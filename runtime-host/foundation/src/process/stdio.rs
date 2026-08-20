use std::{
    future::Future,
    io,
    pin::Pin,
    task::{Context, Poll},
};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StdioMode {
    Null,
    Piped,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StdioSpec {
    stdin: StdioMode,
    stdout: StdioMode,
    stderr: StdioMode,
}

impl StdioSpec {
    pub const fn new(stdin: StdioMode, stdout: StdioMode, stderr: StdioMode) -> Self {
        Self {
            stdin,
            stdout,
            stderr,
        }
    }

    pub const fn stdin(&self) -> StdioMode {
        self.stdin
    }

    pub const fn stdout(&self) -> StdioMode {
        self.stdout
    }

    pub const fn stderr(&self) -> StdioMode {
        self.stderr
    }
}

pub struct ProcessStdin {
    inner: Pin<Box<dyn AsyncWrite + Send + Unpin>>,
}

impl ProcessStdin {
    pub(crate) fn new(inner: impl AsyncWrite + Send + Unpin + 'static) -> Self {
        Self {
            inner: Box::pin(inner),
        }
    }
}

impl AsyncWrite for ProcessStdin {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.inner.as_mut().poll_write(context, buffer)
    }

    fn poll_flush(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.inner.as_mut().poll_flush(context)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.inner.as_mut().poll_shutdown(context)
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffers: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        self.inner.as_mut().poll_write_vectored(context, buffers)
    }
}

pub struct ProcessOutput {
    inner: Pin<Box<dyn AsyncRead + Send + Unpin>>,
}

impl ProcessOutput {
    pub(crate) fn new(inner: impl AsyncRead + Send + Unpin + 'static) -> Self {
        Self {
            inner: Box::pin(inner),
        }
    }
}

impl AsyncRead for ProcessOutput {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        self.inner.as_mut().poll_read(context, buffer)
    }
}

pub struct ProcessStdio {
    stdin: Option<ProcessStdin>,
    stdout: Option<ProcessOutput>,
    stderr: Option<ProcessOutput>,
}

impl ProcessStdio {
    pub(crate) const fn new(
        stdin: Option<ProcessStdin>,
        stdout: Option<ProcessOutput>,
        stderr: Option<ProcessOutput>,
    ) -> Self {
        Self {
            stdin,
            stdout,
            stderr,
        }
    }

    pub fn into_parts(
        self,
    ) -> (
        Option<ProcessStdin>,
        Option<ProcessOutput>,
        Option<ProcessOutput>,
    ) {
        (self.stdin, self.stdout, self.stderr)
    }
}

pub struct StdioDrain {
    inner: Pin<Box<dyn Future<Output = StdioDrainResult> + Send + 'static>>,
}

impl StdioDrain {
    pub fn new(future: impl Future<Output = StdioDrainResult> + Send + 'static) -> Self {
        Self {
            inner: Box::pin(future),
        }
    }
}

impl Future for StdioDrain {
    type Output = StdioDrainResult;

    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        self.inner.as_mut().poll(context)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StdioDrainResult {
    Drained,
    Unavailable,
    Cancelled,
}

pub enum StdioActivationResult {
    Activated(StdioDrain),
    Unavailable,
    Cancelled,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stdio_spec_preserves_each_stream_mode() {
        let spec = StdioSpec::new(StdioMode::Piped, StdioMode::Null, StdioMode::Piped);

        assert_eq!(spec.stdin(), StdioMode::Piped);
        assert_eq!(spec.stdout(), StdioMode::Null);
        assert_eq!(spec.stderr(), StdioMode::Piped);
    }

    #[test]
    fn process_stdio_transfers_stream_ownership_without_materializing_output() {
        let stdio = ProcessStdio::new(
            Some(ProcessStdin::new(tokio::io::sink())),
            Some(ProcessOutput::new(tokio::io::empty())),
            None,
        );

        let (stdin, stdout, stderr) = stdio.into_parts();

        assert!(stdin.is_some());
        assert!(stdout.is_some());
        assert!(stderr.is_none());
    }
}
