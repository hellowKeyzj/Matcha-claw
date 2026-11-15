use std::collections::VecDeque;

use crate::future::boxed;

use foundation::execution::OwnedTask;
use futures_util::future::BoxFuture;
use runtime_directory::OwnedRuntimeFuture;
use tokio_util::sync::CancellationToken;

use crate::{
    BeginCancellationOutcome, CreateGraphRunOutcome, GraphRunId, NativeDeletionEvidence,
    RoleAbortOutcome, RoleSessionCreationOutcome, RoleSessionReceipt, RunRuntimeReceipt,
    RuntimeReceiptOutcome, StoreFault, TeamCreationFailure, TeamCreationFailureReason, TeamCreationStage,
    application::team_runtime::{RoleSessionCreateError, TeamRuntimeStatus},
};

use super::{
    OrganizationCommand,
    actor::{OrganizationLaneKey, OrganizationRunLane, OrganizationShared},
    team_run::{ManualTeamCreateOutcome, creation_store_failure, prepare_runtime_receipt, settle_public_cancellation},
};

type RoleReply = crate::call::CallReply<Result<RoleSessionReceipt, RoleSessionCreateError>>;

enum InitialReply {
    Manual(CreateGraphRunOutcome, crate::call::CallReply<ManualTeamCreateOutcome>),
    Template(crate::TeamId, CreateGraphRunOutcome, crate::call::CallReply<(Result<CreateGraphRunOutcome, TeamRuntimeStatus>, Option<TeamCreationFailure>, Option<crate::run::public_projection::TeamRunPublicWorkspace>)>),
    Task(crate::task_execution::TaskExecutionIdentity, crate::call::CallReply<Result<String, crate::task_execution::TaskExecutionReceipt>>),
    Recovery(std::sync::Arc<tokio::sync::OwnedRwLockReadGuard<()>>, tokio::sync::oneshot::Sender<()>),
}

struct Initial {
    receipt: RunRuntimeReceipt,
    pending: VecDeque<String>,
    reply: InitialReply,
}

impl InitialReply {
    fn native_guard(&self) -> Option<std::sync::Arc<tokio::sync::OwnedRwLockReadGuard<()>>> {
        match self {
            Self::Manual(_, reply) => reply.native_guard(),
            Self::Template(_, _, reply) => reply.native_guard(),
            Self::Task(_, reply) => reply.native_guard(),
            Self::Recovery(guard, _) => Some(guard.clone()),
        }
    }
}

enum Operation {
    Role { key: String, binding: RoleSessionReceipt, readback: bool, reply: RoleReply },
    Initial { initial: Initial, current: Option<(String, RoleSessionReceipt, bool)> },
    Cancel { run: GraphRunId, key: String, at: u64, reply: crate::call::CallReply<Result<BeginCancellationOutcome, StoreFault>> },
    TaskCancel { identity: crate::task_execution::TaskExecutionIdentity, key: String, at: u64, reply: crate::call::CallReply<crate::task_execution::TaskExecutionReceipt> },
    Delete { run: GraphRunId, key: String, at: u64, reply: crate::call::CallReply<Result<crate::GraphRunPurgeOutcome, StoreFault>> },
}

impl Operation {
    fn native_guard(&self) -> Option<std::sync::Arc<tokio::sync::OwnedRwLockReadGuard<()>>> {
        match self {
            Self::Role { reply, .. } => reply.native_guard(),
            Self::Initial { initial, .. } => initial.reply.native_guard(),
            Self::Cancel { reply, .. } => reply.native_guard(),
            Self::TaskCancel { reply, .. } => reply.native_guard(),
            Self::Delete { reply, .. } => reply.native_guard(),
        }
    }
}

enum NativeResult {
    Role(RoleSessionCreationOutcome),
    Receipt(RuntimeReceiptOutcome, Option<TeamCreationFailure>),
    Abort(RoleAbortOutcome),
    Delete(NativeDeletionEvidence),
}

enum NativeEffect {
    Await(OwnedRuntimeFuture<NativeResult>),
    Cancel { bindings: Vec<RoleSessionReceipt>, readback: bool },
}

