mod accounting;
mod assurance;
pub(crate) use assurance::{abstraction_assurance_impact, require_abstraction_assurance, require_abstraction_assurance_read};
mod basis;
mod binding;
mod branch_execution;
pub(crate) use binding::{ExecutionBounds, execution_case_id, require_execution_binding, require_execution_binding_snapshot};
pub(crate) use branch_execution::{
    ExecutionWitness, FiniteBranchExecution, PreparedExecution, abstraction_plan_digest,
    oracle_step_retention_roots,
};
mod constraints;
mod disclosure;
mod error;
mod evaluate;
mod execution;
mod frozen_model;
mod frozen_plan;
pub(crate) use frozen_model::{FrozenArmModel, FrozenArmPlan, frozen_arm_model, frozen_arm_model_snapshot, frozen_arm_plan, frozen_arm_plan_snapshot, frozen_model_impact};
pub(crate) use frozen_plan::{SuiteMemory, frozen_inline_definitions, load_suite_memory, plans_impact};
mod io;
mod isolation;
mod judge;
mod management;
pub(crate) use management::{
    branch_for_freeze, exact_test, freeze, freeze_impact, frozen_suite, suite_creation_context, suite_summary, suites,
    test_cases, test_impact,
};
mod numeric;
mod online;
pub(crate) use online::{
    OnlineOraclePlan, OnlineOracleResult, check_online, online_oracle_retention_roots, prepare_online,
    read_online_test, recheck_online,
};
mod oracle;
mod prepared;
pub(crate) use prepared::PreparedEvaluation;
mod read;
mod records;
mod request;
pub(crate) use request::{branch_for_test, resolve_test};
mod retention;
pub(crate) use retention::{
    case_step_retention_roots, retain_freeze, retain_report, retain_task, retain_test,
    world_deletion_roots,
};
mod run;
pub(crate) use read::{execution_impact, report, reports};
mod scoring;
mod settlement;
pub(crate) use settlement::{EvaluationSettlement, settle_report};
mod suite;

pub(crate) use disclosure::{full_report, owner_report_impact, owner_request_impact, report_impact, request_impact, summary, summary_failure};
pub(crate) use evaluate::Evaluation;

pub(crate) use run::{
    EvaluationRun, has_unsettled_execution, has_unsettled_world, read_report,
    read_report_for_branch, read_report_plan, reports_for_branch, start,
};

pub(crate) use records::{
    freeze_suite, load_case as read_case, record_case, record_task, record_test,
    suite as read_suite, task as read_task, training_case,
};

pub(crate) use basis::{assess_basis, data_digest};
pub(crate) use constraints::{validate_case, validate_task, validate_test};
pub(crate) use execution::{
    BranchExecution, EvaluationFuture, ExecutedCase, HumanVerification, Measurements, OracleResult,
};
pub(crate) use isolation::{CandidateInput, training_cases};
pub(crate) use oracle::{qualify_oracle, verify_source_receipt};
pub(crate) use suite::{validate_request, validate_suite};

#[derive(Debug)]
pub(crate) enum Error {
    Constraint(ConstraintFailure),
    Evaluation(world_protocol::evaluation::EvaluationFailure),
    Compile(world_protocol::compiler::CompileFailure),
    Store(crate::store::StoreError),
    Authorization(crate::authorization::AuthError),
    Content(crate::content::Error),
    Owner(crate::owner::Error),
    Fact(crate::facts::assertions::Error),
    Release(Box<crate::releases::Error>),
    Binding(crate::extensions::bindings::BindingError),
    Query(crate::query::QueryError),
    Expression(world_protocol::expression::ExpressionFailure),
    Abstraction(Box<crate::abstraction::Error>),
    Invocation(crate::extensions::invocation::InvocationFailure),
    Composition(crate::extensions::invocation::CompositionFailure),
    Lease(crate::extensions::invocation::LeaseFailure),
    Current(crate::extensions::invocation::CurrentFailure),
    DependencyMissing {
        capability: &'static str,
    },
    Rollback {
        error: Box<Error>,
        cleanup: crate::store::StoreError,
    },
}

