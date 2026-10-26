use world_protocol::{
    api::ApiFailure,
    failure::{Failure, FailureStage, Recovery},
    ids::DiagnosticId,
    operation::OperationFailure,
};

use crate::{authorization::AuthError, store::StoreError};

#[derive(Clone)]
pub struct Error {
    failure: Failure<ApiFailure>,
    cause: Option<std::sync::Arc<dyn std::error::Error + Send + Sync>>,
    cleanup: Vec<std::sync::Arc<StoreError>>,
    related: Vec<Error>,
}

impl Error {
    pub(crate) fn new(code: &str, stage: FailureStage, message: &str, details: ApiFailure, recovery: Recovery) -> Self {
        Self { failure: Failure {
            code: code.into(), stage, message: message.into(),
            diagnostic_id: DiagnosticId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID identifier"),
            operation_id: None, run_id: None, step_id: None, details, recovery,
        }, cause: None, cleanup: Vec::new(), related: Vec::new() }
    }

    pub fn preparation_failed(cause: impl std::error::Error + Send + Sync + 'static) -> Self {
        Self::new("world.preparation_failed", FailureStage::Prepare, "世界运行资源准备失败。",
            ApiFailure::InternalFault, Recovery::ManualReview).caused(cause)
    }

    pub(crate) fn internal(stage: FailureStage) -> Self {
        Self::new("world.internal_fault", stage, "世界内部故障，请提供诊断编号。", ApiFailure::InternalFault, Recovery::ManualReview)
    }

    pub(crate) fn from_host_failure(reason: world_protocol::process::HostFailure, stage: FailureStage) -> Self {
        use world_protocol::process::HostFailure;
        let details = match reason {
            HostFailure::Process(reason) => ApiFailure::Operation(OperationFailure::Process(reason)),
            HostFailure::Operation(reason) => ApiFailure::Operation(reason),
            HostFailure::Input(reason) => ApiFailure::Input(reason),
            HostFailure::Authorization(reason) => ApiFailure::Authorization(reason),
            HostFailure::Binding(reason) => ApiFailure::Operation(OperationFailure::Binding(reason)),
            HostFailure::Source(reason) => ApiFailure::Operation(OperationFailure::Source(reason)),
            HostFailure::Query(reason) => ApiFailure::Query(reason),
            HostFailure::Slot(reason) => ApiFailure::Operation(OperationFailure::Slot(reason)),
            HostFailure::Generation(reason) => ApiFailure::Operation(OperationFailure::Generation(reason)),
            HostFailure::State(reason) => ApiFailure::Operation(OperationFailure::State(reason)),
            HostFailure::BudgetExceeded { dimension } => ApiFailure::Operation(OperationFailure::BudgetExceeded { dimension }),
            HostFailure::Cancelled => ApiFailure::Operation(OperationFailure::Cancelled),
            HostFailure::InternalFault => return Self::internal(stage),
        };
        let recovery = match &details {
            ApiFailure::Authorization(_) | ApiFailure::Input(_) | ApiFailure::Operation(OperationFailure::Cancelled) => Recovery::None,
            ApiFailure::Operation(OperationFailure::Commit(world_protocol::commit::CommitFailure::CommitIndeterminate { commit_id })) => Recovery::ReadCommit { commit_id: commit_id.clone() },
            _ => Recovery::Refresh,
        };
        Self::new("world.invocation_failed", stage, "世界调用未完成，请读取操作状态。", details, recovery)
    }

    pub(crate) fn operation_failure(&self) -> Option<Failure<OperationFailure>> {
        let details = match &self.failure.details {
            ApiFailure::Operation(details) => details.clone(),
            ApiFailure::Input(details) => OperationFailure::Input(details.clone()),
            ApiFailure::Authorization(details) => OperationFailure::Authorization(details.clone()),
            ApiFailure::Release(details) => OperationFailure::Release(details.clone()),
            ApiFailure::Query(details) => OperationFailure::Query(details.clone()),
            ApiFailure::Upload(details) => OperationFailure::Upload(details.clone()),
            ApiFailure::NotConfigured => OperationFailure::NotConfigured,
            ApiFailure::NotFound => OperationFailure::NotFound,
            ApiFailure::RevisionConflict => OperationFailure::RevisionConflict,
            ApiFailure::InternalFault => OperationFailure::InternalFault,
            _ => return None,
        };
        let failure = &self.failure;
        Some(Failure { code: failure.code.clone(), stage: failure.stage, message: failure.message.clone(),
            diagnostic_id: failure.diagnostic_id.clone(), operation_id: failure.operation_id.clone(),
            run_id: failure.run_id.clone(), step_id: failure.step_id.clone(), details, recovery: failure.recovery.clone() })
    }