impl NativeEffect {
    fn cancellation(
        run: &crate::GraphRunFacts,
        outcome: &BeginCancellationOutcome,
        pending_bindings: Vec<RoleSessionReceipt>,
    ) -> Option<(String, Self)> {
        let (mut bindings, readback) = match outcome {
            BeginCancellationOutcome::Started(plan) => (plan.bindings().to_vec(), false),
            BeginCancellationOutcome::Replayed(_) | BeginCancellationOutcome::OutcomeUnknown => {
                (run.confirmed_role_sessions(), true)
            }
            _ => return None,
        };
        for intent in run.role_session_intents().values() {
            if intent.phase == crate::store::RoleSessionPhase::SubmissionUncertain
                && !bindings.contains(&intent.binding)
            {
                bindings.push(intent.binding.clone());
            }
        }
        let key = match run.lifecycle().state() {
            crate::GraphRunLifecycleState::Cancelling { idempotency_key, .. }
            | crate::GraphRunLifecycleState::OutcomeUnknown { idempotency_key, .. } => idempotency_key.clone(),
            _ => return None,
        };
        for binding in pending_bindings {
            if !bindings.contains(&binding) { bindings.push(binding); }
        }
        Some((key, Self::Cancel { bindings, readback }))
    }

    fn start(self, shared: &OrganizationShared, cancellation: CancellationToken) -> OwnedRuntimeFuture<NativeResult> {
        match self {
            Self::Await(native) => native,
            Self::Cancel { bindings, readback } => {
                let native = shared.team_cancel_role_sessions(bindings, readback, cancellation);
                boxed(move || async move { NativeResult::Abort(native.await) })
            }
        }
    }
}

struct Work {
    operation: Operation,
    effect: NativeEffect,
    slot: tokio::sync::OwnedSemaphorePermit,
    cancellation: CancellationToken,
}

struct Pending {
    operation: Operation,
    slot: tokio::sync::OwnedSemaphorePermit,
    cancellation: CancellationToken,
}

#[derive(Default)]
pub(super) struct NativeOperations {
    task: Option<OwnedTask<Result<NativeResult, tokio::task::JoinError>>>,
    pending: Option<Pending>,
    deferred: Option<Work>,
    creating: bool,
    bindings: Vec<RoleSessionReceipt>,
}

impl NativeOperations {
    pub(super) fn has_pending(&self) -> bool { self.task.is_some() || self.deferred.is_some() }

    pub(super) fn ready(&self, command: &OrganizationCommand) -> bool {
        if self.task.is_none() { return true; }
        match command {
            OrganizationCommand::NativeOperationSettled { .. } | OrganizationCommand::RunNativeLease { .. } => true,
            OrganizationCommand::RunCancel { .. } | OrganizationCommand::TaskCancel { .. } => self.creating && self.deferred.is_none(),
            OrganizationCommand::RoleSessionCreate { .. } | OrganizationCommand::RecoverRoleSessions { .. }
            | OrganizationCommand::ManualTeamRunCreate { .. } | OrganizationCommand::RunCreateFromTeamTemplate { .. }
            | OrganizationCommand::TaskCreate { .. } | OrganizationCommand::RunStart { .. }
            | OrganizationCommand::RunDeleteAndPurge { .. } | OrganizationCommand::RunDelete { .. }
            | OrganizationCommand::RunPurge { .. } => false,
            _ => true,
        }
    }

    fn spawn(&mut self, shared: &OrganizationShared, lane_key: OrganizationLaneKey, work: Work) {
        self.creating = matches!(work.operation, Operation::Role { .. } | Operation::Initial { .. });
        self.bindings = match &work.operation {
            Operation::Role { binding, .. } => vec![binding.clone()],
            Operation::Initial { current: Some((_, binding, _)), .. } => vec![binding.clone()],
            Operation::Initial { initial, current: None } => initial.receipt.bindings().to_vec(),
            _ => Vec::new(),
        };
        let Work { operation, effect, slot, cancellation } = work;
        self.pending = Some(Pending { operation, slot, cancellation: cancellation.clone() });
        let target = shared.command_target.get().cloned();
        let shared = shared.clone();
        self.task = Some(OwnedTask::spawn(move |shutdown| async move {
            let (mut native, _) = OwnedTask::spawn(move |shutdown| async move {
                let mut native = effect.start(&shared, cancellation.clone());
                tokio::select! {
                    biased;
                    result = &mut native => result,
                    _ = shutdown.cancelled() => { cancellation.cancel(); native.await },
                }
            });
            let result = tokio::select! {
                biased;
                result = native.join() => result,
                _ = shutdown.cancelled() => native.cancel_and_join().await,
            };
            if let Some(target) = target {
                if let Ok(permit) = target.reserve_control().await {
                    let _ = permit.send(OrganizationCommand::NativeOperationSettled { key: lane_key });
                }
            }
            result
        }).0);
    }

    pub(super) fn cancel(&self) {
        if let Some(pending) = &self.pending { pending.cancellation.cancel(); }
        if let Some(task) = &self.task { task.cancel(); }
        if let Some(work) = &self.deferred { work.cancellation.cancel(); }
    }
}

