mod catalog;
pub(crate) mod cdc;
mod configuration;
mod configure;
pub(crate) mod discovery;
pub(crate) mod effects;
mod error;
mod http;
mod metadata;
mod ports;
mod postgres;
mod prepared;
mod values;

pub(crate) use catalog::{capabilities, capabilities_impact, connections, connections_impact};
pub(crate) use configure::{configure, configure_impact};
pub use error::SourceError;
pub use ports::{PgReplicationConnection, PgSourceConnection, SourceAccess, SourceCredential, SourceFuture};
pub(crate) use prepared::PreparedSource;
pub(in crate::sources) use values::native_key;

use crate::{
    authorization::Admission,
    extensions::invocation::{
        self, CallBudget, CurrentFailure, InvocationLease, ResourceKind, TaskResource,
    },
    store::WorldStore,
};
use foundation::{execution::OwnedTask, pipeline::PipelineContext};
use std::sync::Arc;
use tokio::{sync::oneshot, time::Instant};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    failure::FailureStage,
    ids::{AcquisitionId, Digest, InvocationId, InvocationLeaseId, NodeId},
    sources::{SourceFailure, SourcePage, SourceReadPlan},
};

/// Only the real broker can attest a captured page; the public DTO cannot do so.
pub(crate) struct ReadSourcePage {
    page: SourcePage,
    connection: world_protocol::sources::ConnectionRevision,
    implementation: world_protocol::bindings::ImplementationRef,
    metadata: metadata::ReadMetadata,
    lease: Arc<InvocationLease>,
    provider: NodeId,
}
impl ReadSourcePage {
    pub(crate) async fn recheck(
        &self,
        tx: &crate::store::WorldTransaction<'_>,
        admission: &Admission,
        now: &world_protocol::time::Timestamp,
    ) -> Result<(), SourceError> {
        invocation::check_current_in_transaction(tx, admission, &self.lease, &self.provider)
            .await
            .map_err(current_error)?;
        metadata::recheck_output(tx, admission, &self.metadata, &self.page, now).await
    }
    pub fn page(&self) -> &SourcePage {
        &self.page
    }
    pub fn connection(&self) -> &world_protocol::sources::ConnectionRevision {
        &self.connection
    }
    pub fn implementation(&self) -> &world_protocol::bindings::ImplementationRef {
        &self.implementation
    }
}

#[derive(Clone)]
pub(crate) struct SourceBroker {
    store: Arc<WorldStore>,
    access: Result<Arc<dyn SourceAccess>, Arc<SourceError>>,
    lease: Arc<InvocationLease>,
    consumer: NodeId,
    provider: NodeId,
    prepared: prepared::SourceEndpoint,
    seed: crate::owner::InvocationServiceSeed,
}
impl SourceBroker {
    pub fn from_lease(
        store: Arc<WorldStore>,
        access: Result<Arc<dyn SourceAccess>, Arc<SourceError>>,
        lease: Arc<InvocationLease>,
        consumer: NodeId,
        seed: crate::owner::InvocationServiceSeed,
    ) -> Result<Self, SourceError> {
        let provider = lease
            .provider(&consumer, "source.read")
            .cloned()
            .ok_or_else(|| {
                SourceError::new(SourceFailure::ProtocolViolation, FailureStage::Prepare)
            })?;
        let prepared = prepared::SourceEndpoint::from_lease(&lease, &provider)?;
        Ok(Self {
            store,
            access,
            lease,
            consumer,
            provider,
            prepared,
            seed,
        })
    }

    pub fn for_provider(
        store: Arc<WorldStore>,
        access: Result<Arc<dyn SourceAccess>, Arc<SourceError>>,
        lease: Arc<InvocationLease>,
        provider: NodeId,
        seed: crate::owner::InvocationServiceSeed,
    ) -> Result<Self, SourceError> {
        let prepared = prepared::SourceEndpoint::from_lease(&lease, &provider)?;
        Ok(Self {
            store,
            access,
            lease,
            consumer: provider.clone(),
            provider,
            prepared,
            seed,
        })
    }

    fn native_access(&self) -> Result<&Arc<dyn SourceAccess>, SourceError> {
        self.access.as_ref().map_err(|cause| {
            SourceError::caused_by(cause.failure.clone(), cause.stage, cause.clone())
        })
    }

    pub fn rebind(&self, consumer: NodeId) -> Result<Option<Self>, SourceError> {
        if self
            .lease
            .graph()
            .node(&consumer)
            .is_ok_and(|node| node.slot == world_protocol::bindings::SlotKind::Connector)
        {
            return Self::for_provider(
                self.store.clone(),
                self.access.clone(),
                self.lease.clone(),
                consumer,
                self.seed.clone(),
            )
            .map(Some);
        }
        if self.lease.provider(&consumer, "source.read").is_none() {
            return Ok(None);
        }
        Self::from_lease(
            self.store.clone(),
            self.access.clone(),
            self.lease.clone(),
            consumer,
            self.seed.clone(),
        )
        .map(Some)
    }

