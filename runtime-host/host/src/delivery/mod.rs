use tokio::io::{AsyncRead, AsyncWrite};

use crate::{
    Host, HostInput,
    control::{ControlError, run_owner, shutdown_host},
    host_actor,
};

pub struct DeliveryTransportInput<R, W> {
    pub host: HostInput,
    pub verifier: crate::transport::common::authorization::CapabilityDecisionVerifier,
    pub provider_credential_resolver: Option<crate::provider::auth::Resolver>,
    pub webhook_token: crate::transport::team::trigger::WebhookToken,
    pub runtime_host_transport_port: u16,
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
        provider_credential_resolver,
        webhook_token,
        runtime_host_transport_port,
        control_input,
        control_output,
    } = delivery;
    let (mut host, events, handles) = Host::new(input).map_err(ControlError::Construction)?;
    let gateway_auto_start = handles.settings.gateway_auto_start().await;
    host.start_admission_only()
        .await
        .map_err(|error| ControlError::Start(error.to_string()))?;
    let mut owner = host_actor::Owner::spawn(host, events);

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

    handles
        .security
        .recover_pending()
        .await
        .map_err(|_| ControlError::Transport("security emergency recovery"))?;
    let fleet_terminal = crate::transport::fleet::terminal_stream::ServerDependencies::new(
        std::sync::Arc::new(
            crate::transport::fleet::terminal_stream::HostTicketPort::new(handles.fleet.clone()),
        ),
        std::sync::Arc::new(
            crate::transport::fleet::terminal_stream::NativeProvider::new(handles.fleet.clone()),
        ),
    );
    let send_hooks =
        crate::sessions::send_hook::SessionSendHookSet::new(vec![std::sync::Arc::new(
            crate::organization::StartGateSendHook::new(handles.organization.clone()),
        )]);
    let router =
        crate::transport::localhost::Router::new(crate::transport::localhost::RouterInput {
            owner: owner.handle(),
            verifier,
            webhook_token,
            peer: handles.peer.clone(),
            platform_runtime: handles.platform_runtime.clone(),
            toolchain: handles.toolchain.clone(),
            platform_tools: handles.platform_tools.clone(),
            plugins: handles.plugins.clone(),
            skills: handles.skills.clone(),
            session: handles.session.clone(),
            session_delta_source: handles.session_delta_source.clone(),
            send_hooks,
            cron: handles.cron.clone(),
            fleet: handles.fleet.clone(),
            fleet_terminal,
            channel: handles.channel.clone(),
            channel_endpoint: handles.channel_endpoint.clone(),
            organization: handles.organization.clone(),
            task_manager: handles.task_manager.clone(),
            workspace: handles.workspace.clone(),
            provider: handles.provider.clone(),
            agents: handles.agents.clone(),
            usage: handles.usage.clone(),
            settings: handles.settings.clone(),
            security: handles.security.clone(),
            diagnostics: handles.diagnostics.clone(),
            observation: handles.observation.clone(),
            clawhub_registry: handles.clawhub_registry.clone(),
            connector: handles.connector.clone(),
        });
    let localhost_transport = match crate::transport::localhost::Server::bind(
        runtime_host_transport_port,
        router,
    )
    .await
    {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut owner).await;
            return Err(ControlError::Transport("localhost transport"));
        }
    };
    let localhost_transport = tokio::spawn(localhost_transport.run());
    let result = run_owner(
        owner,
        handles.organization.clone(),
        handles.peer.clone(),
        handles.fleet.clone(),
        handles.platform_runtime.clone(),
        handles.toolchain.clone(),
        handles.plugins.clone(),
        handles.skills.clone(),
        handles.observation.clone(),
        gateway_auto_start,
        control_input,
        control_output,
    )
    .await;
    localhost_transport.abort();
    let _ = localhost_transport.await;
    result
}
