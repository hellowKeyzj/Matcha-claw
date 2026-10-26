use world_protocol::{
    authorization::PolicyRef,
    compiler::{DependencyTarget, ExternalContractKind},
    definitions::{Definition, DefinitionBody, DefinitionFailure, DefinitionLifecycle},
    failure::FieldPath,
    ids::{
        CandidateId, ConnectionId, DefinitionId, DefinitionRef, EvaluationId, EvidenceRef,
        IdentityRuleRef, MappingRef, ParseArtifactId, ReleaseId, ResourceRef, Revision, SchemaRef,
        ScopeId, TaskId,
    },
    learning::SemanticOperation,
    materials::SourceVersionRef,
    provenance::ReadDependency,
    releases::{BranchRef, WorldBranch},
    sources::{AuthorityRef, RetentionPolicy, SourceBasis},
};

use crate::store::WorldTransaction;

use super::{Error, read::invalid};

/// Exact references owned by the kept canonical rows; no current-head or whole-world expansion.
#[derive(Default)]
pub(crate) struct ReleaseRetention {
    pub release_ids: Vec<ReleaseId>,
    pub branch_refs: Vec<BranchRef>,
    pub scopes: Vec<ScopeId>,
    pub evidence: Vec<EvidenceRef>,
    pub source_versions: Vec<SourceVersionRef>,
    pub parse_artifacts: Vec<ParseArtifactId>,
    pub definitions: Vec<DefinitionRef>,
    pub resources: Vec<ResourceRef>,
    pub schemas: Vec<SchemaRef>,
    pub schema_mappings: Vec<MappingRef>,
    pub identity_rules: Vec<IdentityRuleRef>,
    pub connections: Vec<(ConnectionId, Revision)>,
    pub authorities: Vec<(DefinitionRef, AuthorityRef)>,
    pub policies: Vec<PolicyRef>,
    pub retention_policies: Vec<RetentionPolicy>,
    pub dependencies: Vec<ReadDependency>,
    pub source_bases: Vec<SourceBasis>,
    pub evaluations: Vec<EvaluationId>,
    pub tasks: Vec<(TaskId, Revision)>,
    pub candidate_ids: Vec<CandidateId>,
}

/// Store supplies the already-kept rows after its FK closure. It owns concrete table seeding.
pub(crate) async fn release_retention(
    tx: &WorldTransaction<'_>,
    releases: &[ReleaseId],
    branches: &[BranchRef],
) -> Result<ReleaseRetention, Error> {
    let mut retained = ReleaseRetention::default();
    for id in releases {
        let release = super::read_release(tx, id)
            .await?
            .ok_or_else(|| invalid("release"))?;
        add(&mut retained.release_ids, release.id);
        if let Some(parent) = release.parent {
            add(&mut retained.release_ids, parent);
        }
        if let Some(branch) = release.source_branch {
            add(&mut retained.branch_refs, branch);
        }
        for scope in release.scopes {
            add(&mut retained.scopes, scope.id);
            expression_refs(&mut retained, &scope.predicate);
        }
        for definition in &release.definitions {
            model(&mut retained, definition);
        }
        for edge in release.artifact.dependencies.edges {
            match edge.target {
                DependencyTarget::Definition(reference) => {
                    add(&mut retained.definitions, reference)
                }
                DependencyTarget::Schema(reference) => add(&mut retained.schemas, reference),
                DependencyTarget::Policy(reference) => add(&mut retained.policies, reference),
                _ => {}
            }
        }
        for dependency in release.basis {
            dependency_ref(&mut retained, dependency);
        }
        for source in release.sources {
            source_basis(&mut retained, source);
        }
        for receipt in release.read_receipts {
            add(&mut retained.release_ids, receipt.release_id);
            for dependency in receipt.actual_dependencies {
                dependency_ref(&mut retained, dependency);
            }
        }
        for evaluation in release.evaluations {
            add(&mut retained.evaluations, evaluation);
        }
    }
    for reference in branches {
        let branch = super::read_branch_revision(tx, reference)
            .await?
            .ok_or_else(|| invalid("branchRevision"))?;
        add(&mut retained.branch_refs, reference.clone());
        branch_refs(&mut retained, &branch);
    }
    evidence_refs(tx, &mut retained).await?;
    Ok(retained)
}

/// Pure model-owned roots; callers resolve evidence and concrete immutable carriers separately.
pub(crate) fn definition_model_retention(
    definitions: &[Definition<DefinitionBody>],
) -> ReleaseRetention {
    let mut retained = ReleaseRetention::default();
    for definition in definitions {
        model(&mut retained, definition);
    }
    retained
}

