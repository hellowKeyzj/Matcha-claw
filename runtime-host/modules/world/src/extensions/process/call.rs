use std::sync::Arc;

use tokio::time::{Instant, timeout_at};
use world_protocol::{
    bindings::PortDirection,
    budget::{BudgetDimension, Usage},
    ids::AcquisitionId,
    process::{CallResult, Frame, ProcessFailure, TerminalState},
    slots::{SlotRequest, request_slot},
    sources::ContractRef,
};

use super::{
    error::{Delivery, ProcessError},
    pending::PendingCall,
    session::{Outgoing, Session},
    streams::ProcessChunk,
};
use crate::extensions::{
    host_calls::HostCallContext,
    invocation::{
        CleanupControl, CleanupFuture, HostResource, InvocationContext, Registration,
        ResourceFailure, ResourceKind, ResourceStage,
    },
};

#[derive(Clone)]
pub(crate) struct ProcessClient {
    pub(super) session: Arc<Session>,
}

pub(crate) struct ProcessCall {
    pending: Arc<PendingCall>,
    registration: Option<Registration>,
}

#[derive(Clone, Debug)]
pub(crate) struct ProcessOutcome {
    pub result: Option<CallResult>,
    pub terminal: TerminalState,
    pub delivery: Delivery,
    pub usage: Usage,
    pub host_failure: Option<Arc<crate::extensions::host_calls::HostCallFailure>>,
}

struct CallResource {
    pending: Arc<PendingCall>,
    permit: Option<tokio::sync::OwnedSemaphorePermit>,
    released: bool,
}

impl ProcessClient {
    pub fn implementation(&self) -> &world_protocol::bindings::ImplementationRef {
        &self.session.implementation
    }
    pub fn config(&self) -> &world_protocol::api::PackageConfigView {
        &self.session.config
    }
    pub fn limits(&self) -> &world_protocol::package::PackageLimits {
        &self.session.limits
    }
    pub fn failure(&self) -> Option<Arc<ProcessError>> {
        self.session.failure()
    }
    pub(super) fn same_endpoint(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.session, &other.session)
    }

    pub async fn call(
        &self,
        context: &InvocationContext,
        hosts: Arc<HostCallContext>,
        request: SlotRequest,
        contract: ContractRef,
        deadline: Instant,
    ) -> Result<ProcessCall, Arc<ProcessError>> {
        if !hosts.matches(context) {
            return Err(Arc::new(ProcessError::Current(Arc::new(
                crate::extensions::invocation::CurrentFailure::Authorization(
                    crate::authorization::AuthError::Denied(
                        world_protocol::authorization::AuthorizationFailure::InsufficientScope,
                    ),
                ),
            ))));
        }
        let lease = context.lease();
        let node = context.node();
        let budget = context.budget().clone();
        let selected = lease
            .process(node)
            .ok_or_else(|| Arc::new(ProcessError::Closing))?;
        if !self.same_endpoint(selected) {
            return Err(Arc::new(ProcessError::Closing));
        }
        let binding = lease
            .graph()
            .node(node)
            .map_err(|_| Arc::new(ProcessError::Closing))?;
        if binding.implementation != self.session.implementation
            || binding.slot != request_slot(&request)
        {
            return Err(Arc::new(ProcessError::Protocol(
                ProcessFailure::HandshakeMismatch,
            )));
        }
        let mut matches = binding
            .ports
            .iter()
            .filter(|port| port.direction == PortDirection::Export && port.contract == contract);
        let method = matches.next().cloned().ok_or_else(|| {
            Arc::new(ProcessError::Protocol(ProcessFailure::ContractMismatch {
                contract_id: contract.id.clone(),
            }))
        })?;
        let expected = world_protocol::slots::request_port(&request)
            .map_err(|_| Arc::new(ProcessError::Protocol(ProcessFailure::HandshakeMismatch)))?;
        if matches.next().is_some() || method != expected {
            return Err(Arc::new(ProcessError::Protocol(
                ProcessFailure::HandshakeMismatch,
            )));
        }
        let now = world_protocol::time::Timestamp::try_new(chrono::Utc::now().to_rfc3339())
            .map_err(|_| Arc::new(ProcessError::Deadline))?;
        budget
            .restrict(&self.session.limits.budget, &now)
            .map_err(|cause| Arc::new(ProcessError::Budget(cause.dimension)))?;
        budget
            .charge(BudgetDimension::Steps, 1)
            .map_err(|cause| Arc::new(ProcessError::Budget(cause.dimension)))?;
        let timeout = std::time::Duration::from_millis(self.session.limits.call_timeout.0);
        let package_deadline = Instant::now()
            .checked_add(timeout)
            .ok_or_else(|| Arc::new(ProcessError::Deadline))?;
        let deadline = deadline.min(budget.deadline()).min(package_deadline);
        let ledger = lease
            .ledger(node)
            .cloned()
            .ok_or_else(|| Arc::new(ProcessError::Closing))?;
        let spec = lease
            .resource_spec(node, ResourceKind::ChildCall)
            .ok_or_else(|| Arc::new(ProcessError::Closing))?;
        let token = spec.token.clone();
        let ticket = ledger
            .begin_acquisition(
                AcquisitionId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID acquisition"),
                spec,
            )
            .map_err(|cause| Arc::new(ProcessError::Admission(cause)))?;
        let permit = match lease.try_call(node) {
            Ok(permit) => permit,
            Err(_) => {
                ticket.fail();
                return Err(Arc::new(ProcessError::BackpressureTimeout));
            }
        };
        let cancellation = ticket.cancellation().clone();
        let pending = PendingCall::new(
            &self.session,
            method,
            request,
            deadline,
            context.clone(),
            hosts,
            token,
            cancellation,
        );
        let local = match self.session.register_call(pending.clone()) {
            Ok(local) => local,
            Err(cause) => {
                ticket.fail();
                return Err(cause);
            }
        };
        pending.set_local(local);
        let acquired = ticket.complete(Box::new(CallResource {
            pending: pending.clone(),
            permit: Some(permit),
            released: false,
        }));
        let mut call = ProcessCall {
            pending,
            registration: Some(acquired.registration),
        };
        if acquired.must_release {
            call.pending.cancel_before_dispatch();
            call.close(deadline).await?;
            return Err(Arc::new(ProcessError::Closing));
        }
        let sent = timeout_at(
            deadline,
            self.session
                .calls
                .send(Outgoing::Call(call.pending.clone())),
        )
        .await;
        if !matches!(sent, Ok(Ok(()))) {
            call.pending.cancel_before_dispatch();
            call.close(deadline).await?;
            return Err(Arc::new(ProcessError::BackpressureTimeout));
        }
        Ok(call)
    }
}

