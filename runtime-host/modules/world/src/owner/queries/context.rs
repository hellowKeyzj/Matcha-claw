use std::{collections::BTreeSet, sync::Arc};

use foundation::pipeline::PipelineContext;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    api::{QueryEnvelope, QueryResult, WorldQuery},
    authorization::{AccessMode, AccessScope},
    bindings::SlotKind,
    failure::FailureStage,
    ids::*,
    query::QueryPage,
    slots::{ContextRequest, ContextResult, SlotRequest, SlotResponse},
    learning::{TaskContract, TaskRef},
    time::Timestamp,
};

use crate::{
    authorization::{self, Admission, AdmissionCommit, AuthError, ServiceIngress, VerifiedInvocation},
    extensions::{
        bindings::{self, BindingError, BindingGraph},
        invocation::{CallBudget, CompositionFailure, InvocationContext, InvocationLease, check_current_in_transaction, invoke_composition_checked},
    },
    owner::{Error, operation::{self, SignedRequest}, resources::Resources},
    sources::connectors::{SourceAccess, SourceError},
    store::{CommitRequest, WorldStore, WorldTransaction},
};

pub(crate) async fn query(
    resources: &Resources, tx: &WorldTransaction<'_>, verified: &VerifiedInvocation,
    query: &WorldQuery, now: &Timestamp, budget: &CallBudget, cancel: &CancellationToken,
) -> Result<QueryResult, Error> {
    match query {
        WorldQuery::TaskContract(reference) => task(tx, verified, reference, now).await.map(QueryResult::TaskContract),
        WorldQuery::Abstraction(reference) => crate::abstraction::read_authorized(tx, &resources.content, verified, reference)
            .await.map(QueryResult::Abstraction).map_err(Into::into),
        WorldQuery::Abstractions(request) => crate::abstraction::list_authorized(tx, &resources.content, verified, &request.task, &request.page, budget, cancel)
            .await.map(QueryResult::Abstractions).map_err(Into::into),
        _ => Err(Error::internal(FailureStage::Decode)),
    }
}

pub(crate) struct ContextExecution {
    store: WorldStore,
    admission: Admission,
    invocation: InvocationContext,
    request: ContextRequest,
    page: QueryPage,
    budget: CallBudget,
    cancellation: CancellationToken,
    result: tokio::sync::OnceCell<Result<ContextResult, Error>>,
}

impl ContextExecution {
    pub(crate) async fn execute(
        &self, context: &InvocationContext, request: &ContextRequest, cancel: &CancellationToken, deadline: Instant,
    ) -> Result<ContextResult, Error> {
        let graph = self.invocation.lease().graph();
        let root = graph.node(self.invocation.node()).map_err(BindingError::from)?;
        let member = graph.node(context.node()).map_err(BindingError::from)?;
        if request != &self.request || member.slot != SlotKind::Context || member.binding_id != root.binding_id
            || !Arc::ptr_eq(context.lease(), self.invocation.lease())
            || context.admission().invocation() != self.admission.invocation()
            || context.admission().decision() != self.admission.decision() { return Err(changed()); }
        self.check(context, cancel, deadline).await?;
        let result = self.result.get_or_init(|| async {
            let request = self.request.clone();
            let page = self.page.clone();
            let admission = self.admission.clone();
            let invocation = context.clone();
            let budget = context.budget().clone();
            let cancellation = self.cancellation.clone();
            let commit = self.commit("build", &(&request, &page)).await?;
            let result = self.store.transact(commit.prepare()?, move |tx| Box::pin(async move {
                current(tx, &admission, &invocation).await?;
                crate::context::from_page(tx, &admission, &request, page, &budget, &cancellation).await.map_err(Error::from)
            })).await?;
            Ok(result.value)
        }).await.clone()?;
        self.check(context, cancel, deadline).await?;
        let scoped = ContextRequest { budget: context.budget().limit(), ..request.clone() };
        crate::context::check_result(&scoped, &self.page, &result)?;
        Ok(result)
    }

    async fn check(&self, context: &InvocationContext, cancel: &CancellationToken, deadline: Instant) -> Result<(), Error> {
        if cancel.is_cancelled() || self.cancellation.is_cancelled() {
            return Err(crate::context::Error::from(world_protocol::abstraction::ContextFailure::Cancelled).into());
        }
        if Instant::now() >= deadline.min(self.budget.deadline()).min(context.budget().deadline()) {
            return Err(crate::context::Error::from(world_protocol::abstraction::ContextFailure::BudgetExceeded).into());
        }
        context.check_current().await.map_err(|error| Error::from_host_failure(error.host_failure(), FailureStage::Read).caused(error))
    }

    async fn commit(&self, stage: &str, input: &impl serde::Serialize) -> Result<CommitRequest, Error> {
        let invocation = self.admission.invocation();
        let identity = crate::definitions::canonical_digest(&("world.view.v1", self.admission.restart_identity(), &invocation.replay_id, stage))?;
        crate::owner::execution::prepare_request(&self.store, &invocation.world,
            CommitId::try_new(format!("world-view-{}", &identity.as_str()[7..])).map_err(|_| changed())?,
            crate::definitions::canonical_digest(input)?, &["authorization", "query", "learning"]).await
    }
}

