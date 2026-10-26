use world_protocol::{
    api::{ProposeAbstraction, ProposeChange, WorldCommand},
    authorization::{AccessMode, AccessScope},
    compiler::{CompileRequest, CompileSelection},
    evaluation::{BranchBasis, Replayability},
    ids::{BranchId, CandidateId, ChangeSetId, Digest, ReleaseId, ResourceRef, Revision},
    learning::{Candidate, CandidateOrigin, ChangeSet, ChangeStatus, LearningFailure, TaskRef},
    releases::{ReleaseFailure, WorldBranch},
    sources::SourceGuarantee,
    time::Timestamp,
};

use super::{Error, invalid};
use crate::{
    authorization::{self, Admission},
    definitions::canonical_digest,
    store::WorldTransaction,
};

pub(crate) async fn direct_candidate(
    tx: &WorldTransaction<'_>,
    request: &ProposeChange,
    now: &Timestamp,
) -> Result<Candidate, Error> {
    let digest = canonical_digest(&(tx.world(), WorldCommand::ProposeChange(request.clone())))?;
    canonical_candidate(
        tx, request, &digest, CandidateOrigin::Direct, "直接提交的语义变更。", now,
    )
    .await
}

pub(crate) async fn abstraction_proposal(
    tx: &WorldTransaction<'_>,
    request: &ProposeAbstraction,
    now: &Timestamp,
) -> Result<(WorldBranch, Candidate), Error> {
    let first = crate::abstraction::read(tx, &request.abstraction.id, Revision(1)).await
        .map_err(crate::owner::Error::from)?;
    let mut identity = request.clone();
    if let Some(first) = &first {
        identity.abstraction.revision = first.revision;
        identity.abstraction.assurance = first.assurance;
        identity.abstraction.evaluation_ids = first.evaluation_ids.clone();
    }
    let digest = canonical_digest(&(tx.world(), WorldCommand::ProposeAbstraction(identity)))?;
    if first.as_ref().is_some_and(|first| first.candidate_id.as_str() != format!("candidate-{}", &digest.as_str()[7..])) {
        return Err(LearningFailure::BasisChanged.into());
    }
    let candidate = canonical_candidate(tx, &request.change, &digest, CandidateOrigin::Abstraction, "提交的抽象语义变更。", now).await?;
    super::lock_candidate(tx, &candidate.id).await?;
    let (branch, candidate) = match super::read::historical_candidate(tx, &candidate.id, Revision(1)).await? {
        Some(original) => original,
        None if first.is_none() => (derive_branch(tx, &candidate, &request.change.task, &request.change.compile).await?, candidate),
        None => return Err(LearningFailure::BasisChanged.into()),
    };
    if candidate.origin != CandidateOrigin::Abstraction || branch.task_id != request.change.task.id
        || branch.task_revision != request.change.task.revision || request.change.task.world != *tx.world()
        || first.as_ref().is_some_and(|first| first.branch.as_ref() != Some(&world_protocol::releases::BranchRef {
            world: branch.world.clone(), id: branch.id.clone(), revision: branch.revision,
        }))
    {
        return Err(LearningFailure::BasisChanged.into());
    }
    Ok((branch, candidate))
}

async fn canonical_candidate(
    tx: &WorldTransaction<'_>,
    request: &ProposeChange,
    digest: &Digest,
    origin: CandidateOrigin,
    rationale: &str,
    now: &Timestamp,
) -> Result<Candidate, Error> {
    let id = CandidateId::try_new(format!("candidate-{}", &digest.as_str()[7..]))
        .map_err(|_| invalid(0, "candidate.id"))?;
    if let Some((_, candidate)) = crate::releases::read_candidate(tx, &id).await? {
        return Ok(candidate);
    }
    let mut candidate = Candidate {
        world: tx.world().clone(),
        id,
        change_set: ChangeSet {
            world: tx.world().clone(),
            id: ChangeSetId::try_new(format!("change-{}", &digest.as_str()[7..]))
                .map_err(|_| invalid(0, "changeSet.id"))?,
            revision: Revision(1),
            base_release: request.base_release.clone(),
            operations: request.operations.clone(),
            evidence: request.evidence.clone(),
            cases: request.cases.clone(),
            rationale: rationale.into(),
            status: ChangeStatus::Proposed,
        },
        origin,
        evidence: Vec::new(),
        model_calls: Vec::new(),
        created_at: now.clone(),
    };
    for reference in super::impact::evidence_refs(&candidate) {
        candidate.evidence.push(
            crate::facts::assertions::read_evidence(tx, &reference)
                .await?
                .ok_or_else(|| LearningFailure::MissingEvidence { reference })?,
        );
    }
    if let Some((_, original)) = super::read::historical_candidate(tx, &candidate.id, Revision(1)).await? {
        candidate.created_at = original.created_at.clone();
        if candidate != original {
            return Err(LearningFailure::BasisChanged.into());
        }
    }
    Ok(candidate)
}

