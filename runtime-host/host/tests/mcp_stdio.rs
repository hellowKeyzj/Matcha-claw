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
    GraphDefinition, GraphRunId, MaterializationOperationOutcome, NodeDefinition, NodeId,
    OrganizationNativeRuntime, OrganizationRuntimeDirectory, RoleId, RuntimeEndpointReference,
    TeamId,
};
use platform::state_dir::CanonicalStateDir;
use runtime_directory::OwnedRuntimeFuture;
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
            "description": "报告当前节点进度、请求输入或请求审批，不提交节点终态；节点完成沿运行时 terminal hook 结算。\n- runId/nodeExecutionId 取本次系统注入的 <team_run_context>，或当前 Run 的 team_graph_context 脱敏结果中对应 nodes 条目的真实执行 ID；不能用 nodeId/runId 代替执行 ID，也不能沿用旧尝试的 ID。roleId 如需提供，必须取当前节点的真实角色绑定，不猜角色名。\n- progress 记录进度；request_input 使节点等待；request_approval 创建 WorkNode 审批并使节点等待，必须提供 roleId 及实际请求的 approvalAction。这不授予执行许可；已有明确人工决定后可用 team_approval_resolve 记账，再从 view=current_node 返回的 approvals 查询同一尝试的决定。记账不会自动恢复、重派或完成节点。\n- 每次新事件生成 commandId/idempotencyKey；原请求重试保留这两项及全部参数，不换键重复请求。结果未知先重读当前节点状态及 pendingApprovalIds，无法确认则报告未知。\n- 分别检查 outcome=progressed/waiting_for_input/approval_requested，再按需重读脱敏图核验；这些返回均不代表节点完成或审批通过。返回错误时按错误修正，不伪造成功。" ,
            "inputSchema": { "type": "object", "allOf": [{
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "runId": { "type": "string", "minLength": 1 },
                    "commandId": { "type": "string", "minLength": 1 },
                    "idempotencyKey": { "type": "string", "minLength": 1 },
                    "nodeExecutionId": { "type": "string", "minLength": 1 },
                    "roleId": { "type": ["string", "null"], "minLength": 1 },
                    "event": { "enum": ["progress", "request_input", "request_approval"] },
                    "approvalAction": { "enum": ["continue_node", "execute_tool", "publish_result", "external_action"] }
                },
                "required": ["runId", "commandId", "idempotencyKey", "nodeExecutionId", "event"]
            }, {
                "if": { "properties": { "event": { "const": "request_approval" } }, "required": ["event"] },
                "then": { "required": ["roleId", "approvalAction"], "properties": { "roleId": { "type": "string", "minLength": 1 } } }
            }] }
        })
    );
    assert_eq!(
        tools["result"]["tools"][1],
        json!({
            "name": "team_approval_resolve",
            "description": "提交已有 HumanDecision 或 WorkNode 审批的明确人工决定；工具调用本身不是人工授权，不能替人选择 approve/deny/abort。\n- runId 取当前 Run；approvalId 取已提供的真实审批上下文，并确认人工决定。team_graph_context 的 view=current_node 返回的 approvals 可核对当前尝试的 subject/status/decision；Run 级 pendingApprovalIds 不说明审批类型，不能据此盲批。本工具不创建审批，输入不传 subject，owner 按已持久化的审批事实分派。\n- 新决定使用新的 idempotencyKey，原请求重试保留同一键及全部参数；note 只记录真实说明，不需要时省略或 null。结果未知时先核对审批状态，不换键盲目重试。\n- 检查 outcome=recorded/replayed：HumanDecision 记录回执并结算 approved/rejected/aborted 分支；WorkNode 只记录决定，保留 KeepNodeWaiting，不自动恢复、重派、创建新尝试或完成节点，终态仍沿原运行时路径处理。可重读当前尝试 approvals 确认决定，不能仅因 pendingApprovalIds 中 ID 消失就推断批准。错误或未知结果不表示已批准，也不表示整个 Run 完成。",
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
    let patch = &tools["result"]["tools"][2]["inputSchema"];
    assert_eq!(patch["type"], "object");
    assert!(patch.get("oneOf").is_none());
    let operations = patch["properties"]["operations"]["items"]["oneOf"]
        .as_array()
        .unwrap();
    assert_eq!(operations.len(), 6);
    assert_eq!(
        patch["required"],
        json!([
            "teamId", "runId", "expectedGraphVersion", "commandId", "idempotencyKey", "operations"
        ])
    );
    assert_eq!(patch["if"], json!({
        "properties": { "operations": { "contains": {
            "type": "object", "properties": { "op": { "const": "set_node_prompt" } }, "required": ["op"]
        } } },
        "required": ["operations"]
    }));
    assert_eq!(patch["then"], json!({
        "required": ["nodeId", "nodeExecutionId"],
        "properties": {
            "designEpoch": false, "promptGeneration": false,
            "baseGraphId": false, "baseWorkflowPlanId": false,
            "operations": { "items": { "properties": { "op": { "const": "set_node_prompt" } } } }
        }
    }));
    assert_eq!(patch["else"], json!({
        "required": ["designEpoch", "promptGeneration", "baseGraphId", "baseWorkflowPlanId"],
        "properties": { "nodeId": false, "nodeExecutionId": false }
    }));
    assert_eq!(operations[5]["properties"]["op"]["const"], "set_node_prompt");
    assert_eq!(operations[5]["required"], json!(["op", "nodeId", "prompt"]));
    let edge = &patch["properties"]["operations"]["items"]["oneOf"][2]["properties"]["edge"];
    assert_eq!(edge["required"], json!(["edgeId", "sourceNodeId", "targetNodeId"]));
    let node = &patch["properties"]["operations"]["items"]["oneOf"][0]["properties"]["node"];
    assert_eq!(node["properties"]["config"]["type"], "object");
    assert!(node.get("allOf").is_none());
    let kinds = node["oneOf"].as_array().unwrap();
    assert_eq!(kinds.len(), 5);
    assert!(node["properties"].get("groupId").is_none());
    for (branch, kind, fields) in [
        (&kinds[0], json!({ "const": "start" }), vec!["trigger"]),
        (&kinds[1], json!({ "const": "work" }), vec!["outputArtifactKind", "prompt", "sessionRef"]),
        (&kinds[2], json!({ "const": "review" }), vec!["prompt", "sessionRef"]),
        (&kinds[3], json!({ "const": "script_review" }), vec!["rule"]),
        (&kinds[4], json!({ "enum": ["human_decision", "join", "end"] }), vec![]),
    ] {
        assert_eq!(branch["properties"]["kind"], kind);
        let config = &branch["properties"]["config"];
        assert_eq!(config["type"], "object");
        assert_eq!(config["additionalProperties"], false);
        let mut keys = config["properties"].as_object().unwrap().keys().map(String::as_str).collect::<Vec<_>>();
        keys.sort_unstable();
        assert_eq!(keys, fields);
    }
    for branch in [&kinds[1], &kinds[2]] {
        assert_eq!(branch["required"], json!(["roleId", "config"]));
        let config = &branch["properties"]["config"];
        assert_eq!(config["required"], json!(["prompt"]));
        assert_eq!(config["properties"]["prompt"]["minLength"], 1);
        assert_eq!(config["properties"]["sessionRef"]["pattern"], "^rs[0-9]+$");
    }
    assert_eq!(kinds[3]["required"], json!(["config"]));
    assert_eq!(kinds[3]["properties"]["config"]["required"], json!(["rule"]));
    assert_eq!(kinds[3]["properties"]["config"]["properties"]["rule"]["enum"], json!([
        "pass_through", "assert_all_upstream_completed", "assert_no_blocking_gate", "assert_artifact_exists"
    ]));
    for index in [0, 4] {
        assert_eq!(kinds[index]["properties"]["config"]["required"], json!([]));
    }
    let context = &tools["result"]["tools"][3]["inputSchema"];
    assert_eq!(context["type"], "object");
    assert!(context.get("oneOf").is_none());
    assert_eq!(context["required"], json!(["teamId", "runId", "view"]));
    assert_eq!(
        context["properties"]["view"]["enum"],
        json!(["current_node", "graph_summary", "run_prompts"])
    );
    assert_eq!(context["if"], json!({
        "properties": { "view": { "const": "run_prompts" } }, "required": ["view"]
    }));
    assert_eq!(context["then"], json!({
        "required": ["nodeId", "nodeExecutionId"],
        "properties": {
            "nodeExecutionId": { "type": "string", "minLength": 1 },
            "designEpoch": false, "promptGeneration": false
        }
    }));
    assert_eq!(context["properties"]["nodeExecutionId"]["type"], json!(["string", "null"]));
    assert_eq!(context["else"], json!({
        "properties": { "nodeId": false },
        "if": { "anyOf": [
            { "required": ["designEpoch"] },
            { "required": ["promptGeneration"] }
        ] },
        "then": { "required": ["designEpoch", "promptGeneration"] },
        "else": {
            "if": { "properties": { "view": { "const": "current_node" } }, "required": ["view"] },
            "then": {
                "required": ["nodeExecutionId"],
                "properties": { "nodeExecutionId": { "type": "string", "minLength": 1 } }
            }
        }
    }));
    for branch in [patch, context].into_iter().chain(operations) {
        assert_eq!(branch["additionalProperties"], false);
    }
    assert_eq!(
        tools["result"]["tools"][4],
        json!({
            "name": "team_run_decision_submit",
            "description": "记录 TeamRun 的 retry/proceed_degraded/abort 决策，不等于已重试、降级继续、中止或恢复执行，也不能代替人工授权或审批回执。\n- runId 取当前 Run；stageId 仅使用已提供的真实阶段标识，省略或 null 表示 run 级决定。本工具和 team_graph_context 都不提供阶段列表，不把 nodeId/nodeExecutionId 猜成 stageId。decision 按已有明确决定填写；note 不需要时省略或 null。\n- 新决定使用新的 idempotencyKey；原请求重试保持全部参数和原键，不换键绕过冲突。服务端记录时间参与决策重放比较，跨次重试不保证 replayed；结果未知时先从已有决策回执或运行状态确认，无法确认则报告未知，不盲目重提。\n- 核验 outcome=recorded/replayed、对应 recorded/replayed 标志及 sequence；这些仅证明决策记账。脱敏图只可核对实际运行状态，不能查询该决策回执或证明调度已执行。",
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
            "description": "为当前 TeamRun 节点执行登记已有产物的不透明证据引用，不上传、创建、查找产物，不验证产物实体存在，也不提交节点完成。\n- runId/nodeExecutionId 取本次 <team_run_context> 或当前 Run 脱敏上下文中对应节点的真实执行 ID，不能用 nodeId 替代或借用旧尝试。referenceKind 固定 artifact；reference 取实际产物流程已提供的标识，不猜 ID，不传文件路径、URL 或正文。这些工具不提供产物列表或引用查询；没有真实引用就不要调用。\n- evidenceId 是本条新证据的唯一标识，由调用方生成；同一登记重试保持 evidenceId 和全部字段不变。相同 ID 的不同内容会冲突，不换 ID 掩盖冲突或重复登记。label 可省略或 null；提供时也须是不透明标识，不是自由文本说明。\n- 检查 outcome=recorded/replayed，确认登记成功；错误或未知结果不能声称已保存。此返回只证明引用已记录，不能证明产物正确、节点完成或审批通过。",
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
    prepare_evidence_run(&home);
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
        assert!(response["result"].get("isError").is_none());
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
    assert!(response.get("error").is_none());
    assert_eq!(response["result"]["isError"], true);
    let result: Value = serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(
        result,
        json!({
            "success": false,
            "errorCode": "invalid_params",
            "fieldPath": "arguments",
            "error": "Remove unsupported fields; use only fields listed in this tool's input schema."
        })
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains(secret));
    assert!(!String::from_utf8_lossy(&output.stderr).contains(secret));
}

#[test]
fn artifact_contains_no_store_opening_or_static_signing_material() {
    let source = include_str!("../src/mcp/stdio.rs");
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
    assert!(source.contains("TeamRunMcpFacade::new"));
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
    assert!(response.get("error").is_none());
    assert_eq!(response["result"]["isError"], true);
    let result: Value = serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(result, json!({
        "success": false,
        "errorCode": "invalid_params",
        "fieldPath": "event",
        "error": "Use progress, request_input, or request_approval; terminal results use runtime receipts."
    }));
}

#[test]
fn rejects_removed_terminal_node_event_even_with_legacy_resolution_fields() {
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
    assert!(response.get("error").is_none());
    assert_eq!(response["result"]["isError"], true);
    let result: Value = serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(result, json!({
        "success": false,
        "errorCode": "invalid_params",
        "fieldPath": "arguments",
        "error": "Remove unsupported fields; use only fields listed in this tool's input schema."
    }));
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
    let mut child = Command::new(env!("CARGO_BIN_EXE_runtime-host"))
        .arg("mcp")
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
            runtime_host_mcp_executable: PathBuf::from(env!("CARGO_BIN_EXE_runtime-host")),
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
        organization_store: organization::open_organization_store(&home.0.join("state")).unwrap(),
        runtime_state_dir: home.0.join("state"),
        searxng_resources_dir: home.0.join("searxng"),
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
                webhook_token: organization::WebhookToken::try_new(
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

fn prepare_evidence_run(home: &Home) {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let mut system = foundation::execution::OwnerRuntimeSystem::spawn(Default::default());
            let (module, mut owner) = organization::spawn_owner(
                &system,
                organization::OrganizationOwnerInput {
                    store: organization::open_organization_store(&home.0.join("state")).unwrap(),
                    runtime_directory: Arc::new(EvidenceRuntime),
                    member_introductions: None,
                    team_skill_selections: organization::package::TeamSkillSelectionResolver::open(
                        home.0.join("state/team-skill-selections.v1.json"),
                    )
                    .unwrap(),
                },
            );
            let team_id = TeamId::try_new("team:one").unwrap();
            let run_id = GraphRunId::new("run:one");
            let materialized = module
                .handle()
                .manual_team_materialize(
                    team_id.clone(),
                    "Team One".into(),
                    RuntimeEndpointReference::try_new(
                        runtime_directory::RuntimeDriverIdentity::open_claw()
                            .runtime_endpoint_reference(),
                    )
                    .unwrap(),
                    vec![organization::ManualTeamRoleBinding::try_new(
                        RoleId::try_new("leader").unwrap(),
                        "Leader",
                        organization::ManagedAgentReference::try_new("leader").unwrap(),
                        true,
                    )
                    .unwrap()],
                    organization::IdempotencyKey::try_new("materialize:evidence").unwrap(),
                )
                .await
                .unwrap();
            assert!(matches!(
                materialized,
                organization::TeamMaterializationCommandOutcome::Materialized { .. }
            ));
            assert_eq!(
                module
                    .handle()
                    .run_create(
                        team_id,
                        run_id.clone(),
                        "create:evidence".into(),
                        organization::WorkflowPlan::new(
                            "plan:one",
                            "run:one",
                            "Evidence graph",
                            "ready",
                            vec![organization::WorkflowTask::new(
                                "evidence",
                                "leader",
                                "Evidence",
                                "Record evidence",
                                Vec::new(),
                                None,
                            )],
                            "create:evidence",
                            1,
                        ),
                        "mcp-test".into(),
                        1,
                        1,
                    )
                    .await
                    .unwrap()
                    .unwrap(),
                organization::CreateGraphRunOutcome::Created(run_id.clone()),
            );
            let graph = GraphDefinition::new(
                "graph:one",
                "plan:one",
                run_id,
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
            let saved = module
                .handle()
                .graph_save(
                    organization::RunCommand::new(
                        organization::run::event::OpaqueId::try_new("run:one").unwrap(),
                        organization::run::event::OpaqueId::try_new("save:evidence").unwrap(),
                        organization::run::event::OpaqueId::try_new("save:evidence").unwrap(),
                        organization::CommandPayload::GraphReplace(graph.clone()),
                        1,
                    ),
                    graph,
                )
                .await
                .unwrap()
                .unwrap();
            assert!(matches!(saved, organization::TeamRunCommandOutcome::OutcomeUnknown));
            owner.drain_and_join().await.unwrap();
            system.drain_and_join().await.unwrap();
        });
}

struct EvidenceRuntime;

impl OrganizationRuntimeDirectory for EvidenceRuntime {
    fn team_runtime_for_endpoint(
        &self,
        _endpoint: &RuntimeEndpointReference,
    ) -> Option<Arc<dyn OrganizationNativeRuntime>> {
        Some(Arc::new(Self))
    }

    fn open_claw_runtime(&self) -> Option<Arc<dyn OrganizationNativeRuntime>> {
        Some(Arc::new(Self))
    }
}

impl OrganizationNativeRuntime for EvidenceRuntime {
    fn materialize_team(
        &self,
        request: organization::TeamMaterializationRequest,
    ) -> OwnedRuntimeFuture<MaterializationOperationOutcome> {
        Box::pin(async move {
            let intent = request.intent();
            let [role] = intent.agents() else {
                panic!("expected one leader")
            };
            let organization::RoleMaterializationAgent::External { agent } = role.agent() else {
                panic!("expected a selected native agent")
            };
            let mut receipt = organization::RoleMaterializationReceipt::with_ownership(
                role.role().clone(),
                agent.clone(),
                organization::RoleMaterializationOwnership::External,
                intent.endpoint().clone(),
            );
            if let Some(markdown) = role.agents_markdown() {
                receipt = receipt.with_agents_markdown(markdown);
            }
            MaterializationOperationOutcome::Confirmed {
                receipt: organization::MaterializationReceipt::try_new(
                    intent.team().clone(),
                    intent.endpoint().clone(),
                    vec![receipt],
                )
                .unwrap(),
            }
        })
    }

    fn remove_team(
        &self,
        _removal: organization::TeamMaterializationRemoval,
    ) -> OwnedRuntimeFuture<MaterializationOperationOutcome> {
        panic!("unexpected team removal")
    }

    fn recover_team_materialization(
        &self,
        _request: organization::TeamMaterializationRequest,
    ) -> OwnedRuntimeFuture<MaterializationOperationOutcome> {
        panic!("unexpected materialization recovery")
    }

    fn confirm_team_run_receipt(
        &self,
        _receipt: organization::RunRuntimeReceipt,
    ) -> OwnedRuntimeFuture<organization::RuntimeReceiptOutcome> {
        panic!("unexpected native run receipt")
    }

    fn abort_role_sessions(
        &self,
        _bindings: Vec<organization::RoleSessionReceipt>,
    ) -> OwnedRuntimeFuture<organization::RoleAbortOutcome> {
        panic!("unexpected session abort")
    }

    fn delete_role_sessions(
        &self,
        _run_id: GraphRunId,
        _bindings: Vec<organization::RoleSessionReceipt>,
        _abort_first: bool,
    ) -> OwnedRuntimeFuture<organization::NativeDeletionEvidence> {
        panic!("unexpected session deletion")
    }

    fn installed_skill_names(&self) -> OwnedRuntimeFuture<Option<Vec<String>>> {
        panic!("unexpected skill lookup")
    }
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
