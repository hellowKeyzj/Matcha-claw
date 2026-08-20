use std::fmt;

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ScopeId([u8; 16]);

impl ScopeId {
    pub(crate) const fn new(bytes: [u8; 16]) -> Self {
        Self(bytes)
    }
}

impl fmt::Display for ScopeId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for byte in self.0 {
            write!(formatter, "{byte:02x}")?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct ProcessIdentity {
    pid: u32,
    creation_marker: u128,
}

impl ProcessIdentity {
    pub(crate) const fn new(pid: u32, creation_marker: u128) -> Self {
        Self {
            pid,
            creation_marker,
        }
    }

    pub const fn pid(self) -> u32 {
        self.pid
    }

    pub(crate) const fn creation_marker(self) -> u128 {
        self.creation_marker
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuthorityClass {
    Observed,
    Owned,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AuthorityScope {
    id: ScopeId,
}

impl AuthorityScope {
    pub(crate) const fn owned(id: ScopeId) -> Self {
        Self { id }
    }

    pub const fn id(self) -> ScopeId {
        self.id
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Provenance {
    Spawned { scope: AuthorityScope },
    Attached { subject: ProcessIdentity },
}

impl Provenance {
    pub const fn class(self) -> AuthorityClass {
        match self {
            Self::Spawned { .. } => AuthorityClass::Owned,
            Self::Attached { .. } => AuthorityClass::Observed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_id_display_is_stable_lowercase_hex() {
        let scope = ScopeId::new([
            0x00, 0x01, 0x0a, 0x0f, 0x10, 0x11, 0x7f, 0x80, 0x90, 0xa0, 0xb0, 0xc0, 0xd0, 0xe0,
            0xf0, 0xff,
        ]);

        assert_eq!(scope.to_string(), "00010a0f10117f8090a0b0c0d0e0f0ff");
    }

    #[test]
    fn process_identity_preserves_pid_and_creation_marker() {
        let identity = ProcessIdentity::new(42, 0xfeed_cafe_dead_beef);

        assert_eq!(identity.pid(), 42);
        assert_eq!(identity.creation_marker(), 0xfeed_cafe_dead_beef);
    }

    #[test]
    fn authority_scope_and_provenance_keep_attach_and_owned_boundaries_distinct() {
        let scope_id = ScopeId::new([7; 16]);
        let owned = AuthorityScope::owned(scope_id);
        let identity = ProcessIdentity::new(42, 9);
        let spawned = Provenance::Spawned { scope: owned };
        let attached = Provenance::Attached { subject: identity };

        assert_eq!(owned.id(), scope_id);
        assert_eq!(spawned.class(), AuthorityClass::Owned);
        assert_eq!(attached.class(), AuthorityClass::Observed);
        assert!(matches!(
            spawned,
            Provenance::Spawned { scope } if scope == owned
        ));
        assert!(matches!(
            attached,
            Provenance::Attached { subject } if subject == identity
        ));
        assert_ne!(spawned, attached);
    }
}
