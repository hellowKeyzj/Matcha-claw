use platform::endpoint::runtime_address::RuntimeEndpoint;
use provider_module::{ProviderSessionEndpoint, ProviderSessionModelSelectionOutcome};

use super::actor::{SessionLane, SessionShared};
use crate::{
    ports::RuntimeOperationFailure,
    state::SessionProvider,
    thinking::{
        SessionThinkingAction, SessionThinkingCommand, SessionThinkingOutcome, ThinkingModel,
        ThinkingRuntime,
    },
};

impl SessionLane {
    pub(super) async fn handle_thinking(
        &mut self,
        shared: &SessionShared,
        mut command: SessionThinkingCommand,
    ) -> SessionThinkingOutcome {
        let runtime = command.runtime();
        let trace_id = command.trace_id().map(str::to_owned);
        let operation = match &command.action {
            SessionThinkingAction::Get => "get",
            SessionThinkingAction::Set { .. } => "set",
        };
        let failed = |reason: &'static str, outcome| {
            crate::trace::log("runtime.thinking.owner-failed", trace_id.as_deref(), || {
                serde_json::json!({ "operation": operation, "runtime": runtime, "reason": reason })
            });
            outcome
        };
        if !command.valid() {
            return failed("invalid_command", SessionThinkingOutcome::Rejected(runtime));
        }
        crate::trace::log("runtime.thinking.owner", trace_id.as_deref(), || {
            serde_json::json!({
                "operation": operation, "runtime": runtime,
                "scope": if command.scope.identity().is_some() { "session" } else { "agent" },
                "identity": command.scope.identity().map(crate::trace::identity_shape),
                "agentHash": crate::trace::fingerprint(command.scope.agent_id()),
                "instanceHash": crate::trace::fingerprint(&command.scope.endpoint().runtime_instance_id),
                "selectionHash": match &command.model {
                    Some(ThinkingModel::Selection(id)) => Some(crate::trace::fingerprint(id)),
                    _ => None,
                },
                "requestedLevel": match &command.action {
                    SessionThinkingAction::Set { level } => level.as_deref().map(level_label),
                    SessionThinkingAction::Get => None,
                },
                "hasActiveRun": self.state.as_ref().is_some_and(|state| state.active_run_id().is_some()),
                "executionPending": command.scope.identity().is_some_and(|identity| shared.session_execution_pending(identity)),
                "pendingCompletions": self.has_pending_completions(),
            })
        });
        if shared.terminal_delivery.is_stopping() {
            return failed("stopping", SessionThinkingOutcome::Unavailable(runtime));
        }
        if let Some(identity) = command.scope.identity()
            && self.state.as_ref().is_some_and(|state| state.identity() != identity)
        {
            return failed("identity_mismatch", SessionThinkingOutcome::Rejected(runtime));
        }
        let endpoint = command.scope.endpoint();
        let driver = match shared.running_session_driver(
            RuntimeEndpoint::try_new(endpoint.provider().as_str(), &endpoint.runtime_instance_id)
                .ok(),
        ) {
            Ok(driver) => driver,
            Err(failure) => {
                return failed(
                    match failure {
                        RuntimeOperationFailure::Unsupported => "driver_unsupported",
                        RuntimeOperationFailure::Unavailable => "driver_unavailable",
                        RuntimeOperationFailure::HistoryRetryPending => "driver_history_retry_pending",
                        RuntimeOperationFailure::TargetRejected => "driver_rejected",
                        RuntimeOperationFailure::Unknown => "driver_unknown",
                    },
                    driver_failure(runtime, failure),
                );
            }
        };
        if let Some(ThinkingModel::Selection(selection_id)) = &command.model {
            let endpoint = match command.scope.endpoint().provider() {
                SessionProvider::OpenClaw => ProviderSessionEndpoint::OpenClawLocal,
                SessionProvider::MatchaAgent => ProviderSessionEndpoint::MatchaAgentLocal,
            };
            let session_key = command
                .scope
                .identity()
                .map(|identity| identity.session_key.clone())
                .unwrap_or_default();
            let selection = match shared
                .provider_handle
                .select_session_model(endpoint, session_key, None, selection_id.clone(), trace_id.clone())
                .await
            {
                Ok(ProviderSessionModelSelectionOutcome::Selected(selection)) => selection,
                Ok(ProviderSessionModelSelectionOutcome::Unsupported) => {
                    return failed("provider_unsupported", SessionThinkingOutcome::Unsupported(runtime));
                }
                Ok(ProviderSessionModelSelectionOutcome::Rejected) => {
                    return failed("provider_rejected", SessionThinkingOutcome::Rejected(runtime));
                }
                Ok(ProviderSessionModelSelectionOutcome::Unavailable) => {
                    return failed("provider_unavailable", SessionThinkingOutcome::Unavailable(runtime));
                }
                Err(()) => {
                    return failed("provider_owner_unavailable", SessionThinkingOutcome::Unavailable(runtime));
                }
            };
            crate::trace::log("runtime.thinking.provider-resolved", trace_id.as_deref(), || {
                serde_json::json!({
                    "runtime": runtime, "selectionHash": crate::trace::fingerprint(selection_id),
                    "accountHash": crate::trace::fingerprint(&selection.account_id),
                    "modelHash": crate::trace::fingerprint(&selection.model_id),
                    "protocol": selection.protocol,
                })
            });
            let protocol = selection.protocol.map(str::to_owned);
            command.model = Some(match endpoint {
                ProviderSessionEndpoint::OpenClawLocal => {
                    let Some((provider, model)) = selection.runtime_model_ref.split_once('/')
                    else {
                        return failed("provider_model_ref_invalid", SessionThinkingOutcome::Unavailable(runtime));
                    };
                    ThinkingModel::Native {
                        model: model.to_owned(),
                        provider: Some(provider.to_owned()),
                        protocol,
                    }
                }
                ProviderSessionEndpoint::MatchaAgentLocal => ThinkingModel::Native {
                    model: selection.model_id,
                    provider: None,
                    protocol,
                },
            });
            if !command.valid() {
                return failed("provider_model_invalid", SessionThinkingOutcome::Unavailable(runtime));
            }
        }
        let Some(ops) = driver.session_ops() else {
            return failed("missing_session_ops", SessionThinkingOutcome::Unsupported(runtime));
        };
        crate::trace::log("runtime.thinking.native-dispatch", trace_id.as_deref(), || {
            serde_json::json!({ "operation": operation, "runtime": runtime })
        });
        let outcome = ops.session_thinking(command.clone()).await;
        let outcome = command.validate_outcome(outcome);
        crate::trace::log("runtime.thinking.native-outcome", trace_id.as_deref(), || {
            let (snapshot, confirmed, applied) = match &outcome {
                SessionThinkingOutcome::Available(snapshot) => (Some(snapshot), false, None),
                SessionThinkingOutcome::Confirmed { snapshot, applied } => (Some(snapshot), true, Some(*applied)),
                _ => (None, false, None),
            };
            serde_json::json!({
                "operation": operation, "runtime": runtime,
                "outcome": match &outcome {
                    SessionThinkingOutcome::Available(_) => "available",
                    SessionThinkingOutcome::Confirmed { .. } => "confirmed",
                    SessionThinkingOutcome::Unsupported(_) => "unsupported",
                    SessionThinkingOutcome::Unavailable(_) => "unavailable",
                    SessionThinkingOutcome::Rejected(_) => "rejected",
                    SessionThinkingOutcome::Unknown(_) => "unknown",
                },
                "level": snapshot.and_then(|snapshot| snapshot.level.as_deref()).map(level_label),
                "effectiveLevel": snapshot.and_then(|snapshot| snapshot.effective_level.as_deref()).map(level_label),
                "options": snapshot.map(|snapshot| snapshot.options.iter().map(|level| level_label(level)).collect::<Vec<_>>()),
                "confirmed": confirmed, "applied": applied,
            })
        });
        outcome
    }
}

fn level_label(level: &str) -> &'static str {
    match level {
        "off" => "off",
        "on" => "on",
        "minimal" => "minimal",
        "low" => "low",
        "medium" => "medium",
        "high" => "high",
        "xhigh" => "xhigh",
        "max" => "max",
        "ultra" => "ultra",
        _ => "other",
    }
}

fn driver_failure(
    runtime: ThinkingRuntime,
    failure: RuntimeOperationFailure,
) -> SessionThinkingOutcome {
    match failure {
        RuntimeOperationFailure::Unsupported => SessionThinkingOutcome::Unsupported(runtime),
        RuntimeOperationFailure::Unavailable | RuntimeOperationFailure::HistoryRetryPending => {
            SessionThinkingOutcome::Unavailable(runtime)
        }
        RuntimeOperationFailure::TargetRejected => SessionThinkingOutcome::Rejected(runtime),
        RuntimeOperationFailure::Unknown => SessionThinkingOutcome::Unknown(runtime),
    }
}
