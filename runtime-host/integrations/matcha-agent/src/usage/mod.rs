use chrono::{DateTime, SecondsFormat};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{client::Client, driver::MatchaRuntimeDriver};
use ::usage::{UsageEntry, UsageOps, UsageReadError, ports::UsageFuture};

const DEFAULT_LIMIT: usize = 100;
const MAX_LIMIT: usize = 1_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

impl UsageOps for MatchaRuntimeDriver {
    fn usage_recent<'a>(
        &'a self,
        limit: usize,
    ) -> UsageFuture<'a, Result<Vec<UsageEntry>, UsageReadError>> {
        Box::pin(async move {
            if limit == 0 || limit > MAX_LIMIT {
                return Err(UsageReadError::Unavailable);
            }
            let page = read_page(
                &self.native_client(),
                "usage.recent",
                json!({ "limit": limit }),
            )
            .await?;
            page.entries.into_iter().map(project).collect()
        })
    }

    fn session_usage_timeseries<'a>(
        &'a self,
        agent_id: &'a str,
        session_id: &'a str,
    ) -> UsageFuture<'a, Result<Vec<UsageEntry>, UsageReadError>> {
        Box::pin(async move {
            let client = self.native_client();
            let mut before = None;
            let mut entries = Vec::new();
            loop {
                let page = read_page(
                    &client,
                    "usage.sessionTimeseries",
                    json!({
                        "agentId": agent_id, "sessionId": session_id,
                        "limit": MAX_LIMIT, "before": before,
                    }),
                )
                .await?;
                for point in page.entries {
                    if point.session_id != session_id || point.agent_id != agent_id {
                        return Err(UsageReadError::Unavailable);
                    }
                    entries.push(project(point)?);
                }
                let Some(next) = page.next_before else { break };
                if next.session_id != session_id
                    || before.as_ref().is_some_and(|old| !next.precedes(old))
                {
                    return Err(UsageReadError::Unavailable);
                }
                before = Some(next);
            }
            entries.reverse();
            Ok(entries)
        })
    }

    fn default_usage_limit(&self) -> usize {
        DEFAULT_LIMIT
    }

    fn max_usage_limit(&self) -> usize {
        MAX_LIMIT
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    entries: Vec<Point>,
    next_before: Option<Cursor>,
    coverage: String,
    native_outcome_unknown: bool,
}

#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Cursor {
    at_ms: u64,
    session_id: String,
    seq: u64,
}

impl Cursor {
    fn precedes(&self, previous: &Self) -> bool {
        (self.at_ms, self.session_id.as_str(), self.seq)
            < (previous.at_ms, previous.session_id.as_str(), previous.seq)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Point {
    session_id: String,
    agent_id: String,
    instance_id: Option<String>,
    seq: u64,
    at_ms: u64,
    uuid: Option<String>,
    usage: QueryUsage,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueryUsage {
    status: String,
    scope: String,
    value: Tokens,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tokens {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
}

async fn read_page(client: &Client, method: &str, params: Value) -> Result<Page, UsageReadError> {
    // Read failures do not assert anything about a native execution's outcome.
    let value = client
        .call(method, params)
        .await
        .map_err(|_| UsageReadError::Unavailable)?;
    let page: Page = serde_json::from_value(value).map_err(|_| UsageReadError::Unavailable)?;
    // An empty page reports no metering observations, not zero usage.
    if page.coverage != "observedDurableResultsOnly" || page.native_outcome_unknown {
        return Err(UsageReadError::Unavailable);
    }
    Ok(page)
}

fn project(point: Point) -> Result<UsageEntry, UsageReadError> {
    if point.usage.status != "available"
        || point.usage.scope != "observedNativeQuery"
        || point.instance_id.as_deref().is_none_or(str::is_empty)
        || point.uuid.as_deref().is_none_or(str::is_empty)
        || point.seq == 0
        || !safe_session_id(&point.session_id)
        || !safe_agent_id(&point.agent_id)
    {
        return Err(UsageReadError::Unavailable);
    }
    // The existing public chart DTO has no unknown/partial token representation.
    let [Some(input), Some(output), Some(read), Some(write)] = [
        point.usage.value.input_tokens,
        point.usage.value.output_tokens,
        point.usage.value.cache_read_input_tokens,
        point.usage.value.cache_creation_input_tokens,
    ] else {
        return Err(UsageReadError::Unavailable);
    };
    let total = [input, output, read, write]
        .into_iter()
        .try_fold(0_u64, |sum, value| sum.checked_add(value))
        .filter(|total| *total <= MAX_SAFE_INTEGER)
        .ok_or(UsageReadError::Unavailable)?;
    let timestamp = DateTime::from_timestamp_millis(
        i64::try_from(point.at_ms).map_err(|_| UsageReadError::Unavailable)?,
    )
    .ok_or(UsageReadError::Unavailable)?
    .to_rfc3339_opts(SecondsFormat::Millis, true);
    Ok(UsageEntry {
        session_id: point.session_id,
        agent_id: point.agent_id,
        timestamp,
        // modelUsage and total_cost_usd are instance-cumulative, never per-query charges.
        model: None,
        provider: None,
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: read,
        cache_write_tokens: write,
        total_tokens: total,
        cost_usd: None,
    })
}

fn safe_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn safe_agent_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}
