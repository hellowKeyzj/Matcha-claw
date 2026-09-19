use std::{collections::HashMap, future::Future, pin::Pin, sync::Arc};

use openclaw::{
    port::OpenClawSessionError,
    session::protocol::{
        ChatAbortParams, ChatAbortResult, ChatHistoryParams, ChatHistoryResult, ChatSendParams,
        ChatSendResult,
    },
};
use platform::exchange::InvocationOutcome;
use tokio::sync::oneshot;

use crate::{
    RuntimeSessionError,
    runtime::{
        directory::RuntimeDriverDirectory,
        driver::{LifecycleOps, RuntimeDriver, RuntimeDriverIdentity},
    },
};

pub(crate) type SessionResult<T> = Result<T, RuntimeSessionError<OpenClawSessionError>>;
pub(crate) type InvocationResult<T> =
    Result<InvocationOutcome<T, OpenClawSessionError>, RuntimeSessionError<OpenClawSessionError>>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SessionCatalog {
    pub(crate) sessions: Vec<SessionCatalogEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SessionCatalogEntry {
    pub(crate) key: String,
    pub(crate) agent_id: String,
    pub(crate) endpoint_session_id: String,
    pub(crate) model: Option<String>,
    pub(crate) updated_at: Option<u64>,
}

/// Indices of the entries that carry a `Some(model)` ref, paired with that ref in the same order.
pub(crate) fn catalog_model_refs(catalog: &SessionCatalog) -> Vec<(usize, String)> {
    catalog
        .sessions
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| entry.model.clone().map(|model| (index, model)))
        .collect()
}

/// Catalog entries whose model ref the provider catalog no longer accepts.
pub(crate) fn stale_catalog_models(
    catalog: &SessionCatalog,
    refs: &[(usize, String)],
    accepted: &[bool],
) -> Vec<(usize, String)> {
    refs.iter()
        .zip(accepted)
        .filter(|(_, accepted)| !**accepted)
        .map(|((index, _), _)| (*index, catalog.sessions[*index].agent_id.clone()))
        .collect()
}

/// Agents owning a stale model ref, deduplicated in first-seen order. Each distinct agent is
/// consulted for its configured default at most once per catalog.
pub(crate) fn stale_catalog_agents(stale: &[(usize, String)]) -> Vec<String> {
    let mut agents = Vec::new();
    for (_, agent_id) in stale {
        if !agents.contains(agent_id) {
            agents.push(agent_id.clone());
        }
    }
    agents
}

/// Applies model-ref corrections, leaving every other catalog entry field untouched.
pub(crate) fn correct_catalog_models(
    mut catalog: SessionCatalog,
    corrections: Vec<(usize, Option<String>)>,
) -> SessionCatalog {
    for (index, model) in corrections {
        catalog.sessions[index].model = model;
    }
    catalog
}

/// Result of asking the provider catalog which refs it still accepts.
pub(crate) enum CatalogModelJudgement {
    /// One bool per ref returned by [`catalog_model_refs`], in the same order.
    Accepted(Vec<bool>),
    /// The judgement is unavailable; the catalog is delivered unmodified.
    Unavailable,
}

/// Boxed future returned by the reconciliation callbacks, matching the driver boundary style.
pub(crate) type CatalogModelFuture<'a> = Pin<Box<dyn Future<Output = Option<String>> + Send + 'a>>;

