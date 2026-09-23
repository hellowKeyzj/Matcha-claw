use std::sync::Arc;

use tokio::io::{AsyncRead, AsyncWrite};

use crate::{
    Host, HostInput,
    composition::HostHandles,
    control::{ControlError, run_loop},
    host_actor,
    module_registry::{
        install::{InstallModulesInput, prepare_module_install},
        private_control::PrivateControlRegistry,
    },
};

#[cfg(test)]
const TEST_VERIFICATION_KEY: &str = "MCowBQYDK2VwAyEAhI7FT5ZzRIPEHVkZavhKl2CqMou1WrMW7b9vB7BHXoE";
#[cfg(test)]
const TEST_WEBHOOK_TOKEN: &str =
    "mctwh_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

pub(crate) struct RuntimeService {
    pub(crate) host: Option<Host>,
    pub(crate) events: Option<crate::composition::HostEvents>,
    pub(crate) owner: Option<host_actor::Owner>,
    pub(crate) handles: HostHandles,
    gateway_auto_start: bool,
}

pub(crate) async fn start(input: HostInput) -> Result<RuntimeService, ControlError> {
    let (mut host, events, handles) = Host::new(input).map_err(ControlError::Construction)?;
    let gateway_auto_start = handles.settings.gateway_auto_start().await;
    host.start_admission_only()
        .await
        .map_err(|error| ControlError::Start(error.to_string()))?;
    Ok(RuntimeService {
        host: Some(host),
        events: Some(events),
        owner: None,
        handles,
        gateway_auto_start,
    })
}

impl RuntimeService {
    pub(crate) fn host_mut(&mut self) -> &mut Host {
        self.host
            .as_mut()
            .expect("Host must remain owned until actor spawn")
    }

    pub(crate) fn spawn_owner(&mut self) {
        let host = self.host.take().expect("Host must be spawned once");
        let events = self
            .events
            .take()
            .expect("Host events must be spawned once");
        self.owner = Some(host_actor::Owner::spawn(host, events));
    }
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
    let owner = runtime
        .owner
        .as_mut()
        .expect("Host owner must be spawned before private control starts");
    let owner_events = owner
        .take_events()
        .expect("owner event receiver must be taken before control starts");
    run_loop(
        owner.handle(),
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
    let install_plan = prepare_module_install(InstallModulesInput {
        handles: &runtime.handles,
        verifier,
        webhook_token,
    });
    let route_snapshot = install_plan.route_snapshot();
    let router = crate::http::Router::new(route_snapshot.clone());
    if let Err(error) = runtime
        .host_mut()
        .register_route_effects(&route_snapshot, router)
    {
        runtime.spawn_owner();
        if let Some(owner) = runtime.owner.as_mut() {
            let _ = super::shutdown::shutdown_host(owner).await;
        }
        return Err(ControlError::ModuleInstall(error));
    }
    let private_control_catalog =
        match install_plan.install(&runtime.host_mut().module_effect_registrations()) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                runtime.spawn_owner();
                if let Some(owner) = runtime.owner.as_mut() {
                    let _ = super::shutdown::shutdown_host(owner).await;
                }
                return Err(ControlError::ModuleInstall(error));
            }
        };
    let private_control = PrivateControlRegistry::from_snapshot(private_control_catalog);
    runtime.spawn_owner();
    let result =
        run_private_control(&mut runtime, private_control, control_input, control_output).await;
    let shutdown = match runtime.owner.as_mut() {
        Some(owner) => super::shutdown::shutdown_host(owner).await,
        None => Ok(()),
    };
    result.and(shutdown)
}
