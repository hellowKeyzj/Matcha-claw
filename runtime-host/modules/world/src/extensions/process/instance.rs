use std::{sync::Arc, time::Duration};

use foundation::process::{
    ProcessContainment, supervise,
    supervision::{CommandReceipt, StartOutcome},
};
use tokio::time::{Instant, timeout_at};
use world_protocol::{
    api::PackageConfigView,
    bindings::BindingNode,
    ids::{AcquisitionId, ActivationLockId, ResourceToken},
    lifecycle::LifecycleOperation,
    process::{ProcessFailure, SystemMethod, SystemValue},
};

use super::{
    call::ProcessClient,
    close::{CloseFailure, CloseStage, JoinedTask, ProcessCustody},
    error::ProcessError,
    fault::{self, FaultResult},
    launch::{Materializer, ProcessLaunch},
    policies::Policies,
    recovery::NoReplay,
    session::{Session, SessionKind},
};
use crate::extensions::{
    invocation::{
        CleanupControl, CleanupFuture, HostResource, Registration, ResourceFailure, ResourceKind,
        ResourceLedger, ResourcePartFailure, ResourceSpec, ResourceStage,
    },
    package::ArtifactLease,
};

pub(crate) struct PreparedProcess {
    pub client: ProcessClient,
    pub registration: Registration,
}

struct ProcessInstance {
    custody: ProcessCustody,
    policies: Policies,
    monitor: JoinedTask<FaultResult>,
    drain_failure: Option<Arc<ProcessError>>,
}

/// The caller obtains `ledger` from LiveExtensions::new_generation before preparation.
/// Custody is installed before the first async start or protocol interaction.
pub(crate) async fn prepare(
    containment: ProcessContainment,
    node: BindingNode,
    config: PackageConfigView,
    activation_lock: ActivationLockId,
    artifact: ArtifactLease,
    launch: ProcessLaunch,
    host_io_timeout: Duration,
    ledger: &ResourceLedger,
    deadline: Instant,
) -> Result<PreparedProcess, Arc<ProcessError>> {
    let (session, registration) = prepare_instance(containment, Preparation::Binding { node, config, activation_lock },
        artifact, launch, host_io_timeout, ledger, deadline).await?;
    Ok(PreparedProcess { client: ProcessClient { session }, registration })
}

pub(crate) struct PreparedMaterials {
    pub(crate) client: super::materials_session::MaterialsClient,
    pub(crate) registration: Registration,
}

enum Preparation {
    Binding { node: BindingNode, config: PackageConfigView, activation_lock: ActivationLockId },
    Materials { pin: crate::materials::MaterialImplementation },
}

pub(crate) async fn prepare_materials(
    containment: ProcessContainment, pin: crate::materials::MaterialImplementation,
    artifact: ArtifactLease, launch: ProcessLaunch,
    host_io_timeout: Duration, ledger: &ResourceLedger, deadline: Instant,
) -> Result<PreparedMaterials, Arc<ProcessError>> {
    let (session, registration) = prepare_instance(containment, Preparation::Materials { pin },
        artifact, launch, host_io_timeout, ledger, deadline).await?;
    Ok(PreparedMaterials { client: super::materials_session::MaterialsClient { session }, registration })
}

