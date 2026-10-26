use std::sync::Arc;

use serde::{Deserialize, Serialize};
use world_protocol::{
    bindings::BindingFailure,
    commit::CommitReceipt,
    ids::{ActivationLockId, CommitId, Digest, EventId, ResourceRef, Revision, WorldRef, WriterDomain},
};

use crate::{
    authorization::{self, Admission},
    extensions::{lifecycle::DrainedGraph, package::{RetentionOwner, release_packages}},
    owner, releases,
    store::{CommitRequest, OutboxEvent, WorldTransaction},
};
use super::{BindingError, BindingGraph, durable};

#[derive(Clone)]
pub(crate) struct RetirementContext {
    pub request: CommitRequest,
    pub admission: Admission,
    pub expected_revision: Revision,
    pub event_id: EventId,
}

#[derive(Clone)]
pub(crate) struct RetirementCandidate {
    pub graph: Arc<BindingGraph>,
    pub revision: Revision,
}

pub(crate) async fn retirement_candidates_snapshot(
    snapshot: &crate::store::WorldSnapshot<'_>, maximum: u32,
) -> Result<Vec<RetirementCandidate>, BindingError> {
    let world = snapshot.world();
    snapshot.query(
        "SELECT l.activation_lock_id,l.revision,g.content_digest,g.graph FROM world_activation_lifecycle l JOIN world_activation_lock g USING(tenant_id,world_id,activation_lock_id) WHERE l.tenant_id=$1 AND l.world_id=$2 AND l.state='active' AND NOT EXISTS(SELECT 1 FROM world_binding_head h WHERE h.tenant_id=l.tenant_id AND h.world_id=l.world_id AND h.activation_lock_id=l.activation_lock_id) ORDER BY l.activation_lock_id LIMIT $3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &i64::from(maximum)],
    ).await?.into_iter().map(|row| {
        let id: ActivationLockId = row.get::<_, String>("activation_lock_id").parse()
            .map_err(|_| BindingFailure::LockIdentityConflict)?;
        let revision = u64::try_from(row.get::<_, i64>("revision")).ok().filter(|revision| *revision > 0)
            .map(Revision).ok_or(BindingFailure::LockIdentityConflict)?;
        let graph = durable::checked_graph(world, &id, row.get("content_digest"), row.get("graph"))?;
        Ok(RetirementCandidate { graph: Arc::new(graph), revision })
    }).collect()
}

/// This capability is constructed only after the original intent's authoritative
/// receipt is observed. It grants resource retirement, not package-pin release.
pub(crate) struct CommittedRetirement {
    graph: Arc<BindingGraph>,
    receipt: CommitReceipt,
    revision: Revision,
}

impl CommittedRetirement {
    pub fn world(&self) -> &WorldRef { &self.graph.lock().world }
    pub fn lock(&self) -> &ActivationLockId { &self.graph.lock().id }
    pub fn digest(&self) -> &Digest { &self.graph.lock().digest }
    pub fn commit_id(&self) -> &CommitId { &self.receipt.commit_id }
    pub fn revision(&self) -> Revision { self.revision }
    pub fn graph(&self) -> &BindingGraph { &self.graph }
    pub(super) fn graph_arc(&self) -> Arc<BindingGraph> { self.graph.clone() }

