use std::collections::BTreeSet;

use crate::{
    authorization::{Admission, actual_impact, check_admitted_output},
    store::WorldTransaction,
};
use world_protocol::{
    authorization::{AccessMode, AccessScope},
    evaluation::{
        EvaluationExecution, EvaluationReport, EvaluationSummary, EvaluationSummaryExecution,
    },
    ids::{EvaluationId, ResourceRef},
    time::Timestamp,
};

use super::{Error, records, run};

/// Full reports remain available to explicitly authorized suite/evaluation managers.
/// Candidate execution must use its own limited principal, not a manager's admission.
pub(crate) async fn full_report(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    id: &EvaluationId,
    now: &Timestamp,
) -> Result<EvaluationReport, Error> {
    let (request, report) = run::read_report(tx, id).await?;
    let impact = derived_impact(tx, &request, &report, true, ResourceRef::Evaluation { id: id.clone() }).await?;
    check_admitted_output(tx, admission, &impact, report.cases.len() as u64, now).await?;
    Ok(report)
}

/// Ordinary agent context receives no per-case holdout feedback or oracle diagnostics.
pub(crate) async fn summary(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    id: &EvaluationId,
    now: &Timestamp,
) -> Result<EvaluationSummary, Error> {
    let (_, report) = run::read_report(tx, id).await?;
    let impact = owner_report_impact(tx, admission.verified(), id).await?;
    check_admitted_output(tx, admission, &impact, 1, now).await?;
    Ok(EvaluationSummary {
        world: report.world,
        id: report.id,
        candidate_id: report.candidate_id,
        suite_id: report.suite_id,
        suite_revision: report.suite_revision,
        execution: match report.execution {
            EvaluationExecution::Running => EvaluationSummaryExecution::Running,
            EvaluationExecution::Completed => EvaluationSummaryExecution::Completed,
            EvaluationExecution::Cancelled => EvaluationSummaryExecution::Cancelled,
            EvaluationExecution::Failed { .. } => EvaluationSummaryExecution::Failed,
        },
        verdict: report.verdict,
        assurance: report.assurance,
        usage: report.usage,
        completed_at: report.completed_at,
    })
}

pub(crate) async fn owner_report_impact(
    tx: &WorldTransaction<'_>,
    verified: &crate::authorization::VerifiedInvocation,
    id: &EvaluationId,
) -> Result<world_protocol::authorization::ActualImpact, Error> {
    let state = run::require_owner_report(tx, verified, id).await?;
    derived_impact(tx, &state.request, &state.report, false, ResourceRef::Branch {
        id: state.request.branch_id.clone(),
    }).await
}

pub(crate) async fn owner_request_impact(
    tx: &WorldTransaction<'_>,
    verified: &crate::authorization::VerifiedInvocation,
    request: &world_protocol::evaluation::EvaluationRequest,
    operation: &world_protocol::ids::OperationId,
) -> Result<world_protocol::authorization::ActualImpact, Error> {
    run::require_owner_request(tx, verified, request, operation).await?;
    request_basis_impact(tx, request, false, ResourceRef::Branch {
        id: request.branch_id.clone(),
    }).await
}

pub(super) async fn creation_impact(
    tx: &WorldTransaction<'_>,
    request: &world_protocol::evaluation::EvaluationRequest,
) -> Result<world_protocol::authorization::ActualImpact, Error> {
    request_basis_impact(tx, request, false, ResourceRef::Suite {
        id: request.suite.id.clone(),
    }).await
}

/// Internal impact derivation after the caller has admitted the operation read.
/// A not-yet-started operation still discloses only its frozen, durable suite basis.
pub(crate) async fn request_impact(
    tx: &WorldTransaction<'_>,
    request: &world_protocol::evaluation::EvaluationRequest,
    full: bool,
) -> Result<world_protocol::authorization::ActualImpact, Error> {
    request_basis_impact(tx, request, full, ResourceRef::Evaluation {
        id: request.id.clone(),
    }).await
}

