use std::fmt;

use platform::endpoint::runtime_address::RuntimeEndpoint;
use zeroize::Zeroizing;

use crate::channel::control::ChannelControlAction;

const OPENCLAW_RUNTIME_ADAPTER_ID: &str = "openclaw";

#[derive(Clone, Eq, Hash, PartialEq)]
pub(crate) struct ChannelKey {
    endpoint: RuntimeEndpoint,
    channel_id: ChannelId,
    account_id: Option<AccountId>,
}

impl ChannelKey {
    pub(crate) fn try_new(
        endpoint: RuntimeEndpoint,
        channel_id: impl Into<String>,
        account_id: Option<String>,
    ) -> Result<Self, InvalidChannelKey> {
        if endpoint.runtime_adapter_id() != OPENCLAW_RUNTIME_ADAPTER_ID {
            return Err(InvalidChannelKey);
        }
        Ok(Self {
            endpoint,
            channel_id: ChannelId::try_new(channel_id.into())?,
            account_id: account_id.map(AccountId::try_new).transpose()?,
        })
    }

    pub(crate) fn endpoint(&self) -> &RuntimeEndpoint {
        &self.endpoint
    }

    pub(crate) fn channel_id(&self) -> &str {
        &self.channel_id.0
    }

    pub(crate) fn account_id(&self) -> Option<&str> {
        self.account_id.as_ref().map(|id| id.0.as_str())
    }

    pub(crate) fn channel_scope(&self) -> Self {
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
pub(crate) struct InvalidChannelKey;

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

pub(super) enum ChannelMutation {
    Configure {
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
        config: Zeroizing<Vec<u8>>,
    },
}

pub(super) enum ChannelMutationEffect {
    Configure(crate::channel::catalog::ChannelConfigureOutcome),
    DeleteConfig(crate::channel::delete::Outcome),
    Control(crate::channel::control::ChannelControlOutcome),
    Login(crate::channel::login::Outcome),
    PairingApprove(crate::channel::status::ChannelPairingApprovalOutcome),
    Credentials(crate::channel::credentials::Outcome),
    LoginFinalized(LoginFinalizationOutcome),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum LoginFinalizationOutcome {
    Confirmed,
    Rejected,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ChannelOperationKind {
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

pub(super) fn mutation_kind(mutation: &ChannelMutation) -> ChannelOperationKind {
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
