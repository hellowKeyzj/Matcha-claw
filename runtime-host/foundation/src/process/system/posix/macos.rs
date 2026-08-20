use std::io;
use std::mem::MaybeUninit;
use std::time::Duration;

use super::scope::{ScopeIdentity, SessionAnchor, VerifiedTargetGroup};

const PROC_ALL_PIDS: u32 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ProcessProof {
    pid: libc::pid_t,
    start_time_seconds: u64,
    start_time_microseconds: u64,
}

impl ProcessProof {
    pub(super) const fn pid(self) -> libc::pid_t {
        self.pid
    }

    pub(super) const fn creation_marker(self) -> u128 {
        ((self.start_time_seconds as u128) << 64) | self.start_time_microseconds as u128
    }
}

pub(super) fn prove_process(pid: libc::pid_t) -> io::Result<ProcessProof> {
    let mut info = MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            std::mem::size_of::<libc::proc_bsdinfo>() as _,
        )
    };
    if written != std::mem::size_of::<libc::proc_bsdinfo>() as i32 {
        let error = io::Error::last_os_error();
        return Err(if error.raw_os_error() == Some(0) {
            io::Error::new(
                io::ErrorKind::NotFound,
                "macOS process identity is unavailable",
            )
        } else {
            error
        });
    }
    let info = unsafe { info.assume_init() };
    Ok(ProcessProof {
        pid,
        start_time_seconds: info.pbi_start_tvsec,
        start_time_microseconds: info.pbi_start_tvusec,
    })
}

pub(super) fn verify_anchor(anchor: SessionAnchor) -> io::Result<()> {
    let expected = anchor.sentinel();
    verify_exact_process(
        expected,
        expected.pid(),
        expected.pid(),
        "custody session anchor identity is no longer valid",
    )
}

pub(super) fn verify_live_scope(scope: ScopeIdentity) -> io::Result<VerifiedTargetGroup> {
    scope.anchor().verify()?;
    require_distinct_group(scope)?;
    verify_exact_process(
        scope.root(),
        scope.group_id(),
        scope.session_id(),
        "custody target root identity is no longer valid",
    )?;
    verify_group_members(scope)
}

fn verify_exact_process(
    expected: ProcessProof,
    expected_group: libc::pid_t,
    expected_session: libc::pid_t,
    message: &'static str,
) -> io::Result<()> {
    let before = prove_process(expected.pid())?;
    let (group, session) = process_group_and_session(expected.pid())?;
    let after = prove_process(expected.pid())?;
    require(
        before == expected
            && after == expected
            && group == expected_group
            && session == expected_session,
        message,
    )
}

fn require_distinct_group(scope: ScopeIdentity) -> io::Result<()> {
    require(
        scope.group_id() > 0 && scope.group_id() != scope.session_id(),
        "custody target group is not distinct from its session anchor",
    )
}

fn verify_group_members(scope: ScopeIdentity) -> io::Result<VerifiedTargetGroup> {
    let mut members = Vec::new();
    for pid in processes_in_group(scope.group_id())? {
        let Some(proof) = prove_group_member(pid, scope.group_id(), scope.session_id())? else {
            continue;
        };
        if pid == scope.root().pid() {
            require(
                proof == scope.root(),
                "custody target root identity changed during group enumeration",
            )?;
        }
        members.push(proof);
    }
    VerifiedTargetGroup::new(scope, members)
}

fn prove_group_member(
    pid: libc::pid_t,
    expected_group: libc::pid_t,
    expected_session: libc::pid_t,
) -> io::Result<Option<ProcessProof>> {
    let before = match prove_process(pid) {
        Ok(proof) => proof,
        Err(error) if is_process_missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let (group, session) = match process_group_and_session(pid) {
        Ok(identity) => identity,
        Err(error) if is_process_missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let after = match prove_process(pid) {
        Ok(proof) => proof,
        Err(error) if is_process_missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    require(
        before == after && group == expected_group && session == expected_session,
        "custody target group member identity is no longer valid",
    )?;
    Ok(Some(after))
}

fn process_group_and_session(pid: libc::pid_t) -> io::Result<(libc::pid_t, libc::pid_t)> {
    let group = unsafe { libc::getpgid(pid) };
    if group == -1 {
        return Err(io::Error::last_os_error());
    }
    let session = unsafe { libc::getsid(pid) };
    if session == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok((group, session))
}

fn processes_in_group(group_id: libc::pid_t) -> io::Result<Vec<libc::pid_t>> {
    let mut capacity = 256_usize;
    loop {
        let mut process_ids = vec![0 as libc::pid_t; capacity];
        let written = unsafe {
            libc::proc_listpids(
                PROC_ALL_PIDS,
                0,
                process_ids.as_mut_ptr().cast(),
                (process_ids.len() * std::mem::size_of::<libc::pid_t>()) as _,
            )
        };
        if written < 0 {
            return Err(io::Error::last_os_error());
        }
        let count = written as usize / std::mem::size_of::<libc::pid_t>();
        if count == capacity {
            capacity = capacity
                .checked_mul(2)
                .ok_or_else(|| io::Error::other("macOS process enumeration overflowed"))?;
            continue;
        }
        let mut members = Vec::new();
        for pid in process_ids.into_iter().take(count).filter(|pid| *pid > 0) {
            let group = unsafe { libc::getpgid(pid) };
            if group == -1 {
                let error = io::Error::last_os_error();
                if is_process_missing(&error) {
                    continue;
                }
                return Err(error);
            }
            if group == group_id {
                members.push(pid);
            }
        }
        return Ok(members);
    }
}

fn is_process_missing(error: &io::Error) -> bool {
    error.raw_os_error() == Some(libc::ESRCH) || error.kind() == io::ErrorKind::NotFound
}

fn require(condition: bool, message: &'static str) -> io::Result<()> {
    if condition {
        Ok(())
    } else {
        Err(io::Error::new(io::ErrorKind::PermissionDenied, message))
    }
}

pub(super) fn signal_scope(group: VerifiedTargetGroup) -> io::Result<()> {
    let current = verify_live_scope(group.scope())?;
    require(
        group.matches_current(&current),
        "custody target group membership changed before cleanup",
    )?;
    if unsafe { libc::kill(-group.group_id(), libc::SIGKILL) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(super) fn wait_a_moment() -> io::Result<()> {
    let pause = libc::timespec {
        tv_sec: 0,
        tv_nsec: Duration::from_millis(10).as_nanos() as _,
    };
    if unsafe { libc::nanosleep(&pause, std::ptr::null_mut()) } == -1 {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io;

    use super::is_process_missing;

    #[test]
    fn only_missing_process_errors_are_skippable_during_enumeration() {
        assert!(is_process_missing(&io::Error::from_raw_os_error(
            libc::ESRCH
        )));
        assert!(is_process_missing(&io::Error::new(
            io::ErrorKind::NotFound,
            "candidate disappeared",
        )));
        assert!(!is_process_missing(&io::Error::from_raw_os_error(
            libc::EPERM
        )));
    }
}
