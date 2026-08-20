use std::sync::Arc;

use serde_json::{Value, json};

use crate::gateway::{
    client::GatewayClient,
    delivery::MutationDelivery,
    wire::{self, GatewayResponse},
};

use super::{
    channel_identity::{AccountId, ChannelId},
    next_request_id,
};

const CHANNELS_START_METHOD: &str = "channels.start";
const CHANNELS_STOP_METHOD: &str = "channels.stop";

/// Native Gateway account-runtime control. A positive result is only returned
/// when the Gateway confirms the same channel/account and the requested
/// runtime state; transport ambiguity is deliberately not retried.
pub struct ChannelControlOperation {
    gateway: Arc<GatewayClient>,
}

impl ChannelControlOperation {
    pub fn new(gateway: Arc<GatewayClient>) -> Self {
        Self { gateway }
    }

    pub async fn connect(&self, channel: String, account: String) -> ChannelControlEffect {
        self.mutate(ChannelControlAction::Start, channel, account)
            .await
    }

    pub async fn disconnect(&self, channel: String, account: String) -> ChannelControlEffect {
        self.mutate(ChannelControlAction::Stop, channel, account)
            .await
    }

    async fn mutate(
        &self,
        action: ChannelControlAction,
        channel: String,
        account: String,
    ) -> ChannelControlEffect {
        let channel = match ChannelId::try_new(channel) {
            Ok(channel) => channel,
            Err(_) => return ChannelControlEffect::Rejected,
        };
        let account = match AccountId::try_new(account) {
            Ok(account) => account,
            Err(_) => return ChannelControlEffect::Rejected,
        };
        let request = match channel_control_request(action, &channel, &account) {
            Ok(request) => request,
            Err(_) => return ChannelControlEffect::OutcomeUnknown,
        };
        match self.gateway.rpc_mutation(request).await {
            MutationDelivery::Response(GatewayResponse::Failure { .. }) => {
                ChannelControlEffect::Rejected
            }
            MutationDelivery::Response(response) => {
                if decode_confirmation(response, action, &channel, &account).is_ok() {
                    ChannelControlEffect::Confirmed
                } else {
                    ChannelControlEffect::OutcomeUnknown
                }
            }
            MutationDelivery::NotWritten(_) | MutationDelivery::MayHaveReached(_) => {
                ChannelControlEffect::OutcomeUnknown
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChannelControlEffect {
    Confirmed,
    Rejected,
    OutcomeUnknown,
}

#[derive(Clone, Copy)]
enum ChannelControlAction {
    Start,
    Stop,
}

impl ChannelControlAction {
    const fn method(self) -> &'static str {
        match self {
            Self::Start => CHANNELS_START_METHOD,
            Self::Stop => CHANNELS_STOP_METHOD,
        }
    }

    const fn confirmation_field(self) -> &'static str {
        match self {
            Self::Start => "started",
            Self::Stop => "stopped",
        }
    }
}

fn channel_control_request(
    action: ChannelControlAction,
    channel: &ChannelId,
    account: &AccountId,
) -> Result<wire::RpcRequest, wire::WireError> {
    wire::operations_request(
        next_request_id("channel-control"),
        action.method(),
        json!({ "channel": channel.as_str(), "accountId": account.as_str() }),
    )
}

fn decode_confirmation(
    response: GatewayResponse,
    action: ChannelControlAction,
    expected_channel: &ChannelId,
    expected_account: &AccountId,
) -> Result<(), ()> {
    let GatewayResponse::Success {
        payload: Some(Value::Object(payload)),
        ..
    } = response
    else {
        return Err(());
    };
    (payload.len() == 3
        && payload.get("channel").and_then(Value::as_str) == Some(expected_channel.as_str())
        && payload.get("accountId").and_then(Value::as_str) == Some(expected_account.as_str())
        && payload
            .get(action.confirmation_field())
            .and_then(Value::as_bool)
            == Some(true))
    .then_some(())
    .ok_or(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn response(payload: Value) -> GatewayResponse {
        GatewayResponse::Success {
            request_id: "request".into(),
            payload: Some(payload),
        }
    }

    fn channel() -> ChannelId {
        ChannelId::try_new("whatsapp".into()).unwrap()
    }

    fn account() -> AccountId {
        AccountId::try_new("default".into()).unwrap()
    }

    #[test]
    fn start_request_uses_current_gateway_method_and_exact_account_identity() {
        let request =
            channel_control_request(ChannelControlAction::Start, &channel(), &account()).unwrap();
        let encoded: Value = serde_json::from_str(&request.encode().unwrap()).unwrap();
        assert_eq!(encoded["method"], CHANNELS_START_METHOD);
        assert_eq!(
            encoded["params"],
            json!({ "channel": "whatsapp", "accountId": "default" })
        );
    }

    #[test]
    fn confirmation_requires_the_requested_state_and_exact_identity() {
        assert!(
            decode_confirmation(
                response(json!({ "channel": "whatsapp", "accountId": "default", "started": true })),
                ChannelControlAction::Start,
                &channel(),
                &account(),
            )
            .is_ok()
        );
        assert!(
            decode_confirmation(
                response(json!({ "channel": "whatsapp", "accountId": "other", "started": true })),
                ChannelControlAction::Start,
                &channel(),
                &account(),
            )
            .is_err()
        );
        assert!(
            decode_confirmation(
                response(json!({ "channel": "whatsapp", "accountId": "default", "stopped": true })),
                ChannelControlAction::Start,
                &channel(),
                &account(),
            )
            .is_err()
        );
    }
}
