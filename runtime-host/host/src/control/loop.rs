use std::{
    fmt,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use foundation::execution::{
    ControlObservation, ControlReason, ControlStage, ObservationRecord, ObservationSink,
    TraceContext,
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::mpsc,
    task::JoinSet,
    time::timeout,
};
use zeroize::Zeroize;

use crate::{
    HostEvent, composition::PeerHandle, host_actor,
    module_registry::private_control::PrivateControlRegistry,
};

const INPUT_CAPACITY: usize = 32;
const OUTPUT_CAPACITY: usize = 64;
const REQUEST_CAPACITY: usize = 32;
const CONTROL_COMMAND_KIND: &str = "control.command";
static NEXT_CONTROL_TRACE: AtomicU64 = AtomicU64::new(1);

pub(crate) async fn run_loop<R, W>(
    owner: host_actor::Handle,
    mut owner_events: tokio::sync::mpsc::Receiver<HostEvent>,
    peer: PeerHandle,
    private_control: PrivateControlRegistry,
    observation: ObservationSink,
    gateway_auto_start: bool,
    control_input: R,
    mut control_output: W,
) -> Result<(), ControlError>
where
    R: AsyncRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin,
{
    if let Err(error) = write_output(
        &mut control_output,
        super::wire::Output::Ready(super::wire::Ready::new()),
    )
    .await
    {
        return Err(error);
    }
    eprintln!(
        "[startup-trace] source=runtime-host phase=ready detail=control-channel-ready gateway_auto_start={gateway_auto_start}"
    );
    let peer_autostart = tokio::spawn({
        let peer = peer.clone();
        async move {
            eprintln!(
                "[startup-trace] source=runtime-host phase=openclaw-autostart-request detail=requesting-peer-autostart gateway_auto_start={gateway_auto_start}"
            );
            match peer.request_peer_autostart(gateway_auto_start).await {
                Ok(()) => eprintln!(
                    "[startup-trace] source=runtime-host phase=openclaw-autostart-result detail=peer-autostart-finished success=true error="
                ),
                Err(error) => eprintln!(
                    "[startup-trace] source=runtime-host phase=openclaw-autostart-result detail=peer-autostart-finished success=false error={error:?}"
                ),
            }
        }
    });

    let (input_sender, mut input_receiver) = mpsc::channel(INPUT_CAPACITY);
    let mut reader = tokio::spawn(read_control_input(control_input, input_sender));
    let (output_sender, mut output_receiver) = mpsc::channel(OUTPUT_CAPACITY);
    let mut commands = JoinSet::new();
    let mut events_open = true;
    let shutdown_signal = system_shutdown();
    tokio::pin!(shutdown_signal);

    let result = loop {
        tokio::select! {
            _ = &mut shutdown_signal => break Ok(()),
            input = input_receiver.recv() => match input {
                Some(Input::Frame(mut frame)) => {
                    let trace = next_control_trace();
                    let command = super::wire::decode_command_request(&frame);
                    frame.zeroize();
                    match command {
                        Ok(command) => {
                            observe_control(
                                &observation,
                                trace,
                                CONTROL_COMMAND_KIND,
                                ControlStage::Decode,
                                Some(ControlReason::Accepted),
                            );
                            if let Err(error) = spawn_command(
                                &mut commands,
                                owner.clone(),
                                peer.clone(),
                                private_control.clone(),
                                output_sender.clone(),
                                observation.clone(),
                                trace,
                                command,
                            ) {
                                break Err(error);
                            }
                        }
                        Err(_) => {
                            observe_control(
                                &observation,
                                trace,
                                CONTROL_COMMAND_KIND,
                                ControlStage::Decode,
                                Some(ControlReason::DecodeRejected),
                            );
                            break Err(ControlError::InvalidCommand);
                        }
                    }
                }
                Some(Input::End) | None => break Ok(()),
                Some(Input::Error) => break Err(ControlError::Input),
            },
            output = output_receiver.recv() => match output {
                Some(output) => {
                    if let Err(error) = write_output(&mut control_output, output).await {
                        observe_control(
                            &observation,
                            TraceContext::absent(),
                            "control.output",
                            ControlStage::Settle,
                            Some(ControlReason::OutputClosed),
                        );
                        break Err(error);
                    }
                }
                None => {
                    observe_control(
                        &observation,
                        TraceContext::absent(),
                        "control.output",
                        ControlStage::Settle,
                        Some(ControlReason::OutputClosed),
                    );
                    break Err(ControlError::OutputClosed);
                }
            },
            event = owner_events.recv(), if events_open => match event {
                Some(event) => {
                    if let Some(event) = project_event(event, &observation)
                        && output_sender.try_send(event).is_err()
                    {
                        observe_control(
                            &observation,
                            TraceContext::absent(),
                            "control.output",
                            ControlStage::Settle,
                            Some(ControlReason::OutputClosed),
                        );
                        break Err(ControlError::OutputClosed);
                    }
                },
                None => events_open = false,
            },
            completed = commands.join_next(), if !commands.is_empty() => {
                if let Some(Err(_)) = completed {
                    break Err(ControlError::CommandTask);
                }
            },
        }
    };

    peer_autostart.abort();
    let _ = peer_autostart.await;
    reader.abort();
    let _ = (&mut reader).await;
    commands.abort_all();
    while commands.join_next().await.is_some() {}
    drop(output_sender);
    drop(output_receiver);

    result
}

fn spawn_command(
    commands: &mut JoinSet<()>,
    owner: host_actor::Handle,
    peer: PeerHandle,
    private_control: PrivateControlRegistry,
    output: mpsc::Sender<super::wire::Output>,
    observation: ObservationSink,
    trace: TraceContext,
    command: super::wire::CommandRequest,
) -> Result<(), ControlError> {
    let id = command.id.clone();
    if commands.len() >= REQUEST_CAPACITY {
        observe_control(
            &observation,
            trace,
            CONTROL_COMMAND_KIND,
            ControlStage::Admit,
            Some(ControlReason::CapacityExhausted),
        );
        observe_control(
            &observation,
            trace,
            CONTROL_COMMAND_KIND,
            ControlStage::Settle,
            Some(ControlReason::Rejected),
        );
        return output
            .try_send(super::wire::Output::Outcome(super::wire::Outcome::new(
                id,
                super::wire::CommandOutcome::rejected(
                    super::wire::RejectionCode::CapacityExhausted,
                    "Runtime Host control command capacity is exhausted.",
                ),
            )))
            .map_err(|_| ControlError::OutputClosed);
    }

    observe_control(
        &observation,
        trace,
        CONTROL_COMMAND_KIND,
        ControlStage::Admit,
        Some(ControlReason::Accepted),
    );
    let timeout_duration = Duration::from_millis(command.timeout.milliseconds());
    commands.spawn(async move {
        observe_control(
            &observation,
            trace,
            CONTROL_COMMAND_KIND,
            ControlStage::Dispatch,
            Some(ControlReason::Accepted),
        );
        let outcome = match timeout(
            timeout_duration,
            private_control.execute(&owner, &peer, command.command),
        )
        .await
        {
            Ok(outcome) => outcome,
            Err(_) => super::wire::CommandOutcome::timed_out(),
        };
        observe_control(
            &observation,
            trace,
            CONTROL_COMMAND_KIND,
            ControlStage::Settle,
            Some(outcome_reason(&outcome)),
        );
        let _ = output
            .send(super::wire::Output::Outcome(super::wire::Outcome::new(
                id, outcome,
            )))
            .await;
    });
    Ok(())
}

fn observe_control(
    observation: &ObservationSink,
    trace: TraceContext,
    command_kind: &'static str,
    stage: ControlStage,
    reason: Option<ControlReason>,
) {
    if observation.is_enabled() {
        observation.observe(ObservationRecord::Control(ControlObservation {
            trace,
            command_kind,
            stage,
            reason,
        }));
    }
}

fn next_control_trace() -> TraceContext {
    TraceContext::root(NEXT_CONTROL_TRACE.fetch_add(1, Ordering::Relaxed))
}

fn outcome_reason(outcome: &super::wire::CommandOutcome) -> ControlReason {
    match outcome {
        super::wire::CommandOutcome::Succeeded { .. }
        | super::wire::CommandOutcome::Unknown { .. } => ControlReason::Accepted,
        super::wire::CommandOutcome::Rejected { .. } => ControlReason::Rejected,
        super::wire::CommandOutcome::TimedOut => ControlReason::TimedOut,
    }
}

async fn read_control_input<R>(mut input: R, sender: mpsc::Sender<Input>)
where
    R: AsyncRead + Unpin,
{
    loop {
        match super::frame::decode_next(&mut input).await {
            Ok(Some(frame)) => {
                if sender.send(Input::Frame(frame)).await.is_err() {
                    return;
                }
            }
            Ok(None) => {
                let _ = sender.send(Input::End).await;
                return;
            }
            Err(_) => {
                let _ = sender.send(Input::Error).await;
                return;
            }
        }
    }
}

async fn write_output(
    output: &mut (impl AsyncWrite + Unpin),
    message: super::wire::Output,
) -> Result<(), ControlError> {
    let frame = super::wire::encode(&message).map_err(|_| ControlError::OutputEncoding)?;
    super::frame::encode(output, &frame)
        .await
        .map_err(|_| ControlError::Output)
}

fn project_event(event: HostEvent, observation: &ObservationSink) -> Option<super::wire::Output> {
    super::event_projection::project_observed(event, observation)
        .map(|event| super::wire::Output::Event(super::wire::Event::new(event)))
}

#[cfg(unix)]
async fn system_shutdown() {
    match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
        Ok(mut terminate) => {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = terminate.recv() => {}
            }
        }
        Err(_) => {
            let _ = tokio::signal::ctrl_c().await;
        }
    }
}

