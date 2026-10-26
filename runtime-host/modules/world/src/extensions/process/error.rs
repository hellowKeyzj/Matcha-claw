use std::{fmt, sync::Arc};

use world_protocol::process::ProcessFailure;

use super::{close::CloseFailure, frame::WireFailure};
use crate::extensions::{
    invocation::{AdmissionFailure, CurrentFailure},
    package::PackageError,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Delivery {
    NotDispatched,
    Attempted,
    Accepted,
    Terminal,
}

/// Private causes never become protocol messages, stderr, argv or configuration diagnostics.
#[derive(Debug)]
pub(crate) enum ProcessError {
    Artifact(PackageError),
    ArtifactMismatch,
    ConfigurationMismatch,
    UnsupportedEntrypoint,
    SandboxUnavailable,
    InvalidLaunch,
    Admission(AdmissionFailure),
    Current(Arc<CurrentFailure>),
    Output(Arc<crate::authorization::AuthError>),
    HostImport(Arc<crate::extensions::host_calls::HostCallFailure>),
    Resource(crate::extensions::invocation::ResourceFailure),
    Cleanup {
        cause: Arc<ProcessError>,
        failure: crate::extensions::invocation::ResourceFailure,
    },
    Call {
        delivery: Delivery,
        observed: Option<Arc<super::call::ProcessOutcome>>,
        received_result: Option<Arc<world_protocol::process::CallResult>>,
        cause: Arc<ProcessError>,
    },
    Budget(world_protocol::budget::BudgetDimension),
    Wire(Arc<WireFailure>),
    Stderr(Arc<std::io::Error>),
    Protocol(ProcessFailure),
    MaterialsInitialization(crate::materials::WorkerFailure),
    Cancelled,
    Deadline,
    CancelNotConfirmed,
    BackpressureTimeout,
    TransportClosed,
    Exited,
    Quarantined,
    Closing,
    StreamsPending,
    Close(Arc<CloseFailure>),
    Launch(Arc<foundation::process::supervision::CompletionError>),
    Supervisor(Arc<foundation::process::supervision::SupervisorFailure>),
}

impl ProcessError {
    pub(crate) fn host_failure(&self) -> world_protocol::process::HostFailure {
        use world_protocol::{
            budget::BudgetDimension, lifecycle::LifecycleFailure, operation::OperationFailure,
            process::HostFailure, wire::CodecFailure,
        };
        match self {
            Self::HostImport(cause) => cause.details().clone(),
            Self::Call { cause, .. } => cause.host_failure(),
            Self::Current(cause) => cause.host_failure(),
            Self::Output(cause) => match cause.as_ref() {
                crate::authorization::AuthError::Denied(reason) => {
                    HostFailure::Authorization(reason.clone())
                }
                crate::authorization::AuthError::Store(cause) => {
                    HostFailure::Operation(OperationFailure::Commit(cause.reason.clone()))
                }
                crate::authorization::AuthError::Codec(_) => HostFailure::InternalFault,
            },
            Self::Artifact(cause) => {
                HostFailure::Operation(OperationFailure::Package(cause.reason.clone()))
            }
            Self::Admission(cause) => {
                HostFailure::Operation(OperationFailure::Lifecycle(match cause {
                    AdmissionFailure::Closed | AdmissionFailure::StillOpen => {
                        LifecycleFailure::AcquisitionClosed
                    }
                    AdmissionFailure::DuplicateToken(_)
                    | AdmissionFailure::DuplicateAcquisition(_)
                    | AdmissionFailure::GenerationConflict(_)
                    | AdmissionFailure::ParentUnavailable(_) => {
                        LifecycleFailure::InvalidPersistedState
                    }
                }))
            }
            Self::Resource(_) | Self::Cleanup { .. } | Self::Close(_) => {
                HostFailure::Operation(OperationFailure::CleanupFailed)
            }
            Self::Budget(dimension) => HostFailure::BudgetExceeded {
                dimension: *dimension,
            },
            Self::Deadline => HostFailure::BudgetExceeded {
                dimension: BudgetDimension::Deadline,
            },
            Self::Protocol(cause) => HostFailure::Process(cause.clone()),
            Self::MaterialsInitialization(_) => HostFailure::Process(ProcessFailure::ReadinessFailed),
            Self::Cancelled => HostFailure::Cancelled,
            Self::Wire(cause) => HostFailure::Process(match cause.as_ref() {
                WireFailure::Protocol(cause) => cause.clone(),
                WireFailure::Codec(CodecFailure::SizeLimit) => ProcessFailure::FrameTooLarge,
                WireFailure::Codec(_) => ProcessFailure::FrameMalformed,
                WireFailure::Read(_) => ProcessFailure::ReadFailed,
                WireFailure::Write(_) => ProcessFailure::WriteFailed,
                WireFailure::Flush(_) => ProcessFailure::FlushFailed,
            }),
            Self::Stderr(_) => HostFailure::Process(ProcessFailure::ReadFailed),
            Self::CancelNotConfirmed => HostFailure::Process(ProcessFailure::CancelTimeout),
            Self::BackpressureTimeout => HostFailure::Process(ProcessFailure::BackpressureTimeout),
            Self::TransportClosed => HostFailure::Process(ProcessFailure::TransportClosed),
            Self::SandboxUnavailable => HostFailure::Process(ProcessFailure::SandboxUnavailable),
            Self::Exited => HostFailure::Process(ProcessFailure::ChildExited { code: None }),
            Self::Quarantined => HostFailure::Operation(OperationFailure::Lifecycle(
                LifecycleFailure::AuthorizationRevoked,
            )),
            Self::Closing => HostFailure::Operation(OperationFailure::Lifecycle(
                LifecycleFailure::AcquisitionClosed,
            )),
            Self::Launch(cause) => match cause.as_ref() {
                foundation::process::supervision::CompletionError::Failed(cause) => {
                    supervisor_failure(cause)
                }
                foundation::process::supervision::CompletionError::SupervisorStopped => {
                    HostFailure::Process(ProcessFailure::ExitUnconfirmed)
                }
            },
            Self::Supervisor(cause) => supervisor_failure(cause),
            Self::ArtifactMismatch => invalid("artifact"),
            Self::ConfigurationMismatch => invalid("configuration"),
            Self::UnsupportedEntrypoint => invalid("entrypoint"),
            Self::InvalidLaunch => invalid("launch"),
            Self::StreamsPending => invalid("stream_consumption"),
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::Artifact(_) | Self::ArtifactMismatch => "process_artifact_invalid",
            Self::ConfigurationMismatch => "process_configuration_mismatch",
            Self::UnsupportedEntrypoint => "process_entrypoint_unsupported",
            Self::SandboxUnavailable => "process_sandbox_unavailable",
            Self::InvalidLaunch => "process_launch_invalid",
            Self::Admission(_) => "process_acquisition_closed",
            Self::Current(_) => "process_current_authority_rejected",
            Self::Output(_) => "process_output_authority_rejected",
            Self::HostImport(_) => "process_host_import_failed",
            Self::Resource(cause) => cause.code,
            Self::Cleanup { .. } => "process_cleanup_not_confirmed",
            Self::Call { cause, .. } => cause.code(),
            Self::Budget(_) => "process_budget_exhausted",
            Self::Wire(cause) => match cause.as_ref() {
                WireFailure::Protocol(_) => "process_bad_frame",
                WireFailure::Codec(_) => "process_bad_payload",
                WireFailure::Read(_) => "process_read_failed",
                WireFailure::Write(_) => "process_write_failed",
                WireFailure::Flush(_) => "process_flush_failed",
            },
            Self::Stderr(_) => "process_stderr_read_failed",
            Self::Protocol(cause) => match cause {
                ProcessFailure::InvalidRequestId => "process_request_id_invalid",
                ProcessFailure::SpawnFailed => "process_spawn_failed",
                ProcessFailure::SandboxUnavailable => "process_sandbox_unavailable",
                ProcessFailure::StdioFailed => "process_stdio_failed",
                ProcessFailure::ReadinessFailed => "process_ready_failed",
                ProcessFailure::BackpressureTimeout => "process_backpressure_timeout",
                ProcessFailure::TransportClosed => "process_transport_closed",
                ProcessFailure::HandshakeTimeout => "process_handshake_timeout",
                ProcessFailure::HandshakeMismatch => "process_handshake_mismatch",
                ProcessFailure::ContractMismatch { .. } => "process_contract_mismatch",
                ProcessFailure::FrameEmpty
                | ProcessFailure::FrameTooLarge
                | ProcessFailure::FrameMalformed
                | ProcessFailure::PartialHeader
                | ProcessFailure::PartialBody => "process_bad_frame",
                ProcessFailure::DuplicateRequest => "process_duplicate_request",
                ProcessFailure::UnexpectedDirection => "process_direction_invalid",
                ProcessFailure::UnknownCorrelation => "process_correlation_unknown",
                ProcessFailure::CreditExceeded => "process_credit_exceeded",
                ProcessFailure::SequenceMismatch => "process_sequence_mismatch",
                ProcessFailure::ChildExited { .. } => "process_exited",
                ProcessFailure::ReadFailed => "process_read_failed",
                ProcessFailure::WriteFailed => "process_write_failed",
                ProcessFailure::FlushFailed => "process_flush_failed",
                ProcessFailure::CancelTimeout => "process_cancel_not_confirmed",
                ProcessFailure::ExitUnconfirmed => "process_exit_not_confirmed",
                ProcessFailure::Retained => "process_retained",
                ProcessFailure::InternalFault => "process_internal_fault",
            },
            Self::MaterialsInitialization(_) => "process_materials_initialization_failed",
            Self::Cancelled => "process_cancelled",
            Self::Deadline => "process_deadline",
            Self::CancelNotConfirmed => "process_cancel_not_confirmed",
            Self::BackpressureTimeout => "process_backpressure_timeout",
            Self::TransportClosed => "process_transport_closed",
            Self::Exited => "process_exited",
            Self::Quarantined => "process_quarantined",
            Self::Closing => "process_admission_closed",
            Self::StreamsPending => "process_streams_pending",
            Self::Close(_) => "process_close_not_confirmed",
            Self::Launch(_) => "process_launch_failed",
            Self::Supervisor(cause) => match cause.as_ref() {
                foundation::process::supervision::SupervisorFailure::LaunchFailed(_) => {
                    "process_launch_failed"
                }
                foundation::process::supervision::SupervisorFailure::StdioFailed => {
                    "process_stdio_failed"
                }
                foundation::process::supervision::SupervisorFailure::ReadinessFailed => {
                    "process_ready_failed"
                }
                foundation::process::supervision::SupervisorFailure::Exited(_) => "process_exited",
                foundation::process::supervision::SupervisorFailure::Termination(_) => {
                    "process_exit_not_confirmed"
                }
            },
        }
    }
}

fn invalid(field: &str) -> world_protocol::process::HostFailure {
    world_protocol::process::HostFailure::Input(
        world_protocol::failure::InputFailure::InvalidValue {
            field: world_protocol::failure::FieldPath(vec!["process".into(), field.into()]),
        },
    )
}

fn supervisor_failure(
    cause: &foundation::process::supervision::SupervisorFailure,
) -> world_protocol::process::HostFailure {
    use foundation::process::{TerminationFailure, supervision::SupervisorFailure};
    use world_protocol::{operation::OperationFailure, process::HostFailure};
    match cause {
        SupervisorFailure::LaunchFailed(_) => HostFailure::Process(ProcessFailure::SpawnFailed),
        SupervisorFailure::StdioFailed => HostFailure::Process(ProcessFailure::StdioFailed),
        SupervisorFailure::ReadinessFailed => HostFailure::Process(ProcessFailure::ReadinessFailed),
        SupervisorFailure::Exited(exit) => HostFailure::Process(ProcessFailure::ChildExited {
            code: exit.exit_code(),
        }),
        SupervisorFailure::Termination(TerminationFailure::MaterialCleanupFailed) => {
            HostFailure::Operation(OperationFailure::CleanupFailed)
        }
        SupervisorFailure::Termination(_) => HostFailure::Process(ProcessFailure::ExitUnconfirmed),
    }
}

impl fmt::Display for ProcessError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for ProcessError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Artifact(cause) => Some(cause),
            Self::MaterialsInitialization(cause) => Some(cause),
            Self::Current(cause) => match cause.as_ref() {
                CurrentFailure::Authorization(cause) => Some(cause),
                CurrentFailure::Store(cause) => Some(cause),
                CurrentFailure::Package(cause) => Some(cause),
                CurrentFailure::Binding(_) => None,
            },
            Self::Output(cause) => Some(cause.as_ref()),
            Self::HostImport(cause) => Some(cause.as_ref()),
            Self::Call { cause, .. } | Self::Cleanup { cause, .. } => Some(cause.as_ref()),
            Self::Wire(cause) => Some(cause.as_ref()),
            Self::Stderr(cause) => Some(cause.as_ref()),
            Self::Close(cause) => Some(cause.as_ref()),
            Self::Launch(cause) => Some(cause.as_ref()),
            Self::Supervisor(cause) => Some(cause.as_ref()),
            _ => None,
        }
    }
}

impl From<PackageError> for ProcessError {
    fn from(cause: PackageError) -> Self {
        Self::Artifact(cause)
    }
}
impl From<WireFailure> for ProcessError {
    fn from(cause: WireFailure) -> Self {
        Self::Wire(Arc::new(cause))
    }
}
impl From<ProcessFailure> for ProcessError {
    fn from(cause: ProcessFailure) -> Self {
        Self::Protocol(cause)
    }
}
