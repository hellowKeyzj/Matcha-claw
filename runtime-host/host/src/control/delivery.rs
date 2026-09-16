use tokio::io::{AsyncRead, AsyncWrite};

use crate::{Host, HostInput, host_actor};

use super::{ControlError, run_owner, shutdown_host};

pub struct DeliveryTransportInput<R, W> {
    pub host: HostInput,
    pub verifier: crate::transport::common::authorization::CapabilityDecisionVerifier,
    pub cron_broker_verifier: crate::transport::common::authorization::CapabilityDecisionVerifier,
    pub provider_credential_resolver: Option<crate::provider::auth::Resolver>,
    pub webhook_token: crate::transport::team::trigger::WebhookToken,
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
    let mut owner = host_actor::Owner::spawn(host, events);
    let compatibility_transport = match crate::transport::compatibility::Server::bind(
        compatibility_transport_port,
        owner.handle(),
        handles.peer.clone(),
        handles.platform_runtime.clone(),
        handles.toolchain.clone(),
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
    let settings_desired_transport =
        match crate::transport::settings::desired::server::Server::bind(
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
    let security_policy_transport = match crate::transport::security::policy::server::Server::bind(
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
    let task_manager_transport = match crate::transport::team::task_manager::server::Server::bind(
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
    let session_send_transport = match crate::transport::sessions::send::server::Server::bind(
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
    let session_abort_transport = match crate::transport::sessions::abort::server::Server::bind(
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
    let session_approval_transport =
        match crate::transport::sessions::approval::server::Server::bind(
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
        match crate::transport::security::emergency::server::Server::bind(
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
    let channel_status_transport = match crate::transport::channels::status::server::Server::bind(
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
    let channel_catalog_transport = match crate::transport::channels::catalog::server::Server::bind(
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
    let channel_control_transport = match crate::transport::channels::control::server::Server::bind(
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
    let channel_pairing_transport = match crate::transport::channels::pairing::server::Server::bind(
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
        match crate::transport::sessions::model_selection::server::Server::bind(
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
    let matcha_history_transport =
        match crate::transport::sessions::matcha_history::server::Server::bind(
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
    let workspace_text_transport = match crate::transport::workspace::text::server::Server::bind(
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
    let workspace_binary_transport =
        match crate::transport::workspace::binary::server::Server::bind(
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
        match crate::transport::workspace::directory::server::Server::bind(
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
    let workspace_write_transport = match crate::transport::workspace::write::server::Server::bind(
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
    let workspace_media_transport = match crate::transport::workspace::media::server::Server::bind(
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
    let team_public_transport = match crate::transport::team::public::server::Server::bind(
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
    let team_task_board_transport = match crate::transport::team::task_board::server::Server::bind(
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
        crate::transport::fleet::terminal_stream::HostTicketPort::new(handles.fleet.clone()),
    );
    let fleet_terminal_provider = std::sync::Arc::new(
        crate::transport::fleet::terminal_stream::NativeProvider::new(handles.fleet.clone()),
    );
    let fleet_terminal = crate::transport::fleet::terminal_stream::ServerDependencies::new(
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
        match crate::transport::team::role_sessions::server::Server::bind(
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
    let team_approvals_transport = match crate::transport::team::approvals::server::Server::bind(
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
    let team_decision_transport = match crate::transport::team::decision::server::Server::bind(
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
    let team_role_chat_transport = match crate::transport::team::role_chat::server::Server::bind(
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
    let team_graph_transport = match crate::transport::team::graph::server::Server::bind(
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
    let provider_models_transport = match crate::transport::providers::models::server::Server::bind(
        provider_models_transport_port,
        verifier.clone(),
        handles.provider.clone(),
        handles.skills.clone(),
        handles.agents.clone(),
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
    let provider_private_resolver =
        provider_credential_resolver.unwrap_or_else(crate::provider::auth::Resolver::disabled);
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
        match crate::transport::providers::accounts::server::Server::bind(
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
    let team_skill_transport = match crate::transport::team::skill::server::Server::bind(
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
    let team_trigger_transport = match crate::transport::team::trigger::server::Server::bind(
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
    let team_lifecycle_transport = match crate::transport::team::lifecycle::server::Server::bind(
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
    let manual_team_transport = match crate::transport::team::manual::server::Server::bind(
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
        handles.toolchain.clone(),
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
