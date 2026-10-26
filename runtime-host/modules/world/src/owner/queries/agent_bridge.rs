use std::{collections::BTreeSet, sync::Arc};

use foundation::pipeline::PipelineContext;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    api::{PeerOperation, PeerRequest, PeerResponse},
    authorization::{AccessMode, AccessScope, ActualImpact},
    bindings::SlotKind,
    failure::FailureStage,
    ids::*,
    query::QueryRequest,
    slots::{AgentBridgeRequest, AgentBridgeResult, BridgeFailure, SlotFailure, SlotRequest, SlotResponse},
};
use crate::{
    authorization::{Admission, self},
    extensions::{
        bindings::{self, BindingError, BindingGraph},
        invocation::{CallBudget, CompositionFailure, InvocationContext, InvocationFailure, invoke_composition_checked},
    },
    owner::{Error, resources::Resources},
    sources::connectors::{SourceAccess, SourceError},
    store::{StoreFuture, WorldStore, WorldTransaction},
};

pub(crate) struct AgentBridgeExecution {
    store: WorldStore,
    resources: Arc<Resources>,
    admission: Admission,
    invocation: InvocationContext,
    request: AgentBridgeRequest,
    native_run: NativeRunId,
    source_access: Result<Arc<dyn SourceAccess>, Arc<SourceError>>,
    cancellation: CancellationToken,
    result: tokio::sync::OnceCell<Result<AgentBridgeResult, Error>>,
}

impl AgentBridgeExecution {
    pub(crate) async fn execute(
        &self, context: &InvocationContext, request: &AgentBridgeRequest,
        cancel: &CancellationToken, deadline: Instant,
    ) -> Result<AgentBridgeResult, Error> {
        let graph = self.invocation.lease().graph();
        let root = graph.node(self.invocation.node()).map_err(BindingError::from)?;
        let member = graph.node(context.node()).map_err(BindingError::from)?;
        if request != &self.request || member.slot != SlotKind::AgentBridge || member.binding_id != root.binding_id
            || !Arc::ptr_eq(context.lease(), self.invocation.lease())
            || context.admission().invocation() != self.admission.invocation()
            || context.admission().decision() != self.admission.decision() { return Err(failure(BridgeFailure::ProtocolMismatch)); }
        self.check(context, cancel, deadline).await?;
        let result = self.result.get_or_init(|| async {
            let PeerOperation::Query(query) = &request.peer.operation else { return Err(failure(BridgeFailure::ProtocolMismatch)); };
            let cancellation = self.cancellation.child_token();
            let read = super::objects::run_admitted_with_budget(
                self.store.clone(), self.resources.clone(), self.admission.clone(), query.clone(),
                self.source_access.clone(), cancellation.clone(), context.budget().clone(), None, context.pipeline().clone(),
            );
            tokio::pin!(read);
            let page = tokio::select! {
                biased;
                _ = cancel.cancelled() => { cancellation.cancel(); read.await },
                result = &mut read => result,
            }?;
            if page.receipt.activation_lock_id != graph.lock().id { return Err(failure(BridgeFailure::ProtocolMismatch)); }
            Ok(AgentBridgeResult { response: PeerResponse::Query(page), native_run_id: Some(self.native_run.clone()) })
        }).await.clone()?;
        self.check(context, cancel, deadline).await?;
        Ok(result)
    }

    async fn check(&self, context: &InvocationContext, cancel: &CancellationToken, deadline: Instant) -> Result<(), Error> {
        if cancel.is_cancelled() || self.cancellation.is_cancelled() { return Err(failure(BridgeFailure::Cancelled)); }
        if Instant::now() >= deadline.min(context.budget().deadline()) { return Err(failure(BridgeFailure::Timeout)); }
        context.check_current().await.map_err(|error| Error::from_host_failure(error.host_failure(), FailureStage::Read).caused(error))
    }
}

pub(crate) fn preflight<'a>(
    tx: &'a WorldTransaction<'_>, request: &'a QueryRequest, scope: &'a ScopeId,
) -> StoreFuture<'a, (ActualImpact, (NodeId, ActivationLockId)), Error> {
    Box::pin(async move {
        let mut impact = super::objects::impact_in_transaction(tx, request, scope).await?;
        let release = crate::query::read_release_in_transaction(tx, request).await?;
        let graph = bindings::read_graph_in_transaction(tx, &release.artifact.activation_lock_id).await?;
        let node = bridge_node(&graph)?;
        let resources = graph.closure_nodes(&node).map_err(BindingError::from)?.iter()
            .map(|node| graph.node(node).map(|node| ResourceRef::Binding { id: node.binding_id.clone() }))
            .collect::<Result<BTreeSet<_>, _>>().map_err(BindingError::from)?;
        impact.access.push(AccessScope { resources: resources.into_iter().collect(), fields: Vec::new(),
            modes: vec![AccessMode::Execute], scope: scope.clone(), valid_time: None });
        let impact = authorization::actual_impact(impact.access, impact.effects, impact.labels, impact.state, impact.source_ids)?;
        Ok((impact, (node, graph.lock().id.clone())))
    })
}

