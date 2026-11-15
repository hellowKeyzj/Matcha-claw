use std::collections::HashMap;

use organization::{DeliveryId, NativeTerminalReceiptTarget, OrganizationStore, StoreFault, TeamMessageTerminalObservation};
use platform::endpoint::runtime_address::SessionIdentity;
use platform::trace::{identifier_hash, runtime_trace};
use serde_json::json;

use crate::{EndpointSessionId, NativeRunSettled};
use crate::application::team_message::{
    TeamMessageFailure, TeamMessageRepairBasis, plan_team_message_terminal_with_repair_basis,
};

use super::team_run::TeamRunOwner;

pub(crate) struct TeamRunTerminalSettlement {
    repairs: HashMap<(SessionIdentity, String), PendingTeamMessageRepair>,
}

pub(crate) enum TerminalObservationOutcome {
    Observed(TeamMessageTerminalObservation),
    Inspect {
        request: crate::ActivityExecutionRequest,
        assistant_texts: Result<Vec<String>, TeamMessageFailure>,
    },
}

struct TerminalDelivery<'a> {
    delivery: &'a crate::Delivery,
    binding: &'a crate::RoleSessionReceipt,
    target: Option<NativeTerminalReceiptTarget>,
    repair_key: Option<(SessionIdentity, String)>,
}

#[derive(Clone)]
struct PendingTeamMessageRepair {
    identity: SessionIdentity,
    target: NativeTerminalReceiptTarget,
    context: organization::TeamMessageTerminalContext,
    status: organization::NativeTerminalStatus,
    settled_at: u64,
    attempt: usize,
    business_messages: Vec<String>,
    repair_basis: TeamMessageRepairBasis,
    repair_request_id: Option<String>,
}

impl TeamRunTerminalSettlement {
    pub(crate) fn new() -> Self {
        Self { repairs: HashMap::new() }
    }

    pub(crate) fn has_pending_repairs(&self) -> bool {
        !self.repairs.is_empty()
    }

    fn repair_key(
        &self,
        identity: &SessionIdentity,
        native_run_id: &str,
        native_request_id: Option<&str>,
    ) -> Result<Option<(SessionIdentity, String)>, StoreFault> {
        let exact = (identity.clone(), native_run_id.to_owned());
        if let Some(pending) = self.repairs.get(&exact) {
            if native_request_id.is_some_and(|request| pending.repair_request_id.as_deref() != Some(request)) {
                return Err(StoreFault::InvalidFacts);
            }
            return Ok(Some(exact));
        }
        let Some(request) = native_request_id else { return Ok(None) };
        let mut matches = self.repairs.iter().filter(|((session, _), pending)| {
            session == identity && pending.repair_request_id.as_deref() == Some(request)
        });
        let key = matches.next().map(|(key, _)| key.clone());
        if matches.next().is_some() { return Err(StoreFault::InvalidFacts); }
        Ok(key)
    }

