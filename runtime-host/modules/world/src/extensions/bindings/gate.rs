use std::{collections::BTreeMap, sync::{Arc, Mutex}};

use world_protocol::{
    commit::CommitReceipt,
    ids::{ActivationLockId, ChannelId, CommitId, WorldRef, WriterDomain},
};

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum Scope { Head(ChannelId), Domain(WriterDomain), Lock(ActivationLockId) }

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Phase { Publishing, Indeterminate }

struct Pending { commit_id: CommitId, phase: Phase }
type State = BTreeMap<(WorldRef, Scope), Pending>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum GateFailure {
    EmptyScope,
    Publishing { commit_id: CommitId },
    Indeterminate { commit_id: CommitId },
    ResolutionMismatch,
    RollbackUnproven,
}

/// The only graph publication/admission/Closing gate. Its closures are synchronous:
/// prepare, database waits, cleanup and drain must happen outside them.
#[derive(Clone, Default)]
pub(crate) struct PublicationGate { state: Arc<Mutex<State>> }

pub(crate) struct GateAccess<'a> { state: &'a State, identity: &'a Arc<Mutex<State>> }

/// Dropping a reservation never reopens its scopes. Recovery uses the original
/// CommitId; a missing receipt is not evidence of rollback.
#[must_use = "resolve publication explicitly; dropping it leaves admission closed"]
pub(crate) struct Publication {
    gate: PublicationGate,
    world: WorldRef,
    commit_id: CommitId,
    scopes: Vec<Scope>,
}

impl PublicationGate {
    pub fn new() -> Self { Self::default() }

