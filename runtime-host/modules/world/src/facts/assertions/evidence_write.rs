use std::collections::BTreeMap;

use tokio_util::sync::CancellationToken;
use world_protocol::{
    facts::{Evidence, EvidenceAvailability, EvidenceStatus, FactFailure},
    ids::{EvidenceRef, ResourceRef, ScopeId},
    materials::MaterialFailure,
};

use crate::{
    authorization::Admission,
    content::{self, Content, ContentOwner, ContentReference, LoadedParse},
    facts::support,
    store::WorldTransaction,
};

use super::{
    Error,
    admission::{cancelled, recorded_time},
    evidence::{require_active, validate_evidence, validate_lineage, validate_revision},
    impact::{authorize, evidence_impact, resource_read_impact},
    persist,
    read::{evidence_head, read_evidence, same_world},
};

pub(crate) async fn append_evidence(
    tx: &mut WorldTransaction<'_>,
    content: &Content,
    loaded: Option<&LoadedParse>,
    admission: &Admission,
    scope: &ScopeId,
    evidence: &Evidence,
    budget: &crate::extensions::invocation::CallBudget,
    cancellation: &CancellationToken,
) -> Result<Evidence, Error> {
    cancelled(cancellation)?;
    tx.require_domain(
        &world_protocol::ids::WriterDomain::try_new("facts").expect("facts writer domain"),
    )?;
    same_world(tx, &evidence.reference.world)?;
    same_world(tx, content.world())?;
    let mut now = recorded_time(tx).await?;
    authorize(tx, admission, &evidence_impact(evidence, scope)?, &now).await?;
    let previous = evidence_head(tx, &evidence.reference.id).await?;
    validate_revision(evidence, previous.as_ref())?;
    if evidence.observed_at > now {
        return Err(FactFailure::InvalidRecordedTime.into());
    }
    if previous.is_none() {
        if evidence.status != EvidenceStatus::Active
            || evidence.availability != EvidenceAvailability::Available
        {
            return Err(FactFailure::EvidenceIncomplete {
                reference: evidence.reference.clone(),
            }
            .into());
        }
    }
    // A recoverable availability update or withdrawal does not need unavailable bytes.
    let needs_content = previous.is_none()
        || (evidence.status == EvidenceStatus::Active
            && evidence.availability == EvidenceAvailability::Available);
    if needs_content {
        let source =
            content::read_source_version_in_transaction(tx, &evidence.locator.source_version)
                .await
                .map_err(|error| material_error(error, &evidence.reference))?;
        let artifact = match &evidence.locator.parse_artifact_id {
            Some(id) => {
                let loaded = loaded.ok_or_else(|| FactFailure::EvidenceIncomplete {
                    reference: evidence.reference.clone(),
                })?;
                let artifact = loaded.artifact();
                if artifact.id != *id || artifact.source_version != evidence.locator.source_version
                {
                    return Err(FactFailure::InvalidEvidenceLocator {
                        reference: evidence.reference.clone(),
                    }
                    .into());
                }
                content::require_loaded_parse_in_transaction(tx, loaded)
                    .await
                    .map_err(|error| material_error(error, &evidence.reference))?;
                Some(artifact)
            }
            None => None,
        };
        validate_evidence(evidence, &source, artifact, previous.as_ref())?;
        let ancestors = load_ancestors(tx, admission, scope, evidence, &now).await?;
        validate_lineage(evidence, &ancestors)?;
        let owner = ContentOwner::Evidence {
            id: evidence.reference.id.clone(),
            revision: evidence.reference.revision,
        };
        content::retain(
            tx,
            &ContentReference::new(owner.clone(), source.blob)
                .map_err(|error| material_error(error, &evidence.reference))?,
        )
        .await
        .map_err(|error| material_error(error, &evidence.reference))?;
        if let Some(artifact) = artifact {
            content::retain(
                tx,
                &ContentReference::new(owner, artifact.manifest.clone())
                    .map_err(|error| material_error(error, &evidence.reference))?,
            )
            .await
            .map_err(|error| material_error(error, &evidence.reference))?;
        }
    }
    let cleanup = if evidence.status == EvidenceStatus::ContentDeleted {
        let original = previous
            .as_ref()
            .ok_or_else(|| FactFailure::EvidenceMissing {
                reference: evidence.reference.clone(),
            })?;
        let target = content::CleanupTarget {
            owner: content::CleanupOwner::Facts,
            resource: ContentOwner::Evidence {
                id: original.reference.id.clone(),
                revision: original.reference.revision,
            },
        };
        let deletion =
            content::require_source_cleanup(tx, &evidence.locator.source_version, &target)
                .await
                .map_err(|error| material_error(error, &evidence.reference))?;
        let owner = &target.resource;
        for reference in content::owner_references(tx, owner)
            .await
            .map_err(|error| material_error(error, &evidence.reference))?
        {
            cancelled(cancellation)?;
            content::release_reference(tx, &reference)
                .await
                .map_err(|error| material_error(error, &evidence.reference))?;
        }
        Some((deletion, target))
    } else {
        None
    };
    cancelled(cancellation)?;
    now = recorded_time(tx).await?;
    authorize(tx, admission, &evidence_impact(evidence, scope)?, &now).await?;
    persist::evidence(tx, evidence, previous.as_ref()).await?;
    support::invalidate(
        tx,
        &[],
        &[],
        previous.as_slice(),
        std::slice::from_ref(evidence),
        budget,
        cancellation,
        &now,
    )
    .await?;
    if let Some((deletion, target)) = cleanup {
        content::acknowledge_cleanup(tx, &deletion, &target)
            .await
            .map_err(|error| material_error(error, &evidence.reference))?;
    }
    cancelled(cancellation)?;
    Ok(evidence.clone())
}

