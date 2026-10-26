use crate::{
    authorization::AuthError,
    content, facts,
    identity::IdentityError,
    sources::{connectors::SourceError, mapping::MappingError},
    store::{StoreError, TransactionError},
};
use std::{error::Error, fmt};
use world_protocol::{failure::FailureStage, sources::SourceFailure};

pub(crate) enum SyncError {
    Source(SourceError),
    Store(StoreError),
    Authorization(AuthError),
    Mapping(MappingError),
    Content(content::Error),
    Fact(facts::assertions::Error),
    Identity(IdentityError),
    Owner(crate::owner::Error),
    Indeterminate(StoreError),
    Rollback {
        error: Box<SyncError>,
        cleanup: StoreError,
    },
    Cleanup {
        error: Box<SyncError>,
        cleanup: SourceError,
    },
}
impl SyncError {
    pub(crate) fn host_failure(&self) -> world_protocol::process::HostFailure {
        use world_protocol::{
            operation::OperationFailure as Operation, process::HostFailure as Host,
        };
        match self {
            Self::Source(error) => Host::Source(error.failure.clone()),
            Self::Owner(error) => match &error.safe_failure().details {
                world_protocol::api::ApiFailure::Operation(failure) => {
                    Host::Operation(failure.clone())
                }
                world_protocol::api::ApiFailure::Authorization(failure) => {
                    Host::Authorization(failure.clone())
                }
                _ => Host::InternalFault,
            },
            Self::Store(error)
            | Self::Indeterminate(error)
            | Self::Authorization(AuthError::Store(error))
            | Self::Mapping(MappingError::Store(error))
            | Self::Mapping(MappingError::Authorization(AuthError::Store(error)))
            | Self::Content(content::Error::Store(error))
            | Self::Identity(IdentityError::Store(error)) => {
                Host::Operation(Operation::Commit(error.reason.clone()))
            }
            Self::Authorization(AuthError::Denied(failure))
            | Self::Mapping(MappingError::Authorization(AuthError::Denied(failure))) => {
                Host::Authorization(failure.clone())
            }
            Self::Authorization(AuthError::Codec(_))
            | Self::Mapping(MappingError::Authorization(AuthError::Codec(_))) => {
                Host::InternalFault
            }
            Self::Mapping(MappingError::Mapping(failure)) => {
                Host::Operation(Operation::Mapping(failure.clone()))
            }
            Self::Mapping(MappingError::Release(error)) => error.host_failure(),
            Self::Mapping(MappingError::Definition(error)) => match error {
                crate::definitions::DefinitionError::Rejected(failure) => {
                    Host::Operation(Operation::Definition(failure.clone()))
                }
                crate::definitions::DefinitionError::Compile(failure) => {
                    Host::Operation(Operation::Compile(failure.clone()))
                }
                crate::definitions::DefinitionError::Store(error) => {
                    Host::Operation(Operation::Commit(error.reason.clone()))
                }
                crate::definitions::DefinitionError::Codec(_) => Host::InternalFault,
            },
            Self::Content(content::Error::Material { reason, .. }) => {
                Host::Operation(Operation::Material(reason.clone()))
            }
            Self::Fact(error) | Self::Identity(IdentityError::Fact(error)) => {
                Host::Operation(Operation::Fact(error.safe_failure().details))
            }
            Self::Identity(IdentityError::Rejected(failure)) => {
                Host::Operation(Operation::Identity(failure.clone()))
            }
            Self::Rollback { error, .. } | Self::Cleanup { error, .. } => error.host_failure(),
        }
    }
    pub(crate) fn protocol() -> Self {
        Self::Source(SourceError::new(
            SourceFailure::ProtocolViolation,
            FailureStage::Validate,
        ))
    }
    pub(crate) fn caused(
        failure: SourceFailure,
        stage: FailureStage,
        cause: impl Error + Send + Sync + 'static,
    ) -> Self {
        Self::Source(SourceError::caused_by(failure, stage, cause))
    }
    pub(crate) fn codec(stage: FailureStage, cause: serde_json::Error) -> Self {
        Self::caused(SourceFailure::InternalFault, stage, cause)
    }
}
impl From<crate::owner::Error> for SyncError {
    fn from(error: crate::owner::Error) -> Self {
        Self::Owner(error)
    }
}
impl From<StoreError> for SyncError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}
impl From<SourceError> for SyncError {
    fn from(error: SourceError) -> Self {
        Self::Source(error)
    }
}
impl From<AuthError> for SyncError {
    fn from(error: AuthError) -> Self {
        Self::Authorization(error)
    }
}
impl From<MappingError> for SyncError {
    fn from(error: MappingError) -> Self {
        Self::Mapping(error)
    }
}
impl From<world_protocol::sources::MappingFailure> for SyncError {
    fn from(error: world_protocol::sources::MappingFailure) -> Self {
        Self::Mapping(error.into())
    }
}
impl From<content::Error> for SyncError {
    fn from(error: content::Error) -> Self {
        Self::Content(error)
    }
}
impl From<facts::assertions::Error> for SyncError {
    fn from(error: facts::assertions::Error) -> Self {
        Self::Fact(error)
    }
}
impl From<IdentityError> for SyncError {
    fn from(error: IdentityError) -> Self {
        Self::Identity(error)
    }
}
impl From<TransactionError<Self>> for SyncError {
    fn from(error: TransactionError<Self>) -> Self {
        match error {
            TransactionError::NotCommitted { error, cleanup } => match cleanup {
                None => error,
                Some(cleanup) => Self::Rollback {
                    error: Box::new(error),
                    cleanup,
                },
            },
            TransactionError::Indeterminate(error) => Self::Indeterminate(error),
        }
    }
}
impl From<foundation::pipeline::PipelineError> for SyncError {
    fn from(error: foundation::pipeline::PipelineError) -> Self {
        let failure = if matches!(&error, foundation::pipeline::PipelineError::Cancelled) {
            SourceFailure::Cancelled
        } else {
            SourceFailure::InternalFault
        };
        Self::caused(failure, FailureStage::Execute, error)
    }
}
impl From<SyncError> for crate::owner::Error {
    fn from(error: SyncError) -> Self {
        use world_protocol::{api::ApiFailure, failure::Recovery, operation::OperationFailure};
        match error {
            SyncError::Store(error) | SyncError::Indeterminate(error) => error.into(),
            SyncError::Authorization(error) => error.into(),
            SyncError::Content(error) => error.into(),
            SyncError::Owner(error) => error,
            SyncError::Fact(error) => error.into(),
            SyncError::Rollback { error, cleanup } => Self::from(*error).with_cleanup(cleanup),
            SyncError::Cleanup { error, cleanup } => {
                Self::from(*error).with_related(Self::from(SyncError::Source(cleanup)))
            }
            SyncError::Source(error) => Self::new(
                "world.source_sync_failed",
                error.stage,
                "来源同步未完成。",
                ApiFailure::Operation(OperationFailure::Source(error.failure.clone())),
                Recovery::ManualReview,
            )
            .caused(error),
            SyncError::Mapping(MappingError::Mapping(failure)) => Self::new(
                "world.source_mapping_failed",
                FailureStage::Validate,
                "来源映射未通过校验。",
                ApiFailure::Operation(OperationFailure::Mapping(failure)),
                Recovery::Refresh,
            ),
            SyncError::Mapping(MappingError::Store(error)) => error.into(),
            SyncError::Mapping(MappingError::Authorization(error)) => error.into(),
            SyncError::Mapping(MappingError::Release(error)) => (*error).into(),
            SyncError::Mapping(MappingError::Definition(error)) => {
                Self::internal(FailureStage::Compile).caused(error)
            }
            SyncError::Identity(IdentityError::Store(error)) => error.into(),
            SyncError::Identity(IdentityError::Fact(error)) => error.into(),
            SyncError::Identity(error @ IdentityError::Rejected(_)) => {
                let IdentityError::Rejected(failure) = &error else {
                    unreachable!()
                };
                Self::new(
                    "world.source_identity_rejected",
                    FailureStage::Admission,
                    "来源记录身份未通过校验。",
                    ApiFailure::Operation(OperationFailure::Identity(failure.clone())),
                    Recovery::ManualReview,
                )
                .caused(error)
            }
        }
    }
}
impl fmt::Display for SyncError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(if matches!(self, Self::Indeterminate(_)) {
            "world.source_commit_indeterminate"
        } else {
            "world.source_sync_failed"
        })
    }
}
impl fmt::Debug for SyncError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}
impl Error for SyncError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(match self {
            Self::Source(error) => error,
            Self::Store(error) | Self::Indeterminate(error) => error,
            Self::Authorization(error) => error,
            Self::Mapping(error) => error,
            Self::Content(error) => error,
            Self::Fact(error) => error,
            Self::Identity(error) => error,
            Self::Owner(error) => error,
            Self::Rollback { error, .. } | Self::Cleanup { error, .. } => error.as_ref(),
        })
    }
}
