mod dispatch;
mod frame;
mod lifecycle;
mod wire;

pub(crate) use wire::{
    CommandInput, CommandOutcome, CronExecutionId, RejectionCode, SafeCronExecutionStatus,
    SafeEvent, SafeRuntimeLifecycle, validate_session_delta,
};

use std::{
    fmt,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use foundation::execution::{
    ControlObservation, ControlReason, ControlStage, ObservationRecord, ObservationSink,
    TraceContext,
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::mpsc,
    task::JoinSet,
    time::timeout,
};
use zeroize::Zeroize;

use crate::{
    Host, HostEvent, HostInput,
    composition::PeerHandle,
    event_output,
    facade::{CronHandle, PlatformRuntimeHandle, PluginsHandle, SkillsHandle},
    fleet::handle::FleetHandle,
    owner,
    sessions::SessionHandle,
};

const INPUT_CAPACITY: usize = 32;
const OUTPUT_CAPACITY: usize = 64;
const REQUEST_CAPACITY: usize = 32;
const SHUTDOWN_RETRY_INTERVAL: Duration = Duration::from_millis(50);
static NEXT_CONTROL_TRACE: AtomicU64 = AtomicU64::new(1);

pub async fn run<R, W>(
    input: HostInput,
    control_input: R,
    control_output: W,
) -> Result<(), ControlError>
where
    R: AsyncRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin,
{
    let (mut host, events, handles) = Host::new(input).map_err(ControlError::Construction)?;
    let gateway_auto_start = handles.settings.gateway_auto_start().await;
    host.start_admission_only()
        .await
        .map_err(|error| ControlError::Start(error.to_string()))?;
    run_owner(
        owner::Owner::spawn(host, events),
        handles.organization.clone(),
        handles.peer.clone(),
        handles.session.clone(),
        handles.fleet.clone(),
        handles.platform_runtime.clone(),
        handles.plugins.clone(),
        handles.skills.clone(),
        handles.cron.clone(),
        handles.observation.clone(),
        gateway_auto_start,
        control_input,
        control_output,
    )
    .await
}

pub struct DeliveryTransportInput<R, W> {
    pub host: HostInput,
    pub verifier: crate::transport::authorization::CapabilityDecisionVerifier,
    pub cron_broker_verifier: crate::transport::authorization::CapabilityDecisionVerifier,
    pub provider_credential_resolver:
        Option<crate::transport::provider_accounts::private_auth::Resolver>,
    pub webhook_token: crate::transport::team_trigger::WebhookToken,
    pub compatibility_transport_port: u16,
    pub session_transport_port: u16,
    pub task_manager_transport_port: u16,
    pub session_send_transport_port: u16,
    pub session_abort_transport_port: u16,
    pub session_approval_transport_port: u16,
    pub security_emergency_transport_port: u16,
    pub channel_status_transport_port: u16,
    pub channel_catalog_transport_port: u16,
    pub channel_control_transport_port: u16,
    pub channel_pairing_transport_port: u16,
    pub session_model_selection_transport_port: u16,
    pub openclaw_history_transport_port: u16,
    pub matcha_history_transport_port: u16,
    pub usage_transport_port: u16,
    pub diagnostics_transport_port: u16,
    pub workspace_text_transport_port: u16,
    pub workspace_binary_transport_port: u16,
    pub workspace_directory_transport_port: u16,
    pub workspace_write_transport_port: u16,
    pub workspace_media_transport_port: u16,
    pub cron_transport_port: u16,
    pub cron_broker_transport_port: u16,
    pub agents_transport_port: u16,
    pub team_public_transport_port: u16,
    pub team_task_board_transport_port: u16,
    pub fleet_transport_port: u16,
    pub team_role_sessions_transport_port: u16,
    pub team_approvals_transport_port: u16,
    pub team_decision_transport_port: u16,
    pub team_role_chat_transport_port: u16,
    pub team_graph_transport_port: u16,
    pub provider_models_transport_port: u16,
    pub provider_accounts_transport_port: u16,
    pub team_skill_transport_port: u16,
    pub team_trigger_transport_port: u16,
    pub team_lifecycle_transport_port: u16,
    pub manual_team_transport_port: u16,
    pub settings_desired_transport_port: u16,
    pub security_policy_transport_port: u16,
    pub control_input: R,
    pub control_output: W,
}

pub async fn run_delivery_transports<R, W>(
    delivery: DeliveryTransportInput<R, W>,
) -> Result<(), ControlError>
where
    R: AsyncRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin,
{
    let DeliveryTransportInput {
        host: input,
        verifier,
        cron_broker_verifier,
        provider_credential_resolver,
        webhook_token,
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
        control_input,
        control_output,
    } = delivery;
    let (mut host, events, handles) = Host::new(input).map_err(ControlError::Construction)?;
    let gateway_auto_start = handles.settings.gateway_auto_start().await;
    host.start_admission_only()
        .await
        .map_err(|error| ControlError::Start(error.to_string()))?;
    let mut owner = owner::Owner::spawn(host, events);
    let compatibility_transport = match crate::transport::compatibility::Server::bind(
        compatibility_transport_port,
        owner.handle(),
        handles.peer.clone(),
        handles.platform_runtime.clone(),
        handles.plugins.clone(),
        handles.skills.clone(),
        handles.session.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("compatibility transport"));
        }
    };
    let settings_desired_transport = match crate::transport::settings_desired::server::Server::bind(
        settings_desired_transport_port,
        verifier.clone(),
        handles.settings.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("settings desired transport"));
        }
    };
    let security_policy_transport = match crate::transport::security_policy::server::Server::bind(
        security_policy_transport_port,
        verifier.clone(),
        handles.security.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(error) => {
            let _ = shutdown_host(&mut owner).await;
            let stage = match error.kind() {
                std::io::ErrorKind::PermissionDenied => "security policy transport permission",
                std::io::ErrorKind::InvalidData => "security policy state",
                _ => "security policy transport",
            };
            return Err(ControlError::Transport(stage));
        }
    };
    let task_manager_transport = match crate::transport::task_manager::server::Server::bind(
        task_manager_transport_port,
        verifier.clone(),
        handles.task_manager.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("task manager transport"));
        }
    };
    let session_transport = match crate::transport::sessions::server::Server::bind(
        session_transport_port,
        verifier.clone(),
        handles.platform_tools.clone(),
        handles.peer.clone(),
        handles.session.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("sessions transport"));
        }
    };
    let session_send_transport = match crate::transport::session_send::server::Server::bind(
        session_send_transport_port,
        verifier.clone(),
        handles.session.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("session send transport"));
        }
    };
    let session_abort_transport = match crate::transport::session_abort::server::Server::bind(
        session_abort_transport_port,
        verifier.clone(),
        handles.session.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("session abort transport"));
        }
    };
    let session_approval_transport = match crate::transport::session_approval::server::Server::bind(
        session_approval_transport_port,
        verifier.clone(),
        handles.session.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("session approval transport"));
        }
    };
    let security_emergency_transport =
        match crate::transport::security_emergency::server::Server::bind(
            security_emergency_transport_port,
            verifier.clone(),
            handles.security.clone(),
        )
        .await
        {
            Ok(transport) => transport,
            Err(_) => {
                let _ = shutdown_host(&mut owner).await;
                return Err(ControlError::Transport("security emergency transport"));
            }
        };
    let channel_status_transport = match crate::transport::channel_status::server::Server::bind(
        channel_status_transport_port,
        verifier.clone(),
        handles.channel.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("channel status transport"));
        }
    };
    let channel_catalog_transport = match crate::transport::channel_catalog::server::Server::bind(
        channel_catalog_transport_port,
        verifier.clone(),
        handles.channel.clone(),
        handles.channel_endpoint.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("channel catalog transport"));
        }
    };
    let channel_control_transport = match crate::transport::channel_control::server::Server::bind(
        channel_control_transport_port,
        verifier.clone(),
        handles.channel.clone(),
        handles.channel_endpoint.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("channel control transport"));
        }
    };
    let channel_pairing_transport = match crate::transport::channel_pairing::server::Server::bind(
        channel_pairing_transport_port,
        verifier.clone(),
        handles.channel.clone(),
        handles.channel_endpoint.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("channel pairing transport"));
        }
    };
    let session_model_selection_transport =
        match crate::transport::session_model_selection::server::Server::bind(
            session_model_selection_transport_port,
            verifier.clone(),
            handles.session.clone(),
        )
        .await
        {
            Ok(transport) => transport,
            Err(_) => {
                let _ = shutdown_host(&mut owner).await;
                return Err(ControlError::Transport("session model selection transport"));
            }
        };
    let openclaw_history_transport = match crate::transport::openclaw_history::server::Server::bind(
        openclaw_history_transport_port,
        verifier.clone(),
        handles.session.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("openclaw history transport"));
        }
    };
    let matcha_history_transport = match crate::transport::matcha_history::server::Server::bind(
        matcha_history_transport_port,
        verifier.clone(),
        handles.session.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("matcha history transport"));
        }
    };
    let usage_transport = match crate::transport::usage::server::Server::bind(
        usage_transport_port,
        verifier.clone(),
        handles.usage.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("usage transport"));
        }
    };
    let diagnostics_transport = match crate::transport::diagnostics::server::Server::bind(
        diagnostics_transport_port,
        verifier.clone(),
        handles.diagnostics.clone(),
        handles.observation.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("diagnostics transport"));
        }
    };
    let workspace_text_transport = match crate::transport::workspace_text::server::Server::bind(
        workspace_text_transport_port,
        verifier.clone(),
        handles.workspace.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("workspace text transport"));
        }
    };
    let workspace_binary_transport = match crate::transport::workspace_binary::server::Server::bind(
        workspace_binary_transport_port,
        verifier.clone(),
        handles.workspace.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("workspace binary transport"));
        }
    };
    let workspace_directory_transport =
        match crate::transport::workspace_directory::server::Server::bind(
            workspace_directory_transport_port,
            verifier.clone(),
            handles.workspace.clone(),
        )
        .await
        {
            Ok(transport) => transport,
            Err(_) => {
                let _ = shutdown_host(&mut owner).await;
                return Err(ControlError::Transport("workspace directory transport"));
            }
        };
    let workspace_write_transport = match crate::transport::workspace_write::server::Server::bind(
        workspace_write_transport_port,
        verifier.clone(),
        handles.workspace.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("workspace write transport"));
        }
    };
    let workspace_media_transport = match crate::transport::workspace_media::server::Server::bind(
        workspace_media_transport_port,
        verifier.clone(),
        handles.workspace.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("workspace media transport"));
        }
    };
    let cron_transport = match crate::transport::cron::server::Server::bind(
        cron_transport_port,
        verifier.clone(),
        handles.cron.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("cron transport"));
        }
    };
    let cron_broker_transport = match crate::transport::cron::server::BrokerServer::bind(
        cron_broker_transport_port,
        cron_broker_verifier,
        handles.cron.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("cron broker transport"));
        }
    };
    let agents_transport = match crate::transport::agents::server::Server::bind(
        agents_transport_port,
        verifier.clone(),
        handles.agents.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("agents transport"));
        }
    };
    let team_public_transport = match crate::transport::team_public::server::Server::bind(
        team_public_transport_port,
        verifier.clone(),
        handles.organization.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("team public transport"));
        }
    };
    let team_task_board_transport = match crate::transport::team_task_board::server::Server::bind(
        team_task_board_transport_port,
        verifier.clone(),
        handles.organization.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("team task board transport"));
        }
    };
    let fleet_terminal_tickets = std::sync::Arc::new(
        crate::transport::fleet_terminal::HostTicketPort::new(handles.fleet.clone()),
    );
    let fleet_terminal_provider = std::sync::Arc::new(
        crate::transport::fleet_terminal::NativeProvider::new(handles.fleet.clone()),
    );
    let fleet_terminal = crate::transport::fleet_terminal::ServerDependencies::new(
        fleet_terminal_tickets,
        fleet_terminal_provider,
    );
    let fleet_transport = match crate::transport::fleet::server::Server::bind(
        fleet_transport_port,
        verifier.clone(),
        handles.fleet.clone(),
        fleet_terminal,
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("fleet transport"));
        }
    };
    let team_role_sessions_transport =
        match crate::transport::team_role_sessions::server::Server::bind(
            team_role_sessions_transport_port,
            verifier.clone(),
            handles.organization.clone(),
        )
        .await
        {
            Ok(transport) => transport,
            Err(_) => {
                let _ = shutdown_host(&mut owner).await;
                return Err(ControlError::Transport("team role sessions transport"));
            }
        };
    let team_approvals_transport = match crate::transport::team_approvals::server::Server::bind(
        team_approvals_transport_port,
        verifier.clone(),
        handles.organization.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("team approvals transport"));
        }
    };
    let team_decision_transport = match crate::transport::team_decision::server::Server::bind(
        team_decision_transport_port,
        verifier.clone(),
        handles.organization.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("team decision transport"));
        }
    };
    let team_role_chat_transport = match crate::transport::team_role_chat::server::Server::bind(
        team_role_chat_transport_port,
        verifier.clone(),
        handles.organization.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("team role chat transport"));
        }
    };
    let team_graph_transport = match crate::transport::team_graph::server::Server::bind(
        team_graph_transport_port,
        verifier.clone(),
        handles.organization.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("team graph transport"));
        }
    };
    let provider_models_transport = match crate::transport::provider_models::server::Server::bind(
        provider_models_transport_port,
        verifier.clone(),
        handles.provider.clone(),
        handles.skills.clone(),
        handles.clawhub_registry.clone(),
        handles.plugins.clone(),
        handles.connector.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("provider models transport"));
        }
    };
    let provider_private_resolver = provider_credential_resolver
        .unwrap_or_else(crate::transport::provider_accounts::private_auth::Resolver::disabled);
    if handles
        .provider
        .clone()
        .configure_provider_private_resolver(provider_private_resolver.clone())
        .await
        .is_err()
    {
        let _ = shutdown_host(&mut owner).await;
        return Err(ControlError::Transport("provider credential resolver"));
    }
    if handles
        .connector
        .clone()
        .configure_private_resolver(provider_private_resolver)
        .await
        .is_err()
    {
        let _ = shutdown_host(&mut owner).await;
        return Err(ControlError::Transport("connector credential resolver"));
    }
    let provider_accounts_transport =
        match crate::transport::provider_accounts::server::Server::bind(
            provider_accounts_transport_port,
            verifier.clone(),
            handles.provider,
        )
        .await
        {
            Ok(transport) => transport,
            Err(_) => {
                let _ = shutdown_host(&mut owner).await;
                return Err(ControlError::Transport("provider accounts transport"));
            }
        };
    let team_skill_transport = match crate::transport::team_skill::server::Server::bind(
        team_skill_transport_port,
        verifier.clone(),
        handles.organization.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("team skill transport"));
        }
    };
    let team_trigger_transport = match crate::transport::team_trigger::server::Server::bind(
        team_trigger_transport_port,
        verifier.clone(),
        webhook_token,
        handles.organization.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("team trigger transport"));
        }
    };
    let team_lifecycle_transport = match crate::transport::team_lifecycle::server::Server::bind(
        team_lifecycle_transport_port,
        verifier.clone(),
        handles.organization.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("team lifecycle transport"));
        }
    };
    let manual_team_transport = match crate::transport::manual_team::server::Server::bind(
        manual_team_transport_port,
        verifier,
        handles.organization.clone(),
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("manual team transport"));
        }
    };
    let compatibility_transport = tokio::spawn(compatibility_transport.run());
    let settings_desired_transport = tokio::spawn(settings_desired_transport.run());
    let security_policy_transport = tokio::spawn(security_policy_transport.run());
    let task_manager_transport = tokio::spawn(task_manager_transport.run());
    let session_transport = tokio::spawn(session_transport.run());
    let session_send_transport = tokio::spawn(session_send_transport.run());
    let session_abort_transport = tokio::spawn(session_abort_transport.run());
    let session_approval_transport = tokio::spawn(session_approval_transport.run());
    let security_emergency_transport = tokio::spawn(security_emergency_transport.run());
    let channel_status_transport = tokio::spawn(channel_status_transport.run());
    let channel_catalog_transport = tokio::spawn(channel_catalog_transport.run());
    let channel_control_transport = tokio::spawn(channel_control_transport.run());
    let channel_pairing_transport = tokio::spawn(channel_pairing_transport.run());
    let session_model_selection_transport = tokio::spawn(session_model_selection_transport.run());
    let openclaw_history_transport = tokio::spawn(openclaw_history_transport.run());
    let matcha_history_transport = tokio::spawn(matcha_history_transport.run());
    let usage_transport = tokio::spawn(usage_transport.run());
    let diagnostics_transport = tokio::spawn(diagnostics_transport.run());
    let workspace_text_transport = tokio::spawn(workspace_text_transport.run());
    let workspace_binary_transport = tokio::spawn(workspace_binary_transport.run());
    let workspace_directory_transport = tokio::spawn(workspace_directory_transport.run());
    let workspace_write_transport = tokio::spawn(workspace_write_transport.run());
    let workspace_media_transport = tokio::spawn(workspace_media_transport.run());
    let cron_transport = tokio::spawn(cron_transport.run());
    let cron_broker_transport = tokio::spawn(cron_broker_transport.run());
    let agents_transport = tokio::spawn(agents_transport.run());
    let team_public_transport = tokio::spawn(team_public_transport.run());
    let team_task_board_transport = team_task_board_transport.spawn();
    let fleet_transport = tokio::spawn(fleet_transport.run());
    let team_role_sessions_transport = tokio::spawn(team_role_sessions_transport.run());
    let team_approvals_transport = tokio::spawn(team_approvals_transport.run());
    let team_decision_transport = tokio::spawn(team_decision_transport.run());
    let team_role_chat_transport = tokio::spawn(team_role_chat_transport.run());
    let team_graph_transport = tokio::spawn(team_graph_transport.run());
    let provider_models_transport = tokio::spawn(provider_models_transport.run());
    let provider_accounts_transport = tokio::spawn(provider_accounts_transport.run());
    let team_skill_transport = tokio::spawn(team_skill_transport.run());
    let team_trigger_transport = tokio::spawn(team_trigger_transport.run());
    let team_lifecycle_transport = tokio::spawn(team_lifecycle_transport.run());
    let manual_team_transport = tokio::spawn(manual_team_transport.run());
    let result = run_owner(
        owner,
        handles.organization.clone(),
        handles.peer.clone(),
        handles.session.clone(),
        handles.fleet.clone(),
        handles.platform_runtime.clone(),
        handles.plugins.clone(),
        handles.skills.clone(),
        handles.cron.clone(),
        handles.observation.clone(),
        gateway_auto_start,
        control_input,
        control_output,
    )
    .await;
    compatibility_transport.abort();
    settings_desired_transport.abort();
    security_policy_transport.abort();
    task_manager_transport.abort();
    session_transport.abort();
    session_send_transport.abort();
    session_abort_transport.abort();
    session_approval_transport.abort();
    security_emergency_transport.abort();
    channel_status_transport.abort();
    channel_catalog_transport.abort();
    channel_control_transport.abort();
    channel_pairing_transport.abort();
    session_model_selection_transport.abort();
    openclaw_history_transport.abort();
    matcha_history_transport.abort();
    usage_transport.abort();
    diagnostics_transport.abort();
    workspace_text_transport.abort();
    workspace_binary_transport.abort();
    workspace_directory_transport.abort();
    workspace_write_transport.abort();
    workspace_media_transport.abort();
    cron_transport.abort();
    cron_broker_transport.abort();
    agents_transport.abort();
    team_public_transport.abort();
    team_task_board_transport.abort();
    fleet_transport.abort();
    team_role_sessions_transport.abort();
    team_approvals_transport.abort();
    team_decision_transport.abort();
    team_role_chat_transport.abort();
    team_graph_transport.abort();
    provider_models_transport.abort();
    provider_accounts_transport.abort();
    team_skill_transport.abort();
    team_trigger_transport.abort();
    team_lifecycle_transport.abort();
    manual_team_transport.abort();
    let _ = compatibility_transport.await;
    let _ = settings_desired_transport.await;
    let _ = security_policy_transport.await;
    let _ = task_manager_transport.await;
    let _ = session_transport.await;
    let _ = session_send_transport.await;
    let _ = session_abort_transport.await;
    let _ = session_approval_transport.await;
    let _ = security_emergency_transport.await;
    let _ = channel_status_transport.await;
    let _ = channel_catalog_transport.await;
    let _ = channel_control_transport.await;
    let _ = channel_pairing_transport.await;
    let _ = session_model_selection_transport.await;
    let _ = openclaw_history_transport.await;
    let _ = matcha_history_transport.await;
    let _ = usage_transport.await;
    let _ = diagnostics_transport.await;
    let _ = workspace_text_transport.await;
    let _ = workspace_binary_transport.await;
    let _ = workspace_directory_transport.await;
    let _ = workspace_write_transport.await;
    let _ = workspace_media_transport.await;
    let _ = cron_transport.await;
    let _ = cron_broker_transport.await;
    let _ = agents_transport.await;
    let _ = team_public_transport.await;
    let _ = team_task_board_transport.r#await().await;
    let _ = fleet_transport.await;
    let _ = team_role_sessions_transport.await;
    let _ = team_approvals_transport.await;
    let _ = team_decision_transport.await;
    let _ = team_role_chat_transport.await;
    let _ = team_graph_transport.await;
    let _ = provider_models_transport.await;
    let _ = provider_accounts_transport.await;
    let _ = team_skill_transport.await;
    let _ = team_trigger_transport.await;
    let _ = team_lifecycle_transport.await;
    let _ = manual_team_transport.await;
    result
}

