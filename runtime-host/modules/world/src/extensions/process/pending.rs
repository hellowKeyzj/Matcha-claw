use std::sync::{
    Arc, Mutex, MutexGuard, Weak,
    atomic::{AtomicU64, Ordering},
};

use tokio::sync::Notify;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    bindings::MethodPort,
    process::{self, CallId, CallResult, Frame, ProcessFailure, Terminal, TerminalState},
    slots::{SlotRequest, failure_slot, response_port},
};

use super::{
    error::{Delivery, ProcessError},
    session::Session,
    streams::{ProcessChunk, Streams},
};
use crate::extensions::{
    host_calls::HostCallContext,
    invocation::{CallBudget, InvocationContext},
};

pub(super) struct PendingCall {
    pub(super) method: MethodPort,
    slot: world_protocol::bindings::SlotKind,
    pub(super) request: SlotRequest,
    pub(super) deadline: Instant,
    pub(super) budget: CallBudget,
    pub(super) cancellation: CancellationToken,
    pub(super) changed: Notify,
    pub(super) session: Weak<Session>,
    local: AtomicU64,
    context: Mutex<Option<InvocationContext>>,
    hosts: Mutex<Option<Arc<HostCallContext>>>,
    pub(super) token: world_protocol::ids::ResourceToken,
    state: Mutex<State>,
}

struct State {
    dispatch_pending: bool,
    id: Option<CallId>,
    delivery: Delivery,
    cancel_sent: Option<world_protocol::ids::RequestId>,
    cancel_deadline: Option<Instant>,
    cancel_acknowledged: bool,
    remote_settled: bool,
    released: bool,
    released_streams_consumed: bool,
    result: Option<CallResult>,
    terminal: Option<TerminalState>,
    failure: Option<Arc<ProcessError>>,
    host_failure: Option<Arc<crate::extensions::host_calls::HostCallFailure>>,
    streams: Streams,
}

impl PendingCall {
    pub(super) fn new(
        session: &Arc<Session>,
        method: MethodPort,
        request: SlotRequest,
        deadline: Instant,
        context: InvocationContext,
        hosts: Arc<HostCallContext>,
        token: world_protocol::ids::ResourceToken,
        cancellation: CancellationToken,
    ) -> Arc<Self> {
        Arc::new(Self {
            method,
            slot: world_protocol::slots::request_slot(&request),
            request,
            deadline,
            budget: context.budget().clone(),
            cancellation,
            changed: Notify::new(),
            session: Arc::downgrade(session),
            local: AtomicU64::new(0),
            context: Mutex::new(Some(context)),
            hosts: Mutex::new(Some(hosts)),
            token,
            state: Mutex::new(State {
                dispatch_pending: true,
                id: None,
                delivery: Delivery::NotDispatched,
                cancel_sent: None,
                cancel_deadline: None,
                cancel_acknowledged: false,
                remote_settled: false,
                released: false,
                released_streams_consumed: false,
                result: None,
                terminal: None,
                failure: None,
                host_failure: None,
                streams: Streams::new(),
            }),
        })
    }

    pub(super) fn set_local(&self, value: u64) {
        self.local.store(value, Ordering::Release);
    }
    pub(super) fn local(&self) -> u64 {
        self.local.load(Ordering::Acquire)
    }
    pub(super) fn delivery(&self) -> Delivery {
        self.state().delivery
    }
    pub(super) fn remote_settled(&self) -> bool {
        self.state().remote_settled
    }
    pub(super) fn failure(&self) -> Option<Arc<ProcessError>> {
        self.state().failure.clone()
    }
    pub(super) fn id(&self) -> Option<CallId> {
        self.state().id.clone()
    }
    pub(super) fn context(&self) -> Option<InvocationContext> {
        self.context
            .lock()
            .expect("process call context poisoned")
            .clone()
    }

    pub(super) fn host_failure(&self, cause: Arc<crate::extensions::host_calls::HostCallFailure>) {
        self.state().host_failure.get_or_insert(cause);
    }

