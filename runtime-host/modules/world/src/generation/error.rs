use std::{error::Error, fmt};

use world_protocol::generation::{GenerationFailure, GenerationFailureKind, GenerationStage};

use crate::{authorization::AuthError, store::StoreError};

/// The public failure is safe; upstream errors remain available only to private diagnostics.
pub struct GenerationError {
    pub failure: GenerationFailure,
    cause: Option<Box<dyn Error + Send + Sync>>,
}

impl GenerationError {
    pub fn new(failure: GenerationFailure) -> Self {
        Self {
            failure,
            cause: None,
        }
    }
    pub fn caused_by(
        failure: GenerationFailure,
        cause: impl Error + Send + Sync + 'static,
    ) -> Self {
        Self {
            failure,
            cause: Some(Box::new(cause)),
        }
    }
    pub(crate) fn rejected(stage: GenerationStage, kind: GenerationFailureKind) -> Self {
        Self::new(GenerationFailure {
            stage,
            kind,
            receipt: None,
        })
    }
    pub(crate) fn host_failure(&self) -> world_protocol::process::HostFailure {
        world_protocol::process::HostFailure::Generation(self.failure.clone())
    }
    pub(crate) fn codec(cause: impl Error + Send + Sync + 'static) -> Self {
        Self::caused_by(
            GenerationFailure {
                stage: GenerationStage::Output,
                kind: GenerationFailureKind::InternalFault,
                receipt: None,
            },
            cause,
        )
    }
}
impl fmt::Debug for GenerationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GenerationError")
            .field("stage", &self.failure.stage)
            .field("kind", &self.failure.kind)
            .finish_non_exhaustive()
    }
}
impl fmt::Display for GenerationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("world.generation_failed")
    }
}
impl Error for GenerationError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.cause
            .as_deref()
            .map(|cause| cause as &(dyn Error + 'static))
    }
}
impl From<StoreError> for GenerationError {
    fn from(error: StoreError) -> Self {
        Self::caused_by(
            GenerationFailure {
                stage: GenerationStage::Output,
                kind: GenerationFailureKind::Commit {
                    failure: error.reason.clone(),
                },
                receipt: None,
            },
            error,
        )
    }
}
impl From<AuthError> for GenerationError {
    fn from(error: AuthError) -> Self {
        match error {
            AuthError::Denied(failure) => Self::rejected(
                GenerationStage::Admission,
                GenerationFailureKind::Authorization { failure },
            ),
            AuthError::Store(error) => error.into(),
            AuthError::Codec(error) => Self::codec(error),
        }
    }
}
impl From<GenerationError> for crate::owner::Error {
    fn from(error: GenerationError) -> Self {
        use GenerationFailureKind as Kind;
        use world_protocol::{
            api::ApiFailure,
            failure::{FailureStage, Recovery},
            operation::OperationFailure,
        };
        let code = match &error.failure.kind {
            Kind::Authorization { .. } => "world.generation_authorization",
            Kind::Commit { .. } => "world.generation_commit",
            Kind::Material { .. } => "world.generation_material",
            Kind::RunMismatch { .. } => "world.generation_run_mismatch",
            Kind::CallConflict { .. } => "world.generation_call_conflict",
            Kind::CallIndeterminate { .. } => "world.generation_call_indeterminate",
            Kind::UnsupportedParameter { .. } => "world.generation_parameter_unsupported",
            Kind::BindingStoreUnavailable => "world.generation_binding_store_unavailable",
            Kind::OwnerUnavailable => "world.generation_owner_unavailable",
            Kind::AuditUnavailable => "world.generation_audit_unavailable",
            Kind::BindingInvalid => "world.generation_binding_invalid",
            Kind::BindingMissing { .. } => "world.generation_binding_missing",
            Kind::BindingStale => "world.generation_binding_stale",
            Kind::NoSelection => "world.generation_no_selection",
            Kind::SelectionUnavailable => "world.generation_selection_unavailable",
            Kind::RemoteVersionUnlocked => "world.generation_remote_version_unlocked",
            Kind::UnsupportedProtocol => "world.generation_protocol_unsupported",
            Kind::UnsupportedAuthentication => "world.generation_authentication_unsupported",
            Kind::CredentialMissing => "world.generation_credential_missing",
            Kind::CredentialUnavailable => "world.generation_credential_unavailable",
            Kind::Authentication => "world.generation_authentication",
            Kind::PermissionDenied => "world.generation_permission_denied",
            Kind::RateLimited { .. } => "world.generation_rate_limited",
            Kind::ConnectDeadline => "world.generation_connect_deadline",
            Kind::ReadDeadline => "world.generation_read_deadline",
            Kind::GenerationDeadline => "world.generation_deadline",
            Kind::ConnectFailed => "world.generation_connect_failed",
            Kind::ReadFailed => "world.generation_read_failed",
            Kind::ProviderRejected { .. } => "world.generation_provider_rejected",
            Kind::ProviderUnavailable { .. } => "world.generation_provider_unavailable",
            Kind::ContextLimit => "world.generation_context_limit",
            Kind::OutputLimit => "world.generation_output_limit",
            Kind::StructuredOutputUnsupported => "world.generation_structured_output_unsupported",
            Kind::ToolUnsupported => "world.generation_tool_unsupported",
            Kind::MediaUnsupported => "world.generation_media_unsupported",
            Kind::Refused => "world.generation_refused",
            Kind::Truncated => "world.generation_truncated",
            Kind::InvalidOutput => "world.generation_invalid_output",
            Kind::SchemaMismatch { .. } => "world.generation_schema_mismatch",
            Kind::BudgetExceeded { .. } => "world.generation_budget_exceeded",
            Kind::Cancelled => "world.generation_cancelled",
            Kind::Sink => "world.generation_sink",
            Kind::RemoteUnrecognized { .. } => "world.generation_remote_unrecognized",
            Kind::InternalFault => "world.generation_internal_fault",
        };
        let stage = match error.failure.stage {
            GenerationStage::Admission => FailureStage::Admission,
            GenerationStage::Binding | GenerationStage::Credential => FailureStage::Prepare,
            GenerationStage::Read => FailureStage::Read,
            GenerationStage::Connect | GenerationStage::Output => FailureStage::Generate,
        };
        let recovery = match &error.failure.kind {
            Kind::Commit {
                failure: world_protocol::commit::CommitFailure::CommitIndeterminate { commit_id },
            } => Recovery::ReadCommit {
                commit_id: commit_id.clone(),
            },
            Kind::CredentialMissing | Kind::CredentialUnavailable | Kind::Authentication => {
                Recovery::RestoreCredential { source_id: None }
            }
            Kind::BindingStale | Kind::SelectionUnavailable | Kind::RunMismatch { .. } => {
                Recovery::Refresh
            }
            Kind::Authorization { .. }
            | Kind::PermissionDenied
            | Kind::Cancelled
            | Kind::BudgetExceeded { .. }
            | Kind::CallConflict { .. }
            | Kind::UnsupportedParameter { .. }
            | Kind::UnsupportedProtocol
            | Kind::UnsupportedAuthentication
            | Kind::RemoteVersionUnlocked
            | Kind::ContextLimit
            | Kind::OutputLimit
            | Kind::StructuredOutputUnsupported
            | Kind::ToolUnsupported
            | Kind::MediaUnsupported
            | Kind::Refused => Recovery::None,
            _ => Recovery::ManualReview,
        };
        Self::new(
            code,
            stage,
            "模型调用未完成，请查看具体原因和诊断编号。",
            ApiFailure::Operation(OperationFailure::Generation(error.failure.clone())),
            recovery,
        )
        .caused(error)
    }
}

pub(super) fn rejected(stage: GenerationStage, kind: GenerationFailureKind) -> crate::owner::Error {
    GenerationError::rejected(stage, kind).into()
}

pub(super) fn codec(cause: impl Error + Send + Sync + 'static) -> crate::owner::Error {
    crate::owner::Error::internal(world_protocol::failure::FailureStage::Recover).caused(cause)
}
