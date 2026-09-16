use openclaw::projection::security::rule_catalog::{
    SecurityRuleCatalogCategory, SecurityRuleCatalogItem, SecurityRuleCatalogPlatform,
    SecurityRuleCatalogSeverity,
};
use serde_json::{Value, json};

use super::CATALOG_ENDPOINT;

pub(crate) fn response_body(platform: Option<&str>) -> Value {
    let catalog =
        openclaw::projection::security::rule_catalog::list_security_rule_catalog(platform);
    json!({
        "success": catalog.success,
        "total": catalog.total,
        "items": catalog.items.iter().map(rule_item_json).collect::<Vec<_>>(),
    })
}

fn rule_item_json(item: &SecurityRuleCatalogItem) -> Value {
    json!({
        "platform": rule_platform_code(item.platform),
        "command": item.command,
        "category": rule_category_code(item.category),
        "severity": rule_severity_code(item.severity),
        "reason": item.reason,
    })
}

fn rule_platform_code(platform: SecurityRuleCatalogPlatform) -> &'static str {
    match platform {
        SecurityRuleCatalogPlatform::Universal => "universal",
        SecurityRuleCatalogPlatform::Linux => "linux",
        SecurityRuleCatalogPlatform::Windows => "windows",
        SecurityRuleCatalogPlatform::Macos => "macos",
        SecurityRuleCatalogPlatform::Powershell => "powershell",
    }
}

fn rule_category_code(category: SecurityRuleCatalogCategory) -> &'static str {
    match category {
        SecurityRuleCatalogCategory::FileDelete => "file_delete",
        SecurityRuleCatalogCategory::GitDestructive => "git_destructive",
        SecurityRuleCatalogCategory::SqlDestructive => "sql_destructive",
        SecurityRuleCatalogCategory::SystemDestructive => "system_destructive",
        SecurityRuleCatalogCategory::ProcessKill => "process_kill",
        SecurityRuleCatalogCategory::NetworkDestructive => "network_destructive",
        SecurityRuleCatalogCategory::PrivilegeEscalation => "privilege_escalation",
    }
}

fn rule_severity_code(severity: SecurityRuleCatalogSeverity) -> &'static str {
    match severity {
        SecurityRuleCatalogSeverity::Critical => "critical",
        SecurityRuleCatalogSeverity::High => "high",
        SecurityRuleCatalogSeverity::Medium => "medium",
        SecurityRuleCatalogSeverity::Low => "low",
        SecurityRuleCatalogSeverity::Info => "info",
    }
}

pub(crate) fn parse_target(path: &str) -> Option<Option<String>> {
    let (pathname, query) = match path.split_once('?') {
        Some((pathname, query)) => (pathname, Some(query)),
        None => (path, None),
    };
    if pathname != CATALOG_ENDPOINT {
        return None;
    }
    Some(query.and_then(|query| {
        query.split('&').find_map(|pair| {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            (decode_query_component(name) == "platform").then(|| decode_query_component(value))
        })
    }))
}

fn decode_query_component(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'+' {
            decoded.push(b' ');
            index += 1;
        } else if byte == b'%'
            && index + 2 < bytes.len()
            && let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
        {
            decoded.push(high << 4 | low);
            index += 3;
        } else {
            decoded.push(byte);
            index += 1;
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_target, response_body};

    #[test]
    fn query_keeps_the_historical_platform_reading_semantics() {
        assert_eq!(
            parse_target("/api/security/destructive-rule-catalog/current"),
            Some(None)
        );
        assert_eq!(
            parse_target("/api/security/destructive-rule-catalog/current?platform=windows"),
            Some(Some("windows".into()))
        );
        assert_eq!(
            parse_target(
                "/api/security/destructive-rule-catalog/current?ignored=true&platform=PowerShell"
            ),
            Some(Some("PowerShell".into()))
        );
        assert_eq!(
            parse_target(
                "/api/security/destructive-rule-catalog/current?platform=windows&platform=linux"
            ),
            Some(Some("windows".into()))
        );
        assert_eq!(
            parse_target("/api/security/destructive-rule-catalog/current?platform=windows%20"),
            Some(Some("windows ".into()))
        );
        assert_eq!(parse_target("/api/security/audit"), None);
    }

    #[test]
    fn response_is_complete_and_excludes_policy_or_recovery_state() {
        let body = response_body(Some("windows"));
        assert_eq!(body["success"], true);
        assert_eq!(body["total"], 9);
        assert_eq!(body["items"].as_array().map(Vec::len), Some(9));

        let encoded = body.to_string();
        for private_or_unrelated in [
            "securityPolicyVersion",
            "revision",
            "outcome",
            "recovery",
            "secret",
            "path",
            "evidence",
        ] {
            assert!(!encoded.contains(private_or_unrelated));
        }
    }
}
