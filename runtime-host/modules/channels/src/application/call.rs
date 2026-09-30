use std::sync::Arc;

use platform::call::{CallContext, CallDetail, CallLogError, CallReceipt, CallStatus};
use serde::Serialize;
use tokio::sync::OnceCell;

use crate::domain::operations::{ChannelKey, ChannelMutationEffect, LoginFinalizationOutcome};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelCallDetail {
    pub operation: ChannelCallOperation,
    pub channel: Option<String>,
    pub account_id: Option<String>,
    pub phase: ChannelCallPhase,
    pub outcome: Option<ChannelCallOutcome>,
    pub reply: Option<ChannelCallOutcome>,
    pub config_finalization: Option<ChannelConfigFinalization>,
}

impl CallDetail for ChannelCallDetail {
    const MODULE: &'static str = "channels";
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChannelCallOperation {
    Catalog,
    ConfigureForm,
    ConfigRead,
    PairingList,
    Status,
    Snapshot,
    Configure,
    DeleteConfig,
    Connect,
    Disconnect,
    LoginStart,
    LoginWait,
    LoginCancel,
    Logout,
    PairingApprove,
    ValidateCredentials,
}

impl ChannelCallOperation {
    pub(crate) fn command(self) -> &'static str {
        match self {
            Self::Catalog => "catalog",
            Self::ConfigureForm => "configureForm",
            Self::ConfigRead => "configRead",
            Self::PairingList => "pairingList",
            Self::Status => "status",
            Self::Snapshot => "snapshot",
            Self::Configure => "configure",
            Self::DeleteConfig => "deleteConfig",
            Self::Connect => "connect",
            Self::Disconnect => "disconnect",
            Self::LoginStart => "loginStart",
            Self::LoginWait => "loginWait",
            Self::LoginCancel => "loginCancel",
            Self::Logout => "logout",
            Self::PairingApprove => "pairingApprove",
            Self::ValidateCredentials => "validateCredentials",
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChannelCallPhase {
    Admission,
    Execution,
    Reply,
    ConfigFinalization,
    Complete,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChannelCallOutcome {
    Confirmed,
    Connected,
    Qr,
    Pending,
    Rejected,
    Unsupported,
    Cancelled,
    Valid,
    Invalid,
    Unknown,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChannelConfigFinalization {
    Confirmed,
    Rejected,
    Unknown,
}

impl ChannelCallDetail {
    pub(crate) fn new(operation: ChannelCallOperation, channel: Option<String>, account_id: Option<String>) -> Self {
        Self { operation, channel, account_id, phase: ChannelCallPhase::Admission, outcome: None, reply: None, config_finalization: None }
    }

    pub(crate) fn keyed(operation: ChannelCallOperation, key: &ChannelKey) -> Self {
        Self::new(operation, Some(key.channel_id().to_owned()), key.account_id().map(str::to_owned))
    }
}

#[derive(Clone)]
pub(crate) struct ChannelCall {
    pub context: CallContext<ChannelCallDetail>,
    pub detail: ChannelCallDetail,
    admission: Arc<OnceCell<Result<CallReceipt, CallLogError>>>,
}

impl ChannelCall {
    pub fn new(context: CallContext<ChannelCallDetail>, detail: ChannelCallDetail) -> Self {
        Self {
            context,
            detail,
            admission: Arc::new(OnceCell::new()),
        }
    }

    pub async fn accepted(&self) -> Result<CallReceipt, CallLogError> {
        // Both callers run after enqueue; share the persistence result before native execution.
        self.admission
            .get_or_init(|| self.context.accepted())
            .await
            .clone()
    }

    pub async fn running(&mut self) -> Result<(), CallLogError> {
        self.accepted().await?;
        self.detail.phase = ChannelCallPhase::Execution;
        self.context.update(&self.detail).await?;
        self.context.running().await
    }

    pub async fn finish(&mut self, outcome: ChannelCallOutcome) -> Result<(), CallLogError> {
        self.detail.phase = ChannelCallPhase::Complete;
        self.detail.outcome = Some(outcome);
        self.context.finish(outcome.status(), &self.detail).await
    }

    pub async fn effect(&mut self, effect: &ChannelMutationEffect) -> Result<(), CallLogError> {
        self.finish(effect_outcome(effect)).await
    }

    pub async fn login_reply(&mut self, effect: &ChannelMutationEffect) -> Result<(), CallLogError> {
        let outcome = effect_outcome(effect);
        self.detail.phase = ChannelCallPhase::Reply;
        self.detail.reply = Some(outcome);
        self.context.update(&self.detail).await?;
        if matches!(outcome, ChannelCallOutcome::Qr | ChannelCallOutcome::Pending) {
            self.context.waiting().await?;
        }
        Ok(())
    }

    pub async fn finalizing(&mut self, key: &ChannelKey) -> Result<(), CallLogError> {
        self.detail.phase = ChannelCallPhase::ConfigFinalization;
        self.detail.account_id = key.account_id().map(str::to_owned);
        self.context.update(&self.detail).await?;
        self.context.running().await
    }

    pub async fn finalized(&mut self, effect: &ChannelMutationEffect) -> Result<(), CallLogError> {
        let outcome = effect_outcome(effect);
        self.detail.config_finalization = Some(match effect {
            ChannelMutationEffect::LoginFinalized(LoginFinalizationOutcome::Confirmed) => ChannelConfigFinalization::Confirmed,
            ChannelMutationEffect::LoginFinalized(LoginFinalizationOutcome::Rejected) => ChannelConfigFinalization::Rejected,
            _ => ChannelConfigFinalization::Unknown,
        });
        self.finish(outcome).await
    }
}

impl ChannelCallOutcome {
    fn status(self) -> CallStatus {
        match self {
            Self::Confirmed | Self::Connected | Self::Qr | Self::Pending | Self::Cancelled | Self::Valid => CallStatus::Succeeded,
            Self::Rejected | Self::Unsupported => CallStatus::Rejected,
            Self::Invalid => CallStatus::Failed,
            Self::Unknown => CallStatus::Unknown,
        }
    }
}

fn effect_outcome(effect: &ChannelMutationEffect) -> ChannelCallOutcome {
    use crate::domain::{catalog::ChannelConfigureOutcome as Configure, control::ChannelControlOutcome as Control, credentials::Outcome as Credentials, delete::Outcome as Delete, login::{LoginProgressStatus, Outcome as Login}, status::ChannelPairingApprovalOutcome as Pairing};
    match effect {
        ChannelMutationEffect::Configure(Configure::Confirmed)
        | ChannelMutationEffect::DeleteConfig(Delete::Confirmed)
        | ChannelMutationEffect::Control(Control::Confirmed)
        | ChannelMutationEffect::PairingApprove(Pairing::Confirmed)
        | ChannelMutationEffect::LoginFinalized(LoginFinalizationOutcome::Confirmed)
        | ChannelMutationEffect::Login(Login::Confirmed) => ChannelCallOutcome::Confirmed,
        ChannelMutationEffect::Configure(Configure::TargetRejected)
        | ChannelMutationEffect::DeleteConfig(Delete::TargetRejected)
        | ChannelMutationEffect::Control(Control::Rejected)
        | ChannelMutationEffect::PairingApprove(Pairing::TargetRejected)
        | ChannelMutationEffect::Credentials(Credentials::TargetRejected)
        | ChannelMutationEffect::LoginFinalized(LoginFinalizationOutcome::Rejected)
        | ChannelMutationEffect::Login(Login::Rejected) => ChannelCallOutcome::Rejected,
        ChannelMutationEffect::Login(Login::Unsupported) => ChannelCallOutcome::Unsupported,
        ChannelMutationEffect::Login(Login::Cancelled) => ChannelCallOutcome::Cancelled,
        ChannelMutationEffect::Credentials(Credentials::Validated(validation)) => if validation.valid { ChannelCallOutcome::Valid } else { ChannelCallOutcome::Invalid },
        ChannelMutationEffect::Login(Login::Progress(progress)) => match progress.status {
            LoginProgressStatus::Connected => ChannelCallOutcome::Connected,
            LoginProgressStatus::Qr => ChannelCallOutcome::Qr,
            LoginProgressStatus::Pending => ChannelCallOutcome::Pending,
            LoginProgressStatus::Rejected => ChannelCallOutcome::Rejected,
            LoginProgressStatus::Unknown => ChannelCallOutcome::Unknown,
        },
        _ => ChannelCallOutcome::Unknown,
    }
}

pub(crate) fn record_error(result: Result<(), CallLogError>) {
    if let Err(error) = result {
        platform::trace::channel_trace("channel.call_log", &format!("outcome=failed code={error:?}"));
    }
}
