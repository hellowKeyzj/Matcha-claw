use std::{
    ffi::OsStr,
    mem::size_of,
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, IntoRawHandle, OwnedHandle},
    },
    ptr::{null, null_mut},
};

use tokio::net::windows::named_pipe::NamedPipeClient;
use windows_sys::Win32::{
    Foundation as F, Security::SECURITY_ATTRIBUTES, Storage::FileSystem as FS, System::Pipes as P,
};

use super::{io_failure, owned};
use crate::rpc;

const PIPE_BYTES: u32 = 64 * 1024;

pub(super) struct Pipes {
    pub(super) stdin: NamedPipeClient,
    pub(super) stdout: NamedPipeClient,
    pub(super) stderr: NamedPipeClient,
    pub(super) child: [OwnedHandle; 3],
}

impl Pipes {
    pub(super) fn create() -> rpc::Result<Self> {
        let (stdin_child, stdin) = pipe(true)?;
        let (stdout_child, stdout) = pipe(false)?;
        let (stderr_child, stderr) = pipe(false)?;
        Ok(Self {
            stdin,
            stdout,
            stderr,
            child: [stdin_child, stdout_child, stderr_child],
        })
    }

    pub(super) fn handles(&self) -> [F::HANDLE; 3] {
        self.child
            .each_ref()
            .map(|handle| handle.as_raw_handle().cast())
    }
}

fn pipe(input: bool) -> rpc::Result<(OwnedHandle, NamedPipeClient)> {
    // Random, first-instance-only and local-only: no public pipe endpoint is
    // exposed before its non-inheritable parent handle is opened.
    let name: Vec<u16> = OsStr::new(&format!(
        r"\\.\pipe\matcha-app-server-{}",
        uuid::Uuid::new_v4()
    ))
    .encode_wide()
    .chain([0])
    .collect();
    let security = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    let child = owned(
        unsafe {
            P::CreateNamedPipeW(
                name.as_ptr(),
                (if input {
                    FS::PIPE_ACCESS_INBOUND
                } else {
                    FS::PIPE_ACCESS_OUTBOUND
                }) | FS::FILE_FLAG_FIRST_PIPE_INSTANCE,
                P::PIPE_TYPE_BYTE
                    | P::PIPE_READMODE_BYTE
                    | P::PIPE_WAIT
                    | P::PIPE_REJECT_REMOTE_CLIENTS,
                1,
                PIPE_BYTES,
                PIPE_BYTES,
                0,
                &security,
            )
        },
        "stdio_pipe_create",
    )?;
    let parent = owned(
        unsafe {
            FS::CreateFileW(
                name.as_ptr(),
                if input {
                    F::GENERIC_WRITE
                } else {
                    F::GENERIC_READ
                },
                0,
                null(),
                FS::OPEN_EXISTING,
                FS::FILE_ATTRIBUTE_NORMAL | FS::FILE_FLAG_OVERLAPPED,
                null_mut(),
            )
        },
        "stdio_pipe_open",
    )?;
    // Child's synchronous end is explicitly allowlisted by CreateProcessW;
    // parent uses IOCP, never Tokio ChildStdio's blocking-reader implementation.
    let parent =
        unsafe { NamedPipeClient::from_raw_handle(parent.into_raw_handle()) }.map_err(|error| {
            io_failure(
                "stdio_async_registration",
                "CLI stdio could not be registered for asynchronous I/O",
                error,
            )
        })?;
    Ok((child, parent))
}
