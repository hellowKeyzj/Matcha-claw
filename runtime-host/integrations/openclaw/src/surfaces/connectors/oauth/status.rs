use connectors::ports::{ConnectorOperationFailure, McpOAuthState};
use serde::Deserialize;

#[derive(Deserialize)]
struct Server {
    name: String,
    configured: bool,
    transport: Option<String>,
    auth: Option<String>,
    #[serde(rename = "authStatus")]
    auth_status: Option<AuthStatus>,
}

#[derive(Deserialize)]
struct AuthStatus {
    state: String,
}

// Public `mcp status --json` observes credentials without connecting to MCP.
pub(super) fn decode(bytes: &[u8], name: &str) -> Result<McpOAuthState, ConnectorOperationFailure> {
    let status: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| ConnectorOperationFailure::Unknown)?;
    let servers = status
        .get("servers")
        .and_then(serde_json::Value::as_array)
        .ok_or(ConnectorOperationFailure::Unknown)?;
    let mut matches = servers
        .iter()
        .filter(|server| server.get("name").and_then(serde_json::Value::as_str) == Some(name));
    let server = matches
        .next()
        .ok_or(ConnectorOperationFailure::Unavailable)?;
    if matches.next().is_some() {
        return Err(ConnectorOperationFailure::Unknown);
    }
    let server: Server =
        serde_json::from_value(server.clone()).map_err(|_| ConnectorOperationFailure::Unknown)?;
    if server.name != name
        || !server.configured
        || !matches!(server.transport.as_deref(), Some("streamable-http" | "sse"))
        || server.auth.as_deref() != Some("oauth")
    {
        return Err(ConnectorOperationFailure::Unavailable);
    }
    match server
        .auth_status
        .as_ref()
        .map(|status| status.state.as_str())
    {
        Some("authorized") => Ok(McpOAuthState::Authorized),
        Some("requires-authorization") => Ok(McpOAuthState::AuthorizationRequired),
        Some("pending-authorization") => Ok(McpOAuthState::Authorizing),
        Some("unauthenticated") => Ok(McpOAuthState::Unauthenticated),
        _ => Err(ConnectorOperationFailure::Unknown),
    }
}
