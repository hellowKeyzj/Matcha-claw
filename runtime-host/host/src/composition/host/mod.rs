use std::sync::Arc;

use sessions_module::command::SessionIngressEvent;
use tokio::sync::mpsc;

use crate::composition::runtime_ports::{RuntimeDriver, RuntimeDriverIdentity};
use matcha_agent::driver::{MatchaAgentInstance, MatchaRuntimeDriver, build_peer};
use openclaw::driver::OpenClawDriver;

use crate::{http::Router, parent_callback::ParentCallbackClient};
use ::cron::CronModule;
use ::fleet::{FleetHandle, FleetModule};

use super::{
    admission::{HostAdmission, HostState as AdmissionState, HostTransitionError},
    events::{self, EventSinks, HostEvents},
    peer::PeerHandle,
};
pub(super) mod diagnostics;
mod errors;
mod handle_wiring;
mod handles;
mod input;
mod owners;
pub(crate) mod ports;
mod provisioning;
mod resources;
mod session_ingress;
#[allow(dead_code)]
mod session_shutdown;
mod shutdown;

pub use errors::{ConstructionError, RuntimeLifecycleFailure, RuntimeStartFailure};
pub(crate) use handles::HostHandles;
pub use input::HostInput;
pub use session_shutdown::SessionShutdownFailure;
pub use shutdown::{
    Failures as ShutdownFailures, HostShutdownError, OwnerShutdownFailure, RuntimeExit,
    RuntimeShutdownFailure, RuntimeShutdownOutcome, ShutdownReport,
};

pub struct Host {
    pub(crate) admission: Arc<HostAdmission>,
    pub(crate) _parent_callback: ParentCallbackClient,
    peer_handle: PeerHandle,
    fleet_handle: FleetHandle,
    fleet_module: FleetModule,
    owner_runtime_tasks: owners::OwnerRuntimeTasks,
    call_scope: foundation::lifecycle::ModuleScope,
    peer_startup: super::peer::PeerStartupState,
    matcha_runtime_driver: Arc<MatchaRuntimeDriver>,
    open_claw: Arc<OpenClawDriver>,
    runtime_processes: shutdown::RuntimeProcessScopes,
    cron_handle: CronModule,
    event_sinks: EventSinks,
    runtime_observation: ::diagnostics::RuntimeFlightRecorder,
    matcha_startup_diagnostics: ::diagnostics::RuntimeStartupDiagnostics,
    openclaw_startup_diagnostics: ::diagnostics::RuntimeStartupDiagnostics,
    shutdown_failures: shutdown::ShutdownState,
}

struct PeerRuntimeArtifacts {
    matcha: MatchaAgentInstance,
    open_claw: Arc<OpenClawDriver>,
    matcha_runtime_driver: Arc<MatchaRuntimeDriver>,
    event_sinks: EventSinks,
    events: HostEvents,
    openclaw_session_events: Option<mpsc::Receiver<SessionIngressEvent>>,
    matcha_session_events: Option<mpsc::Receiver<SessionIngressEvent>>,
    session_delta_source: sessions_module::SessionDeltaSource,
}

struct HostAssemblyArtifacts {
    calls: call_log::CallLogModule,
    sealed_resource: sealed_resource::SealedResourceModule,
    clawhub_registry: clawhub::ClawHubRegistryClient,
    runtime_observation: ::diagnostics::RuntimeFlightRecorder,
    matcha_startup_diagnostics: ::diagnostics::RuntimeStartupDiagnostics,
    openclaw_startup_diagnostics: ::diagnostics::RuntimeStartupDiagnostics,
}

