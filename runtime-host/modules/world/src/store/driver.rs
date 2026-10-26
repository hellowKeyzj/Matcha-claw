use super::StoreError;
use foundation::execution::{OwnedTask, TaskHandle};
use std::{future::Future, pin::Pin, sync::Arc, time::Duration};
use tokio::{
    sync::{Mutex, oneshot},
    task::JoinHandle,
};
use tokio_postgres::{
    Client, Config, Error, Socket,
    tls::{MakeTlsConnect, TlsConnect},
};
use world_protocol::{commit::CommitFailure, failure::FailureStage};

struct Drivers {
    closing: bool,
    tasks: Vec<OwnedTask<Result<(), Error>>>,
    failure: Option<StoreError>,
}
#[derive(Clone)]
pub struct DriverCustody(Arc<Mutex<Drivers>>);
impl Default for DriverCustody {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(Drivers {
            closing: false,
            tasks: Vec::new(),
            failure: None,
        })))
    }
}
impl DriverCustody {
    pub fn new() -> Self {
        Self::default()
    }
    pub async fn checked_close(&self, timeout: Duration) -> Result<(), StoreError> {
        tokio::time::timeout(timeout, async {
            self.close_admission().await;
            self.join().await
        })
        .await
        .map_err(|error| {
            StoreError::caused_by(CommitFailure::StatementTimeout, FailureStage::Stop, error)
        })?
    }
    pub async fn mechanisms_closed(&self) -> bool {
        let drivers = self.0.lock().await;
        drivers.closing && drivers.tasks.is_empty()
    }
    pub(super) async fn is_closed(&self) -> bool {
        self.mechanisms_closed().await
    }
    pub(super) async fn close_admission(&self) {
        self.0.lock().await.closing = true;
    }
    pub(super) async fn join(&self) -> Result<(), StoreError> {
        let mut drivers = self.0.lock().await;
        for task in &drivers.tasks {
            task.cancel();
        }
        while !drivers.tasks.is_empty() {
            // Keep ownership in the collection if a caller times out or is cancelled during join.
            let result = drivers.tasks[0].join().await;
            drivers.tasks.remove(0);
            let error = match result {
                Ok(Ok(())) => None,
                Ok(Err(error)) => Some(StoreError::caused_by(
                    CommitFailure::Connection,
                    FailureStage::Stop,
                    error,
                )),
                Err(error) => Some(StoreError::caused_by(
                    CommitFailure::InternalFault,
                    FailureStage::Stop,
                    error,
                )),
            };
            if drivers.failure.is_none() {
                drivers.failure = error;
            }
        }
        match drivers.failure.take() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}
/// TLS is supplied by Host; ownership of every actual connection driver stays with WorldStore.
pub struct TrackedConnect<T> {
    tls: T,
    custody: DriverCustody,
}
impl<T> TrackedConnect<T> {
    pub fn new(tls: T, custody: DriverCustody) -> Self {
        Self { tls, custody }
    }
}
struct CancelDriver(TaskHandle);
impl Drop for CancelDriver {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
impl<T> deadpool_postgres::Connect for TrackedConnect<T>
where
    T: MakeTlsConnect<Socket> + Clone + Sync + Send + 'static,
    T::Stream: Sync + Send,
    T::TlsConnect: Sync + Send,
    <T::TlsConnect as TlsConnect<Socket>>::Future: Send,
{
    fn connect(
        &self,
        config: &Config,
    ) -> Pin<Box<dyn Future<Output = Result<(Client, JoinHandle<()>), Error>> + Send + '_>> {
        let config = config.clone();
        let tls = self.tls.clone();
        let custody = self.custody.clone();
        Box::pin(async move {
            let mut drivers = custody.0.lock().await;
            let (client, connection) = config.connect(tls).await?;
            // The manager may have had an in-flight connection when pool admission closed.
            if drivers.closing {
                drop(connection);
                // Dropping the actual transport makes the real client report its typed Closed error.
                let error = client
                    .simple_query("")
                    .await
                    .expect_err("dropped PostgreSQL transport is closed");
                return Err(error);
            }
            let mut index = 0;
            while index < drivers.tasks.len() {
                if drivers.tasks[index].is_finished() {
                    let result = drivers.tasks[index].join().await;
                    drivers.tasks.remove(index);
                    let error = match result {
                        Ok(Ok(())) => None,
                        Ok(Err(error)) => Some(StoreError::caused_by(
                            CommitFailure::Connection,
                            FailureStage::Execute,
                            error,
                        )),
                        Err(error) => Some(StoreError::caused_by(
                            CommitFailure::InternalFault,
                            FailureStage::Execute,
                            error,
                        )),
                    };
                    if drivers.failure.is_none() {
                        drivers.failure = error;
                    }
                } else {
                    index += 1;
                }
            }
            let (done, wait) = oneshot::channel();
            let (task, handle) = OwnedTask::spawn(move |cancel| async move {
                let result =
                    tokio::select! { result=connection=>result,_=cancel.cancelled()=>Ok(()) };
                let _ = done.send(());
                result
            });
            drivers.tasks.push(task);
            // deadpool owns only this proxy. Its Drop cancels, but cannot discard the real join.
            let guard = CancelDriver(handle);
            let proxy = tokio::spawn(async move {
                let _guard = guard;
                let _ = wait.await;
            });
            Ok((client, proxy))
        })
    }
}
