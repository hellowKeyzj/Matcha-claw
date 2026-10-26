use std::sync::Arc;

use foundation::pipeline::PipelineContext;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    api::{QueryEnvelope, QueryResult, WorldQuery}, budget::Budget,
    failure::FailureStage, ids::*, query::{QueryFailure, QueryPage, QueryRequest},
    time::{DurationMs, Timestamp},
};
use crate::{
    authorization::{self, Admission, AdmissionCommit, ServiceIngress}, content::Content,
    extensions::{bindings::{self, BindingError}, invocation::{CallBudget, InvocationLease}},
    query, sources::connectors::{SourceAccess, SourceBroker, SourceError}, store::{CommitRequest, StoreFuture, WorldStore},
};
use super::super::{Error, head, operation::{self, SignedRequest}, resources::Resources};

/// One exact query execution; the Resolver cannot supply a different plan or reset its budget.
pub(crate) struct ResolverExecution {
    store: WorldStore, content: Arc<Content>, admission: Admission, scope: ScopeId,
    request: world_protocol::slots::ResolveQueryRequest, lease: Arc<InvocationLease>, node: NodeId,
    brokers: query::SourceBrokers, calls: std::sync::Mutex<Option<Option<query::ProjectionCalls>>>,
    result: tokio::sync::OnceCell<Result<QueryPage, Error>>, pipeline: PipelineContext, budget: CallBudget,
    storage: crate::extensions::invocation::InvocationContext,
}
impl ResolverExecution {
    pub(crate) async fn execute(
        &self, context: &crate::extensions::invocation::InvocationContext,
        request: &world_protocol::slots::ResolveQueryRequest, cancel: &CancellationToken, deadline: Instant,
    ) -> Result<world_protocol::slots::ResolveQueryResult, Error> {
        let graph = self.lease.graph();
        let root = graph.node(&self.node).map_err(BindingError::from)?;
        let member = graph.node(context.node()).map_err(BindingError::from)?;
        if request != &self.request || member.binding_id != root.binding_id || member.slot != world_protocol::bindings::SlotKind::Resolver || !Arc::ptr_eq(context.lease(), &self.lease)
            || context.admission().invocation() != self.admission.invocation()
            || context.admission().decision() != self.admission.decision() {
            return Err(query::QueryError::from(QueryFailure::BasisChanged).into());
        }
        context.check_current().await.map_err(|error| Error::from_host_failure(error.host_failure(), FailureStage::Read).caused(error))?;
        self.budget.check().map_err(|error| Error::from_host_failure(world_protocol::process::HostFailure::BudgetExceeded { dimension: error.dimension }, FailureStage::Read))?;
        let page = self.result.get_or_init(|| async {
            let calls = self.calls.lock().expect("resolver calls poisoned").take().ok_or_else(|| Error::from(query::QueryError::from(QueryFailure::BasisChanged)))?;
            execute_current(&self.store, &self.content, &self.admission, &request.query, &self.scope,
                Some(&self.brokers), calls, &self.pipeline, &self.budget, cancel, deadline.min(self.budget.deadline()), Some((context, &self.request)), &self.storage).await
        }).await.clone()?;
        context.check_current().await.map_err(|error| Error::from_host_failure(error.host_failure(), FailureStage::Read).caused(error))?;
        Ok(world_protocol::slots::ResolveQueryResult { actual_dependencies: page.receipt.actual_dependencies.clone(), page })
    }
}

