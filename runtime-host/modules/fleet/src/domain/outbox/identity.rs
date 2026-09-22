use std::fmt;

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct DispatchId(String);

impl DispatchId {
    /// Creates an identity for one Fleet command delivery.
    ///
    /// # Errors
    ///
    /// Returns [`InvalidDispatchId`] when `value` is empty or whitespace.
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidDispatchId> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(InvalidDispatchId);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidDispatchId;

impl fmt::Display for InvalidDispatchId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("dispatch ID must not be empty")
    }
}

impl std::error::Error for InvalidDispatchId {}
