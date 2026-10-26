use std::{error::Error, fmt};

use world_protocol::{process::HostFailure, state::StateFailure};

use crate::{
    authorization::AuthError,
    extensions::{bindings::BindingError, invocation::CurrentFailure},
    store::{StoreError, TransactionError},
};

#[derive(Debug)]
pub(crate) enum StateError {
    State(StateFailure),
    Cancelled,
    Authorization(AuthError),
    Binding(Box<BindingError>),
    Operation(Box<crate::owner::Error>),
    Store(StoreError),
    Codec(serde_json::Error),
    Content(crate::content::Error),
    Package(crate::extensions::package::PackageError),
    Wasm(Box<crate::extensions::wasm::WasmError>),
    Resource {
        failure: Option<Box<StateError>>,
        cleanup: crate::extensions::invocation::ResourceFailure,
    },
    Join(tokio::sync::oneshot::error::RecvError),
    Cleanup {
        failure: Box<StateError>,
        cleanup: StoreError,
    },
}

impl StateError {
    pub(crate) fn host_failure(&self) -> HostFailure {
        match self {
            Self::State(failure) => HostFailure::State(failure.clone()),
            Self::Cancelled => HostFailure::Cancelled,
            Self::Authorization(AuthError::Denied(failure)) => {
                HostFailure::Authorization(failure.clone())
            }
            Self::Store(error)
            | Self::Authorization(AuthError::Store(error))
            | Self::Content(crate::content::Error::Store(error)) => {
                HostFailure::State(StateFailure::Commit {
                    failure: error.reason.clone(),
                })
            }
            Self::Content(crate::content::Error::Material { reason, .. }) => {
                HostFailure::Operation(world_protocol::operation::OperationFailure::Material(
                    reason.clone(),
                ))
            }
            Self::Binding(error) => error.host_failure(),
            Self::Operation(error) => operation_failure(error),
            Self::Package(error) => HostFailure::Operation(
                world_protocol::operation::OperationFailure::Package(error.reason.clone()),
            ),
            Self::Wasm(error) => error.host_failure(),
            Self::Resource { .. } | Self::Join(_) => {
                HostFailure::Operation(world_protocol::operation::OperationFailure::CleanupFailed)
            }
            Self::Cleanup { failure, .. } => failure.host_failure(),
            _ => HostFailure::InternalFault,
        }
    }
}

fn operation_failure(error: &crate::owner::Error) -> HostFailure {
    use world_protocol::{api::ApiFailure, operation::OperationFailure};
    match &error.safe_failure().details {
        ApiFailure::Input(failure) | ApiFailure::Operation(OperationFailure::Input(failure)) => {
            HostFailure::Input(failure.clone())
        }
        ApiFailure::Authorization(failure)
        | ApiFailure::Operation(OperationFailure::Authorization(failure)) => {
            HostFailure::Authorization(failure.clone())
        }
        ApiFailure::Query(failure) => HostFailure::Query(failure.clone()),
        ApiFailure::Operation(failure) => HostFailure::Operation(failure.clone()),
        _ => HostFailure::InternalFault,
    }
}

