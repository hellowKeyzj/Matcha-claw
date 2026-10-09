use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use sessions_module::command::SessionIngressEvent;
use tokio::sync::mpsc;

use crate::gateway::{
    ingress::GatewayEpoch,
    wire::GatewayEvent,
};

use super::{
    event_router::EventRouter,
    events::{SessionEvent, send_lifecycle},
    projection::CanonicalRecoveryReason,
    protocol::{
        SessionEventEnvelope, decode_session_event,
    },
};

const INGRESS_CAPACITY: usize = 256;

fn gateway_event_trace_payload(event: &GatewayEvent, epoch: GatewayEpoch) -> serde_json::Value {
    let payload = event
        .payload
        .as_ref()
        .and_then(serde_json::Value::as_object);
    let message = payload.and_then(|payload| payload.get("message"));
    let data = payload
        .and_then(|payload| payload.get("data"))
        .and_then(serde_json::Value::as_object);
    let message_content = message.and_then(|message| message.get("content")).and_then(serde_json::Value::as_array).map(|content| content.iter().take(64).map(|block| {
        match block.get("type").and_then(serde_json::Value::as_str) {
            Some("text") => serde_json::json!({ "kind": "text", "text": block.get("text").and_then(serde_json::Value::as_str).map(sessions_module::trace::text_shape) }),
            Some("thinking") => serde_json::json!({ "kind": "thinking", "text": block.get("thinking").and_then(serde_json::Value::as_str).map(sessions_module::trace::text_shape) }),
            _ => serde_json::json!({ "kind": "other" }),
        }
    }).collect::<Vec<_>>());
    serde_json::json!({
        "sourceEpoch": epoch.as_u64(),
        "eventName": match event.name.as_str() { "chat" | "session.message" | "session.tool" | "agent" | "exec.approval.requested" | "exec.approval.resolved" | "plugin.approval.requested" | "plugin.approval.resolved" | "session.approval" | "sessions.changed" => event.name.as_str(), _ => "other" },
        "gatewaySequence": event.sequence,
        "hasPayload": event.payload.is_some(),
        "stateHash": payload.and_then(|payload| payload.get("state")).and_then(serde_json::Value::as_str).map(sessions_module::trace::fingerprint),
        "streamHash": payload.and_then(|payload| payload.get("stream")).and_then(serde_json::Value::as_str).map(sessions_module::trace::fingerprint),
        "dataKindHash": data.and_then(|data| data.get("kind")).and_then(serde_json::Value::as_str).map(sessions_module::trace::fingerprint),
        "dataPhaseHash": data.and_then(|data| data.get("phase")).and_then(serde_json::Value::as_str).map(sessions_module::trace::fingerprint),
        "hasData": data.is_some(),
        "hasDataItemId": data.and_then(|data| data.get("itemId")).is_some(),
        "hasDataText": data.and_then(|data| data.get("text")).is_some(),
        "dataTextLength": data
            .and_then(|data| data.get("text"))
            .and_then(serde_json::Value::as_str)
            .map_or(0, str::len),
        "hasDataDelta": data.and_then(|data| data.get("delta")).is_some(),
        "dataDeltaLength": data
            .and_then(|data| data.get("delta"))
            .and_then(serde_json::Value::as_str)
            .map_or(0, str::len),
        "dataProgressTextLength": data
            .and_then(|data| data.get("progressText"))
            .and_then(serde_json::Value::as_str)
            .map_or(0, str::len),
        "replace": payload
            .and_then(|payload| payload.get("replace"))
            .and_then(serde_json::Value::as_bool),
        "dataReplace": data.and_then(|data| data.get("replace")).and_then(serde_json::Value::as_bool),
        "hasDeltaText": payload.and_then(|payload| payload.get("deltaText")).is_some(),
        "deltaTextLength": payload
            .and_then(|payload| payload.get("deltaText"))
            .and_then(serde_json::Value::as_str)
            .map_or(0, str::len),
        "hasMessage": message.is_some(),
        "messageTextLength": message.and_then(message_text_length).unwrap_or(0),
        "messageThinkingLength": message.and_then(message_thinking_length).unwrap_or(0),
        "hasRunId": payload.and_then(|payload| payload.get("runId")).is_some(),
        "hasSessionKey": payload.and_then(|payload| payload.get("sessionKey")).is_some(),
        "sessionHash": payload.and_then(|payload| payload.get("sessionKey")).and_then(serde_json::Value::as_str).map(sessions_module::trace::fingerprint),
        "runHash": payload.and_then(|payload| payload.get("runId")).and_then(serde_json::Value::as_str).map(sessions_module::trace::fingerprint),
        "messageHash": payload.and_then(|payload| payload.get("messageId")).and_then(serde_json::Value::as_str).map(sessions_module::trace::fingerprint),
        "embeddedMessageHash": message.and_then(|message| message.pointer("/__openclaw/id").or_else(|| message.get("id"))).and_then(serde_json::Value::as_str).map(sessions_module::trace::fingerprint),
        "itemHash": data.and_then(|data| data.get("itemId").or_else(|| data.get("id"))).and_then(serde_json::Value::as_str).map(sessions_module::trace::fingerprint),
        "nativeSequence": payload.and_then(|payload| payload.get("seq")).and_then(serde_json::Value::as_u64),
        "messageSequence": message.and_then(|message| message.pointer("/__openclaw/seq").or_else(|| message.get("seq")).or_else(|| message.get("sequence"))).or_else(|| payload.and_then(|payload| payload.get("messageSeq"))).and_then(serde_json::Value::as_u64),
        "persistedRunHash": message.and_then(|message| message.pointer("/__openclaw/runId").or_else(|| message.get("runId"))).and_then(serde_json::Value::as_str).map(sessions_module::trace::fingerprint),
        "displayItemHash": message.and_then(|message| message.pointer("/openclawStreamFallback/itemId")).and_then(serde_json::Value::as_str).map(sessions_module::trace::fingerprint),
        "deltaText": payload.and_then(|payload| payload.get("deltaText")).and_then(serde_json::Value::as_str).map(sessions_module::trace::text_shape),
        "dataText": data.and_then(|data| data.get("text")).and_then(serde_json::Value::as_str).map(sessions_module::trace::text_shape),
        "dataDelta": data.and_then(|data| data.get("delta")).and_then(serde_json::Value::as_str).map(sessions_module::trace::text_shape),
        "dataProgressText": data.and_then(|data| data.get("progressText")).and_then(serde_json::Value::as_str).map(sessions_module::trace::text_shape),
        "messageContentCount": message.and_then(|message| message.get("content")).and_then(serde_json::Value::as_array).map(Vec::len),
        "messageContentSummarizedCount": message.and_then(|message| message.get("content")).and_then(serde_json::Value::as_array).map(|content| content.len().min(64)),
        "messageContentTruncated": message.and_then(|message| message.get("content")).and_then(serde_json::Value::as_array).is_some_and(|content| content.len() > 64),
        "messageContent": message_content,
    })
}

