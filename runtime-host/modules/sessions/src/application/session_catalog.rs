use std::{collections::HashMap, future::Future, pin::Pin};

use platform::endpoint::runtime_address::RuntimeEndpoint;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionCatalogCommand {
    endpoint: RuntimeEndpoint,
}

impl SessionCatalogCommand {
    pub fn new(endpoint: RuntimeEndpoint) -> Self {
        Self { endpoint }
    }

    pub fn endpoint(&self) -> &RuntimeEndpoint {
        &self.endpoint
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionCatalog {
    pub sessions: Vec<SessionCatalogEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionCatalogEntry {
    pub endpoint: RuntimeEndpoint,
    pub key: String,
    pub agent_id: String,
    pub endpoint_session_id: String,
    pub model: Option<String>,
    pub updated_at: Option<u64>,
    pub preferred: Option<bool>,
    pub protocol_id: Option<String>,
    pub runtime_endpoint_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionCatalogOutcome {
    Listed(SessionCatalog),
    Unavailable,
}

/// Indices of the entries that carry a `Some(model)` ref, paired with that ref in the same order.
pub fn catalog_model_refs(catalog: &SessionCatalog) -> Vec<(usize, String)> {
    catalog
        .sessions
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| entry.model.clone().map(|model| (index, model)))
        .collect()
}

/// Catalog entries whose model ref the provider catalog no longer accepts.
pub fn stale_catalog_models(
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
pub fn stale_catalog_agents(stale: &[(usize, String)]) -> Vec<String> {
    let mut agents = Vec::new();
    for (_, agent_id) in stale {
        if !agents.contains(agent_id) {
            agents.push(agent_id.clone());
        }
    }
    agents
}

/// Applies model-ref corrections, leaving every other catalog entry field untouched.
pub fn correct_catalog_models(
    mut catalog: SessionCatalog,
    corrections: Vec<(usize, Option<String>)>,
) -> SessionCatalog {
    for (index, model) in corrections {
        catalog.sessions[index].model = model;
    }
    catalog
}

/// Result of asking the provider catalog which refs it still accepts.
pub enum CatalogModelJudgement {
    /// One bool per ref returned by [`catalog_model_refs`], in the same order.
    Accepted(Vec<bool>),
    /// The judgement is unavailable; the catalog is delivered unmodified.
    Unavailable,
}

/// Boxed future returned by the reconciliation callbacks, matching the driver boundary style.
pub type CatalogModelFuture<'a> = Pin<Box<dyn Future<Output = Option<String>> + Send + 'a>>;

/// Read-only list projection: corrects catalog model refs that our own provider catalog no longer
/// accepts, and reports how many entries it corrected. Never writes back to the runtime, and never
/// fails the list.
///
/// `judge` runs once for the whole catalog. `agent_default_model` runs at most once per distinct
/// agent owning a stale ref (owned argument, so the returned future carries no caller borrow), and
/// `rebound` once per stale ref.
pub async fn reconcile_catalog_models<Judge, Defaults, Rebound>(
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

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint() -> RuntimeEndpoint {
        RuntimeEndpoint::try_new("openclaw", "local").unwrap()
    }

    fn entry(key: &str, agent_id: &str, model: Option<&str>) -> SessionCatalogEntry {
        SessionCatalogEntry {
            endpoint: endpoint(),
            key: key.to_owned(),
            agent_id: agent_id.to_owned(),
            endpoint_session_id: format!("{key}:native"),
            model: model.map(str::to_owned),
            updated_at: Some(7),
            preferred: None,
            protocol_id: None,
            runtime_endpoint_id: None,
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
