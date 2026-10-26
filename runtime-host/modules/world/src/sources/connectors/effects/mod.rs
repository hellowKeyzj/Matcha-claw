mod metadata;
mod postgres;

use super::{SourceBroker, SourceError};
use crate::{
    authorization::{self, Admission, AuthorizedEffect, EffectBinding},
    extensions::invocation::{self, CallBudget, ResourceKind, TaskResource},
    query::ActionEvaluation,
};
use foundation::{execution::OwnedTask, pipeline::PipelineContext};
use metadata::EffectMetadata;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use tokio::{sync::oneshot, time::Instant};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    actions::{
        EffectDisposition, EffectIntent, IdempotencyPolicy, SourceMutation, SourceOperation,
        SourceReceipt,
    },
    failure::FailureStage,
    ids::*,
    sources::{SourceFailure, SourcePlanReason},
    value::Value,
};

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MutationValues {
    insert: bool,
    delete: bool,
    keys: Vec<(SourceFieldId, Value)>,
    values: Vec<(SourceFieldId, Value)>,
    expected: Vec<(SourceFieldId, Value)>,
}

/// Only canonical action evaluation or an exact durable intent can construct this value.
#[derive(Clone)]
pub(crate) struct PreparedEffect {
    intent_id: EffectIntentId,
    operation: SourceOperation,
    values: MutationValues,
    policy: IdempotencyPolicy,
    binding: EffectBinding,
    implementation: world_protocol::bindings::ImplementationRef,
    metadata: EffectMetadata,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RetainedEffect {
    intent_id: EffectIntentId,
    operation: SourceOperation,
    values: MutationValues,
    policy: IdempotencyPolicy,
    binding: EffectBinding,
    implementation: world_protocol::bindings::ImplementationRef,
}

/// A real source outcome. Public SourceReceipt DTOs cannot instantiate the witness.
pub(crate) struct Observation {
    receipt: SourceReceipt,
    failure: Option<SourceError>,
}
impl Observation {
    pub(crate) fn receipt(&self) -> &SourceReceipt {
        &self.receipt
    }
    pub(crate) fn failure(&self) -> Option<&SourceError> {
        self.failure.as_ref()
    }
    fn new(
        prepared: &PreparedEffect,
        metadata: &EffectMetadata,
        disposition: EffectDisposition,
    ) -> Self {
        Self {
            receipt: SourceReceipt {
                id: SourceReceiptId::try_new(uuid::Uuid::new_v4().to_string())
                    .expect("UUID source receipt"),
                intent_id: prepared.intent_id.clone(),
                source_id: metadata.binding.body.source_id.clone(),
                observed_at: world_protocol::time::Timestamp::try_new(
                    chrono::Utc::now().to_rfc3339(),
                )
                .expect("UTC timestamp"),
                disposition,
                position: None,
                result: None,
                evidence: Vec::new(),
            },
            failure: None,
        }
    }
    fn failed(mut self, error: SourceError) -> Self {
        self.failure = Some(match self.failure.take() {
            Some(previous) => error.with_related(previous),
            None => error,
        });
        self
    }
    fn cleanup(mut self, error: SourceError) -> Self {
        self.failure = Some(SourceError::cleanup(
            self.failure.take(),
            "source.effect_cleanup",
            error,
        ));
        self
    }
}

impl PreparedEffect {
    pub(crate) fn binding(&self) -> &EffectBinding {
        &self.binding
    }
    pub(crate) fn retained(&self) -> Result<serde_json::Value, SourceError> {
        serde_json::to_value(RetainedEffect {
            intent_id: self.intent_id.clone(),
            operation: self.operation.clone(),
            values: self.values.clone(),
            policy: self.policy,
            binding: self.binding.clone(),
            implementation: self.implementation.clone(),
        })
        .map_err(|cause| {
            SourceError::caused_by(SourceFailure::InternalFault, FailureStage::Prepare, cause)
        })
    }
}

impl SourceBroker {
    pub(crate) async fn prepare_effect(
        &self,
        intent: &EffectIntent,
        evaluation: &ActionEvaluation,
        binding: &EffectBinding,
        policy: IdempotencyPolicy,
        admission: &Admission,
    ) -> Result<PreparedEffect, SourceError> {
        if evaluation.contract() != &intent.action
            || evaluation.arguments() != intent.argument_values
            || evaluation.operation() != &intent.source_operation
            || evaluation
                .preconditions()
                .iter()
                .any(|value| *value != world_protocol::expression::TruthValue::True)
            || self.lease.graph().lock().id != intent.activation_lock_id
            || self.lease.invocation() != &admission.invocation().id
            || binding.intent_id != intent.id
            || binding.operation_id != intent.operation_id
            || binding.step_id != intent.step_id
        {
            return Err(protocol());
        }
        let (insert, delete) = match intent.source_operation.mutation {
            SourceMutation::Insert { .. } => (true, false),
            SourceMutation::Update { .. } => (false, false),
            SourceMutation::Delete { .. } => (false, true),
        };
        let values = MutationValues {
            insert,
            delete,
            keys: evaluation.keys().to_vec(),
            values: evaluation.values().to_vec(),
            expected: evaluation.expected().to_vec(),
        };
        validate_values(&intent.source_operation, &values)?;
        invocation::check_current(&self.store, admission, &self.lease, &self.provider)
            .await
            .map_err(super::current_error)?;
        let operation = intent.source_operation.clone();
        let admission_copy = admission.clone();
        let values_copy = values.clone();
        let prepared = self.prepared.native()?.clone();
        let metadata = self
            .store
            .snapshot(admission.invocation().world.clone(), move |snapshot| {
                Box::pin(async move {
                    metadata::read(
                        snapshot,
                        &admission_copy,
                        &operation,
                        &values_copy,
                        policy,
                        &prepared,
                        false,
                    )
                    .await
                })
            })
            .await?;
        Ok(PreparedEffect {
            intent_id: intent.id.clone(),
            operation: intent.source_operation.clone(),
            values,
            policy,
            binding: binding.clone(),
            implementation: self.prepared.implementation().clone(),
            metadata,
        })
    }

