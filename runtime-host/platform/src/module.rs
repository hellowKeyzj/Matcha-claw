use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use crate::loopback;

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ModuleId(&'static str);

impl ModuleId {
    pub const fn new(value: &'static str) -> Self {
        Self(value)
    }

    pub const fn as_str(self) -> &'static str {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct CapabilityKey(&'static str);

impl CapabilityKey {
    pub const fn new(value: &'static str) -> Self {
        Self(value)
    }

    pub const fn as_str(self) -> &'static str {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum EffectKind {
    OwnerTask,
    Route,
    EventSubscription,
    Process,
    Listener,
    RuntimeEndpoint,
    CallbackServer,
    FilesystemRead,
    FilesystemWrite,
    RuntimeOperation,
}

impl EffectKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::OwnerTask => "owner-task",
            Self::Route => "route",
            Self::EventSubscription => "event-subscription",
            Self::Process => "process",
            Self::Listener => "listener",
            Self::RuntimeEndpoint => "runtime-endpoint",
            Self::CallbackServer => "callback-server",
            Self::FilesystemRead => "filesystem-read",
            Self::FilesystemWrite => "filesystem-write",
            Self::RuntimeOperation => "runtime-operation",
        }
    }

    pub const fn is_scoped(self) -> bool {
        matches!(
            self,
            Self::OwnerTask
                | Self::Route
                | Self::EventSubscription
                | Self::Process
                | Self::Listener
                | Self::RuntimeEndpoint
                | Self::CallbackServer
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct EffectRegistration {
    module: ModuleId,
    effect: EffectKind,
    effect_id: &'static str,
}

impl EffectRegistration {
    pub const fn new(module: ModuleId, effect: EffectKind, effect_id: &'static str) -> Self {
        Self {
            module,
            effect,
            effect_id,
        }
    }

    pub const fn module(self) -> ModuleId {
        self.module
    }

    pub const fn effect(self) -> EffectKind {
        self.effect
    }

    pub const fn effect_id(self) -> &'static str {
        self.effect_id
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ModuleDependencyError {
    EmptyModuleId,
    DuplicateModule {
        module: ModuleId,
    },
    EmptyPrivateControlCommand {
        module: ModuleId,
    },
    DuplicatePrivateControlCommand {
        module: ModuleId,
        command: &'static str,
    },
    DuplicatePrivateControlProvider {
        command: &'static str,
        first: ModuleId,
        second: ModuleId,
    },
    EmptyHostCapability,
    DuplicateHostCapability {
        capability: CapabilityKey,
    },
    EmptyCapability {
        module: ModuleId,
    },
    DuplicateProvidedCapability {
        module: ModuleId,
        capability: CapabilityKey,
    },
    DuplicateRequiredCapability {
        module: ModuleId,
        capability: CapabilityKey,
    },
    HostCapabilityConflict {
        module: ModuleId,
        capability: CapabilityKey,
    },
    DuplicateProvider {
        capability: CapabilityKey,
        providers: Vec<ModuleId>,
    },
    MissingRequiredCapability {
        module: ModuleId,
        requires: CapabilityKey,
    },
    SelfDependency {
        module: ModuleId,
        capability: CapabilityKey,
    },
    DependencyCycle {
        modules: Vec<ModuleId>,
    },
    OutOfOrderDependency {
        module: ModuleId,
        depends_on: ModuleId,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ModuleEffectError {
    EmptyEffectId {
        module: ModuleId,
        effect: EffectKind,
    },
    DuplicateEffect {
        module: ModuleId,
        effect: EffectKind,
    },
    EmptyRouteId {
        module: ModuleId,
    },
    DuplicateRoute {
        module: ModuleId,
        route: &'static str,
    },
    DuplicateRouteAcrossModules {
        route: &'static str,
        first: ModuleId,
        second: ModuleId,
    },
    RouteEffectMismatch {
        module: ModuleId,
    },
    LoopbackModuleMismatch {
        module: ModuleId,
    },
    LoopbackRouteMismatch {
        module: ModuleId,
    },
    EmptyEventId {
        module: ModuleId,
    },
    DuplicateEvent {
        module: ModuleId,
        event: &'static str,
    },
    EventEffectMismatch {
        module: ModuleId,
    },
    UnknownModule {
        module: ModuleId,
        effect: EffectKind,
    },
    UndeclaredEffect {
        module: ModuleId,
        effect: EffectKind,
    },
    UndeclaredEffectId {
        module: ModuleId,
        effect: EffectKind,
        effect_id: &'static str,
    },
    DuplicateEffectRegistration {
        module: ModuleId,
        effect: EffectKind,
        effect_id: &'static str,
    },
    UnscopedEffectRegistration {
        module: ModuleId,
        effect: EffectKind,
        effect_id: &'static str,
    },
    MissingScopedEffect {
        module: ModuleId,
        effect: EffectKind,
        effect_id: &'static str,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ModuleInstallError {
    Dependency(ModuleDependencyError),
    Effect(ModuleEffectError),
}

impl From<ModuleDependencyError> for ModuleInstallError {
    fn from(error: ModuleDependencyError) -> Self {
        Self::Dependency(error)
    }
}

impl From<ModuleEffectError> for ModuleInstallError {
    fn from(error: ModuleEffectError) -> Self {
        Self::Effect(error)
    }
}

#[derive(Clone, Copy)]
pub struct PrivateControlDescriptor {
    name: &'static str,
    accepts_input: bool,
}

impl PrivateControlDescriptor {
    pub const fn new(name: &'static str, accepts_input: bool) -> Self {
        Self {
            name,
            accepts_input,
        }
    }

    pub const fn name(self) -> &'static str {
        self.name
    }

    pub const fn accepts_input(self) -> bool {
        self.accepts_input
    }
}

#[derive(Clone, Copy)]
pub struct PrivateControlProvider {
    descriptors: &'static [PrivateControlDescriptor],
}

impl PrivateControlProvider {
    pub const fn new(descriptors: &'static [PrivateControlDescriptor]) -> Self {
        Self { descriptors }
    }

    pub const fn descriptors(self) -> &'static [PrivateControlDescriptor] {
        self.descriptors
    }
}

#[derive(Clone)]
pub struct PrivateControlCatalogSnapshot {
    providers: Vec<(ModuleId, PrivateControlProvider)>,
}

impl PrivateControlCatalogSnapshot {
    fn new(providers: Vec<(ModuleId, PrivateControlProvider)>) -> Self {
        Self { providers }
    }

    pub fn find(&self, name: &str) -> Option<PrivateControlDescriptor> {
        self.providers
            .iter()
            .flat_map(|(_, provider)| provider.descriptors().iter().copied())
            .find(|descriptor| descriptor.name() == name)
    }
}

#[derive(Clone, Copy)]
pub struct CapabilityDescriptorProvider {
    listed: fn() -> Vec<Value>,
    describe: fn(&str, &Value) -> Option<Value>,
}

impl CapabilityDescriptorProvider {
    pub const fn new(
        listed: fn() -> Vec<Value>,
        describe: fn(&str, &Value) -> Option<Value>,
    ) -> Self {
        Self { listed, describe }
    }

    pub fn listed(self) -> Vec<Value> {
        (self.listed)()
    }

    pub fn describe(self, id: &str, scope: &Value) -> Option<Value> {
        (self.describe)(id, scope)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CapabilityDescribeOutcome {
    Available(Value),
    ScopeNotAvailable,
    UnknownCapability,
}

#[derive(Clone)]
pub struct CapabilityCatalogSnapshot {
    providers: Vec<CapabilityDescriptorProvider>,
}

impl CapabilityCatalogSnapshot {
    fn new(providers: Vec<CapabilityDescriptorProvider>) -> Self {
        Self { providers }
    }

    pub fn installed_capabilities(&self) -> Vec<Value> {
        let mut descriptors = self
            .providers
            .iter()
            .copied()
            .flat_map(CapabilityDescriptorProvider::listed)
            .collect::<Vec<_>>();
        descriptors.sort_by(|left, right| {
            left.get("id")
                .and_then(Value::as_str)
                .cmp(&right.get("id").and_then(Value::as_str))
        });
        descriptors
    }

    pub fn describe_capability(&self, id: &str, scope: &Value) -> CapabilityDescribeOutcome {
        let mut known = false;
        for provider in self.providers.iter().copied() {
            if provider
                .listed()
                .iter()
                .any(|descriptor| descriptor.get("id") == Some(&Value::String(id.to_owned())))
            {
                known = true;
            }
            if let Some(descriptor) = provider.describe(id, scope) {
                return CapabilityDescribeOutcome::Available(descriptor);
            }
        }
        if known {
            CapabilityDescribeOutcome::ScopeNotAvailable
        } else {
            CapabilityDescribeOutcome::UnknownCapability
        }
    }
}

#[derive(Clone)]
pub struct ModuleDescriptor {
    id: ModuleId,
    provides: &'static [CapabilityKey],
    requires: &'static [CapabilityKey],
    effects: &'static [EffectKind],
    routes: &'static [&'static str],
    events: &'static [&'static str],
    loopback: Option<loopback::ModuleDescriptor>,
    capabilities: Option<CapabilityDescriptorProvider>,
    private_control: Option<PrivateControlProvider>,
}

impl ModuleDescriptor {
    pub fn new(
        id: ModuleId,
        provides: &'static [CapabilityKey],
        requires: &'static [CapabilityKey],
        effects: &'static [EffectKind],
        routes: &'static [&'static str],
        events: &'static [&'static str],
        loopback: Option<loopback::ModuleDescriptor>,
    ) -> Self {
        Self::with_providers(
            id, provides, requires, effects, routes, events, loopback, None, None,
        )
    }

    pub fn with_capabilities(
        id: ModuleId,
        provides: &'static [CapabilityKey],
        requires: &'static [CapabilityKey],
        effects: &'static [EffectKind],
        routes: &'static [&'static str],
        events: &'static [&'static str],
        loopback: Option<loopback::ModuleDescriptor>,
        capabilities: Option<CapabilityDescriptorProvider>,
    ) -> Self {
        Self::with_providers(
            id,
            provides,
            requires,
            effects,
            routes,
            events,
            loopback,
            capabilities,
            None,
        )
    }

    pub fn with_private_control(
        id: ModuleId,
        provides: &'static [CapabilityKey],
        requires: &'static [CapabilityKey],
        effects: &'static [EffectKind],
        routes: &'static [&'static str],
        events: &'static [&'static str],
        loopback: Option<loopback::ModuleDescriptor>,
        private_control: Option<PrivateControlProvider>,
    ) -> Self {
        Self::with_providers(
            id,
            provides,
            requires,
            effects,
            routes,
            events,
            loopback,
            None,
            private_control,
        )
    }

    fn with_providers(
        id: ModuleId,
        provides: &'static [CapabilityKey],
        requires: &'static [CapabilityKey],
        effects: &'static [EffectKind],
        routes: &'static [&'static str],
        events: &'static [&'static str],
        loopback: Option<loopback::ModuleDescriptor>,
        capabilities: Option<CapabilityDescriptorProvider>,
        private_control: Option<PrivateControlProvider>,
    ) -> Self {
        debug_assert!(!id.as_str().is_empty());
        debug_assert!(
            provides
                .iter()
                .all(|capability| !capability.as_str().is_empty())
        );
        debug_assert!(
            requires
                .iter()
                .all(|capability| !capability.as_str().is_empty())
        );
        debug_assert!(routes.iter().all(|route| !route.is_empty()));
        debug_assert!(events.iter().all(|event| !event.is_empty()));
        if let Some(loopback) = loopback.as_ref() {
            debug_assert_eq!(id.as_str(), loopback.id().as_str());
        }
        Self {
            id,
            provides,
            requires,
            effects,
            routes,
            events,
            loopback,
            capabilities,
            private_control,
        }
    }

    pub const fn id(&self) -> ModuleId {
        self.id
    }

    pub const fn provides(&self) -> &'static [CapabilityKey] {
        self.provides
    }

    pub const fn requires(&self) -> &'static [CapabilityKey] {
        self.requires
    }

    pub const fn effects(&self) -> &'static [EffectKind] {
        self.effects
    }

    pub const fn routes(&self) -> &'static [&'static str] {
        self.routes
    }

    pub const fn events(&self) -> &'static [&'static str] {
        self.events
    }

    pub fn loopback(&self) -> Option<&loopback::ModuleDescriptor> {
        self.loopback.as_ref()
    }

    pub const fn capabilities(&self) -> Option<CapabilityDescriptorProvider> {
        self.capabilities
    }

    pub const fn private_control(&self) -> Option<PrivateControlProvider> {
        self.private_control
    }

    pub fn into_loopback(self) -> Option<loopback::ModuleDescriptor> {
        self.loopback
    }
}

