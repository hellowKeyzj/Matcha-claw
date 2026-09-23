use platform::state_dir::CanonicalStateDir;
use std::path::Path;

use serde_json::{Map, Value};

use crate::native_config::config_store::{OpenClawConfigMutation, OpenClawConfigStore};

use super::external::{ConnectorProjectionEffect, projection_effect};

pub const PRESET_TEAM_RUN_MCP_SERVER_ID: &str = "matcha-teamrun";

#[derive(Clone, Copy)]
pub struct PresetMcpProjection<'a> {
    runtime_host_mcp_executable: &'a Path,
    team_run_mcp_state_dir: &'a Path,
}

impl<'a> PresetMcpProjection<'a> {
    pub fn new(runtime_host_mcp_executable: &'a Path, team_run_mcp_state_dir: &'a Path) -> Self {
        Self {
            runtime_host_mcp_executable,
            team_run_mcp_state_dir,
        }
    }

    pub(super) fn team_run_server(&self) -> Option<Value> {
        team_run_mcp_server(
            self.runtime_host_mcp_executable,
            self.team_run_mcp_state_dir,
        )
    }
}

pub fn project_preset_team_run_mcp_server(
    open_claw_state_dir: CanonicalStateDir,
    runtime_host_mcp_executable: &Path,
    team_run_mcp_state_dir: &Path,
) -> ConnectorProjectionEffect {
    let preset = PresetMcpProjection::new(runtime_host_mcp_executable, team_run_mcp_state_dir);
    let Some(server) = preset.team_run_server() else {
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
        if current_servers.get(PRESET_TEAM_RUN_MCP_SERVER_ID) == Some(&server) {
            return OpenClawConfigMutation::unchanged();
        }
        current_servers.insert(PRESET_TEAM_RUN_MCP_SERVER_ID.into(), server.clone());
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

fn team_run_mcp_server(
    runtime_host_mcp_executable: &Path,
    team_run_mcp_state_dir: &Path,
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
            Value::String(path_text(team_run_mcp_state_dir)?),
        ]),
    );
    server.insert("transport".into(), Value::String("stdio".into()));
    server.insert("enabled".into(), Value::Bool(true));
    Some(Value::Object(server))
}

fn projection_readback_matches(store: &OpenClawConfigStore, expected: &Value) -> bool {
    let Ok(document) = store.read() else {
        return false;
    };
    document
        .get("mcp")
        .and_then(Value::as_object)
        .and_then(|mcp| mcp.get("servers"))
        .and_then(Value::as_object)
        .and_then(|servers| servers.get(PRESET_TEAM_RUN_MCP_SERVER_ID))
        == Some(expected)
}

fn path_text(path: &Path) -> Option<String> {
    if !path.is_absolute() {
        return None;
    }
    path.to_str()
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}
