use super::*;
use crate::session::protocol::{ChatState, DisplayContent, SessionErrorKind};
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Eq, PartialEq)]
pub(in crate::session) enum Status {
    Streaming,
    Completed,
    Error,
    Aborted,
    Timeout,
    Yielded,
}

impl Status {
    fn from_chat(chat: &ChatEvent) -> Option<Self> {
        Some(match chat.state {
            ChatState::Status => return None,
            ChatState::Delta => Self::Streaming,
            ChatState::Aborted => Self::Aborted,
            ChatState::Error if chat.error_kind == Some(SessionErrorKind::Timeout) => Self::Timeout,
            ChatState::Error => Self::Error,
            ChatState::Final if chat.is_yielded() => Self::Yielded,
            ChatState::Final if chat.stop_reason.as_deref() == Some("error") => Self::Error,
            ChatState::Final => Self::Completed,
        })
    }

    pub(in crate::session) fn terminal(self) -> bool { self != Self::Streaming }
}

#[derive(Clone)]
struct RunMessage {
    content: DisplayContent,
    identity: Option<[u8; 32]>,
    text: Option<[u8; 32]>,
    source: u64,
}

#[derive(Clone)]
struct Run {
    id: String,
    status: Status,
    sequence: Option<u64>,
    message: Option<RunMessage>,
    accepted: Vec<[u8; 32]>,
    error_message: Option<String>,
    error_kind: Option<SessionErrorKind>,
}

impl Run {
    fn displayable(&self) -> bool {
        self.message.as_ref().is_some_and(|message| message.content.has_displayable_content())
    }

    fn diagnostic(&self) -> bool {
        self.message.as_ref().is_none_or(|message| message.content.is_error_message(self.error_message.as_deref()))
    }

    fn accepted(&self, identity: Option<[u8; 32]>) -> bool {
        identity.is_some_and(|identity| self.accepted.contains(&identity)
            || self.message.as_ref().and_then(|message| message.identity) == Some(identity))
    }
}

#[derive(Clone, Default)]
pub(super) struct Runs {
    entries: Vec<Run>,
    next_source: u64,
}

pub(in crate::session) struct Transition {
    pub previous: Option<Status>,
    pub current: Status,
    pub replayed: bool,
    pub source: Option<u64>,
    pub resumed: bool,
    pub error_changed: bool,
}

impl Transition {
    pub(in crate::session) fn ignores_body(&self, chat: &ChatEvent) -> bool {
        self.previous.is_some_and(Status::terminal) && self.current.terminal()
            && (matches!(chat.state, ChatState::Delta | ChatState::Error | ChatState::Aborted)
                || (chat.state == ChatState::Final && (self.replayed || chat.final_message.as_ref()
                    .is_none_or(Message::hidden_control_reply))))
    }
}

impl Runs {
    pub(super) fn accepted(&self, run: &str) -> bool {
        self.entries.iter().find(|entry| entry.id == run).is_some_and(|run| !run.accepted.is_empty())
    }

    pub(super) fn finishing_text(&self, run: &str, text: &str) -> bool {
        text_identity(text).is_some_and(|text| self.entries.iter().find(|entry| entry.id == run)
            .and_then(|run| run.message.as_ref()).and_then(|message| message.text) == Some(text))
    }

