use std::time::Duration;

use platform::{
    loopback::{self, BodyPolicy, RouteDescriptor, RouteHeadPlan},
    module::{
        CapabilityKey, EffectKind, EffectRegistration, ModuleCatalog, ModuleDependencyError,
        ModuleDescriptor, ModuleEffectError, ModuleId, ModuleInstallError,
        PrivateControlDescriptor, PrivateControlProvider,
    },
};

const CHANNEL_ACCOUNT: CapabilityKey = CapabilityKey::new("channel.account");
const HOST_SECRET: CapabilityKey = CapabilityKey::new("host.secret");
const OPENCLAW_RUNTIME: CapabilityKey = CapabilityKey::new("openclaw.runtime");
const SESSION_STORE: CapabilityKey = CapabilityKey::new("session.store");
const WORKSPACE_STORE: CapabilityKey = CapabilityKey::new("workspace.store");
const HOST_PRIVATE_CONTROL_COMMANDS: &[PrivateControlDescriptor] = &[
    PrivateControlDescriptor::new("host.health", false),
    PrivateControlDescriptor::new("host.runtime.snapshot", false),
];
const EMPTY_PRIVATE_CONTROL_COMMANDS: &[PrivateControlDescriptor] =
    &[PrivateControlDescriptor::new("", false)];
const DUPLICATE_PRIVATE_CONTROL_COMMANDS: &[PrivateControlDescriptor] = &[
    PrivateControlDescriptor::new("host.health", false),
    PrivateControlDescriptor::new("host.health", false),
];
const HOST_HEALTH_PRIVATE_CONTROL_COMMAND: &[PrivateControlDescriptor] =
    &[PrivateControlDescriptor::new("host.health", false)];

fn descriptor(
    id: &'static str,
    provides: &'static [CapabilityKey],
    requires: &'static [CapabilityKey],
    effects: &'static [EffectKind],
) -> ModuleDescriptor {
    ModuleDescriptor::new(
        ModuleId::new(id),
        provides,
        requires,
        effects,
        &[],
        &[],
        None,
    )
}

fn routed_descriptor(
    id: &'static str,
    provides: &'static [CapabilityKey],
    routes: &'static [&'static str],
    loopback_routes: Vec<RouteDescriptor>,
) -> ModuleDescriptor {
    ModuleDescriptor::new(
        ModuleId::new(id),
        provides,
        &[],
        &[EffectKind::Route],
        routes,
        &[],
        Some(loopback::ModuleDescriptor::new(
            loopback::ModuleId::new(id),
            loopback_routes,
        )),
    )
}

fn event_descriptor(
    id: &'static str,
    provides: &'static [CapabilityKey],
    events: &'static [&'static str],
) -> ModuleDescriptor {
    ModuleDescriptor::new(
        ModuleId::new(id),
        provides,
        &[],
        &[EffectKind::EventSubscription],
        &[],
        events,
        None,
    )
}

fn route(id: &'static str) -> RouteDescriptor {
    RouteDescriptor::bound(
        id,
        |_| {
            Some(RouteHeadPlan::new(
                BodyPolicy::Empty,
                Duration::from_secs(1),
                loopback::Response::bad_request,
            ))
        },
        |_| Box::pin(async { loopback::Response::bad_request().into() }),
    )
}

fn install_error(
    modules: Vec<ModuleDescriptor>,
    capabilities: &[CapabilityKey],
    effects: &[EffectRegistration],
) -> ModuleInstallError {
    match ModuleCatalog::install_with_capabilities_and_effects(modules, capabilities, effects) {
        Ok(_) => panic!("expected module catalog installation to fail"),
        Err(error) => error,
    }
}

fn dependency_error(
    modules: Vec<ModuleDescriptor>,
    capabilities: &[CapabilityKey],
    effects: &[EffectRegistration],
) -> ModuleDependencyError {
    match install_error(modules, capabilities, effects) {
        ModuleInstallError::Dependency(error) => error,
        error => panic!("expected dependency error, got {error:?}"),
    }
}

fn effect_error(
    modules: Vec<ModuleDescriptor>,
    capabilities: &[CapabilityKey],
    effects: &[EffectRegistration],
) -> ModuleEffectError {
    match install_error(modules, capabilities, effects) {
        ModuleInstallError::Effect(error) => error,
        error => panic!("expected effect error, got {error:?}"),
    }
}

