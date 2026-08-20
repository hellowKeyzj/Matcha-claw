use std::{
    ffi::c_void,
    mem::{MaybeUninit, size_of, size_of_val},
    ptr::{null, null_mut},
};

use windows_sys::Win32::{Foundation as F, System::Threading as T};

use super::{
    super::super::{ChildDescriptor, ProcessIdentity},
    command::{CreateProcessInput, environment_ptr},
    error::WindowsCustodyError,
    handle::{Handle, close_if_valid, native},
    job::Job,
    stdio::ChildStdio,
};

type Result<T> = std::result::Result<T, WindowsCustodyError>;

pub(super) struct SuspendedChild {
    process: Handle,
    primary_thread: Handle,
    // Parent-only pin: intentionally excluded from ProcessAttributes' child allowlist.
    _execution_source: Option<super::super::super::ExecutionSource>,
}

impl SuspendedChild {
    pub(super) fn spawn(
        input: &mut CreateProcessInput,
        job: &Job,
        stdio: &ChildStdio,
        child_descriptor: Option<&ChildDescriptor>,
        execution_source: Option<super::super::super::ExecutionSource>,
    ) -> Result<Self> {
        let child_handles = stdio.child_handles();
        let attributes = ProcessAttributes::new(job, child_handles, child_descriptor)?;
        let startup = T::STARTUPINFOEXW {
            StartupInfo: T::STARTUPINFOW {
                cb: size_of::<T::STARTUPINFOEXW>() as u32,
                dwFlags: T::STARTF_USESTDHANDLES,
                hStdInput: child_handles[0],
                hStdOutput: child_handles[1],
                hStdError: child_handles[2],
                ..Default::default()
            },
            lpAttributeList: attributes.raw(),
        };
        let mut info = T::PROCESS_INFORMATION::default();
        bool_ok(
            // SAFETY: input owns all NUL-terminated buffers; attributes atomically owns the Job
            // and exact child-handle allowlist; only listed handles are inheritable.
            unsafe {
                T::CreateProcessW(
                    input.application.as_ptr(),
                    input.command_line.as_mut_ptr(),
                    null(),
                    null(),
                    1,
                    T::CREATE_SUSPENDED
                        | T::CREATE_UNICODE_ENVIRONMENT
                        | T::EXTENDED_STARTUPINFO_PRESENT,
                    environment_ptr(&input.environment),
                    input.working_directory.as_ptr(),
                    &startup.StartupInfo,
                    &mut info,
                )
            },
            "CreateProcessW",
        )?;

        let process = match Handle::new(info.hProcess, "CreateProcessW(process)") {
            Ok(process) => process,
            Err(error) => {
                close_if_valid(info.hThread);
                return Err(error);
            }
        };
        let primary_thread = Handle::new(info.hThread, "CreateProcessW(thread)")?;
        // `ExecutionSource` remains parent-owned and is intentionally absent from the
        // child handle allowlist. Storing it on the suspended child pins this image path
        // until ResumeThread succeeds and into_process consumes the suspended state.
        if let Some(source) = execution_source.as_ref() {
            let _ = source.pin();
        }

        Ok(Self {
            process,
            primary_thread,
            _execution_source: execution_source,
        })
    }

    pub(super) fn process(&self) -> &Handle {
        &self.process
    }

    pub(super) fn identity(&self) -> Result<ProcessIdentity> {
        self.process.identity()
    }

    pub(super) fn resume(&self) -> Result<()> {
        // SAFETY: primary_thread is the valid primary thread returned by CreateProcessW.
        if unsafe { T::ResumeThread(self.primary_thread.raw()) } == u32::MAX {
            return Err(native("ResumeThread"));
        }
        Ok(())
    }

    pub(super) fn into_process(self) -> Handle {
        let Self {
            process,
            primary_thread,
            _execution_source,
        } = self;
        drop(primary_thread);
        drop(_execution_source);
        process
    }
}

struct ProcessAttributes {
    _storage: Vec<MaybeUninit<usize>>,
    list: T::LPPROC_THREAD_ATTRIBUTE_LIST,
    _jobs: Box<[F::HANDLE; 1]>,
    _handles: Box<[F::HANDLE]>,
}

