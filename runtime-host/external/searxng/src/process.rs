use std::{ffi::OsString, time::Duration};

use foundation::process::{
    FixedLaunch, LaunchSpec, ProcessContainment, ProcessObservation, ProcessStdio, ShutdownOutcome,
    StdioActivationResult, StdioDrain, StdioDrainResult, StdioMode, StdioSpec, TerminationOutcome,
    supervise,
    supervision::{
        CommandReceipt, GracefulStop, GracefulStopResult, PolicyFuture, ReadinessProbe,
        ReadinessResult, RestartDecision, RestartEpisode, RestartPolicy, StartOutcome,
        StartRecovery, StartRecoveryResult, StdioActivation, Supervisor, SupervisorFailure,
        SupervisorHandle,
    },
};
use tokio::{
    io::AsyncReadExt,
    sync::watch,
    time::{Instant, timeout_at},
};
use tokio_util::sync::CancellationToken;

use crate::{Engine, Error, ServiceInput, http, preparation::Execution};

#[derive(Clone)]
pub(crate) struct Ready {
    pub(crate) base_url: String,
    pub(crate) engines: Vec<Engine>,
}

pub(crate) fn launch(
    input: &ServiceInput,
    execution: Execution,
    client: reqwest::Client,
) -> Result<(Supervisor, watch::Receiver<Option<Ready>>), Error> {
    let arguments = vec![
        OsString::from("-I"),
        OsString::from("-B"),
        input.resources_dir.join("serve.py").into_os_string(),
        OsString::from("--source"),
        input.resources_dir.join("source").into_os_string(),
        OsString::from("--settings"),
        input.state_dir.join("settings.yml").into_os_string(),
        OsString::from("--host"),
        OsString::from("127.0.0.1"),
        OsString::from("--port"),
        OsString::from("0"),
    ];
    let spec = LaunchSpec::try_new(
        execution.python,
        input.state_dir.clone(),
        arguments,
        execution.environment,
        StdioSpec::new(StdioMode::Null, StdioMode::Piped, StdioMode::Piped),
    )
    .map_err(|_| Error::StartFailed)?;
    let (endpoint, port_receiver) = watch::channel(None);
    let (ready, receiver) = watch::channel(None);
    let supervisor = supervise(
        containment(input)?,
        FixedLaunch::new(spec),
        Output { endpoint },
        Readiness {
            endpoint: port_receiver,
            ready,
            client,
        },
        Stop,
        NoRetry,
        NoRetry,
    );
    Ok((supervisor, receiver))
}

pub(crate) fn containment(input: &ServiceInput) -> Result<ProcessContainment, Error> {
    #[cfg(windows)]
    {
        let _ = input;
        Ok(ProcessContainment::job())
    }
    #[cfg(unix)]
    {
        ProcessContainment::guardian(
            input
                .guardian_executable
                .clone()
                .ok_or(Error::ResourcesUnavailable)?,
        )
        .map_err(|_| Error::ResourcesUnavailable)
    }
}

pub(crate) async fn start(handle: &SupervisorHandle) -> Result<(), Error> {
    match handle.start().await {
        CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => {
            if matches!(completion.wait().await, Ok(StartOutcome::Started)) {
                Ok(())
            } else {
                Err(Error::StartFailed)
            }
        }
        _ => Err(Error::StartFailed),
    }
}

pub(crate) async fn shutdown(supervisor: &mut Supervisor) -> Result<(), Error> {
    let confirmed = match supervisor.handle().shutdown().await {
        CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => matches!(
            completion.wait().await,
            Ok(ShutdownOutcome::Terminated(
                TerminationOutcome::Forced(_)
                    | TerminationOutcome::Graceful(_)
                    | TerminationOutcome::NoProcess
            ))
        ),
        CommandReceipt::AlreadySatisfied => true,
        _ => false,
    };
    if !confirmed {
        return Err(Error::StopFailed);
    }
    supervisor.join().await.map_err(|_| Error::StopFailed)
}

struct Output {
    endpoint: watch::Sender<Option<String>>,
}

