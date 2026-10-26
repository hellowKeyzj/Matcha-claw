use crate::{
    protocol::{
        api::PackageConfigView,
        bindings::{Entrypoint, SlotKind},
        failure::{Failure, FailureStage, Recovery},
        ids::{DiagnosticId, PluginGenerationId, Sequence},
        process::*,
        slots::{OracleFailure, SlotFailure, SlotRequest, SlotResponse},
        sources::SourceFailure,
    },
    source::{RecordedSource, discover_port, read_port},
};
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::watch,
    task::JoinHandle,
};

type BusinessResult = Result<SlotResponse, SlotFailure>;

#[derive(Clone, Copy)]
enum Program {
    Source,
    Oracle,
}
impl Program {
    fn slot(self) -> SlotKind {
        match self {
            Self::Source => SlotKind::Connector,
            Self::Oracle => SlotKind::Evaluation,
        }
    }
    fn methods(self) -> Result<Vec<crate::protocol::bindings::MethodPort>, ProcessFailure> {
        match self {
            Self::Source => Ok(vec![
                read_port().map_err(|_| ProcessFailure::InternalFault)?,
                discover_port().map_err(|_| ProcessFailure::InternalFault)?,
            ]),
            Self::Oracle => Ok(vec![
                crate::protocol::slots::slot_port(self.slot())
                    .map_err(|_| ProcessFailure::InternalFault)?,
            ]),
        }
    }
    fn rejected(self) -> SlotFailure {
        match self {
            Self::Source => SlotFailure::Connector(SourceFailure::ProtocolViolation),
            Self::Oracle => SlotFailure::Evaluation(OracleFailure::SchemaMismatch),
        }
    }
    fn response_limit(self) -> SlotFailure {
        match self {
            Self::Source => SlotFailure::Connector(SourceFailure::ResponseLimit),
            Self::Oracle => SlotFailure::Evaluation(OracleFailure::BudgetExceeded),
        }
    }
}

enum Service {
    Source(RecordedSource),
    Oracle { enabled: bool },
}
impl Service {
    fn new(program: Program, config: &PackageConfigView) -> Result<Self, ProcessFailure> {
        match program {
            Program::Source => RecordedSource::from_config(config)
                .map(Self::Source)
                .map_err(|_| ProcessFailure::HandshakeMismatch),
            Program::Oracle => crate::oracle::enabled(config)
                .map(|enabled| Self::Oracle { enabled })
                .map_err(|_| ProcessFailure::HandshakeMismatch),
        }
    }
    async fn call(&self, request: SlotRequest, receiver: watch::Receiver<bool>) -> BusinessResult {
        match (self, request) {
            (Self::Source(source), SlotRequest::Connector(request)) => source
                .read_cancellable(request, receiver)
                .await
                .map(SlotResponse::Connector)
                .map_err(SlotFailure::Connector),
            (Self::Source(source), SlotRequest::ConnectorDiscover(request)) => source
                .discover_cancellable(request, receiver)
                .await
                .map(SlotResponse::ConnectorDiscover)
                .map_err(SlotFailure::Connector),
            (Self::Oracle { enabled }, SlotRequest::Evaluation(request)) => {
                if !enabled {
                    return Err(SlotFailure::Evaluation(OracleFailure::Unavailable));
                }
                crate::oracle::evaluate_cancellable(request, receiver)
                    .await
                    .map(SlotResponse::Evaluation)
                    .map_err(SlotFailure::Evaluation)
            }
            (Self::Source(_), _) => Err(Program::Source.rejected()),
            (Self::Oracle { .. }, _) => Err(Program::Oracle.rejected()),
        }
    }
    fn timeout(&self) -> SlotFailure {
        match self {
            Self::Source(_) => SlotFailure::Connector(SourceFailure::ReadTimeout),
            Self::Oracle { .. } => SlotFailure::Evaluation(OracleFailure::BudgetExceeded),
        }
    }
}

struct Active {
    id: CallId,
    method: String,
    cancel: watch::Sender<bool>,
    task: JoinHandle<BusinessResult>,
}

