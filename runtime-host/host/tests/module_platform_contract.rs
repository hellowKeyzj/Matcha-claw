use std::{fs, path::Path};

const HOST_SRC: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src");
const HOST_HTTP_ROUTER: &str = include_str!("../src/http/router.rs");
const APP_SERVICE: &str = concat!(
    include_str!("../src/app/mod.rs"),
    include_str!("../src/app/runtime.rs"),
    include_str!("../src/app/service.rs"),
    include_str!("../src/app/shutdown.rs"),
);
const MODULE_REGISTRY_INSTALL: &str = include_str!("../src/module_registry/install.rs");
const MODULE_REGISTRY_EFFECTS: &str = include_str!("../src/module_registry/effects.rs");
const MODULE_REGISTRY_RUNTIME_MODULES: &str =
    include_str!("../src/module_registry/runtime_modules.rs");
const HOST_OWNER_RUNTIME: &str = include_str!("../src/composition/host/owners/runtime.rs");
const HOST_RUNTIME_PORTS: &str = include_str!("../src/composition/runtime_ports.rs");
const HOST_SHUTDOWN: &str = include_str!("../src/composition/host/shutdown.rs");
const HOST_DIAGNOSTICS: &str = include_str!("../src/composition/host/diagnostics.rs");
const HOST_HTTP_SERVER: &str = include_str!("../src/http/server.rs");
const FOUNDATION_LIFECYCLE: &str = include_str!("../../foundation/src/lifecycle.rs");
const PLATFORM_MODULE: &str = include_str!("../../platform/src/module.rs");
const DIAGNOSTICS_MODULE: &str = include_str!("../../modules/diagnostics/src/lib.rs");
const RUNTIME_DIRECTORY_MODULE: &str = include_str!("../../modules/runtime-directory/src/lib.rs");
const PLATFORM_LOOPBACK: &str = include_str!("../../platform/src/loopback.rs");
const CHANNEL_MODULE: &str = include_str!("../../modules/channels/src/lib.rs");
const CHANNEL_LOOPBACK: &str = include_str!("../../modules/channels/src/adapters/loopback/mod.rs");
const ORGANIZATION_MODULE: &str = include_str!("../../modules/organization/src/lib.rs");
const OPENCLAW_PLATFORM_LOOPBACK: &str =
    include_str!("../../integrations/openclaw/src/platform_runtime/loopback.rs");
const HOST_ADMISSION: &str = include_str!("../src/composition/admission.rs");
const OPENCLAW_TOOL_PERMISSION: &str =
    include_str!("../../integrations/openclaw/src/tool_permission.rs");
const OPENCLAW_PROVIDER_OPS: &str =
    include_str!("../../integrations/openclaw/src/driver/ops/provider_config.rs");
const OPENCLAW_CHANNEL_OPS: &str =
    include_str!("../../integrations/openclaw/src/driver/ops/channel.rs");
const OPENCLAW_CONNECTOR_OPS: &str =
    include_str!("../../integrations/openclaw/src/driver/ops/connector.rs");
const OPENCLAW_SETTINGS_OPS: &str =
    include_str!("../../integrations/openclaw/src/driver/ops/settings.rs");

fn without_whitespace(source: &str) -> String {
    source
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect()
}

fn production_rust_sources(root: impl AsRef<Path>) -> Vec<String> {
    let root = root.as_ref();
    if !root.exists() {
        return Vec::new();
    }
    let mut sources = Vec::new();
    collect_production_rust_sources(root, &mut sources);
    sources
}

fn collect_production_rust_sources(path: &Path, sources: &mut Vec<String>) {
    for entry in fs::read_dir(path).expect("read source directory") {
        let path = entry.expect("read source entry").path();
        if path.is_dir() {
            collect_production_rust_sources(&path, sources);
        } else if path.extension().and_then(|extension| extension.to_str()) == Some("rs") {
            let source_path = path.to_string_lossy().replace('\\', "/");
            if !source_path.ends_with("_tests.rs") && !source_path.contains("/tests/") {
                sources.push(source_path);
            }
        }
    }
}

