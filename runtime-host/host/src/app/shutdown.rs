use std::time::Duration;

use serde_json::{Value, json};

use crate::{
    composition::{
        HostPhase, HostShutdownError, HostTransitionError, OwnerShutdownFailure,
        SessionShutdownFailure,
    },
    control::ControlError,
    host_actor,
};

const SHUTDOWN_RETRY_INTERVAL: Duration = Duration::from_millis(50);

pub(crate) async fn shutdown_host(owner: &mut host_actor::Owner) -> Result<(), ControlError> {
    loop {
        let attempt = owner.handle().shutdown().await.map_err(|error| {
            trace_actor_error("request", &error);
            ControlError::Owner
        })?;
        platform::trace::runtime_trace("host.shutdown.attempt", || {
            json!({
                "terminal": attempt.terminal,
                "retryable": attempt.retryable,
                "result": match &attempt.result {
                    Ok(_) => json!({ "kind": "ok" }),
                    Err(error) => shutdown_error_fields(error),
                },
            })
        });
        if attempt.terminal {
            let result = attempt
                .result
                .map(|_| ())
                .map_err(|_| ControlError::Shutdown);
            let joined = owner.join().await.map_err(|error| {
                trace_actor_error("join", &error);
                ControlError::Owner
            })?;
            joined.map_err(|error| {
                platform::trace::runtime_trace("host.shutdown.join_failed", || {
                    shutdown_error_fields(&error)
                });
                ControlError::Shutdown
            })?;
            return result;
        }
        if !attempt.retryable {
            return Err(ControlError::Shutdown);
        }
        tokio::time::sleep(SHUTDOWN_RETRY_INTERVAL).await;
    }
}

fn trace_actor_error(source: &'static str, error: &host_actor::Error) {
    platform::trace::runtime_trace("host.shutdown.actor_failed", || {
        let kind = match error {
            host_actor::Error::LifecycleChannelClosed => "lifecycle_closed",
            host_actor::Error::ResponseChannelClosed => "response_closed",
            host_actor::Error::Join(error) if error.is_cancelled() => "join_cancelled",
            host_actor::Error::Join(error) if error.is_panic() => "join_panic",
            host_actor::Error::Join(_) => "join",
        };
        json!({ "resultSource": source, "kind": kind })
    });
}

fn shutdown_error_fields(error: &HostShutdownError) -> Value {
    match error {
        HostShutdownError::Transition(error) => {
            let (kind, phase) = match error {
                HostTransitionError::StartFrom(phase) => ("start_from", phase),
                HostTransitionError::ReadyFrom(phase) => ("ready_from", phase),
                HostTransitionError::ShutdownFrom(phase) => ("shutdown_from", phase),
                HostTransitionError::ShutdownCompleteFrom(phase) => {
                    ("shutdown_complete_from", phase)
                }
            };
            let phase = match phase {
                HostPhase::Created => "created",
                HostPhase::Starting => "starting",
                HostPhase::Ready => "ready",
                HostPhase::ShuttingDown => "shutting_down",
                HostPhase::ShutDown => "shut_down",
            };
            json!({ "kind": "transition", "transition": kind, "phase": phase })
        }
        HostShutdownError::Resources { failures, .. } => json!({
            "kind": "resources",
            "world": failures.world().map(|world| json!({
                "ownerRemaining": world.owner_remaining,
                "storeRemaining": world.store_remaining,
                "retainedResources": world.retained_resources,
                "durableUnsettled": world.durable_unsettled,
                "indeterminateCommits": world.indeterminate_commits,
                "diagnosticCount": world.diagnostic_codes.len(),
            })),
            "worldNative": {
                "count": failures.world_native().len(),
                "openClaw": failures.world_native().contains(&"openclaw"),
                "matcha": failures.world_native().contains(&"matcha-agent"),
            },
            "ownerJoinCount": failures.owner_joins().len(),
            "ownerJoins": failures.owner_joins().iter().map(|owner| match *owner {
                "peer" => "peer",
                "owner-runtime-system" => "owner-runtime-system",
                "provider" => "provider",
                "sessions" => "sessions",
                "fleet" => "fleet",
                "security" => "security",
                "channel" => "channel",
                "connectors" => "connectors",
                "settings" => "settings",
                "organization" => "organization",
                "board" => "board",
                "cron" => "cron",
                "usage" => "usage",
                "diagnostics" => "diagnostics",
                "task-manager" => "task-manager",
                "subagents" => "subagents",
                "workspace" => "workspace",
                "wiki" => "wiki",
                "toolchain" => "toolchain",
                "search" => "search",
                "platform-tools" => "platform-tools",
                "world-epoch-clock" => "world-epoch-clock",
                _ => "other",
            }).collect::<Vec<_>>(),
            "callLog": failures.call_log().map(|error| match error {
                platform::call::CallLogError::InvalidInput => "invalid_input",
                platform::call::CallLogError::QueueFull => "queue_full",
                platform::call::CallLogError::Unavailable => "unavailable",
                platform::call::CallLogError::PersistFailed => "persist_failed",
                platform::call::CallLogError::NotFound => "not_found",
                platform::call::CallLogError::InvalidTransition => "invalid_transition",
            }),
            "organization": failures.organization().map(|error| match error {
                organization::OrganizationShutdownError::Join => "join",
                organization::OrganizationShutdownError::PendingSettlements => "pending_settlements",
            }),
            "organizationTerminal": failures.organization_terminal().map(|error| match error {
                organization::OrganizationTerminalCloseError::Join => "join",
                organization::OrganizationTerminalCloseError::Unsettled => "unsettled",
            }),
            "sessionsTerminal": failures.sessions_terminal().map(|error| match error {
                sessions_module::SessionTerminalCloseError::Join => "join",
                sessions_module::SessionTerminalCloseError::Unsettled => "unsettled",
            }),
            "openClawSession": failures.open_claw_session().map(|error| match error {
                SessionShutdownFailure::Close => "close",
                SessionShutdownFailure::Join => "join",
            }),
            "openClaw": failures.open_claw().map(owner_failure_kind),
            "matcha": failures.matcha().map(owner_failure_kind),
        }),
    }
}

fn owner_failure_kind(error: OwnerShutdownFailure) -> &'static str {
    match error {
        OwnerShutdownFailure::Shutdown => "shutdown",
        OwnerShutdownFailure::Join => "join",
    }
}
