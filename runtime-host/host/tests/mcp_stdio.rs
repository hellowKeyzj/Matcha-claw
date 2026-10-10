use std::{
    fs,
    io::Write,
    net::TcpListener,
    num::NonZeroU32,
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use organization::{
    DeliveryLedgerSnapshot, GraphDefinition, GraphRunFacts, GraphRunId, GraphState, MemberId,
    NodeDefinition, NodeId, OrganizationFacts, RoleAssignment, RoleId, RoleKind, TeamDefinition,
    TeamFacts, TeamId, TeamMember, TeamRevision, TeamRole,
};
use platform::state_dir::CanonicalStateDir;
use serde_json::{Value, json};

static NEXT_TEST_ID: AtomicU64 = AtomicU64::new(1);

#[test]
fn serves_initialize_and_the_fixed_tool_list_over_both_framings() {
    let home = Home::new();
    let input = format!(
        "{}\nContent-Length: {}\r\n\r\n{}",
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" }),
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })
            .to_string()
            .len(),
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
    );

    let output = run(&home.0, input.as_bytes());

    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let mut responses = decode_responses(&output.stdout);
    let initialize = responses.remove(0);
    assert_eq!(initialize["id"], 1);
    assert_eq!(initialize["result"]["protocolVersion"], "2024-11-05");
    assert_eq!(initialize["result"]["serverInfo"]["name"], "matcha");
    let tools = responses.remove(0);
    assert_eq!(tools["id"], 2);
    assert_eq!(
        tools["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "team_node_event",
            "team_approval_resolve",
            "team_graph_patch",
            "team_graph_context",
            "team_run_decision_submit",
            "team_evidence_record",
            "wiki_status",
            "wiki_projects",
            "wiki_files",
            "wiki_read_file",
            "wiki_search",
            "wiki_graph",
            "wiki_rescan_sources",
            "wiki_import_source",
            "wiki_import_folder",
            "wiki_refresh_sources",
            "wiki_apply_generated_pages",
            "wiki_delete_source",
            "wiki_source_tasks",
            "wiki_embed_page",
            "wiki_retrieve_context",
        ],
    );
    assert_eq!(
        tools["result"]["tools"][0],
        json!({
            "name": "team_node_event",
            "description": "Record a legacy/manual TeamRun node event. Terminal complete/reject events are accepted only as non-scheduler evidence; runtime terminal settle remains the completion path.",
            "inputSchema": { "type": "object", "allOf": [{
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "runId": { "type": "string", "minLength": 1 },
                    "commandId": { "type": "string", "minLength": 1 },
                    "idempotencyKey": { "type": "string", "minLength": 1 },
                    "nodeExecutionId": { "type": "string", "minLength": 1 },
                    "roleId": { "type": ["string", "null"], "minLength": 1 },
                    "event": { "enum": ["progress", "request_input", "request_approval", "complete", "reject"] },
                    "approvalAction": { "enum": ["continue_node", "execute_tool", "publish_result", "external_action"] },
                    "deliveryId": { "type": "string", "minLength": 1 },
                    "receipt": { "type": "string", "minLength": 1 },
                    "nodeId": { "type": "string", "minLength": 1 },
                    "attemptNumber": { "type": "integer", "minimum": 1, "maximum": u32::MAX },
                    "summary": { "type": "string", "minLength": 1, "maxLength": 512 },
                    "outputPort": { "type": "string", "minLength": 1 }
                },
                "required": ["runId", "commandId", "idempotencyKey", "nodeExecutionId", "event"]
            }, {
                "if": { "properties": { "event": { "const": "request_approval" } }, "required": ["event"] },
                "then": { "required": ["approvalAction"] }
            }, {
                "if": { "properties": { "event": { "enum": ["complete", "reject"] } }, "required": ["event"] },
                "then": { "required": ["deliveryId", "receipt", "nodeId", "attemptNumber", "summary", "outputPort"] }
            }] }
        })
    );
    assert_eq!(
        tools["result"]["tools"][1],
        json!({
            "name": "team_approval_resolve",
            "description": "Resolve an existing TeamRun approval receipt.",
            "inputSchema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "runId": { "type": "string", "minLength": 1 },
                    "approvalId": { "type": "string", "minLength": 1 },
                    "decision": { "enum": ["approve", "deny", "abort"] },
                    "note": { "type": ["string", "null"], "minLength": 1 },
                    "idempotencyKey": { "type": "string", "minLength": 1 }
                },
                "required": ["runId", "approvalId", "decision", "idempotencyKey"]
            }
        })
    );
    let patch = &tools["result"]["tools"][2]["inputSchema"]["oneOf"];
    assert_eq!(patch.as_array().unwrap().len(), 2);
    assert_eq!(
        patch[0]["properties"]["operations"]["items"]["oneOf"]
            .as_array()
            .unwrap()
            .len(),
        5
    );
    assert_eq!(
        patch[0]["required"],
        json!([
            "teamId",
            "runId",
            "designEpoch",
            "promptGeneration",
            "expectedGraphVersion",
            "commandId",
            "idempotencyKey",
            "baseGraphId",
            "baseWorkflowPlanId",
            "operations"
        ])
    );
    assert_eq!(
        patch[1]["required"],
        json!([
            "teamId",
            "runId",
            "executionAuthority",
            "expectedGraphVersion",
            "commandId",
            "idempotencyKey",
            "operations"
        ])
    );
    assert_eq!(
        patch[1]["properties"]["operations"]["items"]["properties"]["op"],
        json!({ "const": "set_node_prompt" })
    );
    let context = &tools["result"]["tools"][3]["inputSchema"]["oneOf"];
    assert_eq!(context.as_array().unwrap().len(), 3);
    assert_eq!(
        context[0]["required"],
        json!(["teamId", "runId", "view", "executionAuthority"])
    );
    assert_eq!(
        context[0]["properties"]["view"],
        json!({ "const": "run_prompts" })
    );
    assert_eq!(context[1]["required"], json!(["teamId", "runId", "view"]));
    assert_eq!(
        context[1]["properties"]["view"]["enum"],
        json!(["current_node", "graph_summary"])
    );
    assert_eq!(
        context[2]["required"],
        json!(["teamId", "runId", "designEpoch", "promptGeneration", "view"])
    );
    for branch in patch
        .as_array()
        .unwrap()
        .iter()
        .chain(context.as_array().unwrap())
    {
        assert_eq!(branch["additionalProperties"], false);
    }
    assert_eq!(
        tools["result"]["tools"][4],
        json!({
            "name": "team_run_decision_submit",
            "description": "Submit a TeamRun continuation decision for a paused run stage.",
            "inputSchema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "runId": { "type": "string", "minLength": 1 },
                    "stageId": { "type": ["string", "null"], "minLength": 1 },
                    "decision": { "enum": ["retry", "proceed_degraded", "abort"] },
                    "note": { "type": ["string", "null"], "minLength": 1 },
                    "idempotencyKey": { "type": "string", "minLength": 1 }
                },
                "required": ["runId", "decision", "idempotencyKey"]
            }
        })
    );
    assert_eq!(
        tools["result"]["tools"][5],
        json!({
            "name": "team_evidence_record",
            "description": "Record an opaque artifact evidence reference for a current TeamRun node execution.",
            "inputSchema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "evidenceId": { "type": "string", "minLength": 1 },
                    "runId": { "type": "string", "minLength": 1 },
                    "nodeExecutionId": { "type": "string", "minLength": 1 },
                    "referenceKind": { "const": "artifact" },
                    "reference": { "type": "string", "minLength": 1 },
                    "label": { "type": ["string", "null"], "minLength": 1 }
                },
                "required": ["evidenceId", "runId", "nodeExecutionId", "referenceKind", "reference"]
            }
        })
    );
    assert_eq!(
        tools["result"]["tools"][16],
        json!({
            "name": "wiki_apply_generated_pages",
            "description": "Apply generated wiki pages for a source file.",
            "inputSchema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "sourcePath": { "type": "string", "minLength": 1 },
                    "files": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "properties": {
                                "path": { "type": "string", "minLength": 1 },
                                "content": { "type": "string" }
                            },
                            "required": ["path", "content"]
                        }
                    }
                },
                "required": ["sourcePath", "files"]
            }
        })
    );
    assert_eq!(
        tools["result"]["tools"][17]["inputSchema"],
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "sourcePath": { "type": "string", "minLength": 1 },
                "fileAlreadyDeleted": { "type": ["boolean", "null"], "default": false }
            },
            "required": ["sourcePath"]
        })
    );
}

