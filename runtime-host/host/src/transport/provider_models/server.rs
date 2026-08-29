use std::{
    io,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use clawhub::ClawHubRegistryClient;
use serde_json::Value;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Mutex,
    time::timeout,
};

use crate::{
    facade::{PluginsHandle, SkillsHandle},
    transport::authorization::CapabilityDecisionVerifier,
};

use super::{ProviderModelsCommand, ProviderModelsDelivery, ProviderModelsRequest, RequestError};

use crate::transport::{
    clawhub_search::{self, Delivery as ClawHubSearchDelivery},
    clawhub_skill::{self, Delivery as ClawHubSkillDelivery},
    provider_routing::{self, ProviderRoutingDelivery},
    skill_bundle, skills,
};
use crate::transport::{external_connectors, plugins};

const ENDPOINT: &str = "/api/provider-models";
const SELECTABLE_ENDPOINT: &str = "/api/provider-models/selectable";
const AUTHORIZATION_SCOPE: &str = "providers:models";
const AUTHORIZATION_SUBJECT: &str = "provider-models";
const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_HEADERS: usize = 32;
const REQUEST_DEADLINE: Duration = Duration::from_secs(5);
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";

pub(crate) struct Server {
    listener: TcpListener,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::provider::ProviderHandle,
    skills: SkillsHandle,
    clawhub_registry: ClawHubRegistryClient,
    plugins: PluginsHandle,
    connector_handle: crate::connectors::ConnectorHandle,
}

impl Server {
    pub(crate) async fn bind(
        port: u16,
        verifier: CapabilityDecisionVerifier,
        owner: crate::provider::ProviderHandle,
        skills: SkillsHandle,
        clawhub_registry: ClawHubRegistryClient,
        plugins: PluginsHandle,
        connector_handle: crate::connectors::ConnectorHandle,
    ) -> io::Result<Self> {
        Ok(Self {
            listener: TcpListener::bind(("127.0.0.1", port)).await?,
            verifier: Arc::new(Mutex::new(verifier)),
            owner,
            skills,
            clawhub_registry,
            plugins,
            connector_handle,
        })
    }

    pub(crate) async fn run(self) -> io::Result<()> {
        loop {
            let (stream, _) = self.listener.accept().await?;
            let verifier = Arc::clone(&self.verifier);
            let owner = self.owner.clone();
            let skills = self.skills.clone();
            let clawhub_registry = self.clawhub_registry.clone();
            let plugins = self.plugins.clone();
            let connector_handle = self.connector_handle.clone();
            tokio::spawn(async move {
                let _ = serve(
                    stream,
                    verifier,
                    owner,
                    skills,
                    clawhub_registry,
                    plugins,
                    connector_handle,
                )
                .await;
            });
        }
    }

    #[cfg(test)]
    fn port(&self) -> u16 {
        self.listener
            .local_addr()
            .expect("provider models listener address")
            .port()
    }
}

async fn serve(
    mut stream: TcpStream,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::provider::ProviderHandle,
    skills: SkillsHandle,
    clawhub_registry: ClawHubRegistryClient,
    plugins: PluginsHandle,
    connector_handle: crate::connectors::ConnectorHandle,
) -> io::Result<()> {
    let response = match timeout(REQUEST_DEADLINE, async {
        let request = read_request(&mut stream).await?;
        Ok::<_, io::Error>(match request {
            Ok(request) => {
                handle(
                    request,
                    verifier,
                    owner,
                    skills,
                    clawhub_registry,
                    plugins,
                    connector_handle,
                )
                .await
            }
            Err(response) => response,
        })
    })
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => return Err(error),
        Err(_) => Response::bad_request(),
    };
    write_response(&mut stream, response).await
}

async fn handle(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::provider::ProviderHandle,
    skills: SkillsHandle,
    clawhub_registry: ClawHubRegistryClient,
    plugins: PluginsHandle,
    connector_handle: crate::connectors::ConnectorHandle,
) -> Response {
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
            ENDPOINT => return handle_get_list(request, &query, verifier, owner).await,
            SELECTABLE_ENDPOINT => {
                return handle_get_selectable(request, &query, verifier, owner).await;
            }
            _ => {}
        }
    }
    match request.path.as_str() {
        ENDPOINT if request.method == "POST" => {
            handle_provider_models(request, verifier, owner).await
        }
        "/api/provider-routing" if request.method == "POST" => {
            handle_provider_routing(request, verifier, owner).await
        }
        plugins::CATALOG_ENDPOINT if request.method == "GET" => {
            handle_plugin_catalog(request, verifier, plugins).await
        }
        plugins::RUNTIME_ENDPOINT if request.method == "GET" => {
            handle_plugin_runtime(request, verifier, plugins).await
        }
        plugins::CONFIGURATION_ENDPOINT if request.method == "POST" => {
            handle_plugin_configuration(request, verifier, plugins).await
        }
        plugins::OPERATION_ENDPOINT if request.method == "POST" => {
            handle_plugin_operation(request, verifier, plugins).await
        }
        skills::ENDPOINT if request.method == "GET" => {
            handle_skills_status(request, verifier, skills).await
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
            handle_skills_management(request, verifier, skills).await
        }
        clawhub_search::ENDPOINT if request.method == "POST" => {
            handle_clawhub_search(request, verifier, clawhub_registry).await
        }
        clawhub_skill::ENDPOINT if request.method == "POST" => {
            handle_clawhub_skill_install(request, verifier, skills).await
        }
        skill_bundle::EXPORT_ENDPOINT if request.method == "POST" => {
            handle_skill_bundle_export(request, verifier, skills).await
        }
        skill_bundle::IMPORT_ENDPOINT if request.method == "POST" => {
            handle_skill_bundle_import(request, verifier, skills).await
        }
        external_connectors::ENDPOINT if request.method == "POST" => {
            handle_external_connectors(request, verifier, connector_handle).await
        }
        _ => Response::not_found(&request.path),
    }
}

async fn handle_get_list(
    request: Request,
    query: &str,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::provider::ProviderHandle,
) -> Response {
    if !query.is_empty() || !request.body.is_empty() {
        return Response::bad_request();
    }
    if !verify_get_authorization(&request.headers, &verifier, ENDPOINT, "providerModels.list").await
    {
        return Response::unauthorized();
    }
    let delivery = owner
        .list_provider_models()
        .await
        .map(ProviderModelsDelivery::List)
        .unwrap_or(ProviderModelsDelivery::Unavailable);
    Response::from_delivery(delivery)
}

