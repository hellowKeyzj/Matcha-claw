use super::process::{Output, Process};
use crate::{
    config::{Config, Paths},
    rpc::{self, Error},
};

pub struct CommandOutput {
    pub code: Option<i32>,
    pub stdout: String,
}

pub async fn run(
    config: &Config,
    paths: &Paths,
    agent_id: &str,
    args: Vec<String>,
) -> rpc::Result<CommandOutput> {
    let (output, stderr_observed) = execute(config, paths, agent_id, args, None).await?;
    successful(output, stderr_observed)
}

pub(crate) async fn run_bounded(
    launch: super::process::Launch,
    max_stdout: usize,
    deadline: std::time::Duration,
) -> rpc::Result<CommandOutput> {
    let (output, stderr_observed) = execute_launch(launch, Some((max_stdout, deadline))).await?;
    successful(output, stderr_observed)
}

fn successful(output: CommandOutput, stderr_observed: bool) -> rpc::Result<CommandOutput> {
    if output.code != Some(0) {
        return Err(Error::new(
            -32004,
            "native_command_exit",
            "The native command exited unsuccessfully",
        )
        .with_data(
            serde_json::json!({"exitCode": output.code, "stderrObserved": stderr_observed}),
        ));
    }
    Ok(output)
}

pub async fn run_observed(
    config: &Config,
    paths: &Paths,
    agent_id: &str,
    args: Vec<String>,
) -> rpc::Result<CommandOutput> {
    execute(config, paths, agent_id, args, None)
        .await
        .map(|(output, _)| output)
}

async fn execute(
    config: &Config,
    paths: &Paths,
    agent_id: &str,
    args: Vec<String>,
    limits: Option<(usize, std::time::Duration)>,
) -> rpc::Result<(CommandOutput, bool)> {
    let launch = super::projection::launch(config, paths, agent_id, args).await?;
    execute_launch(launch, limits).await
}

async fn execute_launch(
    launch: super::process::Launch,
    limits: Option<(usize, std::time::Duration)>,
) -> rpc::Result<(CommandOutput, bool)> {
    let (process, mut output) = Process::spawn(launch).await?;
    let mut cleanup = ReapOnDrop::new(process.clone());
    let observing = async {
        process.finish_input().await?;
        let mut stdout = Vec::new();
        let mut stderr_observed = false;
        while let Some(event) = output.recv().await {
            match event {
                Output::Stdout(bytes) => {
                    if limits.is_some_and(|(maximum, _)| {
                        bytes.len() > maximum.saturating_sub(stdout.len())
                    }) {
                        return Err(Error::new(
                            -32004,
                            "native_command_stdout_limit",
                            "Native command stdout exceeded its bounded response size",
                        ));
                    }
                    stdout.extend_from_slice(&bytes);
                }
                Output::Stderr => stderr_observed = true,
                Output::StdoutClosed => {}
                Output::ReadFailed { stream, kind } => {
                    return Err(Error::new(-32004, "native_command_read", "Reading native command output failed")
                        .with_data(serde_json::json!({"stream": stream, "reason": kind, "stderrObserved": stderr_observed})));
                }
                Output::Exited { code, signal } => {
                    if signal.is_some() || code.is_none() {
                        return Err(Error::new(-32004, "native_command_terminated", "The native command terminated without an exit code")
                            .with_data(serde_json::json!({"exitCode": code, "signal": signal, "stderrObserved": stderr_observed})));
                    }
                    let stdout = String::from_utf8(stdout).map_err(|_| {
                        Error::new(
                            -32004,
                            "native_command_encoding",
                            "Native command stdout was not UTF-8",
                        )
                    })?;
                    return Ok((CommandOutput { code, stdout }, stderr_observed));
                }
            }
        }
        Err(Error::new(
            -32006,
            "native_command_exit_unobserved",
            "The native command output closed before its exit was observed",
        ))
    };
    let result = match limits {
        Some((_, deadline)) => tokio::time::timeout(deadline, observing)
            .await
            .unwrap_or_else(|_| {
                Err(Error::new(
                    -32004,
                    "native_command_timeout",
                    "The native capability command did not finish before its deadline",
                ))
            }),
        None => observing.await,
    };
    let reclaimed = process.close().await;
    cleanup.disarm();
    combine_cleanup(result, reclaimed)
}

pub(super) fn combine_cleanup<T>(
    result: rpc::Result<T>,
    cleanup: rpc::Result<()>,
) -> rpc::Result<T> {
    match (result, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Ok(_), Err(error)) => Err(error),
        (Err(error), Ok(())) => Err(error),
        (Err(error), Err(cleanup)) => Err(error.with_data(serde_json::json!({
            "cleanupError": {"code": cleanup.code, "data": cleanup.data}
        }))),
    }
}

// Cancellation drops the observer, not ownership of the child process.
pub(super) struct ReapOnDrop(Option<Process>);

impl ReapOnDrop {
    pub(super) fn new(process: Process) -> Self {
        Self(Some(process))
    }

    pub(super) fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for ReapOnDrop {
    fn drop(&mut self) {
        if let Some(process) = self.0.take() {
            tokio::spawn(async move {
                if process.close().await.is_err() {
                    eprintln!("native CLI cleanup could not be confirmed");
                }
            });
        }
    }
}
