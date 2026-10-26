use std::sync::Arc;

use foundation::process::{
    ProcessObservation, ProcessStdio, StdioActivationResult, StdioDrain, StdioDrainResult,
    supervision::{PolicyFuture, StdioActivation},
};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio_util::sync::CancellationToken;

use super::{
    logs::{LifecycleDiagnostic, LifecycleLogBuffer, LifecycleLogClassifier, LogStream},
    stop::OpenClawGracefulStop,
};

const READ_CHUNK_BYTES: usize = 8 * 1024;

pub struct OpenClawStdioActivation {
    report_diagnostic: Arc<dyn Fn(LifecycleDiagnostic) + Send + Sync>,
    log_buffer: LifecycleLogBuffer,
    graceful_stop: OpenClawGracefulStop,
}

impl OpenClawStdioActivation {
    pub fn new(
        report_diagnostic: Arc<dyn Fn(LifecycleDiagnostic) + Send + Sync>,
        graceful_stop: OpenClawGracefulStop,
    ) -> Self {
        Self::with_log_buffer(report_diagnostic, LifecycleLogBuffer::new(), graceful_stop)
    }

    pub fn with_log_buffer(
        report_diagnostic: Arc<dyn Fn(LifecycleDiagnostic) + Send + Sync>,
        log_buffer: LifecycleLogBuffer,
        graceful_stop: OpenClawGracefulStop,
    ) -> Self {
        Self {
            report_diagnostic,
            log_buffer,
            graceful_stop,
        }
    }

    pub fn log_buffer(&self) -> LifecycleLogBuffer {
        self.log_buffer.clone()
    }
}

impl StdioActivation for OpenClawStdioActivation {
    fn activate(
        &self,
        process: ProcessObservation,
        stdio: ProcessStdio,
        cancellation: CancellationToken,
    ) -> PolicyFuture<StdioActivationResult> {
        let report_diagnostic = Arc::clone(&self.report_diagnostic);
        let log_buffer = self.log_buffer.clone();
        let graceful_stop = self.graceful_stop.clone();
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return StdioActivationResult::Cancelled;
            }
            let (Some(stdin), Some(stdout), Some(stderr)) = stdio.into_parts() else {
                return StdioActivationResult::Unavailable;
            };
            let Some(stdin_guard) = graceful_stop.bind_stdin(process, stdin, &cancellation) else {
                return StdioActivationResult::Cancelled;
            };
            StdioActivationResult::Activated(StdioDrain::new(async move {
                let _stdin_guard = stdin_guard;
                drain_outputs(stdout, stderr, report_diagnostic, log_buffer).await
            }))
        })
    }
}

async fn drain_outputs<O, E>(
    stdout: O,
    stderr: E,
    report_diagnostic: Arc<dyn Fn(LifecycleDiagnostic) + Send + Sync>,
    log_buffer: LifecycleLogBuffer,
) -> StdioDrainResult
where
    O: AsyncRead + Send + Unpin + 'static,
    E: AsyncRead + Send + Unpin + 'static,
{
    let stdout_diagnostics = Arc::clone(&report_diagnostic);
    let stdout_buffer = log_buffer.clone();
    let (stdout_result, stderr_result) = tokio::join!(
        drain_output(stdout, LogStream::Stdout, stdout_diagnostics, stdout_buffer),
        drain_output(stderr, LogStream::Stderr, report_diagnostic, log_buffer),
    );

    if stdout_result.is_ok() && stderr_result.is_ok() {
        StdioDrainResult::Drained
    } else {
        StdioDrainResult::Unavailable
    }
}

async fn drain_output(
    mut output: impl AsyncRead + Unpin,
    stream: LogStream,
    report_diagnostic: Arc<dyn Fn(LifecycleDiagnostic) + Send + Sync>,
    log_buffer: LifecycleLogBuffer,
) -> std::io::Result<()> {
    let mut classifier = LifecycleLogClassifier::with_buffer(stream, log_buffer);
    let mut chunk = [0; READ_CHUNK_BYTES];

    loop {
        let read = output.read(&mut chunk).await?;
        if read == 0 {
            for diagnostic in classifier.finish() {
                LifecycleDiagnostic::state().record(diagnostic);
                report_diagnostic(diagnostic);
            }
            return Ok(());
        }
        for diagnostic in classifier.push(&chunk[..read]) {
            LifecycleDiagnostic::state().record(diagnostic);
            report_diagnostic(diagnostic);
        }
    }
}