async fn request_basis_impact(
    tx: &WorldTransaction<'_>,
    request: &world_protocol::evaluation::EvaluationRequest,
    full: bool,
    resource: ResourceRef,
) -> Result<world_protocol::authorization::ActualImpact, Error> {
    if request.world != *tx.world() {
        return Err(super::ConstraintFailure::CrossWorld.into());
    }
    let frozen = records::suite(tx, &request.suite.id, request.suite.revision).await?;
    let task = records::task(tx, &frozen.task_id, frozen.task_revision).await?;
    let mut access = vec![AccessScope {
        resources: vec![resource],
        fields: Vec::new(),
        modes: vec![if full {
            AccessMode::Manage
        } else {
            AccessMode::Read
        }],
        scope: task.scope.clone(),
        valid_time: None,
    }];
    if full {
        access.push(AccessScope {
            resources: vec![ResourceRef::Suite {
                id: frozen.id.clone(),
            }],
            fields: Vec::new(),
            modes: vec![AccessMode::Manage],
            scope: task.scope.clone(),
            valid_time: None,
        });
    }
    let mut labels = BTreeSet::new();
    let mut sources = BTreeSet::new();
    let mut evidence = BTreeSet::new();
    for test in records::tests(tx, &frozen.tests).await? {
        evidence.extend(test.evidence);
    }
    for reference in evidence {
        let item = crate::facts::assertions::read_evidence(tx, &reference)
            .await
            .map_err(Error::Fact)?
            .ok_or(world_protocol::evaluation::EvaluationFailure::OracleUnavailable)?;
        let version =
            crate::content::read_source_version_in_transaction(tx, &item.locator.source_version)
                .await?;
        let material = crate::authorization::material_read_impact(tx, &version).await?;
        labels.extend(item.access.labels);
        labels.extend(material.labels);
        sources.extend(material.source_ids);
        if full {
            access.extend(material.access);
        }
        if full {
            access.push(AccessScope {
                resources: vec![ResourceRef::Evidence { id: reference.id }],
                fields: Vec::new(),
                modes: vec![AccessMode::Read],
                scope: task.scope.clone(),
                valid_time: None,
            });
        }
    }
    Ok(actual_impact(
        access,
        Vec::new(),
        labels.into_iter().collect(),
        Vec::new(),
        sources.into_iter().collect(),
    )?)
}