async fn run_owner<R, W>(
    mut owner: owner::Owner,
    organization: crate::organization::OrganizationHandle,
    peer: PeerHandle,
    session: SessionHandle,
    fleet: FleetHandle,
    platform_runtime: PlatformRuntimeHandle,
    plugins: PluginsHandle,
    skills: SkillsHandle,
    cron: CronHandle,
    observation: ObservationSink,
    gateway_auto_start: bool,
    control_input: R,
    mut control_output: W,
) -> Result<(), ControlError>
where
    R: AsyncRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin,
{
    let handle = owner.handle();
    if let Err(error) =
        write_output(&mut control_output, wire::Output::Ready(wire::Ready::new())).await
    {
        let _ = shutdown_host(&mut owner).await;
        return Err(error);
    }
    eprintln!(
        "[startup-trace] source=runtime-host phase=ready detail=control-channel-ready gateway_auto_start={gateway_auto_start}"
    );
    let peer_autostart = tokio::spawn({
        let peer = peer.clone();
        async move {
            eprintln!(
                "[startup-trace] source=runtime-host phase=openclaw-autostart-request detail=requesting-peer-autostart gateway_auto_start={gateway_auto_start}"
            );
            let result = peer.request_peer_autostart(gateway_auto_start).await;
            eprintln!(
                "[startup-trace] source=runtime-host phase=openclaw-autostart-result detail=peer-autostart-request-finished success={} error={}",
                result.is_ok(),
                if result.is_ok() {
                    ""
                } else {
                    "peer owner unavailable"
                }
            );
        }
    });

    let (input_sender, mut input_receiver) = mpsc::channel(INPUT_CAPACITY);
    let mut reader = tokio::spawn(read_control_input(control_input, input_sender));
    let (output_sender, mut output_receiver) = mpsc::channel(OUTPUT_CAPACITY);
    let mut owner_events = owner
        .take_events()
        .expect("owner event receiver must be taken before control starts");
    let mut commands = JoinSet::new();
    let mut events_open = true;
    let shutdown_signal = system_shutdown();
    tokio::pin!(shutdown_signal);

    let result = loop {
        tokio::select! {
            _ = &mut shutdown_signal => break Ok(()),
            input = input_receiver.recv() => match input {
                Some(Input::Frame(mut frame)) => {
                    let trace = next_control_trace();
                    let command = wire::decode_command_request(&frame);
                    frame.zeroize();
                    match command {
                        Ok(command) => {
                            let command_kind = command_kind(&command.command);
                            observe_control(
                                &observation,
                                trace,
                                command_kind,
                                ControlStage::Decode,
                                Some(ControlReason::Accepted),
                            );
                            if let Err(error) = spawn_command(
                                &mut commands,
                                handle.clone(),
                                organization.clone(),
                                peer.clone(),
                                session.clone(),
                                fleet.clone(),
                                platform_runtime.clone(),
                                plugins.clone(),
                                skills.clone(),
                                cron.clone(),
                                output_sender.clone(),
                                observation.clone(),
                                trace,
                                command_kind,
                                command,
                            ) {
                                break Err(error);
                            }
                        }
                        Err(_) => {
                            observe_control(
                                &observation,
                                trace,
                                "control.command",
                                ControlStage::Decode,
                                Some(ControlReason::DecodeRejected),
                            );
                            break Err(ControlError::InvalidCommand);
                        }
                    }
                }
                Some(Input::End) | None => break Ok(()),
                Some(Input::Error) => break Err(ControlError::Input),
            },
            output = output_receiver.recv() => match output {
                Some(output) => {
                    if let Err(error) = write_output(&mut control_output, output).await {
                        observe_control(
                            &observation,
                            TraceContext::absent(),
                            "control.output",
                            ControlStage::Settle,
                            Some(ControlReason::OutputClosed),
                        );
                        break Err(error);
                    }
                }
                None => {
                    observe_control(
                        &observation,
                        TraceContext::absent(),
                        "control.output",
                        ControlStage::Settle,
                        Some(ControlReason::OutputClosed),
                    );
                    break Err(ControlError::OutputClosed);
                }
            },
            event = owner_events.recv(), if events_open => match event {
                Some(event) => {
                    if let Some(event) = project_event(event, &observation)
                        && output_sender.try_send(event).is_err()
                    {
                        observe_control(
                            &observation,
                            TraceContext::absent(),
                            "control.output",
                            ControlStage::Settle,
                            Some(ControlReason::OutputClosed),
                        );
                        break Err(ControlError::OutputClosed);
                    }
                }
                None => events_open = false,
            },
            completed = commands.join_next(), if !commands.is_empty() => {
                if let Some(Err(_)) = completed {
                    break Err(ControlError::CommandTask);
                }
            },
        }
    };

    peer_autostart.abort();
    let _ = peer_autostart.await;
    reader.abort();
    let _ = (&mut reader).await;
    commands.abort_all();
    while commands.join_next().await.is_some() {}
    drop(output_sender);
    drop(output_receiver);

    let shutdown = shutdown_host(&mut owner).await;
    result.and(shutdown)
}

