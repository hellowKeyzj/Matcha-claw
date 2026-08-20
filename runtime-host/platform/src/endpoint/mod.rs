pub mod runtime_address;

use std::fmt;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct EndpointId(String);

impl EndpointId {
    /// Creates an endpoint instance identity.
    ///
    /// # Errors
    ///
    /// Returns [`InvalidEndpointId`] when `value` is empty or contains only
    /// whitespace.
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidEndpointId> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(InvalidEndpointId);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidEndpointId;

impl fmt::Display for InvalidEndpointId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("endpoint ID must not be empty")
    }
}

impl std::error::Error for InvalidEndpointId {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidNativeAgentId;

impl fmt::Display for InvalidNativeAgentId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("native agent ID must not be empty")
    }
}

impl std::error::Error for InvalidNativeAgentId {}

#[derive(Clone, Eq, Hash, PartialEq)]
pub struct NativeAgentId(String);

impl NativeAgentId {
    /// Creates an identity issued by a native Runtime.
    ///
    /// # Errors
    ///
    /// Returns [`InvalidNativeAgentId`] when `value` is empty or contains only
    /// whitespace.
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidNativeAgentId> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(InvalidNativeAgentId);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for NativeAgentId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("NativeAgentId(<opaque>)")
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn endpoint_id_preserves_a_non_empty_instance_identity() {
        let endpoint_id = EndpointId::try_new(" openclaw:primary ").unwrap();

        assert_eq!(endpoint_id.as_str(), " openclaw:primary ");
    }

    #[test]
    fn endpoint_id_equality_and_hash_use_the_preserved_identity() {
        let primary = EndpointId::try_new("primary").unwrap();
        let same = EndpointId::try_new(String::from("primary")).unwrap();
        let spaced = EndpointId::try_new(" primary ").unwrap();
        let mut endpoint_ids = HashSet::from([primary.clone(), spaced.clone()]);

        assert_eq!(primary, same);
        assert_ne!(primary, spaced);
        assert!(endpoint_ids.remove(&same));
        assert!(endpoint_ids.contains(&spaced));
    }

    #[test]
    fn endpoint_id_rejects_empty_and_whitespace_only_values() {
        for value in ["", " \t\r\n", "\u{2003}"] {
            assert_eq!(EndpointId::try_new(value).unwrap_err(), InvalidEndpointId);
        }
    }

    #[test]
    fn invalid_endpoint_id_error_is_fixed_and_does_not_echo_input() {
        let empty = EndpointId::try_new("").unwrap_err();
        let whitespace = EndpointId::try_new(" \t\n").unwrap_err();

        assert_eq!(empty.to_string(), "endpoint ID must not be empty");
        assert_eq!(empty.to_string(), whitespace.to_string());
        assert_eq!(format!("{empty:?}"), "InvalidEndpointId");
    }
}
