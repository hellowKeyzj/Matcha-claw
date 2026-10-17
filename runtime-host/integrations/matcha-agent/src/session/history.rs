use super::{
    model::SessionRecord,
    rpc::{self, Failure},
};
use crate::client::Client;
use serde::Deserialize;
use serde_json::{Value, json};
use sessions_module::{state::SessionWindow, timeline::Direction};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub messages: Vec<Value>,
    pub total: usize,
    pub next_offset: Option<usize>,
}

pub(crate) async fn page(
    client: &Client,
    id: &str,
    agent: &str,
    offset: usize,
    limit: usize,
) -> Result<Page, Failure> {
    let value = rpc::call(
        client,
        "sessions.get",
        json!({"sessionId":id,"history":true,"offset":offset,"limit":limit}),
    )
    .await?;
    let record: SessionRecord = rpc::decode(value.clone())?;
    if !record.validate(id, Some(agent)) {
        return Err(Failure::InvalidReadback);
    }
    let page: Page = rpc::decode(
        value
            .get("history")
            .cloned()
            .ok_or(Failure::InvalidReadback)?,
    )?;
    let start = offset.min(page.total);
    let end = start
        .checked_add(page.messages.len())
        .ok_or(Failure::InvalidReadback)?;
    if page.total as u64 > sessions_module::state::MAX_SAFE_INTEGER
        || page.messages.len() > limit
        || end > page.total
        || page.next_offset != (end < page.total).then_some(end)
    {
        return Err(Failure::InvalidReadback);
    }
    Ok(page)
}

pub(crate) async fn window(
    client: &Client,
    id: &str,
    agent: &str,
    direction: Direction,
    limit: usize,
    offset: Option<usize>,
) -> Result<(Page, SessionWindow), Failure> {
    let total = page(client, id, agent, 0, 0).await?.total;
    let start = match direction {
        Direction::Latest => total.saturating_sub(limit),
        Direction::Older => offset.unwrap_or(total).min(total).saturating_sub(limit),
        Direction::Newer => offset.unwrap_or(total).min(total),
    };
    let count = match direction {
        Direction::Older => offset.unwrap_or(total).min(total) - start,
        _ => limit,
    };
    let page = page(client, id, agent, start, count).await?;
    // The second read is authoritative for its own window; it is not an atomic
    // snapshot of the earlier total. A growing transcript remains visibly newer.
    let start = start.min(page.total);
    let total = page.total;
    let end = start + page.messages.len();
    let window = SessionWindow {
        total_item_count: total as u64,
        window_start_offset: start as u64,
        window_end_offset: end as u64,
        has_more: start > 0,
        has_newer: end < total,
        is_at_latest: end == total,
    };
    Ok((page, window))
}

pub(crate) async fn message(
    client: &Client,
    id: &str,
    agent: &str,
    uuid: &str,
) -> Result<Value, Failure> {
    let mut offset = 0;
    loop {
        let page = page(client, id, agent, offset, 200).await?;
        if let Some(row) = page
            .messages
            .into_iter()
            .find(|row| row.get("uuid").and_then(Value::as_str) == Some(uuid))
        {
            return Ok(row);
        }
        match page.next_offset {
            Some(next) if next > offset => offset = next,
            _ => return Err(Failure::InvalidReadback),
        }
    }
}
