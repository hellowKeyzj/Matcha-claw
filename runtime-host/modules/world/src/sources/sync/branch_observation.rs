use world_protocol::{
    facts::{Assertion, AssertionOrigin, Claim, Evidence, ObservationDraft},
    identity::{IdentityReceipt, SourceKey}, ids::*, materials::SourceVersion,
    provenance::ReadDependency, releases::BranchRef, time::Timestamp,
};
use crate::{authorization::Admission, sources::mapping, store::WorldTransaction};
use super::{BranchCapture, SyncError};

pub(crate) struct BranchObservation<'a> {
    capture: &'a BranchCapture,
    prepared: &'a PreparedObservation,
    receipts: &'a [IdentityReceipt],
}
struct PreparedObservation {
    id: AssertionId,
    draft: ObservationDraft,
    dependencies: Vec<ReadDependency>,
    key: SourceKey,
    previous: Option<Assertion>,
}
pub(super) struct BranchObservations<'a> {
    capture: &'a BranchCapture,
    receipts: Vec<IdentityReceipt>,
    observations: Vec<PreparedObservation>,
}
impl BranchObservations<'_> {
    pub(super) fn len(&self) -> usize { self.observations.len() }
    pub(super) fn observation(&self, index: usize) -> Option<BranchObservation<'_>> {
        Some(BranchObservation { capture: self.capture, prepared: self.observations.get(index)?, receipts: &self.receipts })
    }
}
impl BranchObservation<'_> {
    pub(crate) fn id(&self) -> &AssertionId { &self.prepared.id }
    pub(crate) fn draft(&self) -> &ObservationDraft { &self.prepared.draft }
    pub(crate) fn branch(&self) -> &BranchRef { &self.capture.dto.branch }
    pub(crate) fn capture(&self) -> &BranchCapture { self.capture }
    pub(crate) fn source_version(&self) -> &SourceVersion { &self.capture.version }
    pub(crate) fn evidence(&self) -> &[Evidence] { &self.capture.dto.evidence }
    pub(crate) fn receipts(&self) -> &[IdentityReceipt] { self.receipts }
    pub(crate) fn dependencies(&self) -> &[ReadDependency] { &self.prepared.dependencies }
    pub(crate) fn expected_source_head(&self, id: &AssertionId) -> Option<&AssertionRef> {
        self.prepared.previous.as_ref().filter(|old| &old.reference.id == id).map(|old| &old.reference)
    }
    pub(super) fn key(&self) -> &SourceKey { &self.prepared.key }
    pub(crate) async fn recheck(&self, tx: &WorldTransaction<'_>, admission: &Admission, now: &Timestamp, budget: &crate::extensions::invocation::CallBudget, cancellation: &tokio_util::sync::CancellationToken) -> Result<(), SyncError> {
        self.capture.recheck(tx, admission, now).await?;
        crate::identity::recheck_receipts(tx, self.receipts, &[]).await?;
        let mut request = super::branch_capture::request(&self.capture.raw, &self.capture.plan, &self.capture.version);
        request.batch.rows.retain(|row| row.native_key == self.key().native_key && row.incarnation == self.key().incarnation);
        if request.batch.rows.len() != 1 { return Err(SyncError::protocol()); }
        request.identities = self.receipts.to_vec();
        let (mapped, dependencies) = mapping::map_branch_observations(&request, budget, cancellation)?;
        let mut matches = mapped.observations.iter().zip(&dependencies).filter(|(draft, _)| *draft == self.draft());
        let (_, dependencies) = matches.next().ok_or_else(SyncError::protocol)?;
        if matches.next().is_some() || dependencies != self.dependencies() || claim_id(self.capture, self.key(), self.draft())? != *self.id() { return Err(SyncError::protocol()); }
        let previous = source_head(tx, self.capture, self.key(), self.id()).await?;
        if previous != self.prepared.previous { return Err(SyncError::protocol()); }
        Ok(())
    }
}

