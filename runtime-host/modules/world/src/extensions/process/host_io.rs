use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use foundation::execution::OwnedTask;
use tokio::{
    sync::Mutex,
    time::{Instant, timeout_at},
};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    budget::BudgetDimension,
    ids::{AcquisitionId, RequestId},
    process::{self, CallId, HostCall, HostResponse, ProcessFailure},
};

use super::{
    close::{CloseStage, JoinedTask},
    error::ProcessError,
    pending::PendingCall,
    session::{CONTROL_TIMEOUT, Session},
};
use crate::extensions::{
    host_calls::HostCallFailure,
    invocation::{
        CleanupControl, CleanupFuture, HostResource, Registration, ResourceFailure, ResourceKind,
        ResourcePartFailure, ResourceStage,
    },
};

type Output = Result<HostResponse, Arc<HostCallFailure>>;

pub(super) struct HostIo {
    pub(super) id: CallId,
    pub(super) parent: Arc<PendingCall>,
    task: Mutex<JoinedTask<Output>>,
    registration: Mutex<Option<Registration>>,
    writing: AtomicBool,
    written: CancellationToken,
}

struct HostIoResource(Arc<HostIo>);

pub(super) fn accept(session: &Arc<Session>, call: HostCall) -> Result<(), ProcessError> {
    let parent = session.call(&call.parent)?;
    if !parent.accepts_host_call() {
        return Err(ProcessFailure::SequenceMismatch.into());
    }
    let port = process::host_request_port(&call.request)
        .map_err(|_| ProcessError::Protocol(ProcessFailure::HandshakeMismatch))?;
    if call.contract != port.contract
        || !session.methods.iter().any(|actual| {
            actual.direction == port.direction
                && actual.name == port.name
                && actual.contract == port.contract
                && actual.request_schema == port.request_schema
                && actual.result_schema == port.result_schema
        })
    {
        return Err(ProcessFailure::ContractMismatch {
            contract_id: call.contract.id,
        }
        .into());
    }
    let context = parent.context().ok_or(ProcessError::Closing)?;
    let hosts = parent.hosts().ok_or(ProcessError::Closing)?;
    let deadline = Instant::now()
        .checked_add(std::time::Duration::from_millis(call.timeout.0).min(session.host_io_timeout))
        .ok_or(ProcessError::Deadline)?
        .min(parent.deadline)
        .min(parent.budget.deadline());
    parent
        .budget
        .charge(BudgetDimension::Steps, 1)
        .map_err(|cause| ProcessError::Budget(cause.dimension))?;
    let ledger = context
        .lease()
        .ledger(context.node())
        .ok_or(ProcessError::Closing)?;
    let mut spec = context
        .lease()
        .resource_spec(context.node(), ResourceKind::HostIo)
        .ok_or(ProcessError::Closing)?;
    spec.parent = Some(parent.token.clone());
    let ticket = ledger
        .begin_acquisition(
            AcquisitionId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID acquisition"),
            spec,
        )
        .map_err(ProcessError::Admission)?;
    if let Err(cause) = session.admit_host(&call.id) {
        ticket.fail();
        return Err(cause);
    }
    let acquired_cancel = ticket.cancellation().clone();
    let task_parent = parent.clone();
    let task_closed = session.closed.clone();
    let cleanup = session.cleanup.clone();
    let call_key = format!(
        "{}/{}/{}",
        call.id.generation_id, call.parent.request_id, call.id.request_id
    );
    let (task, _) = OwnedTask::spawn(move |task_cancel| async move {
        let cancel = CancellationToken::new();
        let work = hosts.execute(call.request, &call_key, cancel.clone(), deadline);
        tokio::pin!(work);
        let pipeline_cancel = context.pipeline().cancellation();
        tokio::select! {
            biased;
            _ = task_cancel.cancelled() => {},
            _ = acquired_cancel.cancelled() => {},
            _ = task_parent.cancellation.cancelled() => {},
            _ = pipeline_cancel.cancelled() => {},
            _ = cleanup.quarantined() => {},
            _ = task_closed.cancelled() => {},
            _ = tokio::time::sleep_until(deadline) => {},
            result = work.as_mut() => return result.map_err(Arc::new),
        };
        cancel.cancel();
        // The same producer future owns cancellation cleanup; never drop it at the deadline.
        // Cancellation does not undo a committed response. The producer keeps its typed receipt.
        let result = work.await.map_err(Arc::new);
        if let Err(cause) = &result {
            task_parent.host_failure(cause.clone());
        }
        result
    });
    let io = Arc::new(HostIo {
        id: call.id,
        parent,
        task: Mutex::new(JoinedTask::new(task)),
        registration: Mutex::new(None),
        writing: AtomicBool::new(false),
        written: CancellationToken::new(),
    });
    let acquired = ticket.complete(Box::new(HostIoResource(io.clone())));
    *io.registration
        .try_lock()
        .expect("new host I/O registration unlocked") = Some(acquired.registration);
    session.add_host(io);
    Ok(())
}

