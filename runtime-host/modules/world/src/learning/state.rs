use super::{
    Error, invalid, metadata,
    proposal::{emit, lock, next_change_revision, write_candidate, write_change},
    require_writer,
};
use crate::{
    authorization::{self, Admission},
    definitions::canonical_digest,
    store::WorldTransaction,
};
use std::collections::{BTreeMap, BTreeSet};
use world_protocol::{
    authorization::{AccessMode, AccessScope},
    evaluation::{
        CandidateVerdict, EvaluationAssurance, EvaluationExecution, EvaluationRequest,
        Replayability,
    },
    ids::{CandidateId, EvaluationId, ResourceRef, Revision},
    learning::{Candidate, ChangeStatus, LearningFailure, SemanticOperation},
    releases::WorldBranch,
    time::Timestamp,
};

pub(crate) async fn prepare_validation(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    id: &CandidateId,
    expected: Revision,
    now: &Timestamp,
) -> Result<(WorldBranch, Vec<world_protocol::ids::DefinitionRef>), Error> {
    let (branch, candidate) = current(tx, admission, id, expected, now).await?;
    if candidate.change_set.status != ChangeStatus::Proposed {
        return Err(invalid(0, "status"));
    }
    recheck_support(tx, admission, &candidate, &branch, now).await?;
    let bindings = affected_source_bindings(tx, &branch).await?;
    Ok((branch, bindings))
}

pub(crate) async fn affected_source_bindings(
    tx: &WorldTransaction<'_>,
    branch: &WorldBranch,
) -> Result<Vec<world_protocol::ids::DefinitionRef>, Error> {
    if branch.world != *tx.world() {
        return Err(LearningFailure::BasisChanged.into());
    }
    crate::compiler::validate_structure(&branch.compile)?;
    Ok(crate::releases::source_bindings(
        &branch.compile.definitions,
    ))
}

pub(crate) async fn validate_change(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    id: &CandidateId,
    expected: Revision,
    frozen: &WorldBranch,
    budget: &crate::extensions::invocation::CallBudget,
    cancel: &tokio_util::sync::CancellationToken,
    now: &Timestamp,
) -> Result<Candidate, Error> {
    let (branch, candidate) = current(tx, admission, id, expected, now).await?;
    if branch != *frozen {
        return Err(LearningFailure::BasisChanged.into());
    }
    if candidate.change_set.status != ChangeStatus::Proposed {
        return Err(invalid(0, "status"));
    }
    recheck_support(tx, admission, &candidate, &branch, now).await?;
    advance(
        tx,
        admission,
        candidate,
        branch,
        ChangeStatus::Validated,
        budget,
        cancel,
        now,
    )
    .await
}

/// A frozen evaluation request, not a learner claim, determines which candidate is testing.
pub(crate) async fn begin_testing(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    request: &EvaluationRequest,
    budget: &crate::extensions::invocation::CallBudget,
    cancel: &tokio_util::sync::CancellationToken,
    now: &Timestamp,
) -> Result<Candidate, Error> {
    require_writer(tx)?;
    lock(tx, &request.candidate_id).await?;
    let (_, candidate) = crate::releases::read_candidate(tx, &request.candidate_id)
        .await?
        .ok_or_else(|| invalid(0, "candidate.id"))?;
    let (branch, candidate) = current(
        tx,
        admission,
        &request.candidate_id,
        candidate.change_set.revision,
        now,
    )
    .await?;
    if request.world != branch.world
        || request.branch_id != branch.id
        || request.basis != branch.basis
        || branch.basis.activation_lock_id != branch.compile.activation_lock.id
        || request.suite.task_id != branch.task_id
        || request.suite.task_revision != branch.task_revision
    {
        return Err(LearningFailure::BasisChanged.into());
    }
    if candidate.change_set.status == ChangeStatus::Testing {
        return Ok(candidate);
    }
    if candidate.change_set.status != ChangeStatus::Validated {
        return Err(invalid(0, "status"));
    }
    recheck_support(tx, admission, &candidate, &branch, now).await?;
    advance(
        tx,
        admission,
        candidate,
        branch,
        ChangeStatus::Testing,
        budget,
        cancel,
        now,
    )
    .await
}

