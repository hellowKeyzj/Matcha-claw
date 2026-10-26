use std::{error::Error, fmt};

use world_protocol::{bindings::BindingFailure, package::PackageFailure, state::StateFailure};

use crate::{authorization::AuthError, store::StoreError};
use super::GateFailure;

#[derive(Debug)]
pub(crate) enum BindingError {
    Binding(BindingFailure),
    Package(PackageFailure),
    PackageOperation(crate::extensions::package::PackageError),
    Release(Box<crate::releases::Error>),
    Lifecycle(Box<crate::extensions::lifecycle::LifecycleError>),
    State(StateFailure),
    StateOwner(Box<crate::extensions::migration::StateError>),
    Authorization(AuthError),
    Operation(crate::owner::Error),
    Store(StoreError),
    Gate(GateFailure),
    Cleanup { failure: Box<BindingError>, cleanup: StoreError },
}

impl BindingError {
    pub(super) fn commit_unresolved(self, commit_id: &world_protocol::ids::CommitId) -> Self {
        StoreError::caused_by(world_protocol::commit::CommitFailure::CommitIndeterminate { commit_id: commit_id.clone() },
            world_protocol::failure::FailureStage::Recover, self).into()
    }

    pub(crate) fn host_failure(&self) -> world_protocol::process::HostFailure {
        use world_protocol::{api::ApiFailure, bindings::PublicationConflictReason, operation::OperationFailure, process::HostFailure};
        match self {
            Self::Binding(reason) => HostFailure::Binding(reason.clone()),
            Self::Package(reason) => HostFailure::Operation(OperationFailure::Package(reason.clone())),
            Self::PackageOperation(error) => HostFailure::Operation(OperationFailure::Package(error.reason.clone())),
            Self::State(reason) => HostFailure::State(reason.clone()),
            Self::StateOwner(error) => error.host_failure(),
            Self::Release(error) => error.host_failure(),
            Self::Lifecycle(error) => error.host_failure(),
            Self::Authorization(AuthError::Denied(reason)) => HostFailure::Authorization(reason.clone()),
            Self::Store(error) | Self::Authorization(AuthError::Store(error)) =>
                HostFailure::Operation(OperationFailure::Commit(error.reason.clone())),
            Self::Authorization(AuthError::Codec(_)) => HostFailure::InternalFault,
            Self::Operation(error) => match &error.safe_failure().details {
                ApiFailure::Input(reason) => HostFailure::Input(reason.clone()),
                ApiFailure::Authorization(reason) => HostFailure::Authorization(reason.clone()),
                ApiFailure::Release(reason) => HostFailure::Operation(OperationFailure::Release(reason.clone())),
                ApiFailure::Query(reason) => HostFailure::Query(reason.clone()),
                ApiFailure::Operation(reason) => HostFailure::Operation(reason.clone()),
                _ => HostFailure::InternalFault,
            },
            Self::Gate(GateFailure::Publishing { commit_id } | GateFailure::Indeterminate { commit_id }) =>
                HostFailure::Binding(BindingFailure::Commit { failure:
                    world_protocol::commit::CommitFailure::CommitIndeterminate { commit_id: commit_id.clone() } }),
            Self::Gate(GateFailure::EmptyScope) => HostFailure::Binding(BindingFailure::PublicationConflict {
                reason: PublicationConflictReason::EmptyScope,
            }),
            Self::Gate(GateFailure::ResolutionMismatch) => HostFailure::Binding(BindingFailure::PublicationConflict {
                reason: PublicationConflictReason::ResolutionMismatch,
            }),
            Self::Gate(GateFailure::RollbackUnproven) => HostFailure::Binding(BindingFailure::PublicationConflict {
                reason: PublicationConflictReason::RollbackUnproven,
            }),
            Self::Cleanup { failure, .. } => failure.host_failure(),
        }
    }
}

