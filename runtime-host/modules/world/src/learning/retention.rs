use super::{
    Error, invalid,
    proposal::{decode, number},
};
use crate::{
    definitions,
    store::{RetentionRoots, WorldSnapshot, WorldTransaction},
};
use world_protocol::{
    definitions::{Definition, DefinitionBody},
    ids::{CandidateId, ResourceRef, Revision},
    learning::{Candidate, SemanticOperation},
};

/// Retained candidates keep their embedded evidence's exact material metadata in the same snapshot.
pub(crate) async fn archive_retention_roots(
    snapshot: &WorldSnapshot<'_>,
) -> Result<RetentionRoots, Error> {
    let mut roots = RetentionRoots::default();
    let mut after = String::new();
    let mut after_revision = 0i64;
    loop {
        let rows = snapshot.query("SELECT candidate_id,revision,content_digest,body FROM world_candidate_revision WHERE tenant_id=$1 AND world_id=$2 AND (candidate_id,revision)>($3,$4) ORDER BY candidate_id,revision LIMIT 256",
            &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &after, &after_revision]).await?;
        let done = rows.len() < 256;
        for row in rows {
            after = row.get("candidate_id");
            after_revision = row.get("revision");
            let candidate: Candidate = decode(row.get("body"))?;
            if candidate.world != *snapshot.world()
                || candidate.id.as_str() != after
                || candidate.change_set.world != *snapshot.world()
                || number(candidate.change_set.revision)? != row.get::<_, i64>("revision")
                || definitions::canonical_digest(&candidate)?.as_str()
                    != row.get::<_, String>("content_digest")
            {
                return Err(invalid(0, "retention.candidate"));
            }
            for evidence in &candidate.evidence {
                crate::facts::assertions::evidence_retention_roots(evidence, &mut roots);
            }
        }
        if done {
            break;
        }
    }
    roots.source_versions.sort_by(|left, right| {
        (&left.source_id, &left.version_id).cmp(&(&right.source_id, &right.version_id))
    });
    roots.source_versions.dedup();
    roots.parse_artifacts.sort();
    roots.parse_artifacts.dedup();
    roots.evidence.sort();
    roots.evidence.dedup();
    Ok(roots)
}

/// Candidates are retained history; branch/change-set tables themselves remain Store's closure.
pub(crate) async fn world_deletion_roots(
    tx: &WorldTransaction<'_>,
) -> Result<RetentionRoots, Error> {
    let mut roots = RetentionRoots::default();
    let mut after = String::new();
    let mut after_revision = 0i64;
    loop {
        let rows = tx.query("SELECT candidate_id,revision,content_digest,body FROM world_candidate_revision WHERE tenant_id=$1 AND world_id=$2 AND (candidate_id,revision)>($3,$4) ORDER BY candidate_id,revision LIMIT 256",
            &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &after, &after_revision]).await?;
        let done = rows.len() < 256;
        for row in rows {
            after = row.get("candidate_id");
            after_revision = row.get("revision");
            let candidate: Candidate = decode(row.get("body"))?;
            if candidate.world != *tx.world()
                || candidate.id.as_str() != after
                || candidate.change_set.world != *tx.world()
                || number(candidate.change_set.revision)? != row.get::<_, i64>("revision")
                || definitions::canonical_digest(&candidate)?.as_str()
                    != row.get::<_, String>("content_digest")
            {
                return Err(invalid(0, "retention.candidate"));
            }
            candidate_retention_roots(tx, &candidate, &mut roots).await?;
        }
        if done {
            break;
        }
    }
    roots.resources.sort();
    roots.resources.dedup();
    roots.definitions.sort();
    roots.definitions.dedup();
    roots.evidence.sort();
    roots.evidence.dedup();
    roots.releases.sort();
    roots.releases.dedup();
    roots.scopes.sort();
    roots.scopes.dedup();
    Ok(roots)
}

pub(crate) async fn candidate_revision_retention_roots(
    tx: &WorldTransaction<'_>,
    references: &[(CandidateId, Revision)],
) -> Result<RetentionRoots, Error> {
    let mut roots = RetentionRoots::default();
    for (id, revision) in references {
        let row = tx.query_opt(
            "SELECT content_digest,change_set_id,body FROM world_candidate_revision WHERE tenant_id=$1 AND world_id=$2 AND candidate_id=$3 AND revision=$4",
            &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &id.as_str(), &number(*revision)?],
        ).await?.ok_or_else(|| invalid(0, "retention.candidate"))?;
        let candidate: Candidate = decode(row.get("body"))?;
        if candidate.world != *tx.world() || candidate.id != *id
            || candidate.change_set.world != *tx.world()
            || candidate.change_set.revision != *revision
            || candidate.change_set.id.as_str() != row.get::<_, String>("change_set_id")
            || definitions::canonical_digest(&candidate)?.as_str() != row.get::<_, String>("content_digest")
        {
            return Err(invalid(0, "retention.candidate"));
        }
        candidate_retention_roots(tx, &candidate, &mut roots).await?;
        roots.resources.retain(|resource| !matches!(resource, ResourceRef::ChangeSet { id } if id == &candidate.change_set.id));
    }
    Ok(roots)
}

