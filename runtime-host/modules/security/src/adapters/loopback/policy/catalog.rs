use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SecurityRuleCatalogPlatform {
    Universal,
    Linux,
    Windows,
    Macos,
    Powershell,
}

impl SecurityRuleCatalogPlatform {
    fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "universal" => Some(Self::Universal),
            "linux" => Some(Self::Linux),
            "windows" => Some(Self::Windows),
            "macos" => Some(Self::Macos),
            "powershell" => Some(Self::Powershell),
            _ => None,
        }
    }

    fn is_selected(self, selected: Self) -> bool {
        self == Self::Universal || self == selected
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SecurityRuleCatalogCategory {
    FileDelete,
    GitDestructive,
    SqlDestructive,
    SystemDestructive,
    ProcessKill,
    NetworkDestructive,
    PrivilegeEscalation,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SecurityRuleCatalogSeverity {
    Critical,
    High,
    Medium,
    Low,
    Info,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct SecurityRuleCatalogItem {
    pub platform: SecurityRuleCatalogPlatform,
    pub command: &'static str,
    pub category: SecurityRuleCatalogCategory,
    pub severity: SecurityRuleCatalogSeverity,
    pub reason: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct SecurityRuleCatalogResponse {
    pub success: bool,
    pub total: usize,
    pub items: Vec<SecurityRuleCatalogItem>,
}

const SECURITY_RULE_CATALOG: [SecurityRuleCatalogItem; 22] = [
    SecurityRuleCatalogItem {
        platform: SecurityRuleCatalogPlatform::Universal,
        command: "rm -rf <系统路径>",
        category: SecurityRuleCatalogCategory::FileDelete,
        severity: SecurityRuleCatalogSeverity::Critical,
        reason: "递归强删目录树",
    },
    SecurityRuleCatalogItem {
        platform: SecurityRuleCatalogPlatform::Universal,
        command: "git reset --hard",
        category: SecurityRuleCatalogCategory::GitDestructive,
        severity: SecurityRuleCatalogSeverity::Critical,
        reason: "强制/递归删除文件",
    },
    SecurityRuleCatalogItem {
        platform: SecurityRuleCatalogPlatform::Linux,
        command: "systemctl disable <关键服务 critical>",
        category: SecurityRuleCatalogCategory::SystemDestructive,
        severity: SecurityRuleCatalogSeverity::Critical,
        reason: "系统服务停用（关键服务为 critical）",
    },
    SecurityRuleCatalogItem {
        platform: SecurityRuleCatalogPlatform::Linux,
        command: "service <service> stop",
        category: SecurityRuleCatalogCategory::SystemDestructive,
        severity: SecurityRuleCatalogSeverity::High,
        reason: "服务停用/删除",
    },
    SecurityRuleCatalogItem {
        platform: SecurityRuleCatalogPlatform::Linux,
        command: "ip route flush table main（flush 为 critical）",
        category: SecurityRuleCatalogCategory::NetworkDestructive,
        severity: SecurityRuleCatalogSeverity::Critical,
        reason: "路由表变更（flush 为 critical）",
    },
    SecurityRuleCatalogItem {
        platform: SecurityRuleCatalogPlatform::Windows,
        command: "rmdir /s /q C:\\temp\\demo",
        category: SecurityRuleCatalogCategory::FileDelete,
        severity: SecurityRuleCatalogSeverity::Critical,
        reason: "递归删除目录树",
    },
    SecurityRuleCatalogItem {
        platform: SecurityRuleCatalogPlatform::Windows,
        command: "del /f /s <系统路径>",
        category: SecurityRuleCatalogCategory::FileDelete,
        severity: SecurityRuleCatalogSeverity::High,
        reason: "强制/递归删除文件",
    },
    SecurityRuleCatalogItem {
        platform: SecurityRuleCatalogPlatform::Windows,
        command: "taskkill /f /pid 1234",
        category: SecurityRuleCatalogCategory::ProcessKill,
        severity: SecurityRuleCatalogSeverity::High,
        reason: "终止进程（/f 提升风险）",
    },
    SecurityRuleCatalogItem {
        platform: SecurityRuleCatalogPlatform::Windows,
        command: "reg delete HKLM\\Software\\Demo /f",
        category: SecurityRuleCatalogCategory::SystemDestructive,
        severity: SecurityRuleCatalogSeverity::Critical,
        reason: "删除注册表键值",
    },
    SecurityRuleCatalogItem {
        platform: SecurityRuleCatalogPlatform::Windows,
        command: "diskpart clean",
        category: SecurityRuleCatalogCategory::SystemDestructive,
        severity: SecurityRuleCatalogSeverity::Critical,
        reason: "磁盘分区破坏",
    },
    SecurityRuleCatalogItem {
        platform: SecurityRuleCatalogPlatform::Windows,
        command: "netsh advfirewall reset",
        category: SecurityRuleCatalogCategory::NetworkDestructive,
        severity: SecurityRuleCatalogSeverity::Critical,
        reason: "防火墙重置",
    },
    SecurityRuleCatalogItem {
        platform: SecurityRuleCatalogPlatform::Windows,
        command: "route delete 0.0.0.0",
        category: SecurityRuleCatalogCategory::NetworkDestructive,
        severity: SecurityRuleCatalogSeverity::High,
        reason: "路由表变更",
    },
    SecurityRuleCatalogItem {
        platform: SecurityRuleCatalogPlatform::Powershell,
        command: "Remove-Item C:\\temp\\x -Recurse -Force",
        category: SecurityRuleCatalogCategory::FileDelete,
        severity: SecurityRuleCatalogSeverity::Critical,
        reason: "递归强删目录树",
    },
    SecurityRuleCatalogItem {
        platform: SecurityRuleCatalogPlatform::Powershell,
        command: "Remove-NetFirewallRule -DisplayName DemoRule",
        category: SecurityRuleCatalogCategory::NetworkDestructive,
        severity: SecurityRuleCatalogSeverity::High,
        reason: "防火墙规则变更",
    },
    SecurityRuleCatalogItem {
        platform: SecurityRuleCatalogPlatform::Powershell,
        command: "Stop-Process -Id 1234 -Force",
        category: SecurityRuleCatalogCategory::ProcessKill,
        severity: SecurityRuleCatalogSeverity::High,
        reason: "强制终止进程",
    },
    SecurityRuleCatalogItem {
        platform: SecurityRuleCatalogPlatform::Powershell,
        command: "Set-Acl -Path <系统路径> -AclObject <acl>",
        category: SecurityRuleCatalogCategory::PrivilegeEscalation,
        severity: SecurityRuleCatalogSeverity::High,
        reason: "递归 ACL 改动",
    },
    SecurityRuleCatalogItem {
        platform: SecurityRuleCatalogPlatform::Macos,
        command: "diskutil eraseDisk APFS Demo /dev/disk3",
        category: SecurityRuleCatalogCategory::SystemDestructive,
        severity: SecurityRuleCatalogSeverity::Critical,
        reason: "磁盘抹除/重分区",
    },
    SecurityRuleCatalogItem {
        platform: SecurityRuleCatalogPlatform::Macos,
        command: "launchctl bootout system/com.apple.sshd",
        category: SecurityRuleCatalogCategory::SystemDestructive,
        severity: SecurityRuleCatalogSeverity::High,
        reason: "系统/用户服务停用",
    },
    SecurityRuleCatalogItem {
        platform: SecurityRuleCatalogPlatform::Macos,
        command: "csrutil disable",
        category: SecurityRuleCatalogCategory::PrivilegeEscalation,
        severity: SecurityRuleCatalogSeverity::Critical,
        reason: "关闭 SIP 保护",
    },
    SecurityRuleCatalogItem {
        platform: SecurityRuleCatalogPlatform::Macos,
        command: "pfctl -e / pfctl -d",
        category: SecurityRuleCatalogCategory::NetworkDestructive,
        severity: SecurityRuleCatalogSeverity::High,
        reason: "启停 PF 规则",
    },
    SecurityRuleCatalogItem {
        platform: SecurityRuleCatalogPlatform::Macos,
        command: "pfctl -f /etc/pf.conf",
        category: SecurityRuleCatalogCategory::NetworkDestructive,
        severity: SecurityRuleCatalogSeverity::Critical,
        reason: "重载 PF 规则文件",
    },
    SecurityRuleCatalogItem {
        platform: SecurityRuleCatalogPlatform::Macos,
        command: "route delete default",
        category: SecurityRuleCatalogCategory::NetworkDestructive,
        severity: SecurityRuleCatalogSeverity::High,
        reason: "路由表变更",
    },
];

pub fn list_security_rule_catalog(platform: Option<&str>) -> SecurityRuleCatalogResponse {
    let selected = platform.and_then(SecurityRuleCatalogPlatform::parse);
    let items = SECURITY_RULE_CATALOG
        .iter()
        .copied()
        .filter(|item| selected.is_none_or(|selected| item.platform.is_selected(selected)))
        .collect::<Vec<_>>();
    SecurityRuleCatalogResponse {
        success: true,
        total: items.len(),
        items,
    }
}

use serde_json::{Value, json};

use super::CATALOG_ENDPOINT;

pub fn response_body(platform: Option<&str>) -> Value {
    let catalog = list_security_rule_catalog(platform);
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

pub fn parse_target(path: &str) -> Option<Option<String>> {
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
