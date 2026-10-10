use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{
    Approval, ApprovalDecision, ApprovalEffect, ApprovalOrigin, ApprovalRequest,
    ApprovalResolution, ApprovalStatus, ApprovalSubject, GraphRunId, TeamId,
    run::approval::{ApprovalDurableSnapshot, ApprovalResolutionCause},
    store::{
        StoreFault,
        content::ContentStore,
        schema::{RecordKey, RecordKind, StoredRecord},
    },
};

pub(crate) struct ApprovalHeader {
    pub(crate) team: TeamId,
    pub(crate) facts: ApprovalRequest,
    pub(crate) status: ApprovalStatus,
}

pub(crate) struct ApprovalResolutionRecord {
    pub(crate) team: TeamId,
    pub(crate) run_id: GraphRunId,
    pub(crate) approval_id: String,
    pub(crate) ordinal: u64,
    pub(crate) resolution: ApprovalResolution,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    approval_id: String,
    run_id: String,
    stage_id: String,
    role_id: String,
    reason: String,
    requested_action: String,
    risk_summary: String,
    idempotency_key: String,
    requested_at: u64,
    subject: Subject,
    origin: Origin,
    effect: Effect,
    execution_fence: Option<String>,
    status: Status,
}

#[derive(Serialize, Deserialize)]
enum Subject {
    Stage(String),
    WorkNode(String),
    HumanDecision(String),
}

#[derive(Serialize, Deserialize)]
enum Origin {
    StageContinuation,
    WorkNode,
    HumanDecision,
}

#[derive(Serialize, Deserialize)]
enum Effect {
    ResumeStage,
    KeepNodeWaiting,
    RouteDecisionPorts,
}

#[derive(Serialize, Deserialize)]
enum Status {
    Pending,
    Approved,
    Denied,
    Aborted,
}

#[derive(Serialize, Deserialize)]
enum Decision {
    Approve,
    Deny,
    Abort,
}

