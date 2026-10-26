use std::sync::{Arc, Mutex};

use world_protocol::{bindings::BindingFailure, commit::CommitReceipt, ids::{CommitId, WorldRef}};

use crate::{
    extensions::lifecycle::{DrainedGraph, RetiringGraph},
    store::TransactionError,
};
use super::{
    BindingError, BindingGraph, Bindings, CommittedRetirement, GateFailure, Publication, RetirementContext,
    retire::{self, RetirementRecord},
};

enum Phase { Intent, Release(Arc<DrainedGraph>) }

pub(super) struct Pending {
    context: RetirementContext,
    graph: Arc<BindingGraph>,
    phase: Phase,
    publication: Mutex<Option<Publication>>,
}

pub(crate) enum RetirementCommitted {
    Draining { retirement: RetiringGraph, receipt: CommitReceipt },
    Released { lock: world_protocol::ids::ActivationLockId, receipt: CommitReceipt },
}

impl Bindings {
    pub fn retirement_revision(&self, world: &WorldRef, lock: &world_protocol::ids::ActivationLockId) -> Result<world_protocol::ids::Revision, BindingError> {
        self.retired.lock().expect("world committed retirements poisoned").get(&(world.clone(), lock.clone()))
            .map(|retirement| retirement.revision()).ok_or_else(|| GateFailure::ResolutionMismatch.into())
    }

    /// Maintenance only: ordinary upgrade and package uninstall never call this.
    pub async fn begin_retirement(
        &self, context: RetirementContext, graph: Arc<BindingGraph>,
    ) -> Result<RetirementCommitted, BindingError> {
        if context.request.world != graph.lock().world { return Err(BindingFailure::HeadInvalid.into()); }
        let batch = context.request.clone().prepare()?;
        let publication = self.gate.begin_retirement(context.request.world.clone(), context.request.commit_id.clone(),
            graph.lock().id.clone(), |access| Ok(self.live.preflight_retirement_in(access, &graph)?))?;
        let pending = Arc::new(Pending { context, graph, phase: Phase::Intent, publication: Mutex::new(Some(publication)) });
        let key = (pending.context.request.world.clone(), pending.context.request.commit_id.clone());
        self.retirements.lock().expect("world retirement publications poisoned").insert(key.clone(), pending.clone());
        let mutation = pending.clone();
        let outcome = self.store.transact(batch, move |tx| Box::pin(async move {
            retire::commit_intent(tx, &mutation.graph, &mutation.context).await
        })).await;
        self.resolve_retirement(&key, &pending, outcome)
    }

    pub async fn finish_retirement(
        &self, context: RetirementContext, proof: DrainedGraph,
    ) -> Result<RetirementCommitted, BindingError> {
        if context.request.world != *proof.world() || !self.live.validate_drained(&proof) {
            return Err(BindingFailure::LockIdentityConflict.into());
        }
        let proof = Arc::new(proof);
        self.drained.lock().expect("world drained graph capabilities poisoned")
            .insert((proof.world().clone(), proof.lock().clone()), proof.clone());
        self.finish_with_proof(context, proof).await
    }

    pub async fn retry_finish_retirement(
        &self, context: RetirementContext, lock: &world_protocol::ids::ActivationLockId,
    ) -> Result<RetirementCommitted, BindingError> {
        let proof = self.drained.lock().expect("world drained graph capabilities poisoned")
            .get(&(context.request.world.clone(), lock.clone())).cloned().ok_or(GateFailure::ResolutionMismatch)?;
        self.finish_with_proof(context, proof).await
    }

    async fn finish_with_proof(
        &self, context: RetirementContext, proof: Arc<DrainedGraph>,
    ) -> Result<RetirementCommitted, BindingError> {
        let capability = self.retired.lock().expect("world committed retirements poisoned")
            .get(&(proof.world().clone(), proof.lock().clone())).cloned()
            .ok_or(GateFailure::ResolutionMismatch)?;
        if capability.digest() != proof.digest() { return Err(BindingFailure::DigestMismatch.into()); }
        let batch = context.request.clone().prepare()?;
        let publication = self.gate.begin_retirement(context.request.world.clone(), context.request.commit_id.clone(),
            proof.lock().clone(), |_| Ok(()))?;
        let graph = capability.graph_arc();
        let pending = Arc::new(Pending { context, graph, phase: Phase::Release(proof),
            publication: Mutex::new(Some(publication)) });
        let key = (pending.context.request.world.clone(), pending.context.request.commit_id.clone());
        self.retirements.lock().expect("world retirement publications poisoned").insert(key.clone(), pending.clone());
        let mutation = pending.clone();
        let outcome = self.store.transact(batch, move |tx| Box::pin(async move {
            let Phase::Release(proof) = &mutation.phase else { unreachable!() };
            retire::commit_release(tx, &mutation.graph, &mutation.context, proof).await
        })).await;
        self.resolve_retirement(&key, &pending, outcome)
    }

    /// Authoritative recovery of the original identity only; absent is still unknown.
    pub async fn recover_retirement_commit(
        &self, world: &WorldRef, commit_id: &CommitId,
    ) -> Result<RetirementCommitted, BindingError> {
        let key = (world.clone(), commit_id.clone());
        let pending = self.retirements.lock().expect("world retirement publications poisoned")
            .get(&key).cloned().ok_or(GateFailure::ResolutionMismatch)?;
        let committed = self.store.read_commit::<RetirementRecord>(world, commit_id, &pending.context.request.input_digest).await
            .map_err(|error| BindingError::from(error).commit_unresolved(commit_id))?;
        self.publish_retirement(&key, &pending, committed.value, committed.receipt)
    }

