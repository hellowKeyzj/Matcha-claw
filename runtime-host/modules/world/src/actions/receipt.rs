use super::{contract::input, decode, encode, intent};
use crate::{
    owner::{self, Error, OperationUpdate},
    sources::connectors::effects::Observation,
    store::WorldTransaction,
};
use world_protocol::{
    actions::{
        ActionFailure, ActionPhase, ActionStatus, EffectDisposition, EffectIntent, SourceReceipt,
        VerificationReceipt,
    },
    failure::{Failure, FailureStage, Recovery},
    ids::*,
    operation::{OperationFailure, OperationPhase},
};

/// Consuming the sole send authority also makes crash recovery conservatively effect-aware.
pub(crate) async fn mark_dispatching(
    tx: &mut WorldTransaction<'_>,
    expected: &EffectIntent,
    now: &world_protocol::time::Timestamp,
) -> Result<(), Error> {
    tx.require_domain(&WriterDomain::try_new("actions").expect("actions domain"))?;
    tx.require_domain(&WriterDomain::try_new("operation").expect("operation domain"))?;
    let (intent, execution, phase) = intent::read_intent(tx, &expected.id).await?;
    if intent != *expected || phase != "dispatching" || execution.source.is_none() {
        return Err(input("intent.dispatch"));
    }
    let operation = owner::read_operation(tx, &intent.operation_id).await?;
    let run = owner::read_run(tx, &intent.run_id).await?;
    let step = owner::read_step(tx, &intent.run_id, &intent.step_id)
        .await?
        .ok_or_else(|| input("intent.step"))?;
    if run.operation != operation.accepted
        || operation.progress.run_id.as_ref() != Some(&intent.run_id)
        || run.activation_lock_id.as_ref() != Some(&intent.activation_lock_id)
        || run.release_id.as_ref() != Some(&execution.context.release_id)
        || run.branch_id.is_some()
        || execution.context.branch.is_some()
        || operation.cancellation != world_protocol::operation::CancellationState::NotRequested
        || !matches!(
            operation.phase,
            OperationPhase::Admitted | OperationPhase::Running
        )
        || !matches!(
            run.phase,
            OperationPhase::Admitted | OperationPhase::Running
        )
        || !matches!(
            step.phase,
            OperationPhase::Admitted | OperationPhase::Running
        )
        || step.kind != "action.effect"
        || step.result.is_some()
        || step.failure.is_some()
        || !tx
            .fences()
            .iter()
            .any(|fence| fence.domain.as_str() == "operation" && fence.epoch == step.writer_epoch)
    {
        return Err(input("intent.dispatch.basis"));
    }
    let reason = operation_failure(&failure(
        &intent,
        ActionFailure::EffectIndeterminate {
            intent_id: intent.id.clone(),
        },
        FailureStage::Execute,
        Recovery::InspectEffect {
            operation_id: intent.operation_id.clone(),
            step_id: intent.step_id.clone(),
        },
    ));
    let mut next = step.clone();
    next.phase = OperationPhase::EffectIndeterminate;
    if next.checkpoint.is_null() { next.checkpoint = serde_json::json!({}); }
    next.checkpoint.as_object_mut().ok_or_else(|| input("step.checkpoint"))?
        .insert("intentId".into(), encode(&intent.id)?);
    next.failure = Some(reason.clone());
    owner::checkpoint_step(tx, &step, next).await?;
    let mut progress = operation.progress.clone();
    progress.stage = FailureStage::Execute;
    progress.step_id = Some(intent.step_id);
    owner::update_operation(
        tx,
        &operation.accepted,
        OperationUpdate {
            phase: OperationPhase::EffectIndeterminate,
            progress,
            failure: Some(reason),
            effects: Vec::new(),
        },
        now,
    )
    .await?;
    Ok(())
}