async fn handle_get_selectable(
    request: Request,
    query: &str,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::provider::ProviderHandle,
) -> Response {
    if !request.body.is_empty() {
        return Response::bad_request();
    }
    let Some(capability) = parse_capability_query(query) else {
        return Response::bad_request();
    };
    if !verify_get_authorization(
        &request.headers,
        &verifier,
        SELECTABLE_ENDPOINT,
        "providerModels.listSelectable",
    )
    .await
    {
        return Response::unauthorized();
    }
    let delivery = owner
        .selectable_provider_models(capability)
        .await
        .map(ProviderModelsDelivery::Selectable)
        .unwrap_or(ProviderModelsDelivery::Unavailable);
    Response::from_delivery(delivery)
}

fn parse_capability_query(query: &str) -> Option<environment::ProviderModelCapability> {
    let (key, value) = query.split_once('=')?;
    if key != "capability" || value.is_empty() || value.contains('=') || value.contains('&') {
        return None;
    }
    super::capability_for(value)
}

async fn verify_get_authorization(
    headers: &[(String, String)],
    verifier: &Arc<Mutex<CapabilityDecisionVerifier>>,
    endpoint: &str,
    capability: &str,
) -> bool {
    let Some(token) = authorization(headers) else {
        return false;
    };
    verifier
        .lock()
        .await
        .verify(
            token,
            now_millis(),
            endpoint,
            AUTHORIZATION_SCOPE,
            capability,
            AUTHORIZATION_SUBJECT,
        )
        .is_ok()
}

fn authorization(headers: &[(String, String)]) -> Option<&str> {
    headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
}

async fn handle_provider_models(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::provider::ProviderHandle,
) -> Response {
    let Some(authorization) = request
        .headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        return Response::unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => return Response::bad_request(),
    };
    let mut verifier = verifier.lock().await;
    let command =
        match ProviderModelsRequest::decode(value, authorization, &mut verifier, now_millis())
            .and_then(ProviderModelsRequest::into_command)
        {
            Ok(command) => command,
            Err(RequestError::Invalid) => return Response::bad_request(),
            Err(RequestError::Unauthorized) => return Response::unauthorized(),
            Err(RequestError::Unavailable) => {
                return Response::fixed(503, "Provider models are unavailable");
            }
        };
    drop(verifier);
    let delivery = match command {
        ProviderModelsCommand::List => owner
            .list_provider_models()
            .await
            .map(ProviderModelsDelivery::List),
        ProviderModelsCommand::Selectable(capability) => owner
            .selectable_provider_models(capability)
            .await
            .map(ProviderModelsDelivery::Selectable),
        ProviderModelsCommand::Replace { account_id, models } => owner
            .replace_provider_models(account_id, models)
            .await
            .map(ProviderModelsDelivery::Replace),
    }
    .unwrap_or(ProviderModelsDelivery::Unavailable);
    Response::from_delivery(delivery)
}

async fn handle_plugin_catalog(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    plugins: PluginsHandle,
) -> Response {
    match plugins::catalog(&request.headers, verifier, plugins, now_millis()).await {
        Ok(body) => Response { status: 200, body },
        Err(plugins::RequestError::Invalid) => {
            Response::fixed(503, "Plugin catalog is unavailable")
        }
        Err(plugins::RequestError::Unauthorized) => {
            Response::fixed(401, "Plugin authorization is invalid")
        }
    }
}

async fn handle_plugin_runtime(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    plugins: PluginsHandle,
) -> Response {
    match plugins::runtime(&request.headers, verifier, plugins, now_millis()).await {
        Ok(body) => Response { status: 200, body },
        Err(plugins::RequestError::Invalid) => {
            Response::fixed(503, "Plugin runtime is unavailable")
        }
        Err(plugins::RequestError::Unauthorized) => {
            Response::fixed(401, "Plugin authorization is invalid")
        }
    }
}

async fn handle_plugin_configuration(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    plugins: PluginsHandle,
) -> Response {
    match plugins::configuration(
        &request.headers,
        &request.body,
        verifier,
        plugins,
        now_millis(),
    )
    .await
    {
        Ok(body) => Response { status: 200, body },
        Err(plugins::RequestError::Invalid) => {
            Response::fixed(400, "Plugin configuration request is invalid")
        }
        Err(plugins::RequestError::Unauthorized) => {
            Response::fixed(401, "Plugin authorization is invalid")
        }
    }
}

async fn handle_plugin_operation(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    plugins: PluginsHandle,
) -> Response {
    match plugins::operation(
        &request.headers,
        &request.body,
        verifier,
        plugins,
        now_millis(),
    )
    .await
    {
        Ok(body) => Response { status: 200, body },
        Err(plugins::RequestError::Invalid) => {
            Response::fixed(400, "Plugin operation request is invalid")
        }
        Err(plugins::RequestError::Unauthorized) => {
            Response::fixed(401, "Plugin authorization is invalid")
        }
    }
}

async fn handle_external_connectors(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    connector_handle: crate::connectors::ConnectorHandle,
) -> Response {
    let Some(authorization) = request
        .headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        return Response::external_connectors_unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => return Response::external_connectors_bad_request(),
    };
    let command = {
        let mut verifier = verifier.lock().await;
        match external_connectors::Request::decode(
            value,
            authorization,
            &mut verifier,
            now_millis(),
        ) {
            Ok(request) => request.into_command(),
            Err(external_connectors::RequestError::Invalid) => {
                return Response::external_connectors_bad_request();
            }
            Err(external_connectors::RequestError::Unauthorized) => {
                return Response::external_connectors_unauthorized();
            }
        }
    };
    let delivery = match command {
        external_connectors::Command::List => connector_handle
            .list()
            .await
            .map(|outcome| match outcome {
                crate::external_connectors::ListOutcome::Available(connectors) => {
                    external_connectors::Delivery::List(
                        crate::external_connectors::ListOutcome::Available(public_connectors(
                            connectors,
                        )),
                    )
                }
                crate::external_connectors::ListOutcome::Unavailable => {
                    external_connectors::Delivery::Unavailable
                }
            })
            .unwrap_or(external_connectors::Delivery::Unavailable),
        external_connectors::Command::Catalog => connector_handle
            .catalog()
            .await
            .map(external_connectors::Delivery::Catalog)
            .unwrap_or(external_connectors::Delivery::Unavailable),
        external_connectors::Command::Status => connector_handle
            .status()
            .await
            .map(|outcome| match outcome {
                crate::external_connectors::StatusOutcome::Available(statuses) => {
                    external_connectors::Delivery::Status(statuses)
                }
                crate::external_connectors::StatusOutcome::Unavailable => {
                    external_connectors::Delivery::Unavailable
                }
            })
            .unwrap_or(external_connectors::Delivery::Unavailable),
        external_connectors::Command::SessionStatus(identity) => {
            let native_openclaw = is_native_openclaw_session(&identity);
            connector_handle
                .session_status(identity)
                .await
                .map(|outcome| match outcome {
                    crate::external_connectors::SessionStatusOutcome::Available(statuses) => {
                        let statuses = public_session_statuses(statuses);
                        if statuses.is_empty() && native_openclaw {
                            external_connectors::Delivery::Unavailable
                        } else {
                            external_connectors::Delivery::SessionStatus(statuses)
                        }
                    }
                    crate::external_connectors::SessionStatusOutcome::Unavailable => {
                        external_connectors::Delivery::Unavailable
                    }
                })
                .unwrap_or(external_connectors::Delivery::Unavailable)
        }
        external_connectors::Command::Probe(id) => connector_handle
            .probe(id.clone())
            .await
            .map(|outcome| match outcome {
                crate::external_connectors::ProbeOutcome::Observed(observation) => {
                    external_connectors::Delivery::Probe(id, observation)
                }
                crate::external_connectors::ProbeOutcome::Missing => {
                    external_connectors::Delivery::Missing
                }
                crate::external_connectors::ProbeOutcome::Unavailable => {
                    external_connectors::Delivery::Unavailable
                }
            })
            .unwrap_or(external_connectors::Delivery::Unavailable),
        external_connectors::Command::Get(id) => connector_handle
            .get(id)
            .await
            .map(|outcome| match outcome {
                crate::external_connectors::GetOutcome::Found(connector)
                    if is_system_runtime_connector(&connector) =>
                {
                    external_connectors::Delivery::Missing
                }
                outcome => external_connectors::Delivery::Get(outcome),
            })
            .unwrap_or(external_connectors::Delivery::Unavailable),
        external_connectors::Command::Upsert(connector) => connector_handle
            .upsert(*connector)
            .await
            .map(external_connectors::Delivery::Mutation)
            .unwrap_or(external_connectors::Delivery::Unavailable),
        external_connectors::Command::Remove(id) => connector_handle
            .remove(id)
            .await
            .map(external_connectors::Delivery::Mutation)
            .unwrap_or(external_connectors::Delivery::Unavailable),
    };
    Response::from_external_connectors_delivery(delivery)
}

