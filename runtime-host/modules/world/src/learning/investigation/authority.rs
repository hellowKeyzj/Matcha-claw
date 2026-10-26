use crate::{
    authorization::{self, AuthError},
    owner::StepRecord,
};
use world_protocol::{
    abstraction::BindingTarget,
    authorization::{AccessMode, AccessScope, ActualImpact, AuthorizationFailure},
    expression::Effect,
    identity::SubjectRef,
    ids::*,
    operation::OperationPhase,
    provenance::ReadDependency,
    time::Timestamp,
};

use super::{Checkpoint, InvestigationIdentity};

pub(crate) fn require_investigation_checkpoint(
    step: &StepRecord,
    identity: &InvestigationIdentity,
    finite: &ActualImpact,
    now: &Timestamp,
) -> Result<Timestamp, AuthError> {
    let deadline = require_investigation_recovery_checkpoint(step, identity, finite)?;
    let state: Checkpoint = serde_json::from_value(step.checkpoint.clone()).map_err(AuthError::Codec)?;
    if deadline <= *now || state.execution.as_ref().is_none_or(|execution| execution.created_at > *now) {
        return Err(AuthorizationFailure::InvalidDelegation.into());
    }
    Ok(deadline)
}

pub(crate) fn require_investigation_recovery_checkpoint(
    step: &StepRecord,
    identity: &InvestigationIdentity,
    finite: &ActualImpact,
) -> Result<Timestamp, AuthError> {
    let changed = || AuthError::from(AuthorizationFailure::InvalidDelegation);
    let state: Checkpoint = serde_json::from_value(step.checkpoint.clone()).map_err(AuthError::Codec)?;
    let execution = state.execution.as_ref().ok_or_else(changed)?;
    let context = state.context.as_ref().ok_or_else(changed)?;
    let material: (
        world_protocol::learning::TaskRef,
        world_protocol::value::ValueType,
        world_protocol::value::Value,
        world_protocol::abstraction::WorldView,
        Option<world_protocol::abstraction::AbstractionContract>,
    ) = serde_json::from_str(&execution.execution_prompt).map_err(AuthError::Codec)?;
    let digest = |value: &serde_json::Value| crate::definitions::canonical_digest(value)
        .map_err(|_| AuthError::from(AuthorizationFailure::RequestDigestMismatch));
    let input = serde_json::to_value(&material.2).map_err(AuthError::Codec)?;
    let payload = serde_json::to_value(&material).map_err(AuthError::Codec)?;
    if execution.identity != *identity || execution.finite_impact != *finite
        || finite_impact(&state, &execution.query_closure)? != *finite
        || step.run_id != identity.run_id || step.id != identity.step_id
        || step.attempt != identity.attempt || step.kind != "learning.resolve"
        || !matches!(step.phase, OperationPhase::Running | OperationPhase::Retained)
        || step.result.is_some() || !super::context::ready(context) || !context.investigate
        || state.binding.task != identity.task || state.binding.case_id != identity.case_id
        || state.binding.run_id != identity.run_id || state.binding.step_id != identity.step_id
        || state.binding.operation_id != identity.operation.operation_id
        || state.task.world != identity.operation.world
        || state.task.id != identity.task.id || state.task.revision != identity.task.revision
        || material.0 != identity.task || material.1 != state.task.input_type
        || context.view.as_ref() != Some(&material.3) || context.contract != material.4
        || digest(&input)? != identity.input_digest || digest(&payload)? != identity.material_digest
        || content_budget_digest(&execution.execution_prompt)? != identity.content_budget_digest
        || execution.allowed_effects != state.task.allowed_effects
        || execution.budget.deadline.as_ref().is_none_or(|deadline| deadline > &state.deadline)
        || execution.budget.deadline.as_ref().is_none_or(|deadline| deadline <= &execution.created_at)
        || allowance(&execution.budget) != execution.allowance
    {
        return Err(changed());
    }
    Ok(execution.budget.deadline.clone().ok_or_else(changed)?)
}

pub(crate) fn investigation_request_digest(
    step: &StepRecord, identity: &InvestigationIdentity, finite: &ActualImpact,
) -> Result<Digest, AuthError> {
    require_investigation_recovery_checkpoint(step, identity, finite)?;
    let state: Checkpoint = serde_json::from_value(step.checkpoint.clone()).map_err(AuthError::Codec)?;
    let execution = state.execution.as_ref().ok_or(AuthorizationFailure::InvalidDelegation)?;
    crate::definitions::canonical_digest(&(&execution.identity, &execution.execution_prompt,
        &execution.allowed_effects, &execution.budget, &execution.created_at))
        .map_err(|_| AuthorizationFailure::RequestDigestMismatch.into())
}

/// An upper bound, not an observation of consumption.
pub(super) fn allowance(budget: &world_protocol::budget::Budget) -> world_protocol::budget::Usage {
    world_protocol::budget::Usage {
        elapsed: world_protocol::time::DurationMs(0),
        steps: budget.max_steps,
        source_reads: budget.max_source_reads,
        rows: budget.max_rows,
        bytes: budget.max_bytes,
        model_calls: budget.max_model_calls,
        input_tokens: budget.max_input_tokens,
        output_tokens: budget.max_output_tokens,
        cost: budget.max_cost.clone(),
    }
}

