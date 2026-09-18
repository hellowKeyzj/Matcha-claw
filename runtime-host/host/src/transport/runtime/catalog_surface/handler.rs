use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use ::clawhub::ClawHubRegistryClient;
use serde_json::Value;
use tokio::sync::Mutex;

use crate::{
    facade::{AgentsHandle, PluginsHandle, SkillsHandle},
    transport::{
        common::authorization::CapabilityDecisionVerifier,
        connectors::external::{self as external_connectors},
        localhost,
        providers::{models::ProviderModelsDelivery, routing::ProviderRoutingDelivery},
        runtime::openclaw_mcp_servers,
        skills::{
            bundle as skill_bundle,
            clawhub_search::{self, Delivery as ClawHubSearchDelivery},
            clawhub_skill::{self, Delivery as ClawHubSkillDelivery},
            management as skills, plugins, sealed_resource,
        },
    },
};

use super::{
    clawhub, connectors, plugins as plugin_surface, projection, provider, skills as skills_surface,
};

pub(super) const ENDPOINT: &str = "/api/provider-models";
pub(super) const SELECTABLE_ENDPOINT: &str = "/api/provider-models/selectable";
pub(super) const AUTHORIZATION_SCOPE: &str = "providers:models";
pub(super) const AUTHORIZATION_SUBJECT: &str = "provider-models";
pub(super) const AUTHORIZATION_HEADER: &str = "authorization";
pub(super) const BEARER_PREFIX: &str = "Bearer ";

pub(crate) async fn handle(
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::provider::ProviderHandle,
    skills: SkillsHandle,
    agents: AgentsHandle,
    clawhub_registry: ClawHubRegistryClient,
    plugins: PluginsHandle,
    connector_handle: crate::connectors::ConnectorHandle,
) -> localhost::Response {
    handle_request(
        method,
        path,
        headers,
        body,
        verifier,
        owner,
        skills,
        agents,
        clawhub_registry,
        plugins,
        connector_handle,
    )
    .await
    .into()
}

async fn handle_request(
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::provider::ProviderHandle,
    skills: SkillsHandle,
    agents: AgentsHandle,
    clawhub_registry: ClawHubRegistryClient,
    plugins: PluginsHandle,
    connector_handle: crate::connectors::ConnectorHandle,
) -> Response {
    let request = Request {
        method: method.to_owned(),
        path: path.to_owned(),
        headers: headers.to_vec(),
        body: body.to_vec(),
    };
    if request.method == "GET" {
        let path = request
            .path
            .split_once('?')
            .map_or(request.path.as_str(), |(path, _)| path)
            .to_owned();
        let query = request
            .path
            .split_once('?')
            .map_or("", |(_, query)| query)
            .to_owned();
        match path.as_str() {
            ENDPOINT => {
                return provider::handle_models_get_list(request, &query, verifier, owner).await;
            }
            SELECTABLE_ENDPOINT => {
                return provider::handle_models_get_selectable(request, &query, verifier, owner)
                    .await;
            }
            _ => {}
        }
    }
    match request.path.as_str() {
        ENDPOINT if request.method == "POST" => {
            provider::handle_models_post(request, verifier, owner).await
        }
        "/api/provider-routing" if request.method == "POST" => {
            provider::handle_routing(request, verifier, owner).await
        }
        plugins::CATALOG_ENDPOINT if request.method == "GET" => {
            plugin_surface::handle_catalog(request, verifier, plugins).await
        }
        plugins::RUNTIME_ENDPOINT if request.method == "GET" => {
            plugin_surface::handle_runtime(request, verifier, plugins).await
        }
        plugins::CONFIGURATION_ENDPOINT if request.method == "POST" => {
            plugin_surface::handle_configuration(request, verifier, plugins).await
        }
        plugins::OPERATION_ENDPOINT if request.method == "POST" => {
            plugin_surface::handle_operation(request, verifier, plugins).await
        }
        skills::ENDPOINT if request.method == "GET" => {
            skills_surface::handle_status(request, verifier, skills).await
        }
        skills::DETAIL_ENDPOINT
        | skills::CONFIG_ENDPOINT
        | skills::CLAWHUB_INSTALL_ENDPOINT
        | skills::CLAWHUB_UPDATE_ENDPOINT
        | skills::UPLOAD_BEGIN_ENDPOINT
        | skills::UPLOAD_CHUNK_ENDPOINT
        | skills::UPLOAD_COMMIT_ENDPOINT
        | skills::UNINSTALL_ENDPOINT
        | skills::IMPORT_MARKDOWN_ENDPOINT
        | skills::IMPORT_BUNDLE_ENDPOINT
        | skills::README_ENDPOINT
            if request.method == "POST" =>
        {
            skills_surface::handle_management(request, verifier, skills).await
        }
        clawhub_search::ENDPOINT if request.method == "POST" => {
            clawhub::handle_search(request, verifier, clawhub_registry).await
        }
        clawhub_skill::ENDPOINT if request.method == "POST" => {
            clawhub::handle_skill_install(request, verifier, skills).await
        }
        skill_bundle::EXPORT_ENDPOINT if request.method == "POST" => {
            skills_surface::handle_bundle_export(request, verifier, skills).await
        }
        skill_bundle::IMPORT_ENDPOINT if request.method == "POST" => {
            skills_surface::handle_bundle_import(request, verifier, skills).await
        }
        sealed_resource::STATUS_ENDPOINT if request.method == "GET" => {
            projection::handle_sealed_resource(request, verifier, skills, agents).await
        }
        path if request.method == "GET"
            && (path.starts_with(sealed_resource::READ_ENDPOINT_PREFIX)
                || path.starts_with(sealed_resource::AGENT_READ_ENDPOINT_PREFIX)) =>
        {
            projection::handle_sealed_resource(request, verifier, skills, agents).await
        }
        sealed_resource::EXPORT_ENDPOINT
        | sealed_resource::INSTALL_ENDPOINT
        | sealed_resource::UNINSTALL_ENDPOINT
            if request.method == "POST" =>
        {
            projection::handle_sealed_resource(request, verifier, skills, agents).await
        }
        external_connectors::ENDPOINT if request.method == "POST" => {
            connectors::handle_external_connectors(request, verifier, connector_handle).await
        }
        openclaw_mcp_servers::ENDPOINT if request.method == "POST" => {
            connectors::handle_openclaw_mcp_servers(request, verifier, connector_handle).await
        }
        _ => Response::not_found(&request.path),
    }
}

