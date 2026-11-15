use organization::{
    TeamDecisionCommand,
    run::decision::{TeamDecision, TeamDecisionType},
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamDecisionRequest(TeamDecisionCommand);

impl TeamDecisionRequest {
    pub fn try_new(
        run_id: String,
        stage_id: Option<String>,
        decision: TeamDecisionType,
        note: Option<String>,
        idempotency_key: String,
        created_at: u64,
    ) -> Result<Self, TeamDecisionCompositionError> {
        TeamDecisionCommand::try_new(
            format!("team-decision-{idempotency_key}"),
            run_id,
            stage_id.unwrap_or_else(|| "run".to_owned()),
            decision,
            note,
            idempotency_key,
            created_at,
        )
        .map(Self)
        .map_err(|_| TeamDecisionCompositionError::Invalid)
    }

    pub fn from_command(command: TeamDecisionCommand) -> Self {
        Self(command)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamDecisionReceiptProjection {
    decision: TeamDecision,
    replayed: bool,
}

impl TeamDecisionReceiptProjection {
    pub fn decision(&self) -> &TeamDecision {
        &self.decision
    }

    pub const fn replayed(&self) -> bool {
        self.replayed
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamDecisionCompositionError {
    Invalid,
    Unavailable,
}