async fn prepare_instance(
    containment: ProcessContainment, preparation: Preparation, artifact: ArtifactLease, launch: ProcessLaunch,
    host_io_timeout: Duration, ledger: &ResourceLedger, deadline: Instant,
) -> Result<(Arc<Session>, Registration), Arc<ProcessError>> {
    let ticket = ledger
        .begin_acquisition(
            AcquisitionId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID acquisition"),
            ResourceSpec {
                token: ResourceToken::try_new(uuid::Uuid::new_v4().to_string())
                    .expect("UUID process resource"),
                kind: ResourceKind::Process,
                parent: None,
                invocation: None,
            },
        )
        .map_err(|cause| {
            let cause = Arc::new(ProcessError::Admission(cause));
            trace_prepare_failure(
                "acquisition_rejected",
                "not_requested",
                &cause,
                None,
                ledger,
                false,
            );
            cause
        })?;
    let cancellation = ticket.cancellation().clone();
    let limits = artifact.package_limits().clone();
    let prepared = match preparation {
        Preparation::Binding { node, config, activation_lock } => {
            Materializer::prepare(&node, &config, artifact, launch, &cancellation)
                .map(|materializer| (materializer, node.implementation, config, node.ports,
                    SessionKind::Binding(node.slot), Some(activation_lock)))
        }
        Preparation::Materials { pin } => {
            let pdfium = pin.native_files.iter().find(|file| file.path == if cfg!(windows) {
                "native/pdfium.dll"
            } else {
                "native/libpdfium.so"
            }).map(|file| {
                artifact.file_path(file).map(|path| super::materials_wire::Pdfium {
                    path: path.to_path_buf(), digest: file.digest.clone(),
                }).ok_or(ProcessError::ArtifactMismatch)
            }).transpose();
            let maximum_payload = limits.memory_bytes;
            pdfium.and_then(|pdfium| Materializer::prepare_materials(&pin.implementation, &pin.config, artifact, launch, &cancellation)
                .map(|materializer| (materializer, pdfium)))
                .map(|(materializer, pdfium)| (materializer, pin.implementation, pin.config, Vec::new(),
                    SessionKind::Materials(super::materials_session::MaterialsSession::new(pdfium, maximum_payload)), None))
        }
    };
    let (materializer, implementation, config, methods, kind, activation_lock) = match prepared {
        Ok(prepared) => prepared,
        Err(cause) => {
            trace_prepare_failure("materialize", "not_requested", &cause, None, ledger, cancellation.is_cancelled());
            ticket.fail();
            return Err(Arc::new(cause));
        }
    };
    let (session, receivers) = Session::new(
        implementation, config, methods, kind, limits, host_io_timeout,
        ledger.snapshot().generation, ledger.cleanup_control(),
    );
    let policies = Policies::new(session.clone(), receivers, deadline, Duration::from_secs(5));
    let supervisor = supervise(
        containment,
        materializer,
        policies.clone(),
        policies.clone(),
        policies.clone(),
        NoReplay(session.clone()),
        NoReplay(session.clone()),
    );
    let handle = supervisor.handle();
    let acquired = ticket.complete(Box::new(ProcessInstance {
        custody: ProcessCustody::new(supervisor),
        policies: policies.clone(),
        monitor: JoinedTask::new(fault::monitor(handle.clone(), session.clone())),
        drain_failure: None,
    }));
    let mut registration = acquired.registration;
    if acquired.must_release {
        let first = session.failure();
        let cause = first
            .clone()
            .unwrap_or_else(|| Arc::new(ProcessError::Closing));
        trace_prepare_failure(
            "late_acquisition",
            "not_requested",
            &cause,
            first.as_deref(),
            ledger,
            cancellation.is_cancelled(),
        );
        registration
            .close_checked(deadline)
            .await
            .map_err(|cause| Arc::new(ProcessError::Resource(cause)))?;
        return Err(cause);
    }
    let mut branch = "start";
    let mut start_outcome = "pending";
    let prepared = async {
        let receipt = handle.start().await;
        start_outcome = match &receipt {
            CommandReceipt::Accepted(_) | CommandReceipt::Shared(_) => "pending",
            CommandReceipt::AlreadySatisfied => "already_satisfied",
            CommandReceipt::Busy => "busy",
            CommandReceipt::Rejected(_) => "rejected",
            CommandReceipt::ShuttingDown => "shutting_down",
        };
        match receipt {
            CommandReceipt::Accepted(completion) | CommandReceipt::Shared(completion) => {
                let outcome = completion.wait().await.map_err(|cause| {
                    start_outcome = "completion_failed";
                    Arc::new(ProcessError::Launch(Arc::new(cause)))
                })?;
                match outcome {
                    StartOutcome::Started => start_outcome = "started",
                    StartOutcome::Cancelled { .. } => {
                        start_outcome = "cancelled";
                        return Err(Arc::new(ProcessError::Closing));
                    }
                }
            }
            _ => {
                return Err(Arc::new(ProcessError::Protocol(
                    ProcessFailure::SpawnFailed,
                )));
            }
        }
        branch = "ready";
        session.wait_ready(deadline).await?;
        let Some(activation_lock) = activation_lock else { return Ok(()) };
        branch = "system_prepare";
        match session
            .system(
                SystemMethod::Prepare {
                    activation_lock_id: activation_lock.clone(),
                },
                deadline,
            )
            .await?
        {
            SystemValue::Prepared { activation_lock_id }
                if activation_lock_id == activation_lock => {}
            _ => {
                return Err(Arc::new(ProcessError::Protocol(
                    ProcessFailure::HandshakeMismatch,
                )));
            }
        }
        branch = "system_start";
        match session.system(SystemMethod::Start, deadline).await? {
            SystemValue::Started => Ok(()),
            _ => Err(Arc::new(ProcessError::Protocol(
                ProcessFailure::HandshakeMismatch,
            ))),
        }
    };
    let (result, interrupted) = tokio::select! {
        biased;
        _ = cancellation.cancelled() => (Err(Arc::new(ProcessError::Closing)), Some("resource_cancelled")),
        result = timeout_at(deadline, prepared) => match result {
            Ok(result) => (result, None),
            Err(_) => (Err(Arc::new(ProcessError::Deadline)), Some("deadline")),
        },
    };
    if let Err(cause) = result {
        let first = session.failure();
        trace_prepare_failure(
            interrupted.unwrap_or(branch),
            start_outcome,
            &cause,
            first.as_deref(),
            ledger,
            cancellation.is_cancelled(),
        );
        let cause = first.unwrap_or(cause);
        // A failed or cancelled preparation remains ledger-owned if cleanup cannot finish.
        if let Err(cleanup) = registration.close_checked(deadline).await {
            registration.retain(cleanup.clone());
            return Err(Arc::new(ProcessError::Cleanup {
                cause,
                failure: cleanup,
            }));
        }
        return Err(cause);
    }
    Ok((session, registration))
}

