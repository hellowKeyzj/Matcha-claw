use crate::{
    BeginCancellationOutcome, CreateGraphRunOutcome, OrganizationStore,
    ports::RuntimeReceiptOutcome,
    task_execution::{
        self, TaskExecutionIdentity, TaskExecutionReceipt, TaskExecutionRejection,
        TaskExecutionRequest, TaskExecutionState,
    },
};
use tokio_util::sync::CancellationToken;

use super::{
    actor::OrganizationShared,
    team_run::{
        TeamRunOwner, install_prepared_runtime_receipt, prepare_runtime_receipt,
        settle_public_cancellation,
    },
};

pub(super) fn inspection_requests(
    store: &OrganizationStore,
    receipt: &TaskExecutionReceipt,
) -> Result<Vec<crate::ActivityExecutionRequest>, crate::StoreFault> {
    if matches!(receipt.state, TaskExecutionState::Rejected(_) | TaskExecutionState::Unavailable) {
        return Ok(Vec::new());
    }
    receipt.activities.iter().filter(|activity| {
        store.facts().deliveries().delivery(&activity.delivery_id).is_some_and(|delivery| {
            matches!(delivery.phase(), crate::DeliveryPhase::Delivering(_)
                | crate::DeliveryPhase::OutcomeUnknown { .. }
                | crate::DeliveryPhase::Delivered { .. })
                || (matches!(delivery.phase(), crate::DeliveryPhase::TerminalObserved { .. })
                    && delivery.task_native_execution().is_none_or(|native| {
                        matches!(native.measurement, crate::TaskRunMeasurement::Unavailable)
                    }))
        })
    }).map(|activity| {
        let activity_id = crate::ActivityId::new(activity.delivery_id.as_str())
            .map_err(|_| crate::StoreFault::InvalidFacts)?;
        let durable = store.facts().activities().activity(&activity_id)
            .ok_or(crate::StoreFault::InvalidFacts)?;
        let (run, binding) = super::run_scheduler::activity_target(store, durable.facts())
            .ok_or(crate::StoreFault::InvalidFacts)?;
        let request = super::team_run::agent_task_execution_request(run, durable.facts(), binding)
            .map_err(|_| crate::StoreFault::InvalidFacts)?;
        let delivery = store.facts().deliveries().delivery(&activity.delivery_id)
            .ok_or(crate::StoreFault::InvalidFacts)?;
        if request.delivery_request() != delivery.facts() { return Err(crate::StoreFault::InvalidFacts); }
        Ok(request)
    }).collect()
}

pub(super) fn record_inspection(
    store: &mut OrganizationStore,
    identity: TaskExecutionIdentity,
    request: crate::ActivityExecutionRequest,
    execution: crate::TaskNativeExecution,
) -> Result<(), crate::StoreFault> {
    let receipt = task_execution::inspect(store, identity);
    if !inspection_requests(store, &receipt)?.iter().any(|original| original == &request) {
        return Err(crate::StoreFault::InvalidFacts);
    }
    store.record_task_native_execution(&request.delivery_request().delivery_id, execution)
}

pub(super) fn prepare_create(
    shared: &OrganizationShared,
    owner: &TeamRunOwner,
    store: &mut OrganizationStore,
    request: TaskExecutionRequest,
    cancellation: CancellationToken,
) -> Result<(TaskExecutionIdentity, crate::RunRuntimeReceipt), TaskExecutionReceipt> {
    let identity = request.identity.clone();
    if store.facts().run(&identity.run_id).is_none() {
        let run = request.instantiate(store).map_err(|reason| {
            TaskExecutionReceipt::new(identity.clone(), TaskExecutionState::Rejected(reason)).not_sent()
        })?;
        let unsupported = store.facts().materialization(&identity.selection.team_id)
            .map(|materialization| {
                let mut unsupported = Vec::new();
                for receipt in materialization.receipts() {
                    let dimensions = shared.runtime_directory.team_runtime_for_endpoint(receipt.endpoint())
                        .map(|runtime| runtime.unsupported_task_budget(&request.budget))
                        .unwrap_or_else(|| request.budget.required_dimensions());
                    for dimension in dimensions {
                        if !unsupported.contains(&dimension) {
                            unsupported.push(dimension);
                        }
                    }
                }
                unsupported
            })
            .unwrap_or_else(|| request.budget.required_dimensions());
        if !unsupported.is_empty() {
            return Err(TaskExecutionReceipt::new(
                identity,
                TaskExecutionState::Rejected(TaskExecutionRejection::UnsupportedBudget {
                    dimensions: unsupported,
                }),
            ).not_sent());
        }
        if cancellation.is_cancelled() {
            return Err(TaskExecutionReceipt::new(
                identity,
                TaskExecutionState::Rejected(TaskExecutionRejection::InvalidInput),
            ).not_sent());
        }
        let created = owner
            .create(store, run, identity.request_id.as_str())
            .map_err(|error| task_execution::store_failure(identity.clone(), &error))?;
        match created {
            CreateGraphRunOutcome::Created(_) | CreateGraphRunOutcome::Replayed(_) => {}
            CreateGraphRunOutcome::ConflictingIdempotency | CreateGraphRunOutcome::ExistingRun => {
                return Err(TaskExecutionReceipt::new(
                    identity,
                    TaskExecutionState::Rejected(TaskExecutionRejection::RequestConflict),
                ));
            }
        }
    }
    let run = store.facts().run(&identity.run_id).ok_or_else(|| {
        TaskExecutionReceipt::new(identity.clone(), TaskExecutionState::Unavailable)
    })?;
    if !request.matches_payload(run) {
        return Err(TaskExecutionReceipt::new(
            identity,
            TaskExecutionState::Rejected(TaskExecutionRejection::RequestConflict),
        ));
    }
    let run = pending_create(store, &identity)?;
    // Only saved intents authorize resuming initialization; Unknown alone never does.
    if cancellation.is_cancelled()
        || (run.runtime().is_none() && run.role_session_intents().is_empty())
    {
        return Err(task_execution::inspect(store, identity));
    }
    let receipt = if run.runtime().is_some() && run.role_session_intents().values()
        .any(|intent| intent.phase != crate::store::RoleSessionPhase::Confirmed)
    {
        crate::RunRuntimeReceipt::try_new(identity.run_id.clone(), run.owned_role_sessions())
            .map_err(|_| TaskExecutionReceipt::new(identity.clone(), TaskExecutionState::Unknown))?
    } else {
        prepare_runtime_receipt(store, &identity.selection.team_id, &identity.run_id)
            .map_err(|(outcome, _)| runtime_failure(identity.clone(), outcome))?
    };
    Ok((identity, receipt))
}