#[test]
fn host_facade_and_capability_directory_modules_are_removed() {
    let host_src = Path::new(HOST_SRC);

    assert!(
        !host_src.join("facade").exists(),
        "Host must not keep host/src/facade; typed entries must live with concrete owners/modules"
    );
    assert!(
        !host_src.join("capabilities").exists(),
        "Host must not keep host/src/capabilities; capability catalog must come from installed ModuleCatalog descriptors"
    );
}

#[test]
fn host_final_form_keeps_app_http_not_delivery_or_transport_production_dirs() {
    let host_src = Path::new(HOST_SRC);
    let delivery_sources = production_rust_sources(host_src.join("delivery"));
    let transport_sources = production_rust_sources(host_src.join("transport"));

    assert!(
        delivery_sources.is_empty(),
        "Host app final-form must not keep host/src/delivery production Rust files; use host/src/app:\n{}",
        delivery_sources.join("\n")
    );
    assert!(
        transport_sources.is_empty(),
        "Host HTTP final-form must not keep top-level host/src/transport production Rust files; use host/src/http and installed module routes:\n{}",
        transport_sources.join("\n")
    );
    assert!(
        !host_src.join("transport").exists(),
        "Host final-form must not keep top-level host/src/transport; app/http are the active paths"
    );
}

#[test]
fn openclaw_platform_loopback_owns_product_routes_without_host_platform_ops() {
    for residue in [
        "trait RuntimePlatformOps",
        "fn platform_ops(&self)",
        "RuntimePlatformFailure",
        "RuntimeSubagentTemplateFailure",
    ] {
        assert!(
            !HOST_RUNTIME_PORTS.contains(residue),
            "Host runtime ports must not keep OpenClaw platform product adapter residue {residue}"
        );
    }
    assert!(
        OPENCLAW_PLATFORM_LOOPBACK.contains("OpenClawPlatformAdmissionPort")
            && OPENCLAW_PLATFORM_LOOPBACK.contains("openclaw-platform.loopback")
            && OPENCLAW_PLATFORM_LOOPBACK.contains("/api/openclaw/status")
            && OPENCLAW_PLATFORM_LOOPBACK.contains("/api/openclaw/runtime/paths")
            && OPENCLAW_PLATFORM_LOOPBACK.contains("/api/openclaw/cli-command")
            && OPENCLAW_PLATFORM_LOOPBACK.contains("/api/openclaw/tool-permission-mode")
            && OPENCLAW_PLATFORM_LOOPBACK.contains("/api/openclaw/subagent-templates")
            && OPENCLAW_PLATFORM_LOOPBACK.contains("/api/openclaw/subagent-template/detail")
            && OPENCLAW_PLATFORM_LOOPBACK.contains("project_runtime_paths")
            && OPENCLAW_PLATFORM_LOOPBACK.contains("decode_set_mode_request")
            && OPENCLAW_PLATFORM_LOOPBACK.contains("subagent_template_detail_response")
            && OPENCLAW_PLATFORM_LOOPBACK.contains("driver.set_tool_permission_mode"),
        "OpenClaw platform loopback must own platform route auth, decode, projection, and driver dispatch"
    );
    assert!(
        MODULE_REGISTRY_RUNTIME_MODULES
            .contains("openclaw::platform_runtime::loopback::descriptor")
            && MODULE_REGISTRY_RUNTIME_MODULES.contains("OpenClawPlatformAdmissionPort")
            && MODULE_REGISTRY_RUNTIME_MODULES.contains("Arc::clone(&handles.open_claw)")
            && MODULE_REGISTRY_RUNTIME_MODULES.contains("openclaw_platform_admission"),
        "module_registry/runtime_modules should only install OpenClaw platform loopback and wire driver/admission ports"
    );
    assert!(
        HOST_ADMISSION.contains(
            "impl openclaw::platform_runtime::loopback::OpenClawPlatformAdmissionPort for HostAdmission",
        ) && HOST_ADMISSION.contains("self.admit_request().is_ok()"),
        "Host admission should preserve request admission semantics without owning OpenClaw platform DTOs"
    );
    assert!(
        OPENCLAW_TOOL_PERMISSION.contains("From<projection::tool_permission::Mode>")
            && OPENCLAW_TOOL_PERMISSION
                .contains("From<Mode> for projection::tool_permission::Mode")
            && OPENCLAW_TOOL_PERMISSION.contains("From<projection::tool_permission::Effect>")
            && OPENCLAW_TOOL_PERMISSION.contains("From<projection::tool_permission::Error>"),
        "openclaw integration must own tool_permission projection/effect/error mapping"
    );
}

