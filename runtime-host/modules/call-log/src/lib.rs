mod loopback;
mod reader;
mod store;

use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
    thread,
};

use platform::{
    call::{
        CallAppend, CallBegin, CallChanged, CallFuture, CallHistory, CallId, CallLog, CallLogError,
        CallPage, CallQuery, CallRecord, CallRecorder,
    },
    capability::CapabilityDecisionVerifier,
};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore, broadcast, mpsc, oneshot};

const QUEUE_CAPACITY: usize = 256;
const RECOVERY_ATTEMPTS: usize = 3;

#[derive(Clone)]
pub struct CallLogModule {
    inner: Arc<Writer>,
}

struct Writer {
    sender: Mutex<Option<mpsc::Sender<Request>>>,
    task: Mutex<Option<thread::JoinHandle<Result<(), CallLogError>>>>,
    wake: thread::Thread,
    state: Arc<Mutex<WriterState>>,
    terminal_capacity: Arc<Semaphore>,
    reader: reader::Reader,
    changed: broadcast::Sender<CallChanged>,
}

#[derive(Default)]
struct WriterState {
    // One terminal delivery reservation per live audit call, not executable work.
    calls: HashMap<CallId, TerminalSlot>,
    failed: bool,
    fault_changed: Arc<Notify>,
    stopping: bool,
    notified: bool,
}

struct TerminalSlot {
    _permit: OwnedSemaphorePermit,
    delivery: TerminalDelivery,
}

enum TerminalDelivery {
    Reserved,
    Pending(
        CallAppend,
        Option<oneshot::Sender<Result<(), CallLogError>>>,
    ),
    Writing,
}

struct PublishedBegin {
    call_id: Option<CallId>,
    state: Arc<Mutex<WriterState>>,
    wake: thread::Thread,
}

impl PublishedBegin {
    fn into_call_id(mut self) -> CallId {
        self.call_id.take().unwrap()
    }
}

impl Drop for PublishedBegin {
    fn drop(&mut self) {
        if let Some(call_id) = self.call_id.take() {
            abandon(&self.state, &self.wake, &call_id);
        }
    }
}

fn abandon(state: &Mutex<WriterState>, wake: &thread::Thread, call_id: &CallId) {
    if let Ok(mut state) = state.lock() {
        if let Some(TerminalSlot {
            delivery: slot @ TerminalDelivery::Reserved,
            ..
        }) = state.calls.get_mut(call_id)
        {
            *slot = TerminalDelivery::Pending(
                CallAppend {
                    call_id: call_id.clone(),
                    status: Some(platform::call::CallStatus::Unknown),
                    detail: None,
                },
                None,
            );
            state.notified = true;
            wake.unpark();
        }
    }
}

enum Request {
    Begin(
        CallBegin,
        OwnedSemaphorePermit,
        oneshot::Sender<Result<PublishedBegin, CallLogError>>,
    ),
    Append(CallAppend, oneshot::Sender<Result<(), CallLogError>>),
}

impl Drop for Writer {
    fn drop(&mut self) {
        self.terminal_capacity.close();
        if let Ok(mut state) = self.state.lock() {
            state.stopping = true;
        }
        self.wake.unpark();
        if let Ok(task) = self.task.get_mut() {
            if let Some(task) = task.take() {
                let _ = task.join();
            }
        }
    }
}

impl CallLogModule {
    pub fn open(state_dir: &Path) -> Result<Self, CallLogError> {
        let store = store::Store::open(state_dir)?;
        let (sender, receiver) = mpsc::channel(QUEUE_CAPACITY);
        let (changed, _) = broadcast::channel(QUEUE_CAPACITY);
        let events = changed.clone();
        let state = Arc::new(Mutex::new(WriterState::default()));
        let writer_state = state.clone();
        let terminal_capacity = Arc::new(Semaphore::new(QUEUE_CAPACITY));
        let reader = reader::Reader::open(state_dir, state.clone())?;
        let task = thread::Builder::new()
            .name("call-log-writer".into())
            .spawn(move || run_writer(store, receiver, events, writer_state))
            .map_err(|_| CallLogError::Unavailable)?;
        let wake = task.thread().clone();
        Ok(Self {
            inner: Arc::new(Writer {
                sender: Mutex::new(Some(sender)),
                task: Mutex::new(Some(task)),
                wake,
                state,
                terminal_capacity,
                reader,
                changed,
            }),
        })
    }