    pub(super) fn checked(
        graph: Arc<BindingGraph>, request: &CommitRequest, record: &RetirementRecord, receipt: CommitReceipt,
    ) -> Result<Self, BindingError> {
        if receipt.world != request.world || receipt.commit_id != request.commit_id
            || record.world != graph.lock().world || record.activation_lock_id != graph.lock().id
            || record.digest != graph.lock().digest || record.revision.0 < 2 {
            return Err(BindingFailure::LockIdentityConflict.into());
        }
        Ok(Self { graph, receipt, revision: record.revision })
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RetirementRecord {
    world: WorldRef,
    activation_lock_id: ActivationLockId,
    digest: Digest,
    revision: Revision,
}

impl RetirementRecord {
    pub(super) fn check(
        &self, graph: &BindingGraph, context: &RetirementContext, receipt: &CommitReceipt,
    ) -> Result<(), BindingError> {
        if self.world != graph.lock().world || self.activation_lock_id != graph.lock().id
            || self.digest != graph.lock().digest || receipt.world != context.request.world
            || receipt.commit_id != context.request.commit_id
            || Some(self.revision.0) != context.expected_revision.0.checked_add(1)
            || !receipt.outbox_ids.contains(&context.event_id) {
            return Err(BindingFailure::LockIdentityConflict.into());
        }
        Ok(())
    }
}

pub(crate) async fn read_retirements(
    snapshot: &crate::store::WorldSnapshot<'_>,
) -> Result<Vec<(String, Result<(ActivationLockId, Revision, CommitId), BindingFailure>)>, BindingError> {
    let world = snapshot.world();
    Ok(snapshot.query(
        "SELECT activation_lock_id,revision,retiring_commit_id FROM world_activation_lifecycle WHERE tenant_id=$1 AND world_id=$2 AND state='retiring' ORDER BY activation_lock_id",
        &[&world.tenant_id.as_str(), &world.world_id.as_str()],
    ).await?.into_iter().map(|row| {
        let key = row.get::<_, String>("activation_lock_id");
        let retirement = (|| {
            let id = key.parse::<ActivationLockId>().map_err(|_| BindingFailure::LockIdentityConflict)?;
            let revision = u64::try_from(row.get::<_, i64>("revision")).ok().filter(|revision| *revision >= 2)
                .map(Revision).ok_or(BindingFailure::LockIdentityConflict)?;
            let commit = row.get::<_, String>("retiring_commit_id").parse::<CommitId>()
                .map_err(|_| BindingFailure::LockIdentityConflict)?;
            Ok((id, revision, commit))
        })();
        (key, retirement)
    }).collect())
}

impl CommittedRetirement {
    pub(super) fn restored(
        graph: Arc<BindingGraph>, revision: Revision, commit: &CommitId, record: &RetirementRecord, receipt: CommitReceipt,
    ) -> Result<Self, BindingError> {
        if record.world != graph.lock().world || record.activation_lock_id != graph.lock().id
            || record.digest != graph.lock().digest || record.revision != revision
            || receipt.world != graph.lock().world || &receipt.commit_id != commit {
            return Err(BindingFailure::LockIdentityConflict.into());
        }
        Ok(Self { graph, receipt, revision: record.revision })
    }
}

pub(super) async fn commit_intent(
    tx: &mut WorldTransaction<'_>, graph: &BindingGraph, context: &RetirementContext,
) -> Result<RetirementRecord, BindingError> {
    require_writer(tx)?;
    let revision = lock_lifecycle(tx, &graph.lock().id, "active", context.expected_revision).await?;
    check_graph(tx, graph).await?;
    recheck_authority(tx, graph, &context.admission).await?;
    require_unreferenced(tx, graph).await?;
    let world = tx.world();
    let changed = tx.execute(
        "UPDATE world_activation_lifecycle SET state='retiring',revision=$4,retiring_commit_id=$5 WHERE tenant_id=$1 AND world_id=$2 AND activation_lock_id=$3 AND state='active' AND revision=$6",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &graph.lock().id.as_str(),
          &(revision.0 as i64), &tx.commit_id().as_str(), &(context.expected_revision.0 as i64)],
    ).await?;
    if changed != 1 { return Err(BindingFailure::LockIdentityConflict.into()); }
    let record = RetirementRecord { world: world.clone(), activation_lock_id: graph.lock().id.clone(),
        digest: graph.lock().digest.clone(), revision };
    emit(tx, &record, context.event_id.clone(), "world.bindings.retiring").await?;
    Ok(record)
}

pub(super) async fn commit_release(
    tx: &mut WorldTransaction<'_>, graph: &BindingGraph, context: &RetirementContext, proof: &DrainedGraph,
) -> Result<RetirementRecord, BindingError> {
    require_writer(tx)?;
    if proof.world() != tx.world() || proof.lock() != &graph.lock().id || proof.digest() != &graph.lock().digest {
        return Err(BindingFailure::LockIdentityConflict.into());
    }
    let revision = lock_lifecycle(tx, &graph.lock().id, "retiring", context.expected_revision).await?;
    check_graph(tx, graph).await?;
    recheck_authority(tx, graph, &context.admission).await?;
    require_unreferenced(tx, graph).await?;
    let packages = graph.lock().nodes.iter().map(|node| node.implementation.package_digest.clone())
        .collect::<std::collections::BTreeSet<_>>().into_iter().collect::<Vec<_>>();
    release_packages(tx, RetentionOwner::ActivationLock(&graph.lock().id), Revision(0), &packages).await?;
    let world = tx.world();
    let changed = tx.execute(
        "UPDATE world_activation_lifecycle SET state='released',revision=$4,released_commit_id=$5 WHERE tenant_id=$1 AND world_id=$2 AND activation_lock_id=$3 AND state='retiring' AND revision=$6",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &graph.lock().id.as_str(),
          &(revision.0 as i64), &tx.commit_id().as_str(), &(context.expected_revision.0 as i64)],
    ).await?;
    if changed != 1 { return Err(BindingFailure::LockIdentityConflict.into()); }
    let record = RetirementRecord { world: world.clone(), activation_lock_id: graph.lock().id.clone(),
        digest: graph.lock().digest.clone(), revision };
    emit(tx, &record, context.event_id.clone(), "world.bindings.released").await?;
    Ok(record)
}