/// Also used for durable, not-yet-admitted extraction drafts: new declarations are not canonical roots.
pub(crate) async fn candidate_retention_roots(
    tx: &WorldTransaction<'_>,
    candidate: &Candidate,
    roots: &mut RetentionRoots,
) -> Result<(), Error> {
    if candidate.world != *tx.world() || candidate.change_set.world != *tx.world() {
        return Err(invalid(0, "retention.candidate.world"));
    }
    let mut draft = RetentionRoots::default();
    draft
        .releases
        .push(candidate.change_set.base_release.clone());
    draft
        .evidence
        .extend(candidate.change_set.evidence.iter().cloned());
    draft.resources.extend(
        candidate
            .change_set
            .cases
            .iter()
            .cloned()
            .map(|id| ResourceRef::Case { id }),
    );
    if tx.query_opt("SELECT 1 FROM world_change_set WHERE tenant_id=$1 AND world_id=$2 AND change_set_id=$3 LIMIT 1",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &candidate.change_set.id.as_str()]).await?.is_some() {
        draft.resources.push(ResourceRef::ChangeSet { id: candidate.change_set.id.clone() });
    }
    retain_operations(&mut draft, &candidate.change_set.operations);
    for evidence in &candidate.evidence {
        draft.evidence.push(evidence.reference.clone());
        crate::facts::assertions::evidence_retention_roots(evidence, &mut draft);
    }
    append_existing(tx, draft, roots).await
}

pub(crate) async fn proposal_retention_roots(
    tx: &WorldTransaction<'_>,
    request: &world_protocol::api::ProposeChange,
    roots: &mut RetentionRoots,
) -> Result<(), Error> {
    let mut draft = RetentionRoots::default();
    if request.task.world == *tx.world() {
        draft.resources.push(ResourceRef::Task {
            id: request.task.id.clone(),
        });
        draft.releases.push(request.base_release.clone());
        draft.evidence.extend(request.evidence.iter().cloned());
        draft.resources.extend(
            request
                .cases
                .iter()
                .cloned()
                .map(|id| ResourceRef::Case { id }),
        );
        retain_operations(&mut draft, &request.operations);
    }
    append_existing(tx, draft, roots).await?;
    compile_retention_roots(tx, &request.compile, roots).await
}

pub(crate) async fn abstraction_proposal_retention_roots(
    tx: &WorldTransaction<'_>,
    request: &world_protocol::api::ProposeAbstraction,
    roots: &mut RetentionRoots,
) -> Result<(), Error> {
    proposal_retention_roots(tx, &request.change, roots).await?;
    let mut draft = RetentionRoots::default();
    crate::abstraction::retain_draft(tx.world(), &request.abstraction, &mut draft);
    if let Some(contract) = crate::abstraction::read(tx, &request.abstraction.id, request.abstraction.revision).await.map_err(crate::owner::Error::from)? {
        crate::abstraction::retain_contract(tx.world(), &contract, &mut draft);
    }
    roots.branches.append(&mut draft.branches);
    append_existing(tx, draft, roots).await
}

pub(crate) async fn compile_retention_roots(
    tx: &WorldTransaction<'_>,
    selection: &world_protocol::compiler::CompileSelection,
    roots: &mut RetentionRoots,
) -> Result<(), Error> {
    let graph = crate::extensions::bindings::read_graph_history_in_transaction(
        tx,
        &selection.activation_lock_id,
    )
    .await
    .map_err(crate::owner::Error::from)?;
    let mut draft = RetentionRoots::default();
    for node in &graph.lock().nodes {
        draft.resources.push(ResourceRef::Package {
            id: node.implementation.install_id.clone(),
        });
        draft.resources.push(ResourceRef::Binding {
            id: node.binding_id.clone(),
        });
    }
    for external in &selection.external_contracts {
        match &external.kind {
            world_protocol::compiler::ExternalContractUse::Function { reference }
            | world_protocol::compiler::ExternalContractUse::Source { binding: reference } => {
                draft.definitions.push(reference.clone())
            }
            _ => {}
        }
    }
    append_existing(tx, draft, roots).await
}

