#![recursion_limit = "512"]

mod bootstrap;

use std::process::ExitCode;

use runtime_host::{DeliveryTransportInput, run_delivery_transports};
use tokio::io::{stdin, stdout};

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("runtime-host: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), Error> {
    if std::env::var_os("MATCHACLAW_DEBUG_CRON_PROVIDER").is_some() {
        eprintln!("[DEBUG-cron-provider] host=process_started");
    }
    let mut control_input = stdin();
    let bootstrap = bootstrap::read(&mut control_input)
        .await
        .map_err(Error::Bootstrap)?;
    let parts = bootstrap.into_parts().map_err(Error::Bootstrap)?;

    run_delivery_transports(DeliveryTransportInput {
        host: parts.host,
        verifier: parts.verifier,
        cron_broker_verifier: parts.cron_broker_verifier,
        provider_credential_resolver: parts.provider_credential_resolver,
        webhook_token: parts.webhook_token,
        compatibility_transport_port: parts.compatibility_transport_port,
        session_transport_port: parts.session_transport_port,
        task_manager_transport_port: parts.task_manager_transport_port,
        session_send_transport_port: parts.session_send_transport_port,
        session_abort_transport_port: parts.session_abort_transport_port,
        session_approval_transport_port: parts.session_approval_transport_port,
        security_emergency_transport_port: parts.security_emergency_transport_port,
        channel_status_transport_port: parts.channel_status_transport_port,
        channel_catalog_transport_port: parts.channel_catalog_transport_port,
        channel_control_transport_port: parts.channel_control_transport_port,
        channel_pairing_transport_port: parts.channel_pairing_transport_port,
        session_model_selection_transport_port: parts.session_model_selection_transport_port,
        matcha_history_transport_port: parts.matcha_history_transport_port,
        usage_transport_port: parts.usage_transport_port,
        diagnostics_transport_port: parts.diagnostics_transport_port,
        workspace_text_transport_port: parts.workspace_text_transport_port,
        workspace_binary_transport_port: parts.workspace_binary_transport_port,
        workspace_directory_transport_port: parts.workspace_directory_transport_port,
        workspace_write_transport_port: parts.workspace_write_transport_port,
        workspace_media_transport_port: parts.workspace_media_transport_port,
        cron_transport_port: parts.cron_transport_port,
        cron_broker_transport_port: parts.cron_broker_transport_port,
        agents_transport_port: parts.agents_transport_port,
        team_public_transport_port: parts.team_public_transport_port,
        team_task_board_transport_port: parts.team_task_board_transport_port,
        fleet_transport_port: parts.fleet_transport_port,
        team_role_sessions_transport_port: parts.team_role_sessions_transport_port,
        team_approvals_transport_port: parts.team_approvals_transport_port,
        team_decision_transport_port: parts.team_decision_transport_port,
        team_role_chat_transport_port: parts.team_role_chat_transport_port,
        team_graph_transport_port: parts.team_graph_transport_port,
        provider_models_transport_port: parts.provider_models_transport_port,
        provider_accounts_transport_port: parts.provider_accounts_transport_port,
        team_skill_transport_port: parts.team_skill_transport_port,
        team_trigger_transport_port: parts.team_trigger_transport_port,
        team_lifecycle_transport_port: parts.team_lifecycle_transport_port,
        manual_team_transport_port: parts.manual_team_transport_port,
        settings_desired_transport_port: parts.settings_desired_transport_port,
        security_policy_transport_port: parts.security_policy_transport_port,
        control_input,
        control_output: stdout(),
    })
    .await
    .map_err(Error::Control)
}

#[derive(Debug)]
enum Error {
    Bootstrap(bootstrap::BootstrapError),
    Control(runtime_host::ControlError),
}

impl std::fmt::Display for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Bootstrap(error) => error.fmt(formatter),
            Self::Control(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for Error {}
