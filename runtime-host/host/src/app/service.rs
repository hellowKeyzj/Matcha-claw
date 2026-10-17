use std::sync::Arc;

use tokio::io::{AsyncRead, AsyncWrite};

use super::{runtime, shutdown::shutdown_host};
use crate::{
    HostInput,
    control::ControlError,
    module_registry::{
        install::{InstallModulesInput, prepare_module_install},
        private_control::PrivateControlRegistry,
    },
};

pub struct AppInput<R, W> {
    pub host: HostInput,
    pub verifier: platform::capability::CapabilityDecisionVerifier,
    pub provider_credential_resolver: Option<provider_module::Resolver>,
    pub webhook_token: organization::WebhookToken,
    pub runtime_host_transport_port: u16,
    pub control_input: R,
    pub control_output: W,
}

pub async fn run_app_service<R, W>(app: AppInput<R, W>) -> Result<(), ControlError>
where
    R: AsyncRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin,
{
    let AppInput {
        host: input,
        verifier,
        provider_credential_resolver,
        webhook_token,
        runtime_host_transport_port,
        control_input,
        mut control_output,
    } = app;
    let mcp = crate::mcp::Discovery::prepare(
        &input.open_claw.runtime_host_mcp_state_dir,
        runtime_host_transport_port,
    )
    .map_err(|_| ControlError::Transport("MCP discovery"))?;
    crate::mcp::project_matcha(
        &input.matcha.storage_root,
        &input.open_claw.runtime_host_mcp_executable,
        &input.open_claw.runtime_host_mcp_state_dir,
    )
    .map_err(|_| ControlError::Transport("Matcha MCP projection"))?;
    let mut runtime = match runtime::start(input).await {
        Ok(runtime) => runtime,
        Err(error) => {
            if matches!(
                error,
                ControlError::Construction(crate::ConstructionError::ProviderMigration(_))
            ) {
                let output = crate::control::wire::Output::StartupFailure(
                    crate::control::wire::StartupFailure::provider_migration(),
                );
                if let Ok(bytes) = crate::control::wire::encode(&output) {
                    let _ = crate::control::frame::encode(&mut control_output, &bytes).await;
                }
            }
            return Err(error);
        }
    };

    let provider_private_resolver =
        provider_credential_resolver.unwrap_or_else(provider_module::Resolver::disabled);
    if runtime
        .handles
        .provider
        .configure_private_resolver(provider_private_resolver.clone())
        .await
        .is_err()
    {
        let _ = shutdown_runtime(&mut runtime).await;
        return Err(ControlError::Transport("provider credential resolver"));
    }
    let provider_private_resolver = Arc::new(provider_private_resolver);
    if runtime
        .handles
        .session
        .clone()
        .configure_private_resolver(provider_private_resolver.clone())
        .await
        .is_err()
    {
        let _ = shutdown_runtime(&mut runtime).await;
        return Err(ControlError::Transport("session credential resolver"));
    }
    if runtime
        .handles
        .connector
        .clone()
        .configure_private_resolver(provider_private_resolver)
        .await
        .is_err()
    {
        let _ = shutdown_runtime(&mut runtime).await;
        return Err(ControlError::Transport("connector credential resolver"));
    }

    runtime
        .handles
        .security
        .recover_pending()
        .await
        .map_err(|_| ControlError::Transport("security emergency recovery"))?;
    let verifier = Arc::new(tokio::sync::Mutex::new(verifier));
    let install_plan = prepare_module_install(InstallModulesInput {
        handles: &runtime.handles,
        verifier: Arc::clone(&verifier),
        webhook_token,
        mcp: mcp.descriptor(
            runtime.handles.organization.clone(),
            runtime.handles.runtime_directory.clone(),
            runtime.handles.wiki.handle().clone(),
        ),
    });
    let route_snapshot = install_plan.route_snapshot();
    let router = crate::http::Router::new(route_snapshot.clone());
    if let Err(error) = runtime
        .host_mut()
        .register_route_effects(&route_snapshot, router.clone())
    {
        let _ = shutdown_runtime(&mut runtime).await;
        return Err(ControlError::ModuleInstall(error));
    }
    let private_control_catalog =
        match install_plan.install(&runtime.host_mut().module_effect_registrations()) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                let _ = shutdown_runtime(&mut runtime).await;
                return Err(ControlError::ModuleInstall(error));
            }
        };
    let private_control = PrivateControlRegistry::from_snapshot(private_control_catalog);
    let http_server = match crate::http::Server::bind(runtime_host_transport_port, router).await {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_runtime(&mut runtime).await;
            return Err(ControlError::Transport("http server"));
        }
    };
    if let Some(credentials) = runtime.handles.sealed_resource.matcha_reader_credentials() {
        let source = match matcha_agent::sealed::ReaderSource::new(
            format!("http://{}", http_server.local_addr()),
            credentials.token().to_owned(),
        ) {
            Ok(source) => source,
            Err(_) => {
                let _ = shutdown_runtime(&mut runtime).await;
                return Err(ControlError::Transport("sealed reader source"));
            }
        };
        if runtime
            .handles
            .matcha_agent
            .set_sealed_reader_source(source)
            .is_err()
        {
            let _ = shutdown_runtime(&mut runtime).await;
            return Err(ControlError::Transport("sealed reader source"));
        }
    }
    runtime.spawn_owner();
    if mcp.publish().is_err() {
        let _ = shutdown_runtime(&mut runtime).await;
        return Err(ControlError::Transport("MCP discovery"));
    }
    let (mut http_server, http_completion) = http_server.into_scoped_extension();
    runtime.http_completion = Some(http_completion);
    let result =
        runtime::run_private_control(&mut runtime, private_control, control_input, control_output)
            .await;
    http_server.dispose_all_lifo().await;
    let http_result = match runtime.http_completion.take() {
        Some(completion) => match completion.await {
            Ok(Ok(())) => Ok(()),
            _ => Err(ControlError::Transport("http server")),
        },
        None => Ok(()),
    };
    let shutdown = shutdown_runtime(&mut runtime).await;
    result.and(http_result).and(shutdown)
}

async fn shutdown_runtime(runtime: &mut runtime::RuntimeService) -> Result<(), ControlError> {
    if runtime.owner.is_none() {
        runtime.spawn_owner();
    }
    let owner = runtime
        .owner
        .as_mut()
        .expect("runtime owner must be spawned");
    shutdown_host(owner).await
}
