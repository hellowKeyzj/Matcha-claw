use std::{
    fs,
    io::Write,
    num::NonZeroU32,
    path::PathBuf,
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer as _, SigningKey};
use openclaw::lifecycle::state_dir::CanonicalStateDir;
use organization::{
    DeliveryLedgerSnapshot, GraphDefinition, GraphRunFacts, GraphRunId, GraphState, MemberId,
    NodeDefinition, NodeId, OrganizationFacts, RoleAssignment, RoleId, RoleKind, TeamDefinition,
    TeamFacts, TeamId, TeamMember, TeamRevision, TeamRole,
};
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

    let output = run(&home, input.as_bytes());

    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let mut responses = decode_responses(&output.stdout);
    let initialize = responses.remove(0);
    assert_eq!(initialize["id"], 1);
    assert_eq!(initialize["result"]["protocolVersion"], "2024-11-05");
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
            "team_evidence_record",
        ],
    );
    assert_eq!(
        tools["result"]["tools"][0],
        json!({
            "name": "team_node_event",
            "description": "Record an authorized TeamRun node event. Terminal complete/reject events require the exact delivery, receipt, node attempt, summary, and routed output port.",
            "inputSchema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "runId": { "type": "string", "minLength": 1 },
                    "commandId": { "type": "string", "minLength": 1 },
                    "idempotencyKey": { "type": "string", "minLength": 1 },
                    "nodeExecutionId": { "type": "string", "minLength": 1 },
                    "roleId": { "type": ["string", "null"], "minLength": 1 },
                    "event": { "enum": ["progress", "request_input", "request_approval", "complete", "reject"] },
                    "approvalAction": { "enum": ["approve", "deny", "abort"] },
                    "deliveryId": { "type": "string", "minLength": 1 },
                    "receipt": { "type": "string", "minLength": 1 },
                    "nodeId": { "type": "string", "minLength": 1 },
                    "attemptNumber": { "type": "integer", "minimum": 1 },
                    "summary": { "type": "string", "minLength": 1, "maxLength": 512 },
                    "outputPort": { "type": "string", "minLength": 1 }
                },
                "required": ["runId", "commandId", "idempotencyKey", "nodeExecutionId", "event"]
            }
        })
    );
    assert_eq!(
        tools["result"]["tools"][4],
        json!({
            "name": "team_evidence_record",
            "description": "Record an authorized opaque artifact evidence reference for a current TeamRun node execution.",
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
}

#[test]
fn records_and_replays_an_authorized_team_evidence_reference() {
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
        "label": "build output"
    });
    let input = format!(
        "{}\\n{}\\n",
        json!({
            "jsonrpc": "2.0", "id": "recorded", "method": "tools/call",
            "params": {
                "name": "team_evidence_record",
                "authorization": authorization("teamrun.evidence.record", "evidence-record"),
                "arguments": arguments
            }
        }),
        json!({
            "jsonrpc": "2.0", "id": "replayed", "method": "tools/call",
            "params": {
                "name": "team_evidence_record",
                "authorization": authorization("teamrun.evidence.record", "evidence-replay"),
                "arguments": arguments
            }
        }),
    );

    let output = run(&home, input.as_bytes());

    assert!(output.status.success());
    let responses = decode_responses(&output.stdout);
    for (response, outcome) in responses.iter().zip(["recorded", "replayed"]) {
        let result = serde_json::from_str::<Value>(
            response["result"]["content"][0]["text"].as_str().unwrap(),
        )
        .unwrap();
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

    let output = run(&home, input.as_bytes());

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
    let malformed = run(&home, b"Content-Type: application/json\r\n\r\n");

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
            "authorization": "invalid-authorization",
            "arguments": {
                "teamId": "team:one",
                "runId": "run:one",
                "view": "graph_summary",
                "unexpected": secret
            }
        }
    });
    let output = run(&home, format!("{invalid_tool}\n").as_bytes());

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
fn rejects_missing_invalid_and_replayed_mcp_authorization_without_leaking_it() {
    let home = Home::new();
    let secret = "mcp-authorization-sentinel";
    let valid = authorization("teamrun.graph.context", "context-correlation");
    let input = format!(
        "{}\n{}\n{}\n{}\n",
        json!({
            "jsonrpc": "2.0",
            "id": "missing",
            "method": "tools/call",
            "params": {
                "name": "team_graph_context",
                "arguments": { "teamId": "team:one", "runId": "run:one", "view": "graph_summary" }
            }
        }),
        json!({
            "jsonrpc": "2.0",
            "id": "invalid",
            "method": "tools/call",
            "params": {
                "name": "team_graph_context",
                "authorization": secret,
                "arguments": { "teamId": "team:one", "runId": "run:one", "view": "graph_summary" }
            }
        }),
        json!({
            "jsonrpc": "2.0",
            "id": "accepted",
            "method": "tools/call",
            "params": {
                "name": "team_graph_context",
                "authorization": valid,
                "arguments": { "teamId": "team:one", "runId": "run:one", "view": "graph_summary" }
            }
        }),
        json!({
            "jsonrpc": "2.0",
            "id": "replayed",
            "method": "tools/call",
            "params": {
                "name": "team_graph_context",
                "authorization": valid,
                "arguments": { "teamId": "team:one", "runId": "run:one", "view": "graph_summary" }
            }
        }),
    );

    let output = run(&home, input.as_bytes());

    assert!(output.status.success());
    let responses = decode_responses(&output.stdout);
    assert_eq!(
        responses[0]["error"],
        json!({ "code": -32602, "message": "Invalid params" })
    );
    assert_eq!(
        responses[1]["error"],
        json!({ "code": -32001, "message": "Unauthorized" })
    );
    assert_eq!(responses[2]["id"], "accepted");
    assert_eq!(
        responses[3]["error"],
        json!({ "code": -32001, "message": "Unauthorized" })
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains(secret));
    assert!(!String::from_utf8_lossy(&output.stderr).contains(secret));
}

