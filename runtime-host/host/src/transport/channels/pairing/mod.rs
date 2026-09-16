use serde_json::{Value, json};
use zeroize::Zeroizing;

use crate::{
    channel::status::{ChannelPairingList, ChannelPairingOutcome},
    transport::common::authorization::CapabilityDecisionVerifier,
};

pub(crate) mod server;

const LIST_OPERATION_ID: &str = "channels.pairing.list";
const APPROVE_OPERATION_ID: &str = "channels.pairing.approve";
const AUTHORIZATION_ENDPOINT: &str = "/api/channels/pairing";
const LIST_AUTHORIZATION_SCOPE: &str = "channels:read";
const APPROVE_AUTHORIZATION_SCOPE: &str = "channels:write";
const AUTHORIZATION_SUBJECT: &str = "channel-pairing";
const MAX_CODE_BYTES: usize = 128;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

pub(crate) fn decode_list(
    value: Value,
    authorization: &str,
    verifier: &mut CapabilityDecisionVerifier,
    now: u64,
) -> Result<(String, Option<String>), DecodeError> {
    let mut span = crate::channel::trace::ChannelTraceSpan::begin(
        "host.transport.channel_pairing.decode_list",
    );
    let result = (|| {
        verifier
            .verify(
                authorization,
                now,
                AUTHORIZATION_ENDPOINT,
                LIST_AUTHORIZATION_SCOPE,
                LIST_OPERATION_ID,
                AUTHORIZATION_SUBJECT,
            )
            .map_err(|_| DecodeError::Unauthorized)?;
        let Value::Object(body) = value else {
            return Err(DecodeError::Invalid);
        };
        if !(body.len() == 1 || body.len() == 2)
            || body
                .keys()
                .any(|key| key != "channel" && key != "accountId")
        {
            return Err(DecodeError::Invalid);
        }
        let channel = identity(body.get("channel")).ok_or(DecodeError::Invalid)?;
        let account = body
            .get("accountId")
            .map(|value| identity(Some(value)).ok_or(DecodeError::Invalid))
            .transpose()?;
        Ok((channel, account))
    })();
    span.finish(match &result {
        Ok(_) => "decoded",
        Err(DecodeError::Unauthorized) => "unauthorized",
        Err(DecodeError::Invalid) => "invalid",
    });
    result
}

pub(crate) struct ApprovalRequest {
    pub(crate) channel: String,
    pub(crate) account: Option<String>,
    pub(crate) code: Zeroizing<Vec<u8>>,
}

pub(crate) fn decode_approval(
    value: Value,
    authorization: &str,
    verifier: &mut CapabilityDecisionVerifier,
    now: u64,
) -> Result<ApprovalRequest, DecodeError> {
    let mut span = crate::channel::trace::ChannelTraceSpan::begin(
        "host.transport.channel_pairing.decode_approval",
    );
    let result = (|| {
        verifier
            .verify(
                authorization,
                now,
                AUTHORIZATION_ENDPOINT,
                APPROVE_AUTHORIZATION_SCOPE,
                APPROVE_OPERATION_ID,
                AUTHORIZATION_SUBJECT,
            )
            .map_err(|_| DecodeError::Unauthorized)?;
        let Value::Object(mut body) = value else {
            return Err(DecodeError::Invalid);
        };
        if !(body.len() == 3 || body.len() == 4)
            || body
                .remove("action")
                .and_then(|value| value.as_str().map(str::to_owned))
                .as_deref()
                != Some("approve")
            || !body.contains_key("channel")
            || !body.contains_key("code")
            || body
                .keys()
                .any(|key| key != "channel" && key != "accountId" && key != "code")
        {
            return Err(DecodeError::Invalid);
        }
        let channel = identity(body.get("channel")).ok_or(DecodeError::Invalid)?;
        let account = body
            .get("accountId")
            .map(|value| identity(Some(value)).ok_or(DecodeError::Invalid))
            .transpose()?;
        let code = body
            .get("code")
            .and_then(Value::as_str)
            .filter(|code| {
                !code.is_empty()
                    && code.len() <= MAX_CODE_BYTES
                    && code.bytes().all(|byte| byte.is_ascii_alphanumeric())
            })
            .map(|code| Zeroizing::new(code.as_bytes().to_vec()))
            .ok_or(DecodeError::Invalid)?;
        Ok(ApprovalRequest {
            channel,
            account,
            code,
        })
    })();
    span.finish(match &result {
        Ok(_) => "decoded",
        Err(DecodeError::Unauthorized) => "unauthorized",
        Err(DecodeError::Invalid) => "invalid",
    });
    result
}

fn identity(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 128
                && value
                    .chars()
                    .all(|character| !character.is_control() && !character.is_whitespace())
        })
        .map(str::to_owned)
}

pub(crate) enum ChannelPairingDelivery {
    Ok(ChannelPairingList),
    Rejected,
    Unavailable,
}

impl ChannelPairingDelivery {
    pub(crate) fn from_outcome(outcome: ChannelPairingOutcome) -> Self {
        match outcome {
            ChannelPairingOutcome::Listed(requests) => Self::Ok(ChannelPairingList::new(requests)),
            ChannelPairingOutcome::Rejected => Self::Rejected,
            ChannelPairingOutcome::OutcomeUnknown => Self::Unavailable,
        }
    }
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Ok(_) => 200,
            Self::Rejected => 400,
            Self::Unavailable => 503,
        }
    }
    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Ok(outcome) => serde_json::to_value(outcome)
                .expect("Channel pairing public response is serializable"),
            Self::Rejected => {
                json!({"success": false, "error": "Channel pairing request is rejected"})
            }
            Self::Unavailable => {
                json!({"success": false, "error": "Channel pairing is unavailable"})
            }
        }
    }
}
