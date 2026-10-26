use std::collections::{BTreeMap, BTreeSet};

use super::{
    Error, invalid,
    proposal::{decode, encode, number},
    require_writer,
};
use crate::{
    authorization::{self, Admission},
    definitions::canonical_digest,
    store::WorldTransaction,
};
use world_protocol::{
    authorization::{AccessMode, AccessScope, Actor},
    definitions::{Definition, DefinitionAnnotation, DefinitionBody, DefinitionLink},
    ids::{DefinitionRef, ResourceRef, Revision},
    learning::{Annotation, LearningFailure, SemanticLink, SemanticOperation},
    releases::{BranchRef, ReleaseFailure, WorldBranch},
    time::Timestamp,
};

type Model = Definition<DefinitionBody>;

/// Materialized metadata is pinned to this immutable branch revision, never canonical heads.
pub(super) async fn materialize(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    branch: &WorldBranch,
    now: &Timestamp,
) -> Result<(), Error> {
    require_writer(tx)?;
    let reference = BranchRef {
        world: branch.world.clone(),
        id: branch.id.clone(),
        revision: branch.revision,
    };
    let mut annotations: BTreeMap<DefinitionRef, Annotation> = BTreeMap::new();
    let mut links: BTreeMap<(DefinitionRef, DefinitionRef, &'static str), DefinitionLink> =
        BTreeMap::new();
    let materialized = super::materialize_frozen(tx, branch).await?;
    for (index, operation) in materialized.metadata().iter().enumerate() {
        match operation {
            SemanticOperation::AttachEvidence { target, evidence } => {
                let ResourceRef::Definition { id } = target else {
                    return Err(Error::DependencyMissing {
                        capability: "branch_support_target",
                    });
                };
                let definition = branch
                    .compile
                    .definitions
                    .iter()
                    .find(|definition| &definition.reference.id == id)
                    .ok_or_else(|| invalid(index, "target"))?;
                authorize(tx, admission, definition, AccessMode::Write, now).await?;
                crate::facts::assertions::require_evidence(
                    tx,
                    admission,
                    evidence,
                    &definition.scope,
                    Some(&definition.valid_time),
                    now,
                )
                .await?;
                // The immutable overlay is the sole branch-local support binding.
            }
            SemanticOperation::EnrichAnnotation { target, annotation } => {
                let definition = member(branch, target)?;
                authorize(tx, admission, definition, AccessMode::Write, now).await?;
                let combined = annotations
                    .entry(target.clone())
                    .or_insert_with(|| Annotation {
                        label: None,
                        description: None,
                        aliases: Vec::new(),
                    });
                if let Some(label) = &annotation.label {
                    if combined.label.as_ref().is_some_and(|old| old != label) {
                        return Err(invalid(index, "annotation.label"));
                    }
                    combined.label = Some(label.clone());
                }
                if let Some(description) = &annotation.description {
                    if combined
                        .description
                        .as_ref()
                        .is_some_and(|old| old != description)
                    {
                        return Err(invalid(index, "annotation.description"));
                    }
                    combined.description = Some(description.clone());
                }
                combined.aliases.extend(annotation.aliases.iter().cloned());
                combined.aliases.sort();
                combined.aliases.dedup();
            }
            SemanticOperation::LinkExisting {
                source,
                target,
                relation,
            } => {
                add_link(
                    tx,
                    admission,
                    branch,
                    &reference,
                    &mut links,
                    source,
                    target,
                    *relation,
                    &branch
                        .basis
                        .overlay
                        .iter()
                        .filter_map(|operation| match operation {
                            SemanticOperation::AttachEvidence {
                                target: ResourceRef::Definition { id },
                                evidence,
                            } if id == &source.id || id == &target.id => Some(evidence.as_slice()),
                            _ => None,
                        })
                        .flatten()
                        .cloned()
                        .collect::<BTreeSet<_>>()
                        .into_iter()
                        .collect::<Vec<_>>(),
                    now,
                )
                .await?;
            }
            SemanticOperation::MergeAliases {
                sources,
                target,
                evidence,
            } => {
                for source in sources {
                    add_link(
                        tx,
                        admission,
                        branch,
                        &reference,
                        &mut links,
                        source,
                        target,
                        SemanticLink::EquivalentWithinScope,
                        evidence,
                        now,
                    )
                    .await?;
                }
            }
            _ => {}
        }
    }
    for link in links.values() {
        let source = member(branch, &link.source)?;
        crate::facts::assertions::require_evidence(
            tx,
            admission,
            &link.evidence,
            &source.scope,
            Some(&source.valid_time),
            now,
        )
        .await?;
    }
    let world = tx.world().clone();
    let actor = match &admission.invocation().actor {
        Actor::Human { id } | Actor::Service { id } => id,
    };
    for (target, annotation) in annotations {
        let record = DefinitionAnnotation {
            branch: reference.clone(),
            target,
            revision: Revision(1),
            annotation,
            previous_revision: None,
        };
        tx.execute("INSERT INTO world_definition_annotation_revision(tenant_id,world_id,branch_id,branch_revision,definition_id,definition_revision,revision,previous_revision,content_digest,actor_id,body) VALUES($1,$2,$3,$4,$5,$6,1,NULL,$7,$8,$9)",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &reference.id.as_str(), &number(reference.revision)?,
              &record.target.id.as_str(), &number(record.target.revision)?, &canonical_digest(&record)?.as_str(), &actor.as_str(), &encode(&record)?]).await?;
        tx.execute("INSERT INTO world_definition_annotation_head(tenant_id,world_id,branch_id,branch_revision,definition_id,definition_revision,revision) VALUES($1,$2,$3,$4,$5,$6,1)",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &reference.id.as_str(), &number(reference.revision)?,
              &record.target.id.as_str(), &number(record.target.revision)?]).await?;
    }
    for record in links.into_values() {
        tx.execute("INSERT INTO world_definition_link_revision(tenant_id,world_id,branch_id,branch_revision,source_id,source_revision,target_id,target_revision,relation,revision,previous_revision,content_digest,actor_id,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,NULL,$10,$11,$12)",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &reference.id.as_str(), &number(reference.revision)?,
              &record.source.id.as_str(), &number(record.source.revision)?, &record.target.id.as_str(), &number(record.target.revision)?,
              &relation_name(record.relation), &canonical_digest(&record)?.as_str(), &actor.as_str(), &encode(&record)?]).await?;
        tx.execute("INSERT INTO world_definition_link_head(tenant_id,world_id,branch_id,branch_revision,source_id,source_revision,target_id,target_revision,relation,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1)",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &reference.id.as_str(), &number(reference.revision)?,
              &record.source.id.as_str(), &number(record.source.revision)?, &record.target.id.as_str(), &number(record.target.revision)?, &relation_name(record.relation)]).await?;
    }
    Ok(())
}