fn trace_gateway_drop(
    stage: &'static str,
    mut payload: Option<serde_json::Value>,
    reason: impl Into<String>,
) {
    if !super::trace::enabled() {
        return;
    }
    let Some(payload) = payload.as_mut() else {
        return;
    };
    if let serde_json::Value::Object(fields) = payload {
        fields.insert(
            "dropReason".into(),
            serde_json::Value::String(reason.into()),
        );
    }
    super::trace::log_unscoped(stage, payload.clone());
}

fn trace_decoded_event(stage: &'static str, envelope: &SessionEventEnvelope, epoch: GatewayEpoch) {
    if !super::trace::enabled() {
        return;
    }
    let chat = envelope.chat.as_ref();
    super::trace::log_unscoped(
        stage,
        serde_json::json!({
            "sourceEpoch": epoch.as_u64(),
            "kind": format!("{:?}", envelope.kind),
            "gatewaySequence": envelope.gateway_sequence,
            "hasRunId": envelope.run_id.is_some(),
            "hasMessageId": envelope.message_id.is_some(),
            "hasEmbeddedMessageId": envelope.embedded_message_id.is_some(),
            "hasChat": envelope.chat.is_some(),
            "chatState": chat.map(|chat| format!("{:?}", chat.state)),
            "deltaTextLength": chat.and_then(|chat| chat.delta_text.as_ref()).map_or(0, String::len),
            "replace": chat.is_some_and(|chat| chat.replace),
            "messageTextLength": chat.and_then(|chat| chat.message_text.as_ref()).map_or(0, String::len),
            "messageThinkingLength": chat.and_then(|chat| chat.message_thinking.as_ref()).map_or(0, String::len),
            "hasActivity": envelope.activity.is_some(),
            "hasApproval": envelope.approval.is_some(),
            "sessionHash": sessions_module::trace::fingerprint(envelope.session_key.as_str()),
            "runHash": envelope.run_id.as_ref().map(|id| sessions_module::trace::fingerprint(id.as_str())),
            "messageHash": envelope.message_id.as_ref().map(|id| sessions_module::trace::fingerprint(id.as_str())),
            "embeddedMessageHash": envelope.embedded_message_id.as_ref().map(|id| sessions_module::trace::fingerprint(id.as_str())),
            "chatSequence": chat.map(|chat| chat.sequence),
            "deltaText": chat.and_then(|chat| chat.delta_text.as_deref()).map(sessions_module::trace::text_shape),
            "messageText": chat.and_then(|chat| chat.message_text.as_deref()).map(sessions_module::trace::text_shape),
            "messageThinking": chat.and_then(|chat| chat.message_thinking.as_deref()).map(sessions_module::trace::text_shape),
            "activity": envelope.activity.as_ref().map(|activity| match activity.kind() {
                super::protocol::SessionActivityKind::Message { message_id, lifecycle, text } => serde_json::json!({ "kind": "message", "messageHash": sessions_module::trace::fingerprint(message_id.as_str()), "lifecycle": format!("{:?}", lifecycle), "text": text.as_deref().map(sessions_module::trace::text_shape) }),
                super::protocol::SessionActivityKind::Thinking { text } => serde_json::json!({ "kind": "thinking", "text": sessions_module::trace::text_shape(text) }),
                super::protocol::SessionActivityKind::Tool { tool_id, phase, .. } => serde_json::json!({ "kind": "tool", "toolHash": sessions_module::trace::fingerprint(tool_id.as_str()), "phase": format!("{:?}", phase) }),
                _ => serde_json::json!({ "kind": "other" }),
            }),
            "persistedMessage": envelope.transcript_message.as_ref().map(|message| serde_json::json!({
                "role": format!("{:?}", message.role()), "runHash": message.run_id().map(sessions_module::trace::fingerprint),
                "messageHash": message.message_id().map(sessions_module::trace::fingerprint), "displayItemHash": message.display_item_id().map(sessions_module::trace::fingerprint),
                "sequence": message.sequence(), "text": sessions_module::trace::text_shape(message.text()) })),
            "commentary": envelope.commentary.as_ref().map(|(id, text)| serde_json::json!({ "itemHash": sessions_module::trace::fingerprint(id), "text": sessions_module::trace::text_shape(text) })),
        }),
    );
}

fn message_text_length(message: &serde_json::Value) -> Option<usize> {
    message_content_length(message, "text", "text")
}

fn message_thinking_length(message: &serde_json::Value) -> Option<usize> {
    message_content_length(message, "thinking", "thinking")
}

fn message_content_length(
    message: &serde_json::Value,
    block_type: &str,
    text_key: &str,
) -> Option<usize> {
    message
        .get("content")
        .and_then(serde_json::Value::as_array)
        .map(|content| {
            content
                .iter()
                .filter_map(|block| {
                    (block.get("type").and_then(serde_json::Value::as_str) == Some(block_type))
                        .then(|| block.get(text_key).and_then(serde_json::Value::as_str))?
                })
                .map(str::len)
                .sum()
        })
}