#[test]
fn rejects_missing_required_capability() {
    let error = dependency_error(
        vec![descriptor(
            "channels",
            &[CHANNEL_ACCOUNT],
            &[HOST_SECRET],
            &[],
        )],
        &[],
        &[],
    );

    assert_eq!(
        error,
        ModuleDependencyError::MissingRequiredCapability {
            module: ModuleId::new("channels"),
            requires: HOST_SECRET,
        }
    );
}

#[test]
fn rejects_unknown_effect_registration_module() {
    let error = effect_error(
        vec![descriptor("channels", &[CHANNEL_ACCOUNT], &[], &[])],
        &[],
        &[EffectRegistration::new(
            ModuleId::new("ghost"),
            EffectKind::Route,
            "ghost.route",
        )],
    );

    assert_eq!(
        error,
        ModuleEffectError::UnknownModule {
            module: ModuleId::new("ghost"),
            effect: EffectKind::Route,
        }
    );
}

#[test]
fn rejects_undeclared_effect_registration() {
    let error = effect_error(
        vec![descriptor("channels", &[CHANNEL_ACCOUNT], &[], &[])],
        &[],
        &[EffectRegistration::new(
            ModuleId::new("channels"),
            EffectKind::Route,
            "channels.route",
        )],
    );

    assert_eq!(
        error,
        ModuleEffectError::UndeclaredEffect {
            module: ModuleId::new("channels"),
            effect: EffectKind::Route,
        }
    );
}

#[test]
fn rejects_missing_scoped_effect_registration() {
    let error = effect_error(
        vec![descriptor(
            "channels",
            &[CHANNEL_ACCOUNT],
            &[],
            &[EffectKind::OwnerTask],
        )],
        &[],
        &[],
    );

    assert_eq!(
        error,
        ModuleEffectError::MissingScopedEffect {
            module: ModuleId::new("channels"),
            effect: EffectKind::OwnerTask,
            effect_id: "owner-task",
        }
    );
}

#[test]
fn rejects_undeclared_route_effect_id() {
    let error = effect_error(
        vec![routed_descriptor(
            "channels",
            &[CHANNEL_ACCOUNT],
            &["channels.loopback"],
            vec![route("channels.loopback")],
        )],
        &[],
        &[EffectRegistration::new(
            ModuleId::new("channels"),
            EffectKind::Route,
            "channels.ghost",
        )],
    );

    assert_eq!(
        error,
        ModuleEffectError::UndeclaredEffectId {
            module: ModuleId::new("channels"),
            effect: EffectKind::Route,
            effect_id: "channels.ghost",
        }
    );
}

#[test]
fn rejects_installed_loopback_route_without_scoped_registration() {
    let error = effect_error(
        vec![routed_descriptor(
            "channels",
            &[CHANNEL_ACCOUNT],
            &["channels.loopback"],
            vec![route("channels.loopback")],
        )],
        &[],
        &[],
    );

    assert_eq!(
        error,
        ModuleEffectError::MissingScopedEffect {
            module: ModuleId::new("channels"),
            effect: EffectKind::Route,
            effect_id: "channels.loopback",
        }
    );
}

#[test]
fn rejects_loopback_route_mismatch() {
    let error = effect_error(
        vec![routed_descriptor(
            "channels",
            &[CHANNEL_ACCOUNT],
            &["channels.loopback"],
            vec![route("channels.other")],
        )],
        &[],
        &[],
    );

    assert_eq!(
        error,
        ModuleEffectError::LoopbackRouteMismatch {
            module: ModuleId::new("channels"),
        }
    );
}

#[test]
fn rejects_missing_event_subscription_registration() {
    let error = effect_error(
        vec![event_descriptor(
            "channels",
            &[CHANNEL_ACCOUNT],
            &["channels.changed"],
        )],
        &[],
        &[],
    );

    assert_eq!(
        error,
        ModuleEffectError::MissingScopedEffect {
            module: ModuleId::new("channels"),
            effect: EffectKind::EventSubscription,
            effect_id: "channels.changed",
        }
    );
}

