use std::sync::Arc;

use foundation::process::{
    ProcessObservation, ProcessStdio, StdioActivationResult, StdioDrain, StdioDrainResult,
    supervision::{PolicyFuture, StdioActivation},
};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio_util::sync::CancellationToken;

use super::output::{OutputStream, StartupDiagnostic, StartupOutputClassifier};

const READ_CHUNK_BYTES: usize = 8 * 1024;
type DiagnosticCallback = dyn Fn(StartupDiagnostic) + Send + Sync;
pub struct MatchaStdioActivation {
    report_diagnostic: Arc<DiagnosticCallback>,
}

impl MatchaStdioActivation {
    pub fn new(report_diagnostic: Arc<dyn Fn(StartupDiagnostic) + Send + Sync>) -> Self {
        Self { report_diagnostic }
    }
}

impl StdioActivation for MatchaStdioActivation {
    fn activate(
        &self,
        _process: ProcessObservation,
        stdio: ProcessStdio,
        cancellation: CancellationToken,
    ) -> PolicyFuture<StdioActivationResult> {
        let report_diagnostic = Arc::clone(&self.report_diagnostic);
        Box::pin(async move {
            let (stdin, stdout, stderr) = stdio.into_parts();
            drop(stdin);
            activate_stdio(stdout, stderr, cancellation, report_diagnostic)
        })
    }
}

fn activate_stdio<O, E>(
    stdout: Option<O>,
    stderr: Option<E>,
    cancellation: CancellationToken,
    report_diagnostic: Arc<DiagnosticCallback>,
) -> StdioActivationResult
where
    O: AsyncRead + Send + Unpin + 'static,
    E: AsyncRead + Send + Unpin + 'static,
{
    if cancellation.is_cancelled() {
        return StdioActivationResult::Cancelled;
    }

    let (Some(stdout), Some(stderr)) = (stdout, stderr) else {
        return StdioActivationResult::Unavailable;
    };

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
    let mut chunk = [0; READ_CHUNK_BYTES];

    loop {
        let read = output.read(&mut chunk).await?;
        if read == 0 {
            if let Some(diagnostic) = classifier.finish() {
                report_diagnostic(diagnostic);
            }
            return Ok(());
        }
        let bytes = &chunk[..read];
        classifier.push(bytes, |diagnostic| report_diagnostic(diagnostic));
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

    use tokio::io::{AsyncRead, AsyncWriteExt, ReadBuf};

    use super::*;
    use crate::lifecycle::output::StartupDiagnosticCategory;

    const CANARY: &str = "stdio-secret-canary-must-not-escape";

    #[tokio::test]
    async fn drains_duplex_outputs_concurrently_and_reports_only_diagnostics() {
        let diagnostics = Arc::new(Mutex::new(Vec::new()));
        let activation = activation(Arc::clone(&diagnostics));
        let (mut stdout_writer, stdout) = tokio::io::duplex(32);
        let (mut stderr_writer, stderr) = tokio::io::duplex(32);
        let stderr_drained = Arc::new(tokio::sync::Notify::new());

        let drain = activated(activate_stdio(
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
                .write_all(format!("matcha-app-server: {CANARY}\n").as_bytes())
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

    #[test]
    fn cancellation_precedes_shape_validation() {
        let activation = activation(Arc::new(Mutex::new(Vec::new())));
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        let result = activate_stdio(
            None::<tokio::io::Empty>,
            None::<tokio::io::Empty>,
            cancellation,
            activation.report_diagnostic,
        );

        assert!(matches!(result, StdioActivationResult::Cancelled));
    }

    #[test]
    fn missing_output_is_unavailable() {
        let activation = activation(Arc::new(Mutex::new(Vec::new())));

        let result = activate_stdio(
            None::<tokio::io::Empty>,
            Some(tokio::io::empty()),
            CancellationToken::new(),
            activation.report_diagnostic,
        );

        assert!(matches!(result, StdioActivationResult::Unavailable));
    }

    #[tokio::test]
    async fn read_error_waits_for_both_outputs_and_returns_unavailable() {
        let diagnostics = Arc::new(Mutex::new(Vec::new()));
        let activation = activation(Arc::clone(&diagnostics));
        let (mut stderr_writer, stderr) = tokio::io::duplex(32);
        let drain = activated(activate_stdio(
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
            .write_all(format!("The server configuration is invalid: {CANARY}\n").as_bytes())
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

    fn activation(diagnostics: Arc<Mutex<Vec<StartupDiagnostic>>>) -> MatchaStdioActivation {
        MatchaStdioActivation::new(Arc::new(move |diagnostic| {
            diagnostics.lock().unwrap().push(diagnostic)
        }))
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
