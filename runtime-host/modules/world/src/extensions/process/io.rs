use std::{sync::Arc, time::Duration};

use foundation::{
    execution::OwnedTask,
    process::{ProcessOutput, ProcessStdin},
};
use tokio::{
    io::AsyncWriteExt,
    time::{Instant, timeout_at},
};
use world_protocol::{
    budget::BudgetDimension,
    process::{self, Frame, ProcessFailure},
    time::DurationMs,
};

use super::{
    error::ProcessError,
    frame, host_io,
    pending::PendingCall,
    session::{CONTROL_TIMEOUT, Outgoing, Receivers, Session},
};

pub(super) enum IoEnd {
    Eof,
    Cancelled,
}
pub(super) type IoResult = Result<IoEnd, Arc<ProcessError>>;

pub(super) fn reader(
    mut output: ProcessOutput,
    session: Arc<Session>,
    handshake_deadline: Instant,
) -> OwnedTask<IoResult> {
    if session.materials().is_some() { return super::materials_io::reader(output, session, handshake_deadline); }
    let (task, _) = OwnedTask::spawn(move |cancellation| async move {
        let result: IoResult = async {
            let mut hello = false;
            loop {
                let handshaking = !session.is_ready();
                let next = async {
                    if handshaking {
                        timeout_at(
                            handshake_deadline,
                            frame::read(&mut output, true, process::MAX_HANDSHAKE_BYTES),
                        )
                        .await
                        .map_err(|_| {
                            Arc::new(ProcessError::Protocol(ProcessFailure::HandshakeTimeout))
                        })?
                        .map_err(|cause| Arc::new(cause.into()))
                    } else {
                        frame::read(&mut output, false, session.maximum_frame())
                            .await
                            .map_err(|cause| Arc::new(cause.into()))
                    }
                };
                let incoming = tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => return Ok(IoEnd::Cancelled),
                    _ = session.closed.cancelled() => return Ok(IoEnd::Cancelled),
                    result = next => result?,
                };
                let Some(incoming) = incoming else {
                    return Ok(IoEnd::Eof);
                };
                if handshaking {
                    match incoming {
                        Frame::Hello(value) if !hello => {
                            if value.protocol != process::PROTOCOL
                                || value.contracts != session.implementation.contracts
                                || value.methods != session.methods
                                || value.slots != session.slots()
                            {
                                return Err(Arc::new(ProcessError::Protocol(
                                    ProcessFailure::HandshakeMismatch,
                                )));
                            }
                            let (maximum_frame_bytes, maximum_inflight) = session
                                .select_limits(value.maximum_frame_bytes, value.maximum_inflight)
                                .map_err(Arc::new)?;
                            hello = true;
                            session.control_frame(Frame::Select(process::Select {
                                config: session.config.clone(),
                                protocol: process::PROTOCOL.into(),
                                generation_id: session.generation.clone(),
                                implementation: session.implementation.clone(),
                                contracts: session.implementation.contracts.clone(),
                                methods: session.methods.clone(),
                                maximum_frame_bytes,
                                maximum_inflight,
                            }))?;
                        }
                        Frame::Ready(value) if hello => {
                            if value.generation_id != session.generation
                                || value.contracts != session.implementation.contracts
                                || value.methods != session.methods
                                || value.implementation_digest
                                    != session.implementation.artifact_digest
                                || value.config_digest != session.implementation.config_digest
                            {
                                return Err(Arc::new(ProcessError::Protocol(
                                    ProcessFailure::HandshakeMismatch,
                                )));
                            }
                            session.ready();
                        }
                        _ => {
                            return Err(Arc::new(ProcessError::Protocol(
                                ProcessFailure::UnexpectedDirection,
                            )));
                        }
                    }
                } else {
                    dispatch(&session, incoming).await.map_err(Arc::new)?;
                }
            }
        }
        .await;
        match &result {
            Ok(IoEnd::Eof) if session.orderly_eof() => {
                session.closed.cancel();
            }
            Ok(IoEnd::Eof) => session.fail(Arc::new(ProcessError::TransportClosed)),
            Err(cause) => session.fail(cause.clone()),
            _ => {}
        }
        session
            .status
            .send_modify(|status| status.reader_done = true);
        result
    });
    task
}