/// Consumes a socket's decoded Gateway events, sequences them through the
/// shared [`Ingress`], and fans each verified event out to the lifecycle sink
/// and the sessions module ingress.
pub(crate) struct SessionEventIngest {
    sender: mpsc::Sender<IngestFrame>,
    next_epoch: AtomicU64,
    task: Mutex<Option<foundation::execution::OwnedTask<()>>>,
    session_events: mpsc::Sender<SessionIngressEvent>,
}

pub(crate) enum IngestFrame {
    Socket { epoch: GatewayEpoch, frame: crate::gateway::connection::GatewayFrame, observations: Arc<crate::gateway::observation::Observations> },
    HistoryContent { identity: sessions_module::state::SessionIdentity, generation: u64, source_epoch: GatewayEpoch, window: super::window::SessionWindow, page: super::window::PageRequest, host_epoch: u64, observations: Arc<crate::gateway::observation::Observations>, reply: tokio::sync::oneshot::Sender<Result<Option<sessions_module::ports::SessionSync>, sessions_module::ports::RuntimeOperationFailure>> },
    HistoryStarted { identity: sessions_module::state::SessionIdentity, generation: u64, page: super::window::PageRequest, reply: tokio::sync::oneshot::Sender<u64> },
    HistoryFinished { identity: sessions_module::state::SessionIdentity, generation: u64, read: u64, reply: tokio::sync::oneshot::Sender<bool> },
    Close { identity: sessions_module::state::SessionIdentity, generation: u64, reply: tokio::sync::oneshot::Sender<()> },
    Restart { identity: sessions_module::state::SessionIdentity, generation: u64, next_generation: u64, observations: Arc<crate::gateway::observation::Observations>, reply: tokio::sync::oneshot::Sender<Result<(), sessions_module::ports::RuntimeOperationFailure>> },
}

impl SessionEventIngest {
    pub(crate) fn new(
        events: mpsc::Sender<SessionEvent>,
        session_events: mpsc::Sender<SessionIngressEvent>,
    ) -> Self {
        let (sender, receiver) = mpsc::channel(INGRESS_CAPACITY);
        let session_sink = session_events.clone();
        let (task, _) = foundation::execution::OwnedTask::spawn(|cancel| async move {
            tokio::select! {
                _ = cancel.cancelled() => {},
                _ = project_ingress(receiver, events, session_events) => {},
            }
        });
        Self { sender, next_epoch: AtomicU64::new(0), task: Mutex::new(Some(task)), session_events: session_sink }
    }

    pub(crate) fn forward(self: &Arc<Self>, mut events: mpsc::Receiver<crate::gateway::connection::GatewayFrame>, observations: Arc<crate::gateway::observation::Observations>, failure: tokio::sync::watch::Receiver<Option<crate::gateway::delivery::DispatcherError>>) -> (GatewayEpoch, foundation::execution::OwnedTask<()>) {
        let value = self.next_epoch.fetch_add(1, Ordering::Relaxed).checked_add(1).expect("gateway epoch exhausted");
        let epoch = GatewayEpoch::try_new(value).expect("gateway epoch never zero");
        observations.activate(value);
        let sender = self.sender.clone();
        let session_events = self.session_events.clone();
        let (task, _) = foundation::execution::OwnedTask::spawn(move |cancel| async move {
            loop {
                let frame = tokio::select! { _ = cancel.cancelled() => { observations.deactivate(value); return; }, frame = events.recv() => frame };
                let Some(frame) = frame else { break };
                if sender.send(IngestFrame::Socket { epoch, frame, observations: Arc::clone(&observations) }).await.is_err() { break; }
            }
            observations.deactivate(value);
            let reason = match *failure.borrow() {
                Some(crate::gateway::delivery::DispatcherError::EventBackpressure) => sessions_module::state::RecoveryReason::EventOverflow,
                Some(crate::gateway::delivery::DispatcherError::Protocol) => sessions_module::state::RecoveryReason::NativeUnknown,
                _ => sessions_module::state::RecoveryReason::NativeUnavailable,
            };
            for (identity, generation) in observation_targets(&observations, value, None) {
                let binding = sessions_module::state::SessionEventBinding::observed(identity.clone(), generation, Some(value), false).expect("validated observation binding");
                let event = SessionIngressEvent::new(identity, sessions_module::command::SessionEvent { binding, run_id: None, cursor: None, history_refresh: false, changes: vec![sessions_module::state::SessionChange::RecoveryRequired { reason }] });
                if session_events.send(event).await.is_err() { break; }
            }
        });
        (epoch, task)
    }

    pub(crate) async fn restart_observation(&self, identity: sessions_module::state::SessionIdentity, generation: u64, next_generation: u64, observations: Arc<crate::gateway::observation::Observations>) -> Result<(), sessions_module::ports::RuntimeOperationFailure> {
        use sessions_module::ports::RuntimeOperationFailure;
        let (reply, receiver) = tokio::sync::oneshot::channel();
        self.sender.send(IngestFrame::Restart { identity, generation, next_generation, observations, reply }).await.map_err(|_| RuntimeOperationFailure::Unavailable)?;
        receiver.await.map_err(|_| RuntimeOperationFailure::Unavailable)?
    }

    pub(crate) async fn history_content(&self, identity: sessions_module::state::SessionIdentity, generation: u64, source_epoch: GatewayEpoch, window: super::window::SessionWindow, page: super::window::PageRequest, host_epoch: u64, observations: Arc<crate::gateway::observation::Observations>) -> Result<Option<sessions_module::ports::SessionSync>, sessions_module::ports::RuntimeOperationFailure> {
        use sessions_module::ports::RuntimeOperationFailure;
        let (reply, receiver) = tokio::sync::oneshot::channel();
        self.sender.send(IngestFrame::HistoryContent { identity, generation, source_epoch, window, page, host_epoch, observations, reply }).await.map_err(|_| RuntimeOperationFailure::Unavailable)?;
        receiver.await.map_err(|_| RuntimeOperationFailure::Unavailable)?
    }

