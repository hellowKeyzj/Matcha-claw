use serde_json::{Value, json};

use super::*;

fn command(name: &str, input: Option<Value>) -> Value {
    let mut command = json!({ "name": name });
    if let Some(input) = input {
        command["input"] = input;
    }
    json!({
        "version": 1,
        "type": "command",
        "id": "command-1",
        "timeoutMs": 1_000,
        "command": command,
    })
}

#[test]
fn command_round_trip_is_strict_and_has_no_http_shape() {
    let health =
        decode_command_request(command("host.health", None).to_string().as_bytes()).unwrap();
    let lifecycle = [
        ("matcha.lifecycle.status", Command::MatchaStatus {}),
        ("matcha.lifecycle.start", Command::MatchaStart {}),
        ("matcha.lifecycle.stop", Command::MatchaStop {}),
        ("matcha.lifecycle.restart", Command::MatchaRestart {}),
        ("openclaw.lifecycle.status", Command::OpenClawStatus {}),
        (
            "openclaw.environment.status",
            Command::OpenClawEnvironmentStatus {},
        ),
        ("openclaw.runtime.paths", Command::OpenClawRuntimePaths {}),
        ("openclaw.cli.command", Command::OpenClawCliCommand {}),
        (
            "openclaw.tool-permission.get",
            Command::OpenClawToolPermissionGet {},
        ),
        ("host.toolchain.status", Command::HostToolchainStatus {}),
        ("host.toolchain.prepare", Command::HostToolchainPrepare {}),
        ("openclaw.lifecycle.start", Command::OpenClawStart {}),
        ("openclaw.lifecycle.stop", Command::OpenClawStop {}),
        ("openclaw.lifecycle.restart", Command::OpenClawRestart {}),
        ("openclaw.control.ready", Command::OpenClawControlReady {}),
    ];

    assert_eq!(health.id.as_str(), "command-1");
    assert_eq!(health.timeout, Timeout(1_000));
    assert_eq!(health.command, Command::HostHealth {});
    let capabilities = decode_command_request(
        command("host.capabilities.list", None)
            .to_string()
            .as_bytes(),
    )
    .unwrap();
    assert_eq!(capabilities.command, Command::HostCapabilitiesList {});
    assert_eq!(
        serde_json::from_slice::<Value>(&encode_command_request(&capabilities).unwrap()).unwrap(),
        command("host.capabilities.list", None),
    );
    let describe = decode_command_request(
        command(
            "host.capabilities.describe",
            Some(json!({
                "id": "scheduler.cron",
                "scope": {
                    "kind": "runtime-instance",
                    "endpoint": {
                        "kind": "native-runtime",
                        "runtimeAdapterId": "openclaw",
                        "runtimeInstanceId": "local",
                    },
                },
            })),
        )
        .to_string()
        .as_bytes(),
    )
    .unwrap();
    assert_eq!(
        describe.command,
        Command::HostCapabilitiesDescribe {
            input: CommandInput(json!({
                "id": "scheduler.cron",
                "scope": {
                    "kind": "runtime-instance",
                    "endpoint": {
                        "kind": "native-runtime",
                        "runtimeAdapterId": "openclaw",
                        "runtimeInstanceId": "local",
                    },
                },
            })),
        }
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&encode_command_request(&describe).unwrap()).unwrap(),
        command(
            "host.capabilities.describe",
            Some(json!({
                "id": "scheduler.cron",
                "scope": {
                    "kind": "runtime-instance",
                    "endpoint": {
                        "kind": "native-runtime",
                        "runtimeAdapterId": "openclaw",
                        "runtimeInstanceId": "local",
                    },
                },
            })),
        )
    );
    for (name, expected) in lifecycle {
        let decoded = decode_command_request(command(name, None).to_string().as_bytes()).unwrap();
        assert_eq!(decoded.command, expected);
        assert_eq!(
            serde_json::from_slice::<Value>(&encode_command_request(&decoded).unwrap()).unwrap(),
            command(name, None),
        );
    }
    assert_eq!(
        serde_json::from_slice::<Value>(&encode_command_request(&health).unwrap()).unwrap(),
        command("host.health", None)
    );

    let permission = decode_command_request(
        command(
            "openclaw.tool-permission.set",
            Some(json!({ "mode": "fullAccess" })),
        )
        .to_string()
        .as_bytes(),
    )
    .unwrap();
    assert_eq!(
        permission.command,
        Command::OpenClawToolPermissionSet {
            input: CommandInput(json!({ "mode": "fullAccess" })),
        }
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&encode_command_request(&permission).unwrap()).unwrap(),
        command(
            "openclaw.tool-permission.set",
            Some(json!({ "mode": "fullAccess" })),
        )
    );

    let browser = decode_command_request(
        command(
            "openclaw.browser.request",
            Some(
                json!({ "method": "GET", "path": "/session/view", "body": { "viewId": "view-1" } }),
            ),
        )
        .to_string()
        .as_bytes(),
    )
    .unwrap();
    assert_eq!(
        browser.command,
        Command::OpenClawBrowserRequest {
            input: CommandInput(
                json!({ "method": "GET", "path": "/session/view", "body": { "viewId": "view-1" } })
            ),
        }
    );
    let mcp = decode_command_request(
        command(
            "openclaw.mcp-app.request",
            Some(json!({ "operationId": "mcp.app.open", "sessionKey": "agent:main:session-1", "viewId": "view-1", "standalone": true })),
        )
        .to_string()
        .as_bytes(),
    )
    .unwrap();
    assert_eq!(
        mcp.command,
        Command::OpenClawMcpAppRequest {
            input: CommandInput(
                json!({ "operationId": "mcp.app.open", "sessionKey": "agent:main:session-1", "viewId": "view-1", "standalone": true })
            ),
        }
    );
}