#[cfg(all(test, windows))]
pub(super) async fn with_process_stdio<T, F>(
    spec: foundation::process::StdioSpec,
    check: impl FnOnce(ProcessObservation, ProcessStdio) -> F,
) -> T
where
    F: std::future::Future<Output = T>,
{
    use std::{sync::Mutex, time::Duration};

    use foundation::process::{
        FixedLaunch, LaunchSpec, ProcessContainment, ShutdownOutcome, supervise,
        supervision::{CommandReceipt, ReadinessProbe, ReadinessResult},
    };
    use tokio::{sync::oneshot, time::timeout};

    const DEADLINE: Duration = Duration::from_secs(5);

    #[derive(Clone)]
    struct Capture {
        sender: Arc<Mutex<Option<oneshot::Sender<(ProcessObservation, ProcessStdio)>>>>,
        release: CancellationToken,
    }

    impl StdioActivation for Capture {
        fn activate(
            &self,
            process: ProcessObservation,
            stdio: ProcessStdio,
            _: CancellationToken,
        ) -> PolicyFuture<StdioActivationResult> {
            let sender = self.sender.lock().unwrap().take();
            let release = self.release.clone();
            Box::pin(async move {
                if let Some(sender) = sender {
                    let _ = sender.send((process, stdio));
                }
                StdioActivationResult::Activated(StdioDrain::new(async move {
                    release.cancelled().await;
                    StdioDrainResult::Drained
                }))
            })
        }
    }

    impl ReadinessProbe for Capture {
        fn wait_ready(
            &self,
            _: ProcessObservation,
            _: CancellationToken,
        ) -> PolicyFuture<ReadinessResult> {
            Box::pin(async { ReadinessResult::Ready })
        }
    }

    let executable = std::env::current_exe().unwrap();
    let launch = LaunchSpec::try_new_inheriting_environment(
        executable.clone(),
        executable.parent().unwrap().to_path_buf(),
        [
            "--exact".into(),
            "surfaces::channels::gateway::pairing::tests::timeout_child_entry".into(),
            "--nocapture".into(),
        ],
        [("MATCHA_PAIRING_TIMEOUT_CHILD".into(), "1".into())],
        spec,
    )
    .unwrap();
    let (sender, receiver) = oneshot::channel();
    let release = CancellationToken::new();
    let capture = Capture {
        sender: Arc::new(Mutex::new(Some(sender))),
        release: release.clone(),
    };
    let mut supervisor = supervise(
        ProcessContainment::job(),
        FixedLaunch::new(launch),
        capture.clone(),
        capture,
        OpenClawGracefulStop::new(),
        super::recovery::OpenClawStartRecovery::new(),
        super::restart::OpenClawRestartPolicy,
    );
    let handle = supervisor.handle();
    let receipt = timeout(DEADLINE, handle.start()).await;
    let result = if matches!(
        &receipt,
        Ok(CommandReceipt::Accepted(_) | CommandReceipt::Shared(_))
    ) {
        timeout(DEADLINE, async move {
            let Ok((process, stdio)) = receiver.await else {
                return None;
            };
            Some(check(process, stdio).await)
        })
        .await
        .ok()
        .flatten()
    } else {
        None
    };
    release.cancel();
    let shutdown = timeout(DEADLINE, async {
        match handle.shutdown().await {
            CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => {
                completion.wait().await.ok()
            }
            _ => None,
        }
    })
    .await;
    let joined = timeout(DEADLINE, supervisor.join()).await;
    assert!(matches!(shutdown, Ok(Some(ShutdownOutcome::Terminated(_)))));
    assert!(matches!(joined, Ok(Ok(()))));
    result.expect("real stdio check did not finish within its bound")
}

#[cfg(test)]
mod tests {
    use std::{
        io,
        pin::Pin,
        sync::Mutex,
        task::{Context, Poll},
        time::Duration,
    };

    use tokio::{
        io::{AsyncRead, AsyncWriteExt, ReadBuf},
        sync::Notify,
    };

    use super::*;
    use crate::lifecycle::logs::LifecycleDiagnosticCategory;

    const SECRET_CANARY: &str = "stdio-secret-canary-must-not-escape";
    const CONFIG_CANARY: &str = "stdio-config-canary-must-not-escape";
    const PATH_CANARY: &str = "stdio-path-canary-must-not-escape";
    const TRANSCRIPT_CANARY: &str = "stdio-transcript-canary-must-not-escape";
    const CANARIES: [&str; 4] = [SECRET_CANARY, CONFIG_CANARY, PATH_CANARY, TRANSCRIPT_CANARY];