    pub(crate) async fn history_started(&self, identity: sessions_module::state::SessionIdentity, generation: u64, page: super::window::PageRequest) -> Result<u64, sessions_module::ports::RuntimeOperationFailure> {
        use sessions_module::ports::RuntimeOperationFailure;
        let (reply, receiver) = tokio::sync::oneshot::channel();
        self.sender.send(IngestFrame::HistoryStarted { identity, generation, page, reply }).await.map_err(|_| RuntimeOperationFailure::Unavailable)?;
        receiver.await.map_err(|_| RuntimeOperationFailure::Unavailable)
    }

    pub(crate) async fn history_finished(&self, identity: sessions_module::state::SessionIdentity, generation: u64, read: u64) -> bool {
        let (reply, receiver) = tokio::sync::oneshot::channel();
        if self.sender.send(IngestFrame::HistoryFinished { identity, generation, read, reply }).await.is_err() { return false; }
        receiver.await.unwrap_or(false)
    }

    pub(crate) async fn close_observation(&self, identity: sessions_module::state::SessionIdentity, generation: u64) {
        let (reply, receiver) = tokio::sync::oneshot::channel();
        if self.sender.send(IngestFrame::Close { identity, generation, reply }).await.is_ok() { let _ = receiver.await; }
    }
}