async fn dispatch(session: &Arc<Session>, incoming: Frame) -> Result<(), ProcessError> {
    match incoming {
        Frame::Accepted(value) => session.call(&value.id)?.accepted(),
        Frame::Result(value) => {
            let call = session.call(&value.id)?;
            let encoded = process::encode_frame(&Frame::Result(value.clone()), false)
                .map_err(|cause| ProcessError::from(frame::WireFailure::Codec(cause)))?;
            call.budget
                .charge(BudgetDimension::Bytes, encoded.len() as u64)
                .map_err(|cause| ProcessError::Budget(cause.dimension))?;
            call.result(value)
        }
        Frame::SystemResult(value) => session.system_result(value),
        Frame::StreamOpen(value) => {
            let credit = session.call(&value.id)?.stream_open(value)?;
            session
                .control_frame(Frame::Credit(credit))
                .map_err(|_| ProcessError::BackpressureTimeout)
        }
        Frame::StreamItem(value) => session.call(&value.id)?.stream_item(value),
        Frame::StreamEnd(value) => session.call(&value.id)?.stream_end(value),
        Frame::CancelAck(value) => session.cancel_ack(value),
        Frame::Terminal(value) => session.terminal(value).await,
        Frame::HostCall(value) => host_io::accept(session, value),
        // Driver-to-host slot dispatch is not a host authorization capability.
        _ => Err(ProcessFailure::UnexpectedDirection.into()),
    }
}

pub(super) fn writer(
    mut input: ProcessStdin,
    mut receivers: Receivers,
    session: Arc<Session>,
) -> OwnedTask<IoResult> {
    let (task, _) = OwnedTask::spawn(move |cancellation| async move {
        let mut result: IoResult = async {
            let mut sweep = tokio::time::interval(Duration::from_millis(20));
            sweep.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                let outgoing = tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => return Ok(IoEnd::Cancelled),
                    _ = session.cleanup.quarantined() => return Err(Arc::new(ProcessError::Quarantined)),
                    _ = session.closed.cancelled() => return Ok(IoEnd::Eof),
                    _ = sweep.tick() => {
                        if session.cancel_expired() { return Err(Arc::new(ProcessError::CancelNotConfirmed)); }
                        send_host_results(&mut input, &session).await?;
                        for call in session.pending_calls() {
                            if let Some(frame) = call.cancel_frame().map_err(Arc::new)? {
                                send_frame(&mut input, &session, frame, Instant::now() + CONTROL_TIMEOUT).await?;
                            }
                        }
                        continue;
                    }
                    value = receivers.control.recv() => value,
                    value = receivers.calls.recv() => value,
                };
                let Some(outgoing) = outgoing else { return Ok(IoEnd::Eof) };
                match outgoing {
                    Outgoing::Frame(frame) => send_frame(&mut input, &session, frame, Instant::now() + CONTROL_TIMEOUT).await?,
                    Outgoing::Materials(value) => {
                        if session.materials().is_none() { return Err(Arc::new(ProcessError::Protocol(ProcessFailure::UnexpectedDirection))); }
                        let maximum = if session.is_ready() { session.maximum_frame() } else { process::MAX_HANDSHAKE_BYTES };
                        let bytes = super::materials_wire::encode(&value, maximum).map_err(|cause| Arc::new(ProcessError::from(cause)))?;
                        write_bytes(&mut input, &session, &bytes, Instant::now() + CONTROL_TIMEOUT).await?;
                    },
                    Outgoing::System { method, response } => {
                        if Instant::now() >= response.deadline { response.complete(Err(Arc::new(ProcessError::Deadline))); continue; }
                        let id = session.next_id().map_err(Arc::new)?;
                        session.add_system(&id, method.clone(), response.clone()).map_err(Arc::new)?;
                        send_frame(&mut input, &session, Frame::SystemCall(process::SystemCall { id, method }), response.deadline).await?;
                    }
                    Outgoing::Drain { operation, response } => {
                        if Instant::now() >= response.deadline { response.complete(Err(Arc::new(ProcessError::Deadline))); continue; }
                        let method = process::SystemMethod::Drain { cutoff: session.cutoff(), operation };
                        let id = session.next_id().map_err(Arc::new)?;
                        session.add_system(&id, method.clone(), response.clone()).map_err(Arc::new)?;
                        send_frame(&mut input, &session, Frame::SystemCall(process::SystemCall { id, method }), response.deadline).await?;
                    }
                    Outgoing::Call(call) => send_call(&mut input, &session, call).await?,
                }
            }
        }.await;
        let shutdown = timeout_at(Instant::now() + CONTROL_TIMEOUT, input.shutdown()).await;
        if result.is_ok() {
            result = match shutdown {
                Ok(Ok(())) => result,
                Ok(Err(cause)) => Err(Arc::new(frame::WireFailure::Write(cause).into())),
                Err(_) => Err(Arc::new(ProcessError::BackpressureTimeout)),
            };
        }
        if let Err(cause) = &result {
            session.fail(cause.clone());
        }
        session
            .status
            .send_modify(|status| status.writer_done = true);
        result
    });
    task
}