pub(super) fn handle(
    shared: OrganizationShared,
    lane_key: OrganizationLaneKey,
    lane: &mut OrganizationRunLane,
    command: OrganizationCommand,
) -> BoxFuture<'_, ()> {
    match command {
        OrganizationCommand::RunNativeLease { reply, .. } => boxed(move || async move {
            let guard = lane.native.pending.as_ref().and_then(|pending| pending.operation.native_guard());
            let _ = reply.send(guard);
        }),
        OrganizationCommand::NativeOperationSettled { .. } => boxed(move || async move {
            complete(&shared, lane_key, lane).await;
        }),
        command => {
            let prepared = prepare(shared.clone(), lane, command);
            boxed(move || async move {
                let (work, lane) = prepared.await;
                if let Some(work) = work {
                    if lane.native.task.is_some() {
                        if let Some(pending) = &lane.native.pending { pending.cancellation.cancel(); }
                        lane.native.deferred = Some(work);
                    } else {
                        lane.native.spawn(&shared, lane_key, work);
                    }
                }
            })
        }
    }
}

fn prepare(shared: OrganizationShared, lane: &mut OrganizationRunLane, command: OrganizationCommand) -> BoxFuture<'_, (Option<Work>, &mut OrganizationRunLane)> {
    match command {
        OrganizationCommand::RoleSessionCreate { native_slot, team_id, run_id, role_id, idempotency_key, scope, reply } => boxed(move || async move {
            if !reply.running().await { return (None, lane); }
            let work = async {
                let store = match OrganizationRunLane::open_store(&mut lane.store, &lane.store_path) {
                    Ok(store) => store,
                    Err(error) => {
                        let _ = reply.send(Err(RoleSessionCreateError::Store(error))).await;
                        return None;
                    }
                };
                let cancellation = reply.cancellation().child_token();
                let intent = match store.reserve_role_session(&team_id, &run_id, &role_id, &idempotency_key, &scope) {
                    Ok(intent) => intent,
                    Err(error) => { let _ = reply.send(Err(RoleSessionCreateError::Store(error))).await; return None; }
                };
                let binding = intent.binding.clone();
                if store.facts().run(&run_id).is_some_and(|run| run.session_installed(&binding)) {
                    let _ = reply.send(Ok(binding)).await;
                    return None;
                }
                match super::role_session::prepare(store, &shared, idempotency_key.as_str().to_owned(), intent, cancellation.clone()) {
                    Ok(Some(prepared)) => {
                        let (key, binding, readback, native) = prepared.into_parts();
                        Some(Work { operation: Operation::Role { key, binding, readback, reply }, slot: native_slot, cancellation,
                            effect: NativeEffect::Await(boxed(move || async move { NativeResult::Role(native.await) })) })
                    }
                    Ok(None) => { let _ = reply.send(Ok(binding)).await; None }
                    Err(error) => { let _ = reply.send(Err(error)).await; None }
                }
            }.await;
            (work, lane)
        }),
        OrganizationCommand::ManualTeamRunCreate { native_slot, team_id, run, run_idempotency_key, reply } => boxed(move || async move {
            let work = async {
                let store = match OrganizationRunLane::open_store(&mut lane.store, &lane.store_path) {
                    Ok(store) => store,
                    Err(error) => {
                        reply.creation_failure(creation_store_failure(TeamCreationStage::InitializingSessions, &error)).await;
                        reply.creation(None, Err(&error)).await;
                        let _ = reply.send(ManualTeamCreateOutcome::Unavailable).await;
                        return None;
                    }
                };
                match super::manual_team::prepare_run(store, &lane.team_run, team_id, run, run_idempotency_key, &reply).await {
                    Ok((created, receipt)) => {
                        let cancellation = reply.cancellation().child_token();
                        prepare_initial(&shared, store, native_slot, receipt, InitialReply::Manual(created, reply), cancellation).await
                    }
                    Err(outcome) => { let _ = reply.send(outcome).await; None }
                }
            }.await;
            (work, lane)
        }),
        OrganizationCommand::RunCreateFromTeamTemplate { native_slot, team_id, run_id, idempotency_key, created_at, reply } => boxed(move || async move {
            if !reply.running().await { return (None, lane); }
            let work = async {
                let store = match OrganizationRunLane::open_store(&mut lane.store, &lane.store_path) {
                    Ok(store) => store,
                    Err(error) => {
                        let failure = creation_store_failure(TeamCreationStage::InitializingSessions, &error);
                        reply.creation_failure(failure).await;
                        let _ = reply.send((Err(TeamRuntimeStatus::Unavailable), Some(failure), None)).await;
                        return None;
                    }
                };
                let prepared = (|| {
                    let run = lane.team_run.run_from_team_template(store, &team_id, run_id.clone(), idempotency_key.as_str(), created_at)
                        .map_err(|(_, failure)| (TeamRuntimeStatus::Rejected, failure))?;
                    let created = lane.team_run.create(store, run, idempotency_key.as_str())
                        .map_err(|error| (TeamRuntimeStatus::Unavailable, creation_store_failure(TeamCreationStage::InitializingSessions, &error)))?;
                    if matches!(created, CreateGraphRunOutcome::ConflictingIdempotency) {
                        return Err((TeamRuntimeStatus::Unavailable, TeamCreationFailure::new(TeamCreationStage::InitializingSessions, TeamCreationFailureReason::StoreConflict)));
                    }
                    let receipt = prepare_runtime_receipt(store, &team_id, &run_id).map_err(|(outcome, failure)| (status(outcome), failure))?;
                    Ok((created, receipt))
                })();
                match prepared {
                    Ok((created, receipt)) => {
                        let cancellation = reply.cancellation().child_token();
                        prepare_initial(&shared, store, native_slot, receipt, InitialReply::Template(team_id, created, reply), cancellation).await
                    }
                    Err((status, failure)) => { reply.creation_failure(failure).await; let _ = reply.send((Err(status), Some(failure), None)).await; None }
                }
            }.await;
            (work, lane)
        }),
        OrganizationCommand::TaskCreate { native_slot, request, reply } => boxed(move || async move {
            if !reply.running().await { return (None, lane); }
            let work = async {
                let store = match OrganizationRunLane::open_store(&mut lane.store, &lane.store_path) {
                    Ok(store) => store,
                    Err(error) => {
                        let _ = reply.send(Err(crate::task_execution::store_failure(request.identity, &error))).await;
                        return None;
                    }
                };
                let cancellation = reply.cancellation().child_token();
                match super::task_execution::prepare_create(&shared, &lane.team_run, store, request, cancellation.clone()) {
                    Ok((identity, receipt)) => prepare_initial(&shared, store, native_slot, receipt, InitialReply::Task(identity, reply), cancellation).await,
                    Err(outcome) => { let _ = reply.send(Err(outcome)).await; None }
                }
            }.await;
            (work, lane)
        }),
        OrganizationCommand::RecoverRoleSessions { native_slot, run_id, guard, cancellation, reply } => boxed(move || async move {
            let work = async {
                let store = match OrganizationRunLane::open_store(&mut lane.store, &lane.store_path) {
                    Ok(store) => store,
                    Err(_) => {
                        let _ = reply.send(()); drop(guard);
                        return None;
                    }
                };
                let prepared = store.facts().run(&run_id).filter(|run| {
                    matches!(run.lifecycle().state(), crate::GraphRunLifecycleState::Active)
                        && store.facts().team(run.team()).is_some_and(|team| !team.tombstoned())
                }).and_then(|run| {
                    let pending = run.role_session_intents().iter()
                        .filter(|(_, intent)| intent.phase != crate::store::RoleSessionPhase::Confirmed)
                        .map(|(key, _)| key.clone()).collect();
                    RunRuntimeReceipt::try_new(run_id, run.owned_role_sessions()).ok()
                        .map(|receipt| (receipt, pending))
                });
                if let Some((receipt, pending)) = prepared {
                    next_initial(&shared, store, Initial { receipt, pending, reply: InitialReply::Recovery(guard, reply) }, native_slot, cancellation.child_token()).await
                } else { let _ = reply.send(()); None }
            }.await;
            (work, lane)
        }),
        OrganizationCommand::RunCancel { native_slot, run_id, idempotency_key, requested_at, reply } => boxed(move || async move {
            if !reply.running().await { return (None, lane); }
            let cancellation_replay = lane.native.task.is_some() && (!lane.native.creating || lane.native.deferred.is_some());
            let work = async {
                if cancellation_replay {
                    let _ = reply.send(Ok(BeginCancellationOutcome::OutcomeUnknown)).await;
                    return None;
                }
                let pending_bindings = lane.native.bindings.clone();
                let store = match OrganizationRunLane::open_store(&mut lane.store, &lane.store_path) {
                    Ok(store) => store,
                    Err(error) => {
                        let _ = reply.send(Err(error)).await;
                        return None;
                    }
                };
                let outcome = lane.team_run.begin_cancellation(store, &run_id, &idempotency_key, requested_at);
                match outcome {
                    Ok(outcome) => {
                        let effect = store.facts().run(&run_id)
                            .and_then(|run| NativeEffect::cancellation(run, &outcome, pending_bindings));
                        if let Some((key, effect)) = effect {
                            let cancellation = reply.cancellation().child_token();
                            Some(Work { operation: Operation::Cancel { run: run_id, key, at: requested_at, reply }, slot: native_slot, cancellation, effect })
                        } else { let _ = reply.send(Ok(outcome)).await; None }
                    }
                    Err(error) => { let _ = reply.send(Err(error)).await; None }
                }
            }.await;
            (work, lane)
        }),
        OrganizationCommand::TaskCancel { native_slot, identity, idempotency_key, requested_at, reply } => boxed(move || async move {
            if !reply.running().await { return (None, lane); }
            let cancellation_replay = lane.native.task.is_some() && (!lane.native.creating || lane.native.deferred.is_some());
            let work = async {
                if cancellation_replay {
                    let outcome = match OrganizationRunLane::open_store(&mut lane.store, &lane.store_path) {
                        Ok(store) => crate::task_execution::inspect(store, identity),
                        Err(error) => crate::task_execution::store_failure(identity, &error),
                    };
                    let _ = reply.send(outcome).await;
                    return None;
                }
                let pending_bindings = lane.native.bindings.clone();
                let store = match OrganizationRunLane::open_store(&mut lane.store, &lane.store_path) {
                    Ok(store) => store,
                    Err(error) => {
                        let _ = reply.send(crate::task_execution::store_failure(identity, &error)).await;
                        return None;
                    }
                };
                match super::task_execution::prepare_cancel(&lane.team_run, store, identity.clone(), &idempotency_key, requested_at, !pending_bindings.is_empty()) {
                    Ok(outcome) => {
                        let effect = store.facts().run(&identity.run_id)
                            .and_then(|run| NativeEffect::cancellation(run, &outcome, pending_bindings));
                        if let Some((key, effect)) = effect {
                            let cancellation = reply.cancellation().child_token();
                            Some(Work { operation: Operation::TaskCancel { identity, key, at: requested_at, reply }, slot: native_slot, cancellation, effect })
                        } else { let _ = reply.send(crate::task_execution::inspect(store, identity)).await; None }
                    }
                    Err(outcome) => { let _ = reply.send(outcome).await; None }
                }
            }.await;
            (work, lane)
        }),
        OrganizationCommand::RunDeleteAndPurge { native_slot, run_id, idempotency_key, observed_at, reply } => boxed(move || async move {
            if !reply.running().await { return (None, lane); }
            let work = async {
                let store = match OrganizationRunLane::open_store(&mut lane.store, &lane.store_path) {
                    Ok(store) => store,
                    Err(error) => {
                        let _ = reply.send(Err(error)).await;
                        return None;
                    }
                };
                match super::run_delete::prepare(store, &lane.team_run, run_id.clone(), &idempotency_key, observed_at) {
                    Ok(super::run_delete::DeletePreparation::Native { bindings, abort_first }) => {
                        let cancellation = reply.cancellation().child_token();
                        let native = super::run_delete::delete_run_sessions(store, &shared, run_id.clone(), bindings, abort_first, cancellation.clone());
                        Some(Work { operation: Operation::Delete { run: run_id, key: idempotency_key, at: observed_at, reply }, slot: native_slot, cancellation,
                            effect: NativeEffect::Await(boxed(move || async move { NativeResult::Delete(native.await) })) })
                    }
                    Ok(super::run_delete::DeletePreparation::Complete(outcome)) => { let _ = reply.send(Ok(outcome)).await; None }
                    Err(error) => { let _ = reply.send(Err(error)).await; None }
                }
            }.await;
            (work, lane)
        }),
        _ => unreachable!("native operation admission"),
    }
}