fn trace_prepare_failure(
    branch: &'static str,
    start_outcome: &'static str,
    cause: &ProcessError,
    first: Option<&ProcessError>,
    ledger: &ResourceLedger,
    cancelled: bool,
) {
    platform::trace::runtime_trace("world.process.prepare_failed", || {
        let snapshot = ledger.snapshot();
        let (kind, reason) = prepare_failure_reason(cause);
        let first_reason = first.map(prepare_failure_reason);
        serde_json::json!({
            "branch": branch,
            "failureKind": kind,
            "reason": reason,
            "sessionFailurePresent": first.is_some(),
            "sessionFailureKind": first_reason.map(|(kind, _)| kind),
            "sessionReason": first_reason.map(|(_, reason)| reason),
            "startOutcome": start_outcome,
            "admission": match snapshot.admission {
                crate::extensions::invocation::Admission::Open => "open",
                crate::extensions::invocation::Admission::Closing => "closing",
                crate::extensions::invocation::Admission::Closed => "closed",
            },
            "resourceCount": snapshot.resources.len(),
            "acquisitionCount": snapshot.acquisitions,
            "cancelled": cancelled,
            "hostOnly": ledger.cleanup_control().host_only(),
            "generationIdHash": platform::trace::identifier_hash(snapshot.generation.as_str()),
        })
    });
}

