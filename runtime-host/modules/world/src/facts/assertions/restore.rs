use std::collections::BTreeMap;

use serde_json::Value;
use world_protocol::{
    facts::{
        Assertion, AssertionStatus, Evidence, EvidenceAvailability, EvidenceLocator,
        EvidenceStatus, FactFailure,
    },
    failure::FieldPath,
    ids::*,
};

use super::{
    Error,
    read::{decode, read_assertion, read_evidence},
};
use crate::store::WorldTransaction;

/// Called before archive replacement while the sole storage transaction is exclusive.
/// A backup is not authority to erase current withdrawal/deletion/rejection facts.
pub(crate) async fn validate_archive_restore(
    tx: &WorldTransaction<'_>,
    evidence_revisions: &[Value],
    evidence_heads: &[Value],
    assertion_revisions: &[Value],
    assertion_heads: &[Value],
) -> Result<Vec<EvidenceLocator>, Error> {
    tx.require_exclusive_storage()?;
    let mut evidence = BTreeMap::new();
    for row in evidence_revisions {
        let value: Evidence = decode(row.get("body").cloned().ok_or_else(invalid)?)?;
        if value.reference.world != *tx.world()
            || row.get("evidence_id").and_then(Value::as_str) != Some(value.reference.id.as_str())
            || row.get("revision").and_then(Value::as_u64) != Some(value.reference.revision.0)
        {
            return Err(invalid());
        }
        if let Some(current) = read_evidence(tx, &value.reference).await? {
            if current != value {
                return Err(FactFailure::EvidenceIncomplete {
                    reference: value.reference,
                }
                .into());
            }
        }
        if evidence.insert(value.reference.clone(), value).is_some() {
            return Err(invalid());
        }
    }
    let mut evidence_head = BTreeMap::new();
    for row in evidence_heads {
        let id = EvidenceId::try_new(
            row.get("evidence_id")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?,
        )
        .map_err(|_| invalid())?;
        let reference = EvidenceRef {
            world: tx.world().clone(),
            id: id.clone(),
            revision: Revision(
                row.get("revision")
                    .and_then(Value::as_u64)
                    .ok_or_else(invalid)?,
            ),
        };
        if !evidence.contains_key(&reference) || evidence_head.insert(id, reference).is_some() {
            return Err(invalid());
        }
    }
    for row in tx.query("SELECT r.body FROM world_evidence_head h JOIN world_evidence_revision r USING(tenant_id,world_id,evidence_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 ORDER BY h.evidence_id FOR SHARE OF h", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str()]).await? {
        let current: Evidence = decode(row.get("body"))?;
        if current.status != EvidenceStatus::Active || current.availability != EvidenceAvailability::Available {
            if evidence_head.get(&current.reference.id) != Some(&current.reference) || evidence.get(&current.reference) != Some(&current) {
                return Err(match current.status {
                    EvidenceStatus::ContentDeleted => FactFailure::EvidenceDeleted { reference: current.reference },
                    EvidenceStatus::Withdrawn => FactFailure::EvidenceIncomplete { reference: current.reference },
                    EvidenceStatus::Active => FactFailure::EvidenceUnavailable { reference: current.reference },
                }.into());
            }
        }
    }
    let mut assertions = BTreeMap::new();
    for row in assertion_revisions {
        let value: Assertion = decode(row.get("body").cloned().ok_or_else(invalid)?)?;
        if value.reference.world != *tx.world()
            || row.get("assertion_id").and_then(Value::as_str) != Some(value.reference.id.as_str())
            || row.get("revision").and_then(Value::as_u64) != Some(value.reference.revision.0)
        {
            return Err(invalid());
        }
        if let Some(current) = read_assertion(tx, &value.reference).await? {
            if current != value {
                return Err(invalid());
            }
        }
        if assertions.insert(value.reference.clone(), value).is_some() {
            return Err(invalid());
        }
    }
    let mut assertion_head = BTreeMap::new();
    for row in assertion_heads {
        let id = AssertionId::try_new(
            row.get("assertion_id")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?,
        )
        .map_err(|_| invalid())?;
        let reference = AssertionRef {
            world: tx.world().clone(),
            id: id.clone(),
            revision: Revision(
                row.get("revision")
                    .and_then(Value::as_u64)
                    .ok_or_else(invalid)?,
            ),
        };
        if !assertions.contains_key(&reference) || assertion_head.insert(id, reference).is_some() {
            return Err(invalid());
        }
    }
    for row in tx.query("SELECT r.body FROM world_assertion_head h JOIN world_assertion_revision r USING(tenant_id,world_id,assertion_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 ORDER BY h.assertion_id FOR SHARE OF h", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str()]).await? {
        let current: Assertion = decode(row.get("body"))?;
        if matches!(current.status, AssertionStatus::Rejected | AssertionStatus::Withdrawn)
            && (assertion_head.get(&current.reference.id) != Some(&current.reference) || assertions.get(&current.reference) != Some(&current)) {
            return Err(FactFailure::RevisionConflict { expected: current.reference.revision, actual: assertion_head.get(&current.reference.id).map_or(Revision(0), |reference| reference.revision) }.into());
        }
    }
    Ok(evidence_head
        .values()
        .filter_map(|reference| evidence.get(reference))
        .filter(|value| {
            value.status == EvidenceStatus::Active
                && value.availability == EvidenceAvailability::Available
        })
        .map(|value| value.locator.clone())
        .collect())
}
fn invalid() -> Error {
    FactFailure::Structural {
        field: FieldPath(vec!["archive".into(), "facts".into()]),
    }
    .into()
}
