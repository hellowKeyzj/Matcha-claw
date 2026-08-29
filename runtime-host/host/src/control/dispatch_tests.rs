use serde_json::{Value, json, to_value};

use super::*;

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
fn control_payload_decoders_keep_the_fixed_product_dtos() {
    assert_eq!(
        to_value(
            decode_send(CommandInput(json!({
                "sessionKey": "session-1",
                "message": "private-input",
                "runId": "run-1",
            })))
            .unwrap()
        )
        .unwrap(),
        json!({
            "sessionKey": "session-1",
            "message": "private-input",
            "idempotencyKey": "run-1",
        })
    );
    assert_eq!(
        to_value(decode_abort(CommandInput(json!({ "sessionKey": "session-1" }))).unwrap())
            .unwrap(),
        json!({ "sessionKey": "session-1" })
    );
    assert_eq!(
        to_value(
            decode_history(CommandInput(json!({
                "sessionKey": "session-1",
                "limit": 3,
                "maxChars": 4,
            })))
            .unwrap(),
        )
        .unwrap(),
        json!({ "sessionKey": "session-1", "limit": 3, "maxChars": 4 })
    );
    assert_eq!(
        to_value(decode_history(CommandInput(json!({ "sessionKey": "session-1" }))).unwrap())
            .unwrap(),
        json!({ "sessionKey": "session-1" })
    );
    assert_eq!(
        decode_manual_cron_trigger(CommandInput(json!({ "jobId": "cron-job-1" })))
            .unwrap()
            .job_id,
        "cron-job-1"
    );
    for payload in [
        CommandInput(serde_json::Value::Null),
        CommandInput(serde_json::Value::Null),
        CommandInput(json!({ "sessionKey": "session-1", "limit": null })),
        CommandInput(json!({ "sessionKey": "session-1", "maxChars": null })),
        CommandInput(json!({ "sessionKey": "session-1", "limit": 0 })),
        CommandInput(json!({ "sessionKey": "session-1", "limit": 1_001 })),
        CommandInput(json!({ "sessionKey": "session-1", "maxChars": 0 })),
        CommandInput(json!({ "sessionKey": "session-1", "maxChars": 500_001 })),
        CommandInput(json!({
            "sessionKey": "session-1",
            "metadata": "must-not-pass",
        })),
    ] {
        assert_eq!(decode_history(payload), Err(InvalidPayload));
    }
    for payload in [
        CommandInput(serde_json::Value::Null),
        CommandInput(json!({
            "sessionKey": "session-1",
            "message": "message",
            "runId": "run-1",
            "attachments": [],
        })),
        CommandInput(json!({
            "sessionKey": " ",
            "message": "message",
            "runId": "run-1",
        })),
    ] {
        assert_eq!(decode_send(payload), Err(InvalidPayload));
    }
    for payload in [
        CommandInput(serde_json::Value::Null),
        CommandInput(json!({ "jobId": "" })),
        CommandInput(json!({ "jobId": "cron-job-1", "extra": true })),
    ] {
        assert!(matches!(
            decode_manual_cron_trigger(payload),
            Err(InvalidPayload)
        ));
    }
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
        openclaw::projection::tool_permission::Mode::FullAccess,
    );
}