fn projection_nodes(graph: &bindings::BindingGraph, request: &QueryRequest) -> Result<Option<[NodeId; 2]>, Error> {
    if request.branch_id.is_some() || request.page.cursor.is_some() { return Ok(None); }
    let mut selected = Vec::new();
    for slot in [world_protocol::bindings::SlotKind::Projection, world_protocol::bindings::SlotKind::Reconcile] {
        let bindings: std::collections::BTreeSet<_> = graph.lock().nodes.iter().filter(|node| node.slot == slot).map(|node| node.binding_id.clone()).collect();
        if bindings.len() != 1 { return Err(query::QueryError::from(QueryFailure::GuaranteeUnsatisfied { mode: request.read_mode.clone(), source_id: None }).into()); }
        let binding = bindings.into_iter().next().expect("one composition");
        let order = graph.composition_order(&binding).map_err(BindingError::from)?;
        selected.push(order.into_iter().find(|node| graph.node(node).is_ok_and(|node| node.slot == slot)).ok_or_else(|| Error::from(query::QueryError::from(QueryFailure::GuaranteeUnsatisfied { mode: request.read_mode.clone(), source_id: None })))?);
    }
    Ok(Some([selected.remove(0), selected.remove(0)]))
}
fn resolver_node(graph: &bindings::BindingGraph) -> Result<NodeId, Error> {
    let bindings: std::collections::BTreeSet<_> = graph.lock().nodes.iter().filter(|node| node.slot == world_protocol::bindings::SlotKind::Resolver).map(|node| node.binding_id.clone()).collect();
    if bindings.len() != 1 { return Err(query::QueryError::from(QueryFailure::BasisChanged).into()); }
    let binding = bindings.into_iter().next().expect("one resolver composition");
    graph.composition_order(&binding).map_err(BindingError::from)?.into_iter()
        .find(|node| graph.node(node).is_ok_and(|node| node.slot == world_protocol::bindings::SlotKind::Resolver))
        .ok_or_else(|| query::QueryError::from(QueryFailure::BasisChanged).into())
}
fn storage_node(graph: &bindings::BindingGraph) -> Result<NodeId, Error> {
    let mut nodes = graph.lock().nodes.iter().filter(|node| node.slot == world_protocol::bindings::SlotKind::Storage);
    let node = nodes.next().ok_or_else(|| Error::from(query::QueryError::from(QueryFailure::BasisChanged)))?;
    if nodes.next().is_some() { return Err(query::QueryError::from(QueryFailure::BasisChanged).into()); }
    Ok(node.id.clone())
}
fn projection_impact(mut impact: world_protocol::authorization::ActualImpact, graph: &bindings::BindingGraph, nodes: Option<&[NodeId; 2]>, scope: &ScopeId) -> Result<world_protocol::authorization::ActualImpact, Error> {
    let resolver = resolver_node(graph)?;
    let mut resources = std::collections::BTreeSet::new();
    let storage = storage_node(graph)?;
    for node in [&resolver, &storage].into_iter().chain(nodes.into_iter().flatten()) {
        for node in graph.closure_nodes(node).map_err(BindingError::from)? {
            resources.insert(ResourceRef::Binding { id: graph.node(&node).map_err(BindingError::from)?.binding_id.clone() });
        }
    }
    impact.access.push(world_protocol::authorization::AccessScope { resources: resources.into_iter().collect(), fields: Vec::new(), modes: vec![world_protocol::authorization::AccessMode::Execute], scope: scope.clone(), valid_time: None });
    Ok(authorization::actual_impact(impact.access, impact.effects, impact.labels, impact.state, impact.source_ids)?)
}
pub(crate) async fn impact_in_transaction(tx: &crate::store::WorldTransaction<'_>, request: &QueryRequest, scope: &ScopeId) -> Result<world_protocol::authorization::ActualImpact, Error> {
    let impact = query::impact_in_transaction(tx, request, scope).await?;
    let release = query::read_release_in_transaction(tx, request).await?;
    let graph = bindings::read_graph_history_in_transaction(tx, &release.artifact.activation_lock_id).await?;
    let nodes = projection_nodes(&graph, request)?;
    projection_impact(impact, &graph, nodes.as_ref(), scope)
}

pub(crate) async fn run(
    store: WorldStore, resources: Arc<Resources>, ingress: Arc<ServiceIngress>,
    signed: SignedRequest, envelope: QueryEnvelope,
    source_access: Result<Arc<dyn SourceAccess>, Arc<SourceError>>, cancel: CancellationToken,
) -> Result<QueryResult, Error> {
    let relations = matches!(&envelope.query, WorldQuery::Relations(_));
    let request = match envelope.query {
        WorldQuery::Objects(request) | WorldQuery::Relations(request) if request.world == envelope.world => request,
        _ => return Err(Error::internal(FailureStage::Decode)),
    };
    let batch = operation::batch(&store, &signed.binding).await?;
    let admitted = authorization::commit_admission(&store, batch, move |tx| Box::pin(async move {
        let now = tx.now().await?;
        let verified = ingress.authenticate(tx, &signed.token, signed.binding, &now).await?;
        let scope = head::management_scope(tx).await?;
        let impact = impact_in_transaction(tx, &request, &scope).await?;
        let admission = authorization::admit(tx, &verified, &impact, &[], None, &now).await?;
        Ok::<_, Error>((request, admission))
    })).await?;
    let (request, admission) = match admitted {
        AdmissionCommit::Committed { outcome, admission } => (outcome.value, admission),
        AdmissionCommit::Replayed(_) => return Err(Error::internal(FailureStage::Admission)),
    };
    let page = run_admitted(store, resources, admission, request, source_access, cancel).await?;
    Ok(if relations { QueryResult::Relations(page) } else { QueryResult::Objects(page) })
}

