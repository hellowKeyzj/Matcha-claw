use std::collections::BTreeSet;

use foundation::execution::{OwnedTask, OwnerRuntimeHandle};
use futures_util::future::BoxFuture;
use organization::{
    BeginCancellationOutcome, GraphRunId, GraphRunLifecycleState, IdempotencyKey,
    NativeDeletionEvidence, OrganizationStore, RoleAbortOutcome, RuntimeEndpointReference,
    StoreFault, TeamId,
};
use platform::trace::{current_session_trace, with_session_trace};
use runtime_directory::OwnedRuntimeFuture;
use tokio_util::sync::CancellationToken;

use crate::{future::boxed, ports::native_effects::RoleSessionRetirementOutcome};

use super::{
    OrganizationCommand, OrganizationQuery,
    actor::{OrganizationRunLane, OrganizationShared},
    team_run::{TeamDeleteOutcome, TeamRunOwner, prepare_runtime_receipt},
};

#[derive(Default)]
pub(super) struct TeamDeletion {
    tasks: Vec<OwnedTask<()>>,
    run_tasks: BTreeSet<(String, String)>,
    removal_tasks: BTreeSet<RuntimeEndpointReference>,
    replies: Vec<PendingDelete>,
}

struct PendingDelete {
    reply: Option<crate::call::CallReply<Result<TeamDeleteOutcome, StoreFault>>>,
    outcome: Result<TeamDeleteOutcome, StoreFault>,
    _guard: Option<tokio::sync::OwnedRwLockWriteGuard<()>>,
    _slot: tokio::sync::OwnedSemaphorePermit,
}

enum RunNativeOutcome {
    Deletion(NativeDeletionEvidence),
    Retirement(RoleSessionRetirementOutcome),
}

struct RunSettlement {
    team_id: TeamId,
    run_id: GraphRunId,
    idempotency_key: String,
    native: RunNativeOutcome,
    observed_at: u64,
    cancellation: CancellationToken,
}

impl RunSettlement {
    fn submit(
        self,
        target: &OwnerRuntimeHandle<OrganizationCommand, OrganizationQuery>,
    ) -> BoxFuture<'_, Result<(), foundation::execution::OwnerRuntimeSendError>> {
        let Self { team_id, run_id, idempotency_key, native, observed_at, cancellation } = self;
        match native {
            RunNativeOutcome::Deletion(native) => boxed(move || {
                target.send_command(OrganizationCommand::TeamDeleteRunNativeSettled {
                    team_id, run_id, idempotency_key, native, observed_at, cancellation,
                })
            }),
            RunNativeOutcome::Retirement(outcome) => boxed(move || {
                target.send_command(OrganizationCommand::TeamDeleteUnconfirmedRunSettled {
                    team_id, run_id, idempotency_key, outcome, observed_at, cancellation,
                })
            }),
        }
    }
}

impl TeamDeletion {
    pub(super) fn has_pending(&self) -> bool {
        self.has_pending_settlements() || !self.replies.is_empty()
            || self.tasks.iter().any(|task| !task.is_finished())
    }

    pub(super) fn cancel(&self) {
        for task in &self.tasks { task.cancel(); }
    }

    pub(super) async fn shutdown(&mut self) {
        self.cancel();
        for mut task in self.tasks.drain(..) {
            let _ = task.join().await;
        }
        self.run_tasks.clear();
        self.removal_tasks.clear();
        for pending in self.replies.drain(..) {
            if let Some(reply) = pending.reply {
                let _ = reply.send(Ok(TeamDeleteOutcome::OutcomeUnknown)).await;
            }
        }
    }

    fn has_pending_settlements(&self) -> bool {
        !self.run_tasks.is_empty() || !self.removal_tasks.is_empty()
    }

