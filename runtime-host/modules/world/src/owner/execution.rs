use std::sync::Arc;

mod source_identity;
pub(super) use source_identity::step_retention_roots as source_identity_retention_roots;

use serde::{Serialize, de::DeserializeOwned};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use world_protocol::{failure::FailureStage, ids::*, operation::OperationAccepted};

use crate::{
    authorization::{self, Admission},
    extensions::{
        host_calls::HostCallServices,
        invocation::{CompositionFailure, CompositionOutcome, CurrentFailure, InvocationContext, InvocationFailure, InvocationLease, InvocationServices, invoke_composition},
        migration::StateLimits,
    },
    generation::BoundGeneration,
    sources::connectors::SourceBroker,
    store::{CommitRequest, Committed, StoreFuture, WorldStore, WorldTransaction},
};
use super::{Error, OperationRecord, RunRecord, head, ledger, resources::Resources, run};

/// Current owner execution facts, not a guest-constructible invocation or plugin lease.
#[derive(Clone)]
pub(crate) struct ExecutionContext {
    pub owner: super::WorldHandle,
    pub store: WorldStore,
    pub resources: Arc<Resources>,
    pub admission: Admission,
    pub authority: Arc<crate::authorization::AuthorityRoot>,
    pub operation: OperationAccepted,
    pub run: RunRecord,
    pub cancellation: CancellationToken,
    pub deadline: Instant,
    pub pipeline: foundation::pipeline::PipelineContext,
    pub budget: crate::extensions::invocation::CallBudget,
    pub source_access: Result<Arc<dyn crate::sources::connectors::SourceAccess>, Arc<crate::sources::connectors::SourceError>>,
    pub locator: Arc<dyn crate::store::WorldLocator>,
    pub target: Arc<dyn crate::extensions::migration::StorageTarget>,
}

pub(crate) fn execution_commit_id(world: &WorldRef, operation: &OperationId, run: &RunId, key: &str) -> Result<CommitId, Error> {
    let identity = crate::definitions::canonical_digest(&(world, operation, run, key))?;
    CommitId::try_new(format!("owner-{}", &identity.as_str()[7..]))
        .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))
}

impl ExecutionContext {
    pub(crate) fn maintenance_context(&self) -> MaintenanceContext {
        MaintenanceContext { store: self.store.clone(), resources: self.resources.clone(),
            admission: self.admission.clone(), deadline: self.deadline,
            budget: self.budget.clone(), cancellation: self.cancellation.clone() }
    }

    pub(crate) fn commit_id(&self, key: &str) -> Result<CommitId, Error> {
        execution_commit_id(&self.operation.world, &self.operation.operation_id, &self.run.id, key)
    }

    pub(crate) async fn commit_request(&self, key: &str, input_digest: Digest, domains: &[&str]) -> Result<CommitRequest, Error> {
        let mut domains = domains.to_vec();
        if !domains.contains(&"operation") { domains.push("operation"); }
        prepare_request(&self.store, &self.operation.world, self.commit_id(key)?, input_digest, &domains).await
    }

    pub(crate) fn evaluation_authority(&self) -> Result<&crate::authorization::EvaluationAuthority, Error> {
        self.resources.authorities.evaluation.get().ok_or_else(|| Error::new(
            "world.evaluation_not_configured", FailureStage::Prepare, "当前世界未配置评测执行身份。",
            world_protocol::api::ApiFailure::NotConfigured, world_protocol::failure::Recovery::None,
        ))
    }

    fn services(
        &self, lease: &Arc<InvocationLease>, generation: Option<Arc<dyn BoundGeneration>>,
        source_versions: Vec<world_protocol::materials::SourceVersionRef>,
    ) -> Result<InvocationServices, InvocationFailure> {
        if self.run.activation_lock_id.as_ref() != Some(&lease.graph().lock().id)
            || self.operation.world != lease.graph().lock().world
            || self.admission.invocation().id != *lease.invocation()
        {
            return Err(InvocationFailure::Binding(world_protocol::bindings::BindingFailure::LockIdentityConflict));
        }
        self.invocation_service_seed().for_lease(lease, generation, source_versions)
    }

    pub(crate) fn invocation_service_seed(&self) -> InvocationServiceSeed {
        InvocationServiceSeed::for_resources(&self.store, &self.resources, self.source_access.clone())
    }

    pub(crate) fn invocation_services(
        &self, lease: &Arc<InvocationLease>, generation: Option<Arc<dyn BoundGeneration>>,
        source_versions: Vec<world_protocol::materials::SourceVersionRef>,
    ) -> Result<InvocationServices, Error> {
        self.services(lease, generation, source_versions)
            .map_err(|error| Error::from_host_failure(error.host_failure(), FailureStage::Prepare).caused(error))
    }

