use std::sync::{Arc, Mutex};

use tokio::time::Instant;
use world_protocol::{bindings::{BindingChannel, BindingFailure, BindingHeadCas}, ids::{CommitId, WorldRef}, state::StateEpoch};

use crate::{extensions::lifecycle::{DrainedState, DrainingState, PreparedGraph}, store::CommitRequest};
use super::{BindingError, BindingGraph, Bindings, GateFailure, Publication};

type RestoreGraph = (Arc<BindingGraph>, Vec<BindingChannel>);

#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) enum PreparationPhase { Preparing, Submitted, NotCommitted, Committed, Restored }

pub(super) struct Preparing {
    pub(super) request: CommitRequest,
    pub(super) digest: world_protocol::ids::Digest,
    pub(super) heads: Vec<BindingHeadCas>,
    pub(super) phase: Mutex<PreparationPhase>,
    pub(super) publication: Mutex<Option<Publication>>,
    draining: tokio::sync::Mutex<Option<DrainingState>>,
    drained: Mutex<Option<Arc<DrainedState>>>,
    pub(super) stages: Mutex<std::collections::BTreeMap<CommitId, crate::content::StagedCommit>>,
    restore: Vec<RestoreGraph>,
}

/// The registry retains the original reservation and drain custody if its observer leaves.
#[derive(Clone)]
pub(crate) struct ReservedActivation { pub(super) inner: Arc<Preparing> }

impl ReservedActivation {
    pub fn affected_graphs(&self) -> Vec<RestoreGraph> { self.inner.restore.clone() }
    pub fn commit_id(&self) -> &CommitId { &self.inner.request.commit_id }
    pub(crate) fn retain_stage(
        &self, checkpoint: CommitId, staged: crate::content::StagedCommit,
    ) -> Result<(), BindingError> {
        let request = staged.request();
        if request.world != self.inner.request.world || request.commit_id != self.inner.request.commit_id
            || request.input_digest != self.inner.request.input_digest || checkpoint == request.commit_id {
            return Err(GateFailure::ResolutionMismatch.into());
        }
        let mut stages = self.inner.stages.lock().expect("world migration stage custody poisoned");
        if stages.contains_key(&checkpoint) { return Err(GateFailure::ResolutionMismatch.into()); }
        stages.insert(checkpoint, staged);
        Ok(())
    }
    pub(crate) fn release_stage(&self, checkpoint: &CommitId) {
        self.inner.stages.lock().expect("world migration stage custody poisoned").remove(checkpoint);
    }
    pub fn may_restore(&self) -> bool {
        matches!(*self.inner.phase.lock().expect("world migration phase poisoned"),
            PreparationPhase::Preparing | PreparationPhase::NotCommitted)
    }
}

impl Bindings {
    pub fn reserve_migration(
        &self, request: &CommitRequest, graph: &BindingGraph, heads: &[BindingHeadCas], epoch: &StateEpoch,
    ) -> Result<ReservedActivation, BindingError> {
        if request.world != graph.lock().world || epoch.world != request.world {
            return Err(BindingFailure::HeadInvalid.into());
        }
        request.clone().prepare()?;
        let channels: Vec<_> = heads.iter().map(|head| head.channel.clone()).collect();
        let mut domains: Vec<_> = graph.lock().nodes.iter().filter_map(|node| node.state.as_ref()
            .map(|state| state.writer_domain.clone())).collect();
        domains.push(epoch.writer_domain.clone());
        let publication = self.gate.begin(request.world.clone(), request.commit_id.clone(), &channels, &domains)?;
        let draining = self.gate.synchronized(|access| self.live.close_state_in(access, epoch, &request.commit_id));
        let draining = match draining {
            Ok(draining) => draining,
            Err(error) => { publication.unsubmitted(|_| Ok(()))?; return Err(error.into()); }
        };
        let restore = draining.affected_graphs();
        let preparing = Arc::new(Preparing { request: request.clone(), digest: graph.lock().digest.clone(), heads: heads.to_vec(),
            phase: Mutex::new(PreparationPhase::Preparing), publication: Mutex::new(Some(publication)),
            draining: tokio::sync::Mutex::new(Some(draining)), drained: Mutex::new(None),
            stages: Mutex::new(std::collections::BTreeMap::new()), restore });
        self.preparing.lock().expect("world migration preparations poisoned")
            .insert((request.world.clone(), request.commit_id.clone()), preparing.clone());
        Ok(ReservedActivation { inner: preparing })
    }

    fn expand_migration(&self, reservation: &ReservedActivation) -> Result<(), BindingError> {
        let mut channels = Vec::new();
        let mut domains = Vec::new();
        for (graph, mappings) in &reservation.inner.restore {
            channels.extend(mappings.iter().map(|mapping| mapping.channel.clone()));
            domains.extend(graph.lock().nodes.iter().filter_map(|node| node.state.as_ref()
                .map(|state| state.writer_domain.clone())));
        }
        reservation.inner.publication.lock().expect("world migration publication poisoned")
            .as_mut().ok_or(GateFailure::ResolutionMismatch)?.extend(&channels, &domains)?;
        Ok(())
    }

