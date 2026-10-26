use std::collections::BTreeSet;

use tokio_util::sync::CancellationToken;
use world_protocol::{
    facts::{Assertion, AssertionOrigin, AssertionStatus, FactFailure, ObservationDraft},
    failure::FieldPath,
    ids::{ResourceRef, WriterDomain},
    materials::SourceAnchor,
    sources::DeleteSemantics,
};

use crate::{
    authorization::Admission,
    content::Content,
    identity,
    sources::{mapping, sync::SourceRetraction},
    store::WorldTransaction,
};

use super::{
    Error,
    admission::{branch_failure, cancelled, recorded_time},
    claim::ClaimRead,
    impact::{authorize, observation_impact, resource_read_impact},
    read::{assertion_head, claim_subjects, read_assertion, read_evidence, same_world},
    revision::validate_interval,
    status::withdraw_assertion,
    temporal::retain_outside,
};

pub(crate) async fn retract_source_claims(
    tx: &mut WorldTransaction<'_>,
    _content: &Content,
    admission: &Admission,
    proof: &SourceRetraction,
    budget: &crate::extensions::invocation::CallBudget,
    cancellation: &CancellationToken,
) -> Result<Vec<Assertion>, Error> {
    cancelled(cancellation)?;
    tx.require_domain(&WriterDomain::try_new("facts").expect("facts writer domain"))?;
    same_world(tx, &proof.binding().world)?;
    validate_interval(proof.valid_time())?;
    if proof.semantics() != DeleteSemantics::WithdrawSourceClaims {
        return Err(FactFailure::Structural {
            field: FieldPath(vec!["source".into(), "deleteSemantics".into()]),
        }
        .into());
    }
    let now = recorded_time(tx).await?;
    authorize(
        tx,
        admission,
        &resource_read_impact(
            ResourceRef::Source {
                id: proof.source().clone(),
            },
            vec![proof.binding().clone()],
            proof.scope(),
            Some(proof.valid_time()),
            Vec::new(),
            Some(proof.source().clone()),
        )?,
        &now,
    )
    .await?;
    let branch = match proof.branch() {
        Some(reference) => Some(
            crate::releases::read_branch_revision(tx, reference)
                .await
                .map_err(|error| Error::caused_by(FactFailure::InternalFault, error))?
                .ok_or(FactFailure::AccessDenied)?,
        ),
        None => None,
    };
    let read = match &branch {
        Some(branch) => ClaimRead::Branch(tx, branch),
        None => ClaimRead::transaction(tx).await?,
    };
    let binding = read.definition(proof.binding(), proof.valid_time()).await?;
    let world_protocol::definitions::DefinitionBody::SourceBinding(source) = &binding.body else {
        return Err(FactFailure::AccessDenied.into());
    };
    if source.source_id != *proof.source()
        || source.namespace != proof.namespace()
        || source.incarnation != proof.basis().incarnation
        || source.authority.revision != proof.basis().authority_revision
    {
        return Err(FactFailure::SourceAuthorityDenied {
            binding: proof.binding().clone(),
        }
        .into());
    }
    let authority = match proof.branch() {
        Some(branch) => {
            mapping::read_branch_authority(tx, branch, proof.binding(), &source.authority).await?
        }
        None => mapping::read_authority(tx, proof.binding(), &source.authority).await?,
    }
    .ok_or_else(|| FactFailure::SourceAuthorityDenied {
        binding: proof.binding().clone(),
    })?;
    let scopes = read
        .scopes(&[
            proof.scope().clone(),
            binding.scope.clone(),
            source.scope.clone(),
            authority.scope.clone(),
        ])
        .await?;
    super::authority::validate_retraction_authority(
        &binding,
        &authority,
        proof.scope(),
        proof.valid_time(),
        &scopes,
        &now,
    )?;
    let mut originals = Vec::with_capacity(proof.assertions().len());
    let mut subjects = BTreeSet::new();
    let mut references: Vec<_> = proof.assertions().iter().collect();
    references.sort();
    if references.windows(2).any(|pair| pair[0].id == pair[1].id) {
        return Err(FactFailure::Structural {
            field: FieldPath(vec!["assertions".into()]),
        }
        .into());
    }
    for reference in references {
        cancelled(cancellation)?;
        same_world(tx, &reference.world)?;
        authorize(
            tx,
            admission,
            &resource_read_impact(
                ResourceRef::Assertion {
                    id: reference.id.clone(),
                },
                Vec::new(),
                proof.scope(),
                Some(proof.valid_time()),
                Vec::new(),
                None,
            )?,
            &now,
        )
        .await?;
        let original = read_assertion(tx, reference)
            .await?
            .ok_or(FactFailure::AccessDenied)?;
        let draft = ObservationDraft {
            claim: original.claim.clone(),
            polarity: original.polarity,
            scope: original.scope.clone(),
            valid_time: original.valid_time.clone(),
            observed_at: now.clone(),
            origin: original.origin.clone(),
            evidence: original.evidence.clone(),
            supersedes: Some(reference.clone()),
        };
        authorize(
            tx,
            admission,
            &observation_impact(&reference.id, &draft)?,
            &now,
        )
        .await?;
        let AssertionOrigin::Source { binding, .. } = &original.origin else {
            return Err(FactFailure::AccessDenied.into());
        };
        if binding.world != proof.binding().world
            || binding.id != proof.binding().id
            || original.scope != *proof.scope()
            || !matches!(
                original.status,
                AssertionStatus::Accepted | AssertionStatus::Candidate
            )
            || original
                .valid_time
                .to
                .as_ref()
                .is_some_and(|end| end <= &proof.valid_time().from)
            || proof
                .valid_time()
                .to
                .as_ref()
                .is_some_and(|end| end <= &original.valid_time.from)
        {
            return Err(FactFailure::AccessDenied.into());
        }
        let owns = match (&original.claim, &authority.ownership) {
            (
                world_protocol::facts::Claim::Attribute(claim),
                world_protocol::facts::AuthorityOwnership::Properties { properties },
            ) => {
                properties.iter().any(|property| {
                    property.world == claim.property.world && property.id == claim.property.id
                }) && authority.authority.fields.contains(&claim.property.id)
            }
            (
                world_protocol::facts::Claim::Relation(claim),
                world_protocol::facts::AuthorityOwnership::RelationRoles {
                    relation_type,
                    roles,
                },
            ) => {
                let definition = read.definition(relation_type, proof.valid_time()).await?;
                let world_protocol::definitions::DefinitionBody::RelationType(relation) =
                    definition.body
                else {
                    return Err(FactFailure::AccessDenied.into());
                };
                let owned: BTreeSet<_> = roles.iter().collect();
                relation_type.world == claim.relation_type.world
                    && relation_type.id == claim.relation_type.id
                    && owned.len() == roles.len()
                    && owned == authority.authority.roles.iter().collect()
                    && owned == relation.roles.iter().map(|role| &role.id).collect()
            }
            _ => false,
        };
        if !owns {
            return Err(FactFailure::SourceAuthorityDenied {
                binding: proof.binding().clone(),
            }
            .into());
        }
        let definition = crate::releases::read_definition_exact(tx, binding)
            .await
            .map_err(|error| Error::caused_by(FactFailure::InternalFault, error))?
            .ok_or_else(|| FactFailure::MissingDefinition {
                reference: binding.clone(),
            })?;
        let world_protocol::definitions::DefinitionBody::SourceBinding(source) = definition.body
        else {
            return Err(FactFailure::AccessDenied.into());
        };
        if source.source_id != *proof.source()
            || source.namespace != proof.namespace()
            || source.incarnation != proof.basis().incarnation
        {
            return Err(FactFailure::AccessDenied.into());
        }
        let mut matches_record = false;
        for reference in &original.evidence {
            cancelled(cancellation)?;
            let resource = ResourceRef::Evidence {
                id: reference.id.clone(),
            };
            authorize(
                tx,
                admission,
                &resource_read_impact(
                    resource.clone(),
                    Vec::new(),
                    &original.scope,
                    Some(&original.valid_time),
                    Vec::new(),
                    None,
                )?,
                &now,
            )
            .await?;
            let evidence = read_evidence(tx, reference).await?.ok_or_else(|| {
                FactFailure::EvidenceMissing {
                    reference: reference.clone(),
                }
            })?;
            authorize(
                tx,
                admission,
                &resource_read_impact(
                    resource,
                    Vec::new(),
                    &original.scope,
                    Some(&original.valid_time),
                    evidence.access.labels.clone(),
                    Some(evidence.locator.source_version.source_id.clone()),
                )?,
                &now,
            )
            .await?;
            matches_record |= evidence.locator.source_version.source_id == *proof.source()
                && matches!(&evidence.locator.anchor, SourceAnchor::Record { namespace, native_key, .. }
                    if namespace == proof.namespace() && native_key == proof.native_key());
        }
        if !matches_record {
            return Err(FactFailure::AccessDenied.into());
        }
        subjects.extend(claim_subjects(&original.claim));
        originals.push(original);
    }
    let claims: Vec<_> = originals
        .iter()
        .map(|assertion| (&assertion.claim, &assertion.origin))
        .collect();
    let _ranges = crate::facts::support::lock_assertion_ranges(tx, &claims).await?;
    let subjects: Vec<_> = subjects.into_iter().collect();
    proof
        .recheck_branch(tx, admission, budget, cancellation)
        .await
        .map_err(branch_failure)?;
    identity::recheck_receipts(tx, proof.receipts(), &subjects).await?;
    identity::touch_influence(tx, &subjects).await?;
    if proof.branch().is_none() {
        mapping::recheck_dependencies(tx, proof.dependencies()).await?;
    }
    // Lock all exact heads before the first revision; a stale index is never silently accepted.
    for original in &originals {
        let head = assertion_head(tx, &original.reference.id)
            .await?
            .ok_or(FactFailure::AccessDenied)?;
        if head.reference != original.reference {
            return Err(FactFailure::RevisionConflict {
                expected: original.reference.revision,
                actual: head.reference.revision,
            }
            .into());
        }
    }
    let mut changed = Vec::new();
    for original in originals {
        let withdrawn =
            withdraw_assertion(tx, admission, &original.reference, budget, cancellation).await?;
        changed.push(withdrawn);
        changed.extend(
            retain_outside(
                tx,
                admission,
                &original,
                proof.valid_time(),
                budget,
                cancellation,
            )
            .await?,
        );
    }
    cancelled(cancellation)?;
    Ok(changed)
}
