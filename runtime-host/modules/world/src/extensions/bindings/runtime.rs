use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

use world_protocol::{
    bindings::{BindingFailure, BindingHead, BindingHeadCas},
    commit::CommitReceipt,
    ids::{ChannelId, CommitId, EventId, InvocationId, NodeId, WorldRef, WriterDomain},
    operation::OperationAccepted,
    time::Timestamp,
};

use super::{
    BindingError, GateFailure, Publication, PublicationGate, activate::commit_activation, durable,
};
use crate::{
    authorization::Admission,
    extensions::{
        invocation::{InvocationLease, LeaseFailure},
        lifecycle::{LiveExtensions, PreparedGraph},
    },
    store::{CommitRequest, TransactionError, WorldStore},
};

pub(crate) struct ActivationContext {
    pub request: CommitRequest,
    pub admission: Admission,
    pub operation: OperationAccepted,
    pub heads: Vec<BindingHeadCas>,
    pub namespaces: Vec<crate::extensions::migration::PreparedNamespace>,
    pub migrations: Vec<crate::extensions::migration::PreparedMigration>,
    pub install_revision: Option<world_protocol::api::InstallCommand>,
    pub reservation: Option<super::ReservedActivation>,
    pub source_lock: Option<world_protocol::ids::ActivationLockId>,
    pub event_id: EventId,
}

pub(crate) struct ActivationCommitted {
    pub heads: Vec<BindingHead>,
    pub receipt: CommitReceipt,
}

struct Pending {
    context: Arc<ActivationContext>,
    graph: Arc<super::BindingGraph>,
    channels: Vec<world_protocol::bindings::BindingChannel>,
    configs: Vec<world_protocol::api::PackageConfigView>,
    prepared: Mutex<Option<PreparedGraph>>,
    publication: Mutex<Option<Publication>>,
}

#[derive(Debug)]
pub(crate) enum AcquireFailure {
    MissingHead(ChannelId),
    Gate(GateFailure),
    Lease(LeaseFailure),
}

/// Owns selection heads, not execution endpoints. LiveExtensions owns endpoint
/// custody. Both use this single gate for publication and whole-graph admission.
pub(crate) struct Bindings {
    pub(super) store: WorldStore,
    pub(super) live: Arc<LiveExtensions>,
    pub(super) gate: PublicationGate,
    pub(super) heads: Arc<Mutex<BTreeMap<(WorldRef, ChannelId), BindingHead>>>,
    pending: Mutex<BTreeMap<(WorldRef, CommitId), Arc<Pending>>>,
    pub(super) preparing:
        Mutex<BTreeMap<(WorldRef, CommitId), Arc<super::migration_runtime::Preparing>>>,
    failed_candidates: Mutex<Vec<Arc<PreparedGraph>>>,
    pub(super) retirements:
        Mutex<BTreeMap<(WorldRef, CommitId), Arc<super::retirement_runtime::Pending>>>,
    pub(super) retired: Mutex<
        BTreeMap<
            (WorldRef, world_protocol::ids::ActivationLockId),
            Arc<super::CommittedRetirement>,
        >,
    >,
    pub(super) drained: Mutex<
        BTreeMap<
            (WorldRef, world_protocol::ids::ActivationLockId),
            Arc<crate::extensions::lifecycle::DrainedGraph>,
        >,
    >,
}

impl Bindings {
    pub fn new(store: WorldStore, live: Arc<LiveExtensions>) -> Self {
        Self {
            store,
            gate: live.gate().clone(),
            live,
            heads: Arc::new(Mutex::new(BTreeMap::new())),
            pending: Mutex::new(BTreeMap::new()),
            preparing: Mutex::new(BTreeMap::new()),
            failed_candidates: Mutex::new(Vec::new()),
            retirements: Mutex::new(BTreeMap::new()),
            retired: Mutex::new(BTreeMap::new()),
            drained: Mutex::new(BTreeMap::new()),
        }
    }

