mod activity;
mod artifact;
mod decision;
mod delivery;
mod evidence;
mod task;

use crate::run::artifact::ArtifactRecord;
use crate::run::{
    decision::{TeamDecisionEventSnapshot, TeamDecisionSnapshot},
    task_board::{AutoRunnerFacts, MailboxMessage, TaskRecord},
};
use crate::store::{
    OrganizationFacts, StoreFault,
    content::{ContentRef, ContentScope, ContentStore},
    schema::{RecordKey, RecordKind, StoredRecord},
};
use crate::{Activity, Delivery, EvidenceRecord, GraphRunId, TeamId};
use serde::{Deserialize, Serialize};

pub(crate) enum ExecutionRecord {
    Activity(Activity),
    Delivery(Delivery),
    Evidence(EvidenceRecord),
    Artifact(ArtifactRecord),
    Decision(TeamDecisionSnapshot),
    DecisionEvent(TeamDecisionEventSnapshot),
    Task {
        ordinal: u64,
        record: TaskRecord,
    },
    Runner {
        ordinal: u64,
        record: AutoRunnerFacts,
    },
    Mailbox {
        ordinal: u64,
        record: MailboxMessage,
    },
}

#[derive(Serialize, Deserialize)]
struct Body(Vec<u8>);

struct Bodies<'a> {
    contents: &'a ContentStore,
    team: &'a TeamId,
    run: GraphRunId,
}

impl Bodies<'_> {
    fn put(&self, text: &str) -> Result<Body, StoreFault> {
        let reference = self.contents.put(
            ContentScope::Run {
                team: self.team,
                run: &self.run,
            },
            text.as_bytes(),
        )?;
        let mut bytes = reference.sha256.to_vec();
        bytes.extend_from_slice(&reference.byte_len.to_le_bytes());
        Ok(Body(bytes))
    }

    fn read(&self, body: Body) -> Result<String, StoreFault> {
        let bytes: [u8; 40] = body.0.try_into().map_err(|_| StoreFault::CorruptRecord)?;
        let reference = ContentRef {
            sha256: bytes[..32]
                .try_into()
                .map_err(|_| StoreFault::CorruptRecord)?,
            byte_len: u64::from_le_bytes(
                bytes[32..]
                    .try_into()
                    .map_err(|_| StoreFault::CorruptRecord)?,
            ),
        };
        String::from_utf8(self.contents.read(
            ContentScope::Run {
                team: self.team,
                run: &self.run,
            },
            &reference,
        )?)
        .map_err(|_| StoreFault::CorruptRecord)
    }

    fn optional(&self, text: Option<&str>) -> Result<Option<Body>, StoreFault> {
        text.map(|text| self.put(text)).transpose()
    }

    fn read_optional(&self, body: Option<Body>) -> Result<Option<String>, StoreFault> {
        body.map(|body| self.read(body)).transpose()
    }
}

fn serialize(value: &impl Serialize) -> Result<Vec<u8>, StoreFault> {
    serde_json::to_vec(value).map_err(|_| StoreFault::InvalidFacts)
}

fn deserialize<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T, StoreFault> {
    serde_json::from_slice(bytes).map_err(|_| StoreFault::CorruptRecord)
}

fn valid<T, E>(value: Result<T, E>) -> Result<T, StoreFault> {
    value.map_err(|_| StoreFault::CorruptRecord)
}

#[derive(Serialize, Deserialize)]
struct Fence {
    attempt: String,
    execution: String,
}
impl Fence {
    fn from_domain(fence: &crate::ExecutionFence) -> Self {
        Self {
            attempt: fence.attempt_id().as_str().to_owned(),
            execution: fence.node_execution_id().as_str().to_owned(),
        }
    }
    fn into_domain(self) -> crate::ExecutionFence {
        crate::ExecutionFence::from_durable(self.attempt, self.execution)
    }
}

pub(crate) fn scoped_key(team: &str, run: &str) -> String {
    format!("{}:{}{}", team.len(), team, run)
}

