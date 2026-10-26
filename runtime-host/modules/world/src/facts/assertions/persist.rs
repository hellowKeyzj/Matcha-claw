use world_protocol::{
    authorization::Decision,
    commit::CommittedRevision,
    facts::{
        Assertion, AssertionOrigin, AssertionStatus, Claim, Evidence, EvidenceAvailability,
        EvidenceStatus, Polarity,
    },
    identity::SubjectRef,
    ids::ResourceRef,
    materials::SourceAnchor,
};

use crate::store::{OutboxEvent, WorldTransaction};

use super::{
    Error,
    read::{encode, revision},
};

pub(super) async fn assertion(
    tx: &mut WorldTransaction<'_>,
    value: &Assertion,
    decision: &Decision,
) -> Result<(), Error> {
    tx.require_domain(
        &world_protocol::ids::WriterDomain::try_new("facts").expect("facts writer domain"),
    )?;
    let (kind, subject_kind, subject_id, predicate) = match &value.claim {
        Claim::Attribute(claim) => {
            let (subject_kind, subject_id) = match &claim.subject {
                SubjectRef::Object { id } => ("object", id.as_str()),
                SubjectRef::Relation { id } => ("relation", id.as_str()),
            };
            ("attribute", subject_kind, subject_id, &claim.property)
        }
        Claim::Relation(claim) => (
            "relation",
            "relation",
            claim.relation_id.as_str(),
            &claim.relation_type,
        ),
    };
    let (origin, binding, authority) = match &value.origin {
        AssertionOrigin::Source {
            binding, authority, ..
        } => ("source", Some(binding), Some(authority)),
        AssertionOrigin::Derived { .. } => ("derived", None, None),
        AssertionOrigin::HumanObservation { .. } => ("human_observation", None, None),
        AssertionOrigin::Extraction { .. } => ("extraction", None, None),
    };
    let world = tx.world().clone();
    let id = value.reference.id.as_str();
    let rev = revision(value.reference.revision.0)?;
    let predicate_rev = revision(predicate.revision.0)?;
    let binding_rev = binding
        .map(|binding| revision(binding.revision.0))
        .transpose()?;
    let authority_rev = authority
        .map(|authority| revision(authority.revision.0))
        .transpose()?;
    let previous_rev = value
        .supersedes
        .as_ref()
        .map(|previous| revision(previous.revision.0))
        .transpose()?;
    tx.execute(
        "INSERT INTO world_assertion_identity(tenant_id,world_id,assertion_id,claim_kind,subject_kind,subject_id,predicate_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id, &kind, &subject_kind, &subject_id, &predicate.id.as_str()],
    ).await?;
    tx.execute(
        "INSERT INTO world_assertion_revision(tenant_id,world_id,assertion_id,revision,claim_kind,subject_kind,subject_id,predicate_id,predicate_revision,scope_id,valid_from,valid_to,polarity,status,origin_kind,source_binding_id,source_binding_revision,authority_policy_id,authority_revision,supersedes_id,supersedes_revision,body,admission,recorded_at,valid_from_ns,valid_to_ns) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text::timestamptz,$12::text::timestamptz,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::text::timestamptz,$25::text::numeric,$26::text::numeric)",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id, &rev, &kind, &subject_kind, &subject_id,
          &predicate.id.as_str(), &predicate_rev, &value.scope.as_str(), &value.valid_time.from.as_str(),
          &value.valid_time.to.as_ref().map(|to| to.as_str()), &polarity(value.polarity), &assertion_status(value.status), &origin,
          &binding.map(|binding| binding.id.as_str()), &binding_rev,
          &authority.map(|authority| authority.policy_id.as_str()), &authority_rev,
          &value.supersedes.as_ref().map(|previous| previous.id.as_str()), &previous_rev, &encode(value)?, &encode(decision)?, &value.recorded_at.as_str(),
          &value.valid_time.from.unix_nanos().to_string(), &value.valid_time.to.as_ref().map(|to| to.unix_nanos().to_string())],
    ).await?;
    let changed = if let Some(previous) = previous_rev {
        tx.execute("UPDATE world_assertion_head SET revision=$4 WHERE tenant_id=$1 AND world_id=$2 AND assertion_id=$3 AND revision=$5",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id, &rev, &previous]).await?
    } else {
        tx.execute("INSERT INTO world_assertion_head(tenant_id,world_id,assertion_id,revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id, &rev]).await?
    };
    tx.require_changed(
        changed,
        ResourceRef::Assertion {
            id: value.reference.id.clone(),
        },
    )?;
    if let Claim::Relation(claim) = &value.claim {
        for role in &claim.roles {
            tx.execute("INSERT INTO world_assertion_role(tenant_id,world_id,assertion_id,revision,role_id,object_id) VALUES($1,$2,$3,$4,$5,$6)",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id, &rev, &role.role.as_str(), &role.object_id.as_str()]).await?;
        }
    }
    for subject in super::read::claim_subjects(&value.claim) {
        let (kind, subject) = match &subject {
            SubjectRef::Object { id } => ("object", id.as_str()),
            SubjectRef::Relation { id } => ("relation", id.as_str()),
        };
        tx.execute("INSERT INTO world_assertion_subject(tenant_id,world_id,assertion_id,revision,subject_kind,subject_id) VALUES($1,$2,$3,$4,$5,$6)",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id, &rev, &kind, &subject]).await?;
    }
    for evidence in &value.evidence {
        tx.execute("INSERT INTO world_assertion_evidence(tenant_id,world_id,assertion_id,revision,evidence_id,evidence_revision) VALUES($1,$2,$3,$4,$5,$6)",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id, &rev, &evidence.id.as_str(), &revision(evidence.revision.0)?]).await?;
    }
    tx.record_revision(CommittedRevision {
        resource: ResourceRef::Assertion {
            id: value.reference.id.clone(),
        },
        revision: value.reference.revision,
    })?;
    emit(
        tx,
        "assertion",
        id,
        value.reference.revision.0,
        "world.assertion_revised",
        &value.reference,
    )
    .await
}