async fn load_ancestors(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    scope: &ScopeId,
    evidence: &Evidence,
    now: &world_protocol::time::Timestamp,
) -> Result<BTreeMap<EvidenceRef, Evidence>, Error> {
    let mut ancestors = BTreeMap::new();
    let mut pending = evidence.derived_from.clone();
    while let Some(reference) = pending.pop() {
        if reference == evidence.reference {
            return Err(FactFailure::EvidenceCycle {
                references: vec![reference],
            }
            .into());
        }
        if ancestors.contains_key(&reference) {
            continue;
        }
        if ancestors.len() >= 4096 {
            return Err(FactFailure::Structural {
                field: world_protocol::failure::FieldPath(vec!["derivedFrom".into()]),
            }
            .into());
        }
        let impact = resource_read_impact(
            ResourceRef::Evidence {
                id: reference.id.clone(),
            },
            Vec::new(),
            scope,
            None,
            Vec::new(),
            None,
        )?;
        authorize(tx, admission, &impact, now).await?;
        let parent =
            read_evidence(tx, &reference)
                .await?
                .ok_or_else(|| FactFailure::EvidenceMissing {
                    reference: reference.clone(),
                })?;
        let impact = resource_read_impact(
            ResourceRef::Evidence {
                id: reference.id.clone(),
            },
            Vec::new(),
            scope,
            None,
            parent.access.labels.clone(),
            Some(parent.locator.source_version.source_id.clone()),
        )?;
        authorize(tx, admission, &impact, now).await?;
        require_active(&parent)?;
        let current = evidence_head(tx, &parent.reference.id)
            .await?
            .ok_or_else(|| FactFailure::EvidenceMissing {
                reference: parent.reference.clone(),
            })?;
        require_active(&current)?;
        pending.extend(parent.derived_from.clone());
        ancestors.insert(reference, parent);
    }
    Ok(ancestors)
}

pub(super) fn material_error(error: content::Error, reference: &EvidenceRef) -> Error {
    match error {
        content::Error::Store(error) => Error::from(error),
        error => {
            let reason = match error.reason() {
                Some(MaterialFailure::Deleted) => FactFailure::EvidenceDeleted {
                    reference: reference.clone(),
                },
                Some(
                    MaterialFailure::ContentNotFound | MaterialFailure::SourceVersionMissing { .. },
                ) => FactFailure::EvidenceMissing {
                    reference: reference.clone(),
                },
                Some(MaterialFailure::RetentionDenied) => FactFailure::AccessDenied,
                Some(
                    MaterialFailure::ReadFailed | MaterialFailure::VersionContentUnavailable { .. },
                ) => FactFailure::EvidenceUnavailable {
                    reference: reference.clone(),
                },
                Some(MaterialFailure::Cancelled) => FactFailure::Cancelled,
                Some(
                    MaterialFailure::IncompleteLocation
                    | MaterialFailure::CorruptContent
                    | MaterialFailure::DigestMismatch,
                ) => FactFailure::EvidenceIncomplete {
                    reference: reference.clone(),
                },
                _ => FactFailure::InternalFault,
            };
            Error::caused_by(reason, error)
        }
    }
}