#[test]
fn rejects_undeclared_event_subscription_effect_id() {
    let error = effect_error(
        vec![event_descriptor(
            "channels",
            &[CHANNEL_ACCOUNT],
            &["channels.changed"],
        )],
        &[],
        &[EffectRegistration::new(
            ModuleId::new("channels"),
            EffectKind::EventSubscription,
            "channels.other",
        )],
    );

    assert_eq!(
        error,
        ModuleEffectError::UndeclaredEffectId {
            module: ModuleId::new("channels"),
            effect: EffectKind::EventSubscription,
            effect_id: "channels.other",
        }
    );
}

#[test]
fn rejects_missing_runtime_endpoint_registration() {
    let error = effect_error(
        vec![descriptor(
            "runtime-directory",
            &[OPENCLAW_RUNTIME],
            &[],
            &[EffectKind::RuntimeEndpoint],
        )],
        &[],
        &[],
    );

    assert_eq!(
        error,
        ModuleEffectError::MissingScopedEffect {
            module: ModuleId::new("runtime-directory"),
            effect: EffectKind::RuntimeEndpoint,
            effect_id: "runtime-endpoint",
        }
    );
}

#[test]
fn rejects_route_effect_without_declared_routes() {
    let error = effect_error(
        vec![descriptor(
            "channels",
            &[CHANNEL_ACCOUNT],
            &[],
            &[EffectKind::Route],
        )],
        &[],
        &[],
    );

    assert_eq!(
        error,
        ModuleEffectError::RouteEffectMismatch {
            module: ModuleId::new("channels"),
        }
    );
}

#[test]
fn rejects_event_declaration_without_event_effect() {
    let error = effect_error(
        vec![ModuleDescriptor::new(
            ModuleId::new("channels"),
            &[CHANNEL_ACCOUNT],
            &[],
            &[],
            &[],
            &["channels.changed"],
            None,
        )],
        &[],
        &[],
    );

    assert_eq!(
        error,
        ModuleEffectError::EventEffectMismatch {
            module: ModuleId::new("channels"),
        }
    );
}

#[test]
fn rejects_duplicate_route_across_modules() {
    let error = effect_error(
        vec![
            routed_descriptor(
                "channels",
                &[CHANNEL_ACCOUNT],
                &["shared.loopback"],
                vec![route("shared.loopback")],
            ),
            routed_descriptor(
                "sessions",
                &[SESSION_STORE],
                &["shared.loopback"],
                vec![route("shared.loopback")],
            ),
        ],
        &[],
        &[],
    );

    assert_eq!(
        error,
        ModuleEffectError::DuplicateRouteAcrossModules {
            route: "shared.loopback",
            first: ModuleId::new("channels"),
            second: ModuleId::new("sessions"),
        }
    );
}

#[test]
fn accepts_declared_route_and_event_registrations() {
    let catalog = ModuleCatalog::install_with_capabilities_and_effects(
        vec![
            routed_descriptor(
                "channels",
                &[CHANNEL_ACCOUNT],
                &["channels.loopback"],
                vec![route("channels.loopback")],
            ),
            event_descriptor("sessions", &[SESSION_STORE], &["sessions.changed"]),
        ],
        &[],
        &[
            EffectRegistration::new(
                ModuleId::new("channels"),
                EffectKind::Route,
                "channels.loopback",
            ),
            EffectRegistration::new(
                ModuleId::new("sessions"),
                EffectKind::EventSubscription,
                "sessions.changed",
            ),
        ],
    )
    .expect("catalog installs with declared route and event effects");

    assert_eq!(catalog.modules().len(), 2);
}

#[test]
fn private_control_snapshot_finds_installed_command() {
    let catalog = ModuleCatalog::install_with_capabilities_and_effects(
        vec![ModuleDescriptor::with_private_control(
            ModuleId::new("host-system-control"),
            &[],
            &[],
            &[],
            &[],
            &[],
            None,
            Some(PrivateControlProvider::new(HOST_PRIVATE_CONTROL_COMMANDS)),
        )],
        &[],
        &[],
    )
    .expect("catalog installs private-control provider");

    let snapshot = catalog.private_control_snapshot();
    assert_eq!(
        snapshot
            .find("host.health")
            .map(|descriptor| (descriptor.name(), descriptor.accepts_input())),
        Some(("host.health", false))
    );
    assert!(snapshot.find("openclaw.environment.status").is_none());
}

