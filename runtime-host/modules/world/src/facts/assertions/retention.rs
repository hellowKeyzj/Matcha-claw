use std::collections::BTreeSet;

use world_protocol::{
    definitions::DefinitionBody,
    facts::{Assertion, AssertionOrigin, Claim, Evidence, FactFailure, ObservationDraft},
    identity::SubjectRef,
    ids::{AssertionRef, EvidenceRef, ResourceRef},
    provenance::{PremiseRef, ReadDependency, SupportSet},
};

use super::{Error, claim_subjects, read_assertion, read_evidence};
use crate::store::{RetentionRoots, WorldSnapshot, WorldTransaction};

/// Exact retained revisions keep their typed dependencies, never JSON-shaped identifiers.
pub(crate) async fn retention_roots(
    tx: &WorldTransaction<'_>,
    assertions: &[AssertionRef],
    evidence: &[EvidenceRef],
) -> Result<RetentionRoots, Error> {
    let mut roots = RetentionRoots::default();
    let mut pending_assertions = assertions.to_vec();
    let mut pending_evidence = evidence.to_vec();
    let mut seen_assertions = BTreeSet::new();
    let mut seen_evidence = BTreeSet::new();
    while let Some(reference) = pending_assertions.pop() {
        if !seen_assertions.insert(reference.clone()) {
            continue;
        }
        let assertion = read_assertion(tx, &reference)
            .await?
            .ok_or(FactFailure::AccessDenied)?;
        if matches!(assertion.origin, AssertionOrigin::Derived {}) {
            let mut after = (String::new(), 0i64);
            loop {
                let rows = tx.query(
                    "SELECT support_id,revision,body FROM world_support_revision WHERE tenant_id=$1 AND world_id=$2 AND conclusion_id=$3 AND conclusion_revision=$4 AND (support_id,revision)>($5,$6) ORDER BY support_id,revision LIMIT 256",
                    &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &reference.id.as_str(), &super::read::revision(reference.revision.0)?, &after.0, &after.1],
                ).await?;
                let done = rows.len() < 256;
                for row in rows {
                    after = (row.get("support_id"), row.get("revision"));
                    let support: SupportSet = super::read::decode(row.get("body"))?;
                    if support.conclusion != reference || support.reference.world != *tx.world()
                        || support.reference.id.as_str() != after.0
                        || i64::try_from(support.reference.revision.0).ok() != Some(after.1)
                    {
                        return Err(FactFailure::InternalFault.into());
                    }
                    crate::facts::support::retain_support(&mut roots, &support);
                    roots.definitions.push(support.rule.clone());
                    for premise in &support.premises {
                        match premise {
                            PremiseRef::Assertion(reference)
                            | PremiseRef::Read(ReadDependency::Assertion { reference }) => {
                                pending_assertions.push(reference.clone());
                            }
                            PremiseRef::Evidence(reference)
                            | PremiseRef::Read(ReadDependency::Evidence { reference }) => {
                                pending_evidence.push(reference.clone());
                            }
                            _ => {}
                        }
                    }
                }
                if done { break; }
            }
        }
        roots
            .dependencies
            .push(ReadDependency::Assertion { reference });
        roots.scopes.push(assertion.scope);
        claim_roots(tx, &assertion.claim, &assertion.origin, &mut roots).await?;
        pending_evidence.extend(assertion.evidence);
        pending_assertions.extend(assertion.supersedes);
    }
    while let Some(reference) = pending_evidence.pop() {
        if !seen_evidence.insert(reference.clone()) {
            continue;
        }
        let evidence =
            read_evidence(tx, &reference)
                .await?
                .ok_or_else(|| FactFailure::EvidenceMissing {
                    reference: reference.clone(),
                })?;
        roots.evidence.push(reference);
        roots.source_versions.push(evidence.locator.source_version);
        roots
            .parse_artifacts
            .extend(evidence.locator.parse_artifact_id);
        pending_evidence.extend(evidence.derived_from);
    }
    Ok(roots)
}

