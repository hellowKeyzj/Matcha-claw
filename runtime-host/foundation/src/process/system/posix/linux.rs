use std::fs;
use std::io;
use std::time::Duration;

use super::scope::{ScopeIdentity, SessionAnchor, VerifiedTargetGroup};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ProcessProof {
    pid: libc::pid_t,
    start_time_ticks: u64,
}

impl ProcessProof {
    pub(super) const fn pid(self) -> libc::pid_t {
        self.pid
    }

    pub(super) const fn creation_marker(self) -> u128 {
        self.start_time_ticks as u128
    }
}

struct ProcessRecord {
    proof: ProcessProof,
    group_id: libc::pid_t,
    session_id: libc::pid_t,
}

pub(super) fn prove_process(pid: libc::pid_t) -> io::Result<ProcessProof> {
    Ok(read_process_record(pid)?.proof)
}

pub(super) fn verify_anchor(anchor: SessionAnchor) -> io::Result<()> {
    let expected = anchor.sentinel();
    let observed = read_process_record(expected.pid())?;
    require(
        observed.proof == expected
            && observed.group_id == expected.pid()
            && observed.session_id == expected.pid(),
        "custody session anchor identity is no longer valid",
    )
}

pub(super) fn verify_live_scope(scope: ScopeIdentity) -> io::Result<VerifiedTargetGroup> {
    scope.anchor().verify()?;
    require_distinct_group(scope)?;
    let root = read_process_record(scope.root().pid())?;
    require(
        root.proof == scope.root()
            && root.group_id == scope.group_id()
            && root.session_id == scope.session_id(),
        "custody target root identity is no longer valid",
    )?;
    verify_group_members(scope)
}

fn require_distinct_group(scope: ScopeIdentity) -> io::Result<()> {
    require(
        scope.group_id() > 0 && scope.group_id() != scope.session_id(),
        "custody target group is not distinct from its session anchor",
    )
}

fn verify_group_members(scope: ScopeIdentity) -> io::Result<VerifiedTargetGroup> {
    let mut members = Vec::new();
    for record in process_records()? {
        if record.group_id == scope.group_id() {
            require(
                record.session_id == scope.session_id(),
                "custody target group member left its expected session",
            )?;
            if record.proof.pid() == scope.root().pid() {
                require(
                    record.proof == scope.root(),
                    "custody target root identity changed during group enumeration",
                )?;
            }
            members.push(record.proof);
        }
    }
    VerifiedTargetGroup::new(scope, members)
}

fn process_records() -> io::Result<Vec<ProcessRecord>> {
    let mut records = Vec::new();
    for entry in fs::read_dir("/proc")? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            return Err(invalid_process_record());
        };
        let Ok(pid) = name.parse::<libc::pid_t>() else {
            continue;
        };
        match read_process_record(pid) {
            Ok(record) => records.push(record),
            Err(error) if is_process_missing(&error) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(records)
}

fn is_process_missing(error: &io::Error) -> bool {
    error.raw_os_error() == Some(libc::ESRCH) || error.kind() == io::ErrorKind::NotFound
}

fn read_process_record(pid: libc::pid_t) -> io::Result<ProcessRecord> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let closing_parenthesis = stat.rfind(')').ok_or_else(invalid_process_record)?;
    let fields: Vec<&str> = stat[closing_parenthesis + 2..].split_whitespace().collect();
    let group_id = parse_field(&fields, 2)?;
    let session_id = parse_field(&fields, 3)?;
    let start_time_ticks = fields
        .get(19)
        .ok_or_else(invalid_process_record)?
        .parse::<u64>()
        .map_err(|_| invalid_process_record())?;
    Ok(ProcessRecord {
        proof: ProcessProof {
            pid,
            start_time_ticks,
        },
        group_id,
        session_id,
    })
}

fn parse_field(fields: &[&str], index: usize) -> io::Result<libc::pid_t> {
    fields
        .get(index)
        .ok_or_else(invalid_process_record)?
        .parse::<libc::pid_t>()
        .map_err(|_| invalid_process_record())
}

fn invalid_process_record() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "Linux process stat is invalid")
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
        assert!(!is_process_missing(&io::Error::new(
            io::ErrorKind::InvalidData,
            "candidate record is malformed",
        )));
    }
}
