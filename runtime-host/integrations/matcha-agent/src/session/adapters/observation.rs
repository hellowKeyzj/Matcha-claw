use std::sync::{Arc, Mutex};

use foundation::execution::OwnedTask;
use serde_json::{Value, json};
use sessions_module::{
    RuntimeOperationFailure, SessionFuture, SessionObservation, SessionObservationRequest,
    SessionSync, SessionSyncCut,
    command::{SessionEvent, SessionIngress, SessionIngressEvent, SessionObservationFailure},
    ports::{ItemsSyncMode, OwnedRuntimeFuture, SessionTerminalRun},
    state::{
        ApprovalPhase, ApprovalView, ItemAnchor, ItemStatus, MissingFact, RecoveryReason,
        RuntimeView, SessionApplyResult, SessionChange, SessionContent, SessionEventBinding,
        SessionFact, SessionItem, SessionState, SessionView, ToolPhase,
    },
    timeline,
};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::{
    client::{Client, Event, Subscription},
    peer::MatchaPeerSessionHandle,
    session::{
        events, interaction,
        model::{RunRecord, SessionId, valid_uuid},
        projection::{Streaming, parse_session_key},
        rpc::{self, Failure},
    },
};

struct SyncRequest {
    command: timeline::Command,
    epoch: u64,
    reply: oneshot::Sender<Result<SessionSync, RuntimeOperationFailure>>,
}
struct Observation {
    session: MatchaPeerSessionHandle,
    events: mpsc::Sender<SessionIngressEvent>,
    request: SessionObservationRequest,
    native_id: SessionId,
    receive: Arc<Mutex<Option<ObservationRun>>>,
}
struct ObservationRun {
    requests: mpsc::Sender<SyncRequest>,
    acceptance: Arc<Mutex<Option<SyncAcceptance>>>,
    task: Option<OwnedTask<Projection>>,
}
struct SyncAcceptance {
    generation: u64,
    source_epoch: Option<u64>,
    cut: SessionSyncCut,
    reply: oneshot::Sender<()>,
}

