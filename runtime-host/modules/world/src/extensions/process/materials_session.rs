use std::sync::{Arc, Mutex};

use tokio::time::{Instant, timeout_at};
use tokio_util::sync::CancellationToken;
use world_protocol::{ids::Digest, process::{CallId, ProcessFailure}, wire};

use super::{
    error::ProcessError,
    materials_payload::{Receiving, Sending},
    materials_wire::{MaterialsFrame, Payload, Pdfium},
    session::{Outgoing, Session},
};
use crate::{extensions::invocation::CallBudget, materials::{MaterialRequest, MaterialResponse, WorkerFailure}};

#[derive(Clone)]
pub(crate) struct MaterialsClient { pub(super) session: Arc<Session> }

impl MaterialsClient {
    pub(crate) async fn invoke(&self, request: MaterialRequest, budget: CallBudget,
        cancellation: CancellationToken, deadline: Instant,
    ) -> Result<Result<MaterialResponse, WorkerFailure>, Arc<ProcessError>> {
        self.session.materials().expect("materials endpoint").invoke(&self.session, request, budget, cancellation, deadline).await
    }
    pub(crate) fn cancel(&self) { self.session.fail(Arc::new(ProcessError::Cancelled)); }
}

pub(super) struct MaterialsSession {
    pub(super) pdfium: Option<Pdfium>,
    pub(super) maximum_payload: u64,
    state: Mutex<State>,
}

struct State {
    pending: Option<CallId>,
    sending: Option<Sending>,
    receiving: Option<Receiving>,
    result: Option<Result<MaterialResponse, WorkerFailure>>,
    stopped: bool,
}

impl MaterialsSession {
    pub(super) fn new(pdfium: Option<Pdfium>, maximum_payload: u64) -> Self {
        Self { pdfium, maximum_payload, state: Mutex::new(State {
            pending: None, sending: None, receiving: None, result: None, stopped: false,
        }) }
    }

    pub(super) fn dispatch(&self, session: &Session, value: MaterialsFrame) -> Result<(), ProcessError> {
        let mut state = self.state.lock().expect("materials process state poisoned");
        match value {
            MaterialsFrame::Credit(credit) => {
                if state.pending.as_ref() != Some(&credit.id) { return Err(ProcessFailure::UnknownCorrelation.into()); }
                let sending = state.sending.as_mut().ok_or(ProcessFailure::SequenceMismatch)?;
                let frame = sending.credit(credit, session.maximum_frame())?;
                if matches!(frame, MaterialsFrame::End(_)) { state.sending = None; }
                send(session, frame)?;
            }
            MaterialsFrame::Result { id, payload } => {
                session.validate_id(&id)?;
                if state.pending.as_ref() != Some(&id) || state.sending.is_some() || state.receiving.is_some() || state.result.is_some() {
                    return Err(ProcessFailure::SequenceMismatch.into());
                }
                let schema = result_schema()?;
                let (receiving, credit) = Receiving::new(id, payload, &schema, self.maximum_payload)?;
                state.receiving = Some(receiving);
                send(session, MaterialsFrame::Credit(credit))?;
            }
            MaterialsFrame::Fragment(item) => {
                let credit = state.receiving.as_mut().ok_or(ProcessFailure::SequenceMismatch)?.fragment(item)?;
                send(session, MaterialsFrame::Credit(credit))?;
            }
            MaterialsFrame::End(end) => {
                let bytes = state.receiving.take().ok_or(ProcessFailure::SequenceMismatch)?.finish(end)?;
                state.result = Some(wire::decode(&bytes, usize::try_from(self.maximum_payload).unwrap_or(usize::MAX))
                    .map_err(super::frame::WireFailure::Codec)?);
                session.changed.notify_waiters();
            }
            MaterialsFrame::Stopped if state.pending.is_none() && !state.stopped => {
                state.stopped = true;
                session.changed.notify_waiters();
            }
            _ => return Err(ProcessFailure::UnexpectedDirection.into()),
        }
        Ok(())
    }

