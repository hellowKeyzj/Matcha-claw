pub(crate) fn route_modules(
    modules: &[platform::module::ModuleDescriptor],
) -> Vec<platform::loopback::ModuleDescriptor> {
    modules
        .iter()
        .filter_map(|module| module.loopback().cloned())
        .collect()
}
