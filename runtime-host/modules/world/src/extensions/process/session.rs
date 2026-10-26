use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use tokio::{
    sync::{Notify, mpsc, watch},
    time::{Instant, timeout_at},
};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    api::PackageConfigView,
    bindings::{ImplementationRef, MethodPort, SlotKind},
    ids::{PluginGenerationId, RequestId, Sequence},
    lifecycle::LifecycleOperation,
    process::{self, CallId, Endpoint, Frame, ProcessFailure, SystemMethod, SystemValue},
};

use super::{error::ProcessError, host_io::HostIo, pending::PendingCall};
use crate::extensions::invocation::CleanupControl;

pub(super) const MAX_INFLIGHT: usize = 16;
pub(super) const CONTROL_CAPACITY: usize = 256;
pub(super) const CONTROL_TIMEOUT: Duration = Duration::from_secs(2);

pub(super) enum Outgoing {
    Frame(Frame),
    Materials(super::materials_wire::MaterialsFrame),
    Call(Arc<PendingCall>),
    System {
        method: SystemMethod,
        response: Arc<SystemReply>,
    },
    Drain {
        operation: LifecycleOperation,
        response: Arc<SystemReply>,
    },
}

pub(super) struct SystemReply {
    pub(super) deadline: Instant,
    pub(super) value: Mutex<Option<Result<SystemValue, Arc<ProcessError>>>>,
    pub(super) changed: Notify,
}

impl SystemReply {
    fn new(deadline: Instant) -> Arc<Self> {
        Arc::new(Self {
            deadline,
            value: Mutex::new(None),
            changed: Notify::new(),
        })
    }

    pub(super) fn complete(&self, result: Result<SystemValue, Arc<ProcessError>>) {
        *self.value.lock().expect("process system reply poisoned") = Some(result);
        self.changed.notify_waiters();
    }

    async fn wait(&self) -> Result<SystemValue, Arc<ProcessError>> {
        loop {
            let notified = self.changed.notified();
            if let Some(value) = self
                .value
                .lock()
                .expect("process system reply poisoned")
                .clone()
            {
                return value;
            }
            timeout_at(self.deadline, notified)
                .await
                .map_err(|_| Arc::new(ProcessError::Deadline))?;
        }
    }
}

pub(super) enum SessionKind {
    Binding(SlotKind),
    Materials(super::materials_session::MaterialsSession),
}

pub(super) struct Session {
    pub(super) implementation: ImplementationRef,
    pub(super) config: PackageConfigView,
    pub(super) methods: Vec<MethodPort>,
    pub(super) kind: SessionKind,
    pub(super) limits: world_protocol::package::PackageLimits,
    pub(super) host_io_timeout: Duration,
    pub(super) generation: PluginGenerationId,
    pub(super) cleanup: CleanupControl,
    pub(super) control: mpsc::Sender<Outgoing>,
    pub(super) calls: mpsc::Sender<Outgoing>,
    pub(super) closed: CancellationToken,
    pub(super) changed: Notify,
    pub(super) status: watch::Sender<IoStatus>,
    state: Mutex<State>,
}

pub(super) struct Receivers {
    pub(super) control: mpsc::Receiver<Outgoing>,
    pub(super) calls: mpsc::Receiver<Outgoing>,
}

#[derive(Clone, Default)]
pub(super) struct IoStatus {
    pub(super) reader_done: bool,
    pub(super) writer_done: bool,
    pub(super) stderr_done: bool,
    pub(super) failed: bool,
}

struct State {
    ready: bool,
    closing: bool,
    maximum_frame: usize,
    maximum_inflight: usize,
    next_sequence: u64,
    next_local: u64,
    failure: Option<Arc<ProcessError>>,
    calls: BTreeMap<u64, Arc<PendingCall>>,
    correlation: BTreeMap<RequestId, u64>,
    systems: BTreeMap<RequestId, (SystemMethod, Arc<SystemReply>)>,
    cancelled: BTreeMap<RequestId, (RequestId, Instant)>,
    driver_sequence: u64,
    hosts: BTreeMap<RequestId, Arc<HostIo>>,
}