#[derive(Clone)]
pub struct ModuleCatalog {
    modules: Vec<ModuleDescriptor>,
}

impl ModuleCatalog {
    pub fn install_with_capabilities_and_effects(
        modules: Vec<ModuleDescriptor>,
        capabilities: &[CapabilityKey],
        effects: &[EffectRegistration],
    ) -> Result<Self, ModuleInstallError> {
        let catalog = Self::install_dependencies(modules, capabilities)?;
        catalog.validate_effects(effects)?;
        Ok(catalog)
    }

    fn install_dependencies(
        modules: Vec<ModuleDescriptor>,
        capabilities: &[CapabilityKey],
    ) -> Result<Self, ModuleDependencyError> {
        let mut host_capabilities = BTreeSet::new();
        for capability in capabilities.iter().copied() {
            if capability.as_str().is_empty() {
                return Err(ModuleDependencyError::EmptyHostCapability);
            }
            if !host_capabilities.insert(capability) {
                return Err(ModuleDependencyError::DuplicateHostCapability { capability });
            }
        }

        let mut module_indexes = BTreeMap::new();
        let mut private_control_commands = BTreeMap::new();
        for (index, module) in modules.iter().enumerate() {
            if module.id().as_str().is_empty() {
                return Err(ModuleDependencyError::EmptyModuleId);
            }
            if module_indexes.insert(module.id(), index).is_some() {
                return Err(ModuleDependencyError::DuplicateModule {
                    module: module.id(),
                });
            }
            if let Some(provider) = module.private_control() {
                let mut provided_by_module = BTreeSet::new();
                for descriptor in provider.descriptors().iter().copied() {
                    if descriptor.name().is_empty() {
                        return Err(ModuleDependencyError::EmptyPrivateControlCommand {
                            module: module.id(),
                        });
                    }
                    if !provided_by_module.insert(descriptor.name()) {
                        return Err(ModuleDependencyError::DuplicatePrivateControlCommand {
                            module: module.id(),
                            command: descriptor.name(),
                        });
                    }
                    if let Some(first) =
                        private_control_commands.insert(descriptor.name(), module.id())
                    {
                        return Err(ModuleDependencyError::DuplicatePrivateControlProvider {
                            command: descriptor.name(),
                            first,
                            second: module.id(),
                        });
                    }
                }
            }
        }

        let mut providers = BTreeMap::new();
        for module in &modules {
            let mut provided_by_module = BTreeSet::new();
            for capability in module.provides().iter().copied() {
                if capability.as_str().is_empty() {
                    return Err(ModuleDependencyError::EmptyCapability {
                        module: module.id(),
                    });
                }
                if !provided_by_module.insert(capability) {
                    return Err(ModuleDependencyError::DuplicateProvidedCapability {
                        module: module.id(),
                        capability,
                    });
                }
                if host_capabilities.contains(&capability) {
                    return Err(ModuleDependencyError::HostCapabilityConflict {
                        module: module.id(),
                        capability,
                    });
                }
                if let Some(first) = providers.insert(capability, module.id()) {
                    return Err(ModuleDependencyError::DuplicateProvider {
                        capability,
                        providers: vec![first, module.id()],
                    });
                }
            }
        }

        let mut edges = vec![Vec::new(); modules.len()];
        for (module_index, module) in modules.iter().enumerate() {
            let mut required_by_module = BTreeSet::new();
            for requires in module.requires().iter().copied() {
                if requires.as_str().is_empty() {
                    return Err(ModuleDependencyError::EmptyCapability {
                        module: module.id(),
                    });
                }
                if !required_by_module.insert(requires) {
                    return Err(ModuleDependencyError::DuplicateRequiredCapability {
                        module: module.id(),
                        capability: requires,
                    });
                }
                if host_capabilities.contains(&requires) {
                    continue;
                }
                let Some(provider) = providers.get(&requires).copied() else {
                    return Err(ModuleDependencyError::MissingRequiredCapability {
                        module: module.id(),
                        requires,
                    });
                };
                let provider_index = module_indexes[&provider];
                if provider_index == module_index {
                    return Err(ModuleDependencyError::SelfDependency {
                        module: module.id(),
                        capability: requires,
                    });
                }
                edges[module_index].push(provider_index);
            }
        }

        detect_dependency_cycle(&modules, &edges)?;
        for (module_index, dependencies) in edges.iter().enumerate() {
            for provider_index in dependencies.iter().copied() {
                if provider_index > module_index {
                    return Err(ModuleDependencyError::OutOfOrderDependency {
                        module: modules[module_index].id(),
                        depends_on: modules[provider_index].id(),
                    });
                }
            }
        }
        Ok(Self { modules })
    }