pub(super) struct Request {
    pub(super) method: String,
    pub(super) path: String,
    pub(super) headers: Vec<(String, String)>,
    pub(super) body: Vec<u8>,
}

pub(super) struct Response {
    pub(super) status: u16,
    pub(super) body: Value,
}

impl From<Response> for localhost::Response {
    fn from(response: Response) -> Self {
        Self::json(response.status, response.body)
    }
}

impl Response {
    pub(super) fn bad_request() -> Self {
        Self::fixed(400, "Provider model request is invalid")
    }

    pub(super) fn unauthorized() -> Self {
        Self::fixed(401, "Provider model authorization is invalid")
    }

    pub(super) fn not_found(path: &str) -> Self {
        match path {
            "/api/provider-routing" => Self::fixed(404, "Provider routing route is not available"),
            clawhub_search::ENDPOINT => Self::fixed(404, "ClawHub search route is not available"),
            clawhub_skill::ENDPOINT => {
                Self::fixed(404, "ClawHub skill install route is not available")
            }
            skills::ENDPOINT => Self::fixed(404, "Skills status route is not available"),
            skills::DETAIL_ENDPOINT
            | skills::CONFIG_ENDPOINT
            | skills::CLAWHUB_INSTALL_ENDPOINT
            | skills::CLAWHUB_UPDATE_ENDPOINT
            | skills::UPLOAD_BEGIN_ENDPOINT
            | skills::UPLOAD_CHUNK_ENDPOINT
            | skills::UPLOAD_COMMIT_ENDPOINT
            | skills::UNINSTALL_ENDPOINT
            | skills::IMPORT_MARKDOWN_ENDPOINT
            | skills::IMPORT_BUNDLE_ENDPOINT
            | skills::README_ENDPOINT => {
                Self::fixed(404, "Skills management route is not available")
            }
            skill_bundle::EXPORT_ENDPOINT | skill_bundle::IMPORT_ENDPOINT => {
                Self::fixed(404, "Subagent skill bundle route is not available")
            }
            sealed_resource::STATUS_ENDPOINT
            | sealed_resource::EXPORT_ENDPOINT
            | sealed_resource::INSTALL_ENDPOINT
            | sealed_resource::UNINSTALL_ENDPOINT => {
                Self::fixed(404, "Sealed skills route is not available")
            }
            path if path.starts_with(sealed_resource::READ_ENDPOINT_PREFIX)
                || path.starts_with(sealed_resource::AGENT_READ_ENDPOINT_PREFIX) =>
            {
                Self::fixed(404, "Sealed resource route is not available")
            }
            external_connectors::ENDPOINT => {
                Self::fixed(404, "External connector route is not available")
            }
            openclaw_mcp_servers::ENDPOINT => {
                Self::fixed(404, "OpenClaw MCP servers route is not available")
            }
            _ => Self::fixed(404, "Provider model route is not available"),
        }
    }

