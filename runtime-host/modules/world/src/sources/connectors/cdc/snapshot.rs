use super::super::{ReadSourcePage, SourceBroker, SourceError, metadata};
use crate::{
    authorization::Admission,
    extensions::invocation::{
        self, CallBudget, Registration, ResourceFailure, ResourceKind, ResourceStage, TaskResource,
    },
};
use foundation::{execution::OwnedTask, pipeline::PipelineContext};
use tokio::{sync::mpsc, time::Instant};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    failure::FailureStage,
    ids::AcquisitionId,
    sources::{SourceConnectionConfig, SourceFailure, SourcePage, SourceReadPlan},
};

/// The ledger owns the task and the actual PostgreSQL connection until checked cleanup.
pub(crate) struct SourceSnapshot {
    receiver: mpsc::Receiver<Result<ReadSourcePage, SourceError>>,
    registration: Registration,
    cancellation: CancellationToken,
    finished: bool,
}
impl SourceSnapshot {
    pub(crate) async fn next_trusted(&mut self) -> Result<Option<ReadSourcePage>, SourceError> {
        if self.finished {
            return Ok(None);
        }
        match self.receiver.recv().await {
            Some(Ok(page)) => Ok(Some(page)),
            Some(Err(error)) => Err(error),
            None => {
                self.finished = true;
                Ok(None)
            }
        }
    }
    pub(crate) async fn collect_trusted(
        &mut self,
        deadline: Instant,
    ) -> Result<ReadSourcePage, SourceError> {
        let result = async {
            let mut result: Option<ReadSourcePage> = None;
            while let Some(page) = self.next_trusted().await? {
                if let Some(all) = &mut result {
                    if all.connection != page.connection
                        || all.implementation != page.implementation
                        || all.page.basis != page.page.basis
                    {
                        return Err(super::super::values::invalid_response("snapshotBasis"));
                    }
                    all.page.rows.extend(page.page.rows);
                    all.page.complete = page.page.complete;
                    all.page.continuation = page.page.continuation;
                } else {
                    result = Some(page);
                }
            }
            let page = result.ok_or_else(|| super::super::values::invalid_response("snapshot"))?;
            if !page.page.complete
                || page.page.continuation.is_some()
                || page.page.basis.gap.is_some()
            {
                return Err(super::super::values::invalid_response("snapshotCoverage"));
            }
            Ok(page)
        }
        .await;
        if let Err(cleanup) = self.close(deadline).await {
            return Err(SourceError::cleanup(
                result.err(),
                "source.snapshot_close",
                cleanup,
            ));
        }
        result
    }
    pub(crate) async fn close(&mut self, deadline: Instant) -> Result<(), SourceError> {
        self.cancellation.cancel();
        self.receiver.close();
        self.registration
            .close_checked(deadline)
            .await
            .map_err(SourceError::from)
    }
}
impl Drop for SourceSnapshot {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}

impl SourceBroker {
    pub(crate) async fn open_snapshot(
        &self,
        plan: SourceReadPlan,
        admission: &Admission,
        pipeline: &PipelineContext,
        cancel: CancellationToken,
        deadline: Instant,
        budget: CallBudget,
    ) -> Result<SourceSnapshot, SourceError> {
        self.open_snapshot_in(plan, None, None, admission, pipeline, cancel, deadline, budget)
            .await
    }

    pub(in crate::sources) async fn open_sync_snapshot(
        &self, plan: SourceReadPlan, assignment: crate::sources::sync::Assignment,
        admission: &Admission, pipeline: &PipelineContext, cancel: CancellationToken,
        deadline: Instant, budget: CallBudget,
    ) -> Result<SourceSnapshot, SourceError> {
        self.open_snapshot_in(plan, None, Some(assignment), admission, pipeline, cancel, deadline, budget).await
    }

    pub(crate) async fn open_branch_snapshot(
        &self,
        plan: SourceReadPlan,
        branch: &world_protocol::releases::BranchRef,
        admission: &Admission,
        pipeline: &PipelineContext,
        cancel: CancellationToken,
        deadline: Instant,
        budget: CallBudget,
    ) -> Result<SourceSnapshot, SourceError> {
        self.open_snapshot_in(
            plan,
            Some(branch),
            None,
            admission,
            pipeline,
            cancel,
            deadline,
            budget,
        )
        .await
    }

