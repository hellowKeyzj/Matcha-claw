use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::rpc;

use super::{Cli, effort::CONTROL_WINDOW};

pub(super) struct Permissions {
    file: Value,
    inline: Value,
}

impl Permissions {
    pub(super) fn new(value: Option<&Value>) -> Self {
        let value = value.cloned().unwrap_or_else(|| json!({}));
        Self {
            file: value.clone(),
            inline: value,
        }
    }
}

pub(crate) fn project(
    mut permissions: Value,
    states: &BTreeMap<String, bool>,
) -> rpc::Result<Value> {
    let permissions_object = permissions
        .as_object_mut()
        .ok_or_else(|| rpc::Error::invalid("permissions must be an object"))?;
    let deny = permissions_object
        .entry("deny")
        .or_insert_with(|| json!([]));
    let deny = deny
        .as_array_mut()
        .ok_or_else(|| rpc::Error::invalid("permissions.deny must be an array"))?;
    for (name, enabled) in states {
        if !enabled {
            let rule = json!(format!("Skill({name})"));
            if !deny.contains(&rule) {
                deny.push(rule);
            }
        }
    }
    Ok(permissions)
}

impl Cli {
    // Called under the shared Agent guard; this lock only owns inline permission controls.
    pub(crate) async fn apply_permissions(
        &self,
        patch: &Value,
        states: &BTreeMap<String, bool>,
    ) -> rpc::Result<Vec<String>> {
        self.initialized().await?;
        let mut permissions = self.0.instance.permissions.lock().await;
        let mut inline = permissions.inline.clone();
        let mut restart_fields = Vec::new();
        for (field, value) in patch
            .as_object()
            .ok_or_else(|| rpc::Error::invalid("permissions must be an object"))?
        {
            let removes_file_rule = matches!(field.as_str(), "allow" | "deny" | "ask")
                && permissions
                    .file
                    .get(field)
                    .and_then(Value::as_array)
                    .is_some_and(|previous| {
                        value
                            .as_array()
                            .is_none_or(|next| previous.iter().any(|rule| !next.contains(rule)))
                    });
            if field == "additionalDirectories" || removes_file_rule {
                restart_fields.push(format!("permissions.{field}"));
            } else {
                inline[field] = value.clone();
            }
        }
        let projected = project(inline.clone(), states)?;
        permissions.inline = inline;
        tokio::time::timeout(
            CONTROL_WINDOW,
            self.request(json!({
                "subtype": "apply_flag_settings", "settings": { "permissions": projected },
            })),
        )
        .await
        .map_err(|_| {
            rpc::Error::new(
                -32006,
                "permissions_ack_unknown",
                "Native permission acknowledgement did not complete",
            )
        })??;
        Ok(restart_fields)
    }
}