impl HostIo {
    pub(super) fn request_id(&self) -> &RequestId {
        &self.id.request_id
    }

    pub(super) fn is_finished(&self) -> bool {
        self.task.try_lock().is_ok_and(|task| task.is_finished())
    }

    pub(super) async fn result(&self, deadline: Instant) -> Result<Output, Arc<ProcessError>> {
        let mut task = timeout_at(deadline, self.task.lock())
            .await
            .map_err(|_| Arc::new(ProcessError::BackpressureTimeout))?;
        task.join_checked(CloseStage::HostJoin, deadline)
            .await
            .map(Clone::clone)
            .map_err(|cause| Arc::new(ProcessError::Close(Arc::new(cause))))
    }

    pub(super) async fn release(&self, deadline: Instant) -> Result<(), Arc<ProcessError>> {
        let mut registration = timeout_at(deadline, self.registration.lock())
            .await
            .map_err(|_| Arc::new(ProcessError::CancelNotConfirmed))?;
        if let Some(registration) = registration.as_mut() {
            registration
                .close_checked(deadline)
                .await
                .map_err(|cause| Arc::new(ProcessError::Resource(cause)))?;
        }
        *registration = None;
        Ok(())
    }

    pub(super) fn begin_write(&self) {
        self.writing.store(true, Ordering::Release);
    }
    pub(super) fn written(&self) {
        self.written.cancel();
    }

    pub(super) async fn wait_written(&self) -> Result<(), ProcessError> {
        if !self.writing.load(Ordering::Acquire) {
            return Err(ProcessFailure::SequenceMismatch.into());
        }
        timeout_at(Instant::now() + CONTROL_TIMEOUT, self.written.cancelled())
            .await
            .map_err(|_| ProcessError::BackpressureTimeout)
    }

    pub(super) fn remaining(&self) -> Option<ResourcePartFailure> {
        match self.task.try_lock() {
            Ok(task) => task.remaining("host_import"),
            Err(_) => Some(ResourcePartFailure {
                kind: ResourceKind::HostIo,
                name: "host_import".into(),
                stage: ResourceStage::TaskJoin,
                code: "process_host_io_join_not_confirmed",
                message: "host import has not completed checked cleanup".into(),
            }),
        }
    }
}

impl HostResource for HostIoResource {
    fn close_checked(&mut self, deadline: Instant, _control: CleanupControl) -> CleanupFuture<'_> {
        Box::pin(async move {
            let mut task = timeout_at(deadline, self.0.task.lock())
                .await
                .map_err(|_| {
                    ResourceFailure::new(
                        ResourceStage::TaskJoin,
                        "process_host_io_lock_deadline",
                        "host import cleanup is still owned",
                    )
                })?;
            task.cancel();
            match task.join_checked(CloseStage::HostJoin, deadline).await {
                Ok(Err(cause)) => self.0.parent.host_failure(cause.clone()),
                Ok(Ok(_)) => {}
                Err(cause) => {
                    let pending = matches!(cause, super::close::CloseFailure::Deadline(_));
                    let failure = cause
                        .safe_resource_failure(task.remaining("host_import").into_iter().collect());
                    if let Some(session) = self.0.parent.session.upgrade() {
                        session.fail(Arc::new(ProcessError::Close(Arc::new(cause))));
                    }
                    if pending {
                        return Err(failure);
                    }
                }
            }
            Ok(())
        })
    }
}

pub(super) async fn close_all(
    session: &Session,
    deadline: Instant,
) -> Result<(), Arc<ProcessError>> {
    let mut failure = None;
    for io in session.host_calls() {
        match io.release(deadline).await {
            Ok(()) => session.remove_host(io.request_id()),
            Err(cause) => {
                failure.get_or_insert(cause);
            }
        }
    }
    failure.map_or(Ok(()), Err)
}
