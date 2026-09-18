use serde_json::{Value, json, to_value};

use super::*;
use crate::organization::{
    TeamNodePromptSettledResult, TeamRuntimeCommand, TeamRuntimeCommandOutcome,
};

const TEST_UNKNOWN_CAPABILITY_MESSAGE: &str = "Capability descriptor is not available.";
const TEST_INVALID_SCOPE_MESSAGE: &str = "Capability scope is invalid.";
const TEST_SCOPE_NOT_AVAILABLE_MESSAGE: &str = "Capability scope is not available.";

fn test_native_endpoint() -> Value {
    json!({
        "kind": "native-runtime",
        "runtimeAdapterId": "openclaw",
        "runtimeInstanceId": "local",
    })
}

fn test_runtime_instance_scope() -> Value {
    json!({
        "kind": "runtime-instance",
        "endpoint": test_native_endpoint(),
    })
}

fn test_agent_scope(agent_id: &str) -> Value {
    json!({
        "kind": "agent",
        "endpoint": test_native_endpoint(),
        "agentId": agent_id,
    })
}

fn test_matcha_runtime_instance_scope() -> Value {
    json!({
        "kind": "runtime-instance",
        "endpoint": {
            "kind": "native-runtime",
            "runtimeAdapterId": "matcha-agent",
            "runtimeInstanceId": "local",
        },
    })
}

fn test_runtime_endpoint() -> organization::RuntimeEndpointReference {
    organization::RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap()
}

#[test]
fn team_runtime_facade_accepts_peer_runtime_scopes_without_changing_other_native_capabilities() {
    assert!(is_team_runtime_facade_scope(&test_runtime_instance_scope()));
    assert!(is_team_runtime_facade_scope(
        &test_matcha_runtime_instance_scope()
    ));
    assert!(is_native_runtime_scope(&test_runtime_instance_scope()));
    assert!(!is_native_runtime_scope(
        &test_matcha_runtime_instance_scope()
    ));
}

#[test]
fn control_payload_decoders_keep_private_lifecycle_dtos() {
    for payload in [
        CommandInput(serde_json::Value::Null),
        CommandInput(json!({})),
        CommandInput(json!({ "mode": "default", "extra": true })),
        CommandInput(json!({ "mode": "bypassPermissions" })),
    ] {
        assert!(matches!(
            decode::<ToolPermissionModeRequest>(payload),
            Err(InvalidPayload)
        ));
    }
    assert_eq!(
        decode::<ToolPermissionModeRequest>(CommandInput(json!({ "mode": "fullAccess" })))
            .unwrap()
            .mode,
        crate::facade::ToolPermissionMode::FullAccess,
    );
}

#[test]
fn graph_context_decode_requires_node_execution_id_only_for_current_node_view() {
    let target = json!({ "kind": "team-run", "teamId": "team:one", "runId": "run:one" });
    let current = team_runtime_command(
        "team.graphContext",
        &target,
        &json!({
            "teamId": "team:one",
            "runId": "run:one",
            "view": "currentNode",
            "nodeExecutionId": "node:attempt:1",
        }),
        test_runtime_endpoint(),
    )
    .unwrap();
    assert!(matches!(
        current,
        TeamRuntimeCommand::GraphContext {
            view: organization::TeamGraphContextView::CurrentNode,
            node_execution_id: Some(node_execution_id),
            ..
        } if node_execution_id == "node:attempt:1"
    ));

    let summary = team_runtime_command(
        "team.graphContext",
        &target,
        &json!({
            "teamId": "team:one",
            "runId": "run:one",
            "view": "graph_summary",
        }),
        test_runtime_endpoint(),
    )
    .unwrap();
    assert!(matches!(
        summary,
        TeamRuntimeCommand::GraphContext {
            view: organization::TeamGraphContextView::GraphSummary,
            node_execution_id: None,
            ..
        }
    ));

    for input in [
        json!({
            "teamId": "team:one",
            "runId": "run:one",
            "view": "current_node",
        }),
        json!({
            "teamId": "team:one",
            "runId": "run:one",
            "view": "graphSummary",
            "nodeExecutionId": "node:attempt:1",
        }),
    ] {
        assert!(
            team_runtime_command(
                "team.graphContext",
                &target,
                &input,
                test_runtime_endpoint()
            )
            .is_err()
        );
    }
}

#[test]
fn graph_patch_decode_bounds_command_identity_for_renderer_keys() {
    let key = "graph-patch:0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz012345";
    let command = team_runtime_command(
        "team.graphPatch",
        &json!({ "kind": "team-run", "runId": "run:one" }),
        &json!({
            "runId": "run:one",
            "summary": "graph_patch",
            "idempotencyKey": key,
            "patch": {
                "baseGraphId": "graph:one",
                "baseWorkflowPlanId": "workflow:one",
                "operations": [{ "op": "remove_node", "nodeId": "node:old" }],
            },
        }),
        test_runtime_endpoint(),
    )
    .unwrap();

    assert!(matches!(
        command,
        TeamRuntimeCommand::GraphPatch { patch }
            if patch.command_id.as_str().starts_with("graph-patch:")
                && patch.command_id.as_str() != format!("graph-patch:{key}")
                && patch.command_id.as_str().len() <= 128
    ));
}