async fn send_host_results(
    input: &mut ProcessStdin,
    session: &Session,
) -> Result<(), Arc<ProcessError>> {
    for io in session.host_calls() {
        if !io.is_finished() {
            continue;
        }
        let deadline = Instant::now() + CONTROL_TIMEOUT;
        let mut result = io.result(deadline).await?;
        if result.is_ok() {
            let context = io
                .parent
                .context()
                .ok_or_else(|| Arc::new(ProcessError::Closing))?;
            let checked = timeout_at(deadline, async {
                context
                    .check_current()
                    .await
                    .map_err(crate::extensions::host_calls::HostCallFailure::from)?;
                context
                    .check_output(1)
                    .await
                    .map_err(crate::extensions::host_calls::HostCallFailure::from)
            })
            .await;
            match checked {
                Ok(Ok(())) => {}
                Ok(Err(cause)) => result = Err(Arc::new(cause)),
                Err(_) => {
                    result = Err(Arc::new(
                        crate::extensions::host_calls::HostCallFailure::new(
                            process::HostFailure::BudgetExceeded {
                                dimension: BudgetDimension::Deadline,
                            },
                            world_protocol::failure::FailureStage::Disclose,
                        ),
                    ))
                }
            }
        }
        if let Err(cause) = &result {
            io.parent.host_failure(cause.clone());
        }
        let result = result.map_err(|cause| cause.safe_failure());
        io.release(deadline).await?;
        io.begin_write();
        send_frame(
            input,
            session,
            Frame::HostResult(process::HostResult {
                id: io.id.clone(),
                result,
            }),
            deadline,
        )
        .await?;
        io.written();
        session.remove_host(io.request_id());
    }
    Ok(())
}

async fn send_call(
    input: &mut ProcessStdin,
    session: &Session,
    call: Arc<PendingCall>,
) -> Result<(), Arc<ProcessError>> {
    call.observe_cancellation();
    if session.is_closing() || call.cancellation.is_cancelled() || call.remote_settled() {
        call.cancel_before_dispatch();
        return Ok(());
    }
    let checked = tokio::select! {
        biased;
        _ = session.cleanup.quarantined() => return Err(Arc::new(ProcessError::Quarantined)),
        result = timeout_at(call.deadline, call.check_current()) => result,
    };
    match checked {
        Ok(Ok(())) => {}
        Ok(Err(cause)) => {
            call.fail(cause);
            return Ok(());
        }
        Err(_) => {
            call.fail(Arc::new(ProcessError::Deadline));
            return Ok(());
        }
    }
    let id = session.next_id().map_err(Arc::new)?;
    let Some(request) = call.take_request(id.clone()) else {
        return Ok(());
    };
    let remaining = call.deadline.saturating_duration_since(Instant::now());
    let timeout = DurationMs(u64::try_from(remaining.as_millis()).unwrap_or(u64::MAX));
    let frame = Frame::Call(process::Call {
        id: id.clone(),
        parent: None,
        contract: call.method.contract.clone(),
        timeout,
        request,
    });
    let bytes = frame::encode(&frame, false, session.maximum_frame())
        .map_err(|cause| Arc::new(cause.into()))?;
    if let Err(cause) = call
        .budget
        .charge(BudgetDimension::Bytes, bytes.len() as u64)
    {
        call.fail(Arc::new(ProcessError::Budget(cause.dimension)));
        return Ok(());
    }
    if session.cleanup.host_only() {
        return Err(Arc::new(ProcessError::Quarantined));
    }
    if !session.begin_dispatch(&call, &id) {
        call.cancel_before_dispatch();
        return Ok(());
    }
    write_bytes(
        input,
        session,
        &bytes,
        call.deadline.min(Instant::now() + CONTROL_TIMEOUT),
    )
    .await
}

async fn send_frame(
    input: &mut ProcessStdin,
    session: &Session,
    value: Frame,
    deadline: Instant,
) -> Result<(), Arc<ProcessError>> {
    if session.cleanup.host_only() {
        return Err(Arc::new(ProcessError::Quarantined));
    }
    let handshake = matches!(&value, Frame::Select(_));
    let bytes = frame::encode(
        &value,
        handshake,
        if handshake {
            process::MAX_HANDSHAKE_BYTES
        } else {
            session.maximum_frame()
        },
    )
    .map_err(|cause| Arc::new(cause.into()))?;
    write_bytes(input, session, &bytes, deadline).await
}

async fn write_bytes(
    input: &mut ProcessStdin,
    session: &Session,
    bytes: &[u8],
    deadline: Instant,
) -> Result<(), Arc<ProcessError>> {
    tokio::select! {
        biased;
        _ = session.cleanup.quarantined() => Err(Arc::new(ProcessError::Quarantined)),
        result = timeout_at(deadline, frame::write(input, bytes)) => result
            .map_err(|_| Arc::new(ProcessError::BackpressureTimeout))?
            .map_err(|cause| Arc::new(cause.into())),
    }
}