impl ProcessCall {
    pub fn record_failure(&self, cause: Arc<ProcessError>) {
        self.pending.record_failure(cause);
    }

    pub fn delivery(&self) -> Delivery {
        self.pending.delivery()
    }

    /// Chunks are fragments of their stream's declared additional output schema, not SlotResponse.
    /// Credit is returned only when the consumer takes the bounded fragment.
    pub async fn next(&mut self) -> Result<Option<ProcessChunk>, Arc<ProcessError>> {
        self.next_inner()
            .await
            .map_err(|cause| self.call_error(cause))
    }

    async fn next_inner(&mut self) -> Result<Option<ProcessChunk>, Arc<ProcessError>> {
        loop {
            let notified = self.pending.changed.notified();
            if self.pending.released() {
                return Err(Arc::new(ProcessError::Closing));
            }
            if self.pending.has_chunks() {
                timeout_at(self.pending.deadline, self.pending.check_output())
                    .await
                    .map_err(|_| Arc::new(ProcessError::Deadline))??;
                let Some((chunk, credit)) = self.pending.pop() else {
                    continue;
                };
                if let Some(credit) = credit {
                    let session = self
                        .pending
                        .session
                        .upgrade()
                        .ok_or_else(|| Arc::new(ProcessError::TransportClosed))?;
                    session.control_frame(Frame::Credit(credit))?;
                }
                return Ok(Some(chunk));
            }
            if let Some(error) = self.pending.failure() {
                return Err(error);
            }
            if self.pending.outcome().is_some() {
                return Ok(None);
            }
            tokio::select! {
                biased;
                _ = self.pending.cancellation.cancelled() => return Err(Arc::new(ProcessError::CancelNotConfirmed)),
                result = timeout_at(self.pending.deadline, notified) => {
                    result.map_err(|_| Arc::new(ProcessError::Deadline))?;
                }
            }
        }
    }

    pub async fn finish(mut self) -> Result<ProcessOutcome, Arc<ProcessError>> {
        self.finish_inner()
            .await
            .map_err(|cause| self.call_error(cause))
    }