/// Redact oracle/test/source payloads, not the stable failure identity or commit recovery.
pub(crate) fn summary_failure(
    failure: &world_protocol::failure::Failure<world_protocol::operation::OperationFailure>,
) -> world_protocol::failure::Failure<world_protocol::operation::OperationFailure> {
    use world_protocol::{
        evaluation::{EvaluationFailure as Full, EvaluationSummaryFailure as Safe},
        operation::OperationFailure,
    };
    let mut projected = failure.clone();
    let OperationFailure::Evaluation(reason) = &failure.details else {
        let commit = match &failure.details {
            OperationFailure::Commit(reason) => Some(reason),
            OperationFailure::Source(world_protocol::sources::SourceFailure::Commit {
                failure,
            })
            | OperationFailure::Fact(world_protocol::facts::FactFailure::Commit { failure }) => {
                Some(failure)
            }
            _ => None,
        };
        if let Some(reason) = commit {
            let safe = crate::store::StoreError::new(reason.clone(), failure.stage).safe_failure();
            projected.code = safe.code;
            projected.details = commit_details(reason);
        } else {
            projected.code = match &failure.details {
                OperationFailure::Authorization(_) => "world.authorization_denied",
                OperationFailure::Source(reason) => source_failure_code(reason),
                OperationFailure::Input(_) => "world.evaluation_invalid_input",
                OperationFailure::Query(_) => "world.query_failed",
                OperationFailure::Slot(_) => "world.slot_failed",
                OperationFailure::NotConfigured => "world.not_configured",
                OperationFailure::NotFound => "world.not_found",
                OperationFailure::RevisionConflict => "world.revision_conflict",
                OperationFailure::Upload(_) => "world.upload_failed",
                OperationFailure::Material(_) => "world.content_failed",
                OperationFailure::Mapping(_) => "world.mapping_failed",
                OperationFailure::Identity(_) => "world.identity_failed",
                OperationFailure::Fact(_) => "world.fact_failed",
                OperationFailure::Definition(_) => "world.definition_rejected",
                OperationFailure::Release(_) => "world.release_failed",
                OperationFailure::Compile(_) => "world.evaluation_compile_failed",
                OperationFailure::Learning(_) => "world.learning_rejected",
                OperationFailure::Generation(_) => "world.generation_failed",
                OperationFailure::BudgetExceeded { .. } => "world.budget_exhausted",
                OperationFailure::Action(_) => "world.action_failed",
                OperationFailure::Package(_) => "world.package_failed",
                OperationFailure::Binding(_) => "world.binding_failed",
                OperationFailure::State(_) => "world.state_failed",
                OperationFailure::Lifecycle(_) => "world.lifecycle_failed",
                OperationFailure::Process(_) => "world.process_failed",
                OperationFailure::Cancelled => "world.operation_cancelled",
                OperationFailure::CleanupFailed => "world.cleanup_failed",
                OperationFailure::InternalFault => "world.internal_fault",
                OperationFailure::EvaluationSummary(_) => "world.evaluation_failed",
                OperationFailure::DetailsWithheld => "world.failure_details_withheld",
                OperationFailure::Evaluation(_) | OperationFailure::Commit(_) => {
                    unreachable!("handled separately")
                }
            }
            .into();
            projected.details = OperationFailure::DetailsWithheld;
        }
        projected.message = "操作未完成；详情受当前披露权限限制，可通过诊断编号查询。".into();
        projected.recovery = summary_recovery(&failure.recovery);
        return projected;
    };
    projected.details = match reason {
        Full::Commit { failure } => commit_details(failure),
        reason => OperationFailure::EvaluationSummary(match reason {
            Full::BadCase { .. } => Safe::BadCase,
            Full::OracleUnavailable => Safe::OracleUnavailable,
            Full::SchemaMismatch { .. } => Safe::SchemaMismatch,
            Full::SourceMissing { .. } => Safe::SourceMissing,
            Full::BasisChanged => Safe::BasisChanged,
            Full::EpochChanged => Safe::EpochChanged,
            Full::BudgetExhausted { dimension } => Safe::BudgetExhausted {
                dimension: *dimension,
            },
            Full::Cancelled => Safe::Cancelled,
            Full::ExecutionFailed => Safe::ExecutionFailed,
            Full::InternalFault => Safe::InternalFault,
            Full::Commit { .. } => unreachable!("commit handled above"),
        }),
    };
    projected.code = match reason {
        Full::BadCase { .. } => "world.evaluation_bad_case",
        Full::OracleUnavailable => "world.evaluation_oracle_unavailable",
        Full::SchemaMismatch { .. } => "world.evaluation_schema_mismatch",
        Full::SourceMissing { .. } => "world.evaluation_source_missing",
        Full::BasisChanged => "world.evaluation_basis_changed",
        Full::EpochChanged => "world.evaluation_epoch_changed",
        Full::BudgetExhausted { .. } => "world.evaluation_budget_exhausted",
        Full::Cancelled => "world.evaluation_cancelled",
        Full::ExecutionFailed => "world.evaluation_execution_failed",
        Full::InternalFault => "world.evaluation_internal_fault",
        Full::Commit { .. } => "world.commit_failed",
    }
    .into();
    projected.message = "评测未完成；可通过诊断编号查看授权详情。".into();
    if let Full::Commit { failure } = reason {
        projected.code = crate::store::StoreError::new(failure.clone(), projected.stage)
            .safe_failure()
            .code;
    }
    projected.recovery = summary_recovery(&projected.recovery);
    projected
}

fn summary_recovery(
    recovery: &world_protocol::failure::Recovery,
) -> world_protocol::failure::Recovery {
    use world_protocol::failure::Recovery;
    match recovery {
        Recovery::RestoreCredential { .. } => Recovery::RestoreCredential { source_id: None },
        Recovery::RequestEvidence { .. } => Recovery::RequestEvidence {
            evidence: Vec::new(),
        },
        Recovery::CorrectInput { .. } => Recovery::CorrectInput { fields: Vec::new() },
        recovery => recovery.clone(),
    }
}

fn commit_details(
    reason: &world_protocol::commit::CommitFailure,
) -> world_protocol::operation::OperationFailure {
    use world_protocol::{commit::CommitFailure, operation::OperationFailure};
    match reason {
        CommitFailure::ReadDependencyChanged { .. } | CommitFailure::RevisionConflict { .. } => {
            OperationFailure::DetailsWithheld
        }
        reason => OperationFailure::Commit(reason.clone()),
    }
}