async fn project_ingress(mut receiver: mpsc::Receiver<IngestFrame>, events: mpsc::Sender<SessionEvent>, session_events: mpsc::Sender<SessionIngressEvent>) {
    use crate::gateway::{connection::GatewayFrame, observation::{OrderedContext, identity_key}};
    use sessions_module::ports::RuntimeOperationFailure;
    let mut router = EventRouter::new(session_events);
    let mut active_epoch = 0;
    let mut last_sequence = None;
    loop {
        let deadline = router.recovery_deadline();
        let frame = tokio::select! {
            frame = receiver.recv() => { let Some(frame) = frame else { break }; frame },
            _ = async { if let Some(deadline) = deadline { tokio::time::sleep_until(deadline).await; } else { std::future::pending::<()>().await; } } => {
                router.refresh_terminal_history().await;
                continue;
            }
        };
        let (epoch, frame, observations) = match frame {
            IngestFrame::HistoryStarted { identity, generation, page, reply } => {
                let _ = reply.send(router.history_started(&identity, generation, page));
                continue;
            }
            IngestFrame::HistoryFinished { identity, generation, read, reply } => {
                let _ = reply.send(router.history_finished(&identity, generation, read));
                continue;
            }
            IngestFrame::Socket { epoch, frame, observations } => (epoch, frame, observations),
            IngestFrame::HistoryContent { identity, generation, source_epoch, window, page, host_epoch, observations, reply } => {
                let result = if source_epoch.as_u64() != active_epoch || !observations.contains(&identity, generation, Some(active_epoch)) {
                    Err(RuntimeOperationFailure::Unavailable)
                } else {
                    let cursor = window.state().delta_cursor().map(str::to_owned);
                    let history_kind = super::trace::enabled().then(|| window.state().kind());
                    let result = router.history(identity.clone(), generation, window, page, source_epoch, host_epoch);
                    update_history_cursor(&observations, &identity, generation, page, cursor, &result, source_epoch.as_u64(), history_kind);
                    result
                };
                let _ = reply.send(result);
                continue;
            }
            IngestFrame::Close { identity, generation, reply } => { router.close(&identity, generation); let _ = reply.send(()); continue; }
            IngestFrame::Restart { identity, generation, next_generation, observations, reply } => {
                let result = if observations.contains(&identity, next_generation, None) {
                    router.restart(&identity, generation, next_generation)
                } else { Err(RuntimeOperationFailure::Unavailable) };
                if super::trace::enabled() {
                    super::trace::log_unscoped("runtime.openclaw.ingress.restart_ordered", serde_json::json!({
                        "identity": sessions_module::trace::identity_shape(&identity), "generation": generation,
                        "nextGeneration": next_generation, "activeSourceEpoch": active_epoch, "nativeCursor": last_sequence,
                        "accepted": result.is_ok(), "failure": result.as_ref().err().map(|failure| format!("{:?}", failure)) }));
                }
                let _ = reply.send(result);
                continue;
            }
        };
        if epoch.as_u64() > active_epoch {
            if super::trace::enabled() { super::trace::log_unscoped("runtime.openclaw.ingress.source_epoch", serde_json::json!({
                "previousSourceEpoch": active_epoch, "sourceEpoch": epoch.as_u64(), "previousNativeCursor": last_sequence })); }
            active_epoch = epoch.as_u64(); last_sequence = None;
        }
        match frame {
            GatewayFrame::Event(event) => {
                let trace_payload = super::trace::enabled().then(|| gateway_event_trace_payload(&event, epoch));
                if let Some(payload) = trace_payload.as_ref() {
                    super::trace::log_unscoped("runtime.openclaw.ingress.raw", payload.clone());
                }
                if epoch.as_u64() < active_epoch {
                    trace_gateway_drop("runtime.openclaw.ingress.dropped", trace_payload, "source_epoch_stale");
                    continue;
                }
                let monotonic = event.sequence.is_none_or(|seq| last_sequence.is_none_or(|last| seq > last));
                if !monotonic {
                    trace_gateway_drop("runtime.openclaw.ingress.dropped", trace_payload, "non_monotonic_gateway_sequence");
                    let targets = observation_targets(&observations, active_epoch, None);
                    for (identity, generation) in targets { router.recover(identity, generation, epoch, CanonicalRecoveryReason::CursorStale).await; }
                    continue;
                }
                if event.sequence.zip(last_sequence).is_some_and(|(seq, last)| seq > last + 1) {
                    trace_gateway_drop("runtime.openclaw.ingress.dropped", trace_payload, "gateway_sequence_gap");
                    let targets: Vec<_> = {
                        let mut entries = observations.entries.lock().expect("observation registry lock poisoned");
                        entries.values_mut().filter(|entry| !entry.paused && entry.source_epoch == Some(active_epoch))
                            .map(|entry| { entry.paused = true; (entry.identity.clone(), entry.generation) }).collect()
                    };
                    last_sequence = event.sequence;
                    for (identity, generation) in targets { router.recover(identity, generation, epoch, CanonicalRecoveryReason::CursorGap).await; }
                    continue;
                }
                if event.sequence.is_some() { last_sequence = event.sequence; }
                if matches!(event.name.as_str(), "question.requested" | "question.resolved") {
                    let _ = events.send(SessionEvent::QuestionsChanged).await;
                    continue;
                }
                match super::goal::changed(&event) {
                    Ok(Some((key, agent, session, goal))) => {
                        for (identity, generation) in observation_targets(&observations, active_epoch, Some(key)) {
                            if identity.agent_id != agent { continue; }
                            if router.goal(&identity, generation, session, goal.clone(), epoch, None).await.is_err() {
                                router.recover(identity, generation, epoch, CanonicalRecoveryReason::NativeUnknown).await;
                            }
                        }
                    }
                    Err(_) => {
                        for (identity, generation) in observation_targets(&observations, active_epoch, event.payload.as_ref().and_then(|payload| payload.get("sessionKey")).and_then(serde_json::Value::as_str)) {
                            router.recover(identity, generation, epoch, CanonicalRecoveryReason::NativeUnknown).await;
                        }
                        continue;
                    }
                    Ok(None) => {}
                }
                let envelope = match decode_session_event(event) {
                    Ok(Some(event)) => event,
                    Ok(None) => {
                        trace_gateway_drop("runtime.openclaw.ingress.dropped", trace_payload, "not_session_event");
                        continue;
                    }
                    Err(_) => {
                        trace_gateway_drop("runtime.openclaw.ingress.dropped", trace_payload, "decode_failed");
                        for (identity, generation) in observation_targets(&observations, active_epoch, None) { router.recover(identity, generation, epoch, CanonicalRecoveryReason::NativeUnknown).await; }
                        continue;
                    }
                };
                let _ = send_lifecycle(&events, &envelope, epoch);
                trace_decoded_event("runtime.openclaw.ingress.routed", &envelope, epoch);
                let targets = observation_targets(&observations, active_epoch, Some(envelope.session_key.as_str()));
                if super::trace::enabled() {
                    let entries = observations.entries.lock().expect("observation registry lock poisoned");
                    super::trace::log_unscoped("runtime.openclaw.ingress.targets", serde_json::json!({
                        "sourceEpoch": epoch.as_u64(), "activeSourceEpoch": active_epoch, "nativeCursor": envelope.gateway_sequence,
                        "sessionHash": sessions_module::trace::fingerprint(envelope.session_key.as_str()), "targetCount": targets.len(),
                        "candidateCount": entries.values().filter(|entry| entry.identity.session_key == envelope.session_key.as_str()).count(),
                        "candidatesTruncated": entries.values().filter(|entry| entry.identity.session_key == envelope.session_key.as_str()).count() > 200,
                        "candidates": entries.values().filter(|entry| entry.identity.session_key == envelope.session_key.as_str()).take(200).map(|entry| serde_json::json!({
                            "identity": sessions_module::trace::identity_shape(&entry.identity), "generation": entry.generation,
                            "sourceEpoch": entry.source_epoch, "subscribedEpoch": entry.subscribed_epoch, "paused": entry.paused,
                            "decision": if entry.paused { "paused" } else if entry.source_epoch != Some(active_epoch) { "source_epoch_mismatch" } else { "admitted" }
                        })).collect::<Vec<_>>() }));
                }
                for (identity, generation) in targets {
                    if observations.contains(&identity, generation, Some(active_epoch)) { router.route(envelope.clone(), epoch, identity, generation, &observations).await; }
                    else if super::trace::enabled() {
                        super::trace::log_unscoped("runtime.openclaw.ingress.target_dropped", serde_json::json!({
                            "identity": sessions_module::trace::identity_shape(&identity), "generation": generation,
                            "sourceEpoch": active_epoch, "nativeCursor": envelope.gateway_sequence, "reason": "binding_changed" }));
                    }
                }
            }
            GatewayFrame::Response { response, reply } => {
                let context = observations.pending.lock().expect("observation pending lock poisoned").remove(response.request_id());
                let _result = match context {
                    Some(OrderedContext::Subscribe { identity, generation, reply: subscribe_reply }) => {
                        let result = if epoch.as_u64() != active_epoch || !observations.contains(&identity, generation, Some(active_epoch)) {
                            Err(RuntimeOperationFailure::Unavailable)
                        } else if let crate::gateway::wire::GatewayResponse::Failure { error, .. } = &response {
                            Err(observation_failure(error))
                        } else {
                            match crate::gateway::wire::decode_sessions_messages_subscribe(match &response {
                                crate::gateway::wire::GatewayResponse::Success { request_id, payload } => crate::gateway::wire::GatewayResponse::Success { request_id: request_id.clone(), payload: payload.clone() },
                                crate::gateway::wire::GatewayResponse::Failure { .. } => unreachable!("native failure handled above"),
                            }) {
                                Ok(subscription) if subscription.key == identity.session_key => {
                                    let result = router.approvals(&identity, generation, subscription.approvals, epoch);
                                    if result.is_ok() { if let Some(entry) = observations.entries.lock().expect("observation registry lock poisoned").get_mut(&identity_key(&identity)) { if entry.generation == generation { entry.subscribed_epoch = Some(active_epoch); } } }
                                    result
                                }
                                _ => Err(RuntimeOperationFailure::Unknown),
                            }
                        };
                        if super::trace::enabled() {
                            super::trace::log_unscoped("runtime.openclaw.ingress.subscribe_result", serde_json::json!({
                                "identity": sessions_module::trace::identity_shape(&identity), "generation": generation,
                                "sourceEpoch": epoch.as_u64(), "activeSourceEpoch": active_epoch, "accepted": result.is_ok(),
                                "failure": result.as_ref().err().map(|failure| format!("{:?}", failure)) }));
                        }
                        let _ = subscribe_reply.send(result);
                        result
                    }
                    Some(OrderedContext::Describe { identity, generation, supported, reply: describe_reply }) => {
                        let result = async {
                            if epoch.as_u64() != active_epoch || !observations.contains(&identity, generation, Some(active_epoch)) {
                                return Err(RuntimeOperationFailure::Unavailable);
                            }
                            if let crate::gateway::wire::GatewayResponse::Failure { error, .. } = &response { return Err(observation_failure(error)); }
                            if super::trace::enabled()
                                && let crate::gateway::wire::GatewayResponse::Success { payload: Some(payload), .. } = &response
                                && let Some(session) = payload.get("session").and_then(serde_json::Value::as_object)
                            {
                                super::trace::log_unscoped("runtime.openclaw.ingress.goal_session", serde_json::json!({
                                    "identity": sessions_module::trace::identity_shape(&identity),
                                    "generation": generation, "sourceEpoch": epoch.as_u64(),
                                    "sessionId": sessions_module::trace::id_shape(session.get("sessionId").and_then(serde_json::Value::as_str)),
                                    "running": session.get("status").and_then(serde_json::Value::as_str).map(|status| status == "running"),
                                    "abortedLastRun": session.get("abortedLastRun").and_then(serde_json::Value::as_bool),
                                    "archived": session.get("archived").and_then(serde_json::Value::as_bool),
                                    "archivedAtPresent": session.get("archivedAt").is_some_and(|value| !value.is_null()),
                                    "spawnedByPresent": session.get("spawnedBy").is_some_and(|value| !value.is_null()),
                                    "spawnDepth": session.get("spawnDepth").and_then(serde_json::Value::as_u64),
                                    "subagentRolePresent": session.get("subagentRole").is_some_and(|value| !value.is_null()),
                                    "hasActiveSubagentRun": session.get("hasActiveSubagentRun").and_then(serde_json::Value::as_bool),
                                }));
                            }
                            let row = super::protocol::decode_session_describe_result(response.request_id(), match &response {
                                crate::gateway::wire::GatewayResponse::Success { request_id, payload } => crate::gateway::wire::GatewayResponse::Success { request_id: request_id.clone(), payload: payload.clone() },
                                crate::gateway::wire::GatewayResponse::Failure { .. } => unreachable!("native failure handled above"),
                            }).map_err(|_| RuntimeOperationFailure::Unknown)?.ok_or(RuntimeOperationFailure::Unknown)?;
                            if row.agent_id.as_ref().map(|agent| agent.as_str()) != Some(identity.agent_id.as_str()) || row.key.as_deref() != Some(identity.session_key.as_str()) { return Err(RuntimeOperationFailure::Unknown); }
                            let session_id = row.session_id.ok_or(RuntimeOperationFailure::Unknown)?;
                            let goal = if supported { row.goal } else { sessions_module::goal::SessionGoalView::Unsupported };
                            router.goal(&identity, generation, &session_id, goal, epoch, None).await
                        }.await;
                        let _ = describe_reply.send(result);
                        result
                    }
                    Some(OrderedContext::History { identity, generation, page, host_epoch, reply: history_reply }) => {
                        let request_hash = super::trace::enabled().then(|| sessions_module::trace::fingerprint(response.request_id()));
                        if super::trace::enabled() {
                            super::trace::log_unscoped("runtime.openclaw.ingress.history_response", serde_json::json!({
                                "identity": sessions_module::trace::identity_shape(&identity), "generation": generation,
                                "requestHash": &request_hash, "sourceEpoch": epoch.as_u64(), "activeSourceEpoch": active_epoch,
                                "direction": format!("{:?}", page.direction()), "limit": page.limit(), "offset": page.offset(),
                                "timingScope": "ordered_ingress_processing_start_after_socket_and_ingress_queue" }));
                        }
                        let result = if epoch.as_u64() == active_epoch && observations.contains(&identity, generation, Some(active_epoch)) {
                            match &response {
                                crate::gateway::wire::GatewayResponse::Success { payload: Some(payload), .. } => {
                                    let decode_started = super::trace::enabled().then(std::time::Instant::now);
                                    let decoded = super::window::decode_window(payload.clone(), page);
                                    let decode_elapsed_ms = decode_started.map(|started| started.elapsed().as_secs_f64() * 1000.0);
                                    if super::trace::enabled() {
                                        super::trace::log_unscoped("runtime.openclaw.ingress.history_decoded", serde_json::json!({
                                            "identity": sessions_module::trace::identity_shape(&identity), "generation": generation,
                                            "requestHash": &request_hash, "sourceEpoch": epoch.as_u64(), "decoded": decoded.is_ok(),
                                            "decodeElapsedMs": decode_elapsed_ms, "timingScope": "payload_clone_and_decode_window_excluding_outer_trace",
                                            "messageCount": decoded.as_ref().ok().map(|window| window.messages().len()),
                                        }));
                                    }
                                    match decoded {
                                        Ok(window) if window.messages().iter().any(super::window::Message::truncated) => {
                                            Ok(crate::gateway::observation::HistoryRead::NeedsContent { window, source_epoch: epoch })
                                        }
                                        Ok(window) => {
                                            let cursor = window.state().delta_cursor().map(str::to_owned);
                                            let history_kind = super::trace::enabled().then(|| window.state().kind());
                                            let projection_started = super::trace::enabled().then(std::time::Instant::now);
                                            let result = if super::trace::enabled() {
                                                sessions_module::trace::with_context(serde_json::json!({ "requestHash": &request_hash }), ||
                                                    router.history(identity.clone(), generation, window, page, epoch, host_epoch))
                                            } else { router.history(identity.clone(), generation, window, page, epoch, host_epoch) };
                                            let projection_elapsed_ms = projection_started.map(|started| started.elapsed().as_secs_f64() * 1000.0);
                                            if super::trace::enabled() {
                                                super::trace::log_unscoped("runtime.openclaw.ingress.history_projected", serde_json::json!({
                                                    "identity": sessions_module::trace::identity_shape(&identity), "generation": generation,
                                                    "requestHash": &request_hash, "sourceEpoch": epoch.as_u64(), "accepted": result.is_ok(),
                                                    "projectionElapsedMs": projection_elapsed_ms, "timingScope": "router_history_with_context_including_internal_trace_excluding_outer_trace",
                                                }));
                                            }
                                            update_history_cursor(&observations, &identity, generation, page, cursor, &result, epoch.as_u64(), history_kind);
                                            result.map(crate::gateway::observation::HistoryRead::Projected)
                                        }
                                        Err(_) => {
                                            if super::trace::enabled() {
                                                super::trace::log_unscoped("runtime.openclaw.ingress.history_decode_failed", serde_json::json!({
                                                    "identity": sessions_module::trace::identity_shape(&identity), "generation": generation,
                                                    "sourceEpoch": epoch.as_u64(), "activeSourceEpoch": active_epoch, "requestHash": &request_hash,
                                                    "decodeElapsedMs": decode_elapsed_ms, "reason": "decode_failed" }));
                                            }
                                            Err(RuntimeOperationFailure::Unknown)
                                        },
                                    }
                                },
                                crate::gateway::wire::GatewayResponse::Failure { error, .. } => Err(observation_failure(error)),
                                _ => Err(RuntimeOperationFailure::Unknown),
                            }
                        } else { Err(RuntimeOperationFailure::Unavailable) };
                        if super::trace::enabled() {
                            super::trace::log_unscoped("runtime.openclaw.ingress.history_result", serde_json::json!({
                                "identity": sessions_module::trace::identity_shape(&identity), "generation": generation,
                                "sourceEpoch": epoch.as_u64(), "activeSourceEpoch": active_epoch, "direction": format!("{:?}", page.direction()),
                                "requestHash": &request_hash, "limit": page.limit(), "offset": page.offset(),
                                "accepted": result.is_ok(), "hasSnapshot": matches!(&result, Ok(crate::gateway::observation::HistoryRead::Projected(Some(_)))),
                                "failure": result.as_ref().err().map(|failure| format!("{:?}", failure)) }));
                        }
                        let status = result.as_ref().map(|_| ()).map_err(|error| *error);
                        let _ = history_reply.send(result);
                        status
                    }
                    _ => Err(RuntimeOperationFailure::Unavailable),
                };
                let _ = reply.send(Ok(response));
            }
        }
    }
}

