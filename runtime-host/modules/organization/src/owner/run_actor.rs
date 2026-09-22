use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    sync::atomic::{AtomicU64, Ordering},
};

use foundation::execution::{OperationHandle, TraceContext};
use organization::{ActivityId, DeliveryId, GraphRunId};
use runtime_directory::OwnedRuntimeFuture;
use tokio_util::sync::CancellationToken;

use crate::ports::{ActivityExecutionOutcome, ActivityExecutionRequest};

use super::{
    coordinator::TeamRunCoordinatorInput,
    receipt_router::{ActivityReceipt, ActivityReceiptStatus, TeamRunReceiptRouter},
    team_run::{TeamRunActivityError, TeamRunActivityStart, TeamRunActivityTarget},
};

const READY_NODES_OPERATION: &str = "teamRun.readyNodes";
const ACTIVITY_EXECUTION_OPERATION: &str = "teamRun.activityExecution";
const ACTIVITY_OBSERVATION_OPERATION: &str = "teamRun.activityObservation";
const ACTIVITY_EXECUTION_CONCURRENCY: usize = 8;

static NEXT_TEAM_RUN_ACTOR_TRACE: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub(super) struct TeamRunActors {
    actors: BTreeMap<GraphRunId, TeamRunActor>,
}

impl TeamRunActors {
    pub(super) async fn wake_active_runs(
        &mut self,
        input: &TeamRunCoordinatorInput,
        receipt_router: &mut TeamRunReceiptRouter,
        active_run_ids: Vec<GraphRunId>,
        now: u64,
    ) {
        let active_runs = active_run_ids.iter().cloned().collect::<BTreeSet<_>>();
        self.actors.retain(|run_id, _| active_runs.contains(run_id));
        for run_id in &active_run_ids {
            self.actors
                .entry(run_id.clone())
                .or_insert_with(|| TeamRunActor::new(run_id.clone()))
                .begin_wake();
        }
        for run_id in &active_run_ids {
            if let Some(actor) = self.actors.get_mut(run_id) {
                actor
                    .route_completed_activity_receipts(input, receipt_router)
                    .await;
            }
        }
        let mut capacity = self.capacity();
        for run_id in active_run_ids {
            let Some(actor) = self.actors.get_mut(&run_id) else {
                continue;
            };
            actor.wake_ready_nodes(input, now).await;
            actor
                .start_dirty_activities(input, now, &mut capacity)
                .await;
        }
    }

    pub(super) fn cancel(&mut self) {
        for actor in self.actors.values_mut() {
            actor.cancel();
        }
        self.actors.clear();
    }

    fn capacity(&self) -> usize {
        ACTIVITY_EXECUTION_CONCURRENCY.saturating_sub(
            self.actors
                .values()
                .map(|actor| actor.activity_execution.processing_len())
                .sum(),
        )
    }
}

struct TeamRunActor {
    run_id: GraphRunId,
    activity_execution: ActivityExecutionState,
}

impl TeamRunActor {
    fn new(run_id: GraphRunId) -> Self {
        Self {
            run_id,
            activity_execution: ActivityExecutionState::default(),
        }
    }

    fn begin_wake(&mut self) {
        self.activity_execution.resume_deferred();
    }

    async fn route_completed_activity_receipts(
        &mut self,
        input: &TeamRunCoordinatorInput,
        receipt_router: &mut TeamRunReceiptRouter,
    ) {
        for completion in self.activity_execution.poll_completed().await {
            let (activity_id, status) = match completion {
                ActivityExecutionCompletion::Observation(observation) => {
                    receipt_router.record_activity_observation(
                        self.run_id.clone(),
                        observation.activity_id.clone(),
                        activity_delivery_id(&observation.activity_id),
                        observation.status,
                    );
                    (observation.activity_id, observation.status)
                }
                ActivityExecutionCompletion::Executed {
                    run_id,
                    activity_id,
                    delivery_id,
                    claim,
                    outcome,
                } => {
                    let status = receipt_router
                        .route_activity_receipt(
                            input,
                            ActivityReceipt {
                                run_id,
                                activity_id: activity_id.clone(),
                                delivery_id,
                                claim,
                                outcome,
                            },
                        )
                        .await;
                    (activity_id, status)
                }
            };
            if status.should_retry_on_wakeup() {
                self.activity_execution.defer(activity_id);
            }
        }
    }