pub(crate) async fn run(
    store: WorldStore, resources: Arc<Resources>, admission: Admission, peer: PeerRequest,
    native_run: NativeRunId, selection: (NodeId, ActivationLockId),
    source_access: Result<Arc<dyn SourceAccess>, Arc<SourceError>>, cancel: CancellationToken,
) -> Result<PeerResponse, Error> {
    let PeerOperation::Query(query) = &peer.operation else { return Err(failure(BridgeFailure::ProtocolMismatch)); };
    if peer.world != admission.invocation().world || query.world != peer.world { return Err(failure(BridgeFailure::PrincipalInvalid)); }
    let saved = admission.clone();
    let now = store.snapshot(peer.world.clone(), move |snapshot| Box::pin(async move {
        let now = snapshot.now().await?;
        authorization::recheck_read(snapshot, &saved, &now).await?;
        Ok::<_, Error>(now)
    })).await?;
    let limit = super::objects::query_budget(admission.invocation().deadline.clone());
    let budget = match admission.investigation_budget() {
        Some(parent) => parent.scoped(&limit, &now),
        None => CallBudget::new(limit, &now),
    }.map_err(|error| Error::from_host_failure(world_protocol::process::HostFailure::BudgetExceeded { dimension: error.dimension }, FailureStage::Read))?;
    let (node, lock) = selection;
    let lease = Arc::new(resources.live.acquire(&peer.world, &lock, &node, admission.invocation().id.clone(), now)
        .map_err(|error| Error::from_host_failure(error.host_failure(), FailureStage::Prepare).caused(InvocationFailure::Lease(error)))?);
    let result = async {
        let pipeline = PipelineContext::silent_in_memory(admission.invocation().id.as_str());
        let context = InvocationContext::new(Arc::new(store.clone()), admission.clone(), lease.clone(), node, pipeline, budget.clone())
            .map_err(|error| Error::from_host_failure(error.host_failure(), FailureStage::Prepare).caused(error))?;
        let request = AgentBridgeRequest { peer, deadline: admission.invocation().deadline.clone() };
        let execution = Arc::new(AgentBridgeExecution { store: store.clone(), resources: resources.clone(), admission: admission.clone(),
            invocation: context.clone(), request: request.clone(), native_run, source_access: source_access.clone(),
            cancellation: cancel.clone(), result: tokio::sync::OnceCell::new() });
        let mut services = crate::owner::InvocationServiceSeed::for_resources(&store, &resources, source_access).for_lease(&lease, None, Vec::new())
            .map_err(|error| Error::from_host_failure(error.host_failure(), FailureStage::Prepare).caused(error))?;
        services.agent_bridge = Some(execution.clone());
        let expected = request.clone();
        let observed = execution.clone();
        let outcome = invoke_composition_checked(context.clone(), SlotRequest::AgentBridge(request.clone()), services,
            |_, input| { if input != SlotRequest::AgentBridge(expected.clone()) { return Err(invalid()); } Ok(input) },
            |_, input, output| {
                if input != &SlotRequest::AgentBridge(expected.clone()) { return Err(invalid()); }
                let SlotResponse::AgentBridge(result) = output else { return Err(invalid()); };
                if observed.result.get().and_then(|result| result.as_ref().ok()) != Some(result) { return Err(invalid()); }
                Ok(None)
            }).await.map_err(composition_error)?;
        let SlotResponse::AgentBridge(result) = outcome.result.map_err(|error| Error::from_host_failure(error.host_failure(), FailureStage::Read).caused(error))?
            else { return Err(failure(BridgeFailure::ProtocolMismatch)); };
        execution.check(&context, &cancel, budget.deadline()).await?;
        if execution.result.get().and_then(|result| result.as_ref().ok()) != Some(&result) { return Err(failure(BridgeFailure::ProtocolMismatch)); }
        let PeerResponse::Query(page) = &result.response else { return Err(failure(BridgeFailure::ProtocolMismatch)); };
        let PeerOperation::Query(query) = &request.peer.operation else { return Err(failure(BridgeFailure::ProtocolMismatch)); };
        let scope = store.snapshot(request.peer.world.clone(), |snapshot| Box::pin(async move {
            let row = snapshot.query_opt("SELECT management_scope_id FROM world_runtime_head WHERE tenant_id=$1 AND world_id=$2",
                &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str()]).await?.ok_or_else(|| failure(BridgeFailure::ProtocolMismatch))?;
            ScopeId::try_new(row.get::<_, String>("management_scope_id")).map_err(|_| failure(BridgeFailure::ProtocolMismatch))
        })).await?;
        crate::query::recheck_page(&store, &resources.content, &admission, query, &scope, page, &budget, &cancel).await?;
        Ok(result.response)
    }.await;
    lease.finish();
    result
}

fn bridge_node(graph: &BindingGraph) -> Result<NodeId, Error> {
    let bindings: BTreeSet<_> = graph.lock().nodes.iter().filter(|node| node.slot == SlotKind::AgentBridge)
        .map(|node| node.binding_id.clone()).collect();
    if bindings.len() != 1 { return Err(failure(BridgeFailure::RuntimeUnavailable)); }
    graph.composition_order(bindings.iter().next().expect("one AgentBridge composition")).map_err(BindingError::from)?.into_iter()
        .find(|node| graph.node(node).is_ok_and(|node| node.slot == SlotKind::AgentBridge)).ok_or_else(|| failure(BridgeFailure::RuntimeUnavailable))
}
fn failure(reason: BridgeFailure) -> Error { Error::from_host_failure(world_protocol::process::HostFailure::Slot(SlotFailure::AgentBridge(reason)), FailureStage::Read) }
fn invalid() -> CompositionFailure { CompositionFailure::Slot(SlotFailure::AgentBridge(BridgeFailure::ProtocolMismatch)) }
fn composition_error(error: CompositionFailure) -> Error { Error::from_host_failure(error.host_failure(), FailureStage::Read).caused(error) }
