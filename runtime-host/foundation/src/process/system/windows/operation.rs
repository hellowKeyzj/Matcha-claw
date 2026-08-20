use std::{
    sync::{Arc, Mutex},
    thread::{self, JoinHandle},
};

use tokio::{runtime::Handle as RuntimeHandle, sync::oneshot};

pub(super) struct BlockingOperation<T> {
    completion: oneshot::Receiver<()>,
    thread: Option<JoinHandle<T>>,
}

impl<T: Send + 'static> BlockingOperation<T> {
    pub(super) fn spawn<I, F>(name: &'static str, input: I, operation: F) -> Result<Self, I>
    where
        I: Send + 'static,
        F: FnOnce(I) -> T + Send + 'static,
    {
        let Ok(runtime) = RuntimeHandle::try_current() else {
            return Err(input);
        };
        let input = Arc::new(Mutex::new(Some(input)));
        let thread_input = Arc::clone(&input);
        let (completed, completion) = oneshot::channel();
        let thread = thread::Builder::new().name(name.into()).spawn(move || {
            let _runtime = runtime.enter();
            let input = thread_input
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take()
                .expect("blocking operation input must exist");
            let output = operation(input);
            let _ = completed.send(());
            output
        });
        match thread {
            Ok(thread) => Ok(Self {
                completion,
                thread: Some(thread),
            }),
            Err(_) => {
                let input = input
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .take()
                    .expect("failed thread spawn must return its input");
                Err(input)
            }
        }
    }
}

impl<T> BlockingOperation<T> {
    pub(super) async fn join(&mut self) -> thread::Result<T> {
        let _ = (&mut self.completion).await;
        self.join_thread()
    }

    fn join_thread(&mut self) -> thread::Result<T> {
        self.thread
            .take()
            .expect("blocking operation thread must exist before join")
            .join()
    }
}

impl<T> Drop for BlockingOperation<T> {
    fn drop(&mut self) {
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::BlockingOperation;

    #[test]
    fn spawn_without_runtime_returns_input() {
        let spawned = BlockingOperation::<()>::spawn(
            "foundation-windows-test-no-runtime",
            Box::new(7),
            |_| (),
        );

        match spawned {
            Err(input) => assert_eq!(*input, 7),
            Ok(_) => panic!("operation must not spawn without a Tokio runtime"),
        }
    }
}