    fn update(&mut self, chat: &ChatEvent) -> Option<Transition> {
        let status = Status::from_chat(chat)?;
        let source = if chat.has_projection_message() {
            self.next_source = self.next_source.checked_add(1)?;
            Some(self.next_source)
        } else { None };
        let message = source.map(|source| RunMessage {
            content: chat.projection_content().clone(), identity: chat.projection_final_identity(),
            text: chat.message_text.as_deref().and_then(text_identity), source,
        });
        let error = chat.error_message.as_deref().map(|text| text.trim_matches(reconciliation::whitespace))
            .filter(|text| !text.is_empty()).map(str::to_owned);
        let index = self.entries.iter().position(|run| run.id == chat.run_id.as_str());
        let previous = index.map(|index| self.entries[index].status);
        let replayed = index.is_some_and(|index| self.entries[index].accepted(chat.projection_final_identity()));
        let resumed = index.is_some_and(|index| {
            let run = &self.entries[index];
            run.status == Status::Error && status == Status::Streaming
                && run.sequence.is_some_and(|sequence| chat.sequence > sequence) && run.diagnostic()
        });
        let mut transition = Transition { previous, current: status, replayed, source, resumed, error_changed: false };
        if let Some(index) = index.filter(|index| self.entries[*index].status.terminal() && !resumed) {
            let run = &mut self.entries[index];
            transition.current = run.status;
            let incoming_final = matches!(status, Status::Completed | Status::Yielded);
            let accept_final = incoming_final && (run.status == status || !run.displayable() || !run.accepted.is_empty())
                && chat.projection_final_identity().is_some() && !replayed;
            if accept_final {
                if run.accepted.is_empty() && let Some(first) = run.message.as_ref().and_then(|message| message.identity) {
                    run.accepted.push(first);
                }
                if !run.displayable() { run.message = message; }
                run.accepted.push(chat.projection_final_identity()?);
                if run.accepted.len() > 32 { run.accepted.remove(0); }
            }
            if run.error_message.is_none() && error.is_some() {
                transition.error_changed = true;
                run.error_message = error;
                if chat.error_kind.is_some() { run.error_kind = chat.error_kind; }
            }
            if status.terminal() && run.sequence.is_none_or(|sequence| chat.sequence > sequence) {
                run.sequence = Some(chat.sequence);
            }
            return Some(transition);
        }
        let current = index.map(|index| self.entries.remove(index));
        let accepted = if matches!(status, Status::Completed | Status::Yielded) {
            chat.projection_final_identity().map(|identity| vec![identity])
        } else { None };
        let retain = !resumed;
        let old_error = current.as_ref().and_then(|run| run.error_message.clone());
        let old_kind = current.as_ref().and_then(|run| run.error_kind);
        let inherited_message = current.as_ref().and_then(|run| run.message.clone());
        let inherited_accepted = current.as_ref().map(|run| run.accepted.clone()).unwrap_or_default();
        let run = Run {
            id: chat.run_id.as_str().to_owned(), status, sequence: Some(chat.sequence),
            message: message.or_else(|| retain.then_some(inherited_message).flatten()),
            accepted: accepted.unwrap_or_else(|| if retain { inherited_accepted } else { Vec::new() }),
            error_message: error.or_else(|| retain.then_some(old_error).flatten()),
            error_kind: chat.error_kind.or_else(|| retain.then_some(old_kind).flatten()),
        };
        transition.error_changed = run.error_message != current.as_ref().and_then(|run| run.error_message.clone());
        if let Some(index) = index.filter(|_| !previous.is_some_and(|previous| previous == Status::Streaming && status.terminal())) {
            self.entries.insert(index, run);
        } else { self.entries.push(run); }
        if self.entries.len() > 200 {
            let active = self.entries.iter().filter(|run| run.status == Status::Streaming).count();
            let remove = self.entries.len().saturating_sub(active).saturating_sub(150usize.saturating_sub(active));
            let mut removed = 0;
            self.entries.retain(|run| {
                if run.status.terminal() && removed < remove { removed += 1; false } else { true }
            });
        }
        Some(transition)
    }
}

impl Body {
    pub(in crate::session) fn update_run(&mut self, chat: &ChatEvent) -> Option<Transition> {
        let diagnostic = self.runs.entries.iter().find(|run| run.id == chat.run_id.as_str())
            .map(|run| (run.error_message.clone(), run.message.as_ref().map(|message| message.source)));
        let transition = self.runs.update(chat)?;
        if transition.resumed {
            let (error, source) = diagnostic?;
            let mut retired = self.persisted.iter().filter(|row| {
                let current = source.is_some() && row.source == source;
                (row.identity_run_id() == Some(chat.run_id.as_str()) || current)
                    && (row.stop_reason() == Some("error") || current)
                    && row.is_projection_error_message(error.as_deref())
            }).map(|row| row.id.clone()).collect::<Vec<_>>();
            retired.extend(self.streams.values().flat_map(|stream| stream.provisional.iter())
                .filter(|entry| entry.diagnostic_for_run(chat.run_id.as_str(), error.as_deref(), source))
                .map(|entry| entry.id.clone()));
            self.items.retain(|item| !retired.iter().any(|id| id == item.item_id()));
            self.persisted.retain(|row| !retired.contains(&row.id));
            self.history_ids.retain(|id| !retired.contains(id));
            for stream in self.streams.values_mut() { stream.provisional.retain(|entry| !retired.contains(&entry.id)); }
        }
        Some(transition)
    }
}

fn text_identity(text: &str) -> Option<[u8; 32]> {
    let text = text.trim_matches(reconciliation::whitespace);
    (!text.is_empty()).then(|| Sha256::digest(text.as_bytes()).into())
}