impl From<ConstraintFailure> for Error {
    fn from(failure: ConstraintFailure) -> Self {
        Self::Constraint(failure)
    }
}
impl From<crate::store::StoreError> for Error {
    fn from(error: crate::store::StoreError) -> Self {
        Self::Store(error)
    }
}
impl From<crate::authorization::AuthError> for Error {
    fn from(error: crate::authorization::AuthError) -> Self {
        Self::Authorization(error)
    }
}
impl From<crate::releases::Error> for Error {
    fn from(error: crate::releases::Error) -> Self {
        Self::Release(Box::new(error))
    }
}
impl From<crate::content::Error> for Error {
    fn from(error: crate::content::Error) -> Self {
        Self::Content(error)
    }
}
impl From<crate::owner::Error> for Error {
    fn from(error: crate::owner::Error) -> Self {
        Self::Owner(error)
    }
}
impl From<crate::extensions::bindings::BindingError> for Error {
    fn from(error: crate::extensions::bindings::BindingError) -> Self {
        Self::Binding(error)
    }
}
impl From<crate::query::QueryError> for Error {
    fn from(error: crate::query::QueryError) -> Self {
        Self::Query(error)
    }
}
impl From<world_protocol::expression::ExpressionFailure> for Error {
    fn from(error: world_protocol::expression::ExpressionFailure) -> Self {
        Self::Expression(error)
    }
}
impl From<crate::abstraction::Error> for Error {
    fn from(error: crate::abstraction::Error) -> Self {
        Self::Abstraction(Box::new(error))
    }
}
impl From<crate::extensions::invocation::InvocationFailure> for Error {
    fn from(error: crate::extensions::invocation::InvocationFailure) -> Self {
        Self::Invocation(error)
    }
}
impl From<crate::extensions::invocation::CompositionFailure> for Error {
    fn from(error: crate::extensions::invocation::CompositionFailure) -> Self {
        Self::Composition(error)
    }
}
impl From<crate::extensions::invocation::LeaseFailure> for Error {
    fn from(error: crate::extensions::invocation::LeaseFailure) -> Self {
        Self::Lease(error)
    }
}
impl From<crate::extensions::invocation::CurrentFailure> for Error {
    fn from(error: crate::extensions::invocation::CurrentFailure) -> Self {
        Self::Current(error)
    }
}
impl From<foundation::pipeline::PipelineError> for Error {
    fn from(error: foundation::pipeline::PipelineError) -> Self {
        Self::Evaluation(match error {
            foundation::pipeline::PipelineError::Cancelled => {
                world_protocol::evaluation::EvaluationFailure::Cancelled
            }
            _ => world_protocol::evaluation::EvaluationFailure::ExecutionFailed,
        })
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Constraint(_) => formatter.write_str("world.evaluation_invalid_input"),
            Self::Evaluation(_) => formatter.write_str("world.evaluation_failed"),
            Self::Compile(_) => formatter.write_str("world.evaluation_compile_failed"),
            Self::Store(error) => error.fmt(formatter),
            Self::Authorization(error) => error.fmt(formatter),
            Self::Content(error) => error.fmt(formatter),
            Self::Owner(error) => error.fmt(formatter),
            Self::Fact(error) => error.fmt(formatter),
            Self::Release(error) => error.fmt(formatter),
            Self::Binding(error) => error.fmt(formatter),
            Self::Query(error) => error.fmt(formatter),
            Self::Expression(_) => formatter.write_str("world.evaluation_expression_failed"),
            Self::Abstraction(error) => error.fmt(formatter),
            Self::Invocation(error) => error.fmt(formatter),
            Self::Composition(_) | Self::Lease(_) | Self::Current(_) => {
                formatter.write_str("world.evaluation_invocation_failed")
            }
            Self::Rollback { error, .. } => error.fmt(formatter),
            Self::DependencyMissing { capability } => write!(
                formatter,
                "world.evaluation_dependency_missing: {capability}"
            ),
        }
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Store(error) => Some(error),
            Self::Authorization(error) => Some(error),
            Self::Content(error) => Some(error),
            Self::Owner(error) => Some(error),
            Self::Fact(error) => Some(error),
            Self::Release(error) => Some(error.as_ref()),
            Self::Binding(error) => Some(error),
            Self::Query(error) => Some(error),
            Self::Abstraction(error) => Some(error.as_ref()),
            Self::Invocation(error) => Some(error),
            Self::Composition(error) => Some(error),
            Self::Rollback { error, .. } => Some(error.as_ref()),
            _ => None,
        }
    }
}

use world_protocol::{
    definitions::DefinitionFailure,
    failure::FieldPath,
    ids::{CaseId, TestCaseId},
};

/// Admission failures are not evidence that the candidate failed its task.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ConstraintFailure {
    Invalid { field: FieldPath },
    Definition { failure: DefinitionFailure },
    CrossWorld,
    TaskMismatch,
    VersionMismatch,
    EpochChanged,
    MissingTrace,
    InvalidReceipt,
    Duplicate,
    OracleNotIndependent,
    OracleNotTrusted,
    OracleUnverified,
    ProtectedCounterexample { test_case_id: TestCaseId },
    HoldoutLeak { test_case_id: TestCaseId },
    MissingParent { case_id: CaseId },
}

fn invalid(field: &str) -> ConstraintFailure {
    ConstraintFailure::Invalid {
        field: FieldPath(field.split('.').map(str::to_owned).collect()),
    }
}
