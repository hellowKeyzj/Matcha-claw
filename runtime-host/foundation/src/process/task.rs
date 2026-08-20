use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
};

use tokio::task::{JoinError, JoinHandle};

type DeferredTask<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

#[derive(Clone)]
pub(crate) struct TaskOwner<T> {
    state: Arc<State<T>>,
}

struct State<T> {
    task: Mutex<Task<T>>,
}

enum Task<T> {
    Deferred(Option<DeferredTask<T>>),
    Running(JoinHandle<T>),
}

impl<T: Send + 'static> TaskOwner<T> {
    pub(super) fn spawn(future: impl Future<Output = T> + Send + 'static) -> Self {
        let task = Self::deferred(future);
        task.start();
        task
    }

    pub(super) fn deferred(future: impl Future<Output = T> + Send + 'static) -> Self {
        Self {
            state: Arc::new(State {
                task: Mutex::new(Task::Deferred(Some(Box::pin(future)))),
            }),
        }
    }

    pub(crate) fn start(&self) {
        let mut task = self.state.task.lock().expect("task owner lock poisoned");
        let Task::Deferred(future) = &mut *task else {
            return;
        };
        let future = future.take().expect("deferred task missing its future");
        let custody = Arc::clone(&self.state);
        *task = Task::Running(tokio::spawn(async move {
            let output = future.await;
            drop(custody);
            output
        }));
    }

    pub(super) fn is_started(&self) -> bool {
        matches!(
            &*self.state.task.lock().expect("task owner lock poisoned"),
            Task::Running(_)
        )
    }

    pub(super) fn is_finished(&self) -> bool {
        match &*self.state.task.lock().expect("task owner lock poisoned") {
            Task::Deferred(_) => false,
            Task::Running(handle) => handle.is_finished(),
        }
    }

    #[cfg(test)]
    pub(super) fn abort(&self) {
        if let Task::Running(handle) = &*self.state.task.lock().expect("task owner lock poisoned") {
            handle.abort();
        }
    }
}

impl<T: Send + 'static> Future for TaskOwner<T> {
    type Output = Result<T, JoinError>;

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        self.start();
        let mut task = self.state.task.lock().expect("task owner lock poisoned");
        let Task::Running(handle) = &mut *task else {
            unreachable!("task owner must start before polling");
        };
        Pin::new(handle).poll(context)
    }
}
