use crate::{
    BeginCancellationOutcome, CreateGraphRunOutcome, GraphRunLifecycleState, OrganizationStore,
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
        let durable = store.facts().activities().activities()
            .find(|item| item.facts().activity_id.as_str() == activity.delivery_id.as_str())
            .ok_or(crate::StoreFault::InvalidFacts)?;
        let request = super::team_run::agent_task_execution_request(store, durable.facts())
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

pub(super) async fn create(
    shared: &OrganizationShared,
    owner: &TeamRunOwner,
    store: &mut OrganizationStore,
    request: TaskExecutionRequest,
    cancellation: CancellationToken,
) -> Result<String, TaskExecutionReceipt> {
    let identity = request.identity.clone();
    if let Some(existing) = store.facts().run(&identity.run_id) {
        return Err(if request.matches_payload(existing) {
            task_execution::inspect(store, identity)
        } else {
            TaskExecutionReceipt::new(
                identity,
                TaskExecutionState::Rejected(TaskExecutionRejection::RequestConflict),
            )
        });
    }
    let run = request.instantiate(store).map_err(|reason| {
        TaskExecutionReceipt::new(identity.clone(), TaskExecutionState::Rejected(reason)).not_sent()
    })?;
    let unsupported = store.facts().materialization(&identity.selection.team_id)
        .and_then(|receipt| shared.runtime_directory.team_runtime_for_endpoint(receipt.endpoint()))
        .map(|runtime| runtime.unsupported_task_budget(&request.budget))
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
        CreateGraphRunOutcome::Created(_) => {}
        CreateGraphRunOutcome::Replayed(_) => return Err(task_execution::inspect(store, identity)),
        CreateGraphRunOutcome::ConflictingIdempotency | CreateGraphRunOutcome::ExistingRun => {
            return Err(TaskExecutionReceipt::new(
                identity,
                TaskExecutionState::Rejected(TaskExecutionRejection::RequestConflict),
            ));
        }
    }
    let receipt = prepare_runtime_receipt(store, &identity.selection.team_id, &identity.run_id)
        .map_err(|(outcome, _)| runtime_failure(identity.clone(), outcome))?;
    let (outcome, _) = shared
        .team_confirm_receipt(receipt.clone(), cancellation)
        .await;
    if outcome != RuntimeReceiptOutcome::Installed {
        return Err(runtime_failure(identity, outcome));
    }
    install_prepared_runtime_receipt(store, receipt)
        .map_err(|error| task_execution::store_failure(identity.clone(), &error))?;
    let run = store.facts().run(&identity.run_id).ok_or_else(|| {
        TaskExecutionReceipt::new(identity.clone(), TaskExecutionState::Unavailable)
    })?;
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

pub(super) async fn cancel(
    shared: &OrganizationShared,
    owner: &TeamRunOwner,
    store: &mut OrganizationStore,
    identity: TaskExecutionIdentity,
    idempotency_key: crate::IdempotencyKey,
    requested_at: u64,
    cancellation: CancellationToken,
) -> TaskExecutionReceipt {
    let receipt = task_execution::inspect(store, identity.clone());
    if matches!(
        receipt.state,
        TaskExecutionState::Rejected(_)
            | TaskExecutionState::Unavailable
            | TaskExecutionState::Unknown
    ) {
        return receipt;
    }
    let run = store
        .facts()
        .run(&identity.run_id)
        .expect("inspected task run exists");
    if matches!(
        run.lifecycle().state(),
        GraphRunLifecycleState::OutcomeUnknown { .. }
    ) {
        return receipt;
    }
    let plan = match owner.begin_cancellation(
        store,
        &identity.run_id,
        idempotency_key.as_str(),
        requested_at,
    ) {
        Ok(BeginCancellationOutcome::Started(plan)) => plan,
        // An ambiguous/replayed cancellation is read back, never sent under another key.
        Ok(_) => return task_execution::inspect(store, identity),
        Err(error) => return task_execution::store_failure(identity, &error),
    };
    let outcome = shared
        .team_abort_role_sessions(plan.bindings().to_vec(), cancellation)
        .await;
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
