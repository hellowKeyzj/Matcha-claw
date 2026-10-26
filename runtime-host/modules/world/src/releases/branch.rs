use super::{Error, read_branch, read_release, require_writer};
use crate::{
    authorization::{self, Admission},
    content::{self, ContentOwner, ContentReference},
    definitions::{canonical_digest, read_scopes},
    extensions::{bindings::read_graph_in_transaction, invocation::CallBudget},
    store::WorldTransaction,
};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    authorization::{AccessMode, AccessScope, Actor},
    commit::CommittedRevision,
    evaluation::{BranchBasis, Replayability},
    failure::FieldPath,
    ids::{ResourceRef, Revision},
    learning::ChangeStatus,
    materials::BlobRef,
    query::ReadReceipt,
    releases::{BranchRef, ReleaseFailure, WorldBranch},
    sources::{SourceBasis, SourceGuarantee},
    time::Timestamp,
};

/// The sole branch producer. Semantic operations are interpreted by Learning, never by caller IR.
pub(crate) async fn insert_branch(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    branch: &WorldBranch,
    budget: &CallBudget,
    cancellation: &CancellationToken,
    _now: &Timestamp,
) -> Result<WorldBranch, Error> {
    require_writer(tx)?;
    lock(tx, &branch.id).await?;
    if branch.status != ChangeStatus::Proposed {
        return Err(invalid("status"));
    }
    if !historical_basis(tx, branch).await? {
        return Err(invalid("basis"));
    }
    validate(tx, admission, branch, true, budget, cancellation).await?;
    if let Some(actual) = read_branch(tx, &branch.id).await? {
        if actual == *branch {
            return Ok(actual);
        }
        return Err(ReleaseFailure::BranchConflict {
            branch_id: branch.id.clone(),
            expected: Revision(0),
            actual: actual.revision,
            fields: vec![FieldPath(vec!["id".into()])],
        }
        .into());
    }
    if branch.revision != next_branch_revision(tx, &branch.id).await? {
        return Err(invalid("revision"));
    }
    let world = tx.world().clone();
    let actor = match &admission.invocation().actor {
        Actor::Human { id } | Actor::Service { id } => id,
    };
    tx.execute("INSERT INTO world_branch(tenant_id,world_id,branch_id,actor_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &branch.id.as_str(), &actor.as_str()]).await?;
    finish(tx, branch).await?;
    let changed = tx.execute("INSERT INTO world_branch_head(tenant_id,world_id,branch_id,revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &branch.id.as_str(), &super::read::number(branch.revision.0)?]).await?;
    tx.require_changed(changed, ResourceRef::Branch { id: branch.id.clone() })?;
    Ok(branch.clone())
}

pub(crate) async fn update_branch(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    expected: Revision,
    next: &WorldBranch,
    budget: &CallBudget,
    cancellation: &CancellationToken,
    _now: &Timestamp,
) -> Result<WorldBranch, Error> {
    require_writer(tx)?;
    lock(tx, &next.id).await?;
    let current =
        read_branch(tx, &next.id)
            .await?
            .ok_or_else(|| ReleaseFailure::BranchMissing {
                branch_id: next.id.clone(),
            })?;
    if current.revision != expected {
        return Err(ReleaseFailure::BranchConflict {
            branch_id: next.id.clone(),
            expected,
            actual: current.revision,
            fields: vec![FieldPath(vec!["revision".into()])],
        }
        .into());
    }
    if next.revision != next_branch_revision(tx, &next.id).await?
        || next.task_id != current.task_id
        || next.task_revision != current.task_revision
        || next.candidate_id != current.candidate_id
        || next.change_set_id != current.change_set_id
        || !(transition(current.status, next.status)
            || (current.status == ChangeStatus::Proposed
                && next.status == ChangeStatus::Proposed
                && (current.basis != next.basis || current.compile != next.compile)))
        || (next.status != ChangeStatus::Proposed
            && (next.basis != current.basis || next.compile != current.compile))
    {
        return Err(invalid("status"));
    }
    if next.status == ChangeStatus::Proposed
        && (next.basis != current.basis || next.compile != current.compile)
        && !historical_basis(tx, next).await?
    {
        return Err(invalid("basis"));
    }
    validate(
        tx,
        admission,
        next,
        next.status == ChangeStatus::Proposed,
        budget,
        cancellation,
    )
    .await?;
    write_branch(tx, expected, next).await
}

/// Model equivalence only; durable revisions do not establish ancestry or execution equivalence.
pub(crate) async fn require_branch_model(
    tx: &WorldTransaction<'_>,
    origin: &BranchRef,
    current: &WorldBranch,
) -> Result<WorldBranch, Error> {
    let original = super::read_branch_revision(tx, origin)
        .await?
        .ok_or_else(|| ReleaseFailure::BranchMissing {
            branch_id: origin.id.clone(),
        })?;
    let reference = BranchRef {
        world: current.world.clone(),
        id: current.id.clone(),
        revision: current.revision,
    };
    if super::read_branch_revision(tx, &reference).await?.as_ref() != Some(current)
        || original.revision > current.revision
    {
        return Err(invalid("branchModel"));
    }
    let mut projected = original.clone();
    projected.revision = current.revision;
    projected.status = current.status;
    if original.basis != current.basis {
        projected.basis = frozen_basis(
            &original,
            current.basis.sources.clone(),
            current.basis.snapshots.clone(),
            current.basis.read_receipts.clone(),
        );
    }
    if projected != *current {
        return Err(invalid("branchModel"));
    }
    Ok(original)
}

async fn write_branch(
    tx: &mut WorldTransaction<'_>,
    expected: Revision,
    next: &WorldBranch,
) -> Result<WorldBranch, Error> {
    let world = tx.world().clone();
    finish(tx, next).await?;
    let changed = tx.execute("UPDATE world_branch_head SET revision=$4 WHERE tenant_id=$1 AND world_id=$2 AND branch_id=$3 AND revision=$5",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &next.id.as_str(), &super::read::number(next.revision.0)?, &super::read::number(expected.0)?]).await?;
    if changed != 1 {
        let actual = read_branch(tx, &next.id)
            .await?
            .ok_or_else(|| invalid("branchId"))?;
        return Err(ReleaseFailure::BranchConflict {
            branch_id: next.id.clone(),
            expected,
            actual: actual.revision,
            fields: vec![FieldPath(vec!["revision".into()])],
        }
        .into());
    }
    Ok(next.clone())
}

/// Captures and replayed reads keep their original immutable branch identity.
pub(crate) async fn freeze_branch_basis(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    reference: &BranchRef,
    captures: &[crate::sources::sync::BranchCapture],
    reads: Vec<crate::query::TargetRead>,
    budget: &CallBudget,
    cancellation: &CancellationToken,
    now: &Timestamp,
) -> Result<WorldBranch, Error> {
    require_writer(tx)?;
    if &reference.world != tx.world() {
        return Err(invalid("world"));
    }
    lock(tx, &reference.id).await?;
    let current =
        read_branch(tx, &reference.id)
            .await?
            .ok_or_else(|| ReleaseFailure::BranchMissing {
                branch_id: reference.id.clone(),
            })?;
    if current.revision != reference.revision {
        return Err(ReleaseFailure::BranchConflict {
            branch_id: reference.id.clone(),
            expected: reference.revision,
            actual: current.revision,
            fields: vec![FieldPath(vec!["revision".into()])],
        }
        .into());
    }
    if current.status != ChangeStatus::Proposed {
        return Err(invalid("status"));
    }
    let obligations: std::collections::BTreeSet<_> = current
        .basis
        .read_receipts
        .iter()
        .map(|receipt| &receipt.id)
        .collect();
    let replayed: std::collections::BTreeSet<_> = reads
        .iter()
        .map(crate::query::TargetRead::original_id)
        .collect();
    if obligations.len() != current.basis.read_receipts.len()
        || replayed.len() != reads.len()
        || obligations != replayed
    {
        return Err(invalid("readReceipts"));
    }
    let required: std::collections::BTreeSet<_> =
        super::source_bindings(&current.compile.definitions)
            .into_iter()
            .collect();
    let supplied: std::collections::BTreeSet<_> = captures
        .iter()
        .map(|capture| capture.capture().binding.clone())
        .collect();
    if supplied.len() != captures.len() || supplied != required {
        return Err(invalid("sourceCapture"));
    }
    let mut sources = Vec::new();
    let mut snapshots = Vec::new();
    for capture in captures {
        super::publication::cancelled(cancellation)?;
        let item = capture.capture();
        if item.branch != *reference
            || !item.complete
            || !item.consistent
            || !item.failures.is_empty()
            || item.basis.gap.is_some()
        {
            return Err(invalid("sourceCapture"));
        }
        capture.recheck(tx, admission, now).await?;
        sources.push(item.basis.clone());
        let blob = &capture.source_version().blob;
        if !snapshots.contains(blob) {
            snapshots.push(blob.clone());
        }
    }
    let mut receipts = Vec::new();
    for read in reads {
        super::publication::cancelled(cancellation)?;
        receipts
            .push(crate::query::commit_target_read(tx, admission, &current, captures, read).await?);
    }
    let mut next = current.clone();
    next.revision = next_branch_revision(tx, &current.id).await?;
    next.basis = frozen_basis(&current, sources, snapshots, receipts);
    validate(tx, admission, &next, false, budget, cancellation).await?;
    super::publication::cancelled(cancellation)?;
    write_branch(tx, current.revision, &next).await
}

fn frozen_basis(
    branch: &WorldBranch,
    sources: Vec<SourceBasis>,
    snapshots: Vec<BlobRef>,
    receipts: Vec<ReadReceipt>,
) -> BranchBasis {
    let mut basis = branch.basis.clone();
    basis.activation_lock_id = branch.compile.activation_lock.id.clone();
    basis.sources = sources;
    basis.snapshots = snapshots;
    basis.read_receipts = receipts;
    basis.missing_sources.clear();
    for source in &basis.sources {
        if source.guarantee == SourceGuarantee::Assumed
            || (source.snapshot.is_none() && source.guarantee != SourceGuarantee::RecordedReplay)
        {
            if !basis.missing_sources.contains(&source.source_id) {
                basis.missing_sources.push(source.source_id.clone());
            }
        }
    }
    basis.replayability = if basis.missing_sources.is_empty() && basis.assumptions.is_empty() {
        Replayability::Complete
    } else {
        Replayability::Partial
    };
    basis
}

pub(crate) async fn next_branch_revision(
    tx: &WorldTransaction<'_>,
    id: &world_protocol::ids::BranchId,
) -> Result<Revision, Error> {
    lock(tx, id).await?;
    let world = tx.world();
    let rows = tx.query(
        "SELECT COALESCE(MAX(revision),0) AS revision FROM world_branch_revision WHERE tenant_id=$1 AND world_id=$2 AND branch_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()],
    ).await?;
    let next = rows[0].get::<_, i64>("revision").checked_add(1)
        .and_then(|revision| u64::try_from(revision).ok())
        .filter(|revision| *revision > 0)
        .ok_or_else(|| invalid("revision"))?;
    Ok(Revision(next))
}

pub(super) async fn lock(
    tx: &WorldTransaction<'_>,
    id: &world_protocol::ids::BranchId,
) -> Result<(), Error> {
    let key = serde_json::to_string(&(tx.world(), "release.branch", id))?;
    tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        &[&key],
    )
    .await?;
    Ok(())
}

