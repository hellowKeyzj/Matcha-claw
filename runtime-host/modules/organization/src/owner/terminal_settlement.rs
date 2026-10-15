use std::collections::BTreeMap;

use organization::{DeliveryId, OrganizationStore, StoreFault, TeamMessageTerminalObservation};
use platform::trace::{identifier_hash, runtime_trace};
use serde_json::json;

use crate::{EndpointSessionId, NativeRunSettled};
use crate::application::team_message::TeamMessageFailure;

use super::team_run::TeamRunOwner;

pub(crate) struct TeamRunTerminalSettlement {
    repairs: BTreeMap<String, PendingTeamMessageRepair>,
}

#[derive(Clone)]
struct PendingTeamMessageRepair {
    context: organization::TeamMessageTerminalContext,
    status: organization::NativeTerminalStatus,
    settled_at: u64,
    attempt: usize,
}

impl TeamRunTerminalSettlement {
    pub(crate) fn new() -> Self {
        Self { repairs: BTreeMap::new() }
    }

    pub(crate) fn has_pending_repairs(&self) -> bool {
        !self.repairs.is_empty()
    }

    pub(crate) fn observe_team_message_terminal(
        &mut self,
        store: &mut OrganizationStore,
        team_run: &TeamRunOwner,
        native_run_id: String,
        delivery_context: Option<(DeliveryId, EndpointSessionId)>,
        status: organization::NativeTerminalStatus,
        assistant_texts: Vec<String>,
        settled_at: u64,
    ) -> Result<TeamMessageTerminalObservation, StoreFault> {
        store.refresh()?;
        if let Some(pending) = self.repairs.get(&native_run_id).cloned() {
            runtime_trace("runtime.team_run.repair.match", || json!({
                "nativeRunHash": identifier_hash(&native_run_id),
                "deliveryHash": identifier_hash(pending.context.delivery_id().as_str()),
                "runHash": identifier_hash(pending.context.run_id().as_str()),
                "attempt": pending.attempt, "matched": true,
                "nativeStatus": format!("{status:?}"),
                "outcome": if status == organization::NativeTerminalStatus::Completed { "parse" } else { "repair_failed" },
            }));
            if status != organization::NativeTerminalStatus::Completed {
                settle_native_run(store, team_run, pending, Err(TeamMessageFailure::RepairFailed))?;
                self.repairs.remove(&native_run_id);
                return Ok(TeamMessageTerminalObservation::Settled);
            }
            let outcome = self.plan_and_settle(store, team_run, pending, assistant_texts).inspect_err(|error| {
                runtime_trace("runtime.team_run.terminal.error", || json!({
                    "nativeRunHash": identifier_hash(&native_run_id),
                    "boundary": "repair_plan_and_settle", "error": crate::trace::terminal_error(error),
                }));
            })?;
            self.repairs.remove(&native_run_id);
            return Ok(outcome);
        }
        runtime_trace("runtime.team_run.repair.match", || json!({
            "nativeRunHash": identifier_hash(&native_run_id), "matched": false,
            "nativeStatus": format!("{status:?}"), "hasDeliveryContext": delivery_context.is_some(),
        }));
        if let Some((delivery_id, endpoint_session_id)) = delivery_context {
            runtime_trace("runtime.team_run.terminal.context_accept", || json!({
                "nativeRunHash": identifier_hash(&native_run_id),
                "deliveryHash": identifier_hash(delivery_id.as_str()), "outcome": "begin",
            }));
            let result = store.accept_native_terminal_context(&delivery_id, endpoint_session_id, native_run_id.clone());
            runtime_trace("runtime.team_run.terminal.context_accept", || json!({
                "nativeRunHash": identifier_hash(&native_run_id),
                "deliveryHash": identifier_hash(delivery_id.as_str()),
                "outcome": if result.is_ok() { "accepted" } else { "error" },
                "error": result.as_ref().err().map(crate::trace::terminal_error),
            }));
            result?;
        }
        let Some(context) = team_message_terminal_context(store, team_run, &native_run_id)? else {
            return Ok(TeamMessageTerminalObservation::Ignored);
        };
        if status != organization::NativeTerminalStatus::Completed {
            let result = super::team_run::resolve_native_settled_output(
                store, context.run_id(), context.delivery_id(),
                NativeRunSettled { status, final_assistant_text: None }, settled_at,
            );
            runtime_trace("runtime.team_run.terminal.non_completed", || json!({
                "nativeRunHash": identifier_hash(&native_run_id),
                "deliveryHash": identifier_hash(context.delivery_id().as_str()),
                "runHash": identifier_hash(context.run_id().as_str()),
                "nativeStatus": format!("{status:?}"),
                "outcome": if result.is_ok() { "settled" } else { "error" },
                "error": result.as_ref().err().map(crate::trace::terminal_error),
            }));
            result?;
            return Ok(TeamMessageTerminalObservation::Settled);
        }
        // A repeated original terminal must not reset the repair budget or resend a repair.
        if self.repairs.values().any(|pending| pending.context.delivery_id() == context.delivery_id()) {
            runtime_trace("runtime.team_run.terminal.duplicate", || json!({
                "nativeRunHash": identifier_hash(&native_run_id),
                "deliveryHash": identifier_hash(context.delivery_id().as_str()),
                "runHash": identifier_hash(context.run_id().as_str()),
                "outcome": "ignored", "reason": "repair_pending",
            }));
            return Ok(TeamMessageTerminalObservation::Ignored);
        }
        if store.facts().deliveries().delivery(context.delivery_id()).is_some_and(|delivery| {
            matches!(delivery.phase(), crate::DeliveryPhase::TerminalObserved { observation }
                if !matches!(observation.resolution(), crate::run::delivery::TerminalObservationResolution::AwaitingAuthorizedGraphResolution))
        }) {
            runtime_trace("runtime.team_run.terminal.duplicate", || json!({
                "nativeRunHash": identifier_hash(&native_run_id),
                "deliveryHash": identifier_hash(context.delivery_id().as_str()),
                "runHash": identifier_hash(context.run_id().as_str()),
                "outcome": "settled", "reason": "already_resolved",
            }));
            return Ok(TeamMessageTerminalObservation::Settled);
        }
        self.plan_and_settle(store, team_run, PendingTeamMessageRepair { context, status, settled_at, attempt: 0 }, assistant_texts)
            .inspect_err(|error| {
                runtime_trace("runtime.team_run.terminal.error", || json!({
                    "nativeRunHash": identifier_hash(&native_run_id),
                    "boundary": "plan_and_settle", "error": crate::trace::terminal_error(error),
                }));
            })
    }

