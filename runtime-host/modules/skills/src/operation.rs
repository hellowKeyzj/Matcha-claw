use std::future::Future;

use foundation::execution::OperationHandle;
use platform::{
    call::{CallContext, CallLogError, CallStatus},
    loopback::Response,
};
use tokio::sync::oneshot;

use crate::call::{self, Detail};

#[derive(Clone)]
pub(crate) struct RecordedCall {
    pub context: CallContext<Detail>,
    pub detail: Detail,
    pub command: &'static str,
    pub accepted:
        std::sync::Arc<tokio::sync::OnceCell<Result<platform::call::CallReceipt, CallLogError>>>,
}

impl RecordedCall {
    pub async fn accepted(&self) -> Result<platform::call::CallReceipt, CallLogError> {
        self.accepted
            .get_or_init(|| self.context.accepted())
            .await
            .clone()
    }
}

#[derive(Default)]
pub(crate) struct Operations {
    closed: bool,
    pending: Vec<(platform::call::CallId, OperationHandle<()>)>,
    tail: Option<oneshot::Receiver<()>>,
    pub results: crate::result::Results,
}

impl Operations {
    pub async fn submit<F>(
        &mut self,
        call: RecordedCall,
        reservation: Option<(crate::result::ResultAccess, usize)>,
        operation: F,
    ) -> Result<(), CallLogError>
    where
        F: Future<Output = Response> + Send + 'static,
    {
        let mut index = 0;
        while index < self.pending.len() {
            if self.pending[index].1.is_finished() {
                let (_, mut completed) = self.pending.swap_remove(index);
                if completed.join().await.is_err() {
                    eprintln!("[skills-call] operation join failed");
                }
            } else {
                index += 1;
            }
        }
        let retained = self.results.occupied().await;
        let occupied = retained.len()
            + self
                .pending
                .iter()
                .filter(|(id, _)| !retained.contains(id))
                .count();
        if self.closed || occupied >= 16 {
            return Err(if self.closed {
                CallLogError::Unavailable
            } else {
                CallLogError::QueueFull
            });
        }
        if let Some((access, budget)) = reservation {
            self.results
                .reserve(call.context.id().clone(), call.command, access, budget)
                .await?;
        }
        let results = self.results.clone();
        let predecessor = self.tail.take();
        let (completed, completion) = oneshot::channel();
        self.tail = Some(completion);
        let context = call.context.clone();
        let call_id = context.id().clone();
        let (task, _) = OperationHandle::spawn(move |_cancellation| async move {
            if let Err(error) = call.accepted().await {
                eprintln!("[skills-call] accepted transition failed: {error}");
                results.remove(context.id()).await;
                let _ = context.finish(CallStatus::Rejected, &call.detail).await;
                if let Some(predecessor) = predecessor {
                    let _ = predecessor.await;
                }
                let _ = completed.send(());
                return;
            }
            if let Some(predecessor) = predecessor {
                let _ = predecessor.await;
            }
            // Native ports own their effects: drain them to a terminal result on shutdown.
            if let Err(error) = context.running().await {
                eprintln!("[skills-call] running transition failed: {error}");
                results.remove(context.id()).await;
                let _ = context.finish(CallStatus::Failed, &call.detail).await;
            } else {
                let importing = matches!(
                    call.command,
                    "skills.import.markdown"
                        | "skills.import.bundle"
                        | "skills.importBundles"
                        | "skills.bundles.import"
                );
                let started = std::time::Instant::now();
                if importing {
                    eprintln!(
                        "[startup-trace] source=skills-import phase=running callIdHigh={} callIdLow={} command={}",
                        &context.id().as_str()[..16],
                        &context.id().as_str()[16..],
                        call.command
                    );
                }
                let response = operation.await;
                let (status, detail) = call::terminal(call.detail, &response);
                if importing {
                    eprintln!(
                        "[startup-trace] source=skills-import phase=terminal callIdHigh={} callIdLow={} command={} status={} httpStatus={} elapsedMs={}",
                        &context.id().as_str()[..16],
                        &context.id().as_str()[16..],
                        call.command,
                        status.as_str(),
                        response.status(),
                        started.elapsed().as_millis()
                    );
                }
                if let Err(error) = context.finish(status, &detail).await {
                    eprintln!("[skills-call] terminal transition failed: {error}");
                }
            }
            let _ = completed.send(());
        });
        self.pending.push((call_id, task));
        Ok(())
    }

    pub async fn stop(&mut self) {
        self.closed = true;
        for (_, mut operation) in self.pending.drain(..) {
            if operation.join().await.is_err() {
                eprintln!("[skills-call] shutdown join failed");
            }
        }
        self.results.clear().await;
    }
}