fn public_connectors(connectors: Vec<environment::Connector>) -> Vec<environment::Connector> {
    connectors
        .into_iter()
        .filter(|connector| !is_system_runtime_connector(connector))
        .collect()
}

fn public_session_statuses(
    statuses: Vec<crate::external_connectors::SessionConnectorStatus>,
) -> Vec<crate::external_connectors::SessionConnectorStatus> {
    statuses
        .into_iter()
        .filter(|status| status.connector_id != "matcha")
        .collect()
}

fn is_system_runtime_connector(connector: &environment::Connector) -> bool {
    connector
        .mcp_server_program
        .as_ref()
        .is_some_and(|program| {
            matches!(program.source, environment::McpProgramSource::SystemRuntime)
        })
}

fn is_native_openclaw_session(identity: &crate::external_connectors::SessionIdentity) -> bool {
    matches!(
        &identity.endpoint,
        crate::external_connectors::SessionEndpoint::Native {
            runtime_adapter_id,
            runtime_instance_id,
        } if runtime_adapter_id == "openclaw" && runtime_instance_id == "local"
    )
}

async fn handle_provider_routing(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::provider::ProviderHandle,
) -> Response {
    match provider_routing::handle(
        &request.headers,
        &request.body,
        verifier,
        owner,
        now_millis(),
    )
    .await
    {
        Ok(delivery) => Response::from_provider_routing_delivery(delivery),
        Err(provider_routing::RequestError::Invalid) => Response::provider_routing_bad_request(),
        Err(provider_routing::RequestError::Unauthorized) => {
            Response::provider_routing_unauthorized()
        }
    }
}

async fn handle_skills_status(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    skills: SkillsHandle,
) -> Response {
    match skills::handle_status(&request.headers, verifier, skills, now_millis()).await {
        Ok(body) => Response { status: 200, body },
        Err(skills::RequestError::Unauthorized) => Response::skills_unauthorized(),
        Err(skills::RequestError::Invalid) => Response::skills_unavailable(),
    }
}

async fn handle_skills_management(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    skills: SkillsHandle,
) -> Response {
    match skills::handle_management(
        &request.path,
        &request.headers,
        &request.body,
        verifier,
        skills,
        now_millis(),
    )
    .await
    {
        Ok(outcome) => {
            let (status, body) = skills::response(outcome);
            Response { status, body }
        }
        Err(skills::RequestError::Invalid) => Response::skills_rejected(),
        Err(skills::RequestError::Unauthorized) => Response::skills_management_unauthorized(),
    }
}

async fn handle_clawhub_search(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    clawhub_registry: ClawHubRegistryClient,
) -> Response {
    match clawhub_search::handle(
        &request.headers,
        &request.body,
        verifier,
        clawhub_registry,
        now_millis(),
    )
    .await
    {
        Ok(delivery) => Response::from_clawhub_search_delivery(delivery),
        Err(clawhub_search::RequestError::Invalid) => Response::clawhub_search_bad_request(),
        Err(clawhub_search::RequestError::Unauthorized) => Response::clawhub_search_unauthorized(),
    }
}

async fn handle_clawhub_skill_install(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    skills: SkillsHandle,
) -> Response {
    match clawhub_skill::handle(
        &request.headers,
        &request.body,
        verifier,
        skills,
        now_millis(),
    )
    .await
    {
        Ok(delivery) => Response::from_clawhub_skill_delivery(delivery),
        Err(clawhub_skill::RequestError::Invalid) => Response::clawhub_skill_bad_request(),
        Err(clawhub_skill::RequestError::Unauthorized) => Response::clawhub_skill_unauthorized(),
    }
}

async fn handle_skill_bundle_export(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    skills: SkillsHandle,
) -> Response {
    match skill_bundle::export(
        &request.headers,
        &request.body,
        verifier,
        skills,
        now_millis(),
    )
    .await
    {
        Ok(delivery) => Response::skill_bundle_delivery(delivery),
        Err(skill_bundle::RequestError::Invalid) => Response::skill_bundle_bad_request(),
        Err(skill_bundle::RequestError::Unauthorized) => Response::skill_bundle_unauthorized(),
    }
}

async fn handle_skill_bundle_import(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    skills: SkillsHandle,
) -> Response {
    match skill_bundle::import(
        &request.headers,
        &request.body,
        verifier,
        skills,
        now_millis(),
    )
    .await
    {
        Ok(delivery) => Response::skill_bundle_delivery(delivery),
        Err(skill_bundle::RequestError::Invalid) => Response::skill_bundle_bad_request(),
        Err(skill_bundle::RequestError::Unauthorized) => Response::skill_bundle_unauthorized(),
    }
}

struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

struct Response {
    status: u16,
    body: Value,
}