    pub(crate) async fn restore_effect(
        &self,
        intent: &EffectIntent,
        admission: &Admission,
    ) -> Result<PreparedEffect, SourceError> {
        let intent_copy = intent.clone();
        let admission_copy = admission.clone();
        let prepared = self.prepared.native()?.clone();
        if self.lease.graph().lock().id != intent.activation_lock_id
            || self.lease.invocation() != &admission.invocation().id
        {
            return Err(protocol());
        }
        self.store.snapshot(admission.invocation().world.clone(), move |snapshot| Box::pin(async move {
            authorization::recheck_read(snapshot, &admission_copy, &snapshot.now().await?).await?;
            let row = snapshot.query_opt("SELECT record,execution FROM world_effect_intent WHERE tenant_id=$1 AND world_id=$2 AND intent_id=$3", &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &intent_copy.id.as_str()]).await?.ok_or_else(protocol)?;
            let durable: EffectIntent = serde_json::from_value(row.get("record")).map_err(|cause| SourceError::caused_by(SourceFailure::InternalFault, FailureStage::Decode, cause))?;
            let execution: serde_json::Value = row.get("execution");
            let retained: RetainedEffect = serde_json::from_value(execution.get("source").cloned().ok_or_else(protocol)?).map_err(|cause| SourceError::caused_by(SourceFailure::InternalFault, FailureStage::Decode, cause))?;
            if durable != intent_copy || retained.intent_id != durable.id || retained.operation != durable.source_operation
                || retained.binding.intent_id != durable.id || retained.binding.operation_id != durable.operation_id || retained.binding.step_id != durable.step_id
                || &retained.implementation != prepared.implementation()
            { return Err(protocol()); }
            validate_values(&retained.operation, &retained.values)?;
            let metadata = metadata::read(snapshot, &admission_copy, &retained.operation, &retained.values, retained.policy, &prepared, true).await?;
            Ok(PreparedEffect { intent_id: retained.intent_id, operation: retained.operation, values: retained.values,
                policy: retained.policy, binding: retained.binding, implementation: retained.implementation, metadata })
        })).await
    }

    /// Taking the committed, non-cloneable authorization is the only dispatch entry.
    pub(crate) async fn execute_effect(
        &self,
        prepared: PreparedEffect,
        authorized: AuthorizedEffect,
        admission: &Admission,
        pipeline: &PipelineContext,
        cancel: CancellationToken,
        deadline: Instant,
        budget: CallBudget,
    ) -> Result<Observation, SourceError> {
        if authorized.binding() != &prepared.binding {
            return Err(protocol());
        }
        let retained = prepared.clone();
        match self
            .effect_io(
                prepared,
                Some(authorized),
                admission,
                pipeline,
                cancel,
                deadline,
                budget,
            )
            .await
        {
            Ok(observation) => Ok(observation),
            Err(error) => Ok(Observation::new(
                &retained,
                &retained.metadata,
                EffectDisposition::Indeterminate,
            )
            .failed(error)),
        }
    }