fn spawn_observation(
    session: MatchaPeerSessionHandle,
    events: mpsc::Sender<SessionIngressEvent>,
    projection: Projection,
) -> ObservationRun {
    let (requests, receiver) = mpsc::channel(8);
    let acceptance = Arc::new(Mutex::new(None));
    let pending = acceptance.clone();
    let (task, _) =
        OwnedTask::spawn(move |cancel| run(session, events, projection, receiver, pending, cancel));
    ObservationRun {
        requests,
        acceptance,
        task: Some(task),
    }
}
pub(super) fn prepare(
    session: MatchaPeerSessionHandle,
    events: Option<mpsc::Sender<SessionIngressEvent>>,
    request: SessionObservationRequest,
) -> Result<Arc<dyn SessionObservation>, RuntimeOperationFailure> {
    let events = events.ok_or(RuntimeOperationFailure::Unavailable)?;
    let native_id = SessionId::try_new(
        request
            .endpoint_session_id
            .clone()
            .ok_or(RuntimeOperationFailure::TargetRejected)?,
    )
    .map_err(|_| RuntimeOperationFailure::TargetRejected)?;
    if request.identity.validate().is_err()
        || request.identity.endpoint.runtime_instance_id != "local"
        || request.identity.endpoint.kind != "native-runtime"
        || request.identity.provider() != sessions_module::state::SessionProvider::MatchaAgent
        || parse_session_key(&request.identity.session_key)
            != Some((request.identity.agent_id.as_str(), native_id.as_str()))
        || SessionEventBinding::observed(request.identity.clone(), request.generation, None, true)
            .is_none()
    {
        return Err(RuntimeOperationFailure::TargetRejected);
    }
    let projection = Projection::new(
        request.clone(),
        native_id.clone(),
        session.observer_source_epoch(),
    );
    let receive = spawn_observation(session.clone(), events.clone(), projection);
    Ok(Arc::new(Observation {
        session,
        events,
        request,
        native_id,
        receive: Arc::new(Mutex::new(Some(receive))),
    }))
}
impl SessionObservation for Observation {
    fn items_sync_mode(&self) -> ItemsSyncMode {
        ItemsSyncMode::Replace
    }
    fn sync<'a>(
        &'a self,
        command: timeline::Command,
        epoch: u64,
    ) -> SessionFuture<'a, Result<SessionSync, RuntimeOperationFailure>> {
        Box::pin(async move {
            let unavailable = |step: &'static str| {
                platform::trace::runtime_trace("matcha.session.observation.failed", || {
                    json!({
                        "step": step,
                        "sessionHash": platform::trace::identifier_hash(self.native_id.as_str()),
                        "publicSessionHash": platform::trace::identifier_hash(&self.request.identity.session_key),
                    })
                });
                RuntimeOperationFailure::Unavailable
            };
            let requests = self
                .receive
                .lock()
                .expect("observation receive lock is not poisoned")
                .as_ref()
                .filter(|receive| receive.task.is_some())
                .map(|receive| receive.requests.clone())
                .ok_or_else(|| unavailable("sync.task_unavailable"))?;
            let (reply, received) = oneshot::channel();
            requests
                .send(SyncRequest {
                    command,
                    epoch,
                    reply,
                })
                .await
                .map_err(|_| unavailable("sync.request_closed"))?;
            received
                .await
                .map_err(|_| unavailable("sync.reply_closed"))?
        })
    }
    fn accept_sync(&self, generation: u64, source_epoch: Option<u64>, cut: SessionSyncCut) {
        let receive = self
            .receive
            .lock()
            .expect("observation receive lock is not poisoned");
        if let Some(receive) = receive.as_ref() {
            let mut pending = receive
                .acceptance
                .lock()
                .expect("observation acceptance lock is not poisoned");
            if pending.as_ref().is_some_and(|pending| {
                pending.generation == generation
                    && pending.source_epoch == source_epoch
                    && pending.cut == cut
            }) {
                let _ = pending
                    .take()
                    .expect("matching sync acceptance")
                    .reply
                    .send(());
            }
        }
    }
    fn restart(&self, generation: u64) -> OwnedRuntimeFuture<Result<(), RuntimeOperationFailure>> {
        if SessionEventBinding::observed(self.request.identity.clone(), generation, None, true)
            .is_none()
        {
            return Box::pin(async { Err(RuntimeOperationFailure::TargetRejected) });
        }
        let task = self
            .receive
            .lock()
            .expect("observation receive lock is not poisoned")
            .as_mut()
            .and_then(|receive| receive.task.take());
        let Some(mut task) = task else {
            return Box::pin(async { Err(RuntimeOperationFailure::Unavailable) });
        };
        task.cancel();
        let receive = self.receive.clone();
        let session = self.session.clone();
        let events = self.events.clone();
        Box::pin(async move {
            let mut projection = task
                .join()
                .await
                .map_err(|_| RuntimeOperationFailure::Unavailable)?;
            projection.request.generation = generation;
            let mut receive = receive
                .lock()
                .expect("observation receive lock is not poisoned");
            *receive
                .as_mut()
                .ok_or(RuntimeOperationFailure::Unavailable)? =
                spawn_observation(session, events, projection);
            Ok(())
        })
    }
    fn close(&self) -> OwnedRuntimeFuture<()> {
        let task = self
            .receive
            .lock()
            .expect("observation receive lock is not poisoned")
            .take()
            .and_then(|receive| receive.task);
        if let Some(task) = &task {
            task.cancel();
        }
        Box::pin(async move {
            if let Some(mut task) = task {
                let _ = task.join().await;
            }
        })
    }
}

#[derive(Clone, Copy)]
struct ObservationFailure {
    operation: RuntimeOperationFailure,
    invalid_readback: bool,
}
impl From<RuntimeOperationFailure> for ObservationFailure {
    fn from(operation: RuntimeOperationFailure) -> Self {
        Self {
            operation,
            invalid_readback: false,
        }
    }
}
const MAX_RUN_FACTS: usize = 1024;