    fn delete(
        &mut self,
        store: &mut OrganizationStore,
        owner: &TeamRunOwner,
        shared: &OrganizationShared,
        team_id: TeamId,
        idempotency_key: IdempotencyKey,
        observed_at: u64,
        cancellation: CancellationToken,
    ) -> Result<TeamDeleteOutcome, StoreFault> {
        let cancellation = cancellation.child_token();
        let is_matcha = |endpoint: &RuntimeEndpointReference| {
            runtime_directory::endpoint_from_reference(endpoint.as_str()).is_some_and(|endpoint| {
                endpoint.runtime_adapter_id() == runtime_directory::RuntimeDriverIdentity::matcha_agent().runtime_adapter_id()
            })
        };
        let mut native = Vec::new();
        let outcome = (|| {
            let mut run_ids = store.facts().runs().filter(|run| run.team() == &team_id)
                .map(|run| run.run_id().clone()).collect::<Vec<_>>();
            run_ids.sort();
            let mut pending_settlement = false;
            for run_id in run_ids {
                let requires_native_delete = store.facts().run(&run_id)
                    .is_some_and(|run| run.runtime().is_some() || run.workspace().is_some());
                if !requires_native_delete && store.facts().materialization(&team_id).is_some_and(|receipt| {
                    receipt.roles().any(|role| is_matcha(role.endpoint()))
                }) {
                    let retirement_key = match store.facts().run(&run_id).map(|run| run.lifecycle().state()) {
                        Some(GraphRunLifecycleState::Tombstoned { .. }) => continue,
                        Some(GraphRunLifecycleState::Cancelling { idempotency_key, .. }
                            | GraphRunLifecycleState::Cancelled { idempotency_key, .. }
                            | GraphRunLifecycleState::OutcomeUnknown { idempotency_key, .. }) => idempotency_key.clone(),
                        _ => idempotency_key.as_str().to_owned(),
                    };
                    pending_settlement = true;
                    owner.begin_cancellation(store, &run_id, &retirement_key, observed_at)?;
                    let Ok(receipt) = prepare_runtime_receipt(store, &team_id, &run_id) else {
                        continue;
                    };
                    self.plan_unconfirmed_run(
                        &mut native, shared, &team_id, run_id, &retirement_key,
                        receipt.bindings().iter().filter(|binding| is_matcha(binding.endpoint())).cloned().collect(),
                        observed_at, cancellation.clone(),
                    );
                    continue;
                }
                if requires_native_delete {
                    match super::run_delete::prepare(store, owner,
                        run_id.clone(), idempotency_key.as_str(), observed_at)?
                    {
                        super::run_delete::DeletePreparation::Native { bindings, abort_first } => {
                            pending_settlement = true;
                            self.plan_run_native(&mut native, store, shared, &team_id, run_id,
                                idempotency_key.as_str(), bindings, abort_first, observed_at, cancellation.clone());
                        }
                        super::run_delete::DeletePreparation::Complete(outcome) => {
                            pending_settlement |= !matches!(outcome,
                                organization::GraphRunPurgeOutcome::Purged | organization::GraphRunPurgeOutcome::Replayed);
                        }
                    }
                    continue;
                }
                match owner.begin_cancellation(store, &run_id, idempotency_key.as_str(), observed_at) {
                    Ok(BeginCancellationOutcome::Started(_)) | Ok(BeginCancellationOutcome::Replayed(_)) => {
                        if !tombstone_after_local_cancellation(store, owner, run_id, idempotency_key.as_str(), observed_at)? {
                            pending_settlement = true;
                        }
                    }
                    Ok(BeginCancellationOutcome::AlreadyCancelled) => {
                        if !tombstone_cancelled_run(store, owner, run_id, idempotency_key.as_str(), observed_at)? {
                            pending_settlement = true;
                        }
                    }
                    Ok(BeginCancellationOutcome::Tombstoned) => {}
                    Ok(BeginCancellationOutcome::OutcomeUnknown) => pending_settlement = true,
                    Err(error) => return Err(error),
                }
            }
            if store.facts().team(&team_id).is_none() {
                return Ok(TeamDeleteOutcome::Deleted);
            }
            store.tombstone_team(&team_id, idempotency_key)?;
            let removal_started = self.start_removal_if_ready(store, shared, &team_id, cancellation.clone())?;
            if pending_settlement || removal_started {
                return Ok(TeamDeleteOutcome::OutcomeUnknown);
            }
            Ok(cleanup_outcome(store, &team_id))
        })();
        self.spawn_batch(shared, native, cancellation);
        outcome
    }