#[test]
fn host_openclaw_adapters_do_not_reexport_migrated_channel_or_skill_adapters() {
    assert!(
        !std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/runtime/adapters/openclaw/adapters/channel.rs")
            .exists(),
        "Host OpenClaw adapters/channel.rs must not return after channel adapter migration"
    );
    assert!(
        !std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/runtime/adapters/openclaw/adapters/skill.rs")
            .exists(),
        "Host OpenClaw adapters/skill.rs must not return after skill adapter migration"
    );
    assert!(
        !std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/runtime/adapters/openclaw/adapters/mod.rs")
            .exists(),
        "Host OpenClaw adapters/mod.rs must not export migrated channel or skill adapters"
    );
}

#[test]
fn host_openclaw_provider_and_channel_ops_do_not_redefine_legacy_mapping_helpers() {
    for helper in [
        "provider_native_configuration_effect",
        "provider_native_configuration_outcome",
        "provider_native_configuration_error",
        "provider_model_discovery_effect",
        "provider_model_discovery_outcome",
        "provider_private_projection_effect",
        "provider_private_projection_outcome",
    ] {
        assert!(
            !OPENCLAW_PROVIDER_OPS.contains(helper),
            "Host OpenClaw provider ops must use provider/openclaw projections, not legacy helper {helper}"
        );
    }
    for helper in [
        "map_catalog_effect",
        "map_form_effect",
        "map_login_wait_effect",
        "map_login_start_effect",
        "map_stop_login_effect",
        "map_logout_effect",
        "map_config_read_effect",
        "map_config_mutation_effect",
        "map_delete_config_effect",
    ] {
        assert!(
            !OPENCLAW_CHANNEL_OPS.contains(helper),
            "Host OpenClaw channel ops must use channel projections, not legacy helper {helper}"
        );
    }
}

#[test]
fn host_openclaw_connector_ops_do_not_redefine_integration_mapping_helpers() {
    for helper in [
        "map_projection_effect",
        "map_observation",
        "map_mcp_server_config",
        "map_mcp_server_kind",
        "map_mcp_server_status_list",
        "map_mcp_server_status_entry",
    ] {
        assert!(
            !OPENCLAW_CONNECTOR_OPS.contains(&format!("fn {helper}(")),
            "Host OpenClaw connector ops must call openclaw::connector projections, not redefine legacy helper {helper}"
        );
    }
}

#[test]
fn host_openclaw_settings_ops_do_not_redefine_legacy_projection_helpers() {
    for helper in [
        "browser_mode_projection",
        "apply_settings_file_projection",
        "map_settings_projection_error",
    ] {
        assert!(
            !OPENCLAW_SETTINGS_OPS.contains(&format!("fn {helper}(")),
            "Host OpenClaw settings ops must call openclaw::settings projections, not redefine legacy helper {helper}"
        );
    }

    assert!(
        !HOST_RUNTIME_PORTS.contains("fn project_settings_config_outcome("),
        "Host must not own project_settings_config_outcome after OpenClaw ops moved into the integration"
    );
}

#[test]
fn organization_sessions_run_terminal_event_is_declared_and_registered() {
    let organization_module = without_whitespace(ORGANIZATION_MODULE);
    let module_registry_effects = without_whitespace(MODULE_REGISTRY_EFFECTS);

    assert!(
        organization_module.contains("constEVENTS:&[&str]=&[\"sessions.run-terminal\"]")
            && organization_module.contains("EVENTS,"),
        "organization module descriptor must declare sessions.run-terminal as an owned event"
    );
    assert!(
        HOST_OWNER_RUNTIME.contains("register_event_subscription(\"sessions.run-terminal\""),
        "Host organization scope must register the sessions.run-terminal event-subscription effect"
    );
    assert!(
        module_registry_effects.contains("EffectRegistration::new(")
            && module_registry_effects.contains("EffectKind::EventSubscription")
            && module_registry_effects.contains("registration.effect_id()"),
        "module_registry/effects must project scoped event-subscription registrations, including sessions.run-terminal, into platform effect registrations"
    );
}