    pub(super) async fn invoke(
        &self, session: &Arc<Session>, request: MaterialRequest, budget: CallBudget,
        cancellation: CancellationToken, deadline: Instant,
    ) -> Result<Result<MaterialResponse, WorkerFailure>, Arc<ProcessError>> {
        if cancellation.is_cancelled() { return Err(Arc::new(ProcessError::Cancelled)); }
        budget.check().map_err(|cause| Arc::new(ProcessError::Budget(cause.dimension)))?;
        let package_deadline = Instant::now().checked_add(std::time::Duration::from_millis(session.limits.call_timeout.0))
            .ok_or_else(|| Arc::new(ProcessError::Deadline))?;
        let deadline = deadline.min(budget.deadline()).min(package_deadline);
        if Instant::now() >= deadline { return Err(Arc::new(ProcessError::Deadline)); }
        let maximum = self.maximum_payload;
        let bytes = super::materials_payload::encode(&request, maximum).map_err(Arc::new)?;
        if cancellation.is_cancelled() { return Err(Arc::new(ProcessError::Cancelled)); }
        if Instant::now() >= deadline { return Err(Arc::new(ProcessError::Deadline)); }
        let id = session.next_id().map_err(Arc::new)?;
        let payload = Payload { schema: request_schema().map_err(Arc::new)?,
            digest: world_protocol::schema::hash(&bytes).map_err(|_| Arc::new(ProcessError::Protocol(ProcessFailure::FrameMalformed)))?,
            size: bytes.len() as u64 };
        {
            let mut state = self.state.lock().expect("materials process state poisoned");
            if !session.is_ready() || session.is_closing() || state.pending.is_some() || state.stopped {
                return Err(Arc::new(ProcessError::Closing));
            }
            state.pending = Some(id.clone());
            state.sending = Some(Sending::new(id.clone(), bytes));
            if let Err(cause) = send(session, MaterialsFrame::Call { id, payload }) {
                let cause = Arc::new(cause);
                session.fail(cause.clone());
                return Err(cause);
            }
        }
        let mut guard = CancelCall { session: session.clone(), armed: true };
        let result = loop {
            let notified = session.changed.notified();
            if let Some(cause) = session.failure() { break Err(cause); }
            if cancellation.is_cancelled() { break Err(Arc::new(ProcessError::Cancelled)); }
            if Instant::now() >= deadline { break Err(Arc::new(ProcessError::Deadline)); }
            {
                let mut state = self.state.lock().expect("materials process state poisoned");
                if let Some(result) = state.result.take() {
                    state.pending = None;
                    break Ok(result);
                }
            }
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => break Err(Arc::new(ProcessError::Cancelled)),
                _ = session.cleanup.quarantined() => break Err(Arc::new(ProcessError::Quarantined)),
                next = timeout_at(deadline, notified) => if next.is_err() { break Err(Arc::new(ProcessError::Deadline)); },
            }
        };
        match &result {
            Ok(_) => {
                guard.armed = false;
                budget.check().map_err(|cause| Arc::new(ProcessError::Budget(cause.dimension)))?;
            }
            Err(cause) => {
                session.fail(cause.clone());
                guard.armed = false;
            }
        }
        result
    }

    pub(super) async fn stop(&self, session: &Session, deadline: Instant) -> Result<(), Arc<ProcessError>> {
        {
            let state = self.state.lock().expect("materials process state poisoned");
            if state.stopped { return Ok(()); }
            if state.pending.is_some() { return Err(Arc::new(ProcessError::Closing)); }
        }
        send(session, MaterialsFrame::Stop).map_err(Arc::new)?;
        loop {
            let notified = session.changed.notified();
            if self.state.lock().expect("materials process state poisoned").stopped { return Ok(()); }
            if let Some(cause) = session.failure() { return Err(cause); }
            timeout_at(deadline, notified).await.map_err(|_| Arc::new(ProcessError::CancelNotConfirmed))?;
        }
    }

    pub(super) fn stopped(&self) -> bool {
        self.state.lock().expect("materials process state poisoned").stopped
    }
}

struct CancelCall { session: Arc<Session>, armed: bool }
impl Drop for CancelCall {
    fn drop(&mut self) {
        if self.armed { self.session.fail(Arc::new(ProcessError::Cancelled)); }
    }
}

pub(super) fn send(session: &Session, value: MaterialsFrame) -> Result<(), ProcessError> {
    if session.cleanup.host_only() { return Err(ProcessError::Quarantined); }
    session.control.try_send(Outgoing::Materials(value)).map_err(|_| ProcessError::BackpressureTimeout)
}

pub(super) fn request_schema() -> Result<Digest, ProcessError> {
    crate::materials::material_request_schema().and_then(|bytes| world_protocol::schema::hash(&bytes))
        .map_err(|_| ProcessFailure::FrameMalformed.into())
}
pub(super) fn result_schema() -> Result<Digest, ProcessError> {
    crate::materials::material_result_schema().and_then(|bytes| world_protocol::schema::hash(&bytes))
        .map_err(|_| ProcessFailure::FrameMalformed.into())
}
