use std::{
    ffi::c_void,
    io,
    mem::{MaybeUninit, size_of, size_of_val},
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    ptr::{null, null_mut},
    sync::Arc,
    time::Duration,
};

use tokio::{
    net::windows::named_pipe::NamedPipeClient,
    sync::Notify,
    time::{sleep, timeout},
};
use windows_sys::Win32::{
    Foundation as F,
    System::{JobObjects as J, Threading as T},
};

use super::{Launch, RESOURCE_WINDOW, io_failure};
use crate::rpc;

#[path = "windows_command.rs"]
mod command;
#[path = "windows_stdio.rs"]
mod stdio;

pub(super) type Input = NamedPipeClient;

pub(super) struct Spawned {
    pub(super) child: Child,
    pub(super) stdin: Input,
    pub(super) stdout: NamedPipeClient,
    pub(super) stderr: NamedPipeClient,
}

pub(super) struct Child {
    process: OwnedHandle,
    job: OwnedHandle,
    registered: Option<RegisteredWait>,
    pid: u32,
}

pub(super) async fn spawn(launch: Launch) -> rpc::Result<Spawned> {
    // Executable lookup is filesystem work; never pin an async I/O worker on it.
    let mut command = tokio::task::spawn_blocking(move || command::CommandLine::prepare(launch))
        .await
        .map_err(|error| {
            rpc::Error::new(
                -32004,
                "process_launch_join",
                "CLI launch preparation did not finish normally",
            )
            .with_source(error)
        })??;
    let (mut child, pipes, setup) = spawn_owned(&mut command)?;
    if let Err(error) = setup {
        let cleanup = child.terminate_tree();
        let waited = timeout(RESOURCE_WINDOW, child.wait()).await;
        let confirmed = child.confirm_cleanup().await;
        let mut failures = Vec::new();
        if let Err(failure) = cleanup {
            failures.push(failure);
        }
        match waited {
            Ok(Ok(_)) => {}
            Ok(Err(failure)) => failures.push(failure),
            Err(_) => failures.push(rpc::Error::new(
                -32004,
                "process_wait_timeout",
                "Failed CLI launch exit was not confirmed",
            )),
        }
        if let Err(failure) = confirmed {
            failures.push(failure);
        }
        if failures.is_empty() {
            return Err(error);
        }
        let mut causes = vec![error.clone()];
        causes.extend(failures.iter().cloned());
        return Err(error
            .with_data(serde_json::json!({ "cleanupFailures": failures }))
            .with_source(super::ProcessFailures(causes)));
    }
    drop(pipes.child);
    Ok(Spawned {
        child,
        stdin: pipes.stdin,
        stdout: pipes.stdout,
        stderr: pipes.stderr,
    })
}

// Attribute buffers and raw allowlists never enter an async future's state.
fn spawn_owned(
    command: &mut command::CommandLine,
) -> rpc::Result<(Child, stdio::Pipes, rpc::Result<()>)> {
    let job = create_job()?;
    let pipes = stdio::Pipes::create()?;
    let handles = pipes.handles();
    let jobs = [job.as_raw_handle() as F::HANDLE];
    let attributes = Attributes::create(&jobs, &handles)?;
    let startup = T::STARTUPINFOEXW {
        StartupInfo: T::STARTUPINFOW {
            cb: size_of::<T::STARTUPINFOEXW>() as u32,
            dwFlags: T::STARTF_USESTDHANDLES,
            hStdInput: handles[0],
            hStdOutput: handles[1],
            hStdError: handles[2],
            ..Default::default()
        },
        lpAttributeList: attributes.list,
    };
    let mut info = T::PROCESS_INFORMATION::default();
    // JOB_LIST joins the Job atomically during CreateProcess, unlike a post-spawn
    // AssignProcessToJobObject race. HANDLE_LIST excludes every unrelated handle.
    bool_ok(
        unsafe {
            T::CreateProcessW(
                command.application.as_ptr(),
                command.arguments.as_mut_ptr(),
                null(),
                null(),
                1,
                T::CREATE_SUSPENDED
                    | T::CREATE_UNICODE_ENVIRONMENT
                    | T::EXTENDED_STARTUPINFO_PRESENT,
                command.environment.as_ptr().cast(),
                command.directory.as_ptr(),
                &startup.StartupInfo,
                &mut info,
            )
        },
        "process_spawn_failed",
        "CLI process could not be created in its owned Job",
    )?;
    // SAFETY: successful CreateProcessW returns two exclusively owned handles.
    let process = unsafe { OwnedHandle::from_raw_handle(info.hProcess.cast()) };
    let thread = unsafe { OwnedHandle::from_raw_handle(info.hThread.cast()) };
    let mut child = Child {
        process,
        job,
        registered: None,
        pid: info.dwProcessId,
    };
    let setup: rpc::Result<()> = (|| {
        child.registered = Some(RegisteredWait::new(&child.process)?);
        if unsafe { T::ResumeThread(thread.as_raw_handle().cast()) } == u32::MAX {
            return Err(io_failure(
                "process_resume_failed",
                "CLI process could not be resumed",
                io::Error::last_os_error(),
            ));
        }
        Ok(())
    })();
    drop(thread);
    drop(attributes);
    Ok((child, pipes, setup))
}

