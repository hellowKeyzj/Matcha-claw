use serde_json::{Value, json};

use crate::{Catalog, CatalogEntry, Execution, Runtime};

pub fn project_catalog(catalog: Catalog) -> Value {
    json!({
        "success": catalog.success,
        "execution": project_execution(catalog.execution),
        "plugins": catalog.plugins.into_iter().map(project_catalog_entry).collect::<Vec<_>>(),
    })
}

pub fn project_runtime(runtime: Runtime) -> Value {
    let enabled_plugin_ids = runtime.execution.enabled_plugin_ids;
    let active_plugin_count = runtime
        .plugins
        .iter()
        .filter(|plugin| {
            plugin.status == "running" && enabled_plugin_ids.iter().any(|id| id == &plugin.id)
        })
        .count();
    json!({
        "success": runtime.success,
        "state": {
            "lifecycle": "running",
            "runtimeLifecycle": "running",
            "activePluginCount": active_plugin_count,
            "enabledPluginIds": enabled_plugin_ids,
        },
        "health": {
            "ok": true,
            "lifecycle": "running",
            "activePluginCount": active_plugin_count,
            "degradedPlugins": [],
        },
        "execution": {
            "enabledPluginIds": enabled_plugin_ids,
        },
    })
}

pub fn project_control_catalog(catalog: Catalog) -> Value {
    json!({ "result": project_catalog(catalog) })
}

pub fn project_control_runtime(runtime: Runtime) -> Value {
    json!({ "result": project_runtime(runtime) })
}

pub fn project_capability_configured() -> Value {
    json!({ "success": true, "outcome": "configured" })
}

pub fn project_control_configured_result() -> Value {
    json!({ "result": { "outcome": "configured" } })
}

pub fn project_control_unknown_outcome() -> Value {
    json!({ "outcome": "unknown" })
}

fn project_execution(execution: Execution) -> Value {
    json!({ "enabledPluginIds": execution.enabled_plugin_ids })
}

fn project_catalog_entry(entry: CatalogEntry) -> Value {
    let mut value = json!({
        "runtime": entry.runtime,
        "id": entry.id,
        "name": entry.name,
        "version": entry.version,
        "kind": entry.kind,
        "platform": entry.platform,
        "enabled": entry.enabled,
        "installed": entry.installed,
        "updateAvailable": entry.update_available,
        "companionSkillReady": entry.companion_skill_ready,
    });
    if let Some(description) = entry.description {
        value["description"] = json!(description);
    }
    if let Some(companion_skill_slugs) = entry.companion_skill_slugs {
        value["companionSkillSlugs"] = json!(companion_skill_slugs);
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Execution, Runtime, RuntimeEntry};

    #[test]
    fn runtime_projection_keeps_child_lifecycle_running_when_peer_plugins_are_stopped() {
        let body = project_runtime(Runtime {
            success: true,
            lifecycle: "stopped",
            state: "stopped",
            health: "stopped",
            execution: Execution {
                enabled_plugin_ids: vec!["browser-relay".into()],
            },
            plugins: vec![RuntimeEntry {
                id: "browser-relay".into(),
                status: "stopped",
            }],
        });

        assert_eq!(body["state"]["lifecycle"], "running");
        assert_eq!(body["state"]["runtimeLifecycle"], "running");
        assert_eq!(body["health"]["ok"], true);
        assert_eq!(body["health"]["lifecycle"], "running");
        assert_eq!(body["health"].get("error"), None);
        assert_eq!(body["state"]["activePluginCount"], 0);
    }
}