pub(crate) async fn run(
    store: WorldStore, resources: Arc<Resources>, ingress: Arc<ServiceIngress>, signed: SignedRequest,
    envelope: QueryEnvelope, source_access: Result<Arc<dyn SourceAccess>, Arc<SourceError>>, cancel: CancellationToken,
) -> Result<QueryResult, Error> {
    let WorldQuery::WorldView(input) = envelope.query else { return Err(changed()); };
    if input.task.world != envelope.world || input.query.world != envelope.world { return Err(changed()); }
    crate::api::query::validate_query_request(&input.query).map_err(|_| changed())?;
    let batch = operation::batch(&store, &signed.binding).await?;
    let admitted = authorization::commit_admission(&store, batch, move |tx| Box::pin(async move {
        let now = tx.now().await?;
        let mut verified = ingress.authenticate(tx, &signed.token, signed.binding, &now).await?;
        if let Some(branch) = &input.query.branch_id { verified = verified.bind_branch(tx, branch).await?; }
        let task = crate::evaluation::read_task(tx, &input.task.id, input.task.revision).await?;
        if task.world != input.task.world { return Err(changed()); }
        let request = ContextRequest { world: input.task.world, task, query: input.query, budget: input.budget };
        let mut impact = crate::context::impact(tx, &request).await?;
        let query = super::objects::impact_in_transaction(tx, &request.query, &request.task.scope).await?;
        impact.access.extend(query.access); impact.effects.extend(query.effects); impact.labels.extend(query.labels);
        impact.state.extend(query.state); impact.source_ids.extend(query.source_ids);
        let release = crate::query::read_release_in_transaction(tx, &request.query).await?;
        let graph = bindings::read_graph_in_transaction(tx, &release.artifact.activation_lock_id).await?;
        let node = context_node(&graph)?;
        let resources = graph.closure_nodes(&node).map_err(BindingError::from)?.iter()
            .map(|node| graph.node(node).map(|node| ResourceRef::Binding { id: node.binding_id.clone() }))
            .collect::<Result<BTreeSet<_>, _>>().map_err(BindingError::from)?;
        impact.access.push(AccessScope { resources: resources.into_iter().collect(), fields: Vec::new(),
            modes: vec![AccessMode::Execute], scope: request.task.scope.clone(), valid_time: None });
        let impact = authorization::actual_impact(impact.access, impact.effects, impact.labels, impact.state, impact.source_ids)?;
        let admission = authorization::admit(tx, &verified, &impact, &[], None, &now).await?;
        Ok::<_, Error>(((request, node, graph.lock().id.clone(), now), admission))
    })).await?;
    let (request, node, lock, now, admission) = match admitted {
        AdmissionCommit::Committed { outcome, admission } => (outcome.value.0, outcome.value.1, outcome.value.2, outcome.value.3, admission),
        AdmissionCommit::Replayed(_) => return Err(world_protocol::authorization::AuthorizationFailure::Replay.into()),
    };
    let mut limit = super::objects::query_budget(admission.invocation().deadline.clone());
    limit.max_input_tokens = request.budget.max_input_tokens.min(request.task.budget.max_input_tokens);
    let budget = CallBudget::new(limit, &now).map_err(|error| budget_error(error.dimension))?;
    let budget = budget.scoped(&request.task.budget, &now).map_err(|error| budget_error(error.dimension))?
        .scoped(&request.budget, &now).map_err(|error| budget_error(error.dimension))?;
    let pipeline = PipelineContext::silent_in_memory(admission.invocation().id.as_str());
    let page = super::objects::run_admitted_with_budget(store.clone(), resources.clone(), admission.clone(), request.query.clone(),
        source_access.clone(), cancel.clone(), budget.clone(), Some(request.task.scope.clone()), pipeline.clone()).await?;
    if page.receipt.activation_lock_id != lock { return Err(changed()); }
    let lease = Arc::new(resources.live.acquire(&request.world, &lock, &node,
        admission.invocation().id.clone(), now).map_err(|error| Error::from_host_failure(error.host_failure(), FailureStage::Prepare).caused(crate::extensions::invocation::InvocationFailure::Lease(error)))?);
    let result = async {
        let context = InvocationContext::new(Arc::new(store.clone()), admission.clone(), lease.clone(), node, pipeline, budget.clone())
            .map_err(|error| Error::from_host_failure(error.host_failure(), FailureStage::Prepare).caused(error))?;
        let execution = Arc::new(ContextExecution { store: store.clone(), admission: admission.clone(), invocation: context.clone(),
            request: request.clone(), page: page.clone(), budget: budget.clone(), cancellation: cancel.clone(), result: tokio::sync::OnceCell::new() });
        let mut services = crate::owner::InvocationServiceSeed::for_resources(&store, &resources, source_access).for_lease(&lease, None, Vec::new())
            .map_err(|error| Error::from_host_failure(error.host_failure(), FailureStage::Prepare).caused(error))?;
        services.context = Some(Arc::new(crate::learning::investigation::ContextExecution::new_world_view(execution.clone())));
        let expected = request.clone();
        let observed = page.clone();
        let outcome = invoke_composition_checked(context.clone(), SlotRequest::Context(request.clone()), services,
            |_, input| { if input != SlotRequest::Context(expected.clone()) { return Err(invalid()); } Ok(input) },
            |_, input, output| {
                if input != &SlotRequest::Context(expected.clone()) { return Err(invalid()); }
                let SlotResponse::Context(result) = output else { return Err(invalid()); };
                crate::context::check_result(&expected, &observed, result).map_err(|_| invalid())?;
                Ok(None)
            }).await.map_err(composition_error)?;
        let SlotResponse::Context(result) = outcome.result.map_err(|error| Error::from_host_failure(error.host_failure(), FailureStage::Execute).caused(error))?
            else { return Err(changed()); };
        execution.check(&context, &cancel, budget.deadline()).await?;
        let commit = crate::owner::execution::prepare_request(&store, &request.world,
            CommitId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID identifier"),
            crate::definitions::canonical_digest(&(&request, &page, &result))?, &["authorization", "query", "learning"]).await?;
        let checked = result.clone();
        let cancellation = cancel.clone();
        store.transact(commit.prepare()?, move |tx| Box::pin(async move {
            current(tx, &admission, &context).await?;
            crate::context::recheck_result(tx, &admission, &request, &page, &checked, &cancellation).await?;
            Ok::<_, Error>(())
        })).await?;
        Ok(QueryResult::WorldView(result))
    }.await;
    lease.finish();
    result
}

