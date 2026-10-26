use super::{Error, PreparedArtifact, read_candidate, read_head, require_writer};
use crate::{
    authorization::{self, Admission},
    content::Content,
    extensions::invocation::CallBudget,
    sources::sync::VerifiedCandidateSources,
    store::WorldTransaction,
};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    authorization::{AccessMode, AccessScope},
    definitions::{Definition, DefinitionBody},
    evaluation::Replayability,
    failure::FieldPath,
    ids::{CandidateId, DefinitionRef, EvaluationId, ResourceRef, Revision, ScopeId},
    learning::ChangeStatus,
    releases::{BranchRef, Release, ReleaseFailure, ReleaseHeadCas},
};

/// The caller prepares bytes outside the transaction; all authoritative publication checks occur here.
pub(crate) async fn publish(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    content: &Content,
    prepared: &PreparedArtifact,
    sources: &VerifiedCandidateSources,
    candidate_id: &CandidateId,
    expected_branch: Revision,
    expected_change: Revision,
    head: &ReleaseHeadCas,
    evaluations: &[EvaluationId],
    budget: &CallBudget,
    cancellation: &CancellationToken,
) -> Result<Release, Error> {
    require_writer(tx)?;
    cancelled(cancellation)?;
    crate::learning::lock_candidate(tx, candidate_id).await?;
    let (branch, candidate) = read_candidate(tx, candidate_id)
        .await?
        .ok_or_else(|| invalid("candidate"))?;
    if branch.revision != expected_branch {
        return Err(ReleaseFailure::BranchConflict {
            branch_id: branch.id,
            expected: expected_branch,
            actual: branch.revision,
            fields: vec![FieldPath(vec!["revision".into()])],
        }
        .into());
    }
    if branch.status != ChangeStatus::Ready
        || candidate.change_set.revision != expected_change
        || candidate.change_set.status != ChangeStatus::Ready
        || prepared.request() != &branch.compile
        || head.world != *tx.world()
        || head.next != prepared.manifest().release_id
        || head
            .expected
            .as_ref()
            .is_none_or(|head| head.release_id != branch.basis.release_id)
        || branch.basis.replayability != Replayability::Complete
        || !branch.basis.assumptions.is_empty()
        || !branch.basis.missing_sources.is_empty()
    {
        return Err(invalid("branch"));
    }
    let task = crate::evaluation::read_task(tx, &branch.task_id, branch.task_revision).await?;
    authorize(
        tx,
        admission,
        &task.scope,
        &branch.compile.definitions,
        &branch.basis.sources,
        head,
        Some(ResourceRef::Branch {
            id: branch.id.clone(),
        }),
    )
    .await?;
    require_head(tx, head).await?;
    super::acceptance::check(tx, admission, &branch, &task, evaluations).await?;
    crate::learning::recheck_model_calls(tx, admission, &candidate).await?;
    let now = tx.now().await?;
    super::basis::recheck(tx, admission, &branch, budget, cancellation, &now).await?;
    let affected = super::source_bindings(&branch.compile.definitions);
    require_sources(tx, admission, &branch, &affected, budget, cancellation).await?;
    cancelled(cancellation)?;
    let base = super::read_release(tx, &branch.basis.release_id)
        .await?
        .ok_or_else(|| ReleaseFailure::ReleaseMissing {
            release_id: branch.basis.release_id.clone(),
        })?;
    let changed: Vec<_> = branch
        .compile
        .definitions
        .iter()
        .filter(|definition| !base.definitions.contains(definition))
        .cloned()
        .collect();
    crate::definitions::KindRegistry::recheck(
        tx, admission, &branch.compile, prepared.kinds(),
    ).await?;
    if !changed.is_empty() {
        crate::definitions::apply_definitions_checked(tx, admission, &changed, prepared.kinds()).await?;
    }
    let artifact = super::artifact::persist_artifact(tx, content, prepared).await?;
    let release = Release {
        world: tx.world().clone(),
        id: artifact.release_id.clone(),
        parent: Some(branch.basis.release_id.clone()),
        source_branch: Some(BranchRef {
            world: branch.world.clone(),
            id: branch.id.clone(),
            revision: branch.revision,
        }),
        artifact,
        definitions: branch.compile.definitions.clone(),
        scopes: branch.compile.scopes.clone(),
        basis: super::basis::dependencies(&branch.basis),
        sources: branch.basis.sources.clone(),
        read_receipts: branch.basis.read_receipts.clone(),
        evaluations: evaluations.to_vec(),
        published_at: now.clone(),
    };
    super::persist::insert_release(tx, content, prepared, &release).await?;
    crate::sources::sync::promote_candidate_sources(
        tx,
        content,
        admission,
        sources,
        &release.id,
        budget,
        cancellation,
    )
    .await?;
    let mut published = branch.clone();
    published.revision = super::next_branch_revision(tx, &branch.id).await?;
    published.status = ChangeStatus::Published;
    super::update_branch(
        tx,
        admission,
        branch.revision,
        &published,
        budget,
        cancellation,
        &now,
    )
    .await?;
    crate::learning::complete_publication(
        tx,
        admission,
        candidate_id,
        expected_change,
        &release.id,
        &now,
    )
    .await?;
    cancelled(cancellation)?;
    authorization::recheck(tx, admission, &tx.now().await?).await?;
    super::persist::switch_head(tx, head).await?;
    Ok(release)
}