pub(crate) async fn definition_retention(
    tx: &WorldTransaction<'_>,
    definitions: &[DefinitionRef],
) -> Result<ReleaseRetention, Error> {
    let mut retained = ReleaseRetention::default();
    for reference in definitions {
        let historical = super::read::read_definition_history(tx, reference)
            .await?
            .ok_or_else(|| DefinitionFailure::MissingReference {
                reference: reference.clone(),
            })?;
        match historical.carrier {
            super::read::DefinitionCarrier::Archive => {}
            super::read::DefinitionCarrier::Release(id) => add(&mut retained.release_ids, id),
            super::read::DefinitionCarrier::Branches(references) => {
                add(
                    &mut retained.branch_refs,
                    references.into_iter().next().ok_or_else(|| invalid("branchRevision"))?,
                )
            }
        }
        model(&mut retained, &historical.definition);
    }
    evidence_refs(tx, &mut retained).await?;
    Ok(retained)
}

/// A stable type has no semantic revision; retain one real carrier of every historical revision.
pub(crate) async fn definition_resource_retention(
    tx: &WorldTransaction<'_>,
    ids: &[DefinitionId],
) -> Result<ReleaseRetention, Error> {
    let mut references = std::collections::BTreeSet::new();
    for id in ids {
        let history = super::read::definition_history_references(tx, id).await?;
        if history.is_empty() {
            return Err(DefinitionFailure::MissingField {
                field: FieldPath(vec!["definitionHistory".into(), id.to_string()]),
            }
            .into());
        }
        references.extend(history);
    }
    definition_retention(tx, &references.into_iter().collect::<Vec<_>>()).await
}

async fn evidence_refs(
    tx: &WorldTransaction<'_>,
    retained: &mut ReleaseRetention,
) -> Result<(), Error> {
    // Evidence locators and derivation are immutable and may outlive the currently visible model.
    let mut index = 0;
    while index < retained.evidence.len() {
        let reference = retained.evidence[index].clone();
        let evidence = crate::facts::assertions::read_evidence(tx, &reference)
            .await?
            .ok_or_else(|| invalid("evidence"))?;
        add(
            &mut retained.source_versions,
            evidence.locator.source_version,
        );
        if let Some(artifact) = evidence.locator.parse_artifact_id {
            add(&mut retained.parse_artifacts, artifact);
        }
        for derived in evidence.derived_from {
            add(&mut retained.evidence, derived);
        }
        add(&mut retained.retention_policies, evidence.retention);
        index += 1;
    }
    Ok(())
}

fn branch_refs(retained: &mut ReleaseRetention, branch: &WorldBranch) {
    add(&mut retained.release_ids, branch.basis.release_id.clone());
    add(
        &mut retained.tasks,
        (branch.task_id.clone(), branch.task_revision),
    );
    add(&mut retained.candidate_ids, branch.candidate_id.clone());
    for scope in &branch.compile.scopes {
        add(&mut retained.scopes, scope.id.clone());
        expression_refs(retained, &scope.predicate);
    }
    for assumption in &branch.basis.assumptions {
        expression_refs(retained, assumption);
    }
    for definition in &branch.compile.definitions {
        model(retained, definition);
    }
    for external in &branch.compile.external_contracts {
        if let ExternalContractKind::Policy { policy } = &external.kind {
            add(&mut retained.policies, policy.clone());
        }
    }
    for source in &branch.basis.sources {
        source_basis(retained, source.clone());
    }
    for receipt in &branch.basis.read_receipts {
        add(&mut retained.release_ids, receipt.release_id.clone());
        for dependency in &receipt.actual_dependencies {
            dependency_ref(retained, dependency.clone());
        }
    }
    for operation in &branch.basis.overlay {
        match operation {
            SemanticOperation::NoOp { .. } => {}
            SemanticOperation::AttachEvidence { target, evidence } => {
                add(&mut retained.resources, target.clone());
                for reference in evidence {
                    add(&mut retained.evidence, reference.clone());
                }
            }
            SemanticOperation::MergeAliases {
                sources,
                target,
                evidence,
            } => {
                for reference in sources.iter().chain(std::iter::once(target)) {
                    add(&mut retained.definitions, reference.clone());
                }
                for reference in evidence {
                    add(&mut retained.evidence, reference.clone());
                }
            }
            SemanticOperation::EnrichAnnotation { target, .. } => {
                add(&mut retained.definitions, target.clone());
            }
            SemanticOperation::ScopeDefinition {
                previous, scope, ..
            } => {
                add(&mut retained.definitions, previous.clone());
                add(&mut retained.scopes, scope.clone());
            }
            SemanticOperation::RefineDefinition {
                previous,
                replacement,
            }
            | SemanticOperation::SupersedeRule {
                previous,
                replacement,
            } => {
                add(&mut retained.definitions, previous.clone());
                model(retained, replacement);
            }
            SemanticOperation::CreateDefinition { definition } => model(retained, definition),
            SemanticOperation::LinkExisting { source, target, .. } => {
                add(&mut retained.definitions, source.clone());
                add(&mut retained.definitions, target.clone());
            }
            SemanticOperation::DeprecateDefinition {
                previous,
                replacements,
                ..
            } => {
                for reference in replacements.iter().chain(std::iter::once(previous)) {
                    add(&mut retained.definitions, reference.clone());
                }
            }
            SemanticOperation::SplitDefinition {
                previous,
                replacements,
                partition,
            } => {
                add(&mut retained.definitions, previous.clone());
                for definition in replacements {
                    model(retained, definition);
                }
                for partition in partition {
                    add(
                        &mut retained.resources,
                        ResourceRef::Definition {
                            id: partition.replacement.clone(),
                        },
                    );
                    expression_refs(retained, &partition.predicate);
                }
            }
        }
    }
}