fn update_history_cursor(observations: &crate::gateway::observation::Observations, identity: &sessions_module::state::SessionIdentity, generation: u64, page: super::window::PageRequest, cursor: Option<String>, result: &Result<Option<sessions_module::ports::SessionSync>, sessions_module::ports::RuntimeOperationFailure>, source_epoch: u64, history_kind: Option<super::window::HistoryKind>) {
    let mut cursor_trace = super::trace::enabled().then(|| serde_json::json!({
        "identity": sessions_module::trace::identity_shape(identity), "generation": generation, "sourceEpoch": source_epoch,
        "historyKind": history_kind.map(|kind| format!("{:?}", kind)), "direction": format!("{:?}", page.direction()),
        "limit": page.limit(), "offset": page.offset(), "cursorState": "observation",
        "historyResult": match result { Ok(Some(_)) => "snapshot", Ok(None) => "reset", Err(_) => "failed" },
        "ingressBindingAdmitted": true,
        "responseCursorPresent": cursor.is_some(), "saveCandidatePresent": cursor.is_some(),
        "saveCandidateHash": cursor.as_deref().map(sessions_module::trace::fingerprint),
        "registryObserved": false, "cursorSaveDecision": if result.is_err() { "history_failed" } else { "not_latest" }
    }));
    if result.is_ok() && matches!(page.direction(), super::window::Direction::Latest) {
        if let Some(payload) = cursor_trace.as_mut() {
            payload["registryObserved"] = serde_json::json!(true);
            payload["cursorSaveDecision"] = serde_json::json!("registry_missing");
        }
        if let Some(entry) = observations.entries.lock().expect("observation registry lock poisoned").get_mut(&crate::gateway::observation::identity_key(identity)) {
            if let Some(payload) = cursor_trace.as_mut() {
                payload["entryGeneration"] = serde_json::json!(entry.generation);
                payload["entrySourceEpoch"] = serde_json::json!(entry.source_epoch);
                payload["generationMatched"] = serde_json::json!(entry.generation == generation);
                payload["sourceEpochMatched"] = serde_json::json!(entry.source_epoch == Some(source_epoch));
                payload["cursorBeforePresent"] = serde_json::json!(entry.cursor.is_some());
                payload["cursorBeforeHash"] = serde_json::json!(entry.cursor.as_deref().map(sessions_module::trace::fingerprint));
                payload["cursorSaveDecision"] = serde_json::json!(if entry.generation != generation { "stale_generation" }
                    else if entry.source_epoch != Some(source_epoch) { "stale_epoch" }
                    else if matches!(result, Ok(None)) { "reset_cleared" }
                    else if cursor.is_none() { "response_no_cursor" } else { "saved" });
            }
            if entry.generation == generation && entry.source_epoch == Some(source_epoch) {
                entry.cursor = if matches!(result, Ok(Some(_))) { cursor } else { None };
                entry.cursor_page = entry.cursor.as_ref().map(|_| page);
            }
            if let Some(payload) = cursor_trace.as_mut() {
                payload["cursorAfterPresent"] = serde_json::json!(entry.cursor.is_some());
                payload["cursorAfterHash"] = serde_json::json!(entry.cursor.as_deref().map(sessions_module::trace::fingerprint));
            }
        }
    }
    if let Some(payload) = cursor_trace {
        super::trace::log_unscoped("runtime.openclaw.ingress.history_cursor", payload);
    }
}