    async fn open_snapshot_in(
        &self,
        plan: SourceReadPlan,
        branch: Option<&world_protocol::releases::BranchRef>,
        assignment: Option<crate::sources::sync::Assignment>,
        admission: &Admission,
        pipeline: &PipelineContext,
        cancel: CancellationToken,
        deadline: Instant,
        budget: CallBudget,
    ) -> Result<SourceSnapshot, SourceError> {
        if plan.continuation.is_some() || plan.as_of.is_some() {
            return Err(SourceError::new(
                SourceFailure::HistoryUnavailable,
                FailureStage::Read,
            ));
        }
        invocation::check_current(&self.store, admission, &self.lease, &self.provider)
            .await
            .map_err(super::super::current_error)?;
        let metadata = match branch {
            Some(branch) => {
                metadata::read_branch(&self.store, admission, &plan, &self.prepared, branch).await?
            }
            None => metadata::read(&self.store, admission, &plan, &self.prepared).await?,
        };
        let ledger = self
            .lease
            .ledger(&self.provider)
            .ok_or_else(super::super::cancelled)?;
        let spec = self
            .lease
            .resource_spec(&self.provider, ResourceKind::HostIo)
            .ok_or_else(super::super::cancelled)?;
        let ticket = ledger
            .begin_acquisition(
                AcquisitionId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID acquisition"),
                spec,
            )
            .map_err(|_| super::super::cancelled())?;
        let ledger_cancel = ticket.cancellation().clone();
        let permit = if self.prepared.driver() == super::super::prepared::Driver::Plugin {
            None
        } else {
            match self.lease.try_call(&self.provider) {
                Ok(permit) => Some(permit),
                Err(error) => {
                    ticket.fail();
                    return Err(super::super::lease_error(error));
                }
            }
        };
        let broker = self.clone_for_cdc();
        let admission = admission.clone();
        let pipeline_cancel = pipeline.cancellation();
        let pipeline = pipeline.clone();
        let branch = branch.cloned();
        let cancellation = CancellationToken::new();
        let worker_cancel = cancellation.clone();
        let deadline = deadline.min(budget.deadline());
        let (send, receiver) = mpsc::channel(1);
        let (task, _) = OwnedTask::spawn(move |task_cancel| async move {
            let io_cancel = CancellationToken::new();
            let work = async {
                if matches!(
                    &metadata.connection.config,
                    SourceConnectionConfig::Plugin(_)
                ) {
                    let mut next = plan.clone();
                    let mut continuations = std::collections::BTreeSet::new();
                    loop {
                        budget.check().map_err(super::super::budget_error)?;
                        let page = broker
                            .read_trusted_selected(
                                next.clone(),
                                branch.as_ref(),
                                &admission,
                                &pipeline,
                                io_cancel.clone(),
                                deadline,
                                budget.clone(),
                            )
                            .await?;
                        let continuation = page.page().continuation.clone();
                        let complete = page.page().complete;
                        if complete != continuation.is_none() {
                            return Err(super::super::values::invalid_response("snapshotCoverage"));
                        }
                        tokio::select! { sent = send.send(Ok(page)) => sent.map_err(|_| super::super::cancelled())?, _ = io_cancel.cancelled() => return Err(super::super::cancelled()) }
                        let Some(continuation) = continuation else {
                            return Ok(());
                        };
                        if !continuations.insert(continuation.clone()) {
                            return Err(super::super::values::invalid_response("continuation"));
                        }
                        next.continuation = Some(continuation);
                    }
                }
                let credential = broker
                    .native_access()?
                    .credentials(
                        &metadata.connection.world,
                        &metadata.connection.id,
                        metadata.connection.revision,
                        io_cancel.clone(),
                        deadline,
                    )
                    .await?;
                match &metadata.connection.config {
                    SourceConnectionConfig::Postgres(_) => {
                        super::postgres_snapshot::run(
                            &broker,
                            &metadata,
                            &plan,
                            assignment.as_ref(),
                            &admission,
                            credential,
                            &budget,
                            &send,
                            io_cancel.clone(),
                            deadline,
                        )
                        .await
                    }
                    SourceConnectionConfig::HttpJson(_) => {
                        budget
                            .charge(world_protocol::budget::BudgetDimension::SourceReads, 1)
                            .map_err(super::super::budget_error)?;
                        let page = super::super::http::read(
                            &metadata,
                            &plan,
                            credential,
                            io_cancel.clone(),
                            deadline,
                            &budget,
                        )
                        .await?;
                        deliver(
                            &broker, &metadata, &admission, &budget, &send, page, &io_cancel,
                        )
                        .await
                    }
                    SourceConnectionConfig::Plugin(_) => unreachable!("plugin dispatched above"),
                }
            };
            tokio::pin!(work);
            let result = tokio::select! {
                result = &mut work => result,
                _ = cancel.cancelled() => { io_cancel.cancel(); Err(super::super::interrupted(work.await, super::super::cancelled())) },
                _ = pipeline_cancel.cancelled() => { io_cancel.cancel(); Err(super::super::interrupted(work.await, super::super::cancelled())) },
                _ = worker_cancel.cancelled() => { io_cancel.cancel(); Err(super::super::interrupted(work.await, super::super::cancelled())) },
                _ = ledger_cancel.cancelled() => { io_cancel.cancel(); Err(super::super::interrupted(work.await, super::super::cancelled())) },
                _ = task_cancel.cancelled() => { io_cancel.cancel(); Err(super::super::interrupted(work.await, super::super::cancelled())) },
                _ = tokio::time::sleep_until(deadline) => { io_cancel.cancel(); Err(super::super::interrupted(work.await, SourceError::new(SourceFailure::ReadTimeout, world_protocol::failure::FailureStage::Read))) },
            };
            if let Err(error) = result {
                let failed_cleanup = matches!(error.failure, SourceFailure::Cleanup { .. });
                tokio::select! {
                    _ = send.send(Err(error)) => {},
                    _ = io_cancel.cancelled() => {},
                    _ = worker_cancel.cancelled() => {},
                }
                if failed_cleanup {
                    return Err(ResourceFailure::new(
                        ResourceStage::Cleanup,
                        "source.snapshot_cleanup",
                        "source snapshot cleanup did not settle",
                    ));
                }
            }
            Ok(())
        });
        let resource = TaskResource::new(task, |result| result);
        let resource = match permit {
            Some(permit) => resource.with_permit(permit),
            None => resource,
        };
        let registration = ticket.complete(Box::new(resource)).registration;
        Ok(SourceSnapshot {
            receiver,
            registration,
            cancellation,
            finished: false,
        })
    }
}

