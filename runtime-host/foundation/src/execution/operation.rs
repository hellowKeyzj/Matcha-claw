use std::future::Future;

use tokio::task::JoinError;
use tokio_util::sync::CancellationToken;

use super::{
    ObservationSink, OperationObservation, OperationReason, OperationStage, OwnedTask, TaskHandle,
    TraceContext,
};

pub struct OperationHandle<T> {
    task: OwnedTask<T>,
    observation: OperationHandleObservation,
}

#[derive(Clone)]
struct OperationHandleObservation {
    sink: ObservationSink,
    trace: TraceContext,
    operation_kind: &'static str,
}

impl OperationHandleObservation {
    fn disabled() -> Self {
        Self {
            sink: ObservationSink::disabled(),
            trace: TraceContext::absent(),
            operation_kind: "operation",
        }
    }

    fn observe(&self, stage: OperationStage, reason: Option<OperationReason>) {
        if self.sink.is_enabled() {
            self.sink
                .observe(super::ObservationRecord::Operation(OperationObservation {
                    trace: self.trace,
                    operation_kind: self.operation_kind,
                    stage,
                    reason,
                }));
        }
    }
}

impl<T: Send + 'static> OperationHandle<T> {
    pub fn spawn<F, U>(future: F) -> (Self, TaskHandle)
    where
        F: FnOnce(CancellationToken) -> U + Send + 'static,
        U: Future<Output = T> + Send + 'static,
    {
        let (task, handle) = OwnedTask::spawn(future);
        (
            Self {
                task,
                observation: OperationHandleObservation::disabled(),
            },
            handle,
        )
    }

    pub fn spawn_observed<F, U>(
        sink: ObservationSink,
        trace: TraceContext,
        operation_kind: &'static str,
        future: F,
    ) -> (Self, TaskHandle)
    where
        F: FnOnce(CancellationToken) -> U + Send + 'static,
        U: Future<Output = T> + Send + 'static,
    {
        let observation = OperationHandleObservation {
            sink,
            trace,
            operation_kind,
        };
        observation.observe(OperationStage::Start, None);
        let task_observation = observation.clone();
        let (task, handle) = OwnedTask::spawn(move |cancellation| async move {
            let output = future(cancellation).await;
            task_observation.observe(OperationStage::Settle, Some(OperationReason::Completed));
            output
        });
        (Self { task, observation }, handle)
    }

    pub fn cancel(&self) {
        self.observation
            .observe(OperationStage::Cancel, Some(OperationReason::Cancelled));
        self.task.cancel();
    }

    pub fn is_finished(&self) -> bool {
        self.task.is_finished()
    }

    pub async fn join(&mut self) -> Result<T, JoinError> {
        self.observation.observe(OperationStage::Join, None);
        let result = self.task.join().await;
        if result.is_err() {
            self.observation
                .observe(OperationStage::Settle, Some(OperationReason::JoinFailed));
        }
        result
    }

    pub async fn cancel_and_join(&mut self) -> Result<T, JoinError> {
        self.observation
            .observe(OperationStage::Cancel, Some(OperationReason::Cancelled));
        self.observation.observe(OperationStage::Join, None);
        let result = self.task.cancel_and_join().await;
        if result.is_err() {
            self.observation
                .observe(OperationStage::Settle, Some(OperationReason::JoinFailed));
        }
        result
    }
}

impl<T> Drop for OperationHandle<T> {
    fn drop(&mut self) {
        if !self.task.is_finished() {
            self.observation
                .observe(OperationStage::Cancel, Some(OperationReason::Dropped));
        }
        self.task.cancel();
    }
}
