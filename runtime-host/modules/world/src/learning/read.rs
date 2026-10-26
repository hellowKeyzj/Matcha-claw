use super::{
    Error, invalid,
    proposal::{decode, lock, number},
};
use crate::{definitions::canonical_digest, store::WorldTransaction};
use world_protocol::{
    ids::{BranchId, CandidateId, ChangeSetId, Revision},
    learning::{Candidate, ChangeSet, LearningFailure},
    releases::WorldBranch,
};

/// A ChangeSetId is not a CandidateId; resolve the immutable change and verify its canonical owner.
pub(crate) async fn read_for_change(
    tx: &WorldTransaction<'_>,
    id: &ChangeSetId,
) -> Result<(WorldBranch, Candidate), Error> {
    let rows = tx.query("SELECT c.candidate_id,s.branch_id,s.revision,s.content_digest,s.body FROM world_candidate_head h JOIN world_candidate_revision c USING(tenant_id,world_id,candidate_id,revision) JOIN world_change_set s ON s.tenant_id=c.tenant_id AND s.world_id=c.world_id AND s.change_set_id=c.change_set_id AND s.revision=c.revision WHERE c.tenant_id=$1 AND c.world_id=$2 AND c.change_set_id=$3 LIMIT 2",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &id.as_str()]).await?;
    let row = rows.first().ok_or_else(|| invalid(0, "changeSet.id"))?;
    if rows.len() != 1 {
        return Err(LearningFailure::BasisChanged.into());
    }
    let branch_id = BranchId::try_new(row.get::<_, String>("branch_id"))
        .map_err(|_| invalid(0, "branch.id"))?;
    let change: ChangeSet = decode(row.get("body"))?;
    if change.world != *tx.world()
        || change.id != *id
        || number(change.revision)? != row.get::<_, i64>("revision")
        || canonical_digest(&change)?.as_str() != row.get::<_, String>("content_digest")
    {
        return Err(LearningFailure::BasisChanged.into());
    }
    let id = CandidateId::try_new(row.get::<_, String>("candidate_id"))
        .map_err(|_| invalid(0, "candidate.id"))?;
    lock(tx, &id).await?;
    let (branch, candidate) = crate::releases::read_candidate(tx, &id)
        .await?
        .ok_or(LearningFailure::BasisChanged)?;
    if branch.id != branch_id || candidate.change_set != change {
        return Err(LearningFailure::BasisChanged.into());
    }
    Ok((branch, candidate))
}

pub(super) async fn historical_candidate(
    tx: &WorldTransaction<'_>,
    id: &CandidateId,
    revision: Revision,
) -> Result<Option<(WorldBranch, Candidate)>, Error> {
    let row = tx.query_opt("SELECT c.task_id,c.task_revision,c.content_digest,c.status,c.body,s.branch_id,s.branch_revision,s.content_digest AS change_digest,s.body AS change_body FROM world_candidate_revision c JOIN world_change_set s ON s.tenant_id=c.tenant_id AND s.world_id=c.world_id AND s.change_set_id=c.change_set_id AND s.revision=c.revision WHERE c.tenant_id=$1 AND c.world_id=$2 AND c.candidate_id=$3 AND c.revision=$4",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &id.as_str(), &number(revision)?]).await?;
    let Some(row) = row else { return Ok(None); };
    let candidate: Candidate = decode(row.get("body"))?;
    let change: ChangeSet = decode(row.get("change_body"))?;
    let reference = world_protocol::releases::BranchRef {
        world: tx.world().clone(),
        id: BranchId::try_new(row.get::<_, String>("branch_id"))
            .map_err(|_| invalid(0, "branch.id"))?,
        revision: Revision(u64::try_from(row.get::<_, i64>("branch_revision"))
            .map_err(|_| invalid(0, "branch.revision"))?),
    };
    let branch = crate::releases::read_branch_revision(tx, &reference).await?
        .ok_or(LearningFailure::BasisChanged)?;
    if candidate.world != *tx.world()
        || candidate.id != *id
        || change.world != *tx.world()
        || change.revision != revision
        || candidate.change_set != change
        || canonical_digest(&candidate)?.as_str() != row.get::<_, String>("content_digest")
        || canonical_digest(&change)?.as_str() != row.get::<_, String>("change_digest")
        || super::proposal::status(change.status) != row.get::<_, String>("status")
        || branch.candidate_id != *id
        || branch.change_set_id != change.id
        || branch.task_id.as_str() != row.get::<_, String>("task_id")
        || number(branch.task_revision)? != row.get::<_, i64>("task_revision")
        || branch.status != change.status
        || branch.basis.release_id != change.base_release
        || branch.basis.overlay != change.operations
    {
        return Err(LearningFailure::BasisChanged.into());
    }
    Ok(Some((branch, candidate)))
}