/// Durable custody only: this witness came from the trusted source, not a public receipt DTO.
/// No authorization is minted here and no source result is disclosed.
pub(crate) async fn record_source(
    tx: &mut WorldTransaction<'_>,
    expected: &EffectIntent,
    observation: &Observation,
) -> Result<(), Error> {
    tx.require_domain(&WriterDomain::try_new("actions").expect("actions domain"))?;
    let (intent, mut execution, phase) = intent::read_intent(tx, &expected.id).await?;
    if intent != *expected
        || observation.receipt().intent_id != intent.id
        || !matches!(
            phase.as_str(),
            "dispatching"
                | "effect_pending"
                | "effect_indeterminate"
                | "verifying"
                | "retained"
                | "completed"
                | "rejected"
                | "cancelled_after_effect"
        )
    {
        return Err(input("sourceReceipt.intent"));
    }
    let world = tx.world();
    let (proposal, _) = super::read_proposal(tx, &execution.proposal_id).await?;
    let (payload_digest, target_digest) = crate::authorization::effect_digests(
        &intent.source_operation,
        &intent.argument_values,
        &proposal.request.targets,
    )?;
    let binding = crate::authorization::EffectBinding {
        intent_id: intent.id.clone(),
        operation_id: intent.operation_id.clone(),
        step_id: intent.step_id.clone(),
        payload_digest,
        target_digest,
        effect: world_protocol::expression::Effect::ExternalWrite,
    };
    // Settlement belongs to the original consumed actor, not the current inspector.
    let consumed = tx.query_opt("SELECT p.binding FROM world_auth_permit p JOIN world_effect_intent i USING(tenant_id,world_id,intent_id) JOIN world_operation o ON o.tenant_id=i.tenant_id AND o.world_id=i.world_id AND o.operation_id=i.operation_id WHERE p.tenant_id=$1 AND p.world_id=$2 AND p.intent_id=$3 AND p.operation_id=$4 AND p.step_id=$5 AND p.actor_id=i.actor_id AND o.actor_id=i.actor_id AND p.status='consumed' AND p.remaining_uses=0", &[&world.tenant_id.as_str(), &world.world_id.as_str(), &intent.id.as_str(), &intent.operation_id.as_str(), &intent.step_id.as_str()]).await?.ok_or_else(|| input("sourceReceipt.permit"))?;
    if decode::<crate::authorization::EffectBinding>(consumed.get("binding"))? != binding {
        return Err(input("sourceReceipt.permit"));
    }
    let definition = crate::releases::read_definition_exact(tx, &intent.source_operation.binding)
        .await?
        .ok_or_else(|| input("sourceReceipt.source"))?;
    if !matches!(definition.body, world_protocol::definitions::DefinitionBody::SourceBinding(source) if source.source_id == observation.receipt().source_id && source.resource == intent.source_operation.resource)
    {
        return Err(input("sourceReceipt.source"));
    }
    let operation = owner::read_operation(tx, &intent.operation_id).await?;
    if operation.progress.run_id.as_ref() != Some(&intent.run_id) {
        return Err(input("sourceReceipt.operation"));
    }
    let step = owner::read_step(tx, &intent.run_id, &intent.step_id)
        .await?
        .ok_or_else(|| input("sourceReceipt.step"))?;
    let receipt = observation.receipt();
    let disposition = encode(&receipt.disposition)?;
    let disposition = disposition
        .as_str()
        .ok_or_else(|| input("sourceReceipt.disposition"))?;
    let old = tx.query_opt("SELECT body FROM world_source_receipt WHERE tenant_id=$1 AND world_id=$2 AND receipt_id=$3", &[&world.tenant_id.as_str(), &world.world_id.as_str(), &receipt.id.as_str()]).await?;
    if let Some(row) = old {
        if decode::<SourceReceipt>(row.get("body"))? != *receipt {
            return Err(input("sourceReceipt"));
        }
        return Ok(());
    }
    tx.execute("INSERT INTO world_source_receipt(tenant_id,world_id,receipt_id,intent_id,source_id,disposition,observed_at,body) VALUES($1,$2,$3,$4,$5,$6,$7::text::timestamptz,$8)", &[&world.tenant_id.as_str(), &world.world_id.as_str(), &receipt.id.as_str(), &intent.id.as_str(), &receipt.source_id.as_str(), &disposition, &receipt.observed_at.as_str(), &encode(receipt)?]).await?;
    // Late independent observations are still physical custody, not permission to reopen a terminal action.
    if matches!(
        phase.as_str(),
        "completed" | "rejected" | "cancelled_after_effect"
    ) {
        return Ok(());
    }
    let now = tx.now().await?;
    let causal = tx.query_opt("SELECT receipt_id FROM world_source_receipt WHERE tenant_id=$1 AND world_id=$2 AND intent_id=$3 AND disposition IN ('applied','accepted') LIMIT 1", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &intent.id.as_str()]).await?.is_some();
    let next = match receipt.disposition {
        EffectDisposition::Applied | EffectDisposition::Accepted => "verifying",
        EffectDisposition::Indeterminate if causal => "verifying",
        EffectDisposition::Indeterminate => "effect_indeterminate",
        EffectDisposition::NotSent
        | EffectDisposition::Rejected
        | EffectDisposition::NotApplied => "rejected",
    };
    if let Some(error) = observation.failure() {
        execution.failure = Some(failure(
            &intent,
            ActionFailure::Source {
                failure: error.failure.clone(),
            },
            error.stage,
            Recovery::InspectEffect {
                operation_id: intent.operation_id.clone(),
                step_id: intent.step_id.clone(),
            },
        ));
    } else if next == "rejected" {
        execution.failure = Some(failure(
            &intent,
            ActionFailure::ConditionalWriteConflict,
            FailureStage::Execute,
            Recovery::Refresh,
        ));
    } else if receipt.disposition == EffectDisposition::Indeterminate {
        execution.failure = Some(failure(
            &intent,
            ActionFailure::EffectIndeterminate {
                intent_id: intent.id.clone(),
            },
            FailureStage::Execute,
            Recovery::InspectEffect {
                operation_id: intent.operation_id.clone(),
                step_id: intent.step_id.clone(),
            },
        ));
    }
    tx.execute("UPDATE world_effect_intent SET status=$4,execution=$5,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND intent_id=$3", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &intent.id.as_str(), &next, &encode(&execution)?]).await?;
    let mut next_step = step.clone();
    if next_step.checkpoint.is_null() { next_step.checkpoint = serde_json::json!({}); }
    let checkpoint = next_step.checkpoint.as_object_mut().ok_or_else(|| input("step.checkpoint"))?;
    checkpoint.insert("intentId".into(), encode(&intent.id)?);
    checkpoint.insert("sourceReceiptId".into(), encode(&receipt.id)?);
    next_step.phase = if next == "rejected" {
        OperationPhase::Failed
    } else if next == "effect_indeterminate" {
        OperationPhase::EffectIndeterminate
    } else {
        OperationPhase::Verifying
    };
    next_step.failure = execution.failure.as_ref().map(operation_failure);
    owner::checkpoint_step(tx, &step, next_step).await?;
    let mut progress = operation.progress.clone();
    progress.stage = if next == "verifying" {
        FailureStage::Verify
    } else {
        FailureStage::Recover
    };
    progress.step_id = Some(intent.step_id.clone());
    let updated = owner::update_operation(
        tx,
        &operation.accepted,
        OperationUpdate {
            phase: if next == "effect_indeterminate" {
                OperationPhase::EffectIndeterminate
            } else {
                OperationPhase::Verifying
            },
            progress,
            failure: execution.failure.as_ref().map(operation_failure),
            effects: vec![receipt.clone()],
        },
        &now,
    )
    .await?;
    if next == "rejected" {
        let reason = execution
            .failure
            .as_ref()
            .ok_or_else(|| input("sourceReceipt.failure"))?;
        owner::fail_operation(
            tx,
            &updated.accepted,
            operation_failure(&reason),
            operation.cancellation != world_protocol::operation::CancellationState::NotRequested,
            &now,
        )
        .await?;
    }
    Ok(())
}

