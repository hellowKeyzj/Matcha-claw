use std::sync::Arc;

use tokio::io::{AsyncRead, AsyncWrite};

use super::{runtime, shutdown::shutdown_host};
use crate::{
    HostInput,
    control::ControlError,
    module_registry::{
        install::{InstallModulesInput, install_modules},
        private_control::PrivateControlRegistry,
    },
};

pub struct AppInput<R, W> {
    pub host: HostInput,
    pub verifier: platform::capability::CapabilityDecisionVerifier,
    pub provider_credential_resolver: Option<provider_module::Resolver>,
    pub webhook_token: organization::adapters::loopback::trigger::WebhookToken,
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
        control_output,
    } = app;
    let mut runtime = runtime::start(input).await?;

    let provider_private_resolver =
        provider_credential_resolver.unwrap_or_else(provider_module::Resolver::disabled);
    if runtime
        .handles
        .provider
        .configure_private_resolver(provider_private_resolver.clone())
        .await
        .is_err()
    {
        let _ = shutdown_host(&mut runtime.owner).await;
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
        let _ = shutdown_host(&mut runtime.owner).await;
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
        let _ = shutdown_host(&mut runtime.owner).await;
        return Err(ControlError::Transport("connector credential resolver"));
    }

    runtime
        .handles
        .security
        .recover_pending()
        .await
        .map_err(|_| ControlError::Transport("security emergency recovery"))?;
    let verifier = Arc::new(tokio::sync::Mutex::new(verifier));
    let installed_modules = match install_modules(InstallModulesInput {
        handles: &runtime.handles,
        scoped_effects: &runtime.module_effect_registrations,
        verifier: Arc::clone(&verifier),
        webhook_token,
    }) {
        Ok(modules) => modules,
        Err(error) => {
            let _ = shutdown_host(&mut runtime.owner).await;
            return Err(ControlError::ModuleInstall(error));
        }
    };
    let (modules, private_control_catalog) = installed_modules.into_parts();
    let private_control = PrivateControlRegistry::from_snapshot(private_control_catalog);
    let router = crate::http::Router::new(crate::http::RouterInput { routes: modules });
    let http_server = match crate::http::Server::bind(runtime_host_transport_port, router).await {
        Ok(transport) => transport,
        Err(_) => {
            let _ = shutdown_host(&mut runtime.owner).await;
            return Err(ControlError::Transport("http server"));
        }
    };
    let mut http_server = http_server.into_scoped_extension();
    let result =
        runtime::run_private_control(&mut runtime, private_control, control_input, control_output)
            .await;
    http_server.dispose_all_lifo().await;
    let shutdown = shutdown_host(&mut runtime.owner).await;
    result.and(shutdown)
}
