use std::fmt;

use wasm_host::{ExecutionError, InvocationError};
use world_protocol::bindings::BindingFailure;

use crate::extensions::{invocation::AdmissionFailure, package::PackageError};

pub(crate) enum WasmError {
    ArtifactMismatch,
    ConfigurationMismatch,
    EntrypointUnsupported,
    Cancelled,
    LeaseMismatch,
    InvalidData {
        field: &'static str,
    },
    Component(world_protocol::component::ComponentFailure),
    Proposal(crate::facts::assertions::Error),
    Binding(BindingFailure),
    Admission(AdmissionFailure),
    Package(PackageError),
    Execution(ExecutionError),
    Invocation(InvocationError),
    Current(crate::extensions::invocation::CurrentFailure),
    Authorization(crate::authorization::AuthError),
    Budget(crate::extensions::invocation::BudgetFailure),
    Lease(crate::extensions::invocation::LeaseFailure),
    Cleanup(crate::extensions::invocation::ResourceFailure),
    Release {
        primary: Option<Box<WasmError>>,
        cleanup: crate::extensions::invocation::ResourceFailure,
    },
    Join(tokio::sync::oneshot::error::RecvError),
    Meter(serde_json::Error),
    Schema(world_protocol::schema::SchemaFailure),
    HostCall(world_protocol::failure::Failure<world_protocol::process::HostFailure>),
    Store(crate::store::StoreError),
    HostFailures {
        primary: Box<WasmError>,
        host_failures: Vec<crate::extensions::host_calls::HostCallFailure>,
    },
    Accounting {
        primary: Box<WasmError>,
        failure: Box<WasmError>,
    },
}

impl From<world_protocol::component::ComponentFailure> for WasmError {
    fn from(error: world_protocol::component::ComponentFailure) -> Self {
        Self::Component(error)
    }
}
impl From<ExecutionError> for WasmError {
    fn from(error: ExecutionError) -> Self {
        Self::Execution(error)
    }
}
impl From<PackageError> for WasmError {
    fn from(error: PackageError) -> Self {
        Self::Package(error)
    }
}
impl From<BindingFailure> for WasmError {
    fn from(error: BindingFailure) -> Self {
        Self::Binding(error)
    }
}
impl From<AdmissionFailure> for WasmError {
    fn from(error: AdmissionFailure) -> Self {
        Self::Admission(error)
    }
}

impl From<crate::extensions::invocation::CurrentFailure> for WasmError {
    fn from(error: crate::extensions::invocation::CurrentFailure) -> Self {
        Self::Current(error)
    }
}
impl From<crate::authorization::AuthError> for WasmError {
    fn from(error: crate::authorization::AuthError) -> Self {
        Self::Authorization(error)
    }
}
impl From<crate::extensions::invocation::BudgetFailure> for WasmError {
    fn from(error: crate::extensions::invocation::BudgetFailure) -> Self {
        Self::Budget(error)
    }
}
impl From<crate::extensions::invocation::LeaseFailure> for WasmError {
    fn from(error: crate::extensions::invocation::LeaseFailure) -> Self {
        Self::Lease(error)
    }
}

impl From<crate::store::StoreError> for WasmError {
    fn from(error: crate::store::StoreError) -> Self {
        Self::Store(error)
    }
}

