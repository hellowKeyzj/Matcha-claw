use std::time::{SystemTime, UNIX_EPOCH};

use openclaw::port::OpenClawControlReadiness;
use serde::Serialize;
use serde_json::json;

use crate::{
    RuntimeLifecycle, RuntimeState,
    composition::{
        PeerHandle, RestartMatchaError, RestartOpenClawError, StartMatchaError, StartOpenClawError,
        StopMatchaError, StopOpenClawError,
    },
    diagnostics::RuntimeStateProjection,
    owner::Handle,
};

use super::wire::CommandOutcome;

const RUNTIME_UNAVAILABLE_MESSAGE: &str = "Runtime Host is unavailable.";
const COMMAND_FAILED_MESSAGE: &str = "Runtime Host command failed.";

fn observed_at_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .unwrap_or(u64::MAX)
}

pub(crate) async fn host_health(owner: &Handle) -> CommandOutcome {
    let state = owner.state();
    let safe_matcha = state.matcha().projection();
    let safe_open_claw = state.open_claw().projection();
    CommandOutcome::succeeded(json!({
        "state": {
            "ok": state.ok(),
            "lifecycle": state.lifecycle(),
            "matcha": safe_matcha,
            "openClaw": safe_open_claw,
        },
        "health": {
            "ok": state.ok(),
            "lifecycle": state.lifecycle(),
            "matcha": safe_matcha,
            "openClaw": safe_open_claw,
        },
    }))
}

pub(crate) async fn runtime_snapshot(owner: &Handle, peer: &PeerHandle) -> CommandOutcome {
    let observed_at_ms = observed_at_ms();
    let state = owner.state();
    let gateway = match peer.open_claw_status().await {
        Ok(state) => gateway_snapshot_result(state.lifecycle(), observed_at_ms),
        Err(_) => json!({ "availability": "unavailable" }),
    };
    let control = match peer.control_lease().await {
        Ok(lease) => control_readiness_result(lease.snapshot_control().await),
        Err(_) => json!({
            "ready": false,
            "phase": "unavailable",
            "retryable": false,
        }),
    };
    let safe_matcha = state.matcha().projection();
    let safe_open_claw = state.open_claw().projection();
    CommandOutcome::succeeded(json!({
        "state": {
            "ok": state.ok(),
            "lifecycle": state.lifecycle(),
            "matcha": safe_matcha,
            "openClaw": safe_open_claw,
        },
        "health": {
            "ok": state.ok(),
            "lifecycle": state.lifecycle(),
            "matcha": safe_matcha,
            "openClaw": safe_open_claw,
        },
        "gateway": gateway,
        "control": control,
        "observedAtMs": observed_at_ms,
    }))
}

fn gateway_snapshot_result(lifecycle: RuntimeLifecycle, observed_at_ms: u64) -> serde_json::Value {
    if lifecycle == RuntimeLifecycle::Running {
        return json!({
            "availability": "available",
            "ok": true,
            "timestampMs": observed_at_ms,
            "durationMs": 0,
            "channelCount": 0,
            "agentCount": 0,
            "sessionCount": 0,
            "heartbeatEnabled": null,
        });
    }
    json!({ "availability": "unavailable" })
}

fn control_readiness_result(readiness: OpenClawControlReadiness) -> serde_json::Value {
    match readiness {
        OpenClawControlReadiness::Ready => json!({
            "ready": true,
            "phase": "ready",
            "retryable": false,
        }),
        OpenClawControlReadiness::Starting => json!({
            "ready": false,
            "phase": "starting",
            "retryable": true,
        }),
        OpenClawControlReadiness::Unavailable => json!({
            "ready": false,
            "phase": "unavailable",
            "retryable": false,
        }),
    }
}

pub(crate) async fn matcha_status(peer: &PeerHandle) -> CommandOutcome {
    let state = match peer.matcha_status().await {
        Ok(state) => state,
        Err(_) => return unavailable(),
    };
    matcha_status_result(state)
}

pub(crate) async fn start_matcha(peer: &PeerHandle) -> CommandOutcome {
    let state = match peer.start_matcha().await {
        Ok(Ok(state)) => state,
        Ok(Err(error)) => return start_matcha_failure(error),
        Err(_) => return internal_error(),
    };
    matcha_lifecycle_result(state.lifecycle())
}