async fn add_link(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    branch: &WorldBranch,
    reference: &BranchRef,
    links: &mut BTreeMap<(DefinitionRef, DefinitionRef, &'static str), DefinitionLink>,
    source: &DefinitionRef,
    target: &DefinitionRef,
    relation: SemanticLink,
    evidence: &[world_protocol::ids::EvidenceRef],
    now: &Timestamp,
) -> Result<(), Error> {
    let source_definition = member(branch, source)?;
    let target_definition = member(branch, target)?;
    authorize(tx, admission, source_definition, AccessMode::Write, now).await?;
    authorize(tx, admission, target_definition, AccessMode::Read, now).await?;
    if !crate::definitions::scope_contains(
        &branch.world,
        &target_definition.scope,
        &source_definition.scope,
        &branch.compile.scopes,
    )? || !crate::definitions::valid_time_contains(
        &target_definition.valid_time,
        &source_definition.valid_time,
    ) {
        return Err(invalid(0, "link.scope"));
    }
    let record = links
        .entry((source.clone(), target.clone(), relation_name(relation)))
        .or_insert_with(|| DefinitionLink {
            branch: reference.clone(),
            source: source.clone(),
            target: target.clone(),
            relation,
            revision: Revision(1),
            previous_revision: None,
            evidence: Vec::new(),
        });
    record.evidence.extend(evidence.iter().cloned());
    record.evidence.sort();
    record.evidence.dedup();
    Ok(())
}

pub(crate) async fn read_annotations(
    tx: &WorldTransaction<'_>,
    branch: &BranchRef,
) -> Result<Vec<DefinitionAnnotation>, Error> {
    let basis = crate::releases::read_branch_revision(tx, branch)
        .await?
        .ok_or_else(|| ReleaseFailure::BranchMissing {
            branch_id: branch.id.clone(),
        })?;
    let world = tx.world();
    let rows = tx.query("SELECT r.content_digest,r.body FROM world_definition_annotation_revision r JOIN world_definition_annotation_head h USING(tenant_id,world_id,branch_id,branch_revision,definition_id,definition_revision,revision) WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.branch_id=$3 AND r.branch_revision=$4 ORDER BY r.definition_id,r.definition_revision",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &branch.id.as_str(), &number(branch.revision)?]).await?;
    rows.into_iter()
        .map(|row| {
            let record: DefinitionAnnotation = decode(row.get("body"))?;
            if record.branch != *branch
                || record.revision != Revision(1)
                || record.previous_revision.is_some()
                || canonical_digest(&record)?.as_str() != row.get::<_, String>("content_digest")
            {
                return Err(LearningFailure::BasisChanged.into());
            }
            member(&basis, &record.target)?;
            Ok(record)
        })
        .collect()
}