impl ExecutionRecord {
    fn identity(&self) -> (RecordKind, String, String, String) {
        use RecordKind as K;
        match self {
            Self::Activity(value) => (
                K::Activity,
                String::new(),
                value.facts().activity_id.as_str().to_owned(),
                value.facts().run_id.as_str().to_owned(),
            ),
            Self::Delivery(value) => (
                K::Delivery,
                String::new(),
                value.facts().delivery_id.as_str().to_owned(),
                value.facts().run_id.clone(),
            ),
            Self::Evidence(value) => (
                K::Evidence,
                String::new(),
                value.evidence_id().as_str().to_owned(),
                value.run_id().to_owned(),
            ),
            Self::Artifact(value) => (
                K::Artifact,
                String::new(),
                value.artifact_id().as_str().to_owned(),
                value.run_id().to_owned(),
            ),
            Self::Decision(value) => (
                K::Decision,
                value.run_id().to_owned(),
                value.decision_id().to_owned(),
                value.run_id().to_owned(),
            ),
            Self::DecisionEvent(value) => (
                K::DecisionEvent,
                String::new(),
                value.event_id().to_owned(),
                value.run_id().to_owned(),
            ),
            Self::Task { record, .. } => (
                K::Task,
                scoped_key(record.team_id().as_str(), record.run_id().as_str()),
                record.task_id().as_str().to_owned(),
                record.run_id().as_str().to_owned(),
            ),
            Self::Runner { record: value, .. } => (
                K::Runner,
                scoped_key(value.team_id().as_str(), value.run_id().as_str()),
                value.runner_id().to_owned(),
                value.run_id().as_str().to_owned(),
            ),
            Self::Mailbox { record: value, .. } => (
                K::Mailbox,
                scoped_key(value.team_id().as_str(), value.run_id().as_str()),
                value.msg_id().to_owned(),
                value.run_id().as_str().to_owned(),
            ),
        }
    }
}

pub(crate) fn encode(
    record: &ExecutionRecord,
    team: Option<&TeamId>,
    contents: &ContentStore,
) -> Result<StoredRecord, StoreFault> {
    let (kind, scope, id, run_id) = record.identity();
    if matches!(
        record,
        ExecutionRecord::Decision(_) | ExecutionRecord::DecisionEvent(_)
    ) {
        let payload = match record {
            ExecutionRecord::Decision(value) => decision::encode(value)?,
            ExecutionRecord::DecisionEvent(value) => decision::encode_event(value)?,
            _ => unreachable!(),
        };
        return Ok(StoredRecord {
            key: RecordKey { kind, scope, id },
            team_id: None,
            run_id: Some(run_id),
            payload,
        });
    }
    let team = team.ok_or(StoreFault::InvalidFacts)?;
    let bodies = Bodies {
        contents,
        team,
        run: GraphRunId::new(run_id.clone()),
    };
    let payload = match record {
        ExecutionRecord::Activity(value) => activity::encode(value, &bodies),
        ExecutionRecord::Delivery(value) => delivery::encode(value, &bodies),
        ExecutionRecord::Evidence(value) => evidence::encode(value, &bodies),
        ExecutionRecord::Artifact(value) => artifact::encode(value, &bodies),
        ExecutionRecord::Decision(_) | ExecutionRecord::DecisionEvent(_) => unreachable!(),
        ExecutionRecord::Task { ordinal, record } => task::encode_task(*ordinal, record, &bodies),
        ExecutionRecord::Runner { ordinal, record } => {
            task::encode_runner(*ordinal, record, &bodies)
        }
        ExecutionRecord::Mailbox { ordinal, record } => {
            task::encode_mailbox(*ordinal, record, &bodies)
        }
    }?;
    Ok(StoredRecord {
        key: RecordKey { kind, scope, id },
        team_id: Some(team.as_str().to_owned()),
        run_id: Some(run_id),
        payload,
    })
}

pub(crate) fn decode(
    record: &StoredRecord,
    contents: &ContentStore,
) -> Result<ExecutionRecord, StoreFault> {
    if matches!(
        record.key.kind,
        RecordKind::Decision | RecordKind::DecisionEvent
    ) {
        if record.team_id.is_some() {
            return Err(StoreFault::CorruptRecord);
        }
        let value = match record.key.kind {
            RecordKind::Decision => ExecutionRecord::Decision(decision::decode(&record.payload)?),
            RecordKind::DecisionEvent => {
                ExecutionRecord::DecisionEvent(decision::decode_event(&record.payload)?)
            }
            _ => unreachable!(),
        };
        check_identity(record, &value)?;
        return Ok(value);
    }
    let team = valid(TeamId::try_new(
        record.team_id.clone().ok_or(StoreFault::CorruptRecord)?,
    ))?;
    let run = GraphRunId::new(record.run_id.clone().ok_or(StoreFault::CorruptRecord)?);
    let bodies = Bodies {
        contents,
        team: &team,
        run,
    };
    use RecordKind as K;
    let value = match record.key.kind {
        K::Activity => ExecutionRecord::Activity(activity::decode(&record.payload, &bodies)?),
        K::Delivery => ExecutionRecord::Delivery(delivery::decode(&record.payload, &bodies)?),
        K::Evidence => ExecutionRecord::Evidence(evidence::decode(&record.payload, &bodies)?),
        K::Artifact => ExecutionRecord::Artifact(artifact::decode(&record.payload, &bodies)?),
        K::Decision | K::DecisionEvent => unreachable!(),
        K::Task => {
            let (ordinal, record) = task::decode_task(&record.payload, &bodies)?;
            ExecutionRecord::Task { ordinal, record }
        }
        K::Runner => {
            let (ordinal, record) = task::decode_runner(&record.payload, &bodies)?;
            ExecutionRecord::Runner { ordinal, record }
        }
        K::Mailbox => {
            let (ordinal, record) = task::decode_mailbox(&record.payload, &bodies)?;
            ExecutionRecord::Mailbox { ordinal, record }
        }
        _ => return Err(StoreFault::CorruptRecord),
    };
    check_identity(record, &value)?;
    Ok(value)
}