#[test]
fn host_router_does_not_keep_literal_response_module_allowlist() {
    assert!(
        !HOST_HTTP_ROUTER.contains("response_module"),
        "Host loopback router must mount normal modules from module_registry/install, not a hard-coded response_module id list"
    );
}

#[test]
fn sessions_events_is_not_a_host_router_owner_special_case() {
    assert!(
        !HOST_HTTP_ROUTER.contains("sessions-events"),
        "sessions-events must be contributed by its module descriptor, not special-cased in the Host router owner"
    );
}

#[test]
fn host_http_router_runs_only_installed_route_descriptors() {
    for residue in [
        "plugins_module::PluginsModule",
        "skills_module::SkillsModule",
        "PeerHandle",
        "HostCompatibilityModule",
        "is_short_deadline_route",
        "is_compatibility_route",
        "handle_compatibility",
        "match (method, route",
        "route_without_query",
    ] {
        assert!(
            !HOST_HTTP_ROUTER.contains(residue),
            "Host HTTP router must not keep business or compatibility branch residue {residue}"
        );
    }
    assert!(
        HOST_HTTP_ROUTER.contains("Vec<platform::loopback::ModuleDescriptor>")
            && HOST_HTTP_ROUTER.contains("RouteRegistry::new(input.routes)")
            && HOST_HTTP_ROUTER.contains("routes.route(request)"),
        "Host HTTP router must execute installed route descriptors from the module registry"
    );
}

#[test]
fn app_service_installs_modules_through_module_registry_install() {
    let app_service = without_whitespace(APP_SERVICE);
    let module_registry_install = without_whitespace(MODULE_REGISTRY_INSTALL);

    assert!(
        !APP_SERVICE.contains("module_bundle"),
        "app service must not keep a module_bundle install shim"
    );
    assert!(
        app_service.contains("install_modules(InstallModulesInput{")
            && app_service.contains("installed_modules.into_parts()")
            && app_service.contains("RouterInput{routes:modules}"),
        "app service must call module_registry install and pass the installed route registry into the router"
    );
    assert!(
        module_registry_install.contains("pub(crate)structInstallModulesInput")
            && module_registry_install.contains("system_module_install_plan(")
            && module_registry_install.contains("runtime_module_install_plan(")
            && module_registry_install.contains("map_scoped_effects(scoped_effects)"),
        "module_registry/install must feed canonical descriptor groups and scoped effect validation"
    );
    assert!(
        !MODULE_REGISTRY_INSTALL.contains("compatibility")
            && !MODULE_REGISTRY_RUNTIME_MODULES.contains("compatibility"),
        "module registry final-form must not install legacy compatibility descriptors"
    );
}

#[test]
fn module_registry_install_is_the_only_host_module_install_entry() {
    let registry_sources = production_rust_sources(Path::new(HOST_SRC).join("module_registry"));
    let mut violations = Vec::new();

    for path in registry_sources {
        let source = fs::read_to_string(&path).expect("read module_registry source");
        let normalized = path.replace('\\', "/");
        if normalized.ends_with("/module_registry/install.rs") {
            continue;
        }
        for residue in [
            "pub(crate) struct InstallModulesInput",
            "pub(crate) fn install_modules(",
            "ModuleCatalog::install_with_capabilities_and_effects(",
            "ModuleCatalog::install_with_capabilities(",
        ] {
            if source.contains(residue) {
                violations.push(format!("{normalized}: {residue}"));
            }
        }
    }

    assert!(
        violations.is_empty(),
        "module_registry/install.rs must remain the only Host module installation entry; helper files may provide descriptors/effects, not install paths:\n{}",
        violations.join("\n")
    );
}

#[test]
fn app_service_does_not_fall_back_to_manual_install_with_capabilities_vec() {
    let app_service = without_whitespace(APP_SERVICE);
    let module_registry_install = without_whitespace(MODULE_REGISTRY_INSTALL);

    assert!(
        !app_service.contains("install_with_capabilities(vec![")
            && !module_registry_install.contains("install_with_capabilities(vec!["),
        "app service must not manually enumerate descriptors in install_with_capabilities(vec![...])"
    );
    assert!(
        !module_registry_install
            .contains("ModuleCatalog::install_with_capabilities(bundle.descriptors"),
        "module_registry/install must not bypass effect ownership validation with install_with_capabilities"
    );
    assert!(
        !PLATFORM_MODULE.contains("pub fn install_with_capabilities(")
            && !PLATFORM_MODULE.contains("pub fn install("),
        "platform must not expose a public ModuleCatalog install path that bypasses effect validation"
    );
}