pub(crate) async fn conclude_available_evaluations(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    id: &CandidateId,
    owned_evaluation: &EvaluationId,
    budget: &crate::extensions::invocation::CallBudget,
    cancel: &tokio_util::sync::CancellationToken,
    now: &Timestamp,
) -> Result<Candidate, Error> {
    lock(tx, id).await?;
    let (_, candidate) = crate::releases::read_candidate(tx, id)
        .await?
        .ok_or(LearningFailure::BasisChanged)?;
    let (branch, candidate) =
        current(tx, admission, id, candidate.change_set.revision, now).await?;
    if matches!(
        candidate.change_set.status,
        ChangeStatus::Ready | ChangeStatus::Rejected
    ) {
        return Ok(candidate);
    }
    if candidate.change_set.status != ChangeStatus::Testing {
        return Err(invalid(0, "status"));
    }
    let task = crate::evaluation::read_task(tx, &branch.task_id, branch.task_revision).await?;
    let mut rejected = None;
    for (request, report) in crate::evaluation::reports_for_branch(tx, &branch).await? {
        if cancel.is_cancelled() {
            return Err(crate::evaluation::Error::from(
                world_protocol::evaluation::EvaluationFailure::Cancelled,
            )
            .into());
        }
        budget
            .charge(world_protocol::budget::BudgetDimension::Rows, 1)
            .map_err(|error| {
                crate::evaluation::Error::from(
                    world_protocol::evaluation::EvaluationFailure::BudgetExhausted {
                        dimension: error.dimension,
                    },
                )
            })?;
        if !task.required_suites.contains(&report.suite_id)
            || request.suite.conditions.policy_epoch != admission.decision().policy_epoch
            || request.suite.conditions.grant_epoch != admission.decision().grant_epoch
            || report.execution != EvaluationExecution::Completed
            || report.assurance != EvaluationAssurance::Tested
        {
            continue;
        }
        if report.verdict == CandidateVerdict::Rejected {
            rejected = Some(report.id);
            break;
        }
    }
    let evaluations = match rejected {
        Some(id) => vec![id],
        None => match crate::releases::select_accepted_evaluations(
            tx,
            &branch,
            &task,
            admission.decision().policy_epoch,
            admission.decision().grant_epoch,
            None,
        )
        .await
        {
            Ok(evaluations) => evaluations,
            Err(crate::releases::Error::Rejected(
                world_protocol::releases::ReleaseFailure::EvaluationRequired { .. },
            )) => return Ok(candidate),
            Err(error) => return Err(error.into()),
        },
    };
    conclude_evaluation(
        tx,
        admission,
        id,
        candidate.change_set.revision,
        &evaluations,
        owned_evaluation,
        budget,
        cancel,
        now,
    )
    .await
}