    pub fn synchronized<T>(&self, action: impl FnOnce(&GateAccess<'_>) -> T) -> T {
        let state = self.state.lock().expect("world publication gate poisoned");
        action(&GateAccess { state: &state, identity: &self.state })
    }

    pub fn with_open<T>(
        &self, world: &WorldRef, heads: &[ChannelId], domains: &[WriterDomain],
        action: impl FnOnce() -> T,
    ) -> Result<T, GateFailure> {
        self.synchronized(|access| {
            access.require_open(world, heads, domains)?;
            Ok(action())
        })
    }

    pub fn begin(
        &self, world: WorldRef, commit_id: CommitId,
        heads: &[ChannelId], domains: &[WriterDomain],
    ) -> Result<Publication, GateFailure> {
        if heads.is_empty() && domains.is_empty() { return Err(GateFailure::EmptyScope) }
        let scopes = heads.iter().cloned().map(Scope::Head)
            .chain(domains.iter().cloned().map(Scope::Domain)).collect();
        self.reserve(world, commit_id, scopes, |_| Ok(()))
    }

    pub fn begin_retirement(
        &self, world: WorldRef, commit_id: CommitId, lock: ActivationLockId,
        preflight: impl FnOnce(&GateAccess<'_>) -> Result<(), super::BindingError>,
    ) -> Result<Publication, super::BindingError> {
        self.reserve(world, commit_id, vec![Scope::Lock(lock)], preflight)
    }

    fn reserve<E: From<GateFailure>>(
        &self, world: WorldRef, commit_id: CommitId, mut scopes: Vec<Scope>,
        preflight: impl FnOnce(&GateAccess<'_>) -> Result<(), E>,
    ) -> Result<Publication, E> {
        let mut state = self.state.lock().expect("world publication gate poisoned");
        let access = GateAccess { state: &state, identity: &self.state };
        for scope in &scopes { access.check(&world, scope)?; }
        preflight(&access)?;
        if state.iter().any(|((pending_world, _), pending)| {
            pending_world == &world && pending.commit_id == commit_id
        }) { return Err(GateFailure::ResolutionMismatch.into()) }
        scopes.sort_unstable();
        scopes.dedup();
        for scope in &scopes {
            state.insert((world.clone(), scope.clone()), Pending {
                commit_id: commit_id.clone(), phase: Phase::Publishing,
            });
        }
        Ok(Publication { gate: self.clone(), world, commit_id, scopes })
    }

    /// Only an authoritative receipt for this exact commit can publish and reopen.
    pub fn recover_committed<T>(
        &self, receipt: &CommitReceipt,
        publish: impl FnOnce(&GateAccess<'_>) -> Result<T, super::BindingError>,
    ) -> Result<T, super::BindingError> {
        let mut state = self.state.lock().expect("world publication gate poisoned");
        if !state.iter().any(|((world, _), pending)| {
            world == &receipt.world && pending.commit_id == receipt.commit_id
        }) { return Err(GateFailure::ResolutionMismatch.into()) }
        let result = publish(&GateAccess { state: &state, identity: &self.state })?;
        state.retain(|(world, _), pending| world != &receipt.world || pending.commit_id != receipt.commit_id);
        Ok(result)
    }
}

impl GateAccess<'_> {
    pub fn belongs_to(&self, gate: &PublicationGate) -> bool { Arc::ptr_eq(self.identity, &gate.state) }

    /// Select the snapshot and check its entire exact closure under this same gate,
    /// then register all resources as one batch before returning from the closure.
    pub fn require_open(
        &self, world: &WorldRef, heads: &[ChannelId], domains: &[WriterDomain],
    ) -> Result<(), GateFailure> {
        for scope in heads.iter().cloned().map(Scope::Head)
            .chain(domains.iter().cloned().map(Scope::Domain)) {
            self.check(world, &scope)?;
        }
        Ok(())
    }

    pub fn require_reserved(
        &self, world: &WorldRef, commit: &CommitId, heads: &[ChannelId], domains: &[WriterDomain],
    ) -> Result<(), GateFailure> {
        for scope in heads.iter().cloned().map(Scope::Head).chain(domains.iter().cloned().map(Scope::Domain)) {
            if !self.state.get(&(world.clone(), scope)).is_some_and(|pending| &pending.commit_id == commit) {
                return Err(GateFailure::ResolutionMismatch);
            }
        }
        Ok(())
    }

    pub fn require_lock_open(&self, world: &WorldRef, lock: &ActivationLockId) -> Result<(), GateFailure> {
        self.check(world, &Scope::Lock(lock.clone()))
    }

    fn check(&self, world: &WorldRef, scope: &Scope) -> Result<(), GateFailure> {
        match self.state.get(&(world.clone(), scope.clone())) {
            Some(Pending { commit_id, phase: Phase::Publishing }) =>
                Err(GateFailure::Publishing { commit_id: commit_id.clone() }),
            Some(Pending { commit_id, phase: Phase::Indeterminate }) =>
                Err(GateFailure::Indeterminate { commit_id: commit_id.clone() }),
            None => Ok(()),
        }
    }
}

impl Publication {
    pub fn commit_id(&self) -> &CommitId { &self.commit_id }

    pub fn extend(&mut self, heads: &[ChannelId], domains: &[WriterDomain]) -> Result<(), GateFailure> {
        let mut state = self.gate.state.lock().expect("world publication gate poisoned");
        self.check(&state)?;
        let scopes: Vec<_> = heads.iter().cloned().map(Scope::Head)
            .chain(domains.iter().cloned().map(Scope::Domain)).collect();
        for scope in &scopes {
            if !self.scopes.contains(scope) { GateAccess { state: &state, identity: &self.gate.state }.check(&self.world, scope)?; }
        }
        for scope in scopes {
            if !self.scopes.contains(&scope) {
                state.insert((self.world.clone(), scope.clone()), Pending { commit_id: self.commit_id.clone(), phase: Phase::Publishing });
                self.scopes.push(scope);
            }
        }
        Ok(())
    }

    /// The preparation owner has not submitted this identity to Store. Its private
    /// phase check precedes this call; a failed restoration never opens admission.
    pub(super) fn unsubmitted<T>(
        &self, restore: impl FnOnce(&GateAccess<'_>) -> Result<T, super::BindingError>,
    ) -> Result<T, super::BindingError> {
        let mut state = self.gate.state.lock().expect("world publication gate poisoned");
        self.check(&state)?;
        let result = restore(&GateAccess { state: &state, identity: &self.gate.state })?;
        self.remove(&mut state);
        Ok(result)
    }

    pub fn mark_indeterminate(&self) -> Result<(), GateFailure> {
        let mut state = self.gate.state.lock().expect("world publication gate poisoned");
        self.check(&state)?;
        for scope in &self.scopes {
            state.get_mut(&(self.world.clone(), scope.clone())).expect("checked reservation").phase = Phase::Indeterminate;
        }
        Ok(())
    }

    pub fn committed<T>(
        &self, receipt: &CommitReceipt,
        publish: impl FnOnce(&GateAccess<'_>) -> Result<T, super::BindingError>,
    ) -> Result<T, super::BindingError> {
        if receipt.world != self.world || receipt.commit_id != self.commit_id {
            return Err(GateFailure::ResolutionMismatch.into());
        }
        let mut state = self.gate.state.lock().expect("world publication gate poisoned");
        self.check(&state)?;
        let result = publish(&GateAccess { state: &state, identity: &self.gate.state })?;
        self.remove(&mut state);
        Ok(result)
    }

    /// Only Store's proof that this original identity never committed may reopen
    /// admission. A timeout, cancelled future or absent receipt is not such proof.
    pub fn not_committed<E, T>(
        &self, proof: &crate::store::TransactionError<E>, rollback: impl FnOnce(&GateAccess<'_>) -> T,
    ) -> Result<T, GateFailure> {
        if !matches!(proof, crate::store::TransactionError::NotCommitted { .. }) {
            return Err(GateFailure::RollbackUnproven);
        }
        let mut state = self.gate.state.lock().expect("world publication gate poisoned");
        self.check(&state)?;
        let result = rollback(&GateAccess { state: &state, identity: &self.gate.state });
        self.remove(&mut state);
        Ok(result)
    }

    fn check(&self, state: &State) -> Result<(), GateFailure> {
        if self.scopes.iter().all(|scope| state.get(&(self.world.clone(), scope.clone()))
            .is_some_and(|pending| pending.commit_id == self.commit_id)) { Ok(()) }
        else { Err(GateFailure::ResolutionMismatch) }
    }

    fn remove(&self, state: &mut State) {
        for scope in &self.scopes { state.remove(&(self.world.clone(), scope.clone())); }
    }
}