#[test]
fn platform_effect_kind_keeps_listener_runtime_endpoint_and_scoped_kind() {
    let platform_module = without_whitespace(PLATFORM_MODULE);

    assert!(
        PLATFORM_MODULE.contains("Listener") && PLATFORM_MODULE.contains("RuntimeEndpoint"),
        "platform EffectKind must include listener and runtime endpoint ownership effects"
    );
    assert!(
        PLATFORM_MODULE.contains("\"listener\"")
            && PLATFORM_MODULE.contains("\"runtime-endpoint\""),
        "platform EffectKind must expose stable wire names for listener and runtime endpoint effects"
    );
    assert!(
        platform_module.contains("pubconstfnis_scoped(self)->bool"),
        "platform EffectKind must expose scoped/non-scoped classification"
    );
    assert!(
        platform_module.contains("Self::Listener")
            && platform_module.contains("Self::RuntimeEndpoint"),
        "listener and runtime endpoint effects must be classified as scoped effects"
    );
}

#[test]
fn module_registry_install_collects_owner_scope_effect_registrations() {
    let app_service = without_whitespace(APP_SERVICE);

    assert!(
        MODULE_REGISTRY_EFFECTS.contains("EffectRegistration"),
        "module_registry/effects must provide platform EffectRegistration entries"
    );
    assert!(
        HOST_OWNER_RUNTIME.contains("module_effect_registrations")
            && HOST_OWNER_RUNTIME.contains("effect_registrations()"),
        "Host owner runtime must expose ModuleScope effect registrations"
    );
    assert!(
        app_service.contains("host.module_effect_registrations()")
            && app_service.contains("&runtime.module_effect_registrations"),
        "app service must pass owner scoped registrations into module_registry/install"
    );
    assert!(
        MODULE_REGISTRY_EFFECTS.contains("EffectRegistration::new("),
        "module_registry/effects must project owner scoped effects into platform EffectRegistration"
    );
}

#[test]
fn host_owner_scopes_remain_effect_registration_sources() {
    assert!(
        FOUNDATION_LIFECYCLE.contains("pub struct EffectRegistration")
            && FOUNDATION_LIFECYCLE.contains("effect_registrations(&self)"),
        "foundation ModuleScope must expose its effect registrations"
    );
    assert!(
        HOST_OWNER_RUNTIME.contains("module_scopes: Vec<ModuleScope>")
            && HOST_OWNER_RUNTIME.contains("module_scope(")
            && HOST_OWNER_RUNTIME.contains("register_owned_task"),
        "Host owner scopes must remain concrete ModuleScope registration sources"
    );
    assert!(
        HOST_OWNER_RUNTIME.contains("scope: ModuleScope")
            && HOST_OWNER_RUNTIME.contains("module_scope(\"organization\", organization_task)"),
        "organization owner task must be registered through its ModuleScope"
    );
    assert!(
        !MODULE_REGISTRY_INSTALL.contains("ModuleId::new(\"organization\")")
            && !MODULE_REGISTRY_INSTALL.contains("EffectKind::OwnerTask,\n        \"owner-task\""),
        "module_registry/install must not hand-register organization owner effects outside ModuleScope"
    );
    assert!(
        MODULE_REGISTRY_EFFECTS.contains("ModuleId::new(registration.scope_id())"),
        "module_registry/effects should map effect registrations from ModuleScope metadata"
    );
    assert!(
        !MODULE_REGISTRY_INSTALL.contains("EffectRegistration::new(\n        ModuleId::new(\"")
            && !MODULE_REGISTRY_INSTALL.contains("EffectRegistration::new(ModuleId::new(\""),
        "module_registry/install must not hand-code module effect registrations"
    );
}