async fn prepare_initial(shared: &OrganizationShared, store: &mut crate::OrganizationStore, native_slot: tokio::sync::OwnedSemaphorePermit, receipt: RunRuntimeReceipt, reply: InitialReply, cancellation: CancellationToken) -> Option<Work> {
    let workspace = match store.prepare_run_workspace(receipt.team_run()) {
        Ok(workspace) => workspace,
        Err(error) => {
            finish_initial(store, Initial { receipt, pending: VecDeque::new(), reply }, RuntimeReceiptOutcome::Unavailable,
                Some(creation_store_failure(TeamCreationStage::InitializingSessions, &error))).await;
            return None;
        }
    };
    if (workspace.is_some() || matches!(reply, InitialReply::Task(..)))
        && store.facts().run(receipt.team_run()).and_then(|run| run.runtime()) == Some(&receipt)
    {
        finish_initial(store, Initial { receipt, pending: VecDeque::new(), reply }, RuntimeReceiptOutcome::Installed, None).await;
        return None;
    }
    if workspace.is_none() && !matches!(reply, InitialReply::Task(..)) {
        let groups = super::run_delete::group_role_sessions(receipt.bindings().to_vec()).into_iter().collect();
        let run_id = receipt.team_run().clone();
        let initial = Initial { receipt, pending: VecDeque::new(), reply };
        let shared = shared.clone();
        let native_cancellation = cancellation.clone();
        return Some(Work { operation: Operation::Initial { initial, current: None }, slot: native_slot, cancellation,
            effect: NativeEffect::Await(boxed(move || async move {
                let outcomes = foundation::pipeline::map_concurrent(4, groups, |(endpoint, bindings)| {
                    let runtime = shared.team_runtime_for_endpoint(&endpoint);
                    let receipt = RunRuntimeReceipt::try_new(run_id.clone(), bindings)
                        .expect("endpoint subset of a valid run receipt");
                    let cancellation = native_cancellation.clone();
                    async move {
                        Ok::<_, foundation::pipeline::PipelineError>(match runtime {
                            Some(runtime) => runtime.confirm_team_run_receipt_cancellable(receipt, None, cancellation).await,
                            None => (RuntimeReceiptOutcome::OutcomeUnknown, Some(TeamCreationFailure::new(
                                TeamCreationStage::InitializingSessions, TeamCreationFailureReason::Unavailable,
                            ))),
                        })
                    }
                }).await;
                let Ok(outcomes) = outcomes else { return NativeResult::Receipt(RuntimeReceiptOutcome::OutcomeUnknown, None); };
                let mut result = (RuntimeReceiptOutcome::Installed, None);
                for outcome in outcomes {
                    if outcome.0 != RuntimeReceiptOutcome::Installed
                        && (result.0 == RuntimeReceiptOutcome::Installed || outcome.0 == RuntimeReceiptOutcome::OutcomeUnknown)
                    {
                        result = outcome;
                    }
                }
                NativeResult::Receipt(result.0, result.1)
            })) });
    }
    let pending = store.facts().run(receipt.team_run()).map(|run| run.role_session_intents().keys().cloned().collect()).unwrap_or_default();
    next_initial(shared, store, Initial { receipt, pending, reply }, native_slot, cancellation).await
}

