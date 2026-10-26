use world_protocol::{
    authorization::{AccessMode, AccessScope, Actor},
    commit::CommittedRevision,
    ids::{CandidateId, ChangeSetId, EventId, ReleaseId, ResourceRef, Revision},
    learning::{Candidate, ChangeStatus, LearningFailure},
    releases::{ReleaseFailure, WorldBranch},
    time::Timestamp,
};

use super::{Error, invalid, metadata, require_writer, state::recheck_support};
use crate::{
    authorization::{self, Admission},
    definitions::canonical_digest,
    store::{OutboxEvent, WorldTransaction},
};

/// Admit a draft and its branch atomically; compiling is not independent acceptance.
pub(crate) async fn propose(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    candidate: &Candidate,
    branch: &WorldBranch,
    draft: Option<&crate::owner::DraftModelCalls>,
    budget: &crate::extensions::invocation::CallBudget,
    cancel: &tokio_util::sync::CancellationToken,
    _now: &Timestamp,
) -> Result<Candidate, Error> {
    require_writer(tx)?;
    let now = tx.now().await?;
    if candidate.world != *tx.world()
        || candidate.change_set.world != candidate.world
        || branch.world != candidate.world
        || branch.candidate_id != candidate.id
        || branch.change_set_id != candidate.change_set.id
        || branch.basis.release_id != candidate.change_set.base_release
        || branch.basis.overlay != candidate.change_set.operations
        || branch.status != ChangeStatus::Proposed
        || candidate.change_set.status != ChangeStatus::Proposed
        || branch.revision.0 == 0
        || candidate.change_set.revision.0 == 0
        || candidate.created_at > now
        || candidate.change_set.rationale.trim().is_empty()
    {
        return Err(invalid(0, "candidate"));
    }
    lock(tx, &candidate.id).await?;
    let task = crate::evaluation::read_task(tx, &branch.task_id, branch.task_revision).await?;
    let impact = authorization::actual_impact(
        vec![
            AccessScope {
                resources: vec![ResourceRef::ChangeSet {
                    id: candidate.change_set.id.clone(),
                }],
                fields: Vec::new(),
                modes: vec![AccessMode::Write],
                scope: task.scope.clone(),
                valid_time: None,
            },
            AccessScope {
                resources: vec![ResourceRef::Task {
                    id: task.id.clone(),
                }],
                fields: Vec::new(),
                modes: vec![AccessMode::Read],
                scope: task.scope.clone(),
                valid_time: None,
            },
        ],
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )?;
    admission.require_access(&impact)?;
    admission.require_access(
        &super::candidate_impact(tx, candidate, branch, AccessMode::Write).await?,
    )?;
    authorization::recheck(tx, admission, &now).await?;
    if let Some((stored_branch, stored)) =
        crate::releases::read_candidate(tx, &candidate.id).await?
    {
        if stored == *candidate && stored_branch == *branch {
            super::provenance::recheck(tx, admission, &stored).await?;
            return Ok(stored);
        }
        return Err(LearningFailure::BasisChanged.into());
    }
    let historical = super::read::historical_candidate(tx, &candidate.id, Revision(1)).await?;
    if let Some((original_branch, original)) = &historical {
        let mut proposed = candidate.clone();
        proposed.change_set.revision = original.change_set.revision;
        if proposed != *original
            || original_branch.id != branch.id
            || original_branch.task_id != branch.task_id
            || original_branch.task_revision != branch.task_revision
            || original_branch.change_set_id != branch.change_set_id
            || original_branch.basis != branch.basis
        {
            return Err(LearningFailure::BasisChanged.into());
        }
    }
    let calls = super::provenance::prepare(tx, admission, candidate, draft).await?;
    recheck_support(tx, admission, candidate, branch, &now).await?;
    let mut candidate = candidate.clone();
    candidate.change_set.revision = next_change_revision(tx, &candidate.change_set.id).await?;
    if historical.is_none() && candidate.change_set.revision != Revision(1) {
        return Err(LearningFailure::BasisChanged.into());
    }
    let branch = crate::releases::insert_branch(tx, admission, branch, budget, cancel, &now).await?;
    let world = tx.world().clone();
    tx.execute("INSERT INTO world_candidate(tenant_id,world_id,candidate_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &candidate.id.as_str()]).await?;
    write_change(tx, admission, &candidate, &branch).await?;
    write_candidate(tx, &candidate, &branch, None).await?;
    super::provenance::attach(tx, admission, &candidate, &calls).await?;
    metadata::materialize(tx, admission, &branch, &now).await?;
    emit(tx, &candidate).await?;
    Ok(candidate)
}

/// Releases calls this only after its checked release and Published branch are stored in this transaction.
pub(crate) async fn complete_publication(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    id: &CandidateId,
    expected: Revision,
    release_id: &ReleaseId,
    _now: &Timestamp,
) -> Result<Candidate, Error> {
    require_writer(tx)?;
    lock(tx, id).await?;
    let release = crate::releases::read_release(tx, release_id)
        .await?
        .ok_or_else(|| ReleaseFailure::ReleaseMissing {
            release_id: release_id.clone(),
        })?;
    let source = release
        .source_branch
        .as_ref()
        .ok_or_else(|| invalid(0, "release.sourceBranch"))?;
    let branch = crate::releases::read_branch(tx, &source.id)
        .await?
        .ok_or_else(|| ReleaseFailure::BranchMissing {
            branch_id: source.id.clone(),
        })?;
    let world = tx.world().clone();
    let row = tx.query_opt("SELECT c.revision,c.content_digest,c.body FROM world_candidate_head h JOIN world_candidate_revision c USING(tenant_id,world_id,candidate_id,revision) WHERE c.tenant_id=$1 AND c.world_id=$2 AND c.candidate_id=$3 FOR UPDATE OF h",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()]).await?.ok_or_else(|| invalid(0, "candidate.id"))?;
    let mut candidate: Candidate = decode(row.get("body"))?;
    if candidate.world != world
        || candidate.id != *id
        || source.world != world
        || branch.candidate_id != *id
        || branch.change_set_id != candidate.change_set.id
        || branch.status != ChangeStatus::Published
        || branch.revision <= source.revision
        || candidate.change_set.status != ChangeStatus::Ready
        || candidate.change_set.revision != expected
        || number(expected)? != row.get::<_, i64>("revision")
        || canonical_digest(&candidate)?.as_str() != row.get::<_, String>("content_digest")
        || branch.basis.overlay != candidate.change_set.operations
        || branch.basis.release_id != candidate.change_set.base_release
    {
        return Err(LearningFailure::BasisChanged.into());
    }
    let ready = crate::releases::read_branch_revision(tx, source)
        .await?
        .ok_or(LearningFailure::BasisChanged)?;
    let (birth, stored) = super::read::historical_candidate(tx, id, expected).await?
        .ok_or(LearningFailure::BasisChanged)?;
    if stored != candidate || birth != ready {
        return Err(LearningFailure::BasisChanged.into());
    }
    if ready.status != ChangeStatus::Ready
        || ready.candidate_id != *id
        || ready.change_set_id != candidate.change_set.id
        || ready.task_id != branch.task_id
        || ready.task_revision != branch.task_revision
        || ready.compile.definitions != release.definitions
        || ready.basis != branch.basis
        || ready.compile != branch.compile
    {
        return Err(LearningFailure::BasisChanged.into());
    }
    let task = crate::evaluation::read_task(tx, &branch.task_id, branch.task_revision).await?;
    let now = tx.now().await?;
    let impact = authorization::actual_impact(
        vec![AccessScope {
            resources: vec![ResourceRef::ChangeSet {
                id: candidate.change_set.id.clone(),
            }],
            fields: Vec::new(),
            modes: vec![AccessMode::Publish],
            scope: task.scope,
            valid_time: None,
        }],
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )?;
    admission.require_access(&impact)?;
    authorization::recheck(tx, admission, &now).await?;
    candidate.change_set.revision = next_change_revision(tx, &candidate.change_set.id).await?;
    candidate.change_set.status = ChangeStatus::Published;
    write_change(tx, admission, &candidate, &branch).await?;
    write_candidate(tx, &candidate, &branch, Some(expected)).await?;
    emit(tx, &candidate).await?;
    Ok(candidate)
}

