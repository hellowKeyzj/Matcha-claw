use std::{error::Error as StdError, fmt};

use world_protocol::{
    failure::{Failure, FailureStage, Recovery},
    ids::{DiagnosticId, OperationId},
    package::PackageFailure,
};

pub struct PackageError {
    pub reason: PackageFailure,
    pub diagnostic_id: DiagnosticId,
    cause: Option<Box<dyn StdError + Send + Sync>>,
    cleanup: Option<Box<dyn StdError + Send + Sync>>,
}

impl PackageError {
    pub(crate) fn new(reason: PackageFailure) -> Self {
        Self {
            reason,
            diagnostic_id: DiagnosticId::try_new(uuid::Uuid::new_v4().to_string())
                .expect("UUID is a valid diagnostic identifier"),
            cause: None,
            cleanup: None,
        }
    }

    pub(super) fn caused(
        reason: PackageFailure,
        cause: impl StdError + Send + Sync + 'static,
    ) -> Self {
        let mut error = Self::new(reason);
        error.cause = Some(Box::new(cause));
        error
    }

    pub(super) fn with_cleanup(mut self, cause: impl StdError + Send + Sync + 'static) -> Self {
        self.cleanup = Some(Box::new(cause));
        self
    }

    pub fn cleanup_failed(&self) -> bool {
        self.cleanup.is_some()
    }

    pub fn public(
        &self,
        stage: FailureStage,
        operation_id: Option<OperationId>,
    ) -> Failure<PackageFailure> {
        let recovery = match &self.reason {
            PackageFailure::Commit {
                failure: world_protocol::commit::CommitFailure::CommitIndeterminate { commit_id },
            } => Recovery::ReadCommit {
                commit_id: commit_id.clone(),
            },
            PackageFailure::CleanupFailed => Recovery::ManualReview,
            _ if self.cleanup_failed() => Recovery::ManualReview,
            _ => Recovery::None,
        };
        Failure {
            code: "world.package.failed".into(),
            stage,
            message: "World package operation failed".into(),
            diagnostic_id: self.diagnostic_id.clone(),
            operation_id,
            run_id: None,
            step_id: None,
            details: self.reason.clone(),
            recovery,
        }
    }
}

impl From<crate::store::StoreError> for PackageError {
    fn from(error: crate::store::StoreError) -> Self {
        Self::caused(
            PackageFailure::Commit {
                failure: error.reason.clone(),
            },
            error,
        )
    }
}

impl From<PackageError> for crate::owner::Error {
    fn from(error: PackageError) -> Self {
        let failure = error.public(FailureStage::Verify, None);
        let failure = Failure {
            code: failure.code,
            stage: failure.stage,
            message: failure.message,
            diagnostic_id: failure.diagnostic_id,
            operation_id: failure.operation_id,
            run_id: failure.run_id,
            step_id: failure.step_id,
            details: world_protocol::operation::OperationFailure::Package(failure.details),
            recovery: failure.recovery,
        };
        let cleanup = error.cleanup_failed().then(|| {
            let mut cleanup = failure.clone();
            cleanup.code = "world.package.cleanup_failed".into();
            cleanup.stage = FailureStage::Drain;
            cleanup.message = "World package cleanup is not confirmed".into();
            cleanup.details =
                world_protocol::operation::OperationFailure::Package(PackageFailure::CleanupFailed);
            cleanup.recovery = Recovery::ManualReview;
            Self::from(cleanup)
        });
        let failure = Self::from(failure).caused(error);
        match cleanup {
            Some(cleanup) => failure.with_related(cleanup),
            None => failure,
        }
    }
}

impl fmt::Debug for PackageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PackageError")
            .field("reason", &self.reason)
            .field("diagnostic_id", &self.diagnostic_id)
            .field("cleanup_failed", &self.cleanup_failed())
            .finish_non_exhaustive()
    }
}
impl fmt::Display for PackageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("world package operation failed")
    }
}
impl StdError for PackageError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        self.cause
            .as_deref()
            .map(|cause| cause as &(dyn StdError + 'static))
    }
}