async fn next_initial(shared: &OrganizationShared, store: &mut crate::OrganizationStore, mut initial: Initial, native_slot: tokio::sync::OwnedSemaphorePermit, cancellation: CancellationToken) -> Option<Work> {
    while let Some(key) = initial.pending.pop_front() {
        if cancellation.is_cancelled() {
            finish_initial(store, initial, RuntimeReceiptOutcome::OutcomeUnknown, None).await;
            return None;
        }
        let intent = store.facts().run(initial.receipt.team_run()).and_then(|run| run.role_session_intents().get(&key)).cloned();
        let Some(intent) = intent else { finish_initial(store, initial, RuntimeReceiptOutcome::OutcomeUnknown, None).await; return None; };
        match super::role_session::prepare(store, shared, key, intent, cancellation.clone()) {
            Ok(Some(prepared)) => {
                let (key, binding, readback, native) = prepared.into_parts();
                return Some(Work { operation: Operation::Initial { initial, current: Some((key, binding, readback)) }, slot: native_slot, cancellation,
                    effect: NativeEffect::Await(boxed(move || async move { NativeResult::Role(native.await) })) });
            }
            Ok(None) => {}
            Err(error) if matches!(initial.reply, InitialReply::Recovery(..)) => { let _ = error; }
            Err(error) => { finish_initial(store, initial, role_outcome(error), None).await; return None; }
        }
    }
    let outcome = if store.facts().run(initial.receipt.team_run()).and_then(|run| run.runtime()) == Some(&initial.receipt) {
        RuntimeReceiptOutcome::Installed
    } else { RuntimeReceiptOutcome::OutcomeUnknown };
    finish_initial(store, initial, outcome, None).await;
    None
}

