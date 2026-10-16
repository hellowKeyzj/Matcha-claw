mod projection;
mod timeline;

use crate::{
    config::{self, ConfigStore},
    events::Events,
    rpc,
    session::Sessions,
};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyParams {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GetParams {
    session_id: String,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListParams {
    agent_id: Option<String>,
    limit: Option<usize>,
    before_session_id: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecentParams {
    limit: Option<usize>,
    before: Option<timeline::Cursor>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TimeseriesParams {
    session_id: String,
    agent_id: String,
    limit: Option<usize>,
    before: Option<timeline::Cursor>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionRef {
    session_id: String,
    agent_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionPage {
    sessions: Vec<SessionRef>,
    next_before_session_id: Option<String>,
}

/// Read-only metering of durable native results; this module never writes billing or limits.
pub async fn dispatch(
    method: &str,
    params: Value,
    _config: &ConfigStore,
    sessions: &Sessions,
    events: &Events,
) -> rpc::Result<Value> {
    match method {
        "usage.limits" => {
            let _: EmptyParams = rpc::params(if params.is_null() { json!({}) } else { params })?;
            Ok(
                json!({ "defaultLimit": timeline::DEFAULT_LIMIT, "maxLimit": timeline::MAX_LIMIT, "scope": "readPagination" }),
            )
        }
        "usage.recent" => {
            let params: RecentParams =
                rpc::params(if params.is_null() { json!({}) } else { params })?;
            rpc::value(timeline_page(sessions, events, None, params.limit, params.before).await?)
        }
        "usage.sessionTimeseries" => {
            let params: TimeseriesParams = rpc::params(params)?;
            config::validate_id(&params.agent_id)?;
            let session = session_ref(
                sessions
                    .dispatch("sessions.get", json!({ "sessionId": params.session_id }))
                    .await?,
            )?;
            if session.agent_id != params.agent_id {
                return Err(rpc::Error::not_found("Session"));
            }
            rpc::value(
                timeline_page(sessions, events, Some(session), params.limit, params.before).await?,
            )
        }
        "usage.get" => {
            let params: GetParams = rpc::params(params)?;
            let session = sessions
                .dispatch("sessions.get", json!({ "sessionId": params.session_id }))
                .await?;
            rpc::value(project(session_ref(session)?, events).await?)
        }
        "usage.list" => {
            let params: ListParams =
                rpc::params(if params.is_null() { json!({}) } else { params })?;
            if let Some(agent_id) = &params.agent_id {
                config::validate_id(agent_id)?;
            }
            let page = sessions
                .dispatch(
                    "sessions.list",
                    json!({
                        "agentId": params.agent_id,
                        "limit": params.limit.unwrap_or(100),
                        "beforeSessionId": params.before_session_id,
                    }),
                )
                .await?;
            let page: SessionPage = serde_json::from_value(page).map_err(|source| {
                rpc::Error::internal("usage_session_page_invalid").with_source(source)
            })?;
            let mut usage = Vec::with_capacity(page.sessions.len());
            for session in page.sessions {
                usage.push(project(session, events).await?);
            }
            Ok(json!({ "usage": usage, "nextBeforeSessionId": page.next_before_session_id }))
        }
        _ => Err(rpc::Error::method(method)),
    }
}

fn session_ref(value: Value) -> rpc::Result<SessionRef> {
    serde_json::from_value(value)
        .map_err(|source| rpc::Error::internal("usage_session_invalid").with_source(source))
}

async fn timeline_page(
    sessions: &Sessions,
    events: &Events,
    session: Option<SessionRef>,
    limit: Option<usize>,
    before: Option<timeline::Cursor>,
) -> rpc::Result<timeline::Page> {
    let limit = timeline::limit(limit)?;
    let before = before.as_ref().map(timeline::Cursor::native).transpose()?;
    let session_id = session.as_ref().map(|session| session.session_id.as_str());
    if let (Some(session_id), Some(before)) = (session_id, before.as_ref())
        && before.session_id != session_id
    {
        return Err(rpc::Error::invalid(
            "Usage cursor belongs to another session",
        ));
    }
    let mut results = events
        .query_native_results(session_id, before.as_ref(), limit + 1)
        .await?;
    let has_more = results.len() > limit;
    results.truncate(limit);
    let after = if has_more {
        results
            .last()
            .map(|result| crate::events::NativeResultCursor {
                at_ms: result.event.at_ms,
                session_id: result.event.session_id.clone(),
                seq: result.event.seq,
            })
    } else {
        None
    };
    let native_outcome_unknown = events
        .has_native_usage_gap(session_id, after.as_ref(), before.as_ref())
        .await?;
    let mut agents = std::collections::BTreeMap::new();
    if let Some(session) = session {
        agents.insert(session.session_id, session.agent_id);
    }
    let mut entries = Vec::with_capacity(results.len());
    for result in results {
        let session_id = &result.event.session_id;
        if !agents.contains_key(session_id) {
            let session = session_ref(
                sessions
                    .dispatch("sessions.get", json!({ "sessionId": session_id }))
                    .await?,
            )?;
            agents.insert(session.session_id, session.agent_id);
        }
        let agent_id = agents
            .get(session_id)
            .expect("result session was resolved")
            .clone();
        entries.push(timeline::Point::new(result, agent_id));
    }
    let next_before = if has_more {
        entries.last().map(timeline::Point::cursor)
    } else {
        None
    };
    Ok(timeline::Page {
        entries,
        next_before,
        coverage: "observedDurableResultsOnly",
        native_outcome_unknown,
    })
}

async fn project(session: SessionRef, events: &Events) -> rpc::Result<projection::SessionUsage> {
    let through_seq = events.latest(&session.session_id).await?;
    let native_outcome_unknown = events
        .has_native_usage_gap(Some(&session.session_id), None, None)
        .await?;
    let mut projection = projection::Projection::new(
        session.session_id.clone(),
        session.agent_id,
        through_seq,
        native_outcome_unknown,
    );
    let mut after_seq = 0;
    loop {
        // A storage page, not a business quota; token/progress payloads are excluded by SQL.
        let page = events
            .query_kinds(
                &session.session_id,
                after_seq,
                through_seq,
                &["cli.started", "native.result"],
                256,
            )
            .await?;
        if page.is_empty() {
            break;
        }
        for event in page {
            after_seq = event.seq;
            projection.observe(event);
        }
    }
    Ok(projection.finish())
}
