use std::sync::{Arc, Mutex, atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering}};

use foundation::execution::OwnedTask;
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};

use super::actor::{SessionLane, SessionShared};
use crate::{
    command::SessionCommand,
    terminal_hook::SessionTerminalCloseError,
    state::{ItemStatus, OmissionReason, SessionContent, SessionFact, SessionItem, TerminalBodies},
    timeline::{ContentCommand, ContentOutcome},
};

impl TerminalBodies {
    pub(crate) fn capture(items: &SessionFact<Vec<SessionItem>>, endpoint_session_id: Option<&str>, run_id: &str) -> Self {
        let items = match items {
            SessionFact::Complete(items) | SessionFact::Incomplete { facts: items, .. } => items.as_slice(),
            SessionFact::Unknown | SessionFact::Unavailable => &[],
        };
        Self::Items {
            endpoint_session_id: endpoint_session_id.map(str::to_owned),
            items: items.iter().filter(|item| matches!(item,
                SessionItem::AssistantTurn { run_id: Some(owner), status: ItemStatus::Final, .. } if owner == run_id
            )).cloned().collect(),
        }
    }

    pub(crate) fn texts(&self) -> Vec<String> {
        match self {
            Self::Complete(texts) => texts.clone(),
            Self::Items { items, .. } => items.iter().filter_map(|item| match item {
                SessionItem::AssistantTurn { text, .. } => Some(text.clone()),
                _ => None,
            }).collect(),
        }
    }
}

pub(crate) type TerminalPermit = Arc<Mutex<Option<OwnedSemaphorePermit>>>;

pub(super) struct TerminalDelivery {
    gate: Arc<Semaphore>,
    stopping: AtomicBool,
    admission: Mutex<()>,
    stopped: tokio_util::sync::CancellationToken,
    join_failed: AtomicBool,
    closed: AtomicBool,
    producers: AtomicUsize,
    blocked: AtomicUsize,
    retry: AtomicU64,
    retry_changed: Notify,
    changed: Notify,
    pub(super) task: tokio::sync::Mutex<Option<OwnedTask<Result<(), SessionTerminalCloseError>>>>,
    close: tokio::sync::Mutex<()>,
}

pub(crate) struct Producer {
    delivery: Arc<TerminalDelivery>,
    completion_custody: Option<Arc<()>>,
    blocked: bool,
}

impl Producer {
    pub(crate) fn inherited(&self) -> Self {
        self.delivery.producers.fetch_add(1, Ordering::AcqRel);
        Self {
            delivery: Arc::clone(&self.delivery),
            completion_custody: self.completion_custody.clone(),
            blocked: false,
        }
    }

    pub(crate) async fn stopped(&self) { self.delivery.stopped.cancelled().await; }

    pub(crate) fn retry_epoch(&self) -> u64 { self.delivery.retry.load(Ordering::Acquire) }

    pub(crate) async fn wait_retry(&mut self, epoch: u64) {
        self.blocked = true;
        self.delivery.blocked.fetch_add(1, Ordering::AcqRel);
        self.delivery.notify();
        loop {
            let changed = self.delivery.retry_changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.retry_epoch() != epoch { break; }
            changed.await;
        }
        self.delivery.blocked.fetch_sub(1, Ordering::AcqRel);
        self.blocked = false;
    }
}

impl Drop for Producer {
    fn drop(&mut self) {
        if std::thread::panicking() { self.delivery.join_failed.store(true, Ordering::Release); }
        if self.blocked { self.delivery.blocked.fetch_sub(1, Ordering::AcqRel); }
        self.delivery.producers.fetch_sub(1, Ordering::AcqRel);
        self.delivery.notify();
    }
}

impl TerminalDelivery {
    pub(super) fn new() -> Self {
        Self {
            gate: Arc::new(Semaphore::new(1)),
            stopping: AtomicBool::new(false),
            admission: Mutex::new(()),
            stopped: tokio_util::sync::CancellationToken::new(),
            join_failed: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            producers: AtomicUsize::new(0),
            blocked: AtomicUsize::new(0),
            retry: AtomicU64::new(0),
            retry_changed: Notify::new(),
            changed: Notify::new(),
            task: tokio::sync::Mutex::new(None),
            close: tokio::sync::Mutex::new(()),
        }
    }

    pub(super) fn producer(self: &Arc<Self>) -> Result<Producer, ()> {
        let _admission = self.admission.lock().expect("session producer admission lock");
        if self.stopping.load(Ordering::Acquire) { return Err(()); }
        self.producers.fetch_add(1, Ordering::AcqRel);
        Ok(Producer { delivery: Arc::clone(self), completion_custody: None, blocked: false })
    }

    pub(crate) fn is_stopping(&self) -> bool { self.stopping.load(Ordering::Acquire) }

