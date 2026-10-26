use world_protocol::{
    facts::{Assertion, AssertionOrigin, Claim, Evidence, FactFailure},
    identity::{AliasResolution, IdentityReceipt, IdentityRecord, SubjectRef},
    materials::SourceAnchor,
    provenance::ReadDependency,
    sources::SourceBinding,
};

use super::Error;

pub(super) fn validate_source_evidence(
    assertion: &Assertion,
    source: &SourceBinding,
    evidence: &[Evidence],
) -> Result<(), Error> {
    let required: Vec<_> = match &assertion.claim {
        Claim::Attribute(claim) => source
            .field_mapping
            .iter()
            .filter(|mapping| mapping.property == claim.property)
            .map(|mapping| mapping.source_field.as_str())
            .collect(),
        Claim::Relation(claim) => source
            .role_mapping
            .iter()
            .filter(|mapping| claim.roles.iter().any(|role| role.role == mapping.role))
            .map(|mapping| mapping.source_field.as_str())
            .collect(),
    };
    if required.is_empty()
        || !evidence.iter().any(|evidence| {
            evidence.locator.source_version.source_id == source.source_id
                && evidence.authority.as_ref() == Some(&source.authority)
                && match &evidence.locator.anchor {
                    SourceAnchor::Record {
                        namespace, fields, ..
                    } => {
                        namespace == &source.namespace
                            && required
                                .iter()
                                .all(|field| fields.iter().any(|value| value == field))
                    }
                    _ => false,
                }
        })
    {
        return Err(denied(assertion));
    }
    Ok(())
}

pub(super) fn validate_source_basis(
    assertion: &Assertion,
    source: &SourceBinding,
    evidence: &[Evidence],
    dependencies: &[ReadDependency],
    receipts: &[IdentityReceipt],
) -> Result<(), Error> {
    let AssertionOrigin::Source {
        binding,
        authority,
        position,
    } = &assertion.origin
    else {
        return Err(denied(assertion));
    };
    if !dependencies.contains(&ReadDependency::SourceMapping {
        mapping: source.mapping.clone(),
        identity_rule: source.identity_rule.clone(),
        authority: authority.clone(),
        binding: binding.clone(),
    }) || position.as_ref().is_some_and(|position| {
        !dependencies.contains(&ReadDependency::Source {
            position: position.clone(),
            binding: binding.clone(),
        })
    }) {
        return Err(denied(assertion));
    }
    let subject = match &assertion.claim {
        Claim::Attribute(claim) => claim.subject.clone(),
        Claim::Relation(claim) => SubjectRef::Relation {
            id: claim.relation_id.clone(),
        },
    };
    let row_proven = evidence.iter().any(|evidence| match &evidence.locator.anchor {
        SourceAnchor::Record { namespace, native_key, fields } if namespace == &source.namespace
            && evidence.locator.source_version.source_id == source.source_id => {
            fields.iter().all(|name| dependencies.iter().any(|dependency| matches!(dependency,
                ReadDependency::SourceField { schema, name: actual, .. } if schema.world == binding.world && actual == name)))
                && receipts.iter().any(|receipt| receipt.key.source_id == source.source_id
                    && receipt.key.namespace == *namespace && receipt.key.native_key == *native_key
                    && proves(receipt, &subject, assertion))
        }
        _ => false,
    });
    if !row_proven {
        return Err(denied(assertion));
    }
    if let Claim::Relation(claim) = &assertion.claim {
        for role in &claim.roles {
            let target = SubjectRef::Object {
                id: role.object_id.clone(),
            };
            if !source
                .role_mapping
                .iter()
                .filter(|mapping| mapping.role == role.role)
                .any(|mapping| {
                    receipts.iter().any(|receipt| {
                        receipt.key.source_id == mapping.target_source_id
                            && receipt.key.namespace == mapping.target_namespace
                            && proves(receipt, &target, assertion)
                    })
                })
            {
                return Err(denied(assertion));
            }
        }
    }
    Ok(())
}

