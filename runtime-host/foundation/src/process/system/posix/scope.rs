use std::io;
use std::time::Instant;

use super::platform;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct SessionAnchor {
    sentinel: platform::ProcessProof,
}

impl SessionAnchor {
    pub(super) const fn new(sentinel: platform::ProcessProof) -> Self {
        Self { sentinel }
    }

    pub(crate) const fn session_id(self) -> libc::pid_t {
        self.sentinel.pid()
    }

    pub(crate) const fn sentinel(self) -> platform::ProcessProof {
        self.sentinel
    }

    pub(super) fn verify(self) -> io::Result<()> {
        platform::verify_anchor(self)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ScopeIdentity {
    anchor: SessionAnchor,
    root: platform::ProcessProof,
}

impl ScopeIdentity {
    pub(super) const fn new(anchor: SessionAnchor, root: platform::ProcessProof) -> Self {
        Self { anchor, root }
    }

    pub(crate) const fn anchor(self) -> SessionAnchor {
        self.anchor
    }

    pub(crate) const fn session_id(self) -> libc::pid_t {
        self.anchor.session_id()
    }

    pub(crate) const fn group_id(self) -> libc::pid_t {
        self.root.pid()
    }

    pub(crate) const fn root(self) -> platform::ProcessProof {
        self.root
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct VerifiedTargetGroup {
    scope: ScopeIdentity,
    members: Vec<platform::ProcessProof>,
}

impl VerifiedTargetGroup {
    pub(super) fn new(
        scope: ScopeIdentity,
        mut members: Vec<platform::ProcessProof>,
    ) -> io::Result<Self> {
        members.sort_by_key(|member| member.pid());
        if members
            .windows(2)
            .any(|pair| pair[0].pid() == pair[1].pid())
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "custody target group included a duplicate process identity",
            ));
        }
        if !members.iter().any(|member| *member == scope.root()) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "custody target root was absent from its verified group",
            ));
        }
        Ok(Self { scope, members })
    }

    pub(super) const fn scope(&self) -> ScopeIdentity {
        self.scope
    }

    pub(super) const fn group_id(&self) -> libc::pid_t {
        self.scope.group_id()
    }

    pub(super) fn matches_current(&self, current: &Self) -> bool {
        self == current
    }

    pub(super) fn has_only_root(&self) -> bool {
        self.members.len() == 1
    }
}

pub(super) fn verify_live_scope(scope: ScopeIdentity) -> io::Result<VerifiedTargetGroup> {
    platform::verify_live_scope(scope)
}

pub(super) fn signal_verified_scope(group: VerifiedTargetGroup) -> io::Result<()> {
    platform::signal_scope(group)
}

pub(super) fn reap_sentinel_until(sentinel_pid: libc::pid_t, deadline: Instant) -> io::Result<i32> {
    loop {
        let mut status = 0;
        let waited = unsafe { libc::waitpid(sentinel_pid, &mut status, libc::WNOHANG) };
        if waited == sentinel_pid {
            return Ok(status);
        }
        if waited == -1 {
            return Err(io::Error::last_os_error());
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "sentinel did not exit before custody deadline",
            ));
        }
        platform::wait_a_moment()?;
    }
}

#[cfg(test)]
mod tests {
    use std::io;

    use super::{ScopeIdentity, SessionAnchor, VerifiedTargetGroup, platform};

    #[test]
    fn target_group_requires_the_proven_root_member() {
        let proof = platform::prove_process(unsafe { libc::getpid() }).unwrap();
        let scope = ScopeIdentity::new(SessionAnchor::new(proof), proof);

        let error = match VerifiedTargetGroup::new(scope, Vec::new()) {
            Ok(_) => panic!("target group without its proven root must be rejected"),
            Err(error) => error,
        };

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn target_group_rejects_duplicate_process_identity() {
        let root = platform::prove_process(unsafe { libc::getpid() }).unwrap();
        let scope = ScopeIdentity::new(SessionAnchor::new(root), root);

        let error = VerifiedTargetGroup::new(scope, vec![root, root]).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    }
}
