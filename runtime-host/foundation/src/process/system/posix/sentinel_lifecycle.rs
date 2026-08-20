use std::io;
use std::mem::MaybeUninit;
use std::time::Instant;

use super::super::guardian_timeout::cleanup_timeout;
use super::super::platform;
use super::super::scope::{ScopeIdentity, signal_verified_scope, verify_live_scope};

#[derive(Clone, Copy)]
pub(super) enum RootLifecycle {
    Running,
    ExitedUnreaped(i32),
    Reaped(i32),
}

pub(super) fn drain(scope: ScopeIdentity, root: &mut RootLifecycle) -> io::Result<Option<i32>> {
    observe_root_lifecycle(scope, root)?;
    if matches!(root, RootLifecycle::ExitedUnreaped(_)) && verify_live_scope(scope)?.has_only_root()
    {
        reap_observed_root(scope, root)?;
    }
    match *root {
        RootLifecycle::Reaped(status) => Ok(Some(status)),
        _ => Ok(None),
    }
}

pub(super) fn terminate(scope: ScopeIdentity, root: &mut RootLifecycle) -> io::Result<()> {
    if matches!(root, RootLifecycle::Reaped(_)) {
        return Ok(());
    }
    observe_root_lifecycle(scope, root)?;
    let group = verify_live_scope(scope)?;
    if matches!(root, RootLifecycle::ExitedUnreaped(_)) && group.has_only_root() {
        reap_observed_root(scope, root)?;
        return Ok(());
    }
    if let Err(error) = signal_verified_scope(group) {
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(error);
        }
        confirm_root_terminal(scope, root)?;
        if !verify_live_scope(scope)?.has_only_root() {
            return Err(authority_lost(
                "target group signal disappeared before verified scope drain",
            ));
        }
        reap_observed_root(scope, root)?;
        return Ok(());
    }
    wait_until_only_root(scope, root, Instant::now() + cleanup_timeout())?;
    reap_observed_root(scope, root)
}

pub(super) fn terminate_after_guardian_loss(scope: ScopeIdentity, root: &mut RootLifecycle) -> ! {
    let status = if terminate(scope, root).is_ok() {
        0
    } else {
        127
    };
    unsafe { libc::_exit(status) }
}

fn observe_root_lifecycle(scope: ScopeIdentity, root: &mut RootLifecycle) -> io::Result<()> {
    if matches!(root, RootLifecycle::Running) {
        if let Some(status) = observe_root_exit(scope.root().pid())? {
            *root = RootLifecycle::ExitedUnreaped(status);
        } else {
            verify_live_scope(scope)?;
        }
    }
    Ok(())
}

fn confirm_root_terminal(scope: ScopeIdentity, root: &mut RootLifecycle) -> io::Result<()> {
    let status = observe_root_exit(scope.root().pid())?.ok_or_else(|| {
        authority_lost("target root remained live after group signal disappeared")
    })?;
    match *root {
        RootLifecycle::Running => *root = RootLifecycle::ExitedUnreaped(status),
        RootLifecycle::ExitedUnreaped(expected) if expected == status => {}
        _ => {
            return Err(authority_lost(
                "target root terminal status changed before verified scope drain",
            ));
        }
    }
    Ok(())
}

fn wait_until_only_root(
    scope: ScopeIdentity,
    root: &mut RootLifecycle,
    deadline: Instant,
) -> io::Result<()> {
    loop {
        observe_root_lifecycle(scope, root)?;
        if matches!(root, RootLifecycle::ExitedUnreaped(_))
            && verify_live_scope(scope)?.has_only_root()
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "target scope did not retain only its root before custody deadline",
            ));
        }
        platform::wait_a_moment()?;
    }
}

fn reap_observed_root(scope: ScopeIdentity, root: &mut RootLifecycle) -> io::Result<()> {
    let RootLifecycle::ExitedUnreaped(status) = *root else {
        return Err(authority_lost("target root was not observed before reap"));
    };
    reap_root(scope.root().pid(), status)?;
    *root = RootLifecycle::Reaped(status);
    Ok(())
}

fn observe_root_exit(root_pid: libc::pid_t) -> io::Result<Option<i32>> {
    let mut info = MaybeUninit::<libc::siginfo_t>::zeroed();
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            root_pid as libc::id_t,
            info.as_mut_ptr(),
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if result == -1 {
        return Err(io::Error::last_os_error());
    }
    let info = unsafe { info.assume_init() };
    let observed_pid = unsafe { info.si_pid() };
    if observed_pid == 0 {
        return Ok(None);
    }
    if observed_pid != root_pid {
        return Err(authority_lost("waitid returned a different child identity"));
    }
    terminal_wait_status(info).map(Some)
}

fn terminal_wait_status(info: libc::siginfo_t) -> io::Result<i32> {
    let status = unsafe { info.si_status() };
    match info.si_code {
        libc::CLD_EXITED => Ok(status << 8),
        libc::CLD_KILLED => Ok(status),
        libc::CLD_DUMPED => Ok(status | 0x80),
        _ => Err(authority_lost("waitid returned a non-terminal child state")),
    }
}

fn reap_root(root_pid: libc::pid_t, expected_status: i32) -> io::Result<()> {
    let mut status = 0;
    if unsafe { libc::waitpid(root_pid, &mut status, 0) } != root_pid {
        return Err(io::Error::last_os_error());
    }
    if status != expected_status {
        return Err(authority_lost(
            "reaped root status changed after observation",
        ));
    }
    Ok(())
}

fn authority_lost(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message)
}