pub(crate) fn encode_key(
    facts: &OrganizationFacts,
    key: &RecordKey,
    contents: &ContentStore,
) -> Result<Option<StoredRecord>, StoreFault> {
    use RecordKind as K;
    let value = match key.kind {
        K::Activity => facts
            .activities()
            .activity(&valid(crate::ActivityId::new(key.id.clone()))?)
            .cloned()
            .map(ExecutionRecord::Activity),
        K::Delivery => facts
            .deliveries()
            .delivery(&valid(crate::DeliveryId::new(key.id.clone()))?)
            .cloned()
            .map(ExecutionRecord::Delivery),
        K::Evidence => facts
            .evidence()
            .evidence(&valid(crate::EvidenceId::new(key.id.clone()))?)
            .cloned()
            .map(ExecutionRecord::Evidence),
        K::Artifact => facts
            .artifact(&valid(crate::run::artifact::ArtifactId::new(
                key.id.clone(),
            ))?)
            .cloned()
            .map(ExecutionRecord::Artifact),
        K::Decision => facts
            .decision_ledger()
            .decision_by_id(&key.scope, &key.id)
            .map(|value| ExecutionRecord::Decision(TeamDecisionSnapshot::from(value))),
        K::DecisionEvent => facts
            .decision_ledger()
            .event(&key.id)
            .map(|value| ExecutionRecord::DecisionEvent(TeamDecisionEventSnapshot::from(value))),
        K::Task | K::Runner | K::Mailbox => {
            let (team, run) = split_scope(&key.scope)?;
            let board = facts.task_board();
            match key.kind {
                K::Task => board
                    .task_record(team, run, &key.id)
                    .map(|(ordinal, record)| ExecutionRecord::Task {
                        ordinal,
                        record: record.clone(),
                    }),
                K::Runner => board
                    .runner_record(team, run, &key.id)
                    .map(|(ordinal, record)| ExecutionRecord::Runner {
                        ordinal,
                        record: record.clone(),
                    }),
                K::Mailbox => board
                    .mailbox_record(team, run, &key.id)
                    .map(|(ordinal, record)| ExecutionRecord::Mailbox {
                        ordinal,
                        record: record.clone(),
                    }),
                _ => unreachable!(),
            }
        }
        _ => return Err(StoreFault::InvalidFacts),
    };
    let Some(value) = value else {
        return Ok(None);
    };
    let team = match &value {
        ExecutionRecord::Decision(_) | ExecutionRecord::DecisionEvent(_) => None,
        ExecutionRecord::Delivery(value) => {
            Some(valid(TeamId::try_new(value.facts().team_id.clone()))?)
        }
        ExecutionRecord::Task { record, .. } => Some(record.team_id().clone()),
        ExecutionRecord::Runner { record, .. } => Some(record.team_id().clone()),
        ExecutionRecord::Mailbox { record, .. } => Some(record.team_id().clone()),
        _ => {
            let (_, _, _, run) = value.identity();
            Some(
                facts
                    .run(&GraphRunId::new(run))
                    .ok_or(StoreFault::InvalidFacts)?
                    .team()
                    .clone(),
            )
        }
    };
    let record = encode(&value, team.as_ref(), contents)?;
    if &record.key != key {
        return Err(StoreFault::InvalidFacts);
    }
    Ok(Some(record))
}

fn split_scope(scope: &str) -> Result<(&str, &str), StoreFault> {
    let (length, value) = scope.split_once(':').ok_or(StoreFault::CorruptRecord)?;
    let length = length
        .parse::<usize>()
        .map_err(|_| StoreFault::CorruptRecord)?;
    let team = value.get(..length).ok_or(StoreFault::CorruptRecord)?;
    let run = value.get(length..).ok_or(StoreFault::CorruptRecord)?;
    Ok((team, run))
}

fn check_identity(record: &StoredRecord, value: &ExecutionRecord) -> Result<(), StoreFault> {
    let (kind, scope, id, run) = value.identity();
    if record.key != (RecordKey { kind, scope, id })
        || record.run_id.as_deref() != Some(run.as_str())
    {
        return Err(StoreFault::CorruptRecord);
    }
    Ok(())
}