    fn terminal_delivery<'a>(
        &self,
        store: &'a OrganizationStore,
        owner: &TeamRunOwner,
        identity: &SessionIdentity,
        resolver: &dyn crate::RoleSessionIdentityResolver,
        native_run_id: &str,
        delivery_context: Option<&(DeliveryId, EndpointSessionId)>,
        native_request_id: Option<&str>,
    ) -> Result<Option<TerminalDelivery<'a>>, StoreFault> {
        let repair_key = self.repair_key(identity, native_run_id, native_request_id)?;
        let pending = repair_key.as_ref().and_then(|key| self.repairs.get(key));
        let delivery_id = if let Some(pending) = pending {
            Some(pending.context.delivery_id().clone())
        } else if let Some((delivery, _)) = delivery_context {
            Some(delivery.clone())
        } else if let Some(delivery) = native_request_id.and_then(|request| store.facts().deliveries().delivery_by_idempotency_key(request)) {
            Some(delivery.facts().delivery_id.clone())
        } else {
            owner.native_delivery_by_run(store, identity, native_run_id, resolver)?
        };
        let Some(delivery_id) = delivery_id else { return Ok(None) };
        let binding = owner.native_delivery_binding(store, &delivery_id, identity, resolver)?
            .ok_or(StoreFault::InvalidFacts)?;
        let target = store.native_terminal_target(&delivery_id);
        if delivery_context.is_some_and(|(delivery, endpoint)| delivery != &delivery_id || endpoint != binding.endpoint_session_id())
            || target.as_ref().is_some_and(|target| !target.matches_binding(binding))
            || pending.is_some_and(|pending| target.as_ref() != Some(&pending.target))
        {
            return Err(StoreFault::InvalidFacts);
        }
        let delivery = store.facts().deliveries().delivery(&delivery_id).ok_or(StoreFault::InvalidFacts)?;
        if pending.is_none()
            && (native_request_id.is_some_and(|request| request != delivery.facts().idempotency_key.as_str())
                || native_request_id.is_none() && target.as_ref().is_some_and(|target| target.correlation().native_run_receipt().as_str() != native_run_id))
        {
            return Err(StoreFault::InvalidFacts);
        }
        Ok(Some(TerminalDelivery { delivery, binding, target, repair_key }))
    }

    fn activity_request(
        &self,
        store: &OrganizationStore,
        delivery_id: &DeliveryId,
    ) -> Result<crate::ActivityExecutionRequest, StoreFault> {
        let delivery = store.facts().deliveries().delivery(delivery_id).ok_or(StoreFault::InvalidFacts)?;
        if !matches!(delivery.phase(), crate::DeliveryPhase::Delivering(_) | crate::DeliveryPhase::OutcomeUnknown { .. }) {
            return Err(StoreFault::InvalidFacts);
        }
        let activity_id = crate::ActivityId::new(delivery_id.as_str()).map_err(|_| StoreFault::InvalidFacts)?;
        let activity = store.facts().activities().activity(&activity_id).ok_or(StoreFault::InvalidFacts)?;
        let (run, binding) = super::run_scheduler::activity_target(store, activity.facts()).ok_or(StoreFault::InvalidFacts)?;
        let request = super::team_run::agent_task_execution_request(run, activity.facts(), binding).map_err(|_| StoreFault::InvalidFacts)?;
        if request.delivery_request() != delivery.facts() { return Err(StoreFault::InvalidFacts); }
        Ok(request)
    }

    pub(crate) fn plan_file_validation(
        &self,
        store: &OrganizationStore,
        owner: &TeamRunOwner,
        identity: &SessionIdentity,
        resolver: &dyn crate::RoleSessionIdentityResolver,
        native_run_id: &str,
        delivery_context: Option<&(DeliveryId, EndpointSessionId)>,
        native_request_id: Option<&str>,
        assistant_texts: &[String],
    ) -> Result<Option<crate::run::workspace::RunFileValidationPlan>, StoreFault> {
        let Some(TerminalDelivery { delivery, binding, repair_key, .. }) = self.terminal_delivery(
            store, owner, identity, resolver, native_run_id, delivery_context, native_request_id,
        )? else { return Ok(None) };
        let pending = repair_key.as_ref().and_then(|key| self.repairs.get(key));
        if matches!(delivery.phase(), crate::DeliveryPhase::TerminalObserved { observation }
            if !matches!(observation.resolution(), crate::run::delivery::TerminalObservationResolution::AwaitingAuthorizedGraphResolution))
        {
            return Ok(None);
        }
        let run_id = crate::GraphRunId::new(&delivery.facts().run_id);
        let run = store.facts().run(&run_id).ok_or(StoreFault::InvalidFacts)?;
        let Some(workspace) = run.workspace() else { return Ok(None) };
        let context = pending.map(|pending| pending.context.clone()).unwrap_or_else(|| {
            organization::TeamMessageTerminalContext::new(run_id, delivery.facts().delivery_id.clone(), binding.endpoint_session_id().clone())
        });
        let node_id = crate::NodeId::new(&delivery.facts().node_id);
        let Ok(organization::TeamMessageTerminalPlan::Settle { output }) = plan_team_message_terminal_with_repair_basis(
            &context, pending.map_or(0, |pending| pending.attempt), assistant_texts.to_vec(), run.graph(), &node_id,
            pending.map(|pending| &pending.repair_basis), store.facts().team_prompts(),
        ) else { return Ok(None) };
        if pending.is_some_and(|pending| pending.repair_basis.validate_output(&output).is_err())
            || output.files().is_empty()
        {
            return Ok(None);
        }
        Ok(Some(crate::run::workspace::RunFileValidationPlan {
            binding: binding.clone(),
            workspace: workspace.clone(),
            paths: output.files().to_vec(),
        }))
    }

    pub(crate) fn observe_team_message_terminal(
        &mut self,
        store: &mut OrganizationStore,
        team_run: &TeamRunOwner,
        identity: SessionIdentity,
        resolver: &dyn crate::RoleSessionIdentityResolver,
        native_run_id: String,
        delivery_context: Option<(DeliveryId, EndpointSessionId)>,
        observation: crate::task_execution::TaskNativeObservation,
        inspection: Option<(crate::ActivityExecutionRequest, crate::TaskNativeExecution)>,
        status: organization::NativeTerminalStatus,
        assistant_texts: Result<Vec<String>, TeamMessageFailure>,
        settled_at: u64,
        file_validation: Option<(crate::run::workspace::RunFileValidationPlan, Result<(), crate::RunFileValidationError>)>,
    ) -> Result<TerminalObservationOutcome, StoreFault> {
        store.refresh()?;
        let Some(TerminalDelivery { delivery, binding, target, repair_key }) = self.terminal_delivery(
            store, team_run, &identity, resolver, &native_run_id, delivery_context.as_ref(), observation.native_request_id.as_deref(),
        )? else { return Ok(TerminalObservationOutcome::Observed(TeamMessageTerminalObservation::Ignored)) };
        let delivery_id = delivery.facts().delivery_id.clone();
        if repair_key.is_none() {
            let run = store.facts().run(&crate::GraphRunId::new(&delivery.facts().run_id)).ok_or(StoreFault::InvalidFacts)?;
            if observation.execution_context.as_ref().is_some_and(|received| run.task_execution_context() != Some(received)) {
                return Err(StoreFault::InvalidFacts);
            }
            let has_task_context = run.task_execution_context().is_some();
            let endpoint_session_id = binding.endpoint_session_id().clone();
            if target.is_none() && observation.native_request_id.is_some() && inspection.is_none() {
                return Ok(TerminalObservationOutcome::Inspect {
                    request: self.activity_request(store, &delivery_id)?, assistant_texts,
                });
            }
            if let Some((request, native)) = inspection {
                if target.is_none() && self.activity_request(store, &delivery_id)? != request {
                    return Err(StoreFault::InvalidFacts);
                }
                if request.delivery_request() != delivery.facts() || request.binding() != binding
                    || request.execution_context() != run.task_execution_context()
                    || native.endpoint_session_id != endpoint_session_id.as_str()
                    || native.native_request_id.as_deref() != Some(delivery.facts().idempotency_key.as_str())
                    || native.native_message_id.as_ref().is_none_or(|id| id.trim().is_empty())
                    || observation.native_message_id.as_ref().is_some_and(|id| native.native_message_id.as_ref() != Some(id))
                    || target.as_ref().is_some_and(|target| target.correlation().native_run_receipt().as_str() != native.native_run_id)
                {
                    return Err(StoreFault::InvalidFacts);
                }
                if has_task_context {
                    store.record_task_native_execution(&delivery_id, native)?;
                } else if target.is_none() {
                    store.accept_native_terminal_context(&delivery_id, endpoint_session_id, native.native_run_id)?;
                }
            } else {
                if target.is_none() && delivery_context.is_some() {
                    store.accept_native_terminal_context(&delivery_id, endpoint_session_id.clone(), native_run_id.clone())?;
                }
                // Request ownership does not make a continuation the originally accepted execution.
                if has_task_context && observation.native_request_id.is_some() && observation.native_message_id.is_some()
                    && target.as_ref().is_none_or(|target| target.correlation().native_run_receipt().as_str() == native_run_id)
                {
                    store.record_task_native_execution(&delivery_id, crate::TaskNativeExecution {
                        endpoint_session_id: endpoint_session_id.as_str().to_owned(), native_run_id: native_run_id.clone(),
                        native_request_id: observation.native_request_id, native_message_id: observation.native_message_id,
                        measurement: observation.measurement,
                    })?;
                }
            }
        }
        let target = if let Some(original) = target {
            if store.native_terminal_target(&delivery_id).as_ref() != Some(&original) {
                return Err(StoreFault::InvalidFacts);
            }
            original
        } else {
            store.native_terminal_target(&delivery_id).ok_or(StoreFault::InvalidFacts)?
        };
        if repair_key.is_none() && store.native_terminal_is_retired(&target)? {
            return Ok(TerminalObservationOutcome::Observed(TeamMessageTerminalObservation::Ignored));
        }
        if let Some(repair_key) = repair_key {
            let pending = self.repairs.get(&repair_key).cloned().expect("located repair");
            runtime_trace("runtime.team_run.repair.match", || json!({
                "nativeRunHash": identifier_hash(&native_run_id),
                "deliveryHash": identifier_hash(pending.context.delivery_id().as_str()),
                "runHash": identifier_hash(pending.context.run_id().as_str()),
                "attempt": pending.attempt, "matched": true,
                "nativeStatus": format!("{status:?}"),
                "outcome": if status == organization::NativeTerminalStatus::Completed { "parse" } else { "repair_failed" },
            }));
            let assistant_texts = match assistant_texts {
                Ok(texts) => texts,
                Err(failure) => {
                    settle_native_run(store, team_run, pending, Err(failure), None)?;
                    self.repairs.remove(&repair_key);
                    return Ok(TerminalObservationOutcome::Observed(TeamMessageTerminalObservation::Settled));
                }
            };
            if status != organization::NativeTerminalStatus::Completed {
                settle_native_run(store, team_run, pending, Err(TeamMessageFailure::RepairFailed), None)?;
                self.repairs.remove(&repair_key);
                return Ok(TerminalObservationOutcome::Observed(TeamMessageTerminalObservation::Settled));
            }
            let outcome = self.plan_and_settle(store, team_run, pending, assistant_texts, file_validation).inspect_err(|error| {
                runtime_trace("runtime.team_run.terminal.error", || json!({
                    "nativeRunHash": identifier_hash(&native_run_id),
                    "boundary": "repair_plan_and_settle", "error": crate::trace::terminal_error(error),
                }));
            })?;
            self.repairs.remove(&repair_key);
            return Ok(TerminalObservationOutcome::Observed(outcome));
        }
        let context = organization::TeamMessageTerminalContext::new(
            target.graph_run_id().clone(), delivery_id, target.correlation().endpoint_session_id().clone(),
        );
        runtime_trace("runtime.team_run.repair.match", || json!({
            "nativeRunHash": identifier_hash(&native_run_id), "matched": false,
            "nativeStatus": format!("{status:?}"), "hasDeliveryContext": delivery_context.is_some(),
        }));
        if status != organization::NativeTerminalStatus::Completed && assistant_texts.is_ok() {
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
            return Ok(TerminalObservationOutcome::Observed(TeamMessageTerminalObservation::Settled));
        }
        // A repeated original terminal must not reset the repair budget or resend a repair.
        if self.repairs.values().any(|pending| pending.context.delivery_id() == context.delivery_id()) {
            runtime_trace("runtime.team_run.terminal.duplicate", || json!({
                "nativeRunHash": identifier_hash(&native_run_id),
                "deliveryHash": identifier_hash(context.delivery_id().as_str()),
                "runHash": identifier_hash(context.run_id().as_str()),
                "outcome": "ignored", "reason": "repair_pending",
            }));
            return Ok(TerminalObservationOutcome::Observed(TeamMessageTerminalObservation::Ignored));
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
            return Ok(TerminalObservationOutcome::Observed(TeamMessageTerminalObservation::Settled));
        }
        let assistant_texts = match assistant_texts {
            Ok(texts) => texts,
            Err(failure) => {
                settle_native_run(store, team_run, PendingTeamMessageRepair {
                    identity, target, context, status, settled_at, attempt: 0,
                    business_messages: Vec::new(), repair_basis: TeamMessageRepairBasis::UnreadableDeclaration, repair_request_id: None,
                }, Err(failure), None)?;
                return Ok(TerminalObservationOutcome::Observed(TeamMessageTerminalObservation::Settled));
            }
        };
        let business_messages = crate::TeamNodeOutput::business_messages_from(&assistant_texts);
        let repair_basis = TeamMessageRepairBasis::from_assistant_texts(&assistant_texts);
        self.plan_and_settle(store, team_run, PendingTeamMessageRepair { identity, target, context, status, settled_at, attempt: 0, business_messages, repair_basis, repair_request_id: None }, assistant_texts, file_validation)
            .inspect_err(|error| {
                runtime_trace("runtime.team_run.terminal.error", || json!({
                    "nativeRunHash": identifier_hash(&native_run_id),
                    "boundary": "plan_and_settle", "error": crate::trace::terminal_error(error),
                }));
            }).map(TerminalObservationOutcome::Observed)
    }

    pub(crate) fn repair_queued(&mut self, identity: &SessionIdentity, requested_run_id: String, repair: &organization::TeamMessageRepairDispatch) {
        let pending = self.repairs.remove(&(identity.clone(), repair.requested_run_id().to_owned()));
        runtime_trace("runtime.team_run.repair.queued", || json!({
            "requestedNativeRunHash": identifier_hash(repair.requested_run_id()),
            "nativeRunHash": identifier_hash(&requested_run_id),
            "attempt": repair.attempt(), "matched": pending.is_some(),
            "deliveryHash": pending.as_ref().map(|pending| identifier_hash(pending.context.delivery_id().as_str())),
            "runHash": pending.as_ref().map(|pending| identifier_hash(pending.context.run_id().as_str())),
        }));
        if let Some(pending) = pending {
            self.repairs.insert((identity.clone(), requested_run_id), pending);
        }
    }

    pub(crate) fn repair_rejected(
        &mut self,
        store: &mut OrganizationStore,
        team_run: &TeamRunOwner,
        identity: &SessionIdentity,
        repair: &organization::TeamMessageRepairDispatch,
    ) -> Result<(), StoreFault> {
        store.refresh()?;
        let repair_key = (identity.clone(), repair.requested_run_id().to_owned());
        let pending = self.repairs.get(&repair_key).cloned();
        runtime_trace("runtime.team_run.repair.rejected", || json!({
            "nativeRunHash": identifier_hash(repair.requested_run_id()),
            "attempt": repair.attempt(), "matched": pending.is_some(),
            "deliveryHash": pending.as_ref().map(|pending| identifier_hash(pending.context.delivery_id().as_str())),
            "runHash": pending.as_ref().map(|pending| identifier_hash(pending.context.run_id().as_str())),
        }));
        if let Some(pending) = pending {
            settle_native_run(store, team_run, pending, Err(TeamMessageFailure::RepairRejected), None)?;
            self.repairs.remove(&repair_key);
        }
        Ok(())
    }

    fn plan_and_settle(
        &mut self,
        store: &mut OrganizationStore,
        team_run: &TeamRunOwner,
        mut pending: PendingTeamMessageRepair,
        assistant_texts: Vec<String>,
        file_validation: Option<(crate::run::workspace::RunFileValidationPlan, Result<(), crate::RunFileValidationError>)>,
    ) -> Result<TeamMessageTerminalObservation, StoreFault> {
        store.refresh().inspect_err(|error| {
            runtime_trace("runtime.team_run.terminal.error", || json!({
                "deliveryHash": identifier_hash(pending.context.delivery_id().as_str()),
                "runHash": identifier_hash(pending.context.run_id().as_str()),
                "boundary": "refresh", "error": crate::trace::terminal_error(error),
            }));
        })?;
        if store.native_terminal_is_retired(&pending.target)? {
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
        if pending.attempt > 0 && pending.repair_basis == TeamMessageRepairBasis::MissingDeclaration {
            pending.repair_basis = TeamMessageRepairBasis::from_assistant_texts(&assistant_texts);
        }
        let plan = match plan_team_message_terminal_with_repair_basis(
            &pending.context, pending.attempt, assistant_texts, run.graph(), &node_id, Some(&pending.repair_basis),
            store.facts().team_prompts(),
        ) {
            Ok(plan) => plan,
            Err(failure) => {
                settle_native_run(store, team_run, pending, Err(failure), None)?;
                return Ok(TeamMessageTerminalObservation::Settled);
            }
        };
        match plan {
            organization::TeamMessageTerminalPlan::Settle { output } => {
                let output = (if pending.attempt > 0 { pending.repair_basis.validate_output(&output) } else { Ok(()) })
                    .map(|()| Some(output.with_business_messages(std::mem::take(&mut pending.business_messages))));
                settle_native_run(store, team_run, pending, output, file_validation)?;
                Ok(TeamMessageTerminalObservation::Settled)
            }
            organization::TeamMessageTerminalPlan::Failed => {
                settle_native_run(store, team_run, pending, Err(TeamMessageFailure::RepairExhausted), None)?;
                Ok(TeamMessageTerminalObservation::Settled)
            }
            organization::TeamMessageTerminalPlan::Repair(repair) => {
                pending.repair_request_id = Some(repair.requested_run_id().to_owned());
                self.repairs.insert((pending.identity.clone(), repair.requested_run_id().to_owned()), PendingTeamMessageRepair { attempt: repair.attempt(), ..pending });
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
    file_validation: Option<(crate::run::workspace::RunFileValidationPlan, Result<(), crate::RunFileValidationError>)>,
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
    if target != pending.target {
        runtime_trace("runtime.team_run.terminal.settle", || json!({
            "deliveryHash": identifier_hash(pending.context.delivery_id().as_str()),
            "runHash": identifier_hash(pending.context.run_id().as_str()),
            "outcome": "error", "reason": "run_mismatch",
            "error": crate::trace::terminal_error(&StoreFault::InvalidFacts),
        }));
        return Err(StoreFault::InvalidFacts);
    }
    let result = store.settle_native_terminal(target, pending.status, output, pending.settled_at, file_validation);
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
