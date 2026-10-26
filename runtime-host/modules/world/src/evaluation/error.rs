use super::{ConstraintFailure, Error};
use world_protocol::{
    api::ApiFailure,
    evaluation::EvaluationFailure,
    failure::{Failure, FailureStage, FieldPath, InputFailure, Recovery},
    operation::OperationFailure,
};

impl From<Error> for crate::owner::Error {
    fn from(error: Error) -> Self {
        match error {
            Error::Compile(reason) => Self::new(
                "world.evaluation_compile_failed",
                FailureStage::Compile,
                "评测分支编译失败。",
                ApiFailure::Operation(OperationFailure::Compile(reason)),
                Recovery::None,
            ),
            Error::Store(error) => error.into(),
            Error::Authorization(error) => error.into(),
            Error::Content(error) => error.into(),
            Error::Owner(error) => error,
            Error::Binding(error) => error.into(),
            Error::Query(error) => error.into(),
            Error::Expression(failure) => crate::query::QueryError::from(failure).into(),
            Error::Abstraction(error) => (*error).into(),
            Error::Invocation(error) => {
                Self::from_host_failure(error.host_failure(), FailureStage::Execute).caused(error)
            }
            Error::Composition(error) => {
                Self::from_host_failure(error.host_failure(), FailureStage::Execute)
                    .caused(Error::Composition(error))
            }
            Error::Lease(error) => {
                Self::from_host_failure(error.host_failure(), FailureStage::Admission)
                    .caused(Error::Lease(error))
            }
            Error::Current(error) => {
                Self::from_host_failure(error.host_failure(), FailureStage::Admission)
                    .caused(Error::Current(error))
            }
            Error::Release(error) => (*error).into(),
            Error::Rollback { error, cleanup } => Self::from(*error).with_cleanup(cleanup),
            Error::Fact(error) => {
                let failure = error.safe_failure();
                Self::from_failure(Failure {
                    code: failure.code,
                    stage: failure.stage,
                    message: failure.message,
                    diagnostic_id: failure.diagnostic_id,
                    operation_id: failure.operation_id,
                    run_id: failure.run_id,
                    step_id: failure.step_id,
                    details: ApiFailure::Operation(OperationFailure::Fact(failure.details)),
                    recovery: failure.recovery,
                })
                .caused(error)
            }
            Error::DependencyMissing { capability } => {
                let recovery = world_protocol::ids::ContractId::try_new(format!(
                    "world.evaluation.{capability}"
                ))
                .map(|contract_id| Recovery::SupplyDependency { contract_id })
                .unwrap_or(Recovery::ManualReview);
                Self::new(
                    "world.evaluation_dependency_missing",
                    FailureStage::Execute,
                    "评测执行依赖尚不可用。",
                    ApiFailure::Operation(OperationFailure::Evaluation(
                        EvaluationFailure::ExecutionFailed,
                    )),
                    recovery,
                )
                .caused(Error::DependencyMissing { capability })
            }
            Error::Evaluation(reason) => {
                if let EvaluationFailure::Commit { failure } = reason {
                    return crate::store::StoreError::new(failure, FailureStage::Commit).into();
                }
                let (code, stage, recovery) = match &reason {
                    EvaluationFailure::BadCase { .. } => (
                        "world.evaluation_bad_case",
                        FailureStage::Validate,
                        Recovery::None,
                    ),
                    EvaluationFailure::OracleUnavailable => (
                        "world.evaluation_oracle_unavailable",
                        FailureStage::Verify,
                        Recovery::ManualReview,
                    ),
                    EvaluationFailure::SchemaMismatch { .. } => (
                        "world.evaluation_schema_mismatch",
                        FailureStage::Validate,
                        Recovery::None,
                    ),
                    EvaluationFailure::SourceMissing { .. } => (
                        "world.evaluation_source_missing",
                        FailureStage::Read,
                        Recovery::RetryRead { after: None },
                    ),
                    EvaluationFailure::BasisChanged => (
                        "world.evaluation_basis_changed",
                        FailureStage::Validate,
                        Recovery::Refresh,
                    ),
                    EvaluationFailure::EpochChanged => (
                        "world.evaluation_epoch_changed",
                        FailureStage::Admission,
                        Recovery::Refresh,
                    ),
                    EvaluationFailure::BudgetExhausted { .. } => (
                        "world.evaluation_budget_exhausted",
                        FailureStage::Execute,
                        Recovery::None,
                    ),
                    EvaluationFailure::Cancelled => (
                        "world.evaluation_cancelled",
                        FailureStage::Stop,
                        Recovery::None,
                    ),
                    EvaluationFailure::ExecutionFailed => (
                        "world.evaluation_execution_failed",
                        FailureStage::Execute,
                        Recovery::ManualReview,
                    ),
                    EvaluationFailure::InternalFault => (
                        "world.evaluation_internal_fault",
                        FailureStage::Execute,
                        Recovery::ManualReview,
                    ),
                    EvaluationFailure::Commit { .. } => unreachable!("commit handled above"),
                };
                Self::new(
                    code,
                    stage,
                    "评测未完成；这不证明候选业务失败。",
                    ApiFailure::Operation(OperationFailure::Evaluation(reason)),
                    recovery,
                )
            }
            Error::Constraint(reason) => {
                if let ConstraintFailure::Definition { failure } = reason {
                    return failure.into();
                }
                let (code, field) = match &reason {
                    ConstraintFailure::Invalid { field } => {
                        ("world.evaluation_invalid_input", field.clone())
                    }
                    ConstraintFailure::CrossWorld => {
                        ("world.evaluation_cross_world", path("world"))
                    }
                    ConstraintFailure::TaskMismatch => {
                        ("world.evaluation_task_mismatch", path("task"))
                    }
                    ConstraintFailure::VersionMismatch => {
                        ("world.evaluation_version_mismatch", path("revision"))
                    }
                    ConstraintFailure::EpochChanged => {
                        return Error::Evaluation(EvaluationFailure::EpochChanged).into();
                    }
                    ConstraintFailure::MissingTrace => {
                        ("world.evaluation_missing_trace", path("trace"))
                    }
                    ConstraintFailure::InvalidReceipt => {
                        ("world.evaluation_invalid_receipt", path("receipt"))
                    }
                    ConstraintFailure::Duplicate => ("world.evaluation_duplicate", path("members")),
                    ConstraintFailure::OracleNotIndependent => (
                        "world.evaluation_oracle_not_independent",
                        path("oracle.independence"),
                    ),
                    ConstraintFailure::OracleNotTrusted => {
                        ("world.evaluation_oracle_not_trusted", path("oracle.trust"))
                    }
                    ConstraintFailure::OracleUnverified => (
                        "world.evaluation_oracle_unverified",
                        path("oracle.verification"),
                    ),
                    ConstraintFailure::ProtectedCounterexample { .. } => (
                        "world.evaluation_counterexample_protected",
                        path("counterexamples"),
                    ),
                    ConstraintFailure::HoldoutLeak { .. } => {
                        ("world.evaluation_holdout_leak", path("training"))
                    }
                    ConstraintFailure::MissingParent { .. } => {
                        ("world.evaluation_missing_parent", path("origin.parent"))
                    }
                    ConstraintFailure::Definition { .. } => {
                        unreachable!("definition handled above")
                    }
                };
                Self::new(
                    code,
                    FailureStage::Validate,
                    "评测输入不满足冻结契约。",
                    ApiFailure::Operation(OperationFailure::Input(InputFailure::InvalidValue {
                        field,
                    })),
                    Recovery::None,
                )
                .caused(Error::Constraint(reason))
            }
        }
    }
}
impl Error {
    pub(crate) fn host_failure(&self) -> world_protocol::process::HostFailure {
        use crate::authorization::AuthError;
        use world_protocol::process::HostFailure as Host;
        match self {
            Self::Evaluation(reason) => {
                Host::Operation(OperationFailure::Evaluation(reason.clone()))
            }
            Self::Compile(reason) => Host::Operation(OperationFailure::Compile(reason.clone())),
            Self::Store(error) | Self::Authorization(AuthError::Store(error)) => {
                Host::Operation(OperationFailure::Commit(error.reason.clone()))
            }
            Self::Authorization(AuthError::Denied(reason)) => Host::Authorization(reason.clone()),
            Self::Authorization(AuthError::Codec(_)) => Host::InternalFault,
            Self::Content(crate::content::Error::Store(error)) => {
                Host::Operation(OperationFailure::Commit(error.reason.clone()))
            }
            Self::Content(error) => Host::Operation(OperationFailure::Material(
                error.reason().expect("material error").clone(),
            )),
            Self::Owner(error) => match &error.safe_failure().details {
                ApiFailure::Input(reason) => Host::Input(reason.clone()),
                ApiFailure::Authorization(reason) => Host::Authorization(reason.clone()),
                ApiFailure::Release(reason) => {
                    Host::Operation(OperationFailure::Release(reason.clone()))
                }
                ApiFailure::Query(reason) => Host::Query(reason.clone()),
                ApiFailure::Operation(reason) => Host::Operation(reason.clone()),
                _ => Host::InternalFault,
            },
            Self::Fact(error) => {
                Host::Operation(OperationFailure::Fact(error.safe_failure().details))
            }
            Self::Release(error) => error.host_failure(),
            Self::Binding(error) => error.host_failure(),
            Self::Query(error) => error.host_failure(),
            Self::Expression(failure) => {
                Host::Query(world_protocol::query::QueryFailure::Expression {
                    failure: failure.clone(),
                })
            }
            Self::Abstraction(error) => error.host_failure(),
            Self::Invocation(error) => error.host_failure(),
            Self::Composition(error) => error.host_failure(),
            Self::Lease(error) => error.host_failure(),
            Self::Current(error) => error.host_failure(),
            Self::Rollback { error, .. } => error.host_failure(),
            Self::DependencyMissing { .. } => Host::Operation(OperationFailure::Evaluation(
                EvaluationFailure::ExecutionFailed,
            )),
            Self::Constraint(ConstraintFailure::Definition { failure }) => {
                Host::Operation(OperationFailure::Definition(failure.clone()))
            }
            Self::Constraint(reason) => Host::Input(InputFailure::InvalidValue {
                field: match reason {
                    ConstraintFailure::Invalid { field } => field.clone(),
                    ConstraintFailure::CrossWorld => path("world"),
                    ConstraintFailure::TaskMismatch => path("task"),
                    ConstraintFailure::VersionMismatch => path("revision"),
                    ConstraintFailure::EpochChanged => {
                        return Host::Operation(OperationFailure::Evaluation(
                            EvaluationFailure::EpochChanged,
                        ));
                    }
                    ConstraintFailure::MissingTrace => path("trace"),
                    ConstraintFailure::InvalidReceipt => path("receipt"),
                    ConstraintFailure::Duplicate => path("members"),
                    ConstraintFailure::OracleNotIndependent => path("oracle.independence"),
                    ConstraintFailure::OracleNotTrusted => path("oracle.trust"),
                    ConstraintFailure::OracleUnverified => path("oracle.verification"),
                    ConstraintFailure::ProtectedCounterexample { .. } => path("counterexamples"),
                    ConstraintFailure::HoldoutLeak { .. } => path("training"),
                    ConstraintFailure::MissingParent { .. } => path("origin.parent"),
                    ConstraintFailure::Definition { .. } => unreachable!("handled separately"),
                },
            }),
        }
    }
}

fn path(value: &str) -> FieldPath {
    FieldPath(value.split('.').map(str::to_owned).collect())
}
