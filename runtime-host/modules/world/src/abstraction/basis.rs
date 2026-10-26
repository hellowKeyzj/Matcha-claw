use std::collections::BTreeSet;
use world_protocol::{
    abstraction::{AbstractionContract, AbstractionFailure, BindingTarget},
    authorization::{AccessMode, AccessScope, ActualImpact}, definitions::{Definition, DefinitionBody, Scope},
    evaluation::EvaluationArm, expression::Effect,
    ids::{ResourceRef, Revision}, learning::{Candidate, CandidateOrigin, ChangeStatus, SemanticOperation, TaskContract}, provenance::ReadDependency,
    releases::{BranchRef, Release, WorldBranch},
};
use crate::{authorization::{self, Admission, VerifiedInvocation}, content::Content, store::WorldTransaction};
use super::Error;

pub(super) struct Basis {
    pub task: TaskContract, pub definitions: Vec<Definition<DefinitionBody>>, pub scopes: Vec<Scope>,
    pub impact: world_protocol::authorization::ActualImpact, pub current: bool,
    pub model: world_protocol::releases::Release,
}

/// Lifecycle revisions may advance; an abstraction still names its original immutable model.
pub(crate) async fn require_branch(
    tx: &WorldTransaction<'_>, contract: &AbstractionContract, branch: &world_protocol::releases::WorldBranch,
) -> Result<(), Error> {
    let reference = contract.branch.as_ref().ok_or(AbstractionFailure::BasisChanged)?;
    crate::releases::require_branch_model(tx, reference, branch).await?;
    if contract.world != *tx.world() || branch.world != contract.world || reference.id != branch.id
        || reference.revision > branch.revision || branch.candidate_id != contract.candidate_id
        || branch.task_id != contract.task_id || branch.task_revision != contract.task_revision
        || branch.basis.release_id != contract.base_release {
        return Err(AbstractionFailure::BasisChanged.into());
    }
    Ok(())
}

pub(super) async fn load(
    tx: &WorldTransaction<'_>, content: &Content, admission: &Admission, contract: &AbstractionContract, writing: bool,
) -> Result<Basis, Error> {
    if content.world() != tx.world() { return Err(AbstractionFailure::BasisChanged.into()); }
    load_current(tx, admission, contract, writing).await
}

#[derive(Clone, Copy)]
enum Authority<'a> { Admitted(&'a Admission), Read(&'a VerifiedInvocation) }

impl Authority<'_> {
    fn invocation(&self) -> &world_protocol::authorization::Invocation {
        match self { Self::Admitted(admission) => admission.invocation(), Self::Read(verified) => verified.invocation() }
    }
    async fn check(&self, tx: &WorldTransaction<'_>, impact: &ActualImpact) -> Result<(), Error> {
        match self {
            Self::Admitted(admission) => { admission.require_access(impact)?; authorization::recheck(tx, admission, &tx.now().await?).await?; },
            Self::Read(verified) => authorization::check_impact_read(tx, verified, impact, &tx.now().await?).await?,
        }
        Ok(())
    }
}

pub(super) async fn load_current(
    tx: &WorldTransaction<'_>, admission: &Admission, contract: &AbstractionContract, writing: bool,
) -> Result<Basis, Error> {
    load_authorized(tx, Authority::Admitted(admission), contract, writing).await
}

pub(super) async fn load_read(
    tx: &WorldTransaction<'_>, verified: &VerifiedInvocation, contract: &AbstractionContract,
) -> Result<Basis, Error> {
    load_authorized(tx, Authority::Read(verified), contract, false).await
}