fn observation_failure(error: &crate::gateway::wire::GatewayError) -> sessions_module::ports::RuntimeOperationFailure {
    use sessions_module::ports::RuntimeOperationFailure;
    match error.code() {
        "UNAVAILABLE" => RuntimeOperationFailure::Unavailable,
        "INVALID_REQUEST" if error.message().starts_with("unknown method:") => RuntimeOperationFailure::Unsupported,
        "INVALID_REQUEST" => RuntimeOperationFailure::TargetRejected,
        _ => RuntimeOperationFailure::Unknown,
    }
}

fn observation_targets(observations: &crate::gateway::observation::Observations, epoch: u64, key: Option<&str>) -> Vec<(sessions_module::state::SessionIdentity, u64)> {
    observations.entries.lock().expect("observation registry lock poisoned").values()
        .filter(|entry| !entry.paused && entry.source_epoch == Some(epoch) && key.is_none_or(|key| entry.identity.session_key == key))
        .map(|entry| (entry.identity.clone(), entry.generation)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::protocol::{ChatEvent, RunId};
    use serde_json::json;
    use sessions_module::state::{RunPhase, SessionChange};
    use tokio::sync::mpsc;

    fn session_key() -> SessionKey {
        SessionKey::try_new("agent:main:session-1").unwrap()
    }

    fn run(value: &str) -> RunId {
        RunId::try_new(value).unwrap()
    }

    fn envelope(run_id: &str, state: ChatState) -> SessionEventEnvelope {
        let session_key = session_key();
        let run_id = run(run_id);
        SessionEventEnvelope {
            gateway_sequence: Some(1),
            kind: SessionEventKind::Chat,
            session_key: session_key.clone(),
            run_id: Some(run_id.clone()),
            message_id: None,
            embedded_message_id: None,
            chat: Some(ChatEvent {
                run_id,
                session_key,
                sequence: 1,
                state,
                status_phase: None,
                status_retry: None,
                delta_text: Some("delta".to_owned()),
                replace: false,
                message_text: None,
                message_thinking: None,
                final_message: None,
                yielded: false,
                message_absent: true,
                error_kind: None,
                error_message: None,
                stop_reason: None,
                error_detail: None,
            }),
            activity: None,
            approval: None,
            changed: None,
        }
    }

    #[test]
    fn route_key_uses_session_key_not_run_id() {
        let route_keys = Mutex::new(HashMap::from([(
            session_key(),
            "renderer-route:session".to_owned(),
        )]));

        assert_eq!(
            route_key_for(&envelope("native-run", ChatState::Delta), &route_keys).as_deref(),
            Some("renderer-route:session")
        );
    }

    #[test]
    fn terminal_chat_clears_session_route() {
        let route_keys = Mutex::new(HashMap::from([(
            session_key(),
            "renderer-route:session".to_owned(),
        )]));

        let terminal = envelope("native-run", ChatState::Final);
        assert!(should_clear_route_key(&terminal));
        clear_route_key(&terminal, &route_keys);

        assert_eq!(
            route_key_for(&envelope("another-run", ChatState::Delta), &route_keys),
            None
        );
    }

    #[tokio::test]
    async fn messages_subscribe_events_emit_route_bound_delta_and_terminal() {
        let (_events_tx, mut events_rx) = mpsc::channel(8);
        let (session_tx, mut session_rx) = mpsc::channel(8);
        let ingest = Arc::new(SessionEventIngest::new(_events_tx, session_tx));
        let (gateway_tx, gateway_rx) = mpsc::channel(8);
        ingest.register_route(session_key(), "renderer-route:session".to_owned());
        ingest.forward(gateway_rx);

        gateway_tx
            .send(GatewayEvent {
                name: "chat".to_owned(),
                payload: Some(json!({
                    "sessionKey": "agent:main:session-1",
                    "runId": "native-run",
                    "seq": 1,
                    "state": "delta",
                    "deltaText": "hello"
                })),
                sequence: Some(1),
                state_version: None,
            })
            .await
            .unwrap();
        gateway_tx
            .send(GatewayEvent {
                name: "chat".to_owned(),
                payload: Some(json!({
                    "sessionKey": "agent:main:session-1",
                    "runId": "native-run",
                    "seq": 2,
                    "state": "final"
                })),
                sequence: Some(2),
                state_version: None,
            })
            .await
            .unwrap();
        drop(gateway_tx);

        let (_, delta) = session_rx
            .recv()
            .await
            .expect("delta session event")
            .into_parts();
        assert_eq!(delta.binding.route_key(), Some("renderer-route:session"));
        assert_eq!(delta.run_id.as_deref(), Some("native-run"));
        assert!(matches!(
            delta.changes.as_slice(),
            [SessionChange::MessageDelta { text, .. }] if text == "hello"
        ));

        let (_, terminal) = session_rx
            .recv()
            .await
            .expect("terminal session event")
            .into_parts();
        assert_eq!(terminal.binding.route_key(), Some("renderer-route:session"));
        assert!(matches!(
            terminal.changes.as_slice(),
            [SessionChange::RunPhaseChanged {
                phase: RunPhase::Completed,
                ..
            }]
        ));
        assert_eq!(
            route_key_for(
                &envelope("native-run", ChatState::Delta),
                &ingest.route_keys
            ),
            None
        );

        assert!(events_rx.recv().await.is_some());
        assert!(events_rx.recv().await.is_some());
    }
}
