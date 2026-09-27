use std::{fs, path::Path};

const HOST_SRC: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src");
const RUNTIME_HOST_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/..");

const FORBIDDEN_BUSINESS_INTERNAL_SEGMENTS: &[&str] =
    &["owner", "internal", "application", "store", "domain"];

const HOST_FORBIDDEN_CRATES: &[&str] = &[
    "organization",
    "fleet",
    "channels",
    "connectors",
    "cron",
    "diagnostics",
    "platform_tools",
    "provider_module",
    "runtime_directory",
    "security",
    "sessions_module",
    "settings",
    "skills_module",
    "subagents",
    "task_manager",
    "usage",
    "wiki",
    "workspace",
];

const MODULE_CRATES: &[&str] = &[
    "channels",
    "connectors",
    "cron",
    "diagnostics",
    "fleet",
    "organization",
    "platform_tools",
    "provider_module",
    "runtime_directory",
    "security",
    "sessions_module",
    "settings",
    "skills_module",
    "subagents",
    "task_manager",
    "usage",
    "wiki",
    "workspace",
];

fn rust_sources(root: impl AsRef<Path>) -> Vec<String> {
    let root = root.as_ref();
    if !root.exists() {
        return Vec::new();
    }
    let mut sources = Vec::new();
    collect_rust_sources(root, &mut sources);
    sources
}

fn collect_rust_sources(path: &Path, sources: &mut Vec<String>) {
    let entries = fs::read_dir(path).expect("read source directory");
    for entry in entries {
        let entry = entry.expect("read source entry");
        let path = entry.path();
        if path.is_dir() {
            collect_rust_sources(&path, sources);
        } else if path.extension().and_then(|extension| extension.to_str()) == Some("rs") {
            let source_path = path.to_string_lossy().replace('\\', "/");
            if !source_path.ends_with("/tests.rs") && !source_path.contains("/tests/") {
                sources.push(source_path);
            }
        }
    }
}

fn contains_forbidden_path(source: &str, crate_name: &str) -> bool {
    FORBIDDEN_BUSINESS_INTERNAL_SEGMENTS
        .iter()
        .any(|segment| source.contains(&format!("{crate_name}::{segment}")))
}

fn cargo_manifests(root: impl AsRef<Path>) -> Vec<String> {
    let root = root.as_ref();
    if !root.exists() {
        return Vec::new();
    }
    let mut manifests = Vec::new();
    collect_cargo_manifests(root, &mut manifests);
    manifests
}

fn collect_cargo_manifests(path: &Path, manifests: &mut Vec<String>) {
    let entries = fs::read_dir(path).expect("read manifest directory");
    for entry in entries {
        let entry = entry.expect("read manifest entry");
        let path = entry.path();
        if path.is_dir() {
            collect_cargo_manifests(&path, manifests);
        } else if path.file_name().and_then(|file_name| file_name.to_str()) == Some("Cargo.toml") {
            manifests.push(path.to_string_lossy().replace('\\', "/"));
        }
    }
}

fn assert_source_has_no_function_definitions(
    path: impl AsRef<Path>,
    function_names: &[&str],
    message: &str,
) {
    let path = path.as_ref();
    let source = fs::read_to_string(path).expect("read source");
    let violations = function_names
        .iter()
        .filter(|function_name| source.contains(&format!("fn {function_name}(")))
        .copied()
        .collect::<Vec<_>>();

    assert!(
        violations.is_empty(),
        "{} in {}:\n{}",
        message,
        path.to_string_lossy(),
        violations.join("\n")
    );
}

fn assert_host_sources_do_not_contain(residues: &[&str], message: &str) {
    let violations = rust_sources(HOST_SRC)
        .into_iter()
        .flat_map(|path| {
            let source = fs::read_to_string(&path).expect("read host source");
            residues
                .iter()
                .filter(move |residue| source.contains(**residue))
                .map(move |residue| format!("{path}: {residue}"))
        })
        .collect::<Vec<_>>();

    assert!(
        violations.is_empty(),
        "{}:\n{}",
        message,
        violations.join("\n")
    );
}

#[test]
fn host_final_form_removes_legacy_delivery_transport_and_parent_callback_paths() {
    let host_src = Path::new(HOST_SRC);
    let delivery_sources = rust_sources(host_src.join("delivery"));
    let transport_sources = rust_sources(host_src.join("transport"));

    assert!(
        delivery_sources.is_empty(),
        "Host final-form must not keep host/src/delivery production Rust files after app rename:\n{}",
        delivery_sources.join("\n")
    );
    assert!(
        transport_sources.is_empty(),
        "Host final-form must not keep top-level host/src/transport production Rust files after app/http/compatibility migration:\n{}",
        transport_sources.join("\n")
    );
    assert!(
        !host_src.join("transport").exists(),
        "Host final-form must not keep top-level host/src/transport; app/http are the active paths"
    );
    assert!(
        host_src.join("parent_callback.rs").exists(),
        "parent_callback belongs at host/src/parent_callback.rs"
    );
}

