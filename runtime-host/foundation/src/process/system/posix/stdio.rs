use std::ffi::CString;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::task::{Context, Poll};

use tokio::io::unix::AsyncFd;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use super::super::super::{ProcessOutput, ProcessStdin, ProcessStdio, StdioMode, StdioSpec};
use super::io::pipe_cloexec;

const TARGET_STDIO_COUNT: usize = 3;

pub(super) struct HostStdio {
    target: Option<[OwnedFd; TARGET_STDIO_COUNT]>,
    process: Option<ProcessStdio>,
}

impl HostStdio {
    pub(super) fn create(spec: StdioSpec) -> io::Result<Self> {
        let (stdin_target, host_stdin) = input_endpoint(spec.stdin())?;
        let (stdout_target, host_stdout) = output_endpoint(spec.stdout())?;
        let (stderr_target, host_stderr) = output_endpoint(spec.stderr())?;
        let stdin = host_stdin.map(nonblocking).transpose()?.map(PosixPipe::new);
        let stdout = host_stdout
            .map(nonblocking)
            .transpose()?
            .map(PosixPipe::new);
        let stderr = host_stderr
            .map(nonblocking)
            .transpose()?
            .map(PosixPipe::new);
        let target = reserve_target_endpoints([stdin_target, stdout_target, stderr_target])?;
        Ok(Self {
            target: Some(target),
            process: Some(ProcessStdio::new(
                stdin.map(ProcessStdin::new),
                stdout.map(ProcessOutput::new),
                stderr.map(ProcessOutput::new),
            )),
        })
    }

    pub(super) fn into_target_ends(mut self) -> ([OwnedFd; TARGET_STDIO_COUNT], Self) {
        let target = self
            .target
            .take()
            .expect("target stdio must remain owned until guardian spawn");
        (target, self)
    }

    pub(super) fn into_process_stdio(mut self) -> ProcessStdio {
        self.process
            .take()
            .expect("process stdio must remain owned until launch completes")
    }
}

fn input_endpoint(mode: StdioMode) -> io::Result<(OwnedFd, Option<OwnedFd>)> {
    match mode {
        StdioMode::Null => open_null(libc::O_RDONLY).map(|target| (target, None)),
        StdioMode::Piped => {
            let (target, host) = pipe_cloexec()?;
            Ok((target, Some(host)))
        }
    }
}

fn output_endpoint(mode: StdioMode) -> io::Result<(OwnedFd, Option<OwnedFd>)> {
    match mode {
        StdioMode::Null => open_null(libc::O_WRONLY).map(|target| (target, None)),
        StdioMode::Piped => {
            let (host, target) = pipe_cloexec()?;
            Ok((target, Some(host)))
        }
    }
}

fn reserve_target_endpoints(
    descriptors: [OwnedFd; TARGET_STDIO_COUNT],
) -> io::Result<[OwnedFd; TARGET_STDIO_COUNT]> {
    Ok(descriptors)
}

fn open_null(access: libc::c_int) -> io::Result<OwnedFd> {
    let path = CString::new("/dev/null").expect("static path");
    let descriptor = unsafe { libc::open(path.as_ptr(), access | libc::O_CLOEXEC) };
    if descriptor == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(descriptor) })
}

fn nonblocking(descriptor: OwnedFd) -> io::Result<AsyncFd<OwnedFd>> {
    let flags = unsafe { libc::fcntl(descriptor.as_raw_fd(), libc::F_GETFL) };
    if flags == -1
        || unsafe {
            libc::fcntl(
                descriptor.as_raw_fd(),
                libc::F_SETFL,
                flags | libc::O_NONBLOCK,
            )
        } == -1
    {
        return Err(io::Error::last_os_error());
    }
    AsyncFd::new(descriptor)
}

struct PosixPipe(Option<AsyncFd<OwnedFd>>);

impl PosixPipe {
    fn new(descriptor: AsyncFd<OwnedFd>) -> Self {
        Self(Some(descriptor))
    }

    fn descriptor(&self) -> io::Result<&AsyncFd<OwnedFd>> {
        self.0
            .as_ref()
            .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "process pipe is closed"))
    }
}

impl AsyncRead for PosixPipe {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        loop {
            let mut readiness = std::task::ready!(self.descriptor()?.poll_read_ready(context))?;
            let unfilled = buffer.initialize_unfilled();
            match readiness.try_io(|inner| {
                let read = unsafe {
                    libc::read(
                        inner.get_ref().as_raw_fd(),
                        unfilled.as_mut_ptr().cast(),
                        unfilled.len(),
                    )
                };
                if read == -1 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(read as usize)
                }
            }) {
                Ok(Ok(read)) => {
                    buffer.advance(read);
                    return Poll::Ready(Ok(()));
                }
                Ok(Err(error)) => return Poll::Ready(Err(error)),
                Err(_) => continue,
            }
        }
    }
}

impl AsyncWrite for PosixPipe {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        loop {
            let mut readiness = std::task::ready!(self.descriptor()?.poll_write_ready(context))?;
            match readiness.try_io(|inner| {
                let written = unsafe {
                    libc::write(
                        inner.get_ref().as_raw_fd(),
                        buffer.as_ptr().cast(),
                        buffer.len(),
                    )
                };
                if written == -1 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(written as usize)
                }
            }) {
                Ok(result) => return Poll::Ready(result),
                Err(_) => continue,
            }
        }
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        _context: &mut Context<'_>,
    ) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        _context: &mut Context<'_>,
    ) -> Poll<io::Result<()>> {
        self.0 = None;
        Poll::Ready(Ok(()))
    }
}