fn spawn_command(
    commands: &mut JoinSet<()>,
    owner: owner::Handle,
    organization: crate::organization::OrganizationHandle,
    peer: PeerHandle,
    session: SessionHandle,
    fleet: FleetHandle,
    platform_runtime: PlatformRuntimeHandle,
    plugins: PluginsHandle,
    skills: SkillsHandle,
    cron: CronHandle,
    output: mpsc::Sender<wire::Output>,
    observation: ObservationSink,
    trace: TraceContext,
    command_kind: &'static str,
    command: wire::CommandRequest,
) -> Result<(), ControlError> {
    let id = command.id.clone();
    if commands.len() >= REQUEST_CAPACITY {
        observe_control(
            &observation,
            trace,
            command_kind,
            ControlStage::Admit,
            Some(ControlReason::CapacityExhausted),
        );
        observe_control(
            &observation,
            trace,
            command_kind,
            ControlStage::Settle,
            Some(ControlReason::Rejected),
        );
        return output
            .try_send(wire::Output::Outcome(wire::Outcome::new(
                id,
                wire::CommandOutcome::rejected(
                    wire::RejectionCode::CapacityExhausted,
                    "Runtime Host control command capacity is exhausted.",
                ),
            )))
            .map_err(|_| ControlError::OutputClosed);
    }

    observe_control(
        &observation,
        trace,
        command_kind,
        ControlStage::Admit,
        Some(ControlReason::Accepted),
    );
    let timeout_duration = Duration::from_millis(command.timeout.milliseconds());
    commands.spawn(async move {
        observe_control(
            &observation,
            trace,
            command_kind,
            ControlStage::Dispatch,
            Some(ControlReason::Accepted),
        );
        let outcome = match timeout(
            timeout_duration,
            dispatch::execute(
                &owner,
                &organization,
                &peer,
                &fleet,
                &session,
                &platform_runtime,
                &plugins,
                &skills,
                &cron,
                command.command,
            ),
        )
        .await
        {
            Ok(outcome) => outcome,
            Err(_) => wire::CommandOutcome::timed_out(),
        };
        observe_control(
            &observation,
            trace,
            command_kind,
            ControlStage::Settle,
            Some(outcome_reason(&outcome)),
        );
        let _ = output
            .send(wire::Output::Outcome(wire::Outcome::new(id, outcome)))
            .await;
    });
    Ok(())
}