    pub(super) fn notify(&self) { self.changed.notify_waiters(); self.changed.notify_one(); }
}

impl SessionShared {
    async fn complete_terminal_texts(&self, identity: &crate::state::SessionIdentity, bodies: TerminalBodies) -> Option<Vec<String>> {
        let (endpoint_session_id, items) = match bodies {
            TerminalBodies::Complete(texts) => return Some(texts),
            TerminalBodies::Items { endpoint_session_id, items } => (endpoint_session_id, items),
        };
        let mut texts = Vec::new();
        // Keep the existing maximum run text allocation; LargeText is not limited to one preview.
        let mut remaining = crate::state::MAX_ITEMS * crate::state::MAX_TEXT_BYTES;
        for item in items {
            let SessionItem::AssistantTurn { text, segments, .. } = item else { return None };
            if segments.iter().any(|segment| matches!(segment, SessionContent::Omitted { reason: OmissionReason::Unknown })) {
                return None;
            }
            if !segments.iter().any(|segment| matches!(segment, SessionContent::LargeText { .. })) {
                remaining = remaining.checked_sub(text.len())?;
                texts.push(text);
                continue;
            }
            for segment in &segments {
                let bytes = match segment {
                    SessionContent::Text { text } => text.len(),
                    SessionContent::LargeText { total_bytes, .. } => usize::try_from(*total_bytes).ok()?,
                    _ => 0,
                };
                remaining = remaining.checked_sub(bytes)?;
            }
            let mut observed = String::new();
            let mut complete = String::new();
            for segment in segments {
                match segment {
                    SessionContent::Text { text } => { observed.push_str(&text); complete.push_str(&text); }
                    SessionContent::LargeText { text, content_ref, total_bytes, loaded_bytes } => {
                        if text.len() as u64 != loaded_bytes || loaded_bytes > total_bytes { return None; }
                        observed.push_str(&text);
                        let mut full = text;
                        while (full.len() as u64) < total_bytes {
                            let offset = full.len() as u64;
                            let command = ContentCommand::new(
                                identity.clone(), endpoint_session_id.clone(), content_ref.clone(), offset, 64 * 1024,
                            )?;
                            let ContentOutcome::Complete(chunk) = self.handle_content(command).await else { return None };
                            if chunk.content_ref != content_ref || chunk.offset != offset || chunk.total_bytes != total_bytes
                                || chunk.text.is_empty() || offset.checked_add(chunk.text.len() as u64)? != chunk.next_offset
                                || chunk.next_offset > total_bytes || chunk.complete != (chunk.next_offset == total_bytes)
                            { return None; }
                            full.push_str(&chunk.text);
                        }
                        complete.push_str(&full);
                    }
                    _ => {},
                }
            }
            if observed != text { return None; }
            texts.push(complete);
        }
        Some(texts)
    }

    pub(crate) fn producer(&self) -> Result<Producer, ()> {
        self.terminal_delivery.producer()
    }

    pub(crate) async fn terminal_permit(&self) -> TerminalPermit {
        Arc::new(Mutex::new(Some(Arc::clone(&self.terminal_delivery.gate)
            .acquire_owned().await.expect("session terminal gate closed"))))
    }