#[test]
fn host_final_form_removes_legacy_compatibility_module() {
    let host_src = Path::new(HOST_SRC);

    for removed in [
        "module_registry/host_compatibility.rs",
        "module_registry/legacy_compatibility",
        "transport/compatibility",
    ] {
        assert!(
            !host_src.join(removed).exists(),
            "Host final-form must not keep legacy compatibility adapter {removed}"
        );
    }
}

#[test]
fn host_does_not_recreate_business_owner_directories() {
    let host_src = Path::new(HOST_SRC);

    for removed in ["runtime", "owners", "domains", "modules"] {
        assert!(
            !host_src.join(removed).exists(),
            "Host must not re-own business owner directory host/src/{removed}"
        );
    }
}

#[test]
fn openclaw_platform_product_commands_are_loopback_not_private_control() {
    let private_control =
        fs::read_to_string(Path::new(HOST_SRC).join("module_registry/private_control.rs"))
            .expect("read private control registry");
    let wire =
        fs::read_to_string(Path::new(HOST_SRC).join("control/wire.rs")).expect("read control wire");
    let openclaw_lib =
        fs::read_to_string(Path::new(RUNTIME_HOST_ROOT).join("integrations/openclaw/src/lib.rs"))
            .expect("read OpenClaw lib");
    let platform_loopback = fs::read_to_string(
        Path::new(RUNTIME_HOST_ROOT).join("integrations/openclaw/src/platform_runtime/loopback.rs"),
    )
    .expect("read OpenClaw platform loopback");
    let module_registry_runtime_modules =
        fs::read_to_string(Path::new(HOST_SRC).join("module_registry/runtime_modules.rs"))
            .expect("read module_registry runtime modules");

    assert!(
        !Path::new(RUNTIME_HOST_ROOT)
            .join("integrations/openclaw/src/control/private_stdio.rs")
            .exists(),
        "OpenClaw private stdio product command module must not remain after platform loopback cutover"
    );
    assert!(
        !openclaw_lib.contains("pub mod control;")
            && !private_control.contains("openclaw::control::private_stdio")
            && !wire.contains("Command::Installed")
            && !wire.contains("InstalledCommand"),
        "OpenClaw platform product commands must not remain on Host private stdio control"
    );
    for required in [
        "openclaw-platform.loopback",
        "OpenClawPlatformAdmissionPort",
        "project_installation_status",
        "project_runtime_paths",
        "project_cli_command",
        "decode_set_mode_request",
        "project_mode",
        "project_set_mode",
        "subagent_template_detail_response",
    ] {
        assert!(
            platform_loopback.contains(required),
            "OpenClaw platform loopback should own product command route/decode/projection/dispatch {required}"
        );
    }
    assert!(
        module_registry_runtime_modules
            .contains("openclaw::platform_runtime::loopback::descriptor")
            && module_registry_runtime_modules.contains("OpenClawPlatformAdmissionPort")
            && module_registry_runtime_modules.contains("Arc::clone(&handles.open_claw)"),
        "module_registry/runtime_modules should install the OpenClaw platform loopback descriptor and wire driver/admission ports"
    );
}

