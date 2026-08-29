use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use super::*;

#[cfg(unix)]
const ROOT: &str = "/opt/matcha";
#[cfg(windows)]
const ROOT: &str = r"C:\matcha";

fn wire() -> serde_json::Value {
    let mut value = serde_json::json!({
        "version": BOOTSTRAP_VERSION,
        "appVersion": "1.0.0",
        "appLogDir": format!("{ROOT}/userdata/logs"),
        "runtimeHostStateDir": format!("{ROOT}/runtime-host"),
        "parentCallbackBaseUrl": "http://127.0.0.1:34100",
        "parentCallbackDispatchToken": "test-parent-dispatch-token",
        "deliveryVerificationKey": "MCowBQYDK2VwAyEAI3qD__Jv49yWsjljbNRbVm11047IMl5xFBflSPOROKE",
        "cronBrokerVerificationKey": "MCowBQYDK2VwAyEAIcPTPZ95XS_AEiM3zFVx8tkcbB2_7d62G7PkQm6DPhY",
        "sessionTransportPort": 34101,
        "taskManagerTransportPort": 34138,
        "sessionSendTransportPort": 34106,
        "sessionAbortTransportPort": 34113,
        "sessionApprovalTransportPort": 34107,
        "securityEmergencyTransportPort": 34112,
        "channelStatusTransportPort": 34115,
        "channelCatalogTransportPort": 34142,
        "channelControlTransportPort": 34132,
        "channelPairingTransportPort": 34126,
        "sessionModelSelectionTransportPort": 34108,
        "openclawHistoryTransportPort": 34109,
        "matchaHistoryTransportPort": 34141,
        "usageTransportPort": 34136,
        "diagnosticsTransportPort": 34104,
        "cronTransportPort": 34116,
        "cronBrokerTransportPort": 34137,
        "agentsTransportPort": 34117,
        "teamPublicTransportPort": 34118,
        "fleetTransportPort": 34143,
        "teamRoleSessionsTransportPort": 34131,
        "teamGraphTransportPort": 34120,
        "providerModelsTransportPort": 34119,
        "teamSkillTransportPort": 34121,
        "teamTriggerTransportPort": 34122,
        "teamLifecycleTransportPort": 34123,
        "manualTeamTransportPort": 34125,
        "settingsDesiredTransportPort": 34127,
        "securityPolicyTransportPort": 34128,
        "workspaceTextTransportPort": 34105,
        "workspaceBinaryTransportPort": 34130,
        "workspaceDirectoryTransportPort": 34110,
        "workspaceWriteTransportPort": 34111,
        "workspaceMediaTransportPort": 34135,
        "matcha": {
            "bunExecutable": format!("{ROOT}/bun"),
            "entry": format!("{ROOT}/app-server.mjs"),
            "workingDirectory": ROOT,
            "storageRoot": format!("{ROOT}/storage"),
            "port": 34102,
            "privateSecretRoot": format!("{ROOT}/private"),
        },
        "openClaw": {
            "electronImage": format!("{ROOT}/MatchaClaw"),
            "workingDirectory": ROOT,
            "openclawDir": format!("{ROOT}/openclaw"),
            "managedPluginRoot": format!("{ROOT}/openclaw-plugins"),
            "companionSkillSourceRoot": format!("{ROOT}/resources/skills/plugin-companion-skills"),
            "subagentTemplateDir": format!("{ROOT}/openclaw/subagents"),
            "entry": format!("{ROOT}/openclaw/openclaw.mjs"),
            "stateDir": format!("{ROOT}/openclaw-state"),
            "port": 34103,
        },
    });
    let root = value
        .as_object_mut()
        .expect("bootstrap fixture is an object");
    root.insert(
        "teamTaskBoardTransportPort".into(),
        serde_json::json!(34124),
    );
    root.insert(
        "teamApprovalsTransportPort".into(),
        serde_json::json!(34133),
    );
    root.insert("teamDecisionTransportPort".into(), serde_json::json!(34139));
    root.insert("teamRoleChatTransportPort".into(), serde_json::json!(34140));
    root.insert(
        "providerAccountsTransportPort".into(),
        serde_json::json!(34134),
    );
    with_platform_fields(value)
}

