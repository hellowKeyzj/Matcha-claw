//! Native plugin management; gateway forwards params without translating this schema.
//!
//! Inputs (camelCase, unknown fields rejected):
//! - list: { agentId }
//! - install/enable/update: { agentId, id, scope? }
//! - uninstall: { agentId, id, scope?, keepData?: false }
//! - disable: { agentId, id?, scope?, all?: false }; all excludes id and scope.
//! - reload: { sessionId }
//!
//! id is a native name or name@marketplace, not a URL/package/version expression.
//! Scopes: user/project/local; only update also accepts managed. Install,
//! uninstall and update default to user; enable/disable preserve native auto-scope.
//!
//! List returns { agentId, plugins: [{ id, version, scope, enabled, errorCount }],
//! sessionState: "not_observed" }. Enabled is the CLI's merged settings view,
//! not a per-installation or running-session assertion. Native --available is
//! deliberately not exposed: it can fetch install counts and hides market errors.
//! Mutations return { agentId, operation, status: "native_succeeded",
//! sessionRefresh: "not_requested", result }. Only native success receipts are
//! parsed; mutation failure/undecodable receipts may follow partial durable writes.
//! Reload returns sessionId, status (refreshed/partial), unchanged error_count,
//! safe component names/statuses, and observationCompleteness: "best_effort".
//! error_count == 0 does not prove the native post-refresh queries all succeeded.
//!
//! Sources: main.tsx plugin registration; cli/handlers/plugins.ts;
//! services/plugins/{pluginCliCommands,pluginOperations}.ts; cli/print.ts
//! reload_plugins; utils/plugins/refresh.ts. No registry writes or resolver copies.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    cli::command,
    config::{ConfigStore, validate_id},
    rpc::{self, Error},
    session::Sessions,
};

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Scope {
    User,
    Project,
    Local,
    Managed,
}