    /// A fresh process recovers the committed intent, not a formerly live endpoint.
    pub async fn restore_retirement(
        &self, root: &crate::authorization::AuthorityRoot, world: WorldRef,
        lock: world_protocol::ids::ActivationLockId,
    ) -> Result<RetiringGraph, BindingError> {
        let recovered = self.store.snapshot(world.clone(), move |snapshot| Box::pin(async move {
            let row = snapshot.query_opt(
                "SELECT state,revision,retiring_commit_id FROM world_activation_lifecycle WHERE tenant_id=$1 AND world_id=$2 AND activation_lock_id=$3",
                &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &lock.as_str()],
            ).await?.ok_or(BindingFailure::LockIdentityConflict)?;
            if row.get::<_, String>("state") != "retiring" { return Err(BindingFailure::LockIdentityConflict.into()); }
            let revision = u64::try_from(row.get::<_, i64>("revision")).ok().filter(|revision| *revision >= 2)
                .map(world_protocol::ids::Revision).ok_or(BindingFailure::LockIdentityConflict)?;
            let commit: CommitId = row.get::<_, String>("retiring_commit_id").parse()
                .map_err(|_| BindingFailure::LockIdentityConflict)?;
            let graph = super::read_graph(snapshot, &lock).await?;
            Ok::<_, BindingError>((Arc::new(graph), revision, commit))
        })).await?;
        let (graph, revision, commit) = recovered;
        let committed = self.store.read_commit_for_recovery::<RetirementRecord>(root, &world, &commit).await?;
        let capability = Arc::new(CommittedRetirement::restored(graph.clone(), revision, &commit,
            &committed.value, committed.receipt)?);
        self.gate.synchronized(|access| {
            self.live.preflight_retirement_in(access, &graph)?;
            let retiring = self.live.retire_exact_in(access, &capability, &graph)?;
            self.retired.lock().expect("world committed retirements poisoned")
                .insert((world, graph.lock().id.clone()), capability);
            Ok::<_, BindingError>(retiring)
        })
    }

    fn resolve_retirement(
        &self, key: &(WorldRef, CommitId), pending: &Pending,
        outcome: Result<crate::store::Committed<RetirementRecord>, TransactionError<BindingError>>,
    ) -> Result<RetirementCommitted, BindingError> {
        match outcome {
            Ok(committed) => self.publish_retirement(key, pending, committed.value, committed.receipt),
            Err(error @ TransactionError::NotCommitted { .. }) => {
                let mut publication = pending.publication.lock().expect("world retirement capability poisoned");
                publication.as_ref().ok_or(GateFailure::ResolutionMismatch)?.not_committed(&error, |_| ())?;
                *publication = None;
                self.retirements.lock().expect("world retirement publications poisoned").remove(key);
                match error {
                    TransactionError::NotCommitted { error, cleanup: None } => Err(error),
                    TransactionError::NotCommitted { error, cleanup: Some(cleanup) } =>
                        Err(BindingError::Cleanup { failure: Box::new(error), cleanup }),
                    _ => unreachable!(),
                }
            }
            Err(TransactionError::Indeterminate(error)) => {
                if let Some(publication) = pending.publication.lock().expect("world retirement capability poisoned").as_ref() {
                    publication.mark_indeterminate()?;
                }
                Err(error.into())
            }
        }
    }

    fn publish_retirement(
        &self, key: &(WorldRef, CommitId), pending: &Pending, record: RetirementRecord, receipt: CommitReceipt,
    ) -> Result<RetirementCommitted, BindingError> {
        let result = (|| {
        record.check(&pending.graph, &pending.context, &receipt)?;
        let result = match &pending.phase {
            Phase::Intent => {
                let capability = Arc::new(CommittedRetirement::checked(pending.graph.clone(), &pending.context.request,
                    &record, receipt.clone())?);
                self.gate.recover_committed(&receipt, |access| {
                    let retirement = self.live.retire_exact_in(access, &capability, &pending.graph)?;
                    self.retired.lock().expect("world committed retirements poisoned")
                        .insert((capability.world().clone(), capability.lock().clone()), capability);
                    Ok(RetirementCommitted::Draining { retirement, receipt: receipt.clone() })
                })?
            }
            Phase::Release(proof) => self.gate.recover_committed(&receipt, |access| {
                self.live.release_retirement_in(access, proof)?;
                self.retired.lock().expect("world committed retirements poisoned")
                    .remove(&(pending.graph.lock().world.clone(), pending.graph.lock().id.clone()));
                self.drained.lock().expect("world drained graph capabilities poisoned")
                    .remove(&(pending.graph.lock().world.clone(), pending.graph.lock().id.clone()));
                Ok(RetirementCommitted::Released { lock: pending.graph.lock().id.clone(), receipt: receipt.clone() })
            })?,
        };
        self.retirements.lock().expect("world retirement publications poisoned").remove(key);
        Ok(result)
        })();
        result.map_err(|error: BindingError| error.commit_unresolved(&pending.context.request.commit_id))
    }
}