    /// New runs read one selection point and register their whole exact closure
    /// before releasing this gate. Child calls use their InvocationLease only.
    pub fn acquire_current(
        &self,
        world: &WorldRef,
        channel: &ChannelId,
        root: &NodeId,
        invocation: InvocationId,
        at: Timestamp,
    ) -> Result<InvocationLease, AcquireFailure> {
        self.gate.synchronized(|access| {
            access
                .require_open(world, std::slice::from_ref(channel), &[])
                .map_err(AcquireFailure::Gate)?;
            let heads = self.heads.lock().expect("world binding heads poisoned");
            let head = heads
                .get(&(world.clone(), channel.clone()))
                .ok_or_else(|| AcquireFailure::MissingHead(channel.clone()))?;
            self.live
                .acquire_in(
                    access,
                    world,
                    &head.activation_lock_id,
                    root,
                    invocation,
                    at,
                )
                .map_err(AcquireFailure::Lease)
        })
    }

    pub async fn activate(
        &self,
        context: ActivationContext,
        prepared: PreparedGraph,
    ) -> Result<ActivationCommitted, BindingError> {
        let context = Arc::new(context);
        let key = (
            context.request.world.clone(),
            context.request.commit_id.clone(),
        );
        let result = self.activate_prepared(context.clone(), prepared).await;
        if result.is_err()
            && !self
                .pending
                .lock()
                .expect("world binding pending publications poisoned")
                .contains_key(&key)
        {
            if let Err(cleanup) = discard_migrations(&context) {
                return Err(
                    crate::owner::Error::from(result.err().expect("failed activation"))
                        .with_related(cleanup)
                        .into(),
                );
            }
        }
        result
    }