    fn plan_run_native(
        &mut self,
        planned: &mut Vec<OwnedRuntimeFuture<RunSettlement>>,
        store: &OrganizationStore,
        shared: &OrganizationShared,
        team_id: &TeamId,
        run_id: GraphRunId,
        idempotency_key: &str,
        bindings: Vec<organization::RoleSessionReceipt>,
        abort_first: bool,
        observed_at: u64,
        cancellation: CancellationToken,
    ) {
        let task_key = (run_id.as_str().to_owned(), idempotency_key.to_owned());
        if !self.run_tasks.insert(task_key) { return; }
        let team_id = team_id.clone();
        let idempotency_key = idempotency_key.to_owned();
        let operation_cancellation = cancellation.child_token();
        let native = super::run_delete::delete_run_sessions(
            store, shared, run_id.clone(), bindings, abort_first, operation_cancellation,
        );
        planned.push(boxed(move || async move {
            let native = native.await;
            RunSettlement {
                team_id, run_id, idempotency_key, native: RunNativeOutcome::Deletion(native),
                observed_at, cancellation,
            }
        }));
    }

    fn plan_unconfirmed_run(
        &mut self,
        planned: &mut Vec<OwnedRuntimeFuture<RunSettlement>>,
        shared: &OrganizationShared,
        team_id: &TeamId,
        run_id: GraphRunId,
        idempotency_key: &str,
        bindings: Vec<organization::RoleSessionReceipt>,
        observed_at: u64,
        cancellation: CancellationToken,
    ) {
        let task_key = (run_id.as_str().to_owned(), idempotency_key.to_owned());
        if !self.run_tasks.insert(task_key) { return; }
        let team_id = team_id.clone();
        let idempotency_key = idempotency_key.to_owned();
        let native = shared.team_retire_unconfirmed_role_sessions(bindings, cancellation.child_token());
        planned.push(boxed(move || async move {
            let outcome = native.await;
            RunSettlement {
                team_id, run_id, idempotency_key, native: RunNativeOutcome::Retirement(outcome),
                observed_at, cancellation,
            }
        }));
    }

    fn spawn_batch(
        &mut self,
        shared: &OrganizationShared,
        planned: Vec<OwnedRuntimeFuture<RunSettlement>>,
        cancellation: CancellationToken,
    ) {
        if planned.is_empty() { return; }
        let Some(target) = shared.command_target.get().cloned() else { return; };
        self.tasks.retain(|task| !task.is_finished());
        let (task, _) = OwnedTask::spawn(move |task_cancellation| async move {
            let _ = foundation::pipeline::map_concurrent(4, planned, |mut native| {
                let target = target.clone();
                let cancellation = cancellation.clone();
                let task_cancellation = task_cancellation.clone();
                boxed(move || async move {
                    let settlement = tokio::select! {
                        settlement = &mut native => settlement,
                        _ = task_cancellation.cancelled() => {
                            cancellation.cancel();
                            native.await
                        }
                    };
                    let _ = settlement.submit(&target).await;
                    Ok::<(), foundation::pipeline::PipelineError>(())
                })
            }).await;
        });
        self.tasks.push(task);
    }