async fn historical_basis(tx: &WorldTransaction<'_>, branch: &WorldBranch) -> Result<bool, Error> {
    let (mut canonical, _) = crate::learning::base_context(tx, &branch.basis.release_id).await?;
    canonical.overlay = branch.basis.overlay.clone();
    Ok(canonical == branch.basis)
}

async fn validate(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    branch: &WorldBranch,
    historical: bool,
    budget: &CallBudget,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    require_writer(tx)?;
    let historical = historical
        && branch.status == ChangeStatus::Proposed
        && historical_basis(tx, branch).await?;
    if &branch.world != tx.world()
        || branch.compile.world != branch.world
        || branch.revision.0 == 0
        || branch.compile.base_release != branch.basis.release_id
        || (!historical && branch.compile.activation_lock.id != branch.basis.activation_lock_id)
    {
        return Err(invalid("world"));
    }
    let base = read_release(tx, &branch.basis.release_id)
        .await?
        .ok_or_else(|| ReleaseFailure::ReleaseMissing {
            release_id: branch.basis.release_id.clone(),
        })?;
    let scopes = read_scopes(
        tx,
        &branch
            .compile
            .scopes
            .iter()
            .map(|scope| scope.id.clone())
            .collect::<Vec<_>>(),
    )
    .await?;
    if !same_scopes(&scopes, &branch.compile.scopes) {
        return Err(invalid("scopes"));
    }
    let materialized = crate::learning::materialize_frozen(tx, branch).await?;
    let proposed: std::collections::BTreeMap<_, _> = branch
        .compile
        .definitions
        .iter()
        .map(|definition| (&definition.reference.id, definition))
        .collect();
    let derived: std::collections::BTreeMap<_, _> = materialized
        .definitions()
        .iter()
        .map(|definition| (&definition.reference.id, definition))
        .collect();
    if proposed != derived || proposed.len() != branch.compile.definitions.len() {
        return Err(invalid("compile.definitions"));
    }
    let graph = read_graph_in_transaction(tx, &branch.compile.activation_lock.id).await?;
    if graph.lock() != &branch.compile.activation_lock {
        return Err(invalid("activationLock"));
    }
    crate::compiler::validate_structure(&branch.compile)?;
    let task = crate::evaluation::read_task(tx, &branch.task_id, branch.task_revision).await?;
    let mut access = vec![AccessScope {
        resources: vec![ResourceRef::Branch {
            id: branch.id.clone(),
        }],
        fields: Vec::new(),
        modes: vec![if branch.status == ChangeStatus::Published {
            AccessMode::Publish
        } else {
            AccessMode::Write
        }],
        scope: task.scope,
        valid_time: None,
    }];
    access.extend(base.definitions.iter().map(|definition| AccessScope {
        resources: vec![ResourceRef::Definition {
            id: definition.reference.id.clone(),
        }],
        fields: Vec::new(),
        modes: vec![AccessMode::Read],
        scope: definition.scope.clone(),
        valid_time: Some(definition.valid_time.clone()),
    }));
    let impact = authorization::actual_impact(
        access,
        Vec::new(),
        Vec::new(),
        Vec::new(),
        branch
            .basis
            .sources
            .iter()
            .map(|source| source.source_id.clone())
            .collect(),
    )?;
    admission.require_access(&impact)?;
    let now = tx.now().await?;
    authorization::recheck(tx, admission, &now).await?;
    if historical {
        // Sealed history is a replay obligation, not evidence of target execution or freshness.
        return Ok(());
    }
    super::basis::recheck(tx, admission, branch, budget, cancellation, &now).await
}

