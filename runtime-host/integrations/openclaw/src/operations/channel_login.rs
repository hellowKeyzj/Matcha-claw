use std::{fmt, sync::Arc};

use tokio_util::sync::CancellationToken;

use crate::gateway::{
    client::GatewayClient,
    delivery::MutationDelivery,
    wire::{self, GatewayResponse},
};

use super::next_request_id;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChannelRuntimeAction {
    Start,
    Stop,
    Logout,
}

impl ChannelRuntimeAction {
    pub(crate) const fn method(self) -> &'static str {
        match self {
            Self::Start => wire::channel::CHANNELS_START_METHOD,
            Self::Stop => wire::channel::CHANNELS_STOP_METHOD,
            Self::Logout => wire::channel::CHANNELS_LOGOUT_METHOD,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChannelRuntimeConfirmation {
    channel: String,
    account: Option<String>,
}

impl ChannelRuntimeConfirmation {
    pub fn channel(&self) -> &str {
        &self.channel
    }

    pub fn account(&self) -> Option<&str> {
        self.account.as_deref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChannelRuntimeEffect {
    Confirmed(ChannelRuntimeConfirmation),
    Rejected,
    Unknown,
}

#[derive(Clone, Eq, PartialEq)]
pub struct WebLoginStart {
    pub force: bool,
    pub timeout_ms: Option<u64>,
    pub verbose: bool,
    pub account_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WebLoginWait {
    pub timeout_ms: Option<u64>,
    pub account_id: Option<String>,
    pub session_key: Option<String>,
    pub current_qr_data_url: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LoginProgressStatus {
    Connected,
    Qr,
    Pending,
    Rejected,
    Unknown,
}

#[derive(Clone, Eq, PartialEq)]
pub struct LoginProgress {
    status: LoginProgressStatus,
    account_id: Option<String>,
    session_key: Option<String>,
    qr_data_url: Option<String>,
}

impl fmt::Debug for LoginProgress {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LoginProgress")
            .field("status", &self.status)
            .field("account_id", &self.account_id)
            .field(
                "session_key",
                &self.session_key.as_ref().map(|_| "[REDACTED]"),
            )
            .field(
                "qr_data_url",
                &self.qr_data_url.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}

impl LoginProgress {
    pub fn status(&self) -> LoginProgressStatus {
        self.status
    }

    pub fn account_id(&self) -> Option<&str> {
        self.account_id.as_deref()
    }

    pub fn session_key(&self) -> Option<&str> {
        self.session_key.as_deref()
    }

    pub fn qr_data_url(&self) -> Option<&str> {
        self.qr_data_url.as_deref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WebLoginStartEffect {
    Progress(LoginProgress),
    Rejected,
    Unsupported,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WebLoginWaitEffect {
    Progress(LoginProgress),
    Cancelled,
    Rejected,
    Unsupported,
    Unknown,
}

pub struct ChannelLoginOperation {
    gateway: Arc<GatewayClient>,
}

impl ChannelLoginOperation {
    pub fn new(gateway: Arc<GatewayClient>) -> Self {
        Self { gateway }
    }

    pub async fn runtime(
        &self,
        action: ChannelRuntimeAction,
        channel: String,
        account: Option<String>,
    ) -> ChannelRuntimeEffect {
        if !valid_identity(&channel)
            || account
                .as_deref()
                .is_some_and(|value| !valid_identity(value))
        {
            return ChannelRuntimeEffect::Rejected;
        }
        let request = match wire::channel::channel_runtime_request(
            next_request_id("channel-runtime"),
            action,
            &channel,
            account.as_deref(),
        ) {
            Ok(request) => request,
            Err(_) => return ChannelRuntimeEffect::Unknown,
        };
        match self.gateway.rpc_mutation(request).await {
            MutationDelivery::Response(GatewayResponse::Failure { .. }) => {
                ChannelRuntimeEffect::Rejected
            }
            MutationDelivery::Response(response) => {
                match wire::channel::decode_channel_runtime_confirmation(response, action, &channel)
                {
                    Ok((channel, account)) => {
                        ChannelRuntimeEffect::Confirmed(ChannelRuntimeConfirmation {
                            channel,
                            account,
                        })
                    }
                    Err(_) => ChannelRuntimeEffect::Unknown,
                }
            }
            MutationDelivery::NotWritten(_) | MutationDelivery::MayHaveReached(_) => {
                ChannelRuntimeEffect::Unknown
            }
        }
    }

    pub async fn login_start(&self, channel: String, input: WebLoginStart) -> WebLoginStartEffect {
        if !valid_identity(&channel) {
            return WebLoginStartEffect::Rejected;
        }
        if !valid_login_start(&input) {
            return WebLoginStartEffect::Rejected;
        }
        let request = match wire::channel::web_login_start_request(
            next_request_id("web-login-start"),
            &channel,
            input.force,
            input.timeout_ms,
            input.verbose,
            input.account_id.as_deref(),
        ) {
            Ok(request) => request,
            Err(_) => return WebLoginStartEffect::Rejected,
        };
        match self.exchange_login(request).await {
            LoginExchange::Rejected => WebLoginStartEffect::Rejected,
            LoginExchange::Unknown => WebLoginStartEffect::Unknown,
            LoginExchange::Response(response) => {
                match wire::channel::decode_login_progress(response, input.account_id.as_deref()) {
                    Ok(progress) => WebLoginStartEffect::Progress(progress.into_public()),
                    Err(_) => WebLoginStartEffect::Unknown,
                }
            }
        }
    }

    pub async fn login_wait(&self, channel: String, input: WebLoginWait) -> WebLoginWaitEffect {
        self.login_wait_with_cancellation(channel, input, CancellationToken::new())
            .await
    }

    pub async fn login_wait_with_cancellation(
        &self,
        channel: String,
        input: WebLoginWait,
        cancellation: CancellationToken,
    ) -> WebLoginWaitEffect {
        if !valid_identity(&channel) {
            return WebLoginWaitEffect::Rejected;
        }
        if !valid_login_wait(&input) {
            return WebLoginWaitEffect::Rejected;
        }
        let request = match wire::channel::web_login_wait_request(
            next_request_id("web-login-wait"),
            &channel,
            input.timeout_ms,
            input.account_id.as_deref(),
            input.session_key.as_deref(),
            input.current_qr_data_url.as_deref(),
        ) {
            Ok(request) => request,
            Err(_) => return WebLoginWaitEffect::Rejected,
        };
        let exchange = tokio::select! {
            _ = cancellation.cancelled() => return WebLoginWaitEffect::Cancelled,
            result = self.exchange_login(request) => result,
        };
        match exchange {
            LoginExchange::Rejected => WebLoginWaitEffect::Rejected,
            LoginExchange::Unknown => WebLoginWaitEffect::Unknown,
            LoginExchange::Response(response) => {
                match wire::channel::decode_login_progress(response, input.account_id.as_deref()) {
                    Ok(progress) => WebLoginWaitEffect::Progress(progress.into_public()),
                    Err(_) => WebLoginWaitEffect::Unknown,
                }
            }
        }
    }

    async fn exchange_login(&self, request: wire::RpcRequest) -> LoginExchange {
        match self.gateway.rpc_mutation(request).await {
            MutationDelivery::Response(GatewayResponse::Failure { .. }) => LoginExchange::Rejected,
            MutationDelivery::Response(response) => LoginExchange::Response(response),
            MutationDelivery::NotWritten(_) | MutationDelivery::MayHaveReached(_) => {
                LoginExchange::Unknown
            }
        }
    }
}

enum LoginExchange {
    Response(GatewayResponse),
    Rejected,
    Unknown,
}

fn valid_login_start(input: &WebLoginStart) -> bool {
    input.account_id.as_deref().is_none_or(valid_identity)
}

fn valid_login_wait(input: &WebLoginWait) -> bool {
    input.account_id.as_deref().is_none_or(valid_identity)
        && input.session_key.as_deref().is_none_or(valid_identity)
        && input
            .current_qr_data_url
            .as_deref()
            .is_none_or(valid_qr_data_url)
}

fn valid_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| !character.is_control() && !character.is_whitespace())
}

fn valid_qr_data_url(value: &str) -> bool {
    value.starts_with(wire::channel::QR_DATA_URL_PREFIX)
        && value.len() <= wire::channel::MAX_QR_DATA_URL_LENGTH
}

impl wire::channel::NativeLoginProgress {
    fn into_public(self) -> LoginProgress {
        LoginProgress {
            status: self.status,
            account_id: self.account_id,
            session_key: self.session_key,
            qr_data_url: self.qr_data_url,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_channel_identity_accepts_native_plugin_channels() {
        assert!(valid_identity("whatsapp"));
        assert!(valid_identity("openclaw-weixin"));
        assert!(valid_identity("telegram"));
    }

    #[test]
    fn qr_data_url_requires_exact_png_prefix_and_bound() {
        assert!(valid_qr_data_url("data:image/png;base64,abc"));
        assert!(!valid_qr_data_url("data:image/svg+xml;base64,abc"));
        assert!(!valid_qr_data_url(&format!(
            "{}{}",
            wire::channel::QR_DATA_URL_PREFIX,
            "x".repeat(16_384)
        )));
    }

    #[test]
    fn login_debug_does_not_expose_qr_data() {
        let progress = LoginProgress {
            status: LoginProgressStatus::Qr,
            account_id: Some("primary".into()),
            session_key: None,
            qr_data_url: Some("data:image/png;base64,private-qr".into()),
        };
        assert!(!format!("{progress:?}").contains("private-qr"));
    }
}