impl From<BindingFailure> for BindingError {
    fn from(reason: BindingFailure) -> Self { Self::Binding(reason) }
}
impl From<PackageFailure> for BindingError {
    fn from(reason: PackageFailure) -> Self { Self::Package(reason) }
}
impl From<crate::extensions::package::PackageError> for BindingError {
    fn from(error: crate::extensions::package::PackageError) -> Self { Self::PackageOperation(error) }
}
impl From<crate::releases::Error> for BindingError {
    fn from(error: crate::releases::Error) -> Self { Self::Release(Box::new(error)) }
}
impl From<crate::extensions::lifecycle::LifecycleError> for BindingError {
    fn from(error: crate::extensions::lifecycle::LifecycleError) -> Self { Self::Lifecycle(Box::new(error)) }
}
impl From<crate::extensions::migration::StateError> for BindingError {
    fn from(error: crate::extensions::migration::StateError) -> Self { Self::StateOwner(Box::new(error)) }
}
impl From<StateFailure> for BindingError {
    fn from(reason: StateFailure) -> Self { Self::State(reason) }
}
impl From<AuthError> for BindingError {
    fn from(error: AuthError) -> Self { Self::Authorization(error) }
}
impl From<crate::owner::Error> for BindingError {
    fn from(error: crate::owner::Error) -> Self { Self::Operation(error) }
}
impl From<StoreError> for BindingError {
    fn from(error: StoreError) -> Self { Self::Store(error) }
}
impl From<GateFailure> for BindingError {
    fn from(error: GateFailure) -> Self { Self::Gate(error) }
}
impl From<BindingError> for crate::owner::Error {
    fn from(error: BindingError) -> Self {
        use world_protocol::{api::ApiFailure, failure::{FailureStage, Recovery}, operation::OperationFailure};
        match error {
            BindingError::Binding(reason) => {
                let recovery = match &reason {
                    BindingFailure::Commit { failure: world_protocol::commit::CommitFailure::CommitIndeterminate { commit_id } } =>
                        Recovery::ReadCommit { commit_id: commit_id.clone() },
                    BindingFailure::HeadConflict { .. } => Recovery::Refresh,
                    BindingFailure::MissingRequiredProvider { contract, .. } =>
                        Recovery::SupplyDependency { contract_id: contract.id.clone() },
                    _ => Recovery::None,
                };
                Self::new("world.binding_rejected", FailureStage::Activate, "绑定图不可发布或执行。",
                    ApiFailure::Operation(OperationFailure::Binding(reason)), recovery)
            }
            BindingError::Package(reason) => Self::new("world.binding_package_rejected", FailureStage::Prepare,
                "绑定引用的插件包不满足要求。", ApiFailure::Operation(OperationFailure::Package(reason)), Recovery::None),
            BindingError::State(reason) => Self::new("world.binding_state_rejected", FailureStage::Migrate,
                "绑定引用的状态不满足要求。", ApiFailure::Operation(OperationFailure::State(reason)), Recovery::None),
            BindingError::PackageOperation(error) => error.into(),
            BindingError::Release(error) => (*error).into(),
            BindingError::Lifecycle(error) => (*error).into(),
            BindingError::StateOwner(error) => (*error).into(),
            BindingError::Authorization(error) => error.into(),
            BindingError::Operation(error) => error,
            BindingError::Store(error) => error.into(),
            BindingError::Gate(GateFailure::Publishing { commit_id } | GateFailure::Indeterminate { commit_id }) =>
                BindingError::Binding(BindingFailure::Commit { failure:
                    world_protocol::commit::CommitFailure::CommitIndeterminate { commit_id } }).into(),
            BindingError::Gate(GateFailure::EmptyScope) => BindingError::Binding(BindingFailure::PublicationConflict {
                reason: world_protocol::bindings::PublicationConflictReason::EmptyScope,
            }).into(),
            BindingError::Gate(GateFailure::ResolutionMismatch) => BindingError::Binding(BindingFailure::PublicationConflict {
                reason: world_protocol::bindings::PublicationConflictReason::ResolutionMismatch,
            }).into(),
            BindingError::Gate(GateFailure::RollbackUnproven) => BindingError::Binding(BindingFailure::PublicationConflict {
                reason: world_protocol::bindings::PublicationConflictReason::RollbackUnproven,
            }).into(),
            BindingError::Cleanup { failure, cleanup } => Self::from(*failure).with_cleanup(cleanup),
        }
    }
}

impl fmt::Display for BindingError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Store(error) => error.fmt(formatter),
            Self::Authorization(error) => error.fmt(formatter),
            Self::Operation(error) => error.fmt(formatter),
            Self::PackageOperation(error) => error.fmt(formatter),
            Self::Release(error) => error.fmt(formatter),
            Self::Lifecycle(error) => error.fmt(formatter),
            Self::StateOwner(error) => error.fmt(formatter),
            Self::Cleanup { .. } => formatter.write_str("world.binding_cleanup_failed"),
            _ => formatter.write_str("world.binding_failed"),
        }
    }
}
impl Error for BindingError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Store(error) => Some(error),
            Self::Authorization(error) => Some(error),
            Self::Operation(error) => Some(error),
            Self::PackageOperation(error) => Some(error),
            Self::Release(error) => Some(error.as_ref()),
            Self::Lifecycle(error) => Some(error.as_ref()),
            Self::StateOwner(error) => Some(error.as_ref()),
            Self::Cleanup { failure, .. } => Some(failure.as_ref()),
            _ => None,
        }
    }
}