    pub async fn drain_migration(
        &self, reservation: &ReservedActivation, deadline: Instant,
    ) -> Result<Arc<DrainedState>, BindingError> {
        self.expand_migration(reservation)?;
        let mut custody = reservation.inner.draining.lock().await;
        let cached = reservation.inner.drained.lock().expect("world state drain poisoned").clone();
        let proof = if let Some(proof) = cached { proof } else {
            let draining = custody.take().ok_or(GateFailure::ResolutionMismatch)?;
            match draining.drain_until(deadline).await {
                Ok(proof) => {
                    let proof = Arc::new(proof);
                    *reservation.inner.drained.lock().expect("world state drain poisoned") = Some(proof.clone());
                    proof
                }
                Err((draining, remaining)) => {
                    *custody = Some(draining);
                    return Err(crate::extensions::lifecycle::LifecycleError::Cleanup {
                        cause: Box::new(crate::extensions::lifecycle::LifecycleError::Contract(
                            world_protocol::lifecycle::LifecycleFailure::AcquisitionClosed)), remaining_resources: remaining.iter().flat_map(crate::extensions::lifecycle::retained_resources).collect(),
                    }.into());
                }
            }
        };
        let remaining = self.live.drain_migration_tasks(&proof, deadline).await?;
        if !remaining.is_empty() {
            return Err(crate::extensions::lifecycle::LifecycleError::Cleanup {
                cause: Box::new(crate::extensions::lifecycle::LifecycleError::Contract(
                    world_protocol::lifecycle::LifecycleFailure::AcquisitionClosed)),
                remaining_resources: remaining.iter().flat_map(crate::extensions::lifecycle::retained_resources).collect(),
            }.into());
        }
        Ok(proof)
    }

    /// Freshly prepared old graphs replace closed generations only after a proved
    /// unsubmitted/rolled-back transaction. Unknown commits cannot use this path.
    pub fn restore_migration(
        &self, reservation: &ReservedActivation, restored: Vec<PreparedGraph>,
    ) -> Result<(), BindingError> {
        let mut phase = reservation.inner.phase.lock().expect("world migration phase poisoned");
        let drained = reservation.inner.drained.lock().expect("world state drain poisoned").clone();
        if !matches!(*phase, PreparationPhase::Preparing | PreparationPhase::NotCommitted)
            || drained.as_ref().is_none_or(|proof| !self.live.validate_state_drained(proof)) {
            for candidate in restored { self.reject_candidate(candidate); }
            return Err(GateFailure::RollbackUnproven.into());
        }
        let valid = restored.len() == reservation.inner.restore.len() && reservation.inner.restore.iter().all(|(graph, channels)|
            restored.iter().any(|candidate| candidate.graph().lock() == graph.lock() && candidate.channels() == channels));
        if !valid {
            for candidate in restored { self.reject_candidate(candidate); }
            return Err(BindingFailure::HeadInvalid.into());
        }
        let mut publication = reservation.inner.publication.lock().expect("world migration publication poisoned");
        let mut restored = Some(restored);
        let result = publication.as_ref().ok_or(GateFailure::ResolutionMismatch)?.unsubmitted(|access| {
            if !self.live.validate_state_drained_in(access, drained.as_ref().expect("validated state drain")) {
                return Err(GateFailure::RollbackUnproven.into());
            }
            for graph in restored.take().expect("restoration candidates retained") { self.live.publish(access, graph); }
            Ok(())
        });
        if let Err(error) = result {
            for candidate in restored.expect("unpublished restoration candidates retained") { self.reject_candidate(candidate); }
            return Err(error);
        }
        *publication = None;
        *phase = PreparationPhase::Restored;
        if reservation.inner.stages.lock().expect("world migration stage custody poisoned").is_empty() {
            self.preparing.lock().expect("world migration preparations poisoned")
                .remove(&(reservation.inner.request.world.clone(), reservation.inner.request.commit_id.clone()));
        }
        Ok(())
    }

    pub(crate) fn release_stage_checkpoint(&self, world: &WorldRef, checkpoint: &CommitId) {
        let candidates: Vec<_> = self.preparing.lock().expect("world migration preparations poisoned").iter()
            .filter(|((candidate, _), _)| candidate == world).map(|(key, preparation)| (key.clone(), preparation.clone())).collect();
        for (key, preparation) in candidates {
            let phase = preparation.phase.lock().expect("world migration phase poisoned");
            let mut stages = preparation.stages.lock().expect("world migration stage custody poisoned");
            stages.remove(checkpoint);
            if stages.is_empty() && matches!(*phase, PreparationPhase::Restored | PreparationPhase::Committed) {
                self.preparing.lock().expect("world migration preparations poisoned").remove(&key);
            }
        }
    }

    pub fn migration_reservation(&self, world: &WorldRef, commit: &CommitId) -> Result<ReservedActivation, BindingError> {
        self.preparing.lock().expect("world migration preparations poisoned").get(&(world.clone(), commit.clone()))
            .cloned().map(|inner| ReservedActivation { inner }).ok_or_else(|| GateFailure::ResolutionMismatch.into())
    }
}
