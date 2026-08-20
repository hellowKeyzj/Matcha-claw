use std::fmt;

const MAX_IDENTIFIER_BYTES: usize = 128;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SecurityPreset {
    Strict,
    Balanced,
    Relaxed,
}

impl SecurityPreset {
    pub(crate) const fn encode(self) -> u8 {
        match self {
            Self::Strict => 1,
            Self::Balanced => 2,
            Self::Relaxed => 3,
        }
    }

    pub(crate) const fn decode(value: u8) -> Option<Self> {
        match value {
            1 => Some(Self::Strict),
            2 => Some(Self::Balanced),
            3 => Some(Self::Relaxed),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BrowserMode {
    Native,
    Relay,
    Off,
}

impl BrowserMode {
    pub(crate) const fn encode(self) -> u8 {
        match self {
            Self::Native => 1,
            Self::Relay => 2,
            Self::Off => 3,
        }
    }

    pub(crate) const fn decode(value: u8) -> Option<Self> {
        match value {
            1 => Some(Self::Native),
            2 => Some(Self::Relay),
            3 => Some(Self::Off),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChannelDirectMessagePolicy {
    Pairing,
    Allowlist,
    Open,
    Disabled,
}

impl ChannelDirectMessagePolicy {
    pub(crate) const fn encode(self) -> u8 {
        match self {
            Self::Pairing => 1,
            Self::Allowlist => 2,
            Self::Open => 3,
            Self::Disabled => 4,
        }
    }

    pub(crate) const fn decode(value: u8) -> Option<Self> {
        match value {
            1 => Some(Self::Pairing),
            2 => Some(Self::Allowlist),
            3 => Some(Self::Open),
            4 => Some(Self::Disabled),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChannelOperationalDesired {
    channel: ChannelReference,
    account: ChannelAccountId,
    enabled: bool,
    direct_message_policy: ChannelDirectMessagePolicy,
}

impl ChannelOperationalDesired {
    pub fn new(
        channel: ChannelReference,
        account: ChannelAccountId,
        enabled: bool,
        direct_message_policy: ChannelDirectMessagePolicy,
    ) -> Self {
        Self {
            channel,
            account,
            enabled,
            direct_message_policy,
        }
    }

    pub fn channel(&self) -> &ChannelReference {
        &self.channel
    }

    pub fn account(&self) -> &ChannelAccountId {
        &self.account
    }

    pub const fn enabled(&self) -> bool {
        self.enabled
    }

    pub const fn direct_message_policy(&self) -> ChannelDirectMessagePolicy {
        self.direct_message_policy
    }
}

pub(crate) fn canonicalize_operational_channels(channels: &mut [ChannelOperationalDesired]) {
    channels.sort_by(|left, right| {
        left.channel
            .as_str()
            .cmp(right.channel.as_str())
            .then_with(|| left.account.as_str().cmp(right.account.as_str()))
    });
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ChannelAccountId(String);

impl ChannelAccountId {
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidChannelAccountId> {
        let value = value.into();
        if !valid_identifier(&value) {
            return Err(InvalidChannelAccountId);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidChannelAccountId;

impl fmt::Display for InvalidChannelAccountId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("channel account identifier is invalid")
    }
}

impl std::error::Error for InvalidChannelAccountId {}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_IDENTIFIER_BYTES
        && value
            .chars()
            .all(|character| !character.is_control() && !character.is_whitespace())
}

use super::ChannelReference;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operational_channel_desired_keeps_non_secret_facts_only() {
        let desired = ChannelOperationalDesired::new(
            ChannelReference::try_new("discord").unwrap(),
            ChannelAccountId::try_new("default").unwrap(),
            true,
            ChannelDirectMessagePolicy::Pairing,
        );

        assert_eq!(desired.channel().as_str(), "discord");
        assert_eq!(desired.account().as_str(), "default");
        assert!(desired.enabled());
        assert_eq!(
            desired.direct_message_policy(),
            ChannelDirectMessagePolicy::Pairing
        );
    }

    #[test]
    fn channel_account_rejects_empty_whitespace_or_control_values() {
        for value in ["", " ", "account\n"] {
            assert_eq!(
                ChannelAccountId::try_new(value).unwrap_err(),
                InvalidChannelAccountId
            );
        }
    }

    #[test]
    fn browser_mode_preserves_disabled_native_and_relay_desired_values() {
        assert_eq!(BrowserMode::Native.encode(), 1);
        assert_eq!(BrowserMode::Relay.encode(), 2);
        assert_eq!(BrowserMode::Off.encode(), 3);
    }
}