impl From<world_protocol::authorization::AuthorizationFailure> for StateError {
    fn from(failure: world_protocol::authorization::AuthorizationFailure) -> Self {
        AuthError::from(failure).into()
    }
}
impl From<StateFailure> for StateError {
    fn from(failure: StateFailure) -> Self {
        Self::State(failure)
    }
}
impl From<AuthError> for StateError {
    fn from(error: AuthError) -> Self {
        Self::Authorization(error)
    }
}
impl From<BindingError> for StateError {
    fn from(error: BindingError) -> Self {
        Self::Binding(Box::new(error))
    }
}
impl From<crate::owner::Error> for StateError {
    fn from(error: crate::owner::Error) -> Self {
        Self::Operation(Box::new(error))
    }
}
impl From<StoreError> for StateError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}
impl From<crate::content::Error> for StateError {
    fn from(error: crate::content::Error) -> Self {
        Self::Content(error)
    }
}
impl From<crate::extensions::package::PackageError> for StateError {
    fn from(error: crate::extensions::package::PackageError) -> Self {
        Self::Package(error)
    }
}
impl From<crate::extensions::wasm::WasmError> for StateError {
    fn from(error: crate::extensions::wasm::WasmError) -> Self {
        Self::Wasm(Box::new(error))
    }
}
impl From<serde_json::Error> for StateError {
    fn from(error: serde_json::Error) -> Self {
        Self::Codec(error)
    }
}
impl From<CurrentFailure> for StateError {
    fn from(error: CurrentFailure) -> Self {
        match error {
            CurrentFailure::Authorization(error) => error.into(),
            CurrentFailure::Binding(error) => BindingError::Binding(error).into(),
            CurrentFailure::Store(error) => error.into(),
            CurrentFailure::Package(error) => error.into(),
        }
    }
}
impl From<TransactionError<StateError>> for StateError {
    fn from(error: TransactionError<StateError>) -> Self {
        match error {
            TransactionError::NotCommitted {
                error,
                cleanup: None,
            } => error,
            TransactionError::NotCommitted {
                error,
                cleanup: Some(cleanup),
            } => Self::Cleanup {
                failure: Box::new(error),
                cleanup,
            },
            TransactionError::Indeterminate(error) => error.into(),
        }
    }
}
impl From<StateError> for crate::owner::Error {
    fn from(error: StateError) -> Self {
        use world_protocol::{
            api::ApiFailure,
            failure::{FailureStage, Recovery},
            operation::OperationFailure,
        };
        match error {
            StateError::State(failure) => Self::new(
                "world.state_rejected",
                FailureStage::Migrate,
                "世界状态请求未完成。",
                ApiFailure::Operation(OperationFailure::State(failure)),
                Recovery::None,
            ),
            StateError::Cancelled => Self::new(
                "world.state_cancelled",
                FailureStage::Migrate,
                "世界状态操作已取消。",
                ApiFailure::Operation(OperationFailure::Cancelled),
                Recovery::None,
            ),
            StateError::Authorization(error) => error.into(),
            StateError::Binding(error) => (*error).into(),
            StateError::Operation(error) => *error,
            StateError::Store(error) => error.into(),
            StateError::Content(error) => error.into(),
            StateError::Package(error) => error.into(),
            StateError::Codec(error) => Self::internal(FailureStage::Migrate).caused(error),
            StateError::Wasm(error) => {
                crate::extensions::lifecycle::LifecycleError::Wasm(*error).into()
            }
            error @ (StateError::Resource { .. } | StateError::Join(_)) => Self::new(
                "world.state_resource_retained",
                FailureStage::Drain,
                "状态迁移资源尚未确认释放。",
                ApiFailure::Operation(OperationFailure::CleanupFailed),
                Recovery::ManualReview,
            )
            .caused(error),
            StateError::Cleanup { failure, cleanup } => Self::from(*failure).with_cleanup(cleanup),
        }
    }
}

impl fmt::Display for StateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("world.state_failed")
    }
}
impl Error for StateError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::State(_) | Self::Cancelled => None,
            Self::Authorization(error) => Some(error),
            Self::Binding(error) => Some(error.as_ref()),
            Self::Operation(error) => Some(error.as_ref()),
            Self::Store(error) => Some(error),
            Self::Codec(error) => Some(error),
            Self::Content(error) => Some(error),
            Self::Package(error) => Some(error),
            Self::Wasm(error) => Some(error.as_ref()),
            Self::Resource { failure, .. } => failure
                .as_deref()
                .map(|error| error as &(dyn Error + 'static)),
            Self::Join(error) => Some(error),
            Self::Cleanup { failure, .. } => Some(failure.as_ref()),
        }
    }
}
