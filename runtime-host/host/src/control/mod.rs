mod delivery;
mod dispatch;
mod frame;
mod lifecycle;
mod wire;

pub use delivery::{DeliveryTransportInput, run_delivery_transports};

pub(crate) use wire::{
    CommandInput, CommandOutcome, CommandResult, CronExecutionId, RejectionCode,
    SafeCronExecutionStatus, SafeEvent, SafeRuntimeLifecycle, validate_session_delta,
};

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
    Host, HostEvent, HostInput,
    composition::PeerHandle,
    diagnostics::event_output,
    facade::{CronHandle, PlatformRuntimeHandle, PluginsHandle, SkillsHandle, ToolchainHandle},
    fleet::handle::FleetHandle,
    host_actor,
    sessions::SessionHandle,
};

const INPUT_CAPACITY: usize = 32;
const OUTPUT_CAPACITY: usize = 64;
const REQUEST_CAPACITY: usize = 32;
const SHUTDOWN_RETRY_INTERVAL: Duration = Duration::from_millis(50);
static NEXT_CONTROL_TRACE: AtomicU64 = AtomicU64::new(1);

pub async fn run<R, W>(
    input: HostInput,
    control_input: R,
    control_output: W,
) -> Result<(), ControlError>
where
    R: AsyncRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin,
{
    let (mut host, events, handles) = Host::new(input).map_err(ControlError::Construction)?;
    let gateway_auto_start = handles.settings.gateway_auto_start().await;
    host.start_admission_only()
        .await
        .map_err(|error| ControlError::Start(error.to_string()))?;
    run_owner(
        host_actor::Owner::spawn(host, events),
        handles.organization.clone(),
        handles.peer.clone(),
        handles.session.clone(),
        handles.fleet.clone(),
        handles.platform_runtime.clone(),
        handles.toolchain.clone(),
        handles.plugins.clone(),
        handles.skills.clone(),
        handles.cron.clone(),
        handles.observation.clone(),
        gateway_auto_start,
        control_input,
        control_output,
    )
    .await
}

