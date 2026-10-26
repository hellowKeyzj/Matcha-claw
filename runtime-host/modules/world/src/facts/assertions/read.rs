use std::collections::BTreeSet;

use serde::de::DeserializeOwned;
use world_protocol::{
    facts::{Assertion, Claim, Evidence, FactFailure},
    identity::SubjectRef,
    ids::{AssertionId, AssertionRef, EvidenceId, EvidenceRef, ResourceRef},
};

use crate::store::{WorldSnapshot, WorldTransaction};

use super::Error;

pub(crate) async fn read_assertion(
    tx: &WorldTransaction<'_>,
    reference: &AssertionRef,
) -> Result<Option<Assertion>, Error> {
    same_world(tx, &reference.world)?;
    let revision = revision(reference.revision.0)?;
    tx.query_opt(
        "SELECT body FROM world_assertion_revision WHERE tenant_id=$1 AND world_id=$2 AND assertion_id=$3 AND revision=$4",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &reference.id.as_str(), &revision],
    ).await?.map(|row| {
        let value: Assertion = decode(row.get("body"))?;
        if value.reference != *reference { return Err(FactFailure::InternalFault.into()); }
        Ok(value)
    }).transpose()
}

pub(super) async fn assertion_head(
    tx: &WorldTransaction<'_>,
    id: &AssertionId,
) -> Result<Option<Assertion>, Error> {
    tx.query_opt(
        "SELECT r.body FROM world_assertion_head h JOIN world_assertion_revision r USING(tenant_id,world_id,assertion_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.assertion_id=$3 FOR UPDATE OF h",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &id.as_str()],
    ).await?.map(|row| decode(row.get("body"))).transpose()
}

pub(super) async fn peek_assertion_head(
    tx: &WorldTransaction<'_>,
    id: &AssertionId,
) -> Result<Option<Assertion>, Error> {
    tx.query_opt(
        "SELECT r.body FROM world_assertion_head h JOIN world_assertion_revision r USING(tenant_id,world_id,assertion_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.assertion_id=$3",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &id.as_str()],
    ).await?.map(|row| decode(row.get("body"))).transpose()
}

pub(crate) async fn read_evidence(
    tx: &WorldTransaction<'_>,
    reference: &EvidenceRef,
) -> Result<Option<Evidence>, Error> {
    same_world(tx, &reference.world)?;
    let revision = revision(reference.revision.0)?;
    tx.query_opt(
        "SELECT body FROM world_evidence_revision WHERE tenant_id=$1 AND world_id=$2 AND evidence_id=$3 AND revision=$4",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &reference.id.as_str(), &revision],
    ).await?.map(|row| {
        let value: Evidence = decode(row.get("body"))?;
        if value.reference != *reference { return Err(FactFailure::InternalFault.into()); }
        Ok(value)
    }).transpose()
}

pub(crate) async fn read_evidence_snapshot(
    snapshot: &WorldSnapshot<'_>,
    reference: &EvidenceRef,
) -> Result<Option<Evidence>, Error> {
    if snapshot.world() != &reference.world {
        return Err(FactFailure::CrossWorld.into());
    }
    let revision = revision(reference.revision.0)?;
    snapshot.query_opt(
        "SELECT body FROM world_evidence_revision WHERE tenant_id=$1 AND world_id=$2 AND evidence_id=$3 AND revision=$4",
        &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &reference.id.as_str(), &revision],
    ).await?.map(|row| {
        let value: Evidence = decode(row.get("body"))?;
        if value.reference != *reference { return Err(FactFailure::InternalFault.into()); }
        Ok(value)
    }).transpose()
}

pub(super) async fn peek_evidence_head(
    tx: &WorldTransaction<'_>,
    id: &EvidenceId,
) -> Result<Option<Evidence>, Error> {
    tx.query_opt(
        "SELECT r.body FROM world_evidence_head h JOIN world_evidence_revision r USING(tenant_id,world_id,evidence_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.evidence_id=$3",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &id.as_str()],
    ).await?.map(|row| decode(row.get("body"))).transpose()
}

