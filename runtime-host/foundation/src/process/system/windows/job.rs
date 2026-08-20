use std::{
    ffi::c_void,
    mem::size_of,
    ptr::{null, null_mut},
};

use windows_sys::Win32::{Foundation as F, System::JobObjects as J};

use super::{
    super::super::ProcessIdentity,
    error::WindowsCustodyError,
    handle::{Handle, native},
};

const TERMINATION_EXIT_CODE: u32 = 1;
const TERMINATION_CONFIRMATION_WAIT_MILLIS: u32 = 5_000;

type Result<T> = std::result::Result<T, WindowsCustodyError>;

pub(super) struct Job(Handle);

impl Job {
    pub(super) fn raw(&self) -> F::HANDLE {
        self.0.raw()
    }
}

pub(super) fn create() -> Result<Job> {
    let job = Handle::new(
        // SAFETY: null security attributes make the returned Job handle non-inheritable.
        unsafe { J::CreateJobObjectW(null(), null()) },
        "CreateJobObjectW",
    )?;
    let mut limits = J::JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = J::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    bool_ok(
        // SAFETY: job is valid and limits points to initialized, correctly sized data.
        unsafe {
            J::SetInformationJobObject(
                job.raw(),
                J::JobObjectExtendedLimitInformation,
                (&limits as *const J::JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast::<c_void>(),
                size_of::<J::JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        },
        "SetInformationJobObject",
    )?;
    Ok(Job(job))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ScopeTermination {
    AlreadyDrained,
    Terminated,
}

pub(super) fn terminate(
    job: &Job,
    root: &Handle,
    identity: ProcessIdentity,
) -> Result<ScopeTermination> {
    if verify_scope(job, root, identity)? == ScopeVerification::Drained {
        return Ok(ScopeTermination::AlreadyDrained);
    }
    bool_ok(
        // SAFETY: this Job belongs exclusively to the verified root process instance.
        unsafe { J::TerminateJobObject(job.raw(), TERMINATION_EXIT_CODE) },
        "TerminateJobObject",
    )?;
    wait_for_termination(job, root)?;
    Ok(ScopeTermination::Terminated)
}

pub(super) fn terminate_after_failed_spawn(job: &Job, root: &Handle) -> Result<()> {
    bool_ok(
        // SAFETY: this private Job is the atomic creation scope for this failed spawn.
        unsafe { J::TerminateJobObject(job.raw(), TERMINATION_EXIT_CODE) },
        "TerminateJobObject",
    )?;
    wait_for_termination(job, root)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ScopeVerification {
    Drained,
    Verified,
}

fn verify_scope(
    job: &Job,
    root: &Handle,
    expected_identity: ProcessIdentity,
) -> Result<ScopeVerification> {
    if root.identity()? != expected_identity {
        return Err(WindowsCustodyError::invalid(
            "process identity no longer matches its authority scope",
        ));
    }
    if root.is_signaled()? {
        return if is_drained(active_processes(job)?) {
            Ok(ScopeVerification::Drained)
        } else {
            Ok(ScopeVerification::Verified)
        };
    }

    let mut assigned = 0;
    bool_ok(
        // SAFETY: the handles are owned by this custody and the output is writable.
        unsafe { J::IsProcessInJob(root.raw(), job.raw(), &mut assigned) },
        "IsProcessInJob",
    )?;
    if assigned == 0 {
        return Err(WindowsCustodyError::invalid(
            "process is no longer a member of its authority scope",
        ));
    }
    Ok(ScopeVerification::Verified)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ScopeExitProbe {
    Pending,
    Confirmed,
}

pub(super) fn probe_scope_exit(job: &Job, root: &Handle) -> Result<ScopeExitProbe> {
    if !root.is_signaled()? {
        return Ok(scope_exit_probe(false, 0));
    }
    Ok(scope_exit_probe(true, active_processes(job)?))
}

fn wait_for_termination(job: &Job, root: &Handle) -> Result<()> {
    wait_for_signal(root.raw(), "root process exit")?;
    wait_for_signal(job.raw(), "process scope drain")
}

const fn is_drained(active_processes: u32) -> bool {
    active_processes == 0
}

const fn scope_exit_probe(root_terminal: bool, active_processes: u32) -> ScopeExitProbe {
    if root_terminal && is_drained(active_processes) {
        ScopeExitProbe::Confirmed
    } else {
        ScopeExitProbe::Pending
    }
}

fn active_processes(job: &Job) -> Result<u32> {
    let mut accounting = J::JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
    bool_ok(
        // SAFETY: job is valid and accounting is writable with the specified size.
        unsafe {
            J::QueryInformationJobObject(
                job.raw(),
                J::JobObjectBasicAccountingInformation,
                (&mut accounting as *mut J::JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)
                    .cast::<c_void>(),
                size_of::<J::JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                null_mut(),
            )
        },
        "QueryInformationJobObject",
    )?;
    Ok(accounting.ActiveProcesses)
}

fn wait_for_signal(handle: F::HANDLE, subject: &'static str) -> Result<()> {
    // SAFETY: handle is a valid waitable process or Job Object handle.
    match unsafe {
        windows_sys::Win32::System::Threading::WaitForSingleObject(
            handle,
            TERMINATION_CONFIRMATION_WAIT_MILLIS,
        )
    } {
        F::WAIT_OBJECT_0 => Ok(()),
        F::WAIT_TIMEOUT => Err(WindowsCustodyError::invalid(subject)),
        _ => Err(native("WaitForSingleObject")),
    }
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
    use super::{ScopeExitProbe, is_drained, scope_exit_probe};

    #[test]
    fn scope_is_not_drained_while_any_job_member_remains() {
        assert!(is_drained(0));
        assert!(!is_drained(1));
    }

    #[test]
    fn short_probe_remains_pending_until_root_exits() {
        assert_eq!(scope_exit_probe(false, 0), ScopeExitProbe::Pending);
    }

    #[test]
    fn short_probe_remains_pending_while_job_members_remain() {
        assert_eq!(scope_exit_probe(true, 1), ScopeExitProbe::Pending);
    }

    #[test]
    fn short_probe_confirms_after_root_exit_and_job_drain() {
        assert_eq!(scope_exit_probe(true, 0), ScopeExitProbe::Confirmed);
    }
}