fn prepare_failure_reason(cause: &ProcessError) -> (&'static str, &'static str) {
    use super::frame::WireFailure;
    use crate::extensions::invocation::AdmissionFailure;
    use foundation::process::supervision::CompletionError;
    use world_protocol::wire::CodecFailure;

    let reason = match cause {
        ProcessError::Artifact(_) => "artifact",
        ProcessError::ArtifactMismatch => "artifact_mismatch",
        ProcessError::ConfigurationMismatch => "configuration_mismatch",
        ProcessError::UnsupportedEntrypoint => "unsupported_entrypoint",
        ProcessError::SandboxUnavailable => "sandbox_unavailable",
        ProcessError::InvalidLaunch => "invalid_launch",
        ProcessError::Admission(cause) => {
            return (
                "admission",
                match cause {
                    AdmissionFailure::Closed => "closed",
                    AdmissionFailure::StillOpen => "still_open",
                    AdmissionFailure::DuplicateToken(_) => "duplicate_token",
                    AdmissionFailure::DuplicateAcquisition(_) => "duplicate_acquisition",
                    AdmissionFailure::GenerationConflict(_) => "generation_conflict",
                    AdmissionFailure::ParentUnavailable(_) => "parent_unavailable",
                },
            );
        }
        ProcessError::Current(_) => "current_authority",
        ProcessError::Output(_) => "output_authority",
        ProcessError::HostImport(_) => "host_import",
        ProcessError::Resource(_) => "resource",
        ProcessError::Cleanup { .. } => "cleanup",
        ProcessError::Call { .. } => "call",
        ProcessError::Budget(_) => "budget",
        ProcessError::Wire(cause) => {
            return match cause.as_ref() {
                WireFailure::Protocol(cause) => ("wire_protocol", prepare_protocol_reason(cause)),
                WireFailure::Codec(cause) => (
                    "wire_codec",
                    match cause {
                        CodecFailure::SizeLimit => "size_limit",
                        CodecFailure::DepthLimit => "depth_limit",
                        CodecFailure::DuplicateKey => "duplicate_key",
                        CodecFailure::JsonSyntax { .. } => "json_syntax",
                        CodecFailure::UnexpectedEof { .. } => "unexpected_eof",
                        CodecFailure::ContractData { .. } => "contract_data",
                        CodecFailure::Encode => "encode",
                    },
                ),
                WireFailure::Read(_) => ("wire", "read"),
                WireFailure::Write(_) => ("wire", "write"),
                WireFailure::Flush(_) => ("wire", "flush"),
            };
        }
        ProcessError::Stderr(_) => "stderr_read",
        ProcessError::Protocol(cause) => return ("protocol", prepare_protocol_reason(cause)),
        ProcessError::MaterialsInitialization(_) => "materials_initialization",
        ProcessError::Cancelled => "cancelled",
        ProcessError::Deadline => "deadline",
        ProcessError::CancelNotConfirmed => "cancel_not_confirmed",
        ProcessError::BackpressureTimeout => "backpressure_timeout",
        ProcessError::TransportClosed => "transport_closed",
        ProcessError::Exited => "exited",
        ProcessError::Quarantined => "quarantined",
        ProcessError::Closing => "closing",
        ProcessError::StreamsPending => "streams_pending",
        ProcessError::Close(_) => "close",
        ProcessError::Launch(cause) => {
            return (
                "completion",
                match cause.as_ref() {
                    CompletionError::Failed(cause) => prepare_supervisor_reason(cause),
                    CompletionError::SupervisorStopped => "supervisor_stopped",
                },
            );
        }
        ProcessError::Supervisor(cause) => return ("supervisor", prepare_supervisor_reason(cause)),
    };
    ("process", reason)
}

fn prepare_protocol_reason(cause: &ProcessFailure) -> &'static str {
    match cause {
        ProcessFailure::InvalidRequestId => "invalid_request_id",
        ProcessFailure::SpawnFailed => "spawn_failed",
        ProcessFailure::SandboxUnavailable => "sandbox_unavailable",
        ProcessFailure::StdioFailed => "stdio_failed",
        ProcessFailure::ReadinessFailed => "readiness_failed",
        ProcessFailure::TransportClosed => "transport_closed",
        ProcessFailure::BackpressureTimeout => "backpressure_timeout",
        ProcessFailure::HandshakeTimeout => "handshake_timeout",
        ProcessFailure::HandshakeMismatch => "handshake_mismatch",
        ProcessFailure::ContractMismatch { .. } => "contract_mismatch",
        ProcessFailure::FrameEmpty => "frame_empty",
        ProcessFailure::FrameTooLarge => "frame_too_large",
        ProcessFailure::FrameMalformed => "frame_malformed",
        ProcessFailure::PartialHeader => "partial_header",
        ProcessFailure::PartialBody => "partial_body",
        ProcessFailure::DuplicateRequest => "duplicate_request",
        ProcessFailure::UnexpectedDirection => "unexpected_direction",
        ProcessFailure::UnknownCorrelation => "unknown_correlation",
        ProcessFailure::CreditExceeded => "credit_exceeded",
        ProcessFailure::SequenceMismatch => "sequence_mismatch",
        ProcessFailure::ChildExited { .. } => "child_exited",
        ProcessFailure::ReadFailed => "read_failed",
        ProcessFailure::WriteFailed => "write_failed",
        ProcessFailure::FlushFailed => "flush_failed",
        ProcessFailure::CancelTimeout => "cancel_timeout",
        ProcessFailure::ExitUnconfirmed => "exit_unconfirmed",
        ProcessFailure::Retained => "retained",
        ProcessFailure::InternalFault => "internal_fault",
    }
}

