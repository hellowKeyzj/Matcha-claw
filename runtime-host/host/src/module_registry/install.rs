use platform::module::{ModuleCatalog, ModuleInstallError, PrivateControlCatalogSnapshot};

use crate::composition::HostHandles;

use super::{
    CapabilityVerifier,
    capability_catalog::CapabilityCatalog,
    effects::map_scoped_effects,
    routes::RouteModuleSnapshot,
    runtime_modules::{RuntimeModuleInstallPlan, runtime_module_install_plan},
    system_modules::{
        SystemModuleInstallPlan, install_plan_capabilities, system_module_install_plan,
    },
};

pub(crate) struct InstallModulesInput<'a> {
    pub(crate) handles: &'a HostHandles,
    pub(crate) scoped_effects: &'a [foundation::lifecycle::EffectRegistration],
    pub(crate) verifier: CapabilityVerifier,
    pub(crate) webhook_token: organization::adapters::loopback::trigger::WebhookToken,
}

pub(crate) struct InstalledModules {
    route_snapshot: RouteModuleSnapshot,
    private_control_snapshot: PrivateControlCatalogSnapshot,
}

impl InstalledModules {
    pub(crate) fn into_parts(
        self,
    ) -> (
        Vec<platform::loopback::ModuleDescriptor>,
        PrivateControlCatalogSnapshot,
    ) {
        (
            self.route_snapshot.into_loopback_modules(),
            self.private_control_snapshot,
        )
    }
}

pub(crate) fn install_modules(
    input: InstallModulesInput<'_>,
) -> Result<InstalledModules, ModuleInstallError> {
    let InstallModulesInput {
        handles,
        scoped_effects,
        verifier,
        webhook_token,
    } = input;
    let capability_catalog = CapabilityCatalog::new();
    let catalog = ModuleCatalog::install_with_capabilities_and_effects(
        module_descriptors(handles, verifier, webhook_token, capability_catalog.clone()),
        install_plan_capabilities(),
        &map_scoped_effects(scoped_effects),
    )?;
    let route_snapshot = RouteModuleSnapshot::from_catalog(&catalog);
    let private_control_snapshot = catalog.private_control_snapshot();
    capability_catalog.install_snapshot(catalog.capability_snapshot());
    Ok(InstalledModules {
        route_snapshot,
        private_control_snapshot,
    })
}

fn module_descriptors(
    handles: &HostHandles,
    verifier: CapabilityVerifier,
    webhook_token: organization::adapters::loopback::trigger::WebhookToken,
    capability_catalog: CapabilityCatalog,
) -> Vec<platform::module::ModuleDescriptor> {
    let SystemModuleInstallPlan {
        capability_catalog,
        private_control,
    } = system_module_install_plan(verifier.clone(), capability_catalog);
    let RuntimeModuleInstallPlan {
        before_capability_catalog,
        after_capability_catalog,
        process_modules,
    } = runtime_module_install_plan(handles, verifier, webhook_token);

    let mut descriptors = before_capability_catalog;
    descriptors.push(capability_catalog);
    descriptors.extend(after_capability_catalog);
    descriptors.push(private_control);
    descriptors.extend(process_modules);
    descriptors
}
