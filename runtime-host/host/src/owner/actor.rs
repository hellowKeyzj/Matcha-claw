use std::{
    collections::{BTreeMap, BTreeSet},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use foundation::execution::OperationHandle;
use matcha_agent::{
    peer::{
        RendererApprovalPhase, RendererEvent, RendererEventEnvelope, RendererMessageLifecycle,
        RendererRunPhase, RendererToolPhase, SessionSubscriptionItem,
    },
    session::{receipt::TerminalRunStatus, recovery::RecoveryReason as MatchaRecoveryReason},
};
use openclaw::toolchain::{
    ToolchainJobLookup, ToolchainJobSnapshot, ToolchainJobStatus, ToolchainOperationEventState,
};
use organization::{DeliveryClaim, DeliveryId, GraphRunId, PromptDeliveryRequest};
use serde_json::to_value;
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::{JoinError, JoinSet},
};

use crate::{
    Host, HostPhase, RequestAdmissionClosed,
    composition::{
        ChannelLoginWaitOperation, HostEvent, HostEvents, TeamRunDeliveryTarget,
        team_trigger_cron::{CronReconciliation, TeamTriggerCron},
    },
    diagnostics::{
        DiagnosticsArchiveCancellation, DiagnosticsArchiveCancellationGuard,
        DiagnosticsArchiveReceipt,
    },
    parent_callback::ParentRuntimeJobEventName,
    session_state::{
        ApprovalPhase, ApprovalView, ItemStatus, RecoveryReason, RunPhase, SessionApplyResult,
        SessionChange, SessionContent, SessionIdentity, SessionItem, SessionProvider,
        SessionSourceBinding, ToolPhase, ToolView,
    },
};

use super::{
    ActorExit, HostStatePublisher, ShutdownAttempt, ShutdownRequest,
    command::{Command, DiagnosticsCommand, MatchaCommand, RuntimeCommand},
    team_run_operations::{
        TeamRunOperation, cancel_team_run_operations, poll_team_run_operations,
        start_team_run_operation, wait_for_team_run_operation,
    },
    team_runtime_operations::{
        TeamRuntimeOperation, cancel_team_runtime_operations, poll_team_runtime_operations,
        start_team_runtime_operation, start_team_skill_operation, wait_for_team_runtime_operation,
    },
};

struct DiagnosticsOperation {
    cancellation: DiagnosticsArchiveCancellation,
    _actor_cancellation: DiagnosticsArchiveCancellationGuard,
    operation: OperationHandle<DiagnosticsArchiveReceipt>,
    replies: Vec<oneshot::Sender<Result<DiagnosticsArchiveReceipt, RequestAdmissionClosed>>>,
}

struct ChannelLoginWaitActorOperation {
    operation: ChannelLoginWaitOperation,
    reply: oneshot::Sender<crate::channel_login::Outcome>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TerminalWatchCompletion {
    Terminal(TerminalRunStatus),
    OutcomeUnknown,
}

pub(super) struct TerminalWatches {
    watched_delivery_ids: BTreeSet<DeliveryId>,
    tasks: JoinSet<(DeliveryId, TerminalWatchCompletion)>,
}

#[derive(Debug, Eq, PartialEq)]
struct TerminalWatchObservation {
    delivery_id: DeliveryId,
    status: TerminalRunStatus,
}

impl TerminalWatches {
    fn new() -> Self {
        Self {
            watched_delivery_ids: BTreeSet::new(),
            tasks: JoinSet::new(),
        }
    }

    fn is_empty(&self) -> bool {
        self.tasks.is_empty()
    }

    fn start_recovery(&mut self, host: &Host) {
        for delivery_id in host.terminal_observation_deliveries() {
            self.start(host, delivery_id);
        }
    }

    pub(super) fn start(&mut self, host: &Host, delivery_id: DeliveryId) {
        let Some(watch) = host.terminal_watch(&delivery_id) else {
            return;
        };
        if !self.watched_delivery_ids.insert(delivery_id.clone()) {
            return;
        }
        self.tasks.spawn(async move {
            let completion = match watch.wait().await {
                Some(status) => TerminalWatchCompletion::Terminal(status),
                None => TerminalWatchCompletion::OutcomeUnknown,
            };
            (delivery_id, completion)
        });
    }

    async fn join_next(&mut self) -> Option<TerminalWatchObservation> {
        let completed = self.tasks.join_next().await?;
        let Ok((delivery_id, completion)) = completed else {
            return None;
        };
        match completion {
            TerminalWatchCompletion::Terminal(status) => Some(TerminalWatchObservation {
                delivery_id,
                status,
            }),
            TerminalWatchCompletion::OutcomeUnknown => None,
        }
    }

    async fn cancel(&mut self) {
        self.tasks.abort_all();
        while self.tasks.join_next().await.is_some() {}
        self.watched_delivery_ids.clear();
    }
}

impl DiagnosticsOperation {
    fn start(
        host: &Host,
        cancellation: DiagnosticsArchiveCancellation,
        reply: oneshot::Sender<Result<DiagnosticsArchiveReceipt, RequestAdmissionClosed>>,
    ) -> Result<
        Self,
        (
            RequestAdmissionClosed,
            oneshot::Sender<Result<DiagnosticsArchiveReceipt, RequestAdmissionClosed>>,
        ),
    > {
        let admission = match host.admit_diagnostics() {
            Ok(admission) => admission,
            Err(closed) => return Err((closed, reply)),
        };
        let task_cancellation = cancellation.clone();
        let (operation, _) = OperationHandle::spawn(move |operation_cancellation| async move {
            tokio::task::spawn_blocking(move || {
                if operation_cancellation.is_cancelled() {
                    task_cancellation.cancel();
                }
                admission.collect(&task_cancellation)
            })
            .await
            .unwrap_or_else(|_| DiagnosticsArchiveReceipt::failed())
        });
        Ok(Self {
            _actor_cancellation: cancellation.cancel_on_drop(),
            cancellation,
            operation,
            replies: vec![reply],
        })
    }

    fn add_waiter(
        &mut self,
        reply: oneshot::Sender<Result<DiagnosticsArchiveReceipt, RequestAdmissionClosed>>,
    ) {
        self.replies.push(reply);
    }

    fn complete(mut self, result: Result<DiagnosticsArchiveReceipt, JoinError>) {
        let receipt = result.unwrap_or_else(|_| DiagnosticsArchiveReceipt::failed());
        for reply in self.replies.drain(..) {
            let _ = reply.send(Ok(receipt.clone()));
        }
    }