    pub fn modules(&self) -> &[ModuleDescriptor] {
        &self.modules
    }

    pub fn capability_snapshot(&self) -> CapabilityCatalogSnapshot {
        CapabilityCatalogSnapshot::new(
            self.modules
                .iter()
                .filter_map(ModuleDescriptor::capabilities)
                .collect(),
        )
    }

    pub fn private_control_snapshot(&self) -> PrivateControlCatalogSnapshot {
        PrivateControlCatalogSnapshot::new(
            self.modules
                .iter()
                .filter_map(|module| {
                    module
                        .private_control()
                        .map(|provider| (module.id(), provider))
                })
                .collect(),
        )
    }

    pub fn into_modules(self) -> Vec<ModuleDescriptor> {
        self.modules
    }

    pub fn into_loopback_modules(self) -> Vec<loopback::ModuleDescriptor> {
        self.modules
            .into_iter()
            .filter_map(ModuleDescriptor::into_loopback)
            .collect()
    }

    pub fn validate_effects(
        &self,
        effects: &[EffectRegistration],
    ) -> Result<(), ModuleEffectError> {
        let modules = self
            .modules
            .iter()
            .map(|module| (module.id(), module))
            .collect::<BTreeMap<_, _>>();
        let mut scoped = BTreeSet::new();
        let mut route_owners = BTreeMap::new();

        for module in &self.modules {
            validate_module_effect_contract(module, &mut route_owners)?;
            if let Some(loopback) = module.loopback() {
                for route in loopback.routes() {
                    scoped.insert((module.id(), EffectKind::Route, route.id()));
                }
            }
        }

        for registration in effects {
            if registration.effect_id().is_empty() {
                return Err(ModuleEffectError::EmptyEffectId {
                    module: registration.module(),
                    effect: registration.effect(),
                });
            }
            let Some(module) = modules.get(&registration.module()) else {
                return Err(ModuleEffectError::UnknownModule {
                    module: registration.module(),
                    effect: registration.effect(),
                });
            };
            if !module.effects().contains(&registration.effect()) {
                return Err(ModuleEffectError::UndeclaredEffect {
                    module: registration.module(),
                    effect: registration.effect(),
                });
            }
            if !registration.effect().is_scoped() {
                return Err(ModuleEffectError::UnscopedEffectRegistration {
                    module: registration.module(),
                    effect: registration.effect(),
                    effect_id: registration.effect_id(),
                });
            }
            if !declared_effect_ids(module, registration.effect())
                .contains(&registration.effect_id())
            {
                return Err(ModuleEffectError::UndeclaredEffectId {
                    module: registration.module(),
                    effect: registration.effect(),
                    effect_id: registration.effect_id(),
                });
            }
            if !scoped.insert((
                registration.module(),
                registration.effect(),
                registration.effect_id(),
            )) {
                return Err(ModuleEffectError::DuplicateEffectRegistration {
                    module: registration.module(),
                    effect: registration.effect(),
                    effect_id: registration.effect_id(),
                });
            }
        }

        for module in &self.modules {
            for effect in module
                .effects()
                .iter()
                .copied()
                .filter(|effect| effect.is_scoped())
            {
                for effect_id in declared_effect_ids(module, effect) {
                    if !scoped.contains(&(module.id(), effect, effect_id)) {
                        return Err(ModuleEffectError::MissingScopedEffect {
                            module: module.id(),
                            effect,
                            effect_id,
                        });
                    }
                }
            }
        }
        Ok(())
    }
}

