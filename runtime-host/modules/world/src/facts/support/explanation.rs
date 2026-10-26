use std::collections::{BTreeMap, BTreeSet};

use super::{
    basis::Reader, decode, dependencies, maintenance::transaction_snapshot, number, reject,
    watches::auth_error,
};
use crate::{
    authorization::{self, Admission, AuthError},
    facts::assertions::{claim_subjects, value_resources},
    store::{RetentionRoots, StoreError, WorldSnapshot, WorldTransaction},
};
use world_protocol::{
    authorization::{AccessMode, AccessScope, ActualImpact},
    definitions::DefinitionBody,
    expression::Effect,
    facts::{Assertion, AssertionOrigin, Claim, Evidence},
    ids::*,
    provenance::*,
    releases::Release,
    time::{Timestamp, ValidTime},
    value::DirtyState,
};

pub(crate) async fn explanation_retention(
    tx: &WorldTransaction<'_>,
    conclusion: &AssertionRef,
    revision: Revision,
) -> Result<RetentionRoots, StoreError> {
    if conclusion.world != *tx.world() {
        return Err(reject(ProvenanceFailure::CrossScope));
    }
    let row = tx.query_opt(
        "SELECT body FROM world_explanation_revision WHERE tenant_id=$1 AND world_id=$2 AND conclusion_id=$3 AND conclusion_revision=$4 AND revision=$5",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &conclusion.id.as_str(), &number(conclusion.revision.0)?, &number(revision.0)?],
    ).await?.ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
    let graph: ExplanationGraph = decode(row.get("body"))?;
    if graph.conclusion != *conclusion || graph.revision != revision {
        return Err(reject(ProvenanceFailure::InternalFault));
    }
    let references: Vec<_> = graph
        .supports
        .iter()
        .map(|support| support.reference.clone())
        .collect();
    let mut roots = super::basis::support_retention(tx, &references).await?;
    roots.dependencies.push(ReadDependency::Assertion {
        reference: conclusion.clone(),
    });
    roots.evidence.extend(graph.visible_evidence);
    Ok(roots)
}

pub(crate) async fn explain_impact(
    tx: &WorldTransaction<'_>,
    conclusion: &AssertionRef,
    scope: &ScopeId,
    release: &ReleaseId,
    branch: Option<&BranchId>,
) -> Result<ActualImpact, StoreError> {
    if conclusion.world != *tx.world() {
        return Err(reject(ProvenanceFailure::CrossScope));
    }
    let row = tx.query_opt(
        "SELECT revision FROM world_assertion_head WHERE tenant_id=$1 AND world_id=$2 AND assertion_id=$3 FOR SHARE",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &conclusion.id.as_str()],
    ).await?.ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
    if row.get::<_, i64>("revision") != number(conclusion.revision.0)? {
        return Err(StoreError::new(
            world_protocol::commit::CommitFailure::ReadDependencyChanged {
                resource: ResourceRef::Assertion {
                    id: conclusion.id.clone(),
                },
            },
            world_protocol::failure::FailureStage::Validate,
        ));
    }
    let row = tx.query_opt("SELECT body FROM world_assertion_revision WHERE tenant_id=$1 AND world_id=$2 AND assertion_id=$3 AND revision=$4", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &conclusion.id.as_str(), &number(conclusion.revision.0)?]).await?.ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
    let assertion: Assertion = decode(row.get("body"))?;
    if assertion.reference != *conclusion || assertion.scope != *scope {
        return Err(reject(ProvenanceFailure::CrossScope));
    }
    let model = crate::query::support_model(tx, release, branch)
        .await
        .map_err(super::query_error)?;
    impact(tx, conclusion, &model, scope, &assertion.valid_time, &[]).await
}