#[test]
fn host_control_lifecycle_keeps_runtime_specific_projection_out_of_private_control() {
    let control =
        fs::read_to_string(Path::new(HOST_SRC).join("control/loop.rs")).expect("read control loop");
    let app_runtime =
        fs::read_to_string(Path::new(HOST_SRC).join("app/runtime.rs")).expect("read app runtime");
    let app_shutdown =
        fs::read_to_string(Path::new(HOST_SRC).join("app/shutdown.rs")).expect("read app shutdown");
    let private_control =
        fs::read_to_string(Path::new(HOST_SRC).join("module_registry/private_control.rs"))
            .expect("read private control registry");
    let parent_callback = fs::read_to_string(Path::new(HOST_SRC).join("parent_callback.rs"))
        .expect("read Host parent callback client");
    let host_composition = fs::read_to_string(Path::new(HOST_SRC).join("composition/host/mod.rs"))
        .expect("read Host composition");
    let openclaw_driver_control = fs::read_to_string(
        Path::new(RUNTIME_HOST_ROOT).join("integrations/openclaw/src/driver/control.rs"),
    )
    .expect("read OpenClaw driver control projection");
    let openclaw_route = fs::read_to_string(
        Path::new(RUNTIME_HOST_ROOT)
            .join("integrations/openclaw/src/driver/runtime_control_route.rs"),
    )
    .expect("read OpenClaw runtime-control route fragment");
    let matcha_route = fs::read_to_string(
        Path::new(RUNTIME_HOST_ROOT)
            .join("integrations/matcha-agent/src/driver/runtime_control_route.rs"),
    )
    .expect("read Matcha runtime-control route fragment");
    let runtime_control_substrate = fs::read_to_string(
        Path::new(RUNTIME_HOST_ROOT).join("modules/runtime-directory/src/control_loopback.rs"),
    )
    .expect("read runtime-control shared loopback substrate");

    assert!(
        !Path::new(HOST_SRC)
            .join("runtime_control_loopback.rs")
            .exists(),
        "Host must not own runtime-control loopback"
    );
    for required in [
        "project_logs",
        "project_control_readiness",
        "project_gateway_health",
        "project_gateway_status",
    ] {
        assert!(
            openclaw_route.contains(required),
            "OpenClaw integration route fragment should own runtime-control projection {required}"
        );
    }
    assert!(
        matcha_route.contains("MatchaRuntimeControlRoute")
            && runtime_control_substrate.contains("RuntimeControlModule"),
        "runtime-control route fragments must live in integrations while shared auth/body/route substrate lives in runtime-directory"
    );
    assert!(
        !control.contains("Host::new(")
            && !control.contains("HostInput")
            && !control.contains("owner.join()")
            && !control.contains("shutdown_host"),
        "control must only own private stdio loop semantics, not Host construction/app shutdown"
    );
    assert!(
        app_runtime.contains("Host::new(input)")
            && app_runtime.contains("run_loop(")
            && app_shutdown.contains("async fn shutdown_host"),
        "app service must own Host construction/startup/shutdown and enter the private control loop"
    );
    let private_control_production = private_control
        .split("#[cfg(test)]")
        .next()
        .unwrap_or(&private_control);
    for residue in [
        "crate::runtime::adapters::matcha_agent::owner::project_status",
        "crate::runtime::adapters::matcha_agent::owner::project_lifecycle",
        "fn matcha_status",
        "fn start_matcha",
        "fn stop_matcha",
        "fn restart_matcha",
        "OpenClawControlReadiness::Ready",
        "OpenClawControlReadiness::Starting",
        "OpenClawControlReadiness::Unavailable",
        "fn gateway_snapshot_result",
        "fn control_readiness_result",
        "fn control_ready_result",
        "Invalid log cursor.",
        "lifecycleTailEvicted",
        "heartbeatEnabled",
        "RuntimeLifecycle::Running",
        concat!("openclaw::gateway", "::control::"),
    ] {
        assert!(
            !private_control_production.contains(residue),
            "Host control lifecycle must not own runtime-specific private projection residue {residue}"
        );
    }
    assert!(
        private_control_production.contains("peer.open_claw_gateway_snapshot().await")
            && private_control_production.contains("peer.open_claw_control_snapshot().await")
            && openclaw_driver_control.contains("OpenClawGatewaySnapshotObservation")
            && openclaw_driver_control.contains("OpenClawControlSnapshotObservation")
            && openclaw_driver_control.contains("project_gateway_snapshot")
            && openclaw_driver_control.contains("project_control_readiness"),
        "OpenClaw integration must own gateway/control snapshot projection while Host control consumes projected values"
    );
    assert!(
        parent_callback.contains("impl ParentShellOpenPath for ParentCallbackHandle")
            && !parent_callback.contains("OpenClawDriverParentCallback")
            && !host_composition.contains("OpenClawDriverParentCallbackHandle"),
        "Host parent callback transport/composition must stay generic and must not implement or construct OpenClaw-specific callback ports"
    );

    assert!(
        !Path::new(RUNTIME_HOST_ROOT)
            .join("integrations/openclaw/src/control/private_stdio.rs")
            .exists()
            && !private_control.contains("openclaw::control::private_stdio"),
        "OpenClaw product control must not remain on private stdio dispatch"
    );
}

#[test]
fn host_raw_gateway_dispatch_does_not_redefine_request_dtos_or_validation() {
    let private_control =
        fs::read_to_string(Path::new(HOST_SRC).join("module_registry/private_control.rs"))
            .expect("read private control registry");
    let openclaw_gateway_request_path =
        Path::new(RUNTIME_HOST_ROOT).join("integrations/openclaw/src/gateway/request.rs");
    let openclaw_gateway_request =
        fs::read_to_string(&openclaw_gateway_request_path).expect("read OpenClaw gateway request");
    let gateway_loopback = fs::read_to_string(
        Path::new(RUNTIME_HOST_ROOT).join("integrations/openclaw/src/gateway/loopback.rs"),
    )
    .expect("read OpenClaw gateway loopback");

    assert!(
        !Path::new(HOST_SRC)
            .join("control/dispatch/runtime.rs")
            .exists(),
        "Host runtime private dispatch file must not return after gateway loopback cutover"
    );
    for residue in [
        "struct OpenClawBrowserRequest",
        "struct OpenClawMcpAppRequest",
        "struct OpenClawGatewayPayload",
        "fn bounded_gateway_text",
    ] {
        assert!(
            !private_control.contains(residue),
            "Host raw gateway dispatch must not define {residue}; typed gateway request DTO/validation belongs to integrations/openclaw/src/gateway/request.rs"
        );
    }
    assert!(
        openclaw_gateway_request.contains("pub struct OpenClawBrowserGatewayRequest")
            && openclaw_gateway_request.contains("pub struct OpenClawMcpAppGatewayRequest")
            && openclaw_gateway_request.contains("pub fn decode_browser_request(")
            && openclaw_gateway_request.contains("pub fn decode_mcp_app_request(")
            && gateway_loopback.contains("decode_browser_request(wire.input)")
            && gateway_loopback.contains("decode_mcp_app_request(Value::Object(input))"),
        "integrations/openclaw must own typed raw gateway requests, decoders, and loopback dispatch"
    );
}

