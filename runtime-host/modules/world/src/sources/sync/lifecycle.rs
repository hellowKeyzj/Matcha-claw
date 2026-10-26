use super::{Assignment, SyncError};
use foundation::execution::OwnedTask;
use tokio::time::Instant;
use world_protocol::{failure::FailureStage, sources::SourceFailure};

/// Custody stays here across a drain timeout; dropping a future is not a stop receipt.
pub(crate) struct SourceCarriers {
    assignment: Assignment,
    reader: Option<OwnedTask<Result<(), SyncError>>>,
    ack: Option<OwnedTask<Result<(), SyncError>>>,
}
pub(crate) struct StoppedCarriers {
    assignment: Assignment,
}
impl StoppedCarriers {
    pub(crate) fn assignment(&self) -> &Assignment {
        &self.assignment
    }
}
impl SourceCarriers {
    pub(in crate::sources) fn new(
        assignment: Assignment,
        reader: OwnedTask<Result<(), SyncError>>,
        ack: Option<OwnedTask<Result<(), SyncError>>>,
    ) -> Self {
        Self {
            assignment,
            reader: Some(reader),
            ack,
        }
    }
    pub(crate) fn cancel(&self) {
        if let Some(task) = &self.reader {
            task.cancel();
        }
        if let Some(task) = &self.ack {
            task.cancel();
        }
    }
    pub(super) async fn wait_for_exit(&mut self) -> Result<(), SyncError> {
        let result = match (&mut self.reader, &mut self.ack) {
            (Some(reader), Some(ack)) => tokio::select! {
                result = reader.join() => { self.reader = None; result },
                result = ack.join() => { self.ack = None; result },
            },
            (Some(reader), None) => {
                let result = reader.join().await;
                self.reader = None;
                result
            }
            (None, Some(ack)) => {
                let result = ack.join().await;
                self.ack = None;
                result
            }
            (None, None) => return Ok(()),
        };
        result.map_err(|cause| {
            SyncError::caused(SourceFailure::ReaderNotStopped, FailureStage::Drain, cause)
        })?
    }

    pub(crate) async fn stop(&mut self, deadline: Instant) -> Result<StoppedCarriers, SyncError> {
        self.cancel();
        let mut failed = None;
        for (task, failure) in [
            (&mut self.reader, SourceFailure::ReaderNotStopped),
            (&mut self.ack, SourceFailure::AckChannelNotStopped),
        ] {
            if let Some(owned) = task {
                let result = tokio::time::timeout_at(deadline, owned.join())
                    .await
                    .map_err(|cause| {
                        SyncError::caused(failure.clone(), FailureStage::Drain, cause)
                    })?;
                match result {
                    Ok(Ok(())) => {
                        *task = None;
                    }
                    Ok(Err(error)) => {
                        // The carrier joined; ledger cleanup is independently checked by SyncOwner.
                        *task = None;
                        if failed.is_none() {
                            failed = Some(error);
                        }
                    }
                    Err(cause) => {
                        *task = None;
                        if failed.is_none() {
                            failed = Some(SyncError::caused(failure, FailureStage::Drain, cause));
                        }
                    }
                }
            }
        }
        if let Some(error) = failed {
            return Err(error);
        }
        Ok(StoppedCarriers {
            assignment: self.assignment.clone(),
        })
    }
}
