use std::{
    path::Path,
    sync::{Arc, Mutex},
    thread,
};

use platform::call::{CallHistory, CallId, CallLogError, CallPage, CallQuery, CallRecord};
use tokio::sync::{mpsc, oneshot};

use crate::{QUEUE_CAPACITY, WriterState, store};

pub(crate) struct Reader {
    sender: Mutex<Option<mpsc::Sender<Request>>>,
    task: Mutex<Option<thread::JoinHandle<Result<(), CallLogError>>>>,
}

pub(crate) enum Request {
    List(CallQuery, oneshot::Sender<Result<CallPage, CallLogError>>),
    Get(CallId, oneshot::Sender<Result<CallRecord, CallLogError>>),
    History(
        CallId,
        Option<u64>,
        u32,
        oneshot::Sender<Result<CallHistory, CallLogError>>,
    ),
}

impl Reader {
    pub(crate) fn open(
        state_dir: &Path,
        state: Arc<Mutex<WriterState>>,
    ) -> Result<Self, CallLogError> {
        let connection = store::ReadConnection::open(state_dir)?;
        let (sender, receiver) = mpsc::channel(QUEUE_CAPACITY);
        let task = thread::Builder::new()
            .name("call-log-reader".into())
            .spawn(move || run(connection, receiver, state))
            .map_err(|_| CallLogError::Unavailable)?;
        Ok(Self {
            sender: Mutex::new(Some(sender)),
            task: Mutex::new(Some(task)),
        })
    }

    pub(crate) fn enqueue<T>(
        &self,
        request: impl FnOnce(oneshot::Sender<Result<T, CallLogError>>) -> Request,
    ) -> Result<oneshot::Receiver<Result<T, CallLogError>>, CallLogError> {
        let (reply, response) = oneshot::channel();
        self.sender
            .lock()
            .map_err(|_| CallLogError::Unavailable)?
            .as_ref()
            .ok_or(CallLogError::Unavailable)?
            .try_send(request(reply))
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => CallLogError::QueueFull,
                mpsc::error::TrySendError::Closed(_) => CallLogError::Unavailable,
            })?;
        Ok(response)
    }

    pub(crate) fn stop(
        &self,
    ) -> Result<Option<thread::JoinHandle<Result<(), CallLogError>>>, CallLogError> {
        self.sender
            .lock()
            .map_err(|_| CallLogError::Unavailable)?
            .take();
        Ok(self
            .task
            .lock()
            .map_err(|_| CallLogError::Unavailable)?
            .take())
    }
}

impl Drop for Reader {
    fn drop(&mut self) {
        if let Ok(sender) = self.sender.get_mut() {
            sender.take();
        }
        if let Ok(task) = self.task.get_mut() {
            if let Some(task) = task.take() {
                let _ = task.join();
            }
        }
    }
}

fn run(
    mut connection: store::ReadConnection,
    mut receiver: mpsc::Receiver<Request>,
    state: Arc<Mutex<WriterState>>,
) -> Result<(), CallLogError> {
    while let Some(request) = receiver.blocking_recv() {
        match request {
            Request::List(query, reply) => {
                let _ = reply.send(read(&mut connection, &state, |snapshot| {
                    snapshot.list(query)
                }));
            }
            Request::Get(call_id, reply) => {
                let _ = reply.send(read(&mut connection, &state, |snapshot| {
                    snapshot.get(&call_id)
                }));
            }
            Request::History(call_id, after, limit, reply) => {
                let _ = reply.send(read(&mut connection, &state, |snapshot| {
                    snapshot.history(&call_id, after, limit)
                }));
            }
        }
    }
    connection.close()
}

fn read<T>(
    connection: &mut store::ReadConnection,
    state: &Mutex<WriterState>,
    query: impl FnOnce(&store::Snapshot<'_>) -> Result<T, CallLogError>,
) -> Result<T, CallLogError> {
    if state.lock().map_err(|_| CallLogError::Unavailable)?.failed {
        return Err(CallLogError::PersistFailed);
    }
    let outcome = query(&connection.snapshot()?);
    if state.lock().map_err(|_| CallLogError::Unavailable)?.failed {
        return Err(CallLogError::PersistFailed);
    }
    outcome
}