fn observe_control(
    observation: &ObservationSink,
    trace: TraceContext,
    command_kind: &'static str,
    stage: ControlStage,
    reason: Option<ControlReason>,
) {
    if observation.is_enabled() {
        observation.observe(ObservationRecord::Control(ControlObservation {
            trace,
            command_kind,
            stage,
            reason,
        }));
    }
}

fn next_control_trace() -> TraceContext {
    TraceContext::root(NEXT_CONTROL_TRACE.fetch_add(1, Ordering::Relaxed))
}

fn outcome_reason(outcome: &wire::CommandOutcome) -> ControlReason {
    match outcome {
        wire::CommandOutcome::Succeeded { .. } | wire::CommandOutcome::Unknown { .. } => {
            ControlReason::Accepted
        }
        wire::CommandOutcome::Rejected { .. } => ControlReason::Rejected,
        wire::CommandOutcome::TimedOut => ControlReason::TimedOut,
    }
}

fn command_kind(command: &wire::Command) -> &'static str {
    match command {
        wire::Command::HostHealth {} => "host.health",
        wire::Command::HostCapabilitiesList {} => "host.capabilities.list",
        wire::Command::HostCapabilitiesDescribe { .. } => "host.capabilities.describe",
        wire::Command::HostRuntimeSnapshot {} => "host.runtime.snapshot",
        wire::Command::MatchaStatus {} => "matcha.lifecycle.status",
        wire::Command::MatchaStart {} => "matcha.lifecycle.start",
        wire::Command::MatchaStop {} => "matcha.lifecycle.stop",
        wire::Command::MatchaRestart {} => "matcha.lifecycle.restart",
        wire::Command::OpenClawStatus {} => "openclaw.lifecycle.status",
        wire::Command::OpenClawPluginsCatalog {} => "openclaw.plugins.catalog",
        wire::Command::OpenClawPluginsRuntime {} => "openclaw.plugins.runtime",
        wire::Command::OpenClawPluginsSetEnabled { .. } => "openclaw.plugins.set-enabled",
        wire::Command::OpenClawPluginsOperation { .. } => "openclaw.plugins.operation",
        wire::Command::OpenClawSkillsExecute { .. } => "openclaw.skills.execute",
        wire::Command::TeamRuntimeExecute { .. } => "team.runtime.execute",
        wire::Command::OpenClawPluginsExecute { .. } => "openclaw.plugins.execute",
        wire::Command::OpenClawEnvironmentStatus {} => "openclaw.environment.status",
        wire::Command::OpenClawRuntimePaths {} => "openclaw.runtime.paths",
        wire::Command::OpenClawCliCommand {} => "openclaw.cli.command",
        wire::Command::OpenClawToolPermissionGet {} => "openclaw.tool-permission.get",
        wire::Command::OpenClawToolPermissionSet { .. } => "openclaw.tool-permission.set",
        wire::Command::OpenClawToolchainStatus {} => "openclaw.toolchain.status",
        wire::Command::OpenClawToolchainInstallUv {} => "openclaw.toolchain.install-uv",
        wire::Command::OpenClawSubagentTemplateCatalog {} => "openclaw.subagent-templates.list",
        wire::Command::OpenClawSubagentTemplate { .. } => "openclaw.subagent-templates.get",
        wire::Command::OpenClawStart {} => "openclaw.lifecycle.start",
        wire::Command::OpenClawStop {} => "openclaw.lifecycle.stop",
        wire::Command::OpenClawRestart {} => "openclaw.lifecycle.restart",
        wire::Command::OpenClawLogs { .. } => "openclaw.logs",
        wire::Command::OpenClawControlReady {} => "openclaw.control.ready",
        wire::Command::OpenClawGatewayHealth {} => "openclaw.gateway.health",
        wire::Command::OpenClawGatewayStatus {} => "openclaw.gateway.status",
        wire::Command::OpenClawControlUiUrl {} => "openclaw.control-ui.url",
        wire::Command::OpenClawManualCronTrigger { .. } => "openclaw.cron.manual-trigger",
        wire::Command::OpenClawChatHistory { .. } => "openclaw.chat.history",
        wire::Command::OpenClawChatSend { .. } => "openclaw.chat.send",
        wire::Command::OpenClawChatAbort { .. } => "openclaw.chat.abort",
        wire::Command::FleetCredentialsWrite { .. } => "fleet.credentials.write",
    }
}

