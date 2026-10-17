mod projection;
mod runtime;

use std::fmt;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::{client, driver::MatchaRuntimeDriver};

pub enum ConnectorError {
    Remote(client::Error),
    InvalidResponse(Value),
    UnsupportedConfiguration,
    SecretUnavailable,
    InvalidSessionKey,
}

impl ConnectorError {
    pub fn code(&self) -> Option<i64> {
        match self {
            Self::Remote(error) => error.code(),
            _ => None,
        }
    }

    pub fn kind(&self) -> &str {
        match self {
            Self::Remote(error) => error.kind(),
            Self::InvalidResponse(_) => "mcp_response_invalid",
            Self::UnsupportedConfiguration => "mcp_configuration_unsupported",
            Self::SecretUnavailable => "mcp_secret_unavailable",
            Self::InvalidSessionKey => "mcp_session_key_invalid",
        }
    }

    /// Remote payloads are private adapter evidence, never public errors/diagnostics.
    pub fn private_data(&self) -> Option<&Value> {
        match self {
            Self::Remote(error) => error.data(),
            Self::InvalidResponse(response) => Some(response),
            _ => None,
        }
    }

    pub fn delivery(&self) -> client::Delivery {
        match self {
            Self::Remote(error) => error.delivery(),
            Self::InvalidResponse(_) => client::Delivery::ResponseReceived,
            _ => client::Delivery::NotSent,
        }
    }
}

impl fmt::Debug for ConnectorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ConnectorError")
            .field("code", &self.code())
            .field("delivery", &self.delivery())
            .finish_non_exhaustive()
    }
}

impl fmt::Display for ConnectorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Native MCP operation failed; inspect private delivery evidence")
    }
}

impl std::error::Error for ConnectorError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Remote(error) => Some(error),
            _ => None,
        }
    }
}

impl From<client::Error> for ConnectorError {
    fn from(error: client::Error) -> Self {
        Self::Remote(error)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSessionStatus {
    pub session_id: String,
    pub instance_id: String,
    pub servers: Vec<McpServerStatus>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub name: String,
    pub status: McpConnectionState,
    pub transport: Option<String>,
    pub scope: Option<String>,
    pub tool_count: Option<u64>,
}

#[derive(Clone, Copy, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum McpConnectionState {
    Connected,
    Failed,
    NeedsAuth,
    Pending,
    Disabled,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpControlReceipt {
    pub session_id: String,
    pub instance_id: String,
    pub name: String,
    pub acknowledged: bool,
    pub connection_state: String,
    pub enabled_requested: Option<bool>,
    pub native_project_choice: Option<String>,
}

// A transient browser handoff only. Do not log or persist auth_url/callback URLs.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpOAuthReceipt {
    pub session_id: String,
    pub instance_id: String,
    pub name: String,
    pub phase: String,
    pub requires_user_action: Option<bool>,
    pub auth_url: Option<String>,
    pub reconnect_required: Option<bool>,
    pub connection_state: String,
}

impl MatchaRuntimeDriver {
    pub async fn native_mcp_status(
        &self,
        session_id: &str,
    ) -> Result<McpSessionStatus, ConnectorError> {
        let response = self
            .native_client()
            .call("mcp.status", json!({"sessionId": session_id}))
            .await?;
        let status: McpSessionStatus = serde_json::from_value(response.clone())
            .map_err(|_| ConnectorError::InvalidResponse(response.clone()))?;
        if status.session_id != session_id
            || status.instance_id.is_empty()
            || status.servers.iter().any(|server| server.name.is_empty())
        {
            return Err(ConnectorError::InvalidResponse(response));
        }
        Ok(status)
    }

    pub async fn native_mcp_reconnect(
        &self,
        session_id: &str,
        name: &str,
    ) -> Result<McpControlReceipt, ConnectorError> {
        self.mcp_control("mcp.reconnect", session_id, name, None)
            .await
    }

    pub async fn native_mcp_toggle(
        &self,
        session_id: &str,
        name: &str,
        enabled: bool,
    ) -> Result<McpControlReceipt, ConnectorError> {
        self.mcp_control("mcp.toggle", session_id, name, Some(enabled))
            .await
    }

    async fn mcp_control(
        &self,
        method: &str,
        session_id: &str,
        name: &str,
        enabled: Option<bool>,
    ) -> Result<McpControlReceipt, ConnectorError> {
        let mut params = json!({"sessionId": session_id, "name": name});
        if let Some(enabled) = enabled {
            params["enabled"] = json!(enabled);
        }
        let response = self.native_client().call(method, params).await?;
        let receipt: McpControlReceipt = serde_json::from_value(response.clone())
            .map_err(|_| ConnectorError::InvalidResponse(response.clone()))?;
        if receipt.session_id != session_id
            || receipt.instance_id.is_empty()
            || receipt.name != name
            || !receipt.acknowledged
            || receipt.connection_state != "not_observed"
            || receipt.enabled_requested != enabled
        {
            return Err(ConnectorError::InvalidResponse(response));
        }
        Ok(receipt)
    }

    pub async fn native_mcp_authenticate(
        &self,
        session_id: &str,
        name: &str,
        callback_url: Option<&str>,
    ) -> Result<McpOAuthReceipt, ConnectorError> {
        let response = self
            .native_client()
            .call(
                "mcp.authenticate",
                json!({"sessionId": session_id, "name": name, "callbackUrl": callback_url}),
            )
            .await?;
        let receipt: McpOAuthReceipt = serde_json::from_value(response.clone())
            .map_err(|_| ConnectorError::InvalidResponse(response.clone()))?;
        if receipt.session_id != session_id
            || receipt.instance_id.is_empty()
            || receipt.name != name
            || receipt.connection_state != "not_observed"
            || if callback_url.is_some() {
                receipt.phase != "callback_acknowledged"
                    || receipt.reconnect_required != Some(true)
                    || receipt.auth_url.is_some()
            } else {
                receipt.phase != "native_flow_started"
                    || receipt.requires_user_action.is_none()
                    || (receipt.requires_user_action == Some(true)) != receipt.auth_url.is_some()
            }
        {
            return Err(ConnectorError::InvalidResponse(response));
        }
        Ok(receipt)
    }
}
