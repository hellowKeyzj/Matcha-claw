use serde::Serialize;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionDeleteCommand {
    pub agent_id: String,
    pub session_key: String,
}

impl SessionDeleteCommand {
    pub fn new(agent_id: String, session_key: String) -> Self {
        Self {
            agent_id,
            session_key,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum SessionDeleteOutcome {
    Succeeded,
    TargetRejected,
    Unknown,
}

#[cfg(test)]
mod tests {
    use serde_json::{json, to_value};

    use super::*;

    #[test]
    fn serializes_only_the_semantic_outcome() {
        assert_eq!(
            to_value(SessionDeleteOutcome::TargetRejected).unwrap(),
            json!({ "outcome": "target_rejected" })
        );
    }
}
