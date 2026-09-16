mod capabilities;
mod fleet;
mod host;
mod plugins;
mod runtime;
mod sessions;
mod skills;
mod team;

use ::organization as organization_domain;
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};

use crate::{
    RuntimeSessionError,
    composition::PeerHandle,
    facade::{CronHandle, PlatformRuntimeHandle, PluginsHandle, SkillsHandle, ToolchainHandle},
    fleet::handle::FleetHandle,
    host_actor::Handle,
    runtime::driver::RuntimeDriverIdentity,
};

use super::wire::{Command, CommandInput, CommandOutcome, CommandResult, RejectionCode};

pub(super) const INVALID_INPUT_MESSAGE: &str = "Runtime Host command input is invalid.";
pub(super) const RUNTIME_UNAVAILABLE_MESSAGE: &str = "Runtime Host is unavailable.";
pub(super) const COMMAND_FAILED_MESSAGE: &str = "Runtime Host command failed.";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct InvalidPayload;

#[cfg(test)]
use plugins::is_plugin_target;
#[cfg(test)]
use runtime::{
    ToolPermissionModeRequest, decode_browser_request, decode_manual_cron_trigger,
    decode_mcp_app_request, openclaw_gateway_request_outcome,
};
#[cfg(test)]
use sessions::{decode_abort, decode_send};
#[cfg(test)]
use skills::{decode_skill_bundles, is_skill_capability_request};
#[cfg(test)]
use team::{team_public_unavailable_section_name, team_runtime_command, team_runtime_outcome};

