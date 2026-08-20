use std::fmt;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CapabilityId(String);

impl CapabilityId {
    /// Creates a capability identity.
    ///
    /// # Errors
    ///
    /// Returns [`InvalidCapabilityId`] when `value` is empty or contains only
    /// whitespace.
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidCapabilityId> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(InvalidCapabilityId);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidCapabilityId;

impl fmt::Display for InvalidCapabilityId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("capability ID must not be empty")
    }
}

impl std::error::Error for InvalidCapabilityId {}

/// Boundary where a capability is advertised or invoked.
///
/// This is capability grammar, not runtime object containment. Do not use it as
/// a substitute for [`crate::endpoint::runtime_address::RuntimeScope`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CapabilityScope {
    Endpoint,
    Agent,
    Session,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CapabilityAvailability {
    Available,
    Unavailable,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SupportedCapability {
    id: CapabilityId,
    scope: CapabilityScope,
}

impl SupportedCapability {
    pub const fn new(id: CapabilityId, scope: CapabilityScope) -> Self {
        Self { id, scope }
    }

    pub const fn id(&self) -> &CapabilityId {
        &self.id
    }

    pub const fn scope(&self) -> CapabilityScope {
        self.scope
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn capability_id_preserves_owned_identity() {
        let id = CapabilityId::try_new(" session.prompt ").unwrap();
        let same = CapabilityId::try_new(String::from(" session.prompt ")).unwrap();
        let distinct = CapabilityId::try_new("session.prompt").unwrap();
        let identities = HashSet::from([id.clone(), distinct.clone()]);

        assert_eq!(id.as_str(), " session.prompt ");
        assert_eq!(id, same);
        assert_ne!(id, distinct);
        assert!(identities.contains(&same));
    }

    #[test]
    fn capability_id_rejects_empty_and_whitespace_only_values_without_echoing_input() {
        let empty = CapabilityId::try_new("").unwrap_err();
        let whitespace = CapabilityId::try_new(" \t\n").unwrap_err();

        assert_eq!(empty, InvalidCapabilityId);
        assert_eq!(empty.to_string(), "capability ID must not be empty");
        assert_eq!(empty.to_string(), whitespace.to_string());
        assert_eq!(format!("{empty:?}"), "InvalidCapabilityId");
    }

    #[test]
    fn supported_capability_keeps_static_identity_and_scope() {
        let id = CapabilityId::try_new("session.prompt").unwrap();

        for scope in [
            CapabilityScope::Endpoint,
            CapabilityScope::Agent,
            CapabilityScope::Session,
        ] {
            let capability = SupportedCapability::new(id.clone(), scope);

            assert_eq!(capability.id(), &id);
            assert_eq!(capability.scope(), scope);
        }
    }
}
