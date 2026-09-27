use std::collections::BTreeMap;

use organization::{DeliveryId, OrganizationStore, StoreFault, TeamMessageTerminalObservation};

use crate::{EndpointSessionId, NativeRunSettled};

use super::team_run::{TeamNodeTerminalResult, TeamRunOwner};

pub(crate) struct TeamRunTerminalSettlement {
    repairs: BTreeMap<String, PendingTeamMessageRepair>,
}

struct PendingTeamMessageRepair {
    context: organization::TeamMessageTerminalContext,
    status: organization::NativeTerminalStatus,
    settled_at: u64,
    attempt: usize,
    last_invalid_output: String,
}

impl TeamRunTerminalSettlement {
    pub(crate) fn new() -> Self {
        Self {
            repairs: BTreeMap::new(),
        }
    }

    pub(crate) fn observe_team_message_terminal(
        &mut self,
        store: &mut OrganizationStore,
        team_run: &TeamRunOwner,
        native_run_id: String,
        delivery_context: Option<(DeliveryId, EndpointSessionId)>,
        status: organization::NativeTerminalStatus,
        final_assistant_text: Option<String>,
        settled_at: u64,
    ) -> Result<TeamMessageTerminalObservation, StoreFault> {
        if let Some(pending) = self.repairs.remove(&native_run_id) {
            let plan = organization::plan_team_message_terminal(
                &pending.context,
                pending.attempt,
                final_assistant_text,
            );
            return self.settle_team_message_plan(
                store,
                team_run,
                pending.context,
                pending.status,
                pending.settled_at,
                plan,
            );
        }
        if let Some((delivery_id, endpoint_session_id)) = delivery_context {
            store.accept_native_terminal_context(
                &delivery_id,
                endpoint_session_id,
                native_run_id.clone(),
            )?;
        }
        let Some(context) = team_message_terminal_context(store, team_run, &native_run_id)? else {
            return Ok(TeamMessageTerminalObservation::Ignored);
        };
        let plan = organization::plan_team_message_terminal(&context, 0, final_assistant_text);
        self.settle_team_message_plan(store, team_run, context, status, settled_at, plan)
    }

    pub(crate) fn repair_queued(
        &mut self,
        requested_run_id: String,
        repair: &organization::TeamMessageRepairDispatch,
    ) {
        if let Some(pending) = self.repairs.remove(repair.requested_run_id()) {
            self.repairs.insert(requested_run_id, pending);
        }
    }

    pub(crate) fn repair_rejected(
        &mut self,
        store: &mut OrganizationStore,
        team_run: &TeamRunOwner,
        repair: &organization::TeamMessageRepairDispatch,
    ) -> Result<(), StoreFault> {
        match self.repairs.remove(repair.requested_run_id()) {
            Some(pending) => settle_native_run(
                store,
                team_run,
                pending.context,
                pending.status,
                Some(pending.last_invalid_output),
                pending.settled_at,
            ),
            None => Ok(()),
        }
    }

    fn settle_team_message_plan(
        &mut self,
        store: &mut OrganizationStore,
        team_run: &TeamRunOwner,
        context: organization::TeamMessageTerminalContext,
        status: organization::NativeTerminalStatus,
        settled_at: u64,
        plan: organization::TeamMessageTerminalPlan,
    ) -> Result<TeamMessageTerminalObservation, StoreFault> {
        match plan {
            organization::TeamMessageTerminalPlan::Settle {
                final_assistant_text,
            } => {
                settle_native_run(
                    store,
                    team_run,
                    context,
                    status,
                    final_assistant_text,
                    settled_at,
                )?;
                Ok(TeamMessageTerminalObservation::Settled)
            }
            organization::TeamMessageTerminalPlan::Repair(repair) => {
                self.repairs.insert(
                    repair.requested_run_id().to_owned(),
                    PendingTeamMessageRepair {
                        context,
                        status,
                        settled_at,
                        attempt: repair.attempt(),
                        last_invalid_output: repair.last_invalid_output().to_owned(),
                    },
                );
                Ok(TeamMessageTerminalObservation::Repair(repair))
            }
        }
    }
}

fn settle_native_run(
    store: &mut OrganizationStore,
    team_run: &TeamRunOwner,
    context: organization::TeamMessageTerminalContext,
    status: organization::NativeTerminalStatus,
    final_assistant_text: Option<String>,
    settled_at: u64,
) -> Result<(), StoreFault> {
    let run_id = context.run_id().clone();
    let delivery_id = context.delivery_id().clone();
    let Some(target) = team_run.native_terminal_target(store, &delivery_id) else {
        return Err(StoreFault::InvalidFacts);
    };
    if target.graph_run_id() != &run_id {
        return Err(StoreFault::InvalidFacts);
    }
    team_run.observe_native_terminal(store, target, status, settled_at)?;
    super::team_run::resolve_native_settled_output(
        store,
        &run_id,
        &delivery_id,
        NativeRunSettled {
            status,
            final_assistant_text,
        },
        settled_at,
    )?;
    Ok(())
}

pub(crate) fn settle_native_run_for_delivery(
    store: &mut OrganizationStore,
    team_run: &TeamRunOwner,
    run_id: &organization::GraphRunId,
    delivery_id: &DeliveryId,
    settled: NativeRunSettled,
    settled_at: u64,
) -> Result<TeamNodeTerminalResult, StoreFault> {
    let Some(target) = team_run.native_terminal_target(store, delivery_id) else {
        return Err(StoreFault::InvalidFacts);
    };
    if target.graph_run_id() != run_id {
        return Err(StoreFault::InvalidFacts);
    }
    let native_terminal = settled.status;
    team_run.observe_native_terminal(store, target, native_terminal, settled_at)?;
    super::team_run::resolve_native_settled_output(store, run_id, delivery_id, settled, settled_at)
}

fn team_message_terminal_context(
    store: &mut OrganizationStore,
    team_run: &TeamRunOwner,
    native_run_id: &str,
) -> Result<Option<organization::TeamMessageTerminalContext>, StoreFault> {
    store.refresh()?;
    Ok(team_run
        .native_delivery_by_run(store, native_run_id)?
        .and_then(|delivery_id| {
            let target = team_run.native_terminal_target(store, &delivery_id)?;
            Some(organization::TeamMessageTerminalContext::new(
                target.graph_run_id().clone(),
                delivery_id,
                target.correlation().endpoint_session_id().clone(),
            ))
        }))
}
