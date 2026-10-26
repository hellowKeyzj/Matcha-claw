use std::collections::BTreeSet;
use tokio_util::sync::CancellationToken;
use crate::{authorization::VerifiedInvocation, extensions::invocation::CallBudget, store::{StoreError, WorldTransaction}};
use super::{basis, reject, verified::ReadGuard};
use world_protocol::{authorization::ActualImpact, ids::*, provenance::{ConclusionSupport, ProvenanceFailure}, releases::Release, time::{Timestamp, ValidTime}};

/// An authorized materialization, not permission or a cached whole-interval truth value.
pub(crate) struct IntervalBasis {
    roots: BTreeSet<AssertionRef>, whole: ValidTime, scope: ScopeId, model: Release,
    graph: basis::SupportGraph, cuts: Vec<Timestamp>, impact: ActualImpact, fingerprint: Digest,
    budget: CallBudget, cancel: CancellationToken,
}
impl IntervalBasis {
    pub(crate) fn cuts(&self) -> &[Timestamp] { &self.cuts }
    pub(crate) fn impact(&self) -> &ActualImpact { &self.impact }
    pub(crate) fn fingerprint(&self) -> &Digest { &self.fingerprint }
    pub(super) fn stored(&self, root: &AssertionRef) -> Result<&[world_protocol::provenance::SupportSet], StoreError> {
        self.graph.stored(root)
    }
    pub(crate) fn resolve(&self, root: &AssertionRef, segment: &ValidTime) -> Result<ConclusionSupport, StoreError> {
        super::checkpoint(&self.budget, &self.cancel)?;
        if !self.roots.contains(root) { return Err(reject(ProvenanceFailure::MissingPremise)); }
        if segment.to.as_ref().is_some_and(|to| to <= &segment.from) || !super::contains(&self.whole, segment) {
            return Err(reject(ProvenanceFailure::InvalidInterval));
        }
        let snapshot = self.graph.resolve(root, &self.model, &self.scope, Some(segment), Some(&self.budget), Some(&self.cancel))?;
        Ok(super::maintenance::resolve_interval(&snapshot, root, &self.scope, &self.model.id, None, segment))
    }
}

pub(crate) async fn interval_basis(
    tx: &WorldTransaction<'_>, verified: &VerifiedInvocation, roots: &[AssertionRef],
    scope: &ScopeId, release: &ReleaseId, budget: &CallBudget, cancel: &CancellationToken,
    whole: &ValidTime,
) -> Result<IntervalBasis, StoreError> {
    super::checkpoint(budget, cancel)?;
    if verified.invocation().world != *tx.world() || verified.invocation().branch_id.is_some()
        || roots.iter().any(|root| root.world != *tx.world()) { return Err(reject(ProvenanceFailure::CrossScope)); }
    if whole.to.as_ref().is_some_and(|to| to <= &whole.from) { return Err(reject(ProvenanceFailure::InvalidInterval)); }
    if roots.is_empty() { return Err(reject(ProvenanceFailure::MissingPremise)); }
    if roots.len() > super::BATCH_LIMIT { return Err(super::limit(world_protocol::provenance::ProvenanceLimit::ComponentNodes)); }
    let now = tx.now().await?;
    let model = crate::query::support_model(tx, release, None).await.map_err(super::query_error)?;
    let current = crate::releases::read_active_model(tx).await.map_err(|error| {
        StoreError::caused_by(world_protocol::commit::CommitFailure::InvalidBatch, world_protocol::failure::FailureStage::Read, error)
    })?.ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
    let mut guard = ReadGuard::new(tx, verified, &model, &current, budget, cancel, &now, whole);
    let graph = basis::support_graph_read(basis::Reader::Transaction(tx), roots, &model, scope,
        Some(budget), Some(cancel), &now, Some(&mut guard)).await?;
    let cuts = guard.cuts();
    let roots = roots.iter().cloned().collect::<BTreeSet<_>>();
    let (_, impact, fingerprint) = guard.finish_basis(&(&roots, whole, graph.basis(), &cuts)).await?;
    Ok(IntervalBasis { roots, whole: whole.clone(), scope: scope.clone(), model, graph, cuts, impact, fingerprint,
        budget: budget.clone(), cancel: cancel.clone() })
}