fn prepare_supervisor_reason(
    cause: &foundation::process::supervision::SupervisorFailure,
) -> &'static str {
    use foundation::process::{
        TerminationFailure,
        supervision::{LaunchFailure, SupervisorFailure},
    };

    match cause {
        SupervisorFailure::LaunchFailed(cause) => match cause {
            LaunchFailure::ArtifactUnavailable => "launch_artifact_unavailable",
            LaunchFailure::PermissionDenied => "launch_permission_denied",
            LaunchFailure::ResourceUnavailable => "launch_resource_unavailable",
            LaunchFailure::PlatformRejected => "launch_platform_rejected",
        },
        SupervisorFailure::StdioFailed => "stdio_failed",
        SupervisorFailure::ReadinessFailed => "readiness_failed",
        SupervisorFailure::Exited(_) => "exited",
        SupervisorFailure::Termination(cause) => match cause {
            TerminationFailure::AuthorityLost => "termination_authority_lost",
            TerminationFailure::CleanupUnconfirmed => "termination_cleanup_unconfirmed",
            TerminationFailure::MaterialCleanupFailed => "material_cleanup_failed",
        },
    }
}

impl HostResource for ProcessInstance {
    fn close_checked(&mut self, deadline: Instant, control: CleanupControl) -> CleanupFuture<'_> {
        Box::pin(async move {
            if !control.host_only() && self.policies.session.failure().is_none() {
                let now = Instant::now();
                let drain_deadline = now + deadline.saturating_duration_since(now) / 3;
                if let Err(cause) = self
                    .policies
                    .session
                    .drain(LifecycleOperation::Stop, drain_deadline)
                    .await
                {
                    self.policies.session.fail(cause.clone());
                    self.drain_failure = Some(cause);
                }
            }
            self.custody
                .close_checked(deadline, &control)
                .await
                .map_err(|cause| cause.safe_resource_failure(self.remaining()))?;
            self.policies.session.confirmed_exit();
            let host_failure = super::host_io::close_all(&self.policies.session, deadline)
                .await
                .err();
            self.monitor.cancel();
            let monitor = self
                .monitor
                .join_checked(CloseStage::FaultJoin, deadline)
                .await;
            let mut monitor_pending = false;
            match monitor {
                Ok(Ok(_)) => {}
                Ok(Err(cause)) => self.policies.session.fail(cause.clone()),
                Err(cause) => {
                    monitor_pending = matches!(cause, CloseFailure::Deadline(_));
                    self.policies
                        .session
                        .fail(Arc::new(ProcessError::Close(Arc::new(cause))));
                }
            }
            let mut tasks = timeout_at(deadline, self.policies.tasks.lock())
                .await
                .map_err(|_| self.failure("process_tasks_lock_deadline"))?;
            if let Some(tasks) = tasks.as_mut() {
                tasks
                    .close_checked(&self.policies.session, deadline)
                    .await
                    .map_err(|cause| {
                        let mut remaining = self.custody.remaining();
                        remaining.extend(self.monitor.remaining("fault_monitor"));
                        remaining.extend(tasks.remaining());
                        ResourceFailure {
                            stage: ResourceStage::TaskJoin,
                            code: cause.code(),
                            message: cause.to_string(),
                            remaining,
                        }
                    })?;
            }
            drop(tasks);
            if monitor_pending {
                return Err(self.failure("process_fault_monitor_join_deadline"));
            }
            if let Some(cause) = host_failure {
                return Err(ResourceFailure {
                    stage: ResourceStage::TaskJoin,
                    code: cause.code(),
                    message: cause.to_string(),
                    remaining: self.remaining(),
                });
            }
            Ok(())
        })
    }
}

impl ProcessInstance {
    fn remaining(&self) -> Vec<ResourcePartFailure> {
        let mut remaining = self.custody.remaining();
        remaining.extend(self.monitor.remaining("fault_monitor"));
        remaining.extend(
            self.policies
                .session
                .host_calls()
                .iter()
                .filter_map(|io| io.remaining()),
        );
        match self.policies.tasks.try_lock() {
            Ok(tasks) => {
                if let Some(tasks) = tasks.as_ref() {
                    remaining.extend(tasks.remaining());
                }
            }
            Err(_) => {
                remaining.extend(
                    ["protocol_reader", "protocol_writer", "private_stderr"].map(|name| {
                        ResourcePartFailure {
                            kind: ResourceKind::TaskJoin,
                            name: name.into(),
                            stage: ResourceStage::TaskJoin,
                            code: "process_task_join_not_confirmed",
                            message: "process protocol task cleanup has not been confirmed".into(),
                        }
                    }),
                );
            }
        }
        remaining
    }
    fn failure(&self, code: &'static str) -> ResourceFailure {
        ResourceFailure {
            stage: ResourceStage::TaskJoin,
            code,
            message: "process protocol tasks have not completed checked cleanup".into(),
            remaining: self.remaining(),
        }
    }
}