async fn finish(tx: &mut WorldTransaction<'_>, branch: &WorldBranch) -> Result<(), Error> {
    let world = tx.world().clone();
    for snapshot in &branch.basis.snapshots {
        content::retain(
            tx,
            &ContentReference::new(
                ContentOwner::Branch {
                    id: branch.id.clone(),
                },
                snapshot.clone(),
            )?,
        )
        .await?;
    }
    tx.execute("INSERT INTO world_branch_revision(tenant_id,world_id,branch_id,revision,base_release_id,activation_lock_id,basis_digest,content_digest,status,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &branch.id.as_str(), &super::read::number(branch.revision.0)?,
          &branch.basis.release_id.as_str(), &branch.basis.activation_lock_id.as_str(), &canonical_digest(&branch.basis)?.as_str(),
          &super::read::branch_digest(branch)?.as_str(), &super::read::status(branch.status), &serde_json::to_value(branch)?]).await?;
    tx.record_revision(CommittedRevision {
        resource: ResourceRef::Branch {
            id: branch.id.clone(),
        },
        revision: branch.revision,
    })?;
    super::persist::emit(
        tx,
        "branch",
        branch.id.as_str(),
        branch.revision,
        "branch.revised",
        &serde_json::to_value(branch)?,
    )
    .await
}

fn same_scopes(
    left: &[world_protocol::definitions::Scope],
    right: &[world_protocol::definitions::Scope],
) -> bool {
    left.len() == right.len()
        && left.iter().all(|scope| {
            right
                .iter()
                .filter(|candidate| candidate.id == scope.id && *candidate == scope)
                .count()
                == 1
        })
}
fn transition(old: ChangeStatus, next: ChangeStatus) -> bool {
    use ChangeStatus::*;
    matches!(
        (old, next),
        (Proposed, Validated | Rejected | Superseded)
            | (Validated, Testing | Proposed | Rejected | Superseded)
            | (Testing, Ready | Rejected | Proposed | Superseded)
            | (Ready, Published | Proposed | Rejected | Superseded)
            | (Rejected, Proposed | Superseded)
    )
}
fn invalid(field: &str) -> Error {
    ReleaseFailure::InvalidBranch {
        field: FieldPath(field.split('.').map(str::to_owned).collect()),
    }
    .into()
}
