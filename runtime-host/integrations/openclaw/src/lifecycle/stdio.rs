use std::sync::Arc;

use foundation::process::{
    ProcessObservation, ProcessStdio, StdioActivationResult, StdioDrain, StdioDrainResult,
    supervision::{PolicyFuture, StdioActivation},
};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio_util::sync::CancellationToken;

use super::logs::{LifecycleDiagnostic, LifecycleLogBuffer, LifecycleLogClassifier, LogStream};

const READ_CHUNK_BYTES: usize = 8 * 1024;

pub struct OpenClawStdioActivation {
    report_diagnostic: Arc<dyn Fn(LifecycleDiagnostic) + Send + Sync>,
    log_buffer: LifecycleLogBuffer,
}

impl OpenClawStdioActivation {
    pub fn new(report_diagnostic: Arc<dyn Fn(LifecycleDiagnostic) + Send + Sync>) -> Self {
        Self::with_log_buffer(report_diagnostic, LifecycleLogBuffer::new())
    }

    pub fn with_log_buffer(
        report_diagnostic: Arc<dyn Fn(LifecycleDiagnostic) + Send + Sync>,
        log_buffer: LifecycleLogBuffer,
    ) -> Self {
        Self {
            report_diagnostic,
            log_buffer,
        }
    }

    pub fn log_buffer(&self) -> LifecycleLogBuffer {
        self.log_buffer.clone()
    }
}

impl StdioActivation for OpenClawStdioActivation {
    fn activate(
        &self,
        _process: ProcessObservation,
        stdio: ProcessStdio,
        cancellation: CancellationToken,
    ) -> PolicyFuture<StdioActivationResult> {
        let report_diagnostic = Arc::clone(&self.report_diagnostic);
        let log_buffer = self.log_buffer.clone();
        Box::pin(async move {
            let (stdin, stdout, stderr) = stdio.into_parts();
            activate_stdio_with_buffer(
                stdin,
                stdout,
                stderr,
                cancellation,
                report_diagnostic,
                log_buffer,
            )
        })
    }
}

fn activate_stdio<I, O, E>(
    stdin: Option<I>,
    stdout: Option<O>,
    stderr: Option<E>,
    cancellation: CancellationToken,
    report_diagnostic: Arc<dyn Fn(LifecycleDiagnostic) + Send + Sync>,
) -> StdioActivationResult
where
    O: AsyncRead + Send + Unpin + 'static,
    E: AsyncRead + Send + Unpin + 'static,
{
    activate_stdio_with_buffer(
        stdin,
        stdout,
        stderr,
        cancellation,
        report_diagnostic,
        LifecycleLogBuffer::new(),
    )
}

fn activate_stdio_with_buffer<I, O, E>(
    stdin: Option<I>,
    stdout: Option<O>,
    stderr: Option<E>,
    cancellation: CancellationToken,
    report_diagnostic: Arc<dyn Fn(LifecycleDiagnostic) + Send + Sync>,
    log_buffer: LifecycleLogBuffer,
) -> StdioActivationResult
where
    O: AsyncRead + Send + Unpin + 'static,
    E: AsyncRead + Send + Unpin + 'static,
{
    if cancellation.is_cancelled() {
        return StdioActivationResult::Cancelled;
    }

    let (None, Some(stdout), Some(stderr)) = (stdin, stdout, stderr) else {
        return StdioActivationResult::Unavailable;
    };

    StdioActivationResult::Activated(StdioDrain::new(drain_outputs(
        stdout,
        stderr,
        report_diagnostic,
        log_buffer,
    )))
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

#[cfg(test)]
mod tests {
    use std::{
        io,
        pin::Pin,
        sync::{
            Mutex,
            atomic::{AtomicBool, Ordering},
        },
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

        let drain = activated(activate_stdio_with_buffer(
            None::<()>,
            Some(stdout),
            Some(stderr),
            CancellationToken::new(),
            Arc::clone(&activation.report_diagnostic),
            activation.log_buffer(),
        ));
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

    #[tokio::test]
    async fn cancelled_activation_precedes_stdio_shape_validation() {
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        assert!(matches!(
            activate_stdio(
                None::<()>,
                None::<tokio::io::Empty>,
                None::<tokio::io::Empty>,
                cancellation,
                no_diagnostics(),
            ),
            StdioActivationResult::Cancelled
        ));
    }

    #[test]
    fn rejects_missing_output_pipes_and_closes_unexpected_stdin() {
        for (stdout, stderr) in [
            (None, Some(tokio::io::empty())),
            (Some(tokio::io::empty()), None),
        ] {
            let result = activate_stdio(
                None::<DropProbe>,
                stdout,
                stderr,
                CancellationToken::new(),
                no_diagnostics(),
            );
            assert!(matches!(result, StdioActivationResult::Unavailable));
        }

        let dropped = Arc::new(AtomicBool::new(false));
        let result = activate_stdio(
            Some(DropProbe(Arc::clone(&dropped))),
            Some(tokio::io::empty()),
            Some(tokio::io::empty()),
            CancellationToken::new(),
            no_diagnostics(),
        );
        assert!(matches!(result, StdioActivationResult::Unavailable));
        assert!(dropped.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn eof_finishes_partial_lines_before_returning_drained() {
        let diagnostics = Arc::new(Mutex::new(Vec::new()));
        let activation = activation(Arc::clone(&diagnostics));
        let drain = activated(activate_stdio(
            None::<()>,
            Some(&b"[gateway] listening on ws://127.0.0.1:18789"[..]),
            Some(tokio::io::empty()),
            CancellationToken::new(),
            activation.report_diagnostic,
        ));

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
        let drain = activated(activate_stdio(
            None::<()>,
            Some(output),
            Some(io::Cursor::new(stderr.into_bytes())),
            CancellationToken::new(),
            activation.report_diagnostic,
        ));

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
        OpenClawStdioActivation::new(Arc::new(move |diagnostic| {
            diagnostics.lock().unwrap().push(diagnostic);
        }))
    }

    fn no_diagnostics() -> Arc<dyn Fn(LifecycleDiagnostic) + Send + Sync> {
        Arc::new(|_| {})
    }

    fn activated(result: StdioActivationResult) -> StdioDrain {
        match result {
            StdioActivationResult::Activated(drain) => drain,
            StdioActivationResult::Unavailable => panic!("stdio was unavailable"),
            StdioActivationResult::Cancelled => panic!("stdio was cancelled"),
        }
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

    struct DropProbe(Arc<AtomicBool>);

    impl Drop for DropProbe {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
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
