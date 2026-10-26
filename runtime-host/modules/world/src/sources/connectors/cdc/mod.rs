mod http;
mod postgres;
mod postgres_snapshot;
mod prepare;
mod snapshot;

pub(in crate::sources) fn require_position_after(
    at: &world_protocol::sources::SourcePosition,
    before: &world_protocol::sources::SourcePosition,
) -> Result<(), super::SourceError> {
    let incomparable = || {
        super::SourceError::new(
            world_protocol::sources::SourceFailure::PositionIncomparable,
            world_protocol::failure::FailureStage::Validate,
        )
    };
    if at.source_id != before.source_id
        || at.incarnation != before.incarnation
        || at.partition != before.partition
        || at.format != before.format
    {
        return Err(incomparable());
    }
    if at == before {
        return Ok(());
    }
    if at.format.as_str() != "postgres.wal2json.v2" {
        return Err(incomparable());
    }
    let current = postgres::parse_lsn(&at.cursor)?;
    let previous = postgres::parse_lsn(&before.cursor)?;
    if current > previous
        || current == previous
            && at.transaction == before.transaction
            && matches!((at.event_index, before.event_index), (Some(a), Some(b)) if a >= b)
    {
        Ok(())
    } else {
        Err(incomparable())
    }
}
pub(crate) use prepare::SyncPreparation;
pub(crate) use snapshot::SourceSnapshot;
pub(in crate::sources) use postgres::NativeSourceFence;

use super::{
    SourceBroker, SourceError,
    metadata::{self, ReadMetadata},
};
use crate::{
    authorization::Admission,
    content::Content,
    extensions::invocation::{self, CallBudget, ResourceKind, TaskResource},
    sources::sync::{
        AppliedAck, Assignment, CaptureKind, PreparedCapture, SyncError, SyncIdentity,
    },
};
use foundation::execution::OwnedTask;
use std::sync::Arc;
use tokio::{sync::oneshot, time::Instant};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    budget::BudgetDimension,
    failure::FailureStage,
    ids::*,
    sources::*,
    time::{Timestamp, ValidTime},
};

