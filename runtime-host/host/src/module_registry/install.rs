use platform::module::{ModuleCatalog, ModuleInstallError, PrivateControlCatalogSnapshot};

use crate::composition::HostHandles;

use super::{
    CapabilityVerifier,
    capability_catalog::CapabilityCatalog,
    effects::map_scoped_effects,
    routes::route_modules,
    runtime_modules::runtime_module_install_plan,
    system_modules::{install_plan_capabilities, system_module_install_plan},
};

pub(crate) struct InstallModulesInput<'a> {
    pub(crate) handles: &'a HostHandles,
    pub(crate) verifier: CapabilityVerifier,
    pub(crate) webhook_token: organization::adapters::loopback::trigger::WebhookToken,
}

pub(crate) struct ModuleInstallPlan {
    descriptors: Vec<platform::module::ModuleDescriptor>,
    capability_catalog: CapabilityCatalog,
}

pub(crate) fn prepare_module_install(input: InstallModulesInput<'_>) -> ModuleInstallPlan {
    let InstallModulesInput {
        handles,
        verifier,
        webhook_token,
    } = input;
    let capability_catalog = CapabilityCatalog::new();
    let descriptors =
        module_descriptors(handles, verifier, webhook_token, capability_catalog.clone());
    ModuleInstallPlan {
        descriptors,
        capability_catalog,
    }
}

impl ModuleInstallPlan {
    pub(crate) fn route_snapshot(&self) -> Vec<platform::loopback::ModuleDescriptor> {
        route_modules(&self.descriptors)
    }

    pub(crate) fn install(
        self,
        scoped_effects: &[foundation::lifecycle::EffectRegistration],
    ) -> Result<PrivateControlCatalogSnapshot, ModuleInstallError> {
        let effects = map_scoped_effects(scoped_effects);
        let catalog = ModuleCatalog::install_with_capabilities_and_effects(
            self.descriptors,
            install_plan_capabilities(),
            &effects,
        )?;
        self.capability_catalog
            .install_snapshot(catalog.capability_snapshot());
        Ok(catalog.private_control_snapshot())
    }
}

fn module_descriptors(
    handles: &HostHandles,
    verifier: CapabilityVerifier,
    webhook_token: organization::adapters::loopback::trigger::WebhookToken,
    capability_catalog: CapabilityCatalog,
) -> Vec<platform::module::ModuleDescriptor> {
    let (capability_catalog, private_control) =
        system_module_install_plan(verifier.clone(), capability_catalog);
    let (before_capability_catalog, after_capability_catalog, process_modules) =
        runtime_module_install_plan(handles, verifier, webhook_token);

    let mut descriptors = before_capability_catalog;
    descriptors.push(capability_catalog);
    descriptors.extend(after_capability_catalog);
    descriptors.push(private_control);
    descriptors.extend(process_modules);
    descriptors
}