impl Session {
    pub(super) fn new(
        implementation: ImplementationRef,
        config: PackageConfigView,
        methods: Vec<MethodPort>,
        kind: SessionKind,
        limits: world_protocol::package::PackageLimits,
        host_io_timeout: Duration,
        generation: PluginGenerationId,
        cleanup: CleanupControl,
    ) -> (Arc<Self>, Receivers) {
        let (control, control_rx) = mpsc::channel(CONTROL_CAPACITY);
        let (calls, call_rx) = mpsc::channel(MAX_INFLIGHT);
        let (status, _) = watch::channel(IoStatus::default());
        (
            Arc::new(Self {
                implementation,
                config,
                methods,
                kind,
                limits,
                host_io_timeout,
                generation,
                cleanup,
                control,
                calls,
                closed: CancellationToken::new(),
                changed: Notify::new(),
                status,
                state: Mutex::new(State {
                    ready: false,
                    closing: false,
                    maximum_frame: process::MAX_FRAME_BYTES,
                    maximum_inflight: MAX_INFLIGHT,
                    next_sequence: 0,
                    next_local: 0,
                    failure: None,
                    calls: BTreeMap::new(),
                    correlation: BTreeMap::new(),
                    systems: BTreeMap::new(),
                    cancelled: BTreeMap::new(),
                    driver_sequence: 0,
                    hosts: BTreeMap::new(),
                }),
            }),
            Receivers {
                control: control_rx,
                calls: call_rx,
            },
        )
    }

    pub(super) fn materials(&self) -> Option<&super::materials_session::MaterialsSession> {
        match &self.kind { SessionKind::Materials(materials) => Some(materials), _ => None }
    }

    pub(super) fn slots(&self) -> Vec<SlotKind> {
        match &self.kind { SessionKind::Binding(slot) => vec![*slot], SessionKind::Materials(_) => Vec::new() }
    }

    pub(super) fn maximum_frame(&self) -> usize {
        self.state().maximum_frame
    }
    pub(super) fn is_ready(&self) -> bool {
        self.state().ready
    }
    pub(super) fn is_closing(&self) -> bool {
        self.state().closing
    }

    pub(super) fn select_limits(
        &self,
        frame: u32,
        inflight: u32,
    ) -> Result<(u32, u32), ProcessError> {
        if frame == 0 || inflight == 0 || self.limits.maximum_frame_bytes == 0 {
            return Err(ProcessFailure::HandshakeMismatch.into());
        }
        let mut state = self.state();
        state.maximum_frame = (frame as usize)
            .min(process::MAX_FRAME_BYTES)
            .min(usize::try_from(self.limits.maximum_frame_bytes).unwrap_or(usize::MAX));
        state.maximum_inflight = (inflight as usize).min(MAX_INFLIGHT);
        Ok((state.maximum_frame as u32, state.maximum_inflight as u32))
    }

    pub(super) fn ready(&self) {
        self.state().ready = true;
        self.changed.notify_waiters();
    }

    pub(super) async fn wait_ready(&self, deadline: Instant) -> Result<(), Arc<ProcessError>> {
        loop {
            let notified = self.changed.notified();
            {
                let state = self.state();
                if let Some(error) = &state.failure {
                    return Err(error.clone());
                }
                if state.ready {
                    return Ok(());
                }
            }
            timeout_at(deadline, notified)
                .await
                .map_err(|_| Arc::new(ProcessError::Protocol(ProcessFailure::HandshakeTimeout)))?;
        }
    }

    pub(super) fn failure(&self) -> Option<Arc<ProcessError>> {
        self.state().failure.clone()
    }

