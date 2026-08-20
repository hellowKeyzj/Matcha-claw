use std::future::Future;

use tokio::task::JoinError;
use tokio_util::sync::CancellationToken;

use super::{OwnedTask, TaskHandle};

pub struct OperationHandle<T> {
    task: OwnedTask<T>,
}

impl<T: Send + 'static> OperationHandle<T> {
    pub fn spawn<F, U>(future: F) -> (Self, TaskHandle)
    where
        F: FnOnce(CancellationToken) -> U + Send + 'static,
        U: Future<Output = T> + Send + 'static,
    {
        let (task, handle) = OwnedTask::spawn(future);
        (Self { task }, handle)
    }

    pub fn cancel(&self) {
        self.task.cancel();
    }

    pub fn is_finished(&self) -> bool {
        self.task.is_finished()
    }

    pub async fn join(&mut self) -> Result<T, JoinError> {
        self.task.join().await
    }

    pub async fn cancel_and_join(&mut self) -> Result<T, JoinError> {
        self.task.cancel_and_join().await
    }
}

impl<T> Drop for OperationHandle<T> {
    fn drop(&mut self) {
        self.task.cancel();
    }
}
