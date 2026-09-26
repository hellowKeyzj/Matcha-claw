use platform::endpoint::runtime_address::{RuntimeEndpoint, SessionIdentity};

use crate::{
    ports::{SessionOwnershipQuery, SessionOwnershipReader},
    session_catalog::SessionCatalog,
    state::{SessionSourceBinding, SessionView},
    timeline,
};

pub(super) async fn enrich_catalog(
    reader: &dyn SessionOwnershipReader,
    catalog: &mut SessionCatalog,
) {
    let slots = catalog
        .sessions
        .iter_mut()
        .map(|entry| {
            let query = ownership_query(
                entry.endpoint.clone(),
                &entry.agent_id,
                &entry.key,
                &entry.endpoint_session_id,
            );
            (query, &mut entry.ownership)
        })
        .collect();
    enrich(reader, slots).await;
}

pub(super) async fn enrich_views(
    reader: &dyn SessionOwnershipReader,
    views: &mut [SessionView],
) {
    let slots = views
        .iter_mut()
        .map(|view| {
            let query = view_query(view);
            (query, &mut view.ownership)
        })
        .collect();
    enrich(reader, slots).await;
}

pub(super) async fn enrich_timeline(
    reader: &dyn SessionOwnershipReader,
    outcome: &mut timeline::Outcome,
) {
    match outcome {
        timeline::Outcome::Complete(view) | timeline::Outcome::Incomplete(view) => {
            enrich_views(reader, std::slice::from_mut(view)).await;
        }
        timeline::Outcome::Unavailable(_) => {}
    }
}

async fn enrich(
    reader: &dyn SessionOwnershipReader,
    slots: Vec<(Option<SessionOwnershipQuery>, &mut Option<SessionSourceBinding>)>,
) {
    let mut queries = Vec::with_capacity(slots.len());
    let mut outputs = Vec::with_capacity(slots.len());
    for (query, ownership) in slots {
        *ownership = None;
        if let Some(query) = query {
            outputs.push((query.identity.clone(), ownership));
            queries.push(query);
        }
    }
    if queries.is_empty() {
        return;
    }
    let Some(bindings) = reader.lookup(queries).await else {
        return;
    };
    for (identity, ownership) in outputs {
        *ownership = Some(
            bindings
                .get(&identity)
                .cloned()
                .unwrap_or(SessionSourceBinding::Ordinary),
        );
    }
}

fn view_query(view: &SessionView) -> Option<SessionOwnershipQuery> {
    let identity = &view.identity;
    if identity.endpoint.kind != "native-runtime" {
        return None;
    }
    ownership_query(
        RuntimeEndpoint::try_new(
            identity.endpoint.runtime_adapter_id.as_str(),
            identity.endpoint.runtime_instance_id.clone(),
        )
        .ok()?,
        identity.agent_id.as_deref()?,
        identity.session_key(),
        view.endpoint_session_id.as_deref()?,
    )
}

fn ownership_query(
    endpoint: RuntimeEndpoint,
    agent_id: &str,
    session_key: &str,
    endpoint_session_id: &str,
) -> Option<SessionOwnershipQuery> {
    if endpoint_session_id.trim().is_empty() {
        return None;
    }
    Some(SessionOwnershipQuery {
        identity: SessionIdentity::try_new(endpoint, agent_id, session_key).ok()?,
        endpoint_session_id: endpoint_session_id.to_owned(),
    })
}