    async fn activate_prepared(
        &self,
        context: Arc<ActivationContext>,
        prepared: PreparedGraph,
    ) -> Result<ActivationCommitted, BindingError> {
        if let Err(error) =
            durable::validate_heads(prepared.graph(), &context.heads, prepared.channels())
        {
            self.reject_candidate(prepared);
            return Err(error);
        }
        if context.request.world != prepared.graph().lock().world
            || context.operation.world != context.request.world
        {
            self.reject_candidate(prepared);
            return Err(BindingFailure::HeadInvalid.into());
        }
        let mut namespaces = std::collections::BTreeSet::new();
        for namespace in &context.namespaces {
            if !namespaces.insert(namespace.binding().namespace.clone())
                || !prepared.graph().lock().nodes.iter().any(|node| {
                    node.state.as_ref() == Some(namespace.binding())
                        && &node.implementation == namespace.implementation()
                })
            {
                self.reject_candidate(prepared);
                return Err(BindingFailure::HeadInvalid.into());
            }
        }
        let mut migrations = std::collections::BTreeSet::new();
        for migration in &context.migrations {
            if !migrations.insert(migration.binding().namespace.clone())
                || namespaces.contains(&migration.binding().namespace)
                || migration.commit_id() != &context.request.commit_id
                || migration.expected().world != context.request.world
                || !prepared
                    .graph()
                    .lock()
                    .nodes
                    .iter()
                    .any(|node| node.state.as_ref() == Some(migration.binding()))
            {
                self.reject_candidate(prepared);
                return Err(BindingFailure::HeadInvalid.into());
            }
        }
        if context.migrations.is_empty() != context.reservation.is_none() {
            self.reject_candidate(prepared);
            return Err(GateFailure::ResolutionMismatch.into());
        }
        let domains = prepared
            .graph()
            .lock()
            .nodes
            .iter()
            .filter_map(|node| node.state.as_ref().map(|state| state.writer_domain.clone()))
            .collect::<std::collections::BTreeSet<_>>();
        for node in &prepared.graph().lock().nodes {
            if let Some(state) = &node.state {
                let initializes = context.namespaces.iter().any(|namespace| {
                    namespace.initializes()
                        && namespace.binding() == state
                        && namespace.implementation() == &node.implementation
                });
                let epoch = context
                    .migrations
                    .iter()
                    .find(|migration| migration.binding() == state)
                    .map_or(state.writer_epoch, |migration| {
                        migration.expected().writer_epoch
                    });
                if !initializes
                    && !context.request.fences.iter().any(|fence| {
                        fence.domain == state.writer_domain
                            && fence.epoch == epoch
                            && fence.world == context.request.world
                    })
                {
                    let failure = BindingFailure::StateConflict {
                        node_id: node.id.clone(),
                    };
                    self.reject_candidate(prepared);
                    return Err(failure.into());
                }
            }
        }
        let exclusive: Vec<_> = context
            .migrations
            .iter()
            .map(|migration| migration.expected().writer_domain.clone())
            .collect();
        let batch = match context
            .request
            .clone()
            .prepare()
            .and_then(|batch| batch.exclusive_fences(&exclusive))
        {
            Ok(batch) => batch,
            Err(error) => {
                self.reject_candidate(prepared);
                return Err(error.into());
            }
        };
        let heads: Vec<_> = context
            .heads
            .iter()
            .map(|head| head.channel.clone())
            .collect();
        let domains: Vec<WriterDomain> = domains.into_iter().collect();
        let publication = if let Some(reservation) = &context.reservation {
            let mut phase = reservation
                .inner
                .phase
                .lock()
                .expect("world migration phase poisoned");
            if *phase != super::migration_runtime::PreparationPhase::Preparing
                || reservation.inner.request.world != context.request.world
                || reservation.inner.request.commit_id != context.request.commit_id
                || reservation.inner.request.input_digest != context.request.input_digest
                || reservation.inner.digest != prepared.graph().lock().digest
                || reservation.inner.heads != context.heads
            {
                self.reject_candidate(prepared);
                return Err(GateFailure::ResolutionMismatch.into());
            }
            let publication = reservation
                .inner
                .publication
                .lock()
                .expect("world migration publication poisoned")
                .take()
                .ok_or(GateFailure::ResolutionMismatch)?;
            *phase = super::migration_runtime::PreparationPhase::Submitted;
            publication
        } else {
            match self.gate.begin(
                context.request.world.clone(),
                context.request.commit_id.clone(),
                &heads,
                &domains,
            ) {
                Ok(publication) => publication,
                Err(error) => {
                    self.reject_candidate(prepared);
                    return Err(error.into());
                }
            }
        };
        let pending = Arc::new(Pending {
            graph: prepared.graph().clone(),
            channels: prepared.channels().to_vec(),
            configs: prepared.configs().to_vec(),
            context,
            prepared: Mutex::new(Some(prepared)),
            publication: Mutex::new(Some(publication)),
        });
        let key = (
            pending.context.request.world.clone(),
            pending.context.request.commit_id.clone(),
        );
        self.pending
            .lock()
            .expect("world binding pending publications poisoned")
            .insert(key.clone(), pending.clone());
        let mutation = pending.clone();
        let outcome = self
            .store
            .transact(batch, move |tx| {
                Box::pin(async move {
                    commit_activation(
                        tx,
                        &mutation.graph,
                        &mutation.context.heads,
                        &mutation.channels,
                        &mutation.configs,
                        &mutation.context.namespaces,
                        &mutation.context.migrations,
                        mutation.context.install_revision.as_ref(),
                        mutation.context.source_lock.as_ref(),
                        &mutation.context.admission,
                        &mutation.context.operation,
                        mutation.context.event_id.clone(),
                    )
                    .await
                })
            })
            .await;
        match outcome {
            Ok(committed) => {
                self.publish_committed(&key, &pending, committed.value, committed.receipt)
            }
            Err(error @ TransactionError::NotCommitted { .. }) => {
                let publication = pending
                    .publication
                    .lock()
                    .expect("world publication capability poisoned")
                    .take()
                    .ok_or(GateFailure::ResolutionMismatch)?;
                let retire = |access: &super::GateAccess<'_>| {
                    if let Some(prepared) = pending
                        .prepared
                        .lock()
                        .expect("world prepared graph poisoned")
                        .take()
                    {
                        self.live.retire_candidate(access, &prepared);
                        self.failed_candidates
                            .lock()
                            .expect("world failed candidates poisoned")
                            .push(Arc::new(prepared));
                    }
                };
                if let Some(reservation) = &pending.context.reservation {
                    self.gate.synchronized(retire);
                    *reservation
                        .inner
                        .publication
                        .lock()
                        .expect("world migration publication poisoned") = Some(publication);
                    *reservation
                        .inner
                        .phase
                        .lock()
                        .expect("world migration phase poisoned") =
                        super::migration_runtime::PreparationPhase::NotCommitted;
                } else if let Err(failure) = publication.not_committed(&error, retire) {
                    *pending
                        .publication
                        .lock()
                        .expect("world publication capability poisoned") = Some(publication);
                    return Err(failure.into());
                }
                self.pending
                    .lock()
                    .expect("world binding pending publications poisoned")
                    .remove(&key);
                match error {
                    TransactionError::NotCommitted {
                        error,
                        cleanup: None,
                    } => Err(error),
                    TransactionError::NotCommitted {
                        error,
                        cleanup: Some(cleanup),
                    } => Err(BindingError::Cleanup {
                        failure: Box::new(error),
                        cleanup,
                    }),
                    _ => unreachable!(),
                }
            }
            Err(TransactionError::Indeterminate(error)) => {
                if let Some(publication) = pending
                    .publication
                    .lock()
                    .expect("world publication capability poisoned")
                    .as_ref()
                {
                    publication.mark_indeterminate()?;
                }
                Err(error.into())
            }
        }
    }

    /// No retry of activate, new CommitId or optimistic rollback occurs here.
    /// Store's authoritative primary read keeps NotFound explicitly indeterminate.
    pub async fn recover_commit(
        &self,
        world: &WorldRef,
        commit_id: &CommitId,
    ) -> Result<ActivationCommitted, BindingError> {
        let key = (world.clone(), commit_id.clone());
        let pending = self
            .pending
            .lock()
            .expect("world binding pending publications poisoned")
            .get(&key)
            .cloned()
            .ok_or(GateFailure::ResolutionMismatch)?;
        let committed = self
            .store
            .read_commit::<Vec<BindingHead>>(
                world,
                commit_id,
                &pending.context.request.input_digest,
            )
            .await
            .map_err(|error| BindingError::from(error).commit_unresolved(commit_id))?;
        self.publish_committed(&key, &pending, committed.value, committed.receipt)
    }

    /// After a process restart, S13 re-prepares the exact graph loaded from the
    /// durable head. It is never reconstructed from the formerly running instance.
    pub fn restore_heads(
        &self,
        heads: Vec<BindingHead>,
        prepared: PreparedGraph,
    ) -> Result<(), BindingError> {
        let changes: Vec<_> = heads
            .iter()
            .map(|head| BindingHeadCas {
                world: head.world.clone(),
                channel: head.channel.clone(),
                expected: None,
                replacement: head.activation_lock_id.clone(),
            })
            .collect();
        if let Err(error) = durable::validate_heads(prepared.graph(), &changes, prepared.channels())
        {
            self.reject_candidate(prepared);
            return Err(error);
        }
        if heads.iter().any(|head| {
            head.generation.0 == 0
                || head.generation.0 > i64::MAX as u64
                || head.revision.0 == 0
                || head.revision.0 > i64::MAX as u64
        }) {
            self.reject_candidate(prepared);
            return Err(BindingFailure::HeadInvalid.into());
        }
        let world = prepared.graph().lock().world.clone();
        let channels: Vec<_> = heads.iter().map(|head| head.channel.clone()).collect();
        let domains: Vec<_> = prepared
            .graph()
            .lock()
            .nodes
            .iter()
            .filter_map(|node| node.state.as_ref().map(|state| state.writer_domain.clone()))
            .collect();
        let mut candidate = Some(prepared);
        let result = self.gate.synchronized(|access| {
            access.require_open(&world, &channels, &domains)?;
            let mut snapshot = self.heads.lock().expect("world binding heads poisoned");
            for head in &heads {
                if let Some(current) = snapshot.get(&(world.clone(), head.channel.clone())) {
                    if current != head {
                        return Err(BindingFailure::HeadConflict {
                            expected: head.generation,
                            actual: current.generation,
                        }
                        .into());
                    }
                }
            }
            self.live.publish(
                access,
                candidate.take().expect("restoration candidate retained"),
            );
            for head in heads {
                snapshot.insert((world.clone(), head.channel.clone()), head);
            }
            Ok::<_, BindingError>(())
        });
        if let Some(prepared) = candidate {
            self.reject_candidate(prepared);
        }
        result
    }

    pub async fn drain_failed_until(
        &self,
        deadline: tokio::time::Instant,
    ) -> Vec<crate::extensions::invocation::LedgerSnapshot> {
        self.drain_failed_in(None, deadline).await
    }

    pub(crate) async fn drain_failed_world_until(
        &self,
        world: &WorldRef,
        deadline: tokio::time::Instant,
    ) -> Vec<crate::extensions::invocation::LedgerSnapshot> {
        self.drain_failed_in(Some(world), deadline).await
    }

    async fn drain_failed_in(
        &self,
        world: Option<&WorldRef>,
        deadline: tokio::time::Instant,
    ) -> Vec<crate::extensions::invocation::LedgerSnapshot> {
        let candidates: Vec<_> = self
            .failed_candidates
            .lock()
            .expect("world failed candidates poisoned")
            .iter()
            .filter(|candidate| world.is_none_or(|world| &candidate.graph().lock().world == world))
            .cloned()
            .collect();
        let mut remaining = match world {
            Some(world) => self.live.drain_failed_world_until(world, deadline).await,
            None => self.live.drain_failed_until(deadline).await,
        };
        for candidate in candidates {
            let retained = self.live.drain_candidate(&candidate, deadline).await;
            if retained.is_empty() {
                self.failed_candidates
                    .lock()
                    .expect("world failed candidates poisoned")
                    .retain(|failed| !Arc::ptr_eq(failed, &candidate));
            } else {
                remaining.extend(retained);
            }
        }
        remaining
    }

    pub(crate) fn reject_candidate(&self, prepared: PreparedGraph) {
        self.gate
            .synchronized(|access| self.live.retire_candidate(access, &prepared));
        self.failed_candidates
            .lock()
            .expect("world failed candidates poisoned")
            .push(Arc::new(prepared));
    }

    fn publish_committed(
        &self,
        key: &(WorldRef, CommitId),
        pending: &Pending,
        heads: Vec<BindingHead>,
        receipt: CommitReceipt,
    ) -> Result<ActivationCommitted, BindingError> {
        let result = (|| {
            let mut seen = std::collections::BTreeSet::new();
            if receipt.world != pending.context.request.world
                || receipt.commit_id != pending.context.request.commit_id
                || heads.len() != pending.context.heads.len()
                || heads.iter().any(|head| {
                    let Some(expected) = pending
                        .context
                        .heads
                        .iter()
                        .find(|expected| expected.channel == head.channel)
                    else {
                        return true;
                    };
                    head.world != pending.graph.lock().world
                        || head.activation_lock_id != pending.graph.lock().id
                        || !seen.insert(head.channel.clone())
                        || Some(head.generation.0)
                            != expected
                                .expected
                                .as_ref()
                                .map_or(0, |head| head.generation.0)
                                .checked_add(1)
                        || Some(head.revision.0)
                            != expected
                                .expected
                                .as_ref()
                                .map_or(0, |head| head.revision.0)
                                .checked_add(1)
                        || !receipt.revisions.iter().any(|revision| {
                            revision.resource
                                == world_protocol::ids::ResourceRef::Head {
                                    channel: head.channel.clone(),
                                }
                                && revision.revision == head.revision
                        })
                })
            {
                return Err(BindingFailure::HeadInvalid.into());
            }
            discard_migrations(&pending.context)?;
            self.gate.recover_committed(&receipt, |access| {
                let prepared = pending
                    .prepared
                    .lock()
                    .expect("world prepared graph poisoned")
                    .take()
                    .expect("committed candidate retained until publication");
                self.live.publish(access, prepared);
                let mut snapshot = self.heads.lock().expect("world binding heads poisoned");
                for head in &heads {
                    snapshot.insert((head.world.clone(), head.channel.clone()), head.clone());
                }
                Ok(())
            })?;
            if let Some(reservation) = &pending.context.reservation {
                *reservation
                    .inner
                    .phase
                    .lock()
                    .expect("world migration phase poisoned") =
                    super::migration_runtime::PreparationPhase::Committed;
                if reservation
                    .inner
                    .stages
                    .lock()
                    .expect("world migration stage custody poisoned")
                    .is_empty()
                {
                    self.preparing
                        .lock()
                        .expect("world migration preparations poisoned")
                        .remove(key);
                }
            }
            self.pending
                .lock()
                .expect("world binding pending publications poisoned")
                .remove(key);
            Ok(ActivationCommitted { heads, receipt })
        })();
        result.map_err(|error: BindingError| {
            error.commit_unresolved(&pending.context.request.commit_id)
        })
    }
}

fn discard_migrations(context: &ActivationContext) -> Result<(), crate::owner::Error> {
    let mut failure: Option<crate::owner::Error> = None;
    for migration in &context.migrations {
        if let Err(error) = migration.discard_prepared() {
            failure = Some(match failure {
                Some(primary) => primary.with_related(error),
                None => error,
            });
        }
    }
    match failure {
        Some(error) => Err(error),
        None => Ok(()),
    }
}