    pub(crate) fn repair_queued(&mut self, requested_run_id: String, repair: &organization::TeamMessageRepairDispatch) {
        let pending = self.repairs.remove(repair.requested_run_id());
        runtime_trace("runtime.team_run.repair.queued", || json!({
            "requestedNativeRunHash": identifier_hash(repair.requested_run_id()),
            "nativeRunHash": identifier_hash(&requested_run_id),
            "attempt": repair.attempt(), "matched": pending.is_some(),
            "deliveryHash": pending.as_ref().map(|pending| identifier_hash(pending.context.delivery_id().as_str())),
            "runHash": pending.as_ref().map(|pending| identifier_hash(pending.context.run_id().as_str())),
        }));
        if let Some(pending) = pending {
            self.repairs.insert(requested_run_id, pending);
        }
    }

    pub(crate) fn repair_rejected(
        &mut self,
        store: &mut OrganizationStore,
        team_run: &TeamRunOwner,
        repair: &organization::TeamMessageRepairDispatch,
    ) -> Result<(), StoreFault> {
        store.refresh()?;
        let pending = self.repairs.get(repair.requested_run_id()).cloned();
        runtime_trace("runtime.team_run.repair.rejected", || json!({
            "nativeRunHash": identifier_hash(repair.requested_run_id()),
            "attempt": repair.attempt(), "matched": pending.is_some(),
            "deliveryHash": pending.as_ref().map(|pending| identifier_hash(pending.context.delivery_id().as_str())),
            "runHash": pending.as_ref().map(|pending| identifier_hash(pending.context.run_id().as_str())),
        }));
        if let Some(pending) = pending {
            settle_native_run(store, team_run, pending, Err(TeamMessageFailure::RepairRejected))?;
            self.repairs.remove(repair.requested_run_id());
        }
        Ok(())
    }