pub(super) fn content_budget_digest(prompt: &str) -> Result<Digest, AuthError> {
    crate::definitions::canonical_digest(&serde_json::json!({"budget": null, "content": prompt}))
        .map_err(|_| AuthorizationFailure::RequestDigestMismatch.into())
}

/// Only resources and fields actually delivered in the protected-context projection enter this cap.
pub(super) fn finite_impact(state: &Checkpoint, query: &super::InvestigationQueryClosure) -> Result<ActualImpact, AuthError> {
    let changed = || AuthError::from(AuthorizationFailure::InvalidDelegation);
    let context = state.context.as_ref().ok_or_else(changed)?;
    let view = context.view.as_ref().ok_or_else(changed)?;
    let page = context.page.as_ref().ok_or_else(changed)?;
    if !super::context::ready(context) || !context.investigate
        || view.world != state.task.world || view.task_id != state.task.id
        || view.task_revision != state.task.revision || view.scope != state.task.scope
        || view.allowed_effects != state.task.allowed_effects
        || query.activation_lock_id != page.receipt.activation_lock_id
        || query.activation_lock_id != state.binding.activation_lock_id
        || query.bindings.is_empty() || query.bindings.windows(2).any(|pair| pair[0] >= pair[1])
    {
        return Err(changed());
    }
    let scope = &state.task.scope;
    let access = |resource, fields, modes| AccessScope {
        resources: vec![resource], fields, modes, scope: scope.clone(), valid_time: None,
    };
    let mut grants = vec![access(ResourceRef::Task { id: state.task.id.clone() }, Vec::new(), vec![AccessMode::Read, AccessMode::Execute])];
    grants.push(AccessScope {
        resources: query.bindings.iter().cloned().map(|id| ResourceRef::Binding { id }).collect(),
        fields: Vec::new(), modes: vec![AccessMode::Execute], scope: scope.clone(), valid_time: None,
    });
    let mut state_refs = Vec::new();
    let mut source_ids = Vec::new();
    for reference in &view.definitions {
        grants.push(access(ResourceRef::Definition { id: reference.id.clone() }, Vec::new(), vec![AccessMode::Read]));
    }
    for (resource, fields) in view.objects.iter().map(|object| {
        (ResourceRef::Object { id: object.object.id.clone() }, &object.fields)
    }).chain(view.relations.iter().map(|relation| {
        (ResourceRef::Relation { id: relation.relation.id.clone() }, &relation.fields)
    })) {
        if fields.is_empty() { continue; }
        let mut modes = vec![AccessMode::Read];
        if state.task.allowed_effects.contains(&Effect::ExternalWrite) { modes.push(AccessMode::Write); }
        grants.push(access(resource, fields.iter().map(|field| field.property.clone()).collect(), modes));
        for field in fields {
            for evidence in &field.evidence {
                grants.push(access(ResourceRef::Evidence { id: evidence.id.clone() }, Vec::new(), vec![AccessMode::Read]));
            }
            if let world_protocol::value::Cell::Conflicted { assertions } = &field.cell {
                for assertion in assertions {
                    grants.push(access(ResourceRef::Assertion { id: assertion.id.clone() }, Vec::new(), vec![AccessMode::Read]));
                }
            }
        }
    }
    let dependencies = page.receipt.actual_dependencies.iter().chain(
        context.contract.iter().flat_map(|contract| &contract.read_dependencies),
    );
    for dependency in dependencies {
        let resource = match dependency {
            ReadDependency::Assertion { reference } => Some(ResourceRef::Assertion { id: reference.id.clone() }),
            ReadDependency::Evidence { reference } => Some(ResourceRef::Evidence { id: reference.id.clone() }),
            ReadDependency::Definition { reference } => Some(ResourceRef::Definition { id: reference.id.clone() }),
            ReadDependency::Watch { id, .. } => Some(ResourceRef::Watch { id: id.clone() }),
            ReadDependency::Source { position, .. } => {
                source_ids.push(position.source_id.clone());
                Some(ResourceRef::Source { id: position.source_id.clone() })
            }
            // Identity-only observations must not become an all-fields grant.
            ReadDependency::Identity { subject: SubjectRef::Object { .. } | SubjectRef::Relation { .. }, .. }
            | ReadDependency::TimeBoundary { .. } | ReadDependency::AliasRange { .. }
            | ReadDependency::SourceMapping { .. } | ReadDependency::SourceField { .. } => None,
        };
        if let Some(resource) = resource { grants.push(access(resource, Vec::new(), vec![AccessMode::Read])); }
    }
    if let Some(contract) = &context.contract {
        for binding in &contract.binding_map.bindings {
            if let BindingTarget::State { reference } = &binding.target {
                state_refs.push(reference.clone());
                grants.push(access(ResourceRef::State { id: reference.id.clone() }, Vec::new(), vec![AccessMode::Read]));
            }
        }
    }
    authorization::actual_impact(grants, state.task.allowed_effects.clone(), view.labels.clone(), state_refs, source_ids)
}