#[test]
fn node_prompt_settled_decode_requires_team_run_target_and_preserves_run_id() {
    for phase in ["final", "error", "aborted"] {
        let command = team_runtime_command(
            "team.nodePromptSettled",
            &json!({ "kind": "team-run", "runId": "run:one" }),
            &json!({
                "runId": "run:one",
                "sessionKey": "session:one",
                "promptRunId": "prompt:one",
                "phase": phase,
            }),
        )
        .unwrap();
        assert!(matches!(
            command,
            TeamRuntimeCommand::NodePromptSettled {
                run_id,
                session_key,
                prompt_run_id,
                ..
            } if run_id.as_str() == "run:one"
                && session_key.as_str() == "session:one"
                && prompt_run_id.as_str() == "prompt:one"
        ));
    }

    for target in [Value::Null, json!({ "kind": "none" })] {
        assert!(
            team_runtime_command(
                "team.nodePromptSettled",
                &target,
                &json!({
                    "sessionKey": "session:one",
                    "promptRunId": "prompt:one",
                    "phase": "final",
                }),
            )
            .is_err()
        );
    }
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
    let outcome = to_value(crate::capability_directory::list()).unwrap();
    assert_eq!(outcome["kind"], "succeeded");
    let capabilities = outcome["result"]["capabilities"].as_array().unwrap();
    assert_eq!(
        capabilities
            .iter()
            .map(|value| value["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec![
            "integration.channel",
            "platform.runtime",
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
    assert_eq!(capabilities[7]["scope"]["agentId"], "main");
    assert_eq!(capabilities[4]["operations"].as_array().unwrap().len(), 5);
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
        to_value(crate::capability_directory::list()).unwrap()["result"]["capabilities"].clone();
    for descriptor in listed.as_array().unwrap() {
        let outcome = to_value(crate::capability_directory::describe(CommandInput(json!({
            "id": descriptor["id"].clone(),
            "scope": descriptor["scope"].clone(),
        }))))
        .unwrap();
        assert_eq!(outcome["kind"], "succeeded");
        assert_eq!(outcome["result"]["capability"], *descriptor);
    }

    let unknown = to_value(crate::capability_directory::describe(CommandInput(json!({
        "id": "unknown.capability",
        "scope": test_runtime_instance_scope(),
    }))))
    .unwrap();
    assert_eq!(unknown["error"]["code"], "INVALID_INPUT");
    assert_eq!(unknown["error"]["message"], TEST_UNKNOWN_CAPABILITY_MESSAGE);

    let wrong_scope = to_value(crate::capability_directory::describe(CommandInput(json!({
        "id": "scheduler.cron",
        "scope": test_agent_scope("main"),
    }))))
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
        let outcome = to_value(crate::capability_directory::describe(CommandInput(input))).unwrap();
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
        let outcome = to_value(crate::capability_directory::describe(CommandInput(json!({
            "id": "scheduler.cron",
            "scope": scope,
        }))))
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
        let outcome = to_value(crate::capability_directory::describe(CommandInput(json!({
            "id": "unknown.capability",
            "scope": scope,
        }))))
        .unwrap();
        assert_eq!(outcome["error"]["message"], TEST_UNKNOWN_CAPABILITY_MESSAGE);
    }
}

#[test]
fn descriptor_operations_have_reachable_execute_or_transport_paths() {
    let capabilities =
        to_value(crate::capability_directory::list()).unwrap()["result"]["capabilities"]
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
            json!({ "skillKey": "browser-flow", "filePath": "SKILL.md" }),
        ),
    ] {
        assert!(
            is_skill_capability_request(operation, &target, &input),
            "skill operation must reach execute branch: {operation}"
        );
    }
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
fn unknown_mutation_outcomes_remain_safe_and_distinguishable() {
    let send = CommandOutcome::succeeded(json!({
        "result": SendChatResponse::from(platform::exchange::InvocationOutcome::<
            openclaw::session::protocol::ChatSendResult,
            (),
        >::Unknown),
    }));
    let abort = CommandOutcome::succeeded(json!({
        "result": AbortChatResponse::from(platform::exchange::InvocationOutcome::<
            openclaw::session::protocol::ChatAbortResult,
            (),
        >::Unknown),
    }));
    for outcome in [send, abort] {
        assert_eq!(
            to_value(outcome).unwrap(),
            json!({ "kind": "succeeded", "result": { "result": { "outcome": "unknown" } } })
        );
    }
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
fn history_and_lifecycle_results_exclude_private_details() {
    let history = CommandOutcome::succeeded(json!({
        "result": ChatHistoryResponse::from(openclaw::session::protocol::ChatHistoryResult {
            messages: vec![
                openclaw::session::protocol::HistoryMessage {
                    role: openclaw::session::protocol::HistoryRole::User,
                    text: "private input".into(),
                },
                openclaw::session::protocol::HistoryMessage {
                    role: openclaw::session::protocol::HistoryRole::Assistant,
                    text: "private output".into(),
                },
            ],
        }),
    }));
    let start = CommandOutcome::succeeded(json!({
        "result": {
            "lifecycle": crate::RuntimeLifecycle::Running,
            "pid": 42,
            "failure": serde_json::Value::Null,
        },
    }));

    let history = to_value(history).unwrap().to_string();
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
        assert!(!history.contains(private));
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