    pub(super) fn first_host_failure(
        &self,
    ) -> Option<Arc<crate::extensions::host_calls::HostCallFailure>> {
        self.state().host_failure.clone()
    }

    pub(super) fn hosts(&self) -> Option<Arc<HostCallContext>> {
        self.hosts
            .lock()
            .expect("process host context poisoned")
            .clone()
    }

    pub(super) fn accepts_host_call(&self) -> bool {
        let state = self.state();
        state.delivery == Delivery::Accepted && state.terminal.is_none() && !state.released
    }

    pub(super) fn observe_cancellation(&self) {
        let cancelled = self.context().is_some_and(|context| {
            context.pipeline().is_cancelled()
                || context
                    .lease()
                    .cancellation(context.node())
                    .is_some_and(CancellationToken::is_cancelled)
        });
        if cancelled || Instant::now() >= self.deadline {
            self.cancellation.cancel();
        }
    }

    pub(super) async fn check_current(&self) -> Result<(), Arc<ProcessError>> {
        self.budget
            .check()
            .map_err(|cause| Arc::new(ProcessError::Budget(cause.dimension)))?;
        let context = self
            .context()
            .ok_or_else(|| Arc::new(ProcessError::Closing))?;
        context
            .check_current()
            .await
            .map_err(|cause| Arc::new(ProcessError::Current(Arc::new(cause))))
    }

    pub(super) async fn check_output(&self) -> Result<(), Arc<ProcessError>> {
        self.check_current().await?;
        let context = self
            .context()
            .ok_or_else(|| Arc::new(ProcessError::Closing))?;
        context
            .check_output(self.budget.usage().bytes)
            .await
            .map_err(|cause| Arc::new(ProcessError::Output(Arc::new(cause))))
    }

    pub(super) fn take_request(&self, id: CallId) -> Option<SlotRequest> {
        let mut state = self.state();
        if state.remote_settled
            || self.cancellation.is_cancelled()
            || Instant::now() >= self.deadline
        {
            state.remote_settled = true;
            state
                .failure
                .get_or_insert_with(|| Arc::new(ProcessError::Deadline));
            state.dispatch_pending = false;
            drop(state);
            self.notify();
            return None;
        }
        if !state.dispatch_pending {
            return None;
        }
        state.id = Some(id);
        state.dispatch_pending = false;
        Some(self.request.clone())
    }

    /// Called under the session's dispatch gate immediately before attempting a write.
    pub(super) fn attempted(&self) -> bool {
        let mut state = self.state();
        if state.remote_settled
            || self.cancellation.is_cancelled()
            || Instant::now() >= self.deadline
        {
            return false;
        }
        state.delivery = Delivery::Attempted;
        true
    }

    pub(super) fn accepted(&self) -> Result<(), ProcessError> {
        let mut state = self.state();
        if state.delivery != Delivery::Attempted
            || state.terminal.is_some()
            || state.result.is_some()
        {
            return Err(ProcessFailure::SequenceMismatch.into());
        }
        state.delivery = Delivery::Accepted;
        Ok(())
    }

    pub(super) fn result(&self, result: CallResult) -> Result<(), ProcessError> {
        let mut state = self.state();
        if state.delivery != Delivery::Accepted
            || state.result.is_some()
            || state.terminal.is_some()
        {
            return Err(ProcessFailure::SequenceMismatch.into());
        }
        let matches = match &result.result {
            Ok(response) => {
                response_port(response).map_err(|_| ProcessFailure::HandshakeMismatch)?
                    == self.method
            }
            Err(failure) => failure_slot(&failure.details) == self.slot,
        };
        if !matches {
            return Err(ProcessFailure::HandshakeMismatch.into());
        }
        state.result = Some(result);
        drop(state);
        self.notify();
        Ok(())
    }

