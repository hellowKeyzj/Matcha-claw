use std::sync::Arc;

use platform::module::ModuleDescriptor;

use crate::{Host, composition::HostHandles};

use super::CapabilityVerifier;

pub(crate) struct RuntimeModuleInstallPlan {
    pub(crate) before_capability_catalog: Vec<ModuleDescriptor>,
    pub(crate) after_capability_catalog: Vec<ModuleDescriptor>,
    pub(crate) process_modules: [ModuleDescriptor; 2],
}

pub(crate) fn runtime_module_install_plan(
    handles: &HostHandles,
    verifier: CapabilityVerifier,
    webhook_token: organization::adapters::loopback::trigger::WebhookToken,
) -> RuntimeModuleInstallPlan {
    let send_hooks = sessions_module::SessionSendHookSet::new(vec![Arc::new(
        crate::composition::host::ports::organization::StartGateSessionSendHook::new(
            handles.organization.clone(),
            handles.start_gate_registry.clone(),
        ),
    )]);
    let runtime_directory_source: Arc<dyn runtime_directory::RuntimeEndpointDirectorySource> =
        Arc::new(handles.peer.clone());
    let runtime_control_lifecycle: Arc<
        dyn runtime_directory::control_loopback::RuntimeControlLifecyclePort,
    > = Arc::new(handles.peer.clone());
    let openclaw_gateway_port: Arc<dyn openclaw::gateway::loopback::OpenClawGatewayCapabilityPort> =
        Arc::new(handles.peer.clone());
    let openclaw_platform_admission: Arc<
        dyn openclaw::platform_runtime::loopback::OpenClawPlatformAdmissionPort,
    > = handles.admission.clone();

    RuntimeModuleInstallPlan {
        before_capability_catalog: vec![
            handles
                .organization_module
                .descriptor(Arc::clone(&verifier), webhook_token),
            handles.channel.descriptor(Arc::clone(&verifier)),
            handles.security.descriptor(Arc::clone(&verifier)),
            handles.settings.descriptor(Arc::clone(&verifier)),
            handles.connector.descriptor(Arc::clone(&verifier)),
            handles.provider.descriptor(Arc::clone(&verifier)),
            runtime_directory::RuntimeDirectoryModule::new(runtime_directory_source)
                .descriptor(Arc::clone(&verifier)),
            runtime_directory::control_loopback::RuntimeControlModule::new(vec![
                Arc::new(
                    matcha_agent::driver::runtime_control_route::MatchaRuntimeControlRoute::new(
                        Arc::clone(&runtime_control_lifecycle),
                    ),
                )
                    as Arc<dyn runtime_directory::control_loopback::RuntimeControlRouteFragment>,
                Arc::new(
                    openclaw::driver::runtime_control_route::OpenClawRuntimeControlRoute::new(
                        Arc::clone(&handles.open_claw),
                        runtime_control_lifecycle,
                    ),
                )
                    as Arc<dyn runtime_directory::control_loopback::RuntimeControlRouteFragment>,
            ])
            .descriptor(Arc::clone(&verifier)),
            openclaw::gateway::loopback::descriptor(Arc::clone(&verifier), openclaw_gateway_port),
            openclaw::platform_runtime::loopback::descriptor(
                Arc::clone(&verifier),
                Arc::clone(&handles.open_claw),
                openclaw_platform_admission,
            ),
        ],
        after_capability_catalog: vec![
            handles.session_module.descriptor(
                Arc::clone(&verifier),
                send_hooks,
                handles.session_delta_source.clone(),
            ),
            handles.fleet_module.descriptor(Arc::clone(&verifier)),
            handles.plugins.descriptor(Arc::clone(&verifier)),
            handles.sealed_resource.descriptor(),
            handles.skills.descriptor(Arc::clone(&verifier)),
            handles.cron.descriptor(Arc::clone(&verifier)),
            handles.usage.descriptor(Arc::clone(&verifier)),
            handles
                .diagnostics
                .descriptor(Arc::clone(&verifier), handles.observation.clone()),
            handles.task_manager.descriptor(Arc::clone(&verifier)),
            handles.agents.descriptor(Arc::clone(&verifier)),
            handles.workspace.descriptor(Arc::clone(&verifier)),
            handles.platform_tools.descriptor(Arc::clone(&verifier)),
            handles.toolchain.descriptor(Arc::clone(&verifier)),
        ],
        process_modules: Host::runtime_process_descriptors(),
    }
}