    fn spawn_removal(
        &mut self,
        shared: &OrganizationShared,
        team_id: &TeamId,
        cancellation: CancellationToken,
        native: Vec<(RuntimeEndpointReference, OwnedRuntimeFuture<organization::MaterializationOperationOutcome>)>,
    ) {
        self.tasks.retain(|task| !task.is_finished());
        let Some(command_target) = shared.command_target.get().cloned() else { return; };
        for (endpoint, _) in &native { self.removal_tasks.insert(endpoint.clone()); }
        let trace_id = platform::trace::enabled().then(current_session_trace).flatten().or_else(|| {
            self.replies.first()?.reply.as_ref()?.trace_id()
        });
        let team_id = team_id.clone();
        let (task, _) = OwnedTask::spawn(move |task_cancellation| {
            with_session_trace(trace_id, async move {
                let _ = foundation::pipeline::map_concurrent(4, native, |(endpoint, mut native)| {
                    let cancellation = cancellation.clone();
                    let task_cancellation = task_cancellation.clone();
                    let command_target = command_target.clone();
                    let team_id = team_id.clone();
                    boxed(move || async move {
                        let outcome = tokio::select! {
                            outcome = &mut native => outcome,
                            _ = task_cancellation.cancelled() => {
                                cancellation.cancel();
                                native.await
                            }
                        };
                        let _ = boxed(|| command_target.send_command(OrganizationCommand::TeamDeleteRemovalSettled {
                            team_id, endpoint, outcome,
                        })).await;
                        Ok::<(), foundation::pipeline::PipelineError>(())
                    })
                }).await;
            })
        });
        self.tasks.push(task);
    }

    fn start_removal_if_ready(
        &mut self,
        store: &OrganizationStore,
        shared: &OrganizationShared,
        team_id: &TeamId,
        cancellation: CancellationToken,
    ) -> Result<bool, StoreFault> {
        if self.has_pending_settlements() || !store.facts().runs().filter(|run| run.team() == team_id)
            .all(|run| run.runtime().is_none()
                && matches!(run.lifecycle().state(), GraphRunLifecycleState::Tombstoned { .. }))
        {
            return Ok(false);
        }
        let cancellation = cancellation.child_token();
        let mut native = Vec::new();
        for lifecycle in store.facts().materialization_lifecycles()
            .filter(|lifecycle| lifecycle.team() == Some(team_id))
        {
            let endpoint = lifecycle.endpoint();
            if let Some(removal) = store.team_materialization_removal(team_id, endpoint) {
                native.push((endpoint.clone(), shared.team_remove(removal, cancellation.clone())));
            } else if let Some(request) = store.team_unconfirmed_materialization_cleanup_request(team_id, endpoint) {
                native.push((endpoint.clone(), shared.team_remove_unconfirmed(request, cancellation.clone())));
            }
        }
        let started = !native.is_empty();
        if started { self.spawn_removal(shared, team_id, cancellation, native); }
        Ok(started)
    }

    fn settle_reply(
        &mut self,
        store: Option<&OrganizationStore>,
        team_id: &TeamId,
        settled: Result<TeamDeleteOutcome, StoreFault>,
    ) -> BoxFuture<'static, ()> {
        let has_pending = self.has_pending_settlements();
        for pending in &mut self.replies {
            if matches!(settled, Ok(TeamDeleteOutcome::OutcomeUnknown)
                | Err(StoreFault::CommitOutcomeUnknown(_) | StoreFault::RecoveryRequired))
                || (matches!(pending.outcome, Ok(TeamDeleteOutcome::Deleted))
                    && !matches!(settled, Ok(TeamDeleteOutcome::Deleted)))
            {
                pending.outcome = settled.clone();
            }
            if !has_pending && matches!(pending.outcome, Ok(TeamDeleteOutcome::Deleted)) {
                pending.outcome = Ok(cleanup_outcome(
                    store.expect("pending team deletion has an opened store"), team_id,
                ));
            }
        }
        let replies = if has_pending { Vec::new() } else { std::mem::take(&mut self.replies) };
        boxed(move || async move {
            for pending in replies {
                if let Some(reply) = pending.reply { let _ = reply.send(pending.outcome).await; }
            }
        })
    }
}

fn tombstone_after_local_cancellation(
    store: &mut OrganizationStore,
    owner: &TeamRunOwner,
    run_id: GraphRunId,
    idempotency_key: &str,
    observed_at: u64,
) -> Result<bool, StoreFault> {
    match owner.settle_cancellation(store, &run_id, idempotency_key, RoleAbortOutcome::Confirmed, observed_at)? {
        organization::SettleCancellationOutcome::Cancelled | organization::SettleCancellationOutcome::Replayed => {
            tombstone_cancelled_run(store, owner, run_id, idempotency_key, observed_at)
        }
        organization::SettleCancellationOutcome::Tombstoned => Ok(true),
        organization::SettleCancellationOutcome::OutcomeUnknown => Ok(false),
    }
}