async fn lock_lifecycle(
    tx: &WorldTransaction<'_>, id: &ActivationLockId, state: &str, expected: Revision,
) -> Result<Revision, BindingError> {
    let world = tx.world();
    let row = tx.query_opt(
        "SELECT state,revision FROM world_activation_lifecycle WHERE tenant_id=$1 AND world_id=$2 AND activation_lock_id=$3 FOR UPDATE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()],
    ).await?.ok_or_else(|| BindingFailure::MissingActivationLock { activation_lock_id: id.clone() })?;
    if row.get::<_, String>("state") != state || expected.0 == 0
        || i64::try_from(expected.0).ok() != Some(row.get::<_, i64>("revision")) {
        return Err(BindingFailure::LockRetiring { activation_lock_id: id.clone() }.into());
    }
    let revision = expected.0.checked_add(1).filter(|revision| *revision <= i64::MAX as u64)
        .ok_or(BindingFailure::LockIdentityConflict)?;
    Ok(Revision(revision))
}

async fn check_graph(tx: &WorldTransaction<'_>, expected: &BindingGraph) -> Result<(), BindingError> {
    let world = tx.world();
    let row = tx.query_opt(
        "SELECT content_digest,graph FROM world_activation_lock WHERE tenant_id=$1 AND world_id=$2 AND activation_lock_id=$3 FOR SHARE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &expected.lock().id.as_str()],
    ).await?.ok_or_else(|| BindingFailure::MissingActivationLock { activation_lock_id: expected.lock().id.clone() })?;
    let graph = durable::checked_graph(world, &expected.lock().id, row.get("content_digest"), row.get("graph"))?;
    if graph.lock().digest != expected.lock().digest { return Err(BindingFailure::LockIdentityConflict.into()); }
    Ok(())
}

async fn require_unreferenced(tx: &WorldTransaction<'_>, graph: &BindingGraph) -> Result<(), BindingError> {
    let world = tx.world();
    let referenced = tx.query_opt(
        "SELECT 1 FROM world_binding_head WHERE tenant_id=$1 AND world_id=$2 AND activation_lock_id=$3 LIMIT 1",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &graph.lock().id.as_str()],
    ).await?.is_some();
    if referenced || owner::has_activation_references(tx, &graph.lock().id).await?
        || releases::has_activation_references(tx, &graph.lock().id).await?
        || crate::extensions::migration::has_activation_references(tx, &graph.lock().id).await? {
        return Err(BindingFailure::RetainedReferences { activation_lock_id: graph.lock().id.clone() }.into());
    }
    Ok(())
}

async fn recheck_authority(tx: &WorldTransaction<'_>, graph: &BindingGraph, admission: &Admission) -> Result<(), BindingError> {
    let now = tx.now().await?;
    authorization::recheck(tx, admission, &now).await?;
    admission.require_access(&retirement_impact(tx, graph).await?)?;
    Ok(())
}

pub(crate) async fn retirement_impact(
    tx: &WorldTransaction<'_>, graph: &BindingGraph,
) -> Result<world_protocol::authorization::ActualImpact, BindingError> {
    if tx.world() != &graph.lock().world { return Err(BindingFailure::LockIdentityConflict.into()); }
    let mut resources = graph.lock().nodes.iter().flat_map(|node| [
        ResourceRef::Binding { id: node.binding_id.clone() },
        ResourceRef::Package { id: node.implementation.install_id.clone() },
    ]).collect::<std::collections::BTreeSet<_>>();
    resources.extend(graph.lock().nodes.iter().filter_map(|node| node.state.as_ref()
        .map(|state| ResourceRef::State { id: state.root.id.clone() })));
    Ok(authorization::actual_impact(vec![world_protocol::authorization::AccessScope {
        resources: resources.into_iter().collect(), fields: Vec::new(), modes: vec![world_protocol::authorization::AccessMode::Manage],
        scope: owner::management_scope(tx).await?, valid_time: None,
    }], Vec::new(), Vec::new(), Vec::new(), Vec::new())?)
}

fn require_writer(tx: &WorldTransaction<'_>) -> Result<(), BindingError> {
    Ok(tx.require_domain(&WriterDomain::try_new("bindings").expect("fixed binding writer domain"))?)
}

async fn emit(tx: &mut WorldTransaction<'_>, record: &RetirementRecord, event_id: EventId, kind: &str) -> Result<(), BindingError> {
    tx.emit(OutboxEvent { event_id, aggregate_kind: "activation_lock".into(),
        aggregate_id: record.activation_lock_id.to_string(), aggregate_revision: record.revision.0,
        event_kind: kind.into(), payload: durable::encode(record)?, causation_id: None, origin: "world.bindings".into() }).await?;
    Ok(())
}