impl Response {
    fn bad_request() -> Self {
        Self::fixed(400, "Provider model request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Provider model authorization is invalid")
    }

    fn not_found(path: &str) -> Self {
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
            external_connectors::ENDPOINT => {
                Self::fixed(404, "External connector route is not available")
            }
            _ => Self::fixed(404, "Provider model route is not available"),
        }
    }

    fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }

    fn from_delivery(delivery: ProviderModelsDelivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
    }

    fn external_connectors_bad_request() -> Self {
        Self::fixed(400, "External connector request is invalid")
    }

    fn external_connectors_unauthorized() -> Self {
        Self::fixed(401, "External connector authorization is invalid")
    }

    fn from_external_connectors_delivery(delivery: external_connectors::Delivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
    }

    fn provider_routing_bad_request() -> Self {
        Self::fixed(400, "Provider routing request is invalid")
    }

    fn provider_routing_unauthorized() -> Self {
        Self::fixed(401, "Provider routing authorization is invalid")
    }

    fn from_provider_routing_delivery(delivery: ProviderRoutingDelivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
    }

    fn clawhub_search_bad_request() -> Self {
        Self::fixed(400, clawhub_search::invalid_request_error())
    }

    fn clawhub_search_unauthorized() -> Self {
        Self::fixed(401, "ClawHub search authorization is invalid")
    }

    fn from_clawhub_search_delivery(delivery: ClawHubSearchDelivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
    }

    fn clawhub_skill_bad_request() -> Self {
        Self::fixed(400, "ClawHub skill install request is invalid")
    }

    fn clawhub_skill_unauthorized() -> Self {
        Self::fixed(401, "ClawHub skill install authorization is invalid")
    }

    fn skills_unauthorized() -> Self {
        Self::fixed(401, "Skills status authorization is invalid")
    }

    fn skills_unavailable() -> Self {
        Self {
            status: 503,
            body: serde_json::json!({ "outcome": "unknown" }),
        }
    }

    fn skills_rejected() -> Self {
        Self {
            status: 400,
            body: serde_json::json!({ "outcome": "rejected" }),
        }
    }

    fn skills_management_unauthorized() -> Self {
        Self::fixed(401, "Skills management authorization is invalid")
    }

    fn from_clawhub_skill_delivery(delivery: ClawHubSkillDelivery) -> Self {
        Self {
            status: 200,
            body: delivery.body(),
        }
    }

    fn skill_bundle_bad_request() -> Self {
        Self::fixed(400, "Subagent skill bundle request is invalid")
    }

    fn skill_bundle_unauthorized() -> Self {
        Self::fixed(401, "Subagent skill bundle authorization is invalid")
    }

    fn skill_bundle_delivery(body: Value) -> Self {
        Self { status: 200, body }
    }
}