    pub(super) fn fail(&self, cause: Arc<ProcessError>) {
        let (calls, systems) = {
            let mut state = self.state();
            if state.failure.is_some() {
                return;
            }
            state.failure = Some(cause.clone());
            state.closing = true;
            (
                state.calls.values().cloned().collect::<Vec<_>>(),
                state
                    .systems
                    .values()
                    .map(|(_, reply)| reply.clone())
                    .collect::<Vec<_>>(),
            )
        };
        for call in calls {
            call.fail(cause.clone());
        }
        for reply in systems {
            reply.complete(Err(cause.clone()));
        }
        self.status.send_modify(|status| status.failed = true);
        self.closed.cancel();
        self.changed.notify_waiters();
    }

    pub(super) fn next_id(&self) -> Result<CallId, ProcessError> {
        let mut state = self.state();
        let sequence = state
            .next_sequence
            .checked_add(1)
            .ok_or(ProcessFailure::InvalidRequestId)?;
        state.next_sequence = sequence;
        Ok(CallId {
            initiator: Endpoint::Host,
            generation_id: self.generation.clone(),
            request_id: process::request_id(Endpoint::Host, Sequence(sequence))?,
        })
    }

    pub(super) fn register_call(&self, call: Arc<PendingCall>) -> Result<u64, Arc<ProcessError>> {
        let mut state = self.state();
        if let Some(error) = &state.failure {
            return Err(error.clone());
        }
        if !state.ready || state.closing {
            return Err(Arc::new(ProcessError::Closing));
        }
        if state.calls.len() + state.cancelled.len() >= state.maximum_inflight {
            return Err(Arc::new(ProcessError::BackpressureTimeout));
        }
        let local = state
            .next_local
            .checked_add(1)
            .ok_or_else(|| Arc::new(ProcessError::Protocol(ProcessFailure::InvalidRequestId)))?;
        state.next_local = local;
        state.calls.insert(local, call);
        Ok(local)
    }

    pub(super) fn begin_dispatch(&self, call: &PendingCall, id: &CallId) -> bool {
        let mut state = self.state();
        if state.closing || !call.attempted() {
            return false;
        }
        state
            .correlation
            .insert(id.request_id.clone(), call.local());
        true
    }

    pub(super) fn cutoff(&self) -> Sequence {
        Sequence(self.state().next_sequence)
    }

    pub(super) fn call(&self, id: &CallId) -> Result<Arc<PendingCall>, ProcessError> {
        self.validate_id(id)?;
        let state = self.state();
        let local = state
            .correlation
            .get(&id.request_id)
            .ok_or(ProcessFailure::UnknownCorrelation)?;
        state
            .calls
            .get(local)
            .cloned()
            .ok_or_else(|| ProcessFailure::UnknownCorrelation.into())
    }

    pub(super) fn admit_host(&self, id: &CallId) -> Result<(), ProcessError> {
        if id.initiator != Endpoint::Driver || id.generation_id != self.generation {
            return Err(ProcessFailure::UnexpectedDirection.into());
        }
        let sequence = process::request_sequence(id)?.0;
        let mut state = self.state();
        if sequence <= state.driver_sequence {
            return Err(ProcessFailure::DuplicateRequest.into());
        }
        if state.hosts.len() >= state.maximum_inflight {
            return Err(ProcessError::BackpressureTimeout);
        }
        if state.failure.is_some() || self.cleanup.host_only() {
            return Err(ProcessError::Closing);
        }
        state.driver_sequence = sequence;
        Ok(())
    }

    pub(super) fn add_host(&self, io: Arc<HostIo>) {
        self.state().hosts.insert(io.request_id().clone(), io);
    }

    pub(super) fn remove_host(&self, id: &RequestId) {
        self.state().hosts.remove(id);
        self.changed.notify_waiters();
    }

    pub(super) fn host_calls(&self) -> Vec<Arc<HostIo>> {
        self.state().hosts.values().cloned().collect()
    }

    pub(super) async fn terminal(&self, terminal: process::Terminal) -> Result<(), ProcessError> {
        let parent = self.call(&terminal.id)?;
        for io in self
            .host_calls()
            .into_iter()
            .filter(|io| Arc::ptr_eq(&io.parent, &parent))
        {
            io.wait_written().await?;
        }
        parent.terminal(terminal)
    }

