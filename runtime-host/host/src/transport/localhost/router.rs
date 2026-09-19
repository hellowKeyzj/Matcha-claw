use std::{
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
    time::{Duration, SystemTime},
};

use ::clawhub::ClawHubRegistryClient;
use foundation::execution::ObservationSink;
use platform::endpoint::runtime_address::RuntimeEndpoint;
use tokio::sync::Mutex;

use crate::{
    composition::PeerHandle,
    facade::{
        AgentsHandle, CronHandle, DiagnosticsHandle, PlatformRuntimeHandle, PlatformToolsHandle,
        PluginsHandle, SkillsHandle, TaskManagerHandle, ToolchainHandle, UsageHandle,
        WorkspaceHandle,
    },
    host_actor,
    provider::ProviderHandle,
    security::SecurityHandle,
    settings::SettingsHandle,
    transport::{
        common::authorization::CapabilityDecisionVerifier,
        compatibility::{
            dispatch,
            wire::{DispatchRequest, DispatchResponse, HealthResponse, MAX_BODY_BYTES, VERSION},
        },
        fleet::terminal_stream::ServerDependencies as TerminalServerDependencies,
        team::trigger::WebhookToken,
    },
};

use super::{BodyPolicy, Request, RequestHead, Response, RouteOutcome};

const DEFAULT_REQUEST_BYTES: usize = 64 * 1024;
const SUBAGENTS_REQUEST_BYTES: usize = 1024 * 1024 + 64 * 1024;
const SESSIONS_REQUEST_BYTES: usize =
    (20_usize * 1024 * 1024).div_ceil(3) * 4 + 64 * 1024 + 128 * 1024;
const TEAM_SMALL_REQUEST_BYTES: usize = 8 * 1024;
const TEAM_GRAPH_REQUEST_BYTES: usize = 256 * 1024;
const TEAM_MANUAL_REQUEST_BYTES: usize = 16 * 1024;
const TASK_MANAGER_REQUEST_BYTES: usize = 2 * 1024 * 1024 + 64 * 1024;
const WORKSPACE_WRITE_REQUEST_BYTES: usize = 2 * 1024 * 1024 + 16 * 1024;
const WORKSPACE_MEDIA_REQUEST_BYTES: usize = 70 * 1024 * 1024;
const CATALOG_SURFACE_REQUEST_BYTES: usize = 64 * 1024;
const SECURITY_POLICY_REQUEST_BYTES: usize = 72 * 1024;
const DIAGNOSTICS_REQUEST_BYTES: usize = 4 * 1024;
const CHANNEL_TINY_REQUEST_BYTES: usize = 256;
const CHANNEL_CONTROL_REQUEST_BYTES: usize = 20 * 1024;
const CHANNEL_CATALOG_REQUEST_BYTES: usize = 64 * 1024;
const CHANNEL_CREDENTIALS_REQUEST_BYTES: usize = 320 * 1024;
const COMPATIBILITY_DEADLINE: Duration = Duration::from_secs(30);
const DEFAULT_DEADLINE: Duration = Duration::from_secs(30);
const SHORT_DEADLINE: Duration = Duration::from_secs(5);
const CHANNEL_LOGIN_DEADLINE: Duration = Duration::from_secs(305);
const SHUTDOWN_RETRY_DELAY: Duration = Duration::from_millis(50);
const LIFECYCLE_RUNNING: u8 = 0;
const LIFECYCLE_STOPPING: u8 = 1;
const LIFECYCLE_STOPPED: u8 = 2;

pub(crate) struct RouterInput {
    pub(crate) owner: host_actor::Handle,
    pub(crate) verifier: CapabilityDecisionVerifier,
    pub(crate) webhook_token: WebhookToken,
    pub(crate) peer: PeerHandle,
    pub(crate) platform_runtime: PlatformRuntimeHandle,
    pub(crate) toolchain: ToolchainHandle,
    pub(crate) platform_tools: PlatformToolsHandle,
    pub(crate) plugins: PluginsHandle,
    pub(crate) skills: SkillsHandle,
    pub(crate) session: crate::sessions::SessionHandle,
    pub(crate) session_delta_source: crate::sessions::events::SessionDeltaSource,
    pub(crate) send_hooks: crate::sessions::send_hook::SessionSendHookSet,
    pub(crate) cron: CronHandle,
    pub(crate) fleet: crate::fleet::handle::FleetHandle,
    pub(crate) fleet_terminal: TerminalServerDependencies,
    pub(crate) channel: crate::channel::ChannelHandle,
    pub(crate) channel_endpoint: RuntimeEndpoint,
    pub(crate) organization: crate::organization::OrganizationHandle,
    pub(crate) task_manager: TaskManagerHandle,
    pub(crate) workspace: WorkspaceHandle,
    pub(crate) provider: ProviderHandle,
    pub(crate) agents: AgentsHandle,
    pub(crate) usage: UsageHandle,
    pub(crate) settings: SettingsHandle,
    pub(crate) security: SecurityHandle,
    pub(crate) diagnostics: DiagnosticsHandle,
    pub(crate) observation: ObservationSink,
    pub(crate) clawhub_registry: ClawHubRegistryClient,
    pub(crate) connector: crate::connectors::ConnectorHandle,
}