/// A cold transfer must not detach an unresolved external send from its original intent.
pub(crate) async fn has_unsettled_world(
    store: &crate::store::WorldStore,
    world: &WorldRef,
) -> Result<bool, Error> {
    store.snapshot(world.clone(), |snapshot| Box::pin(async move {
        let row = snapshot.query_opt(
            "SELECT EXISTS(SELECT 1 FROM world_effect_intent i WHERE i.tenant_id=$1 AND i.world_id=$2 AND (i.status IN ('dispatching','effect_pending','effect_indeterminate','verifying','retained','commit_indeterminate') OR EXISTS(SELECT 1 FROM world_auth_permit p WHERE p.tenant_id=i.tenant_id AND p.world_id=i.world_id AND p.intent_id=i.intent_id AND p.status='consumed')) AND NOT EXISTS(SELECT 1 FROM world_source_receipt r WHERE r.tenant_id=i.tenant_id AND r.world_id=i.world_id AND r.intent_id=i.intent_id AND r.disposition IN ('applied','not_sent','rejected','not_applied')) AND NOT (EXISTS(SELECT 1 FROM world_source_receipt r WHERE r.tenant_id=i.tenant_id AND r.world_id=i.world_id AND r.intent_id=i.intent_id AND r.disposition='accepted') AND EXISTS(SELECT 1 FROM world_verification_receipt v WHERE v.tenant_id=i.tenant_id AND v.world_id=i.world_id AND v.intent_id=i.intent_id AND v.verdict='verified'))) AS unsettled",
            &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str()],
        ).await?.ok_or_else(|| Error::internal(FailureStage::Read))?;
        Ok(row.get("unsettled"))
    })).await
}