    pub(super) fn terminal(&self, terminal: Terminal) -> Result<(), ProcessError> {
        let mut state = self.state();
        if state.delivery != Delivery::Accepted
            || state.terminal.is_some()
            || !state.streams.remote_ended()
            || terminal.last_sequence.is_some()
            || (matches!(
                terminal.state,
                TerminalState::Completed | TerminalState::Failed
            ) && state.result.is_none())
        {
            return Err(ProcessFailure::SequenceMismatch.into());
        }
        if terminal.state == TerminalState::Completed
            && (!state.streams.completed()
                || state
                    .result
                    .as_ref()
                    .is_some_and(|result| result.result.is_err()))
        {
            return Err(ProcessFailure::SequenceMismatch.into());
        }
        if terminal.state == TerminalState::Failed
            && state
                .result
                .as_ref()
                .is_some_and(|result| result.result.is_ok())
        {
            return Err(ProcessFailure::SequenceMismatch.into());
        }
        state.terminal = Some(terminal.state);
        state.remote_settled = terminal.state != TerminalState::Retained;
        state.delivery = Delivery::Terminal;
        drop(state);
        self.notify();
        Ok(())
    }

    pub(super) fn stream_open(
        &self,
        open: process::StreamOpen,
    ) -> Result<process::Credit, ProcessError> {
        let state = self.state();
        if state.delivery != Delivery::Accepted || state.terminal.is_some() {
            return Err(ProcessFailure::SequenceMismatch.into());
        }
        // Additional output schemas have no declaration/codec producer yet.
        let _ = open;
        Err(ProcessFailure::ContractMismatch {
            contract_id: self.method.contract.id.clone(),
        }
        .into())
    }
    pub(super) fn stream_item(&self, item: process::StreamItem) -> Result<(), ProcessError> {
        let mut state = self.state();
        if state.terminal.is_some() {
            return Err(ProcessFailure::SequenceMismatch.into());
        }
        self.budget
            .charge(
                world_protocol::budget::BudgetDimension::Bytes,
                item.bytes.len() as u64,
            )
            .map_err(|cause| ProcessError::Budget(cause.dimension))?;
        state.streams.push(item)?;
        drop(state);
        self.notify();
        Ok(())
    }
    pub(super) fn stream_end(&self, end: process::StreamEnd) -> Result<(), ProcessError> {
        self.state().streams.end(end)?;
        self.notify();
        Ok(())
    }

    pub(super) fn pop(&self) -> Option<(ProcessChunk, Option<process::Credit>)> {
        self.state().streams.pop()
    }
    pub(super) fn released(&self) -> bool {
        self.state().released
    }
    pub(super) fn has_chunks(&self) -> bool {
        !self.state().streams.consumed()
    }
    pub(super) fn streams_consumed(&self) -> bool {
        self.state().streams.consumed()
    }
    pub(super) fn received_result(&self) -> Option<CallResult> {
        self.state().result.clone()
    }

    pub(super) fn inspection_snapshot(&self) -> super::inspection::ProcessSnapshot {
        let state = self.state();
        let usage = self.budget.usage();
        super::inspection::ProcessSnapshot {
            outcome: state.terminal.map(|terminal| super::ProcessOutcome {
                result: state.result.clone(),
                terminal,
                delivery: state.delivery,
                usage: usage.clone(),
                host_failure: state.host_failure.clone(),
            }),
            received_result: state.result.clone(),
            delivery: state.delivery,
            usage,
            host_failure: state.host_failure.clone(),
            failure: state.failure.clone(),
            released: state.released,
            streams_consumed: if state.released {
                state.released_streams_consumed
            } else {
                state.streams.consumed()
            },
            cleanup: None,
            settled: false,
        }
    }

    pub(super) fn outcome(&self) -> Option<(Option<CallResult>, TerminalState)> {
        let state = self.state();
        state
            .terminal
            .map(|terminal| (state.result.clone(), terminal))
    }

    pub(super) fn record_failure(&self, error: Arc<ProcessError>) {
        self.state().failure.get_or_insert(error);
    }

    pub(super) fn fail(&self, error: Arc<ProcessError>) {
        let mut state = self.state();
        state.failure.get_or_insert(error);
        if state.delivery == Delivery::NotDispatched {
            state.dispatch_pending = false;
            state.remote_settled = true;
        }
        drop(state);
        self.notify();
    }

