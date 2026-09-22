use std::fmt;

use platform::endpoint::runtime_address::RuntimeEndpoint;
use zeroize::Zeroizing;

use crate::domain::control::ChannelControlAction;

#[derive(Clone, Eq, Hash, PartialEq)]
pub struct ChannelKey {
    endpoint: RuntimeEndpoint,
    channel_id: ChannelId,
    account_id: Option<AccountId>,
}

impl ChannelKey {
    pub fn try_new(
        endpoint: RuntimeEndpoint,
        channel_id: impl Into<String>,
        account_id: Option<String>,
    ) -> Result<Self, InvalidChannelKey> {
        Ok(Self {
            endpoint,
            channel_id: ChannelId::try_new(channel_id.into())?,
            account_id: account_id.map(AccountId::try_new).transpose()?,
        })
    }

    pub fn endpoint(&self) -> &RuntimeEndpoint {
        &self.endpoint
    }

    pub fn channel_id(&self) -> &str {
        &self.channel_id.0
    }

    pub fn account_id(&self) -> Option<&str> {
        self.account_id.as_ref().map(|id| id.0.as_str())
    }

    pub fn channel_scope(&self) -> Self {
        Self {
            endpoint: self.endpoint.clone(),
            channel_id: self.channel_id.clone(),
            account_id: None,
        }
    }
}

impl fmt::Debug for ChannelKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ChannelKey(<opaque>)")
    }
}

#[derive(Clone, Eq, Hash, PartialEq)]
struct ChannelId(String);

impl ChannelId {
    fn try_new(value: String) -> Result<Self, InvalidChannelKey> {
        valid_identity(&value)
            .then_some(Self(value))
            .ok_or(InvalidChannelKey)
    }
}

#[derive(Clone, Eq, Hash, PartialEq)]
struct AccountId(String);

impl AccountId {
    fn try_new(value: String) -> Result<Self, InvalidChannelKey> {
        valid_identity(&value)
            .then_some(Self(value))
            .ok_or(InvalidChannelKey)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidChannelKey;

impl fmt::Display for InvalidChannelKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("channel owner key is invalid")
    }
}

impl std::error::Error for InvalidChannelKey {}

fn valid_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| !character.is_control() && !character.is_whitespace())
}

pub(crate) enum ChannelMutation {
    Configure {
        agent_id: Option<String>,
        values: Zeroizing<Vec<u8>>,
    },
    DeleteConfig,
    Control(ChannelControlAction),
    LoginStart {
        force: bool,
        timeout_ms: Option<u64>,
    },
    LoginWait {
        timeout_ms: Option<u64>,
        session_key: Option<String>,
        current_qr_data_url: Option<String>,
    },
    StopLogin,
    Logout,
    PairingApprove {
        code: Zeroizing<Vec<u8>>,
    },
    ValidateCredentials {
        config: Zeroizing<Vec<u8>>,
    },
    FinalizeLogin {
        agent_id: Option<String>,
        config: Zeroizing<Vec<u8>>,
    },
}

pub(crate) enum ChannelMutationEffect {
    Configure(crate::domain::catalog::ChannelConfigureOutcome),
    DeleteConfig(crate::domain::delete::Outcome),
    Control(crate::domain::control::ChannelControlOutcome),
    Login(crate::domain::login::Outcome),
    PairingApprove(crate::domain::status::ChannelPairingApprovalOutcome),
    Credentials(crate::domain::credentials::Outcome),
    LoginFinalized(LoginFinalizationOutcome),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LoginFinalizationOutcome {
    Confirmed,
    Rejected,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ChannelOperationKind {
    Configure,
    DeleteConfig,
    Connect,
    Disconnect,
    LoginStart,
    LoginWait,
    StopLogin,
    Logout,
    PairingApprove,
    ValidateCredentials,
    FinalizeLogin,
}

impl ChannelOperationKind {
    pub(crate) fn trace_phase(self) -> &'static str {
        match self {
            Self::Configure => "channel.mutation.configure",
            Self::DeleteConfig => "channel.mutation.delete",
            Self::Connect => "channel.mutation.connect",
            Self::Disconnect => "channel.mutation.disconnect",
            Self::LoginStart => "channel.login.start",
            Self::LoginWait => "channel.login.wait",
            Self::StopLogin => "channel.login.cancel",
            Self::Logout => "channel.login.logout",
            Self::PairingApprove => "channel.mutation.pairing_approve",
            Self::ValidateCredentials => "channel.mutation.validate_credentials",
            Self::FinalizeLogin => "channel.mutation.finalize_login",
        }
    }
}

impl ChannelMutationEffect {
    pub(crate) fn trace_outcome(&self) -> &'static str {
        use crate::{
            catalog::ChannelConfigureOutcome as Configure,
            control::ChannelControlOutcome as Control, credentials::Outcome as Credentials,
            delete::Outcome as Delete, status::ChannelPairingApprovalOutcome as Pairing,
        };
        match self {
            Self::Configure(Configure::Confirmed)
            | Self::DeleteConfig(Delete::Confirmed)
            | Self::Control(Control::Confirmed)
            | Self::PairingApprove(Pairing::Confirmed)
            | Self::LoginFinalized(LoginFinalizationOutcome::Confirmed) => "confirmed",
            Self::Configure(Configure::TargetRejected)
            | Self::DeleteConfig(Delete::TargetRejected)
            | Self::Control(Control::Rejected)
            | Self::PairingApprove(Pairing::TargetRejected)
            | Self::Credentials(Credentials::TargetRejected)
            | Self::LoginFinalized(LoginFinalizationOutcome::Rejected) => "rejected",
            Self::Credentials(Credentials::Validated(validation)) => {
                if validation.valid {
                    "valid"
                } else {
                    "invalid"
                }
            }
            Self::Login(outcome) => outcome.trace_outcome(),
            Self::Configure(Configure::Unknown)
            | Self::DeleteConfig(Delete::Unknown)
            | Self::Control(Control::OutcomeUnknown)
            | Self::PairingApprove(Pairing::Unknown)
            | Self::Credentials(Credentials::Unknown)
            | Self::LoginFinalized(LoginFinalizationOutcome::Unknown) => "unknown",
        }
    }
}

pub(crate) fn mutation_kind(mutation: &ChannelMutation) -> ChannelOperationKind {
    match mutation {
        ChannelMutation::Configure { .. } => ChannelOperationKind::Configure,
        ChannelMutation::DeleteConfig => ChannelOperationKind::DeleteConfig,
        ChannelMutation::Control(ChannelControlAction::Connect) => ChannelOperationKind::Connect,
        ChannelMutation::Control(ChannelControlAction::Disconnect) => {
            ChannelOperationKind::Disconnect
        }
        ChannelMutation::LoginStart { .. } => ChannelOperationKind::LoginStart,
        ChannelMutation::LoginWait { .. } => ChannelOperationKind::LoginWait,
        ChannelMutation::StopLogin => ChannelOperationKind::StopLogin,
        ChannelMutation::Logout => ChannelOperationKind::Logout,
        ChannelMutation::PairingApprove { .. } => ChannelOperationKind::PairingApprove,
        ChannelMutation::ValidateCredentials { .. } => ChannelOperationKind::ValidateCredentials,
        ChannelMutation::FinalizeLogin { .. } => ChannelOperationKind::FinalizeLogin,
    }
}