fn source_failure_code(reason: &world_protocol::sources::SourceFailure) -> &'static str {
    use world_protocol::sources::SourceFailure;
    match reason {
        SourceFailure::Authorization { .. } => "world.authorization_denied",
        SourceFailure::Authentication => "world.source_authentication",
        SourceFailure::PermissionDenied => "world.source_permission_denied",
        SourceFailure::Credential { .. } => "world.source_credential",
        SourceFailure::Connection => "world.source_connection",
        SourceFailure::ConnectTimeout => "world.source_connect_timeout",
        SourceFailure::ReadTimeout => "world.source_read_timeout",
        SourceFailure::RateLimited { .. } => "world.source_rate_limited",
        SourceFailure::ServiceUnavailable => "world.source_service_unavailable",
        SourceFailure::HistoryUnavailable => "world.source_history_unavailable",
        SourceFailure::BudgetExceeded { .. } => "world.source_budget_exhausted",
        SourceFailure::ConcurrentCallLimit => "world.source_concurrent_call_limit",
        SourceFailure::EffectIndeterminate { .. } => "world.source_effect_indeterminate",
        SourceFailure::Cancelled => "world.source_cancelled",
        SourceFailure::Cleanup { .. } => "world.source_cleanup_failed",
        _ => "world.source_failed",
    }
}

pub(crate) async fn report_impact(
    tx: &WorldTransaction<'_>,
    id: &EvaluationId,
    full: bool,
) -> Result<world_protocol::authorization::ActualImpact, Error> {
    let (request, report) = run::read_report(tx, id).await?;
    derived_impact(tx, &request, &report, full, ResourceRef::Evaluation { id: id.clone() }).await
}

async fn derived_impact(
    tx: &WorldTransaction<'_>,
    request: &world_protocol::evaluation::EvaluationRequest,
    report: &EvaluationReport,
    full: bool,
    resource: ResourceRef,
) -> Result<world_protocol::authorization::ActualImpact, Error> {
    let task = records::task(tx, &request.suite.task_id, request.suite.task_revision).await?;
    let mut access = vec![AccessScope {
        resources: vec![resource],
        fields: Vec::new(),
        modes: vec![if full {
            AccessMode::Manage
        } else {
            AccessMode::Read
        }],
        scope: task.scope.clone(),
        valid_time: None,
    }];
    if full {
        access.push(AccessScope {
            resources: vec![ResourceRef::Suite {
                id: report.suite_id.clone(),
            }],
            fields: Vec::new(),
            modes: vec![AccessMode::Manage],
            scope: task.scope.clone(),
            valid_time: None,
        });
    }
    let mut labels = BTreeSet::new();
    let mut sources = BTreeSet::new();
    let mut evidence = BTreeSet::new();
    for test in records::tests(tx, &request.suite.tests).await? {
        evidence.extend(test.evidence);
    }
    for result in run::results(tx, &report.id).await? {
        if let Some(case) = result.case {
            let current = crate::authorization::case_read_impact(tx, &case).await?;
            labels.extend(current.labels);
            sources.extend(current.source_ids);
            if full {
                access.extend(current.access);
            }
            labels.extend(case.access.labels);
            evidence.extend(case.evidence);
            for receipt in case.read_receipts {
                for source in receipt.basis {
                    sources.insert(source.source_id);
                }
            }
            for receipt in case.source_receipts {
                sources.insert(receipt.source_id);
            }
            if full {
                access.push(AccessScope {
                    resources: vec![ResourceRef::Case { id: case.id }],
                    fields: Vec::new(),
                    modes: vec![AccessMode::Read],
                    scope: task.scope.clone(),
                    valid_time: None,
                });
            }
        }
        for check in result.hard_checks {
            evidence.extend(check.evidence);
        }
    }
    for reference in evidence {
        let fact = crate::facts::assertions::read_evidence(tx, &reference)
            .await
            .map_err(Error::Fact)?
            .ok_or(world_protocol::evaluation::EvaluationFailure::OracleUnavailable)?;
        let version =
            crate::content::read_source_version_in_transaction(tx, &fact.locator.source_version)
                .await?;
        let material = crate::authorization::material_read_impact(tx, &version).await?;
        labels.extend(fact.access.labels);
        labels.extend(material.labels);
        sources.extend(material.source_ids);
        if full {
            access.extend(material.access);
        }
        if full {
            access.push(AccessScope {
                resources: vec![ResourceRef::Evidence { id: reference.id }],
                fields: Vec::new(),
                modes: vec![AccessMode::Read],
                scope: task.scope.clone(),
                valid_time: None,
            });
        }
    }
    Ok(actual_impact(
        access,
        Vec::new(),
        labels.into_iter().collect(),
        Vec::new(),
        sources.into_iter().collect(),
    )?)
}
