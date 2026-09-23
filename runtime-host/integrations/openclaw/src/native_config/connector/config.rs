use platform::state_dir::CanonicalStateDir;
use serde::Serialize;
use serde_json::Value;

use crate::native_config::config_store::OpenClawConfigStore;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpenClawMcpServerConfig {
    pub server_id: String,
    pub kind: OpenClawMcpServerKind,
    pub enabled: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OpenClawMcpServerReadError;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OpenClawMcpServerKind {
    McpStdio,
    McpHttp,
    Unknown,
}

pub fn read_mcp_servers(
    state_dir: CanonicalStateDir,
) -> Result<Vec<OpenClawMcpServerConfig>, OpenClawMcpServerReadError> {
    let document = OpenClawConfigStore::new(state_dir)
        .read()
        .map_err(|_| OpenClawMcpServerReadError)?;
    let mut servers = document
        .get("mcp")
        .and_then(Value::as_object)
        .and_then(|mcp| mcp.get("servers"))
        .and_then(Value::as_object)
        .map(|servers| {
            servers
                .iter()
                .map(|(server_id, server)| OpenClawMcpServerConfig {
                    server_id: server_id.clone(),
                    kind: server_kind(server),
                    enabled: server
                        .as_object()
                        .and_then(|server| server.get("enabled"))
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    servers.sort_by(|left, right| left.server_id.cmp(&right.server_id));
    Ok(servers)
}

fn server_kind(server: &Value) -> OpenClawMcpServerKind {
    let Some(server) = server.as_object() else {
        return OpenClawMcpServerKind::Unknown;
    };
    if server.get("url").and_then(Value::as_str).is_some() {
        return OpenClawMcpServerKind::McpHttp;
    }
    if server.get("command").and_then(Value::as_str).is_some()
        || server
            .get("transport")
            .and_then(Value::as_str)
            .is_some_and(|transport| transport == "stdio")
    {
        return OpenClawMcpServerKind::McpStdio;
    }
    OpenClawMcpServerKind::Unknown
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use serde_json::json;

    use super::*;

    #[test]
    fn mcp_server_config_read_model_omits_private_fields() {
        let root = std::env::temp_dir().join(format!(
            "openclaw-mcp-server-config-read-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let state_dir = CanonicalStateDir::provision(PathBuf::from(&root)).unwrap();
        fs::write(
            state_dir.as_path().join("openclaw.json"),
            json!({
                "mcp": {
                    "servers": {
                        "stdio": {
                            "command": "secret-command",
                            "args": ["secret-arg"],
                            "env": { "TOKEN": "secret" },
                            "enabled": false
                        },
                        "http": {
                            "url": "https://secret.example.test/mcp",
                            "headers": { "Authorization": "secret" }
                        },
                        "opaque": { "path": "secret-path" }
                    }
                }
            })
            .to_string(),
        )
        .unwrap();

        let servers = read_mcp_servers(state_dir).unwrap();

        assert_eq!(
            servers,
            vec![
                OpenClawMcpServerConfig {
                    server_id: "http".into(),
                    kind: OpenClawMcpServerKind::McpHttp,
                    enabled: true,
                },
                OpenClawMcpServerConfig {
                    server_id: "opaque".into(),
                    kind: OpenClawMcpServerKind::Unknown,
                    enabled: true,
                },
                OpenClawMcpServerConfig {
                    server_id: "stdio".into(),
                    kind: OpenClawMcpServerKind::McpStdio,
                    enabled: false,
                },
            ]
        );
        let _ = fs::remove_dir_all(root);
    }
}