fn prepare_host_stage(
    input: HostInput,
) -> Result<(ParentCallbackClient, provisioning::PreparedHost), ConstructionError> {
    let HostInput {
        matcha,
        matcha_secret,
        open_claw,
        open_claw_secret,
        organization_store,
        runtime_state_dir,
        app_log_dir,
        parent_callback_base_url,
        parent_callback_dispatch_token,
        runtime_observation,
    } = input;
    let parent_callback =
        ParentCallbackClient::new(parent_callback_base_url, parent_callback_dispatch_token)
            .map_err(ConstructionError::ParentCallback)?;
    let prepared = provisioning::prepare_host(provisioning::PrepareHostInput {
        matcha,
        matcha_secret,
        open_claw,
        open_claw_secret,
        organization_store,
        runtime_state_dir,
        app_log_dir,
        runtime_observation,
    });
    Ok((parent_callback, prepared))
}

fn build_peer_runtime_stage(
    parent_callback: &ParentCallbackClient,
    mut prepared: provisioning::PreparedHost,
) -> Result<(provisioning::ProvisionedHost, PeerRuntimeArtifacts), ConstructionError> {
    let report_matcha_diagnostic = matcha_agent::diagnostics::runtime_diagnostic_reporter(
        prepared.matcha_startup_diagnostics.clone(),
    );
    let report_openclaw_diagnostic = openclaw::diagnostics::runtime_diagnostic_reporter(
        prepared.openclaw_startup_diagnostics.clone(),
    );
    prepared.openclaw_input.report_diagnostic = report_openclaw_diagnostic;
    let open_claw = OpenClawDriver::prepare(prepared.openclaw_input, prepared.openclaw_secret)
        .map_err(ConstructionError::OpenClaw)?;
    let sealed = resources::provision_sealed_resources(
        &prepared.runtime_state_dir,
        &prepared.diagnostics_state_root,
        prepared.sealed_runtime_token,
    )?;
    let matcha = build_peer(
        prepared.matcha_input,
        prepared.matcha_secret,
        Arc::clone(&prepared.toolchain),
        report_matcha_diagnostic,
    )
    .map_err(ConstructionError::Matcha)?;
    let fleet_private_root = resources::provision_fleet_private_root(
        resources::fleet_private_root_path(&prepared.runtime_state_dir),
    )?;
    let provider_cascade = resources::provision_provider_cascade(&prepared.diagnostics_state_root)?;
    let diagnostics = resources::provision_diagnostics_archive(
        &prepared.diagnostics_state_root,
        prepared.app_log_dir,
        prepared.runtime_observation.clone(),
    )?;
    let organization = resources::provision_organization_owner(
        prepared.organization_store,
        prepared.diagnostics_state_root.as_path(),
    )?;
    let provisioned = provisioning::ProvisionedHost {
        organization,
        runtime_state_dir: prepared.runtime_state_dir,
        diagnostics_state_root: prepared.diagnostics_state_root,
        runtime_observation: prepared.runtime_observation,
        matcha_startup_diagnostics: prepared.matcha_startup_diagnostics,
        openclaw_startup_diagnostics: prepared.openclaw_startup_diagnostics,
        clawhub_registry: prepared.clawhub_registry,
        toolchain: prepared.toolchain,
        runtime_host_mcp_executable: prepared.runtime_host_mcp_executable,
        runtime_host_mcp_state_dir: prepared.runtime_host_mcp_state_dir,
        sealed_resource: sealed.sealed_resource,
        provider_cascade,
        fleet_private_root,
        diagnostics,
    };
    let mut matcha = MatchaAgentInstance::new(matcha);
    let (event_sinks, events) = events::channels();
    let (matcha_session_sink, matcha_session_events) = mpsc::channel(256);
    let (openclaw_session_sink, openclaw_session_events) = mpsc::channel(256);
    let session_delta_source = sessions_module::SessionDeltaSource::new(256);
    matcha.set_renderer_events(Some(matcha_session_sink));
    let open_claw_event_sink = event_sinks
        .open_claw()
        .expect("OpenClaw event sink must be available during construction");
    let open_claw = open_claw
        .into_instance(
            open_claw_event_sink,
            openclaw_session_sink,
            Arc::new(parent_callback.clone()),
        )
        .map_err(ConstructionError::OpenClaw)?;
    let open_claw = Arc::new(open_claw);
    let matcha_runtime_driver = matcha.runtime_driver();
    Ok((
        provisioned,
        PeerRuntimeArtifacts {
            matcha,
            open_claw,
            matcha_runtime_driver,
            event_sinks,
            events,
            openclaw_session_events: Some(openclaw_session_events),
            matcha_session_events: Some(matcha_session_events),
            session_delta_source,
        },
    ))
}