fn context_node(graph: &BindingGraph) -> Result<NodeId, Error> {
    let bindings: BTreeSet<_> = graph.lock().nodes.iter().filter(|node| node.slot == SlotKind::Context)
        .map(|node| node.binding_id.clone()).collect();
    if bindings.len() != 1 { return Err(changed()); }
    graph.composition_order(bindings.iter().next().expect("one Context composition")).map_err(BindingError::from)?.into_iter()
        .find(|node| graph.node(node).is_ok_and(|node| node.slot == SlotKind::Context)).ok_or_else(changed)
}

async fn current(tx: &WorldTransaction<'_>, admission: &Admission, context: &InvocationContext) -> Result<(), Error> {
    for node in &context.lease().closure().nodes {
        check_current_in_transaction(tx, admission, context.lease(), node).await
            .map_err(|error| Error::from_host_failure(error.host_failure(), FailureStage::Read).caused(error))?;
    }
    Ok(())
}

fn changed() -> Error { crate::context::Error::from(world_protocol::abstraction::ContextFailure::BasisChanged).into() }
fn invalid() -> CompositionFailure { CompositionFailure::Slot(world_protocol::slots::SlotFailure::Context(world_protocol::abstraction::ContextFailure::BasisChanged)) }
fn composition_error(error: CompositionFailure) -> Error { Error::from_host_failure(error.host_failure(), FailureStage::Execute).caused(error) }
fn budget_error(dimension: world_protocol::budget::BudgetDimension) -> Error {
    Error::from_host_failure(world_protocol::process::HostFailure::BudgetExceeded { dimension }, FailureStage::Read)
}

async fn task(
    tx: &WorldTransaction<'_>, verified: &VerifiedInvocation, reference: &TaskRef, now: &Timestamp,
) -> Result<Option<TaskContract>, Error> {
    if reference.world != *tx.world() || verified.invocation().world != *tx.world() {
        return Err(world_protocol::authorization::AuthorizationFailure::InsufficientScope.into());
    }
    let revision = i64::try_from(reference.revision.0).map_err(|_| Error::internal(FailureStage::Decode))?;
    if tx.query_opt("SELECT 1 FROM world_task_revision WHERE tenant_id=$1 AND world_id=$2 AND task_id=$3 AND revision=$4",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &reference.id.as_str(), &revision]).await?.is_none() { return Ok(None); }
    let task = crate::evaluation::read_task(tx, &reference.id, reference.revision).await?;
    let impact = authorization::actual_impact(vec![AccessScope {
        resources: vec![ResourceRef::Task { id: task.id.clone() }], fields: Vec::new(),
        modes: vec![AccessMode::Read], scope: task.scope.clone(), valid_time: None,
    }], Vec::new(), Vec::new(), Vec::new(), Vec::new())?;
    let admission = match authorization::admit(tx, verified, &impact, &[], None, now).await {
        Ok(admission) => admission,
        Err(AuthError::Denied(_)) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    authorization::check_output(tx, verified, &admission, &impact, 1, &tx.now().await?).await?;
    Ok(Some(task))
}