#[derive(Clone)]
pub(crate) struct Router {
    owner: host_actor::Handle,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    webhook_token: WebhookToken,
    peer: PeerHandle,
    platform_runtime: PlatformRuntimeHandle,
    toolchain: ToolchainHandle,
    platform_tools: PlatformToolsHandle,
    plugins: PluginsHandle,
    skills: SkillsHandle,
    session: crate::sessions::SessionHandle,
    session_delta_source: crate::sessions::events::SessionDeltaSource,
    send_hooks: crate::sessions::send_hook::SessionSendHookSet,
    cron: CronHandle,
    fleet: crate::fleet::handle::FleetHandle,
    fleet_terminal: TerminalServerDependencies,
    channel: crate::channel::ChannelHandle,
    channel_endpoint: RuntimeEndpoint,
    organization: crate::organization::OrganizationHandle,
    task_manager: TaskManagerHandle,
    workspace: WorkspaceHandle,
    provider: ProviderHandle,
    agents: AgentsHandle,
    usage: UsageHandle,
    settings: SettingsHandle,
    security: SecurityHandle,
    diagnostics: DiagnosticsHandle,
    observation: ObservationSink,
    clawhub_registry: ClawHubRegistryClient,
    connector: crate::connectors::ConnectorHandle,
    lifecycle: Arc<AtomicU8>,
    started_at: SystemTime,
}

impl Router {
    pub(crate) fn new(input: RouterInput) -> Self {
        Self {
            owner: input.owner,
            verifier: Arc::new(Mutex::new(input.verifier)),
            webhook_token: input.webhook_token,
            peer: input.peer,
            platform_runtime: input.platform_runtime,
            toolchain: input.toolchain,
            platform_tools: input.platform_tools,
            plugins: input.plugins,
            skills: input.skills,
            session: input.session,
            session_delta_source: input.session_delta_source,
            send_hooks: input.send_hooks,
            cron: input.cron,
            fleet: input.fleet,
            fleet_terminal: input.fleet_terminal,
            channel: input.channel,
            channel_endpoint: input.channel_endpoint,
            organization: input.organization,
            task_manager: input.task_manager,
            workspace: input.workspace,
            provider: input.provider,
            agents: input.agents,
            usage: input.usage,
            settings: input.settings,
            security: input.security,
            diagnostics: input.diagnostics,
            observation: input.observation,
            clawhub_registry: input.clawhub_registry,
            connector: input.connector,
            lifecycle: Arc::new(AtomicU8::new(LIFECYCLE_RUNNING)),
            started_at: SystemTime::now(),
        }
    }