async fn append_existing(
    tx: &WorldTransaction<'_>,
    draft: RetentionRoots,
    roots: &mut RetentionRoots,
) -> Result<(), Error> {
    for reference in draft.definitions {
        if reference.world == *tx.world()
            && definitions::read_definition(tx, &reference)
                .await?
                .is_some()
        {
            roots.definitions.push(reference);
        }
    }
    for reference in draft.evidence {
        if reference.world == *tx.world()
            && crate::facts::assertions::read_evidence(tx, &reference)
                .await?
                .is_some()
        {
            roots.evidence.push(reference);
        }
    }
    for resource in draft.resources {
        if let ResourceRef::Definition { id } = &resource {
            if tx.query_opt("SELECT 1 FROM world_definition_revision WHERE tenant_id=$1 AND world_id=$2 AND definition_id=$3 LIMIT 1",
                &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &id.as_str()]).await?.is_none() { continue; }
        }
        roots.resources.push(resource);
    }
    for dependency in draft.dependencies {
        if let world_protocol::provenance::ReadDependency::SourceMapping {
            binding, mapping, ..
        } = &dependency
        {
            if binding.world != *tx.world()
                || mapping.world != *tx.world()
                || definitions::read_definition(tx, binding).await?.is_none()
            {
                continue;
            }
        }
        roots.dependencies.push(dependency);
    }
    roots.scopes.extend(draft.scopes);
    roots.releases.extend(draft.releases);
    roots.source_versions.extend(
        draft
            .source_versions
            .into_iter()
            .filter(|reference| reference.world == *tx.world()),
    );
    roots.parse_artifacts.extend(draft.parse_artifacts);
    roots.schemas.extend(
        draft
            .schemas
            .into_iter()
            .filter(|reference| reference.world == *tx.world()),
    );
    roots.mappings.extend(
        draft
            .mappings
            .into_iter()
            .filter(|reference| reference.world == *tx.world()),
    );
    Ok(())
}

pub(crate) fn retain_operations(roots: &mut RetentionRoots, operations: &[SemanticOperation]) {
    for operation in operations {
        match operation {
            SemanticOperation::NoOp { .. } => {}
            SemanticOperation::AttachEvidence { target, evidence } => {
                roots.resources.push(target.clone());
                roots.evidence.extend(evidence.iter().cloned());
            }
            SemanticOperation::EnrichAnnotation { target, .. } => {
                roots.definitions.push(target.clone())
            }
            SemanticOperation::CreateDefinition { definition } => {
                retain_definition(roots, definition)
            }
            SemanticOperation::RefineDefinition {
                previous,
                replacement,
            }
            | SemanticOperation::SupersedeRule {
                previous,
                replacement,
            } => {
                roots.definitions.push(previous.clone());
                retain_definition(roots, replacement);
            }
            SemanticOperation::ScopeDefinition {
                previous, scope, ..
            } => {
                roots.definitions.push(previous.clone());
                roots.scopes.push(scope.clone());
            }
            SemanticOperation::LinkExisting { source, target, .. } => {
                roots.definitions.extend([source.clone(), target.clone()])
            }
            SemanticOperation::MergeAliases {
                sources,
                target,
                evidence,
            } => {
                roots.definitions.extend(sources.iter().cloned());
                roots.definitions.push(target.clone());
                roots.evidence.extend(evidence.iter().cloned());
            }
            SemanticOperation::DeprecateDefinition {
                previous,
                replacements,
                ..
            } => {
                roots.definitions.push(previous.clone());
                roots.definitions.extend(replacements.iter().cloned());
            }
            SemanticOperation::SplitDefinition {
                previous,
                replacements,
                partition,
            } => {
                roots.definitions.push(previous.clone());
                for definition in replacements {
                    retain_definition(roots, definition);
                }
                for part in partition {
                    roots.resources.push(ResourceRef::Definition {
                        id: part.replacement.clone(),
                    });
                    retain_expression(roots, &part.predicate);
                }
            }
        }
    }
}

pub(crate) fn retain_expression(
    roots: &mut RetentionRoots,
    expression: &world_protocol::expression::ExpressionIr,
) {
    roots
        .definitions
        .extend(definitions::expression_references(expression));
    roots
        .resources
        .extend(definitions::expression_resources(expression));
}

fn retain_definition(roots: &mut RetentionRoots, definition: &Definition<DefinitionBody>) {
    roots.scopes.push(definition.scope.clone());
    roots.definitions.push(definition.reference.clone());
    roots
        .definitions
        .extend(definition.dependencies.iter().cloned());
    roots
        .definitions
        .extend(definition.previous_ref.iter().cloned());
    roots
        .definitions
        .extend(definitions::definition_references(&definition.body));
    roots
        .resources
        .extend(definitions::definition_resources(&definition.body));
    roots.evidence.extend(definition.evidence.iter().cloned());
    match &definition.lifecycle {
        world_protocol::definitions::DefinitionLifecycle::Deprecated { replacements, .. }
        | world_protocol::definitions::DefinitionLifecycle::Split { replacements, .. } => {
            roots.definitions.extend(replacements.iter().cloned())
        }
        world_protocol::definitions::DefinitionLifecycle::Available => {}
    }
    match &definition.body {
        DefinitionBody::SourceBinding(source) => {
            roots.schemas.push(source.schema.clone());
            roots.mappings.push(source.mapping.clone());
            roots
                .dependencies
                .push(world_protocol::provenance::ReadDependency::SourceMapping {
                    mapping: source.mapping.clone(),
                    identity_rule: source.identity_rule.clone(),
                    authority: source.authority.clone(),
                    binding: definition.reference.clone(),
                });
        }
        DefinitionBody::Strategy(strategy) => {
            roots.resources.extend(
                strategy
                    .cases
                    .iter()
                    .cloned()
                    .map(|id| ResourceRef::Case { id }),
            );
            roots.resources.extend(
                strategy
                    .counterexamples
                    .iter()
                    .cloned()
                    .map(|id| ResourceRef::TestCase { id }),
            );
        }
        _ => {}
    }
}