fn validate_module_effect_contract(
    module: &ModuleDescriptor,
    route_owners: &mut BTreeMap<&'static str, ModuleId>,
) -> Result<(), ModuleEffectError> {
    let mut effects = BTreeSet::new();
    for effect in module.effects().iter().copied() {
        if !effects.insert(effect) {
            return Err(ModuleEffectError::DuplicateEffect {
                module: module.id(),
                effect,
            });
        }
    }

    let declares_routes = module.effects().contains(&EffectKind::Route);
    if declares_routes != !module.routes().is_empty()
        || module.loopback().is_some() != declares_routes
    {
        return Err(ModuleEffectError::RouteEffectMismatch {
            module: module.id(),
        });
    }

    let mut declared_routes = BTreeSet::new();
    for route in module.routes().iter().copied() {
        if route.is_empty() {
            return Err(ModuleEffectError::EmptyRouteId {
                module: module.id(),
            });
        }
        if !declared_routes.insert(route) {
            return Err(ModuleEffectError::DuplicateRoute {
                module: module.id(),
                route,
            });
        }
        if let Some(first) = route_owners.insert(route, module.id()) {
            return Err(ModuleEffectError::DuplicateRouteAcrossModules {
                route,
                first,
                second: module.id(),
            });
        }
    }

    if let Some(loopback) = module.loopback() {
        if loopback.id().as_str() != module.id().as_str() {
            return Err(ModuleEffectError::LoopbackModuleMismatch {
                module: module.id(),
            });
        }
        let loopback_routes = loopback
            .routes()
            .iter()
            .map(|route| route.id())
            .collect::<BTreeSet<_>>();
        if loopback_routes != declared_routes {
            return Err(ModuleEffectError::LoopbackRouteMismatch {
                module: module.id(),
            });
        }
    }

    let declares_events = module.effects().contains(&EffectKind::EventSubscription);
    if declares_events != !module.events().is_empty() {
        return Err(ModuleEffectError::EventEffectMismatch {
            module: module.id(),
        });
    }
    let mut events = BTreeSet::new();
    for event in module.events().iter().copied() {
        if event.is_empty() {
            return Err(ModuleEffectError::EmptyEventId {
                module: module.id(),
            });
        }
        if !events.insert(event) {
            return Err(ModuleEffectError::DuplicateEvent {
                module: module.id(),
                event,
            });
        }
    }

    Ok(())
}