#[test]
fn http_listener_is_a_scoped_host_extension() {
    let app_service = without_whitespace(APP_SERVICE);

    assert!(
        HOST_HTTP_SERVER.contains("into_scoped_extension")
            && HOST_HTTP_SERVER.contains("ModuleScope::new")
            && HOST_HTTP_SERVER.contains("register_listener")
            && HOST_HTTP_SERVER.contains("register_owned_task"),
        "HTTP listener and accept task must be owned by a Host transport extension scope"
    );
    assert!(
        app_service.contains("into_scoped_extension()")
            && !app_service.contains("tokio::spawn(http_server.run())"),
        "app service must not run HTTP transport as an unscoped bare task"
    );
}

#[test]
fn channel_descriptor_keeps_singular_module_id_and_plural_capability() {
    assert!(
        CHANNEL_MODULE.contains("ModuleId::new(\"channel\")"),
        "channels module descriptor id is the singular module id: channel"
    );
    assert!(
        CHANNEL_MODULE.contains("CapabilityKey::new(\"channels\")"),
        "channels module provides the plural capability key: channels"
    );
    assert!(
        CHANNEL_LOOPBACK.contains("ModuleId::new(\"channel\")"),
        "channels loopback descriptor must use the same singular module id: channel"
    );
    assert!(
        !CHANNEL_MODULE.contains("ModuleId::new(\"channels\")")
            && !CHANNEL_LOOPBACK.contains("ModuleId::new(\"channels\")"),
        "channels must not drift back to a plural module id"
    );
}

#[test]
fn platform_loopback_route_future_outputs_route_outcome() {
    let platform_loopback = without_whitespace(PLATFORM_LOOPBACK);

    assert!(
        platform_loopback
            .contains("pubtypeRouteFuture=Pin<Box<dynFuture<Output=RouteOutcome>+Send>>"),
        "platform loopback RouteFuture must resolve to RouteOutcome"
    );
}

#[test]
fn platform_descriptor_declares_routes_and_events_explicitly() {
    let platform_module = without_whitespace(PLATFORM_MODULE);

    assert!(
        platform_module.contains("routes:&'static[&'staticstr]")
            && platform_module.contains("events:&'static[&'staticstr]")
            && platform_module.contains("pubconstfnroutes(&self)->&'static[&'staticstr]")
            && platform_module.contains("pubconstfnevents(&self)->&'static[&'staticstr]"),
        "ModuleDescriptor must expose explicit routes/events declarations"
    );
    assert!(
        CHANNEL_MODULE.contains("const ROUTES") && CHANNEL_MODULE.contains("const EVENTS"),
        "modules must declare route and event ownership in their descriptor metadata"
    );
}

#[test]
fn platform_dependency_validation_is_declared_dag_not_set_membership() {
    assert!(
        PLATFORM_MODULE.contains("DuplicateProvider")
            && PLATFORM_MODULE.contains("SelfDependency")
            && PLATFORM_MODULE.contains("DependencyCycle")
            && PLATFORM_MODULE.contains("OutOfOrderDependency"),
        "ModuleCatalog dependency validation must reject ambiguous providers, self dependencies, cycles, and invalid topology"
    );
    assert!(
        !without_whitespace(PLATFORM_MODULE).contains(
            "flat_map(|module|module.provides()).copied().chain(capabilities.iter().copied()).collect::<BTreeSet<_>>()"
        ),
        "ModuleCatalog must not regress to capability set-membership validation"
    );
}

#[test]
fn platform_effect_validation_uses_declared_effect_ids() {
    assert!(
        PLATFORM_MODULE.contains("effect_id()")
            && PLATFORM_MODULE.contains("UndeclaredEffectId")
            && PLATFORM_MODULE.contains("DuplicateEffectRegistration")
            && PLATFORM_MODULE.contains("UnscopedEffectRegistration"),
        "ModuleCatalog effect validation must validate scoped effect ids, not only effect kinds"
    );
    assert!(
        !PLATFORM_MODULE.contains("loopback().is_some() {\n                    scoped.insert((module.id(), EffectKind::Route));"),
        "route scope validation must use concrete route ids, not loopback presence"
    );
}