    #[tokio::test]
    async fn drains_both_outputs_concurrently_and_reports_only_diagnostics() {
        let diagnostics = Arc::new(Mutex::new(Vec::new()));
        let activation = activation(Arc::clone(&diagnostics));
        let (mut stdout_writer, stdout) = tokio::io::duplex(32);
        let (mut stderr_writer, stderr) = tokio::io::duplex(32);
        let stderr_drained = Arc::new(Notify::new());

        let drain = drain_outputs(
            stdout,
            stderr,
            Arc::clone(&activation.report_diagnostic),
            activation.log_buffer(),
        );
        let stdout_release = Arc::clone(&stderr_drained);
        let stdout_task = async move {
            stdout_writer
                .write_all(b"[gateway] listening on ws://127.0.0.1:18789\n")
                .await
                .unwrap();
            stdout_release.notified().await;
            stdout_writer.shutdown().await.unwrap();
        };
        let stderr_task = async move {
            let line = format!(
                "Gateway start blocked: {SECRET_CANARY} {CONFIG_CANARY} {PATH_CANARY} {TRANSCRIPT_CANARY}{}\n",
                "x".repeat(256),
            );
            stderr_writer.write_all(line.as_bytes()).await.unwrap();
            stderr_writer.shutdown().await.unwrap();
            stderr_drained.notify_one();
        };

        let (result, (), ()) = tokio::time::timeout(Duration::from_secs(1), async {
            tokio::join!(drain, stdout_task, stderr_task)
        })
        .await
        .expect("concurrent stdio drain exceeded its bound");

        assert_eq!(result, StdioDrainResult::Drained);
        let diagnostics = diagnostics.lock().unwrap();
        assert_eq!(diagnostics.len(), 2);
        assert!(diagnostics.iter().any(|diagnostic| {
            diagnostic.stream() == LogStream::Stdout
                && diagnostic.category() == LifecycleDiagnosticCategory::ListenerReported
        }));
        assert!(diagnostics.iter().any(|diagnostic| {
            diagnostic.stream() == LogStream::Stderr
                && diagnostic.category() == LifecycleDiagnosticCategory::ConfigurationRejected
        }));
        assert_canary_absent(&diagnostics);
        let entries = activation.log_buffer().snapshot();
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().any(|entry| {
            entry.stream() == LogStream::Stdout && entry.line().contains("[gateway] listening on")
        }));
        assert!(
            entries
                .iter()
                .all(|entry| { CANARIES.iter().all(|canary| !entry.line().contains(canary)) })
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn cancelled_activation_precedes_stdio_shape_validation() {
        use foundation::process::{StdioMode, StdioSpec};

        let cancelled = with_process_stdio(
            StdioSpec::new(StdioMode::Null, StdioMode::Null, StdioMode::Null),
            |process, stdio| async move {
                let cancellation = CancellationToken::new();
                cancellation.cancel();
                matches!(
                    OpenClawStdioActivation::new(no_diagnostics(), OpenClawGracefulStop::new())
                        .activate(process, stdio, cancellation)
                        .await,
                    StdioActivationResult::Cancelled
                )
            },
        )
        .await;

        assert!(cancelled);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn requires_owned_stdin_and_both_output_pipes_and_cleans_bound_stdin() {
        use foundation::process::{
            StdioMode, StdioSpec,
            supervision::{GracefulStop, GracefulStopResult},
        };

        for spec in [
            StdioSpec::new(StdioMode::Piped, StdioMode::Null, StdioMode::Piped),
            StdioSpec::new(StdioMode::Piped, StdioMode::Piped, StdioMode::Null),
            StdioSpec::new(StdioMode::Null, StdioMode::Piped, StdioMode::Piped),
        ] {
            let unavailable = with_process_stdio(spec, |process, stdio| async move {
                matches!(
                    OpenClawStdioActivation::new(no_diagnostics(), OpenClawGracefulStop::new())
                        .activate(process, stdio, CancellationToken::new())
                        .await,
                    StdioActivationResult::Unavailable
                )
            })
            .await;
            assert!(unavailable);
        }

        for request_before_drop in [false, true] {
            let (was_activated, requested, after_drop) = with_process_stdio(
                StdioSpec::new(StdioMode::Piped, StdioMode::Piped, StdioMode::Piped),
                move |process, stdio| async move {
                    let stop = OpenClawGracefulStop::new();
                    let result = OpenClawStdioActivation::new(no_diagnostics(), stop.clone())
                        .activate(process, stdio, CancellationToken::new())
                        .await;
                    let was_activated = matches!(&result, StdioActivationResult::Activated(_));
                    let requested = if request_before_drop {
                        Some(stop.request_stop(process, CancellationToken::new()).await)
                    } else {
                        None
                    };
                    drop(result);
                    let after_drop = stop.request_stop(process, CancellationToken::new()).await;
                    (was_activated, requested, after_drop)
                },
            )
            .await;
            assert!(was_activated);
            if request_before_drop {
                assert_eq!(requested, Some(GracefulStopResult::Requested));
            }
            assert_eq!(after_drop, GracefulStopResult::Rejected);
        }
    }

    #[tokio::test]
    async fn eof_finishes_partial_lines_before_returning_drained() {
        let diagnostics = Arc::new(Mutex::new(Vec::new()));
        let activation = activation(Arc::clone(&diagnostics));
        let drain = drain_outputs(
            &b"[gateway] listening on ws://127.0.0.1:18789"[..],
            tokio::io::empty(),
            Arc::clone(&activation.report_diagnostic),
            activation.log_buffer(),
        );

        assert_eq!(drain.await, StdioDrainResult::Drained);
        let diagnostics = diagnostics.lock().unwrap();
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].stream(), LogStream::Stdout);
        assert_eq!(
            diagnostics[0].category(),
            LifecycleDiagnosticCategory::ListenerReported
        );
    }

