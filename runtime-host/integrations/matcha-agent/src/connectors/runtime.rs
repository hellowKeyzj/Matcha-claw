use connectors::{
    Connector, ConnectorCatalog, ConnectorKind, ConnectorSecretResolverPort, McpAuth,
    ports::{
        ConnectorFuture, ConnectorObservation, ConnectorOperationFailure, ConnectorOps,
        ConnectorProjectionEffect, McpOAuthAction, McpOAuthReceipt, McpOAuthRequest, McpOAuthState,
        McpPreset, McpServerConfig, McpServerKind, McpServerStatusEntry,
        McpServerStatusList,
    },
};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{ConnectorError, McpConnectionState, projection};
use crate::{client::Delivery, driver::MatchaRuntimeDriver};

impl ConnectorOps for MatchaRuntimeDriver {
    fn apply_runtime_mcp_projection<'a>(
        &'a self,
        preset: Option<McpPreset<'a>>,
        catalog: ConnectorCatalog,
        secrets: &'a dyn ConnectorSecretResolverPort,
    ) -> ConnectorFuture<'a, ConnectorProjectionEffect> {
        Box::pin(async move {
            match self
                .apply_native_mcp_projection(preset, &catalog, secrets)
                .await
            {
                Ok(changed) => ConnectorProjectionEffect::Written { changed },
                Err(error)
                    if error.delivery() == Delivery::Unknown
                        || matches!(&error, ConnectorError::InvalidResponse(_))
                        || error.private_data().is_some_and(|data| {
                            data.get("commitState").and_then(Value::as_str) == Some("unresolved")
                        }) =>
                {
                    ConnectorProjectionEffect::Unknown
                }
                Err(_) => ConnectorProjectionEffect::Unavailable,
            }
        })
    }

    fn probe_external_connector<'a>(
        &'a self,
        connector: Connector,
    ) -> ConnectorFuture<'a, ConnectorObservation> {
        Box::pin(async move {
            if !connector.enabled() {
                return ConnectorObservation::Disabled;
            }
            // Native health commands require an Agent/workspace. A global connector has
            // neither; do not select a session or implement a second MCP network client.
            match connector.kind() {
                ConnectorKind::McpStdio | ConnectorKind::McpHttp => ConnectorObservation::Unknown,
                _ => ConnectorObservation::Unsupported,
            }
        })
    }

    fn mcp_oauth<'a>(
        &'a self,
        connector: Connector,
        request: McpOAuthRequest,
    ) -> ConnectorFuture<'a, Result<McpOAuthReceipt, ConnectorOperationFailure>> {
        Box::pin(async move {
            if connector.kind() != ConnectorKind::McpHttp
                || connector.auth() != Some(McpAuth::OAuth)
                || !connector.enabled()
                || connector.id() == "matcha"
                || matches!(request.action, McpOAuthAction::Start) && request.flow_id.is_some()
            {
                return Err(ConnectorOperationFailure::Unavailable);
            }
            let agent = request.agent_id.as_deref().filter(|id| {
                !id.trim().is_empty() && !id.chars().any(char::is_control)
            }).ok_or(ConnectorOperationFailure::Unavailable)?;
            let method = match request.action {
                McpOAuthAction::Start => "mcp.oauth.start",
                McpOAuthAction::Status => "mcp.oauth.status",
                McpOAuthAction::Logout => "mcp.oauth.logout",
            };
            let mut params = json!({"agentId":agent,"name":projection::server_name(connector.id())});
            if let Some(flow) = request.flow_id.as_deref() {
                if uuid::Uuid::parse_str(flow).is_err() {
                    return Err(ConnectorOperationFailure::Unavailable);
                }
                params["flowId"] = json!(flow);
            }
            let response = self.native_client().call(method, params).await
                .map_err(ConnectorError::from).map_err(operation_failure)?;
            let receipt: McpOAuthReceipt = serde_json::from_value(response)
                .map_err(|_| ConnectorOperationFailure::Unknown)?;
            if receipt.flow_id.as_ref().is_some_and(|flow| uuid::Uuid::parse_str(flow).is_err())
                || matches!(request.action, McpOAuthAction::Start) && receipt.flow_id.is_none()
                || matches!(request.action, McpOAuthAction::Logout) && receipt.flow_id.is_some()
                || request.flow_id.as_ref().is_some_and(|flow| {
                    !matches!(request.action, McpOAuthAction::Logout) && receipt.flow_id.as_ref() != Some(flow)
                })
                || receipt.authorization_url.as_ref().is_some_and(|url| {
                    !matches!(receipt.state, McpOAuthState::Authorizing)
                        || !safe_authorization_url(url)
                })
            {
                return Err(ConnectorOperationFailure::Unknown);
            }
            Ok(receipt)
        })
    }

    fn list_mcp_servers<'a>(
        &'a self,
    ) -> ConnectorFuture<'a, Result<Vec<McpServerConfig>, ConnectorOperationFailure>> {
        Box::pin(async move {
            self.configured_mcp_servers()
                .await
                .map_err(operation_failure)
        })
    }

    fn observe_mcp_server_status<'a>(
        &'a self,
        agent_id: String,
        session_key: String,
    ) -> ConnectorFuture<'a, Result<McpServerStatusList, ConnectorOperationFailure>> {
        Box::pin(async move {
            let session_id = self
                .mcp_session_id(&agent_id, &session_key)
                .await
                .map_err(operation_failure)?;
            let status = self
                .native_mcp_status(&session_id)
                .await
                .map_err(operation_failure)?;
            Ok(McpServerStatusList {
                servers: status
                    .servers
                    .into_iter()
                    .map(|server| {
                        let (state, available, enabled) = match server.status {
                            McpConnectionState::Connected => ("connected", Some(true), Some(true)),
                            McpConnectionState::Failed => ("error", Some(false), Some(true)),
                            McpConnectionState::NeedsAuth => {
                                ("not-connected", Some(false), Some(true))
                            }
                            McpConnectionState::Pending => ("listing-tools", None, Some(true)),
                            McpConnectionState::Disabled => ("disabled", Some(false), Some(false)),
                        };
                        McpServerStatusEntry {
                            name: server.name,
                            launch_summary: None,
                            tool_count: server.tool_count,
                            available,
                            enabled,
                            state: Some(state.into()),
                        }
                    })
                    .collect(),
                next_cursor: None,
            })
        })
    }

    fn set_mcp_session_server_enabled<'a>(
        &'a self,
        agent_id: String,
        session_key: String,
        server_name: String,
        enabled: bool,
    ) -> ConnectorFuture<'a, Result<(), ConnectorOperationFailure>> {
        Box::pin(async move {
            let session_id = self
                .mcp_session_id(&agent_id, &session_key)
                .await
                .map_err(operation_failure)?;
            self.native_mcp_toggle(&session_id, &server_name, enabled)
                .await
                .map(|_| ())
                .map_err(operation_failure)
        })
    }
}