#[test]
fn openclaw_browser_and_mcp_app_execute_is_gateway_loopback_not_private_control() {
    let gateway_loopback = fs::read_to_string(
        Path::new(RUNTIME_HOST_ROOT).join("integrations/openclaw/src/gateway/loopback.rs"),
    )
    .expect("read OpenClaw gateway loopback");
    let module_registry_runtime_modules =
        fs::read_to_string(Path::new(HOST_SRC).join("module_registry/runtime_modules.rs"))
            .expect("read module_registry runtime modules");
    let runtime_ports =
        fs::read_to_string(Path::new(HOST_SRC).join("composition/runtime_ports.rs"))
            .expect("read Host runtime ports");

    assert!(
        !Path::new(RUNTIME_HOST_ROOT)
            .join("integrations/openclaw/src/control/private_stdio.rs")
            .exists(),
        "OpenClaw private stdio control must not keep browser/MCP capability execute residue"
    );
    assert!(
        gateway_loopback.contains("const EXECUTE_ENDPOINT: &str = \"/api/capabilities/execute\"")
            && gateway_loopback.contains("RouteDescriptor::bound(")
            && gateway_loopback.contains("\"openclaw-gateway.loopback\"")
            && gateway_loopback.contains("OpenClawGatewayCapabilityPort")
            && gateway_loopback.contains("decode_browser_request(wire.input)")
            && gateway_loopback.contains("decode_mcp_app_request(Value::Object(input))")
            && gateway_loopback.contains("dependencies.gateway.browser_request(request).await")
            && gateway_loopback.contains("dependencies.gateway.mcp_app_request(request).await")
            && gateway_loopback.contains("scope: BROWSER_SCOPE")
            && gateway_loopback.contains("scope: MCP_APP_SCOPE")
            && gateway_loopback.contains("operation_id.starts_with(\"mcp.app.\")"),
        "integrations/openclaw/src/gateway/loopback.rs must own OpenClaw browser/MCP capability execute routing, decode, authorization projection, and peer dispatch"
    );
    assert!(
        module_registry_runtime_modules.contains("openclaw::gateway::loopback::descriptor")
            && module_registry_runtime_modules.contains("OpenClawGatewayCapabilityPort")
            && runtime_ports.contains(
                "impl openclaw::gateway::loopback::OpenClawGatewayCapabilityPort for PeerHandle"
            )
            && runtime_ports.contains("peer.open_claw_browser_request(request)")
            && runtime_ports.contains("peer.open_claw_mcp_app_request(request)"),
        "module_registry/runtime_modules should install the OpenClaw gateway loopback descriptor and wire PeerHandle as its port"
    );
}

#[test]
fn host_facade_directory_is_removed_after_owner_module_cutover() {
    assert!(
        !Path::new(HOST_SRC).join("facade").exists(),
        "Host must not keep host/src/facade after typed entries move to concrete owners/modules"
    );
    assert_host_sources_do_not_contain(
        &[
            "project_clawhub_result",
            "project_sealed_catalog",
            "project_sealed_entry_ref",
            "project_sealed_entry",
            "project_sealed_read",
            "sealed_error",
        ],
        "Host must use skills_module projection boundaries, not legacy local facade mapper functions",
    );
}