#[test]
fn command_rejects_legacy_http_shape_and_schema_drift() {
    let cases = [
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 1_000,
            "command": { "name": "host.health", "unexpected": true },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 1_000,
            "command": {
                "name": "host.capabilities.describe",
                "method": "POST",
            },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 1_000,
            "command": { "name": "host.capabilities.describe" },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 1_000,
            "command": {
                "name": "host.capabilities.describe",
                "input": null,
            },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 1_000,
            "command": {
                "name": "host.capabilities.describe",
                "input": [],
            },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 1_000,
            "command": { "name": "host.runtime.execute", "input": {} },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 1_000,
            "command": { "name": "openclaw.toolchain.install-uv" },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 1_000,
            "command": { "name": "host.diagnostics.collect" },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 1_000,
            "command": { "name": "host.diagnostics.cancel" },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 1_000,
            "command": { "name": "team.human-decision", "input": {
                "runId": "run:1",
                "approvalId": "approval:1",
                "decision": "approve",
                "idempotencyKey": "decision:1"
            } },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 1_000,
            "command": { "name": "matcha.lifecycle.status", "input": {} },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 1_000,
            "command": { "name": "matcha.lifecycle.start", "input": null },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 1_000,
            "command": { "name": "matcha.lifecycle.stop", "unexpected": true },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 1_000,
            "command": { "name": "matcha.lifecycle.restart", "input": [] },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 1_000,
            "command": { "name": "openclaw.lifecycle.status", "input": {} },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 1_000,
            "command": { "name": "openclaw.environment.status", "path": "/private/openclaw" },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 1_000,
            "command": { "name": "openclaw.environment.status", "method": "GET" },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 1_000,
            "command": { "name": "openclaw.control.ready", "input": {} },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 1_000,
            "command": { "name": "sessions.authority.revoke" },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 1_000,
            "command": { "name": "openclaw.sessions.list", "input": {} },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 1_000,
            "command": { "name": "openclaw.control.ready", "method": "GET" },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 1_000,
            "command": { "name": "openclaw.control.ready", "route": "/control/ready" },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 1_000,
            "command": { "name": "openclaw.control.ready", "payload": {} },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 1_000,
            "command": { "name": "openclaw.control.ready", "endpoint": "http://127.0.0.1" },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 1_000,
            "command": { "name": "openclaw.control.ready", "port": 18789 },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 1_000,
            "command": { "name": "openclaw.control.ready", "token": "private-token" },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 1_000,
            "command": { "name": "openclaw.lifecycle.stop", "unexpected": true },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 1_000,
            "command": { "name": "openclaw.lifecycle.restart", "input": null },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 1_000,
            "command": { "name": "openclaw.skills.execute", "input": null },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 1_000,
            "command": { "name": "openclaw.skills.execute", "input": [], "method": "POST" },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 1_000,
            "command": { "name": "openclaw.skills.execute", "input": {}, "route": "/api/openclaw/chat/send" },
        }),
        json!({
            "version": 1,
            "type": "request",
            "id": "command-1",
            "deadlineMs": 1_000,
            "dispatch": { "version": 1, "method": "POST", "route": "/api/openclaw/chat/send" },
        }),
        json!({
            "version": 2,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 1_000,
            "command": { "name": "host.health" },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "",
            "timeoutMs": 1_000,
            "command": { "name": "host.health" },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": 0,
            "command": { "name": "host.health" },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "command-1",
            "timeoutMs": MAX_TIMEOUT_MS + 1,
            "command": { "name": "host.health" },
        }),
        json!({
            "version": 1,
            "type": "command",
            "id": "x".repeat(MAX_REQUEST_ID_BYTES + 1),
            "timeoutMs": 1_000,
            "command": { "name": "host.health" },
        }),
    ];

    for value in cases {
        assert_eq!(
            decode_command_request(value.to_string().as_bytes()),
            Err(WireError::InvalidCommand)
        );
    }
    assert_eq!(
        decode_command_request(br#"{"#),
        Err(WireError::MalformedJson)
    );
}