pub(crate) async fn read_links(
    tx: &WorldTransaction<'_>,
    branch: &BranchRef,
) -> Result<Vec<DefinitionLink>, Error> {
    let basis = crate::releases::read_branch_revision(tx, branch)
        .await?
        .ok_or_else(|| ReleaseFailure::BranchMissing {
            branch_id: branch.id.clone(),
        })?;
    let world = tx.world();
    let rows = tx.query("SELECT r.content_digest,r.body FROM world_definition_link_revision r JOIN world_definition_link_head h USING(tenant_id,world_id,branch_id,branch_revision,source_id,source_revision,target_id,target_revision,relation,revision) WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.branch_id=$3 AND r.branch_revision=$4 ORDER BY r.source_id,r.target_id,r.relation",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &branch.id.as_str(), &number(branch.revision)?]).await?;
    rows.into_iter()
        .map(|row| {
            let record: DefinitionLink = decode(row.get("body"))?;
            if record.branch != *branch
                || record.revision != Revision(1)
                || record.previous_revision.is_some()
                || canonical_digest(&record)?.as_str() != row.get::<_, String>("content_digest")
            {
                return Err(LearningFailure::BasisChanged.into());
            }
            member(&basis, &record.source)?;
            member(&basis, &record.target)?;
            Ok(record)
        })
        .collect()
}

fn member<'a>(branch: &'a WorldBranch, reference: &DefinitionRef) -> Result<&'a Model, Error> {
    branch
        .compile
        .definitions
        .iter()
        .find(|definition| &definition.reference == reference)
        .ok_or_else(|| invalid(0, "metadata.target"))
}
async fn authorize(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    definition: &Model,
    mode: AccessMode,
    now: &Timestamp,
) -> Result<(), Error> {
    let impact = authorization::actual_impact(
        vec![AccessScope {
            resources: vec![ResourceRef::Definition {
                id: definition.reference.id.clone(),
            }],
            fields: Vec::new(),
            modes: vec![mode],
            scope: definition.scope.clone(),
            valid_time: Some(definition.valid_time.clone()),
        }],
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )?;
    admission.require_access(&impact)?;
    authorization::recheck(tx, admission, now).await?;
    Ok(())
}
fn relation_name(relation: SemanticLink) -> &'static str {
    match relation {
        SemanticLink::EquivalentWithinScope => "equivalent_within_scope",
        SemanticLink::Specializes => "specializes",
        SemanticLink::Implements => "implements",
        SemanticLink::DependsOn => "depends_on",
    }
}