    fn plan_and_settle(
        &mut self,
        store: &mut OrganizationStore,
        team_run: &TeamRunOwner,
        pending: PendingTeamMessageRepair,
        assistant_texts: Vec<String>,
    ) -> Result<TeamMessageTerminalObservation, StoreFault> {
        store.refresh().inspect_err(|error| {
            runtime_trace("runtime.team_run.terminal.error", || json!({
                "deliveryHash": identifier_hash(pending.context.delivery_id().as_str()),
                "runHash": identifier_hash(pending.context.run_id().as_str()),
                "boundary": "refresh", "error": crate::trace::terminal_error(error),
            }));
        })?;
        let target = store
            .native_terminal_target(pending.context.delivery_id())
            .filter(|target| target.graph_run_id() == pending.context.run_id())
            .ok_or(StoreFault::InvalidFacts)?;
        if store.native_terminal_is_retired(&target)? {
            return Ok(TeamMessageTerminalObservation::Ignored);
        }
        let delivery = store.facts().deliveries().delivery(pending.context.delivery_id()).ok_or(StoreFault::InvalidFacts)
            .inspect_err(|error| {
                runtime_trace("runtime.team_run.terminal.error", || json!({
                    "deliveryHash": identifier_hash(pending.context.delivery_id().as_str()),
                    "runHash": identifier_hash(pending.context.run_id().as_str()),
                    "boundary": "delivery_missing", "error": crate::trace::terminal_error(error),
                }));
            })?;
        let node_id = crate::NodeId::new(&delivery.facts().node_id);
        let run = store.facts().run(pending.context.run_id()).ok_or(StoreFault::InvalidFacts)
            .inspect_err(|error| {
                runtime_trace("runtime.team_run.terminal.error", || json!({
                    "deliveryHash": identifier_hash(pending.context.delivery_id().as_str()),
                    "runHash": identifier_hash(pending.context.run_id().as_str()),
                    "boundary": "run_missing", "error": crate::trace::terminal_error(error),
                }));
            })?;
        let plan = organization::plan_team_message_terminal(
            &pending.context, pending.attempt, assistant_texts, run.graph(), &node_id,
        );
        match plan {
            organization::TeamMessageTerminalPlan::Settle { output } => {
                settle_native_run(store, team_run, pending, Ok(Some(output)))?;
                Ok(TeamMessageTerminalObservation::Settled)
            }
            organization::TeamMessageTerminalPlan::Failed => {
                settle_native_run(store, team_run, pending, Err(TeamMessageFailure::RepairExhausted))?;
                Ok(TeamMessageTerminalObservation::Settled)
            }
            organization::TeamMessageTerminalPlan::Repair(repair) => {
                self.repairs.insert(repair.requested_run_id().to_owned(), PendingTeamMessageRepair { attempt: repair.attempt(), ..pending });
                Ok(TeamMessageTerminalObservation::Repair(repair))
            }
        }
    }
}