impl Child {
    pub(super) fn pid(&self) -> u32 {
        self.pid
    }

    pub(super) async fn exited(&mut self) -> rpc::Result<()> {
        loop {
            match unsafe { T::WaitForSingleObject(self.process.as_raw_handle().cast(), 0) } {
                F::WAIT_OBJECT_0 => return Ok(()),
                F::WAIT_TIMEOUT => {}
                _ => {
                    return Err(io_failure(
                        "process_exit_probe_failed",
                        "CLI exit could not be observed",
                        io::Error::last_os_error(),
                    ));
                }
            }
            let notify = self.registered.as_ref().map(|wait| wait.notify.clone());
            match notify {
                Some(notify) => notify.notified().await,
                // Only used while recovering a failed RegisterWait during spawn.
                None => sleep(Duration::from_millis(10)).await,
            }
        }
    }

    pub(super) fn terminate_tree(&mut self) -> rpc::Result<()> {
        if self.active_processes()? == 0 {
            return Ok(());
        }
        bool_ok(
            unsafe { J::TerminateJobObject(self.job.as_raw_handle().cast(), 1) },
            "process_tree_cleanup_failed",
            "CLI owned Job could not be terminated",
        )
    }

    pub(super) async fn wait(&mut self) -> rpc::Result<(Option<i32>, Option<i32>)> {
        self.exited().await?;
        let mut code = 0;
        bool_ok(
            unsafe { T::GetExitCodeProcess(self.process.as_raw_handle().cast(), &mut code) },
            "process_wait_failed",
            "CLI exit code could not be read",
        )?;
        Ok((Some(code as i32), None))
    }

    pub(super) async fn confirm_cleanup(&mut self) -> rpc::Result<()> {
        let job = &self.job;
        let drained = timeout(RESOURCE_WINDOW, async move {
            while active_processes(job)? != 0 {
                sleep(Duration::from_millis(10)).await;
            }
            Ok(())
        })
        .await
        .unwrap_or_else(|_| {
            Err(rpc::Error::new(
                -32004,
                "process_tree_cleanup_timeout",
                "CLI Job still had active members after cleanup",
            ))
        });
        let unregistered = self
            .registered
            .as_mut()
            .map_or(Ok(()), RegisteredWait::close);
        if unregistered.is_ok() {
            self.registered = None;
        }
        match (drained, unregistered) {
            (Ok(()), result) | (result, Ok(())) => result,
            (Err(error), Err(wait_error)) => Err(error
                .clone()
                .with_data(serde_json::json!({ "waitCleanupFailure": wait_error }))
                .with_source(super::ProcessFailures(vec![error, wait_error]))),
        }
    }

    fn active_processes(&self) -> rpc::Result<u32> {
        active_processes(&self.job)
    }
}

impl Drop for Child {
    fn drop(&mut self) {
        // Explicit close reports failures; this private kill-on-close Job remains
        // a best-effort safety net if the resource task/runtime is abandoned.
        self.registered.take();
    }
}

struct RegisteredWait {
    handle: Option<F::HANDLE>,
    notify: Arc<Notify>,
    context: *const Notify,
}

// SAFETY: this exclusively owned registration may move between runtime workers;
// the native callback only sees an immutable, independently Arc-pinned Notify.
unsafe impl Send for RegisteredWait {}

impl RegisteredWait {
    fn new(process: &OwnedHandle) -> rpc::Result<Self> {
        let notify = Arc::new(Notify::new());
        let context = Arc::into_raw(notify.clone());
        let mut handle = null_mut();
        let result = unsafe {
            T::RegisterWaitForSingleObject(
                &mut handle,
                process.as_raw_handle().cast(),
                Some(on_exit),
                context.cast(),
                T::INFINITE,
                T::WT_EXECUTEONLYONCE,
            )
        };
        if result == 0 {
            let error = io::Error::last_os_error();
            unsafe {
                drop(Arc::from_raw(context));
            }
            return Err(io_failure(
                "process_wait_registration",
                "CLI exit observation could not be registered",
                error,
            ));
        }
        Ok(Self {
            handle: Some(handle),
            notify,
            context,
        })
    }

