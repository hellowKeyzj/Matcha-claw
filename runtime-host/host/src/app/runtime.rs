use std::sync::Arc;

use tokio::io::{AsyncRead, AsyncWrite};

use crate::{
    Host, HostInput,
    composition::HostHandles,
    control::{ControlError, run_loop},
    host_actor,
    module_registry::{
        install::{InstallModulesInput, install_modules},
        private_control::PrivateControlRegistry,
    },
};

#[cfg(test)]
const TEST_VERIFICATION_KEY: &str = "MCowBQYDK2VwAyEAhI7FT5ZzRIPEHVkZavhKl2CqMou1WrMW7b9vB7BHXoE";
#[cfg(test)]
const TEST_WEBHOOK_TOKEN: &str =
    "mctwh_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

pub(crate) struct RuntimeService {
    pub(crate) owner: host_actor::Owner,
    pub(crate) handles: HostHandles,
    pub(crate) module_effect_registrations: Vec<foundation::lifecycle::EffectRegistration>,
    gateway_auto_start: bool,
}

pub(crate) async fn start(input: HostInput) -> Result<RuntimeService, ControlError> {
    let (mut host, events, handles) = Host::new(input).map_err(ControlError::Construction)?;
    let gateway_auto_start = handles.settings.gateway_auto_start().await;
    host.start_admission_only()
        .await
        .map_err(|error| ControlError::Start(error.to_string()))?;
    let module_effect_registrations = host.module_effect_registrations();
    let owner = host_actor::Owner::spawn(host, events);
    Ok(RuntimeService {
        owner,
        handles,
        module_effect_registrations,
        gateway_auto_start,
    })
}

pub(crate) async fn run_private_control<R, W>(
    runtime: &mut RuntimeService,
    private_control: PrivateControlRegistry,
    control_input: R,
    control_output: W,
) -> Result<(), ControlError>
where
    R: AsyncRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin,
{
    let owner_events = runtime
        .owner
        .take_events()
        .expect("owner event receiver must be taken before control starts");
    run_loop(
        runtime.owner.handle(),
        owner_events,
        runtime.handles.peer.clone(),
        private_control,
        runtime.handles.observation.clone(),
        runtime.gateway_auto_start,
        control_input,
        control_output,
    )
    .await
}

#[cfg(test)]
pub(crate) async fn run_control_service<R, W>(
    input: HostInput,
    control_input: R,
    control_output: W,
) -> Result<(), ControlError>
where
    R: AsyncRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin,
{
    let mut runtime = start(input).await?;
    let verifier = Arc::new(tokio::sync::Mutex::new(
        platform::capability::CapabilityDecisionVerifier::try_new(TEST_VERIFICATION_KEY)
            .expect("test verifier key"),
    ));
    let webhook_token =
        organization::adapters::loopback::trigger::WebhookToken::try_new(TEST_WEBHOOK_TOKEN)
            .expect("test webhook token");
    let installed_modules = match install_modules(InstallModulesInput {
        handles: &runtime.handles,
        scoped_effects: &runtime.module_effect_registrations,
        verifier,
        webhook_token,
    }) {
        Ok(modules) => modules,
        Err(error) => {
            let _ = super::shutdown::shutdown_host(&mut runtime.owner).await;
            return Err(ControlError::ModuleInstall(error));
        }
    };
    let (_, private_control_catalog) = installed_modules.into_parts();
    let private_control = PrivateControlRegistry::from_snapshot(private_control_catalog);
    let result =
        run_private_control(&mut runtime, private_control, control_input, control_output).await;
    let shutdown = super::shutdown::shutdown_host(&mut runtime.owner).await;
    result.and(shutdown)
}
