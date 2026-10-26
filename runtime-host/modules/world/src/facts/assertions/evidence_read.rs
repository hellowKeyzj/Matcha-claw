use std::collections::BTreeSet;

use world_protocol::{
    authorization::ActualImpact,
    facts::{Evidence, FactFailure},
    ids::{EvidenceRef, ResourceRef, ScopeId},
    time::{Timestamp, ValidTime},
};

use crate::{
    authorization::{self, Admission, VerifiedInvocation},
    content,
    store::{WorldSnapshot, WorldTransaction},
};

use super::{
    Error,
    evidence::require_active,
    evidence_write::material_error,
    impact::{authorize, resource_read_impact},
    read::{evidence_head, evidence_head_snapshot, read_evidence, read_evidence_snapshot},
};

#[derive(Clone, Copy)]
enum Reader<'a, 's> {
    Transaction(&'a WorldTransaction<'s>),
    Snapshot(&'a WorldSnapshot<'s>),
}

#[derive(Clone, Copy)]
enum Authority<'a> {
    Admitted(&'a Admission),
    Preflight(&'a VerifiedInvocation),
}

pub(crate) async fn require_evidence_preflight(
    tx: &WorldTransaction<'_>,
    verified: &VerifiedInvocation,
    references: &[EvidenceRef],
    scope: &ScopeId,
    valid_time: Option<&ValidTime>,
    now: &Timestamp,
) -> Result<Vec<Evidence>, Error> {
    require(
        Reader::Transaction(tx), Authority::Preflight(verified), references, scope, valid_time, now,
    ).await
}

/// Current access and retained custody; does not hydrate or open physical content.
pub(crate) async fn require_evidence(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    references: &[EvidenceRef],
    scope: &ScopeId,
    valid_time: Option<&ValidTime>,
    now: &Timestamp,
) -> Result<Vec<Evidence>, Error> {
    require(
        Reader::Transaction(tx),
        Authority::Admitted(admission),
        references,
        scope,
        valid_time,
        now,
    )
    .await
}

/// Transaction custody does not hydrate or open physical content.
pub(crate) async fn require_evidence_custody_transaction(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    references: &[EvidenceRef],
    scope: &ScopeId,
    valid_time: Option<&ValidTime>,
    now: &Timestamp,
) -> Result<Vec<Evidence>, Error> {
    require(
        Reader::Transaction(tx),
        Authority::Admitted(admission),
        references,
        scope,
        valid_time,
        now,
    )
    .await
}

/// Snapshot reads prove current retained custody, not the presence of physical bytes.
pub(crate) async fn require_evidence_snapshot(
    snapshot: &WorldSnapshot<'_>,
    admission: &Admission,
    references: &[EvidenceRef],
    scope: &ScopeId,
    valid_time: Option<&ValidTime>,
    now: &Timestamp,
) -> Result<Vec<Evidence>, Error> {
    require(
        Reader::Snapshot(snapshot),
        Authority::Admitted(admission),
        references,
        scope,
        valid_time,
        now,
    )
    .await
}

async fn require(
    read: Reader<'_, '_>,
    authority: Authority<'_>,
    references: &[EvidenceRef],
    scope: &ScopeId,
    valid_time: Option<&ValidTime>,
    now: &Timestamp,
) -> Result<Vec<Evidence>, Error> {
    let unique: BTreeSet<_> = references.iter().collect();
    if unique.len() != references.len() {
        return Err(FactFailure::Structural {
            field: world_protocol::failure::FieldPath(vec!["evidence".into()]),
        }
        .into());
    }
    let mut result = Vec::with_capacity(references.len());
    for reference in unique {
        let resource = ResourceRef::Evidence {
            id: reference.id.clone(),
        };
        read.authorize(
            authority,
            &resource_read_impact(
                resource.clone(),
                Vec::new(),
                scope,
                valid_time,
                Vec::new(),
                None,
            )?,
            now,
        )
        .await?;
        let exact = read
            .exact(reference)
            .await?
            .ok_or_else(|| FactFailure::EvidenceMissing {
                reference: reference.clone(),
            })?;
        read.authorize(
            authority,
            &resource_read_impact(
                resource.clone(),
                Vec::new(),
                scope,
                valid_time,
                exact.access.labels.clone(),
                Some(exact.locator.source_version.source_id.clone()),
            )?,
            now,
        )
        .await?;
        let head = read
            .head(reference)
            .await?
            .ok_or_else(|| FactFailure::EvidenceMissing {
                reference: reference.clone(),
            })?;
        read.authorize(
            authority,
            &resource_read_impact(
                resource,
                Vec::new(),
                scope,
                valid_time,
                head.access.labels.clone(),
                Some(head.locator.source_version.source_id.clone()),
            )?,
            now,
        )
        .await?;
        for evidence in
            std::iter::once(&exact).chain((head.reference != exact.reference).then_some(&head))
        {
            let impact = read.material_impact(evidence).await?;
            read.authorize(authority, &impact, now).await?;
        }
        require_active(&head)?;
        require_active(&exact)?;
        for evidence in
            std::iter::once(&exact).chain((head.reference != exact.reference).then_some(&head))
        {
            read.require_material(evidence).await?;
        }
        result.push(exact);
    }
    Ok(result)
}

impl Reader<'_, '_> {
    async fn authorize(
        self,
        authority: Authority<'_>,
        impact: &ActualImpact,
        now: &Timestamp,
    ) -> Result<(), Error> {
        match (self, authority) {
            (Self::Transaction(tx), Authority::Admitted(admission)) => {
                authorize(tx, admission, impact, now).await?;
            }
            (Self::Transaction(tx), Authority::Preflight(verified)) => {
                authorization::check_impact_read(tx, verified, impact, now).await?;
            }
            (Self::Snapshot(snapshot), Authority::Admitted(admission)) => {
                if &admission.invocation().world != snapshot.world() {
                    return Err(FactFailure::AccessDenied.into());
                }
                admission.require_access(impact)?;
                authorization::recheck_read(snapshot, admission, now).await?;
            }
            (Self::Snapshot(_), Authority::Preflight(_)) => {
                return Err(FactFailure::AccessDenied.into());
            }
        }
        Ok(())
    }

    async fn exact(self, reference: &EvidenceRef) -> Result<Option<Evidence>, Error> {
        match self {
            Self::Transaction(tx) => read_evidence(tx, reference).await,
            Self::Snapshot(snapshot) => read_evidence_snapshot(snapshot, reference).await,
        }
    }

    async fn head(self, reference: &EvidenceRef) -> Result<Option<Evidence>, Error> {
        match self {
            Self::Transaction(tx) => evidence_head(tx, &reference.id).await,
            Self::Snapshot(snapshot) => evidence_head_snapshot(snapshot, &reference.id).await,
        }
    }

    async fn material_impact(self, evidence: &Evidence) -> Result<ActualImpact, Error> {
        let reference = &evidence.locator.source_version;
        let source = match self {
            Self::Transaction(tx) => content::read_source_version_metadata(tx, reference).await,
            Self::Snapshot(snapshot) => {
                content::read_source_version_metadata_snapshot(snapshot, reference).await
            }
        }
        .map_err(|error| material_error(error, &evidence.reference))?;
        Ok(match self {
            Self::Transaction(tx) => authorization::material_read_impact(tx, &source).await?,
            Self::Snapshot(snapshot) => {
                authorization::material_read_impact_snapshot(snapshot, &source).await?
            }
        })
    }

    async fn require_material(self, evidence: &Evidence) -> Result<(), Error> {
        let reference = &evidence.locator.source_version;
        match self {
            Self::Transaction(tx) => {
                content::read_source_version_in_transaction(tx, reference)
                    .await
                    .map_err(|error| material_error(error, &evidence.reference))?;
                if let Some(id) = &evidence.locator.parse_artifact_id {
                    content::require_parse_artifact_in_transaction(tx, id, reference)
                        .await
                        .map_err(|error| material_error(error, &evidence.reference))?;
                }
            }
            Self::Snapshot(snapshot) => {
                content::read_source_version_snapshot(snapshot, reference)
                    .await
                    .map_err(|error| material_error(error, &evidence.reference))?;
                if let Some(id) = &evidence.locator.parse_artifact_id {
                    content::require_parse_artifact_snapshot(snapshot, id, reference)
                        .await
                        .map_err(|error| material_error(error, &evidence.reference))?;
                }
            }
        }
        Ok(())
    }
}