pub(crate) async fn status(
    tx: &WorldTransaction<'_>,
    operation: &OperationId,
) -> Result<ActionStatus, Error> {
    let (intent, execution, phase) = intent::read_operation_intent(tx, operation).await?;
    let receipt = owner::read_operation(tx, operation).await?;
    let sources = tx.query("SELECT body FROM world_source_receipt WHERE tenant_id=$1 AND world_id=$2 AND intent_id=$3 ORDER BY observed_at,receipt_id", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &intent.id.as_str()]).await?.into_iter().map(|row| decode(row.get("body"))).collect::<Result<Vec<SourceReceipt>, _>>()?;
    let verifications = tx.query("SELECT body FROM world_verification_receipt WHERE tenant_id=$1 AND world_id=$2 AND intent_id=$3 ORDER BY verified_at,verification_id", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &intent.id.as_str()]).await?.into_iter().map(|row| decode(row.get("body"))).collect::<Result<Vec<VerificationReceipt>, _>>()?;
    if sources.iter().any(|source| source.intent_id != intent.id)
        || verifications
            .iter()
            .any(|verification| verification.intent_id != intent.id)
    {
        return Err(input("receipts"));
    }
    Ok(ActionStatus {
        operation_id: intent.operation_id,
        run_id: intent.run_id,
        phase: match phase.as_str() {
            "prepared" => ActionPhase::Prepared,
            "dispatching" => ActionPhase::Dispatching,
            "effect_pending" => ActionPhase::EffectPending,
            "verifying" => ActionPhase::Verifying,
            "completed" => ActionPhase::Completed,
            "rejected" => ActionPhase::Rejected,
            "cancelled_before_effect" => ActionPhase::CancelledBeforeEffect,
            "cancelled_after_effect" => ActionPhase::CancelledAfterEffect,
            "effect_indeterminate" => ActionPhase::EffectIndeterminate,
            "commit_indeterminate" => ActionPhase::CommitIndeterminate,
            "compensating" => ActionPhase::Compensating,
            "retained" => ActionPhase::Retained,
            _ => return Err(input("intent.status")),
        },
        source_receipts: sources,
        verifications,
        commit: receipt.commit,
        failure: execution.failure,
    })
}

