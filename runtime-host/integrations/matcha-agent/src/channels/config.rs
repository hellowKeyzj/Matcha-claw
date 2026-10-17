use std::collections::BTreeMap;

use channels_module::{
    catalog::{
        ChannelCatalog, ChannelCatalogEntry, ChannelCatalogOutcome, ChannelConfigureField,
        ChannelConfigureFieldKind, ChannelConfigureForm, ChannelConfigureFormOutcome,
        ChannelConfigureOutcome,
    },
    config_read,
};
use serde_json::{Value, json};
use zeroize::Zeroizing;

use super::{CHANNEL, Channels, Failure, SOURCE, failure};

pub(super) fn form(channel: &str) -> ChannelConfigureFormOutcome {
    if channel != CHANNEL {
        return ChannelConfigureFormOutcome::TargetRejected;
    }
    ChannelConfigureFormOutcome::Form(ChannelConfigureForm { fields: vec![
        ChannelConfigureField { key: "sessionId".into(), label: "Session ID".into(), description: Some("Explicit Server session owned by the selected Agent; configuration applies at its next native launch".into()), kind: ChannelConfigureFieldKind::Text, required: true, options: None },
        ChannelConfigureField { key: "enabled".into(), label: "Enable on next session launch".into(), description: Some("Does not establish an online or healthy connection".into()), kind: ChannelConfigureFieldKind::Boolean, required: false, options: None },
    ] })
}

impl Channels {
    pub(super) async fn catalog(&self) -> ChannelCatalogOutcome {
        match self.bindings().await {
            Ok(bindings) => ChannelCatalogOutcome::Catalog(ChannelCatalog {
                entries: vec![ChannelCatalogEntry {
                    id: CHANNEL.into(),
                    label: "WeChat".into(),
                    detail_label:
                        "Native WeChat · one account per Agent · explicit session consumer".into(),
                    system_image: None,
                    configured: !bindings.is_empty(),
                }],
            }),
            Err(Failure::Rejected) => ChannelCatalogOutcome::Rejected,
            Err(Failure::Unknown) => ChannelCatalogOutcome::Unknown,
        }
    }

    pub(super) async fn read_config(
        &self,
        channel: String,
        account: Option<String>,
    ) -> config_read::Outcome {
        let binding = match self.binding(&channel, account.as_deref()).await {
            Ok(binding) => binding,
            Err(Failure::Rejected) => return config_read::Outcome::TargetRejected,
            Err(Failure::Unknown) => return config_read::Outcome::Unknown,
        };
        let mut values = BTreeMap::from([
            ("enabled".into(), binding.definition.enabled.to_string()),
            ("application".into(), "nextSessionLaunch".into()),
        ]);
        if let Some(session) = binding.definition.session_id {
            values.insert("sessionId".into(), session);
        }
        match config_read::Projection::from_matcha_source(values, binding.definition.agent_id) {
            Ok(values) => config_read::Outcome::Values(values),
            Err(()) => config_read::Outcome::Unknown,
        }
    }

    pub(super) async fn configure(
        &self,
        channel: String,
        account: String,
        agent_id: Option<String>,
        bytes: Zeroizing<Vec<u8>>,
    ) -> ChannelConfigureOutcome {
        if channel != CHANNEL || !valid_id(&account) {
            return ChannelConfigureOutcome::TargetRejected;
        }
        let values = match channels_module::catalog::parse_patch(bytes) {
            Ok(values)
                if values
                    .keys()
                    .all(|key| matches!(key.as_str(), "enabled" | "sessionId" | "application"))
                    && values
                        .get("application")
                        .is_none_or(|value| value == "nextSessionLaunch") =>
            {
                values
            }
            _ => return ChannelConfigureOutcome::TargetRejected,
        };
        let bindings = match self.bindings().await {
            Ok(bindings) => bindings,
            Err(Failure::Rejected) => return ChannelConfigureOutcome::TargetRejected,
            Err(Failure::Unknown) => return ChannelConfigureOutcome::Unknown,
        };
        let previous = bindings.iter().find(|binding| binding.id == account);
        let Some(agent_id) =
            agent_id.or_else(|| previous.map(|binding| binding.definition.agent_id.clone()))
        else {
            return ChannelConfigureOutcome::TargetRejected;
        };
        if !config_read::valid_matcha_agent_id(&agent_id) {
            return ChannelConfigureOutcome::TargetRejected;
        }
        let enabled = match values.get("enabled") {
            Some(Value::Bool(enabled)) => *enabled,
            Some(Value::String(value)) if value == "true" || value == "false" => value == "true",
            None => previous.is_some_and(|binding| binding.definition.enabled),
            _ => return ChannelConfigureOutcome::TargetRejected,
        };
        let session_id = match values.get("sessionId") {
            Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
            Some(Value::Null) => None,
            None => previous.and_then(|binding| binding.definition.session_id.clone()),
            _ => return ChannelConfigureOutcome::TargetRejected,
        };
        // No synthetic default Agent/session and no multi-account native projection.
        if bindings
            .iter()
            .any(|binding| binding.id != account && binding.definition.agent_id == agent_id)
        {
            return ChannelConfigureOutcome::TargetRejected;
        }
        let expected =
            json!({"agentId":agent_id,"enabled":enabled,"source":SOURCE,"sessionId":session_id});
        let result = self.client.call("channels.configure", json!({"id":account,"agentId":agent_id,"enabled":enabled,"source":SOURCE,"sessionId":session_id})).await;
        match result {
            Ok(value) if definition_matches(value.get("definition"), &expected) => {
                ChannelConfigureOutcome::Confirmed
            }
            Err(error) if matches!(failure(&error), Failure::Rejected) => {
                ChannelConfigureOutcome::TargetRejected
            }
            _ => ChannelConfigureOutcome::Unknown,
        }
    }
}

fn definition_matches(actual: Option<&Value>, expected: &Value) -> bool {
    actual.is_some_and(|actual| {
        ["agentId", "enabled", "source", "sessionId"]
            .iter()
            .all(|key| {
                actual.get(*key).unwrap_or(&Value::Null)
                    == expected.get(*key).unwrap_or(&Value::Null)
            })
    })
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}
