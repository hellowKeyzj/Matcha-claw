use std::{error::Error, fmt};

use world_protocol::{
    failure::{FailureStage, FieldPath},
    sources::{SourceFailure, SourcePlanReason},
};

use crate::{authorization::AuthError, store::StoreError};

#[derive(Clone)]
pub struct SourceError {
    pub failure: SourceFailure,
    pub stage: FailureStage,
    cause: Option<std::sync::Arc<dyn Error + Send + Sync>>,
    related: Vec<SourceError>,
}

impl SourceError {
    pub fn new(failure: SourceFailure, stage: FailureStage) -> Self {
        Self {
            failure,
            stage,
            cause: None,
            related: Vec::new(),
        }
    }

    pub fn caused_by(
        failure: SourceFailure,
        stage: FailureStage,
        cause: impl Error + Send + Sync + 'static,
    ) -> Self {
        Self {
            failure,
            stage,
            cause: Some(std::sync::Arc::new(cause)),
            related: Vec::new(),
        }
    }

    pub(crate) fn with_related(mut self, error: Self) -> Self {
        self.related.push(error);
        self
    }

    pub(crate) fn related_errors(&self) -> &[Self] {
        &self.related
    }

    pub(crate) fn cleanup(primary: Option<Self>, code: &str, cleanup: Self) -> Self {
        Self::caused_by(
            SourceFailure::Cleanup {
                primary: primary
                    .as_ref()
                    .map(|error| Box::new(error.failure.clone())),
                code: code.into(),
            },
            FailureStage::Drain,
            CleanupCause { primary, cleanup },
        )
    }

    pub(crate) fn invalid(field: impl Into<String>, reason: SourcePlanReason) -> Self {
        Self::new(
            SourceFailure::InvalidPlan {
                field: FieldPath(vec![field.into()]),
                reason,
            },
            FailureStage::Validate,
        )
    }

    pub(crate) fn database(error: tokio_postgres::Error, stage: FailureStage) -> Self {
        use tokio_postgres::error::SqlState;
        let failure = match error.code() {
            Some(&SqlState::INVALID_PASSWORD | &SqlState::INVALID_AUTHORIZATION_SPECIFICATION) => {
                SourceFailure::Authentication
            }
            Some(&SqlState::INSUFFICIENT_PRIVILEGE) => SourceFailure::PermissionDenied,
            Some(&SqlState::QUERY_CANCELED) => SourceFailure::ReadTimeout,
            Some(code) => SourceFailure::SqlState {
                code: code.code().to_owned(),
            },
            None => SourceFailure::Connection,
        };
        Self::caused_by(failure, stage, error)
    }
}

#[derive(Debug)]
struct CleanupCause {
    primary: Option<SourceError>,
    cleanup: SourceError,
}
impl fmt::Display for CleanupCause {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("world.source_cleanup_failed")
    }
}
impl Error for CleanupCause {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(self.primary.as_ref().unwrap_or(&self.cleanup))
    }
}

impl From<crate::extensions::invocation::ResourceFailure> for SourceError {
    fn from(error: crate::extensions::invocation::ResourceFailure) -> Self {
        Self::caused_by(
            SourceFailure::Cleanup {
                primary: None,
                code: error.code.into(),
            },
            FailureStage::Drain,
            ResourceCause(error),
        )
    }
}

#[derive(Debug)]
struct ResourceCause(crate::extensions::invocation::ResourceFailure);
impl fmt::Display for ResourceCause {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "world.source_resource_failed: {:?}", self.0)
    }
}
impl Error for ResourceCause {}

impl From<crate::extensions::package::PackageError> for SourceError {
    fn from(error: crate::extensions::package::PackageError) -> Self {
        let failure = error.public(FailureStage::Admission, None).details;
        Self::caused_by(
            SourceFailure::Package { failure },
            FailureStage::Admission,
            error,
        )
    }
}
impl From<crate::sources::mapping::MappingError> for SourceError {
    fn from(error: crate::sources::mapping::MappingError) -> Self {
        use crate::{definitions::DefinitionError, sources::mapping::MappingError};
        match error {
            MappingError::Mapping(failure) => {
                Self::new(SourceFailure::Mapping { failure }, FailureStage::Validate)
            }
            MappingError::Authorization(error) => error.into(),
            MappingError::Store(error) => error.into(),
            MappingError::Release(error) => (*error).into(),
            MappingError::Definition(DefinitionError::Rejected(failure)) => Self::new(
                SourceFailure::Compile {
                    failure: world_protocol::compiler::CompileFailure::Definition { failure },
                },
                FailureStage::Validate,
            ),
            MappingError::Definition(DefinitionError::Compile(failure)) => {
                Self::new(SourceFailure::Compile { failure }, FailureStage::Validate)
            }
            MappingError::Definition(DefinitionError::Store(error)) => error.into(),
            MappingError::Definition(DefinitionError::Codec(error)) => {
                Self::caused_by(SourceFailure::InternalFault, FailureStage::Decode, error)
            }
        }
    }
}
impl From<crate::releases::Error> for SourceError {
    fn from(error: crate::releases::Error) -> Self {
        use crate::releases::Error;
        // Metadata readers only produce these four variants. Keep any broken
        // invariant's original cause private rather than calling it a source failure.
        let (failure, stage) = match &error {
            Error::Rejected(failure) => (
                SourceFailure::Release {
                    failure: Box::new(failure.clone()),
                },
                FailureStage::Read,
            ),
            Error::Compile(failure) => (
                SourceFailure::Compile {
                    failure: failure.clone(),
                },
                FailureStage::Validate,
            ),
            Error::Store(error) => (
                SourceFailure::Commit {
                    failure: error.reason.clone(),
                },
                error.stage,
            ),
            _ => (SourceFailure::InternalFault, FailureStage::Decode),
        };
        Self::caused_by(failure, stage, error)
    }
}
impl fmt::Display for SourceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("world.source_failed")
    }
}
impl fmt::Debug for SourceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SourceError")
            .field("failure", &self.failure)
            .field("stage", &self.stage)
            .finish_non_exhaustive()
    }
}
impl Error for SourceError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.cause.as_deref().map(|cause| cause as _)
    }
}
impl From<StoreError> for SourceError {
    fn from(error: StoreError) -> Self {
        Self::caused_by(
            SourceFailure::Commit {
                failure: error.reason.clone(),
            },
            error.stage,
            error,
        )
    }
}
impl From<AuthError> for SourceError {
    fn from(error: AuthError) -> Self {
        match error {
            AuthError::Denied(failure) => Self::new(
                SourceFailure::Authorization { failure },
                FailureStage::Admission,
            ),
            AuthError::Store(error) => error.into(),
            AuthError::Codec(error) => {
                Self::caused_by(SourceFailure::InternalFault, FailureStage::Decode, error)
            }
        }
    }
}