#[test]
fn host_private_control_does_not_expose_skill_management_execute() {
    let wire =
        fs::read_to_string(Path::new(HOST_SRC).join("control/wire.rs")).expect("read control wire");
    let private_control =
        fs::read_to_string(Path::new(HOST_SRC).join("module_registry/private_control.rs"))
            .expect("read private control registry");
    let loopback = fs::read_to_string(
        Path::new(RUNTIME_HOST_ROOT).join("modules/skills/src/adapters/loopback/management.rs"),
    )
    .expect("read skills management loopback");

    for residue in [
        "openclaw.skills.execute",
        "OpenClawSkillsExecute",
        "openclaw_skills_execute",
        "control/dispatch/skills.rs",
    ] {
        assert!(
            !wire.contains(residue) && !private_control.contains(residue),
            "skill.management execute must be owned by skills loopback, not Host private control residue {residue}"
        );
    }
    assert!(
        !Path::new(HOST_SRC)
            .join("control/dispatch/skills.rs")
            .exists(),
        "Host control must not keep a skill.management dispatch module"
    );
    assert!(
        loopback.contains("/api/skills/capability/execute")
            && loopback.contains("skill.management")
            && loopback.contains("execute_management_request"),
        "Skills loopback route should own skill.management execution"
    );
}

#[test]
fn host_plugins_dispatch_uses_module_owned_transport_routes() {
    let control_wire =
        fs::read_to_string(Path::new(HOST_SRC).join("control/wire.rs")).expect("read control wire");
    let private_control =
        fs::read_to_string(Path::new(HOST_SRC).join("module_registry/private_control.rs"))
            .expect("read private control registry");
    let plugins_loopback = fs::read_to_string(
        Path::new(RUNTIME_HOST_ROOT).join("modules/plugins/src/adapters/loopback/mod.rs"),
    )
    .expect("read plugins loopback");
    let plugins_handler = fs::read_to_string(
        Path::new(RUNTIME_HOST_ROOT).join("modules/plugins/src/adapters/loopback/handler.rs"),
    )
    .expect("read plugins loopback handler");

    assert!(
        !Path::new(HOST_SRC)
            .join("control/dispatch/plugins.rs")
            .exists(),
        "Host private control must not keep product plugin dispatch"
    );
    for residue in [
        "OpenClawPlugins",
        "openclaw.plugins",
        "plugins_module::control",
        "control::plugins",
    ] {
        assert!(
            !control_wire.contains(residue) && !private_control.contains(residue),
            "Host private control must not own plugin product command residue {residue}"
        );
    }
    assert!(
        plugins_loopback.contains("handler::CATALOG_ENDPOINT")
            && plugins_loopback.contains("handler::RUNTIME_ENDPOINT")
            && plugins_loopback.contains("handler::CONFIGURATION_ENDPOINT")
            && plugins_loopback.contains("handler::OPERATION_ENDPOINT")
            && plugins_handler.contains("/api/plugins/catalog")
            && plugins_handler.contains("/api/plugins/runtime")
            && plugins_handler.contains("/api/plugins/configuration")
            && plugins_handler.contains("/api/plugins/operation"),
        "plugins module loopback routes must own plugin product transport"
    );
}

#[test]
fn host_runtime_driver_uses_module_owned_provider_config_contract() {
    let mut violations = Vec::new();
    for path in rust_sources(HOST_SRC) {
        let source = fs::read_to_string(&path).expect("read host source");
        if source.contains("trait ProviderConfigOps") {
            violations.push(format!("{path}: trait ProviderConfigOps"));
        }
        if source.contains("struct ProviderNativeConfigurationCommand")
            || source.contains("enum ProviderNativeConfigurationCommand")
            || source.contains("type ProviderNativeConfigurationCommand")
        {
            violations.push(format!(
                "{path}: ProviderNativeConfigurationCommand definition"
            ));
        }
    }

    let provider_ops = fs::read_to_string(
        Path::new(RUNTIME_HOST_ROOT)
            .join("integrations/openclaw/src/surfaces/providers/adapter.rs"),
    )
    .expect("read OpenClaw provider config ops");

    assert!(
        provider_ops.contains("provider_module::ProviderNativeConfigurationCommand"),
        "OpenClaw provider config ops should use the provider_module-owned command type"
    );
    assert!(
        violations.is_empty(),
        "Host must not redefine provider config runtime contracts already owned by provider_module:\n{}",
        violations.join("\n")
    );
}

#[test]
fn host_openclaw_skill_ops_implements_skills_module_runtime_contract() {
    let skills_ports =
        fs::read_to_string(Path::new(RUNTIME_HOST_ROOT).join("modules/skills/src/ports.rs"))
            .expect("read skills module ports");
    let openclaw_skill_ops = fs::read_to_string(
        Path::new(RUNTIME_HOST_ROOT).join("integrations/openclaw/src/surfaces/skills/adapter.rs"),
    )
    .expect("read OpenClaw skill ops");
    let mut violations = Vec::new();
    for path in rust_sources(HOST_SRC) {
        let source = fs::read_to_string(&path).expect("read host source");
        if source.contains("trait SkillOps") {
            violations.push(format!("{path}: trait SkillOps"));
        }
    }

    assert!(
        skills_ports.contains("pub trait SkillRuntimeOps"),
        "SkillRuntimeOps must remain owned by modules/skills"
    );
    assert!(
        openclaw_skill_ops.contains("impl skills_module::SkillRuntimeOps for OpenClawDriver"),
        "OpenClaw skill ops must implement the skills_module-owned runtime trait"
    );
    assert!(
        violations.is_empty(),
        "Host must not redefine the legacy local SkillOps trait:\n{}",
        violations.join("\n")
    );
}