    async fn wake_ready_nodes(&mut self, input: &TeamRunCoordinatorInput, now: u64) {
        let run_id = self.run_id.clone();
        let organization = input.organization.clone();
        let mut operation = spawn_ready_nodes_operation(input, move |_| async move {
            let mut activity_ids = organization
                .pending_run_activity_ids(run_id.clone(), now)
                .await
                .unwrap_or_default();
            activity_ids.extend(
                organization
                    .schedule_ready_nodes(run_id, now)
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .unwrap_or_default(),
            );
            activity_ids
        });
        if let Ok(activity_ids) = operation.join().await {
            for activity_id in activity_ids {
                self.activity_execution.dirty(activity_id);
            }
        }
    }

    async fn start_dirty_activities(
        &mut self,
        input: &TeamRunCoordinatorInput,
        now: u64,
        capacity: &mut usize,
    ) {
        if *capacity == 0 {
            return;
        }
        let activity_ids = self
            .activity_execution
            .dirty
            .iter()
            .take(*capacity)
            .cloned()
            .collect::<Vec<_>>();
        for activity_id in activity_ids {
            if *capacity == 0 {
                break;
            }
            let delivery_id = activity_delivery_id(&activity_id);
            let operation = start_activity_execution(
                input,
                self.run_id.clone(),
                activity_id.clone(),
                delivery_id.clone(),
                now,
            )
            .await;
            self.activity_execution.start(activity_id, operation);
            *capacity = (*capacity).saturating_sub(1);
        }
    }

    fn cancel(&mut self) {
        self.activity_execution.cancel();
    }
}

struct ActivityExecutionObservation {
    activity_id: ActivityId,
    status: ActivityReceiptStatus,
}

enum ActivityExecutionCompletion {
    Observation(ActivityExecutionObservation),
    Executed {
        run_id: GraphRunId,
        activity_id: ActivityId,
        delivery_id: DeliveryId,
        claim: organization::ActivityClaim,
        outcome: ActivityExecutionOutcome,
    },
}

struct ActivityExecutionWork {
    operation: OperationHandle<ActivityExecutionCompletion>,
}

#[derive(Default)]
struct ActivityExecutionState {
    dirty: BTreeSet<ActivityId>,
    deferred: BTreeSet<ActivityId>,
    processing: BTreeMap<ActivityId, ActivityExecutionWork>,
}

impl ActivityExecutionState {
    fn dirty(&mut self, activity_id: ActivityId) {
        if !self.processing.contains_key(&activity_id) {
            self.dirty.insert(activity_id);
        }
    }

    fn defer(&mut self, activity_id: ActivityId) {
        if !self.processing.contains_key(&activity_id) {
            self.deferred.insert(activity_id);
        }
    }

    fn resume_deferred(&mut self) {
        for activity_id in std::mem::take(&mut self.deferred) {
            self.dirty(activity_id);
        }
    }

    fn start(
        &mut self,
        activity_id: ActivityId,
        operation: OperationHandle<ActivityExecutionCompletion>,
    ) {
        self.dirty.remove(&activity_id);
        self.deferred.remove(&activity_id);
        self.processing
            .insert(activity_id, ActivityExecutionWork { operation });
    }

    fn processing_len(&self) -> usize {
        self.processing.len()
    }

    async fn poll_completed(&mut self) -> Vec<ActivityExecutionCompletion> {
        let mut completed = Vec::new();
        let mut pending = BTreeMap::new();
        for (activity_id, mut work) in std::mem::take(&mut self.processing) {
            if work.operation.is_finished() {
                match work.operation.join().await {
                    Ok(completion) => completed.push(completion),
                    Err(_) => completed.push(ActivityExecutionCompletion::Observation(
                        ActivityExecutionObservation {
                            activity_id,
                            status: ActivityReceiptStatus::ResponseUnavailable,
                        },
                    )),
                }
            } else {
                pending.insert(activity_id, work);
            }
        }
        self.processing = pending;
        completed
    }

    fn cancel(&mut self) {
        for (_, work) in std::mem::take(&mut self.processing) {
            work.operation.cancel();
        }
        self.dirty.clear();
        self.deferred.clear();
    }
}

