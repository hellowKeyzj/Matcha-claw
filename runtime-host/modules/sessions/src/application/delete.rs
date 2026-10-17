use serde::Serialize;

use crate::state::SessionIdentity;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionDeleteCommand {
    pub identity: SessionIdentity,
}

impl SessionDeleteCommand {
    pub fn new(identity: SessionIdentity) -> Self {
        Self { identity }
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