pub(super) async fn prepare<'a>(
    tx: &WorldTransaction<'_>, capture: &'a BranchCapture, receipts: Vec<IdentityReceipt>,
    budget: &crate::extensions::invocation::CallBudget, cancellation: &tokio_util::sync::CancellationToken,
) -> Result<BranchObservations<'a>, SyncError> {
    let mut request = super::branch_capture::request(&capture.raw, &capture.plan, &capture.version);
    request.identities = receipts.clone();
    let (mapped, dependencies) = mapping::map_branch_observations(&request, budget, cancellation)?;
    if !mapped.failures.is_empty() || !mapped.gaps.is_empty() || mapped.evidence != capture.dto.evidence { return Err(SyncError::protocol()); }
    let mut observations = Vec::new();
    for (draft, dependencies) in mapped.observations.into_iter().zip(dependencies) {
        let mut proposals = capture.dto.proposals.iter().filter(|proposal| {
            proposal.fields.iter().any(|field| matches!(&draft.claim, Claim::Attribute(claim) if claim.property == field.property) && field.evidence == draft.evidence)
                || proposal.relations.iter().any(|relation| matches!(&draft.claim, Claim::Relation(claim) if claim.relation_type == relation.relation_type) && relation.evidence == draft.evidence)
        });
        let key = proposals.next().ok_or_else(SyncError::protocol)?.key.clone();
        if proposals.next().is_some() { return Err(SyncError::protocol()); }
        let id = claim_id(capture, &key, &draft)?;
        let previous = source_head(tx, capture, &key, &id).await?;
        observations.push(PreparedObservation { id, draft, dependencies, key, previous });
    }
    Ok(BranchObservations { capture, receipts, observations })
}

fn claim_id(capture: &BranchCapture, key: &SourceKey, draft: &ObservationDraft) -> Result<AssertionId, SyncError> {
    super::claims::claim_id(&capture.dto.branch.world, &key.source_id, &capture.plan.binding_body.resource, &capture.dto.binding.id, (&key.namespace, &key.native_key, &key.incarnation), &draft.claim)
}
async fn source_head(tx: &WorldTransaction<'_>, capture: &BranchCapture, key: &SourceKey, id: &AssertionId) -> Result<Option<Assertion>, SyncError> {
    let w = tx.world();
    let row = tx.query_opt("SELECT c.namespace,c.native_key,c.record_incarnation,c.binding_id,c.body,r.body AS current FROM world_source_claim c JOIN world_assertion_head h USING(tenant_id,world_id,assertion_id) JOIN world_assertion_revision r USING(tenant_id,world_id,assertion_id,revision) WHERE c.tenant_id=$1 AND c.world_id=$2 AND c.source_id=$3 AND c.partition_key=$4 AND c.assertion_id=$5", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &key.source_id.as_str(), &capture.plan.binding_body.resource, &id.as_str()]).await?;
    let Some(row) = row else { return Ok(None); };
    let indexed: Assertion = super::decode(row.get("body"))?;
    let current: Assertion = super::decode(row.get("current"))?;
    let AssertionOrigin::Source { binding, .. } = &current.origin else { return Err(SyncError::protocol()); };
    if indexed != current || current.reference.id != *id || binding.id != capture.dto.binding.id || row.get::<_, String>("binding_id") != binding.id.as_str() || row.get::<_, String>("namespace") != key.namespace || row.get::<_, String>("native_key") != key.native_key || row.get::<_, String>("record_incarnation") != key.incarnation { return Err(SyncError::protocol()); }
    let old = crate::releases::read_definition_exact(tx, binding).await.map_err(mapping::MappingError::from)?.ok_or_else(SyncError::protocol)?;
    let world_protocol::definitions::DefinitionBody::SourceBinding(old) = old.body else { return Err(SyncError::protocol()); };
    if old.source_id != key.source_id || old.incarnation != capture.plan.binding_body.incarnation || old.namespace != key.namespace { return Err(SyncError::protocol()); }
    Ok(Some(current))
}