    fn close(&mut self) -> rpc::Result<()> {
        let Some(handle) = self.handle else {
            return Ok(());
        };
        // Join the bounded notify-only callback before freeing its Arc context.
        // Keep the context alive on native failure rather than risk a callback UAF.
        bool_ok(
            unsafe { T::UnregisterWaitEx(handle, F::INVALID_HANDLE_VALUE) },
            "process_wait_cleanup_failed",
            "CLI exit observation could not be released",
        )?;
        self.handle = None;
        unsafe {
            drop(Arc::from_raw(self.context));
        }
        Ok(())
    }
}

unsafe extern "system" fn on_exit(context: *mut c_void, _timed_out: bool) {
    // SAFETY: registration owns an Arc reference until UnregisterWaitEx joins us.
    unsafe { &*context.cast::<Notify>() }.notify_one();
}

impl Drop for RegisteredWait {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

fn active_processes(job: &OwnedHandle) -> rpc::Result<u32> {
    let mut accounting = J::JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
    bool_ok(
        unsafe {
            J::QueryInformationJobObject(
                job.as_raw_handle().cast(),
                J::JobObjectBasicAccountingInformation,
                (&mut accounting as *mut J::JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                size_of::<J::JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                null_mut(),
            )
        },
        "process_job_probe_failed",
        "CLI Job membership could not be observed",
    )?;
    Ok(accounting.ActiveProcesses)
}

fn create_job() -> rpc::Result<OwnedHandle> {
    let job = owned(
        unsafe { J::CreateJobObjectW(null(), null()) },
        "process_job_create",
    )?;
    let mut limits = J::JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = J::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    bool_ok(
        unsafe {
            J::SetInformationJobObject(
                job.as_raw_handle().cast(),
                J::JobObjectExtendedLimitInformation,
                (&limits as *const J::JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<J::JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        },
        "process_job_limits",
        "CLI Job cleanup policy could not be installed",
    )?;
    Ok(job)
}

pub(super) fn owned(handle: F::HANDLE, kind: &'static str) -> rpc::Result<OwnedHandle> {
    if handle.is_null() || handle == F::INVALID_HANDLE_VALUE {
        return Err(io_failure(
            kind,
            "CLI native resource could not be created",
            io::Error::last_os_error(),
        ));
    }
    // SAFETY: callers transfer the only owner of a successful native handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle.cast()) })
}

struct Attributes {
    _storage: Vec<MaybeUninit<usize>>,
    list: T::LPPROC_THREAD_ATTRIBUTE_LIST,
}

impl Attributes {
    fn create(jobs: &[F::HANDLE; 1], handles: &[F::HANDLE; 3]) -> rpc::Result<Self> {
        let mut bytes = 0;
        unsafe {
            T::InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut bytes);
        }
        if bytes == 0 {
            return Err(io_failure(
                "process_attributes_size",
                "CLI process attributes could not be sized",
                io::Error::last_os_error(),
            ));
        }
        let mut storage = Vec::with_capacity(bytes.div_ceil(size_of::<usize>()));
        storage.resize_with(bytes.div_ceil(size_of::<usize>()), MaybeUninit::uninit);
        let list = storage.as_mut_ptr().cast();
        bool_ok(
            unsafe { T::InitializeProcThreadAttributeList(list, 2, 0, &mut bytes) },
            "process_attributes_init",
            "CLI process attributes could not be initialized",
        )?;
        let attributes = Self {
            _storage: storage,
            list,
        };
        for (key, pointer, bytes) in [
            (
                T::PROC_THREAD_ATTRIBUTE_JOB_LIST,
                jobs.as_ptr().cast::<c_void>(),
                size_of_val(jobs),
            ),
            (
                T::PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                handles.as_ptr().cast::<c_void>(),
                size_of_val(handles),
            ),
        ] {
            bool_ok(
                unsafe {
                    T::UpdateProcThreadAttribute(
                        list,
                        0,
                        key as usize,
                        pointer,
                        bytes,
                        null_mut(),
                        null(),
                    )
                },
                "process_attributes_update",
                "CLI process ownership attributes could not be installed",
            )?;
        }
        Ok(attributes)
    }
}

impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe {
            T::DeleteProcThreadAttributeList(self.list);
        }
    }
}

fn bool_ok(result: i32, kind: &'static str, message: &'static str) -> rpc::Result<()> {
    if result == 0 {
        Err(io_failure(kind, message, io::Error::last_os_error()))
    } else {
        Ok(())
    }
}
