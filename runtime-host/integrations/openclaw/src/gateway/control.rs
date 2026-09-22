use serde_json::{Value, json};

use crate::{
    gateway::wire::{GatewayHealthSnapshot, GatewayStatusSnapshot},
    port::OpenClawControlReadiness,
};

pub fn project_control_readiness(readiness: OpenClawControlReadiness) -> Value {
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
        OpenClawControlReadiness::Unavailable => unavailable_control_readiness(),
    }
}

pub fn unavailable_control_readiness() -> Value {
    json!({
        "ready": false,
        "phase": "unavailable",
        "retryable": false,
    })
}

pub fn project_gateway_health(health: GatewayHealthSnapshot) -> Value {
    json!({
        "result": {
            "ok": health.ok,
            "timestampMs": health.timestamp_ms,
            "durationMs": health.duration_ms,
            "channelCount": health.channel_count,
            "agentCount": health.agent_count,
            "sessionCount": health.session_count,
        }
    })
}

pub fn project_gateway_status(status: GatewayStatusSnapshot) -> Value {
    json!({
        "result": {
            "sessionCount": status.session_count,
            "channelCount": status.channel_count,
            "heartbeatEnabled": status.heartbeat_enabled,
        }
    })
}

pub fn project_control_ui_url(url: String) -> Value {
    json!({ "result": { "url": url } })
}

pub fn project_gateway_snapshot(
    health: GatewayHealthSnapshot,
    status: Option<GatewayStatusSnapshot>,
) -> Value {
    json!({
        "availability": "available",
        "ok": health.ok,
        "timestampMs": health.timestamp_ms,
        "durationMs": health.duration_ms,
        "channelCount": health.channel_count,
        "agentCount": health.agent_count,
        "sessionCount": health.session_count,
        "heartbeatEnabled": status.map(|status| status.heartbeat_enabled),
    })
}

pub fn unavailable_gateway_snapshot() -> Value {
    json!({ "availability": "unavailable" })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_readiness_projection_is_exact_and_redacted() {
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
            let serialized = project_control_readiness(readiness).to_string();
            assert_eq!(
                serde_json::from_str::<Value>(&serialized).unwrap(),
                expected
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
}