pub(crate) async fn reject_unconsumed(
    tx: &mut WorldTransaction<'_>,
    expected: &EffectIntent,
    cause: &Failure<world_protocol::api::ApiFailure>,
) -> Result<(), Error> {
    tx.require_domain(&WriterDomain::try_new("actions").expect("actions domain"))?;
    let (intent, mut execution, phase) = intent::read_intent(tx, &expected.id).await?;
    if intent != *expected {
        return Err(input("intent"));
    }
    if phase != "prepared" {
        return Ok(());
    }
    let consumed = tx.query_opt("SELECT permit_id FROM world_auth_permit WHERE tenant_id=$1 AND world_id=$2 AND intent_id=$3 AND status='consumed'", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &intent.id.as_str()]).await?;
    if consumed.is_some() {
        return Err(input("intent.consumption"));
    }
    let cancelled = matches!(
        cause.details,
        world_protocol::api::ApiFailure::Operation(
            OperationFailure::Cancelled
                | OperationFailure::Action(ActionFailure::CancelledBeforeEffect)
        )
    );
    let details = match &cause.details {
        world_protocol::api::ApiFailure::Operation(OperationFailure::Action(reason)) => {
            reason.clone()
        }
        world_protocol::api::ApiFailure::Operation(OperationFailure::Source(reason)) => {
            ActionFailure::Source {
                failure: reason.clone(),
            }
        }
        world_protocol::api::ApiFailure::Operation(OperationFailure::Commit(reason)) => {
            ActionFailure::Commit {
                failure: reason.clone(),
            }
        }
        world_protocol::api::ApiFailure::Authorization(reason) => ActionFailure::Authorization {
            failure: reason.clone(),
        },
        world_protocol::api::ApiFailure::Query(reason) => ActionFailure::Evaluation {
            failure: reason.clone(),
        },
        world_protocol::api::ApiFailure::Input(reason) => ActionFailure::Input {
            failure: reason.clone(),
        },
        _ if cancelled => ActionFailure::CancelledBeforeEffect,
        _ => ActionFailure::InternalFault,
    };
    let reason = Failure {
        code: cause.code.clone(),
        stage: cause.stage,
        message: cause.message.clone(),
        diagnostic_id: cause.diagnostic_id.clone(),
        operation_id: Some(intent.operation_id.clone()),
        run_id: Some(intent.run_id.clone()),
        step_id: Some(intent.step_id.clone()),
        details,
        recovery: cause.recovery.clone(),
    };
    execution.failure = Some(reason.clone());
    let status = if cancelled {
        "cancelled_before_effect"
    } else {
        "rejected"
    };
    tx.execute("UPDATE world_effect_intent SET status=$4,execution=$5,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND intent_id=$3 AND status='prepared'", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &intent.id.as_str(), &status, &encode(&execution)?]).await?;
    let step = owner::read_step(tx, &intent.run_id, &intent.step_id)
        .await?
        .ok_or_else(|| input("intent.step"))?;
    let mut next = step.clone();
    next.phase = if cancelled {
        OperationPhase::CancelledBeforeCommit
    } else {
        OperationPhase::Failed
    };
    next.failure = Some(operation_failure(&reason));
    owner::checkpoint_step(tx, &step, next).await?;
    let operation = owner::read_operation(tx, &intent.operation_id).await?;
    owner::fail_operation(
        tx,
        &operation.accepted,
        operation_failure(&reason),
        cancelled,
        &tx.now().await?,
    )
    .await?;
    Ok(())
}

