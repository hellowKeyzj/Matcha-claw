use super::model::*;
use crate::{GraphRunId, TeamId};

pub fn post(board: &mut TaskBoardFacts, message: MailboxMessage) -> Result<bool, TaskBoardError> {
    if let Some(existing) = board.mailbox().find(|m| {
        m.team_id() == message.team_id()
            && m.run_id() == message.run_id()
            && m.msg_id() == message.msg_id()
    }) {
        return if existing == &message {
            Ok(false)
        } else {
            Err(TaskBoardError::ConflictingMessage)
        };
    }
    board.mailbox_mut().push(message);
    board.mailbox_mut().sort_by(|a, b| {
        a.created_at()
            .cmp(&b.created_at())
            .then_with(|| a.msg_id().cmp(b.msg_id()))
    });
    Ok(true)
}

pub fn pull(
    board: &TaskBoardFacts,
    team: &TeamId,
    run: &GraphRunId,
    cursor: Option<&str>,
    limit: usize,
) -> Result<(Vec<MailboxMessage>, Option<String>), TaskBoardError> {
    let after = cursor.map(parse_cursor).transpose()?.flatten();
    let mut rows = board
        .mailbox()
        .filter(|m| m.team_id() == team && m.run_id() == run)
        .filter(|m| {
            after.as_ref().is_none_or(|(ts, id)| {
                m.created_at() > *ts || (m.created_at() == *ts && m.msg_id() > id.as_str())
            })
        })
        .cloned()
        .collect::<Vec<_>>();
    rows.sort_by(|a, b| {
        a.created_at()
            .cmp(&b.created_at())
            .then_with(|| a.msg_id().cmp(b.msg_id()))
    });
    rows.truncate(limit.clamp(1, 500));
    let next = rows
        .last()
        .map(|m| format!("{}:{}", m.created_at(), m.msg_id()));
    Ok((rows, next.or_else(|| cursor.map(str::to_owned))))
}
fn parse_cursor(value: &str) -> Result<Option<(u64, String)>, TaskBoardError> {
    if value.is_empty() {
        return Ok(None);
    }
    let Some((ts, id)) = value.split_once(':') else {
        return Err(TaskBoardError::CursorInvalid);
    };
    Ok(Some((
        ts.parse().map_err(|_| TaskBoardError::CursorInvalid)?,
        id.to_owned(),
    )))
}