#[cfg(unix)]
fn with_platform_fields(mut value: serde_json::Value) -> serde_json::Value {
    value["guardianExecutable"] =
        serde_json::Value::String(format!("{ROOT}/runtime-host-guardian"));
    value
}

#[cfg(windows)]
fn with_platform_fields(mut value: serde_json::Value) -> serde_json::Value {
    value["matcha"]["gitBash"] = serde_json::Value::String(format!("{ROOT}/git-bash.exe"));
    value
}

struct TestRoot(PathBuf);

impl TestRoot {
    fn new() -> Self {
        static NEXT_ID: AtomicU64 = AtomicU64::new(0);

        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "runtime-host-bootstrap-tests-{}-{id}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self, name: &str) -> String {
        self.0.join(name).to_string_lossy().into_owned()
    }

    fn state_dir(&self) -> String {
        self.path("openclaw-state")
    }

    fn runtime_host_state_dir(&self) -> String {
        self.path("runtime-host")
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn materializable_wire(root: &TestRoot) -> serde_json::Value {
    fs::create_dir_all(root.0.join("work")).unwrap();
    let mut value = wire();
    value["appLogDir"] = serde_json::Value::String(root.path("userdata/logs"));
    value["runtimeHostStateDir"] = serde_json::Value::String(root.runtime_host_state_dir());
    value["matcha"]["bunExecutable"] = serde_json::Value::String(root.path("bun"));
    value["matcha"]["entry"] = serde_json::Value::String(root.path("app-server.mjs"));
    value["matcha"]["workingDirectory"] = serde_json::Value::String(root.path("work"));
    value["matcha"]["storageRoot"] = serde_json::Value::String(root.path("storage"));
    value["matcha"]["privateSecretRoot"] = serde_json::Value::String(root.path("private"));
    value["openClaw"]["electronImage"] = serde_json::Value::String(root.path("MatchaClaw"));
    value["openClaw"]["workingDirectory"] = serde_json::Value::String(root.path("work"));
    value["openClaw"]["openclawDir"] = serde_json::Value::String(root.path("openclaw"));
    value["openClaw"]["managedPluginRoot"] =
        serde_json::Value::String(root.path("openclaw-plugins"));
    value["openClaw"]["companionSkillSourceRoot"] =
        serde_json::Value::String(root.path("resources/skills/plugin-companion-skills"));
    value["openClaw"]["subagentTemplateDir"] =
        serde_json::Value::String(root.path("openclaw/subagents"));
    value["openClaw"]["entry"] = serde_json::Value::String(root.path("openclaw/openclaw.mjs"));
    value["openClaw"]["stateDir"] = serde_json::Value::String(root.state_dir());
    with_materializable_platform_fields(value, root)
}

#[cfg(unix)]
fn with_materializable_platform_fields(
    mut value: serde_json::Value,
    root: &TestRoot,
) -> serde_json::Value {
    value["guardianExecutable"] = serde_json::Value::String(root.path("runtime-host-guardian"));
    value
}

#[cfg(windows)]
fn with_materializable_platform_fields(
    mut value: serde_json::Value,
    root: &TestRoot,
) -> serde_json::Value {
    value["matcha"]["gitBash"] = serde_json::Value::String(root.path("git-bash.exe"));
    value
}

#[test]
fn decodes_a_strict_configuration_without_materializing_files() {
    let value = serde_json::to_vec(&wire()).unwrap();

    assert!(decode(value).is_ok());
}

#[test]
fn defaults_runtime_observation_off() {
    let root = TestRoot::new();
    let bootstrap = decode(serde_json::to_vec(&materializable_wire(&root)).unwrap()).unwrap();
    let parts = bootstrap.into_parts().unwrap();

    assert_eq!(
        parts.host.runtime_observation,
        RuntimeObservationConfig::off()
    );
}

#[test]
fn decodes_runtime_observation_modes() {
    let mut normal = wire();
    normal["runtimeObservation"] = serde_json::json!({
        "mode": "normal",
        "archive": true
    });
    let bootstrap = decode(serde_json::to_vec(&normal).unwrap()).unwrap();
    assert_eq!(
        bootstrap.runtime_observation,
        RuntimeObservationConfig::normal(true)
    );

    let mut diagnostic = wire();
    diagnostic["runtimeObservation"] = serde_json::json!({
        "mode": "diagnostic",
        "archive": true,
        "diagnosticTtlMs": 5000
    });
    let bootstrap = decode(serde_json::to_vec(&diagnostic).unwrap()).unwrap();
    assert_eq!(
        bootstrap.runtime_observation,
        RuntimeObservationConfig::diagnostic(true, std::time::Duration::from_millis(5000))
    );
}

#[test]
fn rejects_diagnostic_runtime_observation_without_ttl() {
    let mut missing = wire();
    missing["runtimeObservation"] = serde_json::json!({
        "mode": "diagnostic"
    });
    assert!(decode(serde_json::to_vec(&missing).unwrap()).is_err());

    let mut zero = wire();
    zero["runtimeObservation"] = serde_json::json!({
        "mode": "diagnostic",
        "diagnosticTtlMs": 0
    });
    assert!(decode(serde_json::to_vec(&zero).unwrap()).is_err());
}

#[test]
fn decodes_a_sealed_provider_credential_resolver() {
    let root = TestRoot::new();
    let mut value = materializable_wire(&root);
    value["providerCredentialResolver"] = serde_json::json!({
        "endpoint": "http://127.0.0.1:34135/resolve",
        "authorization": "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"
    });
    let bootstrap = decode(serde_json::to_vec(&value).unwrap()).unwrap();
    let parts = bootstrap.into_parts().unwrap();
    assert!(format!("{:?}", parts.provider_credential_resolver).contains("[REDACTED]"));
}

#[test]
fn rejects_invalid_provider_credential_resolver_without_disclosing_it() {
    let secret = "provider-private-resolver-secret";
    let mut value = wire();
    value["providerCredentialResolver"] = serde_json::json!({
        "endpoint": "http://127.0.0.1:34135/not-resolve",
        "authorization": secret
    });
    let result = decode(serde_json::to_vec(&value).unwrap());
    assert!(result.is_err());
    let error = result.err().expect("invalid resolver must be rejected");
    assert!(!error.to_string().contains(secret));
    assert!(!format!("{error:?}").contains(secret));
}

#[test]
fn rejects_removed_fleet_ingress() {
    let mut artifact = wire();
    artifact["fleet"] = serde_json::json!({
        "executable": format!("{ROOT}/runtime-agent"),
        "manifest": format!("{ROOT}/runtime-agent.manifest.json"),
        "workingDirectory": ROOT,
        "target": "test-target",
        "revision": "test-revision",
        "publisher": "test-publisher",
        "reference": "test-reference",
        "agentId": "agent:test",
        "remoteRelayBind": "0.0.0.0:0",
        "remoteRelayAdvertised": "192.0.2.1:34141"
    });
    assert!(decode(serde_json::to_vec(&artifact).unwrap()).is_err());

    let mut resolver = wire();
    resolver["fleetCredentialResolver"] = serde_json::json!({
        "endpoint": "http://127.0.0.1:34136/fleet-secret",
        "authorization": "fleet-private-resolver-secret"
    });
    assert!(decode(serde_json::to_vec(&resolver).unwrap()).is_err());
}

#[test]
fn materializes_host_and_organization_runtime_input() {
    let root = TestRoot::new();
    let bootstrap = decode(serde_json::to_vec(&materializable_wire(&root)).unwrap()).unwrap();
    let parts = bootstrap.into_parts().unwrap();
    let input = parts.host;
    let webhook_token = parts.webhook_token;
    let session_transport_port = parts.session_transport_port;
    let task_manager_transport_port = parts.task_manager_transport_port;
    let session_send_transport_port = parts.session_send_transport_port;
    let session_abort_transport_port = parts.session_abort_transport_port;
    let session_approval_transport_port = parts.session_approval_transport_port;
    let security_emergency_transport_port = parts.security_emergency_transport_port;
    let channel_status_transport_port = parts.channel_status_transport_port;
    let channel_catalog_transport_port = parts.channel_catalog_transport_port;
    let channel_control_transport_port = parts.channel_control_transport_port;
    let channel_pairing_transport_port = parts.channel_pairing_transport_port;
    let session_model_selection_transport_port = parts.session_model_selection_transport_port;
    let openclaw_history_transport_port = parts.openclaw_history_transport_port;
    let matcha_history_transport_port = parts.matcha_history_transport_port;
    let usage_transport_port = parts.usage_transport_port;
    let diagnostics_transport_port = parts.diagnostics_transport_port;
    let workspace_text_transport_port = parts.workspace_text_transport_port;
    let workspace_binary_transport_port = parts.workspace_binary_transport_port;
    let workspace_directory_transport_port = parts.workspace_directory_transport_port;
    let workspace_write_transport_port = parts.workspace_write_transport_port;
    let workspace_media_transport_port = parts.workspace_media_transport_port;
    let cron_transport_port = parts.cron_transport_port;
    let agents_transport_port = parts.agents_transport_port;
    let team_public_transport_port = parts.team_public_transport_port;
    let fleet_transport_port = parts.fleet_transport_port;
    let team_role_sessions_transport_port = parts.team_role_sessions_transport_port;
    let team_approvals_transport_port = parts.team_approvals_transport_port;
    let team_decision_transport_port = parts.team_decision_transport_port;
    let team_role_chat_transport_port = parts.team_role_chat_transport_port;
    let team_graph_transport_port = parts.team_graph_transport_port;
    let provider_models_transport_port = parts.provider_models_transport_port;
    let provider_accounts_transport_port = parts.provider_accounts_transport_port;
    let team_skill_transport_port = parts.team_skill_transport_port;
    let team_trigger_transport_port = parts.team_trigger_transport_port;
    let team_lifecycle_transport_port = parts.team_lifecycle_transport_port;
    let manual_team_transport_port = parts.manual_team_transport_port;
    let settings_desired_transport_port = parts.settings_desired_transport_port;
    let security_policy_transport_port = parts.security_policy_transport_port;
    assert_eq!(session_transport_port, 34101);
    assert_eq!(task_manager_transport_port, 34138);
    assert_eq!(session_send_transport_port, 34106);
    assert_eq!(session_abort_transport_port, 34113);
    assert_eq!(session_approval_transport_port, 34107);
    assert_eq!(security_emergency_transport_port, 34112);
    assert_eq!(channel_status_transport_port, 34115);
    assert_eq!(channel_catalog_transport_port, 34142);
    assert_eq!(channel_control_transport_port, 34132);
    assert_eq!(channel_pairing_transport_port, 34126);
    assert_eq!(session_model_selection_transport_port, 34108);
    assert_eq!(openclaw_history_transport_port, 34109);
    assert_eq!(matcha_history_transport_port, 34141);
    assert_eq!(usage_transport_port, 34136);
    assert_eq!(diagnostics_transport_port, 34104);
    assert_eq!(workspace_text_transport_port, 34105);
    assert_eq!(workspace_binary_transport_port, 34130);
    assert_eq!(workspace_directory_transport_port, 34110);
    assert_eq!(workspace_write_transport_port, 34111);
    assert_eq!(workspace_media_transport_port, 34135);
    assert_eq!(cron_transport_port, 34116);
    assert_eq!(task_manager_transport_port, 34138);
    assert_eq!(agents_transport_port, 34117);
    assert_eq!(team_public_transport_port, 34118);
    assert_eq!(fleet_transport_port, 34143);
    assert_eq!(team_role_sessions_transport_port, 34131);
    assert_eq!(team_approvals_transport_port, 34133);
    assert_eq!(team_decision_transport_port, 34139);
    assert_eq!(team_role_chat_transport_port, 34140);
    assert_eq!(team_graph_transport_port, 34120);
    assert_eq!(provider_models_transport_port, 34119);
    assert_eq!(provider_accounts_transport_port, 34134);
    assert_eq!(team_skill_transport_port, 34121);
    assert_eq!(team_trigger_transport_port, 34122);
    assert_eq!(team_lifecycle_transport_port, 34123);
    assert_eq!(manual_team_transport_port, 34125);
    assert_eq!(settings_desired_transport_port, 34127);
    assert_eq!(security_policy_transport_port, 34128);

    assert_eq!(input.matcha.bun_executable, Path::new(&root.path("bun")));
    assert_eq!(input.matcha.entry, Path::new(&root.path("app-server.mjs")));
    assert_eq!(
        input.matcha.working_directory,
        Path::new(&root.path("work"))
    );
    assert_eq!(input.matcha.storage_root, Path::new(&root.path("storage")));
    assert_eq!(input.matcha.port, 34102);
    assert_eq!(
        input.open_claw.electron_image,
        Path::new(&root.path("MatchaClaw"))
    );
    assert_eq!(
        input.open_claw.openclaw_dir,
        Path::new(&root.path("openclaw"))
    );
    assert_eq!(
        input.open_claw.subagent_template_dir,
        Path::new(&root.path("openclaw/subagents"))
    );
    assert_eq!(
        input.open_claw.entry,
        Path::new(&root.path("openclaw/openclaw.mjs"))
    );
    assert_eq!(
        input.open_claw.state_dir.as_path(),
        Path::new(&root.state_dir())
    );
    assert_eq!(input.open_claw.port, 34103);
    assert_eq!(input.open_claw.client_metadata.version(), "1.0.0");
    assert_eq!(
        input.open_claw.client_metadata.platform(),
        std::env::consts::OS
    );
    assert_eq!(input.organization_store.facts().teams().count(), 0);
    assert_eq!(input.app_log_dir, Path::new(&root.path("userdata/logs")));
    assert_eq!(input.parent_callback_base_url, "http://127.0.0.1:34100");
    assert_eq!(
        input.parent_callback_dispatch_token,
        "test-parent-dispatch-token"
    );
    assert!(format!("{webhook_token:?}").contains("[REDACTED]"));
}

#[test]
fn provisions_a_stable_private_webhook_token() {
    let root = TestRoot::new();
    let bootstrap = decode(serde_json::to_vec(&materializable_wire(&root)).unwrap()).unwrap();
    let token_path = super::super::webhook_token::path(Path::new(&root.runtime_host_state_dir()));

    let first = bootstrap.into_parts().unwrap().webhook_token;
    let stored = fs::read_to_string(&token_path).unwrap();
    assert!(first.matches(&stored));
    assert!(stored.starts_with("mctwh_"));
    assert_eq!(stored.len(), 6 + 64);

    let bootstrap = decode(serde_json::to_vec(&materializable_wire(&root)).unwrap()).unwrap();
    let second = bootstrap.into_parts().unwrap().webhook_token;
    assert!(second.matches(&stored));
    assert!(first.matches(&stored));
    assert!(!format!("{first:?}").contains(&stored));
}

#[test]
fn provisions_a_stable_private_gateway_token() {
    let root = TestRoot::new();
    let state_dir = CanonicalStateDir::provision(root.state_dir()).unwrap();
    let token_path = super::super::gateway_token::path(&state_dir);

    let bootstrap = decode(serde_json::to_vec(&materializable_wire(&root)).unwrap()).unwrap();
    let first_input = bootstrap.into_parts().unwrap().host;
    let stored = fs::read_to_string(&token_path).unwrap();
    assert_eq!(stored.len(), 64);
    assert!(format!("{:?}", first_input.open_claw_secret).contains("[REDACTED]"));
    assert!(!format!("{:?}", first_input.open_claw_secret).contains(&stored));

    let bootstrap = decode(serde_json::to_vec(&materializable_wire(&root)).unwrap()).unwrap();
    let second_input = bootstrap.into_parts().unwrap().host;
    assert_eq!(fs::read_to_string(&token_path).unwrap(), stored);
    assert!(format!("{:?}", second_input.open_claw_secret).contains("[REDACTED]"));
}

#[test]
fn rejects_corrupt_private_gateway_token_without_disclosing_it() {
    let root = TestRoot::new();
    let state_dir = CanonicalStateDir::provision(root.state_dir()).unwrap();
    let token_path = super::super::gateway_token::path(&state_dir);
    let corrupt = "gateway-private-token-must-not-leak";
    fs::write(token_path, corrupt).unwrap();

    let bootstrap = decode(serde_json::to_vec(&materializable_wire(&root)).unwrap()).unwrap();
    let error = match bootstrap.into_parts() {
        Err(error) => error,
        Ok(_) => panic!("corrupt private gateway token must be rejected"),
    };
    assert_eq!(
        error.to_string(),
        "runtime-host bootstrap configuration is invalid"
    );
    assert!(!format!("{error:?}").contains(corrupt));
}

#[cfg(unix)]
#[test]
fn rejects_a_linked_private_gateway_token() {
    use std::os::unix::fs::symlink;

    let root = TestRoot::new();
    let state_dir = CanonicalStateDir::provision(root.state_dir()).unwrap();
    let token_path = super::super::gateway_token::path(&state_dir);
    let target = root.0.join("gateway-token-target");
    fs::write(
        &target,
        "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_",
    )
    .unwrap();
    symlink(target, token_path).unwrap();

    let bootstrap = decode(serde_json::to_vec(&materializable_wire(&root)).unwrap()).unwrap();
    assert!(bootstrap.into_parts().is_err());
}

#[test]
fn rejects_corrupt_private_webhook_token_without_disclosing_it() {
    let root = TestRoot::new();
    fs::create_dir_all(root.runtime_host_state_dir()).unwrap();
    let token_path = super::super::webhook_token::path(Path::new(&root.runtime_host_state_dir()));
    let corrupt = "mctwh_not-a-valid-private-webhook-token";
    fs::write(token_path, corrupt).unwrap();

    let bootstrap = decode(serde_json::to_vec(&materializable_wire(&root)).unwrap()).unwrap();
    let error = match bootstrap.into_parts() {
        Err(error) => error,
        Ok(_) => panic!("corrupt private webhook token must be rejected"),
    };
    assert_eq!(
        error.to_string(),
        "runtime-host bootstrap configuration is invalid"
    );
    assert!(!format!("{error:?}").contains(corrupt));
}

#[cfg(unix)]
#[test]
fn rejects_a_linked_private_webhook_token() {
    use std::os::unix::fs::symlink;

    let root = TestRoot::new();
    fs::create_dir_all(root.runtime_host_state_dir()).unwrap();
    let token_path = super::super::webhook_token::path(Path::new(&root.runtime_host_state_dir()));
    let target = root.0.join("token-target");
    fs::write(
        &target,
        "mctwh_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    )
    .unwrap();
    symlink(target, token_path).unwrap();

    let bootstrap = decode(serde_json::to_vec(&materializable_wire(&root)).unwrap()).unwrap();
    assert!(bootstrap.into_parts().is_err());
}

#[test]
fn rejects_unknown_fields_and_matcha_openclaw_port_collisions() {
    let mut unknown = wire();
    unknown["unexpected"] = serde_json::Value::Bool(true);
    assert!(decode(serde_json::to_vec(&unknown).unwrap()).is_err());

    let mut injected_secret = wire();
    injected_secret["matcha"]["secret"] = serde_json::Value::String("external-secret".into());
    assert!(decode(serde_json::to_vec(&injected_secret).unwrap()).is_err());

    let mut injected_session = wire();
    injected_session["openClaw"]["session"] = serde_json::json!({ "id": "external-session" });
    assert!(decode(serde_json::to_vec(&injected_session).unwrap()).is_err());

    let mut legacy_skip_channels = wire();
    legacy_skip_channels["openClaw"]["skipChannels"] = serde_json::Value::Bool(true);
    assert!(decode(serde_json::to_vec(&legacy_skip_channels).unwrap()).is_err());

    let mut collision = wire();
    collision["openClaw"]["port"] = serde_json::Value::from(34102);
    assert!(decode(serde_json::to_vec(&collision).unwrap()).is_err());

    let mut foreign_platform_field = wire();
    #[cfg(unix)]
    {
        foreign_platform_field["matcha"]["gitBash"] =
            serde_json::Value::String(format!("{ROOT}/git-bash"));
    }
    #[cfg(windows)]
    {
        foreign_platform_field["guardianExecutable"] =
            serde_json::Value::String(format!("{ROOT}/runtime-host-guardian"));
    }
    assert!(decode(serde_json::to_vec(&foreign_platform_field).unwrap()).is_err());
}

#[test]
fn rejects_invalid_version_strings_ports_and_paths() {
    let mut unsupported_version = wire();
    unsupported_version["version"] = serde_json::Value::from(BOOTSTRAP_VERSION + 1);
    assert!(decode(serde_json::to_vec(&unsupported_version).unwrap()).is_err());

    let mut blank_version = wire();
    blank_version["appVersion"] = serde_json::Value::String(" \t".into());
    assert!(decode(serde_json::to_vec(&blank_version).unwrap()).is_err());

    let mut zero_port = wire();
    zero_port["matcha"]["port"] = serde_json::Value::from(0);
    assert!(decode(serde_json::to_vec(&zero_port).unwrap()).is_err());

    let mut relative_path = wire();
    relative_path["openClaw"]["entry"] = serde_json::Value::String("openclaw.mjs".into());
    assert!(decode(serde_json::to_vec(&relative_path).unwrap()).is_err());

    let mut nul_path = wire();
    nul_path["matcha"]["privateSecretRoot"] =
        serde_json::Value::String(format!("{ROOT}/private\0injected"));
    assert!(decode(serde_json::to_vec(&nul_path).unwrap()).is_err());

    let mut relative_app_log_dir = wire();
    relative_app_log_dir["appLogDir"] = serde_json::Value::String("userdata/logs".into());
    assert!(decode(serde_json::to_vec(&relative_app_log_dir).unwrap()).is_err());
}

#[test]
fn rejects_raw_payloads_without_disclosing_them() {
    let raw_payload = "native-bootstrap-payload-must-not-leak";
    let mut invalid = wire();
    invalid["matcha"]["privateSecretRoot"] =
        serde_json::Value::String(format!("{ROOT}/private\0{raw_payload}"));

    let error = decode(serde_json::to_vec(&invalid).unwrap())
        .err()
        .expect("invalid bootstrap payload must be rejected");

    assert_eq!(
        error.to_string(),
        "runtime-host bootstrap configuration is invalid"
    );
    assert!(!format!("{error:?}").contains(raw_payload));
}

#[test]
fn rejects_transport_port_collisions() {
    let mut task_manager_collision = wire();
    task_manager_collision["taskManagerTransportPort"] = serde_json::Value::from(34101);
    assert!(decode(serde_json::to_vec(&task_manager_collision).unwrap()).is_err());
}