/// Partial frame progress survives select cancellation; the only codec is world-protocol.
struct Reader<R> {
    input: R,
    header: [u8; 4],
    header_read: usize,
    body: Vec<u8>,
    body_read: usize,
}
impl<R: AsyncRead + Unpin> Reader<R> {
    fn new(input: R) -> Self {
        Self {
            input,
            header: [0; 4],
            header_read: 0,
            body: Vec::new(),
            body_read: 0,
        }
    }
    async fn next(
        &mut self,
        handshake: bool,
        maximum: usize,
    ) -> Result<Option<Frame>, ProcessFailure> {
        while self.header_read < 4 {
            let read = self
                .input
                .read(&mut self.header[self.header_read..])
                .await
                .map_err(|_| ProcessFailure::ReadFailed)?;
            if read == 0 {
                return if self.header_read == 0 {
                    Ok(None)
                } else {
                    Err(ProcessFailure::PartialHeader)
                };
            }
            self.header_read += read;
        }
        if self.body.is_empty() {
            let size = frame_length(self.header, handshake)?;
            if size > maximum {
                return Err(ProcessFailure::FrameTooLarge);
            }
            self.body.resize(size, 0);
        }
        while self.body_read < self.body.len() {
            let read = self
                .input
                .read(&mut self.body[self.body_read..])
                .await
                .map_err(|_| ProcessFailure::ReadFailed)?;
            if read == 0 {
                return Err(ProcessFailure::PartialBody);
            }
            self.body_read += read;
        }
        let frame =
            decode_frame(&self.body, handshake).map_err(|_| ProcessFailure::FrameMalformed)?;
        self.header_read = 0;
        self.body_read = 0;
        self.body.clear();
        Ok(Some(frame))
    }
}
async fn send<W: AsyncWrite + Unpin>(
    output: &mut W,
    frame: Frame,
    handshake: bool,
    maximum: usize,
) -> Result<(), ProcessFailure> {
    let bytes = encode_frame(&frame, handshake).map_err(|_| ProcessFailure::FrameTooLarge)?;
    if bytes.len() - 4 > maximum {
        return Err(ProcessFailure::FrameTooLarge);
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        output
            .write_all(&bytes)
            .await
            .map_err(|_| ProcessFailure::WriteFailed)?;
        output
            .flush()
            .await
            .map_err(|_| ProcessFailure::FlushFailed)
    })
    .await
    .map_err(|_| ProcessFailure::WriteFailed)?
}
fn validate_id(
    id: &CallId,
    generation: &PluginGenerationId,
    last: &mut Option<Sequence>,
) -> Result<Sequence, ProcessFailure> {
    if id.initiator != Endpoint::Host || &id.generation_id != generation {
        return Err(ProcessFailure::UnexpectedDirection);
    }
    let sequence = request_sequence(id)?;
    if last.is_some_and(|last| sequence <= last) {
        return Err(ProcessFailure::DuplicateRequest);
    }
    *last = Some(sequence);
    Ok(sequence)
}
fn failure(id: &CallId, method: &str, details: SlotFailure) -> Failure<SlotFailure> {
    Failure {
        code: format!("{method}_failed"),
        stage: FailureStage::Read,
        message: format!("Recorded {} did not complete", method.replace('.', " ")),
        diagnostic_id: DiagnosticId::try_new(format!(
            "{}:{}",
            method.replace('.', "-"),
            id.request_id
        ))
        .expect("bounded canonical call id"),
        operation_id: None,
        run_id: None,
        step_id: None,
        details,
        recovery: Recovery::None,
    }
}
async fn finish<W: AsyncWrite + Unpin>(
    output: &mut W,
    id: CallId,
    method: &str,
    result: BusinessResult,
    maximum: usize,
    program: Program,
) -> Result<(), ProcessFailure> {
    let state = match &result {
        Ok(_) => TerminalState::Completed,
        Err(
            SlotFailure::Connector(SourceFailure::Cancelled)
            | SlotFailure::Evaluation(OracleFailure::Cancelled),
        ) => TerminalState::Cancelled,
        Err(_) => TerminalState::Failed,
    };
    let frame = Frame::Result(CallResult {
        id: id.clone(),
        result: result.map_err(|details| failure(&id, method, details)),
        effects: Vec::new(),
    });
    // A bounded source may still exceed the negotiated frame after JSON escaping.
    let frame = if encode_frame(&frame, false).is_ok_and(|bytes| bytes.len() - 4 <= maximum) {
        frame
    } else {
        Frame::Result(CallResult {
            id: id.clone(),
            result: Err(failure(&id, method, program.response_limit())),
            effects: Vec::new(),
        })
    };
    let terminal_state = if matches!(&frame, Frame::Result(CallResult { result: Err(_), .. }))
        && state == TerminalState::Completed
    {
        TerminalState::Failed
    } else {
        state
    };
    send(output, frame, false, maximum).await?;
    send(
        output,
        Frame::Terminal(Terminal {
            id,
            state: terminal_state,
            last_sequence: None,
        }),
        false,
        maximum,
    )
    .await
}