#[derive(Clone)]
struct Projection {
    request: SessionObservationRequest,
    native_id: SessionId,
    source_epoch: u64,
    cursor: u64,
    streaming: Streaming,
    state: SessionState,
}
impl Projection {
    fn new(request: SessionObservationRequest, native_id: SessionId, source_epoch: u64) -> Self {
        let state = SessionState::new(request.identity.clone(), 1)
            .and_then(|state| state.with_goal(sessions_module::goal::SessionGoalView::Unsupported))
            .and_then(|state| state.with_endpoint_session_id(Some(native_id.as_str().to_owned())))
            .expect("validated observation identity");
        Self {
            request,
            native_id,
            source_epoch,
            cursor: 0,
            streaming: Streaming::default(),
            state,
        }
    }
    fn binding(&self) -> SessionEventBinding {
        SessionEventBinding::observed(
            self.request.identity.clone(),
            self.request.generation,
            Some(self.source_epoch),
            true,
        )
        .expect("validated observation binding")
    }
    fn trace_failure(
        &self,
        step: &'static str,
        method: Option<&'static str>,
        error: Option<&Failure>,
    ) {
        platform::trace::runtime_trace("matcha.session.observation.failed", || {
            json!({
                "step": step,
                "method": method,
                "sessionHash": platform::trace::identifier_hash(self.native_id.as_str()),
                "publicSessionHash": platform::trace::identifier_hash(&self.request.identity.session_key),
                "generation": self.request.generation,
                "sourceEpoch": self.source_epoch,
                "nativeCursor": self.cursor,
                "failure": error.map(Failure::trace_summary),
            })
        });
    }
    fn subscription_failure(&self, error: crate::client::Error) -> ObservationFailure {
        self.trace_failure("subscription.receive", None, Some(&Failure::Native(error)));
        RuntimeOperationFailure::Unavailable.into()
    }
    async fn consume(
        &mut self,
        event: Event,
        output: &mpsc::Sender<SessionIngressEvent>,
        cancel: &CancellationToken,
        restoring: bool,
    ) -> Result<Option<RunRecord>, ObservationFailure> {
        if event.session_id != self.native_id.as_str()
            || event.seq != self.cursor + 1
            || event.seq > sessions_module::state::MAX_SAFE_INTEGER
            || event.at_ms > sessions_module::state::MAX_SAFE_INTEGER
            || event.run_id.as_deref().is_some_and(|run| !valid_uuid(run))
        {
            self.trace_failure("event.validate", None, None);
            return Err(failure(Failure::InvalidReadback));
        }
        let mut streaming = self.streaming.clone();
        let projected = events::project(&mut streaming, &event, &self.state)
            .inspect_err(|error| {
                platform::trace::runtime_trace("matcha.session.observation.failed", || {
                    json!({
                        "step": "event.project",
                        "sessionHash": platform::trace::identifier_hash(self.native_id.as_str()),
                        "publicSessionHash": platform::trace::identifier_hash(&self.request.identity.session_key),
                        "generation": self.request.generation,
                        "sourceEpoch": self.source_epoch,
                        "nativeCursor": self.cursor,
                        "nativeSeq": event.seq,
                        "eventKind": events::trace_kind(&event.kind),
                        "row": super::super::projection::trace_shape(&event.payload),
                        "streamingAfterFailure": streaming.trace_state(&event.payload),
                        "failure": error.trace_summary(),
                    })
                });
            })
            .map_err(failure)?;
        let binding = self.binding();
        let mut candidate = self.state.clone();
        candidate
            .reserve_observation_capacity(&projected.changes)
            .map_err(|_| {
                self.trace_failure("event.capacity", None, None);
                failure(Failure::InvalidReadback)
            })?;
        match candidate.apply_native_bound(
            binding.clone(),
            event.run_id.clone(),
            Some(event.seq),
            projected.changes.clone(),
        ) {
            SessionApplyResult::Applied(_) | SessionApplyResult::Consumed { .. } => {}
            _ => {
                self.trace_failure("event.apply", None, None);
                return Err(failure(Failure::InvalidReadback));
            }
        }
        let ingress = if restoring {
            projected
                .run
                .as_ref()
                .filter(|run| run.status.terminal())
                .map(|run| {
                    SessionIngressEvent::from_ingress(
                        self.request.identity.clone(),
                        SessionIngress::RestoredTerminal {
                            binding,
                            terminal: SessionTerminalRun {
                                run_id: run.run_id.clone(),
                                phase: run.status.phase(),
                            },
                            assistant_texts: candidate.assistant_texts_for_run_id(&run.run_id),
                        },
                    )
                })
        } else {
            Some(SessionIngressEvent::new(
                self.request.identity.clone(),
                SessionEvent {
                    binding,
                    run_id: event.run_id,
                    cursor: Some(event.seq),
                    history_refresh: projected.history_refresh,
                    changes: projected.changes,
                },
            ))
        };
        if let Some(ingress) = ingress {
            let (ingress, receipt) = ingress.with_receipt();
            tokio::select! {
                _ = cancel.cancelled() => return Err(RuntimeOperationFailure::Unavailable.into()),
                result = output.send(ingress) => result.map_err(|_| {
                    self.trace_failure("event.ingress_closed", None, None);
                    RuntimeOperationFailure::Unavailable
                })?,
            }
            let accepted = tokio::select! {
                biased;
                result = receipt => result.map_err(|_| {
                    self.trace_failure("event.receipt_closed", None, None);
                    RuntimeOperationFailure::Unavailable
                })?,
                _ = cancel.cancelled() => return Err(RuntimeOperationFailure::Unavailable.into()),
            };
            if !accepted {
                self.trace_failure("event.receipt_rejected", None, None);
                return Err(RuntimeOperationFailure::Unknown.into());
            }
        }
        if !restoring {
            platform::trace::runtime_trace(
                "matcha.session.event_consumed",
                || json!({"sessionHash":platform::trace::identifier_hash(self.native_id.as_str()),"nativeSeq":event.seq,"sourceEpoch":self.source_epoch,"runtimeKnown":candidate.runtime() != &SessionFact::Unknown}),
            );
        }
        self.streaming = streaming;
        self.state = candidate;
        self.cursor = event.seq;
        Ok(projected.run)
    }
    async fn sync(
        &mut self,
        client: &Client,
        subscription: &mut Subscription,
        command: timeline::Command,
        epoch: u64,
        output: &mpsc::Sender<SessionIngressEvent>,
        cancel: &CancellationToken,
        restoring: bool,
    ) -> Result<(SessionSync, SessionState), ObservationFailure> {
        if command.identity() != &self.request.identity
            || command.endpoint_session_id() != Some(self.native_id.as_str())
        {
            self.trace_failure("sync.target", None, Some(&Failure::InvalidInput));
            return Err(RuntimeOperationFailure::TargetRejected.into());
        }
        // The subscription is already installed. Drain it while independent history and
        // control reads run, rather than accumulating a second transcript/event queue.
        let native_id = self.native_id.as_str().to_owned();
        // Finish durable replay that predates the history read. Subsequent events
        // are concurrent native facts, not rows silently retired by a stale page.
        let frontier_read = frontier(client, &native_id);
        tokio::pin!(frontier_read);
        let initial = loop {
            tokio::select! {
                _ = cancel.cancelled() => return Err(RuntimeOperationFailure::Unavailable.into()),
                result = &mut frontier_read => break result
                    .inspect_err(|error| self.trace_failure("sync.initial_frontier", Some("events.replay"), Some(error)))
                    .map_err(failure)?,
                event = subscription.recv() => {
                    self.consume(event.map_err(|error| self.subscription_failure(error))?, output, cancel, restoring).await?;
                },
            }
        };
        while self.cursor < initial {
            let event = tokio::select! { _ = cancel.cancelled() => return Err(RuntimeOperationFailure::Unavailable.into()), event = subscription.recv() => event.map_err(|error| self.subscription_failure(error))?, };
            self.consume(event, output, cancel, restoring).await?;
        }
        let baseline = self.state.clone();
        let mut run_facts = Vec::new();
        let read = async {
            let mut view = super::timeline::read(client, &command, epoch).await?;
            let runs = super::runtime::runs(client, &native_id, None)
                .await
                .inspect_err(|error| error.trace("sync.runs", Some("runs.list"), &native_id))?;
            let approvals = interaction::pending(client, &native_id, "approvals")
                .await
                .inspect_err(|error| {
                    error.trace("sync.approvals", Some("approvals.list"), &native_id)
                })?;
            let mut approval_views = Vec::new();
            for item in approvals {
                if item.availability == sessions_module::question::QuestionAvailability::Pending
                    && item.delivery == sessions_module::question::QuestionDelivery::NotSent
                {
                    approval_views.push(ApprovalView {
                        approval_id: item.approval_id().inspect_err(|error| {
                            error.trace("sync.approval_projection", None, &native_id);
                        })?,
                        run_id: item.run_id.clone(),
                        phase: ApprovalPhase::Requested,
                        option_ids: vec!["allow".into(), "deny".into()],
                    });
                }
            }
            view.approvals = SessionFact::Complete(approval_views);
            if let Some(run) = &runs.current_run {
                view.runtime = SessionFact::Incomplete {
                    facts: events::runtime(
                        run.status,
                        (!run.status.terminal()).then(|| run.run_id.clone()),
                    ),
                    gaps: vec![MissingFact::PartialRuntime],
                };
            }
            let mut terminal_runs = Vec::new();
            for run in runs.runs.iter().chain(runs.current_run.iter()) {
                terminal_fact(&mut terminal_runs, run);
            }
            Ok::<_, Failure>((view, runs.latest_seq, terminal_runs))
        };
        tokio::pin!(read);
        let (mut view, run_cut, mut terminal_runs) = loop {
            tokio::select! {
                _ = cancel.cancelled() => return Err(RuntimeOperationFailure::Unavailable.into()),
                result = &mut read => break result
                    .inspect_err(|error| self.trace_failure("sync.read", None, Some(error)))
                    .map_err(failure)?,
                event = subscription.recv(), if run_facts.len() < MAX_RUN_FACTS => {
                    let event = event.map_err(|error| self.subscription_failure(error))?;
                    let seq = event.seq;
                    if let Some(run) = self.consume(event, output, cancel, restoring).await? {
                        run_facts.push((seq, run));
                    }
                },
            }
        };
        for (seq, run) in run_facts {
            if seq > run_cut {
                reconcile_run(&mut view.runtime, &run);
                terminal_fact(&mut terminal_runs, &run);
            }
        }
        while self.cursor < run_cut {
            let event = tokio::select! { _ = cancel.cancelled() => return Err(RuntimeOperationFailure::Unavailable.into()), event = subscription.recv() => event.map_err(|error| self.subscription_failure(error))?, };
            self.consume(event, output, cancel, restoring).await?;
        }
        // Run control uses its DB snapshot cut; history remains independently read.
        let replay = self.state.view();
        let mut sync = SessionSync {
            view,
            source_epoch: Some(self.source_epoch),
            source_branch: None,
            cut: SessionSyncCut::EventFrontier {
                cursor: self.cursor,
                contiguous: true,
            },
            replay_baseline: None,
            terminal_runs,
            retired_item_ids: Vec::new(),
            retired_tool_ids: Vec::new(),
            retired_approval_ids: Vec::new(),
        };
        let mut next = self.reserve_sync(&mut sync.view)?;
        sync.view = next
            .reconcile_sync(&sync, &baseline, ItemsSyncMode::Merge)
            .map_err(|_| {
                self.trace_failure("sync.reconcile", None, None);
                failure(Failure::InvalidReadback)
            })?;
        sync.view.epoch = epoch;
        if restoring {
            sync.cut = SessionSyncCut::Restored {
                cursor: self.cursor,
                contiguous: true,
            };
        } else {
            sync.replay_baseline = Some(replay);
        }
        Ok((sync, next))
    }
    fn reserve_sync(&self, view: &mut SessionView) -> Result<SessionState, ObservationFailure> {
        let current = values(self.state.items());
        let tail_start = current
            .iter()
            .rposition(|item| {
                values(&view.items)
                    .iter()
                    .any(|incoming| incoming.item_id() == item.item_id())
            })
            .map_or(0, |index| index + 1);
        loop {
            // Source-order tail not yet in the history read must survive its page budget.
            let mut protected = values(&view.items).to_vec();
            protected.extend(
                current[tail_start..]
                    .iter()
                    .filter(|item| {
                        !values(&view.items)
                            .iter()
                            .any(|incoming| incoming.item_id() == item.item_id())
                    })
                    .cloned(),
            );
            let mut changes = vec![SessionChange::ItemsReplaced {
                old_item_ids: Vec::new(),
                anchor: ItemAnchor::Start,
                items: protected,
            }];
            changes.extend(
                values(&view.tools)
                    .iter()
                    .cloned()
                    .map(|tool| SessionChange::ToolUpdated { tool }),
            );
            changes.extend(
                values(&view.approvals)
                    .iter()
                    .cloned()
                    .map(|approval| SessionChange::ApprovalUpdated { approval }),
            );
            let mut candidate = self.state.clone();
            if candidate.reserve_observation_capacity(&changes).is_ok() {
                return Ok(candidate);
            }
            // A full history page must leave room for event-only previews/finals.
            // Evict only the earliest terminal display fact, never an active partial.
            let mut items_only = self.state.clone();
            if items_only
                .reserve_observation_capacity(&changes[..1])
                .is_err()
            {
                if let SessionFact::Complete(items) | SessionFact::Incomplete { facts: items, .. } =
                    &mut view.items
                    && let Some(index) = items.iter().position(|item| {
                        terminal_item(item)
                            && !values(self.state.items()).iter().any(|current| {
                                current.item_id() == item.item_id() && !terminal_item(current)
                            })
                    })
                {
                    items.remove(index);
                    mark_bounded(&mut view.items);
                    mark_bounded(&mut view.window);
                    continue;
                }
                self.trace_failure("sync.capacity", None, None);
                return Err(failure(Failure::InvalidReadback));
            }
            let tool_end = 1 + values(&view.tools).len();
            if items_only
                .reserve_observation_capacity(&changes[1..tool_end])
                .is_err()
                && let SessionFact::Complete(tools) | SessionFact::Incomplete { facts: tools, .. } =
                    &mut view.tools
                && let Some(index) = tools.iter().position(|tool| {
                    matches!(tool.phase, ToolPhase::Completed | ToolPhase::Failed)
                        && !values(&view.items)
                            .iter()
                            .chain(values(self.state.items()))
                            .any(|item| item_has_tool(item, &tool.tool_call_id))
                })
            {
                tools.remove(index);
                mark_bounded(&mut view.tools);
                continue;
            }
            self.trace_failure("sync.capacity", None, None);
            return Err(failure(Failure::InvalidReadback));
        }
    }
}
fn values<T>(fact: &SessionFact<Vec<T>>) -> &[T] {
    match fact {
        SessionFact::Complete(values) | SessionFact::Incomplete { facts: values, .. } => values,
        _ => &[],
    }
}
fn terminal_item(item: &SessionItem) -> bool {
    matches!(item,
        SessionItem::UserMessage { status, .. }
            | SessionItem::AssistantTurn { status, .. }
            | SessionItem::System { status, .. }
            if matches!(status, ItemStatus::Final | ItemStatus::Error | ItemStatus::Aborted)
    )
}
fn item_has_tool(item: &SessionItem, id: &str) -> bool {
    match item {
        SessionItem::AssistantTurn { segments, .. } => segments.iter().any(|segment| {
            matches!(segment, SessionContent::ToolUse { tool_call_id, .. }
                | SessionContent::ToolResult { tool_call_id, .. } if tool_call_id == id)
        }),
        _ => false,
    }
}
fn mark_bounded<T>(fact: &mut SessionFact<T>) {
    match fact {
        SessionFact::Incomplete { gaps, .. } => {
            if !gaps.contains(&MissingFact::BoundedHistory) {
                gaps.push(MissingFact::BoundedHistory);
            }
        }
        SessionFact::Complete(_) => {
            let SessionFact::Complete(facts) = std::mem::replace(fact, SessionFact::Unknown) else {
                unreachable!("complete fact")
            };
            *fact = SessionFact::Incomplete {
                facts,
                gaps: vec![MissingFact::BoundedHistory],
            };
        }
        _ => {}
    }
}
fn terminal_fact(terminals: &mut Vec<SessionTerminalRun>, run: &RunRecord) {
    if run.status.terminal()
        && !terminals
            .iter()
            .any(|terminal| terminal.run_id == run.run_id)
    {
        terminals.push(SessionTerminalRun {
            run_id: run.run_id.clone(),
            phase: run.status.phase(),
        });
    }
}
fn reconcile_run(runtime: &mut SessionFact<RuntimeView>, run: &RunRecord) {
    if let Some(updated) = events::run_runtime(run, runtime) {
        *runtime = SessionFact::Incomplete {
            facts: updated,
            gaps: vec![MissingFact::PartialRuntime],
        };
    }
}
async fn sync_request(
    projection: &mut Projection,
    request: SyncRequest,
    client: &Client,
    subscription: &mut Subscription,
    output: &mpsc::Sender<SessionIngressEvent>,
    acceptance: &Mutex<Option<SyncAcceptance>>,
    cancel: &CancellationToken,
    restoring: bool,
) -> Result<(), ObservationFailure> {
    // Only a recovery candidate is speculative. Ordinary events still advance the
    // checkpoint individually, and only after their Host receipt.
    let mut restored = restoring.then(|| projection.clone());
    let current = restored.as_mut().unwrap_or(&mut *projection);
    let result = current
        .sync(
            client,
            subscription,
            request.command,
            request.epoch,
            output,
            cancel,
            restoring,
        )
        .await;
    let (sync, state) = match result {
        Ok(result) => result,
        Err(error) => {
            if error.invalid_readback {
                invalid_readback(output, current, cancel).await;
            }
            let _ = request.reply.send(Err(error.operation));
            return Err(error);
        }
    };
    let (reply, accepted) = oneshot::channel();
    *acceptance
        .lock()
        .expect("observation acceptance lock is not poisoned") = Some(SyncAcceptance {
        generation: current.request.generation,
        source_epoch: sync.source_epoch,
        cut: sync.cut,
        reply,
    });
    let delivered = request.reply.send(Ok(sync)).is_ok();
    let accepted = delivered
        && tokio::select! {
            biased;
            result = accepted => result.is_ok(),
            _ = cancel.cancelled() => false,
        };
    acceptance
        .lock()
        .expect("observation acceptance lock is not poisoned")
        .take();
    if !accepted {
        return Err(RuntimeOperationFailure::Unavailable.into());
    }
    current.state = state;
    if let Some(restored) = restored {
        *projection = restored;
    }
    Ok(())
}
async fn run(
    session: MatchaPeerSessionHandle,
    output: mpsc::Sender<SessionIngressEvent>,
    mut projection: Projection,
    mut requests: mpsc::Receiver<SyncRequest>,
    acceptance: Arc<Mutex<Option<SyncAcceptance>>>,
    cancel: CancellationToken,
) -> Projection {
    // Sessions installs the observation generation before its first sync admits IO.
    let first = tokio::select! {
        _ = cancel.cancelled() => return projection,
        request = requests.recv() => request,
    };
    let Some(first) = first else {
        return projection;
    };
    let client = session.native_client();
    let admitted = tokio::select! {
        _ = cancel.cancelled() => return projection,
        result = rpc::bound(&client, &projection.request.identity, Some(projection.native_id.as_str())) => result,
    };
    if let Err(error) = admitted {
        projection.trace_failure("admission.bound", Some("sessions.get"), Some(&error));
        let error = failure(error);
        if error.invalid_readback {
            invalid_readback(&output, &projection, &cancel).await;
        }
        let _ = first.reply.send(Err(error.operation));
        return projection;
    }
    let subscribed = tokio::select! {
        _ = cancel.cancelled() => return projection,
        result = client.subscribe(projection.native_id.as_str(), projection.cursor) => result,
    };
    let mut subscription = match subscribed {
        Ok(subscription) => subscription,
        Err(error) => {
            projection.trace_failure(
                "subscription.open",
                Some("events.subscribe"),
                Some(&Failure::Native(error.clone())),
            );
            let error = projection.subscription_failure(error);
            if error.invalid_readback {
                invalid_readback(&output, &projection, &cancel).await;
            }
            let _ = first.reply.send(Err(error.operation));
            if !error.invalid_readback {
                unavailable(&output, &projection, &cancel).await;
            }
            return projection;
        }
    };
    let mut failed = sync_request(
        &mut projection,
        first,
        &client,
        &mut subscription,
        &output,
        &acceptance,
        &cancel,
        true,
    )
    .await
    .err();
    while failed.is_none() {
        tokio::select! {
            _ = cancel.cancelled() => break,
            event = subscription.recv() => {
                failed = match event {
                    Ok(event) => projection.consume(event, &output, &cancel, false).await.err(),
                    Err(error) => Some(projection.subscription_failure(error)),
                };
                if failed.is_some_and(|error| error.invalid_readback) {
                    invalid_readback(&output, &projection, &cancel).await;
                }
            },
            request = requests.recv() => {
                let Some(request) = request else { break; };
                failed = sync_request(
                    &mut projection, request, &client, &mut subscription, &output, &acceptance, &cancel, false,
                ).await.err();
            },
        }
    }
    if failed.is_some_and(|error| !error.invalid_readback) && !cancel.is_cancelled() {
        unavailable(&output, &projection, &cancel).await;
    }
    // This owns only observation IO. It never closes a session, cancels a run, or
    // shuts down the shared control client.
    let _ = subscription.close().await;
    projection
}
async fn invalid_readback(
    output: &mpsc::Sender<SessionIngressEvent>,
    projection: &Projection,
    cancel: &CancellationToken,
) {
    let (event, receipt) = SessionIngressEvent::observation_failed(
        projection.request.identity.clone(),
        projection.binding(),
        SessionObservationFailure::InvalidReadback,
    )
    .with_receipt();
    tokio::select! {
        _ = cancel.cancelled() => return,
        result = output.send(event) => if result.is_err() { return; },
    }
    // Failure reports are rejected as facts, but receipt completion fences Host's latch.
    tokio::select! { _ = cancel.cancelled() => {}, _ = receipt => {}, }
}
async fn unavailable(
    output: &mpsc::Sender<SessionIngressEvent>,
    projection: &Projection,
    cancel: &CancellationToken,
) {
    let event = SessionIngressEvent::new(
        projection.request.identity.clone(),
        SessionEvent {
            binding: projection.binding(),
            run_id: None,
            cursor: None,
            history_refresh: false,
            changes: vec![SessionChange::RecoveryRequired {
                reason: RecoveryReason::NativeUnavailable,
            }],
        },
    );
    tokio::select! { _ = cancel.cancelled() => {}, _ = output.send(event) => {}, }
}
async fn frontier(client: &Client, id: &str) -> Result<u64, Failure> {
    let value = rpc::call(
        client,
        "events.replay",
        json!({"sessionId":id,"afterSeq":0,"limit":0}),
    )
    .await?;
    if value.get("sessionId").and_then(Value::as_str) != Some(id)
        || value
            .get("events")
            .and_then(Value::as_array)
            .is_none_or(|events| !events.is_empty())
    {
        return Err(Failure::InvalidReadback);
    }
    value
        .get("latestSeq")
        .and_then(Value::as_u64)
        .filter(|seq| *seq <= sessions_module::state::MAX_SAFE_INTEGER)
        .ok_or(Failure::InvalidReadback)
}
fn failure(error: Failure) -> ObservationFailure {
    ObservationFailure {
        operation: match error.kind() {
            rpc::FailureKind::Rejected => RuntimeOperationFailure::TargetRejected,
            rpc::FailureKind::Unknown => RuntimeOperationFailure::Unknown,
            _ => RuntimeOperationFailure::Unavailable,
        },
        invalid_readback: matches!(error, Failure::InvalidReadback),
    }
}