fn spawn_owner_runtime_stage(
    provisioned: provisioning::ProvisionedHost,
    runtime: &PeerRuntimeArtifacts,
    admission: &Arc<HostAdmission>,
) -> Result<(owners::RuntimeOwners, HostAssemblyArtifacts), ConstructionError> {
    let provisioning::ProvisionedHost {
        organization,
        runtime_state_dir,
        diagnostics_state_root,
        runtime_observation,
        matcha_startup_diagnostics,
        openclaw_startup_diagnostics,
        clawhub_registry,
        toolchain,
        runtime_host_mcp_executable,
        runtime_host_mcp_state_dir,
        sealed_resource,
        provider_cascade,
        fleet_private_root,
        diagnostics,
    } = provisioned;
    let calls = call_log::CallLogModule::open(&runtime_state_dir.join("call-log"))
        .map_err(ConstructionError::CallLog)?;
    let sealed_resource = sealed_resource.with_call_recorder(calls.recorder());
    let owners = owners::spawn_runtime_owners(owners::RuntimeOwnerInput {
        calls: calls.recorder(),
        organization,
        runtime_state_dir,
        diagnostics_state_root,
        runtime_host_mcp_executable,
        runtime_host_mcp_state_dir,
        provider_cascade,
        fleet_private_root,
        matcha_startup_diagnostics: matcha_startup_diagnostics.clone(),
        openclaw_startup_diagnostics: openclaw_startup_diagnostics.clone(),
        runtime_observation: runtime_observation.clone(),
        diagnostics: diagnostics.clone(),
        toolchain: Arc::clone(&toolchain),
        open_claw: Arc::clone(&runtime.open_claw),
        matcha_driver: runtime.matcha_runtime_driver.clone(),
        admission: Arc::clone(admission),
        sealed_resource: sealed_resource.clone(),
        session_delta: Some(runtime.session_delta_source.clone()),
        open_claw_runtime: runtime.event_sinks.open_claw_runtime(),
        cron_events: runtime.event_sinks.cron(),
    })?;
    Ok((
        owners,
        HostAssemblyArtifacts {
            calls,
            sealed_resource,
            clawhub_registry,
            runtime_observation,
            matcha_startup_diagnostics,
            openclaw_startup_diagnostics,
        },
    ))
}

fn wire_session_ingress(owners: &mut owners::RuntimeOwners, runtime: &mut PeerRuntimeArtifacts) {
    let Some(session_scope) = owners.tasks.module_scope_mut("sessions") else {
        return;
    };
    let openclaw_session_events = runtime
        .openclaw_session_events
        .take()
        .expect("OpenClaw session ingress receiver must be wired once");
    session_ingress::forward(
        session_scope,
        owners.session_handle.clone(),
        "openclaw-session-ingress",
        openclaw_session_events,
    );
    let matcha_session_events = runtime
        .matcha_session_events
        .take()
        .expect("Matcha session ingress receiver must be wired once");
    session_ingress::forward(
        session_scope,
        owners.session_handle.clone(),
        "matcha-session-ingress",
        matcha_session_events,
    );
}

