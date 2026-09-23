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

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    #[test]
    fn lists_the_closed_catalog_without_private_findings() {
        let response = list_security_rule_catalog(None);
        assert!(response.success);
        assert_eq!(response.total, 22);
        assert_eq!(response.items.len(), response.total);

        let encoded = serde_json::to_value(response).expect("catalog serializes");
        for item in encoded["items"].as_array().expect("items array") {
            let object = item.as_object().expect("catalog item object");
            assert_eq!(object.len(), 5);
            for field in ["category", "command", "platform", "reason", "severity"] {
                assert!(object.contains_key(field));
            }
            assert!(item.get("path").is_none());
            assert!(item.get("secret").is_none());
            assert!(item.get("evidence").is_none());
        }
        assert!(!encoded.to_string().contains("nativeDetail"));
        assert!(!encoded.to_string().contains("evidenceDir"));
    }

    #[test]
    fn filters_universal_rules_into_each_normalized_platform() {
        assert_eq!(list_security_rule_catalog(Some(" WINDOWS ")).total, 9);
        assert_eq!(list_security_rule_catalog(Some("linux")).total, 5);
        assert_eq!(list_security_rule_catalog(Some("PowerShell")).total, 6);
        assert_eq!(list_security_rule_catalog(Some("macOS")).total, 8);
        assert!(
            list_security_rule_catalog(Some("windows"))
                .items
                .iter()
                .all(|item| matches!(
                    item.platform,
                    SecurityRuleCatalogPlatform::Universal | SecurityRuleCatalogPlatform::Windows
                ))
        );
    }

    #[test]
    fn invalid_platform_preserves_the_historical_unfiltered_snapshot() {
        assert_eq!(
            list_security_rule_catalog(Some("unknown")).total,
            list_security_rule_catalog(None).total
        );
        assert_eq!(
            list_security_rule_catalog(Some("\nsecret")).total,
            list_security_rule_catalog(None).total
        );
    }

    #[test]
    fn serializes_the_public_field_vocabulary() {
        let response = serde_json::to_value(list_security_rule_catalog(Some("windows")))
            .expect("catalog serializes");
        assert_eq!(response["success"], Value::Bool(true));
        assert_eq!(
            response["items"][0]["platform"],
            Value::String("universal".into())
        );
        assert_eq!(
            response["items"][0]["category"],
            Value::String("file_delete".into())
        );
        assert_eq!(
            response["items"][0]["severity"],
            Value::String("critical".into())
        );
    }
}
