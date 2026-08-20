use matcha_agent::session::{
    canonical::CanonicalSessionAssembler,
    history::HistoryResult,
    hydration::{HydratedMessageRole, HydrationWindowMode, HydrationWindowRequest},
    model::SessionId,
};

use crate::Host;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Command {
    session_id: String,
}

impl Command {
    pub(crate) fn new(session_id: String) -> Option<Self> {
        (!session_id.trim().is_empty()).then_some(Self { session_id })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct History {
    messages: Vec<Message>,
}

impl History {
    #[cfg(test)]
    pub(crate) fn test_only(messages: Vec<Message>) -> Self {
        Self { messages }
    }

    pub(crate) fn messages(&self) -> &[Message] {
        &self.messages
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Message {
    role: Role,
    text: String,
}

impl Message {
    #[cfg(test)]
    pub(crate) fn test_only(role: Role, text: String) -> Self {
        Self { role, text }
    }

    pub(crate) const fn role(&self) -> Role {
        self.role
    }

    pub(crate) fn text(&self) -> &str {
        &self.text
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Role {
    User,
    Assistant,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Outcome {
    Complete(History),
    Incomplete,
    Unavailable,
}

impl Host {
    pub(crate) async fn load_matcha_history(&self, command: Command) -> Outcome {
        if self.admission.admit_request().is_err() {
            return Outcome::Unavailable;
        }
        let Some(session_id) = SessionId::try_new(command.session_id).ok() else {
            return Outcome::Incomplete;
        };
        let result = self
            .matcha()
            .read_canonical_session(
                session_id,
                HydrationWindowRequest::new(
                    HydrationWindowMode::Latest,
                    HydrationWindowRequest::MAX_LIMIT,
                    None,
                ),
            )
            .await;
        let facts = match result {
            HistoryResult::Complete(facts) => facts,
            HistoryResult::Unavailable => return Outcome::Unavailable,
            HistoryResult::NotFound | HistoryResult::Unknown | HistoryResult::Incomplete(_) => {
                return Outcome::Incomplete;
            }
        };
        let view = CanonicalSessionAssembler::project(&facts);
        Outcome::Complete(History {
            messages: view
                .transcript_messages()
                .iter()
                .filter_map(|message| {
                    match message.role() {
                        HydratedMessageRole::User => Some(Role::User),
                        HydratedMessageRole::Assistant => Some(Role::Assistant),
                        HydratedMessageRole::System => None,
                    }
                    .map(|role| Message {
                        role,
                        text: message.text().to_owned(),
                    })
                })
                .collect(),
        })
    }
}