async fn start_activity_execution(
    input: &TeamRunCoordinatorInput,
    run_id: GraphRunId,
    activity_id: ActivityId,
    delivery_id: DeliveryId,
    claimed_at: u64,
) -> OperationHandle<ActivityExecutionCompletion> {
    let target = match input
        .organization
        .activity_target(activity_id.clone())
        .await
    {
        Ok(Some(target)) => target,
        Ok(None) | Err(_) => {
            return observed_activity_execution(
                input,
                run_id,
                activity_id,
                delivery_id,
                ActivityReceiptStatus::TargetUnavailable,
            );
        }
    };
    let target_run_id = match &target {
        TeamRunActivityTarget::OpenClaw { run_id } | TeamRunActivityTarget::Matcha { run_id } => {
            run_id
        }
    };
    if target_run_id != &run_id {
        return observed_activity_execution(
            input,
            run_id,
            activity_id,
            delivery_id,
            ActivityReceiptStatus::TargetUnavailable,
        );
    }
    if matches!(target, TeamRunActivityTarget::OpenClaw { .. })
        && open_claw_activity_unavailable(input)
    {
        return observed_activity_execution(
            input,
            run_id,
            activity_id,
            delivery_id,
            ActivityReceiptStatus::RuntimeUnavailable,
        );
    }
    let start = match input
        .organization
        .claim_activity(run_id.clone(), activity_id.clone(), claimed_at)
        .await
    {
        Ok(Ok(start)) => start,
        Ok(Err(TeamRunActivityError::Store(_))) => {
            return observed_activity_execution(
                input,
                run_id,
                activity_id,
                delivery_id,
                ActivityReceiptStatus::StoreFault,
            );
        }
        Ok(Err(_)) | Err(_) => {
            return observed_activity_execution(
                input,
                run_id,
                activity_id,
                delivery_id,
                ActivityReceiptStatus::ActivityError,
            );
        }
    };
    match start {
        TeamRunActivityStart::Claimed { claim, request } => {
            let operation = execute_team_activity(input, request);
            spawn_activity_operation(input, ACTIVITY_EXECUTION_OPERATION, move |_| async move {
                let outcome = operation.await;
                ActivityExecutionCompletion::Executed {
                    run_id,
                    activity_id,
                    delivery_id,
                    claim,
                    outcome,
                }
            })
        }
        TeamRunActivityStart::Immediate(outcome) => observed_activity_execution(
            input,
            run_id,
            activity_id,
            delivery_id,
            ActivityReceiptStatus::from_activity_outcome(&outcome),
        ),
    }
}

fn observed_activity_execution(
    input: &TeamRunCoordinatorInput,
    _run_id: GraphRunId,
    activity_id: ActivityId,
    _delivery_id: DeliveryId,
    status: ActivityReceiptStatus,
) -> OperationHandle<ActivityExecutionCompletion> {
    spawn_activity_operation(input, ACTIVITY_OBSERVATION_OPERATION, move |_| async move {
        ActivityExecutionCompletion::Observation(ActivityExecutionObservation {
            activity_id,
            status,
        })
    })
}

fn spawn_ready_nodes_operation<F, U>(
    input: &TeamRunCoordinatorInput,
    future: F,
) -> OperationHandle<Vec<ActivityId>>
where
    F: FnOnce(CancellationToken) -> U + Send + 'static,
    U: Future<Output = Vec<ActivityId>> + Send + 'static,
{
    if input.observation.is_enabled() {
        OperationHandle::spawn_observed(
            input.observation.clone(),
            next_team_run_actor_trace(),
            READY_NODES_OPERATION,
            future,
        )
        .0
    } else {
        OperationHandle::spawn(future).0
    }
}

fn spawn_activity_operation<F, U>(
    input: &TeamRunCoordinatorInput,
    operation_kind: &'static str,
    future: F,
) -> OperationHandle<ActivityExecutionCompletion>
where
    F: FnOnce(CancellationToken) -> U + Send + 'static,
    U: Future<Output = ActivityExecutionCompletion> + Send + 'static,
{
    if input.observation.is_enabled() {
        OperationHandle::spawn_observed(
            input.observation.clone(),
            next_team_run_actor_trace(),
            operation_kind,
            future,
        )
        .0
    } else {
        OperationHandle::spawn(future).0
    }
}

fn execute_team_activity(
    input: &TeamRunCoordinatorInput,
    request: ActivityExecutionRequest,
) -> OwnedRuntimeFuture<ActivityExecutionOutcome> {
    input.activity_executor.execute(request)
}

fn open_claw_activity_unavailable(input: &TeamRunCoordinatorInput) -> bool {
    !input.admission.is_admitted() || !input.activity_executor.open_claw_ready()
}

fn activity_delivery_id(activity_id: &ActivityId) -> DeliveryId {
    DeliveryId::new(activity_id.as_str().to_owned())
        .expect("validated TeamRun activity id must be a valid delivery id")
}

fn next_team_run_actor_trace() -> TraceContext {
    TraceContext::root(NEXT_TEAM_RUN_ACTOR_TRACE.fetch_add(1, Ordering::Relaxed))
}