/// Native I/O attestation, not a deserializable change-stream DTO.
pub(crate) struct ReadChanges {
    metadata: ReadMetadata,
    implementation: world_protocol::bindings::ImplementationRef,
    batch: OrderedSourceBatch,
    raw: Vec<u8>,
    observed_at: Timestamp,
}
pub(crate) struct Acknowledged {
    assignment: Assignment,
    position: SourcePosition,
    sequence: u64,
}
impl Acknowledged {
    pub(crate) fn assignment(&self) -> &Assignment {
        &self.assignment
    }
    pub(crate) fn position(&self) -> &SourcePosition {
        &self.position
    }
    pub(crate) fn sequence(&self) -> u64 {
        self.sequence
    }
}
impl ReadChanges {
    pub(crate) fn batch(&self) -> &OrderedSourceBatch {
        &self.batch
    }
    pub(crate) fn prepare_capture(
        &self,
        content: &Content,
        a: &Assignment,
        identity: &SyncIdentity,
        cancel: &CancellationToken,
    ) -> Result<Vec<PreparedCapture>, SyncError> {
        let mut captures = Vec::new();
        let mut start = 0;
        for (index, event) in self.batch.events.iter().enumerate() {
            if matches!(event.change, SourceChange::TransactionEnd { .. }) {
                captures.push(self.capture_slice(
                    content,
                    a,
                    identity,
                    cancel,
                    &self.batch.events[start..=index],
                    true,
                )?);
                start = index + 1;
            }
        }
        if start < self.batch.events.len() {
            captures.push(self.capture_slice(
                content,
                a,
                identity,
                cancel,
                &self.batch.events[start..],
                self.batch.transaction_complete,
            )?);
        }
        Ok(captures)
    }
    fn capture_slice(
        &self,
        content: &Content,
        a: &Assignment,
        identity: &SyncIdentity,
        cancel: &CancellationToken,
        events: &[SourceEvent],
        complete: bool,
    ) -> Result<PreparedCapture, SyncError> {
        let last = events.last().ok_or_else(SyncError::protocol)?;
        let observed = last.occurred_at.as_ref().unwrap_or(&self.observed_at);
        if self.batch.binding != a.binding
            || self.batch.epoch != a.epoch
            || self.metadata.connection.id != a.connection_id
            || self.metadata.connection.revision != a.connection_revision
            || self.implementation != a.implementation
        {
            return Err(SyncError::protocol());
        }
        let mut rows = Vec::new();
        let mut deletions = Vec::new();
        for event in events {
            if event.position.transaction != last.position.transaction {
                return Err(SyncError::protocol());
            }
            match &event.change {
                SourceChange::Upsert { row } => {
                    rows.retain(|r: &SourceRow| r.native_key != row.native_key);
                    rows.push(row.clone());
                }
                SourceChange::Delete {
                    native_key,
                    incarnation,
                } => {
                    rows.retain(|r| &r.native_key != native_key);
                    // Close the pre-transaction incarnation before materializing the final row.
                    if !deletions.iter().any(|(key, _)| key == native_key) {
                        deletions.push((native_key.clone(), incarnation.clone()));
                    }
                }
                SourceChange::SchemaChanged { .. } => {
                    return Err(world_protocol::sources::MappingFailure::RevisionMismatch.into());
                }
                SourceChange::TransactionEnd { transaction } => {
                    if event.position.transaction.as_ref() != Some(transaction) {
                        return Err(SyncError::protocol());
                    }
                }
            }
        }
        let binding = &self.metadata.binding.body;
        let page = SourcePage {
            rows,
            basis: SourceBasis {
                source_id: a.source_id.clone(),
                incarnation: a.incarnation.clone(),
                binding: a.binding.clone(),
                mapping_revision: a.mapping.revision,
                authority_revision: binding.authority.revision,
                schema: a.schema.clone(),
                identity_rule: a.identity_rule.clone(),
                field_definitions: binding
                    .field_mapping
                    .iter()
                    .map(|f| f.property.clone())
                    .collect(),
                position: Some(last.position.clone()),
                snapshot: None,
                observed_at: observed.clone(),
                captured_at: Some(observed.clone()),
                last_reconciled_at: None,
                guarantee: SourceGuarantee::Authoritative,
                gap: None,
            },
            continuation: None,
            complete,
        };
        let valid =
            ValidTime::try_new(observed.clone(), None).map_err(|_| SyncError::protocol())?;
        PreparedCapture::prepare_native(
            content,
            a,
            page,
            deletions,
            identity,
            valid,
            CaptureKind::Changes {
                transaction: last.position.transaction.clone(),
                complete,
            },
            last.position.clone(),
            self.raw.clone(),
            cancel,
        )
    }
}
impl SourceBroker {
    pub(crate) async fn has_ack_channel(
        &self,
        plan: &SourceReadPlan,
        admission: &Admission,
    ) -> Result<bool, SourceError> {
        let metadata = metadata::read(&self.store, admission, plan, &self.prepared).await?;
        Ok(match &metadata.connection.config {
            SourceConnectionConfig::Postgres(config) => config.logical.is_some(),
            SourceConnectionConfig::HttpJson(config) => config
                .changes
                .as_ref()
                .is_some_and(|feed| feed.ack_path.is_some()),
            SourceConnectionConfig::Plugin(_) => return Err(missing()),
        })
    }
    pub(crate) async fn changes_trusted(
        &self,
        plan: SourceReadPlan,
        a: Assignment,
        admission: &Admission,
        cancel: CancellationToken,
        deadline: Instant,
        budget: CallBudget,
    ) -> Result<ReadChanges, SourceError> {
        let broker = self.clone_for_cdc();
        let admission = admission.clone();
        let deadline = deadline.min(budget.deadline());
        budget
            .charge(BudgetDimension::SourceReads, 1)
            .map_err(super::budget_error)?;
        self.cdc_task(cancel, deadline, move |work_cancel| {
            Box::pin(async move {
                invocation::check_current(
                    &broker.store,
                    &admission,
                    &broker.lease,
                    &broker.provider,
                )
                .await
                .map_err(super::current_error)?;
                let metadata =
                    metadata::read(&broker.store, &admission, &plan, &broker.prepared).await?;
                validate_assignment(&broker, &metadata, &a)?;
                if matches!(
                    metadata.binding.body.capabilities.change_stream,
                    ChangeStreamCapability::None
                ) {
                    return Err(missing());
                }
                if broker.prepared.driver() == super::prepared::Driver::Plugin {
                    return Err(missing());
                }
                let access = broker.native_access()?.clone();
                let credential = access
                    .credentials(
                        &metadata.connection.world,
                        &metadata.connection.id,
                        metadata.connection.revision,
                        work_cancel.clone(),
                        deadline,
                    )
                    .await?;
                let (batch, raw, observed_at) = match &metadata.connection.config {
                    SourceConnectionConfig::Postgres(_) => {
                        postgres::read(
                            &broker,
                            &admission,
                            &access,
                            &metadata,
                            &plan,
                            &a,
                            credential,
                            work_cancel,
                            deadline,
                        )
                        .await?
                    }
                    SourceConnectionConfig::HttpJson(_) => {
                        http::read(&metadata, &plan, &a, credential, work_cancel, deadline).await?
                    }
                    SourceConnectionConfig::Plugin(_) => return Err(missing()),
                };
                budget
                    .charge(BudgetDimension::Rows, batch.events.len() as u64)
                    .map_err(super::budget_error)?;
                budget
                    .charge(BudgetDimension::Bytes, raw.len() as u64)
                    .map_err(super::budget_error)?;
                invocation::check_current(
                    &broker.store,
                    &admission,
                    &broker.lease,
                    &broker.provider,
                )
                .await
                .map_err(super::current_error)?;
                let page = SourcePage {
                    rows: batch
                        .events
                        .iter()
                        .filter_map(|e| {
                            if let SourceChange::Upsert { row } = &e.change {
                                Some(row.clone())
                            } else {
                                None
                            }
                        })
                        .collect(),
                    basis: source_basis(&metadata, &observed_at),
                    continuation: None,
                    complete: batch.transaction_complete,
                };
                metadata::check_output(&broker.store, &admission, &metadata, &page).await?;
                Ok(ReadChanges {
                    metadata,
                    implementation: broker.prepared.implementation().clone(),
                    batch,
                    raw,
                    observed_at,
                })
            })
        })
        .await
    }
    pub(crate) async fn acknowledge_applied(
        &self,
        plan: SourceReadPlan,
        proof: AppliedAck,
        admission: &Admission,
        cancel: CancellationToken,
        deadline: Instant,
        budget: CallBudget,
    ) -> Result<Acknowledged, SourceError> {
        let broker = self.clone_for_cdc();
        let admission = admission.clone();
        let deadline = deadline.min(budget.deadline());
        self.cdc_task(cancel, deadline, move |work_cancel| {
            Box::pin(async move {
                budget.check().map_err(super::budget_error)?;
                invocation::check_current(
                    &broker.store,
                    &admission,
                    &broker.lease,
                    &broker.provider,
                )
                .await
                .map_err(super::current_error)?;
                let metadata =
                    metadata::read(&broker.store, &admission, &plan, &broker.prepared).await?;
                validate_assignment(&broker, &metadata, proof.assignment())?;
                if broker.prepared.driver() == super::prepared::Driver::Plugin {
                    return Err(missing());
                }
                let access = broker.native_access()?.clone();
                let credential = access
                    .credentials(
                        &metadata.connection.world,
                        &metadata.connection.id,
                        metadata.connection.revision,
                        work_cancel.clone(),
                        deadline,
                    )
                    .await?;
                match &metadata.connection.config {
                    SourceConnectionConfig::Postgres(_) => {
                        postgres::ack(
                            &broker,
                            &admission,
                            &access,
                            &metadata,
                            proof.assignment(),
                            proof.position(),
                            credential,
                            work_cancel,
                            deadline,
                        )
                        .await?
                    }
                    SourceConnectionConfig::HttpJson(_) => {
                        http::ack(
                            &metadata,
                            proof.position(),
                            credential,
                            work_cancel,
                            deadline,
                        )
                        .await?
                    }
                    SourceConnectionConfig::Plugin(_) => return Err(missing()),
                }
                invocation::check_current(
                    &broker.store,
                    &admission,
                    &broker.lease,
                    &broker.provider,
                )
                .await
                .map_err(super::current_error)?;
                Ok(Acknowledged {
                    assignment: proof.assignment().clone(),
                    position: proof.position().clone(),
                    sequence: proof.sequence(),
                })
            })
        })
        .await
    }
    fn clone_for_cdc(&self) -> Arc<SourceBroker> {
        Arc::new(SourceBroker {
            store: self.store.clone(),
            access: self.access.clone(),
            lease: self.lease.clone(),
            consumer: self.consumer.clone(),
            provider: self.provider.clone(),
            prepared: self.prepared.clone(),
            seed: self.seed.clone(),
        })
    }
    pub(super) async fn cdc_task<T: Send + 'static>(
        &self,
        cancel: CancellationToken,
        deadline: Instant,
        work: impl FnOnce(
            CancellationToken,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<T, SourceError>> + Send>,
        > + Send
        + 'static,
    ) -> Result<T, SourceError> {
        let ledger = self
            .lease
            .ledger(&self.provider)
            .ok_or_else(super::cancelled)?;
        let spec = self
            .lease
            .resource_spec(&self.provider, ResourceKind::HostIo)
            .ok_or_else(super::cancelled)?;
        let ticket = ledger
            .begin_acquisition(
                AcquisitionId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID acquisition"),
                spec,
            )
            .map_err(|_| super::cancelled())?;
        let ledger_cancel = ticket.cancellation().clone();
        let permit = if self.prepared.driver() == super::prepared::Driver::Plugin {
            None
        } else {
            match self.lease.try_call(&self.provider) {
                Ok(p) => Some(p),
                Err(e) => {
                    ticket.fail();
                    return Err(super::lease_error(e));
                }
            }
        };
        let (send, recv) = oneshot::channel();
        let (task, _) = OwnedTask::spawn(move |task_cancel| async move {
            let work_cancel = CancellationToken::new();
            let future = work(work_cancel.clone());
            tokio::pin!(future);
            let result = tokio::select! { result = &mut future => result,
                _ = cancel.cancelled() => { work_cancel.cancel(); Err(super::interrupted(future.await, super::cancelled())) },
                _ = ledger_cancel.cancelled() => { work_cancel.cancel(); Err(super::interrupted(future.await, super::cancelled())) },
                _ = task_cancel.cancelled() => { work_cancel.cancel(); Err(super::interrupted(future.await, super::cancelled())) },
                _ = tokio::time::sleep_until(deadline) => { work_cancel.cancel(); Err(super::interrupted(future.await, SourceError::new(SourceFailure::ReadTimeout, FailureStage::Read))) },
            };
            let _ = send.send(result);
        });
        let resource = TaskResource::new(task, |()| Ok(()));
        let resource = match permit {
            Some(permit) => resource.with_permit(permit),
            None => resource,
        };
        let mut registration = ticket.complete(Box::new(resource)).registration;
        let result = recv
            .await
            .map_err(|cause| {
                SourceError::caused_by(SourceFailure::InternalFault, FailureStage::Execute, cause)
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
    }
}
fn validate_assignment(
    broker: &SourceBroker,
    metadata: &ReadMetadata,
    a: &Assignment,
) -> Result<(), SourceError> {
    if broker.lease.id() != &a.instance
        || broker.prepared.implementation() != &a.implementation
        || metadata.binding.reference != a.binding
        || metadata.binding.body.source_id != a.source_id
        || metadata.binding.body.incarnation != a.incarnation
        || metadata.connection.id != a.connection_id
        || metadata.connection.revision != a.connection_revision
    {
        return Err(SourceError::new(
            SourceFailure::ProtocolViolation,
            FailureStage::Validate,
        ));
    }
    Ok(())
}
fn source_basis(metadata: &ReadMetadata, now: &Timestamp) -> SourceBasis {
    let b = &metadata.binding.body;
    SourceBasis {
        source_id: b.source_id.clone(),
        incarnation: b.incarnation.clone(),
        binding: metadata.binding.reference.clone(),
        mapping_revision: b.mapping.revision,
        authority_revision: b.authority.revision,
        schema: b.schema.clone(),
        identity_rule: b.identity_rule.clone(),
        field_definitions: b.field_mapping.iter().map(|f| f.property.clone()).collect(),
        position: None,
        snapshot: None,
        observed_at: now.clone(),
        captured_at: Some(now.clone()),
        last_reconciled_at: None,
        guarantee: SourceGuarantee::Authoritative,
        gap: None,
    }
}
fn missing() -> SourceError {
    SourceError::new(
        SourceFailure::CapabilityMissing {
            capability: SourceCapability::ChangeStream,
        },
        FailureStage::Prepare,
    )
}