fn finish_initial(store: &mut crate::OrganizationStore, initial: Initial, outcome: RuntimeReceiptOutcome, failure: Option<TeamCreationFailure>) -> BoxFuture<'_, ()> {
    match initial.reply {
        InitialReply::Manual(created, reply) => boxed(move || async move {
            let outcome = super::manual_team::settle_run(store, created, initial.receipt, outcome, failure, &reply).await;
            let _ = reply.send(outcome).await;
        }),
        InitialReply::Template(team_id, created, reply) => boxed(move || async move {
            let outcome = if outcome == RuntimeReceiptOutcome::Installed {
                super::team_run::install_prepared_runtime_receipt(store, initial.receipt)
                    .map(|()| created).map_err(|error| (TeamRuntimeStatus::OutcomeUnknown, creation_store_failure(TeamCreationStage::InitializingSessions, &error)))
            } else { Err((status(outcome), failure.unwrap_or_else(|| TeamCreationFailure::new(TeamCreationStage::InitializingSessions, super::actor::runtime_receipt_failure_reason(&outcome))))) };
            let outcome = match outcome {
                Ok(created) => {
                    let workspace = match &created {
                        CreateGraphRunOutcome::Created(run_id) | CreateGraphRunOutcome::Replayed(run_id) => {
                            crate::run::query::query_run_workspace(store.facts(), &team_id, run_id)
                        }
                        _ => None,
                    };
                    (Ok(created), None, workspace)
                }
                Err((status, failure)) => { reply.creation_failure(failure).await; (Err(status), Some(failure), None) }
            };
            let _ = reply.send(outcome).await;
        }),
        InitialReply::Task(identity, reply) => boxed(move || async move { let _ = reply.send(super::task_execution::settle_create(store, identity, initial.receipt, outcome)).await; }),
        InitialReply::Recovery(guard, reply) => boxed(move || async move { let _ = reply.send(()); drop(guard); }),
    }
}