pub(crate) async fn settle_verification(
    tx: &mut WorldTransaction<'_>,
    expected: &EffectIntent,
    receipt: &VerificationReceipt,
) -> Result<(), Error> {
    use world_protocol::actions::VerificationVerdict;
    tx.require_domain(&WriterDomain::try_new("actions").expect("actions domain"))?;
    let (intent, mut execution, phase) = intent::read_intent(tx, &expected.id).await?;
    if intent != *expected
        || receipt.intent_id != intent.id
        || receipt.read_receipt.world != *tx.world()
        || receipt.read_receipt.activation_lock_id != intent.activation_lock_id
        || !matches!(
            phase.as_str(),
            "verifying" | "effect_indeterminate" | "retained"
        )
    {
        return Err(input("verification"));
    }
    let verdict = encode(&receipt.verdict)?;
    let verdict = verdict
        .as_str()
        .ok_or_else(|| input("verification.verdict"))?;
    tx.execute("INSERT INTO world_verification_receipt(tenant_id,world_id,verification_id,intent_id,verdict,verified_at,body) VALUES($1,$2,$3,$4,$5,$6::text::timestamptz,$7)", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &receipt.id.as_str(), &intent.id.as_str(), &verdict, &receipt.verified_at.as_str(), &encode(receipt)?]).await?;
    // Matching current state cannot prove that an indeterminate send caused it.
    let causal = tx.query_opt("SELECT receipt_id FROM world_source_receipt WHERE tenant_id=$1 AND world_id=$2 AND intent_id=$3 AND disposition IN ('applied','accepted') LIMIT 1", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &intent.id.as_str()]).await?.is_some();
    let completed = receipt.verdict == VerificationVerdict::Verified && causal;
    execution.failure = if completed {
        None
    } else {
        Some(failure(
            &intent,
            if !causal {
                ActionFailure::EffectIndeterminate {
                    intent_id: intent.id.clone(),
                }
            } else if receipt.verdict == VerificationVerdict::NotSatisfied {
                ActionFailure::VerificationFailed {
                    verification_id: receipt.id.clone(),
                }
            } else {
                ActionFailure::VerificationUnavailable
            },
            FailureStage::Verify,
            Recovery::InspectEffect {
                operation_id: intent.operation_id.clone(),
                step_id: intent.step_id.clone(),
            },
        ))
    };
    let next_status = if completed {
        "completed"
    } else if !causal {
        "effect_indeterminate"
    } else {
        "verifying"
    };
    tx.execute("UPDATE world_effect_intent SET status=$4,execution=$5,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND intent_id=$3", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &intent.id.as_str(), &next_status, &encode(&execution)?]).await?;
    let step = owner::read_step(tx, &intent.run_id, &intent.step_id)
        .await?
        .ok_or_else(|| input("intent.step"))?;
    let mut next = step.clone();
    next.phase = if completed {
        OperationPhase::Completed
    } else if !causal {
        OperationPhase::EffectIndeterminate
    } else {
        OperationPhase::Verifying
    };
    next.result = Some(encode(receipt)?);
    next.failure = execution.failure.as_ref().map(operation_failure);
    owner::checkpoint_step(tx, &step, next).await?;
    let operation = owner::read_operation(tx, &intent.operation_id).await?;
    if completed {
        let result = status(tx, &intent.operation_id).await?;
        owner::complete_operation(
            tx,
            &operation.accepted,
            world_protocol::operation::OperationResult::Action(Box::new(result)),
            &tx.now().await?,
        )
        .await?;
    } else {
        let mut progress = operation.progress.clone();
        progress.stage = FailureStage::Verify;
        progress.step_id = Some(intent.step_id.clone());
        owner::update_operation(
            tx,
            &operation.accepted,
            OperationUpdate {
                phase: if !causal {
                    OperationPhase::EffectIndeterminate
                } else {
                    OperationPhase::Verifying
                },
                progress,
                failure: execution.failure.as_ref().map(operation_failure),
                effects: Vec::new(),
            },
            &tx.now().await?,
        )
        .await?;
    }
    Ok(())
}

