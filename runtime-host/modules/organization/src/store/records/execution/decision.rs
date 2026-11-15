use super::*;
use crate::run::decision::{
    TeamDecision, TeamDecisionCommand, TeamDecisionEvent, TeamDecisionLedger, TeamDecisionType,
};
use crate::store::schema::RecordChange;
use std::collections::BTreeMap;

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
    fn from_domain(value: &TeamDecision) -> Self {
        let command = value.command();
        let decision = match command.decision() {
            TeamDecisionType::Retry => Kind::Retry,
            TeamDecisionType::ProceedDegraded => Kind::ProceedDegraded,
            TeamDecisionType::Abort => Kind::Abort,
        };
        Self {
            sequence: value.sequence(),
            id: command.decision_id().to_owned(),
            run: command.run_id().to_owned(),
            stage: command.stage_id().to_owned(),
            decision,
            note: command.note().map(ToOwned::to_owned),
            idempotency: command.idempotency_key().to_owned(),
            created_at: command.created_at(),
        }
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
pub(crate) fn encode(value: &TeamDecision) -> Result<StoredRecord, StoreFault> {
    let payload = serialize(&Row::from_domain(value))?;
    Ok(StoredRecord {
        key: RecordKey {
            kind: RecordKind::Decision,
            scope: value.run_id().to_owned(),
            id: value.decision_id().to_owned(),
        },
        team_id: None,
        run_id: Some(value.run_id().to_owned()),
        payload,
    })
}
pub(super) fn decode(bytes: &[u8]) -> Result<TeamDecisionSnapshot, StoreFault> {
    deserialize::<Row>(bytes)?.into_domain()
}
pub(crate) fn encode_event(value: &TeamDecisionEvent) -> Result<StoredRecord, StoreFault> {
    let payload = serialize(&Event {
        id: value.event_id().to_owned(),
        run: value.run_id().to_owned(),
        sequence: value.sequence(),
        decision: Row::from_domain(value.decision()),
    })?;
    Ok(StoredRecord {
        key: RecordKey {
            kind: RecordKind::DecisionEvent,
            scope: String::new(),
            id: value.event_id().to_owned(),
        },
        team_id: None,
        run_id: Some(value.run_id().to_owned()),
        payload,
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

pub(crate) fn apply_changes(
    ledger: &mut TeamDecisionLedger,
    changes: Vec<RecordChange>,
    contents: &ContentStore,
) -> Result<(), StoreFault> {
    let mut decisions = BTreeMap::new();
    let mut events = BTreeMap::new();
    for change in changes {
        match change {
            RecordChange::Put(record) => match super::decode(&record, contents)? {
                ExecutionRecord::Decision(value) => {
                    let key = (value.run_id().to_owned(), value.decision_id().to_owned());
                    if decisions.insert(key, Some(value)).is_some() {
                        return Err(StoreFault::CorruptRecord);
                    }
                }
                ExecutionRecord::DecisionEvent(value) => {
                    let event = valid(value.event())?;
                    if events
                        .insert(value.event_id().to_owned(), Some(event))
                        .is_some()
                    {
                        return Err(StoreFault::CorruptRecord);
                    }
                }
                _ => return Err(StoreFault::CorruptRecord),
            },
            RecordChange::Delete(key) => match key.kind {
                RecordKind::Decision => {
                    if decisions.insert((key.scope, key.id), None).is_some() {
                        return Err(StoreFault::CorruptRecord);
                    }
                }
                RecordKind::DecisionEvent => {
                    if !key.scope.is_empty() || events.insert(key.id, None).is_some() {
                        return Err(StoreFault::CorruptRecord);
                    }
                }
                _ => return Err(StoreFault::CorruptRecord),
            },
        }
    }
    for ((run, id), decision) in &decisions {
        let final_event = events
            .get(id)
            .map_or_else(|| ledger.event(id), Option::as_ref);
        let final_decision = final_event
            .filter(|event| event.run_id() == run)
            .map(|event| event.decision());
        match (decision, final_decision) {
            (Some(snapshot), Some(value)) if snapshot.matches_decision(value) => {}
            (None, None) if events.contains_key(id) => {}
            _ => return Err(StoreFault::CorruptRecord),
        }
    }
    let deleted_ids = decisions
        .iter()
        .filter_map(|((_, id), value)| value.is_none().then_some(id.as_str()))
        .collect::<std::collections::BTreeSet<_>>();
    for (id, replacement) in &events {
        let current = ledger.event(id);
        if let Some(old) = current.filter(|old| {
            replacement
                .as_ref()
                .is_none_or(|event| event.run_id() != old.run_id())
        }) && !matches!(
            decisions.get(&(old.run_id().to_owned(), id.clone())),
            Some(None)
        ) {
            return Err(StoreFault::CorruptRecord);
        }
        match replacement {
            Some(event) => match decisions.get(&(event.run_id().to_owned(), id.clone())) {
                Some(Some(snapshot)) if snapshot.matches_decision(event.decision()) => {}
                None if ledger.decision_by_id(event.run_id(), id) == Some(event.decision()) => {}
                _ => return Err(StoreFault::CorruptRecord),
            },
            None if current.is_none() && !deleted_ids.contains(id.as_str()) => {
                return Err(StoreFault::CorruptRecord);
            }
            None => {}
        }
    }
    valid(ledger.apply_changes(events))
}
