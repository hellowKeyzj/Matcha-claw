use std::fmt;

const MAX_IDENTIFIER_BYTES: usize = 128;

/// Validated public identity used solely to address an existing Gateway channel
/// account. It carries neither configuration nor credential material.
#[derive(Clone, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) struct ChannelId(String);

impl ChannelId {
    pub(crate) fn try_new(value: String) -> Result<Self, ChannelIdentityError> {
        valid_identifier(&value)
            .then_some(Self(value))
            .ok_or(ChannelIdentityError::InvalidChannel)
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ChannelId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_tuple("ChannelId").field(&self.0).finish()
    }
}

/// Validated public account identity paired with a [`ChannelId`].
#[derive(Clone, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) struct AccountId(String);

impl AccountId {
    pub(crate) fn try_new(value: String) -> Result<Self, ChannelIdentityError> {
        valid_identifier(&value)
            .then_some(Self(value))
            .ok_or(ChannelIdentityError::InvalidAccount)
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for AccountId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_tuple("AccountId").field(&self.0).finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ChannelIdentityError {
    InvalidChannel,
    InvalidAccount,
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_IDENTIFIER_BYTES
        && value
            .chars()
            .all(|character| !character.is_control() && !character.is_whitespace())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_control_and_whitespace_identities() {
        for value in ["", "with space", "with\ncontrol"] {
            assert!(ChannelId::try_new(value.into()).is_err());
            assert!(AccountId::try_new(value.into()).is_err());
        }
    }
}