async fn read_request(stream: &mut TcpStream) -> io::Result<Result<Request, Response>> {
    let mut bytes = Vec::with_capacity(1024);
    let mut buffer = [0_u8; 8192];
    let header_end = loop {
        let read = stream.read(&mut buffer).await?;
        if read == 0 {
            return Ok(Err(Response::bad_request()));
        }
        bytes.extend_from_slice(&buffer[..read]);
        if let Some(end) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
            let header_end = end + 4;
            if header_end > MAX_HEADER_BYTES {
                return Ok(Err(Response::bad_request()));
            }
            break header_end;
        }
        if bytes.len() > MAX_HEADER_BYTES {
            return Ok(Err(Response::bad_request()));
        }
    };
    let headers = match std::str::from_utf8(&bytes[..header_end]) {
        Ok(value) => value.to_owned(),
        Err(_) => return Ok(Err(Response::bad_request())),
    };
    let mut lines = headers.split("\r\n");
    let Some(start) = lines.next() else {
        return Ok(Err(Response::bad_request()));
    };
    let mut start = start.split_whitespace();
    let (Some(method), Some(path), Some(version), None) =
        (start.next(), start.next(), start.next(), start.next())
    else {
        return Ok(Err(Response::bad_request()));
    };
    if version != "HTTP/1.1" {
        return Ok(Err(Response::bad_request()));
    }
    let mut parsed_headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Ok(Err(Response::bad_request()));
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim().to_owned();
        if name.is_empty()
            || parsed_headers.len() == MAX_HEADERS
            || parsed_headers.iter().any(|(existing, _)| existing == &name)
        {
            return Ok(Err(Response::bad_request()));
        }
        parsed_headers.push((name, value));
    }
    if parsed_headers
        .iter()
        .any(|(name, _)| name == "transfer-encoding")
    {
        return Ok(Err(Response::bad_request()));
    }
    let content_length_header = parsed_headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .map(|(_, value)| value);
    let content_length = match content_length_header {
        Some(value) => match value.parse::<usize>() {
            Ok(value) => value,
            Err(_) => return Ok(Err(Response::bad_request())),
        },
        None if method == "GET" && is_get_path(path) && bytes.len() == header_end => 0,
        None => return Ok(Err(Response::bad_request())),
    };
    if content_length > MAX_REQUEST_BYTES || header_end + content_length > MAX_REQUEST_BYTES {
        return Ok(Err(Response::bad_request()));
    }
    while bytes.len() < header_end + content_length {
        let read = stream.read(&mut buffer).await?;
        if read == 0 || bytes.len() + read > MAX_REQUEST_BYTES {
            return Ok(Err(Response::bad_request()));
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
    if bytes.len() != header_end + content_length {
        return Ok(Err(Response::bad_request()));
    }
    if method == "GET" && is_get_path(path) && content_length != 0 {
        return Ok(Err(Response::bad_request()));
    }
    Ok(Ok(Request {
        method: method.to_owned(),
        path: path.to_owned(),
        headers: parsed_headers,
        body: bytes[header_end..].to_vec(),
    }))
}

fn is_get_path(path: &str) -> bool {
    let path = path.split_once('?').map_or(path, |(path, _)| path);
    matches!(
        path,
        ENDPOINT
            | SELECTABLE_ENDPOINT
            | plugins::CATALOG_ENDPOINT
            | plugins::RUNTIME_ENDPOINT
            | skills::ENDPOINT
    )
}

async fn write_response(stream: &mut TcpStream, response: Response) -> io::Result<()> {
    let body = serde_json::to_vec(&response.body).expect("Provider model response is serializable");
    let reason = match response.status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        409 => "Conflict",
        422 => "Unprocessable Content",
        503 => "Service Unavailable",
        _ => "Internal Server Error",
    };
    stream
        .write_all(
            format!(
                "HTTP/1.1 {} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response.status,
                body.len(),
            )
            .as_bytes(),
        )
        .await?;
    stream.write_all(&body).await
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    #[cfg(windows)]
    use std::os::windows::fs::OpenOptionsExt;
    #[cfg(windows)]
    use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};

    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::{Signer as _, SigningKey};
    use matcha_agent::lifecycle::secret::Secret;
    use openclaw::{
        gateway::{auth::GatewaySecret, client::GatewayClientMetadata},
        lifecycle::state_dir::CanonicalStateDir,
        projection::workspace::WorkspaceProjectionFixture,
    };
    use serde_json::json;

    use super::*;
    use crate::{
        Host, HostInput, MatchaAgentInput, OpenClawInput, RuntimeObservationConfig, owner,
    };

    static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

    struct TestRoot {
        base: PathBuf,
        matcha_storage_parent: PathBuf,
        state_parent: PathBuf,
        openclaw: WorkspaceProjectionFixture,
    }

    impl TestRoot {
        fn new() -> Self {
            let sequence = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock must follow Unix epoch")
                .as_nanos();
            let base = std::env::temp_dir().join(format!(
                "runtime-host-provider-routing-transport-{}-{nanos}-{sequence}",
                std::process::id()
            ));
            let state_parent = base.join("state");
            let matcha_storage_parent = base.join("matcha");
            fs::create_dir_all(&state_parent).expect("create state parent");
            fs::create_dir(&matcha_storage_parent).expect("create matcha parent");
            fs::create_dir(matcha_storage_parent.join("app-server"))
                .expect("create app-server root");
            fs::create_dir(state_parent.join("openclaw-plugins"))
                .expect("create managed plugin root");
            let openclaw = WorkspaceProjectionFixture::install(&base);
            Self {
                base,
                matcha_storage_parent,
                state_parent,
                openclaw,
            }
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    struct RunningServer {
        root: TestRoot,
        owner: owner::Owner,
        task: tokio::task::JoinHandle<io::Result<()>>,
        events_task: tokio::task::JoinHandle<()>,
        port: u16,
        #[cfg(windows)]
        external_connector_target: Option<fs::File>,
    }

    impl RunningServer {
        async fn start() -> Self {
            let root = TestRoot::new();
            let (mut host, events, handles) = Host::new(host_input(&root)).expect("construct host");
            host.start_admission_only()
                .await
                .expect("start host admission");
            let mut owner = owner::Owner::spawn(host, events);
            let mut events = owner.take_events().expect("owner events");
            let events_task = tokio::spawn(async move { while events.recv().await.is_some() {} });
            let verifier =
                CapabilityDecisionVerifier::try_new(&verification_key()).expect("verifier");
            let server = Server::bind(
                0,
                verifier,
                handles.provider,
                handles.skills,
                handles.clawhub_registry,
                handles.plugins,
                handles.connector,
            )
            .await
            .expect("bind server");
            let port = server.port();
            let task = tokio::spawn(server.run());
            Self {
                root,
                owner,
                task,
                events_task,
                port,
                #[cfg(windows)]
                external_connector_target: None,
            }
        }

        #[cfg(windows)]
        async fn start_with_external_connector_rename_fault() -> Self {
            let root = TestRoot::new();
            let state_dir = CanonicalStateDir::provision(root.state_parent.join("openclaw"))
                .expect("provision connector state directory");
            let target = state_dir
                .as_path()
                .join("external-connectors/connectors.json");
            fs::create_dir_all(target.parent().expect("connector target parent"))
                .expect("create connector target parent");
            fs::write(&target, br#"{"version":3,"connectors":[],"revisions":{}}"#)
                .expect("seed connector store");
            let external_connector_target = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .open(&target)
                .expect("hold connector target without delete sharing");

            let (mut host, events, handles) = Host::new(host_input(&root)).expect("construct host");
            host.start_admission_only()
                .await
                .expect("start host admission");
            let mut owner = owner::Owner::spawn(host, events);
            let mut events = owner.take_events().expect("owner events");
            let events_task = tokio::spawn(async move { while events.recv().await.is_some() {} });
            let verifier =
                CapabilityDecisionVerifier::try_new(&verification_key()).expect("verifier");
            let server = Server::bind(
                0,
                verifier,
                handles.provider,
                handles.skills,
                handles.clawhub_registry,
                handles.plugins,
                handles.connector,
            )
            .await
            .expect("bind server");
            let port = server.port();
            let task = tokio::spawn(server.run());
            Self {
                root,
                owner,
                task,
                events_task,
                port,
                external_connector_target: Some(external_connector_target),
            }
        }

        async fn request(&self, request: &str) -> Value {
            let mut stream = TcpStream::connect(("127.0.0.1", self.port))
                .await
                .expect("connect transport");
            stream
                .write_all(request.as_bytes())
                .await
                .expect("write request");
            stream.shutdown().await.expect("close request");
            let mut response = Vec::new();
            stream
                .read_to_end(&mut response)
                .await
                .expect("read response");
            parse_response(&response)
        }

        async fn stop(mut self) {
            self.task.abort();
            let _ = self.task.await;
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let attempt = self
                        .owner
                        .handle()
                        .shutdown()
                        .await
                        .expect("shutdown request");
                    if attempt.terminal {
                        let _ = self.owner.join().await.expect("join owner");
                        let _ = (&mut self.events_task).await;
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("provider model loopback host shutdown");
            #[cfg(windows)]
            drop(self.external_connector_target.take());
            let _ = &self.root;
        }
    }

    #[tokio::test]
    async fn loopback_provider_routing_transport_enforces_fixed_route_auth_dto_and_redaction() {
        let server = RunningServer::start().await;

        for request in [
            http_request("GET", "/api/provider-routing", None, ""),
            http_request("POST", "/api/provider-routing/other", None, ""),
        ] {
            let response = server.request(&request).await;
            assert_eq!(response["status"], 404);
            assert_eq!(response["connection"], "close");
            assert!(!response.to_string().contains("provider-models"));
        }

        let private_decision = "private-provider-routing-decision";
        let unauthorized = server
            .request(&http_request(
                "POST",
                "/api/provider-routing",
                Some(private_decision),
                &list_request().to_string(),
            ))
            .await;
        assert_eq!(unauthorized["status"], 401);
        assert_eq!(
            unauthorized["body"],
            json!({
                "success": false,
                "error": "Provider routing authorization is invalid",
            })
        );
        assert!(!unauthorized.to_string().contains(private_decision));

        let mut invalid_request = replace_request();
        invalid_request["input"]["routing"]["routes"][0]["primary"]["apiKey"] =
            json!("do-not-leak");
        let invalid = server
            .request(&http_request(
                "POST",
                "/api/provider-routing",
                Some(&decision("providerRouting.replace")),
                &invalid_request.to_string(),
            ))
            .await;
        assert_eq!(invalid["status"], 400);
        assert_eq!(
            invalid["body"],
            json!({
                "success": false,
                "error": "Provider routing request is invalid",
            })
        );
        assert!(!invalid.to_string().contains("do-not-leak"));

        let available = server
            .request(&http_request(
                "POST",
                "/api/provider-routing",
                Some(&decision("providerRouting.list")),
                &list_request().to_string(),
            ))
            .await;
        assert_eq!(available["status"], 200);
        assert_eq!(available["body"], json!({ "routing": null }));
        assert!(!available.to_string().contains("test-openclaw-secret"));
        assert!(!available.to_string().contains("runtime accepted"));

        server.stop().await;
    }

    #[tokio::test]
    async fn loopback_skills_status_uses_public_key_and_unknown_unavailable_contract() {
        let server = RunningServer::start().await;
        let endpoint = skills::ENDPOINT;

        for request in [
            http_request("POST", endpoint, None, ""),
            http_request("GET", "/api/skills/status/other", None, ""),
        ] {
            let response = server.request(&request).await;
            assert_eq!(response["status"], 404);
            assert_eq!(response["connection"], "close");
        }

        let private_decision = "private-skills-status-decision";
        let unauthorized = server
            .request(&http_request("GET", endpoint, Some(private_decision), ""))
            .await;
        assert_eq!(unauthorized["status"], 401);
        assert_eq!(
            unauthorized["body"],
            json!({
                "success": false,
                "error": "Skills status authorization is invalid",
            })
        );
        assert!(!unauthorized.to_string().contains(private_decision));

        let unavailable = server
            .request(&http_request(
                "GET",
                endpoint,
                Some(&signed_decision(
                    endpoint,
                    "skills:read",
                    "skills.status",
                    "skills-status",
                )),
                "",
            ))
            .await;
        assert_eq!(unavailable["status"], 503);
        assert_eq!(unavailable["body"], json!({ "outcome": "unknown" }));
        assert!(!unavailable.to_string().contains("test-openclaw-secret"));

        server.stop().await;
    }

    #[tokio::test]
    async fn loopback_get_product_routes_accept_fetch_style_empty_get() {
        let server = RunningServer::start().await;
        for endpoint in [
            skills::ENDPOINT,
            plugins::CATALOG_ENDPOINT,
            plugins::RUNTIME_ENDPOINT,
        ] {
            let response = server
                .request(&http_get_without_content_length(
                    endpoint,
                    Some("private-decision"),
                ))
                .await;
            assert_eq!(
                response["status"], 401,
                "GET route rejected before auth: {endpoint}"
            );
            assert_eq!(response["connection"], "close");
        }
        server.stop().await;
    }

    #[tokio::test]
    async fn loopback_external_connectors_requires_a_fresh_signed_decision_and_redacts_401() {
        let server = RunningServer::start().await;
        let endpoint = external_connectors::ENDPOINT;
        let request = external_request("externalConnectors.list", json!({ "kind": "list" }));
        let private_decision = "private-external-connector-decision";

        let unauthorized = server
            .request(&http_request(
                "POST",
                endpoint,
                Some(private_decision),
                &request.to_string(),
            ))
            .await;
        assert_eq!(unauthorized["status"], 401);
        assert_eq!(
            unauthorized["body"],
            json!({
                "success": false,
                "error": "External connector authorization is invalid",
            })
        );
        assert!(!unauthorized.to_string().contains(private_decision));

        let decision = external_decision("externalConnectors.list");
        let available = server
            .request(&http_request(
                "POST",
                endpoint,
                Some(&decision),
                &request.to_string(),
            ))
            .await;
        assert_eq!(available["status"], 200);
        assert_eq!(available["body"], json!({ "connectors": [] }));

        let replayed = server
            .request(&http_request(
                "POST",
                endpoint,
                Some(&decision),
                &request.to_string(),
            ))
            .await;
        assert_eq!(replayed["status"], 401);
        assert!(!replayed.to_string().contains(&decision));

        server.stop().await;
    }

    #[tokio::test]
    async fn loopback_external_connectors_rejects_invalid_identity_without_dispatching() {
        let server = RunningServer::start().await;
        let endpoint = external_connectors::ENDPOINT;
        let invalid = external_request(
            "externalConnectors.sessionStatus",
            json!({
                "kind": "sessionStatus",
                "sessionIdentity": {
                    "endpoint": {
                        "kind": "native-runtime",
                        "runtimeAdapterId": "openclaw",
                        "runtimeInstanceId": "local",
                    },
                    "agentId": "",
                    "sessionKey": "session-1",
                },
            }),
        );
        let invalid_response = server
            .request(&http_request(
                "POST",
                endpoint,
                Some(&external_decision("externalConnectors.sessionStatus")),
                &invalid.to_string(),
            ))
            .await;
        assert_eq!(invalid_response["status"], 400);
        assert_eq!(
            invalid_response["body"],
            json!({
                "success": false,
                "error": "External connector request is invalid",
            })
        );
        assert!(!invalid_response.to_string().contains("session-1"));

        let listed = server
            .request(&http_request(
                "POST",
                endpoint,
                Some(&external_decision("externalConnectors.list")),
                &external_request("externalConnectors.list", json!({ "kind": "list" })).to_string(),
            ))
            .await;
        assert_eq!(listed["status"], 200);
        assert_eq!(listed["body"], json!({ "connectors": [] }));

        server.stop().await;
    }

    #[tokio::test]
    async fn loopback_external_connectors_session_status_distinguishes_native_and_protocol_endpoints()
     {
        let server = RunningServer::start().await;
        let endpoint = external_connectors::ENDPOINT;

        let native = server
            .request(&http_request(
                "POST",
                endpoint,
                Some(&external_decision("externalConnectors.sessionStatus")),
                &external_request(
                    "externalConnectors.sessionStatus",
                    json!({
                        "kind": "sessionStatus",
                        "sessionIdentity": {
                            "endpoint": {
                                "kind": "native-runtime",
                                "runtimeAdapterId": "openclaw",
                                "runtimeInstanceId": "local",
                            },
                            "agentId": "agent-native",
                            "sessionKey": "session-native",
                        },
                    }),
                )
                .to_string(),
            ))
            .await;
        assert_eq!(native["status"], 503);
        assert_eq!(
            native["body"],
            json!({ "success": false, "error": "External connectors are unavailable" })
        );
        assert!(!native.to_string().contains("session-native"));

        let protocol = server
            .request(&http_request(
                "POST",
                endpoint,
                Some(&external_decision("externalConnectors.sessionStatus")),
                &external_request(
                    "externalConnectors.sessionStatus",
                    json!({
                        "kind": "sessionStatus",
                        "sessionIdentity": {
                            "endpoint": {
                                "kind": "protocol-connector",
                                "protocolId": "openclaw",
                                "connectorId": "remote",
                                "endpointId": "gateway-1",
                            },
                            "agentId": "agent-protocol",
                            "sessionKey": "session-protocol",
                        },
                    }),
                )
                .to_string(),
            ))
            .await;
        assert_eq!(protocol["status"], 200);
        assert_eq!(protocol["body"], json!({ "statuses": [] }));
        assert!(!protocol.to_string().contains("session-protocol"));

        server.stop().await;
    }

    #[tokio::test]
    async fn loopback_external_connectors_dispatches_status_and_probe_with_redacted_public_results()
    {
        let server = RunningServer::start().await;
        let endpoint = external_connectors::ENDPOINT;

        let status = server
            .request(&http_request(
                "POST",
                endpoint,
                Some(&external_decision("externalConnectors.status")),
                &external_request("externalConnectors.status", json!({ "kind": "status" }))
                    .to_string(),
            ))
            .await;
        assert_eq!(status["status"], 200);
        assert_eq!(status["body"], json!({ "statuses": [] }));
        assert!(!status.to_string().contains("test-openclaw-secret"));

        let probe = server
            .request(&http_request(
                "POST",
                endpoint,
                Some(&external_decision("externalConnectors.probe")),
                &external_request(
                    "externalConnectors.probe",
                    json!({ "kind": "probe", "connectorId": "missing" }),
                )
                .to_string(),
            ))
            .await;
        assert_eq!(probe["status"], 404);
        assert_eq!(
            probe["body"],
            json!({ "success": false, "error": "External connector is unknown" })
        );
        assert!(!probe.to_string().contains("missing-private-connector"));

        server.stop().await;
    }

    #[tokio::test]
    async fn loopback_external_connector_unknown_mutation_uses_conflict_reason_and_redacts() {
        let response = write_response_over_loopback(Response::from_external_connectors_delivery(
            external_connectors::Delivery::Mutation(
                crate::external_connectors::MutationOutcome::Unknown,
            ),
        ))
        .await;
        assert_eq!(response["status"], 409);
        assert_eq!(response["connection"], "close");
        assert_eq!(
            response["body"],
            json!({
                "success": false,
                "error": "External connector mutation outcome is unknown; reopen before retrying",
            })
        );
        assert!(!response.to_string().contains("test-openclaw-secret"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn loopback_external_connector_rename_uncertainty_dispatches_through_host_as_409() {
        let server = RunningServer::start_with_external_connector_rename_fault().await;
        let request = external_request(
            "externalConnectors.upsert",
            json!({
                "kind": "upsert",
                "connector": {
                    "id": "remote",
                    "kind": "mcp-http",
                    "url": "https://example.test/mcp",
                },
            }),
        );

        let response = server
            .request(&http_request(
                "POST",
                external_connectors::ENDPOINT,
                Some(&external_decision("externalConnectors.upsert")),
                &request.to_string(),
            ))
            .await;
        assert_eq!(response["status"], 409);
        assert_eq!(response["connection"], "close");
        assert_eq!(
            response["body"],
            json!({
                "success": false,
                "error": "External connector mutation outcome is unknown; reopen before retrying",
            })
        );
        assert!(!response.to_string().contains("https://example.test/mcp"));
        assert!(!response.to_string().contains("test-openclaw-secret"));

        let recovery = server
            .request(&http_request(
                "POST",
                external_connectors::ENDPOINT,
                Some(&external_decision("externalConnectors.upsert")),
                &request.to_string(),
            ))
            .await;
        assert_eq!(recovery["status"], 409);
        assert_eq!(recovery["body"], response["body"]);

        server.stop().await;
    }

    #[tokio::test]
    async fn loopback_skill_bundle_transport_is_fixed_authorized_atomic_and_redacted() {
        let server = RunningServer::start().await;
        let export = skill_bundle::EXPORT_ENDPOINT;
        let import = skill_bundle::IMPORT_ENDPOINT;

        for request in [
            http_request("GET", export, None, ""),
            http_request("POST", "/api/subagents/skill-bundles/other", None, ""),
        ] {
            let response = server.request(&request).await;
            assert_eq!(response["status"], 404);
            assert_eq!(response["connection"], "close");
        }

        let private_decision = "private-skill-bundle-decision";
        let unauthorized = server
            .request(&http_request(
                "POST",
                export,
                Some(private_decision),
                r#"{"skillKeys":[]}"#,
            ))
            .await;
        assert_eq!(unauthorized["status"], 401);
        assert_eq!(
            unauthorized["body"],
            json!({
                "success": false,
                "error": "Subagent skill bundle authorization is invalid",
            })
        );
        assert!(!unauthorized.to_string().contains(private_decision));

        let private_key = "do-not-leak";
        let invalid = server
            .request(&http_request(
                "POST",
                import,
                Some(&skill_bundle_decision(import)),
                &json!({
                    "skillBundles": [{
                        "skillKey": "web-search",
                        "files": [{
                            "path": "SKILL.md",
                            "content": format!("---\\nname: web-search\\ndescription: {private_key}\\n---\\n"),
                        }],
                        "apiKey": private_key,
                    }],
                })
                .to_string(),
            ))
            .await;
        assert_eq!(invalid["status"], 400);
        assert_eq!(
            invalid["body"],
            json!({
                "success": false,
                "error": "Subagent skill bundle request is invalid",
            })
        );
        assert!(!invalid.to_string().contains(private_key));

        let bundle = json!({
            "skillBundles": [{
                "skillKey": "web-search",
                "files": [{
                    "path": "SKILL.md",
                    "content": "---\nname: web-search\ndescription: Search the web\n---\n",
                }],
            }],
        });
        let imported = server
            .request(&http_request(
                "POST",
                import,
                Some(&skill_bundle_decision(import)),
                &bundle.to_string(),
            ))
            .await;
        assert_eq!(imported["status"], 200);
        assert_eq!(imported["body"], json!({ "outcome": "accepted" }));

        let exported = server
            .request(&http_request(
                "POST",
                export,
                Some(&skill_bundle_decision(export)),
                r#"{"skillKeys":["web-search"]}"#,
            ))
            .await;
        assert_eq!(exported["status"], 200);
        assert_eq!(
            exported["body"],
            json!({
                "outcome": "accepted",
                "skillBundles": bundle["skillBundles"],
            })
        );
        assert!(
            !exported
                .to_string()
                .contains(server.root.base.to_string_lossy().as_ref())
        );

        server.stop().await;
    }

    fn external_request(operation_id: &str, input: Value) -> Value {
        json!({
            "id": "external.connectors",
            "operationId": operation_id,
            "scope": { "kind": "external-connector-catalog" },
            "target": { "kind": "external-connectors" },
            "input": input,
        })
    }

    fn external_decision(operation_id: &str) -> String {
        signed_decision(
            external_connectors::ENDPOINT,
            "environment:external-connectors",
            operation_id,
            "external-connectors",
        )
    }

    async fn write_response_over_loopback(response: Response) -> Value {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind response listener");
        let port = listener
            .local_addr()
            .expect("response listener address")
            .port();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept response client");
            write_response(&mut stream, response)
                .await
                .expect("write response");
        });
        let mut stream = TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connect response client");
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).await.expect("read response");
        task.await.expect("response task");
        parse_response(&bytes)
    }

    fn http_request(method: &str, path: &str, authorization: Option<&str>, body: &str) -> String {
        format!(
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{}Content-Length: {}\r\n\r\n{body}",
            authorization
                .map(|value| format!("Authorization: Bearer {value}\r\n"))
                .unwrap_or_default(),
            body.len(),
        )
    }

    fn http_get_without_content_length(path: &str, authorization: Option<&str>) -> String {
        format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{}\r\n",
            authorization
                .map(|value| format!("Authorization: Bearer {value}\r\n"))
                .unwrap_or_default(),
        )
    }

    fn parse_response(response: &[u8]) -> Value {
        let response = std::str::from_utf8(response).expect("response utf8");
        let (head, body) = response.split_once("\r\n\r\n").expect("response body");
        let status = head
            .split_whitespace()
            .nth(1)
            .expect("status")
            .parse::<u16>()
            .expect("numeric status");
        let connection = head
            .lines()
            .find_map(|line| line.strip_prefix("Connection: "))
            .expect("connection header");
        json!({
            "status": status,
            "connection": connection.to_ascii_lowercase(),
            "body": serde_json::from_str::<Value>(body).expect("json body"),
        })
    }

    fn list_request() -> Value {
        json!({
            "id": "provider.routing",
            "operationId": "providerRouting.list",
            "scope": { "kind": "provider-routing" },
            "target": { "kind": "provider-routing" },
            "input": { "kind": "list" },
        })
    }

    fn replace_request() -> Value {
        json!({
            "id": "provider.routing",
            "operationId": "providerRouting.replace",
            "scope": { "kind": "provider-routing" },
            "target": { "kind": "provider-routing" },
            "input": {
                "kind": "replace",
                "routing": {
                    "revision": 1,
                    "routes": [{
                        "capability": "chat",
                        "primary": {
                            "credential": "credential:v1:provider-routing-test",
                            "modelId": "model",
                        },
                        "fallbacks": [],
                    }],
                },
            },
        })
    }

    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[9; 32])
    }

    fn verification_key() -> String {
        let mut bytes = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        bytes.extend_from_slice(signing_key().verifying_key().as_bytes());
        URL_SAFE_NO_PAD.encode(bytes)
    }

    fn decision(operation_id: &str) -> String {
        signed_decision(
            "/api/provider-routing",
            "providers:routing",
            operation_id,
            "provider-routing",
        )
    }

    fn skill_bundle_decision(endpoint: &str) -> String {
        signed_decision(
            endpoint,
            "subagents:skill-bundles",
            "subagentSkillBundles.transfer",
            "subagent-skill-bundles",
        )
    }

    fn signed_decision(endpoint: &str, scope: &str, capability: &str, subject: &str) -> String {
        signed_decision_with_expiry(endpoint, scope, capability, subject, now_millis() + 60_000)
    }

    fn signed_decision_with_expiry(
        endpoint: &str,
        scope: &str,
        capability: &str,
        subject: &str,
        expires_at: u64,
    ) -> String {
        let payload = json!({
            "version": 1,
            "principal": "localhost-test",
            "endpoint": endpoint,
            "scope": scope,
            "capability": capability,
            "subject": subject,
            "expiresAt": expires_at,
            "correlation": format!("transport:{}", NEXT_ROOT.fetch_add(1, Ordering::Relaxed)),
            "revision": "test",
        });
        let payload =
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("serialize decision"));
        let signed = format!("capability-decision.v1.{payload}");
        let signature = URL_SAFE_NO_PAD.encode(signing_key().sign(signed.as_bytes()).to_bytes());
        format!("{signed}.{signature}")
    }

    fn host_input(root: &TestRoot) -> HostInput {
        let state_dir = CanonicalStateDir::provision(root.state_parent.join("openclaw"))
            .expect("state directory");
        HostInput {
            matcha: MatchaAgentInput {
                bun_executable: absolute_path("bin/bun"),
                entry: absolute_path("matcha-agent/dist/cli-bun.js"),
                working_directory: absolute_path("runtime"),
                storage_root: root.matcha_storage_parent.join("app-server"),
                port: 18_790,
                #[cfg(windows)]
                git_bash: absolute_path("bin/bash.exe"),
                #[cfg(unix)]
                guardian_executable: absolute_path("bin/runtime-host-guardian"),
            },
            matcha_secret: Secret::new("test-matcha-secret".into()).expect("matcha secret"),
            open_claw: OpenClawInput {
                electron_image: absolute_path("MatchaClaw"),
                working_directory: absolute_path("runtime"),
                openclaw_dir: root.openclaw.openclaw_dir().to_owned(),
                companion_skill_source_root: root.state_parent.join("openclaw-plugins"),
                managed_plugin_root: root.state_parent.join("openclaw-plugins"),
                subagent_template_dir: {
                    let path = root.state_parent.join("subagent-templates");
                    fs::create_dir_all(&path).expect("create subagent template directory");
                    path
                },
                entry: root.openclaw.openclaw_dir().join("openclaw.mjs"),
                state_dir,
                port: 18_789,
                client_metadata: GatewayClientMetadata::try_new(
                    "test".into(),
                    std::env::consts::OS.into(),
                )
                .expect("metadata"),
                report_diagnostic: Arc::new(|_| {}),
                #[cfg(unix)]
                guardian_executable: absolute_path("bin/runtime-host-guardian"),
            },
            open_claw_secret: GatewaySecret::new("test-openclaw-secret".into())
                .expect("openclaw secret"),
            organization_store: organization::OrganizationStore::open(
                root.state_parent.join("organization-facts.log"),
            )
            .expect("organization store"),
            runtime_state_dir: root.state_parent.join("runtime-host"),
            app_log_dir: root.state_parent.join("userdata-logs"),
            parent_callback_base_url: "http://127.0.0.1:34100".into(),
            parent_callback_dispatch_token: "test-parent-dispatch-token".into(),
            cron_transport_port: 18_791,
            runtime_observation: RuntimeObservationConfig::off(),
        }
    }

    fn absolute_path(name: &str) -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(format!(r"C:\\MatchaClaw\\{name}"))
        } else {
            PathBuf::from(format!("/MatchaClaw/{name}"))
        }
    }
}