async fn read_control_input<R>(mut input: R, sender: mpsc::Sender<Input>)
where
    R: AsyncRead + Unpin,
{
    loop {
        match frame::decode_next(&mut input).await {
            Ok(Some(frame)) => {
                if sender.send(Input::Frame(frame)).await.is_err() {
                    return;
                }
            }
            Ok(None) => {
                let _ = sender.send(Input::End).await;
                return;
            }
            Err(_) => {
                let _ = sender.send(Input::Error).await;
                return;
            }
        }
    }
}

async fn write_output(
    output: &mut (impl AsyncWrite + Unpin),
    message: wire::Output,
) -> Result<(), ControlError> {
    let frame = wire::encode(&message).map_err(|_| ControlError::OutputEncoding)?;
    frame::encode(output, &frame)
        .await
        .map_err(|_| ControlError::Output)
}

fn project_event(event: HostEvent, observation: &ObservationSink) -> Option<wire::Output> {
    event_output::project_observed(event, observation)
        .map(|event| wire::Output::Event(wire::Event::new(event)))
}

async fn shutdown_host(owner: &mut owner::Owner) -> Result<(), ControlError> {
    loop {
        let attempt = owner
            .handle()
            .shutdown()
            .await
            .map_err(|_| ControlError::Owner)?;
        if attempt.terminal {
            let result = attempt
                .result
                .map(|_| ())
                .map_err(|_| ControlError::Shutdown);
            let joined = owner.join().await.map_err(|_| ControlError::Owner)?;
            joined.map_err(|_| ControlError::Shutdown)?;
            return result;
        }
        tokio::time::sleep(SHUTDOWN_RETRY_INTERVAL).await;
    }
}