#[test]
fn host_capability_catalog_is_not_a_host_owned_descriptor_directory() {
    assert!(
        !Path::new(HOST_SRC).join("capabilities").exists(),
        "Host must not keep host/src/capabilities; the catalog must be projected from installed ModuleCatalog descriptors"
    );
    assert_host_sources_do_not_contain(
        &[
            "channels::capability::integration_descriptor",
            "cron::capability::scheduler_descriptor",
            "plugins_module::capability::runtime_descriptor",
            "provider_module::capability::routing_descriptor",
            "skills_module::capability::management_descriptor",
            "subagents::capability::management_descriptor",
            "subagents::capability::skills_descriptor",
            "subagents::capability::tools_descriptor",
            "openclaw::gateway::capability::browser_descriptor",
            "openclaw::gateway::capability::mcp_app_descriptor",
            "organization::capability::team_runtime_descriptor",
            "sessions_module::capability::",
            "platform_tools::capability::",
            "task_manager::capability::",
            "workspace::capability::",
        ],
        "Host catalog must not import business owner capability descriptor functions directly",
    );
    assert_host_sources_do_not_contain(
        &[
            "sessions.create",
            "sessions.patchModel",
            "approvals.list",
            "tools.invoke",
            "files.readText",
            "media.prepare",
            "team.packageValidate",
        ],
        "Host must not keep migrated capability descriptor bodies after catalog ownership moves to ModuleCatalog descriptors",
    );
}

#[test]
fn host_does_not_import_business_internal_modules_directly() {
    let mut violations = Vec::new();
    for path in rust_sources(HOST_SRC) {
        let source = fs::read_to_string(&path).expect("read host source");
        for crate_name in HOST_FORBIDDEN_CRATES {
            if contains_forbidden_path(&source, crate_name) {
                violations.push(format!("{path}: {crate_name}::<internal-layer>"));
            }
        }
    }

    assert!(
        violations.is_empty(),
        "Host production code must use module api/ports/facades, not business internal layers:\n{}",
        violations.join("\n")
    );
}

#[test]
fn second_stage_business_owner_directories_stay_out_of_host() {
    for removed in ["sealed_resource", "organization_adapters", "artifacts"] {
        assert!(
            !Path::new(HOST_SRC).join(removed).exists(),
            "Host must not keep migrated business owner directory {removed}"
        );
    }
    for removed in [
        "diagnostics",
        "diagnostics/archive.rs",
        "diagnostics/archive",
        "diagnostics/flight_recorder.rs",
    ] {
        assert!(
            !Path::new(HOST_SRC).join(removed).exists(),
            "Host must not keep migrated diagnostics owner path {removed}"
        );
    }
}