#[test]
fn rejects_empty_private_control_command() {
    let error = dependency_error(
        vec![ModuleDescriptor::with_private_control(
            ModuleId::new("host-system-control"),
            &[],
            &[],
            &[],
            &[],
            &[],
            None,
            Some(PrivateControlProvider::new(EMPTY_PRIVATE_CONTROL_COMMANDS)),
        )],
        &[],
        &[],
    );

    assert_eq!(
        error,
        ModuleDependencyError::EmptyPrivateControlCommand {
            module: ModuleId::new("host-system-control"),
        }
    );
}

#[test]
fn rejects_duplicate_private_control_command_in_module() {
    let error = dependency_error(
        vec![ModuleDescriptor::with_private_control(
            ModuleId::new("host-system-control"),
            &[],
            &[],
            &[],
            &[],
            &[],
            None,
            Some(PrivateControlProvider::new(
                DUPLICATE_PRIVATE_CONTROL_COMMANDS,
            )),
        )],
        &[],
        &[],
    );

    assert_eq!(
        error,
        ModuleDependencyError::DuplicatePrivateControlCommand {
            module: ModuleId::new("host-system-control"),
            command: "host.health",
        }
    );
}

#[test]
fn rejects_duplicate_private_control_provider_across_modules() {
    let error = dependency_error(
        vec![
            ModuleDescriptor::with_private_control(
                ModuleId::new("host-system-control"),
                &[],
                &[],
                &[],
                &[],
                &[],
                None,
                Some(PrivateControlProvider::new(
                    HOST_HEALTH_PRIVATE_CONTROL_COMMAND,
                )),
            ),
            ModuleDescriptor::with_private_control(
                ModuleId::new("other-system-control"),
                &[],
                &[],
                &[],
                &[],
                &[],
                None,
                Some(PrivateControlProvider::new(
                    HOST_HEALTH_PRIVATE_CONTROL_COMMAND,
                )),
            ),
        ],
        &[],
        &[],
    );

    assert_eq!(
        error,
        ModuleDependencyError::DuplicatePrivateControlProvider {
            command: "host.health",
            first: ModuleId::new("host-system-control"),
            second: ModuleId::new("other-system-control"),
        }
    );
}

#[test]
fn rejects_dependency_cycle() {
    let error = dependency_error(
        vec![
            descriptor("sessions", &[SESSION_STORE], &[WORKSPACE_STORE], &[]),
            descriptor("workspace", &[WORKSPACE_STORE], &[SESSION_STORE], &[]),
        ],
        &[],
        &[],
    );

    match error {
        ModuleDependencyError::DependencyCycle { modules } => {
            assert!(modules.contains(&ModuleId::new("sessions")));
            assert!(modules.contains(&ModuleId::new("workspace")));
        }
        error => panic!("expected dependency cycle, got {error:?}"),
    }
}

#[test]
fn rejects_duplicate_provider() {
    let error = dependency_error(
        vec![
            descriptor("openclaw", &[OPENCLAW_RUNTIME], &[], &[]),
            descriptor("runtime-directory", &[OPENCLAW_RUNTIME], &[], &[]),
        ],
        &[],
        &[],
    );

    match error {
        ModuleDependencyError::DuplicateProvider {
            capability,
            providers,
        } => {
            assert_eq!(capability, OPENCLAW_RUNTIME);
            assert_eq!(providers.len(), 2);
            assert!(providers.contains(&ModuleId::new("openclaw")));
            assert!(providers.contains(&ModuleId::new("runtime-directory")));
        }
        error => panic!("expected duplicate provider, got {error:?}"),
    }
}

#[test]
fn rejects_self_dependency() {
    let error = dependency_error(
        vec![descriptor(
            "sessions",
            &[SESSION_STORE],
            &[SESSION_STORE],
            &[],
        )],
        &[],
        &[],
    );

    assert_eq!(
        error,
        ModuleDependencyError::SelfDependency {
            module: ModuleId::new("sessions"),
            capability: SESSION_STORE,
        }
    );
}