pub(crate) async fn run_admitted(
    store: WorldStore, resources: Arc<Resources>, admission: Admission, request: QueryRequest,
    source_access: Result<Arc<dyn SourceAccess>, Arc<SourceError>>, cancel: CancellationToken,
) -> Result<QueryPage, Error> {
    let now = Timestamp::try_new(chrono::Utc::now().to_rfc3339()).map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?;
    let limit = query_budget(admission.invocation().deadline.clone());
    let budget = match admission.investigation_budget() {
        Some(parent) => parent.scoped(&limit, &now),
        None => CallBudget::new(limit, &now),
    }.map_err(|error| Error::from_host_failure(world_protocol::process::HostFailure::BudgetExceeded { dimension: error.dimension }, FailureStage::Prepare))?;
    let cancel = admission.investigation_cancellation().cloned().unwrap_or(cancel);
    let pipeline = PipelineContext::silent_in_memory(admission.invocation().id.as_str());
    run_admitted_with_budget(store, resources, admission, request, source_access, cancel, budget, None, pipeline).await
}

pub(crate) async fn run_admitted_with_budget(
    store: WorldStore, resources: Arc<Resources>, admission: Admission, request: QueryRequest,
    source_access: Result<Arc<dyn SourceAccess>, Arc<SourceError>>, cancel: CancellationToken,
    budget: CallBudget, scope: Option<ScopeId>, pipeline: PipelineContext,
) -> Result<QueryPage, Error> {
    budget.check().map_err(|error| Error::from_host_failure(world_protocol::process::HostFailure::BudgetExceeded { dimension: error.dimension }, FailureStage::Prepare))?;
    if cancel.is_cancelled() { return Err(query::QueryError::from(QueryFailure::Cancelled).into()); }
    if request.world != admission.invocation().world { return Err(query::QueryError::from(QueryFailure::BasisChanged).into()); }
    if let Some(committed) = store.read_commit_optional::<QueryPage>(&request.world, &commit_id(&admission, "read")?, &admission.invocation().request_digest).await? {
        let page = committed.value;
        let saved_admission = admission.clone();
        let (scope, now) = store.snapshot(request.world.clone(), move |snapshot| Box::pin(async move {
            let now = snapshot.now().await?;
            authorization::recheck_read(snapshot, &saved_admission, &now).await?;
            let scope = match scope {
                Some(scope) => scope,
                None => {
                    let row = snapshot.query_opt("SELECT management_scope_id FROM world_runtime_head WHERE tenant_id=$1 AND world_id=$2", &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str()]).await?.ok_or_else(|| Error::internal(FailureStage::Prepare))?;
                    ScopeId::try_new(row.get::<_, String>("management_scope_id")).map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?
                },
            };
            Ok::<_, Error>((scope, now))
        })).await?;
        let budget = budget.scoped(&query_budget(admission.invocation().deadline.clone()), &now)
            .map_err(|error| Error::from_host_failure(world_protocol::process::HostFailure::BudgetExceeded { dimension: error.dimension }, FailureStage::Prepare))?;
        let (release, impact) = query::recheck_page(&store, &resources.content, &admission, &request, &scope, &page, &budget, &cancel).await?;
        let graph = store.snapshot(request.world.clone(), move |snapshot| Box::pin(async move {
            bindings::read_graph(snapshot, &release.artifact.activation_lock_id).await.map_err(Error::from)
        })).await?;
        let nodes = projection_nodes(&graph, &request)?;
        admission.require_access(&projection_impact(impact, &graph, nodes.as_ref(), &scope)?)?;
        let mut leases: Vec<Arc<InvocationLease>> = Vec::new();
        let result = async {
            let storage = storage_node(&graph)?;
            for node in [storage.clone(), resolver_node(&graph)?].into_iter().chain(nodes.into_iter().flatten()) {
                let lease = Arc::new(resources.live.acquire(&request.world, &graph.lock().id, &node, admission.invocation().id.clone(), now.clone()).map_err(lease_error)?);
                leases.push(lease.clone());
                if node == storage && lease.storage(&node).is_none() { return Err(query::QueryError::from(QueryFailure::BasisChanged).into()); }
                for member in &lease.closure().nodes {
                    crate::extensions::invocation::check_current(&store, &admission, &lease, member).await
                        .map_err(|error| Error::from_host_failure(error.host_failure(), FailureStage::Read).caused(error))?;
                }
            }
            budget.check().map_err(|error| Error::from_host_failure(world_protocol::process::HostFailure::BudgetExceeded { dimension: error.dimension }, FailureStage::Read))?;
            if cancel.is_cancelled() { return Err(query::QueryError::from(QueryFailure::Cancelled).into()); }
            Ok(page)
        }.await;
        for lease in leases { lease.finish(); }
        return result;
    }
    let saved_request = request.clone(); let saved_admission = admission.clone();
    let (scope, release, graph, nodes, resolver, connectors, source_plans, now) = store.snapshot(request.world.clone(), move |snapshot| Box::pin(async move {
        let now = snapshot.now().await?;
        authorization::recheck_read(snapshot, &saved_admission, &now).await?;
        let row = snapshot.query_opt("SELECT management_scope_id FROM world_runtime_head WHERE tenant_id=$1 AND world_id=$2", &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str()]).await?.ok_or_else(|| Error::internal(FailureStage::Prepare))?;
        let scope = match scope {
            Some(scope) => scope,
            None => ScopeId::try_new(row.get::<_, String>("management_scope_id")).map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?,
        };
        let impact = query::impact(snapshot, &saved_request, &scope).await?;
        let release = query::read_release(snapshot, &saved_request).await?;
        let graph = bindings::read_graph(snapshot, &release.artifact.activation_lock_id).await?;
        let nodes = projection_nodes(&graph, &saved_request)?;
        let resolver = resolver_node(&graph)?;
        saved_admission.require_access(&projection_impact(impact, &graph, nodes.as_ref(), &scope)?)?;
        let connectors = query::source_connectors(snapshot, &saved_request, &release, world_protocol::api::MAX_PAGE_ITEMS as u64).await?;
        let source_plans = query::source_plans(snapshot, &saved_request, &release, world_protocol::api::MAX_PAGE_ITEMS as u64).await?;
        Ok::<_, Error>((scope, release, graph, nodes, resolver, connectors, source_plans, now))
    })).await?;
    let budget = budget.scoped(&query_budget(admission.invocation().deadline.clone()), &now)
        .map_err(|error| Error::from_host_failure(world_protocol::process::HostFailure::BudgetExceeded { dimension: error.dimension }, FailureStage::Prepare))?;
    let deadline = budget.deadline();
    let mut leases: Vec<Arc<InvocationLease>> = Vec::new();
    let mut brokers = query::SourceBrokers::new();
    let result = async {
        let storage_node = storage_node(&graph)?;
        let storage_lease = Arc::new(resources.live.acquire(&request.world, &release.artifact.activation_lock_id, &storage_node,
            admission.invocation().id.clone(), now.clone()).map_err(lease_error)?);
        leases.push(storage_lease.clone());
        if storage_lease.storage(&storage_node).is_none() { return Err(query::QueryError::from(QueryFailure::BasisChanged).into()); }
        let storage = crate::extensions::invocation::InvocationContext::new(Arc::new(store.clone()), admission.clone(), storage_lease,
            storage_node, pipeline.clone(), budget.clone())
            .map_err(|error| Error::from_host_failure(error.host_failure(), FailureStage::Prepare).caused(error))?;
        if !connectors.is_empty() {
            let seed = crate::owner::InvocationServiceSeed::for_resources(&store, &resources, source_access.clone());
            for provider in connectors {
                let nodes: Vec<_> = graph.lock().nodes.iter().filter(|node| node.provider_id == provider
                    && node.implementation.contracts.iter().any(|contract| contract.id.as_str() == "source.read")).collect();
                if nodes.len() != 1 { return Err(query::QueryError::from(QueryFailure::GuaranteeUnsatisfied { mode: request.read_mode.clone(), source_id: None }).into()); }
                let node = &nodes[0].id;
                let lease = Arc::new(resources.live.acquire(&request.world, &release.artifact.activation_lock_id, node,
                    admission.invocation().id.clone(), now.clone()).map_err(lease_error)?);
                leases.push(lease.clone());
                let broker = SourceBroker::for_provider(Arc::new(store.clone()), source_access.clone(), lease, node.clone(), seed.clone())
                    .map_err(|error| Error::from(query::QueryError::from(error)))?;
                brokers.insert(provider, Arc::new(broker));
            }
        }
        let calls = if let Some([projection, reconciliation]) = nodes {
            let seed = crate::owner::InvocationServiceSeed::for_resources(&store, &resources, source_access.clone());
            let mut calls = Vec::new();
            for node in [projection, reconciliation] {
                let lease = Arc::new(resources.live.acquire(&request.world, &release.artifact.activation_lock_id, &node, admission.invocation().id.clone(), now.clone()).map_err(lease_error)?);
                leases.push(lease.clone());
                let context = crate::extensions::invocation::InvocationContext::new(Arc::new(store.clone()), admission.clone(), lease.clone(), node, pipeline.clone(), budget.clone())
                    .map_err(|error| Error::from_host_failure(error.host_failure(), FailureStage::Prepare).caused(crate::extensions::invocation::InvocationFailure::Current(error)))?;
                let services = seed.for_lease(&lease, None, Vec::new())
                    .map_err(|error| Error::from_host_failure(error.host_failure(), FailureStage::Prepare).caused(error))?;
                calls.push(query::ProjectionCall { context, services });
            }
            Some(query::ProjectionCalls { projection: calls.remove(0), reconciliation: calls.remove(0) })
        } else { None };
        let lease = Arc::new(resources.live.acquire(&request.world, &release.artifact.activation_lock_id, &resolver, admission.invocation().id.clone(), now.clone()).map_err(lease_error)?);
        leases.push(lease.clone());
        let context = crate::extensions::invocation::InvocationContext::new(Arc::new(store.clone()), admission.clone(), lease.clone(), resolver.clone(), pipeline.clone(), budget.clone())
            .map_err(|error| Error::from_host_failure(error.host_failure(), FailureStage::Prepare).caused(error))?;
        let resolver_request = world_protocol::slots::ResolveQueryRequest { query: request.clone(), source_plans, budget: budget.limit() };
        let execution = Arc::new(ResolverExecution { store: store.clone(), content: resources.content.clone(), admission: admission.clone(), scope: scope.clone(), request: resolver_request.clone(), lease: lease.clone(), node: resolver,
            brokers, calls: std::sync::Mutex::new(Some(calls)), result: tokio::sync::OnceCell::new(), pipeline, budget: budget.clone(), storage });
        let seed = crate::owner::InvocationServiceSeed::for_resources(&store, &resources, source_access.clone());
        let mut services = seed.for_lease(&lease, None, Vec::new()).map_err(|error| Error::from_host_failure(error.host_failure(), FailureStage::Prepare).caused(error))?;
        services.resolver = Some(execution.clone());
        let outcome = crate::extensions::invocation::invoke_composition(context, world_protocol::slots::SlotRequest::Resolver(resolver_request), services).await
            .map_err(|error| Error::from_host_failure(error.host_failure(), FailureStage::Execute).caused(error))?;
        let result = outcome.result.map_err(|error| Error::from_host_failure(error.host_failure(), FailureStage::Execute).caused(error))?;
        let world_protocol::slots::SlotResponse::Resolver(result) = result else { return Err(query::QueryError::from(QueryFailure::BasisChanged).into()); };
        if result.actual_dependencies != result.page.receipt.actual_dependencies || execution.result.get().and_then(|result| result.as_ref().ok()) != Some(&result.page) { return Err(query::QueryError::from(QueryFailure::BasisChanged).into()); }
        query::recheck_page(&store, &resources.content, &admission, &request, &scope, &result.page, &budget, &cancel).await?;
        Ok(result.page)
    }.await;
    for lease in leases { lease.finish(); }
    result
}