#[test]
fn second_stage_owners_live_in_modules_with_host_only_wiring_ports() {
    let host_lib = fs::read_to_string(Path::new(HOST_SRC).join("lib.rs")).expect("read host lib");
    let module_registry_runtime_modules =
        fs::read_to_string(Path::new(HOST_SRC).join("module_registry/runtime_modules.rs"))
            .expect("read module_registry runtime modules");
    let host_provisioning =
        fs::read_to_string(Path::new(HOST_SRC).join("composition/host/provisioning.rs"))
            .expect("read host provisioning");
    let host_sealed_resources = fs::read_to_string(
        Path::new(HOST_SRC).join("composition/host/resources/sealed_resources.rs"),
    )
    .expect("read host sealed resources");
    let host_organization_ports =
        fs::read_to_string(Path::new(HOST_SRC).join("composition/host/ports/organization.rs"))
            .expect("read host organization ports");
    let sealed_module =
        fs::read_to_string(Path::new(RUNTIME_HOST_ROOT).join("modules/sealed-resource/src/lib.rs"))
            .expect("read sealed-resource module");
    let sealed_ports = fs::read_to_string(
        Path::new(RUNTIME_HOST_ROOT).join("modules/sealed-resource/src/ports.rs"),
    )
    .expect("read sealed-resource ports");
    let organization_module =
        fs::read_to_string(Path::new(RUNTIME_HOST_ROOT).join("modules/organization/src/lib.rs"))
            .expect("read organization module");
    let organization_terminal = fs::read_to_string(
        Path::new(RUNTIME_HOST_ROOT).join("modules/organization/src/adapters/session_terminal.rs"),
    )
    .expect("read organization terminal adapter");
    let organization_send_hook = fs::read_to_string(
        Path::new(RUNTIME_HOST_ROOT)
            .join("modules/organization/src/adapters/start_gate_send_hook.rs"),
    )
    .expect("read organization send hook");
    let host_mcp = fs::read_to_string(Path::new(HOST_SRC).join("bin/runtime-host-mcp.rs"))
        .expect("read Host MCP composition");
    let organization_mcp_tools = fs::read_to_string(
        Path::new(RUNTIME_HOST_ROOT).join("modules/organization/src/adapters/mcp/tools.rs"),
    )
    .expect("read organization MCP tools adapter");
    let wiki_module =
        fs::read_to_string(Path::new(RUNTIME_HOST_ROOT).join("modules/wiki/src/lib.rs"))
            .expect("read wiki module");
    let wiki_mcp_tools = fs::read_to_string(
        Path::new(RUNTIME_HOST_ROOT).join("modules/wiki/src/adapters/mcp/mod.rs"),
    )
    .expect("read wiki MCP adapter");
    let diagnostics_module =
        fs::read_to_string(Path::new(RUNTIME_HOST_ROOT).join("modules/diagnostics/src/lib.rs"))
            .expect("read diagnostics module");
    let diagnostics_model = fs::read_to_string(
        Path::new(RUNTIME_HOST_ROOT).join("modules/diagnostics/src/domain/model.rs"),
    )
    .expect("read diagnostics model");

    assert!(
        !host_lib.contains("mod artifacts;")
            && !host_lib.contains("pub mod sealed_resource;")
            && !host_lib.contains("mod organization_adapters;")
            && !host_lib.contains("mod mcp;"),
        "Host lib must not own migrated second-stage modules or delegate-only MCP wrapper"
    );
    assert!(
        sealed_module.contains("SealedResourceModule")
            && sealed_ports.contains("skills_port")
            && sealed_ports.contains("agents_port")
            && module_registry_runtime_modules
                .contains("handles.sealed_resource.descriptor(Arc::clone(&verifier))")
            && host_sealed_resources.contains("SealedResourceModule::openclaw"),
        "sealed-resource module must own sealed stores while module_registry/runtime_modules installs its descriptor"
    );
    for residue in [
        "SkillKey::parse",
        "AgentKey::parse",
        "PackageRelativePath::parse",
        "impl skills_module::ports::SealedSkillStorePort",
        "impl subagents::SealedAgentStorePort",
    ] {
        assert!(
            !host_provisioning.contains(residue)
                && !module_registry_runtime_modules.contains(residue),
            "Host must not retain sealed-resource store/projection residue {residue}"
        );
    }
    assert!(
        organization_module.contains("StartGateSendHook")
            && organization_module.contains("StartGateRegistry")
            && organization_module.contains("OrganizationSessionTerminal")
            && organization_module.contains("team_run_mcp_provider")
            && organization_send_hook.contains("start_gate_prompt_plan")
            && organization_terminal.contains("team_message_terminal_observed")
            && host_mcp.contains("ToolCatalog::new")
            && host_mcp.contains("organization::team_run_mcp_provider")
            && host_mcp.contains("wiki::wiki_mcp_provider")
            && organization_mcp_tools.contains("impl ToolProvider for TeamRunMcpFacade")
            && organization_mcp_tools.contains("\"team_graph_context\"")
            && organization_mcp_tools.contains("\"inputSchema\"")
            && wiki_module.contains("wiki_mcp_provider")
            && wiki_mcp_tools.contains("impl ToolProvider for WikiMcpFacade")
            && wiki_mcp_tools.contains("\"wiki_retrieve_context\"")
            && wiki_mcp_tools.contains("\"wiki_apply_generated_pages\"")
            && wiki_mcp_tools.contains("\"inputSchema\""),
        "Host product MCP composition must install Organization-owned TeamRun and Wiki-owned MCP providers"
    );
    assert!(
        !Path::new(HOST_SRC).join("transport").exists(),
        "Host final-form must not keep a transport substrate; MCP stdio stays in platform and HTTP stays in host/src/http"
    );
    for residue in [
        "start_gate_prompt_plan",
        "start_gate_terminal_proposal_set",
        "team_message_terminal_observed",
        "TeamRunMcpFacade::from_canonical_store",
    ] {
        assert!(
            !host_organization_ports.contains(residue),
            "Host organization port glue must not own organization business semantic {residue}"
        );
    }
    assert!(
        diagnostics_module.contains("RuntimeFlightRecorder")
            && diagnostics_module.contains("DiagnosticsArchiveProducer")
            && diagnostics_model.contains("RuntimeStartupDiagnostic")
            && diagnostics_model.contains("RuntimeStartupDiagnostics"),
        "diagnostics module must own archive/flight-recorder/runtime projection and startup diagnostic capture without a Host shim"
    );
}