pub(super) async fn evidence_head_snapshot(
    snapshot: &WorldSnapshot<'_>,
    id: &EvidenceId,
) -> Result<Option<Evidence>, Error> {
    snapshot.query_opt(
        "SELECT r.body FROM world_evidence_head h JOIN world_evidence_revision r USING(tenant_id,world_id,evidence_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.evidence_id=$3",
        &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &id.as_str()],
    ).await?.map(|row| decode(row.get("body"))).transpose()
}

pub(super) async fn evidence_head(
    tx: &WorldTransaction<'_>,
    id: &EvidenceId,
) -> Result<Option<Evidence>, Error> {
    tx.query_opt(
        "SELECT r.body FROM world_evidence_head h JOIN world_evidence_revision r USING(tenant_id,world_id,evidence_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.evidence_id=$3 FOR UPDATE OF h",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &id.as_str()],
    ).await?.map(|row| decode(row.get("body"))).transpose()
}

/// Caller holds the identity influence lock. Exact current revisions include nested values and roles.
pub(crate) async fn read_identity_influence(
    tx: &WorldTransaction<'_>,
    subjects: &[SubjectRef],
) -> Result<Vec<Assertion>, Error> {
    let subjects: BTreeSet<_> = subjects.iter().cloned().collect();
    if subjects.is_empty() {
        return Ok(Vec::new());
    }
    let (kinds, ids): (Vec<_>, Vec<_>) = subjects
        .iter()
        .map(|subject| match subject {
            SubjectRef::Object { id } => ("object", id.as_str()),
            SubjectRef::Relation { id } => ("relation", id.as_str()),
        })
        .unzip();
    tx.query(
        "SELECT r.body FROM world_assertion_head h JOIN world_assertion_revision r USING(tenant_id,world_id,assertion_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND EXISTS(SELECT 1 FROM world_assertion_subject s JOIN unnest($3::text[],$4::text[]) AS requested(kind,id) ON requested.kind=s.subject_kind AND requested.id=s.subject_id WHERE s.tenant_id=h.tenant_id AND s.world_id=h.world_id AND s.assertion_id=h.assertion_id AND s.revision=h.revision) ORDER BY h.assertion_id",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &kinds, &ids],
    ).await?.into_iter().map(|row| decode(row.get("body"))).collect()
}

pub(crate) fn claim_subjects(claim: &Claim) -> BTreeSet<SubjectRef> {
    let mut result = BTreeSet::new();
    match claim {
        Claim::Attribute(claim) => {
            result.insert(claim.subject.clone());
            let mut resources = Vec::new();
            value_resources(&claim.value, &mut resources);
            result.extend(resources.into_iter().filter_map(|resource| match resource {
                ResourceRef::Object { id } => Some(SubjectRef::Object { id }),
                ResourceRef::Relation { id } => Some(SubjectRef::Relation { id }),
                _ => None,
            }));
        }
        Claim::Relation(claim) => {
            result.insert(SubjectRef::Relation {
                id: claim.relation_id.clone(),
            });
            result.extend(claim.roles.iter().map(|role| SubjectRef::Object {
                id: role.object_id.clone(),
            }));
        }
    }
    result
}

pub(crate) use crate::definitions::value_resources;

pub(super) fn revision(value: u64) -> Result<i64, Error> {
    if value == 0 {
        return Err(FactFailure::Structural {
            field: world_protocol::failure::FieldPath(vec!["revision".into()]),
        }
        .into());
    }
    i64::try_from(value).map_err(|_| {
        FactFailure::Structural {
            field: world_protocol::failure::FieldPath(vec!["revision".into()]),
        }
        .into()
    })
}

pub(super) fn same_world(
    tx: &WorldTransaction<'_>,
    world: &world_protocol::ids::WorldRef,
) -> Result<(), Error> {
    if tx.world() != world {
        return Err(FactFailure::CrossWorld.into());
    }
    Ok(())
}

pub(super) fn decode<T: DeserializeOwned>(value: serde_json::Value) -> Result<T, Error> {
    serde_json::from_value(value)
        .map_err(|source| Error::caused_by(FactFailure::InternalFault, source))
}

pub(super) fn encode<T: serde::Serialize>(value: &T) -> Result<serde_json::Value, Error> {
    serde_json::to_value(value)
        .map_err(|source| Error::caused_by(FactFailure::InternalFault, source))
}