fn tombstone_cancelled_run(
    store: &mut OrganizationStore,
    owner: &TeamRunOwner,
    run_id: GraphRunId,
    idempotency_key: &str,
    observed_at: u64,
) -> Result<bool, StoreFault> {
    Ok(matches!(owner.tombstone(store, &run_id, idempotency_key, observed_at)?,
        organization::TombstoneOutcome::Tombstoned | organization::TombstoneOutcome::Replayed))
}

fn complete_unconfirmed_run(
    store: &mut OrganizationStore,
    owner: &TeamRunOwner,
    team_id: &TeamId,
    run_id: GraphRunId,
    idempotency_key: &str,
    outcome: RoleSessionRetirementOutcome,
    observed_at: u64,
) -> Result<bool, StoreFault> {
    let run = store.facts().run(&run_id).ok_or(StoreFault::InvalidFacts)?;
    if run.team() != team_id || run.runtime().is_some() { return Err(StoreFault::InvalidFacts); }
    if outcome == RoleSessionRetirementOutcome::OutcomeUnknown {
        if matches!(run.lifecycle().state(), GraphRunLifecycleState::Cancelling { .. }) {
            owner.settle_cancellation(store, &run_id, idempotency_key, RoleAbortOutcome::OutcomeUnknown, observed_at)?;
        }
        return Ok(false);
    }
    if matches!(run.lifecycle().state(), GraphRunLifecycleState::Cancelled { .. }
        | GraphRunLifecycleState::Tombstoned { .. })
    {
        return tombstone_cancelled_run(store, owner, run_id, idempotency_key, observed_at);
    }
    tombstone_after_local_cancellation(store, owner, run_id, idempotency_key, observed_at)
}

fn cleanup_outcome(store: &OrganizationStore, team_id: &TeamId) -> TeamDeleteOutcome {
    if !store.facts().runs().filter(|run| run.team() == team_id).all(|run| {
        run.runtime().is_none()
            && matches!(run.lifecycle().state(), GraphRunLifecycleState::Tombstoned { .. })
    }) {
        return TeamDeleteOutcome::OutcomeUnknown;
    }
    if store.facts().materialization_lifecycles()
        .filter(|lifecycle| lifecycle.team() == Some(team_id))
        .all(|lifecycle| matches!(lifecycle,
            organization::TeamMaterializationLifecycle::Tombstoned(
                organization::TombstonedMaterialization::None(_)
                | organization::TombstonedMaterialization::Confirmed {
                    cleanup: organization::TeamMaterializationCleanup::Confirmed(_), ..
                },
            )
        ))
    {
        TeamDeleteOutcome::Deleted
    } else {
        TeamDeleteOutcome::OutcomeUnknown
    }
}