#[test]
fn private_control_rejects_public_capability_names() {
    for (name, input) in [
        ("environment.create", Some(json!({}))),
        ("environment.replace", Some(json!({}))),
        ("environment.delete", Some(json!({}))),
        ("openclaw.sessions.list", None),
    ] {
        assert_eq!(
            decode_command_request(command(name, input).to_string().as_bytes()),
            Err(WireError::InvalidCommand)
        );
    }
}

#[test]
fn output_round_trips_with_semantic_outcomes_and_typed_events() {
    let request =
        decode_command_request(command("host.health", None).to_string().as_bytes()).unwrap();
    let outputs = [
        Output::Ready(Ready::new()),
        Output::Outcome(Outcome::new(
            request.id.clone(),
            CommandOutcome::succeeded(CommandResult::private(json!({ "health": { "ok": true } }))),
        )),
        Output::Outcome(Outcome::new(
            request.id.clone(),
            CommandOutcome::rejected(RejectionCode::Unavailable, "Runtime Host is unavailable."),
        )),
        Output::Outcome(Outcome::new(
            request.id.clone(),
            CommandOutcome::unknown(CommandResult::private(json!({ "outcome": "unknown" }))),
        )),
        Output::Outcome(Outcome::new(
            request.id.clone(),
            CommandOutcome::timed_out(),
        )),
        Output::Event(Event::new(SafeEvent::OpenClawLifecycle {
            sequence: Some(7),
            has_run: true,
            has_message: true,
            has_session_activity: true,
        })),
        Output::Event(Event::new(SafeEvent::OpenClawRuntime {})),
        Output::Event(Event::new(SafeEvent::OpenClawCronExecution {
            job_id: CronExecutionId::try_new("cron-job-1".to_owned()).unwrap(),
            run_id: CronExecutionId::try_new("cron-run-1".to_owned()).unwrap(),
            status: SafeCronExecutionStatus::Succeeded,
        })),
        Output::Event(Event::new(SafeEvent::OpenClawCronExecution {
            job_id: CronExecutionId::try_new("cron-job-2".to_owned()).unwrap(),
            run_id: CronExecutionId::try_new("cron-run-2".to_owned()).unwrap(),
            status: SafeCronExecutionStatus::Failed,
        })),
        Output::Event(Event::new(SafeEvent::OpenClawCronExecution {
            job_id: CronExecutionId::try_new("cron-job-3".to_owned()).unwrap(),
            run_id: CronExecutionId::try_new("cron-run-3".to_owned()).unwrap(),
            status: SafeCronExecutionStatus::Skipped,
        })),
        Output::Event(Event::new(SafeEvent::OpenClawCronExecution {
            job_id: CronExecutionId::try_new("cron-job-4".to_owned()).unwrap(),
            run_id: CronExecutionId::try_new("cron-run-4".to_owned()).unwrap(),
            status: SafeCronExecutionStatus::Cancelled,
        })),
        Output::Event(Event::new(SafeEvent::OpenClawCronExecution {
            job_id: CronExecutionId::try_new("cron-job-5".to_owned()).unwrap(),
            run_id: CronExecutionId::try_new("cron-run-5".to_owned()).unwrap(),
            status: SafeCronExecutionStatus::OutcomeUnknown,
        })),
    ];

    let encoded: Vec<Value> = outputs
        .iter()
        .map(|output| serde_json::from_slice(&encode(output).unwrap()).unwrap())
        .collect();

    assert_eq!(
        encoded,
        vec![
            json!({
                "version": 1,
                "type": "ready",
            }),
            json!({
                "version": 1,
                "type": "outcome",
                "id": "command-1",
                "outcome": { "kind": "succeeded", "result": { "health": { "ok": true } } },
            }),
            json!({
                "version": 1,
                "type": "outcome",
                "id": "command-1",
                "outcome": {
                    "kind": "rejected",
                    "error": {
                        "code": "UNAVAILABLE",
                        "message": "Runtime Host is unavailable.",
                    },
                },
            }),
            json!({
                "version": 1,
                "type": "outcome",
                "id": "command-1",
                "outcome": { "kind": "unknown", "result": { "outcome": "unknown" } },
            }),
            json!({
                "version": 1,
                "type": "outcome",
                "id": "command-1",
                "outcome": { "kind": "timed-out" },
            }),
            json!({
                "version": 1,
                "type": "event",
                "event": {
                    "type": "openclaw.lifecycle",
                    "sequence": 7,
                    "hasRun": true,
                    "hasMessage": true,
                    "hasSessionActivity": true,
                },
            }),
            json!({
                "version": 1,
                "type": "event",
                "event": { "type": "openclaw.runtime" },
            }),
            json!({
                "version": 1,
                "type": "event",
                "event": {
                    "type": "openclaw.cron.execution",
                    "jobId": "cron-job-1",
                    "runId": "cron-run-1",
                    "status": "succeeded",
                },
            }),
            json!({
                "version": 1,
                "type": "event",
                "event": {
                    "type": "openclaw.cron.execution",
                    "jobId": "cron-job-2",
                    "runId": "cron-run-2",
                    "status": "failed",
                },
            }),
            json!({
                "version": 1,
                "type": "event",
                "event": {
                    "type": "openclaw.cron.execution",
                    "jobId": "cron-job-3",
                    "runId": "cron-run-3",
                    "status": "skipped",
                },
            }),
            json!({
                "version": 1,
                "type": "event",
                "event": {
                    "type": "openclaw.cron.execution",
                    "jobId": "cron-job-4",
                    "runId": "cron-run-4",
                    "status": "cancelled",
                },
            }),
            json!({
                "version": 1,
                "type": "event",
                "event": {
                    "type": "openclaw.cron.execution",
                    "jobId": "cron-job-5",
                    "runId": "cron-run-5",
                    "status": "outcome-unknown",
                },
            }),
        ]
    );

    for output in outputs {
        assert_eq!(decode_output(&encode(&output).unwrap()).unwrap(), output);
    }
}