#[test]
fn host_private_control_does_not_expose_toolchain_business_entry() {
    let wire =
        fs::read_to_string(Path::new(HOST_SRC).join("control/wire.rs")).expect("read control wire");
    let private_control =
        fs::read_to_string(Path::new(HOST_SRC).join("module_registry/private_control.rs"))
            .expect("read private control registry");
    for residue in [
        "host.toolchain.status",
        "host.toolchain.prepare",
        "HostToolchainStatus",
        "HostToolchainPrepare",
        "toolchain_status",
        "toolchain_prepare",
        "dispatch_toolchain_uv_check",
        "toolchain::ToolchainModule",
    ] {
        assert!(
            !wire.contains(residue) && !private_control.contains(residue),
            "toolchain business entry must be owned by modules/toolchain loopback adapter, not Host private control residue {residue}"
        );
    }
}

#[test]
fn host_private_control_does_not_expose_fleet_credential_write() {
    let wire =
        fs::read_to_string(Path::new(HOST_SRC).join("control/wire.rs")).expect("read control wire");
    let private_control =
        fs::read_to_string(Path::new(HOST_SRC).join("module_registry/private_control.rs"))
            .expect("read private control registry");
    let loopback = fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("host crate has workspace parent")
            .join("modules/fleet/src/adapters/loopback/credentials.rs"),
    )
    .expect("read fleet credentials loopback route");

    assert!(
        !wire.contains("fleet.credentials.write")
            && !wire.contains("FleetCredentialsWrite")
            && !private_control.contains("fleet_credentials_write")
            && !private_control.contains("::fleet::control::credentials_write"),
        "fleet credential write must be owned by Fleet private loopback, not Host private control"
    );
    assert!(
        loopback.contains("/api/fleet/credentials/write")
            && loopback.contains("fleet:credentials:write")
            && loopback.contains("FleetCredentialPlaintext"),
        "Fleet private loopback route should own credential writes without exposing plaintext publicly"
    );
}

#[test]
fn host_private_control_does_not_expose_team_runtime_execute() {
    let wire =
        fs::read_to_string(Path::new(HOST_SRC).join("control/wire.rs")).expect("read control wire");
    let private_control =
        fs::read_to_string(Path::new(HOST_SRC).join("module_registry/private_control.rs"))
            .expect("read private control registry");
    let loopback = fs::read_to_string(
        Path::new(RUNTIME_HOST_ROOT)
            .join("modules/organization/src/adapters/loopback/team_runtime.rs"),
    )
    .expect("read team runtime loopback");

    for residue in [
        "team.runtime.execute",
        "TeamRuntimeExecute",
        "team_runtime_execute",
        "control/dispatch/team.rs",
    ] {
        assert!(
            !wire.contains(residue) && !private_control.contains(residue),
            "team.runtime execute must be owned by organization loopback, not Host private control residue {residue}"
        );
    }
    assert!(
        !Path::new(HOST_SRC)
            .join("control/dispatch/team.rs")
            .exists(),
        "Host control must not keep a team.runtime dispatch module"
    );
    assert!(
        loopback.contains("/api/team/runtime/execute")
            && loopback.contains("team.runtime")
            && loopback.contains("execute_team_runtime_capability_request"),
        "Organization loopback route should own team.runtime execution"
    );
}

#[test]
fn runtime_module_manifests_do_not_path_depend_on_integrations() {
    let mut violations = Vec::new();
    for manifest in cargo_manifests(Path::new(RUNTIME_HOST_ROOT).join("modules")) {
        let source = fs::read_to_string(&manifest).expect("read module manifest");
        for line in source.lines() {
            if line.contains("path = \"../../integrations/")
                || line.contains("path = '../integrations/")
                || line.contains("path = \"../integrations/")
            {
                violations.push(format!("{manifest}: {line}"));
            }
        }
    }

    assert!(
        violations.is_empty(),
        "Runtime modules must not depend on integration crates; integrations consume module ports instead:\n{}",
        violations.join("\n")
    );
}

#[test]
fn runtime_modules_do_not_cross_import_other_modules_internal_layers() {
    let mut violations = Vec::new();
    for path in rust_sources(Path::new(RUNTIME_HOST_ROOT).join("modules")) {
        let normalized = path.replace('\\', "/");
        let owner = normalized
            .split("/modules/")
            .nth(1)
            .and_then(|suffix| suffix.split('/').next())
            .expect("module path has owner");
        let source = fs::read_to_string(&path).expect("read module source");
        for crate_name in MODULE_CRATES {
            if crate_name.replace('_', "-") == owner {
                continue;
            }
            if contains_forbidden_path(&source, crate_name) {
                violations.push(format!("{normalized}: {crate_name}::<internal-layer>"));
            }
        }
    }

    assert!(
        violations.is_empty(),
        "Runtime modules must depend on other modules through api/ports/events only:\n{}",
        violations.join("\n")
    );
}