pub(crate) async fn stop_matcha(peer: &PeerHandle) -> CommandOutcome {
    let state = match peer.stop_matcha().await {
        Ok(Ok(state)) => state,
        Ok(Err(error)) => return stop_matcha_failure(error),
        Err(_) => return internal_error(),
    };
    matcha_lifecycle_result(state.lifecycle())
}

pub(crate) async fn restart_matcha(peer: &PeerHandle) -> CommandOutcome {
    let state = match peer.restart_matcha().await {
        Ok(Ok(state)) => state,
        Ok(Err(error)) => return restart_matcha_failure(error),
        Err(_) => return internal_error(),
    };
    matcha_lifecycle_result(state.lifecycle())
}

pub(crate) async fn status(peer: &PeerHandle) -> CommandOutcome {
    let state = match peer.open_claw_status().await {
        Ok(state) => state,
        Err(_) => return unavailable(),
    };
    runtime_state_result(state)
}

pub(crate) async fn logs(peer: &PeerHandle, input: super::wire::CommandInput) -> CommandOutcome {
    let input = input.into_value();
    let cursor = match input.get("cursor") {
        None => None,
        Some(value) => match value.as_u64() {
            Some(cursor) => Some(cursor),
            None => {
                return CommandOutcome::rejected(
                    super::wire::RejectionCode::InvalidInput,
                    "Invalid log cursor.",
                );
            }
        },
    };
    let logs = match peer.open_claw_logs(cursor).await {
        Ok(Ok(logs)) => logs,
        Ok(Err(_)) => return unavailable(),
        Err(_) => return internal_error(),
    };
    let entries = logs
        .entries
        .into_iter()
        .map(|entry| json!({ "source": entry.source, "line": entry.line }))
        .collect::<Vec<_>>();
    CommandOutcome::succeeded(json!({
        "result": {
            "entries": entries,
            "cursor": logs.cursor,
            "reset": logs.reset,
            "truncated": logs.truncated,
            "lifecycleTailEvicted": logs.lifecycle_tail_evicted,
        }
    }))
}

pub(crate) async fn gateway_health(peer: &PeerHandle) -> CommandOutcome {
    match peer.open_claw_gateway_health(false).await {
        Ok(Ok(health)) => CommandOutcome::succeeded(json!({
            "result": {
                "ok": health.ok,
                "timestampMs": health.timestamp_ms,
                "durationMs": health.duration_ms,
                "channelCount": health.channel_count,
                "agentCount": health.agent_count,
                "sessionCount": health.session_count,
            }
        })),
        Ok(Err(_)) | Err(_) => unavailable(),
    }
}

pub(crate) async fn gateway_status(peer: &PeerHandle) -> CommandOutcome {
    match peer.open_claw_gateway_status(true).await {
        Ok(Ok(status)) => CommandOutcome::succeeded(json!({
            "result": {
                "sessionCount": status.session_count,
                "channelCount": status.channel_count,
                "heartbeatEnabled": status.heartbeat_enabled,
            }
        })),
        Ok(Err(_)) | Err(_) => unavailable(),
    }
}

pub(crate) async fn control_ui_url(peer: &PeerHandle) -> CommandOutcome {
    match peer.open_claw_control_ui_url().await {
        Ok(url) => CommandOutcome::succeeded(json!({ "result": { "url": url } })),
        Err(_) => unavailable(),
    }
}

pub(crate) async fn control_ready(peer: &PeerHandle) -> CommandOutcome {
    let lease = match peer.control_lease().await {
        Ok(lease) => lease,
        Err(_) => return unavailable(),
    };
    control_ready_result(lease.snapshot_control().await)
}

fn control_ready_result(readiness: OpenClawControlReadiness) -> CommandOutcome {
    let (ready, phase, retryable) = match readiness {
        OpenClawControlReadiness::Ready => (true, "ready", false),
        OpenClawControlReadiness::Starting => (false, "starting", true),
        OpenClawControlReadiness::Unavailable => (false, "unavailable", false),
    };
    CommandOutcome::succeeded(json!({
        "ready": ready,
        "phase": phase,
        "retryable": retryable,
    }))
}