impl fmt::Debug for WasmError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ArtifactMismatch => f.write_str("ArtifactMismatch"),
            Self::ConfigurationMismatch => f.write_str("ConfigurationMismatch"),
            Self::EntrypointUnsupported => f.write_str("EntrypointUnsupported"),
            Self::Cancelled => f.write_str("Cancelled"),
            Self::LeaseMismatch => f.write_str("LeaseMismatch"),
            Self::InvalidData { field } => f.debug_tuple("InvalidData").field(field).finish(),
            Self::Component(error) => f.debug_tuple("Component").field(error).finish(),
            Self::Proposal(error) => f.debug_tuple("Proposal").field(error).finish(),
            Self::Binding(error) => f.debug_tuple("Binding").field(error).finish(),
            Self::Admission(error) => f.debug_tuple("Admission").field(error).finish(),
            Self::Package(error) => f.debug_tuple("Package").field(error).finish(),
            Self::Execution(error) => f.debug_tuple("Execution").field(error).finish(),
            Self::Invocation(error) => f.debug_tuple("Invocation").field(error).finish(),
            Self::Current(error) => f.debug_tuple("Current").field(error).finish(),
            Self::Authorization(_) => f.write_str("Authorization"),
            Self::Budget(error) => f.debug_tuple("Budget").field(&error.dimension).finish(),
            Self::Lease(error) => f.debug_tuple("Lease").field(error).finish(),
            Self::Cleanup(error) => f.debug_tuple("Cleanup").field(error).finish(),
            Self::Release { primary, cleanup } => f
                .debug_struct("Release")
                .field("primary", primary)
                .field("cleanup", cleanup)
                .finish(),
            Self::Join(_) => f.write_str("Join"),
            Self::Meter(_) => f.write_str("Meter"),
            Self::Schema(_) => f.write_str("Schema"),
            Self::HostCall(failure) => f.debug_tuple("HostCall").field(&failure.details).finish(),
            Self::Store(error) => f.debug_tuple("Store").field(error).finish(),
            Self::HostFailures {
                primary,
                host_failures,
            } => f
                .debug_struct("HostFailures")
                .field("primary", primary)
                .field("count", &host_failures.len())
                .finish(),
            Self::Accounting { primary, failure } => f
                .debug_struct("Accounting")
                .field("primary", primary)
                .field("failure", failure)
                .finish(),
        }
    }
}
impl fmt::Display for WasmError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("world wasm execution failed")
    }
}
impl std::error::Error for WasmError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Proposal(error) => Some(error),
            Self::Package(error) => Some(error),
            Self::Execution(error) => Some(error),
            Self::Invocation(error) => Some(error),
            Self::Authorization(error) => Some(error),
            Self::Store(error) => Some(error),
            Self::Join(error) => Some(error),
            Self::Meter(error) => Some(error),
            Self::HostFailures { primary, .. } | Self::Accounting { primary, .. } => {
                Some(primary.as_ref())
            }
            Self::Release {
                primary: Some(primary),
                ..
            } => Some(primary.as_ref()),
            _ => None,
        }
    }
}

impl WasmError {
    pub(crate) fn host_failure(&self) -> world_protocol::process::HostFailure {
        use crate::extensions::invocation::LeaseFailure;
        use world_protocol::{
            component::ComponentFailure, operation::OperationFailure as O,
            process::HostFailure as H,
        };
        match self {
            Self::ArtifactMismatch => invalid("artifact_mismatch"),
            Self::ConfigurationMismatch => invalid("configuration_mismatch"),
            Self::EntrypointUnsupported => invalid("entrypoint_unsupported"),
            Self::Cancelled => H::Cancelled,
            Self::LeaseMismatch => H::Authorization(
                world_protocol::authorization::AuthorizationFailure::InsufficientScope,
            ),
            Self::InvalidData { field } => invalid(field),
            Self::Component(failure) => match failure {
                ComponentFailure::NodeLimit => limit(
                    world_protocol::failure::InputLimit::Items,
                    world_protocol::component::MAX_NODES,
                ),
                ComponentFailure::DepthLimit => limit(
                    world_protocol::failure::InputLimit::Depth,
                    world_protocol::component::MAX_DEPTH,
                ),
                ComponentFailure::InvalidRoot => invalid("component.invalid_root"),
                ComponentFailure::InvalidIndex { .. } => invalid("component.invalid_index"),
                ComponentFailure::NonCanonicalTree { .. } => invalid("component.noncanonical_tree"),
                ComponentFailure::DuplicateField { .. } => invalid("component.duplicate_field"),
                ComponentFailure::InvalidScalar { .. } => invalid("component.invalid_scalar"),
            },
            Self::Proposal(error) => H::Operation(O::Fact(error.reason.clone())),
            Self::Binding(failure) => H::Binding(failure.clone()),
            Self::Admission(failure) => LeaseFailure::Admission(failure.clone()).host_failure(),
            Self::Package(error) => H::Operation(O::Package(
                error
                    .public(world_protocol::failure::FailureStage::Execute, None)
                    .details,
            )),
            Self::Execution(error) => execution_failure(error),
            Self::Invocation(error) => error
                .cleanup
                .as_ref()
                .or(error.execution.as_ref())
                .map_or(H::InternalFault, execution_failure),
            Self::Current(failure) => failure.host_failure(),
            Self::Authorization(error) => auth_failure(error),
            Self::Budget(error) => H::BudgetExceeded {
                dimension: error.dimension,
            },
            Self::Lease(error) => error.host_failure(),
            Self::Cleanup(_) | Self::Release { .. } => H::Operation(O::CleanupFailed),
            Self::Join(_) => invalid("task_join"),
            Self::Meter(_) => invalid("protocol_meter"),
            Self::Schema(_) => invalid("contract_schema"),
            Self::HostCall(failure) => failure.details.clone(),
            Self::Store(error) => H::Operation(O::Commit(error.reason.clone())),
            Self::HostFailures { primary, .. } | Self::Accounting { primary, .. } => {
                primary.host_failure()
            }
        }
    }
}