#[test]
fn artifact_contains_no_store_opening_or_static_authorization_material() {
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
    assert!(source.contains("runtime_host::run_team_run_mcp"));
}

#[test]
fn rejects_terminal_event_without_authorized_resolution_fields() {
    let home = Home::new();
    let request = json!({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "tools/call",
        "params": {
            "name": "team_node_event",
            "authorization": authorization("teamrun.node.event", "terminal-command"),
            "arguments": {
                "runId": "run:one",
                "commandId": "terminal-command",
                "idempotencyKey": "terminal-key",
                "nodeExecutionId": "node:attempt:1",
                "event": "complete"
            }
        }
    });

    let output = run(&home, format!("{request}\n").as_bytes());

    assert!(output.status.success());
    let response = decode_responses(&output.stdout).remove(0);
    assert_eq!(response["error"]["code"], -32602);
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

fn run(home: &Home, input: &[u8]) -> std::process::Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_runtime-host-mcp"))
        .arg("--state-dir")
        .arg(home.0.join("state"))
        .arg("--authorization-verification-key")
        .arg(verification_key())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    child.wait_with_output().unwrap()
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

fn verification_key() -> String {
    let mut spki = vec![
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    spki.extend_from_slice(
        &SigningKey::from_bytes(&[7_u8; 32])
            .verifying_key()
            .to_bytes(),
    );
    URL_SAFE_NO_PAD.encode(spki)
}

fn authorization(capability: &str, correlation: &str) -> String {
    let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
    let payload = URL_SAFE_NO_PAD.encode(
        json!({
            "version": 1,
            "principal": "mcp-client:fixture",
            "endpoint": "stdio://teamrun-mcp",
            "scope": "teamrun:mcp",
            "capability": capability,
            "subject": "teamrun",
            "expiresAt": u64::MAX,
            "correlation": correlation,
            "revision": "revision:fixture",
        })
        .to_string(),
    );
    let signed = format!("capability-decision.v1.{payload}");
    let signature = URL_SAFE_NO_PAD.encode(signing_key.sign(signed.as_bytes()).to_bytes());
    format!("{signed}.{signature}")
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