#[derive(Serialize, Deserialize)]
enum Cause {
    HumanDecision,
    RunCancelled,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Resolution {
    ordinal: u64,
    decision: Decision,
    note: Option<String>,
    resolved_at: u64,
    idempotency_key: String,
    cause: Cause,
}

pub(crate) fn encode_approval(
    team: &TeamId,
    approval: &Approval,
    _contents: &ContentStore,
) -> Result<Vec<StoredRecord>, StoreFault> {
    encode(team, approval, approval.resolutions())
}

pub(crate) fn encode_approval_changes(
    team: &TeamId,
    approval: &Approval,
    _contents: &ContentStore,
) -> Result<Vec<StoredRecord>, StoreFault> {
    encode(team, approval, approval.new_resolutions())
}

fn encode(
    team: &TeamId,
    approval: &Approval,
    resolutions: &[ApprovalResolution],
) -> Result<Vec<StoredRecord>, StoreFault> {
    let facts = approval.facts();
    let header = Header {
        approval_id: facts.approval_id.clone(),
        run_id: facts.run_id.clone(),
        stage_id: facts.stage_id.clone(),
        role_id: facts.role_id.clone(),
        reason: facts.reason.clone(),
        requested_action: facts.requested_action.clone(),
        risk_summary: facts.risk_summary.clone(),
        idempotency_key: facts.idempotency_key.clone(),
        requested_at: facts.requested_at,
        subject: match &facts.subject {
            ApprovalSubject::Stage { stage_id } => Subject::Stage(stage_id.clone()),
            ApprovalSubject::WorkNode { node_id } => Subject::WorkNode(node_id.clone()),
            ApprovalSubject::HumanDecision { node_id } => Subject::HumanDecision(node_id.clone()),
        },
        origin: match facts.origin {
            ApprovalOrigin::StageContinuation => Origin::StageContinuation,
            ApprovalOrigin::WorkNode => Origin::WorkNode,
            ApprovalOrigin::HumanDecision => Origin::HumanDecision,
        },
        effect: match facts.effect {
            ApprovalEffect::ResumeStage => Effect::ResumeStage,
            ApprovalEffect::KeepNodeWaiting => Effect::KeepNodeWaiting,
            ApprovalEffect::RouteDecisionPorts => Effect::RouteDecisionPorts,
        },
        execution_fence: facts.execution_fence.clone(),
        status: match approval.status() {
            ApprovalStatus::Pending => Status::Pending,
            ApprovalStatus::Approved => Status::Approved,
            ApprovalStatus::Denied => Status::Denied,
            ApprovalStatus::Aborted => Status::Aborted,
        },
    };
    let record = |kind, id, payload| StoredRecord {
        key: RecordKey {
            kind,
            scope: facts.approval_id.clone(),
            id,
        },
        team_id: Some(team.as_str().to_owned()),
        run_id: Some(facts.run_id.clone()),
        payload,
    };
    let mut records = vec![record(
        RecordKind::Approval,
        String::new(),
        serde_json::to_vec(&header).map_err(|_| StoreFault::InvalidFacts)?,
    )];
    let start = approval.resolutions().len() - resolutions.len();
    for (offset, resolution) in resolutions.iter().enumerate() {
        let ordinal = (start + offset) as u64;
        let row = Resolution {
            ordinal,
            decision: match resolution.decision {
                ApprovalDecision::Approve => Decision::Approve,
                ApprovalDecision::Deny => Decision::Deny,
                ApprovalDecision::Abort => Decision::Abort,
            },
            note: resolution.note.clone(),
            resolved_at: resolution.resolved_at,
            idempotency_key: resolution.idempotency_key.clone(),
            cause: match resolution.cause {
                ApprovalResolutionCause::HumanDecision => Cause::HumanDecision,
                ApprovalResolutionCause::RunCancelled => Cause::RunCancelled,
            },
        };
        records.push(record(
            RecordKind::ApprovalResolution,
            ordinal.to_string(),
            serde_json::to_vec(&row).map_err(|_| StoreFault::InvalidFacts)?,
        ));
    }
    Ok(records)
}

pub(crate) fn decode_approval_header(record: &StoredRecord) -> Result<ApprovalHeader, StoreFault> {
    if record.key.kind != RecordKind::Approval || !record.key.id.is_empty() {
        return Err(StoreFault::CorruptRecord);
    }
    let row: Header =
        serde_json::from_slice(&record.payload).map_err(|_| StoreFault::CorruptRecord)?;
    if record.key.scope != row.approval_id || record.run_id.as_deref() != Some(row.run_id.as_str())
    {
        return Err(StoreFault::CorruptRecord);
    }
    Ok(ApprovalHeader {
        team: record_team(record)?,
        facts: ApprovalRequest {
            approval_id: row.approval_id,
            run_id: row.run_id,
            stage_id: row.stage_id,
            role_id: row.role_id,
            reason: row.reason,
            requested_action: row.requested_action,
            risk_summary: row.risk_summary,
            idempotency_key: row.idempotency_key,
            requested_at: row.requested_at,
            subject: match row.subject {
                Subject::Stage(stage_id) => ApprovalSubject::Stage { stage_id },
                Subject::WorkNode(node_id) => ApprovalSubject::WorkNode { node_id },
                Subject::HumanDecision(node_id) => ApprovalSubject::HumanDecision { node_id },
            },
            origin: match row.origin {
                Origin::StageContinuation => ApprovalOrigin::StageContinuation,
                Origin::WorkNode => ApprovalOrigin::WorkNode,
                Origin::HumanDecision => ApprovalOrigin::HumanDecision,
            },
            effect: match row.effect {
                Effect::ResumeStage => ApprovalEffect::ResumeStage,
                Effect::KeepNodeWaiting => ApprovalEffect::KeepNodeWaiting,
                Effect::RouteDecisionPorts => ApprovalEffect::RouteDecisionPorts,
            },
            execution_fence: row.execution_fence,
        },
        status: match row.status {
            Status::Pending => ApprovalStatus::Pending,
            Status::Approved => ApprovalStatus::Approved,
            Status::Denied => ApprovalStatus::Denied,
            Status::Aborted => ApprovalStatus::Aborted,
        },
    })
}

pub(crate) fn decode_approval_resolution(
    record: &StoredRecord,
) -> Result<ApprovalResolutionRecord, StoreFault> {
    if record.key.kind != RecordKind::ApprovalResolution {
        return Err(StoreFault::CorruptRecord);
    }
    let row: Resolution =
        serde_json::from_slice(&record.payload).map_err(|_| StoreFault::CorruptRecord)?;
    if record.key.id != row.ordinal.to_string() || record.key.scope.is_empty() {
        return Err(StoreFault::CorruptRecord);
    }
    Ok(ApprovalResolutionRecord {
        team: record_team(record)?,
        run_id: GraphRunId::new(record.run_id.clone().ok_or(StoreFault::CorruptRecord)?),
        approval_id: record.key.scope.clone(),
        ordinal: row.ordinal,
        resolution: ApprovalResolution {
            decision: match row.decision {
                Decision::Approve => ApprovalDecision::Approve,
                Decision::Deny => ApprovalDecision::Deny,
                Decision::Abort => ApprovalDecision::Abort,
            },
            note: row.note,
            resolved_at: row.resolved_at,
            idempotency_key: row.idempotency_key,
            cause: match row.cause {
                Cause::HumanDecision => ApprovalResolutionCause::HumanDecision,
                Cause::RunCancelled => ApprovalResolutionCause::RunCancelled,
            },
        },
    })
}

pub(crate) fn restore_approvals(
    records: &[StoredRecord],
    _contents: &ContentStore,
) -> Result<Vec<Approval>, StoreFault> {
    let mut headers = BTreeMap::new();
    let mut resolutions: BTreeMap<String, Vec<ApprovalResolutionRecord>> = BTreeMap::new();
    for record in records {
        match record.key.kind {
            RecordKind::Approval => {
                let header = decode_approval_header(record)?;
                if headers
                    .insert(header.facts.approval_id.clone(), header)
                    .is_some()
                {
                    return Err(StoreFault::CorruptRecord);
                }
            }
            RecordKind::ApprovalResolution => {
                let resolution = decode_approval_resolution(record)?;
                resolutions
                    .entry(resolution.approval_id.clone())
                    .or_default()
                    .push(resolution);
            }
            _ => {}
        }
    }
    let mut approvals = Vec::with_capacity(headers.len());
    for (id, header) in headers {
        let mut entries = resolutions.remove(&id).unwrap_or_default();
        entries.sort_by_key(|entry| entry.ordinal);
        for (ordinal, entry) in entries.iter().enumerate() {
            if entry.ordinal != ordinal as u64
                || entry.team != header.team
                || entry.run_id.as_str() != header.facts.run_id
            {
                return Err(StoreFault::CorruptRecord);
            }
        }
        approvals.push(
            Approval::restore(ApprovalDurableSnapshot {
                facts: header.facts,
                status: header.status,
                resolutions: entries.into_iter().map(|entry| entry.resolution).collect(),
            })
            .map_err(|_| StoreFault::InvalidFacts)?,
        );
    }
    if !resolutions.is_empty() {
        return Err(StoreFault::CorruptRecord);
    }
    Ok(approvals)
}

fn record_team(record: &StoredRecord) -> Result<TeamId, StoreFault> {
    TeamId::try_new(record.team_id.clone().ok_or(StoreFault::CorruptRecord)?)
        .map_err(|_| StoreFault::CorruptRecord)
}