fn wire_diagnostics_forwarders(owners: &mut owners::RuntimeOwners, runtime: &PeerRuntimeArtifacts) {
    let open_claw_runtime_sink = runtime
        .event_sinks
        .open_claw_runtime()
        .expect("OpenClaw runtime event sink must be available during construction");
    let diagnostics_scope = owners
        .tasks
        .module_scope_mut("diagnostics")
        .expect("diagnostics module scope must exist");
    diagnostics::forward_openclaw_runtime_changes(
        diagnostics_scope,
        runtime.open_claw.owner().subscribe(),
        open_claw_runtime_sink.clone(),
    );
    diagnostics::forward_openclaw_runtime_readiness_changes(
        diagnostics_scope,
        runtime.open_claw.control_readiness(),
        open_claw_runtime_sink,
    );
    if let Some(matcha_lifecycle_sink) = runtime.event_sinks.matcha_lifecycle() {
        diagnostics::forward_matcha_lifecycle_changes(
            diagnostics_scope,
            runtime
                .matcha_runtime_driver
                .host_lifecycle_ops()
                .expect("Matcha Agent lifecycle operations must be available")
                .subscribe(),
            matcha_lifecycle_sink,
        );
    }
}

fn assemble_host(
    parent_callback: ParentCallbackClient,
    admission: Arc<HostAdmission>,
    mut owners: owners::RuntimeOwners,
    runtime: PeerRuntimeArtifacts,
    artifacts: HostAssemblyArtifacts,
) -> (Host, HostEvents, HostHandles) {
    let HostAssemblyArtifacts {
        calls,
        sealed_resource,
        clawhub_registry,
        runtime_observation,
        matcha_startup_diagnostics,
        openclaw_startup_diagnostics,
    } = artifacts;
    let PeerRuntimeArtifacts {
        matcha,
        open_claw,
        matcha_runtime_driver,
        event_sinks,
        mut events,
        session_delta_source,
        ..
    } = runtime;
    events.set_call_changes(calls.subscribe());
    events.set_organization_changes(owners.organization_handle.subscribe_schedule_changes());
    let handles = handle_wiring::build_handles(
        handle_wiring::HostHandleInput {
            admission: Arc::clone(&admission),
            calls: calls.clone(),
            open_claw: Arc::clone(&open_claw),
            sealed_resource,
            clawhub_registry,
            runtime_observation: runtime_observation.clone(),
            session_delta_source: session_delta_source.clone(),
            start_gate_registry: std::sync::Arc::clone(&owners.start_gate_registry),
        },
        &owners,
    );
    let plugins = handles.plugins.clone();
    owners
        .tasks
        .module_scope_mut("plugins")
        .expect("plugins module scope must exist")
        .register_effect_disposer(
            foundation::lifecycle::ScopedEffectKind::OwnerTask,
            "owner-task",
            move || async move {
                plugins.stop_operations().await;
            },
        );
    let skills = handles.skills.clone();
    owners
        .tasks
        .module_scope_mut("skills")
        .expect("skills module scope must exist")
        .register_effect_disposer(
            foundation::lifecycle::ScopedEffectKind::OwnerTask,
            "owner-task",
            move || async move {
                skills.stop_operations().await;
            },
        );
    let cron_handle = handles.cron.clone();
    let shutdown_failures = shutdown::ShutdownState::new(owners.tasks.join_failures());
    let call_scope = shutdown_failures.call_log_scope(calls);
    let runtime_processes = shutdown::RuntimeProcessScopes::new(
        Arc::clone(&open_claw),
        matcha,
        Arc::clone(&matcha_runtime_driver),
        runtime_observation.sink(),
        &shutdown_failures,
    );
    let fleet_module = owners.fleet_module.clone();
    let host = Host {
        admission,
        _parent_callback: parent_callback,
        peer_handle: owners.peer_handle,
        fleet_handle: owners.fleet_handle,
        fleet_module,
        owner_runtime_tasks: owners.tasks,
        call_scope,
        peer_startup: owners.peer_startup,
        matcha_runtime_driver,
        open_claw,
        runtime_processes,
        cron_handle,
        event_sinks,
        runtime_observation,
        matcha_startup_diagnostics,
        openclaw_startup_diagnostics,
        shutdown_failures,
    };
    (host, events, handles)
}