pub(crate) async fn start(peer: &PeerHandle) -> CommandOutcome {
    let state = match peer.start_open_claw().await {
        Ok(Ok(state)) => state,
        Ok(Err(error)) => return start_failure(error),
        Err(_) => return internal_error(),
    };
    runtime_state_result(state)
}

pub(crate) async fn stop(peer: &PeerHandle) -> CommandOutcome {
    let state = match peer.stop_open_claw().await {
        Ok(Ok(state)) => state,
        Ok(Err(error)) => return stop_failure(error),
        Err(_) => return internal_error(),
    };
    runtime_state_result(state)
}

pub(crate) async fn restart(peer: &PeerHandle) -> CommandOutcome {
    let state = match peer.restart_open_claw().await {
        Ok(Ok(state)) => state,
        Ok(Err(error)) => return restart_failure(error),
        Err(_) => return internal_error(),
    };
    runtime_state_result(state)
}

fn runtime_state_result(state: RuntimeState) -> CommandOutcome {
    CommandOutcome::succeeded(json!({ "result": state.projection() }))
}

fn matcha_status_result(state: RuntimeState) -> CommandOutcome {
    CommandOutcome::succeeded(json!({
        "result": MatchaStatusProjection {
            state: state.projection(),
            ready: state.lifecycle() == RuntimeLifecycle::Running,
            observed_at_ms: observed_at_ms(),
        },
    }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MatchaStatusProjection {
    #[serde(flatten)]
    state: RuntimeStateProjection,
    ready: bool,
    observed_at_ms: u64,
}

pub(super) fn matcha_lifecycle_result(lifecycle: crate::RuntimeLifecycle) -> CommandOutcome {
    CommandOutcome::succeeded(json!({ "result": { "lifecycle": lifecycle } }))
}

fn internal_error() -> CommandOutcome {
    CommandOutcome::rejected(super::wire::RejectionCode::Failed, COMMAND_FAILED_MESSAGE)
}

fn start_matcha_failure(error: StartMatchaError) -> CommandOutcome {
    match error {
        StartMatchaError::AdmissionClosed => unavailable(),
        StartMatchaError::RuntimeStart => internal_error(),
    }
}

fn stop_matcha_failure(error: StopMatchaError) -> CommandOutcome {
    match error {
        StopMatchaError::AdmissionClosed => unavailable(),
        StopMatchaError::RuntimeStop => internal_error(),
    }
}

fn restart_matcha_failure(error: RestartMatchaError) -> CommandOutcome {
    match error {
        RestartMatchaError::AdmissionClosed => unavailable(),
        RestartMatchaError::RuntimeRestart => internal_error(),
    }
}

fn start_failure(error: StartOpenClawError) -> CommandOutcome {
    match error {
        StartOpenClawError::AdmissionClosed => unavailable(),
        StartOpenClawError::RuntimeStart => internal_error(),
    }
}

fn stop_failure(error: StopOpenClawError) -> CommandOutcome {
    match error {
        StopOpenClawError::AdmissionClosed => unavailable(),
        StopOpenClawError::RuntimeStop => internal_error(),
    }
}

fn restart_failure(error: RestartOpenClawError) -> CommandOutcome {
    match error {
        RestartOpenClawError::AdmissionClosed => unavailable(),
        RestartOpenClawError::RuntimeRestart => internal_error(),
    }
}

fn unavailable() -> CommandOutcome {
    CommandOutcome::rejected(
        super::wire::RejectionCode::Unavailable,
        RUNTIME_UNAVAILABLE_MESSAGE,
    )
}

#[cfg(test)]
mod tests {
    use serde_json::to_value;

    use super::*;

    #[test]
    fn control_readiness_is_exact_and_redacted() {
        for (readiness, expected) in [
            (
                OpenClawControlReadiness::Ready,
                json!({ "ready": true, "phase": "ready", "retryable": false }),
            ),
            (
                OpenClawControlReadiness::Starting,
                json!({ "ready": false, "phase": "starting", "retryable": true }),
            ),
            (
                OpenClawControlReadiness::Unavailable,
                json!({ "ready": false, "phase": "unavailable", "retryable": false }),
            ),
        ] {
            let serialized = to_value(control_ready_result(readiness))
                .unwrap()
                .to_string();
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&serialized).unwrap(),
                json!({ "kind": "succeeded", "result": expected })
            );
            for private in [
                "required",
                "missing",
                "method",
                "code",
                "error",
                "retryAfter",
                "endpoint",
                "port",
                "token",
                "rawPayload",
                "supervisor",
                "sentinel",
            ] {
                assert!(!serialized.contains(private));
            }
        }
    }

    #[test]
    fn openclaw_lifecycle_result_is_exact_and_redacts_process_identity() {
        let outcome = runtime_state_result(RuntimeState::test_only(
            crate::RuntimeLifecycle::Failed,
            Some(42),
            Some(crate::RuntimeFailure::UnexpectedExit),
            Some(crate::diagnostics::RuntimeStartupDiagnostic::ConfigurationRejected),
        ));

        let serialized = to_value(outcome).unwrap().to_string();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&serialized).unwrap(),
            json!({
                "kind": "succeeded",
                "result": {
                    "result": {
                        "lifecycle": "failed",
                        "failure": "unexpectedExit",
                        "startupDiagnostic": "configurationRejected",
                    },
                },
            })
        );
        for private in [
            "pid",
            "42",
            "endpoint",
            "port",
            "token",
            "path",
            "argv",
            "session identity",
            "run identity",
            "message identity",
        ] {
            assert!(!serialized.contains(private));
        }
    }

    #[test]
    fn matcha_status_result_is_exact_and_redacts_process_identity() {
        let outcome = matcha_status_result(RuntimeState::test_only(
            crate::RuntimeLifecycle::Failed,
            Some(42),
            Some(crate::RuntimeFailure::UnexpectedExit),
            Some(crate::diagnostics::RuntimeStartupDiagnostic::ConfigurationRejected),
        ));

        let value = to_value(outcome).unwrap();
        let observed_at_ms = value["result"]["result"]["observedAtMs"]
            .as_u64()
            .expect("matcha status must include an observed timestamp");
        let serialized = value.to_string();
        assert_eq!(
            value,
            json!({
                "kind": "succeeded",
                "result": {
                    "result": {
                        "lifecycle": "failed",
                        "ready": false,
                        "observedAtMs": observed_at_ms,
                        "failure": "unexpectedExit",
                        "startupDiagnostic": "configurationRejected",
                    },
                },
            })
        );
        for private in [
            "pid",
            "42",
            "endpoint",
            "port",
            "token",
            "path",
            "argv",
            "session identity",
            "run identity",
            "message identity",
        ] {
            assert!(!serialized.contains(private));
        }
    }

    #[test]
    fn matcha_status_result_marks_running_state_ready() {
        let value = to_value(matcha_status_result(RuntimeState::test_only(
            crate::RuntimeLifecycle::Running,
            Some(42),
            None,
            None,
        )))
        .unwrap();
        let observed_at_ms = value["result"]["result"]["observedAtMs"]
            .as_u64()
            .expect("matcha status must include an observed timestamp");

        assert_eq!(
            value,
            json!({
                "kind": "succeeded",
                "result": {
                    "result": {
                        "lifecycle": "running",
                        "ready": true,
                        "observedAtMs": observed_at_ms,
                    },
                },
            })
        );
    }

    #[test]
    fn lifecycle_failures_are_bounded_and_discard_private_errors() {
        for rejection in [
            unavailable(),
            start_failure(StartOpenClawError::AdmissionClosed),
            stop_failure(StopOpenClawError::AdmissionClosed),
            restart_failure(RestartOpenClawError::AdmissionClosed),
        ] {
            assert_eq!(
                to_value(rejection).unwrap(),
                json!({
                    "kind": "rejected",
                    "error": {
                        "code": "UNAVAILABLE",
                        "message": "Runtime Host is unavailable.",
                    },
                })
            );
        }

        for rejection in [
            start_failure(StartOpenClawError::RuntimeStart),
            stop_failure(StopOpenClawError::RuntimeStop),
            restart_failure(RestartOpenClawError::RuntimeRestart),
        ] {
            let serialized = to_value(rejection).unwrap().to_string();
            assert!(serialized.contains("FAILED"));
            for private in [
                "endpoint",
                "port",
                "token",
                "path",
                "argv",
                "gateway payload",
                "provider metadata",
                "session identity",
                "run identity",
                "message identity",
                "native error",
            ] {
                assert!(!serialized.contains(private));
            }
        }
    }
}