    pub fn recorder(&self) -> CallRecorder {
        CallRecorder::new(Arc::new(self.clone()))
    }

    pub fn subscribe(&self) -> broadcast::Receiver<CallChanged> {
        self.inner.changed.subscribe()
    }

    pub async fn list(&self, query: CallQuery) -> Result<CallPage, CallLogError> {
        self.read(|reply| reader::Request::List(query, reply)).await
    }

    pub async fn get(&self, call_id: CallId) -> Result<CallRecord, CallLogError> {
        self.read(|reply| reader::Request::Get(call_id, reply)).await
    }

    pub async fn history(
        &self,
        call_id: CallId,
        after_revision: Option<u64>,
        limit: u32,
    ) -> Result<CallHistory, CallLogError> {
        self.read(|reply| reader::Request::History(call_id, after_revision, limit, reply))
            .await
    }

    async fn read<T>(
        &self,
        request: impl FnOnce(oneshot::Sender<Result<T, CallLogError>>) -> reader::Request,
    ) -> Result<T, CallLogError> {
        let response = self.inner.reader.enqueue(request)?;
        self.inner
            .state
            .lock()
            .map_err(|_| CallLogError::Unavailable)?
            .notified = true;
        self.inner.wake.unpark();
        response.await.map_err(|_| CallLogError::Unavailable)?
    }

    pub fn descriptor(
        &self,
        verifier: Arc<tokio::sync::Mutex<CapabilityDecisionVerifier>>,
    ) -> platform::module::ModuleDescriptor {
        loopback::descriptor(self.clone(), verifier)
    }

    /// Invoke after all business owners joined; stop cannot wait behind a full request queue.
    pub async fn shutdown(&self) -> Result<(), CallLogError> {
        self.inner
            .sender
            .lock()
            .map_err(|_| CallLogError::Unavailable)?
            .take()
            .ok_or(CallLogError::Unavailable)?;
        self.inner.terminal_capacity.close();
        self.inner
            .state
            .lock()
            .map_err(|_| CallLogError::Unavailable)?
            .stopping = true;
        self.inner.wake.unpark();
        let reader = self.inner.reader.stop()?;
        let writer = self
            .inner
            .task
            .lock()
            .map_err(|_| CallLogError::Unavailable)?
            .take();
        tokio::task::spawn_blocking(move || {
            let writer = match writer {
                Some(task) => task.join().unwrap_or(Err(CallLogError::Unavailable)),
                None => Err(CallLogError::Unavailable),
            };
            let reader = match reader {
                Some(task) => task.join().unwrap_or(Err(CallLogError::Unavailable)),
                None => Err(CallLogError::Unavailable),
            };
            writer.and(reader)
        })
        .await
        .map_err(|_| CallLogError::Unavailable)?
    }