/// Source I/O finishes before the sole receipt transaction; a replay still requires current output authority.
pub(crate) async fn execute_admitted(
    store: WorldStore, content: &Content, admission: Admission, request: QueryRequest, scope: ScopeId,
    brokers: Option<query::SourceBrokers>, calls: Option<query::ProjectionCalls>, pipeline: PipelineContext, budget: CallBudget,
    cancel: CancellationToken, deadline: Instant, storage: crate::extensions::invocation::InvocationContext,
) -> Result<QueryPage, Error> {
    execute_current(&store, content, &admission, &request, &scope, brokers.as_ref(), calls, &pipeline, &budget, &cancel, deadline, None, &storage).await
}

fn execute_current<'a>(
    store: &'a WorldStore,
    content: &'a Content,
    admission: &'a Admission,
    request: &'a QueryRequest,
    scope: &'a ScopeId,
    brokers: Option<&'a query::SourceBrokers>,
    calls: Option<query::ProjectionCalls>,
    pipeline: &'a PipelineContext,
    budget: &'a CallBudget,
    cancel: &'a CancellationToken,
    deadline: Instant,
    resolver: Option<(&'a crate::extensions::invocation::InvocationContext, &'a world_protocol::slots::ResolveQueryRequest)>,
    storage: &'a crate::extensions::invocation::InvocationContext,
) -> StoreFuture<'a, QueryPage, Error> {
    Box::pin(async move {
        let commit_id = commit_id(admission, "read")?;
        let input_digest = admission.invocation().request_digest.clone();
        storage.check_current().await.map_err(|error| Error::from_host_failure(error.host_failure(), FailureStage::Commit).caused(error))?;
        let recovered = store.read_commit_optional::<QueryPage>(&request.world, &commit_id, &input_digest).await?;
        let page = if let Some(committed) = recovered { committed.value } else {
            let prepared = if let Some((context, selected)) = resolver {
                if &selected.query != request { return Err(query::QueryError::from(QueryFailure::BasisChanged).into()); }
                query::execute_resolved(store, content, brokers, admission, selected, &context.lease().graph().lock().id, scope, pipeline, budget, cancel, deadline, calls).await?
            } else if let Some(calls) = calls {
                query::execute_projected(store, brokers, admission, request, scope, pipeline, budget, cancel, deadline, calls).await?
            } else {
                query::execute(store, content, brokers, admission, request, scope, pipeline, budget, cancel, deadline).await?
            };
            let endpoint = storage.lease().storage(storage.node()).cloned().ok_or_else(|| Error::from(query::QueryError::from(QueryFailure::BasisChanged)))?;
            let (storage_epoch, fences) = store.snapshot(request.world.clone(), |snapshot| Box::pin(head::writer_fences(snapshot, &["query"]))).await?;
            let batch = CommitRequest { world: request.world.clone(), commit_id, input_digest,
                storage_epoch, fences, watch_basis: Vec::new() }.prepare()?;
            let commit_admission = admission.clone();
            let resolver = resolver.map(|(context, _)| context.clone());
            endpoint.transact(storage.clone(), batch, move |tx| Box::pin(async move {
                if let Some(resolver) = &resolver {
                    crate::extensions::invocation::check_current_in_transaction(tx, &commit_admission, resolver.lease(), resolver.node()).await
                        .map_err(|error| Error::from_host_failure(error.host_failure(), FailureStage::Commit).caused(error))?;
                }
                query::commit_read(tx, &commit_admission, prepared).await.map_err(Error::from)
            })).await?.value
        };
        query::recheck_page(store, content, admission, request, scope, &page, budget, cancel).await?;
        Ok(page)
    })
}

fn commit_id(admission: &Admission, stage: &str) -> Result<CommitId, Error> {
    let invocation = admission.invocation();
    let identity = crate::definitions::canonical_digest(&("world.query.commit.v1", &invocation.world,
        admission.restart_identity(), &invocation.replay_id, stage))?;
    CommitId::try_new(format!("query-{}", &identity.as_str()[7..]))
        .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))
}
pub(crate) fn query_budget(deadline: Timestamp) -> Budget {
    Budget { max_wall_time: DurationMs(30_000), max_steps: world_protocol::api::MAX_QUERY_NODES as u64,
        max_source_reads: 64, max_rows: world_protocol::api::MAX_PAGE_ITEMS as u64, max_bytes: 8 * 1024 * 1024,
        max_model_calls: 0, max_input_tokens: 0, max_output_tokens: 0, max_cost: None, deadline: Some(deadline) }
}
fn lease_error(error: crate::extensions::invocation::LeaseFailure) -> Error {
    Error::from_host_failure(error.host_failure(), FailureStage::Prepare)
        .caused(crate::extensions::invocation::InvocationFailure::Lease(error))
}