#[test]
fn records_and_replays_a_standard_team_evidence_reference_call() {
    let home = Home::new();
    organization::OrganizationStore::open(home.0.join("state/organization-facts.log"))
        .unwrap()
        .replace_facts(evidence_run_facts())
        .unwrap();
    let arguments = json!({
        "evidenceId": "evidence:one",
        "runId": "run:one",
        "nodeExecutionId": "start:attempt:1",
        "referenceKind": "artifact",
        "reference": "artifact:one",
        "label": "build-output"
    });
    let input = format!(
        "{}\n{}\n",
        json!({
            "jsonrpc": "2.0", "id": "recorded", "method": "tools/call",
            "params": {
                "name": "team_evidence_record",
                "arguments": arguments
            }
        }),
        json!({
            "jsonrpc": "2.0", "id": "replayed", "method": "tools/call",
            "params": {
                "name": "team_evidence_record",
                "arguments": arguments
            }
        }),
    );

    let output = run_with_host(&home, input.as_bytes());

    assert!(output.status.success());
    let responses = decode_responses(&output.stdout);
    assert_eq!(responses.len(), 2);
    for (response, outcome) in responses.iter().zip(["recorded", "replayed"]) {
        assert_eq!(response["id"], outcome);
        let text = response["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or_else(|| panic!("missing tool result text: {response}"));
        let result = serde_json::from_str::<Value>(text).unwrap();
        assert_eq!(result, json!({ "outcome": outcome }));
    }
}

#[test]
fn silently_accepts_initialized_notification_and_returns_closed_errors() {
    let home = Home::new();
    let secret = "mcp-private-sentinel-must-not-leak";
    let input = format!(
        "{}\n{}\n{}\n",
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        json!({ "jsonrpc": "2.0", "id": "invalid", "method": "tools/list", "unexpected": secret }),
        json!({ "jsonrpc": "2.0", "id": "unknown", "method": "private/method" }),
    );

    let output = run(&home.0, input.as_bytes());

    assert!(output.status.success());
    let responses = decode_responses(&output.stdout);
    assert_eq!(responses.len(), 2);
    assert_eq!(responses[0]["id"], "invalid");
    assert_eq!(
        responses[0]["error"],
        json!({ "code": -32600, "message": "Invalid Request" })
    );
    assert_eq!(responses[1]["id"], "unknown");
    assert_eq!(
        responses[1]["error"],
        json!({ "code": -32601, "message": "Method not found" })
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains(secret));
    assert!(!String::from_utf8_lossy(&output.stderr).contains(secret));
}

#[test]
fn rejects_malformed_framing_and_unknown_tool_arguments_without_leaking_input() {
    let home = Home::new();
    let malformed = run(&home.0, b"Content-Type: application/json\r\n\r\n");

    assert!(malformed.status.success());
    let malformed_response = decode_responses(&malformed.stdout).remove(0);
    assert_eq!(malformed_response["id"], Value::Null);
    assert_eq!(
        malformed_response["error"],
        json!({ "code": -32600, "message": "Invalid Request" })
    );

    let secret = "mcp-strict-input-secret";
    let invalid_tool = json!({
        "jsonrpc": "2.0",
        "id": "invalid-tool",
        "method": "tools/call",
        "params": {
            "name": "team_graph_context",
            "arguments": {
                "teamId": "team:one",
                "runId": "run:one",
                "view": "graph_summary",
                "unexpected": secret
            }
        }
    });
    let output = run_with_host(&home, format!("{invalid_tool}\n").as_bytes());

    assert!(output.status.success());
    let response = decode_responses(&output.stdout).remove(0);
    assert_eq!(response["id"], "invalid-tool");
    assert_eq!(
        response["error"],
        json!({ "code": -32602, "message": "Invalid params" })
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains(secret));
    assert!(!String::from_utf8_lossy(&output.stderr).contains(secret));
}

#[test]
fn artifact_contains_no_store_opening_or_static_signing_material() {
    let source = include_str!("../src/bin/runtime-host-mcp.rs");
    for forbidden in [
        "open_organization_store",
        "OrganizationStore",
        "CanonicalStateDir",
        "CapabilityDecisionVerifier",
        "SigningKey",
    ] {
        assert!(
            !source.contains(forbidden),
            "artifact must not contain {forbidden}"
        );
    }
    assert!(source.contains("ToolCatalog::new"));
    assert!(source.contains("runtime_host::team_mcp::team_provider"));
}

#[test]
fn rejects_terminal_event_without_resolution_fields() {
    let home = Home::new();
    let request = json!({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "tools/call",
        "params": {
            "name": "team_node_event",
            "arguments": {
                "runId": "run:one",
                "commandId": "terminal-command",
                "idempotencyKey": "terminal-key",
                "nodeExecutionId": "node:attempt:1",
                "event": "complete"
            }
        }
    });

    let output = run_with_host(&home, format!("{request}\n").as_bytes());

    assert!(output.status.success());
    let response = decode_responses(&output.stdout).remove(0);
    assert_eq!(response["error"]["code"], -32602);
}

#[test]
fn terminal_node_event_is_legacy_evidence_not_completion() {
    let home = Home::new();
    let request = json!({
        "jsonrpc": "2.0",
        "id": 4,
        "method": "tools/call",
        "params": {
            "name": "team_node_event",
            "arguments": {
                "runId": "run:one",
                "commandId": "terminal-command",
                "idempotencyKey": "terminal-key",
                "nodeExecutionId": "node:attempt:1",
                "event": "complete",
                "deliveryId": "delivery:one",
                "receipt": "receipt:one",
                "nodeId": "node:one",
                "attemptNumber": 1,
                "summary": "manual evidence only",
                "outputPort": "out"
            }
        }
    });

    let output = run_with_host(&home, format!("{request}\n").as_bytes());

    assert!(output.status.success());
    let response = decode_responses(&output.stdout).remove(0);
    let text = response["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or_else(|| panic!("missing tool result text: {response}"));
    let result = serde_json::from_str::<Value>(text).unwrap();
    assert_eq!(
        result,
        json!({
            "outcome": "legacy_terminal_evidence",
            "completionPath": "runtime_terminal_settle",
            "summary": "manual evidence only",
            "outputPort": "out"
        })
    );
}

struct Home(PathBuf);

impl Home {
    fn new() -> Self {
        let ordinal = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("runtime-host-mcp-{ordinal}-{nanos}"));
        fs::create_dir(&root).unwrap();
        prepare_state_parent(&root);
        CanonicalStateDir::provision(root.join("state")).unwrap();
        Self(root)
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn run(home: &std::path::Path, input: &[u8]) -> std::process::Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_runtime-host-mcp"))
        .arg("--state-dir")
        .arg(home.join("state"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    child.wait_with_output().unwrap()
}

fn run_with_host(home: &Home, input: &[u8]) -> std::process::Output {
    use tokio::io::AsyncReadExt;

    let workspace = openclaw::workspace::WorkspaceProjectionFixture::install(&home.0);
    let listeners: [_; 3] = std::array::from_fn(|_| TcpListener::bind("127.0.0.1:0").unwrap());
    let [host_port, matcha_port, openclaw_port] =
        listeners.map(|listener| listener.local_addr().unwrap().port());
    let state = CanonicalStateDir::provision(home.0.join("openclaw-state")).unwrap();
    let mut settings = settings::DesiredState::open(state.as_path()).unwrap();
    assert_eq!(
        settings.replace(
            "mcp-test-no-autostart".into(),
            settings::Desired::try_new(
                settings::BrowserMode::Off,
                settings::ProxyDesired::default(),
                false,
                false,
            )
            .unwrap(),
        ),
        (1, None)
    );
    drop(settings);
    let host = runtime_host::HostInput {
        // Deliberately absent artifacts keep peer runtimes and model calls out of this fixture.
        matcha: runtime_host::MatchaAgentInput {
            bun_executable: home.0.join("missing-bun"),
            entry: home.0.join("missing-matcha-entry"),
            working_directory: home.0.clone(),
            storage_root: home.0.join("matcha-storage"),
            port: matcha_port,
            #[cfg(windows)]
            git_bash: home.0.join("missing-git-bash"),
            #[cfg(unix)]
            guardian_executable: home.0.join("missing-guardian"),
        },
        matcha_secret: matcha_agent::lifecycle::secret::Secret::new(
            "mcp-test-matcha-secret".into(),
        )
        .unwrap(),
        open_claw: runtime_host::OpenClawInput {
            runtime_host_mcp_executable: PathBuf::from(env!("CARGO_BIN_EXE_runtime-host-mcp")),
            runtime_host_mcp_state_dir: home.0.join("state"),
            electron_image: home.0.join("missing-electron"),
            working_directory: home.0.clone(),
            openclaw_dir: workspace.openclaw_dir().to_owned(),
            companion_skill_source_root: home.0.join("companion-skills"),
            managed_plugin_root: home.0.join("plugins"),
            subagent_template_dir: home.0.join("subagent-templates"),
            entry: workspace.openclaw_dir().join("openclaw.mjs"),
            state_dir: state,
            port: openclaw_port,
            sealed_endpoint: None,
            sealed_token: None,
            client_metadata: openclaw::gateway::client::GatewayClientMetadata::try_new(
                "test".into(),
                std::env::consts::OS.into(),
            )
            .unwrap(),
            report_diagnostic: Arc::new(|_| {}),
            #[cfg(unix)]
            guardian_executable: home.0.join("missing-guardian"),
        },
        open_claw_secret: openclaw::gateway::auth::GatewaySecret::new(
            "mcp-test-openclaw-secret".into(),
        )
        .unwrap(),
        organization_store: organization::OrganizationStore::open(
            home.0.join("state/organization-facts.log"),
        )
        .unwrap(),
        runtime_state_dir: home.0.join("state"),
        app_log_dir: home.0.join("logs"),
        parent_callback_base_url: "http://127.0.0.1:1".into(),
        parent_callback_dispatch_token: "mcp-test-parent-token".into(),
        runtime_observation: runtime_host::RuntimeObservationConfig::off(),
    };
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let (control, control_input) = tokio::io::duplex(1024);
            let (control_output, mut output) = tokio::io::duplex(8192);
            let service = tokio::spawn(runtime_host::run_app_service(runtime_host::AppInput {
                host,
                verifier: platform::capability::CapabilityDecisionVerifier::try_new(
                    "MCowBQYDK2VwAyEAhI7FT5ZzRIPEHVkZavhKl2CqMou1WrMW7b9vB7BHXoE",
                )
                .unwrap(),
                provider_credential_resolver: None,
                webhook_token: organization::adapters::loopback::trigger::WebhookToken::try_new(
                    "mctwh_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                )
                .unwrap(),
                runtime_host_transport_port: host_port,
                control_input,
                control_output,
            }));
            let ready = tokio::time::timeout(Duration::from_secs(10), async {
                let length = output.read_u32().await?;
                let mut body = vec![0; length as usize];
                output.read_exact(&mut body).await?;
                Ok::<_, std::io::Error>(serde_json::from_slice::<Value>(&body).unwrap())
            })
            .await
            .unwrap();
            let result = match ready {
                Ok(ready) => {
                    assert_eq!(ready["type"], "ready");
                    let home = home.0.clone();
                    let input = input.to_vec();
                    tokio::task::spawn_blocking(move || run(&home, &input))
                        .await
                        .unwrap()
                }
                Err(error) => panic!("Host did not become ready: {error}; {:?}", service.await),
            };
            drop(control);
            tokio::time::timeout(Duration::from_secs(10), service)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            result
        })
}

#[cfg(unix)]
fn prepare_state_parent(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

#[cfg(windows)]
fn prepare_state_parent(path: &std::path::Path) {
    use std::{
        os::windows::{
            ffi::OsStrExt,
            io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle},
        },
        ptr::{null, null_mut},
    };
    use windows_sys::Win32::{
        Foundation as F, Security as S, Security::Authorization as A, Storage::FileSystem as FS,
    };

    let name: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    let raw = unsafe {
        FS::CreateFileW(
            name.as_ptr(),
            FS::WRITE_DAC | FS::READ_CONTROL,
            FS::FILE_SHARE_READ | FS::FILE_SHARE_WRITE | FS::FILE_SHARE_DELETE,
            null(),
            FS::OPEN_EXISTING,
            FS::FILE_FLAG_BACKUP_SEMANTICS | FS::FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    assert_ne!(raw, F::INVALID_HANDLE_VALUE);
    let handle = unsafe { OwnedHandle::from_raw_handle(raw as RawHandle) };
    let sddl: Vec<u16> = "D:P(A;OICI;FA;;;OW)".encode_utf16().chain([0]).collect();
    let mut descriptor = null_mut();
    assert_ne!(
        unsafe {
            A::ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                A::SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        },
        0
    );
    let mut present = 0;
    let mut defaulted = 0;
    let mut dacl = null_mut();
    assert_ne!(
        unsafe {
            S::GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted)
        },
        0
    );
    assert_eq!(
        unsafe {
            A::SetSecurityInfo(
                handle.as_raw_handle() as F::HANDLE,
                A::SE_FILE_OBJECT,
                S::PROTECTED_DACL_SECURITY_INFORMATION | S::DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                dacl,
                null_mut(),
            )
        },
        F::ERROR_SUCCESS
    );
    unsafe { F::LocalFree(descriptor) };
}

fn evidence_run_facts() -> OrganizationFacts {
    let team_id = TeamId::try_new("team:one").unwrap();
    let graph = GraphDefinition::new(
        "graph:one",
        "plan:one",
        GraphRunId::new("run:one"),
        "Evidence graph",
        vec![NodeDefinition::start(
            NodeId::new("start"),
            "Start",
            NonZeroU32::new(1).unwrap(),
            None,
        )],
        Vec::new(),
    )
    .unwrap();
    OrganizationFacts::restore(
        vec![TeamFacts::new(
            TeamDefinition::try_new(
                team_id.clone(),
                "Team One",
                vec![
                    TeamMember::try_new(MemberId::try_new("member:leader").unwrap(), "Leader")
                        .unwrap(),
                ],
                vec![
                    TeamRole::try_new(
                        RoleId::try_new("leader").unwrap(),
                        "Leader",
                        RoleKind::Leader,
                    )
                    .unwrap(),
                ],
                vec![RoleAssignment::new(
                    MemberId::try_new("member:leader").unwrap(),
                    RoleId::try_new("leader").unwrap(),
                )],
            )
            .unwrap(),
            TeamRevision::initial(),
            false,
        )],
        [],
        [GraphRunFacts::new(
            team_id,
            TeamRevision::initial(),
            GraphState::initialize(graph, 1),
            None,
        )
        .unwrap()],
        DeliveryLedgerSnapshot::new(Vec::new()),
    )
    .unwrap()
}

fn decode_responses(bytes: &[u8]) -> Vec<Value> {
    let mut remaining = bytes;
    let mut responses = Vec::new();
    while !remaining.is_empty() {
        if remaining.starts_with(b"Content-Length: ") {
            let header_end = remaining
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .unwrap()
                + 4;
            let length = std::str::from_utf8(&remaining[16..header_end - 4])
                .unwrap()
                .parse::<usize>()
                .unwrap();
            responses
                .push(serde_json::from_slice(&remaining[header_end..header_end + length]).unwrap());
            remaining = &remaining[header_end + length..];
        } else {
            let newline = remaining.iter().position(|byte| *byte == b'\n').unwrap();
            responses.push(serde_json::from_slice(&remaining[..newline]).unwrap());
            remaining = &remaining[newline + 1..];
        }
    }
    responses
}
