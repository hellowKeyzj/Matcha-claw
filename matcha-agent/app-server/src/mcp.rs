//! Native configuration commands and instance-bound MCP controls are separate surfaces.
//! Configuration queries run the CLI's temporary health probe; they are not session status.

mod projection;
pub use projection::{project, validate_config};

use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock, Weak},
};

use axum::{extract::Query, http::Uri};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Mutex as AsyncMutex;

use crate::{
    cli::command,
    config::{ConfigStore, validate_id},
    rpc::{self, Error},
    session::Sessions,
    workspace,
};

static PROJECT_WRITERS: OnceLock<Mutex<BTreeMap<PathBuf, Weak<AsyncMutex<()>>>>> = OnceLock::new();

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentInput {
    agent_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GetInput {
    agent_id: String,
    name: String,
}

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Scope {
    #[default]
    Local,
    User,
    Project,
}

impl Scope {
    fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::User => "user",
            Self::Project => "project",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AddInput {
    agent_id: String,
    name: String,
    #[serde(default)]
    scope: Scope,
    server: ServerInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoveInput {
    agent_id: String,
    name: String,
    scope: Scope,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
enum ServerInput {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
    },
    Http(RemoteInput),
    Sse(RemoteInput),
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RemoteInput {
    url: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    oauth: Option<OAuthInput>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OAuthInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    client_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    callback_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    auth_server_metadata_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    xaa: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionInput {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServerInputRef {
    session_id: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToggleInput {
    session_id: String,
    name: String,
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthenticateInput {
    session_id: String,
    name: String,
    callback_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Observation {
    session_id: String,
    instance_id: String,
    response: Value,
}

/// Accepted gateway requests are owned tasks drained at shutdown, not aborted mid-commit.
/// No method accepts raw native config or arbitrary control requests.
pub async fn dispatch(
    method: &str,
    params: Value,
    config: &ConfigStore,
    sessions: &Sessions,
) -> rpc::Result<Value> {
    match method {
        "mcp.config.get" => projection::get(params, config).await,
        "mcp.config.set" => projection::replace(params, config).await,
        "mcp.list" => {
            let input: AgentInput = rpc::params(params)?;
            let stdout = run(config, &input.agent_id, vec!["mcp".into(), "list".into()]).await?;
            Ok(json!({
                "agentId": input.agent_id,
                "observation": "ephemeral_native_command",
                "servers": list_projection(&stdout)?,
            }))
        }
        "mcp.get" => {
            let input: GetInput = rpc::params(params)?;
            reference_name(&input.name)?;
            let stdout = run(
                config,
                &input.agent_id,
                vec!["mcp".into(), "get".into(), "--".into(), input.name.clone()],
            )
            .await?;
            Ok(json!({
                "agentId": input.agent_id,
                "observation": "ephemeral_native_command",
                "server": get_projection(&input.name, &stdout)?,
            }))
        }
        "mcp.add" => {
            let input: AddInput = rpc::params(params)?;
            if input.name.is_empty()
                || !input
                    .name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            {
                return Err(Error::invalid(
                    "MCP names must contain only ASCII letters, digits, hyphens, and underscores",
                ));
            }
            if matches!(input.name.as_str(), "claude-in-chrome" | "computer-use") {
                return Err(Error::invalid(
                    "This MCP server name is reserved for the native runtime",
                ));
            }
            input.server.validate()?;
            if matches!(input.scope, Scope::Project) {
                project_update(
                    config,
                    &input.agent_id,
                    &input.name,
                    Some(rpc::value(input.server)?),
                )
                .await?;
            } else {
                let server = serde_json::to_string(&input.server)
                    .map_err(|_| Error::internal("mcp_config_encode"))?;
                run(
                    config,
                    &input.agent_id,
                    vec![
                        "mcp".into(),
                        "add-json".into(),
                        "--scope".into(),
                        input.scope.as_str().into(),
                        "--".into(),
                        input.name.clone(),
                        server,
                    ],
                )
                .await?;
            }
            Ok(configuration_receipt(
                &input.agent_id,
                &input.name,
                input.scope,
            ))
        }
        "mcp.remove" => {
            let input: RemoveInput = rpc::params(params)?;
            reference_name(&input.name)?;
            if matches!(input.scope, Scope::Project) {
                project_update(config, &input.agent_id, &input.name, None).await?;
            } else {
                run(
                    config,
                    &input.agent_id,
                    vec![
                        "mcp".into(),
                        "remove".into(),
                        "--scope".into(),
                        input.scope.as_str().into(),
                        "--".into(),
                        input.name.clone(),
                    ],
                )
                .await?;
            }
            Ok(configuration_receipt(
                &input.agent_id,
                &input.name,
                input.scope,
            ))
        }
        "mcp.status" => {
            let input: SessionInput = rpc::params(params)?;
            let observed = control(
                sessions,
                &input.session_id,
                json!({"subtype": "mcp_status"}),
            )
            .await?;
            let servers = observed
                .response
                .get("mcpServers")
                .and_then(Value::as_array)
                .ok_or_else(control_format)?;
            let servers = servers
                .iter()
                .map(status_projection)
                .collect::<rpc::Result<Vec<_>>>()?;
            Ok(
                json!({"sessionId": observed.session_id, "instanceId": observed.instance_id, "servers": servers}),
            )
        }
        "mcp.reconnect" => {
            let input: ServerInputRef = rpc::params(params)?;
            reference_name(&input.name)?;
            let observed = control(
                sessions,
                &input.session_id,
                json!({
                    "subtype": "mcp_reconnect", "serverName": input.name,
                }),
            )
            .await?;
            Ok(control_receipt(observed, &input.name))
        }
        "mcp.toggle" => {
            let input: ToggleInput = rpc::params(params)?;
            reference_name(&input.name)?;
            let observed = control(
                sessions,
                &input.session_id,
                json!({
                    "subtype": "mcp_toggle", "serverName": input.name, "enabled": input.enabled,
                }),
            )
            .await?;
            let mut receipt = control_receipt(observed, &input.name);
            receipt["enabledRequested"] = json!(input.enabled);
            receipt["nativeProjectChoice"] = json!("acknowledged");
            Ok(receipt)
        }
        "mcp.authenticate" => authenticate(rpc::params(params)?, sessions).await,
        _ => Err(Error::method(method)),
    }
}

impl ServerInput {
    fn validate(&self) -> rpc::Result<()> {
        match self {
            Self::Stdio { command, args, env } => {
                if command.is_empty()
                    || command.contains('\0')
                    || args.iter().any(|arg| arg.contains('\0'))
                {
                    return Err(Error::invalid(
                        "MCP command must be nonempty and command arguments must not contain NUL",
                    ));
                }
                if env
                    .iter()
                    .any(|(key, value)| !env_name(key) || !env_reference(value))
                {
                    return Err(Error::invalid(
                        "MCP env accepts only variable names mapped to complete ${SOURCE_ENV} references; plaintext and default values are not accepted",
                    ));
                }
            }
            Self::Http(remote) | Self::Sse(remote) => {
                endpoint(&remote.url)?;
                if remote.headers.iter().any(|(key, value)| {
                    !key.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
                        || key.is_empty()
                        || !env_reference(value.strip_prefix("Bearer ").unwrap_or(value))
                }) {
                    return Err(Error::invalid(
                        "MCP headers accept only ${SOURCE_ENV} or Bearer ${SOURCE_ENV} values; use native OAuth for credentials",
                    ));
                }
                if let Some(oauth) = &remote.oauth {
                    if oauth.callback_port == Some(0) {
                        return Err(Error::invalid(
                            "OAuth callbackPort must be a nonzero TCP port",
                        ));
                    }
                    if let Some(url) = &oauth.auth_server_metadata_url
                        && endpoint(url)?.scheme_str() != Some("https")
                    {
                        return Err(Error::invalid("OAuth metadata URL must use HTTPS"));
                    }
                }
            }
        }
        Ok(())
    }
}

fn env_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn env_reference(value: &str) -> bool {
    value
        .strip_prefix("${")
        .and_then(|value| value.strip_suffix('}'))
        .is_some_and(env_name)
}

fn reference_name(name: &str) -> rpc::Result<()> {
    if name.trim().is_empty() || name.chars().any(char::is_control) {
        return Err(Error::invalid(
            "MCP name must be nonempty and must not contain control characters",
        ));
    }
    Ok(())
}

fn http_uri(value: &str) -> Option<Uri> {
    let uri: Uri = value.parse().ok()?;
    (matches!(uri.scheme_str(), Some("http" | "https"))
        && uri.host().is_some_and(|host| !host.is_empty())
        && !uri.authority()?.as_str().contains('@')
        && !value.contains('#'))
    .then_some(uri)
}

fn endpoint(value: &str) -> rpc::Result<Uri> {
    http_uri(value).filter(|uri| uri.query().is_none()).ok_or_else(|| {
        Error::invalid("MCP endpoint must be an absolute HTTP(S) URL without userinfo, query credentials, or fragment; use native OAuth or environment-reference headers")
    })
}

async fn run(config: &ConfigStore, agent_id: &str, args: Vec<String>) -> rpc::Result<String> {
    validate_id(agent_id)?;
    let snapshot = config.snapshot().await;
    if !snapshot.agents.contains_key(agent_id) {
        return Err(Error::not_found("agent"));
    }
    let output = command::run(&snapshot, config.paths(), agent_id, args).await?;
    Ok(output.stdout)
}

async fn project_update(
    config: &ConfigStore,
    agent_id: &str,
    name: &str,
    server: Option<Value>,
) -> rpc::Result<()> {
    validate_id(agent_id)?;
    let path = config.paths().workspace(agent_id)?;
    let writer = {
        let mut writers = PROJECT_WRITERS
            .get_or_init(Mutex::default)
            .lock()
            .map_err(|_| Error::internal("mcp_project_writer_lock"))?;
        writers.retain(|_, writer| writer.strong_count() > 0);
        if let Some(writer) = writers.get(&path).and_then(Weak::upgrade) {
            writer
        } else {
            let writer = Arc::new(AsyncMutex::new(()));
            writers.insert(path, Arc::downgrade(&writer));
            writer
        }
    };
    // Only this workspace's literal MCP read/modify/commit is serialized.
    let _guard = writer.lock().await;
    let mut document = match workspace::read_file(config, agent_id, ".mcp.json").await {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes).map_err(|_| {
            Error::conflict(
                "mcp_project_config_invalid",
                "Project MCP configuration is not valid JSON; it was not modified",
            )
        })?,
        Err(error)
            if error
                .data
                .as_ref()
                .and_then(|data| data.get("kind"))
                .and_then(Value::as_str)
                == Some("workspace_not_found")
                && matches!(
                    error
                        .data
                        .as_ref()
                        .and_then(|data| data.get("operation"))
                        .and_then(Value::as_str),
                    Some("read_open" | "open")
                ) =>
        {
            json!({"mcpServers": {}})
        }
        Err(error) => return Err(error),
    };
    let servers = document
        .as_object_mut()
        .and_then(|root| root.get_mut("mcpServers"))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| {
            Error::conflict(
                "mcp_project_config_invalid",
                "Project MCP configuration must contain an mcpServers object; it was not modified",
            )
        })?;
    if let Some(server) = server {
        if servers.contains_key(name) {
            return Err(Error::conflict(
                "mcp_server_exists",
                "This MCP server already exists in project scope",
            ));
        }
        servers.insert(name.to_owned(), server);
    } else if servers.remove(name).is_none() {
        return Err(Error::not_found("project MCP server"));
    }
    let mut bytes =
        serde_json::to_vec_pretty(&document).map_err(|_| Error::internal("mcp_config_encode"))?;
    bytes.push(b'\n');
    workspace::write_file(config, agent_id, ".mcp.json", &bytes).await
}

fn configuration_receipt(agent_id: &str, name: &str, scope: Scope) -> Value {
    let mut receipt = json!({
        "agentId": agent_id, "name": name, "scope": scope,
        "sessionApplication": "not_requested",
    });
    if matches!(scope, Scope::Project) {
        receipt["projectConfig"] = json!("persisted");
        receipt["nativePolicy"] = json!("evaluated_on_load");
        receipt["nativeCredentials"] = json!("unchanged");
    } else {
        receipt["nativeCommand"] = json!("acknowledged");
    }
    receipt
}

async fn control(
    sessions: &Sessions,
    session_id: &str,
    request: Value,
) -> rpc::Result<Observation> {
    let value = sessions.control_observed(session_id, request).await?;
    let observed: Observation = serde_json::from_value(value).map_err(|_| control_format())?;
    if observed.session_id != session_id
        || observed.instance_id.is_empty()
        || !observed.response.is_object()
    {
        return Err(control_format());
    }
    Ok(observed)
}

fn control_receipt(observed: Observation, name: &str) -> Value {
    json!({
        "sessionId": observed.session_id, "instanceId": observed.instance_id,
        "name": name, "acknowledged": true, "connectionState": "not_observed",
    })
}

async fn authenticate(input: AuthenticateInput, sessions: &Sessions) -> rpc::Result<Value> {
    reference_name(&input.name)?;
    if let Some(callback_url) = input.callback_url {
        let uri = http_uri(&callback_url)
            .ok_or_else(|| Error::invalid("OAuth callback must be an absolute HTTP(S) URL"))?;
        let Query(query) = Query::<BTreeMap<String, String>>::try_from_uri(&uri)
            .map_err(|_| Error::invalid("OAuth callback query is malformed"))?;
        if !["code", "error"]
            .iter()
            .any(|key| query.get(*key).is_some_and(|value| !value.is_empty()))
        {
            return Err(Error::invalid(
                "OAuth callback URL must include a code or error parameter",
            ));
        }
        let observed = control(sessions, &input.session_id, json!({
            "subtype": "mcp_oauth_callback_url", "serverName": input.name, "callbackUrl": callback_url,
        })).await?;
        let mut receipt = control_receipt(observed, &input.name);
        receipt["phase"] = json!("callback_acknowledged");
        receipt["reconnectRequired"] = json!(true);
        return Ok(receipt);
    }

    let observed = control(
        sessions,
        &input.session_id,
        json!({
            "subtype": "mcp_authenticate", "serverName": input.name,
        }),
    )
    .await?;
    let requires_action = observed
        .response
        .get("requiresUserAction")
        .and_then(Value::as_bool)
        .ok_or_else(control_format)?;
    let auth_url = if requires_action {
        let url = observed
            .response
            .get("authUrl")
            .and_then(Value::as_str)
            .ok_or_else(control_format)?;
        let uri = http_uri(url).ok_or_else(auth_url_unavailable)?;
        let Query(query) = Query::<BTreeMap<String, String>>::try_from_uri(&uri)
            .map_err(|_| auth_url_unavailable())?;
        // This URL is an intentional, transient browser handoff, never config or diagnostics.
        if query.keys().any(|key| {
            let key = key.to_ascii_lowercase().replace(['-', '_'], "");
            key.contains("token")
                || key.contains("secret")
                || key.contains("password")
                || key.contains("apikey")
                || key == "code"
                || key == "authorization"
        }) {
            return Err(auth_url_unavailable());
        }
        Some(url.to_owned())
    } else {
        None
    };
    Ok(json!({
        "sessionId": observed.session_id, "instanceId": observed.instance_id, "name": input.name,
        "phase": "native_flow_started", "requiresUserAction": requires_action,
        "authUrl": auth_url, "connectionState": "not_observed",
    }))
}

fn auth_url_unavailable() -> Error {
    Error::unavailable(
        "mcp_oauth_url_unavailable",
        "Native OAuth started but its browser URL cannot be safely exposed",
    )
    .with_data(json!({"nativeFlow": "started", "connectionState": "not_observed"}))
}

fn control_format() -> Error {
    Error::unavailable(
        "mcp_control_response_unavailable",
        "Native MCP response does not match the supported safe projection; operation outcome must not be inferred",
    )
}

fn query_format() -> Error {
    Error::unavailable(
        "mcp_native_query_format_unavailable",
        "Native MCP query has no JSON output and its text does not match the supported safe projection",
    )
}

fn probe_status(line: &str) -> Option<&'static str> {
    match line {
        "✓ Connected" => Some("connected"),
        "! Needs authentication" => Some("needs-auth"),
        "✗ Failed to connect" => Some("failed"),
        "✗ Connection error" => Some("connection-error"),
        _ => None,
    }
}

fn list_projection(stdout: &str) -> rpc::Result<Vec<Value>> {
    let mut lines = stdout.lines().filter(|line| !line.is_empty());
    match lines.next() {
        Some("No MCP servers configured. Use `claude mcp add` to add a server.")
            if lines.next().is_none() =>
        {
            return Ok(Vec::new());
        }
        Some("Checking MCP server health...") => {}
        _ => return Err(query_format()),
    }
    let mut servers = Vec::new();
    for line in lines {
        let (name, details) = line.split_once(": ").ok_or_else(query_format)?;
        reference_name(name).map_err(|_| query_format())?;
        let status = [
            "✓ Connected",
            "! Needs authentication",
            "✗ Failed to connect",
            "✗ Connection error",
        ]
        .into_iter()
        .find_map(|status| {
            details
                .strip_suffix(&format!(" - {status}"))
                .and_then(|_| probe_status(status))
        })
        .ok_or_else(query_format)?;
        servers.push(json!({"name": name, "probeStatus": status}));
    }
    if servers.is_empty() {
        return Err(query_format());
    }
    Ok(servers)
}

fn get_projection(name: &str, stdout: &str) -> rpc::Result<Value> {
    let mut lines = stdout.lines();
    if lines.next() != Some(format!("{name}:").as_str()) {
        return Err(query_format());
    }
    let scope = match lines.next() {
        Some("  Scope: Local config (private to you in this project)") => "local",
        Some("  Scope: Project config (shared via .mcp.json)") => "project",
        Some("  Scope: User config (available in all your projects)") => "user",
        Some("  Scope: Enterprise config (managed by your organization)") => "enterprise",
        Some("  Scope: Dynamic config (from command line)") => "dynamic",
        Some("  Scope: claude.ai config") => "claudeai",
        Some("  Scope: managed") => "managed",
        _ => return Err(query_format()),
    };
    let status = lines
        .next()
        .and_then(|line| line.strip_prefix("  Status: "))
        .and_then(probe_status)
        .ok_or_else(query_format)?;
    let transport = match lines.next() {
        Some("  Type: stdio") => Some("stdio"),
        Some("  Type: sse") => Some("sse"),
        Some("  Type: http") => Some("http"),
        Some("") => None, // The native handler omits type/config for internal transports.
        _ => return Err(query_format()),
    };
    Ok(json!({"name": name, "scope": scope, "transport": transport, "probeStatus": status}))
}

fn status_projection(server: &Value) -> rpc::Result<Value> {
    let name = server
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(control_format)?;
    let status = server
        .get("status")
        .and_then(Value::as_str)
        .filter(|status| {
            matches!(
                *status,
                "connected" | "failed" | "needs-auth" | "pending" | "disabled"
            )
        })
        .ok_or_else(control_format)?;
    let scope = server.get("scope").and_then(Value::as_str).filter(|scope| {
        matches!(
            *scope,
            "local" | "user" | "project" | "dynamic" | "enterprise" | "claudeai" | "managed"
        )
    });
    let transport = server
        .get("config")
        .and_then(|config| config.get("type"))
        .and_then(Value::as_str)
        .filter(|transport| {
            matches!(
                *transport,
                "stdio" | "sse" | "http" | "ws" | "sse-ide" | "ws-ide" | "sdk" | "claudeai-proxy"
            )
        });
    Ok(json!({
        "name": name, "status": status, "scope": scope, "transport": transport,
        "toolCount": server.get("tools").and_then(Value::as_array).map(Vec::len),
        "errorKind": (status == "failed").then_some("native_connection_failed"),
    }))
}