    pub(super) fn remove_call(&self, local: u64) {
        let mut state = self.state();
        if let Some(call) = state.calls.remove(&local) {
            if let Some((request, cancellation)) = call.unacknowledged_cancel() {
                state.cancelled.insert(request, cancellation);
            }
        }
        state.correlation.retain(|_, value| *value != local);
        drop(state);
        self.changed.notify_waiters();
    }

    pub(super) fn cancel_ack(&self, ack: process::CancelAck) -> Result<(), ProcessError> {
        self.validate_id(&ack.id)?;
        let mut state = self.state();
        if let Some(expected) = state.cancelled.get(&ack.id.request_id) {
            if expected.0 != ack.cancellation_id {
                return Err(ProcessFailure::UnknownCorrelation.into());
            }
            state.cancelled.remove(&ack.id.request_id);
            return Ok(());
        }
        let call = state
            .correlation
            .get(&ack.id.request_id)
            .and_then(|local| state.calls.get(local))
            .ok_or(ProcessFailure::UnknownCorrelation)?;
        call.cancel_ack(ack)
    }

    pub(super) fn cancel_expired(&self) -> bool {
        let state = self.state();
        state
            .cancelled
            .values()
            .any(|(_, deadline)| Instant::now() >= *deadline)
            || state.calls.values().any(|call| call.cancel_expired())
    }

    pub(super) fn orderly_eof(&self) -> bool {
        if let Some(materials) = self.materials() { return materials.stopped(); }
        let calls = {
            let state = self.state();
            if !state.closing
                || !state.systems.is_empty()
                || !state.cancelled.is_empty()
                || !state.hosts.is_empty()
            {
                return false;
            }
            state.calls.values().cloned().collect::<Vec<_>>()
        };
        calls.iter().all(|call| call.remote_settled())
    }

    pub(super) fn validate_id(&self, id: &CallId) -> Result<(), ProcessError> {
        if id.initiator != Endpoint::Host || id.generation_id != self.generation {
            return Err(ProcessFailure::UnexpectedDirection.into());
        }
        process::request_sequence(id)?;
        Ok(())
    }

    pub(super) fn add_system(
        &self,
        id: &CallId,
        method: SystemMethod,
        reply: Arc<SystemReply>,
    ) -> Result<(), ProcessError> {
        let mut state = self.state();
        if state.systems.len() >= MAX_INFLIGHT {
            return Err(ProcessError::BackpressureTimeout);
        }
        state.systems.insert(id.request_id.clone(), (method, reply));
        Ok(())
    }

    pub(super) fn system_result(&self, result: process::SystemResult) -> Result<(), ProcessError> {
        self.validate_id(&result.id)?;
        let (method, reply) = self
            .state()
            .systems
            .remove(&result.id.request_id)
            .ok_or(ProcessFailure::UnknownCorrelation)?;
        if let Ok(value) = &result.result {
            let valid = match (&method, value) {
                (
                    SystemMethod::Describe,
                    SystemValue::Description {
                        contracts,
                        methods,
                        slots,
                    },
                ) => {
                    contracts == &self.implementation.contracts
                        && methods == &self.methods
                        && slots == &self.slots()
                }
                (SystemMethod::Health, SystemValue::Health { .. }) => true,
                (
                    SystemMethod::Prepare {
                        activation_lock_id: expected,
                    },
                    SystemValue::Prepared { activation_lock_id },
                ) => expected == activation_lock_id,
                (SystemMethod::Start, SystemValue::Started) => true,
                (
                    SystemMethod::Drain {
                        cutoff: expected, ..
                    },
                    SystemValue::Drained { cutoff },
                ) => expected == cutoff,
                (SystemMethod::Stop { .. }, SystemValue::StopAcknowledged) => true,
                (
                    SystemMethod::Checkpoint { format: expected },
                    SystemValue::Checkpoint { format, .. },
                ) => expected == format,
                _ => false,
            };
            if !valid {
                let cause = Arc::new(ProcessError::Protocol(ProcessFailure::SequenceMismatch));
                reply.complete(Err(cause.clone()));
                return Err(ProcessFailure::SequenceMismatch.into());
            }
        }
        reply.complete(
            result
                .result
                .map_err(|cause| Arc::new(ProcessError::Protocol(cause))),
        );
        Ok(())
    }

