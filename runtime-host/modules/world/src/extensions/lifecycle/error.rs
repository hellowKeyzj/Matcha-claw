use world_protocol::{
    ids::{InstallId, NodeId},
    lifecycle::LifecycleFailure,
};

use crate::store::StoreError;

#[derive(Debug)]
pub(crate) enum LifecycleError {
    Store(StoreError),
    Binding(crate::extensions::bindings::BindingError),
    Contract(LifecycleFailure),
    MissingInstall(InstallId),
    MissingConfiguration(InstallId),
    MissingTrust(InstallId),
    InvalidPersistedState,
    EndpointMismatch(NodeId),
    DuplicateGeneration,
    AlreadyPrepared,
    Retiring,
    Cancelled,
    Deadline,
    PreparationTask(tokio::task::JoinError),
    Gate(crate::extensions::bindings::GateFailure),
    RecoveryBlocked {
        node: NodeId,
        reason: super::RecoveryBlock,
    },
    PrepareNode {
        node: NodeId,
        cause: Box<LifecycleError>,
    },
    Cleanup {
        cause: Box<LifecycleError>,
        remaining_resources: Vec<world_protocol::lifecycle::RetainedResource>,
    },
    Package(crate::extensions::package::PackageError),
    Wasm(crate::extensions::wasm::WasmError),
    Process(std::sync::Arc<crate::extensions::process::ProcessError>),
    Source(crate::sources::connectors::SourceError),
    Native {
        node: NodeId,
        cause: crate::extensions::invocation::NativePrepareFailure,
    },
}

impl LifecycleError {
    pub(crate) fn host_failure(&self) -> world_protocol::process::HostFailure {
        use world_protocol::{operation::OperationFailure, process::HostFailure};
        let lifecycle = match self {
            Self::Cancelled => return HostFailure::Cancelled,
            Self::Deadline => {
                return HostFailure::BudgetExceeded {
                    dimension: world_protocol::budget::BudgetDimension::Deadline,
                };
            }
            Self::PreparationTask(_) => return HostFailure::InternalFault,
            Self::Store(error) => {
                return HostFailure::Operation(OperationFailure::Commit(error.reason.clone()));
            }
            Self::Binding(error) => return error.host_failure(),
            Self::Gate(error) => {
                return crate::extensions::bindings::BindingError::Gate(error.clone())
                    .host_failure();
            }
            Self::Package(error) => {
                return HostFailure::Operation(OperationFailure::Package(error.reason.clone()));
            }
            Self::Source(error) => return HostFailure::Source(error.failure.clone()),
            Self::Wasm(error) => return error.host_failure(),
            Self::Process(error) => return error.host_failure(),
            Self::Native { node, cause } => {
                use crate::extensions::invocation::NativePrepareFailure;
                let reason = match cause {
                    NativePrepareFailure::Configuration => world_protocol::bindings::BindingFailure::ConfigurationChanged { node_id: node.clone() },
                    NativePrepareFailure::Entrypoint => world_protocol::bindings::BindingFailure::TrustBoundary { node_id: node.clone() },
                    NativePrepareFailure::Artifact => world_protocol::bindings::BindingFailure::DigestMismatch,
                    NativePrepareFailure::Implementation => return HostFailure::Operation(OperationFailure::Lifecycle(
                        LifecycleFailure::PrepareFailed { node_id: node.clone() },
                    )),
                };
                return HostFailure::Binding(reason);
            }
            Self::PrepareNode { cause, .. } => return cause.host_failure(),
            Self::Cleanup {
                remaining_resources,
                ..
            } => LifecycleFailure::Retained {
                stage: world_protocol::lifecycle::LifecycleStage::Cleanup,
                remaining_resources: remaining_resources.clone(),
            },
            Self::Contract(reason) => reason.clone(),
            Self::MissingInstall(install_id) => LifecycleFailure::MissingInstall {
                install_id: install_id.clone(),
            },
            Self::MissingConfiguration(install_id) => LifecycleFailure::MissingConfiguration {
                install_id: install_id.clone(),
            },
            Self::MissingTrust(install_id) => LifecycleFailure::MissingTrust {
                install_id: install_id.clone(),
            },
            Self::InvalidPersistedState | Self::DuplicateGeneration => {
                LifecycleFailure::InvalidPersistedState
            }
            Self::EndpointMismatch(node_id) => LifecycleFailure::PrepareFailed {
                node_id: node_id.clone(),
            },
            Self::AlreadyPrepared => LifecycleFailure::AlreadyPrepared,
            Self::Retiring => LifecycleFailure::AcquisitionClosed,
            Self::RecoveryBlocked { node, reason } => match reason {
                super::RecoveryBlock::MissingNode | super::RecoveryBlock::MissingPackage => {
                    LifecycleFailure::DependencyMissing {
                        node_id: node.clone(),
                    }
                }
                super::RecoveryBlock::Disabled | super::RecoveryBlock::PendingRemoval => {
                    LifecycleFailure::AcquisitionClosed
                }
                super::RecoveryBlock::Quarantined | super::RecoveryBlock::Untrusted => {
                    LifecycleFailure::AuthorizationRevoked
                }
                super::RecoveryBlock::Configuration => LifecycleFailure::PrepareFailed {
                    node_id: node.clone(),
                },
                super::RecoveryBlock::InvalidInventory => LifecycleFailure::InvalidPersistedState,
            },
        };
        HostFailure::Operation(OperationFailure::Lifecycle(lifecycle))
    }
}

impl From<crate::extensions::bindings::BindingError> for LifecycleError {
    fn from(error: crate::extensions::bindings::BindingError) -> Self {
        Self::Binding(error)
    }
}

