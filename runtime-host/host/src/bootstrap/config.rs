use std::{
    fmt, fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use matcha_agent::lifecycle::secret::Secret;
use openclaw::{gateway::client::GatewayClientMetadata, lifecycle::state_dir::CanonicalStateDir};
use runtime_host::{
    HostInput, MatchaAgentInput, OpenClawInput, RuntimeObservationConfig, open_organization_store,
    transport::{authorization::CapabilityDecisionVerifier, team_trigger::WebhookToken},
};
use serde::Deserialize;
use zeroize::Zeroize;

const BOOTSTRAP_VERSION: u8 = 1;

pub(crate) struct Bootstrap {
    app_version: String,
    app_log_dir: PathBuf,
    runtime_host_state_dir: PathBuf,
    parent_callback_base_url: String,
    parent_callback_dispatch_token: String,
    provider_credential_resolver:
        Option<runtime_host::transport::provider_accounts::private_auth::Resolver>,
    runtime_observation: RuntimeObservationConfig,
    matcha: MatchaConfig,
    open_claw: OpenClawConfig,
    delivery_verification_key: String,
    cron_broker_verification_key: String,
    compatibility_transport_port: u16,
    session_transport_port: u16,
    task_manager_transport_port: u16,
    session_send_transport_port: u16,
    session_abort_transport_port: u16,
    session_approval_transport_port: u16,
    security_emergency_transport_port: u16,
    channel_status_transport_port: u16,
    channel_catalog_transport_port: u16,
    channel_control_transport_port: u16,
    channel_pairing_transport_port: u16,
    session_model_selection_transport_port: u16,
    openclaw_history_transport_port: u16,
    matcha_history_transport_port: u16,
    usage_transport_port: u16,
    diagnostics_transport_port: u16,
    workspace_text_transport_port: u16,
    workspace_binary_transport_port: u16,
    workspace_directory_transport_port: u16,
    workspace_write_transport_port: u16,
    workspace_media_transport_port: u16,
    cron_transport_port: u16,
    cron_broker_transport_port: u16,
    agents_transport_port: u16,
    team_public_transport_port: u16,
    team_task_board_transport_port: u16,
    fleet_transport_port: u16,
    team_role_sessions_transport_port: u16,
    team_approvals_transport_port: u16,
    team_decision_transport_port: u16,
    team_role_chat_transport_port: u16,
    team_graph_transport_port: u16,
    provider_models_transport_port: u16,
    provider_accounts_transport_port: u16,
    team_skill_transport_port: u16,
    team_trigger_transport_port: u16,
    team_lifecycle_transport_port: u16,
    manual_team_transport_port: u16,
    settings_desired_transport_port: u16,
    security_policy_transport_port: u16,
    #[cfg(unix)]
    guardian_executable: PathBuf,
}

pub(crate) struct BootstrapParts {
    pub(crate) host: HostInput,
    pub(crate) verifier: CapabilityDecisionVerifier,
    pub(crate) cron_broker_verifier: CapabilityDecisionVerifier,
    pub(crate) provider_credential_resolver:
        Option<runtime_host::transport::provider_accounts::private_auth::Resolver>,
    pub(crate) webhook_token: WebhookToken,
    pub(crate) compatibility_transport_port: u16,
    pub(crate) session_transport_port: u16,
    pub(crate) task_manager_transport_port: u16,
    pub(crate) session_send_transport_port: u16,
    pub(crate) session_abort_transport_port: u16,
    pub(crate) session_approval_transport_port: u16,
    pub(crate) security_emergency_transport_port: u16,
    pub(crate) channel_status_transport_port: u16,
    pub(crate) channel_catalog_transport_port: u16,
    pub(crate) channel_control_transport_port: u16,
    pub(crate) channel_pairing_transport_port: u16,
    pub(crate) session_model_selection_transport_port: u16,
    pub(crate) openclaw_history_transport_port: u16,
    pub(crate) matcha_history_transport_port: u16,
    pub(crate) usage_transport_port: u16,
    pub(crate) diagnostics_transport_port: u16,
    pub(crate) workspace_text_transport_port: u16,
    pub(crate) workspace_binary_transport_port: u16,
    pub(crate) workspace_directory_transport_port: u16,
    pub(crate) workspace_write_transport_port: u16,
    pub(crate) workspace_media_transport_port: u16,
    pub(crate) cron_transport_port: u16,
    pub(crate) cron_broker_transport_port: u16,
    pub(crate) agents_transport_port: u16,
    pub(crate) team_public_transport_port: u16,
    pub(crate) team_task_board_transport_port: u16,
    pub(crate) fleet_transport_port: u16,
    pub(crate) team_role_sessions_transport_port: u16,
    pub(crate) team_approvals_transport_port: u16,
    pub(crate) team_decision_transport_port: u16,
    pub(crate) team_role_chat_transport_port: u16,
    pub(crate) team_graph_transport_port: u16,
    pub(crate) provider_models_transport_port: u16,
    pub(crate) provider_accounts_transport_port: u16,
    pub(crate) team_skill_transport_port: u16,
    pub(crate) team_trigger_transport_port: u16,
    pub(crate) team_lifecycle_transport_port: u16,
    pub(crate) manual_team_transport_port: u16,
    pub(crate) settings_desired_transport_port: u16,
    pub(crate) security_policy_transport_port: u16,
}

impl Bootstrap {
    pub(crate) fn into_parts(self) -> Result<BootstrapParts, BootstrapError> {
        let state_dir =
            CanonicalStateDir::provision(&self.open_claw.state_dir).map_err(|_| BootstrapError)?;
        let runtime_host_state_dir =
            provision_runtime_host_state_dir(&self.runtime_host_state_dir)?;
        let webhook_token = super::webhook_token::load_or_create(&runtime_host_state_dir)?;
        let matcha_secret =
            runtime_secret().and_then(|value| Secret::new(value).map_err(|_| BootstrapError))?;
        let open_claw_secret = super::gateway_token::load_or_create(&state_dir)?;
        let metadata =
            GatewayClientMetadata::try_new(self.app_version, std::env::consts::OS.into())
                .map_err(|_| BootstrapError)?;
        let organization_store =
            open_organization_store(&runtime_host_state_dir).map_err(|_| BootstrapError)?;

        let verifier = CapabilityDecisionVerifier::try_new(&self.delivery_verification_key)
            .map_err(|_| BootstrapError)?;
        let cron_broker_verifier =
            CapabilityDecisionVerifier::try_new(&self.cron_broker_verification_key)
                .map_err(|_| BootstrapError)?;
        let session_transport_port = self.session_transport_port;
        let task_manager_transport_port = self.task_manager_transport_port;
        let session_send_transport_port = self.session_send_transport_port;
        let session_abort_transport_port = self.session_abort_transport_port;
        let session_approval_transport_port = self.session_approval_transport_port;
        let security_emergency_transport_port = self.security_emergency_transport_port;
        let channel_status_transport_port = self.channel_status_transport_port;
        let channel_catalog_transport_port = self.channel_catalog_transport_port;
        let channel_control_transport_port = self.channel_control_transport_port;
        let channel_pairing_transport_port = self.channel_pairing_transport_port;
        let session_model_selection_transport_port = self.session_model_selection_transport_port;
        let openclaw_history_transport_port = self.openclaw_history_transport_port;
        let matcha_history_transport_port = self.matcha_history_transport_port;
        let usage_transport_port = self.usage_transport_port;
        let diagnostics_transport_port = self.diagnostics_transport_port;
        let workspace_text_transport_port = self.workspace_text_transport_port;
        let workspace_binary_transport_port = self.workspace_binary_transport_port;
        let workspace_directory_transport_port = self.workspace_directory_transport_port;
        let workspace_write_transport_port = self.workspace_write_transport_port;
        let workspace_media_transport_port = self.workspace_media_transport_port;
        let cron_transport_port = self.cron_transport_port;
        let agents_transport_port = self.agents_transport_port;
        let team_public_transport_port = self.team_public_transport_port;
        let team_task_board_transport_port = self.team_task_board_transport_port;
        let fleet_transport_port = self.fleet_transport_port;
        let team_role_sessions_transport_port = self.team_role_sessions_transport_port;
        let team_approvals_transport_port = self.team_approvals_transport_port;
        let team_decision_transport_port = self.team_decision_transport_port;
        let team_role_chat_transport_port = self.team_role_chat_transport_port;
        let team_graph_transport_port = self.team_graph_transport_port;
        let provider_models_transport_port = self.provider_models_transport_port;
        let provider_accounts_transport_port = self.provider_accounts_transport_port;
        let team_skill_transport_port = self.team_skill_transport_port;
        let team_trigger_transport_port = self.team_trigger_transport_port;
        let team_lifecycle_transport_port = self.team_lifecycle_transport_port;
        let manual_team_transport_port = self.manual_team_transport_port;
        let settings_desired_transport_port = self.settings_desired_transport_port;
        let security_policy_transport_port = self.security_policy_transport_port;
        let compatibility_transport_port = self.compatibility_transport_port;
        Ok(BootstrapParts {
            compatibility_transport_port,
            host: HostInput {
                matcha: MatchaAgentInput {
                    bun_executable: self.matcha.bun_executable,
                    entry: self.matcha.entry,
                    working_directory: self.matcha.working_directory,
                    storage_root: self.matcha.storage_root,
                    port: self.matcha.port,
                    #[cfg(windows)]
                    git_bash: self.matcha.git_bash,
                    #[cfg(unix)]
                    guardian_executable: self.guardian_executable.clone(),
                },
                matcha_secret,
                open_claw: OpenClawInput {
                    electron_image: self.open_claw.electron_image,
                    working_directory: self.open_claw.working_directory,
                    openclaw_dir: self.open_claw.openclaw_dir,
                    managed_plugin_root: self.open_claw.managed_plugin_root,
                    companion_skill_source_root: self.open_claw.companion_skill_source_root,
                    subagent_template_dir: self.open_claw.subagent_template_dir,
                    entry: self.open_claw.entry,
                    state_dir,
                    port: self.open_claw.port,
                    client_metadata: metadata,
                    report_diagnostic: Arc::new(|_| {}),
                    #[cfg(unix)]
                    guardian_executable: self.guardian_executable,
                },
                open_claw_secret,
                organization_store,
                runtime_state_dir: runtime_host_state_dir,
                app_log_dir: self.app_log_dir,
                parent_callback_base_url: self.parent_callback_base_url,
                parent_callback_dispatch_token: self.parent_callback_dispatch_token,
                cron_transport_port,
                runtime_observation: self.runtime_observation,
            },
            verifier,
            cron_broker_verifier,
            provider_credential_resolver: self.provider_credential_resolver,
            webhook_token,
            session_transport_port,
            task_manager_transport_port,
            session_send_transport_port,
            session_abort_transport_port,
            session_approval_transport_port,
            security_emergency_transport_port,
            channel_status_transport_port,
            channel_catalog_transport_port,
            channel_control_transport_port,
            channel_pairing_transport_port,
            session_model_selection_transport_port,
            openclaw_history_transport_port,
            matcha_history_transport_port,
            usage_transport_port,
            diagnostics_transport_port,
            workspace_text_transport_port,
            workspace_binary_transport_port,
            workspace_directory_transport_port,
            workspace_write_transport_port,
            workspace_media_transport_port,
            cron_transport_port,
            cron_broker_transport_port: self.cron_broker_transport_port,
            agents_transport_port,
            team_public_transport_port,
            team_task_board_transport_port,
            fleet_transport_port,
            team_role_sessions_transport_port,
            team_approvals_transport_port,
            team_decision_transport_port,
            team_role_chat_transport_port,
            team_graph_transport_port,
            provider_models_transport_port,
            provider_accounts_transport_port,
            team_skill_transport_port,
            team_trigger_transport_port,
            team_lifecycle_transport_port,
            manual_team_transport_port,
            settings_desired_transport_port,
            security_policy_transport_port,
        })
    }
}

pub(crate) fn decode(mut input: Vec<u8>) -> Result<Bootstrap, BootstrapError> {
    let parsed = serde_json::from_slice::<Wire>(&input);
    input.zeroize();
    let wire = parsed.map_err(|_| BootstrapError)?;
    if wire.version != BOOTSTRAP_VERSION {
        return Err(BootstrapError);
    }

    let app_version = non_empty(wire.app_version)?;
    let runtime_host_state_dir = absolute(wire.runtime_host_state_dir)?;
    let parent_callback_base_url = non_empty(wire.parent_callback_base_url)?;
    let parent_callback_dispatch_token = non_empty(wire.parent_callback_dispatch_token)?;
    let delivery_verification_key = non_empty(wire.delivery_verification_key)?;
    let cron_broker_verification_key = non_empty(wire.cron_broker_verification_key)?;
    let provider_credential_resolver = wire
        .provider_credential_resolver
        .map(|value| {
            runtime_host::transport::provider_accounts::private_auth::Resolver::try_new(
                value.endpoint,
                value.authorization,
            )
        })
        .transpose()
        .map_err(|_| BootstrapError)?;
    let runtime_observation = runtime_observation(wire.runtime_observation)?;
    let compatibility_transport_port = compatibility_port();
    let session_transport_port = port(wire.session_transport_port)?;
    let task_manager_transport_port = port(wire.task_manager_transport_port)?;
    let session_send_transport_port = port(wire.session_send_transport_port)?;
    let session_abort_transport_port = port(wire.session_abort_transport_port)?;
    let session_approval_transport_port = port(wire.session_approval_transport_port)?;
    let security_emergency_transport_port = port(wire.security_emergency_transport_port)?;
    let channel_status_transport_port = port(wire.channel_status_transport_port)?;
    let channel_catalog_transport_port = port(wire.channel_catalog_transport_port)?;
    let channel_control_transport_port = port(wire.channel_control_transport_port)?;
    let channel_pairing_transport_port = port(wire.channel_pairing_transport_port)?;
    let session_model_selection_transport_port = port(wire.session_model_selection_transport_port)?;
    let openclaw_history_transport_port = port(wire.openclaw_history_transport_port)?;
    let matcha_history_transport_port = port(wire.matcha_history_transport_port)?;
    let usage_transport_port = port(wire.usage_transport_port)?;
    let diagnostics_transport_port = port(wire.diagnostics_transport_port)?;
    let workspace_text_transport_port = port(wire.workspace_text_transport_port)?;
    let workspace_binary_transport_port = port(wire.workspace_binary_transport_port)?;
    let workspace_directory_transport_port = port(wire.workspace_directory_transport_port)?;
    let workspace_write_transport_port = port(wire.workspace_write_transport_port)?;
    let workspace_media_transport_port = port(wire.workspace_media_transport_port)?;
    let cron_transport_port = port(wire.cron_transport_port)?;
    let cron_broker_transport_port = port(wire.cron_broker_transport_port)?;
    let agents_transport_port = port(wire.agents_transport_port)?;
    let team_public_transport_port = port(wire.team_public_transport_port)?;
    let team_task_board_transport_port = port(wire.team_task_board_transport_port)?;
    let fleet_transport_port = port(wire.fleet_transport_port)?;
    let team_role_sessions_transport_port = port(wire.team_role_sessions_transport_port)?;
    let team_approvals_transport_port = port(wire.team_approvals_transport_port)?;
    let team_decision_transport_port = port(wire.team_decision_transport_port)?;
    let team_role_chat_transport_port = port(wire.team_role_chat_transport_port)?;
    let team_graph_transport_port = port(wire.team_graph_transport_port)?;
    let provider_models_transport_port = port(wire.provider_models_transport_port)?;
    let provider_accounts_transport_port = port(wire.provider_accounts_transport_port)?;
    let team_skill_transport_port = port(wire.team_skill_transport_port)?;
    let team_trigger_transport_port = port(wire.team_trigger_transport_port)?;
    let team_lifecycle_transport_port = port(wire.team_lifecycle_transport_port)?;
    let manual_team_transport_port = port(wire.manual_team_transport_port)?;
    let settings_desired_transport_port = port(wire.settings_desired_transport_port)?;
    let security_policy_transport_port = port(wire.security_policy_transport_port)?;
    let matcha = MatchaConfig {
        bun_executable: absolute(wire.matcha.bun_executable)?,
        entry: absolute(wire.matcha.entry)?,
        working_directory: absolute(wire.matcha.working_directory)?,
        storage_root: absolute(wire.matcha.storage_root)?,
        port: port(wire.matcha.port)?,
        #[cfg(windows)]
        git_bash: absolute(wire.matcha.git_bash)?,
    };
    absolute(wire.matcha.private_secret_root)?;
    let open_claw = OpenClawConfig {
        electron_image: absolute(wire.open_claw.electron_image)?,
        working_directory: absolute(wire.open_claw.working_directory)?,
        openclaw_dir: absolute(wire.open_claw.openclaw_dir)?,
        managed_plugin_root: absolute(wire.open_claw.managed_plugin_root)?,
        companion_skill_source_root: absolute(wire.open_claw.companion_skill_source_root)?,
        subagent_template_dir: absolute(wire.open_claw.subagent_template_dir)?,
        entry: absolute(wire.open_claw.entry)?,
        state_dir: absolute(wire.open_claw.state_dir)?,
        port: port(wire.open_claw.port)?,
    };
    if matcha.port == open_claw.port
        || [
            compatibility_transport_port,
            session_transport_port,
            task_manager_transport_port,
            session_send_transport_port,
            session_abort_transport_port,
            session_approval_transport_port,
            security_emergency_transport_port,
            channel_status_transport_port,
            channel_catalog_transport_port,
            channel_control_transport_port,
            channel_pairing_transport_port,
            session_model_selection_transport_port,
            openclaw_history_transport_port,
            matcha_history_transport_port,
            usage_transport_port,
            diagnostics_transport_port,
            workspace_text_transport_port,
            workspace_binary_transport_port,
            workspace_directory_transport_port,
            workspace_write_transport_port,
            workspace_media_transport_port,
            cron_transport_port,
            cron_broker_transport_port,
            agents_transport_port,
            team_public_transport_port,
            team_task_board_transport_port,
            fleet_transport_port,
            team_role_sessions_transport_port,
            team_approvals_transport_port,
            team_decision_transport_port,
            team_role_chat_transport_port,
            team_graph_transport_port,
            provider_models_transport_port,
            provider_accounts_transport_port,
            team_skill_transport_port,
            team_trigger_transport_port,
            team_lifecycle_transport_port,
            manual_team_transport_port,
            settings_desired_transport_port,
            security_policy_transport_port,
            matcha.port,
            open_claw.port,
        ]
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>()
        .len()
            != 42
    {
        return Err(BootstrapError);
    }

    Ok(Bootstrap {
        app_version,
        app_log_dir: absolute(wire.app_log_dir)?,
        runtime_host_state_dir,
        parent_callback_base_url,
        parent_callback_dispatch_token,
        provider_credential_resolver,
        runtime_observation,
        compatibility_transport_port,
        matcha,
        open_claw,
        delivery_verification_key,
        cron_broker_verification_key,
        session_transport_port,
        task_manager_transport_port,
        session_send_transport_port,
        session_abort_transport_port,
        session_approval_transport_port,
        security_emergency_transport_port,
        channel_status_transport_port,
        channel_catalog_transport_port,
        channel_control_transport_port,
        channel_pairing_transport_port,
        session_model_selection_transport_port,
        openclaw_history_transport_port,
        matcha_history_transport_port,
        usage_transport_port,
        diagnostics_transport_port,
        workspace_text_transport_port,
        workspace_binary_transport_port,
        workspace_directory_transport_port,
        workspace_write_transport_port,
        workspace_media_transport_port,
        cron_transport_port,
        cron_broker_transport_port,
        agents_transport_port,
        team_public_transport_port,
        team_task_board_transport_port,
        fleet_transport_port,
        team_role_sessions_transport_port,
        team_approvals_transport_port,
        team_decision_transport_port,
        team_role_chat_transport_port,
        team_graph_transport_port,
        provider_models_transport_port,
        provider_accounts_transport_port,
        team_skill_transport_port,
        team_trigger_transport_port,
        team_lifecycle_transport_port,
        manual_team_transport_port,
        settings_desired_transport_port,
        security_policy_transport_port,
        #[cfg(unix)]
        guardian_executable: absolute(wire.guardian_executable)?,
    })
}

struct MatchaConfig {
    bun_executable: PathBuf,
    entry: PathBuf,
    working_directory: PathBuf,
    storage_root: PathBuf,
    port: u16,
    #[cfg(windows)]
    git_bash: PathBuf,
}

struct OpenClawConfig {
    electron_image: PathBuf,
    working_directory: PathBuf,
    openclaw_dir: PathBuf,
    companion_skill_source_root: PathBuf,
    managed_plugin_root: PathBuf,
    subagent_template_dir: PathBuf,
    entry: PathBuf,
    state_dir: PathBuf,
    port: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Wire {
    version: u8,
    app_version: String,
    app_log_dir: String,
    runtime_host_state_dir: String,
    parent_callback_base_url: String,
    parent_callback_dispatch_token: String,
    #[serde(default)]
    provider_credential_resolver: Option<ProviderCredentialResolverWire>,
    #[serde(default)]
    runtime_observation: RuntimeObservationWire,
    delivery_verification_key: String,
    cron_broker_verification_key: String,
    session_transport_port: u16,
    task_manager_transport_port: u16,
    session_send_transport_port: u16,
    session_abort_transport_port: u16,
    session_approval_transport_port: u16,
    security_emergency_transport_port: u16,
    channel_status_transport_port: u16,
    channel_catalog_transport_port: u16,
    channel_control_transport_port: u16,
    channel_pairing_transport_port: u16,
    session_model_selection_transport_port: u16,
    openclaw_history_transport_port: u16,
    matcha_history_transport_port: u16,
    usage_transport_port: u16,
    diagnostics_transport_port: u16,
    workspace_text_transport_port: u16,
    workspace_binary_transport_port: u16,
    workspace_directory_transport_port: u16,
    workspace_write_transport_port: u16,
    workspace_media_transport_port: u16,
    cron_transport_port: u16,
    cron_broker_transport_port: u16,
    agents_transport_port: u16,
    team_public_transport_port: u16,
    team_task_board_transport_port: u16,
    fleet_transport_port: u16,
    team_role_sessions_transport_port: u16,
    team_approvals_transport_port: u16,
    team_decision_transport_port: u16,
    team_role_chat_transport_port: u16,
    team_graph_transport_port: u16,
    provider_models_transport_port: u16,
    provider_accounts_transport_port: u16,
    team_skill_transport_port: u16,
    team_trigger_transport_port: u16,
    team_lifecycle_transport_port: u16,
    manual_team_transport_port: u16,
    settings_desired_transport_port: u16,
    security_policy_transport_port: u16,
    matcha: MatchaWire,
    open_claw: OpenClawWire,
    #[cfg(unix)]
    guardian_executable: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeObservationWire {
    #[serde(default)]
    mode: RuntimeObservationModeWire,
    #[serde(default)]
    archive: bool,
    #[serde(default)]
    diagnostic_ttl_ms: Option<u64>,
}

impl Default for RuntimeObservationWire {
    fn default() -> Self {
        Self {
            mode: RuntimeObservationModeWire::Off,
            archive: false,
            diagnostic_ttl_ms: None,
        }
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum RuntimeObservationModeWire {
    Off,
    Normal,
    Diagnostic,
}

impl Default for RuntimeObservationModeWire {
    fn default() -> Self {
        Self::Off
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderCredentialResolverWire {
    endpoint: String,
    authorization: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MatchaWire {
    bun_executable: String,
    entry: String,
    working_directory: String,
    storage_root: String,
    port: u16,
    private_secret_root: String,
    #[cfg(windows)]
    git_bash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenClawWire {
    electron_image: String,
    working_directory: String,
    openclaw_dir: String,
    companion_skill_source_root: String,
    managed_plugin_root: String,
    subagent_template_dir: String,
    entry: String,
    state_dir: String,
    port: u16,
}

fn runtime_observation(
    wire: RuntimeObservationWire,
) -> Result<RuntimeObservationConfig, BootstrapError> {
    match wire.mode {
        RuntimeObservationModeWire::Off => Ok(RuntimeObservationConfig::off()),
        RuntimeObservationModeWire::Normal => Ok(RuntimeObservationConfig::normal(wire.archive)),
        RuntimeObservationModeWire::Diagnostic => {
            let ttl = wire
                .diagnostic_ttl_ms
                .filter(|value| *value != 0)
                .ok_or(BootstrapError)?;
            Ok(RuntimeObservationConfig::diagnostic(
                wire.archive,
                Duration::from_millis(ttl),
            ))
        }
    }
}

fn port(value: u16) -> Result<u16, BootstrapError> {
    (value != 0).then_some(value).ok_or(BootstrapError)
}

fn compatibility_port() -> u16 {
    std::env::var("MATCHACLAW_RUNTIME_HOST_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port != 0)
        .unwrap_or(3211)
}

fn provision_runtime_host_state_dir(path: &Path) -> Result<PathBuf, BootstrapError> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).map_err(|_| BootstrapError)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| BootstrapError)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(BootstrapError);
    }
    Ok(path.to_path_buf())
}

fn absolute(value: String) -> Result<PathBuf, BootstrapError> {
    if value.contains('\0') {
        return Err(BootstrapError);
    }

    let path = PathBuf::from(value);
    path.is_absolute().then_some(path).ok_or(BootstrapError)
}

fn non_empty(value: String) -> Result<String, BootstrapError> {
    (!value.trim().is_empty() && !value.contains('\0'))
        .then_some(value)
        .ok_or(BootstrapError)
}

fn runtime_secret() -> Result<String, BootstrapError> {
    let mut bytes = [0_u8; 48];
    getrandom::fill(&mut bytes).map_err(|_| BootstrapError)?;
    let encoded = URL_SAFE_NO_PAD.encode(bytes);
    bytes.zeroize();
    Ok(encoded)
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct BootstrapError;

impl fmt::Display for BootstrapError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("runtime-host bootstrap configuration is invalid")
    }
}

impl std::error::Error for BootstrapError {}

#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;