impl Host {
    pub(crate) fn new(
        input: HostInput,
    ) -> Result<(Self, HostEvents, HostHandles), ConstructionError> {
        let (parent_callback, prepared) = prepare_host_stage(input)?;
        let (provisioned, mut runtime) = build_peer_runtime_stage(&parent_callback, prepared)?;
        let admission = Arc::new(HostAdmission::new());
        let (mut owners, artifacts) = spawn_owner_runtime_stage(provisioned, &runtime, &admission)?;
        wire_session_ingress(&mut owners, &mut runtime);
        wire_diagnostics_forwarders(&mut owners, &runtime);
        Ok(assemble_host(
            parent_callback,
            admission,
            owners,
            runtime,
            artifacts,
        ))
    }

    fn runtime_driver(
        &self,
        endpoint: &platform::endpoint::runtime_address::RuntimeEndpoint,
    ) -> Option<&dyn RuntimeDriver> {
        if *endpoint == RuntimeDriverIdentity::open_claw().endpoint() {
            Some(self.open_claw.as_ref())
        } else if *endpoint == RuntimeDriverIdentity::matcha_agent().endpoint() {
            Some(self.matcha_runtime_driver.as_ref())
        } else {
            None
        }
    }

    pub(crate) fn module_effect_registrations(
        &self,
    ) -> Vec<foundation::lifecycle::EffectRegistration> {
        let mut registrations = self.owner_runtime_tasks.module_effect_registrations();
        registrations.extend(self.runtime_processes.effect_registrations());
        registrations.extend(self.call_scope.effect_registrations().iter().copied());
        registrations
    }

    pub(crate) fn register_route_effects(
        &mut self,
        routes: &[platform::loopback::ModuleDescriptor],
        router: Router,
    ) -> Result<(), platform::module::ModuleInstallError> {
        for module in routes {
            let scope = if module.id().as_str() == "call-log" {
                Some(&mut self.call_scope)
            } else {
                self.owner_runtime_tasks
                    .route_scope_mut(module.id().as_str())
            };
            let Some(scope) = scope else {
                return Err(platform::module::ModuleEffectError::UnknownModule {
                    module: platform::module::ModuleId::new(module.id().as_str()),
                    effect: platform::module::EffectKind::Route,
                }
                .into());
            };
            for route in module.routes() {
                let module_id = module.id();
                let route_id = route.id();
                let router = router.clone();
                scope.register_route(route_id, move || async move {
                    router.unregister_route(module_id, route_id).await;
                });
            }
        }
        Ok(())
    }

    pub(crate) fn runtime_process_descriptors() -> [platform::module::ModuleDescriptor; 2] {
        shutdown::RuntimeProcessScopes::descriptors()
    }

    pub async fn start(&mut self) -> Result<(), HostTransitionError> {
        self.start_with_open_claw(true).await
    }

    pub async fn start_admission_only(&mut self) -> Result<(), HostTransitionError> {
        match self.admission.state().phase() {
            super::admission::HostPhase::Created => self.admission.begin_start()?,
            super::admission::HostPhase::Starting => {}
            phase => return Err(HostTransitionError::StartFrom(phase)),
        }
        self.drain_fleet_startup_dispatches().await;
        self.admission.publish_ready()
    }

    async fn drain_fleet_startup_dispatches(&mut self) {
        self.fleet_module.begin_startup_dispatches().await;
    }

    pub async fn start_with_open_claw(
        &mut self,
        open_claw_auto_start: bool,
    ) -> Result<(), HostTransitionError> {
        self.start_admission_only().await?;
        let peer = self.peer_handle.clone();
        tokio::spawn(async move {
            let _ = peer.request_peer_autostart(open_claw_auto_start).await;
        });
        Ok(())
    }

    pub fn admission_state(&self) -> AdmissionState {
        self.admission.state()
    }
}

#[cfg(test)]
mod tests;