async fn complete(shared: &OrganizationShared, lane_key: OrganizationLaneKey, lane: &mut OrganizationRunLane) {
    let Some(task) = lane.native.task.as_mut() else { return; };
    let result = task.join().await.and_then(|result| result);
    lane.native.task.take();
    lane.native.bindings.clear();
    let Some(Pending { operation, slot, cancellation }) = lane.native.pending.take() else { return; };
    let result = result.unwrap_or_else(|error| {
        platform::trace::runtime_trace("runtime.team.native.join.error", || serde_json::json!({
            "runHash": match &lane_key {
                OrganizationLaneKey::Run(run) => Some(platform::trace::identifier_hash(run.as_str())),
                _ => None,
            },
            "panicked": error.is_panic(),
            "cancelled": error.is_cancelled(),
        }));
        match &operation {
            Operation::Role { .. } | Operation::Initial { current: Some(_), .. } => NativeResult::Role(RoleSessionCreationOutcome {
                outcome: RuntimeReceiptOutcome::OutcomeUnknown,
                failure: None,
                submission: crate::RoleSessionSubmission::Unknown,
            }),
            Operation::Initial { current: None, .. } => NativeResult::Receipt(RuntimeReceiptOutcome::OutcomeUnknown, None),
            Operation::Cancel { .. } | Operation::TaskCancel { .. } => NativeResult::Abort(RoleAbortOutcome::OutcomeUnknown),
            Operation::Delete { .. } => NativeResult::Delete(NativeDeletionEvidence::OutcomeUnknown),
        }
    });
    let mut slot = Some(slot);
    let next = settle(shared, lane, operation, result, &mut slot, cancellation).await;
    if let Some(work) = next { lane.native.spawn(shared, lane_key, work); }
    else { finish_deferred(shared, lane_key, &mut lane.native); }
}

fn settle<'a>(
    shared: &'a OrganizationShared,
    lane: &'a mut OrganizationRunLane,
    operation: Operation,
    result: NativeResult,
    slot: &'a mut Option<tokio::sync::OwnedSemaphorePermit>,
    cancellation: CancellationToken,
) -> BoxFuture<'a, Option<Work>> {
    match (operation, result) {
        (Operation::Role { key, binding, readback, reply }, NativeResult::Role(result)) => boxed(move || async move {
            let (outcome, failure) = match OrganizationRunLane::open_store(&mut lane.store, &lane.store_path) {
                Ok(store) => super::role_session::settle(store, &key, &binding, readback, result),
                Err(_) => (Err(RoleSessionCreateError::Runtime(TeamRuntimeStatus::OutcomeUnknown)), result.failure),
            };
            if let Some(failure) = failure { reply.creation_failure(failure).await; }
            let _ = reply.send(outcome.map(|()| binding)).await;
            None
        }),
        (Operation::Initial { initial, current }, result) => boxed(move || async move {
            match OrganizationRunLane::open_store(&mut lane.store, &lane.store_path) {
                Ok(store) => {
                    let (outcome, failure) = match (current, result) {
                        (Some((key, binding, readback)), NativeResult::Role(result)) => {
                            let (outcome, failure) = super::role_session::settle(store, &key, &binding, readback, result);
                            (outcome.map_or_else(role_outcome, |_| RuntimeReceiptOutcome::Installed), failure)
                        }
                        (None, NativeResult::Receipt(outcome, failure)) => {
                            finish_initial(store, initial, outcome, failure).await;
                            return None;
                        }
                        _ => unreachable!("initial native result"),
                    };
                    if outcome == RuntimeReceiptOutcome::Installed || matches!(initial.reply, InitialReply::Recovery(..)) {
                        next_initial(shared, store, initial, slot.take().expect("initial operation owns its native slot"), cancellation).await
                    } else { finish_initial(store, initial, outcome, failure).await; None }
                }
                Err(error) => { initial_store_failure(initial, error, &result).await; None }
            }
        }),
        (Operation::Cancel { run, key, at, reply }, NativeResult::Abort(outcome)) => boxed(move || async move {
            let outcome = OrganizationRunLane::open_store(&mut lane.store, &lane.store_path)
                .and_then(|store| settle_public_cancellation(store, &lane.team_run, &run, &key, outcome, at));
            let _ = reply.send(outcome).await;
            None
        }),
        (Operation::TaskCancel { identity, key, at, reply }, NativeResult::Abort(outcome)) => boxed(move || async move {
            let outcome = match OrganizationRunLane::open_store(&mut lane.store, &lane.store_path) {
                Ok(store) => super::task_execution::settle_cancel(&lane.team_run, store, identity, key, at, outcome),
                Err(error) => crate::task_execution::store_failure(identity, &error),
            };
            let _ = reply.send(outcome).await;
            None
        }),
        (Operation::Delete { run, key, at, reply }, NativeResult::Delete(outcome)) => boxed(move || async move {
            let outcome = OrganizationRunLane::open_store(&mut lane.store, &lane.store_path)
                .and_then(|store| super::run_delete::complete_team_run_delete_native_evidence(store, &lane.team_run, run, &key, outcome, at));
            let _ = reply.send(outcome).await;
            None
        }),
        _ => unreachable!("native operation result"),
    }
}