#[cfg(unix)]
async fn system_shutdown() {
    match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
        Ok(mut terminate) => {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = terminate.recv() => {}
            }
        }
        Err(_) => {
            let _ = tokio::signal::ctrl_c().await;
        }
    }
}

#[cfg(windows)]
async fn system_shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}

enum Input {
    Frame(Vec<u8>),
    End,
    Error,
}

#[derive(Debug)]
pub enum ControlError {
    Construction(crate::ConstructionError),
    Start(String),
    Input,
    InvalidCommand,
    Output,
    OutputEncoding,
    OutputClosed,
    Owner,
    CommandTask,
    Shutdown,
    Transport(&'static str),
}

impl fmt::Display for ControlError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Construction(error) => {
                write!(formatter, "runtime-host construction failed: {error}")
            }
            Self::Start(error) => write!(formatter, "runtime-host startup failed: {error}"),
            Self::Input => formatter.write_str("runtime-host control input failed"),
            Self::InvalidCommand => formatter.write_str("runtime-host control command is invalid"),
            Self::Output | Self::OutputEncoding | Self::OutputClosed => {
                formatter.write_str("runtime-host control output failed")
            }
            Self::Owner | Self::CommandTask | Self::Shutdown => {
                formatter.write_str("runtime-host control shutdown failed")
            }
            Self::Transport(stage) => write!(formatter, "runtime-host {stage} failed"),
        }
    }
}

impl std::error::Error for ControlError {}

#[cfg(test)]
#[path = "service_tests.rs"]
mod tests;