#[cfg(windows)]
async fn system_shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}

enum Input {
    Frame(Vec<u8>),
    End,
    Error,
}

#[derive(Debug)]
pub enum ControlError {
    Construction(crate::ConstructionError),
    ModuleInstall(platform::module::ModuleInstallError),
    Start(String),
    Input,
    InvalidCommand,
    Output,
    OutputEncoding,
    OutputClosed,
    Owner,
    CommandTask,
    Shutdown,
    Transport(&'static str),
}

impl fmt::Display for ControlError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Construction(error) => {
                write!(formatter, "runtime-host construction failed: {error}")
            }
            Self::ModuleInstall(error) => {
                write!(
                    formatter,
                    "runtime-host module installation failed: {error:?}"
                )
            }
            Self::Start(error) => write!(formatter, "runtime-host startup failed: {error}"),
            Self::Input => formatter.write_str("runtime-host control input failed"),
            Self::InvalidCommand => formatter.write_str("runtime-host control command is invalid"),
            Self::Output | Self::OutputEncoding | Self::OutputClosed => {
                formatter.write_str("runtime-host control output failed")
            }
            Self::Owner | Self::CommandTask | Self::Shutdown => {
                formatter.write_str("runtime-host control shutdown failed")
            }
            Self::Transport(stage) => write!(formatter, "runtime-host {stage} failed"),
        }
    }
}

impl std::error::Error for ControlError {}