#[test]
fn projects_event_sequences_to_the_electron_safe_integer_range() {
    let event = Output::Event(Event::new(SafeEvent::OpenClawLifecycle {
        sequence: Some(MAX_SAFE_SEQUENCE),
        has_run: true,
        has_message: false,
        has_session_activity: false,
    }));

    let encoded: Value = serde_json::from_slice(&encode(&event).unwrap()).unwrap();
    assert_eq!(encoded["event"]["sequence"], MAX_SAFE_SEQUENCE);
}

#[test]
fn rejects_unknown_fields_and_safe_event_secret_channels() {
    let cases = [
        json!({ "version": 1, "type": "ready", "unexpected": true }),
        json!({
            "version": 1,
            "type": "ready",
            "sessionList": {
                "endpoint": "http://127.0.0.1:12345/v1/sessions/list",
                "credential": "transport-credential-must-not-return",
            },
        }),
        json!({
            "version": 1,
            "type": "event",
            "event": {
                "type": "openclaw.lifecycle",
                "sequence": MAX_SAFE_SEQUENCE + 1,
                "hasRun": true,
                "hasMessage": false,
                "hasSessionActivity": false,
            },
        }),
        json!({
            "version": 1,
            "type": "event",
            "event": { "type": "openclaw.runtime", "unexpected": true },
        }),
        json!({
            "version": 1,
            "type": "event",
            "event": {
                "type": "openclaw.session.update",
                "routeKey": "renderer-route:test",
                "kind": "delta",
                "sequence": 7,
                "text": "legacy update must be rejected",
            },
        }),
        json!({
            "version": 1,
            "type": "event",
            "event": {
                "type": "openclaw.session.activity",
                "routeKey": "renderer-route:test",
                "sequence": 7,
                "activity": {"kind": "message"},
            },
        }),
        json!({
            "version": 1,
            "type": "event",
            "event": {
                "type": "matcha.session.activity",
                "routeKey": "renderer-route:test",
                "sequence": 7,
                "activity": {"kind": "approval"},
            },
        }),
        json!({
            "version": 1,
            "type": "event",
            "event": {
                "type": "openclaw.cron.execution",
                "jobId": "cron-job-1",
                "runId": "cron-run-1",
                "status": "success",
            },
        }),
        json!({
            "version": 1,
            "type": "event",
            "event": {
                "type": "openclaw.cron.execution",
                "jobId": "",
                "runId": "cron-run-1",
                "status": "succeeded",
            },
        }),
        json!({
            "version": 1,
            "type": "event",
            "event": {
                "type": "openclaw.cron.execution",
                "jobId": "cron/job-1",
                "runId": "cron-run-1",
                "status": "succeeded",
            },
        }),
        json!({
            "version": 1,
            "type": "outcome",
            "id": "command-1",
            "outcome": { "kind": "succeeded", "result": {}, "extra": true },
        }),
    ];

    for value in cases {
        assert_eq!(
            decode_output(value.to_string().as_bytes()),
            Err(WireError::InvalidOutput)
        );
    }

    for legacy_event in [
        json!({
            "version": 1,
            "type": "event",
            "event": { "type": "openclaw.session.update" },
        }),
        json!({
            "version": 1,
            "type": "event",
            "event": { "type": "openclaw.session.activity" },
        }),
        json!({
            "version": 1,
            "type": "event",
            "event": { "type": "matcha.session.activity" },
        }),
    ] {
        assert_eq!(
            decode_output(legacy_event.to_string().as_bytes()),
            Err(WireError::InvalidOutput)
        );
    }
}