pub(super) async fn evidence(
    tx: &mut WorldTransaction<'_>,
    value: &Evidence,
    previous: Option<&Evidence>,
) -> Result<(), Error> {
    tx.require_domain(
        &world_protocol::ids::WriterDomain::try_new("facts").expect("facts writer domain"),
    )?;
    let world = tx.world().clone();
    let id = value.reference.id.as_str();
    let rev = revision(value.reference.revision.0)?;
    let locator_kind = match &value.locator.anchor {
        SourceAnchor::Text { .. } => "text",
        SourceAnchor::Pdf { .. } => "pdf",
        SourceAnchor::Html { .. } => "html",
        SourceAnchor::Sheet { .. } => "sheet",
        SourceAnchor::PackagePart { .. } => "package_part",
        SourceAnchor::Media { .. } => "media",
        SourceAnchor::Record { .. } => "record",
    };
    let status = match value.status {
        EvidenceStatus::Active => "active",
        EvidenceStatus::Withdrawn => "withdrawn",
        EvidenceStatus::ContentDeleted => "content_deleted",
    };
    let availability = match value.availability {
        EvidenceAvailability::Available => "available",
        EvidenceAvailability::Unavailable => "unavailable",
    };
    tx.execute(
        "INSERT INTO world_evidence_revision(tenant_id,world_id,evidence_id,revision,source_id,source_version_id,parse_artifact_id,locator_kind,origin_family,observed_at,digest,status,availability,access_policy_id,access_policy_revision,retention_policy_id,retention_policy_revision,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text::timestamptz,$11,$12,$13,$14,$15,$16,$17,$18)",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id, &rev, &value.locator.source_version.source_id.as_str(),
          &value.locator.source_version.version_id.as_str(), &value.locator.parse_artifact_id.as_ref().map(|id| id.as_str()),
          &locator_kind, &value.origin_family.as_str(), &value.observed_at.as_str(), &value.digest.as_ref().map(|digest| digest.as_str()),
          &status, &availability, &value.access.policy_id.as_str(), &revision(value.access.revision.0)?,
          &value.retention.policy_id.as_str(), &revision(value.retention.revision.0)?, &encode(value)?],
    ).await?;
    let changed = if let Some(previous) = previous {
        tx.execute("UPDATE world_evidence_head SET revision=$4 WHERE tenant_id=$1 AND world_id=$2 AND evidence_id=$3 AND revision=$5",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id, &rev, &revision(previous.reference.revision.0)?]).await?
    } else {
        tx.execute("INSERT INTO world_evidence_head(tenant_id,world_id,evidence_id,revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id, &rev]).await?
    };
    tx.require_changed(
        changed,
        ResourceRef::Evidence {
            id: value.reference.id.clone(),
        },
    )?;
    for parent in &value.derived_from {
        tx.execute("INSERT INTO world_evidence_derived_from(tenant_id,world_id,evidence_id,revision,parent_id,parent_revision) VALUES($1,$2,$3,$4,$5,$6)",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id, &rev, &parent.id.as_str(), &revision(parent.revision.0)?]).await?;
    }
    tx.record_revision(CommittedRevision {
        resource: ResourceRef::Evidence {
            id: value.reference.id.clone(),
        },
        revision: value.reference.revision,
    })?;
    emit(
        tx,
        "evidence",
        id,
        value.reference.revision.0,
        "world.evidence_revised",
        &value.reference,
    )
    .await
}

async fn emit(
    tx: &mut WorldTransaction<'_>,
    kind: &str,
    id: &str,
    revision: u64,
    event: &str,
    reference: &impl serde::Serialize,
) -> Result<(), Error> {
    tx.emit(OutboxEvent {
        event_id: world_protocol::ids::EventId::try_new(uuid::Uuid::new_v4().to_string())
            .expect("UUID identifier"),
        aggregate_kind: kind.into(),
        aggregate_id: id.into(),
        aggregate_revision: revision,
        event_kind: event.into(),
        payload: encode(reference)?,
        causation_id: None,
        origin: "world.facts".into(),
    })
    .await?;
    Ok(())
}

fn polarity(value: Polarity) -> &'static str {
    match value {
        Polarity::Positive => "positive",
        Polarity::Negative => "negative",
    }
}
fn assertion_status(value: AssertionStatus) -> &'static str {
    match value {
        AssertionStatus::Candidate => "candidate",
        AssertionStatus::Accepted => "accepted",
        AssertionStatus::Rejected => "rejected",
        AssertionStatus::Withdrawn => "withdrawn",
    }
}