    pub(super) fn cancel_before_dispatch(&self) {
        let mut state = self.state();
        if state.delivery == Delivery::NotDispatched {
            state.remote_settled = true;
            state.dispatch_pending = false;
            state
                .failure
                .get_or_insert_with(|| Arc::new(ProcessError::Closing));
        }
        drop(state);
        self.notify();
    }

    pub(super) fn cancel_frame(&self) -> Result<Option<Frame>, ProcessError> {
        self.observe_cancellation();
        {
            let mut state = self.state();
            if state.remote_settled
                || state.cancel_sent.is_some()
                || (!self.cancellation.is_cancelled() && Instant::now() < self.deadline)
            {
                return Ok(None);
            }
            if state.delivery == Delivery::NotDispatched {
                state.remote_settled = true;
                state.dispatch_pending = false;
                state
                    .failure
                    .get_or_insert_with(|| Arc::new(ProcessError::Deadline));
                drop(state);
                self.notify();
                return Ok(None);
            }
        }
        // The writer is the only allocator. Never hold a call lock while taking the session lock.
        let session = self
            .session
            .upgrade()
            .ok_or(ProcessError::TransportClosed)?;
        let cancellation_id = session.next_id()?.request_id;
        let mut state = self.state();
        if state.remote_settled {
            return Ok(None);
        }
        let Some(id) = state.id.clone() else {
            return Ok(None);
        };
        state.cancel_sent = Some(cancellation_id.clone());
        state.cancel_deadline = Some(Instant::now() + super::session::CONTROL_TIMEOUT);
        Ok(Some(Frame::Cancel(process::Cancel {
            id,
            cancellation_id,
        })))
    }

    pub(super) fn cancel_expired(&self) -> bool {
        let state = self.state();
        (!state.remote_settled || !state.cancel_acknowledged)
            && state
                .cancel_deadline
                .is_some_and(|deadline| Instant::now() >= deadline)
    }

    pub(super) fn unacknowledged_cancel(
        &self,
    ) -> Option<(
        world_protocol::ids::RequestId,
        (world_protocol::ids::RequestId, Instant),
    )> {
        let state = self.state();
        if state.cancel_acknowledged {
            return None;
        }
        Some((
            state.id.as_ref()?.request_id.clone(),
            (state.cancel_sent.clone()?, state.cancel_deadline?),
        ))
    }

    pub(super) fn cancel_ack(
        &self,
        acknowledgement: process::CancelAck,
    ) -> Result<(), ProcessError> {
        let mut state = self.state();
        if state.cancel_sent.as_ref() != Some(&acknowledgement.cancellation_id)
            || state.cancel_acknowledged
        {
            return Err(ProcessFailure::UnknownCorrelation.into());
        }
        state.cancel_acknowledged = true;
        // An acknowledgement neither settles a call nor proves cancellation of effects.
        Ok(())
    }

    pub(super) fn confirmed_exit(&self) {
        let mut state = self.state();
        state.remote_settled = true;
        if state.terminal.is_none() {
            state
                .failure
                .get_or_insert_with(|| Arc::new(ProcessError::Exited));
        }
        drop(state);
        self.notify();
    }

    pub(super) fn release(&self) {
        {
            let mut state = self.state();
            state.released_streams_consumed = state.streams.consumed();
            state.released = true;
            state.dispatch_pending = false;
            // Keep the one bounded result until the call handle drops, including concurrent ledger cleanup.
            state.streams = Streams::new();
        }
        self.context
            .lock()
            .expect("process call context poisoned")
            .take();
        self.hosts
            .lock()
            .expect("process host context poisoned")
            .take();
        if let Some(session) = self.session.upgrade() {
            session.remove_call(self.local());
        }
    }

    fn notify(&self) {
        self.changed.notify_waiters();
        if let Some(session) = self.session.upgrade() {
            session.changed.notify_waiters();
        }
    }
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().expect("process pending call poisoned")
    }
}
