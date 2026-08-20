use std::{
    ffi::{OsStr, c_void},
    fmt::Write as _,
    mem::size_of,
    os::windows::{ffi::OsStrExt, io::RawHandle},
    pin::Pin,
    ptr::{null, null_mut},
    sync::atomic::{AtomicU64, Ordering},
    task::{Context, Poll},
};

use tokio::{io::AsyncWrite, net::windows::named_pipe::NamedPipeClient};
use windows_sys::Win32::{
    Foundation as F, Security as S, Storage::FileSystem as FS, System::Pipes as P,
};

use super::{
    super::super::{ProcessOutput, ProcessStdin, ProcessStdio, StdioMode, StdioSpec},
    error::WindowsCustodyError,
    handle::{Handle, native},
};

const PIPE_BUFFER_BYTES: u32 = 64 * 1024;
const PIPE_RANDOM_BYTES: usize = 16;
const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 2;

static NEXT_PIPE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

type Result<T> = std::result::Result<T, WindowsCustodyError>;

#[link(name = "bcrypt")]
unsafe extern "system" {
    fn BCryptGenRandom(
        algorithm: *mut c_void,
        buffer: *mut u8,
        buffer_bytes: u32,
        flags: u32,
    ) -> i32;
}

pub(super) struct ChildStdio {
    stdin: DirectedHandle,
    stdout: DirectedHandle,
    stderr: DirectedHandle,
}

struct DirectedHandle {
    child: Handle,
    parent: Option<Handle>,
}

pub(super) struct ParentStdio {
    stdin: Option<Handle>,
    stdout: Option<Handle>,
    stderr: Option<Handle>,
}

impl ChildStdio {
    pub(super) fn create(spec: StdioSpec) -> Result<Self> {
        Ok(Self {
            stdin: directed_handle(spec.stdin(), Direction::Input)?,
            stdout: directed_handle(spec.stdout(), Direction::Output)?,
            stderr: directed_handle(spec.stderr(), Direction::Output)?,
        })
    }

    pub(super) fn child_handles(&self) -> [F::HANDLE; 3] {
        [
            self.stdin.child.raw(),
            self.stdout.child.raw(),
            self.stderr.child.raw(),
        ]
    }

    pub(super) fn into_parent(self) -> ParentStdio {
        ParentStdio {
            stdin: self.stdin.parent,
            stdout: self.stdout.parent,
            stderr: self.stderr.parent,
        }
    }
}

impl ParentStdio {
    pub(super) fn into_stdio(self) -> Result<ProcessStdio> {
        let stdin = self
            .stdin
            .map(named_pipe_client)
            .transpose()?
            .map(|pipe| ProcessStdin::new(StdinPipe(Some(pipe))));
        let stdout = self
            .stdout
            .map(named_pipe_client)
            .transpose()?
            .map(ProcessOutput::new);
        let stderr = self
            .stderr
            .map(named_pipe_client)
            .transpose()?
            .map(ProcessOutput::new);
        Ok(ProcessStdio::new(stdin, stdout, stderr))
    }
}

#[derive(Clone, Copy)]
enum Direction {
    Input,
    Output,
}

fn directed_handle(mode: StdioMode, direction: Direction) -> Result<DirectedHandle> {
    match mode {
        StdioMode::Null => Ok(DirectedHandle {
            child: open_null(direction)?,
            parent: None,
        }),
        StdioMode::Piped => open_pipe(direction),
    }
}

fn open_null(direction: Direction) -> Result<Handle> {
    let name = wide("NUL");
    let security = inheritable_security();
    let access = match direction {
        Direction::Input => F::GENERIC_READ,
        Direction::Output => F::GENERIC_WRITE,
    };
    Handle::new(
        // SAFETY: name and security live through the call; no template handle is supplied.
        unsafe {
            FS::CreateFileW(
                name.as_ptr(),
                access,
                FS::FILE_SHARE_READ | FS::FILE_SHARE_WRITE,
                &security,
                FS::OPEN_EXISTING,
                FS::FILE_ATTRIBUTE_NORMAL,
                null_mut(),
            )
        },
        "CreateFileW(NUL)",
    )
}