pub(super) fn encode(value: &impl serde::Serialize) -> Result<serde_json::Value, Error> {
    serde_json::to_value(value).map_err(|_| LearningFailure::InternalFault.into())
}
pub(super) fn decode<T: serde::de::DeserializeOwned>(value: serde_json::Value) -> Result<T, Error> {
    serde_json::from_value(value).map_err(|_| LearningFailure::InternalFault.into())
}
pub(super) fn number(value: Revision) -> Result<i64, Error> {
    i64::try_from(value.0).map_err(|_| invalid(0, "revision"))
}
pub(super) fn status(value: ChangeStatus) -> &'static str {
    match value {
        ChangeStatus::Proposed => "proposed",
        ChangeStatus::Validated => "validated",
        ChangeStatus::Testing => "testing",
        ChangeStatus::Ready => "ready",
        ChangeStatus::Rejected => "rejected",
        ChangeStatus::Published => "published",
        ChangeStatus::Superseded => "superseded",
    }
}
pub(crate) async fn lock(tx: &WorldTransaction<'_>, id: &CandidateId) -> Result<(), Error> {
    let key = serde_json::to_string(&(tx.world(), "learning", id))
        .map_err(|_| LearningFailure::InternalFault)?;
    tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        &[&key],
    )
    .await?;
    Ok(())
}
pub(crate) async fn next_change_revision(
    tx: &WorldTransaction<'_>,
    id: &ChangeSetId,
) -> Result<Revision, Error> {
    let key = serde_json::to_string(&(tx.world(), "learning.change", id))
        .map_err(|_| LearningFailure::InternalFault)?;
    tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", &[&key]).await?;
    let rows = tx.query("SELECT COALESCE(MAX(revision),0) AS revision FROM world_change_set WHERE tenant_id=$1 AND world_id=$2 AND change_set_id=$3",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &id.as_str()]).await?;
    let previous = u64::try_from(rows[0].get::<_, i64>("revision"))
        .map_err(|_| invalid(0, "revision"))?;
    let revision = Revision(previous.checked_add(1).ok_or(LearningFailure::BasisChanged)?);
    number(revision)?;
    Ok(revision)
}