impl ProcessAttributes {
    fn new(
        job: &Job,
        child_handles: [F::HANDLE; 3],
        child_descriptor: Option<&ChildDescriptor>,
    ) -> Result<Self> {
        let handles = exact_child_handles(child_handles, child_descriptor)?;
        let mut bytes = 0;
        // SAFETY: the first call queries the required allocation size.
        unsafe { T::InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut bytes) };
        if bytes == 0 {
            return Err(native("InitializeProcThreadAttributeList"));
        }

        let mut storage = Vec::with_capacity(bytes.div_ceil(size_of::<usize>()));
        storage.resize_with(bytes.div_ceil(size_of::<usize>()), MaybeUninit::uninit);
        let list = storage.as_mut_ptr().cast();
        bool_ok(
            // SAFETY: storage is aligned and has the size required by the query above.
            unsafe { T::InitializeProcThreadAttributeList(list, 2, 0, &mut bytes) },
            "InitializeProcThreadAttributeList",
        )?;

        let jobs = Box::new([job.raw()]);
        let handles = handles.into_boxed_slice();
        let result = update_attribute(
            list,
            T::PROC_THREAD_ATTRIBUTE_JOB_LIST,
            jobs.as_ptr().cast(),
            size_of::<F::HANDLE>(),
            "UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_JOB_LIST)",
        )
        .and_then(|()| {
            update_attribute(
                list,
                T::PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                handles.as_ptr().cast(),
                size_of_val(handles.as_ref()),
                "UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_HANDLE_LIST)",
            )
        });
        if let Err(error) = result {
            // SAFETY: list was initialized successfully above and is not used after deletion.
            unsafe { T::DeleteProcThreadAttributeList(list) };
            return Err(error);
        }

        Ok(Self {
            _storage: storage,
            list,
            _jobs: jobs,
            _handles: handles,
        })
    }

    fn raw(&self) -> T::LPPROC_THREAD_ATTRIBUTE_LIST {
        self.list
    }
}

fn exact_child_handles(
    stdio: [F::HANDLE; 3],
    child_descriptor: Option<&ChildDescriptor>,
) -> Result<Vec<F::HANDLE>> {
    let mut handles = Vec::with_capacity(usize::from(child_descriptor.is_some()) + stdio.len());
    for handle in stdio
        .into_iter()
        .chain(child_descriptor.into_iter().map(ChildDescriptor::raw))
    {
        if handle.is_null() || handle == F::INVALID_HANDLE_VALUE || handles.contains(&handle) {
            return Err(WindowsCustodyError::invalid(
                "child handle allowlist is invalid",
            ));
        }
        handles.push(handle);
    }
    Ok(handles)
}

impl Drop for ProcessAttributes {
    fn drop(&mut self) {
        // SAFETY: list was initialized once and remains valid while storage is owned.
        unsafe { T::DeleteProcThreadAttributeList(self.list) };
    }
}

fn update_attribute(
    list: T::LPPROC_THREAD_ATTRIBUTE_LIST,
    attribute: u32,
    value: *const c_void,
    bytes: usize,
    operation: &'static str,
) -> Result<()> {
    bool_ok(
        // SAFETY: list is initialized and value remains allocated through CreateProcessW.
        unsafe {
            T::UpdateProcThreadAttribute(
                list,
                0,
                attribute as usize,
                value,
                bytes,
                null_mut(),
                null(),
            )
        },
        operation,
    )
}

fn bool_ok(value: i32, operation: &'static str) -> Result<()> {
    if value == 0 {
        Err(native(operation))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use windows_sys::Win32::Foundation as F;

    use super::exact_child_handles;

    #[test]
    fn child_handle_allowlist_contains_only_stdio_and_descriptor() {
        let handles =
            exact_child_handles([1 as F::HANDLE, 2 as F::HANDLE, 3 as F::HANDLE], None).unwrap();
        assert_eq!(
            handles,
            vec![1 as F::HANDLE, 2 as F::HANDLE, 3 as F::HANDLE]
        );
    }
}