    pub(crate) fn body_policy(&self, head: &RequestHead) -> BodyPolicy {
        if is_compatibility_route(&head.method, &head.path) {
            return BodyPolicy::Optional {
                max_bytes: MAX_BODY_BYTES,
            };
        }
        if let Some(policy) = crate::transport::cron::handler::localhost_body_policy(head) {
            return policy;
        }
        if let Some(policy) = crate::transport::fleet::handler::localhost_body_policy(head) {
            return policy;
        }
        let path = pathname(&head.path);
        match (head.method.as_str(), path) {
            ("GET", _) if is_get_route(path) => BodyPolicy::Empty,
            ("POST", _) if is_session_route(path) => BodyPolicy::Required {
                max_bytes: SESSIONS_REQUEST_BYTES,
            },
            ("POST", "/api/matcha-agent/chat/history") => BodyPolicy::Required {
                max_bytes: DEFAULT_REQUEST_BYTES,
            },
            ("POST", "/api/workspace/files/write-text") => BodyPolicy::Required {
                max_bytes: WORKSPACE_WRITE_REQUEST_BYTES,
            },
            ("POST", "/api/workspace/media") => BodyPolicy::Required {
                max_bytes: WORKSPACE_MEDIA_REQUEST_BYTES,
            },
            ("POST", path) if is_workspace_read_route(path) => BodyPolicy::Required {
                max_bytes: DEFAULT_REQUEST_BYTES,
            },
            ("POST", path) if is_team_route(path) => BodyPolicy::Required {
                max_bytes: team_body_limit(path),
            },
            ("POST", "/api/subagents/agents") => BodyPolicy::Required {
                max_bytes: SUBAGENTS_REQUEST_BYTES,
            },
            ("POST", path) if is_channel_route(path) => BodyPolicy::Required {
                max_bytes: channel_body_limit(path),
            },
            ("POST", path) if is_catalog_surface_post_route(path) => BodyPolicy::Required {
                max_bytes: CATALOG_SURFACE_REQUEST_BYTES,
            },
            ("POST", "/api/provider-accounts") => BodyPolicy::Required {
                max_bytes: DEFAULT_REQUEST_BYTES,
            },
            ("POST", "/api/settings/desired") => BodyPolicy::Required {
                max_bytes: 16 * 1024,
            },
            ("POST", "/api/security/emergency") => BodyPolicy::Required { max_bytes: 2 },
            ("POST", path) if is_security_policy_post_route(path) => BodyPolicy::Required {
                max_bytes: SECURITY_POLICY_REQUEST_BYTES,
            },
            ("POST", path) if is_diagnostics_route(path) => BodyPolicy::Required {
                max_bytes: DIAGNOSTICS_REQUEST_BYTES,
            },
            ("GET", _) => BodyPolicy::Empty,
            _ => BodyPolicy::Optional {
                max_bytes: DEFAULT_REQUEST_BYTES,
            },
        }
    }

    pub(crate) fn deadline(&self, head: &RequestHead) -> Duration {
        if is_compatibility_route(&head.method, &head.path) {
            return COMPATIBILITY_DEADLINE;
        }
        if crate::transport::cron::handler::localhost_body_policy(head).is_some() {
            return crate::transport::cron::handler::localhost_deadline();
        }
        if crate::transport::fleet::handler::localhost_body_policy(head).is_some() {
            return crate::transport::fleet::handler::localhost_deadline();
        }
        let path = pathname(&head.path);
        if is_channel_route(path) {
            return channel_deadline(path);
        }
        if is_short_deadline_route(path) {
            SHORT_DEADLINE
        } else {
            DEFAULT_DEADLINE
        }
    }

    pub(crate) fn timeout_response(&self, head: Option<&RequestHead>) -> Response {
        if head.is_some_and(|head| is_compatibility_route(&head.method, &head.path)) {
            return compatibility_response(DispatchResponse::bad_request(
                "Request deadline exceeded",
            ));
        }
        if let Some(head) = head {
            if crate::transport::cron::handler::localhost_body_policy(head).is_some() {
                return crate::transport::cron::handler::localhost_timeout_response();
            }
            if crate::transport::fleet::handler::localhost_body_policy(head).is_some() {
                return crate::transport::fleet::handler::localhost_timeout_response();
            }
        }
        Response::json(
            503,
            serde_json::json!({ "success": false, "error": "Runtime Host request deadline exceeded" }),
        )
    }

    pub(crate) async fn route(&self, request: Request) -> RouteOutcome {
        if is_compatibility_route(request.method(), request.path()) {
            return RouteOutcome::Response(self.handle_compatibility(request).await);
        }
        if let Some(outcome) = self.route_borrowed(&request).await {
            return outcome;
        }
        if crate::transport::cron::handler::localhost_body_policy(&request.head).is_some() {
            return crate::transport::cron::handler::handle_localhost(
                request,
                Arc::clone(&self.verifier),
                self.cron.clone(),
            )
            .await
            .unwrap_or_else(|| RouteOutcome::Response(Response::not_found()));
        }
        if crate::transport::fleet::handler::localhost_body_policy(&request.head).is_some() {
            return crate::transport::fleet::handler::handle_localhost(
                request,
                Arc::clone(&self.verifier),
                self.fleet.clone(),
                self.fleet_terminal.clone(),
            )
            .await
            .unwrap_or_else(|| RouteOutcome::Response(Response::not_found()));
        }
        RouteOutcome::Response(Response::not_found())
    }

