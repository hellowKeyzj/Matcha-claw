use std::{
    future::Future,
    pin::Pin,
    task::{Context, Poll},
};

use tokio::task::{JoinError, JoinHandle};
use tokio_util::sync::CancellationToken;

pub struct OwnedTask<T> {
    cancellation: CancellationToken,
    join: JoinHandle<T>,
}

#[derive(Clone)]
pub struct TaskHandle {
    cancellation: CancellationToken,
}

impl TaskHandle {
    pub fn cancel(&self) {
        self.cancellation.cancel();
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancellation.is_cancelled()
    }
}

impl<T> OwnedTask<T> {
    pub fn cancel(&self) {
        self.cancellation.cancel();
    }

    pub fn is_finished(&self) -> bool {
        self.join.is_finished()
    }
}

impl<T: Send + 'static> OwnedTask<T> {
    pub fn spawn<F, U>(future: F) -> (Self, TaskHandle)
    where
        F: FnOnce(CancellationToken) -> U + Send + 'static,
        U: Future<Output = T> + Send + 'static,
    {
        let cancellation = CancellationToken::new();
        let join = tokio::spawn(future(cancellation.clone()));
        let handle = TaskHandle {
            cancellation: cancellation.clone(),
        };
        (Self { cancellation, join }, handle)
    }

    pub fn handle(&self) -> TaskHandle {
        TaskHandle {
            cancellation: self.cancellation.clone(),
        }
    }

    pub async fn join(&mut self) -> Result<T, JoinError> {
        (&mut self.join).await
    }

    pub async fn cancel_and_join(&mut self) -> Result<T, JoinError> {
        self.cancel();
        self.join().await
    }
}

impl<T: Send + 'static> Future for &mut OwnedTask<T> {
    type Output = Result<T, JoinError>;

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.get_mut().join).poll(context)
    }
}

impl<T> Drop for OwnedTask<T> {
    fn drop(&mut self) {
        self.cancellation.cancel();
        self.join.abort();
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::sync::oneshot;

    use super::OwnedTask;

    #[tokio::test]
    async fn task_handle_cancels_cooperative_future() {
        let (release, wait_release) = oneshot::channel();
        let (mut task, handle) = OwnedTask::spawn(|cancellation| async move {
            tokio::select! {
                _ = cancellation.cancelled() => "cancelled",
                _ = wait_release => "released",
            }
        });

        assert!(!handle.is_cancelled());
        handle.cancel();
        assert!(handle.is_cancelled());
        assert_eq!(
            task.join().await.expect("task should complete"),
            "cancelled"
        );
        let _ = release.send(());
    }

    #[tokio::test]
    async fn cancel_and_join_waits_for_cleanup() {
        let (cleaned, wait_cleaned) = oneshot::channel();
        let (mut task, _) = OwnedTask::spawn(|cancellation| async move {
            cancellation.cancelled().await;
            tokio::time::sleep(Duration::from_millis(1)).await;
            let _ = cleaned.send(());
            7
        });

        assert_eq!(task.cancel_and_join().await.expect("task should join"), 7);
        wait_cleaned.await.expect("cleanup should run");
    }
}