pub(super) async fn validate_source_revision(
    tx: &crate::store::WorldTransaction<'_>,
    admission: &crate::authorization::Admission,
    previous: &Assertion,
    draft: &world_protocol::facts::ObservationDraft,
    current_binding: &SourceBinding,
    current_evidence: &[Evidence],
    now: &world_protocol::time::Timestamp,
) -> Result<(), Error> {
    let (
        AssertionOrigin::Source { binding: old, .. },
        AssertionOrigin::Source { binding: new, .. },
    ) = (&previous.origin, &draft.origin)
    else {
        return Err(FactFailure::AccessDenied.into());
    };
    if old.world != new.world
        || old.id != new.id
        || previous.scope != draft.scope
        || !super::revision::same_claim_identity(&previous.claim, &draft.claim)
    {
        return Err(FactFailure::AccessDenied.into());
    }
    if draft.valid_time.from < previous.valid_time.from {
        return Err(FactFailure::ValidTimeMismatch.into());
    }
    let original_binding = crate::releases::read_definition_exact(tx, old)
        .await
        .map_err(|error| Error::caused_by(FactFailure::InternalFault, error))?
        .ok_or_else(|| FactFailure::MissingDefinition {
            reference: old.clone(),
        })?;
    let world_protocol::definitions::DefinitionBody::SourceBinding(original_binding) =
        original_binding.body
    else {
        return Err(FactFailure::AccessDenied.into());
    };
    if original_binding.source_id != current_binding.source_id
        || original_binding.incarnation != current_binding.incarnation
        || original_binding.namespace != current_binding.namespace
    {
        return Err(FactFailure::AccessDenied.into());
    }
    let mut same_record = false;
    for reference in &previous.evidence {
        let resource = world_protocol::ids::ResourceRef::Evidence {
            id: reference.id.clone(),
        };
        let impact = super::impact::resource_read_impact(
            resource.clone(),
            Vec::new(),
            &previous.scope,
            Some(&previous.valid_time),
            Vec::new(),
            None,
        )?;
        super::impact::authorize(tx, admission, &impact, now).await?;
        let evidence = super::read::read_evidence(tx, reference)
            .await?
            .ok_or_else(|| FactFailure::EvidenceMissing {
                reference: reference.clone(),
            })?;
        let impact = super::impact::resource_read_impact(
            resource,
            Vec::new(),
            &previous.scope,
            Some(&previous.valid_time),
            evidence.access.labels.clone(),
            Some(evidence.locator.source_version.source_id.clone()),
        )?;
        super::impact::authorize(tx, admission, &impact, now).await?;
        if let SourceAnchor::Record {
            namespace,
            native_key,
            ..
        } = &evidence.locator.anchor
        {
            same_record |= current_evidence.iter().filter(|item| draft.evidence.contains(&item.reference)).any(|item| {
                item.locator.source_version.source_id == evidence.locator.source_version.source_id
                    && matches!(&item.locator.anchor, SourceAnchor::Record { namespace: next_namespace, native_key: next_key, .. }
                        if next_namespace == namespace && next_key == native_key)
            });
        }
    }
    if !same_record {
        return Err(FactFailure::AccessDenied.into());
    }
    Ok(())
}

fn proves(receipt: &IdentityReceipt, subject: &SubjectRef, assertion: &Assertion) -> bool {
    receipt.key.world == assertion.reference.world
        && receipt.scope == assertion.scope
        && crate::definitions::valid_time_contains(&receipt.key.valid_time, &assertion.valid_time)
        && match &receipt.resolution {
            AliasResolution::Existing { identity, .. } => match (&identity.record, subject) {
                (IdentityRecord::Object(object), SubjectRef::Object { id }) => object.id == *id,
                (IdentityRecord::Relation(relation), SubjectRef::Relation { id }) => {
                    relation.id == *id
                }
                _ => false,
            },
            _ => false,
        }
}

fn denied(assertion: &Assertion) -> Error {
    match &assertion.origin {
        AssertionOrigin::Source { binding, .. } => FactFailure::SourceAuthorityDenied {
            binding: binding.clone(),
        }
        .into(),
        _ => FactFailure::AccessDenied.into(),
    }
}