    pub(super) async fn invoke_plugin(
        &self,
        request: world_protocol::slots::SlotRequest,
        admission: &Admission,
        pipeline: &PipelineContext,
        cancel: CancellationToken,
        budget: CallBudget,
    ) -> Result<world_protocol::slots::SlotResponse, SourceError> {
        let progress = pipeline.clone();
        let call_pipeline = PipelineContext::new(
            foundation::pipeline::PipelineRun::new(pipeline.run_id()),
            Arc::new(move |event| progress.emit_progress(event)),
            pipeline.artifacts(),
            pipeline.checkpoints(),
        );
        let context = invocation::InvocationContext::new(
            self.store.clone(),
            admission.clone(),
            self.lease.clone(),
            self.provider.clone(),
            call_pipeline.clone(),
            budget,
        )
        .map_err(current_error)?;
        let services = self
            .seed
            .for_lease(&self.lease, None, Vec::new())
            .map_err(invocation_error)?;
        let call = invocation::invoke_composition(context, request, services);
        tokio::pin!(call);
        let outcome = tokio::select! {
            outcome = &mut call => outcome,
            _ = cancel.cancelled() => {
                call_pipeline.cancel();
                call.await
            },
        }
        .map_err(composition_error)?;
        if outcome.result.is_err() {
            let failure = outcome
                .nodes
                .iter()
                .find_map(|node| node.result.as_ref().err())
                .or_else(|| outcome.result.as_ref().err())
                .expect("failed composition");
            return Err(SourceError::caused_by(
                SourceFailure::PluginInvocation {
                    failure: Box::new(failure.host_failure()),
                },
                FailureStage::Execute,
                CompositionCause(outcome),
            ));
        }
        outcome.result.map_err(composition_error)
    }

    pub(crate) fn provider_id(&self) -> &world_protocol::ids::ProviderId {
        self.prepared.provider()
    }

    pub fn matches_invocation(&self, lease: &InvocationLease, consumer: &NodeId) -> bool {
        self.matches(
            lease.id(),
            lease.invocation(),
            consumer,
            &lease.graph().lock().digest,
        )
    }
    pub fn matches(
        &self,
        lease: &InvocationLeaseId,
        invocation: &InvocationId,
        consumer: &NodeId,
        graph: &Digest,
    ) -> bool {
        self.lease.id() == lease
            && self.lease.invocation() == invocation
            && &self.consumer == consumer
            && &self.lease.graph().lock().digest == graph
    }

    pub(crate) async fn required_read_access(
        &self,
        plan: &SourceReadPlan,
        admission: &Admission,
    ) -> Result<Vec<world_protocol::package::RequestedAccess>, SourceError> {
        let metadata = metadata::read(&self.store, admission, plan, &self.prepared).await?;
        configuration::read_access(&metadata.connection)
    }

    pub async fn read(
        &self,
        plan: SourceReadPlan,
        admission: &Admission,
        pipeline: &PipelineContext,
        cancel: CancellationToken,
        deadline: Instant,
        budget: CallBudget,
    ) -> Result<SourcePage, SourceError> {
        self.read_trusted(plan, admission, pipeline, cancel, deadline, budget)
            .await
            .map(|read| read.page)
    }

    pub async fn read_trusted(
        &self,
        plan: SourceReadPlan,
        admission: &Admission,
        pipeline: &PipelineContext,
        cancel: CancellationToken,
        deadline: Instant,
        budget: CallBudget,
    ) -> Result<ReadSourcePage, SourceError> {
        self.read_trusted_selected(plan, None, admission, pipeline, cancel, deadline, budget)
            .await
    }

