use std::sync::Arc;

use tokio::time::{Instant, timeout_at};
use world_protocol::{budget::Usage, slots::SlotRequest};

use super::{Delivery, ProcessError, ProcessOutcome, pending::PendingCall};
use crate::extensions::{
    host_calls::HostCallFailure,
    invocation::{InvocationContext, ResourceLedger, ResourceSnapshot},
};

/// A read-only borrow of original ledger custody; dropping it never cancels a call.
#[derive(Clone)]
pub(crate) struct ProcessInspection {
    pending: Arc<PendingCall>,
    context: InvocationContext,
    ledger: ResourceLedger,
}

pub(crate) struct ProcessSnapshot {
    pub outcome: Option<ProcessOutcome>,
    pub received_result: Option<world_protocol::process::CallResult>,
    pub delivery: Delivery,
    pub usage: Usage,
    pub host_failure: Option<Arc<HostCallFailure>>,
    pub failure: Option<Arc<ProcessError>>,
    pub cleanup: Option<ResourceSnapshot>,
    pub settled: bool,
    pub(super) released: bool,
    pub(crate) streams_consumed: bool,
}

impl ProcessInspection {
    pub(super) fn new(
        pending: Arc<PendingCall>,
        context: InvocationContext,
        ledger: ResourceLedger,
    ) -> Self {
        Self {
            pending,
            context,
            ledger,
        }
    }

    pub fn context(&self) -> &InvocationContext {
        &self.context
    }

    pub fn request(&self) -> &SlotRequest {
        &self.pending.request
    }

    pub fn snapshot(&self) -> ProcessSnapshot {
        let mut snapshot = self.pending.inspection_snapshot();
        snapshot.cleanup = self.ledger.resource(&self.pending.token);
        // Only original checked close releases PendingCall and removes its resource.
        snapshot.settled = snapshot.released && snapshot.cleanup.is_none();
        snapshot
    }

    pub fn closure_settled(&self) -> bool {
        let lease = self.context.lease();
        lease.closure().nodes.iter().all(|node| {
            lease.ledger(node).is_some_and(|ledger| {
                !ledger
                    .snapshot()
                    .resources
                    .iter()
                    .any(|resource| resource.spec.invocation.as_ref() == Some(lease.invocation()))
            })
        })
    }

    /// Waits for original state changes only; it cannot dispatch, cancel or clean up.
    pub async fn wait(&self, deadline: Instant) -> ProcessSnapshot {
        loop {
            let call_changed = self.pending.changed.notified();
            let lease = self.context.lease();
            let cleanup_changed = lease
                .closure()
                .nodes
                .iter()
                .filter_map(|node| lease.ledger(node))
                .map(|ledger| Box::pin(ledger.inspection_changed()))
                .collect::<Vec<_>>();
            let snapshot = self.snapshot();
            if snapshot.settled && self.closure_settled() || Instant::now() >= deadline {
                return snapshot;
            }
            tokio::select! {
                _ = call_changed => {},
                _ = futures_util::future::select_all(cleanup_changed) => {},
                _ = tokio::time::sleep_until(deadline) => return self.snapshot(),
            }
        }
    }

    /// The same original budget/current/output gate as ProcessCall::finish.
    pub async fn check_output(&self) -> Result<(), Arc<ProcessError>> {
        if let Some(error) = self.pending.failure() {
            return Err(error);
        }
        timeout_at(self.pending.deadline, async {
            self.pending
                .budget
                .check()
                .map_err(|cause| Arc::new(ProcessError::Budget(cause.dimension)))?;
            self.context
                .check_current()
                .await
                .map_err(|cause| Arc::new(ProcessError::Current(Arc::new(cause))))?;
            self.context
                .check_output(self.pending.budget.usage().bytes)
                .await
                .map_err(|cause| Arc::new(ProcessError::Output(Arc::new(cause))))
        })
        .await
        .map_err(|_| Arc::new(ProcessError::Deadline))?
    }
}