/// Read-only list projection: corrects OpenClaw catalog model refs that our own provider catalog
/// no longer accepts, and reports how many entries it corrected. Never writes back to the
/// runtime, and never fails the list.
///
/// `judge` runs once for the whole catalog. `agent_default_model` runs at most once per distinct
/// agent owning a stale ref (owned argument, so the returned future carries no caller borrow), and
/// `rebound` once per stale ref.
pub(crate) async fn reconcile_catalog_models<Judge, Defaults, Rebound>(
    catalog: SessionCatalog,
    judge: Judge,
    agent_default_model: Defaults,
    rebound: Rebound,
) -> (SessionCatalog, usize)
where
    Judge: AsyncFnOnce(Vec<String>) -> CatalogModelJudgement,
    Defaults: Fn(String) -> CatalogModelFuture<'static>,
    Rebound:
        for<'entry> Fn(&'entry SessionCatalogEntry, Option<String>) -> CatalogModelFuture<'entry>,
{
    let refs = catalog_model_refs(&catalog);
    if refs.is_empty() {
        return (catalog, 0);
    }
    let model_refs = refs
        .iter()
        .map(|(_, model)| model.clone())
        .collect::<Vec<_>>();
    let CatalogModelJudgement::Accepted(accepted) = judge(model_refs).await else {
        return (catalog, 0);
    };
    let stale = stale_catalog_models(&catalog, &refs, &accepted);
    if stale.is_empty() {
        return (catalog, 0);
    }

    let mut defaults = HashMap::<String, Option<String>>::new();
    for agent_id in stale_catalog_agents(&stale) {
        let default_model = agent_default_model(agent_id.clone()).await;
        defaults.insert(agent_id, default_model);
    }
    let mut corrections = Vec::with_capacity(stale.len());
    for (index, agent_id) in stale {
        let entry = &catalog.sessions[index];
        let resolved = rebound(entry, defaults.get(&agent_id).cloned().flatten()).await;
        corrections.push((index, resolved));
    }
    let corrected = corrections.len();
    (correct_catalog_models(catalog, corrections), corrected)
}

pub(crate) struct SendCommand {
    pub(crate) params: ChatSendParams,
    pub(crate) reply: oneshot::Sender<InvocationResult<ChatSendResult>>,
}

impl SendCommand {
    pub(crate) fn send_unavailable(self) {
        let _ = self
            .reply
            .send(Err(RuntimeSessionError::RuntimeUnavailable));
    }
}

pub(crate) struct AbortCommand {
    pub(crate) params: ChatAbortParams,
    pub(crate) reply: oneshot::Sender<InvocationResult<ChatAbortResult>>,
}

impl AbortCommand {
    pub(crate) fn send_unavailable(self) {
        let _ = self
            .reply
            .send(Err(RuntimeSessionError::RuntimeUnavailable));
    }
}

pub(crate) struct Query {
    request: QueryRequest,
}

enum QueryRequest {
    ListSessions {
        reply: oneshot::Sender<SessionResult<SessionCatalog>>,
    },
    History {
        params: ChatHistoryParams,
        reply: oneshot::Sender<SessionResult<ChatHistoryResult>>,
    },
}

impl Query {
    pub(crate) fn list_sessions(reply: oneshot::Sender<SessionResult<SessionCatalog>>) -> Self {
        Self {
            request: QueryRequest::ListSessions { reply },
        }
    }

    pub(crate) fn history(
        params: ChatHistoryParams,
        reply: oneshot::Sender<SessionResult<ChatHistoryResult>>,
    ) -> Self {
        Self {
            request: QueryRequest::History { params, reply },
        }
    }

    pub(crate) fn send_unavailable(self) {
        match self.request {
            QueryRequest::ListSessions { reply } => {
                let _ = reply.send(Err(RuntimeSessionError::RuntimeUnavailable));
            }
            QueryRequest::History { reply, .. } => {
                let _ = reply.send(Err(RuntimeSessionError::RuntimeUnavailable));
            }
        }
    }
}

pub(crate) async fn reply_query(
    runtime_directory: &RuntimeDriverDirectory,
    query: Query,
    reconcile_catalog: impl AsyncFnOnce(SessionCatalog) -> SessionCatalog,
) {
    match query.request {
        QueryRequest::ListSessions { reply } => {
            let outcome = match list_sessions(runtime_directory).await {
                Ok(catalog) => Ok(reconcile_catalog(catalog).await),
                Err(error) => Err(error),
            };
            let _ = reply.send(outcome);
        }
        QueryRequest::History { params, reply } => {
            let outcome = history(runtime_directory, params).await;
            let _ = reply.send(outcome);
        }
    }
}

pub(crate) async fn list_sessions(
    runtime_directory: &RuntimeDriverDirectory,
) -> SessionResult<SessionCatalog> {
    let driver = openclaw_session_driver(runtime_directory)?;
    let Some(ops) = driver.session_ops() else {
        return Err(RuntimeSessionError::RuntimeUnavailable);
    };
    ops.openclaw_session_catalog().await
}

