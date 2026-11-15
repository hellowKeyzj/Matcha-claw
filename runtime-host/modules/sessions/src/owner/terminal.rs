use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering}},
};

use foundation::execution::OwnedTask;
use futures_util::{StreamExt, stream::FuturesUnordered};
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

// Bound retained deliveries independently of the public event batch size.
const TERMINAL_DELIVERY_CAPACITY: usize = 256;

pub(crate) type TerminalPermit = Arc<Mutex<Option<OwnedSemaphorePermit>>>;

enum TerminalDeliveryOutcome {
    Delivered,
    Deferred,
    Failed,
}

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
        self.completion_custody.take();
        self.delivery.producers.fetch_sub(1, Ordering::AcqRel);
        self.delivery.notify();
    }
}

impl TerminalDelivery {
    pub(super) fn new() -> Self {
        Self {
            gate: Arc::new(Semaphore::new(TERMINAL_DELIVERY_CAPACITY)),
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

    pub(super) fn retry_pending(&self) {
        self.retry.fetch_add(1, Ordering::AcqRel);
        self.retry_changed.notify_waiters();
        self.notify();
    }

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

    pub(crate) async fn terminal_permit(&self, count: usize) -> TerminalPermit {
        loop {
            let changed = self.terminal_delivery.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if let Some(permit) = self.try_terminal_permit(count) { return permit; }
            changed.await;
        }
    }

    pub(super) fn try_terminal_permit(&self, count: usize) -> Option<TerminalPermit> {
        Arc::clone(&self.terminal_delivery.gate).try_acquire_many_owned(count as u32).ok()
            .map(|permit| Arc::new(Mutex::new(Some(permit))))
    }

    async fn read_terminal_run(
        &self,
        command: crate::execution::SessionRunReadCommand,
        cancellation: &tokio_util::sync::CancellationToken,
    ) -> Result<crate::execution::SessionRunRecord, crate::state::RuntimeIssue> {
        use crate::execution::SessionRunReadOutcome;
        use crate::state::RuntimeIssue;
        let outcome = tokio::select! {
            outcome = tokio::time::timeout(std::time::Duration::from_secs(30), self.read_run(command, true)) =>
                outcome.map_err(|_| RuntimeIssue::Timeout)?,
            _ = cancellation.cancelled() => return Err(RuntimeIssue::Unavailable),
        };
        match outcome {
            SessionRunReadOutcome::Found(record) if crate::state::terminal_run_phase(record.phase)
                || record.phase == crate::state::RunPhase::Yielded => Ok(record),
            SessionRunReadOutcome::Unavailable | SessionRunReadOutcome::Unsupported => Err(RuntimeIssue::Unavailable),
            SessionRunReadOutcome::Rejected => Err(RuntimeIssue::Rejected),
            _ => Err(RuntimeIssue::Unknown),
        }
    }

    async fn deliver_terminal(
        &self,
        pending: crate::state::PendingTerminal,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> TerminalDeliveryOutcome {
        let crate::state::PendingTerminal { mut snapshot, bodies, permit, read: terminal_read, .. } = pending;
        let openclaw = snapshot.identity.provider() == crate::state::SessionProvider::OpenClaw;
        let collect_request = openclaw && (snapshot.native_request_id.is_some() || snapshot.delivery_context.is_some()
            || snapshot.execution_context.is_some() || self.observed_run(&snapshot.identity, &snapshot.native_run_id));
        if collect_request && terminal_read != crate::state::TerminalRead::Complete {
            let endpoint_session_id = match &bodies {
                TerminalBodies::Items { endpoint_session_id, .. } => endpoint_session_id.clone(),
                TerminalBodies::Complete(_) => None,
            };
            let selector = snapshot.native_request_id.clone().map(crate::execution::SessionRunSelector::RequestId)
                .unwrap_or_else(|| crate::execution::SessionRunSelector::RunId(snapshot.native_run_id.clone()));
            let Ok(read) = crate::execution::SessionRunReadCommand::try_new(
                snapshot.identity.clone(), endpoint_session_id, selector,
            ) else { return TerminalDeliveryOutcome::Failed; };
            let mut result = self.read_terminal_run(read.clone(), &cancellation).await;
            if cancellation.is_cancelled() { return TerminalDeliveryOutcome::Failed; }
            if result.is_err() && terminal_read == crate::state::TerminalRead::Pending {
                let (reply, received) = tokio::sync::oneshot::channel();
                let recovery = SessionCommand::RecoverTerminalRead {
                    identity: snapshot.identity.clone(), run_id: snapshot.native_run_id.clone(),
                    permit: Arc::clone(&permit), reply,
                };
                let sender = self.completion_handle.get().expect("session completion handle");
                let recovered = tokio::select! {
                    result = tokio::time::timeout(std::time::Duration::from_secs(30), async {
                        sender.send_command(recovery).await.map_err(|_| ())?;
                        received.await.map_err(|_| ())?.map_err(|_| ())
                    }) => matches!(result, Ok(Ok(()))),
                    _ = cancellation.cancelled() => return TerminalDeliveryOutcome::Failed,
                };
                if recovered { result = self.read_terminal_run(read, &cancellation).await; }
            }
            if cancellation.is_cancelled() { return TerminalDeliveryOutcome::Failed; }
            if result.as_ref().is_ok_and(|record| record.phase == crate::state::RunPhase::Yielded) {
                let binding = crate::state::SessionEventBinding::new(snapshot.identity.clone(), None)
                    .expect("validated terminal identity");
                let (reply, received) = tokio::sync::oneshot::channel();
                let refresh = SessionCommand::Ingest {
                    identity: snapshot.identity.clone(),
                    event: crate::command::SessionEvent {
                        binding, run_id: None, cursor: None, history_refresh: false, changes: Vec::new(), work_pending: Some(true),
                    },
                    permit: None, reply,
                };
                let sender = self.completion_handle.get().expect("session completion handle");
                let refreshed = tokio::select! {
                    result = async {
                        sender.send_command(refresh).await.is_ok()
                            && matches!(received.await, Ok(Ok(crate::command::SessionIngestOutcome::Applied(_)
                                | crate::command::SessionIngestOutcome::Consumed { .. })))
                    } => result,
                    _ = cancellation.cancelled() => false,
                };
                return if refreshed { TerminalDeliveryOutcome::Deferred } else { TerminalDeliveryOutcome::Failed };
            }
            let (reply, received) = tokio::sync::oneshot::channel();
            let completion = SessionCommand::TerminalReadCompleted {
                identity: snapshot.identity.clone(), run_id: snapshot.native_run_id.clone(),
                permit: Arc::clone(&permit), result, reply,
            };
            let sender = self.completion_handle.get().expect("session completion handle");
            let committed = tokio::select! {
                result = async {
                    sender.send_command(completion).await.is_ok() && received.await == Ok(true)
                } => result,
                _ = cancellation.cancelled() => false,
            };
            if !committed {
                return if self.snapshot.load().states.get(&crate::command::session_identity_lane_key(&snapshot.identity))
                    .is_some_and(|state| state.work_pending()) { TerminalDeliveryOutcome::Deferred }
                else { TerminalDeliveryOutcome::Failed };
            }
            let current = self.snapshot.load();
            let Some(pending) = current.states.get(&crate::command::session_identity_lane_key(&snapshot.identity))
                .and_then(|state| state.pending_terminals.first())
                .filter(|pending| pending.snapshot.native_run_id == snapshot.native_run_id && Arc::ptr_eq(&pending.permit, &permit))
            else { return TerminalDeliveryOutcome::Failed; };
            snapshot = pending.snapshot.clone();
        } else if !collect_request {
            let collected = tokio::select! {
                texts = self.complete_terminal_texts(&snapshot.identity, bodies) => texts,
                _ = cancellation.cancelled() => return TerminalDeliveryOutcome::Failed,
            };
            let use_native_texts = collected.as_ref().is_some_and(Vec::is_empty);
            snapshot.assistant_texts = Ok(collected.unwrap_or_default());
            let read = crate::execution::SessionRunReadCommand::try_new(
                snapshot.identity.clone(), None,
                crate::execution::SessionRunSelector::RunId(snapshot.native_run_id.clone()),
            );
            let needs_execution_facts = snapshot.execution_context.is_some()
                || self.snapshot.load().states.get(&crate::command::session_identity_lane_key(&snapshot.identity))
                    .is_some_and(|state| state.run_execution_contexts.contains_key(&snapshot.native_run_id));
            if !openclaw && (needs_execution_facts || use_native_texts) && let Ok(read) = read {
                let outcome = tokio::select! {
                    outcome = self.handle_read_run(read) => Some(outcome),
                    _ = cancellation.cancelled() => return TerminalDeliveryOutcome::Failed,
                };
                if let Some(crate::execution::SessionRunReadOutcome::Found(record)) = outcome
                    && record.phase == snapshot.phase && crate::state::terminal_run_phase(record.phase)
                    && snapshot.native_request_id.as_ref().is_none_or(|expected| record.request_id.as_ref() == Some(expected))
                    && snapshot.native_message_id.as_ref().is_none_or(|expected| expected == &record.message_id)
                {
                    if use_native_texts { snapshot.assistant_texts = Ok(record.assistant_texts); }
                    let execution = self.snapshot.load().states.get(&crate::command::session_identity_lane_key(&snapshot.identity))
                        .and_then(|state| state.run_execution_contexts.get(&snapshot.native_run_id)
                            .or_else(|| record.request_id.as_ref().and_then(|id| state.run_execution_contexts.get(id))))
                        .cloned();
                    if let Some((request_id, context)) = execution
                        && record.request_id.as_deref() == Some(request_id.as_str())
                        && snapshot.execution_context.as_ref().is_none_or(|expected| expected == &context)
                    {
                        snapshot.execution_context = Some(context);
                        snapshot.native_request_id = Some(request_id);
                        snapshot.native_message_id = Some(record.message_id);
                        snapshot.measurement = record.measurement;
                        if snapshot.delivery_context.is_none() {
                            snapshot.delivery_context = self.snapshot.load().states.get(&crate::command::session_identity_lane_key(&snapshot.identity))
                                .and_then(|state| snapshot.native_request_id.as_ref()
                                    .and_then(|id| state.run_delivery_contexts.get(id))).cloned();
                        }
                    }
                }
            }
        }
        if openclaw {
            let current = self.snapshot.load();
            let Some(pending) = current.states.get(&crate::command::session_identity_lane_key(&snapshot.identity))
                .filter(|state| !state.work_pending() && !self.terminal_sync_pending(state.identity()) && self.terminal_read_ready(state))
                .and_then(|state| state.pending_terminals.iter().find(|pending|
                    pending.snapshot.native_run_id == snapshot.native_run_id && Arc::ptr_eq(&pending.permit, &permit)))
            else { return TerminalDeliveryOutcome::Deferred; };
            snapshot.delivery_context = pending.snapshot.delivery_context.clone();
            snapshot.execution_context = pending.snapshot.execution_context.clone();
        }
        if !crate::state::terminal_run_phase(snapshot.phase) { return TerminalDeliveryOutcome::Failed; }
        let request_id = snapshot.native_request_id.clone();
        let identity = snapshot.identity.clone();
        let run_id = snapshot.native_run_id.clone();
        let Some(hook) = &self.terminal_hook else { return TerminalDeliveryOutcome::Failed; };
        let delivered = tokio::select! {
            result = hook.run_terminal_async(snapshot, cancellation.clone()) => result.is_ok(),
            _ = cancellation.cancelled() => false,
        };
        if !delivered { return TerminalDeliveryOutcome::Failed; }
        let (reply, received) = tokio::sync::oneshot::channel();
        let sender = self.completion_handle.get().expect("session completion handle");
        tokio::select! {
            result = async {
                sender.send_command(SessionCommand::TerminalDelivered { identity, run_id, request_id, permit, reply }).await.is_ok()
                    && received.await == Ok(true)
            } => if result { TerminalDeliveryOutcome::Delivered } else { TerminalDeliveryOutcome::Failed },
            _ = cancellation.cancelled() => TerminalDeliveryOutcome::Failed,
        }
    }

    fn terminal_task(&self) -> OwnedTask<Result<(), SessionTerminalCloseError>> {
        let shared = self.clone();
        let (task, _) = OwnedTask::spawn(move |cancellation| async move {
            let mut work = FuturesUnordered::new();
            let mut active = HashSet::new();
            let mut failed = HashMap::<(String, String), TerminalPermit>::new();
            let mut retry = shared.terminal_delivery.retry.load(Ordering::Acquire);
            loop {
                let changed = shared.terminal_delivery.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                let current_retry = shared.terminal_delivery.retry.load(Ordering::Acquire);
                if retry != current_retry { failed.clear(); retry = current_retry; }
                let snapshot = shared.snapshot.load();
                failed.retain(|(key, run_id), permit| snapshot.states.get(key)
                    .is_some_and(|state| state.pending_terminals.iter().any(|pending|
                        &pending.snapshot.native_run_id == run_id && Arc::ptr_eq(&pending.permit, permit))));
                let candidates = snapshot.states.iter().filter_map(|(key, state)| {
                    let pending = state.pending_terminals.first()?;
                    (!active.contains(key)
                        && !failed.contains_key(&(key.clone(), pending.snapshot.native_run_id.clone()))
                        && (state.identity().provider() != crate::state::SessionProvider::OpenClaw
                            || (!state.work_pending() && !shared.terminal_sync_pending(state.identity())
                                && shared.terminal_read_ready(state)))
                        && pending.completion_custody.strong_count() <= 1)
                        .then(|| (key.clone(), pending.snapshot.native_run_id.clone()))
                }).collect::<Vec<_>>();
                drop(snapshot);
                for (key, run_id) in candidates.into_iter().take(TERMINAL_DELIVERY_CAPACITY - work.len()) {
                    let pending = shared.snapshot.load().states.get(&key)
                        .and_then(|state| state.pending_terminals.first())
                        .filter(|pending| pending.snapshot.native_run_id == run_id && pending.completion_custody.strong_count() <= 1)
                        .cloned();
                    let Some(pending) = pending else { continue; };
                    let shared = shared.clone();
                    let cancellation = cancellation.child_token();
                    active.insert(key.clone());
                    let permit = Arc::clone(&pending.permit);
                    work.push(async move {
                        let delivered = shared.deliver_terminal(pending, cancellation).await;
                        (key, run_id, permit, delivered)
                    });
                }
                let pending = shared.snapshot.load().states.values().any(|state| !state.pending_terminals.is_empty());
                let producers = shared.terminal_delivery.producers.load(Ordering::Acquire);
                if work.is_empty() && shared.terminal_delivery.stopping.load(Ordering::Acquire) {
                    if !failed.is_empty() || shared.terminal_delivery.blocked.load(Ordering::Acquire) != 0 {
                        return Err(SessionTerminalCloseError::Unsettled);
                    }
                    if producers == 0 {
                        return if pending { Err(SessionTerminalCloseError::Unsettled) } else { Ok(()) };
                    }
                }
                tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => {
                        drop(work);
                        let producers = shared.terminal_delivery.producers.load(Ordering::Acquire);
                        let pending = shared.snapshot.load().states.values().any(|state| !state.pending_terminals.is_empty());
                        return if !pending && producers == 0 { Ok(()) } else { Err(SessionTerminalCloseError::Unsettled) };
                    },
                    Some((key, run_id, permit, delivered)) = work.next(), if !work.is_empty() => {
                        active.remove(&key);
                        if matches!(delivered, TerminalDeliveryOutcome::Failed) { failed.insert((key, run_id), permit); }
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
    pub(super) fn admit_terminals<'a>(
        &mut self,
        shared: &SessionShared,
        identity: &crate::state::SessionIdentity,
        run_ids: impl Iterator<Item = &'a str>,
        permit: Option<TerminalPermit>,
    ) -> Result<(), usize> {
        let needed = if shared.terminal_hook.is_some() {
            self.state.as_ref().filter(|state| state.identity() == identity && state.is_team_source())
                .map_or(0, |state| run_ids.filter(|run_id|
                    !state.has_terminal_run(run_id)
                        && !state.pending_terminals.iter().any(|pending| pending.snapshot.native_run_id == *run_id)
                        && (state.identity().provider() != crate::state::SessionProvider::OpenClaw || state.pending_terminals.is_empty())
                ).collect::<HashSet<_>>().len())
        } else { 0 };
        if needed == 0 { return Ok(()); }
        self.terminal_permit = permit.or_else(|| shared.try_terminal_permit(needed));
        if self.terminal_permit.is_some() { Ok(()) } else { Err(needed) }
    }

    pub(super) async fn collect_settled_request(
        &mut self,
        shared: &SessionShared,
        identity: &crate::state::SessionIdentity,
        permit: Option<TerminalPermit>,
    ) -> Result<bool, usize> {
        let Some(mut state) = self.state.clone().filter(|state| state.identity() == identity
            && state.is_team_source() && identity.provider() == crate::state::SessionProvider::OpenClaw)
            else { return Ok(false); };
        let Some(run_id) = shared.settlement_request_id(&state) else {
            return Ok(!state.pending_terminals.is_empty() && !shared.session_execution_pending(identity));
        };
        let delivery_context = state.run_delivery_contexts.get(&run_id).cloned();
        let execution_context = state.run_execution_contexts.get(&run_id).map(|(_, context)| context.clone());
        if let Some(pending) = state.pending_terminals.first_mut() {
            if pending.snapshot.native_request_id.as_ref().is_some_and(|id| id != &run_id) { return Ok(false); }
            pending.snapshot.native_request_id = Some(run_id);
            if pending.snapshot.delivery_context.is_none() { pending.snapshot.delivery_context = delivery_context; }
            if pending.snapshot.execution_context.is_none() { pending.snapshot.execution_context = execution_context; }
            self.state = Some(state.clone());
            shared.store_snapshot_state(state).await;
            return Ok(true);
        }
        let phase = match state.runtime() {
            SessionFact::Complete(runtime) | SessionFact::Incomplete { facts: runtime, .. } => runtime.phase,
            _ => return Ok(false),
        };
        self.admit_terminals(shared, identity, std::iter::once(run_id.as_str()), permit)?;
        let snapshot = crate::terminal_hook::SessionRunTerminalSnapshot {
            identity: identity.clone(), source_binding: state.source_binding().clone(), native_run_id: run_id.clone(),
            delivery_context,
            execution_context,
            native_request_id: Some(run_id.clone()),
            native_message_id: None, measurement: crate::execution::SessionRunMeasurement::Unavailable,
            phase, assistant_texts: Ok(Vec::new()),
        };
        let retained = self.retain_terminals(shared, &mut state, &[snapshot]);
        if retained {
            self.state = Some(state.clone());
            shared.store_snapshot_state(state).await;
        }
        self.terminal_permit.take();
        Ok(retained)
    }

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
        if state.pending_terminals.len() + terminals.len() > TERMINAL_DELIVERY_CAPACITY { return false; }
        let Some(permit) = &self.terminal_permit else { return false; };
        let mut permit = permit.lock().expect("session terminal permit lock");
        let Some(permit) = permit.as_mut().filter(|permit| permit.num_permits() >= terminals.len()) else { return false; };
        for terminal in terminals {
            let bodies = TerminalBodies::capture(state.items(), state.native_session_id(), &terminal.native_run_id);
            let permit = Arc::new(Mutex::new(permit.split(1)));
            state.pending_terminals.push(crate::state::PendingTerminal {
                snapshot: terminal.clone(), bodies, read: crate::state::TerminalRead::Pending,
                permit, completion_custody: Arc::downgrade(&self.completion_custody),
            });
        }
        true
    }

    pub(super) async fn complete_terminal_read(
        &mut self,
        shared: &SessionShared,
        identity: &crate::state::SessionIdentity,
        run_id: &str,
        permit: &TerminalPermit,
        result: Result<crate::execution::SessionRunRecord, crate::state::RuntimeIssue>,
    ) -> bool {
        let Some(mut next) = self.state.clone().filter(|state| state.identity() == identity && !state.work_pending())
        else { return false; };
        let Some(pending) = next.pending_terminals.first_mut().filter(|pending|
            pending.snapshot.native_run_id == run_id && Arc::ptr_eq(&pending.permit, permit)
                && pending.read != crate::state::TerminalRead::Complete)
        else { return false; };
        let issue = result.as_ref().err().copied();
        match result {
            Ok(record) => {
                pending.snapshot.phase = record.phase;
                pending.snapshot.native_request_id = record.request_id;
                pending.snapshot.native_message_id = Some(record.message_id);
                pending.snapshot.measurement = record.measurement;
                pending.snapshot.assistant_texts = Ok(record.assistant_texts);
            }
            Err(_) => pending.snapshot.assistant_texts = Err(()),
        }
        pending.read = crate::state::TerminalRead::Complete;
        let delta = if let Some(issue) = issue {
            let reason = if matches!(issue, crate::state::RuntimeIssue::Unavailable | crate::state::RuntimeIssue::Timeout) {
                crate::state::RecoveryReason::NativeUnavailable
            } else { crate::state::RecoveryReason::NativeUnknown };
            let mut changes = vec![crate::state::SessionChange::RecoveryRequired { reason }];
            if let crate::state::SessionFact::Complete(runtime) | crate::state::SessionFact::Incomplete { facts: runtime, .. } = next.runtime() {
                let mut runtime = runtime.clone();
                runtime.issue = Some(issue);
                changes.push(crate::state::SessionChange::RuntimeChanged { runtime });
            }
            let Some(cursor) = next.cursor().checked_add(1) else { return false; };
            let crate::state::SessionApplyResult::Applied(delta) = next.apply(None, cursor, changes) else { return false; };
            Some(delta)
        } else { None };
        self.state = Some(next.clone());
        shared.store_snapshot_state(next).await;
        if let Some(delta) = delta { shared.emit_session_delta(&delta, Vec::new()); }
        shared.terminal_delivery.notify();
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
        let request_pending = state.request_pending();
        let pending = state.pending_terminals.remove(index);
        let delta = if state.request_pending() != request_pending {
            match state.cursor().checked_add(1).map(|cursor| state.apply(
                None, cursor, vec![crate::state::SessionChange::RequestPendingChanged { pending: state.work_pending() }],
            )) {
                Some(crate::state::SessionApplyResult::Applied(delta)) => Some(delta),
                _ => { state.pending_terminals.insert(index, pending); return false; }
            }
        } else { None };
        state.run_delivery_contexts.remove(&run_id);
        let execution = state.run_execution_contexts.remove(&run_id);
        if let Some(request_id) = request_id.or_else(|| execution.map(|(request, _)| request)) {
            state.run_delivery_contexts.remove(&request_id);
            state.run_execution_contexts.remove(&request_id);
        }
        shared.store_snapshot_state(state.clone()).await;
        if let Some(delta) = delta { shared.emit_session_delta(&delta, Vec::new()); }
        shared.receive_terminal_delivery(state, &pending.snapshot);
        pending.permit.lock().expect("session terminal permit lock").take();
        shared.terminal_delivery.notify();
        self.close_if_idle(shared, &identity);
        true
    }
}
