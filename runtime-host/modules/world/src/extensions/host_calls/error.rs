use std::{error::Error, fmt};

use world_protocol::{
    failure::{Failure, FailureStage, Recovery},
    ids::DiagnosticId,
    process::HostFailure,
};

use crate::{
    authorization::AuthError, extensions::invocation::CurrentFailure,
    sources::connectors::SourceError, store::StoreError,
};

/// One safe projection and the original typed private error, retained by the calling adapter.
pub(crate) struct HostCallFailure {
    failure: Failure<HostFailure>,
    cause: Option<Box<dyn Error + Send + Sync>>,
}
impl HostCallFailure {
    pub(crate) fn new(details: HostFailure, stage: FailureStage) -> Self {
        Self {
            failure: Failure {
                code: "world.host_call_failed".into(),
                stage,
                message: "插件请求未完成，请查看具体原因和诊断编号。".into(),
                diagnostic_id: DiagnosticId::try_new(uuid::Uuid::new_v4().to_string())
                    .expect("UUID diagnostic"),
                operation_id: None,
                run_id: None,
                step_id: None,
                details,
                recovery: Recovery::None,
            },
            cause: None,
        }
    }
    pub(crate) fn caused_by(
        details: HostFailure,
        stage: FailureStage,
        cause: impl Error + Send + Sync + 'static,
    ) -> Self {
        let mut error = Self::new(details, stage);
        error.cause = Some(Box::new(cause));
        error
    }
    pub(crate) fn safe_failure(&self) -> Failure<HostFailure> {
        self.failure.clone()
    }
    pub(crate) fn details(&self) -> &HostFailure {
        &self.failure.details
    }
    pub(crate) fn source_failure(&self) -> Option<&SourceError> {
        self.cause.as_deref()?.downcast_ref()
    }
}
impl fmt::Display for HostCallFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.failure.code, self.failure.diagnostic_id)
    }
}
impl fmt::Debug for HostCallFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HostCallFailure")
            .field("failure", &self.failure)
            .finish_non_exhaustive()
    }
}
impl Error for HostCallFailure {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.cause
            .as_deref()
            .map(|cause| cause as &(dyn Error + 'static))
    }
}
impl From<SourceError> for HostCallFailure {
    fn from(error: SourceError) -> Self {
        Self::caused_by(
            HostFailure::Source(error.failure.clone()),
            error.stage,
            error,
        )
    }
}
impl From<crate::extensions::package::PackageError> for HostCallFailure {
    fn from(error: crate::extensions::package::PackageError) -> Self {
        let safe = error.public(FailureStage::Admission, None);
        let mut failure = Self::caused_by(
            HostFailure::Operation(world_protocol::operation::OperationFailure::Package(
                safe.details,
            )),
            safe.stage,
            error,
        );
        failure.failure.diagnostic_id = safe.diagnostic_id;
        failure.failure.recovery = safe.recovery;
        failure
    }
}
impl From<crate::query::QueryError> for HostCallFailure {
    fn from(error: crate::query::QueryError) -> Self {
        Self::caused_by(error.host_failure(), FailureStage::Read, error)
    }
}
impl From<crate::extensions::migration::StateError> for HostCallFailure {
    fn from(error: crate::extensions::migration::StateError) -> Self {
        crate::owner::Error::from(error).into()
    }
}
impl From<StoreError> for HostCallFailure {
    fn from(error: StoreError) -> Self {
        let safe = error.safe_failure();
        let mut failure = Self::caused_by(
            HostFailure::Operation(world_protocol::operation::OperationFailure::Commit(
                safe.details,
            )),
            safe.stage,
            error,
        );
        failure.failure.diagnostic_id = safe.diagnostic_id;
        failure.failure.recovery = safe.recovery;
        failure
    }
}
impl From<AuthError> for HostCallFailure {
    fn from(error: AuthError) -> Self {
        match error {
            AuthError::Denied(failure) => {
                Self::new(HostFailure::Authorization(failure), FailureStage::Admission)
            }
            AuthError::Store(error) => error.into(),
            error => Self::caused_by(HostFailure::InternalFault, FailureStage::Admission, error),
        }
    }
}
impl From<CurrentFailure> for HostCallFailure {
    fn from(error: CurrentFailure) -> Self {
        match error {
            CurrentFailure::Authorization(error) => error.into(),
            CurrentFailure::Store(error) => error.into(),
            CurrentFailure::Binding(failure) => {
                Self::new(HostFailure::Binding(failure), FailureStage::Admission)
            }
            CurrentFailure::Package(error) => error.into(),
        }
    }
}
impl From<crate::owner::Error> for HostCallFailure {
    fn from(error: crate::owner::Error) -> Self {
        use world_protocol::api::ApiFailure;
        let failure = error.safe_failure();
        let details = match &failure.details {
            ApiFailure::Input(failure) => HostFailure::Input(failure.clone()),
            ApiFailure::Authorization(failure) => HostFailure::Authorization(failure.clone()),
            ApiFailure::Query(failure) => HostFailure::Query(failure.clone()),
            ApiFailure::Release(failure) => HostFailure::Operation(
                world_protocol::operation::OperationFailure::Release(failure.clone()),
            ),
            ApiFailure::Operation(failure) => HostFailure::Operation(failure.clone()),
            ApiFailure::NotConfigured => {
                HostFailure::Operation(world_protocol::operation::OperationFailure::NotConfigured)
            }
            ApiFailure::NotFound => {
                HostFailure::Operation(world_protocol::operation::OperationFailure::NotFound)
            }
            ApiFailure::RevisionConflict => HostFailure::Operation(
                world_protocol::operation::OperationFailure::RevisionConflict,
            ),
            _ => HostFailure::InternalFault,
        };
        let safe = failure.clone();
        let mut result = Self::caused_by(details, safe.stage, error);
        result.failure.code = safe.code;
        result.failure.message = safe.message;
        result.failure.diagnostic_id = safe.diagnostic_id;
        result.failure.operation_id = safe.operation_id;
        result.failure.run_id = safe.run_id;
        result.failure.step_id = safe.step_id;
        result.failure.recovery = safe.recovery;
        result
    }
}
impl<E: Into<HostCallFailure>> From<crate::store::TransactionError<E>> for HostCallFailure {
    fn from(error: crate::store::TransactionError<E>) -> Self {
        match error {
            crate::store::TransactionError::Indeterminate(error) => error.into(),
            crate::store::TransactionError::NotCommitted {
                error,
                cleanup: None,
            } => error.into(),
            crate::store::TransactionError::NotCommitted {
                error,
                cleanup: Some(cleanup),
            } => {
                let error = error.into();
                let safe = error.failure.clone();
                Self {
                    failure: safe,
                    cause: Some(Box::new(CleanupFailure {
                        primary: error,
                        cleanup,
                    })),
                }
            }
        }
    }
}
#[derive(Debug)]
struct CleanupFailure {
    primary: HostCallFailure,
    cleanup: StoreError,
}
impl fmt::Display for CleanupFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "world.host_call_cleanup_failed: {}", self.cleanup)
    }
}
impl Error for CleanupFailure {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(&self.primary)
    }
}