    async fn begin_call(&self, call: CallBegin) -> Result<CallId, CallLogError> {
        let sender = self
            .inner
            .sender
            .lock()
            .map_err(|_| CallLogError::Unavailable)?
            .as_ref()
            .cloned()
            .ok_or(CallLogError::Unavailable)?;
        let fault_changed = self
            .inner
            .state
            .lock()
            .map_err(|_| CallLogError::Unavailable)?
            .fault_changed
            .clone();
        let mut first_check = true;
        loop {
            let notified = fault_changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let mut state = self
                    .inner
                    .state
                    .lock()
                    .map_err(|_| CallLogError::Unavailable)?;
                if state.stopping {
                    return Err(CallLogError::Unavailable);
                }
                if state.failed {
                    if first_check {
                        state.notified = true;
                        self.inner.wake.unpark();
                    }
                    return Err(CallLogError::PersistFailed);
                }
            }
            first_check = false;
            let permit = tokio::select! {
                _ = sender.closed() => return Err(CallLogError::Unavailable),
                _ = notified => continue,
                permit = self.inner.terminal_capacity.clone().acquire_owned() => {
                    permit.map_err(|_| CallLogError::Unavailable)?
                },
            };
            return self
                .request(|reply| Request::Begin(call, permit, reply))
                .await
                .map(PublishedBegin::into_call_id);
        }
    }

    async fn request<T>(
        &self,
        request: impl FnOnce(oneshot::Sender<Result<T, CallLogError>>) -> Request,
    ) -> Result<T, CallLogError> {
        let (reply, response) = oneshot::channel();
        {
            let guard = self
                .inner
                .sender
                .lock()
                .map_err(|_| CallLogError::Unavailable)?;
            let sender = guard.as_ref().ok_or(CallLogError::Unavailable)?;
            sender
                .try_send(request(reply))
                .map_err(|error| match error {
                    mpsc::error::TrySendError::Full(_) => CallLogError::QueueFull,
                    mpsc::error::TrySendError::Closed(_) => CallLogError::Unavailable,
                })?;
        }
        self.inner
            .state
            .lock()
            .map_err(|_| CallLogError::Unavailable)?
            .notified = true;
        self.inner.wake.unpark();
        response.await.map_err(|_| CallLogError::Unavailable)?
    }

    async fn terminal(&self, change: CallAppend) -> Result<(), CallLogError> {
        let sender = self
            .inner
            .sender
            .lock()
            .map_err(|_| CallLogError::Unavailable)?
            .as_ref()
            .cloned()
            .ok_or(CallLogError::Unavailable)?;
        if sender.is_closed() {
            return Err(CallLogError::Unavailable);
        }
        let (reply, response) = oneshot::channel();
        let queued = {
            let mut state = self
                .inner
                .state
                .lock()
                .map_err(|_| CallLogError::Unavailable)?;
            if state.stopping {
                return Err(CallLogError::Unavailable);
            }
            let failed = state.failed;
            match state.calls.get_mut(&change.call_id) {
                Some(TerminalSlot {
                    delivery: slot @ TerminalDelivery::Reserved,
                    ..
                }) => {
                    *slot = TerminalDelivery::Pending(change, (!failed).then_some(reply));
                    state.notified = true;
                    Ok(failed)
                }
                Some(_) => return Err(CallLogError::InvalidTransition),
                None => Err(change),
            }
        };
        match queued {
            Ok(failed) => {
                self.inner.wake.unpark();
                if failed {
                    Err(CallLogError::PersistFailed)
                } else {
                    response.await.map_err(|_| CallLogError::Unavailable)?
                }
            }
            Err(change) => self.request(|reply| Request::Append(change, reply)).await,
        }
    }
}

impl CallLog for CallLogModule {
    fn abandon(&self, call_id: &CallId) {
        abandon(&self.inner.state, &self.inner.wake, call_id);
    }

    fn begin(&self, call: CallBegin) -> CallFuture<CallId> {
        let module = self.clone();
        Box::pin(async move { module.begin_call(call).await })
    }

    fn append(&self, change: CallAppend) -> CallFuture<()> {
        let module = self.clone();
        Box::pin(async move {
            if change.status.is_some_and(|status| status.is_terminal()) {
                module.terminal(change).await
            } else {
                module.request(|reply| Request::Append(change, reply)).await
            }
        })
    }
}