/// Hidden alternatives leave no identifiers, counts, flags, or revision gaps in this projection.
pub(crate) async fn explain(
    tx: &WorldTransaction<'_>,
    conclusion: &AssertionRef,
    scope: &ScopeId,
    release: &ReleaseId,
    branch: Option<&BranchId>,
    admission: &Admission,
    budget: &crate::extensions::invocation::CallBudget,
    cancellation: &tokio_util::sync::CancellationToken,
    at: &Timestamp,
) -> Result<ExplanationGraph, StoreError> {
    super::checkpoint(budget, cancellation)?;
    let root = explain_impact(tx, conclusion, scope, release, branch).await?;
    let model = crate::query::support_model(tx, release, branch)
        .await
        .map_err(super::query_error)?;
    authorization::check_admitted_output(tx, admission, &root, 1, at)
        .await
        .map_err(auth_error)?;
    let snapshot =
        transaction_snapshot(tx, conclusion, scope, release, branch, budget, cancellation).await?;
    let mut pending = snapshot.supports;
    let mut groups = BTreeMap::new();
    let mut requirements = BTreeMap::new();
    let mut loaded = BTreeSet::from([conclusion.clone()]);
    while let Some(support) = pending.pop() {
        super::checkpoint(budget, cancellation)?;
        if support.status != SupportStatus::Valid
            || support.dirty != DirtyState::Clean
            || !support.valid_time.contains(at)
            || groups.contains_key(&support.reference)
        {
            continue;
        }
        let output = impact(
            tx,
            &support.conclusion,
            &model,
            scope,
            &support.valid_time,
            std::slice::from_ref(&support),
        )
        .await?;
        match authorization::check_admitted_output(tx, admission, &output, 1, at).await {
            Ok(_) => {}
            Err(AuthError::Denied(_)) => continue,
            Err(error) => return Err(auth_error(error)),
        }
        let mut derived = BTreeSet::new();
        for dependency in dependencies(&support) {
            if let ReadDependency::Assertion { reference } = dependency {
                let row = tx.query_opt("SELECT body FROM world_assertion_revision WHERE tenant_id=$1 AND world_id=$2 AND assertion_id=$3 AND revision=$4", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &reference.id.as_str(), &number(reference.revision.0)?]).await?.ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
                if matches!(
                    decode::<Assertion>(row.get("body"))?.origin,
                    AssertionOrigin::Derived { .. }
                ) {
                    derived.insert(reference.clone());
                    if loaded.insert(reference.clone()) {
                        pending.extend(
                            transaction_snapshot(
                                tx,
                                &reference,
                                scope,
                                release,
                                branch,
                                budget,
                                cancellation,
                            )
                            .await?
                            .supports,
                        );
                    }
                }
            }
        }
        requirements.insert(support.reference.clone(), derived);
        groups.insert(support.reference.clone(), support);
    }
    // AND premises require rooted visible paths; an authorized OR alternative is sufficient.
    let mut rooted = BTreeSet::new();
    let mut justified = BTreeSet::new();
    loop {
        let mut changed = false;
        for (reference, support) in &groups {
            super::checkpoint(budget, cancellation)?;
            if !rooted.contains(reference) && requirements[reference].is_subset(&justified) {
                rooted.insert(reference.clone());
                justified.insert(support.conclusion.clone());
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    let mut reachable = BTreeSet::from([conclusion.clone()]);
    let mut visible = BTreeMap::new();
    loop {
        let mut changed = false;
        for reference in &rooted {
            super::checkpoint(budget, cancellation)?;
            let support = &groups[reference];
            if reachable.contains(&support.conclusion) && !visible.contains_key(reference) {
                reachable.extend(requirements[reference].iter().cloned());
                visible.insert(reference.clone(), support.clone());
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    let visible: Vec<SupportSet> = visible.into_values().collect();
    let evidence: BTreeSet<_> = visible
        .iter()
        .flat_map(dependencies)
        .filter_map(|dependency| {
            if let ReadDependency::Evidence { reference } = dependency {
                Some(reference)
            } else {
                None
            }
        })
        .collect();
    let mut access = root.access.clone();
    let mut effects = root.effects.clone();
    let mut labels = root.labels.clone();
    let mut state = root.state.clone();
    let mut sources = root.source_ids.clone();
    for support in &visible {
        super::checkpoint(budget, cancellation)?;
        let output = impact(
            tx,
            &support.conclusion,
            &model,
            scope,
            &support.valid_time,
            std::slice::from_ref(support),
        )
        .await?;
        access.extend(output.access);
        effects.extend(output.effects);
        labels.extend(output.labels);
        state.extend(output.state);
        sources.extend(output.source_ids);
    }
    let output = authorization::actual_impact(access, effects, labels, state, sources)
        .map_err(auth_error)?;
    authorization::check_admitted_output(
        tx,
        admission,
        &output,
        1 + visible.len() as u64 + evidence.len() as u64,
        at,
    )
    .await
    .map_err(auth_error)?;
    let visibility = super::key(&(
        scope,
        release,
        branch,
        admission.impact().digest.clone(),
        admission.decision().policy_epoch,
        admission.decision().grant_epoch,
    ))?;
    let body = super::encode(&(&visible, &evidence))?;
    let row = tx.query_opt("INSERT INTO world_explanation_view(tenant_id,world_id,conclusion_id,conclusion_revision,visibility_digest,revision,body) VALUES($1,$2,$3,$4,$5,1,$6) ON CONFLICT(tenant_id,world_id,conclusion_id,conclusion_revision,visibility_digest) DO UPDATE SET revision=CASE WHEN world_explanation_view.body=EXCLUDED.body THEN world_explanation_view.revision ELSE world_explanation_view.revision+1 END,body=EXCLUDED.body RETURNING revision", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &conclusion.id.as_str(), &number(conclusion.revision.0)?, &visibility, &body]).await?.ok_or_else(|| reject(ProvenanceFailure::InternalFault))?;
    Ok(ExplanationGraph {
        conclusion: conclusion.clone(),
        revision: Revision(row.get::<_, i64>("revision") as u64),
        supports: visible,
        visible_evidence: evidence.into_iter().collect(),
    })
}

async fn impact(
    tx: &WorldTransaction<'_>,
    conclusion: &AssertionRef,
    model: &Release,
    scope: &ScopeId,
    valid_time: &ValidTime,
    supports: &[SupportSet],
) -> Result<ActualImpact, StoreError> {
    let mut resources = Vec::new();
    let mut dependencies = vec![ReadDependency::Assertion {
        reference: conclusion.clone(),
    }];
    for support in supports {
        resources.push(ResourceRef::Support {
            id: support.reference.id.clone(),
        });
        dependencies.extend(super::dependencies(support));
        for argument in &support.arguments {
            value_resources(&argument.value, &mut resources);
        }
        if let DirtyState::Dirty { watches, .. } = &support.dirty {
            resources.extend(watches.iter().cloned().map(|id| ResourceRef::Watch { id }));
        }
    }
    let mut impact = dependency_impact(tx, &dependencies, model, scope, valid_time)
        .await?
        .ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
    if !resources.is_empty() {
        impact.access.push(AccessScope {
            resources,
            fields: Vec::new(),
            modes: vec![AccessMode::Read],
            scope: scope.clone(),
            valid_time: Some(valid_time.clone()),
        });
    }
    authorization::actual_impact(
        impact.access,
        impact.effects,
        impact.labels,
        impact.state,
        impact.source_ids,
    )
    .map_err(auth_error)
}

/// Derives current read requirements only. The caller still admits/rechecks and validates dependencies.
pub(crate) async fn dependency_impact(
    tx: &WorldTransaction<'_>,
    dependencies: &[ReadDependency],
    model: &Release,
    scope: &ScopeId,
    valid_time: &ValidTime,
) -> Result<Option<ActualImpact>, StoreError> {
    dependency_impact_read(
        Reader::Transaction(tx),
        dependencies,
        model,
        scope,
        valid_time,
    )
    .await
}

pub(crate) async fn dependency_impact_snapshot(
    snapshot: &WorldSnapshot<'_>,
    dependencies: &[ReadDependency],
    model: &Release,
    scope: &ScopeId,
    valid_time: &ValidTime,
) -> Result<Option<ActualImpact>, StoreError> {
    dependency_impact_read(
        Reader::Snapshot(snapshot),
        dependencies,
        model,
        scope,
        valid_time,
    )
    .await
}

async fn dependency_impact_read(
    reader: Reader<'_, '_>,
    dependencies: &[ReadDependency],
    model: &Release,
    scope: &ScopeId,
    valid_time: &ValidTime,
) -> Result<Option<ActualImpact>, StoreError> {
    let world = reader.world();
    if model.world != *world {
        return Err(reject(ProvenanceFailure::CrossScope));
    }
    if dependencies.len() > super::BATCH_LIMIT {
        return Err(super::limit(ProvenanceLimit::ProposalItems));
    }
    let mut active = None;
    let mut resources = Vec::new();
    let mut access = Vec::new();
    let mut labels = Vec::new();
    let mut fields = Vec::new();
    let mut sources = Vec::new();
    let mut effects = vec![Effect::Pure];
    let mut state = Vec::new();
    let mut pending = dependencies.to_vec();
    let mut seen = BTreeSet::new();
    let selected: BTreeMap<_, _> = model
        .definitions
        .iter()
        .map(|definition| (&definition.reference, definition))
        .collect();
    while let Some(dependency) = pending.pop() {
        if !seen.insert(super::key(&dependency)?) {
            continue;
        }
        if seen.len() > super::BATCH_LIMIT {
            return Err(super::limit(ProvenanceLimit::ProposalItems));
        }
        match dependency {
            ReadDependency::Assertion { reference } => {
                if reference.world != *world {
                    return Err(reject(ProvenanceFailure::CrossScope));
                }
                resources.push(ResourceRef::Assertion {
                    id: reference.id.clone(),
                });
                let row = reader.query_opt(
                    "SELECT body FROM world_assertion_revision WHERE tenant_id=$1 AND world_id=$2 AND assertion_id=$3 AND revision=$4",
                    "SELECT body FROM world_assertion_revision WHERE tenant_id=$1 AND world_id=$2 AND assertion_id=$3 AND revision=$4",
                    &[&world.tenant_id.as_str(), &world.world_id.as_str(), &reference.id.as_str(), &number(reference.revision.0)?],
                ).await?.ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
                let assertion: Assertion = decode(row.get("body"))?;
                if assertion.reference != reference {
                    return Err(reject(ProvenanceFailure::InternalFault));
                }
                pending.extend(
                    assertion
                        .evidence
                        .into_iter()
                        .map(|reference| ReadDependency::Evidence { reference }),
                );
                resources.extend(claim_subjects(&assertion.claim).into_iter().map(|subject| {
                    match subject {
                        world_protocol::identity::SubjectRef::Object { id } => {
                            ResourceRef::Object { id }
                        }
                        world_protocol::identity::SubjectRef::Relation { id } => {
                            ResourceRef::Relation { id }
                        }
                    }
                }));
                let field = match assertion.claim {
                    Claim::Attribute(claim) => claim.property,
                    Claim::Relation(claim) => claim.relation_type,
                };
                fields.push(field.clone());
                pending.push(ReadDependency::Definition { reference: field });
            }
            ReadDependency::Evidence { reference } => {
                if reference.world != *world {
                    return Err(reject(ProvenanceFailure::CrossScope));
                }
                resources.push(ResourceRef::Evidence {
                    id: reference.id.clone(),
                });
                let row = reader.query_opt(
                    "SELECT body FROM world_evidence_revision WHERE tenant_id=$1 AND world_id=$2 AND evidence_id=$3 AND revision=$4",
                    "SELECT body FROM world_evidence_revision WHERE tenant_id=$1 AND world_id=$2 AND evidence_id=$3 AND revision=$4",
                    &[&world.tenant_id.as_str(), &world.world_id.as_str(), &reference.id.as_str(), &number(reference.revision.0)?],
                ).await?.ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
                let exact: Evidence = decode(row.get("body"))?;
                if exact.reference != reference {
                    return Err(reject(ProvenanceFailure::InternalFault));
                }
                let row = reader.query_opt(
                    "SELECT r.body FROM world_evidence_head h JOIN world_evidence_revision r USING(tenant_id,world_id,evidence_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.evidence_id=$3 FOR SHARE OF h",
                    "SELECT r.body FROM world_evidence_head h JOIN world_evidence_revision r USING(tenant_id,world_id,evidence_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.evidence_id=$3",
                    &[&world.tenant_id.as_str(), &world.world_id.as_str(), &reference.id.as_str()],
                ).await?.ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
                let head: Evidence = decode(row.get("body"))?;
                for evidence in std::iter::once(&exact)
                    .chain((head.reference != exact.reference).then_some(&head))
                {
                    labels.extend(evidence.access.labels.clone());
                    let source = match reader {
                        Reader::Transaction(tx) => {
                            crate::content::read_source_version_metadata(
                                tx,
                                &evidence.locator.source_version,
                            )
                            .await
                        }
                        Reader::Snapshot(snapshot) => {
                            crate::content::read_source_version_metadata_snapshot(
                                snapshot,
                                &evidence.locator.source_version,
                            )
                            .await
                        }
                    }
                    .map_err(|error| match error {
                        crate::content::Error::Store(error) => error,
                        error => StoreError::caused_by(
                            world_protocol::commit::CommitFailure::InvalidBatch,
                            world_protocol::failure::FailureStage::Read,
                            error,
                        ),
                    })?;
                    let material = match reader {
                        Reader::Transaction(tx) => {
                            authorization::material_read_impact(tx, &source).await
                        }
                        Reader::Snapshot(snapshot) => {
                            authorization::material_read_impact_snapshot(snapshot, &source).await
                        }
                    }
                    .map_err(auth_error)?;
                    resources.push(ResourceRef::Source {
                        id: source.reference.source_id.clone(),
                    });
                    access.extend(material.access);
                    labels.extend(material.labels);
                    sources.extend(material.source_ids);
                    effects.extend(material.effects);
                    state.extend(material.state);
                }
            }
            ReadDependency::Definition { reference } => {
                if reference.world != *world {
                    return Err(reject(ProvenanceFailure::CrossScope));
                }
                let exact = selected
                    .get(&reference)
                    .ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
                crate::definitions::validate_applicability(exact, scope, valid_time, &model.scopes)
                    .map_err(|error| {
                        StoreError::caused_by(
                            world_protocol::commit::CommitFailure::InvalidBatch,
                            world_protocol::failure::FailureStage::Validate,
                            crate::definitions::DefinitionError::from(error),
                        )
                    })?;
                resources.push(ResourceRef::Definition {
                    id: reference.id.clone(),
                });
                if active.is_none() {
                    let current = match reader {
                        Reader::Transaction(tx) => crate::releases::read_active_model(tx).await,
                        Reader::Snapshot(snapshot) => {
                            match crate::releases::read_active_release_snapshot(snapshot)
                                .await
                                .map_err(release_error)?
                            {
                                Some(id) => {
                                    crate::releases::read_release_snapshot(snapshot, &id).await
                                }
                                None => Ok(None),
                            }
                        }
                    }
                    .map_err(release_error)?
                    .ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
                    active = Some(
                        current
                            .definitions
                            .into_iter()
                            .map(|definition| (definition.reference.id.clone(), definition))
                            .collect::<BTreeMap<_, _>>(),
                    );
                }
                for definition in std::iter::once(*exact).chain(
                    active
                        .as_ref()
                        .and_then(|definitions| definitions.get(&reference.id)),
                ) {
                    if definition.body.kind() != exact.body.kind() {
                        return Err(reject(ProvenanceFailure::MissingPremise));
                    }
                    access.push(AccessScope {
                        resources: vec![ResourceRef::Definition {
                            id: reference.id.clone(),
                        }],
                        fields: vec![reference.clone()],
                        modes: vec![AccessMode::Read],
                        scope: definition.scope.clone(),
                        valid_time: Some(valid_time.clone()),
                    });
                    match &definition.body {
                        DefinitionBody::Property(property) => {
                            labels.extend(property.access_labels.clone())
                        }
                        DefinitionBody::SourceBinding(binding) => {
                            resources.push(ResourceRef::Source {
                                id: binding.source_id.clone(),
                            });
                            sources.push(binding.source_id.clone());
                        }
                        _ => {}
                    }
                }
                if let DefinitionBody::SourceBinding(binding) = &exact.body {
                    for mapping in &binding.field_mapping {
                        fields.push(mapping.property.clone());
                        pending.push(ReadDependency::Definition {
                            reference: mapping.property.clone(),
                        });
                    }
                }
            }
            ReadDependency::SourceMapping { binding, .. } => {
                pending.push(ReadDependency::Definition { reference: binding })
            }
            ReadDependency::Source { position, binding } => {
                if binding.world != *world {
                    return Err(reject(ProvenanceFailure::CrossScope));
                }
                resources.push(ResourceRef::Source {
                    id: position.source_id.clone(),
                });
                sources.push(position.source_id);
            }
            ReadDependency::Watch { id, .. } => resources.push(ResourceRef::Watch { id }),
            ReadDependency::Identity {
                subject: world_protocol::identity::SubjectRef::Object { id },
                ..
            } => resources.push(ResourceRef::Object { id }),
            ReadDependency::Identity {
                subject: world_protocol::identity::SubjectRef::Relation { id },
                ..
            } => resources.push(ResourceRef::Relation { id }),
            ReadDependency::SourceField { schema, .. } => {
                if schema.world != *world {
                    return Err(reject(ProvenanceFailure::CrossScope));
                }
                let row = reader.query_opt(
                    "SELECT source_id FROM world_source_schema_revision WHERE tenant_id=$1 AND world_id=$2 AND schema_id=$3 AND revision=$4",
                    "SELECT source_id FROM world_source_schema_revision WHERE tenant_id=$1 AND world_id=$2 AND schema_id=$3 AND revision=$4",
                    &[&world.tenant_id.as_str(), &world.world_id.as_str(), &schema.id.as_str(), &number(schema.revision.0)?],
                ).await?.ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
                let id = SourceId::try_new(row.get::<_, String>("source_id"))
                    .map_err(|_| reject(ProvenanceFailure::InternalFault))?;
                resources.push(ResourceRef::Source { id: id.clone() });
                sources.push(id);
            }
            ReadDependency::AliasRange { .. } | ReadDependency::TimeBoundary { .. } => {}
        }
    }
    resources.sort();
    resources.dedup();
    fields.sort();
    fields.dedup();
    labels.sort();
    labels.dedup();
    sources.sort();
    sources.dedup();
    if !resources.is_empty() {
        access.push(AccessScope {
            resources,
            fields,
            modes: vec![AccessMode::Read],
            scope: scope.clone(),
            valid_time: Some(valid_time.clone()),
        });
    }
    if access.is_empty() {
        return Ok(None);
    }
    authorization::actual_impact(access, effects, labels, state, sources)
        .map(Some)
        .map_err(auth_error)
}

fn release_error(error: crate::releases::Error) -> StoreError {
    StoreError::caused_by(
        world_protocol::commit::CommitFailure::InvalidBatch,
        world_protocol::failure::FailureStage::Read,
        error,
    )
}