    #[tokio::test]
    async fn read_error_waits_for_the_other_stream_without_leaking_source_bytes() {
        let diagnostics = Arc::new(Mutex::new(Vec::new()));
        let activation = activation(Arc::clone(&diagnostics));
        let output = ErrorAfterChunk::new(
            format!(
                "[gateway] listening on ws://127.0.0.1:18789 {SECRET_CANARY} {CONFIG_CANARY} {PATH_CANARY} {TRANSCRIPT_CANARY}\n"
            )
            .into_bytes(),
        );
        let stderr = format!(
            "Gateway start blocked: {SECRET_CANARY} {CONFIG_CANARY} {PATH_CANARY} {TRANSCRIPT_CANARY}\n"
        );
        let drain = drain_outputs(
            output,
            io::Cursor::new(stderr.into_bytes()),
            Arc::clone(&activation.report_diagnostic),
            activation.log_buffer(),
        );

        let result = drain.await;

        assert_eq!(result, StdioDrainResult::Unavailable);
        for canary in CANARIES {
            assert!(!format!("{result:?}").contains(canary));
        }
        let diagnostics = diagnostics.lock().unwrap();
        assert_eq!(diagnostics.len(), 2);
        assert!(diagnostics.iter().any(|diagnostic| {
            diagnostic.stream() == LogStream::Stdout
                && diagnostic.category() == LifecycleDiagnosticCategory::ListenerReported
        }));
        assert!(diagnostics.iter().any(|diagnostic| {
            diagnostic.stream() == LogStream::Stderr
                && diagnostic.category() == LifecycleDiagnosticCategory::ConfigurationRejected
        }));
        assert_canary_absent(&diagnostics);
    }

    fn activation(diagnostics: Arc<Mutex<Vec<LifecycleDiagnostic>>>) -> OpenClawStdioActivation {
        OpenClawStdioActivation::new(
            Arc::new(move |diagnostic| {
                diagnostics.lock().unwrap().push(diagnostic);
            }),
            OpenClawGracefulStop::new(),
        )
    }

    #[cfg(windows)]
    fn no_diagnostics() -> Arc<dyn Fn(LifecycleDiagnostic) + Send + Sync> {
        Arc::new(|_| {})
    }

    fn assert_canary_absent(diagnostics: &[LifecycleDiagnostic]) {
        for diagnostic in diagnostics {
            let display = diagnostic.to_string();
            let debug = format!("{diagnostic:?}");
            for canary in CANARIES {
                assert!(!display.contains(canary));
                assert!(!debug.contains(canary));
            }
        }
    }

    struct ErrorAfterChunk {
        chunk: Option<Vec<u8>>,
    }

    impl ErrorAfterChunk {
        fn new(chunk: Vec<u8>) -> Self {
            Self { chunk: Some(chunk) }
        }
    }

    impl AsyncRead for ErrorAfterChunk {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _context: &mut Context<'_>,
            buffer: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            if let Some(chunk) = self.chunk.take() {
                buffer.put_slice(&chunk);
                Poll::Ready(Ok(()))
            } else {
                Poll::Ready(Err(io::Error::other("fixed read failure")))
            }
        }
    }
}