pub(super) fn handle(
    shared: OrganizationShared,
    lane: &mut OrganizationRunLane,
    command: OrganizationCommand,
) -> BoxFuture<'_, ()> {
    match command {
        OrganizationCommand::TeamDelete {
            team_id, idempotency_key, observed_at, reply, guard, slot,
        } => boxed(move || async move {
            if !reply.running().await { return; }
            let outcome = with_session_trace(reply.trace_id(), async {
                match OrganizationRunLane::open_store(&mut lane.store, &lane.store_path) {
                    Ok(store) => lane.team_delete.delete(
                        store, &lane.team_run, &shared, team_id.clone(), idempotency_key,
                        observed_at, reply.cancellation(),
                    ),
                    Err(error) => Err(error),
                }
            }).await;
            if reply.awaits_workflow_settlement() && lane.team_delete.has_pending_settlements() {
                let outcome = match outcome {
                    Err(error) => Err(error),
                    Ok(_) if lane.store.as_ref().expect("team deletion has an opened store").facts().runs()
                        .filter(|run| run.team() == &team_id).any(|run| {
                            !matches!(run.lifecycle().state(), GraphRunLifecycleState::Tombstoned { .. })
                                && !lane.team_delete.run_tasks.iter().any(|(id, _)| id == run.run_id().as_str())
                        }) => Ok(TeamDeleteOutcome::OutcomeUnknown),
                    Ok(_) => Ok(TeamDeleteOutcome::Deleted),
                };
                lane.team_delete.replies.push(PendingDelete { reply: Some(reply), outcome, _guard: Some(guard), _slot: slot });
            } else if lane.team_delete.has_pending_settlements() {
                let _ = reply.send(outcome.clone()).await;
                lane.team_delete.replies.push(PendingDelete { reply: None, outcome, _guard: Some(guard), _slot: slot });
            } else {
                let _ = reply.send(outcome).await;
            }
        }),
        OrganizationCommand::DrainTeamDeleteTasks { reply, .. } => boxed(move || async move {
            if lane.team_delete.tasks.is_empty() {
                // Joined producers precede this Team FIFO barrier; missing settlements stay unknown.
                lane.team_delete.shutdown().await;
            }
            let _ = reply.send(std::mem::take(&mut lane.team_delete.tasks));
        }),
        OrganizationCommand::TeamDeleteRunNativeSettled {
            team_id, run_id, idempotency_key, native, observed_at, cancellation,
        } => boxed(move || async move {
            lane.team_delete.run_tasks.remove(&(run_id.as_str().to_owned(), idempotency_key.clone()));
            let settled = match OrganizationRunLane::open_store(&mut lane.store, &lane.store_path) {
                Ok(store) => match super::run_delete::complete_team_run_delete_native_evidence(
                    store, &lane.team_run, run_id, &idempotency_key, native, observed_at,
                ) {
                    Ok(organization::GraphRunPurgeOutcome::Purged | organization::GraphRunPurgeOutcome::Replayed) => {
                        lane.team_delete.start_removal_if_ready(store, &shared, &team_id, cancellation)
                            .map(|_| TeamDeleteOutcome::Deleted)
                    }
                    Ok(_) => Ok(TeamDeleteOutcome::OutcomeUnknown),
                    Err(error) => Err(error),
                },
                Err(error) => Err(error),
            };
            lane.team_delete.settle_reply(lane.store.as_ref(), &team_id, settled).await;
        }),
        OrganizationCommand::TeamDeleteUnconfirmedRunSettled {
            team_id, run_id, idempotency_key, outcome, observed_at, cancellation,
        } => boxed(move || async move {
            lane.team_delete.run_tasks.remove(&(run_id.as_str().to_owned(), idempotency_key.clone()));
            let settled = match OrganizationRunLane::open_store(&mut lane.store, &lane.store_path) {
                Ok(store) => match complete_unconfirmed_run(
                    store, &lane.team_run, &team_id, run_id, &idempotency_key, outcome, observed_at,
                ) {
                    Ok(true) => lane.team_delete.start_removal_if_ready(store, &shared, &team_id, cancellation)
                        .map(|_| TeamDeleteOutcome::Deleted),
                    Ok(false) => Ok(TeamDeleteOutcome::OutcomeUnknown),
                    Err(error) => Err(error),
                },
                Err(error) => Err(error),
            };
            lane.team_delete.settle_reply(lane.store.as_ref(), &team_id, settled).await;
        }),
        OrganizationCommand::TeamDeleteRemovalSettled { team_id, endpoint, outcome } => boxed(move || async move {
            let settled = OrganizationRunLane::open_store(&mut lane.store, &lane.store_path).and_then(|store| {
                let confirmed = matches!(outcome, organization::MaterializationOperationOutcome::Confirmed { .. });
                store.record_team_materialization_cleanup_outcome(&team_id, &endpoint, outcome)?;
                Ok(if confirmed { TeamDeleteOutcome::Deleted } else { TeamDeleteOutcome::OutcomeUnknown })
            });
            lane.team_delete.removal_tasks.remove(&endpoint);
            lane.team_delete.settle_reply(lane.store.as_ref(), &team_id, settled).await;
        }),
        _ => unreachable!("team deletion command routed to wrong handler"),
    }
}