/// Only durable independent reports can promote a candidate; execution failure leaves it Testing.
pub(crate) async fn conclude_evaluation(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    id: &CandidateId,
    expected: Revision,
    evaluations: &[EvaluationId],
    owned_evaluation: &EvaluationId,
    budget: &crate::extensions::invocation::CallBudget,
    cancel: &tokio_util::sync::CancellationToken,
    now: &Timestamp,
) -> Result<Candidate, Error> {
    let (branch, candidate) = current(tx, admission, id, expected, now).await?;
    if candidate.change_set.status != ChangeStatus::Testing {
        return Err(invalid(0, "status"));
    }
    let task = crate::evaluation::read_task(tx, &branch.task_id, branch.task_revision).await?;
    if evaluations.is_empty()
        || evaluations.iter().collect::<BTreeSet<_>>().len() != evaluations.len()
    {
        return Err(LearningFailure::EvaluationRequired {
            suites: task.required_suites,
        }
        .into());
    }
    let mut passed = BTreeMap::new();
    let mut rejected = false;
    for evaluation in evaluations {
        let (request, report) =
            crate::evaluation::read_report_for_branch(tx, evaluation, &branch).await?;
        if crate::evaluation::read_suite(tx, &request.suite.id, request.suite.revision).await?
            != request.suite
        {
            return Err(LearningFailure::BasisChanged.into());
        }
        if request.world != branch.world
            || request.candidate_id != *id
            || request.branch_id != branch.id
            || request.basis != branch.basis
            || branch.basis.activation_lock_id != branch.compile.activation_lock.id
            || request.suite.task_id != branch.task_id
            || request.suite.task_revision != branch.task_revision
            || request.suite.conditions.policy_epoch != admission.decision().policy_epoch
            || request.suite.conditions.grant_epoch != admission.decision().grant_epoch
            || report.basis_digest != canonical_digest(&branch.basis)?
        {
            return Err(LearningFailure::BasisChanged.into());
        }
        if evaluation == owned_evaluation {
            let impact = crate::evaluation::owner_report_impact(tx, admission.verified(), evaluation).await?;
            let output = authorization::admit(tx, admission.verified(), &impact, &[], None, now).await?;
            authorization::check_admitted_output(tx, &output, &impact, 1, now).await?;
        } else {
            admission.require_access(&crate::evaluation::report_impact(tx, evaluation, false).await?)?;
        }
        admission.require_access(&authorization::actual_impact(
            vec![AccessScope {
                resources: vec![ResourceRef::Suite {
                    id: request.suite.id.clone(),
                }],
                fields: Vec::new(),
                modes: vec![AccessMode::Read],
                scope: task.scope.clone(),
                valid_time: None,
            }],
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
        )?)?;
        if !matches!(report.execution, EvaluationExecution::Completed)
            || report.assurance != EvaluationAssurance::Tested
        {
            return Err(LearningFailure::EvaluationRequired {
                suites: task.required_suites,
            }
            .into());
        }
        match report.verdict {
            CandidateVerdict::Rejected => rejected = true,
            CandidateVerdict::Accepted
                if request.basis.replayability == Replayability::Complete
                    && report.coverage.missing_tests.is_empty()
                    && report.coverage.missing_sources.is_empty()
                    && report.coverage.tested == report.coverage.total =>
            {
                if passed
                    .insert(report.suite_id, report.suite_revision)
                    .is_some()
                {
                    return Err(invalid(0, "evaluations.suite"));
                }
            }
            _ => {
                return Err(LearningFailure::EvaluationRequired {
                    suites: task.required_suites,
                }
                .into());
            }
        }
    }
    if !rejected
        && task
            .required_suites
            .iter()
            .any(|suite| !passed.contains_key(suite))
    {
        return Err(LearningFailure::EvaluationRequired {
            suites: task.required_suites,
        }
        .into());
    }
    recheck_support(tx, admission, &candidate, &branch, now).await?;
    advance(
        tx,
        admission,
        candidate,
        branch,
        if rejected {
            ChangeStatus::Rejected
        } else {
            ChangeStatus::Ready
        },
        budget,
        cancel,
        now,
    )
    .await
}

pub(super) async fn current(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    id: &CandidateId,
    expected: Revision,
    now: &Timestamp,
) -> Result<(WorldBranch, Candidate), Error> {
    require_writer(tx)?;
    lock(tx, id).await?;
    let (branch, candidate) = crate::releases::read_candidate(tx, id)
        .await?
        .ok_or_else(|| invalid(0, "candidate.id"))?;
    if candidate.change_set.revision != expected {
        return Err(LearningFailure::BasisChanged.into());
    }
    let task = crate::evaluation::read_task(tx, &branch.task_id, branch.task_revision).await?;
    let impact = authorization::actual_impact(
        vec![AccessScope {
            resources: vec![ResourceRef::ChangeSet {
                id: candidate.change_set.id.clone(),
            }],
            fields: Vec::new(),
            modes: vec![AccessMode::Write],
            scope: task.scope,
            valid_time: None,
        }],
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )?;
    admission.require_access(&impact)?;
    admission.require_access(
        &super::candidate_impact(tx, &candidate, &branch, AccessMode::Write).await?,
    )?;
    authorization::recheck(tx, admission, &tx.now().await?).await?;
    super::provenance::recheck(tx, admission, &candidate).await?;
    Ok((branch, candidate))
}