fn run_writer(
    mut store: store::Store,
    mut receiver: mpsc::Receiver<Request>,
    changed: broadcast::Sender<CallChanged>,
    state: Arc<Mutex<WriterState>>,
) -> Result<(), CallLogError> {
    let mut failures = 0;
    loop {
        thread::park();
        let mut stopping = {
            let mut state = state.lock().map_err(|_| CallLogError::Unavailable)?;
            if std::mem::take(&mut state.notified) {
                failures = 0;
            }
            state.stopping
        };
        if stopping {
            receiver.close();
        }
        while let Ok(request) = receiver.try_recv() {
            stopping = state
                .lock()
                .map_err(|_| CallLogError::Unavailable)?
                .stopping;
            if stopping {
                receiver.close();
            }
            if !stopping {
                deliver_terminals(&mut store, &changed, &state, &mut failures)?;
            }
            let failed = state.lock().map_err(|_| CallLogError::Unavailable)?.failed;
            match request {
                Request::Begin(call, permit, reply) => {
                    let outcome = if failed {
                        Err(CallLogError::PersistFailed)
                    } else {
                        store.begin(call).and_then(|event| {
                            let call_id = event.call_id.clone();
                            state
                                .lock()
                                .map_err(|_| CallLogError::Unavailable)?
                                .calls
                                .insert(
                                    call_id.clone(),
                                    TerminalSlot {
                                        _permit: permit,
                                        delivery: TerminalDelivery::Reserved,
                                    },
                                );
                            let _ = changed.send(event);
                            Ok(PublishedBegin {
                                call_id: Some(call_id),
                                state: state.clone(),
                                wake: thread::current(),
                            })
                        })
                    };
                    let _ = reply.send(outcome);
                }
                Request::Append(change, reply) => {
                    let outcome = if failed {
                        Err(CallLogError::PersistFailed)
                    } else {
                        store.append(&change).map(|event| {
                            if let Some(event) = event {
                                let _ = changed.send(event);
                            }
                        })
                    };
                    let _ = reply.send(outcome);
                }
            }
        }
        stopping = state
            .lock()
            .map_err(|_| CallLogError::Unavailable)?
            .stopping;
        if stopping {
            failures = 0;
            let mut state = state.lock().map_err(|_| CallLogError::Unavailable)?;
            // Business owners have joined; external contexts cannot keep the writer alive.
            for (call_id, slot) in &mut state.calls {
                if matches!(slot.delivery, TerminalDelivery::Reserved) {
                    slot.delivery = TerminalDelivery::Pending(
                        CallAppend {
                            call_id: call_id.clone(),
                            status: Some(platform::call::CallStatus::Unknown),
                            detail: None,
                        },
                        None,
                    );
                }
            }
        }
        deliver_terminals(&mut store, &changed, &state, &mut failures)?;
        if stopping {
            let failed = state.lock().map_err(|_| CallLogError::Unavailable)?.failed;
            let closed = store.close();
            return if failed {
                Err(CallLogError::PersistFailed)
            } else {
                closed
            };
        }
    }
}

fn deliver_terminals(
    store: &mut store::Store,
    changed: &broadcast::Sender<CallChanged>,
    state: &Mutex<WriterState>,
    failures: &mut usize,
) -> Result<(), CallLogError> {
    while *failures < RECOVERY_ATTEMPTS {
        let pending = {
            let mut state = state.lock().map_err(|_| CallLogError::Unavailable)?;
            let pending = state
                .calls
                .iter_mut()
                .find(|(_, slot)| matches!(slot.delivery, TerminalDelivery::Pending(..)));
            match pending {
                Some((call_id, slot)) => match std::mem::replace(
                    &mut slot.delivery,
                    TerminalDelivery::Writing,
                ) {
                    TerminalDelivery::Pending(change, reply) => {
                        Some((call_id.clone(), change, reply))
                    }
                    _ => unreachable!(),
                },
                None => {
                    state.failed = false;
                    None
                }
            }
        };
        let Some((call_id, change, reply)) = pending else {
            return Ok(());
        };
        let outcome = store.append(&change);
        if let Some(reply) = reply {
            let _ = reply.send(outcome.as_ref().map(|_| ()).map_err(|error| *error));
        }
        let mut state = state.lock().map_err(|_| CallLogError::Unavailable)?;
        match outcome {
            Ok(event) => {
                state.calls.remove(&call_id);
                if let Some(event) = event {
                    let _ = changed.send(event);
                }
            }
            Err(error) => {
                state.calls.get_mut(&call_id).unwrap().delivery =
                    TerminalDelivery::Pending(change, None);
                state.failed = true;
                state.fault_changed.notify_waiters();
                // Release all producer waiters, retaining every reserved safe terminal for this writer.
                for slot in state.calls.values_mut() {
                    if let TerminalDelivery::Pending(_, reply) = &mut slot.delivery {
                        if let Some(reply) = reply.take() {
                            let _ = reply.send(Err(CallLogError::PersistFailed));
                        }
                    }
                }
                *failures += 1;
                if error != CallLogError::PersistFailed {
                    *failures = RECOVERY_ATTEMPTS;
                }
            }
        }
    }
    Ok(())
}