    async fn route_borrowed(&self, request: &Request) -> Option<RouteOutcome> {
        if let Some(outcome) = crate::transport::sessions::events::handle_localhost(
            request,
            Arc::clone(&self.verifier),
            self.session_delta_source.clone(),
        )
        .await
        {
            return Some(outcome);
        }
        if let Some(outcome) = crate::transport::sessions::handler::handle_localhost(
            request,
            Arc::clone(&self.verifier),
            self.platform_tools.clone(),
            self.peer.clone(),
            self.session.clone(),
            self.send_hooks.clone(),
        )
        .await
        {
            return Some(outcome);
        }
        if let Some(response) =
            crate::transport::sessions::matcha_history::handler::handle_localhost(
                request,
                Arc::clone(&self.verifier),
                self.session.clone(),
            )
            .await
        {
            return Some(RouteOutcome::Response(response));
        }
        self.route_exact(request).await.map(RouteOutcome::Response)
    }

    async fn route_exact(&self, request: &Request) -> Option<Response> {
        let path = pathname(request.path());
        match (request.method(), path) {
            ("POST", "/api/workspace/files/read-text") => Some(
                crate::transport::workspace::text::handler::handle(
                    request.method(),
                    request.path(),
                    request.headers(),
                    &request.body,
                    Arc::clone(&self.verifier),
                    self.workspace.clone(),
                )
                .await,
            ),
            ("POST", "/api/workspace/files/binary") => Some(
                crate::transport::workspace::binary::handler::handle(
                    request.method(),
                    request.path(),
                    request.headers(),
                    &request.body,
                    Arc::clone(&self.verifier),
                    self.workspace.clone(),
                )
                .await,
            ),
            ("POST", "/api/workspace/files/list-dir") => Some(
                crate::transport::workspace::directory::handler::handle(
                    request.method(),
                    request.path(),
                    request.headers(),
                    &request.body,
                    Arc::clone(&self.verifier),
                    self.workspace.clone(),
                )
                .await,
            ),
            ("POST", "/api/workspace/files/write-text") => Some(
                crate::transport::workspace::write::handler::handle(
                    request.method(),
                    request.path(),
                    request.headers(),
                    &request.body,
                    Arc::clone(&self.verifier),
                    self.workspace.clone(),
                )
                .await,
            ),
            ("POST", "/api/workspace/media") => Some(
                crate::transport::workspace::media::handler::handle(
                    request.method(),
                    request.path(),
                    request.headers(),
                    &request.body,
                    Arc::clone(&self.verifier),
                    self.workspace.clone(),
                )
                .await,
            ),
            ("POST", "/api/subagents/agents") => Some(
                crate::transport::agents::handler::handle(
                    request.method(),
                    request.path(),
                    request.headers(),
                    &request.body,
                    Arc::clone(&self.verifier),
                    self.agents.clone(),
                )
                .await,
            ),
            ("GET", "/api/usage/recent") | ("GET", "/api/usage/session-timeseries") => Some(
                crate::transport::usage::handler::handle(
                    request.method(),
                    request.path(),
                    request.headers(),
                    Arc::clone(&self.verifier),
                    self.usage.clone(),
                )
                .await,
            ),
            ("GET", "/api/settings/current") | ("POST", "/api/settings/desired") => Some(
                crate::transport::settings::desired::handler::handle_route(
                    request.method(),
                    request.path(),
                    request
                        .headers()
                        .iter()
                        .find(|(name, _)| name == "authorization")
                        .map(|(_, value)| value.as_str()),
                    &request.body,
                    Arc::clone(&self.verifier),
                    self.settings.clone(),
                )
                .await,
            ),
            ("POST", "/api/security/emergency") => Some(
                crate::transport::security::emergency::handler::handle(
                    request.method(),
                    request.path(),
                    request.headers(),
                    &request.body,
                    Arc::clone(&self.verifier),
                    self.security.clone(),
                )
                .await,
            ),
            _ if is_security_policy_route(request.method(), request.path()) => Some(
                match crate::transport::security::policy::handler::handle_route(
                    request.method(),
                    request.path(),
                    request
                        .headers()
                        .iter()
                        .find(|(name, _)| name == "authorization")
                        .map(|(_, value)| value.as_str()),
                    request
                        .headers()
                        .iter()
                        .find(|(name, _)| name == "x-matchaclaw-trace-id")
                        .map(|(_, value)| value.as_str()),
                    &request.body,
                    Arc::clone(&self.verifier),
                    self.security.clone(),
                )
                .await
                {
                    Ok(response) => response,
                    Err(_) => Response::error(503, "Security policy is unavailable"),
                },
            ),
            _ if is_provider_accounts_route(request.method(), request.path()) => Some(
                crate::transport::providers::accounts::handler::handle(
                    request.method(),
                    request.path(),
                    request.headers(),
                    &request.body,
                    Arc::clone(&self.verifier),
                    self.provider.clone(),
                )
                .await,
            ),
            _ if is_catalog_surface_route(request.method(), request.path()) => Some(
                crate::transport::runtime::catalog_surface::handler::handle(
                    request.method(),
                    request.path(),
                    request.headers(),
                    &request.body,
                    Arc::clone(&self.verifier),
                    self.provider.clone(),
                    self.skills.clone(),
                    self.agents.clone(),
                    self.clawhub_registry.clone(),
                    self.plugins.clone(),
                    self.connector.clone(),
                )
                .await,
            ),
            _ if is_channel_route(path) => self.route_channel(request).await,
            _ if is_team_route(path) => self.route_team(request).await,
            _ if is_diagnostics_route(path) => Some(
                match crate::transport::diagnostics::handler::handle(
                    request.method(),
                    request.path(),
                    request.headers(),
                    &request.body,
                    Arc::clone(&self.verifier),
                    self.diagnostics.clone(),
                    self.observation.clone(),
                )
                .await
                {
                    Ok(response) => response,
                    Err(_) => Response::error(503, "Diagnostics archive is unavailable"),
                },
            ),
            _ => None,
        }
    }

