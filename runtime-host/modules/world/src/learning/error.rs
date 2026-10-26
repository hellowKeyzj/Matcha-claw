use super::Error;
use world_protocol::{
    api::ApiFailure,
    failure::{Failure, FailureStage, Recovery},
    learning::LearningFailure,
    operation::OperationFailure,
};

impl Error {
    pub(crate) fn host_failure(&self) -> world_protocol::process::HostFailure {
        use crate::authorization::AuthError;
        use world_protocol::process::HostFailure as Host;
        match self {
            Self::Rejected(reason) => Host::Operation(OperationFailure::Learning(reason.clone())),
            Self::Store(error) | Self::Authorization(AuthError::Store(error)) => {
                Host::Operation(OperationFailure::Commit(error.reason.clone()))
            }
            Self::Authorization(AuthError::Denied(reason)) => Host::Authorization(reason.clone()),
            Self::Authorization(AuthError::Codec(_)) => Host::InternalFault,
            Self::Definition(crate::definitions::DefinitionError::Rejected(reason)) => {
                Host::Operation(OperationFailure::Definition(reason.clone()))
            }
            Self::Definition(crate::definitions::DefinitionError::Compile(reason))
            | Self::Compile(reason) => Host::Operation(OperationFailure::Compile(reason.clone())),
            Self::Definition(crate::definitions::DefinitionError::Store(error)) => {
                Host::Operation(OperationFailure::Commit(error.reason.clone()))
            }
            Self::Definition(crate::definitions::DefinitionError::Codec(_)) => Host::InternalFault,
            Self::Fact(error) => {
                Host::Operation(OperationFailure::Fact(error.safe_failure().details))
            }
            Self::Evaluation(error) => error.host_failure(),
            Self::Owner(error) => match &error.safe_failure().details {
                ApiFailure::Input(reason) => Host::Input(reason.clone()),
                ApiFailure::Authorization(reason) => Host::Authorization(reason.clone()),
                ApiFailure::Query(reason) => Host::Query(reason.clone()),
                ApiFailure::Release(reason) => {
                    Host::Operation(OperationFailure::Release(reason.clone()))
                }
                ApiFailure::Operation(reason) => Host::Operation(reason.clone()),
                ApiFailure::NotConfigured => Host::Operation(OperationFailure::NotConfigured),
                ApiFailure::NotFound => Host::Operation(OperationFailure::NotFound),
                ApiFailure::RevisionConflict => Host::Operation(OperationFailure::RevisionConflict),
                _ => Host::InternalFault,
            },
            Self::Release(error) => error.host_failure(),
            Self::DependencyMissing { .. } => {
                Host::Operation(OperationFailure::Learning(LearningFailure::InternalFault))
            }
        }
    }
}

impl From<Error> for crate::owner::Error {
    fn from(error: Error) -> Self {
        match error {
            Error::Store(error) => error.into(),
            Error::Authorization(error) => error.into(),
            Error::Evaluation(error) => error.into(),
            Error::Owner(error) => error,
            Error::Release(error) => (*error).into(),
            Error::Definition(error) => match error {
                crate::definitions::DefinitionError::Rejected(reason) => reason.into(),
                crate::definitions::DefinitionError::Store(error) => error.into(),
                crate::definitions::DefinitionError::Compile(reason) => {
                    Error::Compile(reason).into()
                }
                crate::definitions::DefinitionError::Codec(error) => {
                    Self::internal(FailureStage::Validate).caused(error)
                }
            },
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
            Error::Compile(reason) => Self::new(
                "world.learning_compile_rejected",
                FailureStage::Compile,
                "学习候选未通过编译。",
                ApiFailure::Operation(OperationFailure::Compile(reason)),
                Recovery::None,
            ),
            Error::DependencyMissing { capability } => {
                let recovery = world_protocol::ids::ContractId::try_new(format!(
                    "world.learning.{capability}"
                ))
                .map(|contract_id| Recovery::SupplyDependency { contract_id })
                .unwrap_or(Recovery::ManualReview);
                Self::new(
                    "world.learning_dependency_missing",
                    FailureStage::Validate,
                    "学习候选缺少可信生产依赖。",
                    ApiFailure::Operation(OperationFailure::Learning(
                        LearningFailure::InternalFault,
                    )),
                    recovery,
                )
                .caused(Error::DependencyMissing { capability })
            }
            Error::Rejected(reason) => {
                if let LearningFailure::Commit { failure } = reason {
                    return crate::store::StoreError::new(failure, FailureStage::Commit).into();
                }
                let (code, stage, recovery) = match &reason {
                    LearningFailure::InvalidOperation { field, .. } => (
                        "world.learning_invalid_operation",
                        FailureStage::Validate,
                        Recovery::CorrectInput {
                            fields: vec![field.clone()],
                        },
                    ),
                    LearningFailure::ConstraintViolated { field } => (
                        "world.learning_constraint_violated",
                        FailureStage::Verify,
                        Recovery::CorrectInput {
                            fields: vec![field.clone()],
                        },
                    ),
                    LearningFailure::MissingEvidence { .. } => (
                        "world.learning_missing_evidence",
                        FailureStage::Read,
                        Recovery::RequestEvidence {
                            evidence: Vec::new(),
                        },
                    ),
                    LearningFailure::BasisChanged => (
                        "world.learning_basis_changed",
                        FailureStage::Validate,
                        Recovery::Refresh,
                    ),
                    LearningFailure::UnauthorizedOperation => (
                        "world.learning_unauthorized",
                        FailureStage::Admission,
                        Recovery::None,
                    ),
                    LearningFailure::Definition { .. } => (
                        "world.learning_definition_rejected",
                        FailureStage::Validate,
                        Recovery::None,
                    ),
                    LearningFailure::EvaluationRequired { .. } => (
                        "world.learning_evaluation_required",
                        FailureStage::Verify,
                        Recovery::None,
                    ),
                    LearningFailure::CounterexampleProtected { .. } => (
                        "world.learning_counterexample_protected",
                        FailureStage::Validate,
                        Recovery::None,
                    ),
                    LearningFailure::Model { .. } => (
                        "world.learning_generation_failed",
                        FailureStage::Generate,
                        Recovery::ManualReview,
                    ),
                    LearningFailure::Cancelled => (
                        "world.learning_cancelled",
                        FailureStage::Stop,
                        Recovery::None,
                    ),
                    LearningFailure::InternalFault => (
                        "world.learning_internal_fault",
                        FailureStage::Validate,
                        Recovery::ManualReview,
                    ),
                    LearningFailure::Commit { .. } => unreachable!("commit handled above"),
                };
                Self::new(
                    code,
                    stage,
                    "学习候选尚未获准发布。",
                    ApiFailure::Operation(OperationFailure::Learning(reason)),
                    recovery,
                )
            }
        }
    }
}