impl From<StoreError> for LifecycleError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

impl std::fmt::Display for LifecycleError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("world.lifecycle_failed")
    }
}
impl std::error::Error for LifecycleError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Store(error) => Some(error),
            Self::Binding(error) => Some(error),
            Self::Package(error) => Some(error),
            Self::Wasm(error) => Some(error),
            Self::Process(error) => Some(error.as_ref()),
            Self::Source(error) => Some(error),
            Self::PreparationTask(error) => Some(error),
            Self::PrepareNode { cause, .. } | Self::Cleanup { cause, .. } => Some(cause.as_ref()),
            _ => None,
        }
    }
}

impl From<LifecycleError> for crate::owner::Error {
    fn from(error: LifecycleError) -> Self {
        use world_protocol::{
            api::ApiFailure,
            failure::{FailureStage, Recovery},
            operation::OperationFailure,
        };
        let (reason, stage, recovery) = match error {
            LifecycleError::Store(error) => return error.into(),
            LifecycleError::Binding(error) => return error.into(),
            LifecycleError::Package(error) => return error.into(),
            LifecycleError::Gate(error) => {
                return crate::extensions::bindings::BindingError::Gate(error).into();
            }
            LifecycleError::Source(error) => {
                return Self::new(
                    "world.source_prepare_failed",
                    error.stage,
                    "源插件准备失败。",
                    ApiFailure::Operation(OperationFailure::Source(error.failure.clone())),
                    Recovery::None,
                )
                .caused(error);
            }
            LifecycleError::Contract(reason) => {
                let recovery = match &reason {
                    LifecycleFailure::Retained { .. } => Recovery::ManualReview,
                    LifecycleFailure::Commit {
                        failure:
                            world_protocol::commit::CommitFailure::CommitIndeterminate { commit_id },
                    } => Recovery::ReadCommit {
                        commit_id: commit_id.clone(),
                    },
                    LifecycleFailure::RevisionConflict { .. } => Recovery::Refresh,
                    _ => Recovery::None,
                };
                (reason, FailureStage::Prepare, recovery)
            }
            LifecycleError::MissingInstall(install_id) => (
                LifecycleFailure::MissingInstall { install_id },
                FailureStage::Prepare,
                Recovery::Refresh,
            ),
            LifecycleError::MissingConfiguration(install_id) => (
                LifecycleFailure::MissingConfiguration { install_id },
                FailureStage::Prepare,
                Recovery::Refresh,
            ),
            LifecycleError::MissingTrust(install_id) => (
                LifecycleFailure::MissingTrust { install_id },
                FailureStage::Prepare,
                Recovery::Refresh,
            ),
            LifecycleError::EndpointMismatch(node_id) => (
                LifecycleFailure::PrepareFailed { node_id },
                FailureStage::Prepare,
                Recovery::None,
            ),
            LifecycleError::Cleanup {
                cause,
                remaining_resources,
            } => {
                let cause = Self::from(*cause);
                return Self::new(
                    "world.extension_cleanup_retained",
                    FailureStage::Drain,
                    "插件资源未排空，保留资源托管以继续回收。",
                    ApiFailure::Operation(OperationFailure::Lifecycle(
                        LifecycleFailure::Retained {
                            stage: world_protocol::lifecycle::LifecycleStage::Cleanup,
                            remaining_resources,
                        },
                    )),
                    Recovery::ManualReview,
                )
                .caused(cause.clone())
                .with_related(cause);
            }
            LifecycleError::PrepareNode { cause, .. } => return Self::from(*cause),
            LifecycleError::RecoveryBlocked { node, reason } => {
                let failure = match reason {
                    super::RecoveryBlock::MissingNode | super::RecoveryBlock::MissingPackage => {
                        LifecycleFailure::DependencyMissing { node_id: node }
                    }
                    super::RecoveryBlock::Disabled | super::RecoveryBlock::PendingRemoval => {
                        LifecycleFailure::AcquisitionClosed
                    }
                    super::RecoveryBlock::Quarantined | super::RecoveryBlock::Untrusted => {
                        LifecycleFailure::AuthorizationRevoked
                    }
                    super::RecoveryBlock::Configuration => {
                        LifecycleFailure::PrepareFailed { node_id: node }
                    }
                    super::RecoveryBlock::InvalidInventory => {
                        LifecycleFailure::InvalidPersistedState
                    }
                };
                (failure, FailureStage::Recover, Recovery::Refresh)
            }
            LifecycleError::InvalidPersistedState | LifecycleError::DuplicateGeneration => (
                LifecycleFailure::InvalidPersistedState,
                FailureStage::Recover,
                Recovery::ManualReview,
            ),
            LifecycleError::AlreadyPrepared => (
                LifecycleFailure::AlreadyPrepared,
                FailureStage::Prepare,
                Recovery::None,
            ),
            LifecycleError::Retiring => (
                LifecycleFailure::AcquisitionClosed,
                FailureStage::Drain,
                Recovery::None,
            ),
            error @ (LifecycleError::Wasm(_)
            | LifecycleError::Process(_)
            | LifecycleError::Native { .. }
            | LifecycleError::Cancelled
            | LifecycleError::Deadline
            | LifecycleError::PreparationTask(_)) => {
                return Self::from_host_failure(error.host_failure(), FailureStage::Prepare)
                    .caused(error);
            }
        };
        Self::new(
            "world.lifecycle_rejected",
            stage,
            "插件生命周期请求未完成。",
            ApiFailure::Operation(OperationFailure::Lifecycle(reason)),
            recovery,
        )
    }
}
