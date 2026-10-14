use std::sync::Mutex;

use tokio::{sync::oneshot, task::JoinSet};

use crate::WikiFailure;

#[derive(Default)]
pub(crate) struct BlockingTasks {
    state: Mutex<BlockingState>,
}

#[derive(Default)]
struct BlockingState {
    closed: bool,
    failed: bool,
    tasks: JoinSet<()>,
}

impl BlockingTasks {
    pub(crate) async fn run<T: Send + 'static>(
        &self,
        work: impl FnOnce() -> Result<T, WikiFailure> + Send + 'static,
    ) -> Result<T, WikiFailure> {
        let (reply, response) = oneshot::channel();
        {
            let mut state = self.state.lock().expect("Wiki blocking tasks lock");
            if state.closed {
                return Err(WikiFailure::OwnerUnavailable);
            }
            while let Some(result) = state.tasks.try_join_next() {
                state.failed |= crate::call::report_task_exit(result);
            }
            state.tasks.spawn_blocking(move || {
                let _ = reply.send(work());
            });
        }
        response
            .await
            .unwrap_or_else(|_| Err(WikiFailure::state("Wiki file operation failed")))
    }

    pub(crate) async fn shutdown(&self) -> bool {
        let (mut tasks, mut failed) = {
            let mut state = self.state.lock().expect("Wiki blocking tasks lock");
            state.closed = true;
            (std::mem::take(&mut state.tasks), state.failed)
        };
        while let Some(result) = tasks.join_next().await {
            failed |= crate::call::report_task_exit(result);
        }
        failed
    }
}
