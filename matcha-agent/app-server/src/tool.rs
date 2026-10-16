use crate::{
    config::ConfigStore,
    rpc::{self, Error},
    session::Sessions,
};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    session_id: String,
    instance_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Named {
    session_id: String,
    instance_id: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    instance_id: Option<String>,
    tools: Option<Vec<String>>,
}

pub async fn dispatch(
    method: &str,
    params: Value,
    _config: &ConfigStore,
    sessions: &Sessions,
) -> rpc::Result<Value> {
    match method {
        "tools.list" => {
            let target: Target = rpc::params(params)?;
            let tools = observed_tools(sessions, &target.session_id, &target.instance_id).await?;
            Ok(json!({
                "sessionId": target.session_id,
                "instanceId": target.instance_id,
                "tools": tools.into_iter().map(|name| json!({"name": name})).collect::<Vec<_>>()
            }))
        }
        "tools.get" => {
            let target: Named = rpc::params(params)?;
            if target.name.is_empty() || target.name.chars().any(char::is_control) {
                return Err(Error::invalid(
                    "Tool name must be nonempty and contain no control characters",
                ));
            }
            let tools = observed_tools(sessions, &target.session_id, &target.instance_id).await?;
            if !tools.iter().any(|name| name == &target.name) {
                return Err(Error::not_found("Observed native tool"));
            }
            Ok(json!({
                "sessionId": target.session_id,
                "instanceId": target.instance_id,
                "tool": {"name": target.name}
            }))
        }
        _ => Err(Error::method(method)),
    }
}

async fn observed_tools(
    sessions: &Sessions,
    session_id: &str,
    instance_id: &str,
) -> rpc::Result<Vec<String>> {
    if instance_id.len() != 36 || Uuid::parse_str(instance_id).is_err() {
        return Err(Error::invalid("instanceId must be a UUID string"));
    }
    let snapshot: Snapshot = serde_json::from_value(sessions.native_snapshot(session_id).await?)
        .map_err(|error| Error::internal("native_snapshot_schema").with_source(error))?;
    let current = snapshot.instance_id.ok_or_else(|| {
        Error::unavailable(
            "native_instance_absent",
            "This session has no live CLI instance",
        )
    })?;
    if current != instance_id {
        return Err(Error::conflict(
            "native_instance_changed",
            "The requested CLI instance is no longer current",
        ));
    }
    snapshot.tools.ok_or_else(|| {
        Error::unavailable(
            "native_tools_not_observed",
            "No system/init tool catalog has been observed for this CLI instance",
        )
    })
}
