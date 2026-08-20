use std::fmt;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct EnvironmentId(String);

impl EnvironmentId {
    /// Creates an Environment identity.
    ///
    /// # Errors
    ///
    /// Returns [`InvalidEnvironmentId`] when `value` is empty or contains only
    /// whitespace.
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidEnvironmentId> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(InvalidEnvironmentId);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidEnvironmentId;

impl fmt::Display for InvalidEnvironmentId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("environment ID must not be empty")
    }
}

impl std::error::Error for InvalidEnvironmentId {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_preserves_a_non_empty_environment_id() {
        let id = EnvironmentId::try_new(" environment:primary ").unwrap();

        assert_eq!(id.as_str(), " environment:primary ");
    }

    #[test]
    fn identity_rejects_empty_values_without_exposing_input() {
        for value in ["", " \t\r\n", "\u{2003}"] {
            let error = EnvironmentId::try_new(value).unwrap_err();

            assert_eq!(error, InvalidEnvironmentId);
            assert_eq!(error.to_string(), "environment ID must not be empty");
            assert_eq!(format!("{error:?}"), "InvalidEnvironmentId");
        }
    }
}