async fn load_authorized(
    tx: &WorldTransaction<'_>, authority: Authority<'_>, contract: &AbstractionContract, writing: bool,
) -> Result<Basis, Error> {
    if contract.world != *tx.world() || contract.revision.0 == 0
        || contract.branch.as_ref().is_some_and(|branch| branch.world != contract.world || branch.revision.0 == 0)
        || authority.invocation().world != contract.world
        || authority.invocation().task_id.as_ref().is_some_and(|id| id != &contract.task_id) {
        return Err(AbstractionFailure::BasisChanged.into());
    }
    let mut impact = authorize(tx, Some(authority), &contract.scope, vec![ResourceRef::Task { id: contract.task_id.clone() }], AccessMode::Read, Vec::new()).await?;
    let task = crate::evaluation::read_task(tx, &contract.task_id, contract.task_revision).await?;
    if task.scope != contract.scope { return Err(AbstractionFailure::BasisChanged.into()); }
    let (branch, candidate) = crate::releases::read_candidate(tx, &contract.candidate_id).await?.ok_or(AbstractionFailure::BasisChanged)?;
    if branch.task_id != task.id || branch.task_revision != task.revision || branch.basis.release_id != contract.base_release
        || candidate.origin != CandidateOrigin::Abstraction
        || matches!(candidate.change_set.status, ChangeStatus::Rejected | ChangeStatus::Superseded) {
        return Err(AbstractionFailure::BasisChanged.into());
    }
    if contract.branch.is_some() { require_branch(tx, contract, &branch).await?; }
    impact.access.extend(authorize(tx, Some(authority), &task.scope, vec![ResourceRef::Branch { id: branch.id.clone() }, ResourceRef::ChangeSet { id: candidate.change_set.id.clone() }],
        if writing { AccessMode::Write } else { AccessMode::Read }, Vec::new()).await?.access);
    let model = model(tx, &branch).await?;
    footprint(tx, Some(authority), contract, task, &branch, model, impact, writing).await
}

/// Derives the same record ceiling before the owner inserts the candidate; it grants no authority.
pub(crate) async fn record_impact(
    tx: &WorldTransaction<'_>, candidate: &Candidate, branch: &WorldBranch, contract: &AbstractionContract,
) -> Result<ActualImpact, Error> {
    let task = crate::evaluation::read_task(tx, &contract.task_id, contract.task_revision).await?;
    let reference = BranchRef { world: branch.world.clone(), id: branch.id.clone(), revision: branch.revision };
    if contract.world != *tx.world() || task.world != contract.world || task.scope != contract.scope
        || contract.revision.0 == 0 || contract.branch.as_ref() != Some(&reference)
        || candidate.world != contract.world || candidate.change_set.world != contract.world
        || candidate.origin != CandidateOrigin::Abstraction || candidate.change_set.revision != Revision(1)
        || candidate.change_set.status != ChangeStatus::Proposed || branch.status != ChangeStatus::Proposed
        || candidate.id != contract.candidate_id || branch.candidate_id != candidate.id
        || branch.task_id != task.id || branch.task_revision != task.revision
        || branch.change_set_id != candidate.change_set.id || branch.basis.overlay != candidate.change_set.operations
        || branch.basis.release_id != contract.base_release || candidate.change_set.base_release != contract.base_release {
        return Err(AbstractionFailure::BasisChanged.into());
    }
    if let Some(first) = super::read(tx, &contract.id, Revision(1)).await? {
        if first.candidate_id != contract.candidate_id || first.branch != contract.branch
            || crate::evaluation::abstraction_plan_digest(&first)? != crate::evaluation::abstraction_plan_digest(contract)? {
            return Err(AbstractionFailure::BasisChanged.into());
        }
    }
    let impact = authorization::actual_impact(vec![
        AccessScope { resources: vec![ResourceRef::Task { id: task.id.clone() }], fields: Vec::new(), modes: vec![AccessMode::Read], scope: task.scope.clone(), valid_time: None },
        AccessScope { resources: vec![ResourceRef::Branch { id: branch.id.clone() }, ResourceRef::ChangeSet { id: candidate.change_set.id.clone() }], fields: Vec::new(), modes: vec![AccessMode::Write], scope: task.scope.clone(), valid_time: None },
    ], vec![Effect::Pure], Vec::new(), Vec::new(), Vec::new())?;
    let model = model(tx, branch).await?;
    let checked = footprint(tx, None, contract, task, branch, model, impact, true).await?;
    super::check::contract(contract, &checked.definitions, &checked.scopes)?;
    Ok(checked.impact)
}

