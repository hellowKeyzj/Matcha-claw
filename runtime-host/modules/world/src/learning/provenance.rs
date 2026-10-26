use std::collections::BTreeSet;

use world_protocol::{
    authorization::{AccessMode, AccessScope, ActualImpact},
    generation::GenerationState,
    ids::{CandidateId, Digest, ModelCallId, ResourceRef, WorldRef},
    learning::{Candidate, LearningFailure},
};

use super::{Error, invalid};
use crate::{
    authorization::{self, Admission},
    definitions::canonical_digest,
    store::WorldTransaction,
};

/// Only a canonical candidate read can mint this attachment; caller model-call IDs are not proof.
pub(crate) struct AttachedModelCall {
    world: WorldRef,
    candidate_id: CandidateId,
    id: ModelCallId,
    request_digest: Digest,
    receipt_digest: Digest,
    impact: ActualImpact,
}
impl AttachedModelCall {
    pub(crate) fn world(&self) -> &WorldRef {
        &self.world
    }
    pub(crate) fn candidate_id(&self) -> &CandidateId {
        &self.candidate_id
    }
    pub(crate) fn id(&self) -> &ModelCallId {
        &self.id
    }
    pub(crate) fn request_digest(&self) -> &Digest {
        &self.request_digest
    }
    pub(crate) fn receipt_digest(&self) -> &Digest {
        &self.receipt_digest
    }
    pub(crate) fn impact(&self) -> &ActualImpact {
        &self.impact
    }
}

pub(super) async fn prepare(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    candidate: &Candidate,
    draft: Option<&crate::owner::DraftModelCalls>,
) -> Result<Vec<(ModelCallId, Digest, Digest)>, Error> {
    if draft.is_some_and(|proof| proof.candidate() != candidate) {
        return Err(invalid(0, "modelCalls.draft"));
    }
    let mut ids = BTreeSet::new();
    let mut calls = Vec::new();
    for id in &candidate.model_calls {
        if !ids.insert(id) {
            return Err(invalid(0, "modelCalls"));
        }
        let recorded = match draft {
            Some(proof) => crate::generation::read_draft_recorded(tx, admission, proof, id).await?,
            None => crate::generation::read_recorded(tx, admission, id).await?,
        }
        .ok_or_else(|| invalid(0, "modelCalls.receipt"))?;
        require_completed(recorded.receipt())?;
        calls.push((
            id.clone(),
            canonical_digest(recorded.request())?,
            canonical_digest(recorded.receipt())?,
        ));
    }
    Ok(calls)
}

pub(super) async fn attach(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    candidate: &Candidate,
    calls: &[(ModelCallId, Digest, Digest)],
) -> Result<(), Error> {
    for (id, request, receipt) in calls {
        tx.execute("INSERT INTO world_candidate_model_call(tenant_id,world_id,candidate_id,model_call_id,request_digest,receipt_digest) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
            &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &candidate.id.as_str(), &id.as_str(), &request.as_str(), &receipt.as_str()]).await?;
    }
    let rows = tx.query("SELECT model_call_id,request_digest,receipt_digest FROM world_candidate_model_call WHERE tenant_id=$1 AND world_id=$2 AND candidate_id=$3 ORDER BY model_call_id",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &candidate.id.as_str()]).await?;
    if rows.len() != calls.len() || rows.iter().any(|row| {
        !calls.iter().any(|(id, request, receipt)| {
            id.as_str() == row.get::<_, String>("model_call_id")
                && request.as_str() == row.get::<_, String>("request_digest")
                && receipt.as_str() == row.get::<_, String>("receipt_digest")
        })
    }) {
        return Err(LearningFailure::BasisChanged.into());
    }
    recheck(tx, admission, candidate).await?;
    Ok(())
}

async fn attachments(
    tx: &WorldTransaction<'_>,
    candidate: &Candidate,
) -> Result<Vec<AttachedModelCall>, Error> {
    let (branch, stored) = crate::releases::read_candidate(tx, &candidate.id)
        .await?
        .ok_or(LearningFailure::BasisChanged)?;
    if &stored != candidate {
        return Err(LearningFailure::BasisChanged.into());
    }
    let task = crate::evaluation::read_task(tx, &branch.task_id, branch.task_revision).await?;
    let impact = authorization::actual_impact(
        vec![AccessScope {
            resources: vec![ResourceRef::ChangeSet {
                id: stored.change_set.id.clone(),
            }],
            fields: Vec::new(),
            modes: vec![AccessMode::Read],
            scope: task.scope,
            valid_time: None,
        }],
        Vec::new(),
        stored
            .evidence
            .iter()
            .flat_map(|item| item.access.labels.clone())
            .collect(),
        Vec::new(),
        stored
            .evidence
            .iter()
            .map(|item| item.locator.source_version.source_id.clone())
            .collect(),
    )?;
    let rows = tx.query("SELECT model_call_id,request_digest,receipt_digest FROM world_candidate_model_call WHERE tenant_id=$1 AND world_id=$2 AND candidate_id=$3 ORDER BY model_call_id",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &stored.id.as_str()]).await?;
    let expected: BTreeSet<_> = stored.model_calls.iter().collect();
    if expected.len() != stored.model_calls.len() || rows.len() != expected.len() {
        return Err(LearningFailure::BasisChanged.into());
    }
    let mut attachments = Vec::with_capacity(rows.len());
    for row in rows {
        let id = ModelCallId::try_new(row.get::<_, String>("model_call_id"))
            .map_err(|_| invalid(0, "modelCalls.id"))?;
        if !expected.contains(&id) {
            return Err(LearningFailure::BasisChanged.into());
        }
        let attached = AttachedModelCall {
            world: stored.world.clone(),
            candidate_id: stored.id.clone(),
            id,
            request_digest: Digest::try_new(row.get::<_, String>("request_digest"))
                .map_err(|_| invalid(0, "modelCalls.requestDigest"))?,
            receipt_digest: Digest::try_new(row.get::<_, String>("receipt_digest"))
                .map_err(|_| invalid(0, "modelCalls.receiptDigest"))?,
            impact: impact.clone(),
        };
        attachments.push(attached);
    }
    Ok(attachments)
}

pub(super) async fn impacts(
    tx: &WorldTransaction<'_>,
    candidate: &Candidate,
) -> Result<Vec<ActualImpact>, Error> {
    let mut impacts = Vec::new();
    for attached in attachments(tx, candidate).await? {
        impacts.push(crate::generation::attached_impact(tx, &attached).await?);
    }
    Ok(impacts)
}

pub(crate) async fn recheck(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    candidate: &Candidate,
) -> Result<(), Error> {
    for attached in attachments(tx, candidate).await? {
        let recorded = crate::generation::read_attached(tx, admission, &attached)
            .await?
            .ok_or_else(|| invalid(0, "modelCalls.receipt"))?;
        require_completed(recorded.receipt())?;
    }
    Ok(())
}

fn require_completed(receipt: &world_protocol::generation::GenerationReceipt) -> Result<(), Error> {
    if receipt.state != GenerationState::Completed
        || receipt.delivery_uncertain
        || receipt.completed_at.is_none()
    {
        return Err(invalid(0, "modelCalls.completed"));
    }
    Ok(())
}
