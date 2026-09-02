use std::sync::{Arc, Mutex};

use foundation::process::{
    ProcessObservation, ProcessStdio, StdioActivationResult, StdioDrain, StdioDrainResult,
    supervision::{PolicyFuture, StdioActivation},
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use super::output::{OutputStream, StartupDiagnostic, StartupOutputClassifier};

const READ_CHUNK_BYTES: usize = 8 * 1024;
const FORWARDED_SESSION_TRACE_LINE_BYTES: usize = 8 * 1024;
const SESSION_TRACE_PREFIX: &str = "\"prefix\":\"session-trace\"";
type DiagnosticCallback = dyn Fn(StartupDiagnostic) + Send + Sync;
type OwnedStdin = Box<dyn AsyncWrite + Send + Unpin>;

#[derive(Clone)]
pub struct MatchaStdinControl {
    stdin: Arc<Mutex<Option<OwnedStdin>>>,
}

impl MatchaStdinControl {
    pub fn new() -> Self {
        Self {
            stdin: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn close_stdin(&self) -> std::io::Result<()> {
        let stdin = self
            .stdin
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        let Some(mut stdin) = stdin else {
            return Ok(());
        };
        stdin.shutdown().await
    }

    fn replace(&self, stdin: impl AsyncWrite + Send + Unpin + 'static) {
        *self.stdin.lock().unwrap_or_else(|error| error.into_inner()) = Some(Box::new(stdin));
    }

    fn clear(&self) {
        self.stdin
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
    }
}

impl Default for MatchaStdinControl {
    fn default() -> Self {
        Self::new()
    }
}

pub struct MatchaStdioActivation {
    stdin: MatchaStdinControl,
    report_diagnostic: Arc<DiagnosticCallback>,
}

impl MatchaStdioActivation {
    pub fn new(
        stdin: MatchaStdinControl,
        report_diagnostic: Arc<dyn Fn(StartupDiagnostic) + Send + Sync>,
    ) -> Self {
        Self {
            stdin,
            report_diagnostic,
        }
    }
}

impl StdioActivation for MatchaStdioActivation {
    fn activate(
        &self,
        _process: ProcessObservation,
        stdio: ProcessStdio,
        cancellation: CancellationToken,
    ) -> PolicyFuture<StdioActivationResult> {
        let stdin_control = self.stdin.clone();
        let report_diagnostic = Arc::clone(&self.report_diagnostic);
        Box::pin(async move {
            let (stdin, stdout, stderr) = stdio.into_parts();
            activate_stdio(
                stdin_control,
                stdin,
                stdout,
                stderr,
                cancellation,
                report_diagnostic,
            )
        })
    }
}

fn activate_stdio<I, O, E>(
    stdin_control: MatchaStdinControl,
    stdin: Option<I>,
    stdout: Option<O>,
    stderr: Option<E>,
    cancellation: CancellationToken,
    report_diagnostic: Arc<DiagnosticCallback>,
) -> StdioActivationResult
where
    I: AsyncWrite + Send + Unpin + 'static,
    O: AsyncRead + Send + Unpin + 'static,
    E: AsyncRead + Send + Unpin + 'static,
{
    if cancellation.is_cancelled() {
        stdin_control.clear();
        return StdioActivationResult::Cancelled;
    }

    let (Some(stdin), Some(stdout), Some(stderr)) = (stdin, stdout, stderr) else {
        stdin_control.clear();
        return StdioActivationResult::Unavailable;
    };
    stdin_control.replace(stdin);

    StdioActivationResult::Activated(StdioDrain::new(drain_outputs(
        stdout,
        stderr,
        report_diagnostic,
    )))
}

async fn drain_outputs<O, E>(
    stdout: O,
    stderr: E,
    report_diagnostic: Arc<DiagnosticCallback>,
) -> StdioDrainResult
where
    O: AsyncRead + Unpin,
    E: AsyncRead + Unpin,
{
    let stdout_diagnostics = Arc::clone(&report_diagnostic);
    let (stdout_result, stderr_result) = tokio::join!(
        drain_output(stdout, OutputStream::Stdout, stdout_diagnostics),
        drain_output(stderr, OutputStream::Stderr, report_diagnostic),
    );

    if stdout_result.is_ok() && stderr_result.is_ok() {
        StdioDrainResult::Drained
    } else {
        StdioDrainResult::Unavailable
    }
}

async fn drain_output(
    mut output: impl AsyncRead + Unpin,
    stream: OutputStream,
    report_diagnostic: Arc<DiagnosticCallback>,
) -> std::io::Result<()> {
    let mut classifier = StartupOutputClassifier::new(stream);
    let mut forwarder = SessionTraceForwarder::new();
    let mut chunk = [0; READ_CHUNK_BYTES];

    loop {
        let read = output.read(&mut chunk).await?;
        if read == 0 {
            if let Some(diagnostic) = classifier.finish() {
                report_diagnostic(diagnostic);
            }
            forwarder.finish();
            return Ok(());
        }
        let bytes = &chunk[..read];
        forwarder.push(bytes);
        classifier.push(bytes, |diagnostic| report_diagnostic(diagnostic));
    }
}

struct SessionTraceForwarder {
    line: Vec<u8>,
    discarding: bool,
}

impl SessionTraceForwarder {
    fn new() -> Self {
        Self {
            line: Vec::with_capacity(FORWARDED_SESSION_TRACE_LINE_BYTES),
            discarding: false,
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        let mut remaining = bytes;
        while let Some(newline) = remaining.iter().position(|byte| *byte == b'\n') {
            self.consume(&remaining[..newline], true);
            remaining = &remaining[newline + 1..];
        }
        self.consume(remaining, false);
    }

    fn finish(&mut self) {
        self.emit_buffered();
    }

    fn consume(&mut self, bytes: &[u8], terminated: bool) {
        if self.discarding {
            if terminated {
                self.line.clear();
                self.discarding = false;
            }
            return;
        }
        if self.line.len().saturating_add(bytes.len()) > FORWARDED_SESSION_TRACE_LINE_BYTES {
            self.line.clear();
            self.discarding = !terminated;
            return;
        }
        self.line.extend_from_slice(bytes);
        if terminated {
            self.emit_buffered();
        }
    }

    fn emit_buffered(&mut self) {
        let content_end = self.line.len() - usize::from(self.line.last() == Some(&b'\r'));
        if let Ok(line) = std::str::from_utf8(&self.line[..content_end])
            && line.contains(SESSION_TRACE_PREFIX)
        {
            eprintln!("{line}");
        }
        self.line.clear();
    }
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

    use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt, ReadBuf};

    use super::*;
    use crate::lifecycle::output::StartupDiagnosticCategory;

    const CANARY: &str = "stdio-secret-canary-must-not-escape";

    #[tokio::test]
    async fn drains_duplex_outputs_concurrently_and_reports_only_diagnostics() {
        let diagnostics = Arc::new(Mutex::new(Vec::new()));
        let (activation, _) = activation(Arc::clone(&diagnostics));
        let (mut stdout_writer, stdout) = tokio::io::duplex(32);
        let (mut stderr_writer, stderr) = tokio::io::duplex(32);
        let stderr_drained = Arc::new(tokio::sync::Notify::new());

        let drain = activated(activate_stdio(
            activation.stdin,
            Some(tokio::io::sink()),
            Some(stdout),
            Some(stderr),
            CancellationToken::new(),
            activation.report_diagnostic,
        ));
        let stdout_release = Arc::clone(&stderr_drained);
        let stdout_task = async move {
            stdout_writer
                .write_all(b"app-server stdout\n")
                .await
                .unwrap();
            stdout_release.notified().await;
            stdout_writer.shutdown().await.unwrap();
        };
        let stderr_task = async move {
            stderr_writer
                .write_all(format!("[app-server:bootstrap] {CANARY}\n").as_bytes())
                .await
                .unwrap();
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
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(
            diagnostics[0].category(),
            StartupDiagnosticCategory::AppServerReportedError
        );
        assert_canary_absent(&diagnostics);
    }

    #[tokio::test]
    async fn shared_stdin_control_closes_with_eof_once() {
        let (activation, stdin_control) = activation(Arc::new(Mutex::new(Vec::new())));
        let (host_stdin, mut child_stdin) = tokio::io::duplex(32);
        let drain = activated(activate_stdio(
            activation.stdin,
            Some(host_stdin),
            Some(tokio::io::empty()),
            Some(tokio::io::empty()),
            CancellationToken::new(),
            activation.report_diagnostic,
        ));

        assert_eq!(drain.await, StdioDrainResult::Drained);
        let (first, second) =
            tokio::join!(stdin_control.close_stdin(), stdin_control.close_stdin());
        first.unwrap();
        second.unwrap();
        let mut remainder = Vec::new();
        child_stdin.read_to_end(&mut remainder).await.unwrap();
        assert!(remainder.is_empty());
    }

    #[test]
    fn cancellation_precedes_shape_validation_and_clears_stdin_custody() {
        let (activation, stdin_control) = activation(Arc::new(Mutex::new(Vec::new())));
        stdin_control.replace(tokio::io::sink());
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        let result = activate_stdio(
            activation.stdin,
            None::<tokio::io::Sink>,
            None::<tokio::io::Empty>,
            None::<tokio::io::Empty>,
            cancellation,
            activation.report_diagnostic,
        );

        assert!(matches!(result, StdioActivationResult::Cancelled));
        assert!(stdin_control.stdin.lock().unwrap().is_none());
    }

    #[test]
    fn unavailable_stdio_shape_clears_stdin_custody() {
        let (activation, stdin_control) = activation(Arc::new(Mutex::new(Vec::new())));
        stdin_control.replace(tokio::io::sink());

        let result = activate_stdio(
            activation.stdin,
            Some(tokio::io::sink()),
            None::<tokio::io::Empty>,
            Some(tokio::io::empty()),
            CancellationToken::new(),
            activation.report_diagnostic,
        );

        assert!(matches!(result, StdioActivationResult::Unavailable));
        assert!(stdin_control.stdin.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn read_error_waits_for_both_outputs_and_returns_unavailable() {
        let diagnostics = Arc::new(Mutex::new(Vec::new()));
        let (activation, _) = activation(Arc::clone(&diagnostics));
        let (mut stderr_writer, stderr) = tokio::io::duplex(32);
        let drain = activated(activate_stdio(
            activation.stdin,
            Some(tokio::io::sink()),
            Some(ErrorAfterChunk::new(
                format!("ignored stdout {CANARY}\n").into_bytes(),
            )),
            Some(stderr),
            CancellationToken::new(),
            activation.report_diagnostic,
        ));
        let drain_task = tokio::spawn(drain);

        tokio::task::yield_now().await;
        assert!(!drain_task.is_finished());
        stderr_writer
            .write_all(format!("Unknown app-server option: {CANARY}\n").as_bytes())
            .await
            .unwrap();
        stderr_writer.shutdown().await.unwrap();

        let result = drain_task.await.unwrap();
        assert_eq!(result, StdioDrainResult::Unavailable);
        assert!(!format!("{result:?}").contains(CANARY));
        let diagnostics = diagnostics.lock().unwrap();
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(
            diagnostics[0].category(),
            StartupDiagnosticCategory::ConfigurationRejected
        );
        assert_canary_absent(&diagnostics);
    }

    fn activation(
        diagnostics: Arc<Mutex<Vec<StartupDiagnostic>>>,
    ) -> (MatchaStdioActivation, MatchaStdinControl) {
        let stdin = MatchaStdinControl::new();
        let activation = MatchaStdioActivation::new(
            stdin.clone(),
            Arc::new(move |diagnostic| diagnostics.lock().unwrap().push(diagnostic)),
        );
        (activation, stdin)
    }

    fn activated(result: StdioActivationResult) -> StdioDrain {
        match result {
            StdioActivationResult::Activated(drain) => drain,
            StdioActivationResult::Unavailable => panic!("stdio was unavailable"),
            StdioActivationResult::Cancelled => panic!("stdio was cancelled"),
        }
    }

    fn assert_canary_absent(diagnostics: &[StartupDiagnostic]) {
        assert!(!format!("{diagnostics:?}").contains(CANARY));
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