pub(super) async fn write_candidate(
    tx: &WorldTransaction<'_>,
    candidate: &Candidate,
    branch: &WorldBranch,
    expected: Option<Revision>,
) -> Result<(), Error> {
    let world = tx.world();
    tx.execute("INSERT INTO world_candidate_revision(tenant_id,world_id,candidate_id,revision,task_id,task_revision,change_set_id,content_digest,status,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &candidate.id.as_str(), &number(candidate.change_set.revision)?,
          &branch.task_id.as_str(), &number(branch.task_revision)?, &candidate.change_set.id.as_str(),
          &canonical_digest(candidate)?.as_str(), &status(candidate.change_set.status), &encode(candidate)?]).await?;
    let changed = match expected {
        Some(expected) => tx.execute("UPDATE world_candidate_head SET revision=$4 WHERE tenant_id=$1 AND world_id=$2 AND candidate_id=$3 AND revision=$5",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &candidate.id.as_str(), &number(candidate.change_set.revision)?, &number(expected)?]).await?,
        None => tx.execute("INSERT INTO world_candidate_head(tenant_id,world_id,candidate_id,revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &candidate.id.as_str(), &number(candidate.change_set.revision)?]).await?,
    };
    if changed != 1 {
        return Err(LearningFailure::BasisChanged.into());
    }
    Ok(())
}

pub(super) async fn write_change(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    candidate: &Candidate,
    branch: &WorldBranch,
) -> Result<(), Error> {
    let world = tx.world().clone();
    let change = &candidate.change_set;
    let actor = match &admission.invocation().actor {
        Actor::Human { id } | Actor::Service { id } => id,
    };
    tx.execute("INSERT INTO world_change_set(tenant_id,world_id,change_set_id,revision,branch_id,branch_revision,base_release_id,content_digest,status,actor_id,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &change.id.as_str(), &number(change.revision)?, &branch.id.as_str(),
          &number(branch.revision)?, &change.base_release.as_str(), &canonical_digest(change)?.as_str(), &status(change.status), &actor.as_str(), &encode(change)?]).await?;
    tx.record_revision(CommittedRevision {
        resource: ResourceRef::ChangeSet {
            id: change.id.clone(),
        },
        revision: change.revision,
    })?;
    Ok(())
}
pub(super) async fn emit(
    tx: &mut WorldTransaction<'_>,
    candidate: &Candidate,
) -> Result<(), Error> {
    let digest = canonical_digest(&(
        tx.world(),
        "learning",
        &candidate.id,
        candidate.change_set.revision,
        tx.commit_id(),
    ))?;
    let event_id = EventId::try_new(format!("learning-{}", &digest.as_str()[7..]))
        .map_err(|_| LearningFailure::InternalFault)?;
    tx.emit(OutboxEvent {
        event_id,
        aggregate_kind: "candidate".into(),
        aggregate_id: candidate.id.as_str().into(),
        aggregate_revision: candidate.change_set.revision.0,
        event_kind: "candidate.revised".into(),
        payload: encode(candidate)?,
        causation_id: None,
        origin: "world.learning".into(),
    })
    .await?;
    Ok(())
}
