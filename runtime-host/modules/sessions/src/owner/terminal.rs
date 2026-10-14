use std::sync::{Arc, Mutex, atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering}};

use foundation::execution::OwnedTask;
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};

use super::actor::{SessionLane, SessionShared};
use crate::{
    command::SessionCommand,
    terminal_hook::SessionTerminalCloseError,
};

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
                if let Some(snapshot) = pending {
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
                    if sender.send_command(SessionCommand::TerminalDelivered { identity, run_id, reply }).await.is_err()
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
        self.stop_observation_waiters().await;
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
            let result = if first { task.cancel_and_join().await } else { task.join().await };
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
            for terminal in terminals { state.run_delivery_contexts.remove(&terminal.native_run_id); }
            return true;
        }
        if terminals.is_empty() { return true; }
        if state.pending_terminals.len() + terminals.len() > crate::state::MAX_CHANGE_COUNT { return false; }
        let Some(permit) = &self.terminal_permit else { return false; };
        if state.terminal_permit.as_ref().is_some_and(|current| !Arc::ptr_eq(current, permit)) { return false; }
        state.pending_terminals.extend_from_slice(terminals);
        state.terminal_permit = Some(Arc::clone(permit));
        true
    }

    pub(super) async fn terminal_delivered(
        &mut self,
        shared: &SessionShared,
        identity: crate::state::SessionIdentity,
        run_id: String,
    ) -> bool {
        let Some(state) = &mut self.state else { return false; };
        if state.identity() != &identity { return false; }
        let Some(index) = state.pending_terminals.iter().position(|snapshot| snapshot.native_run_id == run_id) else { return false; };
        state.pending_terminals.remove(index);
        state.run_delivery_contexts.remove(&run_id);
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