fn model(retained: &mut ReleaseRetention, definition: &Definition<DefinitionBody>) {
    add(&mut retained.scopes, definition.scope.clone());
    add(&mut retained.definitions, definition.reference.clone());
    for reference in crate::definitions::definition_references(&definition.body) {
        add(&mut retained.definitions, reference);
    }
    for resource in crate::definitions::definition_resources(&definition.body) {
        add(&mut retained.resources, resource);
    }
    for reference in definition
        .dependencies
        .iter()
        .chain(definition.previous_ref.iter())
    {
        add(&mut retained.definitions, reference.clone());
    }
    match &definition.lifecycle {
        DefinitionLifecycle::Deprecated { replacements, .. }
        | DefinitionLifecycle::Split { replacements, .. } => {
            for reference in replacements {
                add(&mut retained.definitions, reference.clone());
            }
        }
        DefinitionLifecycle::Available => {}
    }
    for reference in &definition.evidence {
        add(&mut retained.evidence, reference.clone());
    }
    match &definition.body {
        DefinitionBody::SourceBinding(binding) => {
            add(&mut retained.scopes, binding.scope.clone());
            add(&mut retained.schemas, binding.schema.clone());
            add(&mut retained.schema_mappings, binding.mapping.clone());
            add(&mut retained.identity_rules, binding.identity_rule.clone());
            add(
                &mut retained.connections,
                (binding.connection_id.clone(), binding.connection_revision),
            );
            add(
                &mut retained.authorities,
                (definition.reference.clone(), binding.authority.clone()),
            );
            add(&mut retained.retention_policies, binding.retention.clone());
        }
        DefinitionBody::PolicyBinding(binding) => {
            add(&mut retained.scopes, binding.scope.clone());
            add(&mut retained.policies, binding.policy.clone());
        }
        _ => {}
    }
}

fn expression_refs(
    retained: &mut ReleaseRetention,
    expression: &world_protocol::expression::ExpressionIr,
) {
    for reference in crate::definitions::expression_references(expression) {
        add(&mut retained.definitions, reference);
    }
    for resource in crate::definitions::expression_resources(expression) {
        add(&mut retained.resources, resource);
    }
}

fn source_basis(retained: &mut ReleaseRetention, basis: SourceBasis) {
    add(&mut retained.definitions, basis.binding.clone());
    add(&mut retained.schemas, basis.schema.clone());
    add(&mut retained.identity_rules, basis.identity_rule.clone());
    for field in &basis.field_definitions {
        add(&mut retained.definitions, field.clone());
    }
    add(&mut retained.source_bases, basis);
}

fn dependency_ref(retained: &mut ReleaseRetention, dependency: ReadDependency) {
    match &dependency {
        ReadDependency::Evidence { reference } => add(&mut retained.evidence, reference.clone()),
        ReadDependency::Definition { reference } => {
            add(&mut retained.definitions, reference.clone())
        }
        ReadDependency::SourceMapping {
            mapping,
            identity_rule,
            authority,
            binding,
        } => {
            add(&mut retained.schema_mappings, mapping.clone());
            add(&mut retained.identity_rules, identity_rule.clone());
            add(
                &mut retained.authorities,
                (binding.clone(), authority.clone()),
            );
            add(&mut retained.definitions, binding.clone());
        }
        ReadDependency::SourceField { schema, .. } => add(&mut retained.schemas, schema.clone()),
        ReadDependency::Source { binding, .. } => add(&mut retained.definitions, binding.clone()),
        _ => {}
    }
    add(&mut retained.dependencies, dependency);
}

fn add<T: PartialEq>(values: &mut Vec<T>, value: T) {
    if !values.contains(&value) {
        values.push(value);
    }
}
