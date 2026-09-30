mod loopback;
mod store;

use std::{
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
use tokio::sync::{broadcast, mpsc, oneshot};

const QUEUE_CAPACITY: usize = 256;

#[derive(Clone)]
pub struct CallLogModule {
    inner: Arc<Writer>,
}

struct Writer {
    sender: Mutex<Option<mpsc::Sender<Request>>>,
    task: Mutex<Option<thread::JoinHandle<()>>>,
    changed: broadcast::Sender<CallChanged>,
}

enum Request {
    Begin(CallBegin, oneshot::Sender<Result<CallId, CallLogError>>),
    Append(CallAppend, oneshot::Sender<Result<(), CallLogError>>),
    List(CallQuery, oneshot::Sender<Result<CallPage, CallLogError>>),
    Get(CallId, oneshot::Sender<Result<CallRecord, CallLogError>>),
    History(
        CallId,
        Option<u64>,
        u32,
        oneshot::Sender<Result<CallHistory, CallLogError>>,
    ),
    Shutdown(oneshot::Sender<Result<(), CallLogError>>),
}

impl CallLogModule {
    pub fn open(state_dir: &Path) -> Result<Self, CallLogError> {
        let store = store::Store::open(state_dir)?;
        let (sender, receiver) = mpsc::channel(QUEUE_CAPACITY);
        let (changed, _) = broadcast::channel(QUEUE_CAPACITY);
        let events = changed.clone();
        let task = thread::Builder::new()
            .name("call-log-writer".into())
            .spawn(move || run_writer(store, receiver, events))
            .map_err(|_| CallLogError::Unavailable)?;
        Ok(Self {
            inner: Arc::new(Writer {
                sender: Mutex::new(Some(sender)),
                task: Mutex::new(Some(task)),
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
        self.request(|reply| Request::List(query, reply)).await
    }

    pub async fn get(&self, call_id: CallId) -> Result<CallRecord, CallLogError> {
        self.request(|reply| Request::Get(call_id, reply)).await
    }

    pub async fn history(
        &self,
        call_id: CallId,
        after_revision: Option<u64>,
        limit: u32,
    ) -> Result<CallHistory, CallLogError> {
        self.request(|reply| Request::History(call_id, after_revision, limit, reply))
            .await
    }

    pub fn descriptor(
        &self,
        verifier: Arc<tokio::sync::Mutex<CapabilityDecisionVerifier>>,
    ) -> platform::module::ModuleDescriptor {
        loopback::descriptor(self.clone(), verifier)
    }

    /// Invoke after all business owners joined; admission closes before queued writes drain.
    pub async fn shutdown(&self) -> Result<(), CallLogError> {
        let sender = self
            .inner
            .sender
            .lock()
            .map_err(|_| CallLogError::Unavailable)?
            .take()
            .ok_or(CallLogError::Unavailable)?;
        let (reply, response) = oneshot::channel();
        let sent = sender.send(Request::Shutdown(reply)).await;
        drop(sender);
        let outcome = match sent {
            Ok(()) => response.await.unwrap_or(Err(CallLogError::Unavailable)),
            Err(_) => Err(CallLogError::Unavailable),
        };
        let task = self
            .inner
            .task
            .lock()
            .map_err(|_| CallLogError::Unavailable)?
            .take();
        if let Some(task) = task {
            tokio::task::spawn_blocking(move || task.join())
                .await
                .map_err(|_| CallLogError::Unavailable)?
                .map_err(|_| CallLogError::Unavailable)?;
        }
        outcome
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
        response.await.map_err(|_| CallLogError::Unavailable)?
    }
}

impl CallLog for CallLogModule {
    fn begin(&self, call: CallBegin) -> CallFuture<CallId> {
        let module = self.clone();
        Box::pin(async move { module.request(|reply| Request::Begin(call, reply)).await })
    }

    fn append(&self, change: CallAppend) -> CallFuture<()> {
        let module = self.clone();
        Box::pin(async move { module.request(|reply| Request::Append(change, reply)).await })
    }
}

fn run_writer(
    mut store: store::Store,
    mut receiver: mpsc::Receiver<Request>,
    changed: broadcast::Sender<CallChanged>,
) {
    while let Some(request) = receiver.blocking_recv() {
        match request {
            Request::Begin(call, reply) => {
                let outcome = store.begin(call).map(|event| {
                    let call_id = event.call_id.clone();
                    let _ = changed.send(event);
                    call_id
                });
                let _ = reply.send(outcome);
            }
            Request::Append(change, reply) => {
                let outcome = store.append(change).map(|event| {
                    if let Some(event) = event {
                        let _ = changed.send(event);
                    }
                });
                let _ = reply.send(outcome);
            }
            Request::List(query, reply) => {
                let _ = reply.send(store.list(query));
            }
            Request::Get(call_id, reply) => {
                let _ = reply.send(store.get(&call_id));
            }
            Request::History(call_id, after, limit, reply) => {
                let _ = reply.send(store.history(&call_id, after, limit));
            }
            Request::Shutdown(reply) => {
                let _ = reply.send(store.close());
                return;
            }
        }
    }
}