#[test]
fn runtime_directory_declares_scoped_runtime_endpoint() {
    assert!(
        RUNTIME_DIRECTORY_MODULE.contains("EffectKind::RuntimeEndpoint"),
        "runtime-directory module must declare runtime endpoint ownership"
    );
    assert!(
        HOST_OWNER_RUNTIME.contains("ModuleScope::new(\"runtime-directory\")")
            && HOST_OWNER_RUNTIME.contains("register_runtime_endpoint(\"runtime-endpoint\"")
            && HOST_OWNER_RUNTIME.contains("close_runtime_endpoint()"),
        "Host owner runtime must register runtime-directory runtime endpoint ownership through a real disposer"
    );
    assert!(
        !HOST_OWNER_RUNTIME
            .contains("register_runtime_endpoint(\"runtime-endpoint\", || async {})"),
        "runtime-directory endpoint must not be registered with a no-op disposer"
    );
    assert!(
        HOST_RUNTIME_PORTS.contains("close_runtime_endpoint")
            && HOST_RUNTIME_PORTS.contains("AtomicBool")
            && HOST_RUNTIME_PORTS.contains("return None")
            && HOST_RUNTIME_PORTS.contains("return Vec::new()"),
        "runtime-directory disposer must make endpoint lookups unavailable after shutdown"
    );
}

#[test]
fn runtime_processes_are_declared_and_registered_as_process_scopes() {
    assert!(
        HOST_SHUTDOWN.contains("ModuleId::new(\"openclaw\")")
            && HOST_SHUTDOWN.contains("ModuleId::new(\"matcha-agent\")")
            && HOST_SHUTDOWN.contains("EffectKind::Process"),
        "OpenClaw and Matcha Agent process modules must declare process effects"
    );
    assert!(
        HOST_SHUTDOWN.contains("ModuleScope::new(\"openclaw\")")
            && HOST_SHUTDOWN.contains("ModuleScope::new(\"matcha-agent\")")
            && HOST_SHUTDOWN.contains("register_process(\"process\""),
        "OpenClaw and Matcha Agent processes must be registered through ModuleScope process disposers"
    );
    assert!(
        MODULE_REGISTRY_RUNTIME_MODULES.contains("runtime_process_descriptors()"),
        "module_registry/runtime_modules must include runtime process descriptors in the canonical catalog"
    );
    assert!(
        !HOST_OWNER_RUNTIME.contains("ModuleScope::new(\"openclaw\")")
            && !HOST_OWNER_RUNTIME.contains("ModuleScope::new(\"matcha-agent\")"),
        "runtime process scopes must not be owned by ownerRuntimeTasks, which shuts down before OpenClaw session cleanup"
    );
    assert!(
        !HOST_SHUTDOWN.contains("async move {}"),
        "runtime process scope disposers must perform real shutdown and join work"
    );
}

#[test]
fn diagnostics_forwarders_are_declared_event_subscriptions() {
    assert!(
        DIAGNOSTICS_MODULE.contains("EffectKind::EventSubscription")
            && DIAGNOSTICS_MODULE.contains("openclaw-runtime")
            && DIAGNOSTICS_MODULE.contains("openclaw-readiness")
            && DIAGNOSTICS_MODULE.contains("matcha-lifecycle"),
        "diagnostics module must declare lifecycle forwarders as event-subscription effects"
    );
    assert!(
        HOST_DIAGNOSTICS.contains("register_event_subscription(\"openclaw-runtime\"")
            && HOST_DIAGNOSTICS.contains("register_event_subscription(\"openclaw-readiness\"")
            && HOST_DIAGNOSTICS.contains("register_event_subscription(\"matcha-lifecycle\""),
        "diagnostics lifecycle forwarders must register scoped event-subscription disposers"
    );
    assert!(
        !HOST_DIAGNOSTICS.contains("tokio::spawn(async move")
            && HOST_DIAGNOSTICS.contains("OwnedTask::spawn"),
        "diagnostics lifecycle forwarders must not regress to unscoped tokio::spawn tasks"
    );
}

#[test]
fn callback_server_is_a_scoped_lifecycle_effect() {
    assert!(
        FOUNDATION_LIFECYCLE.contains("CallbackServer")
            && FOUNDATION_LIFECYCLE.contains("register_callback_server")
            && PLATFORM_MODULE.contains("CallbackServer")
            && MODULE_REGISTRY_EFFECTS.contains("ScopedEffectKind::CallbackServer"),
        "callback server must be a first-class scoped lifecycle effect across foundation, platform, and Host mapping"
    );
}