    fn terminal_task(&self) -> OwnedTask<Result<(), SessionTerminalCloseError>> {
        let shared = self.clone();
        let (task, _) = OwnedTask::spawn(move |cancellation| async move {
            loop {
                let changed = shared.terminal_delivery.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                let pending = shared.snapshot.load().states.values()
                    .find_map(|state| state.pending_terminals.first().cloned());
                if let Some(crate::state::PendingTerminal { mut snapshot, bodies }) = pending {
                    let collected = tokio::select! {
                        texts = shared.complete_terminal_texts(&snapshot.identity, bodies) => texts,
                        _ = cancellation.cancelled() => return Err(SessionTerminalCloseError::Unsettled),
                    };
                    let use_native_texts = collected.as_ref().is_some_and(Vec::is_empty);
                    snapshot.assistant_texts = collected.unwrap_or_default();
                    let read = crate::execution::SessionRunReadCommand::try_new(
                        snapshot.identity.clone(), None,
                        crate::execution::SessionRunSelector::RunId(snapshot.native_run_id.clone()),
                    );
                    let needs_execution_facts = snapshot.execution_context.is_some()
                        || shared.snapshot.load().states.get(&crate::command::session_identity_lane_key(&snapshot.identity))
                            .is_some_and(|state| state.run_execution_contexts.contains_key(&snapshot.native_run_id));
                    if needs_execution_facts && let Ok(read) = read {
                        let outcome = tokio::select! {
                            outcome = shared.handle_read_run(read) => Some(outcome),
                            _ = cancellation.cancelled() => None,
                        };
                        if let Some(crate::execution::SessionRunReadOutcome::Found(record)) = outcome {
                            let execution = shared.snapshot.load().states.get(&crate::command::session_identity_lane_key(&snapshot.identity))
                                .and_then(|state| state.run_execution_contexts.get(&snapshot.native_run_id)
                                    .or_else(|| record.request_id.as_ref().and_then(|id| state.run_execution_contexts.get(id))))
                                .cloned();
                            if let Some((request_id, context)) = execution
                                && record.request_id.as_deref() == Some(request_id.as_str())
                                && snapshot.native_request_id.as_ref().is_none_or(|expected| expected == &request_id)
                                && snapshot.execution_context.as_ref().is_none_or(|expected| expected == &context)
                                && record.phase == snapshot.phase && crate::state::terminal_run_phase(record.phase)
                            {
                                snapshot.execution_context = Some(context);
                                snapshot.native_request_id = Some(request_id);
                                snapshot.native_message_id = Some(record.message_id);
                                snapshot.measurement = record.measurement;
                                if use_native_texts { snapshot.assistant_texts = record.assistant_texts; }
                                if snapshot.delivery_context.is_none() {
                                    snapshot.delivery_context = shared.snapshot.load().states.get(&crate::command::session_identity_lane_key(&snapshot.identity))
                                        .and_then(|state| snapshot.native_request_id.as_ref()
                                            .and_then(|id| state.run_delivery_contexts.get(id))).cloned();
                                }
                            }
                        }
                    }
                    let request_id = snapshot.native_request_id.clone();
                    let identity = snapshot.identity.clone();
                    let run_id = snapshot.native_run_id.clone();
                    let Some(hook) = &shared.terminal_hook else {
                        return Err(SessionTerminalCloseError::Unsettled);
                    };
                    if hook.run_terminal_async(snapshot, cancellation.clone()).await.is_err() {
                        return Err(SessionTerminalCloseError::Unsettled);
                    }
                    let (reply, received) = tokio::sync::oneshot::channel();
                    let sender = shared.completion_handle.get().expect("session completion handle");
                    if sender.send_command(SessionCommand::TerminalDelivered { identity, run_id, request_id, reply }).await.is_err()
                        || received.await != Ok(true)
                    {
                        return Err(SessionTerminalCloseError::Unsettled);
                    }
                    continue;
                }
                if shared.terminal_delivery.blocked.load(Ordering::Acquire) != 0 {
                    return Err(SessionTerminalCloseError::Unsettled);
                }
                if shared.terminal_delivery.stopping.load(Ordering::Acquire)
                    && shared.terminal_delivery.producers.load(Ordering::Acquire) == 0
                {
                    return Ok(());
                }
                tokio::select! {
                    _ = cancellation.cancelled() => {
                        return if shared.terminal_delivery.producers.load(Ordering::Acquire) == 0 {
                            Ok(())
                        } else { Err(SessionTerminalCloseError::Unsettled) };
                    },
                    _ = changed => {},
                }
            }
        });
        task
    }

    pub(crate) fn start_terminal_delivery(&self) {
        *self.terminal_delivery.task.try_lock().expect("session terminal task lock") = Some(self.terminal_task());
    }

    fn trace_terminal_close(&self, stage: &'static str) {
        crate::trace::log_unscoped("sessions.terminal.close", || serde_json::json!({
            "phase": stage,
            "producers": self.terminal_delivery.producers.load(Ordering::Acquire),
            "blocked": self.terminal_delivery.blocked.load(Ordering::Acquire),
            "pendingTerminals": self.snapshot.load().states.values()
                .map(|state| state.pending_terminals.len()).sum::<usize>(),
            "observations": self.observations.lock().expect("session observation lock").len(),
            "readTasks": self.read_tasks.lock().expect("session read tasks lock").len(),
        }));
    }