impl Scope {
    fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Project => "project",
            Self::Local => "local",
            Self::Managed => "managed",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListParams {
    agent_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginParams {
    agent_id: String,
    id: String,
    scope: Option<Scope>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UninstallParams {
    agent_id: String,
    id: String,
    scope: Option<Scope>,
    #[serde(default)]
    keep_data: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DisableParams {
    agent_id: String,
    id: Option<String>,
    scope: Option<Scope>,
    #[serde(default)]
    all: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReloadParams {
    session_id: String,
}

// Deserialize only the fields allowed on the business surface. In particular,
// installPath/projectPath, MCP env/argv/URLs and raw load errors never leave here.
#[derive(Deserialize)]
struct InstalledPlugin {
    id: String,
    version: String,
    scope: String,
    enabled: bool,
    #[serde(default)]
    errors: Vec<String>,
}

#[derive(Deserialize)]
struct NativeName {
    name: String,
}

#[derive(Deserialize)]
struct NativePlugin {
    name: String,
    source: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum McpStatus {
    Connected,
    Failed,
    NeedsAuth,
    Pending,
    Disabled,
}

#[derive(Deserialize)]
struct NativeMcp {
    name: String,
    status: McpStatus,
    error: Option<String>,
}

#[derive(Deserialize)]
struct ReloadObservation {
    commands: Vec<NativeName>,
    agents: Vec<NativeName>,
    plugins: Vec<NativePlugin>,
    #[serde(rename = "mcpServers")]
    mcp_servers: Vec<NativeMcp>,
    error_count: u64,
}

pub async fn dispatch(
    method: &str,
    params: Value,
    config: &ConfigStore,
    sessions: &Sessions,
) -> rpc::Result<Value> {
    match method {
        "plugins.list" => {
            let params: ListParams = rpc::params(params)?;
            let output = run(
                config,
                &params.agent_id,
                vec!["plugin".into(), "list".into(), "--json".into()],
                None,
            )
            .await?;
            let plugins: Vec<InstalledPlugin> =
                serde_json::from_str(&output.stdout).map_err(|_| invalid_list())?;
            let mut projected = Vec::with_capacity(plugins.len());
            for plugin in plugins {
                if !matches!(
                    plugin.scope.as_str(),
                    "user" | "project" | "local" | "managed" | "session"
                ) {
                    return Err(invalid_list());
                }
                projected.push(json!({
                    "id": public_label(&plugin.id),
                    "version": public_label(&plugin.version),
                    "scope": plugin.scope,
                    "enabled": plugin.enabled,
                    "errorCount": plugin.errors.len(),
                }));
            }
            Ok(
                json!({ "agentId": params.agent_id, "plugins": projected, "sessionState": "not_observed" }),
            )
        }
        "plugins.install" | "plugins.enable" | "plugins.update" => {
            let params: PluginParams = rpc::params(params)?;
            let operation = match method {
                "plugins.install" => "install",
                "plugins.enable" => "enable",
                _ => "update",
            };
            mutate(
                config,
                &params.agent_id,
                operation,
                Some(&params.id),
                params.scope,
                false,
            )
            .await
        }
        "plugins.uninstall" => {
            let params: UninstallParams = rpc::params(params)?;
            mutate(
                config,
                &params.agent_id,
                "uninstall",
                Some(&params.id),
                params.scope,
                params.keep_data,
            )
            .await
        }
        "plugins.disable" => {
            let params: DisableParams = rpc::params(params)?;
            if params.all {
                if params.id.is_some() || params.scope.is_some() {
                    return Err(Error::invalid("all cannot be combined with id or scope"));
                }
            } else if params.id.is_none() {
                return Err(Error::invalid("Specify id or all: true"));
            }
            mutate(
                config,
                &params.agent_id,
                "disable",
                params.id.as_deref(),
                params.scope,
                false,
            )
            .await
        }
        "plugins.reload" => {
            let params: ReloadParams = rpc::params(params)?;
            if params.session_id.is_empty() {
                return Err(Error::invalid("sessionId must not be empty"));
            }
            let response = sessions
                .control(&params.session_id, json!({ "subtype": "reload_plugins" }))
                .await
                .map_err(|error| {
                    error.with_data(json!({
                        "operation": "reload", "reloadOutcome": "unconfirmed",
                    }))
                })?;
            let observed: ReloadObservation = serde_json::from_value(response).map_err(|_| {
                Error::new(
                    -32006,
                    "plugin_reload_observation_invalid",
                    "Native reload may have applied, but its observation could not be decoded",
                )
                .with_data(json!({ "operation": "reload", "reloadOutcome": "unconfirmed" }))
            })?;
            Ok(json!({
                "sessionId": params.session_id,
                "status": if observed.error_count == 0 { "refreshed" } else { "partial" },
                "error_count": observed.error_count,
                "observationCompleteness": "best_effort",
                "commands": observed.commands.into_iter().map(|command| json!({ "name": public_label(&command.name) })).collect::<Vec<_>>(),
                "agents": observed.agents.into_iter().map(|agent| json!({ "name": public_label(&agent.name) })).collect::<Vec<_>>(),
                "plugins": observed.plugins.into_iter().map(|plugin| json!({
                    "name": public_label(&plugin.name), "source": plugin.source.as_deref().map(public_label),
                })).collect::<Vec<_>>(),
                "mcpServers": observed.mcp_servers.into_iter().map(|server| json!({
                    "name": public_label(&server.name), "status": server.status, "errorPresent": server.error.is_some(),
                })).collect::<Vec<_>>(),
            }))
        }
        _ => Err(Error::method(method)),
    }
}

async fn run(
    config: &ConfigStore,
    agent_id: &str,
    args: Vec<String>,
    mutation: Option<&str>,
) -> rpc::Result<command::CommandOutput> {
    validate_id(agent_id)?;
    let snapshot = config.snapshot().await;
    if !snapshot.agents.contains_key(agent_id) {
        return Err(Error::not_found("Agent"));
    }
    command::run(&snapshot, config.paths(), agent_id, args)
        .await
        .map_err(|error| match mutation {
            Some(operation) => error.with_data(mutation_context(operation)),
            None => error,
        })
}

async fn mutate(
    config: &ConfigStore,
    agent_id: &str,
    operation: &str,
    id: Option<&str>,
    scope: Option<Scope>,
    keep_data: bool,
) -> rpc::Result<Value> {
    if id.is_some_and(|id| !valid_reference(id)) {
        return Err(Error::invalid(
            "id must be a plugin name or name@marketplace; sources and version constraints are resolved by the native CLI",
        ));
    }
    if scope == Some(Scope::Managed) && operation != "update" {
        return Err(Error::invalid(
            "managed scope is only accepted by plugins.update",
        ));
    }
    let scope = scope
        .or_else(|| matches!(operation, "install" | "uninstall" | "update").then_some(Scope::User));
    let mut args = vec!["plugin".into(), operation.into()];
    if let Some(id) = id {
        args.push(id.into());
    } else {
        args.push("--all".into());
    }
    if let Some(scope) = scope {
        args.extend(["--scope".into(), scope.as_str().into()]);
    }
    if keep_data {
        args.push("--keep-data".into());
    }
    // Mutation CLI has no --json. Nonzero exit/transport failure can follow
    // settings-first installation, uninstall cleanup, or partial disable-all.
    let output = run(config, agent_id, args, Some(operation)).await?;
    let result = output
        .stdout
        .lines()
        .rfind(|line| !line.trim().is_empty())
        .and_then(|line| {
            // figures selects these two tick characters (Unicode/fallback).
            let message = line
                .trim()
                .strip_prefix("✔ ")
                .or_else(|| line.trim().strip_prefix("√ "))?;
            parse_receipt(operation, message, scope)
        })
        .ok_or_else(|| {
            Error::new(
                -32006,
                "plugin_receipt_unrecognized",
                "Native command exited successfully, but its durable result could not be confirmed",
            )
            .with_data(mutation_context(operation))
        })?;
    Ok(json!({
        "agentId": agent_id, "operation": operation, "status": "native_succeeded",
        "sessionRefresh": "not_requested", "result": result,
    }))
}

fn mutation_context(operation: &str) -> Value {
    json!({
        "operation": operation, "durableOutcome": "unconfirmed",
        "changesMayBePartial": true, "sessionRefresh": "not_requested",
    })
}

fn invalid_list() -> Error {
    Error::new(
        -32004,
        "plugin_list_output_invalid",
        "Native plugin list did not match the supported output schema",
    )
}

fn valid_reference(id: &str) -> bool {
    let mut parts = id.split('@');
    let name = parts.next().unwrap_or_default();
    valid_component(name) && parts.next().is_none_or(valid_component) && parts.next().is_none()
}

fn valid_component(name: &str) -> bool {
    name.as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphanumeric)
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

// Business metadata only, not a general secret scrubber. No free-form native
// descriptions, errors, paths, source URLs, MCP configs or logs are returned.
fn public_label(label: &str) -> &str {
    if !label.is_empty()
        && label
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:@+[]".contains(&byte))
    {
        label
    } else {
        "[redacted]"
    }
}

fn parse_scope(scope: &str) -> Option<Scope> {
    match scope {
        "user" => Some(Scope::User),
        "project" => Some(Scope::Project),
        "local" => Some(Scope::Local),
        "managed" => Some(Scope::Managed),
        _ => None,
    }
}

fn scoped_message(message: &str) -> Option<(&str, Scope, &str)> {
    let (name, rest) = message.split_once(" (scope: ")?;
    let (scope, suffix) = rest.split_once(')')?;
    Some((name, parse_scope(scope)?, suffix))
}

fn reverse_dependents(suffix: &str) -> Option<Vec<&str>> {
    if suffix.is_empty() {
        return Some(Vec::new());
    }
    let names = suffix.strip_prefix(" — warning: required by ")?;
    if names.is_empty() {
        return None;
    }
    Some(names.split(", ").map(public_label).collect())
}

fn parse_receipt(operation: &str, message: &str, requested_scope: Option<Scope>) -> Option<Value> {
    if operation == "install" {
        let (id, scope, suffix) =
            scoped_message(message.strip_prefix("Successfully installed plugin: ")?)?;
        if !valid_reference(id) || Some(scope) != requested_scope {
            return None;
        }
        let dependencies = if suffix.is_empty() {
            0
        } else {
            let count = suffix.strip_prefix(" (+ ")?.strip_suffix(')')?;
            let (count, noun) = count.split_once(' ')?;
            let count: u64 = count.parse().ok()?;
            if noun
                != if count == 1 {
                    "dependency"
                } else {
                    "dependencies"
                }
            {
                return None;
            }
            count
        };
        return Some(json!({ "id": id, "scope": scope, "dependencyCount": dependencies }));
    }
    if matches!(operation, "enable" | "disable" | "uninstall") {
        if operation == "disable" && message == "No enabled plugins to disable" {
            return Some(json!({ "disabledCount": 0 }));
        }
        if operation == "disable"
            && let Some(count) = message.strip_prefix("Disabled ")
        {
            let (count, noun) = count.split_once(' ')?;
            let count: u64 = count.parse().ok()?;
            if noun != if count == 1 { "plugin" } else { "plugins" } {
                return None;
            }
            return Some(json!({ "disabledCount": count }));
        }
        let prefix = match operation {
            "enable" => "Successfully enabled plugin: ",
            "disable" => "Successfully disabled plugin: ",
            _ => "Successfully uninstalled plugin: ",
        };
        if let Some(message) = message.strip_prefix(prefix) {
            let (name, scope, suffix) = scoped_message(message)?;
            if scope == Scope::Managed
                || requested_scope.is_some_and(|requested| scope != requested)
            {
                return None;
            }
            return Some(json!({
                "name": public_label(name), "scope": scope,
                "reverseDependents": reverse_dependents(suffix)?,
            }));
        }
        let builtin_prefix = match operation {
            "enable" => "Successfully enabled built-in plugin: ",
            "disable" => "Successfully disabled built-in plugin: ",
            _ => return None,
        };
        let name = message.strip_prefix(builtin_prefix)?;
        // Native built-ins always write user settings even with explicit scope.
        return Some(
            json!({ "name": public_label(name), "scope": Scope::User, "reverseDependents": [] }),
        );
    }
    if operation == "update" {
        if let Some((name, version)) = message.split_once(" is already at the latest version (") {
            let version = version.strip_suffix(").")?;
            return Some(json!({
                "name": public_label(name), "scope": requested_scope,
                "newVersion": public_label(version), "alreadyUpToDate": true,
            }));
        }
        let message = message
            .strip_prefix("Plugin \"")?
            .strip_suffix(". Restart to apply changes.")?;
        let (name, versions) = message.split_once("\" updated from ")?;
        let (versions, scope) = versions.rsplit_once(" for scope ")?;
        let (old_version, new_version) = versions.split_once(" to ")?;
        let scope_name = scope.split_once(" (").map_or(scope, |(name, _)| name);
        let scope_kind = parse_scope(scope_name)?;
        if Some(scope_kind) != requested_scope || (scope != scope_name && !scope.ends_with(')')) {
            return None;
        }
        return Some(json!({
            "name": public_label(name), "scope": scope_kind,
            "oldVersion": public_label(old_version), "newVersion": public_label(new_version),
            "alreadyUpToDate": false,
        }));
    }
    None
}