    pub(crate) async fn invoke(
        &self, node: NodeId, request: world_protocol::slots::SlotRequest,
        generation: Option<Arc<dyn BoundGeneration>>, source_versions: Vec<world_protocol::materials::SourceVersionRef>,
    ) -> Result<CompositionOutcome, CompositionFailure> {
        self.with_invocation(node, generation, source_versions, move |context, services| {
            invoke_composition(context, request, services)
        }).await
    }

    pub(crate) async fn with_invocation<T, E, F, Fut>(
        &self, node: NodeId, generation: Option<Arc<dyn BoundGeneration>>,
        source_versions: Vec<world_protocol::materials::SourceVersionRef>, action: F,
    ) -> Result<T, E>
    where
        E: From<CompositionFailure>,
        F: FnOnce(InvocationContext, InvocationServices) -> Fut,
        Fut: std::future::Future<Output = Result<T, E>>,
    {
        let lock = self.run.activation_lock_id.as_ref().ok_or_else(|| E::from(CompositionFailure::Invocation(
            InvocationFailure::Binding(world_protocol::bindings::BindingFailure::HeadInvalid),
        )))?;
        let admission = self.admission.clone();
        let now = self.store.snapshot(self.operation.world.clone(), move |snapshot| Box::pin(async move {
            let now = snapshot.now().await?;
            authorization::recheck_read(snapshot, &admission, &now).await?;
            Ok::<_, CurrentFailure>(now)
        })).await.map_err(|error| E::from(CompositionFailure::Invocation(InvocationFailure::Current(error))))?;
        let lease = Arc::new(self.resources.live.acquire(&self.operation.world, lock, &node,
            self.admission.invocation().id.clone(), now)
            .map_err(|error| E::from(CompositionFailure::Invocation(InvocationFailure::Lease(error))))?);
        let result = async {
            let context = InvocationContext::new(Arc::new(self.store.clone()), self.admission.clone(), lease.clone(),
                node, self.pipeline.clone(), self.budget.clone())
                .map_err(|error| E::from(CompositionFailure::Invocation(InvocationFailure::Current(error))))?;
            let services = self.services(&lease, generation, source_versions)
                .map_err(|error| E::from(CompositionFailure::Invocation(error)))?;
            action(context, services).await
        }.await;
        lease.finish();
        result
    }

    pub(crate) async fn prepare_batch(&self, key: &str, input_digest: Digest, domains: &[&str]) -> Result<crate::store::PreparedBatch, Error> {
        self.commit_request(key, input_digest, domains).await?.prepare().map_err(Error::from)
    }

    pub(crate) async fn transact<T, F>(
        &self, key: &str, input_digest: Digest, domains: &[&str], action: F,
    ) -> Result<Committed<T>, Error>
    where
        T: Serialize + DeserializeOwned + Send,
        F: for<'a> FnOnce(&'a mut WorldTransaction<'_>, Admission, OperationRecord, RunRecord) -> StoreFuture<'a, T, Error> + Send + 'static,
    {
        let request = self.commit_request(key, input_digest, domains).await?;
        let committed = self.transact_outcome(request, action).await.map_err(Error::from)?;
        self.recheck_replay(&committed).await?;
        Ok(committed)
    }

    pub(crate) async fn transact_investigation<T, F>(
        &self, key: &str, input_digest: Digest, domains: &[&str], action: F,
    ) -> Result<(Committed<T>, Option<Arc<authorization::InvestigationBinding>>), Error>
    where
        T: Serialize + DeserializeOwned + Send,
        F: for<'a> FnOnce(&'a mut WorldTransaction<'_>, Admission, OperationRecord, RunRecord)
            -> StoreFuture<'a, (T, authorization::InvestigationBinding), Error> + Send + 'static,
    {
        let handoff = Arc::new(std::sync::Mutex::new(None));
        let prepared = handoff.clone();
        let committed = self.transact(key, input_digest, domains, move |tx, admission, operation, run| Box::pin(async move {
            let (value, binding) = action(tx, admission, operation, run).await?;
            *prepared.lock().expect("investigation handoff poisoned") = Some(binding);
            Ok(value)
        })).await?;
        if committed.replayed { return Ok((committed, None)); }
        let binding = handoff.lock().expect("investigation handoff poisoned").take()
            .ok_or_else(|| Error::internal(FailureStage::Commit))?;
        let binding = self.resources.tasks.retain_investigation(self, binding)?;
        Ok((committed, Some(binding)))
    }

    pub(crate) fn investigation_binding(&self) -> Option<Arc<authorization::InvestigationBinding>> {
        self.resources.tasks.investigation_binding(&self.operation.world, &self.run.id)
    }

    pub(crate) async fn join_investigation_child_work(&self, binding: &BindingId, deadline: Instant) -> Result<(), Error> {
        self.resources.tasks.join_investigation_child_work(&self.operation.world, binding, deadline).await
    }