pub(super) async fn recheck_support(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    candidate: &Candidate,
    branch: &WorldBranch,
    now: &Timestamp,
) -> Result<(), Error> {
    let task = crate::evaluation::read_task(tx, &branch.task_id, branch.task_revision).await?;
    let mut evidence: BTreeSet<_> = candidate.change_set.evidence.iter().cloned().collect();
    if evidence.len() != candidate.change_set.evidence.len() {
        return Err(invalid(0, "evidence"));
    }
    for operation in &candidate.change_set.operations {
        match operation {
            SemanticOperation::AttachEvidence { evidence: refs, .. }
            | SemanticOperation::MergeAliases { evidence: refs, .. } => {
                evidence.extend(refs.iter().cloned())
            }
            SemanticOperation::CreateDefinition { definition } => {
                evidence.extend(definition.evidence.iter().cloned())
            }
            SemanticOperation::RefineDefinition { replacement, .. }
            | SemanticOperation::SupersedeRule { replacement, .. } => {
                evidence.extend(replacement.evidence.iter().cloned())
            }
            SemanticOperation::SplitDefinition { replacements, .. } => {
                for replacement in replacements {
                    evidence.extend(replacement.evidence.iter().cloned());
                }
            }
            _ => {}
        }
    }
    let actual = crate::facts::assertions::require_evidence(
        tx,
        admission,
        &evidence.into_iter().collect::<Vec<_>>(),
        &task.scope,
        None,
        now,
    )
    .await?;
    if candidate
        .evidence
        .iter()
        .map(|item| &item.reference)
        .collect::<BTreeSet<_>>()
        .len()
        != candidate.evidence.len()
        || candidate.evidence.iter().any(|item| !actual.contains(item))
    {
        return Err(invalid(0, "candidate.evidence"));
    }
    if candidate
        .change_set
        .cases
        .iter()
        .collect::<BTreeSet<_>>()
        .len()
        != candidate.change_set.cases.len()
    {
        return Err(invalid(0, "cases"));
    }
    for id in &super::impact::case_refs(candidate) {
        let case = crate::evaluation::training_case(tx, admission, id, now).await?;
        if case.task_id != task.id || case.task_revision != task.revision {
            return Err(invalid(0, "cases.task"));
        }
    }
    Ok(())
}

pub(super) async fn advance(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    mut candidate: Candidate,
    mut branch: WorldBranch,
    next: ChangeStatus,
    budget: &crate::extensions::invocation::CallBudget,
    cancel: &tokio_util::sync::CancellationToken,
    now: &Timestamp,
) -> Result<Candidate, Error> {
    let expected = candidate.change_set.revision;
    candidate.change_set.revision = next_change_revision(tx, &candidate.change_set.id).await?;
    candidate.change_set.status = next;
    let branch_expected = branch.revision;
    branch.revision = crate::releases::next_branch_revision(tx, &branch.id).await?;
    branch.status = next;
    let branch = crate::releases::update_branch(tx, admission, branch_expected, &branch, budget, cancel, now)
        .await?;
    write_change(tx, admission, &candidate, &branch).await?;
    write_candidate(tx, &candidate, &branch, Some(expected)).await?;
    metadata::materialize(tx, admission, &branch, now).await?;
    emit(tx, &candidate).await?;
    Ok(candidate)
}
