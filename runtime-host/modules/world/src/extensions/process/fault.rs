use std::sync::Arc;

use foundation::{
    execution::OwnedTask,
    process::{ShutdownOutcome, TerminationOutcome, supervision::SupervisorHandle},
};

use super::{
    close::{self, CloseFailure, CloseStage},
    error::ProcessError,
    session::Session,
};

pub(super) type FaultResult = Result<Option<ShutdownOutcome>, Arc<ProcessError>>;

/// Compound process custody owns this task. A failed pipe or revoked generation must
/// stop the child even when no caller is currently awaiting lifecycle cleanup.
pub(super) fn monitor(handle: SupervisorHandle, session: Arc<Session>) -> OwnedTask<FaultResult> {
    let (task, _) = OwnedTask::spawn(move |cancellation| async move {
        let mut snapshots = handle.subscribe();
        loop {
            let snapshot = snapshots.borrow_and_update().clone();
            if let Some(cause) = snapshot.failure() {
                session.fail(Arc::new(ProcessError::Supervisor(Arc::new(cause.clone()))));
            }
            if session.failure().is_some() || session.cleanup.host_only() {
                break;
            }
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Ok(None),
                _ = session.cleanup.quarantined() => break,
                _ = session.closed.cancelled() => {
                    if session.failure().is_none() { return Ok(None); }
                    break;
                }
                result = snapshots.changed() => {
                    if result.is_err() { return Ok(None); }
                }
            }
        }
        // Do not cancel a published shutdown completion. Close joins this task after
        // independently confirming containment and material cleanup through Foundation.
        let outcome = close::shutdown(handle).await.map_err(|cause| {
            Arc::new(ProcessError::Close(Arc::new(CloseFailure::Control {
                stage: CloseStage::Shutdown,
                cause: Arc::new(cause),
            })))
        })?;
        if matches!(
            &outcome,
            ShutdownOutcome::Terminated(
                TerminationOutcome::Graceful(_)
                    | TerminationOutcome::Forced(_)
                    | TerminationOutcome::NoProcess
            )
        ) {
            session.confirmed_exit();
        }
        Ok(Some(outcome))
    });
    task
}
