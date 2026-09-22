use platform::{loopback, module::ModuleCatalog};

pub(crate) struct RouteModuleSnapshot {
    modules: Vec<loopback::ModuleDescriptor>,
}

impl RouteModuleSnapshot {
    pub(crate) fn from_catalog(catalog: &ModuleCatalog) -> Self {
        Self {
            modules: catalog
                .modules()
                .iter()
                .filter_map(|module| module.loopback().cloned())
                .collect(),
        }
    }

    pub(crate) fn into_loopback_modules(self) -> Vec<loopback::ModuleDescriptor> {
        self.modules
    }
}
