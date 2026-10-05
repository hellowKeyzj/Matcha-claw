use platform::state_dir::CanonicalStateDir;
use std::path::Path;

use serde_json::{Map, Value};

use crate::native_config::config_store::{OpenClawConfigMutation, OpenClawConfigStore};

use super::external::{ConnectorProjectionEffect, projection_effect};

pub const PRESET_MCP_SERVER_ID: &str = connectors::ports::PRESET_MCP_SERVER_ID;
const OLD_PRESET_MCP_SERVER_ID: &str = "matcha-teamrun";

#[derive(Clone, Copy)]
pub struct PresetMcpProjection<'a> {
    runtime_host_mcp_executable: &'a Path,
    runtime_host_mcp_state_dir: &'a Path,
}

impl<'a> PresetMcpProjection<'a> {
    pub fn new(
        runtime_host_mcp_executable: &'a Path,
        runtime_host_mcp_state_dir: &'a Path,
    ) -> Self {
        Self {
            runtime_host_mcp_executable,
            runtime_host_mcp_state_dir,
        }
    }

    pub(super) fn server(&self) -> Option<Value> {
        mcp_server(
            self.runtime_host_mcp_executable,
            self.runtime_host_mcp_state_dir,
        )
    }
}

pub fn project_preset_mcp_server(
    open_claw_state_dir: CanonicalStateDir,
    runtime_host_mcp_executable: &Path,
    runtime_host_mcp_state_dir: &Path,
) -> ConnectorProjectionEffect {
    let preset = PresetMcpProjection::new(runtime_host_mcp_executable, runtime_host_mcp_state_dir);
    let Some(mut server) = preset.server() else {
        return ConnectorProjectionEffect::Unavailable;
    };
    let store = OpenClawConfigStore::new(open_claw_state_dir);
    match store.update(|document| {
        let mut mcp = document
            .get("mcp")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let mut current_servers = mcp
            .get("servers")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if !reconcile_server(&mut current_servers, &mut server) {
            return OpenClawConfigMutation::unchanged();
        }
        mcp.insert("servers".into(), Value::Object(current_servers));
        let mut commands = document
            .get("commands")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        commands.insert("restart".into(), Value::Bool(true));
        document.insert("commands".into(), Value::Object(commands));
        document.insert("mcp".into(), Value::Object(mcp));
        OpenClawConfigMutation::changed()
    }) {
        Ok(update) if projection_readback_matches(&store, &server) => {
            ConnectorProjectionEffect::Written {
                changed: update.changed,
            }
        }
        Ok(_) => ConnectorProjectionEffect::Unavailable,
        Err(error) => projection_effect(error),
    }
}

pub(super) fn reconcile_server(servers: &mut Map<String, Value>, projected: &mut Value) -> bool {
    let old = servers.remove(OLD_PRESET_MCP_SERVER_ID);
    let mut server = servers
        .get(PRESET_MCP_SERVER_ID)
        .or(old.as_ref())
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for key in ["command", "args", "transport"] {
        server.insert(key.into(), projected[key].clone());
    }
    server.entry("enabled").or_insert(Value::Bool(true));
    *projected = Value::Object(server);
    let changed = servers.get(PRESET_MCP_SERVER_ID) != Some(projected);
    if changed {
        servers.insert(PRESET_MCP_SERVER_ID.into(), projected.clone());
    }
    old.is_some() || changed
}

fn mcp_server(
    runtime_host_mcp_executable: &Path,
    runtime_host_mcp_state_dir: &Path,
) -> Option<Value> {
    let mut server = Map::new();
    server.insert(
        "command".into(),
        Value::String(path_text(runtime_host_mcp_executable)?),
    );
    server.insert(
        "args".into(),
        Value::Array(vec![
            Value::String("--state-dir".into()),
            Value::String(path_text(runtime_host_mcp_state_dir)?),
        ]),
    );
    server.insert("transport".into(), Value::String("stdio".into()));
    server.insert("enabled".into(), Value::Bool(true));
    Some(Value::Object(server))
}

fn projection_readback_matches(store: &OpenClawConfigStore, expected: &Value) -> bool {
    let Ok(document) = store.read_private() else {
        return false;
    };
    document
        .get("mcp")
        .and_then(Value::as_object)
        .and_then(|mcp| mcp.get("servers"))
        .and_then(Value::as_object)
        .is_some_and(|servers| server_matches(servers, expected))
}

pub(super) fn server_matches(servers: &Map<String, Value>, expected: &Value) -> bool {
    !servers.contains_key(OLD_PRESET_MCP_SERVER_ID)
        && servers.get(PRESET_MCP_SERVER_ID) == Some(expected)
}

fn path_text(path: &Path) -> Option<String> {
    if !path.is_absolute() {
        return None;
    }
    path.to_str()
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}
