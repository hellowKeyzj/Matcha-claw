mod activity;
mod artifact;
pub(crate) mod decision;
mod delivery;
mod evidence;
mod task;

pub(crate) use activity::{encode as encode_activity, encode_change as encode_activity_change};
pub(crate) use artifact::encode as encode_artifact;
pub(crate) use decision::{encode as encode_decision, encode_event as encode_decision_event};
pub(crate) use delivery::{encode as encode_delivery, encode_change as encode_delivery_change};
pub(crate) use evidence::encode as encode_evidence;
pub(crate) use task::{encode_mailbox, encode_runner, encode_task};

use crate::run::artifact::ArtifactRecord;
use crate::run::{
    decision::{TeamDecisionEventSnapshot, TeamDecisionSnapshot},
    task_board::{AutoRunnerFacts, MailboxMessage, TaskRecord},
};
use crate::store::{
    StoreFault,
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

impl Body {
    fn reference(&self) -> Result<ContentRef, StoreFault> {
        let bytes: &[u8; 40] = self.0.as_slice().try_into().map_err(|_| StoreFault::CorruptRecord)?;
        Ok(ContentRef {
            sha256: bytes[..32].try_into().map_err(|_| StoreFault::CorruptRecord)?,
            byte_len: u64::from_le_bytes(bytes[32..].try_into().map_err(|_| StoreFault::CorruptRecord)?),
        })
    }
}

impl Bodies<'_> {
    fn put(&self, text: &str) -> Result<Body, StoreFault> {
        self.put_reusing(text, None)
    }

    fn put_reusing(&self, text: &str, previous: Option<&Body>) -> Result<Body, StoreFault> {
        let previous = previous.map(Body::reference).transpose()?;
        let reference = self.contents.put_reusing(
            ContentScope::Run {
                team: self.team,
                run: &self.run,
            },
            text.as_bytes(),
            previous.as_ref(),
        )?;
        let mut bytes = reference.sha256.to_vec();
        bytes.extend_from_slice(&reference.byte_len.to_le_bytes());
        Ok(Body(bytes))
    }

    fn read(&self, body: Body) -> Result<String, StoreFault> {
        let reference = body.reference()?;
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

pub(crate) fn split_scope(scope: &str) -> Result<(&str, &str), StoreFault> {
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
