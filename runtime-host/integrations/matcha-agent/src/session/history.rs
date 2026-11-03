use super::{
    model::{SessionRecord, valid_uuid},
    normalization,
    rpc::{self, Failure},
};
use crate::client::Client;
use serde::Deserialize;
use serde_json::{Value, json};
use sessions_module::{
    state::{SessionInputReceipt, SessionWindow},
    timeline::Direction,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub messages: Vec<Value>,
    pub total: usize,
    pub next_offset: Option<usize>,
    pub managed_input_message_ids: Vec<String>,
    pub input_messages: Vec<InputMessage>,
    pub input_receipts: Option<Vec<SessionInputReceipt>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputMessage {
    pub request_id: String,
    pub message_id: String,
}

pub(crate) async fn page(
    client: &Client,
    id: &str,
    agent: &str,
    offset: usize,
    limit: usize,
    input_ids: Option<&[String]>,
) -> Result<Page, Failure> {
    let mut params = json!({"sessionId":id,"history":true,"offset":offset,"limit":limit});
    if let Some(input_ids) = input_ids {
        params["inputIds"] = json!(input_ids);
    }
    let mut value = rpc::call(client, "sessions.get", params)
        .await
        .inspect_err(|error| error.trace("history.rpc", Some("sessions.get"), id))?;
    let record = SessionRecord::deserialize(&value)
        .map_err(|_| Failure::InvalidReadback)
        .inspect_err(|error| error.trace("history.record_decode", Some("sessions.get"), id))?;
    if !record.validate(id, Some(agent)) {
        Failure::InvalidReadback.trace("history.record_identity", Some("sessions.get"), id);
        return Err(Failure::InvalidReadback);
    }
    let page: Page = rpc::decode(
        value
            .get_mut("history")
            .map(Value::take)
            .ok_or(Failure::InvalidReadback)
            .inspect_err(|error| error.trace("history.page_missing", Some("sessions.get"), id))?,
    )
    .inspect_err(|error| error.trace("history.page_decode", Some("sessions.get"), id))?;
    let start = offset.min(page.total);
    let end = start
        .checked_add(page.messages.len())
        .ok_or(Failure::InvalidReadback)
        .inspect_err(|error| error.trace("history.pagination", Some("sessions.get"), id))?;
    if page.total as u64 > sessions_module::state::MAX_SAFE_INTEGER
        || page.messages.len() > limit
        || end > page.total
        || page.next_offset != (end < page.total).then_some(end)
    {
        Failure::InvalidReadback.trace("history.pagination", Some("sessions.get"), id);
        return Err(Failure::InvalidReadback);
    }
    let mut inputs = std::collections::HashSet::new();
    if page.managed_input_message_ids.iter().any(|uuid| {
        !inputs.insert(uuid.as_str())
            || !page.messages.iter().any(|row| {
                row["type"] == "user"
                    && row.get("uuid").and_then(Value::as_str) == Some(uuid.as_str())
            })
    }) {
        Failure::InvalidReadback.trace("history.input_identity", Some("sessions.get"), id);
        return Err(Failure::InvalidReadback);
    }
    let mut messages = std::collections::HashSet::new();
    let mut requests = std::collections::HashSet::new();
    if page.input_messages.iter().any(|input| {
        !valid_uuid(&input.message_id)
            || input.request_id.is_empty()
            || input.request_id.len() > 256
            || input.request_id.chars().any(char::is_control)
            || !messages.insert(input.message_id.as_str())
            || !requests.insert(input.request_id.as_str())
            || !inputs.contains(input.message_id.as_str())
            || !page.messages.iter().any(|row| {
                row["type"] == "user"
                    && row["isSidechain"] != true
                    && row["uuid"].as_str() == Some(input.message_id.as_str())
            })
    }) {
        return Err(Failure::InvalidReadback);
    }
    let mut receipts = std::collections::HashSet::new();
    let mut consumed = std::collections::HashSet::new();
    match (input_ids, page.input_receipts.as_deref()) {
        (Some(input_ids), Some(values)) if values.len() <= input_ids.len() => {
            for receipt in values {
                let input_id = match receipt {
                    SessionInputReceipt::Consumed {
                        input_id,
                        message_id,
                    } => {
                        if !valid_uuid(message_id)
                            || !consumed.insert(message_id)
                            || page.input_messages.iter().any(|input| {
                                (input.request_id == *input_id || input.message_id == *message_id)
                                    && (input.request_id != *input_id
                                        || input.message_id != *message_id)
                            })
                        {
                            return Err(Failure::InvalidReadback);
                        }
                        input_id
                    }
                    SessionInputReceipt::Pending {
                        input_id,
                        queued,
                        cancelled,
                    } => {
                        if !matches!((queued, cancelled), (Some(true), None) | (None, Some(true)))
                            || page
                                .input_messages
                                .iter()
                                .any(|input| input.request_id == *input_id)
                        {
                            return Err(Failure::InvalidReadback);
                        }
                        input_id
                    }
                };
                if !input_ids.contains(input_id) || !receipts.insert(input_id) {
                    return Err(Failure::InvalidReadback);
                }
            }
        }
        (None, None) => {}
        _ => return Err(Failure::InvalidReadback),
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
    input_ids: Option<&[String]>,
) -> Result<(Page, SessionWindow), Failure> {
    let total = page(client, id, agent, 0, 0, None).await?.total;
    let start = match direction {
        Direction::Latest => total.saturating_sub(limit),
        Direction::Older => offset.unwrap_or(total).min(total).saturating_sub(limit),
        Direction::Newer => offset.unwrap_or(total).min(total),
    };
    let count = match direction {
        Direction::Older => offset.unwrap_or(total).min(total) - start,
        _ => limit,
    };
    let page = page(client, id, agent, start, count, input_ids).await?;
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
    index: usize,
) -> Result<String, Failure> {
    let mut offset = 0;
    loop {
        let page = page(client, id, agent, offset, 200, None).await?;
        for raw in &page.messages {
            let managed_input = raw.get("uuid").and_then(Value::as_str).is_some_and(|uuid| {
                page.managed_input_message_ids
                    .iter()
                    .any(|input| input == uuid)
            });
            for message in normalization::messages(raw, managed_input)
                .inspect_err(|error| error.trace("history.normalize", None, id))?
            {
                if message.row.get("uuid").and_then(Value::as_str) != Some(uuid) {
                    continue;
                }
                let block = message
                    .source
                    .block(index)
                    .inspect_err(|error| error.trace("history.content_source", None, id))?;
                return block
                    .as_str()
                    .or_else(|| {
                        block
                            .get("text")
                            .or_else(|| block.get("thinking"))
                            .and_then(Value::as_str)
                    })
                    .map(str::to_owned)
                    .ok_or(Failure::InvalidInput);
            }
        }
        match page.next_offset {
            Some(next) if next > offset => offset = next,
            _ => {
                Failure::InvalidReadback.trace("history.message_missing", Some("sessions.get"), id);
                return Err(Failure::InvalidReadback);
            }
        }
    }
}