    async fn route_channel(&self, request: &Request) -> Option<Response> {
        let response = match pathname(request.path()) {
            "/api/channels/status" => {
                crate::transport::channels::status::handler::handle(
                    request.method(),
                    request.path(),
                    request.headers(),
                    &request.body,
                    Arc::clone(&self.verifier),
                    self.channel.clone(),
                    self.channel_endpoint.clone(),
                )
                .await
            }
            "/api/channels/pairing" => {
                crate::transport::channels::pairing::handler::handle(
                    request.method(),
                    request.path(),
                    request.headers(),
                    &request.body,
                    Arc::clone(&self.verifier),
                    self.channel.clone(),
                    self.channel_endpoint.clone(),
                )
                .await
            }
            "/api/channels/catalog"
            | "/api/channels/configure"
            | "/api/channels/config/read"
            | "/api/channels/credentials/validate" => {
                crate::transport::channels::catalog::handler::handle(
                    request.method(),
                    request.path(),
                    request.headers(),
                    &request.body,
                    Arc::clone(&self.verifier),
                    self.channel.clone(),
                    self.channel_endpoint.clone(),
                )
                .await
            }
            "/api/channels/control" | "/api/channels/login" | "/api/channels/delete-config" => {
                crate::transport::channels::control::handler::handle(
                    request.method(),
                    request.path(),
                    request.headers(),
                    &request.body,
                    Arc::clone(&self.verifier),
                    self.channel.clone(),
                    self.channel_endpoint.clone(),
                )
                .await
            }
            _ => return None,
        };
        Some(response)
    }

    async fn route_team(&self, request: &Request) -> Option<Response> {
        let method = request.method().to_owned();
        let path = request.path().to_owned();
        let headers = request.headers().to_vec();
        let body = request.body.clone();
        let response = match pathname(request.path()) {
            "/api/team/public" => {
                crate::transport::team::public::handler::handle_localhost(
                    method,
                    path,
                    headers,
                    body,
                    Arc::clone(&self.verifier),
                    self.organization.clone(),
                )
                .await
            }
            "/api/team/role-sessions" => {
                crate::transport::team::role_sessions::handler::handle_localhost(
                    method,
                    path,
                    headers,
                    body,
                    Arc::clone(&self.verifier),
                    self.organization.clone(),
                )
                .await
            }
            "/api/team/approvals" => {
                crate::transport::team::approvals::handler::handle_localhost(
                    method,
                    path,
                    headers,
                    body,
                    Arc::clone(&self.verifier),
                    self.organization.clone(),
                )
                .await
            }
            "/api/team/task-board" => {
                crate::transport::team::task_board::handler::handle_localhost(
                    method,
                    path,
                    headers,
                    body,
                    Arc::clone(&self.verifier),
                    self.organization.clone(),
                )
                .await
            }
            "/api/team/decision" => {
                crate::transport::team::decision::handler::handle_localhost(
                    method,
                    path,
                    headers,
                    body,
                    Arc::clone(&self.verifier),
                    self.organization.clone(),
                )
                .await
            }
            "/api/team/lifecycle" => {
                crate::transport::team::lifecycle::handler::handle_localhost(
                    method,
                    path,
                    headers,
                    body,
                    Arc::clone(&self.verifier),
                    self.organization.clone(),
                )
                .await
            }
            "/api/team/graph" => {
                crate::transport::team::graph::handler::handle_localhost(
                    method,
                    path,
                    headers,
                    body,
                    Arc::clone(&self.verifier),
                    self.organization.clone(),
                )
                .await
            }
            "/api/team/skill" => {
                crate::transport::team::skill::handler::handle_localhost(
                    method,
                    path,
                    headers,
                    body,
                    Arc::clone(&self.verifier),
                    self.organization.clone(),
                )
                .await
            }
            "/api/team/manual-materialize-and-create" => {
                crate::transport::team::manual::handler::handle_localhost(
                    method,
                    path,
                    headers,
                    body,
                    Arc::clone(&self.verifier),
                    self.organization.clone(),
                )
                .await
            }
            path if is_task_manager_route(path) => {
                crate::transport::team::task_manager::handler::handle_localhost(
                    method,
                    path.to_owned(),
                    headers,
                    body,
                    Arc::clone(&self.verifier),
                    self.task_manager.clone(),
                )
                .await
            }
            path if is_trigger_route(path) => {
                crate::transport::team::trigger::handler::handle_localhost(
                    method,
                    path.to_owned(),
                    headers,
                    body,
                    Arc::clone(&self.verifier),
                    self.webhook_token.clone(),
                    self.organization.clone(),
                )
                .await
            }
            _ => return None,
        };
        Some(response)
    }

