use crate::{
    client::Client,
    session::{
        history, normalization, projection,
        rpc::{self, Failure, FailureKind},
    },
};
use serde_json::Value;
use sessions_module::{
    session_history::{
        SessionHistoryCommand, SessionHistoryFailure, SessionHistoryMessage, SessionHistoryOutcome,
        SessionHistoryRole, SessionHistoryView,
    },
    state::{
        ItemStatus, MissingFact, SessionCompleteness, SessionFact, SessionItem, SessionView,
        ToolView,
    },
    timeline::{self, UnavailableReason},
};

pub(super) async fn read(
    client: &Client,
    command: &timeline::Command,
    epoch: u64,
) -> Result<SessionView, Failure> {
    let record = rpc::bound(client, command.identity(), command.endpoint_session_id())
        .await
        .inspect_err(|error| {
            if let Some((_, id)) = projection::parse_session_key(&command.identity().session_key) {
                error.trace("timeline.bound", Some("sessions.get"), id);
            }
        })?;
    let (page, mut window) = history::window(
        client,
        record.session_id.as_str(),
        &record.agent_id,
        command.direction(),
        command.limit(),
        command.offset(),
    )
    .await?;
    let mut groups = Vec::new();
    let mut item_count = 0;
    let reverse = !matches!(command.direction(), timeline::Direction::Newer);
    for position in 0..page.messages.len() {
        let index = if reverse {
            page.messages.len() - 1 - position
        } else {
            position
        };
        let raw = &page.messages[index];
        let managed_input = raw.get("uuid").and_then(Value::as_str).is_some_and(|uuid| {
            page.managed_input_message_ids
                .iter()
                .any(|input| input == uuid)
        });
        let mut group = Vec::new();
        for message in normalization::messages(raw, managed_input).inspect_err(|error| {
            error.trace("timeline.normalize", None, record.session_id.as_str());
        })? {
            if let Some(message) = projection::message(&message.row, ItemStatus::Final)
                .inspect_err(|error| {
                    error.trace(
                        "timeline.message_projection",
                        None,
                        record.session_id.as_str(),
                    );
                })?
            {
                group.push(message);
            }
        }
        // Never split a raw row at the display budget: native offsets cannot
        // resume in the middle of its normalized SDK messages.
        if item_count + group.len() > sessions_module::state::MAX_ITEMS {
            if reverse {
                window.window_start_offset += index as u64 + 1;
                window.has_more = true;
            } else {
                window.window_end_offset = window.window_start_offset + index as u64;
                window.has_newer = window.window_end_offset < window.total_item_count;
                window.is_at_latest = !window.has_newer;
            }
            break;
        }
        item_count += group.len();
        groups.push(group);
    }
    if reverse {
        groups.reverse();
    }
    let mut items = Vec::with_capacity(item_count);
    let mut tools = Vec::<ToolView>::new();
    for message in groups.into_iter().flatten() {
        if items
            .iter()
            .any(|item: &SessionItem| item.item_id() == message.item.item_id())
        {
            Failure::InvalidReadback.trace(
                "timeline.duplicate_item",
                None,
                record.session_id.as_str(),
            );
            return Err(Failure::InvalidReadback);
        }
        items.push(message.item);
        for tool in message.tools {
            projection::merge_tool(&mut tools, tool).inspect_err(|error| {
                error.trace("timeline.merge_tool", None, record.session_id.as_str());
            })?;
        }
    }
    let mut view = sessions_module::state::SessionState::new(command.identity().clone(), epoch)
        .map_err(|_| Failure::InvalidInput)
        .inspect_err(|error| error.trace("timeline.state", None, record.session_id.as_str()))?
        .view();
    view.endpoint_session_id = Some(record.session_id.as_str().to_owned());
    view.goal = sessions_module::goal::SessionGoalView::Unsupported;
    view.model_state = record
        .model
        .as_deref()
        .and_then(|model| sessions_module::state::SessionModelState::selected_from_ref(model).ok());
    if let Some(model) = &mut view.model_state {
        model.selection_id = record.model_selection_id;
    }
    view.items = SessionFact::Incomplete {
        facts: items,
        gaps: vec![MissingFact::BoundedHistory],
    };
    view.tools = SessionFact::Incomplete {
        facts: tools,
        gaps: vec![MissingFact::EventOnly],
    };
    view.window = SessionFact::Complete(window);
    view.completeness = SessionCompleteness::Incomplete {
        missing: vec![
            MissingFact::Catalog,
            MissingFact::Usage,
            MissingFact::Artifacts,
            MissingFact::ContextTokens,
            MissingFact::Tasks,
            MissingFact::ReplayCursor,
            MissingFact::PartialRuntime,
            MissingFact::EventOnly,
        ],
    };
    view.validate()
        .map_err(|_| Failure::InvalidReadback)
        .inspect_err(|error| {
            error.trace("timeline.view_validate", None, record.session_id.as_str())
        })?;
    Ok(view)
}
pub(super) async fn load(
    client: &Client,
    command: timeline::Command,
    epoch: u64,
) -> timeline::Outcome {
    match read(client, &command, epoch).await {
        Ok(view) => timeline::Outcome::Incomplete(view),
        Err(error) => timeline::Outcome::unavailable(reason(&error)),
    }
}
fn reason(error: &Failure) -> UnavailableReason {
    if error.is_not_found() {
        return UnavailableReason::MatchaReadNotFound;
    }
    match error.kind() {
        FailureKind::Rejected => UnavailableReason::RuntimeTargetRejected,
        FailureKind::Unknown => UnavailableReason::MatchaReadUnknown,
        _ => UnavailableReason::MatchaReadUnavailable,
    }
}
pub(super) async fn history(
    client: &Client,
    command: SessionHistoryCommand,
) -> SessionHistoryOutcome {
    let result = async {
        let (agent, id) =
            projection::parse_session_key(command.session_key()).ok_or(Failure::InvalidInput)?;
        if command.endpoint()
            != &runtime_directory::RuntimeDriverIdentity::matcha_agent().endpoint()
            || command
                .endpoint_session_id()
                .is_some_and(|native_id| native_id != id)
        {
            return Err(Failure::InvalidInput);
        }
        rpc::get(client, id, Some(agent)).await?;
        let limit = command
            .limit()
            .and_then(|limit| usize::try_from(limit).ok())
            .unwrap_or(200)
            .min(200);
        let (page, _) =
            history::window(client, id, agent, timeline::Direction::Latest, limit, None).await?;
        let mut messages = Vec::new();
        for row in page.messages {
            let role = match row.get("type").and_then(Value::as_str) {
                Some("user") => SessionHistoryRole::User,
                Some("assistant") => SessionHistoryRole::Assistant,
                _ => continue,
            };
            // Plain history has no preview/completeness field. Never return the
            // bounded timeline aggregate as if it were the full native text.
            let text = match row
                .pointer("/message/content")
                .or_else(|| row.get("content"))
            {
                Some(Value::String(text)) => text.clone(),
                Some(Value::Array(blocks)) => blocks
                    .iter()
                    .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                    .map(|block| {
                        block
                            .get("text")
                            .and_then(Value::as_str)
                            .ok_or(Failure::InvalidReadback)
                    })
                    .collect::<Result<Vec<_>, _>>()?
                    .concat(),
                None | Some(Value::Null) => String::new(),
                _ => return Err(Failure::InvalidReadback),
            };
            messages.push(SessionHistoryMessage { role, text });
        }
        Ok(SessionHistoryView { messages })
    }
    .await;
    match result {
        Ok(view) => SessionHistoryOutcome::Loaded(view),
        Err(error) => SessionHistoryOutcome::Failed(match error.kind() {
            FailureKind::Rejected => SessionHistoryFailure::Rejected,
            FailureKind::Unknown => SessionHistoryFailure::Protocol,
            _ => SessionHistoryFailure::Unavailable,
        }),
    }
}
pub(super) async fn content(
    client: &Client,
    command: timeline::ContentCommand,
) -> timeline::ContentOutcome {
    let result = async {
        let record = rpc::bound(client, command.identity(), command.endpoint_session_id()).await?;
        let (uuid, index) = command
            .content_ref()
            .strip_prefix("native:")
            .and_then(|value| value.rsplit_once(':'))
            .ok_or(Failure::InvalidInput)?;
        let index = index.parse::<usize>().map_err(|_| Failure::InvalidInput)?;
        let text = history::message(
            client,
            record.session_id.as_str(),
            &record.agent_id,
            uuid,
            index,
        )
        .await?;
        let start = usize::try_from(command.offset()).map_err(|_| Failure::InvalidInput)?;
        if start > text.len() || !text.is_char_boundary(start) {
            return Err(Failure::InvalidInput);
        }
        let chunk = projection::prefix(&text[start..], command.limit());
        let next = start + chunk.len();
        Ok(timeline::ContentChunk {
            content_ref: command.content_ref().to_owned(),
            offset: start as u64,
            text: chunk.to_owned(),
            next_offset: next as u64,
            total_bytes: text.len() as u64,
            complete: next == text.len(),
        })
    }
    .await;
    match result {
        Ok(chunk) => timeline::ContentOutcome::Complete(chunk),
        Err(error) => timeline::ContentOutcome::unavailable(reason(&error)),
    }
}