#[test]
fn graph_export_yaml_projection_includes_download_file_name() {
    let outcome = team_runtime_outcome(
        TeamRuntimeCommandOutcome::GraphExportYaml(Ok("nodes: []".to_owned())),
        Some("team:one"),
        Some("run:one"),
    );
    let value = to_value(outcome).unwrap();
    assert_eq!(value["kind"], "succeeded");
    assert_eq!(value["result"]["runId"], "run:one");
    assert_eq!(value["result"]["fileName"], "run:one.yaml");
    assert_eq!(value["result"]["yaml"], "nodes: []");
}

#[test]
fn team_resume_unknown_projects_unknown_without_changing_legacy_result_payload() {
    let outcome = team_runtime_outcome(
        TeamRuntimeCommandOutcome::Resume {
            team_id: organization::TeamId::try_new("team:one").unwrap(),
            outcomes: vec![organization::ResumeOutcome::OutcomeUnknown(
                organization::GraphRunId::new("run:one"),
            )],
            runs: vec![],
        },
        Some("team:one"),
        None,
    );

    assert_eq!(
        to_value(outcome).unwrap(),
        json!({
            "kind": "unknown",
            "result": {
                "success": true,
                "teamId": "team:one",
                "restoredRunIds": ["run:one"],
                "activeRunIds": [],
                "skippedTerminalRunIds": [],
                "runs": [],
            },
        })
    );
}

#[test]
fn team_run_snapshot_unavailable_sections_use_legacy_camel_case_names() {
    use organization::run::public_projection::TeamRunPublicUnavailableSection;

    assert_eq!(
        [
            TeamRunPublicUnavailableSection::NodeInputStates,
            TeamRunPublicUnavailableSection::Roles,
            TeamRunPublicUnavailableSection::Stages,
            TeamRunPublicUnavailableSection::WorkflowPlan,
            TeamRunPublicUnavailableSection::DispatchGroups,
            TeamRunPublicUnavailableSection::DispatchTasks,
            TeamRunPublicUnavailableSection::Dispatches,
            TeamRunPublicUnavailableSection::DispatchExecutions,
            TeamRunPublicUnavailableSection::Messages,
            TeamRunPublicUnavailableSection::NodePromptDeliveries,
            TeamRunPublicUnavailableSection::Gates,
            TeamRunPublicUnavailableSection::Kickbacks,
        ]
        .map(team_public_unavailable_section_name),
        [
            "nodeInputStates",
            "roles",
            "stages",
            "workflowPlan",
            "dispatchGroups",
            "dispatchTasks",
            "dispatches",
            "dispatchExecutions",
            "messages",
            "nodePromptDeliveries",
            "gates",
            "kickbacks",
        ]
    );
}

#[test]
fn node_prompt_settled_decode_requires_null_target_and_preserves_prompt_identity() {
    for phase in ["final", "error", "aborted"] {
        let command = team_runtime_command(
            "team.nodePromptSettled",
            &Value::Null,
            &json!({
                "sessionKey": "session:one",
                "promptRunId": "prompt:one",
                "phase": phase,
            }),
            test_runtime_endpoint(),
        )
        .unwrap();
        assert!(matches!(
            command,
            TeamRuntimeCommand::NodePromptSettled {
                session_key,
                prompt_run_id,
                ..
            } if session_key.as_str() == "session:one"
                && prompt_run_id.as_str() == "prompt:one"
        ));
    }

    for (target, input) in [
        (
            json!({ "kind": "team-run", "runId": "run:one" }),
            json!({
                "sessionKey": "session:one",
                "promptRunId": "prompt:one",
                "phase": "final",
            }),
        ),
        (
            json!({ "kind": "none" }),
            json!({
                "sessionKey": "session:one",
                "promptRunId": "prompt:one",
                "phase": "final",
            }),
        ),
        (
            Value::Null,
            json!({
                "runId": "run:one",
                "sessionKey": "session:one",
                "promptRunId": "prompt:one",
                "phase": "final",
            }),
        ),
    ] {
        assert!(
            team_runtime_command(
                "team.nodePromptSettled",
                &target,
                &input,
                test_runtime_endpoint()
            )
            .is_err()
        );
    }
}

#[test]
fn node_prompt_settled_outcome_advances_without_node_event_completion() {
    let outcome = team_runtime_outcome(
        TeamRuntimeCommandOutcome::NodePromptSettled(Ok(TeamNodePromptSettledResult::Recorded(
            organization::GraphRunId::new("run:one"),
        ))),
        None,
        Some("run:one"),
    );

    assert_eq!(
        to_value(outcome).unwrap(),
        json!({
            "kind": "succeeded",
            "result": {
                "settled": true,
                "runId": "run:one",
                "snapshot": null,
            },
        })
    );
}

