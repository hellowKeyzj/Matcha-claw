use std::{fmt, str};

use serde_json::{Map, Value};

use platform::state_dir::CanonicalStateDir;

const CANONICAL_CONFIG_FILE: &str = "openclaw.json";
const CONFIG_LIMIT_BYTES: usize = 1024 * 1024;

pub(super) fn skip_channels(state_dir: &CanonicalStateDir) -> Result<bool, ChannelBootstrapError> {
    let state_dir = state_dir
        .open()
        .map_err(|_| ChannelBootstrapError::StateDirectoryUnavailable)?;
    let Some(contents) = state_dir
        .read_regular_file_bounded(CANONICAL_CONFIG_FILE, CONFIG_LIMIT_BYTES)
        .map_err(|_| ChannelBootstrapError::ConfigReadFailed)?
    else {
        return Ok(true);
    };
    let root = parse_config(&contents)?;
    let root = root
        .as_object()
        .ok_or(ChannelBootstrapError::RootNotObject)?;
    Ok(!has_configured_channel(root))
}

fn parse_config(contents: &[u8]) -> Result<Value, ChannelBootstrapError> {
    let contents = str::from_utf8(contents).map_err(|_| ChannelBootstrapError::InvalidJson5)?;
    json5::from_str(contents).map_err(|_| ChannelBootstrapError::InvalidJson5)
}

fn has_configured_channel(root: &Map<String, Value>) -> bool {
    let Some(channels) = root.get("channels").and_then(Value::as_object) else {
        return false;
    };
    channels.iter().any(|(id, section)| {
        let Some(section) = section.as_object() else {
            return false;
        };
        if section.get("enabled").is_some_and(|value| value == false) {
            return false;
        }
        if id == "feishu" && nonblank_scalar(section.get("appId")) {
            return true;
        }
        let accounts = section.get("accounts").and_then(Value::as_object);
        if id == "dingtalk" && accounts.is_none() {
            return section
                .iter()
                .filter(|(key, _)| key.as_str() != "enabled" && key.as_str() != "updatedAt")
                .any(|(_, value)| nonblank_scalar(Some(value)));
        }
        accounts.is_some_and(has_configured_account)
    })
}

fn has_configured_account(accounts: &Map<String, Value>) -> bool {
    accounts.iter().any(|(key, value)| {
        !key.trim().is_empty()
            && value.as_object().is_none_or(|account| {
                account
                    .get("enabled")
                    .is_none_or(|enabled| enabled != false)
            })
    })
}

fn nonblank_scalar(value: Option<&Value>) -> bool {
    match value {
        Some(Value::String(value)) => !value.trim().is_empty(),
        Some(Value::Number(value)) => !value.to_string().trim().is_empty(),
        Some(Value::Bool(value)) => !value.to_string().trim().is_empty(),
        _ => false,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ChannelBootstrapError {
    StateDirectoryUnavailable,
    ConfigReadFailed,
    InvalidJson5,
    RootNotObject,
}

impl fmt::Display for ChannelBootstrapError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::StateDirectoryUnavailable => "OpenClaw state directory is unavailable",
            Self::ConfigReadFailed => "OpenClaw channel configuration could not be read",
            Self::InvalidJson5 => "OpenClaw channel configuration is not valid JSON5",
            Self::RootNotObject => "OpenClaw channel configuration root must be an object",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for ChannelBootstrapError {}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn parses_openclaw_json5_channel_configuration() {
        let config = br#"
            // OpenClaw config permits JSON5.
            {
                channels: {
                    telegram: {
                        accounts: {
                            primary: { enabled: true, },
                        },
                    },
                },
            }
        "#;

        let root = parse_config(config).expect("JSON5 channel config should parse");
        assert!(has_configured_channel(root.as_object().unwrap()));
    }

    #[test]
    fn rejects_invalid_json5_without_source_content() {
        let error =
            parse_config(br#"{ channels: "#).expect_err("unterminated JSON5 object must fail");

        assert_eq!(error, ChannelBootstrapError::InvalidJson5);
        assert!(!error.to_string().contains("channels"));
    }

    #[test]
    fn rejects_non_utf8_config_as_invalid_json5() {
        let error = parse_config(&[0xff]).expect_err("non-UTF-8 config must fail");

        assert_eq!(error, ChannelBootstrapError::InvalidJson5);
    }

    #[test]
    fn rejects_non_object_root() {
        let root = parse_config(br#"["secret-value"]"#).expect("valid JSON5 array");
        let error = root
            .as_object()
            .ok_or(ChannelBootstrapError::RootNotObject)
            .expect_err("config root must be an object");

        assert_eq!(error, ChannelBootstrapError::RootNotObject);
        assert!(!error.to_string().contains("secret-value"));
    }

    #[test]
    fn derives_configured_channels_from_the_product_predicate() {
        for (value, configured) in [
            (json!({}), false),
            (json!({"channels": []}), false),
            (json!({"channels": {"telegram": null}}), false),
            (
                json!({"channels": {"telegram": {"enabled": false, "accounts": {"main": {}}}}}),
                false,
            ),
            (json!({"channels": {"feishu": {"appId": " app-id "}}}), true),
            (json!({"channels": {"feishu": {"appId": "  "}}}), false),
            (
                json!({"channels": {"dingtalk": {"clientId": "client-id"}}}),
                true,
            ),
            (
                json!({"channels": {"dingtalk": {"enabled": true, "updatedAt": "now"}}}),
                false,
            ),
            (
                json!({"channels": {"dingtalk": {"accounts": {"main": {"enabled": false}}}}}),
                false,
            ),
            (
                json!({"channels": {"telegram": {"accounts": {" ": {}, "main": {"enabled": false}, "alt": "configured"}}}}),
                true,
            ),
            (
                json!({"channels": {"telegram": {"accounts": {"main": {"enabled": false}}}}}),
                false,
            ),
        ] {
            let root = value.as_object().unwrap();
            assert_eq!(has_configured_channel(root), configured, "{value}");
        }
    }
}