    async fn handle_compatibility(&self, request: Request) -> Response {
        match (request.method(), request.path()) {
            ("GET", "/health") => Response::json(
                200,
                build_health_response(Arc::clone(&self.lifecycle), self.started_at).into_json(),
            ),
            ("POST", "/dispatch") => {
                if lifecycle_from_atomic(self.lifecycle.load(Ordering::Acquire))
                    != Lifecycle::Running
                {
                    return compatibility_response(stopped_dispatch_response());
                }
                let request = match serde_json::from_slice::<DispatchRequest>(&request.body) {
                    Ok(request) => request,
                    Err(_) => {
                        return compatibility_response(DispatchResponse::bad_request(
                            "Dispatch envelope is invalid",
                        ));
                    }
                };
                compatibility_response(
                    dispatch::execute(
                        &self.owner,
                        &self.peer,
                        &self.platform_runtime,
                        &self.toolchain,
                        &self.plugins,
                        &self.skills,
                        &self.session,
                        request,
                    )
                    .await,
                )
            }
            ("POST", "/lifecycle/restart") => {
                compatibility_response(DispatchResponse::lifecycle_restart_unavailable())
            }
            ("POST", "/lifecycle/stop") => {
                let accepted = self
                    .lifecycle
                    .compare_exchange(
                        LIFECYCLE_RUNNING,
                        LIFECYCLE_STOPPING,
                        Ordering::AcqRel,
                        Ordering::Acquire,
                    )
                    .is_ok();
                if accepted {
                    tokio::spawn(shutdown_until_terminal(
                        self.owner.clone(),
                        Arc::clone(&self.lifecycle),
                    ));
                }
                let current = lifecycle_from_atomic(self.lifecycle.load(Ordering::Acquire));
                compatibility_response(DispatchResponse::Success(
                    crate::transport::compatibility::wire::DispatchSuccess {
                        version: VERSION,
                        success: true,
                        status: 200,
                        data: serde_json::json!({
                            "lifecycle": if current == Lifecycle::Stopped { "stopped" } else { "accepted" }
                        }),
                    },
                ))
            }
            _ => compatibility_response(DispatchResponse::not_found(
                request.method(),
                request.path(),
            )),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Lifecycle {
    Running,
    Stopping,
    Stopped,
    Error,
}

impl Lifecycle {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Stopping => "stopping",
            Self::Stopped => "stopped",
            Self::Error => "error",
        }
    }
}

fn is_compatibility_route(method: &str, path: &str) -> bool {
    matches!(
        (method, path),
        ("GET", "/health")
            | ("POST", "/dispatch")
            | ("POST", "/lifecycle/restart")
            | ("POST", "/lifecycle/stop")
    )
}

fn pathname(path: &str) -> &str {
    path.split_once('?').map_or(path, |(path, _)| path)
}

fn is_get_route(path: &str) -> bool {
    matches!(
        path,
        "/api/sessions/events"
            | "/api/runtime-endpoints/list"
            | "/api/platform/tools"
            | "/api/usage/recent"
            | "/api/usage/session-timeseries"
            | "/api/settings/current"
            | "/api/security/policy/current"
            | "/api/security/audit/current"
            | "/api/security/audit"
            | "/api/security/destructive-rule-catalog/current"
    ) || is_provider_accounts_get_route(path)
        || is_catalog_surface_get_route(path)
}

fn is_session_route(path: &str) -> bool {
    matches!(
        path,
        "/api/sessions"
            | "/api/sessions/create"
            | "/api/sessions/delete"
            | "/api/sessions/rename"
            | "/api/sessions/permission"
            | "/api/sessions/send"
            | "/api/sessions/abort"
            | "/api/sessions/approvals/list"
            | "/api/sessions/approvals/respond"
            | "/api/sessions/model"
            | "/api/matcha/sessions"
            | "/api/sessions/load"
            | "/api/sessions/window"
            | "/api/sessions/content"
    )
}

fn is_workspace_read_route(path: &str) -> bool {
    matches!(
        path,
        "/api/workspace/files/read-text"
            | "/api/workspace/files/binary"
            | "/api/workspace/files/list-dir"
    )
}

fn is_channel_route(path: &str) -> bool {
    matches!(
        path,
        "/api/channels/status"
            | "/api/channels/pairing"
            | "/api/channels/catalog"
            | "/api/channels/configure"
            | "/api/channels/config/read"
            | "/api/channels/credentials/validate"
            | "/api/channels/control"
            | "/api/channels/login"
            | "/api/channels/delete-config"
    )
}

fn channel_body_limit(path: &str) -> usize {
    match path {
        "/api/channels/status" | "/api/channels/pairing" => CHANNEL_TINY_REQUEST_BYTES,
        "/api/channels/control" | "/api/channels/login" | "/api/channels/delete-config" => {
            CHANNEL_CONTROL_REQUEST_BYTES
        }
        "/api/channels/credentials/validate" => CHANNEL_CREDENTIALS_REQUEST_BYTES,
        _ => CHANNEL_CATALOG_REQUEST_BYTES,
    }
}

fn channel_deadline(path: &str) -> Duration {
    if path == "/api/channels/login" {
        CHANNEL_LOGIN_DEADLINE
    } else {
        SHORT_DEADLINE
    }
}

fn is_team_route(path: &str) -> bool {
    matches!(
        path,
        "/api/team/public"
            | "/api/team/role-sessions"
            | "/api/team/approvals"
            | "/api/team/task-board"
            | "/api/team/decision"
            | "/api/team/lifecycle"
            | "/api/team/graph"
            | "/api/team/skill"
            | "/api/team/manual-materialize-and-create"
    ) || is_task_manager_route(path)
        || is_trigger_route(path)
}

fn team_body_limit(path: &str) -> usize {
    if is_task_manager_route(path) {
        TASK_MANAGER_REQUEST_BYTES
    } else if is_trigger_route(path) {
        crate::transport::team::trigger::handler::max_body_bytes(path)
    } else {
        match path {
            "/api/team/graph" => TEAM_GRAPH_REQUEST_BYTES,
            "/api/team/manual-materialize-and-create" => TEAM_MANUAL_REQUEST_BYTES,
            _ => TEAM_SMALL_REQUEST_BYTES,
        }
    }
}

fn is_task_manager_route(path: &str) -> bool {
    matches!(
        path,
        "/api/tasks/list"
            | "/api/tasks/get"
            | "/api/tasks/create"
            | "/api/tasks/update"
            | "/api/tasks/todos/get"
            | "/api/tasks/todos/write"
    )
}

fn is_trigger_route(path: &str) -> bool {
    matches!(path, "/api/team/trigger" | "/api/team/webhook-auth")
        || crate::transport::team::trigger::handler::is_webhook_route(path)
}

fn is_provider_accounts_get_route(path: &str) -> bool {
    path == "/api/provider-accounts" || path.starts_with("/api/provider-accounts/")
}

fn is_provider_accounts_route(method: &str, path: &str) -> bool {
    let path = pathname(path);
    (method == "GET" && is_provider_accounts_get_route(path))
        || (method == "POST" && path == "/api/provider-accounts")
}

fn is_catalog_surface_route(method: &str, path: &str) -> bool {
    let path = pathname(path);
    (method == "GET" && is_catalog_surface_get_route(path))
        || (method == "POST" && is_catalog_surface_post_route(path))
}

fn is_catalog_surface_get_route(path: &str) -> bool {
    path.starts_with("/api/sealed-skills/read/")
        || path.starts_with("/api/sealed-agents/read/")
        || matches!(
            path,
            "/api/provider-models"
                | "/api/provider-models/selectable"
                | "/api/plugins/catalog"
                | "/api/plugins/runtime"
                | "/api/skills/status"
                | "/api/sealed-skills/status"
        )
}

fn is_catalog_surface_post_route(path: &str) -> bool {
    matches!(
        path,
        "/api/provider-models"
            | "/api/provider-routing"
            | "/api/plugins/configuration"
            | "/api/plugins/operation"
            | "/api/skills/detail"
            | "/api/skills/config"
            | "/api/skills/clawhub/install"
            | "/api/skills/clawhub/update"
            | "/api/skills/upload/begin"
            | "/api/skills/upload/chunk"
            | "/api/skills/upload/commit"
            | "/api/skills/uninstall"
            | "/api/skills/import/markdown"
            | "/api/skills/import/bundle"
            | "/api/skills/readme"
            | "/api/clawhub/search"
            | "/api/clawhub/skills/install"
            | "/api/subagents/skill-bundles/export"
            | "/api/subagents/skill-bundles/import"
            | "/api/sealed-skills/export"
            | "/api/sealed-skills/install"
            | "/api/sealed-skills/uninstall"
            | "/api/external-connectors"
            | "/api/openclaw/mcp-servers"
    )
}

fn is_security_policy_route(method: &str, path: &str) -> bool {
    let path = pathname(path);
    matches!(
        (method, path),
        ("GET", "/api/security/policy/current")
            | ("GET", "/api/security/audit/current")
            | ("GET", "/api/security/audit")
            | ("GET", "/api/security/destructive-rule-catalog/current")
            | ("POST", "/api/security/operation")
            | ("POST", "/api/security/policy")
    )
}

fn is_security_policy_post_route(path: &str) -> bool {
    matches!(path, "/api/security/operation" | "/api/security/policy")
}

fn is_diagnostics_route(path: &str) -> bool {
    matches!(
        path,
        "/api/diagnostics/archive" | "/api/diagnostics/archive/download"
    )
}

fn is_short_deadline_route(path: &str) -> bool {
    is_catalog_surface_route("GET", path)
        || is_catalog_surface_route("POST", path)
        || is_provider_accounts_route("GET", path)
        || is_provider_accounts_route("POST", path)
        || is_diagnostics_route(path)
        || matches!(
            path,
            "/api/settings/current"
                | "/api/settings/desired"
                | "/api/security/emergency"
                | "/api/security/policy/current"
                | "/api/security/audit/current"
                | "/api/security/audit"
                | "/api/security/destructive-rule-catalog/current"
                | "/api/security/operation"
                | "/api/security/policy"
                | "/api/subagents/agents"
        )
}

fn compatibility_response(response: DispatchResponse) -> Response {
    Response::json(response.status(), response.into_json())
}

fn build_health_response(lifecycle: Arc<AtomicU8>, started_at: SystemTime) -> HealthResponse {
    let lifecycle_value = lifecycle_from_atomic(lifecycle.load(Ordering::Acquire));
    HealthResponse {
        version: VERSION,
        ok: lifecycle_value == Lifecycle::Running,
        lifecycle: lifecycle_value.as_str(),
        pid: std::process::id(),
        uptime_sec: SystemTime::now()
            .duration_since(started_at)
            .unwrap_or_default()
            .as_secs(),
    }
}

async fn shutdown_until_terminal(owner: host_actor::Handle, lifecycle: Arc<AtomicU8>) {
    loop {
        match owner.shutdown().await {
            Ok(attempt) if attempt.terminal => {
                lifecycle.store(LIFECYCLE_STOPPED, Ordering::Release);
                break;
            }
            Ok(_) => tokio::time::sleep(SHUTDOWN_RETRY_DELAY).await,
            Err(_) => break,
        }
    }
}

fn stopped_dispatch_response() -> DispatchResponse {
    DispatchResponse::Failure(crate::transport::compatibility::wire::DispatchFailure {
        version: VERSION,
        success: false,
        status: 503,
        error: crate::transport::compatibility::wire::ErrorBody {
            code: "UPSTREAM_UNAVAILABLE",
            message: "Runtime Host is stopping".to_owned(),
        },
    })
}

fn lifecycle_from_atomic(value: u8) -> Lifecycle {
    match value {
        LIFECYCLE_RUNNING => Lifecycle::Running,
        LIFECYCLE_STOPPING => Lifecycle::Stopping,
        LIFECYCLE_STOPPED => Lifecycle::Stopped,
        _ => Lifecycle::Error,
    }
}
