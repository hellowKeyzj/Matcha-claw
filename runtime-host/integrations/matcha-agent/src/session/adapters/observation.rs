use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use foundation::execution::OwnedTask;
use sessions_module::{
    RuntimeOperationFailure, SessionFuture, SessionObservation, SessionObservationRequest,
    SessionSync, SessionSyncCut, SessionTerminalRun,
    command::{SessionEvent, SessionIngressEvent},
    ports::OwnedRuntimeFuture,
    state::{
        ApprovalPhase, ApprovalView, ItemAnchor, ItemStatus, MAX_ITEMS, MissingFact, RecoveryReason,
        RunPhase, RuntimeView, SessionApplyResult, SessionChange, SessionContent, SessionEventBinding,
        SessionFact, SessionItem, SessionState, SessionView, ToolPhase,
    },
    timeline,
};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::{
    driver::matcha_event_changes,
    peer::{MatchaPeerSessionHandle, RendererEventEnvelope, lifecycle::renderer_projection_step},
    session::{
        client::{AppServerClient, EventSubscription, RawEvent},
        events::SessionEventProjector,
        hydration::{HydrationWindowMode, HydrationWindowRequest, hydrate_lines},
        model::{RunId, RunStatus, Sequence, SessionId, SessionSnapshot},
        protocol_event::{EventEnvelope, ReplayLimit},
        request::{SessionSnapshotParams, SessionTranscriptParams},
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
    task: Option<OwnedTask<()>>,
}

fn spawn_observation(
    session: MatchaPeerSessionHandle,
    events: mpsc::Sender<SessionIngressEvent>,
    request: SessionObservationRequest,
    native_id: SessionId,
) -> ObservationRun {
    let (requests, receiver) = mpsc::channel(8);
    let (task, _) =
        OwnedTask::spawn(move |cancel| run(session, events, request, native_id, receiver, cancel));
    ObservationRun {
        requests,
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
    let driver = runtime_directory::RuntimeDriverIdentity::matcha_agent();
    if request.identity.validate().is_err()
        || request.identity.endpoint.runtime_instance_id != driver.endpoint().runtime_instance_id()
        || request.identity.endpoint.kind != "native-runtime"
        || request.identity.provider() != sessions_module::state::SessionProvider::MatchaAgent
        || SessionEventBinding::observed(request.identity.clone(), request.generation, None, true)
            .is_none()
    {
        return Err(RuntimeOperationFailure::TargetRejected);
    }
    let receive = spawn_observation(
        session.clone(),
        events.clone(),
        request.clone(),
        native_id.clone(),
    );
    Ok(Arc::new(Observation {
        session,
        events,
        request,
        native_id,
        receive: Arc::new(Mutex::new(Some(receive))),
    }))
}

impl SessionObservation for Observation {
    fn sync<'a>(
        &'a self,
        command: timeline::Command,
        epoch: u64,
    ) -> SessionFuture<'a, Result<SessionSync, RuntimeOperationFailure>> {
        Box::pin(async move {
            let requests = self
                .receive
                .lock()
                .expect("observation receive lock is not poisoned")
                .as_ref()
                .filter(|receive| receive.task.is_some())
                .map(|receive| receive.requests.clone())
                .ok_or(RuntimeOperationFailure::Unavailable)?;
            let (reply, received) = oneshot::channel();
            requests
                .send(SyncRequest {
                    command,
                    epoch,
                    reply,
                })
                .await
                .map_err(|_| RuntimeOperationFailure::Unavailable)?;
            received
                .await
                .map_err(|_| RuntimeOperationFailure::Unavailable)?
        })
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
        let mut request = self.request.clone();
        request.generation = generation;
        let native_id = self.native_id.clone();
        Box::pin(async move {
            task.join()
                .await
                .map_err(|_| RuntimeOperationFailure::Unavailable)?;
            let mut receive = receive
                .lock()
                .expect("observation receive lock is not poisoned");
            let receive = receive
                .as_mut()
                .ok_or(RuntimeOperationFailure::Unavailable)?;
            *receive = spawn_observation(session, events, request, native_id);
            Ok(())
        })
    }

    fn close(&self) -> OwnedRuntimeFuture<()> {
        let receive = self
            .receive
            .lock()
            .expect("observation receive lock is not poisoned")
            .take();
        let task = receive.and_then(|receive| receive.task);
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

struct Projection {
    request: SessionObservationRequest,
    native_id: SessionId,
    source_epoch: u64,
    cursor: Sequence,
    runs: HashMap<RunId, SessionEventProjector>,
    state: SessionState,
    acknowledged_item_ids: Vec<String>,
}

impl Projection {
    fn new(request: SessionObservationRequest, native_id: SessionId, source_epoch: u64) -> Self {
        let state =
            SessionState::new(request.identity.clone(), 1)
                .and_then(|state| state.with_goal(sessions_module::goal::SessionGoalView::Unsupported))
                .expect("validated observation identity");
        Self {
            request,
            native_id,
            source_epoch,
            cursor: Sequence::try_new(0).expect("zero is valid"),
            runs: HashMap::new(),
            state,
            acknowledged_item_ids: Vec::new(),
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

    fn project(
        &mut self,
        envelope: EventEnvelope,
    ) -> Result<Option<SessionIngressEvent>, RuntimeOperationFailure> {
        if envelope.session_id != self.native_id {
            return Err(RuntimeOperationFailure::Unknown);
        }
        if envelope.seq.get() <= self.cursor.get() {
            return Ok(None);
        }
        if envelope.seq.get() != self.cursor.get() + 1 {
            return Err(RuntimeOperationFailure::Unknown);
        }
        if let Some(run_id) = &envelope.run_id {
            if !self.runs.contains_key(run_id) && self.runs.len() >= MAX_ITEMS {
                return Err(RuntimeOperationFailure::Unknown);
            }
            self.runs.entry(run_id.clone()).or_insert_with(|| {
                SessionEventProjector::resume_after(
                    self.native_id.clone(),
                    run_id.clone(),
                    self.cursor,
                )
            });
        }
        let mut changes = Vec::new();
        for projector in self.runs.values_mut() {
            if let Some(projected) = renderer_projection_step(projector, envelope.clone())
                .map_err(|_| RuntimeOperationFailure::Unknown)?
            {
                let tool_message_id = match &projected.event {
                    crate::peer::RendererEvent::Tool { tool_call_id, .. } => projector
                        .tool_message_id(tool_call_id)
                        .map(|id| id.as_str().to_owned()),
                    _ => None,
                };
                changes = matcha_event_changes(RendererEventEnvelope::new(
                    self.request.identity.clone(),
                    self.request.generation,
                    projected.run_id,
                    projected.source_cursor,
                    Some(self.source_epoch),
                    projected.event,
                ))
                .ok_or(RuntimeOperationFailure::Unknown)?;
                project_tool_position(&mut changes, tool_message_id.as_deref(), &self.state.view())?;
            }
        }
        let mut run_id = envelope.run_id.as_ref().map(|id| id.as_str().to_owned());
        let binding = self.binding();
        let mut candidate = self.state.clone();
        if candidate.reserve_observation_capacity(&changes).is_err() {
            return Err(RuntimeOperationFailure::Unknown);
        }
        match candidate.apply_native_bound(
            binding.clone(),
            run_id.clone(),
            Some(envelope.seq.get()),
            changes.clone(),
        ) {
            SessionApplyResult::Applied(_) | SessionApplyResult::Consumed { .. } => {}
            _ => return Err(RuntimeOperationFailure::Unknown),
        }
        if !changes.is_empty() {
            let projected = candidate.view();
            changes.retain(|change| {
                !matches!(
                    change,
                    SessionChange::MessageDelta { .. }
                        | SessionChange::MessageUpdated { .. }
                        | SessionChange::ItemsReplaced { .. }
                )
            });
            changes.push(SessionChange::ItemsReplaced {
                old_item_ids: self.acknowledged_item_ids.clone(),
                anchor: ItemAnchor::Start,
                items: item_values(&projected.items).to_vec(),
            });
            run_id = None;
        }
        self.state = candidate;
        self.runs.retain(|_, projector| !projector.is_terminal());
        Ok(Some(SessionIngressEvent::new(
            self.request.identity.clone(),
            SessionEvent {
                binding,
                run_id,
                cursor: Some(envelope.seq.get()),
                changes,
            },
        )))
    }

    async fn deliver(
        &mut self,
        event: SessionIngressEvent,
        cursor: Sequence,
        events: &mpsc::Sender<SessionIngressEvent>,
        cancel: &CancellationToken,
    ) -> Result<(), RuntimeOperationFailure> {
        let (identity, event) = event.into_parts();
        let replaces_items = event
            .changes
            .iter()
            .any(|change| matches!(change, SessionChange::ItemsReplaced { .. }));
        let (event, receipt) = SessionIngressEvent::new(identity, event).with_receipt();
        tokio::select! {
            _ = cancel.cancelled() => return Err(RuntimeOperationFailure::Unavailable),
            result = events.send(event) => result.map_err(|_| RuntimeOperationFailure::Unavailable)?,
        }
        let accepted = tokio::select! {
            _ = cancel.cancelled() => return Err(RuntimeOperationFailure::Unavailable),
            result = receipt => result.map_err(|_| RuntimeOperationFailure::Unavailable)?,
        };
        if !accepted {
            return Err(RuntimeOperationFailure::Unknown);
        }
        self.cursor = cursor;
        if replaces_items {
            self.acknowledged_item_ids = item_values(&self.state.view().items)
                .iter()
                .map(|item| item.item_id().to_owned())
                .collect();
        }
        Ok(())
    }

    async fn replay(
        &mut self,
        client: &AppServerClient,
        target: Sequence,
        events: &mpsc::Sender<SessionIngressEvent>,
        cancel: &CancellationToken,
    ) -> Result<(), RuntimeOperationFailure> {
        if target.get() < self.cursor.get() {
            return Err(RuntimeOperationFailure::Unknown);
        }
        while self.cursor.get() < target.get() {
            let count = (target.get() - self.cursor.get()).min(128);
            let page = tokio::select! {
                _ = cancel.cancelled() => return Err(RuntimeOperationFailure::Unavailable),
                result = client.read_replay_payload(
                    self.native_id.clone(),
                    Some(self.cursor),
                    Some(ReplayLimit::try_new(count as f64).expect("bounded replay limit")),
                ) => result.map_err(|_| RuntimeOperationFailure::Unavailable)?,
            };
            if page.event_count() == 0
                || page.event_count() > count as usize
                || page.cursor().get() <= self.cursor.get()
                || page.cursor().get() > target.get()
            {
                return Err(RuntimeOperationFailure::Unknown);
            }
            for envelope in page.events() {
                if let Some(event) = self.project(envelope.clone())? {
                    let (identity, mut event) = event.into_parts();
                    event.binding = event.binding.with_replay();
                    self.deliver(
                        SessionIngressEvent::new(identity, event),
                        envelope.seq,
                        events,
                        cancel,
                    )
                    .await?;
                }
            }
        }
        Ok(())
    }

    async fn sync(
        &mut self,
        client: &AppServerClient,
        command: timeline::Command,
        epoch: u64,
        events: &mpsc::Sender<SessionIngressEvent>,
        cancel: &CancellationToken,
    ) -> Result<SessionSync, RuntimeOperationFailure> {
        if command.identity() != &self.request.identity
            || command.endpoint_session_id() != Some(self.native_id.as_str())
        {
            return Err(RuntimeOperationFailure::TargetRejected);
        }
        let snapshot = client
            .snapshot_session(SessionSnapshotParams::new(self.native_id.clone()))
            .await
            .map_err(|_| RuntimeOperationFailure::Unavailable)?;
        if snapshot.session.session_id != self.native_id
            || snapshot.session.last_seq.get() < self.cursor.get()
        {
            return Err(RuntimeOperationFailure::Unknown);
        }
        let target = snapshot.session.last_seq;
        // Transcript is a later independent read, not an atomic snapshot cut.
        let transcript = client
            .transcript_session(SessionTranscriptParams::new(self.native_id.clone()))
            .await
            .map_err(|_| RuntimeOperationFailure::Unavailable)?;
        let mode = match command.direction() {
            timeline::Direction::Latest => HydrationWindowMode::Latest,
            timeline::Direction::Older => HydrationWindowMode::Older,
            timeline::Direction::Newer => HydrationWindowMode::Newer,
        };
        let transcript = hydrate_lines(
            &transcript.lines,
            HydrationWindowRequest::new(mode, command.limit(), command.offset()),
        )
        .map_err(|_| RuntimeOperationFailure::Unknown)?;
        self.replay(client, target, events, cancel).await?;
        let mut view = super::timeline::project_matcha_hydration_view(
            &self.request.identity,
            Some(self.native_id.as_str().to_owned()),
            &transcript,
            epoch,
        )
        .ok_or(RuntimeOperationFailure::Unknown)?;
        let retired_item_ids = merge_event_facts(&mut view, self.state.view());
        snapshot_facts(&mut view, &snapshot);
        view.validate()
            .map_err(|_| RuntimeOperationFailure::Unknown)?;
        let mut sync = SessionSync {
            view,
            source_epoch: Some(self.source_epoch),
            source_branch: None,
            cut: SessionSyncCut::EventFrontier {
                cursor: target.get(),
                contiguous: true,
            },
            terminal_runs: snapshot
                .runs
                .iter()
                .filter_map(|run| {
                    terminal_phase(&run.status).map(|phase| SessionTerminalRun {
                        run_id: run.run_id.as_str().to_owned(),
                        phase,
                    })
                })
                .collect(),
            retired_item_ids,
            replay_baseline: Some(self.state.view()),
        };
        // Replay is already consumed; this baseline keeps the later transcript body
        // while reconciliation retains missing event facts and private fences.
        let baseline = self.state.clone();
        sync.view = self
            .state
            .reconcile_sync(&sync, &baseline)
            .map_err(|_| RuntimeOperationFailure::Unknown)?;
        sync.view.epoch = epoch;
        Ok(sync)
    }
}

async fn run(
    session: MatchaPeerSessionHandle,
    events: mpsc::Sender<SessionIngressEvent>,
    request: SessionObservationRequest,
    native_id: SessionId,
    mut requests: mpsc::Receiver<SyncRequest>,
    cancel: CancellationToken,
) {
    // Sessions installs the generation before its first sync admits native ingress.
    let first = tokio::select! {
        biased;
        _ = cancel.cancelled() => return,
        request = requests.recv() => request,
    };
    let Some(first) = first else { return; };
    if first.command.identity() != &request.identity
        || first.command.endpoint_session_id() != Some(native_id.as_str())
    {
        let _ = first.reply.send(Err(RuntimeOperationFailure::TargetRejected));
        return;
    }
    let mut projection = Projection::new(request, native_id, session.observer_source_epoch());
    let connected = tokio::select! {
        _ = cancel.cancelled() => return,
        result = session.connect_observer() => result,
    };
    let Ok(client) = connected else {
        let _ = first.reply.send(Err(RuntimeOperationFailure::Unavailable));
        unavailable(&events, &projection, &cancel).await;
        return;
    };
    // Receiver/bounded broadcast ring exists before native live subscription.
    let mut raw = client.raw_events();
    let subscribed = tokio::select! {
        _ = cancel.cancelled() => { let _ = client.close().await; return; },
        result = client.subscribe_events(projection.native_id.clone(), Some(projection.cursor)) => result,
    };
    if subscribed != Ok(EventSubscription::Subscribed) {
        let _ = first.reply.send(Err(RuntimeOperationFailure::Unavailable));
        unavailable(&events, &projection, &cancel).await;
        let _ = client.close().await;
        return;
    }
    let bootstrap = tokio::select! {
        _ = cancel.cancelled() => { let _ = client.close().await; return; },
        result = projection.sync(&client, first.command, first.epoch, &events, &cancel) => result,
    };
    let failed = bootstrap.is_err();
    if failed {
        unavailable(&events, &projection, &cancel).await;
    }
    let _ = first.reply.send(bootstrap);
    if failed {
        let _ = client.close().await;
        return;
    }
    let mut recover = false;
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => break,
            event = raw.recv() => match event {
                Ok(RawEvent::Envelope(envelope)) => {
                    let cursor = envelope.seq;
                    match projection.project(envelope) {
                        Ok(Some(event)) => {
                            if projection.deliver(event, cursor, &events, &cancel).await.is_err() {
                                recover = true; break;
                            }
                        }
                        Ok(None) => {},
                        Err(_) => { recover = true; break; }
                    }
                },
                Ok(RawEvent::Overflow | RawEvent::Closed)
                | Err(broadcast::error::RecvError::Closed | broadcast::error::RecvError::Lagged(_)) => {
                    recover = true; break;
                }
            },
            request = requests.recv() => {
                let Some(request) = request else { break; };
                let result = tokio::select! {
                    _ = cancel.cancelled() => break,
                    result = projection.sync(&client, request.command, request.epoch, &events, &cancel) => result,
                };
                let failed = result.is_err();
                if failed {
                    unavailable(&events, &projection, &cancel).await;
                }
                let _ = request.reply.send(result);
                if failed { break; }
            }
        }
    }
    if recover && !cancel.is_cancelled() {
        unavailable(&events, &projection, &cancel).await;
    }
    let _ = client.close().await;
}

async fn unavailable(
    events: &mpsc::Sender<SessionIngressEvent>,
    projection: &Projection,
    cancel: &CancellationToken,
) -> bool {
    let event = SessionIngressEvent::new(
        projection.request.identity.clone(),
        SessionEvent {
            binding: projection.binding(),
            run_id: None,
            cursor: (projection.cursor.get() > 0).then_some(projection.cursor.get()),
            changes: vec![SessionChange::RecoveryRequired {
                reason: RecoveryReason::NativeUnavailable,
            }],
        },
    );
    tokio::select! { _ = cancel.cancelled() => false, result = events.send(event) => result.is_ok() }
}

fn item_values(fact: &SessionFact<Vec<SessionItem>>) -> &[SessionItem] {
    match fact {
        SessionFact::Complete(items) | SessionFact::Incomplete { facts: items, .. } => items,
        _ => &[],
    }
}

fn tool_call_id(segment: &SessionContent) -> Option<&str> {
    match segment {
        SessionContent::ToolUse { tool_call_id, .. }
        | SessionContent::ToolResult { tool_call_id, .. } => Some(tool_call_id),
        _ => None,
    }
}

fn item_splice(items: &[SessionItem], item: SessionItem) -> SessionChange {
    let index = items
        .iter()
        .position(|existing| existing.item_id() == item.item_id())
        .unwrap_or(items.len());
    SessionChange::ItemsReplaced {
        old_item_ids: Vec::new(),
        anchor: index
            .checked_sub(1)
            .map_or(ItemAnchor::Start, |index| ItemAnchor::After {
                item_id: items[index].item_id().to_owned(),
            }),
        items: vec![item],
    }
}

fn project_tool_position(
    changes: &mut Vec<SessionChange>,
    message_id: Option<&str>,
    view: &SessionView,
) -> Result<(), RuntimeOperationFailure> {
    let items = item_values(&view.items);
    if let [
        SessionChange::MessageDelta {
            item_id,
            text,
            replace,
            status,
            ..
        },
    ] = changes.as_slice()
        && let Some(existing) = items.iter().find(|item| item.item_id() == item_id)
        && let SessionItem::AssistantTurn {
            segments,
            text: current_text,
            ..
        } = existing
        && segments
            .iter()
            .any(|segment| tool_call_id(segment).is_some())
    {
        let mut item = existing.clone();
        let SessionItem::AssistantTurn {
            text: full_text,
            status: current_status,
            ..
        } = &mut item
        else {
            unreachable!()
        };
        *full_text = if *replace {
            text.clone()
        } else {
            format!("{current_text}{text}")
        };
        *current_status = *status;
        *changes = vec![SessionChange::MessageUpdated { item }];
    }
    if let [SessionChange::ToolUpdated { tool }] = changes.as_slice() {
        if items.iter().any(|item| {
            matches!(item,
                SessionItem::AssistantTurn { segments, .. } if segments.iter().any(|segment|
                    tool_call_id(segment) == Some(tool.tool_call_id.as_str()))
            )
        }) {
            return Ok(());
        }
        if tool.phase != ToolPhase::Started {
            return Ok(());
        }
        let message_id = message_id.ok_or(RuntimeOperationFailure::Unknown)?;
        let name = tool.name.clone().unwrap_or_else(|| "tool".to_owned());
        let mut item = items
            .iter()
            .find(|item| {
                matches!(item,
                    SessionItem::AssistantTurn { message_id: Some(id), .. } if id == message_id
                )
            })
            .cloned()
            .unwrap_or_else(|| SessionItem::AssistantTurn {
                item_id: message_id.to_owned(),
                run_id: tool.run_id.clone(),
                message_id: Some(message_id.to_owned()),
                status: ItemStatus::Streaming,
                segments: Vec::new(),
                text: String::new(),
            });
        let SessionItem::AssistantTurn { segments, .. } = &mut item else {
            unreachable!()
        };
        segments.push(SessionContent::ToolUse {
            name,
            tool_call_id: tool.tool_call_id.clone(),
        });
        changes.push(item_splice(items, item));
    } else if let [SessionChange::MessageUpdated { item: incoming }] = changes.as_slice()
        && let SessionItem::AssistantTurn {
            status,
            segments: incoming_segments,
            text,
            ..
        } = incoming
        && let Some(existing) = items
            .iter()
            .find(|item| item.item_id() == incoming.item_id())
        && let SessionItem::AssistantTurn {
            segments,
            text: current_text,
            ..
        } = existing
        && segments
            .iter()
            .any(|segment| tool_call_id(segment).is_some())
    {
        let suffix = text
            .strip_prefix(current_text)
            .ok_or(RuntimeOperationFailure::Unknown)?;
        let mut item = existing.clone();
        let SessionItem::AssistantTurn {
            status: current_status,
            segments,
            text: current_text,
            ..
        } = &mut item
        else {
            unreachable!()
        };
        *current_status = *status;
        *current_text = text.clone();
        for incoming in incoming_segments {
            if let SessionContent::Thinking { .. } = incoming {
                if let Some(current) = segments
                    .iter_mut()
                    .find(|segment| matches!(segment, SessionContent::Thinking { .. }))
                {
                    *current = incoming.clone();
                } else {
                    segments.insert(0, incoming.clone());
                }
            }
        }
        if !suffix.is_empty() {
            if let Some(SessionContent::Text { text }) = segments.last_mut() {
                text.push_str(suffix);
            } else {
                segments.push(SessionContent::Text {
                    text: suffix.to_owned(),
                });
            }
        }
        *changes = vec![item_splice(items, item)];
    }
    Ok(())
}

fn merge_event_facts(view: &mut SessionView, native: SessionView) -> Vec<String> {
    let mut retired = Vec::new();
    if let (
        SessionFact::Complete(items) | SessionFact::Incomplete { facts: items, .. },
        SessionFact::Complete(events) | SessionFact::Incomplete { facts: events, .. },
    ) = (&mut view.items, native.items)
    {
        let positions: Vec<_> = items
            .iter()
            .flat_map(|item| match item {
                SessionItem::AssistantTurn { segments, .. } => segments
                    .iter()
                    .filter_map(|segment| match segment {
                        SessionContent::ToolUse { tool_call_id, .. } => {
                            Some((tool_call_id.clone(), item.item_id().to_owned()))
                        }
                        _ => None,
                    })
                    .collect(),
                _ => Vec::new(),
            })
            .collect();
        for mut event in events {
            if let SessionItem::AssistantTurn {
                run_id: native_run,
                segments,
                ..
            } = &event
            {
                for item in items.iter_mut() {
                    if let SessionItem::AssistantTurn {
                        item_id,
                        run_id,
                        segments: history,
                        ..
                    } = item
                        && run_id.is_none()
                        && (*item_id == event.item_id()
                            || history.iter().any(|segment| {
                                tool_call_id(segment).is_some_and(|id| {
                                    segments
                                        .iter()
                                        .any(|segment| tool_call_id(segment) == Some(id))
                                })
                            }))
                    {
                        *run_id = native_run.clone();
                    }
                }
            }
            let id = event.item_id().to_owned();
            if let SessionItem::AssistantTurn { segments, text, .. } = &mut event {
                let before = segments.len();
                segments.retain(|segment| !matches!(segment,
                    SessionContent::ToolUse { tool_call_id, .. } if positions.iter().any(|(call, owner)|
                        call == tool_call_id && owner != &id)
                ));
                if segments.len() != before {
                    if segments.is_empty() && text.is_empty() {
                        retired.push(id);
                    } else if let Some(item) = items.iter_mut().find(|item| item.item_id() == id) {
                        *item = event;
                    } else {
                        items.push(event);
                    }
                }
            }
        }
        let items = std::mem::take(items);
        view.items = SessionFact::Incomplete {
            facts: items,
            gaps: vec![MissingFact::EventOnly],
        };
    }
    if let (
        SessionFact::Complete(tools) | SessionFact::Incomplete { facts: tools, .. },
        SessionFact::Complete(events) | SessionFact::Incomplete { facts: events, .. },
    ) = (&mut view.tools, native.tools)
    {
        for event in events {
            if let Some(tool) = tools
                .iter_mut()
                .find(|tool| tool.tool_call_id == event.tool_call_id)
                && tool.run_id.is_none()
            {
                tool.run_id = event.run_id;
            }
        }
        let tools = std::mem::take(tools);
        view.tools = SessionFact::Incomplete {
            facts: tools,
            gaps: vec![MissingFact::EventOnly],
        };
    }
    retired
}
fn snapshot_facts(view: &mut SessionView, snapshot: &SessionSnapshot) {
    view.approvals = SessionFact::Complete(
        snapshot
            .pending_approvals
            .iter()
            .map(|approval| ApprovalView {
                approval_id: approval.approval_id().as_str().to_owned(),
                run_id: approval.run_id().map(|id| id.as_str().to_owned()),
                phase: ApprovalPhase::Requested,
                option_ids: approval
                    .option_ids()
                    .iter()
                    .map(|id| id.as_str().to_owned())
                    .collect(),
            })
            .collect(),
    );
    if let Some(run) = snapshot
        .runs
        .iter()
        .rev()
        .find(|run| terminal_phase(&run.status).is_none())
        .or_else(|| snapshot.runs.last())
    {
        let phase = match &run.status {
            RunStatus::Queued { .. } => RunPhase::Queued,
            RunStatus::Running { .. } => RunPhase::Started,
            RunStatus::WaitingForApproval { .. } => RunPhase::WaitingForApproval,
            status => terminal_phase(status).expect("native terminal run"),
        };
        view.runtime = SessionFact::Incomplete {
            facts: RuntimeView {
                phase,
                active_run_id: terminal_phase(&run.status)
                    .is_none()
                    .then(|| run.run_id.as_str().to_owned()),
                issue: None,
                run_progress: None,
                runtime_activity: None,
                error_detail: None,
            },
            gaps: vec![MissingFact::PartialRuntime],
        };
    } else {
        view.runtime = SessionFact::Unknown;
    }
}

fn terminal_phase(status: &RunStatus) -> Option<RunPhase> {
    match status {
        RunStatus::Completed { .. } => Some(RunPhase::Completed),
        RunStatus::Cancelled { .. } => Some(RunPhase::Cancelled),
        RunStatus::Failed { .. } => Some(RunPhase::Failed),
        RunStatus::Interrupted { .. } => Some(RunPhase::Interrupted),
        _ => None,
    }
}