pub(super) async fn model(tx: &WorldTransaction<'_>, branch: &WorldBranch) -> Result<Release, Error> {
    let base = crate::releases::read_release(tx, &branch.basis.release_id).await?.ok_or(AbstractionFailure::BasisChanged)?;
    Ok(crate::query::proposed_branch_model(branch, base, &EvaluationArm::Candidate)?)
}

async fn footprint(
    tx: &WorldTransaction<'_>, admission: Option<Authority<'_>>, contract: &AbstractionContract, task: TaskContract,
    branch: &WorldBranch, model: Release, mut impact: ActualImpact, writing: bool,
) -> Result<Basis, Error> {
    let now = tx.now().await?;
    let definitions = model.definitions.clone();
    let scopes = model.scopes.clone();
    let mut originals = BTreeSet::new();
    for reference in &contract.original_definitions {
        if reference.world != contract.world || !originals.insert(reference) || !definitions.iter().any(|definition| &definition.reference == reference) {
            return Err(AbstractionFailure::BasisChanged.into());
        }
    }
    if originals.is_empty() { return Err(AbstractionFailure::BasisChanged.into()); }
    let mut needed = contract.original_definitions.clone();
    if let Some(reference) = &contract.strategy { needed.push(reference.clone()); }
    if let world_protocol::abstraction::Fallback::ExpandConcrete { concrete_strategy } = &contract.fallback { needed.push(concrete_strategy.clone()); }
    needed.extend(contract.applicable_actions.clone());
    let mut resources = Vec::new();
    for value_type in contract.parameters.iter().map(|parameter| &parameter.value_type).chain(contract.slots.iter().map(|slot| &slot.value_type)) {
        resources.extend(crate::definitions::value_type_resources(value_type));
    }
    let mut expressions = vec![&contract.guard];
    expressions.extend(&contract.assumptions); expressions.extend(&contract.preserved_invariants);
    for step in &contract.forward_plan {
        expressions.push(&step.guard);
        match &step.operation {
            world_protocol::learning::StrategyOperation::Query { query } => {
                needed.extend(crate::definitions::query_references(query)); resources.extend(crate::definitions::query_resources(query));
            },
            world_protocol::learning::StrategyOperation::Function { function, arguments } => { needed.push(function.clone()); expressions.extend(arguments); },
            world_protocol::learning::StrategyOperation::Action { action, arguments } => {
                needed.push(action.clone());
                for argument in arguments { crate::definitions::value_resources(&argument.value, &mut resources); }
            },
            world_protocol::learning::StrategyOperation::Stop { .. } => {},
        }
    }
    for binding in &contract.binding_map.bindings {
        match &binding.target {
            BindingTarget::Property { definition } | BindingTarget::Action { definition } => needed.push(definition.clone()),
            BindingTarget::Expression { expression } => expressions.push(expression), _ => {},
        }
        expressions.extend(binding.guard.iter()); expressions.extend(binding.transform.iter()); expressions.extend(binding.inverse_transform.iter());
    }
    for expression in expressions {
        needed.extend(crate::definitions::expression_references(expression)); resources.extend(crate::definitions::expression_resources(expression));
    }
    resources.sort(); resources.dedup();
    for resource in &resources {
        if let ResourceRef::Definition { id } = resource {
            needed.push(definitions.iter().find(|definition| definition.reference.id == *id).ok_or(AbstractionFailure::BasisChanged)?.reference.clone());
        }
    }
    if !resources.is_empty() { extend(&mut impact, authorize(tx, admission, &contract.scope, resources, AccessMode::Read, Vec::new()).await?); }
    needed.sort(); needed.dedup();
    let mut cursor = 0;
    while cursor < needed.len() {
        let definition = definitions.iter().find(|definition| definition.reference == needed[cursor]).ok_or(AbstractionFailure::BasisChanged)?;
        let references = crate::definitions::definition_references(&definition.body);
        for reference in definition.dependencies.iter().chain(&references) { if !needed.contains(reference) { needed.push(reference.clone()); } }
        cursor += 1;
    }
    let definitions: Vec<_> = definitions.into_iter().filter(|definition| needed.contains(&definition.reference)).collect();
    let mut evidence = BTreeSet::new();
    for binding in &contract.binding_map.bindings {
        if !crate::definitions::scope_contains(&contract.world, &contract.scope, &binding.inverse_scope, &scopes)
            .map_err(|failure| Error::Compile(world_protocol::compiler::CompileFailure::Definition { failure }))? {
            return Err(AbstractionFailure::BasisChanged.into());
        }
        evidence.extend(binding.evidence.iter().cloned());
        let resource = match &binding.target {
            BindingTarget::Object { id } => Some(ResourceRef::Object { id: id.clone() }),
            BindingTarget::Relation { id } => Some(ResourceRef::Relation { id: id.clone() }),
            BindingTarget::Property { definition } | BindingTarget::Action { definition } => Some(ResourceRef::Definition { id: definition.id.clone() }),
            BindingTarget::State { reference } => {
                if reference.world != contract.world { return Err(AbstractionFailure::BasisChanged.into()); }
                let state = authorization::actual_impact(vec![AccessScope { resources: vec![ResourceRef::State { id: reference.id.clone() }], fields: Vec::new(), modes: vec![AccessMode::Read], scope: binding.inverse_scope.clone(), valid_time: None }], vec![Effect::Pure], Vec::new(), vec![reference.clone()], Vec::new())?;
                if let Some(authority) = admission { authority.check(tx, &state).await?; }
                if !crate::extensions::migration::read_exact_state_in_transaction(tx, reference).await? { return Err(AbstractionFailure::BasisChanged.into()); }
                impact.access.extend(state.access); impact.state.extend(state.state);
                None
            },
            BindingTarget::Expression { .. } => None,
        };
        if let Some(resource) = resource { impact.access.extend(authorize(tx, admission, &binding.inverse_scope, vec![resource], AccessMode::Read, Vec::new()).await?.access); }
    }
    for definition in &definitions {
        let current = crate::definitions::read_definition_head(tx, &definition.reference.id).await?;
        if current.as_ref().is_some_and(|current| current.body.kind() != definition.body.kind())
            || current.is_none() && (definition.previous_ref.is_some() || !branch.basis.overlay.iter().any(|operation| match operation {
                SemanticOperation::CreateDefinition { definition: created } => created.reference.id == definition.reference.id,
                SemanticOperation::SplitDefinition { replacements, .. } => replacements.iter().any(|replacement| replacement.reference.id == definition.reference.id),
                _ => false,
            })) {
            return Err(AbstractionFailure::BasisChanged.into());
        }
        let mut labels = Vec::new();
        if let DefinitionBody::Property(property) = &definition.body { labels.extend(property.access_labels.clone()); }
        if let Some(DefinitionBody::Property(property)) = current.as_ref().map(|current| &current.body) { labels.extend(property.access_labels.clone()); }
        for scope in std::iter::once(&definition.scope).chain(current.as_ref().map(|current| &current.scope)) {
            let checked = authorize(tx, admission, scope, vec![ResourceRef::Definition { id: definition.reference.id.clone() }], AccessMode::Read, labels.clone()).await?;
            impact.access.extend(checked.access); impact.labels.extend(checked.labels);
        }
    }
    let evidence: Vec<_> = evidence.into_iter().collect();
    let mut current = true;
    for reference in &evidence {
        impact.access.push(AccessScope { resources: vec![ResourceRef::Evidence { id: reference.id.clone() }], fields: Vec::new(), modes: vec![AccessMode::Read], scope: task.scope.clone(), valid_time: None });
        if writing {
            let dependency = ReadDependency::Evidence { reference: reference.clone() };
            if let Some(required) = crate::facts::support::dependency_impact(tx, &[dependency], &model, &task.scope, &crate::query::point_interval(&now)?).await? {
                extend_record_dependencies(&mut impact, required);
            }
        }
        if let Some(admission) = admission {
            let required = match admission {
                Authority::Admitted(admission) => crate::facts::assertions::require_evidence(tx, admission, std::slice::from_ref(reference), &task.scope, None, &now).await,
                Authority::Read(verified) => crate::facts::assertions::require_evidence_preflight(tx, verified, std::slice::from_ref(reference), &task.scope, None, &now).await,
            };
            match required {
                Ok(items) => for item in items {
                    impact.labels.extend(item.access.labels); impact.source_ids.push(item.locator.source_version.source_id);
                },
                Err(error) if !writing && matches!(error.reason, world_protocol::facts::FactFailure::EvidenceIncomplete { .. } | world_protocol::facts::FactFailure::EvidenceUnavailable { .. } | world_protocol::facts::FactFailure::EvidenceDeleted { .. }) => { current = false; },
                Err(error) => return Err(error.into()),
            }
        }
    }
    // Preadmission and the final record derive the same current ceiling; only the final record proves it.
    let interval = crate::query::point_interval(&now)?;
    for (dependencies, scope) in std::iter::once((contract.read_dependencies.clone(), &contract.scope)).chain(
        contract.binding_map.bindings.iter().map(|binding| (binding.dependencies.iter().cloned()
            .chain(binding.evidence.iter().cloned().map(|reference| ReadDependency::Evidence { reference })).collect(), &binding.inverse_scope)),
    ) {
        if let Some(required) = crate::facts::support::dependency_impact(tx, &dependencies, &model, scope, &interval).await? {
            if let Some(authority) = admission { authority.check(tx, &required).await?; }
            if writing { extend_record_dependencies(&mut impact, required); } else { extend(&mut impact, required); }
        }
        if admission.is_some() {
            if let Err(error) = crate::facts::support::recheck_dependencies_in_model(tx, &dependencies, &model, scope, &interval, &now).await {
                if writing || matches!(crate::facts::support::provenance_failure(&error), world_protocol::provenance::ProvenanceFailure::Commit { .. }) { return Err(error.into()); }
                current = false;
            }
        }
    }
    // A new Verified revision is independently minted by record after these current checks.
    let assurance = if writing && contract.assurance == world_protocol::abstraction::Assurance::Verified {
        None
    } else { match admission {
        Some(Authority::Admitted(admission)) => crate::evaluation::require_abstraction_assurance(tx, admission, contract).await?,
        Some(Authority::Read(verified)) => crate::evaluation::require_abstraction_assurance_read(tx, verified, contract).await?,
        None => crate::evaluation::abstraction_assurance_impact(tx, contract).await?,
    } };
    if let Some(assurance) = assurance { extend(&mut impact, assurance); }
    let impact = authorization::actual_impact(impact.access, impact.effects, impact.labels, impact.state, impact.source_ids)?;
    if let Some(authority) = admission { authority.check(tx, &impact).await?; }
    Ok(Basis { task, definitions, scopes, impact, current, model })
}

async fn authorize(
    tx: &WorldTransaction<'_>, admission: Option<Authority<'_>>, scope: &world_protocol::ids::ScopeId,
    resources: Vec<ResourceRef>, mode: AccessMode, labels: Vec<String>,
) -> Result<world_protocol::authorization::ActualImpact, Error> {
    let impact = authorization::actual_impact(vec![AccessScope { resources, fields: Vec::new(), modes: vec![mode], scope: scope.clone(), valid_time: None }],
        vec![Effect::Pure], labels, Vec::new(), Vec::new())?;
    if let Some(authority) = admission { authority.check(tx, &impact).await?; }
    Ok(impact)
}

// Recording retains dependency metadata; its read authority is not a grant for one transient query instant.
fn extend_record_dependencies(target: &mut ActualImpact, mut required: ActualImpact) {
    for access in &mut required.access { access.valid_time = None; }
    extend(target, required);
}

fn extend(target: &mut ActualImpact, required: ActualImpact) {
    target.access.extend(required.access); target.effects.extend(required.effects); target.labels.extend(required.labels);
    target.state.extend(required.state); target.source_ids.extend(required.source_ids);
}