    pub(crate) async fn inspect_effect(
        &self,
        prepared: PreparedEffect,
        admission: &Admission,
        pipeline: &PipelineContext,
        cancel: CancellationToken,
        deadline: Instant,
        budget: CallBudget,
    ) -> Result<Observation, SourceError> {
        self.effect_io(
            prepared, None, admission, pipeline, cancel, deadline, budget,
        )
        .await
    }

    async fn recheck_effect(
        &self,
        prepared: &PreparedEffect,
        admission: &Admission,
        inspect: bool,
    ) -> Result<EffectMetadata, SourceError> {
        invocation::check_current(&self.store, admission, &self.lease, &self.provider)
            .await
            .map_err(super::current_error)?;
        let native = self.prepared.native()?.clone();
        if native.implementation() != &prepared.implementation {
            return Err(protocol());
        }
        let operation = prepared.operation.clone();
        let values = prepared.values.clone();
        let policy = prepared.policy;
        let admission = admission.clone();
        let current = self
            .store
            .snapshot(admission.invocation().world.clone(), move |snapshot| {
                Box::pin(async move {
                    metadata::read(
                        snapshot, &admission, &operation, &values, policy, &native, inspect,
                    )
                    .await
                })
            })
            .await?;
        if current != prepared.metadata {
            return Err(protocol());
        }
        Ok(current)
    }

    async fn effect_io(
        &self,
        prepared: PreparedEffect,
        authorized: Option<AuthorizedEffect>,
        admission: &Admission,
        pipeline: &PipelineContext,
        cancel: CancellationToken,
        deadline: Instant,
        budget: CallBudget,
    ) -> Result<Observation, SourceError> {
        let inspect = authorized.is_none();
        if cancel.is_cancelled() || pipeline.is_cancelled() {
            return Err(super::cancelled());
        }
        budget.check().map_err(super::budget_error)?;
        if inspect {
            budget
                .charge(world_protocol::budget::BudgetDimension::SourceReads, 1)
                .map_err(super::budget_error)?;
        }
        let deadline = deadline.min(budget.deadline());
        let access = self.native_access()?.clone();
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
        let pipeline_cancel = pipeline.cancellation();
        let broker = self.clone();
        let admission = admission.clone();
        let permit = match self.lease.try_call(&self.provider) {
            Ok(permit) => permit,
            Err(error) => {
                ticket.fail();
                return Err(super::lease_error(error));
            }
        };
        let (send, receive) = oneshot::channel();
        let (task, _) = OwnedTask::spawn(move |task_cancel| async move {
            let work_cancel = CancellationToken::new();
            let work = async {
                let current = broker.recheck_effect(&prepared, &admission, inspect).await?;
                let credential = access
                    .credentials(
                        &current.connection.world,
                        &current.connection.id,
                        current.connection.revision,
                        work_cancel.clone(),
                        deadline,
                    )
                    .await?;
                let mut observation = match authorized {
                    None => {
                        postgres::inspect(
                            &access,
                            &broker,
                            &admission,
                            &prepared,
                            &current,
                            &budget,
                            credential,
                            work_cancel.clone(),
                            deadline,
                        )
                        .await
                    }
                    Some(authorized) => {
                        postgres::execute(
                            &access,
                            &broker,
                            &admission,
                            &prepared,
                            &current,
                            &budget,
                            authorized,
                            credential,
                            work_cancel.clone(),
                            deadline,
                        )
                        .await
                    }
                };
                observation.receipt.observed_at =
                    world_protocol::time::Timestamp::try_new(chrono::Utc::now().to_rfc3339())
                        .expect("UTC timestamp");
                // Preserve the physical source outcome even if authority is revoked during the I/O.
                match broker.recheck_effect(&prepared, &admission, inspect).await {
                    Ok(_) => Ok(observation),
                    Err(error) => Ok(observation.failed(error)),
                }
            };
            tokio::pin!(work);
            let result = tokio::select! {
                result = &mut work => result,
                _ = cancel.cancelled() => { work_cancel.cancel(); work.await },
                _ = pipeline_cancel.cancelled() => { work_cancel.cancel(); work.await },
                _ = ledger_cancel.cancelled() => { work_cancel.cancel(); work.await },
                _ = task_cancel.cancelled() => { work_cancel.cancel(); work.await },
                _ = tokio::time::sleep_until(deadline) => { work_cancel.cancel(); work.await },
            };
            let _ = send.send(result);
        });
        let acquired = ticket.complete(Box::new(
            TaskResource::new(task, |()| Ok(())).with_permit(permit),
        ));
        let mut registration = acquired.registration;
        let result = receive
            .await
            .map_err(|cause| {
                SourceError::caused_by(SourceFailure::InternalFault, FailureStage::Execute, cause)
            })
            .and_then(|result| result);
        if let Err(cleanup) = registration.close_checked(deadline).await {
            return match result {
                Ok(observation) => Ok(observation.cleanup(cleanup.into())),
                Err(error) => Err(SourceError::cleanup(
                    Some(error),
                    cleanup.code,
                    cleanup.into(),
                )),
            };
        }
        result
    }
}