/// Included evidence history retains material metadata, not authority to restore deleted bytes.
pub(crate) async fn archive_retention_roots(
    snapshot: &WorldSnapshot<'_>,
) -> Result<RetentionRoots, Error> {
    let mut roots = RetentionRoots::default();
    let mut after = (String::new(), 0i64);
    loop {
        let rows = snapshot.query(
            "SELECT evidence_id,revision,body FROM world_evidence_revision WHERE tenant_id=$1 AND world_id=$2 AND (evidence_id,revision)>($3,$4) ORDER BY evidence_id,revision LIMIT 256",
            &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &after.0, &after.1],
        ).await?;
        let done = rows.len() < 256;
        for row in rows {
            after = (row.get("evidence_id"), row.get("revision"));
            let evidence: Evidence = super::read::decode(row.get("body"))?;
            if evidence.reference.world != *snapshot.world()
                || evidence.reference.id.as_str() != after.0
                || i64::try_from(evidence.reference.revision.0).ok() != Some(after.1)
            {
                return Err(FactFailure::InternalFault.into());
            }
            evidence_retention_roots(&evidence, &mut roots);
        }
        if done {
            break;
        }
    }
    let mut after = (String::new(), 0i64, String::new(), 0i64);
    loop {
        let rows = snapshot.query("SELECT branch_id,branch_revision,assertion_id,revision,body FROM world_branch_derivation_revision WHERE tenant_id=$1 AND world_id=$2 AND (branch_id,branch_revision,assertion_id,revision)>($3,$4,$5,$6) ORDER BY branch_id,branch_revision,assertion_id,revision LIMIT 256",
            &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &after.0, &after.1, &after.2, &after.3]).await?;
        let done = rows.len() < 256;
        for row in rows {
            after = (row.get("branch_id"), row.get("branch_revision"), row.get("assertion_id"), row.get("revision"));
            let record: super::branch::BranchDerivationRecord = super::read::decode(row.get("body"))?;
            super::branch::validate(&record)?;
            if record.branch.world != *snapshot.world() || record.branch.id.as_str() != after.0 || i64::try_from(record.branch.revision.0).ok() != Some(after.1)
                || record.assertion.reference.id.as_str() != after.2 || i64::try_from(record.revision.0).ok() != Some(after.3) { return Err(FactFailure::InternalFault.into()); }
            super::branch::branch_derivation_retention_roots(&record, &mut roots);
        }
        if done { break; }
    }
    Ok(roots)
}

/// Observations are retained history, including rejected/unaccepted inputs.
pub(crate) async fn world_deletion_roots(
    tx: &WorldTransaction<'_>,
) -> Result<RetentionRoots, Error> {
    let mut roots = RetentionRoots::default();
    let mut assertions = Vec::new();
    let mut evidence = Vec::new();
    for row in tx.query("SELECT body FROM world_observation WHERE tenant_id=$1 AND world_id=$2 ORDER BY observation_id", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str()]).await? {
        let draft: ObservationDraft = super::read::decode(row.get("body"))?;
        roots.scopes.push(draft.scope);
        claim_roots(tx, &draft.claim, &draft.origin, &mut roots).await?;
        assertions.extend(draft.supersedes);
        evidence.extend(draft.evidence);
    }
    let referenced = retention_roots(tx, &assertions, &evidence).await?;
    roots.scopes.extend(referenced.scopes);
    roots.resources.extend(referenced.resources);
    roots.definitions.extend(referenced.definitions);
    roots.evidence.extend(referenced.evidence);
    roots.dependencies.extend(referenced.dependencies);
    roots.releases.extend(referenced.releases);
    roots.source_versions.extend(referenced.source_versions);
    roots.parse_artifacts.extend(referenced.parse_artifacts);
    Ok(roots)
}