fn finish_deferred(shared: &OrganizationShared, key: OrganizationLaneKey, operations: &mut NativeOperations) {
    if let Some(work) = operations.deferred.take() { operations.spawn(shared, key, work); }
    else { operations.creating = false; }
}

pub(super) async fn shutdown(shared: &OrganizationShared, key: OrganizationLaneKey, lane: &mut OrganizationRunLane) {
    lane.native.cancel();
    while lane.native.has_pending() {
        if lane.native.task.is_none() { finish_deferred(shared, key.clone(), &mut lane.native); }
        lane.native.cancel();
        complete(shared, key.clone(), lane).await;
    }
}

fn status(outcome: RuntimeReceiptOutcome) -> TeamRuntimeStatus {
    match outcome {
        RuntimeReceiptOutcome::Rejected => TeamRuntimeStatus::Rejected,
        RuntimeReceiptOutcome::Unavailable => TeamRuntimeStatus::Unavailable,
        RuntimeReceiptOutcome::Installed | RuntimeReceiptOutcome::OutcomeUnknown => TeamRuntimeStatus::OutcomeUnknown,
    }
}

fn role_outcome(error: RoleSessionCreateError) -> RuntimeReceiptOutcome {
    match match error { RoleSessionCreateError::Store(error) => super::role_session::store_status(error), RoleSessionCreateError::Runtime(status) => status } {
        TeamRuntimeStatus::Rejected => RuntimeReceiptOutcome::Rejected,
        TeamRuntimeStatus::Unavailable => RuntimeReceiptOutcome::Unavailable,
        TeamRuntimeStatus::OutcomeUnknown => RuntimeReceiptOutcome::OutcomeUnknown,
    }
}

fn initial_store_failure(initial: Initial, error: StoreFault, native: &NativeResult) -> OwnedRuntimeFuture<()> {
    let installed = matches!(native,
        NativeResult::Role(RoleSessionCreationOutcome { outcome: RuntimeReceiptOutcome::Installed, submission: crate::RoleSessionSubmission::Settled, .. })
        | NativeResult::Receipt(RuntimeReceiptOutcome::Installed, _));
    let failure = creation_store_failure(TeamCreationStage::InitializingSessions, &error);
    match initial.reply {
        InitialReply::Manual(_, reply) => boxed(move || async move {
            reply.creation_failure(failure).await;
            reply.creation(installed.then_some(true), Err(&error)).await;
            let _ = reply.send(ManualTeamCreateOutcome::OutcomeUnknown).await;
        }),
        InitialReply::Template(_, _, reply) => boxed(move || async move {
            reply.creation_failure(failure).await;
            let _ = reply.send((Err(TeamRuntimeStatus::OutcomeUnknown), Some(failure), None)).await;
        }),
        InitialReply::Task(identity, reply) => boxed(move || async move { let _ = reply.send(Err(crate::task_execution::TaskExecutionReceipt::new(identity, crate::task_execution::TaskExecutionState::Unknown))).await; }),
        InitialReply::Recovery(guard, reply) => boxed(move || async move { let _ = reply.send(()); drop(guard); }),
    }
}

