use super::*;
use crate::run::decision::{TeamDecisionCommand, TeamDecisionType};

#[derive(Serialize, Deserialize)]
struct Row {
    sequence: u64,
    id: String,
    run: String,
    stage: String,
    decision: Kind,
    note: Option<String>,
    idempotency: String,
    created_at: u64,
}
#[derive(Serialize, Deserialize)]
enum Kind {
    Retry,
    ProceedDegraded,
    Abort,
}
#[derive(Serialize, Deserialize)]
struct Event {
    id: String,
    run: String,
    sequence: u64,
    decision: Row,
}
impl Row {
    fn from_domain(value: &TeamDecisionSnapshot) -> Result<Self, StoreFault> {
        let command = valid(value.command())?;
        let decision = match command.decision() {
            TeamDecisionType::Retry => Kind::Retry,
            TeamDecisionType::ProceedDegraded => Kind::ProceedDegraded,
            TeamDecisionType::Abort => Kind::Abort,
        };
        Ok(Self {
            sequence: value.sequence(),
            id: command.decision_id().to_owned(),
            run: command.run_id().to_owned(),
            stage: command.stage_id().to_owned(),
            decision,
            note: command.note().map(ToOwned::to_owned),
            idempotency: command.idempotency_key().to_owned(),
            created_at: command.created_at(),
        })
    }
    fn into_domain(self) -> Result<TeamDecisionSnapshot, StoreFault> {
        let decision = match self.decision {
            Kind::Retry => TeamDecisionType::Retry,
            Kind::ProceedDegraded => TeamDecisionType::ProceedDegraded,
            Kind::Abort => TeamDecisionType::Abort,
        };
        Ok(TeamDecisionSnapshot::from_durable(
            self.sequence,
            valid(TeamDecisionCommand::try_new(
                self.id,
                self.run,
                self.stage,
                decision,
                self.note,
                self.idempotency,
                self.created_at,
            ))?,
        ))
    }
}
pub(super) fn encode(value: &TeamDecisionSnapshot) -> Result<Vec<u8>, StoreFault> {
    serialize(&Row::from_domain(value)?)
}
pub(super) fn decode(bytes: &[u8]) -> Result<TeamDecisionSnapshot, StoreFault> {
    deserialize::<Row>(bytes)?.into_domain()
}
pub(super) fn encode_event(value: &TeamDecisionEventSnapshot) -> Result<Vec<u8>, StoreFault> {
    serialize(&Event {
        id: value.event_id().to_owned(),
        run: value.run_id().to_owned(),
        sequence: value.sequence(),
        decision: Row::from_domain(value.decision())?,
    })
}
pub(super) fn decode_event(bytes: &[u8]) -> Result<TeamDecisionEventSnapshot, StoreFault> {
    let row: Event = deserialize(bytes)?;
    let snapshot = TeamDecisionEventSnapshot::from_durable(
        row.id,
        row.run,
        row.sequence,
        row.decision.into_domain()?,
    );
    valid(snapshot.event())?;
    Ok(snapshot)
}