pub(crate) async fn proposer(
    tx: &WorldTransaction<'_>,
    id: &CandidateId,
) -> Result<world_protocol::ids::ActorId, Error> {
    let (_, candidate) = crate::releases::read_candidate(tx, id)
        .await?
        .ok_or(LearningFailure::BasisChanged)?;
    let row = tx.query_opt("SELECT actor_id,content_digest,body FROM world_change_set WHERE tenant_id=$1 AND world_id=$2 AND change_set_id=$3 AND revision=1",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &candidate.change_set.id.as_str()]).await?.ok_or(LearningFailure::BasisChanged)?;
    let first: ChangeSet = decode(row.get("body"))?;
    if first.world != *tx.world()
        || first.id != candidate.change_set.id
        || first.revision != world_protocol::ids::Revision(1)
        || canonical_digest(&first)?.as_str() != row.get::<_, String>("content_digest")
    {
        return Err(LearningFailure::BasisChanged.into());
    }
    world_protocol::ids::ActorId::try_new(row.get::<_, String>("actor_id"))
        .map_err(|_| invalid(0, "proposer"))
}

pub(crate) async fn change(
    tx: &WorldTransaction<'_>,
    verified: &crate::authorization::VerifiedInvocation,
    id: &ChangeSetId,
) -> Result<Option<ChangeSet>, crate::owner::Error> {
    if tx.query_opt("SELECT 1 FROM world_candidate_head h JOIN world_candidate_revision c USING(tenant_id,world_id,candidate_id,revision) WHERE c.tenant_id=$1 AND c.world_id=$2 AND c.change_set_id=$3",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &id.as_str()]).await?.is_none() { return Ok(None); }
    visible(tx, verified, id, 1).await
}

pub(crate) async fn changes(
    tx: &WorldTransaction<'_>,
    verified: &crate::authorization::VerifiedInvocation,
    page: &world_protocol::query::PageRequest,
) -> Result<world_protocol::query::Page<ChangeSet>, crate::owner::Error> {
    use world_protocol::query::{Page, QueryFailure, TruncationReason};
    if page.limit == 0 || page.limit > 200 {
        return Err(query_error(QueryFailure::InvalidQuery {
            field: world_protocol::failure::FieldPath(vec!["page".into()]),
        }));
    }
    let mut after = page.cursor.clone().unwrap_or_default();
    if !after.is_empty() {
        ChangeSetId::try_new(after.clone())
            .map_err(|_| query_error(QueryFailure::CursorInvalid))?;
    }
    let mut items = Vec::new();
    let mut scanned = 0usize;
    loop {
        if tx.now().await? >= verified.invocation().deadline {
            return Err(query_error(QueryFailure::BudgetExceeded {
                limit: TruncationReason::Deadline,
            }));
        }
        let rows = tx.query("SELECT DISTINCT c.change_set_id FROM world_candidate_head h JOIN world_candidate_revision c USING(tenant_id,world_id,candidate_id,revision) WHERE c.tenant_id=$1 AND c.world_id=$2 AND c.change_set_id>$3 ORDER BY c.change_set_id LIMIT 128",
            &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &after]).await?;
        let exhausted = rows.len() < 128;
        for row in rows {
            scanned += 1;
            if scanned > 4096 {
                return Err(query_error(QueryFailure::BudgetExceeded {
                    limit: TruncationReason::Rows,
                }));
            }
            after = row.get("change_set_id");
            let id = ChangeSetId::try_new(after.clone()).map_err(|_| {
                crate::owner::Error::internal(world_protocol::failure::FailureStage::Read)
            })?;
            if let Some(item) = visible(
                tx,
                verified,
                &id,
                (items.len() + 1).min(page.limit as usize) as u64,
            )
            .await?
            {
                if items.len() == page.limit as usize {
                    return Ok(Page {
                        next_cursor: items.last().map(|item: &ChangeSet| item.id.to_string()),
                        items,
                    });
                }
                items.push(item);
            }
        }
        if exhausted {
            return Ok(Page {
                items,
                next_cursor: None,
            });
        }
    }
}

async fn visible(
    tx: &WorldTransaction<'_>,
    verified: &crate::authorization::VerifiedInvocation,
    id: &ChangeSetId,
    delivered: u64,
) -> Result<Option<ChangeSet>, crate::owner::Error> {
    let (branch, candidate) = read_for_change(tx, id).await?;
    let impact = super::candidate_impact(
        tx,
        &candidate,
        &branch,
        world_protocol::authorization::AccessMode::Read,
    )
    .await?;
    let now = tx.now().await?;
    let admission = match crate::authorization::admit(tx, verified, &impact, &[], None, &now).await
    {
        Ok(value) => value,
        Err(crate::authorization::AuthError::Denied(_)) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    crate::authorization::check_admitted_output(
        tx,
        &admission,
        &impact,
        delivered,
        &tx.now().await?,
    )
    .await?;
    Ok(Some(candidate.change_set))
}

fn query_error(failure: world_protocol::query::QueryFailure) -> crate::owner::Error {
    crate::owner::Error::new(
        "world.change_directory_unavailable",
        world_protocol::failure::FailureStage::Read,
        "变更目录读取未完成。",
        world_protocol::api::ApiFailure::Query(failure),
        world_protocol::failure::Recovery::None,
    )
}