    pub(crate) async fn recheck_replay<T>(&self, committed: &Committed<T>) -> Result<(), Error> {
        if !committed.replayed { return Ok(()); }
        let admission = self.admission.clone();
        let operation_id = self.operation.operation_id.clone();
        let run_id = self.run.id.clone();
        self.store.snapshot(self.operation.world.clone(), move |snapshot| Box::pin(async move {
            let now = snapshot.now().await?;
            authorization::recheck_read(snapshot, &admission, &now).await?;
            let receipt = ledger::read_snapshot(snapshot, &operation_id).await?;
            if receipt.progress.run_id.as_ref() != Some(&run_id) { return Err(Error::internal(FailureStage::Admission)); }
            authorization::check_admitted_output_read(snapshot, &admission, admission.impact(), 1, &now).await?;
            Ok::<_, Error>(())
        })).await
    }

    /// Keeps the original commit outcome intact; disclosure failure must never imply rollback.
    pub(crate) async fn transact_outcome<T, F>(
        &self, request: CommitRequest, action: F,
    ) -> Result<Committed<T>, crate::store::TransactionError<Error>>
    where
        T: Serialize + DeserializeOwned + Send,
        F: for<'a> FnOnce(&'a mut WorldTransaction<'_>, Admission, OperationRecord, RunRecord) -> StoreFuture<'a, T, Error> + Send + 'static,
    {
        let batch = request.prepare().map_err(|error| crate::store::TransactionError::NotCommitted { error: error.into(), cleanup: None })?;
        self.transact_batch(batch, action).await
    }

    pub(crate) async fn transact_exclusive_storage<T, F>(
        &self, key: &str, input_digest: Digest, domains: &[&str], action: F,
    ) -> Result<Committed<T>, Error>
    where
        T: Serialize + DeserializeOwned + Send,
        F: for<'a> FnOnce(&'a mut WorldTransaction<'_>, Admission, OperationRecord, RunRecord) -> StoreFuture<'a, T, Error> + Send + 'static,
    {
        let batch = self.prepare_batch(key, input_digest, domains).await?.exclusive_storage()?;
        let committed = self.transact_batch(batch, action).await.map_err(Error::from)?;
        self.recheck_replay(&committed).await?;
        Ok(committed)
    }

    pub(crate) async fn transact_exclusive_storage_outcome<T, F>(
        &self, request: CommitRequest, action: F,
    ) -> Result<Committed<T>, crate::store::TransactionError<Error>>
    where
        T: Serialize + DeserializeOwned + Send,
        F: for<'a> FnOnce(&'a mut WorldTransaction<'_>, Admission, OperationRecord, RunRecord) -> StoreFuture<'a, T, Error> + Send + 'static,
    {
        let batch = request.prepare().and_then(crate::store::PreparedBatch::exclusive_storage)
            .map_err(|error| crate::store::TransactionError::NotCommitted { error: error.into(), cleanup: None })?;
        self.transact_batch(batch, action).await
    }

    pub(crate) async fn transact_world_mutation_outcome<T, F>(
        &self, request: CommitRequest, proof: &crate::store::CommittedWorldMutation, action: F,
    ) -> Result<Committed<T>, crate::store::TransactionError<Error>>
    where
        T: Serialize + DeserializeOwned + Send,
        F: for<'a> FnOnce(&'a mut WorldTransaction<'_>, Admission, OperationRecord, RunRecord) -> StoreFuture<'a, T, Error> + Send + 'static,
    {
        let batch = request.prepare().and_then(|batch| batch.resume_world_mutation(proof))
            .map_err(|error| crate::store::TransactionError::NotCommitted { error: error.into(), cleanup: None })?;
        self.transact_batch(batch, action).await
    }

    async fn transact_batch<T, F>(
        &self, batch: crate::store::PreparedBatch, action: F,
    ) -> Result<Committed<T>, crate::store::TransactionError<Error>>
    where
        T: Serialize + DeserializeOwned + Send,
        F: for<'a> FnOnce(&'a mut WorldTransaction<'_>, Admission, OperationRecord, RunRecord) -> StoreFuture<'a, T, Error> + Send + 'static,
    {
        let admission = self.admission.clone();
        let run_id = self.run.id.clone();
        let operation_id = self.operation.operation_id.clone();
        self.store.transact(batch, move |tx| Box::pin(async move {
            tx.require_world_mutation_operation(&operation_id)?;
            let now = tx.now().await?;
            authorization::recheck(tx, &admission, &now).await?;
            let run = run::require_run_invocation(tx, &admission, &run_id).await?;
            let operation = ledger::read(tx, &operation_id).await?;
            if run.operation.operation_id != operation_id || operation.receipt.progress.run_id.as_ref() != Some(&run.id) {
                return Err(Error::internal(FailureStage::Admission));
            }
            action(tx, admission, operation, run).await
        })).await
    }
}