#[test]
fn private_control_wire_keeps_owner_dtos_and_runtime_seams_private() {
    let wire = include_str!("wire.rs");

    for private in [
        "PeerOwner",
        "PeerHandle",
        "SessionOwner",
        "SessionHandle",
        "SessionCommand",
        "SessionQuery",
        "SessionSendRequest",
        "SessionAbortRequest",
        "SessionView",
        "OwnerRoute",
        "spawn_owner_runtime",
        "rawPayload",
        "native-session-identity",
        "token",
    ] {
        assert!(
            !wire.contains(private),
            "private control wire leaked {private}"
        );
    }
}

#[test]
fn session_handle_separates_query_and_mutation_mailboxes() {
    let handle = include_str!("../sessions/handle.rs");
    let command = include_str!("../sessions/command.rs");
    let query = include_str!("../sessions/query.rs");

    assert!(handle.contains("self.owner.send_query(query(reply))"));
    assert!(handle.contains("self.owner\n            .send_command(command(reply))"));
    assert!(!query.contains("SessionCommand"));
    assert!(!command.contains("SessionQuery"));

    for method in [
        "pub(crate) async fn list_sessions",
        "pub(crate) async fn get_session",
        "pub(crate) async fn pending_approvals",
        "pub(crate) async fn load_timeline",
        "pub(crate) async fn list_openclaw_sessions",
        "pub(crate) async fn list_matcha_sessions",
        "pub(crate) async fn load_matcha_history",
    ] {
        assert!(
            method_body(handle, method).contains("request_query"),
            "{method}"
        );
    }

    for method in [
        "pub(crate) async fn ensure_session",
        "pub(crate) async fn ingest_event",
        "pub(crate) async fn evict_session",
        "pub(crate) async fn create_session",
        "pub(crate) async fn send_session",
        "pub(crate) async fn abort_session",
        "pub(crate) async fn delete_session",
        "pub(crate) async fn rename_session",
        "pub(crate) async fn respond_to_approval",
        "pub(crate) async fn select_model",
    ] {
        assert!(
            method_body(handle, method).contains("request_command"),
            "{method}"
        );
    }
}

fn method_body<'a>(source: &'a str, signature: &str) -> &'a str {
    let start = source
        .find(signature)
        .unwrap_or_else(|| panic!("missing SessionHandle method {signature}"));
    let body = &source[start..];
    match body.find("\n    pub(crate) async fn ") {
        Some(end) => &body[..end],
        None => body,
    }
}