impl StdioActivation for Output {
    fn activate(
        &self,
        _: ProcessObservation,
        stdio: ProcessStdio,
        cancellation: CancellationToken,
    ) -> PolicyFuture<StdioActivationResult> {
        let endpoint = self.endpoint.clone();
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return StdioActivationResult::Cancelled;
            }
            let (_, stdout, stderr) = stdio.into_parts();
            let (Some(stdout), Some(mut stderr)) = (stdout, stderr) else {
                return StdioActivationResult::Unavailable;
            };
            StdioActivationResult::Activated(StdioDrain::new(async move {
                let mut sink = tokio::io::sink();
                let (stdout_result, stderr_result) = tokio::join!(
                    read_endpoint(stdout, endpoint),
                    tokio::io::copy(&mut stderr, &mut sink),
                );
                if stdout_result.is_ok() && stderr_result.is_ok() {
                    StdioDrainResult::Drained
                } else {
                    StdioDrainResult::Unavailable
                }
            }))
        })
    }
}

async fn read_endpoint(
    mut stdout: foundation::process::ProcessOutput,
    endpoint: watch::Sender<Option<String>>,
) -> std::io::Result<()> {
    let mut chunk = [0; 4096];
    let mut line = Vec::new();
    loop {
        let read = stdout.read(&mut chunk).await?;
        if read == 0 {
            return Ok(());
        }
        for byte in &chunk[..read] {
            if *byte == b'\n' {
                if let Some(port) = std::str::from_utf8(&line)
                    .ok()
                    .and_then(|line| {
                        line.trim_end_matches('\r')
                            .strip_prefix("MATCHA_SEARXNG_READY ")
                    })
                    .and_then(|port| port.parse::<u16>().ok())
                    .filter(|port| *port != 0)
                {
                    endpoint.send_replace(Some(format!("http://127.0.0.1:{port}")));
                }
                line.clear();
            } else if line.len() < 128 {
                line.push(*byte);
            }
        }
    }
}

struct Readiness {
    endpoint: watch::Receiver<Option<String>>,
    ready: watch::Sender<Option<Ready>>,
    client: reqwest::Client,
}

impl ReadinessProbe for Readiness {
    fn wait_ready(
        &self,
        _: ProcessObservation,
        cancellation: CancellationToken,
    ) -> PolicyFuture<ReadinessResult> {
        let mut endpoint = self.endpoint.clone();
        let client = self.client.clone();
        let published = self.ready.clone();
        Box::pin(async move {
            let ready = async {
                loop {
                    let base_url = endpoint.borrow().clone();
                    if let Some(base_url) = base_url {
                        return match http::catalog(client, &base_url).await {
                            Ok(engines) => {
                                published.send_replace(Some(Ready { base_url, engines }));
                                ReadinessResult::Ready
                            }
                            Err(_) => ReadinessResult::Unavailable,
                        };
                    }
                    if endpoint.changed().await.is_err() {
                        return ReadinessResult::Unavailable;
                    }
                }
            };
            tokio::select! {
                _ = cancellation.cancelled() => ReadinessResult::Cancelled,
                result = timeout_at(Instant::now() + Duration::from_secs(45), ready) => result.unwrap_or(ReadinessResult::Unavailable),
            }
        })
    }
}

struct Stop;

impl GracefulStop for Stop {
    fn grace_period(&self) -> Duration {
        Duration::ZERO
    }
    fn request_stop(
        &self,
        _: ProcessObservation,
        _: CancellationToken,
    ) -> PolicyFuture<GracefulStopResult> {
        // Waitress has no authenticated shutdown protocol; Foundation terminates only this owned scope.
        Box::pin(async { GracefulStopResult::Rejected })
    }
}

struct NoRetry;

impl StartRecovery for NoRetry {
    fn recover(
        &self,
        _: SupervisorFailure,
        _: CancellationToken,
    ) -> PolicyFuture<StartRecoveryResult> {
        Box::pin(async { StartRecoveryResult::Fail })
    }
}

impl RestartPolicy for NoRetry {
    fn decide(&self, _: &SupervisorFailure, _: RestartEpisode) -> RestartDecision {
        RestartDecision::Halt
    }
}