    pub(crate) fn read_trusted_selected<'a>(
        &'a self,
        plan: SourceReadPlan,
        branch: Option<&'a world_protocol::releases::BranchRef>,
        admission: &'a Admission,
        pipeline: &'a PipelineContext,
        cancel: CancellationToken,
        deadline: Instant,
        budget: CallBudget,
    ) -> SourceFuture<'a, ReadSourcePage> {
        Box::pin(async move {
            if cancel.is_cancelled() || pipeline.is_cancelled() {
                return Err(cancelled());
            }
            if self.prepared.driver() != prepared::Driver::Plugin {
                budget
                    .charge(world_protocol::budget::BudgetDimension::SourceReads, 1)
                    .map_err(budget_error)?;
            }
            let deadline = deadline.min(budget.deadline());
            if Instant::now() >= deadline {
                return Err(SourceError::new(
                    SourceFailure::ReadTimeout,
                    FailureStage::Read,
                ));
            }
            let missing = || {
                lease_error(invocation::LeaseFailure::MissingGeneration(
                    self.provider.clone(),
                ))
            };
            let ledger = self.lease.ledger(&self.provider).ok_or_else(missing)?;
            let spec = self
                .lease
                .resource_spec(&self.provider, ResourceKind::HostIo)
                .ok_or_else(missing)?;
            let ticket = ledger
                .begin_acquisition(
                    AcquisitionId::try_new(uuid::Uuid::new_v4().to_string())
                        .expect("UUID acquisition"),
                    spec,
                )
                .map_err(|error| lease_error(invocation::LeaseFailure::Admission(error)))?;
            let ledger_cancel = ticket.cancellation().clone();
            let pipeline_cancel = pipeline.cancellation();
            let broker = self.clone();
            let pipeline = pipeline.clone();
            let branch = branch.cloned();
            let admission = admission.clone();
            let permit = if self.prepared.driver() == prepared::Driver::Plugin {
                None
            } else {
                match self.lease.try_call(&self.provider) {
                    Ok(permit) => Some(permit),
                    Err(error) => {
                        ticket.fail();
                        return Err(lease_error(error));
                    }
                }
            };
            let (send, receive) = oneshot::channel();
            let (task, _) = OwnedTask::spawn(move |task_cancel| async move {
                let work_cancel = CancellationToken::new();
                let work = broker.read_page(
                    &plan,
                    branch.as_ref(),
                    &admission,
                    &pipeline,
                    &work_cancel,
                    deadline,
                    &budget,
                );
                tokio::pin!(work);
                enum Interruption {
                    Cancelled,
                    Deadline,
                }
                let result = 'result: {
                    let cause = tokio::select! {
                        result = &mut work => break 'result result,
                        _ = cancel.cancelled() => Interruption::Cancelled,
                        _ = pipeline_cancel.cancelled() => Interruption::Cancelled,
                        _ = ledger_cancel.cancelled() => Interruption::Cancelled,
                        _ = task_cancel.cancelled() => Interruption::Cancelled,
                        _ = tokio::time::sleep_until(deadline) => Interruption::Deadline,
                    };
                    work_cancel.cancel();
                    let result = work.await;
                    let reason = match cause {
                        Interruption::Cancelled => cancelled(),
                        Interruption::Deadline => {
                            SourceError::new(SourceFailure::ReadTimeout, FailureStage::Read)
                        }
                    };
                    Err(interrupted(result, reason))
                };
                let _ = send.send(result);
            });
            let resource = TaskResource::new(task, |()| Ok(()));
            let resource = match permit {
                Some(permit) => resource.with_permit(permit),
                None => resource,
            };
            let acquired = ticket.complete(Box::new(resource));
            let mut registration = acquired.registration;
            let result = receive
                .await
                .map_err(|cause| {
                    SourceError::caused_by(
                        SourceFailure::InternalFault,
                        FailureStage::Execute,
                        cause,
                    )
                })
                .and_then(|result| result);
            if let Err(cleanup) = registration.close_checked(deadline).await {
                return Err(SourceError::cleanup(
                    result.err(),
                    cleanup.code,
                    cleanup.into(),
                ));
            }
            result
        })
    }

    #[inline(never)]
    fn read_page<'a>(
        &'a self,
        plan: &'a SourceReadPlan,
        branch: Option<&'a world_protocol::releases::BranchRef>,
        admission: &'a Admission,
        pipeline: &'a PipelineContext,
        work_cancel: &'a CancellationToken,
        deadline: Instant,
        budget: &'a CallBudget,
    ) -> SourceFuture<'a, ReadSourcePage> {
        Box::pin(async move {
            invocation::check_current(&self.store, admission, &self.lease, &self.provider)
                .await
                .map_err(current_error)?;
            let metadata = match branch {
                Some(branch) => {
                    metadata::read_branch(&self.store, admission, plan, &self.prepared, branch).await?
                }
                None => metadata::read(&self.store, admission, plan, &self.prepared).await?,
            };
            let page = if self.prepared.driver() == prepared::Driver::Plugin {
                let plugin_plan = metadata::plugin_read_plan(&metadata, plan)?;
                let response = self
                    .invoke_plugin(
                        world_protocol::slots::SlotRequest::Connector(plugin_plan.clone()),
                        admission,
                        pipeline,
                        work_cancel.clone(),
                        budget.clone(),
                    )
                    .await?;
                let world_protocol::slots::SlotResponse::Connector(mut page) = response else {
                    return Err(values::invalid_response("slotResult"));
                };
                metadata::validate_plugin_page(&metadata, &plugin_plan, &page)?;
                for row in &mut page.rows {
                    row.fields
                        .retain(|field| plan.fields.iter().any(|id| id == field.id.as_str()));
                }
                page
            } else {
                let access = self.access.as_ref().map_err(|cause| {
                    SourceError::caused_by(cause.failure.clone(), cause.stage, cause.clone())
                })?;
                let credential = access
                    .credentials(
                        &metadata.connection.world,
                        &metadata.connection.id,
                        metadata.connection.revision,
                        work_cancel.clone(),
                        deadline,
                    )
                    .await?;
                match self.prepared.driver() {
                    prepared::Driver::Postgres => {
                        postgres::read(
                            access,
                            &metadata,
                            plan,
                            credential,
                            work_cancel.clone(),
                            deadline,
                            budget,
                        )
                        .await?
                    }
                    prepared::Driver::HttpJson => {
                        http::read(
                            &metadata,
                            plan,
                            credential,
                            work_cancel.clone(),
                            deadline,
                            budget,
                        )
                        .await?
                    }
                    prepared::Driver::Plugin => unreachable!("plugin dispatched above"),
                }
            };
            invocation::check_current(&self.store, admission, &self.lease, &self.provider)
                .await
                .map_err(current_error)?;
            metadata::check_output(&self.store, admission, &metadata, &page).await?;
            Ok(ReadSourcePage {
                page,
                connection: metadata.connection.clone(),
                implementation: self.prepared.implementation().clone(),
                metadata,
                lease: self.lease.clone(),
                provider: self.provider.clone(),
            })
        })
    }
}

