use super::Error;
use crate::{
    authorization::{self, Admission, VerifiedInvocation},
    definitions::canonical_digest,
    store::WorldTransaction,
};
use std::collections::{BTreeMap, BTreeSet};
use world_protocol::{
    authorization::{AccessMode, AccessScope},
    evaluation::{
        AcceptanceCriterion, CandidateVerdict, CaseExecution, EvaluationAssurance,
        EvaluationExecution, EvaluationReport, EvaluationRequest, Replayability,
    },
    ids::{Digest, EvaluationId, GrantEpoch, PolicyEpoch, ResourceRef},
    learning::TaskContract,
    releases::{ReleaseFailure, WorldBranch},
};

/// A caller's exact anchor selects its suite only; other suites must have one accepted report.
pub(crate) async fn select_accepted_evaluations(
    tx: &WorldTransaction<'_>,
    branch: &WorldBranch,
    task: &TaskContract,
    policy_epoch: PolicyEpoch,
    grant_epoch: GrantEpoch,
    anchor: Option<&EvaluationId>,
) -> Result<Vec<EvaluationId>, Error> {
    let digests = report_digests(branch)?;
    let mut accepted = BTreeMap::<_, Vec<EvaluationId>>::new();
    let mut anchored = false;
    for (request, report) in crate::evaluation::reports_for_branch(tx, branch).await? {
        let is_anchor = anchor == Some(&report.id);
        if !is_accepted_report(
            branch,
            task,
            &request,
            &report,
            (policy_epoch, grant_epoch),
            &digests,
        ) || crate::evaluation::read_suite(tx, &request.suite.id, request.suite.revision).await?
            != request.suite
        {
            if is_anchor {
                return Err(rejected(&report.id));
            }
            continue;
        }
        anchored |= is_anchor;
        accepted.entry(report.suite_id).or_default().push(report.id);
    }
    if let Some(anchor) = anchor {
        if !anchored {
            return Err(rejected(anchor));
        }
    }
    let missing: Vec<_> = task
        .required_suites
        .iter()
        .filter(|suite| !accepted.contains_key(*suite))
        .cloned()
        .collect();
    if accepted.is_empty() || !missing.is_empty() {
        return Err(ReleaseFailure::EvaluationRequired { suites: missing }.into());
    }
    accepted
        .into_values()
        .map(|ids| {
            if let Some(anchor) = anchor.filter(|anchor| ids.contains(anchor)) {
                Ok(anchor.clone())
            } else if ids.len() == 1 {
                Ok(ids[0].clone())
            } else {
                // No evaluation ID ordering is evidence of recency or authority.
                Err(rejected(&ids[0]))
            }
        })
        .collect()
}

/// Reports are read from the independent evaluator, never supplied by the publisher.
pub(crate) async fn check(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    branch: &WorldBranch,
    task: &TaskContract,
    evaluations: &[EvaluationId],
) -> Result<(), Error> {
    check_reports(tx, ReportAuthority::Admitted(admission), branch, task, evaluations).await
}

pub(crate) async fn check_read(
    tx: &WorldTransaction<'_>,
    verified: &VerifiedInvocation,
    branch: &WorldBranch,
    task: &TaskContract,
    evaluations: &[EvaluationId],
) -> Result<(), Error> {
    check_reports(tx, ReportAuthority::Read(verified), branch, task, evaluations).await
}