pub(crate) async fn observation_retention_roots(
    tx: &WorldTransaction<'_>,
    draft: &ObservationDraft,
    roots: &mut RetentionRoots,
) -> Result<(), Error> {
    roots.scopes.push(draft.scope.clone());
    claim_roots(tx, &draft.claim, &draft.origin, roots).await?;
    roots.evidence.extend(draft.evidence.iter().cloned());
    roots.dependencies.extend(
        draft
            .supersedes
            .iter()
            .cloned()
            .map(|reference| ReadDependency::Assertion { reference }),
    );
    Ok(())
}

pub(crate) fn evidence_retention_roots(evidence: &Evidence, roots: &mut RetentionRoots) {
    roots
        .source_versions
        .push(evidence.locator.source_version.clone());
    roots
        .parse_artifacts
        .extend(evidence.locator.parse_artifact_id.iter().cloned());
    roots.evidence.extend(evidence.derived_from.iter().cloned());
}

async fn claim_roots(
    tx: &WorldTransaction<'_>,
    claim: &Claim,
    origin: &AssertionOrigin,
    roots: &mut RetentionRoots,
) -> Result<(), Error> {
    claim_record_roots(claim, origin, roots);
    match origin {
        AssertionOrigin::Source {
            binding, authority, ..
        } => {
            let definition = crate::releases::read_definition_exact(tx, binding)
                .await
                .map_err(|error| Error::caused_by(FactFailure::InternalFault, error))?
                .ok_or_else(|| FactFailure::MissingDefinition {
                    reference: binding.clone(),
                })?;
            let DefinitionBody::SourceBinding(source) = definition.body else {
                return Err(FactFailure::SourceAuthorityDenied {
                    binding: binding.clone(),
                }
                .into());
            };
            roots.dependencies.push(ReadDependency::SourceMapping {
                mapping: source.mapping,
                identity_rule: source.identity_rule,
                authority: authority.clone(),
                binding: binding.clone(),
            });
        }
        _ => {}
    }
    Ok(())
}

/// Retained typed records already carry these references; interpreting them grants no access.
pub(crate) fn assertion_record_retention_roots(assertion: &Assertion, roots: &mut RetentionRoots) {
    roots.dependencies.push(ReadDependency::Assertion {
        reference: assertion.reference.clone(),
    });
    roots.scopes.push(assertion.scope.clone());
    claim_record_roots(&assertion.claim, &assertion.origin, roots);
    roots.evidence.extend(assertion.evidence.iter().cloned());
    roots.dependencies.extend(
        assertion
            .supersedes
            .iter()
            .cloned()
            .map(|reference| ReadDependency::Assertion { reference }),
    );
}

pub(crate) fn observation_record_retention_roots(
    draft: &ObservationDraft,
    roots: &mut RetentionRoots,
) {
    roots.scopes.push(draft.scope.clone());
    claim_record_roots(&draft.claim, &draft.origin, roots);
    roots.evidence.extend(draft.evidence.iter().cloned());
    roots.dependencies.extend(
        draft
            .supersedes
            .iter()
            .cloned()
            .map(|reference| ReadDependency::Assertion { reference }),
    );
}

fn claim_record_roots(claim: &Claim, origin: &AssertionOrigin, roots: &mut RetentionRoots) {
    roots.resources.extend(
        claim_subjects(claim)
            .into_iter()
            .map(|subject| match subject {
                SubjectRef::Object { id } => ResourceRef::Object { id },
                SubjectRef::Relation { id } => ResourceRef::Relation { id },
            }),
    );
    roots.definitions.push(match claim {
        Claim::Attribute(claim) => claim.property.clone(),
        Claim::Relation(claim) => claim.relation_type.clone(),
    });
    match origin {
        AssertionOrigin::Source {
            binding, position, ..
        } => {
            roots.definitions.push(binding.clone());
            if let Some(position) = position {
                roots.dependencies.push(ReadDependency::Source {
                    position: position.clone(),
                    binding: binding.clone(),
                });
            }
        }
        // Rules belong to exact support records; they are not assertion identity.
        AssertionOrigin::Derived {} => {}
        // Invocation/run/model-call ledgers are retained, not archive-replaced business rows.
        AssertionOrigin::HumanObservation { .. } | AssertionOrigin::Extraction { .. } => {}
    }
}