#[test]
fn team_run_decision_decode_accepts_supported_decisions() {
    for (value, expected) in [
        ("retry", organization::TeamDecisionType::Retry),
        (
            "proceed_degraded",
            organization::TeamDecisionType::ProceedDegraded,
        ),
        ("abort", organization::TeamDecisionType::Abort),
    ] {
        let command = team_runtime_command(
            "team.runDecisionSubmit",
            &json!({ "kind": "team-run", "runId": "run:one" }),
            &json!({
                "runId": "run:one",
                "decision": value,
                "idempotencyKey": format!("decision:{value}"),
            }),
            test_runtime_endpoint(),
        )
        .unwrap();
        assert!(matches!(
            command,
            TeamRuntimeCommand::RunDecisionSubmit { decision, .. } if decision == expected
        ));
    }
}

#[test]
fn capabilities_list_is_complete_and_uses_one_fixed_descriptor_source() {
    let outcome = to_value(crate::capabilities::directory::list()).unwrap();
    assert_eq!(outcome["kind"], "succeeded");
    let capabilities = outcome["result"]["capabilities"].as_array().unwrap();
    assert_eq!(
        capabilities
            .iter()
            .map(|value| value["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec![
            "integration.channel",
            "openclaw.browser",
            "openclaw.mcpApp",
            "plugin.runtime",
            "provider.routing",
            "scheduler.cron",
            "skill.management",
            "subagent.management",
            "subagent.skills",
            "subagent.tools",
            "team.runtime",
        ]
    );
    for descriptor in capabilities {
        assert_eq!(descriptor["runtimeAdapterId"], "openclaw");
        assert_eq!(descriptor["runtimeInstanceId"], "local");
        assert_eq!(descriptor["supportLevel"], "native");
        assert_eq!(descriptor["availability"], "available");
        assert!(descriptor["operations"].is_array());
    }
    let browser = &capabilities[1];
    assert_eq!(browser["kind"], "openclaw-browser");
    assert_eq!(operation_ids(browser), vec!["browser.request"]);
    let mcp_app = &capabilities[2];
    assert_eq!(mcp_app["kind"], "openclaw-mcp-app");
    assert_eq!(operation_ids(mcp_app), vec!["mcp.app.*"]);
    assert_eq!(capabilities[8]["scope"]["agentId"], "main");
    assert_eq!(capabilities[5]["operations"].as_array().unwrap().len(), 5);
    for private in [
        "token",
        "secret",
        "argv",
        "path",
        "rawPayload",
        "sessionKey",
        "private-session-id",
        "provider metadata",
    ] {
        assert!(!outcome.to_string().contains(private));
    }
}

#[test]
fn capabilities_describe_reuses_list_descriptors_and_validates_scope() {
    let listed =
        to_value(crate::capabilities::directory::list()).unwrap()["result"]["capabilities"].clone();
    for descriptor in listed.as_array().unwrap() {
        let outcome = to_value(crate::capabilities::directory::describe(CommandInput(
            json!({
                "id": descriptor["id"].clone(),
                "scope": descriptor["scope"].clone(),
            }),
        )))
        .unwrap();
        assert_eq!(outcome["kind"], "succeeded");
        assert_eq!(outcome["result"]["capability"], *descriptor);
    }

    let unknown = to_value(crate::capabilities::directory::describe(CommandInput(
        json!({
            "id": "unknown.capability",
            "scope": test_runtime_instance_scope(),
        }),
    )))
    .unwrap();
    assert_eq!(unknown["error"]["code"], "INVALID_INPUT");
    assert_eq!(unknown["error"]["message"], TEST_UNKNOWN_CAPABILITY_MESSAGE);

    let wrong_scope = to_value(crate::capabilities::directory::describe(CommandInput(
        json!({
            "id": "scheduler.cron",
            "scope": test_agent_scope("main"),
        }),
    )))
    .unwrap();
    assert_eq!(
        wrong_scope["error"]["message"],
        TEST_SCOPE_NOT_AVAILABLE_MESSAGE
    );

    for input in [
        serde_json::Value::Null,
        json!({ "id": "", "scope": test_runtime_instance_scope() }),
        json!({
            "id": "scheduler.cron",
            "scope": test_runtime_instance_scope(),
            "unexpected": true,
        }),
        json!({
            "id": "scheduler.cron",
            "scope": test_runtime_instance_scope(),
            "method": "POST",
        }),
        json!({
            "id": "scheduler.cron",
            "scope": test_runtime_instance_scope(),
            "route": "/api/capabilities/describe",
            "payload": {},
        }),
        json!({
            "id": "scheduler.cron",
            "scope": test_runtime_instance_scope(),
            "token": "must-be-rejected",
        }),
    ] {
        let outcome = to_value(crate::capabilities::directory::describe(CommandInput(
            input,
        )))
        .unwrap();
        assert_eq!(outcome["error"]["code"], "INVALID_INPUT");
        assert_eq!(outcome["error"]["message"], INVALID_INPUT_MESSAGE);
    }

    for scope in [
        serde_json::Value::Null,
        json!({ "kind": "runtime-instance", "endpoint": {} }),
        json!({
            "kind": "runtime-instance",
            "endpoint": test_native_endpoint(),
            "private": true,
        }),
        json!({
            "kind": "workspace",
            "endpoint": test_native_endpoint(),
            "workspaceId": null,
        }),
        json!({
            "kind": "team-run",
            "endpoint": test_native_endpoint(),
        }),
        json!({
            "kind": "session",
            "identity": {
                "endpoint": test_native_endpoint(),
                "agentId": "main",
            },
        }),
    ] {
        let outcome = to_value(crate::capabilities::directory::describe(CommandInput(
            json!({
                "id": "scheduler.cron",
                "scope": scope,
            }),
        )))
        .unwrap();
        assert_eq!(outcome["error"]["code"], "INVALID_INPUT");
        assert_eq!(outcome["error"]["message"], TEST_INVALID_SCOPE_MESSAGE);
    }

    for scope in [
        json!({ "kind": "app" }),
        json!({
            "kind": "runtime-instance",
            "endpoint": {
                "kind": "protocol-connector",
                "protocolId": "protocol",
                "connectorId": "connector",
                "endpointId": "endpoint",
            },
        }),
        json!({
            "kind": "workspace",
            "endpoint": test_native_endpoint(),
            "sourceId": "source",
        }),
        json!({
            "kind": "team-run",
            "endpoint": test_native_endpoint(),
            "runId": "run",
        }),
        json!({
            "kind": "session",
            "identity": {
                "endpoint": test_native_endpoint(),
                "agentId": "main",
                "sessionKey": "session",
            },
        }),
    ] {
        let outcome = to_value(crate::capabilities::directory::describe(CommandInput(
            json!({
                "id": "unknown.capability",
                "scope": scope,
            }),
        )))
        .unwrap();
        assert_eq!(outcome["error"]["message"], TEST_UNKNOWN_CAPABILITY_MESSAGE);
    }
}

#[test]
fn descriptor_operations_have_reachable_execute_or_transport_paths() {
    let capabilities =
        to_value(crate::capabilities::directory::list()).unwrap()["result"]["capabilities"]
            .as_array()
            .unwrap()
            .clone();
    let channel = capabilities
        .iter()
        .find(|descriptor| descriptor["id"] == "integration.channel")
        .unwrap();
    assert_eq!(
        operation_ids(channel),
        vec![
            "channels.catalog.read",
            "channels.configure",
            "channels.config.read",
            "channels.credentials.validate",
            "channels.config.delete",
            "channels.runtime.control",
            "channels.login",
            "channels.pairing.list",
            "channels.pairing.approve",
            "channels.status.read",
            "channels.snapshot.read",
        ]
    );
    assert_eq!(channel["routeOwnerId"], "openclaw");

    let browser = capabilities
        .iter()
        .find(|descriptor| descriptor["id"] == "openclaw.browser")
        .unwrap();
    assert_eq!(operation_ids(browser), vec!["browser.request"]);
    assert_eq!(browser["routeOwnerId"], "openclaw");
    assert_eq!(browser["targetKinds"], json!(["none"]));

    let mcp_app = capabilities
        .iter()
        .find(|descriptor| descriptor["id"] == "openclaw.mcpApp")
        .unwrap();
    assert_eq!(operation_ids(mcp_app), vec!["mcp.app.*"]);
    assert_eq!(mcp_app["routeOwnerId"], "openclaw");
    assert_eq!(mcp_app["targetKinds"], json!(["none"]));

    let cron = capabilities
        .iter()
        .find(|descriptor| descriptor["id"] == "scheduler.cron")
        .unwrap();
    for operation in [
        "cron.trigger",
        "cron.create",
        "cron.update",
        "cron.delete",
        "cron.toggle",
    ] {
        assert!(operation_ids(cron).contains(&operation));
    }
    assert_eq!(cron["routeOwnerId"], "operations");
    assert_eq!(cron["targetKinds"], json!(["cron-job"]));

    let skill = capabilities
        .iter()
        .find(|descriptor| descriptor["id"] == "skill.management")
        .unwrap();
    assert_eq!(
        operation_ids(skill),
        vec![
            "skills.refreshStatus",
            "skills.updateConfig",
            "skills.updateState",
            "skills.updateBatchState",
            "skills.exportBundles",
            "skills.importBundles",
            "clawhub.openReadme",
            "clawhub.openPath",
        ]
    );
    assert_eq!(skill["routeOwnerId"], "openclaw");

    for (operation, target, input) in [
        ("skills.refreshStatus", json!({ "kind": "none" }), json!({})),
        (
            "skills.updateConfig",
            json!({ "kind": "skill", "skillId": "browser-flow", "slug": "browser-flow" }),
            json!({ "skillKey": "browser-flow", "apiKey": "key", "env": {} }),
        ),
        (
            "skills.updateState",
            json!({ "kind": "skill", "skillId": "browser-flow", "slug": "browser-flow" }),
            json!({ "skillKey": "browser-flow", "enabled": true }),
        ),
        (
            "skills.updateBatchState",
            json!({ "kind": "skill" }),
            json!({ "skillKeys": ["browser-flow"], "enabled": false }),
        ),
        (
            "skills.exportBundles",
            json!({ "kind": "skill-bundle" }),
            json!({ "skillKeys": ["browser-flow"] }),
        ),
        (
            "skills.importBundles",
            json!({ "kind": "skill-bundle" }),
            json!({ "skillBundles": [{ "skillKey": "browser-flow", "files": [{ "path": "SKILL.md", "content": "---\nname: browser-flow\ndescription: Browser flow\n---\n" }] }] }),
        ),
        (
            "clawhub.openReadme",
            json!({ "kind": "skill", "skillId": "browser-flow", "slug": "browser-flow" }),
            json!({ "skillKey": "browser-flow" }),
        ),
        (
            "clawhub.openPath",
            json!({ "kind": "skill", "skillId": "browser-flow", "slug": "browser-flow" }),
            json!({ "skillKey": "browser-flow" }),
        ),
    ] {
        assert!(
            is_skill_capability_request(operation, &target, &input),
            "skill operation must reach execute branch: {operation}"
        );
    }
    assert!(is_skill_capability_request(
        "skills.updateState",
        &json!({ "kind": "skill", "skillId": "Excel XLSX", "slug": "excel-xlsx" }),
        &json!({ "skillKey": "Excel XLSX", "enabled": true })
    ));
    assert!(is_skill_capability_request(
        "skills.updateBatchState",
        &json!({ "kind": "skill" }),
        &json!({ "skillKeys": ["Excel XLSX"], "enabled": true })
    ));
    assert!(is_skill_capability_request(
        "clawhub.openReadme",
        &json!({ "kind": "skill", "skillId": "Excel XLSX", "slug": "excel-xlsx" }),
        &json!({ "skillKey": "Excel XLSX", "slug": "excel-xlsx" })
    ));
    assert!(is_skill_capability_request(
        "clawhub.openPath",
        &json!({ "kind": "skill", "skillId": "vendor/foo" }),
        &json!({ "skillKey": "vendor/foo" })
    ));
    assert!(!is_skill_capability_request(
        "clawhub.openPath",
        &json!({ "kind": "skill", "skillId": "browser-flow", "slug": "browser-flow" }),
        &json!({ "skillKey": "browser-flow", "filePath": "SKILL.md" })
    ));
    assert!(!is_skill_capability_request(
        "clawhub.openPath",
        &json!({ "kind": "skill", "skillId": "browser-flow", "slug": "browser-flow" }),
        &json!({ "skillKey": "browser-flow", "filePath": "C:/skills/browser-flow/README.md" })
    ));
    assert!(!is_skill_capability_request(
        "clawhub.openPath",
        &json!({ "kind": "skill", "skillId": "browser-flow", "slug": "browser-flow" }),
        &json!({ "skillKey": "browser-flow", "baseDir": "relative/path" })
    ));
    assert!(!is_skill_capability_request(
        "skills.refreshStatus",
        &json!({ "kind": "skill" }),
        &json!({})
    ));

    let plugin = capabilities
        .iter()
        .find(|descriptor| descriptor["id"] == "plugin.runtime")
        .unwrap();
    assert_eq!(operation_ids(plugin), vec!["plugins.setEnabled"]);
    assert_eq!(plugin["routeOwnerId"], "openclaw");
    assert!(is_plugin_target(
        &json!({ "kind": "plugin", "pluginId": "browser-relay" }),
        &json!({ "pluginIds": ["browser-relay"], "enabled": true }),
    ));
}

#[test]
fn native_skill_bundle_import_decoder_requires_the_openclaw_bundle_contract() {
    assert!(
        decode_skill_bundles(&json!({
            "skillBundles": [{
                "skillKey": "browser-flow",
                "files": [{
                    "path": "SKILL.md",
                    "content": "---\nname: browser-flow\ndescription: Browser flow\n---\n",
                }],
            }],
        }))
        .is_some()
    );
    for input in [
        json!({ "skillBundles": [] }),
        json!({ "skillBundles": [{ "skillKey": "browser-flow", "files": [{ "path": "SKILL.md", "content": "body" }] }] }),
        json!({ "skillBundles": [{ "skillKey": "browser-flow", "files": [{ "path": "../SKILL.md", "content": "---\nname: browser-flow\ndescription: Browser flow\n---\n" }] }] }),
        json!({ "skillBundles": [{ "skillKey": "browser-flow", "files": [{ "path": ".matchaclaw-managed", "content": "browser-flow\nmanaged\n" }, { "path": "SKILL.md", "content": "---\nname: browser-flow\ndescription: Browser flow\n---\n" }] }] }),
    ] {
        assert!(
            decode_skill_bundles(&input).is_none(),
            "invalid bundle passed: {input}"
        );
    }
}

fn operation_ids(descriptor: &Value) -> Vec<&str> {
    descriptor["operations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|operation| operation["id"].as_str().unwrap())
        .collect()
}

#[test]
fn openclaw_browser_and_mcp_app_decode_strict_private_dtos() {
    let browser = decode_browser_request(CommandInput(json!({
        "method": "GET",
        "path": "/session/view",
        "query": { "profile": "chrome" },
        "body": { "viewId": "view-1" },
        "timeoutMs": 1000,
        "target": "node",
        "node": "browser-node-1",
    })))
    .unwrap();
    assert_eq!(browser.method, "GET");
    assert_eq!(browser.path, "/session/view");
    assert_eq!(browser.query, Some(json!({ "profile": "chrome" })));
    assert_eq!(browser.body, Some(json!({ "viewId": "view-1" })));
    assert_eq!(browser.timeout_ms, Some(1000));
    assert_eq!(browser.target, Some("node".into()));
    assert_eq!(browser.node, Some("browser-node-1".into()));

    let mcp = decode_mcp_app_request(CommandInput(json!({
        "operationId": "mcp.app.open",
        "sessionKey": "agent:main:session-1",
        "viewId": "view-1",
        "standalone": true,
    })))
    .unwrap();
    assert_eq!(mcp.operation_id, "mcp.app.open");
    assert_eq!(mcp.session_key, "agent:main:session-1");
    assert_eq!(mcp.view_id, "view-1");
    assert_eq!(mcp.standalone, Some(true));

    for input in [
        json!({ "method": "GET", "path": "/session/view", "target": null }),
        json!({ "method": "GET", "path": "/session/view", "target": "worker" }),
        json!({ "method": "GET", "path": "/session/view", "node": "browser-node-1" }),
        json!({ "method": "GET", "path": "/session/view", "query": [] }),
        json!({ "method": "GET", "path": "/session/view", "timeoutMs": -1 }),
        json!({ "method": "GET", "path": "/session/view", "timeoutMs": 0 }),
        json!({ "method": "", "path": "/session/view" }),
        json!({ "method": "GET\n", "path": "/session/view" }),
        json!({ "method": "GET", "path": " " }),
    ] {
        assert!(matches!(
            decode_browser_request(CommandInput(input)),
            Err(InvalidPayload)
        ));
    }
    for input in [
        json!({ "operationId": "mcp.other", "sessionKey": "agent:main:session-1", "viewId": "view-1" }),
        json!({ "operationId": "mcp.app.open", "sessionKey": "agent:main:session-1", "viewId": "view-1", "body": {} }),
        json!({ "operationId": "mcp.app.open", "sessionKey": "agent:main:session-1", "viewId": "view-1", "standalone": "yes" }),
        json!({ "operationId": "mcp.app.open", "sessionKey": "", "viewId": "view-1" }),
    ] {
        assert!(matches!(
            decode_mcp_app_request(CommandInput(input)),
            Err(InvalidPayload)
        ));
    }
}

#[test]
fn team_legacy_placeholder_paths_are_fixed_empty_values() {
    assert_eq!(team::TEAM_PUBLIC_PLACEHOLDER_PATH, "");
}

#[test]
fn team_role_binding_projection_redacts_session_identity() {
    let binding = organization::RoleSessionReceipt::with_endpoint_session_id(
        organization::TeamId::try_new("team:one").unwrap(),
        organization::GraphRunId::new("run:one"),
        organization::RoleId::try_new("leader").unwrap(),
        organization::RoleSessionRef::try_new("rs0").unwrap(),
        organization::EndpointSessionId::try_new("native-session:secret").unwrap(),
        organization::ManagedAgentReference::try_new("agent:leader").unwrap(),
        organization::RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap(),
    );

    let value = team::team_role_binding_legacy_json(&binding).unwrap();
    assert_eq!(
        value,
        json!({
            "teamId": "team:one",
            "runId": "run:one",
            "roleId": "leader",
            "sessionRef": "rs0",
            "status": "available",
        })
    );
    let serialized = value.to_string();
    for private in [
        "endpointRef",
        "localSessionId",
        "endpointSessionId",
        "sessionIdentity",
        "sessionKey",
        "agentId",
        "agent:leader",
        "native",
        "endpoint:openclaw",
    ] {
        assert!(!serialized.contains(private));
    }
}

#[test]
fn team_run_snapshot_roles_use_safe_session_projection() {
    let facts = team_snapshot_facts();
    let snapshot = match organization::run::public_projection::query_team_run_public_snapshot(
        &facts,
        &organization::TeamId::try_new("team:one").unwrap(),
        &organization::GraphRunId::new("run:one"),
    ) {
        organization::run::public_projection::TeamRunPublicSnapshotQueryOutcome::Available(
            snapshot,
        ) => snapshot,
        organization::run::public_projection::TeamRunPublicSnapshotQueryOutcome::Unavailable(_) => {
            panic!("expected team run public snapshot")
        }
    };
    let sessions = match organization::query_team_role_sessions(
        &facts,
        &organization::TeamId::try_new("team:one").unwrap(),
    ) {
        organization::TeamRoleSessionQueryOutcome::Available(sessions) => sessions,
        organization::TeamRoleSessionQueryOutcome::Unavailable
        | organization::TeamRoleSessionQueryOutcome::OutcomeUnknown => {
            panic!("expected team role session projection")
        }
    };

    let outcome = team_runtime_outcome(
        TeamRuntimeCommandOutcome::RunSnapshot {
            snapshot:
                organization::run::public_projection::TeamRunPublicSnapshotQueryOutcome::Available(
                    snapshot,
                ),
            role_sessions: Some(sessions),
        },
        Some("team:one"),
        Some("run:one"),
    );
    let value = to_value(outcome).unwrap();

    assert_eq!(value["kind"], "succeeded");
    assert_eq!(
        value["result"]["roles"],
        json!([{
            "teamId": "team:one",
            "runId": "run:one",
            "roleId": "writer",
            "sessionRef": "rs0",
            "status": "available",
        }])
    );
    let serialized = value.to_string();
    for private in [
        "endpointRef",
        "localSessionId",
        "endpointSessionId",
        "sessionIdentity",
        "sessionKey",
        "agentId",
        "private-agent-secret",
        "external-session-secret",
        "private-runtime-endpoint",
        "native",
    ] {
        assert!(!serialized.contains(private));
    }
}

fn team_snapshot_facts() -> organization::OrganizationFacts {
    organization::OrganizationFacts::restore(
        vec![organization::TeamFacts::new(
            team_snapshot_definition(),
            organization::TeamRevision::initial(),
            false,
        )],
        vec![team_snapshot_materialization()],
        vec![
            organization::GraphRunFacts::new(
                organization::TeamId::try_new("team:one").unwrap(),
                organization::TeamRevision::initial(),
                team_snapshot_graph(),
                Some(team_snapshot_runtime()),
            )
            .unwrap(),
        ],
        organization::DeliveryLedger::default().snapshot(),
    )
    .unwrap()
}

fn team_snapshot_definition() -> organization::TeamDefinition {
    let leader = organization::TeamMember::try_new(
        organization::MemberId::try_new("member:leader").unwrap(),
        "Leader",
    )
    .unwrap();
    let writer = organization::TeamMember::try_new(
        organization::MemberId::try_new("member:writer").unwrap(),
        "Writer",
    )
    .unwrap();
    let leader_role = organization::TeamRole::try_new(
        organization::RoleId::try_new("leader").unwrap(),
        "Leader",
        organization::RoleKind::Leader,
    )
    .unwrap();
    let writer_role = organization::TeamRole::try_new(
        organization::RoleId::try_new("writer").unwrap(),
        "Writer",
        organization::RoleKind::Member,
    )
    .unwrap();
    organization::TeamDefinition::try_new(
        organization::TeamId::try_new("team:one").unwrap(),
        "Test team",
        vec![leader.clone(), writer.clone()],
        vec![leader_role.clone(), writer_role.clone()],
        vec![
            organization::RoleAssignment::new(
                leader.member_id().clone(),
                leader_role.role_id().clone(),
            ),
            organization::RoleAssignment::new(
                writer.member_id().clone(),
                writer_role.role_id().clone(),
            ),
        ],
    )
    .unwrap()
}

fn team_snapshot_graph() -> organization::GraphState {
    organization::GraphState::initialize(
        organization::GraphDefinition::new(
            "graph:one",
            "plan:one",
            organization::GraphRunId::new("run:one"),
            "Snapshot graph",
            vec![
                organization::NodeDefinition::start(
                    organization::NodeId::new("start"),
                    "Start",
                    std::num::NonZeroU32::new(1).unwrap(),
                    None,
                ),
                organization::NodeDefinition::work(
                    organization::NodeId::new("draft"),
                    "Draft",
                    std::num::NonZeroU32::new(1).unwrap(),
                    organization::WorkAssignment::new("draft", "writer"),
                ),
            ],
            vec![organization::EdgeDefinition::new(
                organization::EdgeId::new("start-to-draft"),
                organization::NodeId::new("start"),
                "done",
                organization::NodeId::new("draft"),
                "input",
                organization::EdgeAction::Activate,
            )],
        )
        .unwrap(),
        1,
    )
}

fn team_snapshot_materialization() -> organization::MaterializationReceipt {
    let endpoint =
        organization::RuntimeEndpointReference::try_new("private-runtime-endpoint").unwrap();
    organization::MaterializationReceipt::try_new(
        organization::TeamId::try_new("team:one").unwrap(),
        endpoint.clone(),
        vec![organization::RoleMaterializationReceipt::new(
            organization::RoleId::try_new("writer").unwrap(),
            organization::ManagedAgentReference::try_new("private-agent-secret").unwrap(),
            endpoint,
        )],
    )
    .unwrap()
}

fn team_snapshot_runtime() -> organization::RunRuntimeReceipt {
    let endpoint =
        organization::RuntimeEndpointReference::try_new("private-runtime-endpoint").unwrap();
    organization::RunRuntimeReceipt::try_new(
        organization::GraphRunId::new("run:one"),
        vec![organization::RoleSessionReceipt::with_endpoint_session_id(
            organization::TeamId::try_new("team:one").unwrap(),
            organization::GraphRunId::new("run:one"),
            organization::RoleId::try_new("writer").unwrap(),
            organization::RoleSessionRef::try_new("rs0").unwrap(),
            organization::EndpointSessionId::try_new("external-session-secret").unwrap(),
            organization::ManagedAgentReference::try_new("private-agent-secret").unwrap(),
            endpoint,
        )],
    )
    .unwrap()
}

#[test]
fn skill_status_control_projection_preserves_path_fields() {
    let value = skills::skill_status_json(&crate::skills::status::Catalog {
        entries: vec![crate::skills::status::Entry {
            key: "browser-flow".into(),
            slug: Some("browser-flow".into()),
            name: "Browser Flow".into(),
            description: "Browser flow".into(),
            enabled: true,
            selectable: true,
            eligible: true,
            blocked_by_allowlist: false,
            bundled: Some(false),
            always: Some(false),
            emoji: Some("B".into()),
            source: Some("C:/skills/source-root".into()),
            base_dir: Some("C:/skills/browser-flow".into()),
            file_path: Some("C:/skills/browser-flow/SKILL.md".into()),
            missing_categories: Vec::new(),
        }],
    });

    assert_eq!(
        value,
        json!({
            "skills": [{
                "key": "browser-flow",
                "name": "Browser Flow",
                "description": "Browser flow",
                "enabled": true,
                "selectable": true,
                "unavailableReason": null,
                "missingCategories": [],
                "eligible": true,
                "bundled": false,
                "always": false,
                "emoji": "B",
                "slug": "browser-flow",
                "source": "C:/skills/source-root",
                "baseDir": "C:/skills/browser-flow",
                "filePath": "C:/skills/browser-flow/SKILL.md",
            }]
        })
    );
}

#[test]
fn openclaw_gateway_request_outcomes_preserve_native_payloads() {
    let succeeded = to_value(openclaw_gateway_request_outcome(
        openclaw::port::OpenClawGatewayRequestOutcome::Succeeded(json!({
            "leaseId": "lease-1",
            "token": "secret-token",
            "path": "C:/private/openclaw",
        })),
    ))
    .unwrap();
    assert_eq!(
        succeeded,
        json!({
            "kind": "succeeded",
            "result": {
                "leaseId": "lease-1",
                "token": "secret-token",
                "path": "C:/private/openclaw",
            }
        })
    );
    assert_eq!(
        to_value(openclaw_gateway_request_outcome(
            openclaw::port::OpenClawGatewayRequestOutcome::CapacityExhausted
        ))
        .unwrap(),
        json!({
            "kind": "rejected",
            "error": {
                "code": "CAPACITY_EXHAUSTED",
                "message": "OpenClaw Gateway request capacity is exhausted.",
            }
        })
    );
    assert_eq!(
        to_value(openclaw_gateway_request_outcome(
            openclaw::port::OpenClawGatewayRequestOutcome::OutcomeUnknown
        ))
        .unwrap(),
        json!({ "kind": "unknown", "result": { "outcome": "unknown" } })
    );
}

#[test]
fn matcha_lifecycle_projection_is_exact_and_redacted() {
    for lifecycle in [
        crate::RuntimeLifecycle::Idle,
        crate::RuntimeLifecycle::Failed,
        crate::RuntimeLifecycle::ShutDown,
    ] {
        assert_eq!(
            to_value(super::super::lifecycle::matcha_lifecycle_result(lifecycle)).unwrap(),
            json!({
                "kind": "succeeded",
                "result": { "result": { "lifecycle": lifecycle } },
            })
        );
    }
}

#[test]
fn lifecycle_results_exclude_private_details() {
    let start = CommandOutcome::succeeded(CommandResult::private(json!({
        "result": {
            "lifecycle": crate::RuntimeLifecycle::Running,
            "pid": 42,
            "failure": serde_json::Value::Null,
        },
    })));

    let start = to_value(start).unwrap().to_string();
    for private in [
        "sessionKey",
        "sessionId",
        "metadata",
        "rawPayload",
        "private-session-id",
        "private-metadata",
        "endpoint",
        "token",
        "path",
        "argv",
        "peer error",
    ] {
        assert!(!start.contains(private));
    }
}

#[test]
fn rejections_are_stable_and_discard_peer_errors() {
    assert_eq!(
        to_value(invalid_input()).unwrap(),
        json!({
            "kind": "rejected",
            "error": {
                "code": "INVALID_INPUT",
                "message": "Runtime Host command input is invalid.",
            },
        })
    );
    assert_eq!(
        to_value(session_failure(
            RuntimeSessionError::<()>::RuntimeUnavailable
        ))
        .unwrap(),
        json!({
            "kind": "rejected",
            "error": {
                "code": "UNAVAILABLE",
                "message": "Runtime Host is unavailable.",
            },
        })
    );
    let peer_error = "private peer error";
    let response = to_value(session_failure(RuntimeSessionError::Client(peer_error))).unwrap();
    assert_eq!(response["error"]["code"], "FAILED");
    assert!(!response.to_string().contains(peer_error));
}
