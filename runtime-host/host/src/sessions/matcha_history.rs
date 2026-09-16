use matcha_agent::session::{
    canonical::CanonicalSessionAssembler,
    hydration::{HydratedMessageRole, HydrationSnapshot},
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Command {
    pub(crate) session_id: String,
}

impl Command {
    pub(crate) fn new(session_id: String) -> Option<Self> {
        (!session_id.trim().is_empty()).then_some(Self { session_id })
    }

    pub(crate) fn session_id(&self) -> &str {
        &self.session_id
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

pub(crate) fn project(facts: &matcha_agent::session::facts::NativeSessionFacts) -> History {
    let view = CanonicalSessionAssembler::project(facts);
    project_hydration(view.transcript())
}

pub(crate) fn project_hydration(snapshot: &HydrationSnapshot) -> History {
    History {
        messages: snapshot
            .messages()
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
    }
}