    async fn finish_inner(&mut self) -> Result<ProcessOutcome, Arc<ProcessError>> {
        let pending = self.pending.clone();
        loop {
            let notified = pending.changed.notified();
            if self.pending.released() {
                return Err(Arc::new(ProcessError::Closing));
            }
            if !self.pending.streams_consumed() {
                return Err(Arc::new(ProcessError::StreamsPending));
            }
            if let Some((result, terminal)) = self.pending.outcome() {
                timeout_at(self.pending.deadline, self.pending.check_output())
                    .await
                    .map_err(|_| Arc::new(ProcessError::Deadline))??;
                let outcome = ProcessOutcome {
                    result,
                    terminal,
                    delivery: self.pending.delivery(),
                    usage: self.pending.budget.usage(),
                    host_failure: self.pending.first_host_failure(),
                };
                if terminal == TerminalState::Retained {
                    return Ok(outcome);
                }
                self.close(self.pending.deadline).await?;
                return Ok(outcome);
            }
            if let Some(error) = self.pending.failure() {
                return Err(error);
            }
            timeout_at(self.pending.deadline, notified)
                .await
                .map_err(|_| Arc::new(ProcessError::Deadline))?;
        }
    }

    pub async fn cancel(
        mut self,
        deadline: Instant,
    ) -> Result<Option<ProcessOutcome>, Arc<ProcessError>> {
        self.pending.cancellation.cancel();
        self.close(deadline)
            .await
            .map_err(|cause| self.call_error(cause))?;
        let observed = self.observed();
        if observed.is_none() && self.pending.delivery() != Delivery::NotDispatched {
            return Err(self.call_error(
                self.pending
                    .failure()
                    .unwrap_or_else(|| Arc::new(ProcessError::Exited)),
            ));
        }
        Ok(observed)
    }

    fn observed(&self) -> Option<ProcessOutcome> {
        self.pending
            .outcome()
            .map(|(result, terminal)| ProcessOutcome {
                result,
                terminal,
                delivery: self.pending.delivery(),
                usage: self.pending.budget.usage(),
                host_failure: self.pending.first_host_failure(),
            })
    }

    fn call_error(&self, cause: Arc<ProcessError>) -> Arc<ProcessError> {
        self.pending.record_failure(cause.clone());
        let observed = self.observed().map(Arc::new);
        Arc::new(ProcessError::Call {
            delivery: self.pending.delivery(),
            received_result: if observed.is_none() {
                self.pending.received_result().map(Arc::new)
            } else {
                None
            },
            observed,
            cause,
        })
    }

    async fn close(&mut self, deadline: Instant) -> Result<(), Arc<ProcessError>> {
        let pending = self.pending.clone();
        loop {
            let notified = pending.changed.notified();
            if pending.remote_settled() {
                break;
            }
            timeout_at(deadline, notified)
                .await
                .map_err(|_| Arc::new(ProcessError::CancelNotConfirmed))?;
        }
        if let Some(registration) = self.registration.as_mut() {
            registration
                .close_checked(deadline)
                .await
                .map_err(|cause| Arc::new(ProcessError::Resource(cause)))?;
        }
        self.registration = None;
        Ok(())
    }
}

impl Drop for ProcessCall {
    fn drop(&mut self) {
        // Ownership remains in the ledger. The writer observes this request; ACK is not release.
        if self.registration.is_some() {
            self.pending.cancellation.cancel();
            if let Some(session) = self.pending.session.upgrade() {
                session.changed.notify_waiters();
            }
        }
    }
}

impl HostResource for CallResource {
    fn inspect_process(
        &self,
        ledger: &crate::extensions::invocation::ResourceLedger,
    ) -> Option<super::ProcessInspection> {
        Some(super::ProcessInspection::new(
            self.pending.clone(),
            self.pending.context()?,
            ledger.clone(),
        ))
    }

    fn close_checked(&mut self, deadline: Instant, control: CleanupControl) -> CleanupFuture<'_> {
        Box::pin(async move {
            if self.released {
                return Ok(());
            }
            self.pending.cancellation.cancel();
            if let Some(session) = self.pending.session.upgrade() {
                session.changed.notify_waiters();
            }
            loop {
                let notified = self.pending.changed.notified();
                if self.pending.remote_settled() {
                    self.pending.release();
                    self.permit = None;
                    self.released = true;
                    return Ok(());
                }
                if control.host_only() {
                    return Err(ResourceFailure::new(
                        ResourceStage::Cancel,
                        "process_call_retained",
                        "process exit or invocation terminal has not been confirmed",
                    ));
                }
                if timeout_at(deadline, notified).await.is_err() {
                    return Err(ResourceFailure::new(
                        ResourceStage::Cancel,
                        "process_cancel_not_confirmed",
                        "process cancellation has not reached a terminal state",
                    ));
                }
            }
        })
    }
}