fn invalid(field: &str) -> world_protocol::process::HostFailure {
    world_protocol::process::HostFailure::Input(
        world_protocol::failure::InputFailure::InvalidValue {
            field: world_protocol::failure::FieldPath(vec!["wasm".into(), field.into()]),
        },
    )
}
fn limit(
    limit: world_protocol::failure::InputLimit,
    maximum: usize,
) -> world_protocol::process::HostFailure {
    world_protocol::process::HostFailure::Input(
        world_protocol::failure::InputFailure::LimitExceeded {
            limit,
            maximum: maximum as u64,
        },
    )
}

fn auth_failure(error: &crate::authorization::AuthError) -> world_protocol::process::HostFailure {
    use crate::authorization::AuthError;
    use world_protocol::{operation::OperationFailure, process::HostFailure};
    match error {
        AuthError::Denied(failure) => HostFailure::Authorization(failure.clone()),
        AuthError::Store(error) => {
            HostFailure::Operation(OperationFailure::Commit(error.reason.clone()))
        }
        AuthError::Codec(_) => HostFailure::InternalFault,
    }
}
fn execution_failure(error: &ExecutionError) -> world_protocol::process::HostFailure {
    use wasm_host::FailureKind;
    use world_protocol::{
        budget::BudgetDimension, operation::OperationFailure, process::HostFailure,
    };
    if let Some(cause) = error.cause() {
        if let Some(error) = cause.downcast_ref::<WasmError>() {
            return error.host_failure();
        }
        if let Some(error) = cause.downcast_ref::<ExecutionError>() {
            return execution_failure(error);
        }
        if let Some(error) = cause.downcast_ref::<crate::extensions::host_calls::HostCallFailure>()
        {
            return error.details().clone();
        }
    }
    match error.kind() {
        FailureKind::Cancelled | FailureKind::HostIoCancelled => HostFailure::Cancelled,
        FailureKind::FuelExhausted => HostFailure::BudgetExceeded {
            dimension: BudgetDimension::Steps,
        },
        FailureKind::EpochInterrupted
        | FailureKind::GuestDeadline
        | FailureKind::HostIoDeadline => HostFailure::BudgetExceeded {
            dimension: BudgetDimension::Deadline,
        },
        FailureKind::Cleanup => HostFailure::Operation(OperationFailure::CleanupFailed),
        FailureKind::ResourceExceeded {
            resource,
            limit: maximum,
            ..
        } => {
            use wasm_host::Resource;
            use world_protocol::failure::InputLimit;
            limit(
                match resource {
                    Resource::ArtifactBytes | Resource::MemoryBytes | Resource::OutputBytes => {
                        InputLimit::Bytes
                    }
                    Resource::Memories
                    | Resource::TableElements
                    | Resource::Tables
                    | Resource::HostResources
                    | Resource::ComponentHandles => InputLimit::Items,
                },
                maximum,
            )
        }
        FailureKind::EngineConfiguration => invalid("engine_configuration"),
        FailureKind::InvalidLimit => invalid("execution_limit"),
        FailureKind::DigestMismatch => invalid("digest_mismatch"),
        FailureKind::NotComponentBinary => invalid("not_component_binary"),
        FailureKind::CompileBusy => invalid("compile_busy"),
        FailureKind::Compilation => invalid("compilation"),
        FailureKind::EngineMismatch => invalid("engine_mismatch"),
        FailureKind::Linking => invalid("linking"),
        FailureKind::StoreConfiguration => invalid("store_configuration"),
        FailureKind::Instantiation => invalid("instantiation"),
        FailureKind::GuestTrap(_) => invalid("guest_trap"),
        FailureKind::ComponentAbi => invalid("component_abi"),
        FailureKind::Allocation => invalid("allocation"),
        FailureKind::HostCall => invalid("host_call"),
        FailureKind::CachePoisoned => invalid("cache_poisoned"),
    }
}
