use std::{
    collections::{BTreeMap, BTreeSet},
    future::{Future, poll_fn},
    sync::atomic::{AtomicU64, Ordering},
    task::Poll,
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
        active_run_ids: Vec<GraphRunId>,
        now: u64,
        retry_deferred: bool,
    ) {
        let active_runs = active_run_ids.iter().cloned().collect::<BTreeSet<_>>();
        self.actors.retain(|run_id, actor| {
            active_runs.contains(run_id) || actor.activity_execution.processing_len() != 0
        });
        for run_id in &active_run_ids {
            let actor = self
                .actors
                .entry(run_id.clone())
                .or_insert_with(|| TeamRunActor::new(run_id.clone()));
            if retry_deferred {
                actor.activity_execution.resume_deferred();
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

    pub(super) async fn next_completion(&mut self) -> CompletedActivity {
        let completion = {
            let mut joins = self
                .actors
                .iter_mut()
                .flat_map(|(run_id, actor)| {
                    actor.activity_execution.processing.iter_mut().map(
                        move |(activity_id, work)| {
                            (
                                run_id.clone(),
                                activity_id.clone(),
                                Box::pin(work.operation.join()),
                            )
                        },
                    )
                })
                .collect::<Vec<_>>();
            poll_fn(|context| {
                for (run_id, activity_id, join) in &mut joins {
                    if let Poll::Ready(result) = join.as_mut().poll(context) {
                        return Poll::Ready(CompletedActivity {
                            run_id: run_id.clone(),
                            completion: result.unwrap_or_else(|_| {
                                ActivityExecutionCompletion::Observation(
                                    ActivityExecutionObservation {
                                        activity_id: activity_id.clone(),
                                        status: ActivityReceiptStatus::ResponseUnavailable,
                                    },
                                )
                            }),
                            activity_id: activity_id.clone(),
                        });
                    }
                }
                Poll::Pending
            })
            .await
        };
        self.actors
            .get_mut(&completion.run_id)
            .expect("completed activity belongs to a run actor")
            .activity_execution
            .processing
            .remove(&completion.activity_id);
        completion
    }

    pub(super) async fn route_completion(
        &mut self,
        input: &TeamRunCoordinatorInput,
        receipt_router: &mut TeamRunReceiptRouter,
        completion: CompletedActivity,
    ) {
        self.actors
            .get_mut(&completion.run_id)
            .expect("completed activity belongs to a run actor")
            .route_activity_completion(input, receipt_router, completion.completion)
            .await;
    }

    pub(super) async fn cancel_and_join(
        &mut self,
        input: &TeamRunCoordinatorInput,
        receipt_router: &mut TeamRunReceiptRouter,
    ) {
        for actor in self.actors.values() {
            for work in actor.activity_execution.processing.values() {
                work.operation.cancel();
            }
        }
        while self
            .actors
            .values()
            .any(|actor| actor.activity_execution.processing_len() != 0)
        {
            let completion = self.next_completion().await;
            self.route_completion(input, receipt_router, completion)
                .await;
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

    async fn route_activity_completion(
        &mut self,
        input: &TeamRunCoordinatorInput,
        receipt_router: &mut TeamRunReceiptRouter,
        completion: ActivityExecutionCompletion,
    ) {
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
}

pub(super) struct CompletedActivity {
    run_id: GraphRunId,
    activity_id: ActivityId,
    completion: ActivityExecutionCompletion,
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
        if !self.processing.contains_key(&activity_id) && !self.deferred.contains(&activity_id) {
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
            spawn_activity_operation(
                input,
                ACTIVITY_EXECUTION_OPERATION,
                move |cancellation| async move {
                    let outcome = tokio::select! {
                        biased;
                        outcome = operation => outcome,
                        _ = cancellation.cancelled() => ActivityExecutionOutcome::Unknown,
                    };
                    ActivityExecutionCompletion::Executed {
                        run_id,
                        activity_id,
                        delivery_id,
                        claim,
                        outcome,
                    }
                },
            )
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

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;

    fn insert_operation(
        actors: &mut TeamRunActors,
        run_id: &str,
        activity_id: &str,
        operation: OperationHandle<ActivityExecutionCompletion>,
    ) {
        let run_id = GraphRunId::new(run_id);
        actors
            .actors
            .entry(run_id.clone())
            .or_insert_with(|| TeamRunActor::new(run_id))
            .activity_execution
            .start(ActivityId::new(activity_id).unwrap(), operation);
    }

    fn observation(activity_id: &str) -> ActivityExecutionCompletion {
        ActivityExecutionCompletion::Observation(ActivityExecutionObservation {
            activity_id: ActivityId::new(activity_id).unwrap(),
            status: ActivityReceiptStatus::Delivered,
        })
    }

    #[tokio::test]
    async fn completion_wakes_without_a_tick_and_does_not_wait_for_another_run() {
        let mut actors = TeamRunActors::default();
        let (release, wait_release) = oneshot::channel();
        let (blocked, _) = OperationHandle::spawn(move |_| async move {
            wait_release.await.unwrap();
            observation("blocked")
        });
        let (ready, _) = OperationHandle::spawn(|_| async { observation("ready") });
        insert_operation(&mut actors, "run:a", "blocked", blocked);
        insert_operation(&mut actors, "run:b", "ready", ready);
        assert_eq!(actors.capacity(), ACTIVITY_EXECUTION_CONCURRENCY - 2);

        let completion = actors.next_completion().await;
        assert_eq!(completion.activity_id.as_str(), "ready");
        assert_eq!(actors.capacity(), ACTIVITY_EXECUTION_CONCURRENCY - 1);
        release.send(()).unwrap();
        assert_eq!(
            actors.next_completion().await.activity_id.as_str(),
            "blocked"
        );
        assert_eq!(actors.capacity(), ACTIVITY_EXECUTION_CONCURRENCY);
    }

    #[tokio::test]
    async fn interrupted_completion_wait_keeps_operation_owned() {
        let mut actors = TeamRunActors::default();
        let (release, wait_release) = oneshot::channel();
        let (operation, _) = OperationHandle::spawn(move |_| async move {
            wait_release.await.unwrap();
            observation("pending")
        });
        insert_operation(&mut actors, "run:a", "pending", operation);
        {
            let mut completion = Box::pin(actors.next_completion());
            poll_fn(|context| {
                assert!(completion.as_mut().poll(context).is_pending());
                Poll::Ready(())
            })
            .await;
        }
        assert_eq!(actors.capacity(), ACTIVITY_EXECUTION_CONCURRENCY - 1);
        release.send(()).unwrap();
        assert_eq!(
            actors.next_completion().await.activity_id.as_str(),
            "pending"
        );
    }

    #[tokio::test]
    async fn operation_panic_becomes_a_visible_failure_receipt() {
        let mut actors = TeamRunActors::default();
        let (operation, _) = OperationHandle::spawn(|_| async { panic!("executor failed") });
        insert_operation(&mut actors, "run:a", "panicked", operation);
        let completion = actors.next_completion().await;
        let ActivityExecutionCompletion::Observation(observation) = completion.completion else {
            panic!("join failure must be an observation");
        };
        assert_eq!(
            observation.status,
            ActivityReceiptStatus::ResponseUnavailable
        );
        assert_eq!(actors.capacity(), ACTIVITY_EXECUTION_CONCURRENCY);
    }

    struct NoRuntime;

    impl crate::OrganizationRuntimeDirectory for NoRuntime {
        fn team_runtime_for_endpoint(
            &self,
            _: &crate::RuntimeEndpointReference,
        ) -> Option<std::sync::Arc<dyn crate::OrganizationNativeRuntime>> {
            None
        }

        fn open_claw_runtime(
            &self,
        ) -> Option<std::sync::Arc<dyn crate::OrganizationNativeRuntime>> {
            None
        }
    }

    impl crate::TeamActivityExecutor for NoRuntime {
        fn execute(
            &self,
            _: ActivityExecutionRequest,
        ) -> OwnedRuntimeFuture<ActivityExecutionOutcome> {
            panic!("shutdown must not execute new work")
        }

        fn open_claw_ready(&self) -> bool {
            false
        }
    }

    impl super::super::coordinator::TeamRunAdmission for NoRuntime {
        fn is_admitted(&self) -> bool {
            false
        }
    }

    #[tokio::test]
    async fn shutdown_cancels_and_joins_every_owned_operation() {
        use foundation::execution::{ObservationSink, OwnerRuntimeSystem};
        use std::sync::Arc;

        let root = tempfile::tempdir().unwrap();
        let mut system = OwnerRuntimeSystem::spawn(Default::default());
        let (module, mut owner) = crate::spawn_owner(
            &system,
            crate::OrganizationOwnerInput {
                store: crate::OrganizationStore::open(root.path().join("facts.log")).unwrap(),
                runtime_directory: Arc::new(NoRuntime),
                member_introductions: None,
                team_skill_selections: crate::package::TeamSkillSelectionResolver::open(
                    root.path().join("selections.json"),
                )
                .unwrap(),
            },
        );
        let (_admission, admission_changes) =
            tokio::sync::watch::channel(super::super::coordinator::AdmissionState::Changed);
        let input = TeamRunCoordinatorInput {
            admission: Arc::new(NoRuntime),
            organization: module.handle().clone(),
            activity_executor: Arc::new(NoRuntime),
            admission_changes,
            observation: ObservationSink::disabled(),
        };
        let mut actors = TeamRunActors::default();
        let (cleaned, cleanup) = oneshot::channel();
        let (operation, _) = OperationHandle::spawn(move |cancellation| async move {
            cancellation.cancelled().await;
            cleaned.send(()).unwrap();
            observation("cancelled")
        });
        let (ready, _) = OperationHandle::spawn(|_| async { observation("ready") });
        insert_operation(&mut actors, "run:a", "cancelled", operation);
        insert_operation(&mut actors, "run:b", "ready", ready);
        actors.wake_active_runs(&input, Vec::new(), 0, false).await;
        assert_eq!(actors.capacity(), ACTIVITY_EXECUTION_CONCURRENCY - 2);
        actors
            .cancel_and_join(&input, &mut TeamRunReceiptRouter::new())
            .await;
        cleanup.await.unwrap();
        assert!(actors.actors.is_empty());
        owner.cancel();
        owner.join().await.unwrap();
        system.cancel_and_join().await.unwrap();
    }

    #[test]
    fn completion_wakes_do_not_requeue_deferred_failures() {
        let mut state = ActivityExecutionState::default();
        let activity_id = ActivityId::new("deferred").unwrap();
        state.defer(activity_id.clone());
        state.dirty(activity_id.clone());
        assert!(state.dirty.is_empty());
        state.resume_deferred();
        assert!(state.deferred.is_empty());
        assert!(state.dirty.contains(&activity_id));
    }
}