pub(crate) async fn status_impact(
    tx: &WorldTransaction<'_>,
    mut impact: world_protocol::authorization::ActualImpact,
    proposal: &world_protocol::actions::ActionProposal,
    status: &ActionStatus,
) -> Result<world_protocol::authorization::ActualImpact, Error> {
    use world_protocol::authorization::{AccessMode, AccessScope};
    let (_, context) = super::read_proposal(tx, &proposal.id).await?;
    let model = super::contract::release(tx, &context).await?;
    let scope = context.scope;
    let mut resources = Vec::new();
    for receipt in &status.source_receipts {
        resources.push(ResourceRef::Source {
            id: receipt.source_id.clone(),
        });
        impact.source_ids.push(receipt.source_id.clone());
        if let Some(value) = &receipt.result {
            crate::facts::assertions::value_resources(value, &mut resources);
        }
    }
    for receipt in &status.verifications {
        for dependency in &receipt.read_receipt.actual_dependencies {
            match dependency {
                world_protocol::provenance::ReadDependency::Assertion { reference } => resources
                    .push(ResourceRef::Assertion {
                        id: reference.id.clone(),
                    }),
                world_protocol::provenance::ReadDependency::Definition { reference } => resources
                    .push(ResourceRef::Definition {
                        id: reference.id.clone(),
                    }),
                world_protocol::provenance::ReadDependency::Source { position, .. } => {
                    impact.source_ids.push(position.source_id.clone());
                    resources.push(ResourceRef::Source {
                        id: position.source_id.clone(),
                    });
                }
                _ => {}
            }
        }
    }
    let dependencies = status_evidence(status)
        .into_iter()
        .map(|reference| world_protocol::provenance::ReadDependency::Evidence { reference })
        .collect::<Vec<_>>();
    if let Some(material) = crate::facts::support::dependency_impact(
        tx,
        &dependencies,
        &model,
        &scope,
        &crate::query::point_interval(&context.at)?,
    )
    .await?
    {
        impact.access.extend(material.access);
        impact.labels.extend(material.labels);
        impact.source_ids.extend(material.source_ids);
    }
    resources.sort();
    resources.dedup();
    if !resources.is_empty() {
        impact.access.push(AccessScope {
            resources,
            fields: Vec::new(),
            modes: vec![AccessMode::Read],
            scope,
            valid_time: None,
        });
    }
    Ok(crate::authorization::actual_impact(
        impact.access,
        Vec::new(),
        impact.labels,
        Vec::new(),
        impact.source_ids,
    )?)
}

pub(crate) async fn check_status_output(
    tx: &WorldTransaction<'_>,
    admission: &crate::authorization::Admission,
    impact: &world_protocol::authorization::ActualImpact,
    status: &ActionStatus,
    now: &world_protocol::time::Timestamp,
) -> Result<(), Error> {
    admission.require_access(impact)?;
    let (_, execution, _) = intent::read_operation_intent(tx, &status.operation_id).await?;
    crate::facts::assertions::require_evidence_custody_transaction(
        tx,
        admission,
        &status_evidence(status),
        &execution.context.scope,
        Some(&crate::query::point_interval(&execution.context.at)?),
        now,
    )
    .await?;
    crate::authorization::check_admitted_output(tx, admission, impact, 1, now).await?;
    Ok(())
}

fn status_evidence(status: &ActionStatus) -> Vec<EvidenceRef> {
    status
        .source_receipts
        .iter()
        .flat_map(|receipt| receipt.evidence.iter().cloned())
        .chain(status.verifications.iter().flat_map(|receipt| {
            receipt.evidence.iter().cloned().chain(
                receipt
                    .read_receipt
                    .actual_dependencies
                    .iter()
                    .filter_map(|dependency| match dependency {
                        world_protocol::provenance::ReadDependency::Evidence { reference } => {
                            Some(reference.clone())
                        }
                        _ => None,
                    }),
            )
        }))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect()
}

pub(crate) fn operation_failure(failure: &Failure<ActionFailure>) -> Failure<OperationFailure> {
    Failure {
        code: failure.code.clone(),
        stage: failure.stage,
        message: failure.message.clone(),
        diagnostic_id: failure.diagnostic_id.clone(),
        operation_id: failure.operation_id.clone(),
        run_id: failure.run_id.clone(),
        step_id: failure.step_id.clone(),
        details: OperationFailure::Action(failure.details.clone()),
        recovery: failure.recovery.clone(),
    }
}
pub(super) fn failure(
    intent: &EffectIntent,
    details: ActionFailure,
    stage: FailureStage,
    recovery: Recovery,
) -> Failure<ActionFailure> {
    Failure {
        code: "world.action_failed".into(),
        stage,
        message: "动作未完成，请按恢复方式对账。".into(),
        diagnostic_id: DiagnosticId::try_new(uuid::Uuid::new_v4().to_string())
            .expect("UUID diagnostic"),
        operation_id: Some(intent.operation_id.clone()),
        run_id: Some(intent.run_id.clone()),
        step_id: Some(intent.step_id.clone()),
        details,
        recovery,
    }
}