pub(super) async fn authorize(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    scope: &ScopeId,
    definitions: &[Definition<DefinitionBody>],
    sources: &[world_protocol::sources::SourceBasis],
    head: &ReleaseHeadCas,
    branch: Option<ResourceRef>,
) -> Result<(), Error> {
    let mut resources = vec![ResourceRef::Head {
        channel: head.channel.clone(),
    }];
    resources.extend(branch);
    let access = vec![AccessScope {
        resources,
        fields: Vec::new(),
        modes: vec![AccessMode::Publish],
        scope: scope.clone(),
        valid_time: None,
    }];
    let model = super::model_impact(
        tx,
        definitions,
        access,
        &[AccessMode::Read, AccessMode::Publish],
    )
    .await?;
    let impact = authorization::actual_impact(
        model.access,
        model.effects,
        model.labels,
        model.state,
        model
            .source_ids
            .into_iter()
            .chain(sources.iter().map(|source| source.source_id.clone()))
            .collect(),
    )?;
    admission.require_access(&impact)?;
    authorization::recheck(tx, admission, &tx.now().await?).await?;
    Ok(())
}

pub(super) async fn require_head(
    tx: &WorldTransaction<'_>,
    cas: &ReleaseHeadCas,
) -> Result<(), Error> {
    let actual = read_head(tx, &cas.channel).await?;
    if actual != cas.expected {
        return Err(ReleaseFailure::HeadConflict {
            channel: cas.channel.clone(),
            expected: cas.expected.clone(),
            actual,
        }
        .into());
    }
    Ok(())
}

async fn require_sources(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    branch: &world_protocol::releases::WorldBranch,
    affected: &[DefinitionRef],
    budget: &CallBudget,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    crate::sources::sync::require_candidate_ready(
        tx,
        admission,
        &BranchRef {
            world: branch.world.clone(),
            id: branch.id.clone(),
            revision: branch.revision,
        },
        affected,
        budget,
        cancellation,
    )
    .await?;
    let captures =
        crate::sources::sync::read_branch_sources(tx, admission, branch, budget, cancellation)
            .await?;
    let canonical: Vec<_> = branch
        .basis
        .sources
        .iter()
        .filter(|source| {
            !captures
                .iter()
                .any(|capture| &capture.capture().basis == *source)
        })
        .cloned()
        .collect();
    crate::sources::sync::require_release_ready(tx, &canonical).await?;
    Ok(())
}

pub(super) fn cancelled(cancellation: &CancellationToken) -> Result<(), Error> {
    if cancellation.is_cancelled() {
        Err(ReleaseFailure::Cancelled.into())
    } else {
        Ok(())
    }
}
pub(super) fn invalid(field: &str) -> Error {
    ReleaseFailure::InvalidBranch {
        field: FieldPath(vec![field.into()]),
    }
    .into()
}
