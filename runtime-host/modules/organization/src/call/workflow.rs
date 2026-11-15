use std::future::Future;

use futures_util::future::{BoxFuture, Either};
use platform::trace::{session_trace, with_session_trace};
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::{CallWorkflow, TeamWorkflow};
use crate::{OrganizationHandle, adapters::loopback, future::boxed};

pub(super) fn execute(
    workflow: CallWorkflow,
    shutdown: CancellationToken,
) -> impl Future<Output = ()> + Send {
    // Select one workflow before tracing; unrelated branches never share an async frame.
    let (trace_id, future): (_, BoxFuture<'static, ()>) = match workflow {
        CallWorkflow::Team { owner, request } => {
            let owner = owner.with_cancellation(shutdown.clone());
            (owner.call_trace_id(), team(owner, request))
        }
        CallWorkflow::Runtime { owner, command, reply } => {
            let owner = owner.with_cancellation(shutdown.clone());
            let trace_id = owner.call_trace_id();
            (trace_id, boxed(move || async move {
                session_trace("runtime.team.workflow.start", || json!({}));
                let outcome = if owner.call_running().await {
                    owner.execute_team_runtime_inline(command).await
                } else {
                    Err(crate::owner::handle::closed_error())
                };
                owner.finish_workflow(outcome.is_err()).await;
                let sent = reply.send(outcome).is_ok();
                session_trace("runtime.team.workflow.reply", || json!({"sent": sent}));
                session_trace("runtime.team.workflow.end", || json!({}));
            }))
        }
        CallWorkflow::Graph { owner, request, reply } => {
            let owner = owner.with_cancellation(shutdown.clone());
            let future: BoxFuture<'static, ()> = boxed(move || async move {
                let outcome = if owner.call_running().await {
                    loopback::graph::handle(&owner, request).await
                } else {
                    loopback::graph::Delivery::Unavailable
                };
                owner.summarize_call(&outcome).await;
                owner.finish_workflow(false).await;
                let _ = reply.send(outcome);
            });
            return Either::Left(future);
        }
        CallWorkflow::Capability { owner, request, resolver, reply } => {
            let owner = owner.with_cancellation(shutdown.clone());
            let trace_id = owner.call_trace_id();
            (trace_id, boxed(move || async move {
                session_trace("runtime.team.workflow.start", || json!({}));
                let outcome = if owner.call_running().await {
                    owner.execute_runtime_capability_inline(resolver, request).await
                } else {
                    Err(crate::TeamRuntimeDecodeError::Unavailable)
                };
                owner.finish_workflow(outcome.is_err()).await;
                if let Some(reply) = reply {
                    let sent = reply.send(outcome).is_ok();
                    session_trace("runtime.team.workflow.reply", || json!({"sent": sent}));
                }
                session_trace("runtime.team.workflow.end", || json!({}));
            }))
        }
    };
    Either::Right(with_session_trace(trace_id, future))
}

fn team(owner: OrganizationHandle, request: TeamWorkflow) -> BoxFuture<'static, ()> {
    match request {
        TeamWorkflow::Skill(request) => boxed(move || async move {
            session_trace("runtime.team.workflow.start", || json!({}));
            let failed = if owner.call_running().await {
                matches!(
                    loopback::skill::dispatch(&owner, request).await,
                    loopback::skill::Delivery::Unavailable
                )
            } else {
                true
            };
            owner.finish_workflow(failed).await;
            session_trace("runtime.team.workflow.end", || json!({}));
        }),
        TeamWorkflow::Manual(request) => boxed(move || async move {
            session_trace("runtime.team.workflow.start", || json!({}));
            let failed = if owner.call_running().await {
                let outcome = loopback::manual::dispatch(&owner, request).await;
                if matches!(outcome, loopback::manual::Delivery::Rejected) {
                    owner.summarize_call(&crate::TeamRuntimeStatus::Rejected).await;
                }
                matches!(outcome, loopback::manual::Delivery::Unavailable)
            } else {
                true
            };
            owner.finish_workflow(failed).await;
            session_trace("runtime.team.workflow.end", || json!({}));
        }),
        TeamWorkflow::RunDelete { run_id, idempotency_key, observed_at } => boxed(move || async move {
            session_trace("runtime.team.workflow.start", || json!({}));
            let failed = if owner.call_running().await {
                owner.run_delete_and_purge(run_id, idempotency_key, observed_at).await.is_err()
            } else {
                true
            };
            owner.finish_workflow(failed).await;
            session_trace("runtime.team.workflow.end", || json!({}));
        }),
    }
}
