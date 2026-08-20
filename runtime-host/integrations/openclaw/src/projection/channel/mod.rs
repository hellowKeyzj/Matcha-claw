use serde_json::{Map, Value};

use super::config_store::OpenClawConfigDocument;

pub(crate) fn configured_plugin_ids(document: &OpenClawConfigDocument) -> Vec<String> {
    let Some(channels) = document.get("channels").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut plugin_ids = channels
        .iter()
        .filter_map(|(channel_type, section)| {
            let section = section.as_object()?;
            if !channel_is_configured(channel_type, section) {
                return None;
            }
            channel_plugin_id(channel_type).map(str::to_owned)
        })
        .collect::<Vec<_>>();
    plugin_ids.sort();
    plugin_ids.dedup();
    plugin_ids
}

fn channel_plugin_id(channel_type: &str) -> Option<&'static str> {
    match channel_type {
        "dingtalk" => Some("dingtalk"),
        "feishu" => Some("openclaw-lark"),
        "wecom" => Some("wecom"),
        "qqbot" => Some("openclaw-qqbot"),
        "wechat" | "openclaw-weixin" => Some("openclaw-weixin"),
        "discord" => Some("discord"),
        "whatsapp" => Some("whatsapp"),
        _ => None,
    }
}

fn channel_is_configured(channel_type: &str, section: &Map<String, Value>) -> bool {
    if section.get("enabled").is_some_and(|value| value == false) {
        return false;
    }
    if channel_type == "feishu" && nonblank_scalar(section.get("appId")) {
        return true;
    }
    let accounts = section.get("accounts").and_then(Value::as_object);
    if channel_type == "dingtalk" && accounts.is_none() {
        return section
            .iter()
            .filter(|(key, _)| key.as_str() != "enabled" && key.as_str() != "updatedAt")
            .any(|(_, value)| nonblank_scalar(Some(value)));
    }
    accounts.is_some_and(has_configured_account)
}

fn has_configured_account(accounts: &Map<String, Value>) -> bool {
    accounts.iter().any(|(account_id, value)| {
        !account_id.trim().is_empty()
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::config_store::OpenClawConfigDocument;
    use super::configured_plugin_ids;

    #[test]
    fn maps_only_configured_external_channels_to_canonical_plugins() {
        let mut document = OpenClawConfigDocument::empty();
        document.insert(
            "channels".into(),
            json!({
                "feishu": {"appId": "app-id"},
                "discord": {"accounts": {"primary": {"enabled": true}}},
                "telegram": {"accounts": {"primary": {"enabled": true}}},
                "whatsapp": {"enabled": false, "accounts": {"primary": {}}}
            }),
        );

        assert_eq!(
            configured_plugin_ids(&document),
            vec!["discord", "openclaw-lark"]
        );
    }

    #[test]
    fn supports_dingtalk_legacy_top_level_configuration() {
        let mut document = OpenClawConfigDocument::empty();
        document.insert(
            "channels".into(),
            json!({"dingtalk": {"clientId": "client-id"}}),
        );

        assert_eq!(configured_plugin_ids(&document), vec!["dingtalk"]);
    }

    #[test]
    fn normalizes_wechat_to_the_openclaw_plugin_id() {
        let mut document = OpenClawConfigDocument::empty();
        document.insert(
            "channels".into(),
            json!({"wechat": {"accounts": {"primary": {}}}}),
        );

        assert_eq!(configured_plugin_ids(&document), vec!["openclaw-weixin"]);
    }
}