async fn run_owner<R, W>(
    mut owner: host_actor::Owner,
    organization: crate::organization::OrganizationHandle,
    peer: PeerHandle,
    session: SessionHandle,
    fleet: FleetHandle,
    platform_runtime: PlatformRuntimeHandle,
    toolchain: ToolchainHandle,
    plugins: PluginsHandle,
    skills: SkillsHandle,
    cron: CronHandle,
    observation: ObservationSink,
    gateway_auto_start: bool,
    control_input: R,
    mut control_output: W,
) -> Result<(), ControlError>
where
    R: AsyncRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin,
{
    let handle = owner.handle();
    if let Err(error) =
        write_output(&mut control_output, wire::Output::Ready(wire::Ready::new())).await
    {
        let _ = shutdown_host(&mut owner).await;
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
            let result = peer.request_peer_autostart(gateway_auto_start).await;
            eprintln!(
                "[startup-trace] source=runtime-host phase=openclaw-autostart-result detail=peer-autostart-request-finished success={} error={}",
                result.is_ok(),
                if result.is_ok() {
                    ""
                } else {
                    "peer owner unavailable"
                }
            );
        }
    });

    let (input_sender, mut input_receiver) = mpsc::channel(INPUT_CAPACITY);
    let mut reader = tokio::spawn(read_control_input(control_input, input_sender));
    let (output_sender, mut output_receiver) = mpsc::channel(OUTPUT_CAPACITY);
    let mut owner_events = owner
        .take_events()
        .expect("owner event receiver must be taken before control starts");
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
                    let command = wire::decode_command_request(&frame);
                    frame.zeroize();
                    match command {
                        Ok(command) => {
                            let command_kind = command_kind(&command.command);
                            observe_control(
                                &observation,
                                trace,
                                command_kind,
                                ControlStage::Decode,
                                Some(ControlReason::Accepted),
                            );
                            if let Err(error) = spawn_command(
                                &mut commands,
                                handle.clone(),
                                organization.clone(),
                                peer.clone(),
                                session.clone(),
                                fleet.clone(),
                                platform_runtime.clone(),
                                toolchain.clone(),
                                plugins.clone(),
                                skills.clone(),
                                cron.clone(),
                                output_sender.clone(),
                                observation.clone(),
                                trace,
                                command_kind,
                                command,
                            ) {
                                break Err(error);
                            }
                        }
                        Err(_) => {
                            observe_control(
                                &observation,
                                trace,
                                "control.command",
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
                }
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

    let shutdown = shutdown_host(&mut owner).await;
    result.and(shutdown)
}

fn spawn_command(
    commands: &mut JoinSet<()>,
    owner: host_actor::Handle,
    organization: crate::organization::OrganizationHandle,
    peer: PeerHandle,
    session: SessionHandle,
    fleet: FleetHandle,
    platform_runtime: PlatformRuntimeHandle,
    toolchain: ToolchainHandle,
    plugins: PluginsHandle,
    skills: SkillsHandle,
    cron: CronHandle,
    output: mpsc::Sender<wire::Output>,
    observation: ObservationSink,
    trace: TraceContext,
    command_kind: &'static str,
    command: wire::CommandRequest,
) -> Result<(), ControlError> {
    let id = command.id.clone();
    if commands.len() >= REQUEST_CAPACITY {
        observe_control(
            &observation,
            trace,
            command_kind,
            ControlStage::Admit,
            Some(ControlReason::CapacityExhausted),
        );
        observe_control(
            &observation,
            trace,
            command_kind,
            ControlStage::Settle,
            Some(ControlReason::Rejected),
        );
        return output
            .try_send(wire::Output::Outcome(wire::Outcome::new(
                id,
                wire::CommandOutcome::rejected(
                    wire::RejectionCode::CapacityExhausted,
                    "Runtime Host control command capacity is exhausted.",
                ),
            )))
            .map_err(|_| ControlError::OutputClosed);
    }

    observe_control(
        &observation,
        trace,
        command_kind,
        ControlStage::Admit,
        Some(ControlReason::Accepted),
    );
    let timeout_duration = Duration::from_millis(command.timeout.milliseconds());
    commands.spawn(async move {
        observe_control(
            &observation,
            trace,
            command_kind,
            ControlStage::Dispatch,
            Some(ControlReason::Accepted),
        );
        let outcome = match timeout(
            timeout_duration,
            dispatch::execute(
                &owner,
                &organization,
                &peer,
                &fleet,
                &session,
                &platform_runtime,
                &toolchain,
                &plugins,
                &skills,
                &cron,
                command.command,
            ),
        )
        .await
        {
            Ok(outcome) => outcome,
            Err(_) => wire::CommandOutcome::timed_out(),
        };
        observe_control(
            &observation,
            trace,
            command_kind,
            ControlStage::Settle,
            Some(outcome_reason(&outcome)),
        );
        let _ = output
            .send(wire::Output::Outcome(wire::Outcome::new(id, outcome)))
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

fn outcome_reason(outcome: &wire::CommandOutcome) -> ControlReason {
    match outcome {
        wire::CommandOutcome::Succeeded { .. } | wire::CommandOutcome::Unknown { .. } => {
            ControlReason::Accepted
        }
        wire::CommandOutcome::Rejected { .. } => ControlReason::Rejected,
        wire::CommandOutcome::TimedOut => ControlReason::TimedOut,
    }
}

fn command_kind(command: &wire::Command) -> &'static str {
    match command {
        wire::Command::HostHealth {} => "host.health",
        wire::Command::HostCapabilitiesList {} => "host.capabilities.list",
        wire::Command::HostCapabilitiesDescribe { .. } => "host.capabilities.describe",
        wire::Command::HostRuntimeSnapshot {} => "host.runtime.snapshot",
        wire::Command::MatchaStatus {} => "matcha.lifecycle.status",
        wire::Command::MatchaStart {} => "matcha.lifecycle.start",
        wire::Command::MatchaStop {} => "matcha.lifecycle.stop",
        wire::Command::MatchaRestart {} => "matcha.lifecycle.restart",
        wire::Command::OpenClawStatus {} => "openclaw.lifecycle.status",
        wire::Command::OpenClawPluginsCatalog {} => "openclaw.plugins.catalog",
        wire::Command::OpenClawPluginsRuntime {} => "openclaw.plugins.runtime",
        wire::Command::OpenClawPluginsSetEnabled { .. } => "openclaw.plugins.set-enabled",
        wire::Command::OpenClawPluginsOperation { .. } => "openclaw.plugins.operation",
        wire::Command::OpenClawSkillsExecute { .. } => "openclaw.skills.execute",
        wire::Command::TeamRuntimeExecute { .. } => "team.runtime.execute",
        wire::Command::OpenClawPluginsExecute { .. } => "openclaw.plugins.execute",
        wire::Command::OpenClawEnvironmentStatus {} => "openclaw.environment.status",
        wire::Command::OpenClawRuntimePaths {} => "openclaw.runtime.paths",
        wire::Command::OpenClawCliCommand {} => "openclaw.cli.command",
        wire::Command::OpenClawToolPermissionGet {} => "openclaw.tool-permission.get",
        wire::Command::OpenClawToolPermissionSet { .. } => "openclaw.tool-permission.set",
        wire::Command::HostToolchainStatus {} => "host.toolchain.status",
        wire::Command::HostToolchainPrepare {} => "host.toolchain.prepare",
        wire::Command::OpenClawSubagentTemplateCatalog {} => "openclaw.subagent-templates.list",
        wire::Command::OpenClawSubagentTemplate { .. } => "openclaw.subagent-templates.get",
        wire::Command::OpenClawStart {} => "openclaw.lifecycle.start",
        wire::Command::OpenClawStop {} => "openclaw.lifecycle.stop",
        wire::Command::OpenClawRestart {} => "openclaw.lifecycle.restart",
        wire::Command::OpenClawLogs { .. } => "openclaw.logs",
        wire::Command::OpenClawControlReady {} => "openclaw.control.ready",
        wire::Command::OpenClawGatewayHealth {} => "openclaw.gateway.health",
        wire::Command::OpenClawGatewayStatus {} => "openclaw.gateway.status",
        wire::Command::OpenClawControlUiUrl {} => "openclaw.control-ui.url",
        wire::Command::OpenClawManualCronTrigger { .. } => "openclaw.cron.manual-trigger",
        wire::Command::OpenClawBrowserRequest { .. } => "openclaw.browser.request",
        wire::Command::OpenClawMcpAppRequest { .. } => "openclaw.mcp-app.request",
        wire::Command::OpenClawChatSend { .. } => "openclaw.chat.send",
        wire::Command::OpenClawChatAbort { .. } => "openclaw.chat.abort",
        wire::Command::FleetCredentialsWrite { .. } => "fleet.credentials.write",
    }
}

async fn read_control_input<R>(mut input: R, sender: mpsc::Sender<Input>)
where
    R: AsyncRead + Unpin,
{
    loop {
        match frame::decode_next(&mut input).await {
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
    message: wire::Output,
) -> Result<(), ControlError> {
    let frame = wire::encode(&message).map_err(|_| ControlError::OutputEncoding)?;
    frame::encode(output, &frame)
        .await
        .map_err(|_| ControlError::Output)
}

fn project_event(event: HostEvent, observation: &ObservationSink) -> Option<wire::Output> {
    event_output::project_observed(event, observation)
        .map(|event| wire::Output::Event(wire::Event::new(event)))
}

async fn shutdown_host(owner: &mut host_actor::Owner) -> Result<(), ControlError> {
    loop {
        let attempt = owner
            .handle()
            .shutdown()
            .await
            .map_err(|_| ControlError::Owner)?;
        if attempt.terminal {
            let result = attempt
                .result
                .map(|_| ())
                .map_err(|_| ControlError::Shutdown);
            let joined = owner.join().await.map_err(|_| ControlError::Owner)?;
            joined.map_err(|_| ControlError::Shutdown)?;
            return result;
        }
        tokio::time::sleep(SHUTDOWN_RETRY_INTERVAL).await;
    }
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

#[cfg(test)]
#[path = "service_tests.rs"]
mod tests;