impl MatchaRuntimeDriver {
    pub async fn apply_native_mcp_projection(
        &self,
        preset: Option<McpPreset<'_>>,
        catalog: &ConnectorCatalog,
        resolver: &dyn ConnectorSecretResolverPort,
    ) -> Result<bool, ConnectorError> {
        let params = projection::params(preset, catalog, resolver).await?;
        let response = self.native_client().call("mcp.config.set", params).await?;
        #[derive(Deserialize)]
        struct Receipt {
            persisted: bool,
            changed: bool,
            projection: String,
            live: String,
        }
        let receipt: Receipt = serde_json::from_value(response.clone())
            .map_err(|_| ConnectorError::InvalidResponse(response.clone()))?;
        if !receipt.persisted || receipt.projection != "nextLaunch" || receipt.live != "notApplied"
        {
            return Err(ConnectorError::InvalidResponse(response));
        }
        Ok(receipt.changed)
    }

    async fn configured_mcp_servers(&self) -> Result<Vec<McpServerConfig>, ConnectorError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Configuration {
            servers: Vec<Server>,
            configuration_only: bool,
            scope: String,
        }
        #[derive(Deserialize)]
        struct Server {
            name: String,
            transport: String,
            enabled: bool,
        }
        let response = self
            .native_client()
            .call("mcp.config.get", json!({}))
            .await?;
        let configuration: Configuration = serde_json::from_value(response.clone())
            .map_err(|_| ConnectorError::InvalidResponse(response.clone()))?;
        if !configuration.configuration_only
            || configuration.scope != "hostManagedOverlay"
            || configuration.servers.iter().any(|server| {
                server.name.is_empty()
                    || !matches!(server.transport.as_str(), "stdio" | "http" | "sse")
            })
        {
            return Err(ConnectorError::InvalidResponse(response));
        }
        Ok(configuration
            .servers
            .into_iter()
            .map(|server| McpServerConfig {
                server_id: server.name,
                kind: if server.transport == "stdio" {
                    McpServerKind::McpStdio
                } else {
                    McpServerKind::McpHttp
                },
                enabled: server.enabled,
            })
            .collect())
    }

    async fn mcp_session_id(
        &self,
        target_agent_id: &str,
        session_key: &str,
    ) -> Result<String, ConnectorError> {
        let (agent_id, session_id) = crate::session::projection::parse_session_key(session_key)
            .ok_or(ConnectorError::InvalidSessionKey)?;
        if agent_id != target_agent_id {
            return Err(ConnectorError::InvalidSessionKey);
        }
        let response = self
            .native_client()
            .call("sessions.get", json!({"sessionId":session_id}))
            .await?;
        if response.get("agentId").and_then(Value::as_str) != Some(agent_id)
            || response.get("sessionId").and_then(Value::as_str) != Some(session_id)
        {
            return Err(ConnectorError::InvalidResponse(response));
        }
        Ok(session_id.into())
    }
}

fn safe_authorization_url(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else { return false; };
    matches!(url.scheme(), "http" | "https") && url.host_str().is_some()
        && url.username().is_empty() && url.password().is_none() && url.fragment().is_none()
        && value.len() <= 16 * 1024 && !value.chars().any(char::is_control)
        && url.query_pairs().all(|(key, _)| {
            let key = key.to_ascii_lowercase().replace(['-', '_'], "");
            !key.contains("token") && !key.contains("secret") && !key.contains("password")
                && !key.contains("apikey") && key != "code" && key != "authorization"
        })
}

fn operation_failure(error: ConnectorError) -> ConnectorOperationFailure {
    if error.delivery() == Delivery::Unknown || matches!(error, ConnectorError::InvalidResponse(_)) {
        ConnectorOperationFailure::Unknown
    } else {
        ConnectorOperationFailure::Unavailable
    }
}