fn declared_effect_ids(module: &ModuleDescriptor, effect: EffectKind) -> Vec<&'static str> {
    match effect {
        EffectKind::OwnerTask => vec![EffectKind::OwnerTask.as_str()],
        EffectKind::Route => module.routes().to_vec(),
        EffectKind::EventSubscription => module.events().to_vec(),
        EffectKind::Process => vec![EffectKind::Process.as_str()],
        EffectKind::Listener => vec![EffectKind::Listener.as_str()],
        EffectKind::RuntimeEndpoint => vec![EffectKind::RuntimeEndpoint.as_str()],
        EffectKind::CallbackServer => vec![EffectKind::CallbackServer.as_str()],
        EffectKind::FilesystemRead | EffectKind::FilesystemWrite | EffectKind::RuntimeOperation => {
            Vec::new()
        }
    }
}

fn detect_dependency_cycle(
    modules: &[ModuleDescriptor],
    edges: &[Vec<usize>],
) -> Result<(), ModuleDependencyError> {
    #[derive(Clone, Copy, Eq, PartialEq)]
    enum Mark {
        Visiting,
        Visited,
    }

    fn visit(
        index: usize,
        modules: &[ModuleDescriptor],
        edges: &[Vec<usize>],
        marks: &mut [Option<Mark>],
        stack: &mut Vec<usize>,
    ) -> Result<(), ModuleDependencyError> {
        match marks[index] {
            Some(Mark::Visited) => return Ok(()),
            Some(Mark::Visiting) => {
                let start = stack.iter().position(|entry| *entry == index).unwrap_or(0);
                return Err(ModuleDependencyError::DependencyCycle {
                    modules: stack[start..]
                        .iter()
                        .copied()
                        .chain(std::iter::once(index))
                        .map(|entry| modules[entry].id())
                        .collect(),
                });
            }
            None => {}
        }

        marks[index] = Some(Mark::Visiting);
        stack.push(index);
        for dependency in edges[index].iter().copied() {
            visit(dependency, modules, edges, marks, stack)?;
        }
        stack.pop();
        marks[index] = Some(Mark::Visited);
        Ok(())
    }

    let mut marks = vec![None; modules.len()];
    let mut stack = Vec::new();
    for index in 0..modules.len() {
        visit(index, modules, edges, &mut marks, &mut stack)?;
    }
    Ok(())
}