pub(crate) async fn history(
    runtime_directory: &RuntimeDriverDirectory,
    params: ChatHistoryParams,
) -> SessionResult<ChatHistoryResult> {
    let driver = openclaw_session_driver(runtime_directory)?;
    let Some(ops) = driver.session_ops() else {
        return Err(RuntimeSessionError::RuntimeUnavailable);
    };
    ops.history(params).await
}

pub(crate) async fn send_chat(
    runtime_directory: &RuntimeDriverDirectory,
    params: ChatSendParams,
) -> InvocationResult<ChatSendResult> {
    let driver = openclaw_session_driver(runtime_directory)?;
    let Some(ops) = driver.session_ops() else {
        return Err(RuntimeSessionError::RuntimeUnavailable);
    };
    ops.send_open_claw_chat(params).await
}

pub(crate) async fn abort_chat(
    runtime_directory: &RuntimeDriverDirectory,
    params: ChatAbortParams,
) -> InvocationResult<ChatAbortResult> {
    let driver = openclaw_session_driver(runtime_directory)?;
    let Some(ops) = driver.session_ops() else {
        return Err(RuntimeSessionError::RuntimeUnavailable);
    };
    ops.abort_open_claw_chat(params).await
}

fn openclaw_session_driver(
    runtime_directory: &RuntimeDriverDirectory,
) -> SessionResult<Arc<dyn RuntimeDriver>> {
    let driver = runtime_directory
        .lookup(&RuntimeDriverIdentity::open_claw().endpoint())
        .ok_or(RuntimeSessionError::RuntimeUnavailable)?;
    if !driver.lifecycle_ops().is_some_and(LifecycleOps::readiness) {
        return Err(RuntimeSessionError::RuntimeUnavailable);
    }
    if driver.session_ops().is_none() {
        return Err(RuntimeSessionError::RuntimeUnavailable);
    }
    Ok(driver)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(key: &str, agent_id: &str, model: Option<&str>) -> SessionCatalogEntry {
        SessionCatalogEntry {
            key: key.to_owned(),
            agent_id: agent_id.to_owned(),
            endpoint_session_id: format!("{key}:native"),
            model: model.map(str::to_owned),
            updated_at: Some(7),
        }
    }

    fn catalog() -> SessionCatalog {
        SessionCatalog {
            sessions: vec![
                entry("valid", "agent-a", Some("openai/gpt-5")),
                entry("stale", "agent-a", Some("custom-cc367df7/glm-5.2")),
                entry("unset", "agent-b", None),
            ],
        }
    }

    #[tokio::test]
    async fn reconciles_only_stale_models_and_preserves_every_other_field() {
        let original = catalog();
        let default_lookups = std::cell::RefCell::new(Vec::new());

        let (reconciled, corrected) = reconcile_catalog_models(
            original.clone(),
            async |refs| {
                assert_eq!(
                    refs,
                    vec![
                        "openai/gpt-5".to_owned(),
                        "custom-cc367df7/glm-5.2".to_owned()
                    ]
                );
                CatalogModelJudgement::Accepted(vec![true, false])
            },
            |agent_id| {
                default_lookups.borrow_mut().push(agent_id);
                Box::pin(async { Some("openai/gpt-5".to_owned()) })
            },
            |entry, default_model| {
                assert_eq!(entry.key, "stale");
                assert_eq!(default_model.as_deref(), Some("openai/gpt-5"));
                Box::pin(async { Some("openai/gpt-5".to_owned()) })
            },
        )
        .await;

        assert_eq!(corrected, 1);
        assert_eq!(default_lookups.into_inner(), vec!["agent-a".to_owned()]);
        assert_eq!(reconciled.sessions[0], original.sessions[0]);
        assert_eq!(
            reconciled.sessions[1].model.as_deref(),
            Some("openai/gpt-5")
        );
        assert_eq!(reconciled.sessions[1].key, original.sessions[1].key);
        assert_eq!(
            reconciled.sessions[1].endpoint_session_id,
            original.sessions[1].endpoint_session_id
        );
        assert_eq!(
            reconciled.sessions[1].updated_at,
            original.sessions[1].updated_at
        );
        assert_eq!(reconciled.sessions[2], original.sessions[2]);
        assert_eq!(reconciled.sessions[2].model, None);
    }
}