struct ByteCounter(u64);
impl std::io::Write for ByteCounter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 = self
            .0
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| std::io::Error::other("source snapshot byte count overflow"))?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub(super) async fn deliver(
    broker: &SourceBroker,
    metadata: &metadata::ReadMetadata,
    admission: &Admission,
    budget: &CallBudget,
    send: &mpsc::Sender<Result<ReadSourcePage, SourceError>>,
    page: SourcePage,
    cancel: &CancellationToken,
) -> Result<(), SourceError> {
    if matches!(
        &metadata.connection.config,
        SourceConnectionConfig::Postgres(_)
    ) {
        budget
            .charge(
                world_protocol::budget::BudgetDimension::Rows,
                page.rows.len() as u64,
            )
            .map_err(super::super::budget_error)?;
        let mut bytes = ByteCounter(0);
        serde_json::to_writer(&mut bytes, &page).map_err(|cause| {
            SourceError::caused_by(SourceFailure::InternalFault, FailureStage::Read, cause)
        })?;
        budget
            .charge(world_protocol::budget::BudgetDimension::Bytes, bytes.0)
            .map_err(super::super::budget_error)?;
    }
    invocation::check_current(&broker.store, admission, &broker.lease, &broker.provider)
        .await
        .map_err(super::super::current_error)?;
    metadata::check_output(&broker.store, admission, metadata, &page).await?;
    tokio::select! { result = send.send(Ok(ReadSourcePage { page, connection: metadata.connection.clone(), implementation: broker.prepared.implementation().clone(), metadata: metadata.clone(), lease: broker.lease.clone(), provider: broker.provider.clone() })) => result.map_err(|_| super::super::cancelled()), _ = cancel.cancelled() => Err(super::super::cancelled()) }
}