fn open_pipe(direction: Direction) -> Result<DirectedHandle> {
    let name = pipe_name()?;
    let security = inheritable_security();
    let server_access = match direction {
        Direction::Input => FS::PIPE_ACCESS_INBOUND,
        Direction::Output => FS::PIPE_ACCESS_OUTBOUND,
    } | FS::FILE_FLAG_FIRST_PIPE_INSTANCE;
    let child = Handle::new(
        // SAFETY: name and security live through the call and describe one local byte-mode instance.
        unsafe {
            P::CreateNamedPipeW(
                name.as_ptr(),
                server_access,
                P::PIPE_TYPE_BYTE
                    | P::PIPE_READMODE_BYTE
                    | P::PIPE_WAIT
                    | P::PIPE_REJECT_REMOTE_CLIENTS,
                1,
                PIPE_BUFFER_BYTES,
                PIPE_BUFFER_BYTES,
                0,
                &security,
            )
        },
        "CreateNamedPipeW",
    )?;
    let client_access = match direction {
        Direction::Input => F::GENERIC_WRITE,
        Direction::Output => F::GENERIC_READ,
    };
    let parent = Handle::new(
        // SAFETY: name remains valid and the server instance above is waiting for this local client.
        unsafe {
            FS::CreateFileW(
                name.as_ptr(),
                client_access,
                0,
                null(),
                FS::OPEN_EXISTING,
                FS::FILE_ATTRIBUTE_NORMAL | FS::FILE_FLAG_OVERLAPPED,
                null_mut(),
            )
        },
        "CreateFileW(named pipe client)",
    )?;
    if unsafe { F::SetHandleInformation(parent.raw(), F::HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err(native("SetHandleInformation(named pipe client)"));
    }
    Ok(DirectedHandle {
        child,
        parent: Some(parent),
    })
}

fn pipe_name() -> Result<Vec<u16>> {
    let mut random = [0_u8; PIPE_RANDOM_BYTES];
    // SAFETY: the system-preferred provider accepts a null algorithm and random is writable.
    let status = unsafe {
        BCryptGenRandom(
            null_mut(),
            random.as_mut_ptr(),
            random.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status < 0 {
        return Err(WindowsCustodyError::invalid(
            "named pipe identifier generation failed",
        ));
    }
    let sequence = NEXT_PIPE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let mut name = format!(
        r"\\.\pipe\matcha-runtime-host-stdio-{}-{sequence}-",
        std::process::id()
    );
    for byte in random {
        write!(&mut name, "{byte:02x}")
            .map_err(|_| WindowsCustodyError::invalid("named pipe identifier formatting failed"))?;
    }
    Ok(wide(&name))
}

fn inheritable_security() -> S::SECURITY_ATTRIBUTES {
    S::SECURITY_ATTRIBUTES {
        nLength: size_of::<S::SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    }
}

fn wide(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain([0]).collect()
}

fn named_pipe_client(handle: Handle) -> Result<NamedPipeClient> {
    let raw = handle.into_raw();
    // SAFETY: raw is the sole owner of an overlapped named-pipe client. Tokio takes ownership on
    // success; on registration failure the temporary Tokio object closes it before returning.
    unsafe { NamedPipeClient::from_raw_handle(raw as RawHandle) }
        .map_err(|_| WindowsCustodyError::invalid("named pipe async registration failed"))
}

struct StdinPipe(Option<NamedPipeClient>);

impl AsyncWrite for StdinPipe {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        match self.0.as_mut() {
            Some(pipe) => Pin::new(pipe).poll_write(context, buffer),
            None => Poll::Ready(Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "process stdin is shut down",
            ))),
        }
    }

    fn poll_flush(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        match self.0.as_mut() {
            Some(pipe) => Pin::new(pipe).poll_flush(context),
            None => Poll::Ready(Ok(())),
        }
    }

    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        _context: &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        self.0.take();
        Poll::Ready(Ok(()))
    }

    fn is_write_vectored(&self) -> bool {
        self.0
            .as_ref()
            .is_some_and(NamedPipeClient::is_write_vectored)
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffers: &[std::io::IoSlice<'_>],
    ) -> Poll<std::io::Result<usize>> {
        match self.0.as_mut() {
            Some(pipe) => Pin::new(pipe).poll_write_vectored(context, buffers),
            None => Poll::Ready(Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "process stdin is shut down",
            ))),
        }
    }
}