pub(crate) fn retained_effect_roots(
    value: &serde_json::Value,
) -> Result<crate::store::RetentionRoots, SourceError> {
    let retained: RetainedEffect = serde_json::from_value(value.clone()).map_err(|cause| {
        SourceError::caused_by(
            SourceFailure::ProtocolViolation,
            FailureStage::Decode,
            cause,
        )
    })?;
    validate_values(&retained.operation, &retained.values)?;
    let mut roots = crate::store::RetentionRoots::default();
    roots.definitions.push(retained.operation.binding);
    roots.resources.push(ResourceRef::Package {
        id: retained.implementation.install_id,
    });
    let expressions: Vec<_> = match &retained.operation.mutation {
        SourceMutation::Insert { values } => values.iter().collect(),
        SourceMutation::Update {
            keys,
            values,
            expected,
        } => keys.iter().chain(values).chain(expected).collect(),
        SourceMutation::Delete { keys, expected } => keys.iter().chain(expected).collect(),
    };
    for field in expressions {
        roots
            .definitions
            .extend(crate::definitions::expression_references(&field.expression));
        roots
            .resources
            .extend(crate::definitions::expression_resources(&field.expression));
    }
    for (_, value) in retained
        .values
        .keys
        .iter()
        .chain(&retained.values.values)
        .chain(&retained.values.expected)
    {
        crate::definitions::value_resources(value, &mut roots.resources);
    }
    Ok(roots)
}

fn validate_values(
    operation: &SourceOperation,
    values: &MutationValues,
) -> Result<(), SourceError> {
    let expected_flags = match operation.mutation {
        SourceMutation::Insert { .. } => (true, false),
        SourceMutation::Update { .. } => (false, false),
        SourceMutation::Delete { .. } => (false, true),
    };
    if (values.insert, values.delete) != expected_flags {
        return Err(protocol());
    }
    let (keys, fields, expected): (&[_], &[_], &[_]) = match &operation.mutation {
        SourceMutation::Insert { values } => (&[], values, &[]),
        SourceMutation::Update {
            keys,
            values,
            expected,
        } => (keys, values, expected),
        SourceMutation::Delete { keys, expected } => (keys, &[], expected),
    };
    for (expressions, actual) in [
        (keys, &values.keys),
        (fields, &values.values),
        (expected, &values.expected),
    ] {
        let ids: BTreeSet<_> = expressions.iter().map(|entry| &entry.field).collect();
        let actual_ids: BTreeSet<_> = actual.iter().map(|(id, _)| id).collect();
        if ids.len() != expressions.len() || actual_ids.len() != actual.len() || ids != actual_ids {
            return Err(protocol());
        }
    }
    if (values.insert || !values.delete) && values.values.is_empty() {
        return Err(SourceError::invalid("values", SourcePlanReason::Empty));
    }
    if values
        .keys
        .iter()
        .any(|(_, value)| matches!(value, Value::Null))
    {
        return Err(SourceError::invalid("keys", SourcePlanReason::InvalidKey));
    }
    Ok(())
}
fn protocol() -> SourceError {
    SourceError::new(SourceFailure::ProtocolViolation, FailureStage::Validate)
}