    pub(super) fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }

    pub(super) fn from_provider_models_delivery(delivery: ProviderModelsDelivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
    }

    pub(super) fn external_connectors_bad_request() -> Self {
        Self::fixed(400, "External connector request is invalid")
    }

    pub(super) fn external_connectors_unauthorized() -> Self {
        Self::fixed(401, "External connector authorization is invalid")
    }

    pub(super) fn from_external_connectors_delivery(
        delivery: external_connectors::Delivery,
    ) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
    }

    pub(super) fn openclaw_mcp_servers_bad_request() -> Self {
        Self::fixed(400, "OpenClaw MCP servers request is invalid")
    }

    pub(super) fn openclaw_mcp_servers_unauthorized() -> Self {
        Self::fixed(401, "OpenClaw MCP servers authorization is invalid")
    }

    pub(super) fn from_openclaw_mcp_servers_delivery(
        delivery: openclaw_mcp_servers::Delivery,
    ) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
    }

    pub(super) fn provider_routing_bad_request() -> Self {
        Self::fixed(400, "Provider routing request is invalid")
    }

    pub(super) fn provider_routing_unauthorized() -> Self {
        Self::fixed(401, "Provider routing authorization is invalid")
    }

    pub(super) fn from_provider_routing_delivery(delivery: ProviderRoutingDelivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
    }

    pub(super) fn clawhub_search_bad_request() -> Self {
        Self::fixed(400, clawhub_search::invalid_request_error())
    }

    pub(super) fn clawhub_search_unauthorized() -> Self {
        Self::fixed(401, "ClawHub search authorization is invalid")
    }

    pub(super) fn from_clawhub_search_delivery(delivery: ClawHubSearchDelivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
    }

    pub(super) fn clawhub_skill_bad_request() -> Self {
        Self::fixed(400, "ClawHub skill install request is invalid")
    }

    pub(super) fn clawhub_skill_unauthorized() -> Self {
        Self::fixed(401, "ClawHub skill install authorization is invalid")
    }

    pub(super) fn skills_unauthorized() -> Self {
        Self::fixed(401, "Skills status authorization is invalid")
    }

    pub(super) fn skills_unavailable() -> Self {
        Self {
            status: 503,
            body: serde_json::json!({ "outcome": "unknown" }),
        }
    }

    pub(super) fn skills_rejected() -> Self {
        Self {
            status: 400,
            body: serde_json::json!({ "outcome": "rejected" }),
        }
    }

    pub(super) fn skills_management_unauthorized() -> Self {
        Self::fixed(401, "Skills management authorization is invalid")
    }

    pub(super) fn from_clawhub_skill_delivery(delivery: ClawHubSkillDelivery) -> Self {
        Self {
            status: 200,
            body: delivery.body(),
        }
    }

    pub(super) fn skill_bundle_bad_request() -> Self {
        Self::fixed(400, "Subagent skill bundle request is invalid")
    }

    pub(super) fn skill_bundle_unauthorized() -> Self {
        Self::fixed(401, "Subagent skill bundle authorization is invalid")
    }

    pub(super) fn skill_bundle_delivery(body: Value) -> Self {
        Self { status: 200, body }
    }

    pub(super) fn sealed_resource_rejected() -> Self {
        Self {
            status: 400,
            body: serde_json::json!({ "outcome": "rejected" }),
        }
    }

    pub(super) fn sealed_resource_unauthorized() -> Self {
        Self::fixed(401, "Sealed resource authorization is invalid")
    }

    pub(super) fn sealed_resource_unavailable() -> Self {
        Self {
            status: 503,
            body: serde_json::json!({ "outcome": "unknown" }),
        }
    }
}

pub(super) fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