pub async fn run_stdio() -> Result<(), ProcessFailure> {
    run(tokio::io::stdin(), tokio::io::stdout()).await
}

pub async fn run_oracle_stdio() -> Result<(), ProcessFailure> {
    run_program(tokio::io::stdin(), tokio::io::stdout(), Program::Oracle).await
}

pub async fn run<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    input: R,
    output: W,
) -> Result<(), ProcessFailure> {
    run_program(input, output, Program::Source).await
}

async fn run_program<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    input: R,
    mut output: W,
    program: Program,
) -> Result<(), ProcessFailure> {
    let methods = program.methods()?;
    let port = &methods[0];
    let contracts = methods
        .iter()
        .map(|method| method.contract.clone())
        .collect::<Vec<_>>();
    send(
        &mut output,
        Frame::Hello(Hello {
            protocol: PROTOCOL.into(),
            contracts: contracts.clone(),
            methods: methods.clone(),
            slots: vec![program.slot()],
            maximum_frame_bytes: MAX_FRAME_BYTES as u32,
            maximum_inflight: 1,
        }),
        true,
        MAX_HANDSHAKE_BYTES,
    )
    .await?;
    let mut reader = Reader::new(input);
    let Some(Frame::Select(select)) = tokio::time::timeout(
        Duration::from_secs(10),
        reader.next(true, MAX_HANDSHAKE_BYTES),
    )
    .await
    .map_err(|_| ProcessFailure::HandshakeTimeout)??
    else {
        return Err(ProcessFailure::HandshakeMismatch);
    };
    if select.protocol != PROTOCOL
        || select.maximum_inflight != 1
        || select.maximum_frame_bytes < 1024
        || select.maximum_frame_bytes as usize > MAX_FRAME_BYTES
        || select.contracts != contracts
        || select.methods != methods
        || select.implementation.contracts != contracts
        || select.implementation.config_digest != select.config.digest
        || select.implementation.install_id != select.config.install_id
        || !matches!(&select.implementation.entrypoint, Entrypoint::Process { protocol, .. } if protocol == &port.contract)
    {
        return Err(ProcessFailure::HandshakeMismatch);
    }
    let service = Arc::new(Service::new(program, &select.config)?);
    let maximum = select.maximum_frame_bytes as usize;
    let generation = select.generation_id;
    send(
        &mut output,
        Frame::Ready(Ready {
            config_digest: select.config.digest,
            generation_id: generation.clone(),
            contracts: contracts.clone(),
            methods: methods.clone(),
            implementation_digest: select.implementation.artifact_digest,
        }),
        true,
        MAX_HANDSHAKE_BYTES,
    )
    .await?;
    let mut active: Option<Active> = None;
    let mut last = None;
    let mut last_business = None;
    let mut last_terminal = None;
    let mut started = false;
    let mut prepared = false;
    let mut draining = false;
    let mut drain: Option<(CallId, Sequence)> = None;
    let outcome = async {
        loop {
            let frame = if let Some(current) = active.as_mut() {
                tokio::select! {
                    frame = reader.next(false, maximum) => frame?,
                    result = &mut current.task => {
                        let completed = active.take().expect("active completion");
                        last_terminal = Some(completed.id.clone());
                        finish(&mut output, completed.id, &completed.method, result.map_err(|_| ProcessFailure::InternalFault)?, maximum, program).await?;
                        if let Some((id, cutoff)) = drain.take() {
                            send(&mut output, Frame::SystemResult(SystemResult { id, result: Ok(SystemValue::Drained { cutoff }) }), false, maximum).await?;
                        }
                        continue;
                    }
                }
            } else { reader.next(false, maximum).await? };
            let Some(frame) = frame else { return Err(ProcessFailure::ChildExited { code: None }); };
            match frame {
                Frame::Call(call) => {
                    let sequence = validate_id(&call.id, &generation, &mut last)?;
                    last_business = Some(sequence);
                    if !started || draining || active.is_some() || call.parent.is_some() || call.timeout.0 == 0 {
                        return Err(ProcessFailure::UnexpectedDirection);
                    }
                    let method = crate::protocol::slots::request_port(&call.request)
                        .map_err(|_| ProcessFailure::InternalFault)?;
                    if method.contract != call.contract || !methods.contains(&method) {
                        return Err(ProcessFailure::ContractMismatch { contract_id: call.contract.id });
                    }
                    send(&mut output, Frame::Accepted(Accepted { id: call.id.clone() }), false, maximum).await?;
                    let service = service.clone(); let (cancel, receiver) = watch::channel(false);
                    let task = tokio::spawn(async move {
                        tokio::time::timeout(Duration::from_millis(call.timeout.0), service.call(call.request, receiver))
                            .await.unwrap_or_else(|_| Err(service.timeout()))
                    });
                    active = Some(Active { id: call.id, method: method.name, cancel, task });
                }
                Frame::Cancel(cancel) => {
                    let cancellation = CallId { initiator: Endpoint::Host, generation_id: generation.clone(), request_id: cancel.cancellation_id.clone() };
                    validate_id(&cancellation, &generation, &mut last)?;
                    if let Some(current) = active.as_ref().filter(|current| current.id == cancel.id) {
                        current.cancel.send_replace(true);
                    } else if last_terminal.as_ref() != Some(&cancel.id) {
                        return Err(ProcessFailure::UnknownCorrelation);
                    }
                    // A cancellation may cross an already-published terminal in the opposite pipe.
                    send(&mut output, Frame::CancelAck(CancelAck { id: cancel.id, cancellation_id: cancel.cancellation_id }), false, maximum).await?;
                }
                Frame::SystemCall(call) => {
                    let sequence = validate_id(&call.id, &generation, &mut last)?;
                    let result = match call.method {
                        SystemMethod::Describe => Ok(SystemValue::Description { contracts: contracts.clone(), methods: methods.clone(), slots: vec![program.slot()] }),
                        SystemMethod::Health => Ok(SystemValue::Health { ready: started && !draining }),
                        SystemMethod::Prepare { activation_lock_id } if !started && !draining => { prepared = true; Ok(SystemValue::Prepared { activation_lock_id }) },
                        SystemMethod::Start if prepared && !started && !draining => { started = true; Ok(SystemValue::Started) },
                        SystemMethod::Drain { cutoff, .. } if !draining && cutoff < sequence && last_business.is_none_or(|business| business <= cutoff) => {
                            draining = true;
                            if active.is_some() { drain = Some((call.id, cutoff)); continue; }
                            Ok(SystemValue::Drained { cutoff })
                        }
                        SystemMethod::Stop { .. } if draining && active.is_none() && drain.is_none() => {
                            send(&mut output, Frame::SystemResult(SystemResult { id: call.id, result: Ok(SystemValue::StopAcknowledged) }), false, maximum).await?;
                            output.shutdown().await.map_err(|_| ProcessFailure::WriteFailed)?;
                            return Ok(());
                        }
                        _ => Err(ProcessFailure::UnexpectedDirection),
                    };
                    send(&mut output, Frame::SystemResult(SystemResult { id: call.id, result }), false, maximum).await?;
                }
                _ => return Err(ProcessFailure::UnexpectedDirection),
            }
        }
    }.await;
    if let Some(current) = active {
        current.cancel.send_replace(true);
        let _ = current
            .task
            .await
            .map_err(|_| ProcessFailure::InternalFault)?;
    }
    outcome
}