struct CompositionCause(invocation::CompositionOutcome);
impl std::fmt::Debug for CompositionCause {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SourceComposition")
            .field("binding", &self.0.binding)
            .finish_non_exhaustive()
    }
}
impl std::fmt::Display for CompositionCause {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("world.source_composition_failed")
    }
}
impl std::error::Error for CompositionCause {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.0
            .nodes
            .iter()
            .find_map(|node| node.result.as_ref().err())
            .or_else(|| self.0.result.as_ref().err())
            .map(|cause| cause as _)
    }
}

fn invocation_error(error: invocation::InvocationFailure) -> SourceError {
    SourceError::caused_by(
        SourceFailure::PluginInvocation {
            failure: Box::new(error.host_failure()),
        },
        FailureStage::Execute,
        error,
    )
}

fn composition_error(error: invocation::CompositionFailure) -> SourceError {
    SourceError::caused_by(
        SourceFailure::PluginInvocation {
            failure: Box::new(error.host_failure()),
        },
        FailureStage::Execute,
        error,
    )
}

fn budget_error(error: invocation::BudgetFailure) -> SourceError {
    SourceError::new(
        SourceFailure::BudgetExceeded {
            dimension: error.dimension,
        },
        FailureStage::Read,
    )
}
fn interrupted<T>(result: Result<T, SourceError>, reason: SourceError) -> SourceError {
    match result {
        Err(error) if matches!(error.failure, SourceFailure::Cancelled) => {
            SourceError::caused_by(reason.failure, reason.stage, error)
        }
        Err(error) => error,
        Ok(_) => reason,
    }
}
fn cancelled() -> SourceError {
    SourceError::new(SourceFailure::Cancelled, FailureStage::Read)
}
fn current_error(error: CurrentFailure) -> SourceError {
    match error {
        CurrentFailure::Authorization(error) => error.into(),
        CurrentFailure::Store(error) => error.into(),
        CurrentFailure::Binding(failure) => {
            SourceError::new(SourceFailure::Binding { failure }, FailureStage::Admission)
        }
        CurrentFailure::Package(error) => error.into(),
    }
}
pub(crate) fn lease_error(error: invocation::LeaseFailure) -> SourceError {
    use world_protocol::{operation::OperationFailure, process::HostFailure};
    let failure = match error.host_failure() {
        HostFailure::Binding(failure) => SourceFailure::Binding { failure },
        HostFailure::Operation(OperationFailure::Lifecycle(failure)) => {
            SourceFailure::Lifecycle { failure }
        }
        failure => SourceFailure::PluginInvocation {
            failure: Box::new(failure),
        },
    };
    SourceError::caused_by(failure, FailureStage::Admission, LeaseCause(error))
}
#[derive(Debug)]
struct LeaseCause(invocation::LeaseFailure);
impl std::fmt::Display for LeaseCause {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "world.source_lease_failed: {:?}", self.0)
    }
}
impl std::error::Error for LeaseCause {}