    pub(crate) fn caused(mut self, cause: impl std::error::Error + Send + Sync + 'static) -> Self {
        self.cause = Some(std::sync::Arc::new(cause));
        self
    }

    pub(crate) fn from_failure(failure: Failure<ApiFailure>) -> Self {
        Self { failure, cause: None, cleanup: Vec::new(), related: Vec::new() }
    }

    pub(crate) fn with_cleanup(mut self, cleanup: StoreError) -> Self {
        self.cleanup.push(std::sync::Arc::new(cleanup));
        self
    }

    pub(crate) fn with_related(mut self, error: Error) -> Self {
        self.related.push(error);
        self
    }

    pub(crate) fn with_recovery(mut self, recovery: Recovery) -> Self {
        self.failure.recovery = recovery;
        self
    }

    pub(crate) fn with_authorization_context(mut self, code: &str, message: &str) -> Self {
        if matches!(self.failure.details, ApiFailure::Authorization(_)) {
            self.failure.code = code.into();
            self.failure.message = message.into();
        }
        self
    }

    pub(crate) fn unresolved_phase(&self) -> Option<world_protocol::operation::OperationPhase> {
        use world_protocol::operation::OperationPhase;
        let mut pending = vec![self];
        let mut phase = None;
        while let Some(error) = pending.pop() {
            let failures = error.operation_failure().map(|failure| failure.details).into_iter()
                .chain(error.cleanup_errors().map(|error| OperationFailure::Commit(error.safe_failure().details)));
            for failure in failures {
                match super::ledger::unresolved_phase(&failure) {
                    Some(OperationPhase::CommitIndeterminate) => return Some(OperationPhase::CommitIndeterminate),
                    Some(OperationPhase::EffectIndeterminate) => phase = Some(OperationPhase::EffectIndeterminate),
                    Some(next) if phase.is_none() => phase = Some(next),
                    _ => {},
                }
            }
            pending.extend(error.related_errors());
        }
        phase
    }

    pub(crate) fn related_errors(&self) -> &[Error] { &self.related }

    pub(crate) fn cleanup_errors(&self) -> impl Iterator<Item = &StoreError> {
        self.cleanup.iter().map(std::sync::Arc::as_ref)
    }

    pub fn safe_failure(&self) -> &Failure<ApiFailure> { &self.failure }
}

impl From<Failure<OperationFailure>> for Error {
    fn from(failure: Failure<OperationFailure>) -> Self {
        Self::from_failure(Failure {
            code: failure.code, stage: failure.stage, message: failure.message,
            diagnostic_id: failure.diagnostic_id, operation_id: failure.operation_id,
            run_id: failure.run_id, step_id: failure.step_id,
            details: ApiFailure::Operation(failure.details), recovery: failure.recovery,
        })
    }
}

impl From<world_protocol::definitions::DefinitionFailure> for Error {
    fn from(failure: world_protocol::definitions::DefinitionFailure) -> Self {
        Self::new("world.definition_rejected", FailureStage::Validate, "世界定义无效。",
            ApiFailure::Operation(OperationFailure::Definition(failure)), Recovery::None)
    }
}

impl From<crate::content::Error> for Error {
    fn from(error: crate::content::Error) -> Self {
        match error {
            crate::content::Error::Store(error) => error.into(),
            error => {
                let failure = Self::new("world.content_failed", FailureStage::Prepare, "世界内容处理失败。",
                    ApiFailure::Operation(OperationFailure::Material(error.reason().cloned().expect("material error"))),
                    Recovery::ManualReview);
                if platform::trace::enabled() {
                    if let Some(serde_json::Value::Object(mut details)) = error.write_diagnostic() {
                        details.insert("diagnosticIdHash".into(), platform::trace::identifier_hash(failure.failure.diagnostic_id.as_str()).into());
                        platform::trace::runtime_trace("world.content.write_failed", || serde_json::Value::Object(details));
                    }
                }
                failure.caused(error)
            }
        }
    }
}