enum ReportAuthority<'a> {
    Admitted(&'a Admission),
    Read(&'a VerifiedInvocation),
}

async fn check_reports(
    tx: &WorldTransaction<'_>,
    authority: ReportAuthority<'_>,
    branch: &WorldBranch,
    task: &TaskContract,
    evaluations: &[EvaluationId],
) -> Result<(), Error> {
    let mut ids = BTreeSet::new();
    let mut suites = BTreeSet::new();
    let digests = report_digests(branch)?;
    for id in evaluations {
        if !ids.insert(id) {
            return Err(rejected(id));
        }
        let (request, report) = crate::evaluation::read_report_for_branch(tx, id, branch).await?;
        let frozen =
            crate::evaluation::read_suite(tx, &request.suite.id, request.suite.revision).await?;
        let impact = authorization::actual_impact(
            vec![AccessScope {
                resources: vec![
                    ResourceRef::Evaluation { id: id.clone() },
                    ResourceRef::Suite { id: frozen.id.clone() },
                ],
                fields: Vec::new(),
                modes: vec![AccessMode::Read],
                scope: task.scope.clone(),
                valid_time: None,
            }],
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
        )?;
        let epochs = match &authority {
            ReportAuthority::Admitted(admission) => (
                admission.decision().policy_epoch,
                admission.decision().grant_epoch,
            ),
            ReportAuthority::Read(verified) => {
                let decision = authorization::check_impact_read_decision(
                    tx, verified, &impact, &tx.now().await?,
                ).await?;
                (decision.policy_epoch, decision.grant_epoch)
            }
        };
        if request.id != *id
            || report.id != *id
            || request.suite != frozen
            || !suites.insert(frozen.id.clone())
            || !is_accepted_report(branch, task, &request, &report, epochs, &digests)
        {
            return Err(rejected(id));
        }
        if let ReportAuthority::Admitted(admission) = &authority {
            admission.require_access(&impact)?;
        }
    }
    let missing: Vec<_> = task
        .required_suites
        .iter()
        .filter(|suite| !suites.contains(*suite))
        .cloned()
        .collect();
    if evaluations.is_empty() || !missing.is_empty() {
        return Err(ReleaseFailure::EvaluationRequired { suites: missing }.into());
    }
    if let ReportAuthority::Admitted(admission) = authority {
        authorization::recheck(tx, admission, &tx.now().await?).await?;
    }
    Ok(())
}

fn report_digests(branch: &WorldBranch) -> Result<(Digest, Digest), Error> {
    Ok((
        canonical_digest(&branch.basis)?,
        crate::evaluation::data_digest(&branch.basis)?,
    ))
}

fn is_accepted_report(
    branch: &WorldBranch,
    task: &TaskContract,
    request: &EvaluationRequest,
    report: &EvaluationReport,
    epochs: (PolicyEpoch, GrantEpoch),
    digests: &(Digest, Digest),
) -> bool {
    let frozen = &request.suite;
    if request.world != branch.world
        || request.id != report.id
        || request.candidate_id != branch.candidate_id
        || request.branch_id != branch.id
        || request.basis != branch.basis
        || request.basis.replayability != Replayability::Complete
        || frozen.task_id != task.id
        || frozen.task_revision != task.revision
        || request.oracle != task.success_oracle
        || !task.required_suites.contains(&frozen.id)
        || frozen.conditions.tool_lock != branch.basis.activation_lock_id
        || frozen.conditions.data_digest != digests.1
        || frozen.conditions.policy_epoch != epochs.0
        || frozen.conditions.grant_epoch != epochs.1
        || report.world != branch.world
        || report.candidate_id != branch.candidate_id
        || report.suite_id != frozen.id
        || report.suite_revision != frozen.revision
        || report.basis_digest != digests.0
        || report.execution != EvaluationExecution::Completed
        || report.verdict != CandidateVerdict::Accepted
        || report.assurance != EvaluationAssurance::Tested
        || report.completed_at.is_none()
        || report.coverage.total != frozen.tests.len() as u64
        || report.coverage.tested != report.coverage.total
        || !report.coverage.missing_tests.is_empty()
        || !report.coverage.missing_sources.is_empty()
        || report.coverage.assumptions_used
        || frozen.tests.is_empty()
        || frozen.arms.is_empty()
    {
        return false;
    }
    let Some(expected_cases) = frozen.tests.len().checked_mul(frozen.arms.len()) else {
        return false;
    };
    if report.cases.len() != expected_cases
        || frozen.tests.iter().any(|test| {
            frozen.arms.iter().any(|arm| {
                report
                    .cases
                    .iter()
                    .filter(|case| {
                        &case.test == test
                            && &case.arm == arm
                            && case.oracle_passed.is_some()
                            && matches!(
                                case.execution,
                                CaseExecution::Completed | CaseExecution::BusinessFailed { .. }
                            )
                    })
                    .count()
                    != 1
            })
        })
    {
        return false;
    }
    frozen.acceptance.iter().all(|criterion| match criterion {
        AcceptanceCriterion::HardCheck { name } => {
            report
                .hard_checks
                .iter()
                .filter(|check| check.name == *name && check.passed)
                .count()
                >= frozen.tests.len()
        }
        _ => true,
    })
}

fn rejected(id: &EvaluationId) -> Error {
    ReleaseFailure::EvaluationRejected {
        evaluation_id: id.clone(),
    }
    .into()
}