#[derive(Clone)]
pub(crate) struct InvocationServiceSeed {
    store: Arc<WorldStore>,
    content: Arc<crate::content::Content>,
    source_access: Result<Arc<dyn crate::sources::connectors::SourceAccess>, Arc<crate::sources::connectors::SourceError>>,
    model_calls: Arc<crate::generation::GenerationRecovery>,
    wasm: crate::extensions::wasm::ExecutionPolicy,
}

impl InvocationServiceSeed {
    pub(crate) fn for_resources(
        store: &WorldStore, resources: &Resources,
        source_access: Result<Arc<dyn crate::sources::connectors::SourceAccess>, Arc<crate::sources::connectors::SourceError>>,
    ) -> Self {
        Self { store: Arc::new(store.clone()), content: resources.content.clone(), source_access,
            model_calls: resources.model_calls.clone(), wasm: resources.preparation.execution_policy() }
    }

    pub(crate) fn for_lease(
        &self, lease: &Arc<InvocationLease>, generation: Option<Arc<dyn BoundGeneration>>,
        source_versions: Vec<world_protocol::materials::SourceVersionRef>,
    ) -> Result<InvocationServices, InvocationFailure> {
        if self.content.world() != &lease.graph().lock().world {
            return Err(InvocationFailure::Binding(world_protocol::bindings::BindingFailure::LockIdentityConflict));
        }
        let mut sources = crate::query::SourceBrokers::new();
        let expected = world_protocol::slots::slot_port(world_protocol::bindings::SlotKind::Connector)
            .map_err(|cause| InvocationFailure::Source(crate::sources::connectors::SourceError::caused_by(
                world_protocol::sources::SourceFailure::ProtocolViolation, FailureStage::Prepare, cause,
            )))?;
        for node in &lease.closure().nodes {
            let binding = lease.graph().node(node).map_err(InvocationFailure::Binding)?;
            if binding.slot != world_protocol::bindings::SlotKind::Connector
                || !binding.implementation.contracts.contains(&expected.contract)
                || !binding.ports.iter().filter(|port| port.direction == world_protocol::bindings::PortDirection::Export
                    && port.name == expected.name).eq(std::iter::once(&expected))
            { continue; }
            let broker = Arc::new(SourceBroker::for_provider(self.store.clone(), self.source_access.clone(),
                lease.clone(), node.clone(), self.clone()).map_err(InvocationFailure::Source)?);
            if sources.insert(binding.provider_id.clone(), broker).is_some() {
                return Err(InvocationFailure::Binding(world_protocol::bindings::BindingFailure::SchemaMismatch {
                    consumer: node.clone(), provider: node.clone(),
                }));
            }
        }
        Ok(InvocationServices { hosts: HostCallServices { source: None, sources, content: self.content.clone(), generation,
            model_calls: self.model_calls.clone(), state_limits: StateLimits::default(), source_versions }, wasm: self.wasm, resolver: None, context: None, abstraction: None, agent_bridge: None, identity_receipt: None })
    }
}

pub(crate) struct MaintenanceContext {
    pub store: WorldStore,
    pub resources: Arc<Resources>,
    pub admission: Admission,
    pub deadline: Instant,
    pub budget: crate::extensions::invocation::CallBudget,
    pub cancellation: CancellationToken,
}

impl MaintenanceContext {
    pub(crate) async fn commit_request(&self, key: &str, input_digest: Digest, domains: &[&str]) -> Result<CommitRequest, Error> {
        let world = &self.admission.invocation().world;
        let identity = crate::definitions::canonical_digest(&("world.maintenance.v1", world, self.admission.restart_identity(), key))?;
        let commit_id = CommitId::try_new(format!("maintenance-{}", &identity.as_str()[7..]))
            .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?;
        prepare_request(&self.store, world, commit_id, input_digest, domains).await
    }
}

pub(super) async fn prepare_request(
    store: &WorldStore, world: &WorldRef, commit_id: CommitId, input_digest: Digest, domains: &[&str],
) -> Result<CommitRequest, Error> {
    let mut domains: Vec<String> = domains.iter().map(|domain| (*domain).to_owned()).collect();
    domains.sort_unstable();
    domains.dedup();
    let (storage_epoch, fences) = store.snapshot(world.clone(), move |snapshot| Box::pin(async move {
        let domains: Vec<_> = domains.iter().map(String::as_str).collect();
        head::writer_fences(snapshot, &domains).await
    })).await?;
    Ok(CommitRequest { world: world.clone(), commit_id, input_digest, storage_epoch, fences, watch_basis: Vec::new() })
}