fn settle_native_run(
    store: &mut OrganizationStore,
    team_run: &TeamRunOwner,
    pending: PendingTeamMessageRepair,
    output: Result<Option<crate::TeamNodeOutput>, TeamMessageFailure>,
) -> Result<(), StoreFault> {
    runtime_trace("runtime.team_run.terminal.settle", || json!({
        "deliveryHash": identifier_hash(pending.context.delivery_id().as_str()),
        "runHash": identifier_hash(pending.context.run_id().as_str()),
        "attempt": pending.attempt, "nativeStatus": format!("{:?}", pending.status),
        "outcome": "begin", "failure": output.as_ref().err().map(|failure| failure.code()),
    }));
    let target = team_run.native_terminal_target(store, pending.context.delivery_id()).ok_or(StoreFault::InvalidFacts)
        .inspect_err(|error| {
            runtime_trace("runtime.team_run.terminal.settle", || json!({
                "deliveryHash": identifier_hash(pending.context.delivery_id().as_str()),
                "runHash": identifier_hash(pending.context.run_id().as_str()),
                "outcome": "error", "reason": "target_missing", "error": crate::trace::terminal_error(error),
            }));
        })?;
    if target.graph_run_id() != pending.context.run_id() {
        runtime_trace("runtime.team_run.terminal.settle", || json!({
            "deliveryHash": identifier_hash(pending.context.delivery_id().as_str()),
            "runHash": identifier_hash(pending.context.run_id().as_str()),
            "outcome": "error", "reason": "run_mismatch",
            "error": crate::trace::terminal_error(&StoreFault::InvalidFacts),
        }));
        return Err(StoreFault::InvalidFacts);
    }
    let result = store.settle_native_terminal(target, pending.status, output, pending.settled_at);
    runtime_trace("runtime.team_run.terminal.settle", || json!({
        "deliveryHash": identifier_hash(pending.context.delivery_id().as_str()),
        "runHash": identifier_hash(pending.context.run_id().as_str()),
        "attempt": pending.attempt,
        "outcome": match &result {
            Ok(crate::store::NativeTerminalSettlement::Recorded) => "recorded",
            Ok(crate::store::NativeTerminalSettlement::Replayed) => "replayed",
            Ok(crate::store::NativeTerminalSettlement::Retired) => "retired",
            Err(_) => "error",
        },
        "error": result.as_ref().err().map(crate::trace::terminal_error),
    }));
    result?;
    Ok(())
}

pub(crate) fn settle_native_run_for_delivery(
    store: &mut OrganizationStore,
    _team_run: &TeamRunOwner,
    run_id: &organization::GraphRunId,
    delivery_id: &DeliveryId,
    settled: NativeRunSettled,
    settled_at: u64,
) -> Result<crate::store::NativeTerminalSettlement, StoreFault> {
    super::team_run::resolve_native_settled_output(store, run_id, delivery_id, settled, settled_at)
}

fn team_message_terminal_context(
    store: &mut OrganizationStore,
    team_run: &TeamRunOwner,
    native_run_id: &str,
) -> Result<Option<organization::TeamMessageTerminalContext>, StoreFault> {
    store.refresh().inspect_err(|error| {
        runtime_trace("runtime.team_run.terminal.locate", || json!({
            "nativeRunHash": identifier_hash(native_run_id), "outcome": "error",
            "reason": "refresh", "error": crate::trace::terminal_error(error),
        }));
    })?;
    let delivery_id = team_run.native_delivery_by_run(store, native_run_id).inspect_err(|error| {
        runtime_trace("runtime.team_run.terminal.locate", || json!({
            "nativeRunHash": identifier_hash(native_run_id), "outcome": "error",
            "reason": "delivery_lookup", "error": crate::trace::terminal_error(error),
        }));
    })?;
    let Some(delivery_id) = delivery_id else {
        runtime_trace("runtime.team_run.terminal.locate", || json!({
            "nativeRunHash": identifier_hash(native_run_id), "outcome": "ignored", "reason": "delivery_not_found",
        }));
        return Ok(None);
    };
    let target = team_run.native_terminal_target(store, &delivery_id);
    if let Some(target) = &target
        && store.native_terminal_is_retired(target)?
    {
        return Ok(None);
    }
    runtime_trace("runtime.team_run.terminal.locate", || json!({
        "nativeRunHash": identifier_hash(native_run_id),
        "deliveryHash": identifier_hash(delivery_id.as_str()),
        "runHash": target.as_ref().map(|target| identifier_hash(target.graph_run_id().as_str())),
        "outcome": if target.is_some() { "found" } else { "ignored" },
        "reason": if target.is_some() { "target_found" } else { "target_missing" },
    }));
    Ok(target.map(|target| organization::TeamMessageTerminalContext::new(
        target.graph_run_id().clone(), delivery_id, target.correlation().endpoint_session_id().clone(),
    )))
}
