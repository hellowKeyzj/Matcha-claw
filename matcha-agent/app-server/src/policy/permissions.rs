use super::settings::{self, Applied, Target};
use crate::{config::ConfigStore, rpc, session::Sessions};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const FIELDS: &[&str] = &[
    "allow",
    "deny",
    "ask",
    "defaultMode",
    "disableBypassPermissionsMode",
    "additionalDirectories",
];

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum PermissionMode {
    Default,
    AcceptEdits,
    BypassPermissions,
    Plan,
    DontAsk,
    Auto,
}

#[derive(Deserialize, Serialize)]
enum Disabled {
    #[serde(rename = "disable")]
    Disable,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Permissions {
    #[serde(skip_serializing_if = "Option::is_none")]
    allow: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    deny: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ask: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    default_mode: Option<PermissionMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    disable_bypass_permissions_mode: Option<Disabled>,
    #[serde(skip_serializing_if = "Option::is_none")]
    additional_directories: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Set {
    agent_id: String,
    session_id: Option<String>,
    permissions: Permissions,
}

#[derive(Debug, thiserror::Error)]
enum PermissionError {
    #[error("A permission rule has an invalid native rule shape")]
    Rule,
    #[error("additionalDirectories must contain nonempty paths without NUL")]
    Directory,
}

impl From<PermissionError> for rpc::Error {
    fn from(error: PermissionError) -> Self {
        let kind = match error {
            PermissionError::Rule => "permissions_rule_invalid",
            PermissionError::Directory => "permissions_directory_invalid",
        };
        rpc::Error::new(-32602, kind, error.to_string())
    }
}

fn view(permissions: &Value) -> Value {
    settings::select(permissions, FIELDS)
}

pub(super) async fn get(
    params: Value,
    config: &ConfigStore,
    sessions: &Sessions,
) -> rpc::Result<Value> {
    let target: Target = rpc::params(params)?;
    let mut result = settings::query(&target, "permissions", view, config, sessions).await?;
    result["authority"] = json!("nativePermissionPipeline");
    result["precedence"] =
        json!("Native deny rules take priority; server does not evaluate tool calls");
    result["updatedPermissions"] = json!({
        "owner": "nativeApprovalResponse",
        "persistentDestinations": ["userSettings", "projectSettings", "localSettings"],
        "transientDestinations": ["session", "cliArg"],
        "serverConfigurationSynchronized": false,
    });
    Ok(result)
}

pub(super) async fn set(
    params: Value,
    config: &ConfigStore,
    sessions: &Sessions,
) -> rpc::Result<Value> {
    if params
        .get("permissions")
        .and_then(Value::as_object)
        .is_some_and(|permissions| permissions.values().any(Value::is_null))
    {
        return Err(rpc::Error::invalid(
            "Permission fields cannot be null; use empty arrays to remove rules",
        ));
    }
    let request: Set = rpc::params(params)?;
    let target = Target {
        agent_id: request.agent_id,
        session_id: request.session_id,
    };
    target.validate()?;
    for (behavior, rules) in [
        ("allow", &request.permissions.allow),
        ("deny", &request.permissions.deny),
        ("ask", &request.permissions.ask),
    ] {
        for rule in rules.iter().flatten() {
            validate_rule(rule, behavior)?;
        }
    }
    if request
        .permissions
        .additional_directories
        .as_ref()
        .is_some_and(|directories| {
            directories
                .iter()
                .any(|directory| directory.trim().is_empty() || directory.contains('\0'))
        })
    {
        return Err(PermissionError::Directory.into());
    }
    let incoming = rpc::value(&request.permissions)?;
    settings::nonempty_patch(
        incoming
            .as_object()
            .expect("permissions serializes as object"),
    )?;

    // The shared per-agent guard orders commit and short native ACK, not model execution.
    let _guard = sessions.agent_guard(&target.agent_id).await;
    let native = settings::native_settings(&target, sessions).await?;
    config
        .update(|config| {
            let next = settings::patch(
                settings::section(config, &target.agent_id, "permissions")?,
                incoming.clone(),
            )?;
            settings::replace(config, &target.agent_id, "permissions", next)
        })
        .await?;

    let mut applied = Applied::new();
    if let Some(native) = native.as_ref() {
        let current = native.flag_section("permissions");
        let mut live = current.clone();
        let mut has_live_change = false;
        for (field, value) in incoming.as_object().expect("permissions is an object") {
            let restart = field == "additionalDirectories"
                || (matches!(field.as_str(), "allow" | "deny" | "ask")
                    && !settings::additions_only(current.get(field), value));
            if restart {
                applied.restart_fields.push(format!("permissions.{field}"));
            } else {
                live[field] = value.clone();
                has_live_change = true;
            }
        }
        if has_live_change {
            applied
                .control(
                    &target,
                    native,
                    sessions,
                    json!({
                        "subtype": "apply_flag_settings", "settings": { "permissions": live },
                    }),
                    "apply_flag_settings",
                )
                .await?;
        }
        if let Some(mode) = request.permissions.default_mode {
            applied
                .control(
                    &target,
                    native,
                    sessions,
                    json!({
                        "subtype": "set_permission_mode", "mode": mode,
                    }),
                    "set_permission_mode",
                )
                .await?;
        }
    }
    let mut result = applied.receipt(&target, native.as_ref());
    result["authority"] = json!("nativePermissionPipeline");
    result["nativeMerge"] = json!(
        "Arrays concatenate across sources; removals require a new CLI instance and do not erase native user or managed rules"
    );
    Ok(result)
}

// Mirror native settings input checks, not tool matching or authorization.
fn validate_rule(rule: &str, behavior: &str) -> Result<(), PermissionError> {
    if rule.trim().is_empty() || rule.contains('\0') {
        return Err(PermissionError::Rule);
    }
    let mut escaped = false;
    let mut opening = None;
    let mut closing = None;
    let mut balance = 0_i64;
    for (index, character) in rule.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
        } else if character == '(' {
            if rule[index + 1..].starts_with(')') {
                return Err(PermissionError::Rule);
            }
            opening.get_or_insert(index);
            balance += 1;
        } else if character == ')' {
            balance -= 1;
            closing = Some(index);
            if balance < 0 {
                return Err(PermissionError::Rule);
            }
        }
    }
    if balance != 0 {
        return Err(PermissionError::Rule);
    }
    let (tool, content) = if let Some(open) = opening {
        if open == 0 || closing != Some(rule.len() - 1) {
            return Err(PermissionError::Rule);
        }
        let raw = &rule[open + 1..rule.len() - 1];
        (
            &rule[..open],
            (raw != "*").then(|| {
                raw.replace("\\(", "(")
                    .replace("\\)", ")")
                    .replace("\\\\", "\\")
            }),
        )
    } else {
        (rule, None)
    };
    if let Some(mcp) = tool.strip_prefix("mcp__") {
        if opening.is_some() || mcp.split("__").next().is_none_or(str::is_empty) {
            return Err(PermissionError::Rule);
        }
        return Ok(());
    }
    if tool
        .chars()
        .next()
        .is_some_and(|first| first.is_lowercase())
    {
        return Err(PermissionError::Rule);
    }
    if behavior == "allow"
        && content.is_none()
        && matches!(tool, "VaultHttpFetch" | "LocalVaultFetch")
    {
        return Err(PermissionError::Rule);
    }
    let Some(content) = content else {
        return Ok(());
    };
    let invalid = match tool {
        "Bash" => content == ":*" || (content.contains(":*") && !content.ends_with(":*")),
        "WebSearch" => content.contains(['*', '?']),
        "WebFetch" => {
            !content.starts_with("domain:")
                || content.contains("://")
                || content.starts_with("http")
        }
        "Read" | "Write" | "Edit" | "Glob" | "NotebookRead" | "NotebookEdit" => {
            content.contains(":*")
                || (content.contains('*')
                    && !content.starts_with('*')
                    && !content.ends_with('*')
                    && !["**", "/*", "*.", "*)"]
                        .iter()
                        .any(|part| content.contains(*part)))
        }
        "VaultHttpFetch" => {
            content.len() > 384
                || content.bytes().any(|byte| byte < 32 || byte == 127)
                || (matches!(behavior, "allow" | "deny") && !valid_vault_content(&content))
        }
        _ => false,
    };
    if invalid {
        return Err(PermissionError::Rule);
    }
    Ok(())
}

fn valid_vault_content(content: &str) -> bool {
    let Some((key, authority)) = content.split_once('@') else {
        return false;
    };
    if key.is_empty()
        || key.len() > 128
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return false;
    }
    if authority == "*" {
        return true;
    }
    let port = if let Some(address) = authority.strip_prefix('[') {
        let Some((address, tail)) = address.split_once(']') else {
            return false;
        };
        if address.is_empty()
            || !address
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || byte == b':')
        {
            return false;
        }
        if tail.is_empty() {
            return true;
        }
        let Some(port) = tail.strip_prefix(':') else {
            return false;
        };
        port
    } else {
        let (host, port) = authority
            .split_once(':')
            .map_or((authority, None), |(host, port)| (host, Some(port)));
        if host.is_empty()
            || host.len() > 253
            || !host
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
        {
            return false;
        }
        let Some(port) = port else {
            return true;
        };
        port
    };
    !port.starts_with('0')
        && port.bytes().all(|byte| byte.is_ascii_digit())
        && port.parse::<u16>().is_ok_and(|port| port > 0)
}
