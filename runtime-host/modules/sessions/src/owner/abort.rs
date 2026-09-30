use super::actor::SessionShared;
use crate::{
    abort::{NativeEndpoint, SessionAbortCommand, SessionAbortOutcome},
    command::session_lane_key,
    ports::RuntimeOperationFailure,
    trace as session_trace,
};

impl SessionShared {
    pub(super) async fn handle_abort(&self, command: SessionAbortCommand) -> SessionAbortOutcome {
        let started = std::time::Instant::now();
        let trace_id = command.trace_id().map(str::to_owned);
        let lane_key = session_lane_key(command.endpoint.provider(), &command.session_key);
        let runtime_summary = || {
            if trace_id.is_none() || std::env::var("MATCHACLAW_SESSION_TRACE").as_deref() != Ok("1")
            {
                return serde_json::Value::Null;
            }
            let snapshot = self.snapshot.load();
            let runtime = snapshot
                .states
                .get(&lane_key)
                .map(|state| state.view().runtime);
            match runtime {
                Some(crate::state::SessionFact::Complete(runtime))
                | Some(crate::state::SessionFact::Incomplete { facts: runtime, .. }) => {
                    serde_json::json!({
                        "phase": runtime.phase,
                        "activeRunId": session_trace::id_shape(runtime.active_run_id.as_deref()),
                    })
                }
                _ => serde_json::Value::Null,
            }
        };
        session_trace::log(
            "runtime.abort.execution.start",
            trace_id.as_deref(),
            serde_json::json!({
                "endpoint": format!("{:?}", command.endpoint),
                "sessionKey": session_trace::id_shape(Some(&command.session_key)),
                "runId": session_trace::id_shape(command.run_id.as_deref()),
                "runtime": runtime_summary(),
                "elapsedMs": started.elapsed().as_millis(),
            }),
        );
        let command = match self.bind_matcha_abort_command(command) {
            Ok(command) => command,
            Err(outcome) => {
                session_trace::log(
                    "runtime.abort.binding-rejected",
                    trace_id.as_deref(),
                    serde_json::json!({ "outcome": outcome, "elapsedMs": started.elapsed().as_millis() }),
                );
                return outcome;
            }
        };
        let driver = match self.running_session_driver(command.endpoint.runtime_endpoint()) {
            Ok(driver) => driver,
            Err(failure) => {
                let outcome = match failure {
                    RuntimeOperationFailure::Unsupported => SessionAbortOutcome::Unsupported,
                    RuntimeOperationFailure::Unavailable => SessionAbortOutcome::Unavailable,
                    RuntimeOperationFailure::TargetRejected | RuntimeOperationFailure::Unknown => {
                        SessionAbortOutcome::Unknown
                    }
                };
                session_trace::log(
                    "runtime.abort.driver-unavailable",
                    trace_id.as_deref(),
                    serde_json::json!({ "reason": format!("{failure:?}"), "outcome": outcome, "elapsedMs": started.elapsed().as_millis() }),
                );
                return outcome;
            }
        };
        let Some(ops) = driver.session_ops() else {
            session_trace::log(
                "runtime.abort.driver-unavailable",
                trace_id.as_deref(),
                serde_json::json!({ "reason": "session-ops-unsupported", "elapsedMs": started.elapsed().as_millis() }),
            );
            return SessionAbortOutcome::Unsupported;
        };
        session_trace::log(
            "runtime.abort.native.invoke",
            trace_id.as_deref(),
            serde_json::json!({
                "endpointSessionId": session_trace::id_shape(command.endpoint_session_id.as_deref()),
                "runtime": runtime_summary(),
                "elapsedMs": started.elapsed().as_millis(),
            }),
        );
        let outcome = ops.abort_session(command).await;
        session_trace::log(
            "runtime.abort.native.outcome",
            trace_id.as_deref(),
            serde_json::json!({ "outcome": outcome, "runtime": runtime_summary(), "elapsedMs": started.elapsed().as_millis() }),
        );
        outcome
    }

    fn bind_matcha_abort_command(
        &self,
        command: SessionAbortCommand,
    ) -> Result<SessionAbortCommand, SessionAbortOutcome> {
        if command.endpoint != NativeEndpoint::MatchaAgentLocal {
            return Ok(command);
        }
        let lane_key = session_lane_key(command.endpoint.provider(), &command.session_key);
        let session_id = self
            .snapshot
            .load()
            .states
            .get(&lane_key)
            .and_then(|state| state.native_session_id().map(str::to_owned))
            .ok_or(SessionAbortOutcome::Rejected)?;
        command
            .with_endpoint_session_id(session_id)
            .map_err(|_| SessionAbortOutcome::Rejected)
    }
}