fn pending_create<'a>(
    store: &'a OrganizationStore,
    identity: &TaskExecutionIdentity,
) -> Result<&'a crate::GraphRunFacts, TaskExecutionReceipt> {
    let run = store.facts().run(&identity.run_id).ok_or_else(|| {
        TaskExecutionReceipt::new(identity.clone(), TaskExecutionState::Unavailable)
    })?;
    if !identity.valid() || !task_execution::matches_identity(run, identity)
        || store.facts().team(run.team()).is_none_or(|team| {
            team.tombstoned() || team.revision() != identity.selection.team_revision
        })
        || !matches!(run.lifecycle().state(), crate::GraphRunLifecycleState::Active)
        || !matches!(run.start_gate(), crate::RunStartGate::Intake)
    {
        return Err(task_execution::inspect(store, identity.clone()));
    }
    Ok(run)
}

pub(super) fn settle_create(
    store: &mut OrganizationStore,
    identity: TaskExecutionIdentity,
    receipt: crate::RunRuntimeReceipt,
    outcome: RuntimeReceiptOutcome,
) -> Result<String, TaskExecutionReceipt> {
    if outcome != RuntimeReceiptOutcome::Installed {
        return Err(runtime_failure(identity, outcome));
    }
    pending_create(store, &identity)?;
    install_prepared_runtime_receipt(store, receipt)
        .map_err(|_| TaskExecutionReceipt::new(identity.clone(), TaskExecutionState::Unknown))?;
    let run = pending_create(store, &identity)?;
    if run.runtime().is_none()
        || run.workspace().is_some_and(|workspace| !workspace.is_prepared())
        || run.role_session_intents().values()
            .any(|intent| intent.phase != crate::store::RoleSessionPhase::Confirmed)
    {
        return Err(TaskExecutionReceipt::new(identity, TaskExecutionState::Unknown));
    }
    crate::store::codec::graph_version(run.graph().definition())
        .map_err(|error| task_execution::store_failure(identity, &error))
}

fn runtime_failure(
    identity: TaskExecutionIdentity,
    outcome: RuntimeReceiptOutcome,
) -> TaskExecutionReceipt {
    let rejected = outcome == RuntimeReceiptOutcome::Rejected;
    let receipt = TaskExecutionReceipt::new(
        identity,
        match outcome {
            RuntimeReceiptOutcome::Rejected => {
                TaskExecutionState::Rejected(TaskExecutionRejection::RuntimeRejected)
            }
            RuntimeReceiptOutcome::OutcomeUnknown => TaskExecutionState::Unknown,
            RuntimeReceiptOutcome::Installed | RuntimeReceiptOutcome::Unavailable => {
                TaskExecutionState::Unavailable
            }
        },
    );
    if rejected { receipt.not_sent() } else { receipt }
}

pub(super) fn prepare_cancel(
    owner: &TeamRunOwner,
    store: &mut OrganizationStore,
    identity: TaskExecutionIdentity,
    idempotency_key: &crate::IdempotencyKey,
    requested_at: u64,
    initializing: bool,
) -> Result<BeginCancellationOutcome, TaskExecutionReceipt> {
    let receipt = task_execution::inspect(store, identity.clone());
    if matches!(
        receipt.state,
        TaskExecutionState::Rejected(_) | TaskExecutionState::Unavailable
    ) {
        return Err(receipt);
    }
    let run = store
        .facts()
        .run(&identity.run_id)
        .expect("inspected task run exists");
    if receipt.state == TaskExecutionState::Unknown && !initializing
        && !run.lifecycle().state().requires_native_readback()
    {
        return Err(receipt);
    }
    match owner.begin_cancellation(
        store,
        &identity.run_id,
        idempotency_key.as_str(),
        requested_at,
    ) {
        Ok(outcome @ (BeginCancellationOutcome::Started(_)
            | BeginCancellationOutcome::Replayed(_)
            | BeginCancellationOutcome::OutcomeUnknown)) => Ok(outcome),
        Ok(_) => Err(task_execution::inspect(store, identity)),
        Err(error) => Err(task_execution::store_failure(identity, &error)),
    }
}

pub(super) fn settle_cancel(
    owner: &TeamRunOwner,
    store: &mut OrganizationStore,
    identity: TaskExecutionIdentity,
    idempotency_key: String,
    requested_at: u64,
    outcome: crate::RoleAbortOutcome,
) -> TaskExecutionReceipt {
    if let Err(error) = settle_public_cancellation(
        store,
        owner,
        &identity.run_id,
        idempotency_key.as_str(),
        outcome,
        requested_at,
    ) {
        return task_execution::store_failure(identity, &error);
    }
    task_execution::inspect(store, identity)
}