    async fn cancel_and_complete(self) {
        let Self {
            cancellation,
            _actor_cancellation,
            mut operation,
            mut replies,
        } = self;
        cancellation.cancel();
        let receipt = operation
            .cancel_and_join()
            .await
            .unwrap_or_else(|_| DiagnosticsArchiveReceipt::failed());
        for reply in replies.drain(..) {
            let _ = reply.send(Ok(receipt.clone()));
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DeliveryReconciliationStatus {
    Delivered,
    AlreadyClaimed,
    AwaitingRetry,
    Terminal,
    OutcomeUnknown,
    TargetUnavailable,
    StoreFault,
    DeliveryError,
    ResponseUnavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct DeliveryReconciliationObservation {
    delivery_id: DeliveryId,
    status: DeliveryReconciliationStatus,
}

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
enum DeliveryReconciliationKey {
    Delivery(DeliveryId),
    Run(GraphRunId),
}

enum DeliveryReconciliationCompletion {
    Run,
    Observation(DeliveryReconciliationObservation),
    OpenClaw {
        delivery_id: DeliveryId,
        claim: DeliveryClaim,
        outcome: organization::PromptDeliveryOutcome,
    },
    Matcha {
        delivery_id: DeliveryId,
        claim: DeliveryClaim,
        delivery: PromptDeliveryRequest,
        outcome: organization::PromptDeliveryOutcome,
    },
}

struct DeliveryReconciliationWork {
    operation: OperationHandle<DeliveryReconciliationCompletion>,
}

#[derive(Default)]
struct DeliveryReconciliationState {
    last: Option<DeliveryReconciliationObservation>,
    last_failure: Option<DeliveryReconciliationObservation>,
    dirty: BTreeSet<DeliveryReconciliationKey>,
    processing: BTreeMap<DeliveryReconciliationKey, DeliveryReconciliationWork>,
}

impl DeliveryReconciliationState {
    fn dirty(&mut self, key: DeliveryReconciliationKey) {
        if !self.processing.contains_key(&key) {
            self.dirty.insert(key);
        }
    }

    fn start(
        &mut self,
        key: DeliveryReconciliationKey,
        operation: OperationHandle<DeliveryReconciliationCompletion>,
    ) {
        self.dirty.remove(&key);
        self.processing
            .insert(key, DeliveryReconciliationWork { operation });
    }

    fn capacity(&self) -> usize {
        DELIVERY_RECONCILIATION_CONCURRENCY.saturating_sub(self.processing.len())
    }

    fn dirty_run(&mut self, run_id: GraphRunId) {
        self.dirty(DeliveryReconciliationKey::Run(run_id));
    }

    fn dirty_delivery(&mut self, delivery_id: DeliveryId) {
        self.dirty(DeliveryReconciliationKey::Delivery(delivery_id));
    }

    fn record(&mut self, observation: DeliveryReconciliationObservation) {
        if !matches!(
            observation.status,
            DeliveryReconciliationStatus::Delivered
                | DeliveryReconciliationStatus::AlreadyClaimed
                | DeliveryReconciliationStatus::AwaitingRetry
                | DeliveryReconciliationStatus::Terminal
        ) {
            self.last_failure = Some(observation.clone());
        }
        self.last = Some(observation);
    }

    async fn poll_completed(&mut self) -> Vec<DeliveryReconciliationCompletion> {
        let mut completed = Vec::new();
        let mut pending = BTreeMap::new();
        for (key, mut work) in std::mem::take(&mut self.processing) {
            if work.operation.is_finished() {
                match work.operation.join().await {
                    Ok(completion) => completed.push(completion),
                    Err(_) => {
                        if let DeliveryReconciliationKey::Delivery(delivery_id) = key {
                            completed.push(DeliveryReconciliationCompletion::Observation(
                                DeliveryReconciliationObservation {
                                    delivery_id,
                                    status: DeliveryReconciliationStatus::ResponseUnavailable,
                                },
                            ));
                        }
                    }
                }
            } else {
                pending.insert(key, work);
            }
        }
        self.processing = pending;
        completed
    }

    #[cfg(test)]
    fn last(&self) -> Option<&DeliveryReconciliationObservation> {
        self.last.as_ref()
    }

    #[cfg(test)]
    fn last_failure(&self) -> Option<&DeliveryReconciliationObservation> {
        self.last_failure.as_ref()
    }

    #[cfg(test)]
    fn record_target_unavailable(&mut self, delivery_id: DeliveryId) {
        self.record(DeliveryReconciliationObservation {
            delivery_id,
            status: DeliveryReconciliationStatus::TargetUnavailable,
        });
    }
}

struct ToolchainWatch {
    job_id: String,
    changes: watch::Receiver<ToolchainJobSnapshot>,
    done_sent: bool,
}

impl ToolchainWatch {
    fn new(state: ToolchainOperationEventState) -> Self {
        Self {
            job_id: state.job_id,
            changes: state.changes,
            done_sent: false,
        }
    }

    fn snapshot(&self) -> ToolchainJobSnapshot {
        self.changes.borrow().clone()
    }
}

enum Next {
    Shutdown(ShutdownRequest),
    Event(Option<HostEvent>),
    CronTick,
    Command(Option<Box<Command>>),
    Diagnostics(Result<DiagnosticsArchiveReceipt, JoinError>),
    TerminalWatch(Option<TerminalWatchObservation>),
    ToolchainChanged(Result<(), watch::error::RecvError>),
    ChannelLoginWait,
    PeerLifecycle,
    TeamRuntime,
    TeamRun,
}

pub(super) async fn run(
    mut host: Host,
    mut events: HostEvents,
    mut commands: mpsc::Receiver<Command>,
    mut shutdown: mpsc::Receiver<ShutdownRequest>,
    output: mpsc::Sender<HostEvent>,
    state: HostStatePublisher,
) -> ActorExit {
    let mut diagnostics = None;
    let mut events_open = true;
    let mut terminal_watches = TerminalWatches::new();
    let mut toolchain_watch = None;
    let mut channel_login_waits = Vec::new();
    let mut team_runtime_operations = Vec::new();
    let mut team_run_operations = Vec::new();
    let mut team_trigger_cron = TeamTriggerCron::default();
    let mut delivery_reconciliation = DeliveryReconciliationState::default();
    terminal_watches.start_recovery(&host);
    sync_toolchain_watch(&host, &mut toolchain_watch).await;
    reconcile_team_trigger_cron(&mut host, &mut team_trigger_cron);
    reconcile_team_run_deliveries(
        &mut host,
        &mut terminal_watches,
        &mut delivery_reconciliation,
    )
    .await;
    state.publish(host.state());
    loop {
        let next = next(
            Some(&mut events),
            &mut events_open,
            &mut commands,
            &mut shutdown,
            &mut diagnostics,
            &mut terminal_watches,
            &mut toolchain_watch,
            &mut channel_login_waits,
            &mut team_runtime_operations,
            &mut team_run_operations,
            host.has_peer_lifecycle_operations(),
        )
        .await;
        match next {
            Next::Shutdown(reply) => {
                close_commands(&mut commands);
                return shutdown_after_operations(
                    &mut host,
                    reply,
                    &mut diagnostics,
                    &mut terminal_watches,
                    &mut toolchain_watch,
                    &mut shutdown,
                    &mut channel_login_waits,
                    &mut team_runtime_operations,
                    &mut team_run_operations,
                )
                .await;
            }
            Next::Event(Some(HostEvent::OpenClawCanonical(ingress))) => {
                let result = host.apply_openclaw_canonical(ingress);
                if matches!(result, SessionApplyResult::Rejected { .. }) {
                    return host.shutdown().await.map(|_| ());
                }
            }
            Next::Event(Some(HostEvent::Matcha(SessionSubscriptionItem::Event(event)))) => {
                host.trace_matcha_renderer_event(&event);
                let route_key = event.route_key().to_owned();
                let session_key = event.session_key().to_owned();
                let source_epoch = event.source_epoch();
                let native_cursor = Some(event.source_cursor());
                let run_id = Some(event.run_id().to_owned());
                let changes = match matcha_event_changes(event) {
                    Some(changes) => changes,
                    None => continue,
                };
                let Some(binding) =
                    SessionSourceBinding::new(session_key.clone(), Some(route_key), source_epoch)
                else {
                    continue;
                };
                let identity = crate::session_state::SessionIdentity::new(
                    session_key,
                    SessionProvider::MatchaAgent,
                    None,
                );
                let result = host.apply_native_session_change(
                    SessionProvider::MatchaAgent,
                    binding.clone(),
                    identity,
                    run_id.clone(),
                    native_cursor,
                    changes,
                );
                match result {
                    SessionApplyResult::Applied(_) | SessionApplyResult::Duplicate { .. } => {}
                    SessionApplyResult::Gap { .. } => {
                        if matches!(
                            host.apply_session_recovery(
                                SessionProvider::MatchaAgent,
                                binding,
                                None,
                                run_id,
                                native_cursor,
                                RecoveryReason::CursorGap,
                            ),
                            SessionApplyResult::Rejected { .. }
                        ) {
                            return host.shutdown().await.map(|_| ());
                        }
                    }
                    SessionApplyResult::Stale { .. } => {
                        if matches!(
                            host.apply_session_recovery(
                                SessionProvider::MatchaAgent,
                                binding,
                                None,
                                run_id,
                                native_cursor,
                                RecoveryReason::CursorStale,
                            ),
                            SessionApplyResult::Rejected { .. }
                        ) {
                            return host.shutdown().await.map(|_| ());
                        }
                    }
                    SessionApplyResult::Rejected { .. } => {
                        log_matcha_owner_shutdown(&host, &binding, run_id.as_deref(), native_cursor, &result);
                        return host.shutdown().await.map(|_| ());
                    }
                }
            }
            Next::Event(Some(HostEvent::Matcha(SessionSubscriptionItem::Recovery {
                route_key,
                run_id,
                recovery,
            }))) => {
                let Some(cursor) = recovery.native_cursor() else {
                    return host.shutdown().await.map(|_| ());
                };
                let session_key = cursor.session_id().as_str().to_owned();
                let Some(binding) = SessionSourceBinding::new(
                    session_key.clone(),
                    Some(route_key),
                    recovery.source_epoch(),
                ) else {
                    return host.shutdown().await.map(|_| ());
                };
                host.trace_matcha_subscription_recovery(
                    &session_key,
                    &run_id,
                    cursor.sequence().get(),
                    recovery.source_epoch(),
                    recovery.reason(),
                );
                let result = host.apply_session_recovery(
                    SessionProvider::MatchaAgent,
                    binding,
                    SessionIdentity::new(session_key, SessionProvider::MatchaAgent, None),
                    Some(run_id),
                    Some(cursor.sequence().get()),
                    matcha_recovery_reason(recovery.reason()),
                );
                if matches!(result, SessionApplyResult::Rejected { .. }) {
                    return host.shutdown().await.map(|_| ());
                }
            }
            Next::Event(Some(event @ HostEvent::OpenClawRuntime)) => {
                state.publish(host.state());
                if output.send(event).await.is_err() {
                    return host.shutdown().await.map(|_| ());
                }
            }
            Next::Event(Some(event)) => {
                if output.send(event).await.is_err() {
                    return host.shutdown().await.map(|_| ());
                }
            }
            Next::Event(None) => events_open = false,
            Next::CronTick => {
                host.reap_cron_operations().await;
                host.reap_fleet_operations();
                let peer_lifecycle_changed = host.reap_peer_lifecycle_operations().await;
                if peer_lifecycle_changed {
                    state.publish(host.state());
                    if output.send(HostEvent::OpenClawRuntime).await.is_err() {
                        return host.shutdown().await.map(|_| ());
                    }
                }
                reconcile_team_trigger_cron(&mut host, &mut team_trigger_cron);
                reconcile_team_run_deliveries(
                    &mut host,
                    &mut terminal_watches,
                    &mut delivery_reconciliation,
                )
                .await;
            }
            Next::Command(Some(command)) => {
                let shutdown_reply = execute_command(
                    &mut host,
                    *command,
                    &mut diagnostics,
                    &mut terminal_watches,
                    &mut shutdown,
                    &mut channel_login_waits,
                    &mut team_runtime_operations,
                    &mut team_run_operations,
                )
                .await;
                poll_team_runtime_operations(&mut host, &mut team_runtime_operations).await;
                poll_team_run_operations(&mut host, &mut team_run_operations).await;
                state.publish(host.state());
                sync_toolchain_watch(&host, &mut toolchain_watch).await;
                if let Some(reply) = shutdown_reply {
                    close_commands(&mut commands);
                    return shutdown_after_operations(
                        &mut host,
                        reply,
                        &mut diagnostics,
                        &mut terminal_watches,
                        &mut toolchain_watch,
                        &mut shutdown,
                        &mut channel_login_waits,
                        &mut team_runtime_operations,
                        &mut team_run_operations,
                    )
                    .await;
                }
            }
            Next::Command(None) => break,
            Next::ChannelLoginWait => {
                poll_channel_login_waits(&mut host, &mut channel_login_waits).await;
                state.publish(host.state());
            }
            Next::TeamRuntime => {
                poll_team_runtime_operations(&mut host, &mut team_runtime_operations).await;
                state.publish(host.state());
            }
            Next::TeamRun => {
                poll_team_run_operations(&mut host, &mut team_run_operations).await;
                state.publish(host.state());
            }
            Next::PeerLifecycle => {
                let peer_lifecycle_changed = host.reap_peer_lifecycle_operations().await;
                state.publish(host.state());
                if peer_lifecycle_changed && output.send(HostEvent::OpenClawRuntime).await.is_err()
                {
                    return host.shutdown().await.map(|_| ());
                }
            }
            Next::Diagnostics(result) => {
                let operation = diagnostics
                    .take()
                    .expect("diagnostics completion must retain its operation");
                operation.complete(result);
            }
            Next::TerminalWatch(Some(observation)) => {
                let _ = host.observe_team_run_matcha_terminal(
                    observation.delivery_id,
                    observation.status,
                    now_seconds(),
                );
                state.publish(host.state());
            }
            Next::TerminalWatch(None) => {}
            Next::ToolchainChanged(result) => {
                let Some(watch) = toolchain_watch.as_mut() else {
                    continue;
                };
                if result.is_err() {
                    let lookup = host.settle_open_claw_toolchain_install(&watch.job_id).await;
                    if let ToolchainJobLookup::Known(snapshot) = lookup {
                        emit_toolchain_event(
                            &mut host,
                            ParentRuntimeJobEventName::RuntimeJobDone,
                            &snapshot,
                        );
                    }
                    toolchain_watch = None;
                    state.publish(host.state());
                    continue;
                }
                let snapshot = watch.snapshot();
                if matches!(
                    snapshot.status,
                    ToolchainJobStatus::Queued | ToolchainJobStatus::Running
                ) {
                    emit_toolchain_event(
                        &mut host,
                        ParentRuntimeJobEventName::RuntimeJobProgress,
                        &snapshot,
                    );
                    state.publish(host.state());
                    continue;
                }
                if !watch.done_sent {
                    let snapshot =
                        match host.settle_open_claw_toolchain_install(&watch.job_id).await {
                            ToolchainJobLookup::Known(snapshot) => snapshot,
                            ToolchainJobLookup::Unknown => snapshot,
                        };
                    emit_toolchain_event(
                        &mut host,
                        ParentRuntimeJobEventName::RuntimeJobDone,
                        &snapshot,
                    );
                    watch.done_sent = true;
                    toolchain_watch = None;
                    state.publish(host.state());
                }
            }
        }
    }

    close_commands(&mut commands);
    cancel_diagnostics(&mut diagnostics).await;
    terminal_watches.cancel().await;
    cancel_channel_login_waits(&mut channel_login_waits).await;
    cancel_team_runtime_operations(&mut team_runtime_operations).await;
    let lookup = host.cancel_open_claw_toolchain_install().await;
    if let ToolchainJobLookup::Known(snapshot) = lookup {
        emit_toolchain_event(
            &mut host,
            ParentRuntimeJobEventName::RuntimeJobDone,
            &snapshot,
        );
    }
    host.shutdown().await.map(|_| ())
}

async fn wait_for_diagnostics(
    diagnostics: &mut Option<DiagnosticsOperation>,
) -> Result<DiagnosticsArchiveReceipt, JoinError> {
    let Some(operation) = diagnostics.as_mut() else {
        return std::future::pending().await;
    };
    operation.operation.join().await
}

async fn next(
    mut events: Option<&mut HostEvents>,
    events_open: &mut bool,
    commands: &mut mpsc::Receiver<Command>,
    shutdown: &mut mpsc::Receiver<ShutdownRequest>,
    diagnostics: &mut Option<DiagnosticsOperation>,
    terminal_watches: &mut TerminalWatches,
    toolchain_watch: &mut Option<ToolchainWatch>,
    channel_login_waits: &mut Vec<ChannelLoginWaitActorOperation>,
    team_runtime_operations: &mut Vec<TeamRuntimeOperation>,
    team_run_operations: &mut Vec<TeamRunOperation>,
    has_peer_lifecycle_operations: bool,
) -> Next {
    tokio::select! {
        biased;
        Some(reply) = shutdown.recv() => Next::Shutdown(reply),
        event = wait_for_events(&mut events), if *events_open => Next::Event(event),
        result = wait_for_diagnostics(diagnostics) => Next::Diagnostics(result),
        result = wait_for_toolchain(toolchain_watch), if toolchain_watch.is_some() => Next::ToolchainChanged(result),
        _ = wait_for_channel_login_wait(channel_login_waits), if !channel_login_waits.is_empty() => Next::ChannelLoginWait,
        _ = wait_for_team_runtime_operation(team_runtime_operations), if !team_runtime_operations.is_empty() => Next::TeamRuntime,
        _ = wait_for_team_run_operation(team_run_operations), if !team_run_operations.is_empty() => Next::TeamRun,
        _ = wait_for_peer_lifecycle(has_peer_lifecycle_operations), if has_peer_lifecycle_operations => Next::PeerLifecycle,
        delivery_id = terminal_watches.join_next(), if !terminal_watches.is_empty() => Next::TerminalWatch(delivery_id),
        _ = tokio::time::sleep(Duration::from_secs(30)) => Next::CronTick,
        command = commands.recv() => Next::Command(command.map(Box::new)),
    }
}

async fn wait_for_events(events: &mut Option<&mut HostEvents>) -> Option<HostEvent> {
    match events.as_deref_mut() {
        Some(events) => events.next().await,
        None => std::future::pending().await,
    }
}

fn has_completed_channel_login_wait(waits: &[ChannelLoginWaitActorOperation]) -> bool {
    waits
        .iter()
        .any(|wait| wait.operation.operation.is_finished())
}

async fn wait_for_channel_login_wait(waits: &mut [ChannelLoginWaitActorOperation]) {
    loop {
        if has_completed_channel_login_wait(waits) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn wait_for_peer_lifecycle(active: bool) {
    if active {
        tokio::time::sleep(Duration::from_millis(10)).await;
    } else {
        std::future::pending::<()>().await;
    }
}

async fn poll_channel_login_waits(
    host: &mut Host,
    waits: &mut Vec<ChannelLoginWaitActorOperation>,
) {
    let mut pending = Vec::with_capacity(waits.len());
    for wait in waits.drain(..) {
        if wait.operation.operation.is_finished() {
            let completion = host.join_channel_login_wait(wait.operation).await;
            let _ = wait.reply.send(completion.outcome);
        } else {
            pending.push(wait);
        }
    }
    *waits = pending;
}

async fn cancel_channel_login_waits(waits: &mut Vec<ChannelLoginWaitActorOperation>) {
    for wait in waits.drain(..) {
        wait.operation.operation.cancel();
        let _ = wait.reply.send(crate::channel_login::Outcome::Cancelled);
    }
}

fn matcha_recovery_reason(reason: &MatchaRecoveryReason) -> RecoveryReason {
    match reason {
        MatchaRecoveryReason::CursorGap { .. } => RecoveryReason::CursorGap,
        MatchaRecoveryReason::CursorStale { .. } => RecoveryReason::CursorStale,
        MatchaRecoveryReason::EventOverflow | MatchaRecoveryReason::BroadcastLagged { .. } => {
            RecoveryReason::EventOverflow
        }
        MatchaRecoveryReason::ConnectionClosed { .. } | MatchaRecoveryReason::Restart => {
            RecoveryReason::NativeUnavailable
        }
        MatchaRecoveryReason::ReplayBoundary { .. }
        | MatchaRecoveryReason::ProjectionRejected { .. } => RecoveryReason::NativeUnknown,
    }
}

fn log_matcha_owner_shutdown(
    host: &Host,
    binding: &SessionSourceBinding,
    run_id: Option<&str>,
    native_cursor: Option<u64>,
    result: &SessionApplyResult,
) {
    let Some(trace_id) = host.session_trace_id(binding.session_key(), run_id) else {
        return;
    };
    let rejection = match result {
        SessionApplyResult::Rejected { reason } => Some(format!("{reason:?}")),
        _ => None,
    };
    crate::transport::session_trace::log(
        "runtime.matcha.owner-shutdown",
        Some(trace_id),
        serde_json::json!({
            "sessionKey": crate::transport::session_trace::id_shape(Some(binding.session_key())),
            "runId": crate::transport::session_trace::id_shape(run_id),
            "nativeCursor": native_cursor,
            "sourceEpoch": binding.source_epoch(),
            "result": "rejected",
            "rejection": rejection,
        }),
    );
}

fn matcha_event_changes(event: RendererEventEnvelope) -> Option<Vec<SessionChange>> {
    let run_id = event.run_id().to_owned();
    let event = event.into_event();
    match event {
        RendererEvent::Run { phase, .. } => Some(vec![SessionChange::RunPhaseChanged {
            run_id,
            phase: match phase {
                RendererRunPhase::Started => RunPhase::Started,
                RendererRunPhase::WaitingForApproval => RunPhase::WaitingForApproval,
                RendererRunPhase::Completed => RunPhase::Completed,
                RendererRunPhase::Cancelled => RunPhase::Cancelled,
                RendererRunPhase::Failed => RunPhase::Failed,
                RendererRunPhase::Interrupted => RunPhase::Interrupted,
            },
        }]),
        RendererEvent::Message {
            message_id,
            lifecycle,
            message_text: Some(text),
            ..
        } => Some(vec![SessionChange::MessageUpdated {
            item: SessionItem::AssistantTurn {
                item_id: message_id.clone(),
                run_id: Some(run_id),
                message_id: Some(message_id),
                status: match lifecycle {
                    RendererMessageLifecycle::Started => ItemStatus::Streaming,
                    RendererMessageLifecycle::Delta => ItemStatus::Streaming,
                    RendererMessageLifecycle::Completed => ItemStatus::Final,
                },
                segments: vec![SessionContent::Text { text: text.clone() }],
                text,
            },
        }]),
        RendererEvent::Message { .. } => Some(vec![SessionChange::RecoveryRequired {
            reason: RecoveryReason::NativeUnknown,
        }]),
        RendererEvent::Tool {
            tool_call_id,
            phase,
            ..
        } => Some(vec![SessionChange::ToolUpdated {
            tool: ToolView {
                tool_call_id,
                run_id: Some(run_id),
                name: None,
                phase: match phase {
                    RendererToolPhase::Started => ToolPhase::Started,
                    RendererToolPhase::Updated => ToolPhase::Updated,
                    RendererToolPhase::Completed => ToolPhase::Completed,
                    RendererToolPhase::Failed => ToolPhase::Failed,
                },
                summary: None,
                is_error: None,
            },
        }]),
        RendererEvent::Approval {
            approval_id,
            phase,
            option_ids,
            ..
        } => Some(vec![SessionChange::ApprovalUpdated {
            approval: ApprovalView {
                approval_id,
                run_id: Some(run_id),
                phase: match phase {
                    RendererApprovalPhase::Requested => ApprovalPhase::Requested,
                    RendererApprovalPhase::Resolved => ApprovalPhase::Resolved,
                },
                option_ids,
            },
        }]),
    }
}

async fn wait_for_toolchain(
    toolchain_watch: &mut Option<ToolchainWatch>,
) -> Result<(), watch::error::RecvError> {
    let Some(toolchain_watch) = toolchain_watch.as_mut() else {
        return std::future::pending().await;
    };
    if matches!(
        toolchain_watch.snapshot().status,
        ToolchainJobStatus::Succeeded | ToolchainJobStatus::Failed
    ) {
        return Ok(());
    }
    toolchain_watch.changes.changed().await
}

fn emit_toolchain_event(
    host: &mut Host,
    event_name: ParentRuntimeJobEventName,
    snapshot: &ToolchainJobSnapshot,
) {
    let payload = match to_value(
        crate::projection::job_compatibility::openclaw_toolchain_snapshot(snapshot.clone()),
    ) {
        Ok(payload) => payload,
        Err(_) => return,
    };
    host.emit_parent_runtime_job_event(event_name, payload);
}

async fn sync_toolchain_watch(host: &Host, watch: &mut Option<ToolchainWatch>) {
    if watch.is_none() {
        *watch = host.toolchain_event_state().await.map(ToolchainWatch::new);
    }
}

async fn execute_command(
    host: &mut Host,
    command: Command,
    diagnostics: &mut Option<DiagnosticsOperation>,
    terminal_watches: &mut TerminalWatches,
    shutdown: &mut mpsc::Receiver<ShutdownRequest>,
    channel_login_waits: &mut Vec<ChannelLoginWaitActorOperation>,
    team_runtime_operations: &mut Vec<TeamRuntimeOperation>,
    team_run_operations: &mut Vec<TeamRunOperation>,
) -> Option<ShutdownRequest> {
    match command {
        Command::Diagnostics(command) => {
            execute_diagnostics_command(host, command, diagnostics).await;
            None
        }
        command => {
            if command.cancels_diagnostics() {
                cancel_diagnostics(diagnostics).await;
            }
            if command.cancels_terminal_watches() {
                terminal_watches.cancel().await;
            }
            let mut next_command = Some(command);
            loop {
                let command = next_command
                    .take()
                    .expect("actor command must remain until executed");
                let command = match command {
                    Command::Matcha(MatchaCommand::Start(reply)) => {
                        host.start_matcha_operation(reply);
                        return None;
                    }
                    Command::Matcha(MatchaCommand::Stop(reply)) => {
                        host.stop_matcha_operation(reply);
                        return None;
                    }
                    Command::Matcha(MatchaCommand::Restart(reply)) => {
                        host.restart_matcha_operation(reply);
                        return None;
                    }
                    Command::Runtime(RuntimeCommand::Start(reply)) => {
                        host.start_open_claw_operation(reply);
                        return None;
                    }
                    Command::Runtime(RuntimeCommand::Stop(reply)) => {
                        host.stop_open_claw_operation(reply);
                        return None;
                    }
                    Command::Runtime(RuntimeCommand::Restart(reply)) => {
                        host.restart_open_claw_operation(reply);
                        return None;
                    }
                    Command::Runtime(RuntimeCommand::ChannelLoginWait {
                        channel,
                        timeout_ms,
                        account_id,
                        session_key,
                        current_qr_data_url,
                        cancellation,
                        reply,
                    }) => {
                        match host.start_channel_login_wait(
                            channel,
                            timeout_ms,
                            account_id,
                            session_key,
                            current_qr_data_url,
                            cancellation,
                        ) {
                            Ok(operation) => channel_login_waits
                                .push(ChannelLoginWaitActorOperation { operation, reply }),
                            Err(outcome) => {
                                let _ = reply.send(outcome);
                            }
                        }
                        return None;
                    }
                    Command::TeamSkill(command) => {
                        match start_team_skill_operation(host, command, team_runtime_operations) {
                            Some(command) => Command::TeamSkill(command),
                            None => return None,
                        }
                    }
                    command @ Command::TeamRuntime { .. } => {
                        match start_team_runtime_operation(
                            host,
                            command,
                            team_runtime_operations,
                            team_run_operations,
                        ) {
                            Some(command) => command,
                            None => return None,
                        }
                    }
                    Command::TeamRun(command) => match start_team_run_operation(
                        host,
                        *command,
                        terminal_watches,
                        team_run_operations,
                    )
                    .await
                    {
                        Some(command) => Command::team_run(command),
                        None => return None,
                    },
                    command => command,
                };
                let outcome = {
                    let operation = command.execute(host);
                    tokio::pin!(operation);
                    tokio::select! {
                        biased;
                        Some(reply) = shutdown.recv() => return Some(reply),
                        command = &mut operation => command,
                    }
                };
                match outcome {
                    Some(next) => next_command = Some(next),
                    None => return None,
                }
            }
        }
    }
}

async fn execute_diagnostics_command(
    host: &Host,
    command: DiagnosticsCommand,
    diagnostics: &mut Option<DiagnosticsOperation>,
) {
    match command {
        DiagnosticsCommand::Download { archive_id, reply } => {
            let result = host
                .admit_diagnostics()
                .map(|admission| admission.download(&archive_id));
            let _ = reply.send(result);
        }
        DiagnosticsCommand::Submit {
            cancellation,
            reply,
        } if diagnostics.is_none() => {
            match DiagnosticsOperation::start(host, cancellation, reply) {
                Ok(operation) => *diagnostics = Some(operation),
                Err((closed, reply)) => {
                    let _ = reply.send(Err(closed));
                }
            }
        }
        DiagnosticsCommand::Submit { reply, .. } => {
            diagnostics
                .as_mut()
                .expect("diagnostics operation must exist for duplicate submit")
                .add_waiter(reply);
        }
    }
}

async fn cancel_diagnostics(diagnostics: &mut Option<DiagnosticsOperation>) {
    if let Some(operation) = diagnostics.take() {
        operation.cancel_and_complete().await;
    }
}

async fn shutdown_after_operations(
    host: &mut Host,
    reply: ShutdownRequest,
    diagnostics: &mut Option<DiagnosticsOperation>,
    terminal_watches: &mut TerminalWatches,
    toolchain_watch: &mut Option<ToolchainWatch>,
    shutdown: &mut mpsc::Receiver<ShutdownRequest>,
    channel_login_waits: &mut Vec<ChannelLoginWaitActorOperation>,
    team_runtime_operations: &mut Vec<TeamRuntimeOperation>,
    team_run_operations: &mut Vec<TeamRunOperation>,
) -> ActorExit {
    cancel_diagnostics(diagnostics).await;
    terminal_watches.cancel().await;
    cancel_channel_login_waits(channel_login_waits).await;
    cancel_team_runtime_operations(team_runtime_operations).await;
    cancel_team_run_operations(team_run_operations).await;
    host.cancel_peer_lifecycle_operations().await;
    if let Some(watch) = toolchain_watch.take() {
        let lookup = host.cancel_open_claw_toolchain_install().await;
        if let ToolchainJobLookup::Known(snapshot) = lookup {
            emit_toolchain_event(host, ParentRuntimeJobEventName::RuntimeJobDone, &snapshot);
        } else {
            let _ = watch;
        }
    }
    if let Some(exit) = shutdown_host(host, reply).await {
        return exit;
    }
    retry_shutdown(host, shutdown).await
}

const DELIVERY_RETRY_DELAY: Duration = Duration::from_secs(30);
const DELIVERY_RECONCILIATION_CONCURRENCY: usize = 8;

async fn reconcile_team_run_deliveries(
    host: &mut Host,
    terminal_watches: &mut TerminalWatches,
    reconciliation: &mut DeliveryReconciliationState,
) {
    let now = now_seconds();
    let retry_at = now.saturating_add(DELIVERY_RETRY_DELAY.as_secs());
    for completion in reconciliation.poll_completed().await {
        complete_delivery_reconciliation(
            host,
            terminal_watches,
            reconciliation,
            completion,
            retry_at,
        )
        .await;
    }
    for run_id in host.active_team_run_ids() {
        reconciliation.dirty_run(run_id);
    }
    for delivery_id in host.pending_team_run_deliveries(now) {
        reconciliation.dirty_delivery(delivery_id);
    }
    let keys = reconciliation
        .dirty
        .iter()
        .take(reconciliation.capacity())
        .cloned()
        .collect::<Vec<_>>();
    for key in keys {
        let Some(work) = start_delivery_reconciliation(host, &key, now).await else {
            reconciliation.dirty.remove(&key);
            continue;
        };
        reconciliation.start(key, work);
    }
}

async fn start_delivery_reconciliation(
    host: &mut Host,
    key: &DeliveryReconciliationKey,
    now: u64,
) -> Option<OperationHandle<DeliveryReconciliationCompletion>> {
    match key {
        DeliveryReconciliationKey::Run(run_id) => {
            let _ = host.schedule_team_run_ready_nodes(run_id, now);
            Some(OperationHandle::spawn(|_| async { DeliveryReconciliationCompletion::Run }).0)
        }
        DeliveryReconciliationKey::Delivery(delivery_id) => {
            let Some(target) = host.team_run_delivery_target(delivery_id) else {
                return Some(observed_delivery_reconciliation(
                    delivery_id.clone(),
                    DeliveryReconciliationStatus::TargetUnavailable,
                ));
            };
            match target {
                TeamRunDeliveryTarget::OpenClaw => {
                    start_openclaw_delivery_reconciliation(host, delivery_id.clone(), now).await
                }
                TeamRunDeliveryTarget::Matcha => {
                    start_matcha_delivery_reconciliation(host, delivery_id.clone(), now).await
                }
            }
        }
    }
}

fn observed_delivery_reconciliation(
    delivery_id: DeliveryId,
    status: DeliveryReconciliationStatus,
) -> OperationHandle<DeliveryReconciliationCompletion> {
    OperationHandle::spawn(move |_| async move {
        DeliveryReconciliationCompletion::Observation(DeliveryReconciliationObservation {
            delivery_id,
            status,
        })
    })
    .0
}

async fn start_openclaw_delivery_reconciliation(
    host: &mut Host,
    delivery_id: DeliveryId,
    claimed_at: u64,
) -> Option<OperationHandle<DeliveryReconciliationCompletion>> {
    if host.open_claw_delivery_unavailable() {
        return Some(observed_delivery_reconciliation(
            delivery_id,
            DeliveryReconciliationStatus::DeliveryError,
        ));
    }
    let start = match host.claim_team_run_openclaw_delivery(delivery_id.clone(), claimed_at) {
        Ok(start) => start,
        Err(crate::composition::OpenClawDeliveryError::Store(_)) => {
            return Some(observed_delivery_reconciliation(
                delivery_id,
                DeliveryReconciliationStatus::StoreFault,
            ));
        }
        Err(_) => {
            return Some(observed_delivery_reconciliation(
                delivery_id,
                DeliveryReconciliationStatus::DeliveryError,
            ));
        }
    };
    match start {
        crate::composition::OpenClawDeliveryStart::Claimed { claim, delivery } => {
            let operation = host.deliver_team_prompt(delivery);
            Some(
                OperationHandle::spawn(move |_| async move {
                    let outcome = operation.await;
                    DeliveryReconciliationCompletion::OpenClaw {
                        delivery_id,
                        claim,
                        outcome,
                    }
                })
                .0,
            )
        }
        crate::composition::OpenClawDeliveryStart::Immediate(outcome) => Some(
            observed_delivery_reconciliation(delivery_id, openclaw_delivery_status(&outcome)),
        ),
    }
}

async fn start_matcha_delivery_reconciliation(
    host: &mut Host,
    delivery_id: DeliveryId,
    claimed_at: u64,
) -> Option<OperationHandle<DeliveryReconciliationCompletion>> {
    let start = match host.claim_team_run_matcha_delivery(delivery_id.clone(), claimed_at) {
        Ok(start) => start,
        Err(crate::composition::MatchaDeliveryError::Store(_)) => {
            return Some(observed_delivery_reconciliation(
                delivery_id,
                DeliveryReconciliationStatus::StoreFault,
            ));
        }
        Err(_) => {
            return Some(observed_delivery_reconciliation(
                delivery_id,
                DeliveryReconciliationStatus::DeliveryError,
            ));
        }
    };
    match start {
        crate::composition::MatchaDeliveryStartOutcome::Claimed { claim, delivery } => {
            let operation = host.deliver_team_prompt(delivery.clone());
            Some(
                OperationHandle::spawn(move |_| async move {
                    let outcome = operation.await;
                    DeliveryReconciliationCompletion::Matcha {
                        delivery_id,
                        claim,
                        delivery,
                        outcome,
                    }
                })
                .0,
            )
        }
        crate::composition::MatchaDeliveryStartOutcome::AlreadyClaimed(_) => {
            Some(observed_delivery_reconciliation(
                delivery_id,
                DeliveryReconciliationStatus::AlreadyClaimed,
            ))
        }
        crate::composition::MatchaDeliveryStartOutcome::AwaitingRetry(_) => {
            Some(observed_delivery_reconciliation(
                delivery_id,
                DeliveryReconciliationStatus::AwaitingRetry,
            ))
        }
        crate::composition::MatchaDeliveryStartOutcome::Terminal(_) => Some(
            observed_delivery_reconciliation(delivery_id, DeliveryReconciliationStatus::Terminal),
        ),
        crate::composition::MatchaDeliveryStartOutcome::OutcomeUnknown(_) => {
            Some(observed_delivery_reconciliation(
                delivery_id,
                DeliveryReconciliationStatus::OutcomeUnknown,
            ))
        }
    }
}

async fn complete_delivery_reconciliation(
    host: &mut Host,
    terminal_watches: &mut TerminalWatches,
    reconciliation: &mut DeliveryReconciliationState,
    completion: DeliveryReconciliationCompletion,
    retry_at: u64,
) {
    match completion {
        DeliveryReconciliationCompletion::Run => {}
        DeliveryReconciliationCompletion::Observation(observation) => {
            reconciliation.record(observation)
        }
        DeliveryReconciliationCompletion::OpenClaw {
            delivery_id,
            claim,
            outcome,
        } => {
            let status = match host.settle_team_run_openclaw_delivery(claim, outcome, retry_at) {
                Ok(outcome) => openclaw_delivery_status(&outcome),
                Err(crate::composition::OpenClawDeliveryError::Store(_)) => {
                    DeliveryReconciliationStatus::StoreFault
                }
                Err(_) => DeliveryReconciliationStatus::DeliveryError,
            };
            reconciliation.record(DeliveryReconciliationObservation {
                delivery_id,
                status,
            });
        }
        DeliveryReconciliationCompletion::Matcha {
            delivery_id,
            claim,
            delivery,
            outcome,
        } => {
            let status =
                match host.settle_team_run_matcha_delivery(claim, delivery, outcome, retry_at) {
                    Ok(outcome) => matcha_delivery_status(&outcome),
                    Err(crate::composition::MatchaDeliveryError::Store(_)) => {
                        DeliveryReconciliationStatus::StoreFault
                    }
                    Err(_) => DeliveryReconciliationStatus::DeliveryError,
                };
            if matches!(status, DeliveryReconciliationStatus::Delivered) {
                terminal_watches.start(host, delivery_id.clone());
            }
            reconciliation.record(DeliveryReconciliationObservation {
                delivery_id,
                status,
            });
        }
    }
}

fn openclaw_delivery_status(
    outcome: &crate::composition::OpenClawDeliveryOutcome,
) -> DeliveryReconciliationStatus {
    match outcome {
        crate::composition::OpenClawDeliveryOutcome::Delivered(_) => {
            DeliveryReconciliationStatus::Delivered
        }
        crate::composition::OpenClawDeliveryOutcome::AlreadyClaimed(_) => {
            DeliveryReconciliationStatus::AlreadyClaimed
        }
        crate::composition::OpenClawDeliveryOutcome::AwaitingRetry(_) => {
            DeliveryReconciliationStatus::AwaitingRetry
        }
        crate::composition::OpenClawDeliveryOutcome::Terminal(_) => {
            DeliveryReconciliationStatus::Terminal
        }
        crate::composition::OpenClawDeliveryOutcome::OutcomeUnknown(_) => {
            DeliveryReconciliationStatus::OutcomeUnknown
        }
    }
}

fn matcha_delivery_status(
    outcome: &crate::composition::MatchaDeliveryOutcome,
) -> DeliveryReconciliationStatus {
    match outcome {
        crate::composition::MatchaDeliveryOutcome::Delivered(_) => {
            DeliveryReconciliationStatus::Delivered
        }
        crate::composition::MatchaDeliveryOutcome::AlreadyClaimed(_) => {
            DeliveryReconciliationStatus::AlreadyClaimed
        }
        crate::composition::MatchaDeliveryOutcome::AwaitingRetry(_) => {
            DeliveryReconciliationStatus::AwaitingRetry
        }
        crate::composition::MatchaDeliveryOutcome::Terminal(_) => {
            DeliveryReconciliationStatus::Terminal
        }
        crate::composition::MatchaDeliveryOutcome::OutcomeUnknown(_) => {
            DeliveryReconciliationStatus::OutcomeUnknown
        }
    }
}

fn reconcile_team_trigger_cron(host: &mut Host, cron: &mut TeamTriggerCron) {
    let now = now_seconds();
    for reconciliation in cron.reconcile(host.armed_team_triggers(None), now) {
        let CronReconciliation::Due(plan) = reconciliation else {
            continue;
        };
        let request = plan.fire;
        if host.fire_team_run_trigger(request.clone(), now).is_err() {
            cron.unknown(&request);
        }
    }
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn close_commands(commands: &mut mpsc::Receiver<Command>) {
    commands.close();
    while let Ok(command) = commands.try_recv() {
        if let Command::Diagnostics(DiagnosticsCommand::Submit {
            cancellation,
            reply,
        }) = command
        {
            cancellation.cancel();
            drop(reply);
        }
    }
}

async fn retry_shutdown(
    host: &mut Host,
    shutdown: &mut mpsc::Receiver<ShutdownRequest>,
) -> ActorExit {
    while let Some(reply) = shutdown.recv().await {
        if let Some(exit) = shutdown_host(host, reply).await {
            return exit;
        }
    }
    host.shutdown().await.map(|_| ())
}

async fn shutdown_host(host: &mut Host, reply: ShutdownRequest) -> Option<ActorExit> {
    let result = host.shutdown().await;
    let terminal = host.admission_state().phase() == HostPhase::ShutDown;
    let _ = reply.send(ShutdownAttempt {
        result: result.clone(),
        terminal,
    });
    terminal.then(|| result.map(|_| ()))
}

#[cfg(test)]
mod tests {
    use tokio::sync::oneshot;

    use super::*;

    #[tokio::test]
    async fn next_accepts_commands_without_optional_operations() {
        let (sender, mut commands) = mpsc::channel(1);
        let (_shutdown_sender, mut shutdown) = mpsc::channel(1);
        let (reply, _response) = oneshot::channel();
        let mut channel_login_waits = Vec::new();
        let mut team_runtime_operations = Vec::new();
        let mut team_run_operations = Vec::new();
        sender
            .send(Command::State(reply))
            .await
            .expect("test command must queue");

        assert!(matches!(
            next(
                None,
                &mut true,
                &mut commands,
                &mut shutdown,
                &mut None,
                &mut TerminalWatches::new(),
                &mut None,
                &mut channel_login_waits,
                &mut team_runtime_operations,
                &mut team_run_operations,
                false,
            )
            .await,
            Next::Command(Some(command)) if matches!(*command, Command::State(_))
        ));
    }

    #[tokio::test]
    async fn closing_commands_rejects_new_work_and_drops_all_queued_replies() {
        let (sender, mut receiver) = mpsc::channel(32);
        let (first_reply, first_response) = oneshot::channel();
        let (second_reply, second_response) = oneshot::channel();
        sender
            .send(Command::State(first_reply))
            .await
            .expect("test command must queue");
        sender
            .send(Command::State(second_reply))
            .await
            .expect("test command must queue");

        close_commands(&mut receiver);

        assert!(sender.is_closed());
        assert!(first_response.await.is_err());
        assert!(second_response.await.is_err());
    }

    #[test]
    fn peer_lifecycle_commands_cancel_only_their_owned_operations() {
        let (matcha_start, _) = oneshot::channel();
        let (matcha_stop, _) = oneshot::channel();
        let (matcha_restart, _) = oneshot::channel();
        let (open_claw_stop, _) = oneshot::channel();
        let (open_claw_restart, _) = oneshot::channel();

        let matcha_start =
            Command::Matcha(super::super::command::MatchaCommand::Start(matcha_start));
        let matcha_stop = Command::Matcha(super::super::command::MatchaCommand::Stop(matcha_stop));
        let matcha_restart = Command::Matcha(super::super::command::MatchaCommand::Restart(
            matcha_restart,
        ));
        let open_claw_stop =
            Command::Runtime(super::super::command::RuntimeCommand::Stop(open_claw_stop));
        let open_claw_restart = Command::Runtime(super::super::command::RuntimeCommand::Restart(
            open_claw_restart,
        ));

        assert!(!matcha_start.cancels_diagnostics());
        assert!(!matcha_stop.cancels_diagnostics());
        assert!(matcha_restart.cancels_diagnostics());
        assert!(!open_claw_stop.cancels_diagnostics());
        assert!(open_claw_restart.cancels_diagnostics());
        assert!(!matcha_start.cancels_terminal_watches());
        assert!(matcha_stop.cancels_terminal_watches());
        assert!(matcha_restart.cancels_terminal_watches());
        assert!(!open_claw_stop.cancels_terminal_watches());
        assert!(!open_claw_restart.cancels_terminal_watches());
    }

    #[tokio::test]
    async fn parallel_submits_share_the_single_active_operation_receipt() {
        let (release, release_receiver) = oneshot::channel();
        let (active_reply, mut active_response) = oneshot::channel();
        let active_cancellation = DiagnosticsArchiveCancellation::new();
        let (operation, _) = OperationHandle::spawn(|_| async move {
            release_receiver
                .await
                .expect("test must release the active diagnostics task");
            DiagnosticsArchiveReceipt::failed()
        });
        let mut diagnostics = Some(DiagnosticsOperation {
            _actor_cancellation: active_cancellation.cancel_on_drop(),
            cancellation: active_cancellation,
            operation,
            replies: vec![active_reply],
        });
        let (second_reply, mut second_response) = oneshot::channel();

        diagnostics
            .as_mut()
            .expect("parallel operation must remain active")
            .add_waiter(second_reply);

        assert!(diagnostics.is_some());
        assert!(active_response.try_recv().is_err());
        assert!(second_response.try_recv().is_err());

        release
            .send(())
            .expect("parallel submit must not replace the active diagnostics task");
        let mut operation = diagnostics
            .take()
            .expect("parallel operation must remain active until completion");
        let receipt = operation
            .operation
            .join()
            .await
            .expect("parallel diagnostics task must complete");
        for reply in operation.replies {
            let _ = reply.send(Ok(receipt.clone()));
        }

        for response in [&mut active_response, &mut second_response] {
            let receipt = response
                .await
                .expect("shared diagnostics submit must receive a receipt")
                .expect("active diagnostics operation must remain admitted");
            assert_eq!(
                receipt.terminal(),
                crate::diagnostics::DiagnosticsArchiveTerminal::Failed
            );
            assert_eq!(receipt.entries(), 0);
            assert_eq!(receipt.bytes(), 0);
        }
    }

    #[tokio::test]
    async fn shutdown_cancellation_waits_for_task_completion() {
        let (release, release_receiver) = oneshot::channel();
        let (reply, mut response) = oneshot::channel();
        let cancellation_token = DiagnosticsArchiveCancellation::new();
        let (operation, _) = OperationHandle::spawn(|_| async move {
            release_receiver
                .await
                .expect("test must release the diagnostics task");
            DiagnosticsArchiveReceipt::failed()
        });
        let mut diagnostics = Some(DiagnosticsOperation {
            _actor_cancellation: cancellation_token.cancel_on_drop(),
            cancellation: cancellation_token,
            operation,
            replies: vec![reply],
        });

        let mut cancellation = Box::pin(cancel_diagnostics(&mut diagnostics));
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut cancellation)
                .await
                .is_err()
        );
        assert!(response.try_recv().is_err());

        release
            .send(())
            .expect("shutdown cancellation must wait for the active task");
        cancellation.await;

        assert!(diagnostics.is_none());
        assert!(response.await.is_ok());
    }

    #[tokio::test]
    async fn dropping_the_actor_operation_cancels_the_shared_token() {
        let cancellation = DiagnosticsArchiveCancellation::new();
        let (reply, _response) = oneshot::channel();
        let (operation, _) =
            OperationHandle::spawn(|_| async { DiagnosticsArchiveReceipt::failed() });
        let operation = DiagnosticsOperation {
            _actor_cancellation: cancellation.cancel_on_drop(),
            cancellation: cancellation.clone(),
            operation,
            replies: vec![reply],
        };

        drop(operation);

        assert!(cancellation.is_cancelled());
    }

    #[tokio::test]
    async fn closing_commands_cancels_queued_diagnostics_submit() {
        let (sender, mut receiver) = mpsc::channel(1);
        let cancellation = DiagnosticsArchiveCancellation::new();
        let (reply, response) = oneshot::channel();
        sender
            .send(Command::Diagnostics(DiagnosticsCommand::Submit {
                cancellation: cancellation.clone(),
                reply,
            }))
            .await
            .expect("test diagnostics submit must queue");

        close_commands(&mut receiver);

        assert!(cancellation.is_cancelled());
        assert!(response.await.is_err());
    }

    #[test]
    fn delivery_reconciliation_retains_unknown_target_as_observable_failure() {
        let delivery_id = DeliveryId::new("delivery-target-unknown").unwrap();
        let mut state = DeliveryReconciliationState::default();

        state.record_target_unavailable(delivery_id.clone());

        assert_eq!(
            state.last(),
            Some(&DeliveryReconciliationObservation {
                delivery_id: delivery_id.clone(),
                status: DeliveryReconciliationStatus::TargetUnavailable,
            })
        );
        assert_eq!(state.last_failure(), state.last());
    }

    #[tokio::test]
    async fn delivery_reconciliation_merges_wakeups_for_a_processing_key() {
        let key =
            DeliveryReconciliationKey::Delivery(DeliveryId::new("delivery-single-flight").unwrap());
        let mut state = DeliveryReconciliationState::default();

        state.dirty(key.clone());
        state.start(key.clone(), completed_delivery_reconciliation());
        state.dirty(key.clone());

        assert!(!state.dirty.contains(&key));
        assert_eq!(state.processing.len(), 1);
    }

    #[tokio::test]
    async fn delivery_reconciliation_runs_distinct_keys_up_to_capacity() {
        let first = DeliveryReconciliationKey::Delivery(
            DeliveryId::new("delivery-concurrent-one").unwrap(),
        );
        let second = DeliveryReconciliationKey::Delivery(
            DeliveryId::new("delivery-concurrent-two").unwrap(),
        );
        let mut state = DeliveryReconciliationState::default();

        state.dirty(first.clone());
        state.dirty(second.clone());
        for key in state
            .dirty
            .iter()
            .take(state.capacity())
            .cloned()
            .collect::<Vec<_>>()
        {
            state.start(key, completed_delivery_reconciliation());
        }

        assert!(state.processing.contains_key(&first));
        assert!(state.processing.contains_key(&second));
    }

    #[tokio::test]
    async fn delivery_reconciliation_capacity_is_finite() {
        let mut state = DeliveryReconciliationState::default();
        for index in 0..DELIVERY_RECONCILIATION_CONCURRENCY {
            state.start(
                DeliveryReconciliationKey::Delivery(
                    DeliveryId::new(format!("delivery-capacity-{index}")).unwrap(),
                ),
                completed_delivery_reconciliation(),
            );
        }

        assert_eq!(state.capacity(), 0);
    }

    #[test]
    fn delivery_completion_uses_claim_settlement_as_the_stale_fence() {
        let source = include_str!("actor.rs")
            .split_once("fn complete_delivery_reconciliation")
            .expect("actor must retain delivery completion")
            .1;

        assert!(source.contains("settle_team_run_openclaw_delivery(claim, outcome, retry_at)"));
        assert!(
            source.contains("settle_team_run_matcha_delivery(dispatch.clone(), outcome, retry_at)")
        );
        assert!(!source.contains(&["Deliver", "OpenClaw"].concat()));
        assert!(!source.contains(&["Deliver", "Matcha"].concat()));
    }

    fn completed_delivery_reconciliation() -> OperationHandle<DeliveryReconciliationCompletion> {
        OperationHandle::spawn(|_| async { DeliveryReconciliationCompletion::Run }).0
    }

    #[tokio::test]
    async fn unknown_watch_completion_remains_deduplicated_without_automatic_retry() {
        let delivery_id = DeliveryId::new("terminal-watch-unknown").unwrap();
        let other_delivery_id = DeliveryId::new("terminal-watch-other").unwrap();
        let mut watches = TerminalWatches::new();
        assert!(watches.watched_delivery_ids.insert(delivery_id.clone()));
        assert!(
            watches
                .watched_delivery_ids
                .insert(other_delivery_id.clone())
        );
        watches.tasks.spawn({
            let delivery_id = delivery_id.clone();
            async move { (delivery_id, TerminalWatchCompletion::OutcomeUnknown) }
        });

        assert_eq!(watches.join_next().await, None);
        assert!(!watches.watched_delivery_ids.insert(delivery_id));
        assert!(!watches.watched_delivery_ids.insert(other_delivery_id));
        assert!(watches.tasks.is_empty());
    }

    #[tokio::test]
    async fn terminal_watch_completion_remains_deduplicated_for_the_actor_lifetime() {
        let delivery_id = DeliveryId::new("terminal-watch-once").unwrap();
        let mut watches = TerminalWatches::new();
        assert!(watches.watched_delivery_ids.insert(delivery_id.clone()));
        watches.tasks.spawn({
            let delivery_id = delivery_id.clone();
            async move {
                (
                    delivery_id,
                    TerminalWatchCompletion::Terminal(TerminalRunStatus::Completed),
                )
            }
        });

        assert_eq!(
            watches.join_next().await,
            Some(TerminalWatchObservation {
                delivery_id: delivery_id.clone(),
                status: TerminalRunStatus::Completed,
            })
        );
        assert!(watches.watched_delivery_ids.contains(&delivery_id));
        assert!(watches.tasks.is_empty());
    }

    #[tokio::test]
    async fn actor_exit_cancels_and_forgets_terminal_watches() {
        let delivery_id = DeliveryId::new("terminal-watch-shutdown").unwrap();
        let (release, release_receiver) = oneshot::channel::<()>();
        let mut watches = TerminalWatches::new();
        assert!(watches.watched_delivery_ids.insert(delivery_id.clone()));
        watches.tasks.spawn(async move {
            let _ = release_receiver.await;
            (delivery_id, TerminalWatchCompletion::OutcomeUnknown)
        });

        watches.cancel().await;
        drop(release);

        assert!(watches.watched_delivery_ids.is_empty());
        assert!(watches.tasks.is_empty());
    }

    #[test]
    fn recovery_scans_durable_delivery_ids_once_at_actor_startup() {
        let source = include_str!("actor.rs");
        let planner = concat!("terminal_observation_", "deliveries()");
        let startup = concat!("terminal_watches.", "start_", "recovery(&host);");
        let recovery = source
            .split("fn start_recovery(&mut self, host: &Host) {")
            .nth(1)
            .and_then(|source| source.split("\n    fn start(&mut self").next())
            .expect("actor must define terminal-watch recovery before its start operation");

        assert!(recovery.contains(planner));
        assert!(recovery.contains("self.start(host, delivery_id);"));
        assert_eq!(source.matches(planner).count(), 1);
        assert_eq!(source.matches(startup).count(), 1);
    }

    #[test]
    fn matcha_lifecycle_cancels_terminal_watches_without_recovery_scan() {
        let (start_reply, _) = oneshot::channel();
        let (restart_reply, _) = oneshot::channel();
        let (stop_reply, _) = oneshot::channel();
        let start = Command::Matcha(super::super::command::MatchaCommand::Start(start_reply));
        let restart = Command::Matcha(super::super::command::MatchaCommand::Restart(restart_reply));
        let stop = Command::Matcha(super::super::command::MatchaCommand::Stop(stop_reply));

        assert!(!start.cancels_terminal_watches());
        assert!(restart.cancels_terminal_watches());
        assert!(stop.cancels_terminal_watches());

        let actor = include_str!("actor.rs")
            .split_once("\n#[cfg(test)]")
            .expect("actor source must retain its test boundary")
            .0;
        assert!(actor.contains("terminal_watches.cancel().await;"));
        assert_eq!(
            actor
                .matches("terminal_watches.start_recovery(host);")
                .count(),
            0
        );
        assert!(!actor.contains("should_recover_terminal_watches"));
    }
}