    pub(super) fn control_frame(&self, frame: Frame) -> Result<(), Arc<ProcessError>> {
        if self.cleanup.host_only() {
            return Err(Arc::new(ProcessError::Quarantined));
        }
        self.control.try_send(Outgoing::Frame(frame)).map_err(|_| {
            let cause = Arc::new(ProcessError::BackpressureTimeout);
            self.fail(cause.clone());
            cause
        })
    }

    pub(super) async fn system(
        &self,
        method: SystemMethod,
        deadline: Instant,
    ) -> Result<SystemValue, Arc<ProcessError>> {
        if self.cleanup.host_only() {
            return Err(Arc::new(ProcessError::Quarantined));
        }
        if let Some(error) = self.failure() {
            return Err(error);
        }
        let response = SystemReply::new(deadline);
        self.send_system(
            Outgoing::System {
                method,
                response: response.clone(),
            },
            response,
        )
        .await
    }

    async fn send_system(
        &self,
        outgoing: Outgoing,
        response: Arc<SystemReply>,
    ) -> Result<SystemValue, Arc<ProcessError>> {
        tokio::select! {
            biased;
            _ = self.cleanup.quarantined() => return Err(Arc::new(ProcessError::Quarantined)),
            result = timeout_at(response.deadline, self.control.send(outgoing)) => {
                result.map_err(|_| Arc::new(ProcessError::BackpressureTimeout))?
                    .map_err(|_| Arc::new(ProcessError::TransportClosed))?;
            }
        }
        tokio::select! {
            biased;
            _ = self.cleanup.quarantined() => Err(Arc::new(ProcessError::Quarantined)),
            result = response.wait() => result,
        }
    }

    pub(super) async fn drain(
        &self,
        operation: LifecycleOperation,
        deadline: Instant,
    ) -> Result<(), Arc<ProcessError>> {
        self.state().closing = true;
        if let Some(materials) = self.materials() { return materials.stop(self, deadline).await; }
        // A dispatch already marked Attempted belongs before the writer-owned cutoff.
        // Queued calls are settled locally; no caller can race them back into dispatch.
        for call in self.pending_calls() {
            call.cancel_before_dispatch();
        }
        if let Some(cause) = self.failure() {
            return Err(cause);
        }
        let response = SystemReply::new(deadline);
        match self
            .send_system(
                Outgoing::Drain {
                    operation,
                    response: response.clone(),
                },
                response,
            )
            .await?
        {
            SystemValue::Drained { .. } => {}
            _ => {
                return Err(Arc::new(ProcessError::Protocol(
                    ProcessFailure::SequenceMismatch,
                )));
            }
        }
        loop {
            let notified = self.changed.notified();
            if self.host_calls().is_empty()
                && self
                    .pending_calls()
                    .iter()
                    .all(|call| call.remote_settled())
            {
                return Ok(());
            }
            tokio::select! {
                biased;
                _ = self.cleanup.quarantined() => return Err(Arc::new(ProcessError::Quarantined)),
                result = timeout_at(deadline, notified) => {
                    result.map_err(|_| Arc::new(ProcessError::CancelNotConfirmed))?;
                }
            }
        }
    }

    pub(super) fn pending_calls(&self) -> Vec<Arc<PendingCall>> {
        self.state().calls.values().cloned().collect()
    }

    pub(super) fn confirmed_exit(&self) {
        let calls = self.state().calls.values().cloned().collect::<Vec<_>>();
        for call in calls {
            call.confirmed_exit();
        }
        self.changed.notify_waiters();
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().expect("process session state poisoned")
    }
}
