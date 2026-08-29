use serde_json::{Value, json};
use zeroize::Zeroizing;

use crate::{
    channel::catalog::{
        ChannelCatalogOutcome, ChannelConfigureFormOutcome, ChannelConfigureOutcome,
    },
    transport::authorization::CapabilityDecisionVerifier,
};

pub(crate) mod server;

const CATALOG_OPERATION: &str = "channels.catalog.read";
const CONFIG_OPERATION: &str = "channels.configure";
const CATALOG_ENDPOINT: &str = "/api/channels/catalog";
const CONFIG_ENDPOINT: &str = "/api/channels/configure";
const CATALOG_SCOPE: &str = "channels:read";
const CONFIG_SCOPE: &str = "channels:write";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

pub(crate) enum Request {
    Catalog,
    ConfigureForm {
        channel: String,
    },
    ConfigureApply {
        channel: String,
        account_id: String,
        values: Zeroizing<Vec<u8>>,
    },
}

pub(crate) fn decode(
    value: Value,
    authorization: &str,
    verifier: &mut CapabilityDecisionVerifier,
    now: u64,
) -> Result<Request, DecodeError> {
    let object = value.as_object().ok_or(DecodeError::Invalid)?;
    if object.is_empty() {
        verifier
            .verify(
                authorization,
                now,
                CATALOG_ENDPOINT,
                CATALOG_SCOPE,
                CATALOG_OPERATION,
                "channel-catalog",
            )
            .map_err(|_| DecodeError::Unauthorized)?;
        return Ok(Request::Catalog);
    }

    verifier
        .verify(
            authorization,
            now,
            CONFIG_ENDPOINT,
            CONFIG_SCOPE,
            CONFIG_OPERATION,
            "channel-configure",
        )
        .map_err(|_| DecodeError::Unauthorized)?;
    let channel = identity(object.get("channel")).ok_or(DecodeError::Invalid)?;
    match object.get("action").and_then(Value::as_str) {
        Some("form") if object.len() == 2 => Ok(Request::ConfigureForm { channel }),
        Some("apply") if object.len() == 4 => {
            let account_id = identity(object.get("accountId")).ok_or(DecodeError::Invalid)?;
            let values = object.get("values").ok_or(DecodeError::Invalid)?;
            if !values.is_object() {
                return Err(DecodeError::Invalid);
            }
            let values = serde_json::to_vec(values)
                .map(Zeroizing::new)
                .map_err(|_| DecodeError::Invalid)?;
            Ok(Request::ConfigureApply {
                channel,
                account_id,
                values,
            })
        }
        _ => Err(DecodeError::Invalid),
    }
}

fn identity(value: Option<&Value>) -> Option<String> {
    let value = value?.as_str()?;
    (valid_identifier(value)).then(|| value.to_owned())
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
        })
}

pub(crate) enum Delivery {
    Catalog(ChannelCatalogOutcome),
    ConfigureForm(ChannelConfigureFormOutcome),
    Configure(ChannelConfigureOutcome),
    Unavailable,
}

impl Delivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Catalog(ChannelCatalogOutcome::Catalog(_))
            | Self::ConfigureForm(ChannelConfigureFormOutcome::Form(_))
            | Self::Configure(
                ChannelConfigureOutcome::Confirmed
                | ChannelConfigureOutcome::TargetRejected
                | ChannelConfigureOutcome::Unknown,
            ) => 200,
            Self::Catalog(_)
            | Self::ConfigureForm(ChannelConfigureFormOutcome::Unknown)
            | Self::Unavailable => 503,
            Self::ConfigureForm(ChannelConfigureFormOutcome::TargetRejected) => 400,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Catalog(ChannelCatalogOutcome::Catalog(catalog)) => {
                serde_json::to_value(catalog).expect("catalog serializable")
            }
            Self::ConfigureForm(ChannelConfigureFormOutcome::Form(form)) => {
                serde_json::to_value(form).expect("channel configure form serializable")
            }
            Self::ConfigureForm(ChannelConfigureFormOutcome::TargetRejected) => {
                json!({"outcome": "rejected"})
            }
            Self::ConfigureForm(ChannelConfigureFormOutcome::Unknown) => {
                json!({"outcome": "unknown"})
            }
            Self::Configure(outcome) => json!({
                "outcome": outcome,
            }),
            Self::Catalog(ChannelCatalogOutcome::Rejected) => {
                json!({"success": false, "error": "Channel catalog was rejected"})
            }
            Self::Catalog(ChannelCatalogOutcome::Unknown) | Self::Unavailable => {
                json!({"success": false, "error": "Channel catalog is unavailable"})
            }
        }
    }
}