pub(crate) async fn propose_request(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    candidate: &Candidate,
    task: &TaskRef,
    selection: &CompileSelection,
    draft: Option<&crate::owner::DraftModelCalls>,
    budget: &crate::extensions::invocation::CallBudget,
    cancel: &tokio_util::sync::CancellationToken,
    now: &Timestamp,
) -> Result<Candidate, Error> {
    let branch = prepare_branch(tx, admission, candidate, task, selection).await?;
    super::propose(
        tx, admission, candidate, &branch, draft, budget, cancel, now,
    )
    .await
}

pub(crate) async fn prepare_branch(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    candidate: &Candidate,
    task: &TaskRef,
    selection: &CompileSelection,
) -> Result<WorldBranch, Error> {
    let branch = derive_branch(tx, candidate, task, selection).await?;
    let contract = crate::evaluation::read_task(tx, &task.id, task.revision).await?;
    admission.require_access(&authorization::actual_impact(
        vec![AccessScope {
            resources: vec![ResourceRef::Task {
                id: task.id.clone(),
            }],
            fields: Vec::new(),
            modes: vec![AccessMode::Read],
            scope: contract.scope,
            valid_time: None,
        }],
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )?)?;
    Ok(branch)
}

/// Admission derives the same canonical branch that the final transaction rechecks.
pub(crate) async fn derive_branch(
    tx: &WorldTransaction<'_>,
    candidate: &Candidate,
    task: &TaskRef,
    selection: &CompileSelection,
) -> Result<WorldBranch, Error> {
    if task.world != *tx.world()
        || candidate.world != task.world
        || candidate.change_set.status != ChangeStatus::Proposed
    {
        return Err(invalid(0, "task.compile"));
    }
    crate::evaluation::read_task(tx, &task.id, task.revision).await?;
    let (mut basis, _) = base_context(tx, &candidate.change_set.base_release).await?;
    let actual_compile = super::compile_selection(
        tx,
        &candidate.change_set.base_release,
        &candidate.change_set.operations,
        selection,
    )
    .await?;
    basis.overlay = candidate.change_set.operations.clone();
    let digest = canonical_digest(&(tx.world(), &candidate.id, "learning.branch"))?;
    let id = BranchId::try_new(format!("branch-{}", &digest.as_str()[7..]))
        .map_err(|_| invalid(0, "branch.id"))?;
    let revision = crate::releases::next_branch_revision(tx, &id).await?;
    Ok(WorldBranch {
        world: tx.world().clone(),
        id,
        revision,
        task_id: task.id.clone(),
        task_revision: task.revision,
        basis,
        compile: actual_compile,
        candidate_id: candidate.id.clone(),
        change_set_id: candidate.change_set.id.clone(),
        status: ChangeStatus::Proposed,
    })
}

/// The sealed release supplies configuration, graph, contracts and replay basis; never caller claims.
pub(crate) async fn base_context(
    tx: &WorldTransaction<'_>,
    id: &ReleaseId,
) -> Result<(BranchBasis, CompileRequest), Error> {
    let compile = crate::releases::read_compile_context(tx, id).await?;
    let base = crate::releases::read_release(tx, id)
        .await?
        .ok_or_else(|| ReleaseFailure::ReleaseMissing {
            release_id: id.clone(),
        })?;
    let historical = if let Some(reference) = &base.source_branch {
        Some(
            crate::releases::read_branch_revision(tx, reference)
                .await?
                .ok_or(LearningFailure::BasisChanged)?,
        )
    } else {
        None
    };
    let snapshots = historical
        .as_ref()
        .map_or_else(Vec::new, |branch| branch.basis.snapshots.clone());
    let mut missing_sources = Vec::new();
    for source in &base.sources {
        if source.gap.is_some()
            || source.guarantee == SourceGuarantee::Assumed
            || (source.snapshot.is_none() && source.guarantee != SourceGuarantee::RecordedReplay)
        {
            if !missing_sources.contains(&source.source_id) {
                missing_sources.push(source.source_id.clone());
            }
        }
    }
    let read_receipts = base.read_receipts;
    let replayability = if base.sources.is_empty() {
        Replayability::Complete
    } else if snapshots.is_empty() {
        Replayability::NotReplayable
    } else if !missing_sources.is_empty() {
        Replayability::Partial
    } else {
        historical
            .as_ref()
            .map_or(Replayability::Partial, |branch| branch.basis.replayability)
    };
    Ok((
        BranchBasis {
            release_id: base.id,
            activation_lock_id: compile.activation_lock.id.clone(),
            snapshots,
            read_receipts,
            sources: base.sources,
            overlay: Vec::new(),
            assumptions: Vec::new(),
            replayability,
            missing_sources,
        },
        compile,
    ))
}