    pub(crate) async fn close_terminal_delivery(&self) -> Result<(), SessionTerminalCloseError> {
        let _close = self.terminal_delivery.close.lock().await;
        if self.terminal_delivery.closed.load(Ordering::Acquire) { return Ok(()); }
        let first = {
            let _admission = self.terminal_delivery.admission.lock().expect("session producer admission lock");
            !self.terminal_delivery.stopping.swap(true, Ordering::AcqRel)
        };
        self.terminal_delivery.stopped.cancel();
        self.terminal_delivery.retry.fetch_add(1, Ordering::AcqRel);
        self.terminal_delivery.retry_changed.notify_waiters();
        self.terminal_delivery.notify();
        self.trace_terminal_close("stopping");
        self.stop_observation_waiters().await;
        self.trace_terminal_close("waiters_stopped");
        {
            let observations = self.observations.lock().expect("session observation lock");
            for observation in observations.values() { observation.cancel_task(); }
        }
        let tasks = self.read_tasks.lock().expect("session read tasks lock").clone();
        for task in tasks { task.lock().await.cancel(); }
        if self.terminal_delivery.join_failed.load(Ordering::Acquire) { return Err(SessionTerminalCloseError::Join); }
        let mut slot = self.terminal_delivery.task.lock().await;
        if slot.is_none() { *slot = Some(self.terminal_task()); }
        if let Some(task) = slot.as_mut() {
            self.trace_terminal_close(if first { "cancel_join" } else { "join" });
            let result = if first { task.cancel_and_join().await } else { task.join().await };
            self.trace_terminal_close("joined");
            match result {
                Ok(result) => {
                    slot.take();
                    result?;
                },
                Err(_) => {
                    self.terminal_delivery.join_failed.store(true, Ordering::Release);
                    return Err(SessionTerminalCloseError::Join);
                },
            }
        }
        drop(slot);
        if self.terminal_delivery.producers.load(Ordering::Acquire) != 0
            || self.snapshot.load().states.values().any(|state| !state.pending_terminals.is_empty())
        { return Err(SessionTerminalCloseError::Unsettled); }
        self.trace_terminal_close("joining_reads");
        loop {
            let task = self.read_tasks.lock().expect("session read tasks lock").last().cloned();
            let Some(task) = task else { break; };
            if task.lock().await.cancel_and_join().await.is_err() {
                self.terminal_delivery.join_failed.store(true, Ordering::Release);
                return Err(SessionTerminalCloseError::Join);
            }
            self.read_tasks.lock().expect("session read tasks lock").pop();
        }
        if self.terminal_delivery.join_failed.load(Ordering::Acquire) { return Err(SessionTerminalCloseError::Join); }
        self.terminal_delivery.closed.store(true, Ordering::Release);
        Ok(())
    }
}

impl SessionLane {
    pub(super) fn completion_producer(&self, shared: &SessionShared) -> Result<Producer, ()> {
        let mut producer = shared.producer()?;
        producer.completion_custody = Some(Arc::clone(&self.completion_custody));
        Ok(producer)
    }

    pub(super) fn has_pending_completions(&self) -> bool {
        // The lane owns one reference; producers retain the rest through completion delivery.
        Arc::strong_count(&self.completion_custody) != 1
    }

    pub(super) fn retain_terminals(
        &self,
        shared: &SessionShared,
        state: &mut crate::state::SessionState,
        terminals: &[crate::terminal_hook::SessionRunTerminalSnapshot],
    ) -> bool {
        if shared.terminal_hook.is_none() {
            for terminal in terminals {
                state.run_delivery_contexts.remove(&terminal.native_run_id);
                state.run_execution_contexts.remove(&terminal.native_run_id);
            }
            return true;
        }
        if terminals.is_empty() { return true; }
        if state.pending_terminals.len() + terminals.len() > crate::state::MAX_CHANGE_COUNT { return false; }
        let Some(permit) = &self.terminal_permit else { return false; };
        if state.terminal_permit.as_ref().is_some_and(|current| !Arc::ptr_eq(current, permit)) { return false; }
        for terminal in terminals {
            let bodies = TerminalBodies::capture(state.items(), state.native_session_id(), &terminal.native_run_id);
            state.pending_terminals.push(crate::state::PendingTerminal { snapshot: terminal.clone(), bodies });
        }
        state.terminal_permit = Some(Arc::clone(permit));
        true
    }

    pub(super) async fn terminal_delivered(
        &mut self,
        shared: &SessionShared,
        identity: crate::state::SessionIdentity,
        run_id: String,
        request_id: Option<String>,
    ) -> bool {
        let Some(state) = &mut self.state else { return false; };
        if state.identity() != &identity { return false; }
        let Some(index) = state.pending_terminals.iter().position(|pending| pending.snapshot.native_run_id == run_id) else { return false; };
        state.pending_terminals.remove(index);
        state.run_delivery_contexts.remove(&run_id);
        let execution = state.run_execution_contexts.remove(&run_id);
        if let Some(request_id) = request_id.or_else(|| execution.map(|(request, _)| request)) {
            state.run_delivery_contexts.remove(&request_id);
            state.run_execution_contexts.remove(&request_id);
        }
        if state.pending_terminals.is_empty() {
            if let Some(permit) = state.terminal_permit.take() {
                permit.lock().expect("session terminal permit lock").take();
            }
        }
        shared.store_snapshot_state(state.clone()).await;
        shared.terminal_delivery.notify();
        true
    }
}

pub(crate) fn terminal_event(event: &crate::command::SessionEvent) -> bool {
    event.changes.iter().any(|change| matches!(change,
        crate::state::SessionChange::RunPhaseChanged { phase, .. } if crate::state::terminal_run_phase(*phase)))
}