pub(crate) async fn execute(
    owner: &Handle,
    organization: &crate::organization::OrganizationHandle,
    peer: &PeerHandle,
    fleet: &FleetHandle,
    session: &crate::sessions::SessionHandle,
    platform_runtime: &PlatformRuntimeHandle,
    toolchain: &ToolchainHandle,
    plugins: &PluginsHandle,
    skills: &SkillsHandle,
    cron: &CronHandle,
    command: Command,
) -> CommandOutcome {
    match command {
        Command::HostHealth {} => host::health(owner).await,
        Command::HostRuntimeSnapshot {} => host::runtime_snapshot(owner, peer).await,
        Command::HostCapabilitiesList {} => capabilities::list(),
        Command::HostCapabilitiesDescribe { input } => capabilities::describe(input),
        Command::OpenClawSkillsExecute { input } => {
            skills::openclaw_skills_execute(skills, input).await
        }
        Command::TeamRuntimeExecute { input } => {
            team::team_runtime_execute(organization, input).await
        }
        Command::OpenClawPluginsExecute { input } => {
            plugins::openclaw_plugins_execute(plugins, input).await
        }
        Command::MatchaStatus {} => runtime::matcha_status(peer).await,
        Command::MatchaStart {} => runtime::start_matcha(peer).await,
        Command::MatchaStop {} => runtime::stop_matcha(peer).await,
        Command::MatchaRestart {} => runtime::restart_matcha(peer).await,
        Command::OpenClawStatus {} => runtime::status(peer).await,
        Command::OpenClawPluginsCatalog {} => plugins::plugins_catalog(plugins).await,
        Command::OpenClawPluginsRuntime {} => plugins::plugins_runtime(plugins).await,
        Command::OpenClawPluginsSetEnabled { input } => {
            plugins::plugins_set_enabled(plugins, input).await
        }
        Command::OpenClawPluginsOperation { input } => {
            plugins::plugins_operation(plugins, input).await
        }
        Command::OpenClawEnvironmentStatus {} => {
            runtime::openclaw_environment_status(platform_runtime).await
        }
        Command::OpenClawRuntimePaths {} => runtime::openclaw_runtime_paths(platform_runtime).await,
        Command::OpenClawCliCommand {} => runtime::openclaw_cli_command(platform_runtime).await,
        Command::OpenClawToolPermissionGet {} => {
            runtime::openclaw_tool_permission_get(platform_runtime).await
        }
        Command::OpenClawToolPermissionSet { input } => {
            runtime::openclaw_tool_permission_set(platform_runtime, input).await
        }
        Command::HostToolchainStatus {} => host::toolchain_status(toolchain).await,
        Command::HostToolchainPrepare {} => host::toolchain_prepare(toolchain).await,
        Command::OpenClawSubagentTemplateCatalog {} => {
            runtime::subagent_template_catalog(platform_runtime).await
        }
        Command::OpenClawSubagentTemplate { input } => {
            runtime::subagent_template(platform_runtime, input).await
        }
        Command::OpenClawStart {} => runtime::start(peer).await,
        Command::OpenClawStop {} => runtime::stop(peer).await,
        Command::OpenClawRestart {} => runtime::restart(peer).await,
        Command::OpenClawLogs { input } => runtime::logs(peer, input).await,
        Command::OpenClawControlReady {} => runtime::control_ready(peer).await,
        Command::OpenClawGatewayHealth {} => runtime::gateway_health(peer).await,
        Command::OpenClawGatewayStatus {} => runtime::gateway_status(peer).await,
        Command::OpenClawControlUiUrl {} => runtime::control_ui_url(peer).await,
        Command::OpenClawManualCronTrigger { input } => {
            runtime::manually_trigger_openclaw_cron(cron, input).await
        }
        Command::OpenClawBrowserRequest { input } => {
            runtime::openclaw_browser_request(peer, input).await
        }
        Command::OpenClawMcpAppRequest { input } => {
            runtime::openclaw_mcp_app_request(peer, input).await
        }
        Command::OpenClawChatSend { input } => sessions::send_openclaw_chat(session, input).await,
        Command::OpenClawChatAbort { input } => sessions::abort_openclaw_chat(session, input).await,
        Command::FleetCredentialsWrite { input } => {
            fleet::fleet_credentials_write(fleet, input).await
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CapabilityExecuteRequest {
    pub(super) id: String,
    pub(super) operation_id: String,
    pub(super) scope: Value,
    pub(super) target: Value,
    pub(super) input: Value,
    #[serde(rename = "traceId", default)]
    pub(super) trace_id: Option<String>,
}

pub(super) fn is_native_runtime_scope(value: &Value) -> bool {
    is_native_runtime_scope_for(value, RuntimeDriverIdentity::open_claw())
}

pub(super) fn is_team_runtime_facade_scope(value: &Value) -> bool {
    team_runtime_facade_endpoint(value).is_some()
}

pub(super) fn team_runtime_facade_endpoint(
    value: &Value,
) -> Option<organization_domain::RuntimeEndpointReference> {
    for identity in [
        RuntimeDriverIdentity::open_claw(),
        RuntimeDriverIdentity::matcha_agent(),
    ] {
        if is_native_runtime_scope_for(value, identity) {
            return organization_domain::RuntimeEndpointReference::try_new(
                identity.runtime_endpoint_reference().to_owned(),
            )
            .ok();
        }
    }
    None
}

fn is_native_runtime_scope_for(value: &Value, identity: RuntimeDriverIdentity) -> bool {
    value
        == &json!({
            "kind": "runtime-instance",
            "endpoint": {
                "kind": "native-runtime",
                "runtimeAdapterId": identity.runtime_adapter_id(),
                "runtimeInstanceId": identity.runtime_instance_id(),
            },
        })
}

pub(super) fn decode<T: DeserializeOwned>(input: CommandInput) -> Result<T, InvalidPayload> {
    serde_json::from_value(input.into_value()).map_err(|_| InvalidPayload)
}

pub(super) fn invalid_input() -> CommandOutcome {
    CommandOutcome::rejected(RejectionCode::InvalidInput, INVALID_INPUT_MESSAGE)
}

pub(super) fn internal_error() -> CommandOutcome {
    CommandOutcome::rejected(RejectionCode::Failed, COMMAND_FAILED_MESSAGE)
}

pub(super) fn unavailable() -> CommandOutcome {
    CommandOutcome::rejected(RejectionCode::Unavailable, RUNTIME_UNAVAILABLE_MESSAGE)
}

pub(super) fn session_failure<E>(error: RuntimeSessionError<E>) -> CommandOutcome {
    match error {
        RuntimeSessionError::AdmissionClosed(_) | RuntimeSessionError::RuntimeUnavailable => {
            CommandOutcome::rejected(RejectionCode::Unavailable, RUNTIME_UNAVAILABLE_MESSAGE)
        }
        RuntimeSessionError::Client(_) => internal_error(),
    }
}

#[cfg(test)]
#[path = "dispatch_tests.rs"]
mod tests;