impl From<crate::content::UploadError> for Error {
    fn from(error: crate::content::UploadError) -> Self {
        Self::new("world.upload_failed", FailureStage::Prepare, "世界上传请求未完成。",
            ApiFailure::Upload(error.failure().clone()), Recovery::Refresh).caused(error)
    }
}

impl From<StoreError> for Error {
    fn from(error: StoreError) -> Self {
        eprintln!("{}", error.write_diagnostic());
        let failure = error.safe_failure();
        Self { failure: Failure {
            code: failure.code, stage: failure.stage, message: failure.message,
            diagnostic_id: failure.diagnostic_id, operation_id: failure.operation_id,
            run_id: failure.run_id, step_id: failure.step_id,
            details: ApiFailure::Operation(OperationFailure::Commit(failure.details)), recovery: failure.recovery,
        }, cause: Some(std::sync::Arc::new(error)), cleanup: Vec::new(), related: Vec::new() }
    }
}

impl<E: Into<Error>> From<crate::store::TransactionError<E>> for Error {
    fn from(error: crate::store::TransactionError<E>) -> Self {
        match error {
            crate::store::TransactionError::NotCommitted { error, cleanup } => {
                let error = error.into();
                match cleanup { Some(cleanup) => error.with_cleanup(cleanup), None => error }
            }
            crate::store::TransactionError::Indeterminate(error) => error.into(),
        }
    }
}

impl From<world_protocol::authorization::AuthorizationFailure> for Error {
    fn from(reason: world_protocol::authorization::AuthorizationFailure) -> Self {
        AuthError::Denied(reason).into()
    }
}

impl From<AuthError> for Error {
    fn from(error: AuthError) -> Self {
        match error {
            AuthError::Store(error) => error.into(),
            AuthError::Codec(cause) => Self::internal(FailureStage::Admission).caused(cause),
            AuthError::Denied(reason) => Self::new(
                "world.authorization_denied", FailureStage::Admission, "当前身份无权执行此操作。",
                ApiFailure::Authorization(reason), Recovery::None,
            ),
        }
    }
}

impl From<foundation::pipeline::PipelineError> for Error {
    fn from(error: foundation::pipeline::PipelineError) -> Self {
        use foundation::pipeline::PipelineError;
        let (code, stage, message, details, recovery) = match &error {
            PipelineError::Cancelled => ("world.pipeline_cancelled", FailureStage::Execute,
                "世界处理步骤已取消。", OperationFailure::Cancelled, Recovery::None),
            PipelineError::InvalidConcurrencyLimit => ("world.pipeline_concurrency_invalid", FailureStage::Prepare,
                "世界处理步骤的并发额度无效。", OperationFailure::InternalFault, Recovery::ManualReview),
            PipelineError::InvalidKey(_) => ("world.pipeline_key_invalid", FailureStage::Prepare,
                "世界处理步骤的内部键无效。", OperationFailure::InternalFault, Recovery::ManualReview),
            PipelineError::MissingArtifact(_) => ("world.pipeline_artifact_missing", FailureStage::Read,
                "世界处理步骤所需的内部制品不存在。", OperationFailure::NotFound, Recovery::ManualReview),
            PipelineError::Io(_) => ("world.pipeline_io_failed", FailureStage::Execute,
                "世界处理步骤的内部读写失败。", OperationFailure::InternalFault, Recovery::ManualReview),
            PipelineError::Json(_) => ("world.pipeline_json_invalid", FailureStage::Decode,
                "世界处理步骤的内部数据无法解码。", OperationFailure::InternalFault, Recovery::ManualReview),
        };
        Self::new(code, stage, message, ApiFailure::Operation(details), recovery).caused(error)
    }
}

impl std::fmt::Debug for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("WorldError").field("failure", &self.failure).finish_non_exhaustive()
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{} ({})", self.failure.code, self.failure.diagnostic_id)
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.cause.as_deref().map(|cause| cause as &(dyn std::error::Error + 'static))
    }
}
