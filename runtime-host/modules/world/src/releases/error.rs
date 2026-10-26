use std::{error::Error as StdError, fmt};

#[derive(Debug)]
pub(crate) enum Error {
    Rejected(world_protocol::releases::ReleaseFailure),
    Compile(world_protocol::compiler::CompileFailure),
    Definition(world_protocol::definitions::DefinitionFailure),
    Store(crate::store::StoreError),
    Authorization(crate::authorization::AuthError),
    Content(crate::content::Error),
    Binding(crate::extensions::bindings::BindingError),
    Package(crate::extensions::package::PackageError),
    Codec(serde_json::Error),
    Learning(Box<crate::learning::Error>),
    Evaluation(Box<crate::evaluation::Error>),
    Sync(crate::sources::sync::SyncError),
    Fact(crate::facts::assertions::Error),
    Query(Box<crate::query::QueryError>),
    Cleanup {
        failure: Box<Error>,
        cleanup: Vec<crate::content::Error>,
    },
}

macro_rules! convert {
    ($source:ty, $variant:ident) => {
        impl From<$source> for Error {
            fn from(error: $source) -> Self {
                Self::$variant(error)
            }
        }
    };
}
convert!(world_protocol::releases::ReleaseFailure, Rejected);
convert!(world_protocol::compiler::CompileFailure, Compile);
convert!(world_protocol::definitions::DefinitionFailure, Definition);
convert!(crate::store::StoreError, Store);
convert!(crate::authorization::AuthError, Authorization);
convert!(crate::content::Error, Content);
convert!(crate::extensions::bindings::BindingError, Binding);
convert!(crate::extensions::package::PackageError, Package);
convert!(serde_json::Error, Codec);
convert!(crate::sources::sync::SyncError, Sync);
convert!(crate::facts::assertions::Error, Fact);
impl From<crate::definitions::DefinitionError> for Error {
    fn from(error: crate::definitions::DefinitionError) -> Self {
        match error {
            crate::definitions::DefinitionError::Rejected(failure) => Self::Definition(failure),
            crate::definitions::DefinitionError::Compile(failure) => Self::Compile(failure),
            crate::definitions::DefinitionError::Store(error) => Self::Store(error),
            crate::definitions::DefinitionError::Codec(error) => Self::Codec(error),
        }
    }
}
impl From<crate::query::QueryError> for Error {
    fn from(error: crate::query::QueryError) -> Self {
        Self::Query(Box::new(error))
    }
}
impl From<crate::learning::Error> for Error {
    fn from(error: crate::learning::Error) -> Self {
        Self::Learning(Box::new(error))
    }
}
impl From<crate::evaluation::Error> for Error {
    fn from(error: crate::evaluation::Error) -> Self {
        Self::Evaluation(Box::new(error))
    }
}

impl Error {
    pub(crate) fn host_failure(&self) -> world_protocol::process::HostFailure {
        use crate::authorization::AuthError;
        use world_protocol::{
            operation::OperationFailure as Operation, process::HostFailure as Host,
        };
        match self {
            Self::Rejected(failure) => Host::Operation(Operation::Release(failure.clone())),
            Self::Compile(failure) => Host::Operation(Operation::Compile(failure.clone())),
            Self::Definition(failure) => Host::Operation(Operation::Definition(failure.clone())),
            Self::Store(error) | Self::Authorization(AuthError::Store(error)) => {
                Host::Operation(Operation::Commit(error.reason.clone()))
            }
            Self::Authorization(AuthError::Denied(failure)) => Host::Authorization(failure.clone()),
            Self::Authorization(AuthError::Codec(_)) | Self::Codec(_) => Host::InternalFault,
            Self::Content(crate::content::Error::Material { reason, .. }) => {
                Host::Operation(Operation::Material(reason.clone()))
            }
            Self::Content(crate::content::Error::Store(error)) => {
                Host::Operation(Operation::Commit(error.reason.clone()))
            }
            Self::Package(error) => Host::Operation(Operation::Package(error.reason.clone())),
            Self::Binding(error) => error.host_failure(),
            Self::Learning(error) => error.host_failure(),
            Self::Evaluation(error) => error.host_failure(),
            Self::Sync(error) => error.host_failure(),
            Self::Fact(error) => error.host_failure(),
            Self::Query(error) => error.host_failure(),
            Self::Cleanup { failure, .. } => failure.host_failure(),
        }
    }
}

impl From<Error> for crate::owner::Error {
    fn from(error: Error) -> Self {
        use world_protocol::{
            api::ApiFailure,
            failure::{FailureStage, Recovery},
            operation::OperationFailure,
        };
        match error {
            Error::Rejected(failure) => Self::new(
                "world.release_rejected",
                FailureStage::Validate,
                "发布请求未通过校验。",
                ApiFailure::Operation(OperationFailure::Release(failure)),
                Recovery::Refresh,
            ),
            Error::Compile(failure) => Self::new(
                "world.compile_rejected",
                FailureStage::Compile,
                "模型编译未通过。",
                ApiFailure::Operation(OperationFailure::Compile(failure)),
                Recovery::None,
            ),
            Error::Definition(failure) => failure.into(),
            Error::Store(error) => error.into(),
            Error::Authorization(error) => error.into(),
            Error::Content(error) => error.into(),
            Error::Binding(error) => error.into(),
            Error::Package(error) => error.into(),
            Error::Codec(error) => Self::internal(FailureStage::Read).caused(error),
            Error::Learning(error) => (*error).into(),
            Error::Evaluation(error) => (*error).into(),
            Error::Sync(error) => error.into(),
            Error::Fact(error) => error.into(),
            Error::Query(error) => (*error).into(),
            Error::Cleanup { failure, cleanup } => cleanup
                .into_iter()
                .fold(Self::from(*failure), |failure, cleanup| {
                    failure.with_related(cleanup.into())
                }),
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Rejected(_) => formatter.write_str("world.release_rejected"),
            Self::Compile(_) => formatter.write_str("world.release_compile_rejected"),
            Self::Definition(_) => formatter.write_str("world.release_definition_rejected"),
            Self::Store(error) => error.fmt(formatter),
            Self::Authorization(error) => error.fmt(formatter),
            Self::Content(error) => error.fmt(formatter),
            Self::Binding(error) => error.fmt(formatter),
            Self::Package(error) => error.fmt(formatter),
            Self::Codec(_) => formatter.write_str("world.release_codec_fault"),
            Self::Learning(error) => error.fmt(formatter),
            Self::Evaluation(error) => error.fmt(formatter),
            Self::Sync(error) => error.fmt(formatter),
            Self::Fact(error) => error.fmt(formatter),
            Self::Query(error) => error.fmt(formatter),
            Self::Cleanup { .. } => formatter.write_str("world.release_cleanup_failed"),
        }
    }
}
impl StdError for Error {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        match self {
            Self::Store(error) => Some(error),
            Self::Authorization(error) => Some(error),
            Self::Content(error) => Some(error),
            Self::Binding(error) => Some(error),
            Self::Package(error) => Some(error),
            Self::Codec(error) => Some(error),
            Self::Learning(error) => Some(error.as_ref()),
            Self::Evaluation(error) => Some(error.as_ref()),
            Self::Sync(error) => Some(error),
            Self::Fact(error) => Some(error),
            Self::Query(error) => Some(error.as_ref()),
            Self::Cleanup { failure, .. } => Some(failure.as_ref()),
            _ => None,
        }
    }
}
