use std::{
    error::Error,
    fmt,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use world_protocol::{
    commit::{CommitFailure, ConstraintCode, InstallationFailure},
    failure::{Failure, FailureStage, Recovery},
    ids::DiagnosticId,
};

static DIAGNOSTIC_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Display/Debug are safe; the database error is available only through Error::source.
#[derive(Clone)]
pub struct StoreError {
    pub reason: CommitFailure,
    pub stage: FailureStage,
    diagnostic_id: DiagnosticId,
    source: Option<Arc<dyn Error + Send + Sync>>,
    cleanup: Option<Box<StoreError>>,
}

impl StoreError {
    pub fn connection_failed(source: impl Error + Send + Sync + 'static) -> Self {
        Self::caused_by(CommitFailure::Connection, FailureStage::Prepare, source)
    }

    pub fn locator_conflict() -> Self {
        Self::new(CommitFailure::InvalidBatch, FailureStage::Migrate)
    }

    pub fn locator_failed(source: impl Error + Send + Sync + 'static) -> Self {
        Self::caused_by(CommitFailure::InternalFault, FailureStage::Migrate, source)
    }

    pub fn locator_indeterminate(
        transfer_id: world_protocol::ids::TransferId,
        source: impl Error + Send + Sync + 'static,
    ) -> Self {
        Self::caused_by(
            CommitFailure::TransferIndeterminate { transfer_id },
            FailureStage::Migrate,
            source,
        )
    }

    pub(crate) fn new(reason: CommitFailure, stage: FailureStage) -> Self {
        Self {
            reason,
            stage,
            diagnostic_id: DiagnosticId::try_new(format!(
                "store-{}-{}",
                std::process::id(),
                DIAGNOSTIC_SEQUENCE.fetch_add(1, Ordering::Relaxed),
            ))
            .expect("bounded diagnostic identifier"),
            source: None,
            cleanup: None,
        }
    }

    pub(crate) fn caused_by(
        reason: CommitFailure,
        stage: FailureStage,
        source: impl Error + Send + Sync + 'static,
    ) -> Self {
        let mut failure = Self::new(reason, stage);
        failure.source = Some(Arc::new(source));
        failure
    }

    pub(super) fn with_cleanup(mut self, cleanup: StoreError) -> Self {
        self.cleanup = Some(Box::new(cleanup));
        self
    }

    pub(crate) fn cleanup_failure(&self) -> Option<&StoreError> {
        self.cleanup.as_deref()
    }

    pub(super) fn proves_commit_aborted(error: &tokio_postgres::Error) -> bool {
        use tokio_postgres::error::SqlState;
        match error.code() {
            Some(code) if code.code().starts_with("23") => true,
            Some(
                &SqlState::T_R_SERIALIZATION_FAILURE
                | &SqlState::T_R_DEADLOCK_DETECTED
                | &SqlState::IN_FAILED_SQL_TRANSACTION,
            ) => true,
            _ => false,
        }
    }

    pub(crate) fn database(error: tokio_postgres::Error, stage: FailureStage) -> Self {
        use tokio_postgres::error::SqlState;
        let reason = match error.code() {
            Some(&SqlState::T_R_SERIALIZATION_FAILURE) => CommitFailure::SerializationConflict,
            Some(&SqlState::T_R_DEADLOCK_DETECTED) => CommitFailure::Deadlock,
            Some(&SqlState::QUERY_CANCELED) | Some(&SqlState::LOCK_NOT_AVAILABLE) => {
                CommitFailure::StatementTimeout
            }
            Some(code) if code.code().starts_with("23") => {
                let constraint = error.as_db_error().and_then(|error| error.constraint());
                CommitFailure::ConstraintConflict {
                    constraint: constraint_code(constraint, code),
                }
            }
            Some(&SqlState::IN_FAILED_SQL_TRANSACTION) => CommitFailure::RolledBack,
            _ if error.is_closed() => CommitFailure::Connection,
            _ => CommitFailure::InternalFault,
        };
        Self::caused_by(reason, stage, error)
    }

    pub(crate) fn write_diagnostic(&self) -> serde_json::Value {
        let mut causes = Vec::new();
        let mut current = self.source();
        for _ in 0..8 {
            let Some(error) = current else { break };
            let cause = if let Some(store) = error.downcast_ref::<StoreError>() {
                let failure = store.safe_failure();
                serde_json::json!({
                    "kind": "store",
                    "diagnosticId": failure.diagnostic_id,
                    "code": failure.code,
                    "stage": failure.stage,
                })
            } else if let Some(postgres) = error.downcast_ref::<tokio_postgres::Error>() {
                serde_json::json!({
                    "kind": "postgres",
                    "sqlstate": postgres.code().map(|code| code.code()),
                    "closed": postgres.is_closed(),
                })
            } else {
                let kind = if let Some(io) = error.downcast_ref::<std::io::Error>() {
                    match io.kind() {
                        std::io::ErrorKind::ConnectionRefused => "io_connection_refused",
                        std::io::ErrorKind::ConnectionReset => "io_connection_reset",
                        std::io::ErrorKind::ConnectionAborted => "io_connection_aborted",
                        std::io::ErrorKind::NotConnected => "io_not_connected",
                        std::io::ErrorKind::TimedOut => "io_timed_out",
                        std::io::ErrorKind::PermissionDenied => "io_permission_denied",
                        _ => "io_other",
                    }
                } else if let Some(pool) = error.downcast_ref::<deadpool_postgres::PoolError>() {
                    match pool {
                        deadpool_postgres::PoolError::Closed => "pool_closed",
                        deadpool_postgres::PoolError::Timeout(_) => "pool_timeout",
                        deadpool_postgres::PoolError::Backend(_) => "pool_backend",
                        _ => "pool_other",
                    }
                } else if error.is::<tokio::time::error::Elapsed>() {
                    "timeout"
                } else if error.is::<tokio_postgres::types::WrongType>() {
                    "postgres_parameter_type"
                } else if error.is::<serde_json::Error>() {
                    "json"
                } else {
                    "unclassified"
                };
                serde_json::json!({ "kind": kind })
            };
            causes.push(cause);
            current = error.source();
        }
        let failure = self.safe_failure();
        serde_json::json!({
            "prefix": "world-store-diagnostic",
            "diagnosticId": failure.diagnostic_id,
            "code": failure.code,
            "stage": failure.stage,
            "causes": causes,
        })
    }

    pub fn safe_failure(&self) -> Failure<CommitFailure> {
        let (code, message, recovery) = match &self.reason {
            CommitFailure::CommitIndeterminate { commit_id } => (
                "world.commit_indeterminate",
                "提交结果尚未确定，请按原提交身份回读。",
                Recovery::ReadCommit {
                    commit_id: commit_id.clone(),
                },
            ),
            CommitFailure::TransferIndeterminate { transfer_id } => (
                "world.transfer_indeterminate",
                "存储迁移结果尚未确定，请按原迁移身份回读。",
                Recovery::ReadTransfer {
                    transfer_id: transfer_id.clone(),
                },
            ),
            CommitFailure::CommitIdPayloadConflict { .. } => (
                "world.commit_payload_conflict",
                "同一提交身份已绑定其他输入，不能重放。",
                Recovery::None,
            ),
            CommitFailure::Installation { reason } => match reason {
                InstallationFailure::UnsupportedVersion => (
                    "world.storage_version_unsupported",
                    "数据库版本不满足存储要求。",
                    Recovery::None,
                ),
                InstallationFailure::ExtensionUnavailable => (
                    "world.storage_extension_unavailable",
                    "数据库缺少所需扩展。",
                    Recovery::None,
                ),
                InstallationFailure::PermissionDenied => (
                    "world.storage_installation_permission",
                    "数据库安装权限不足。",
                    Recovery::None,
                ),
                InstallationFailure::StorageIdentityMismatch => (
                    "world.storage_identity_mismatch",
                    "数据库身份与已注册存储不一致，未接受该连接配置。",
                    Recovery::ManualReview,
                ),
                InstallationFailure::SchemaMismatch => (
                    "world.storage_schema_mismatch",
                    "数据库迁移版本与程序不一致。",
                    Recovery::ManualReview,
                ),
            },
            CommitFailure::NotConfigured => (
                "world.storage_not_configured",
                "世界存储尚未配置。",
                Recovery::None,
            ),
            CommitFailure::Closed => ("world.storage_closed", "世界存储正在关闭。", Recovery::None),
            CommitFailure::Connection => (
                "world.storage_connection",
                "存储连接不可用，请恢复连接后按原操作身份继续。",
                Recovery::ManualReview,
            ),
            CommitFailure::PoolTimeout => (
                "world.storage_pool_timeout",
                "等待存储连接超时，请按原操作身份继续核实。",
                Recovery::Refresh,
            ),
            CommitFailure::StatementTimeout => (
                "world.storage_statement_timeout",
                "存储操作超时，请按原操作身份核实结果。",
                Recovery::Refresh,
            ),
            CommitFailure::SerializationConflict | CommitFailure::Deadlock => (
                "world.storage_concurrency_conflict",
                "相关数据发生并发变化，请刷新后重新评估。",
                Recovery::Refresh,
            ),
            CommitFailure::Fenced { .. } => (
                "world.writer_fenced",
                "该写入代际已停止，请读取当前状态。",
                Recovery::Refresh,
            ),
            CommitFailure::ReadDependencyChanged { .. }
            | CommitFailure::RevisionConflict { .. } => (
                "world.commit_basis_changed",
                "本次计算依赖已经变化，请重新读取并计算。",
                Recovery::Refresh,
            ),
            CommitFailure::ConstraintConflict { .. } => (
                "world.storage_constraint_conflict",
                "变更与现有数据约束冲突。",
                Recovery::Refresh,
            ),
            CommitFailure::InvalidBatch => (
                "world.invalid_commit_batch",
                "提交批次不符合事务契约。",
                Recovery::None,
            ),
            CommitFailure::RolledBack => (
                "world.commit_rolled_back",
                "事务已经回滚，未提交变更。",
                Recovery::Refresh,
            ),
            CommitFailure::RollbackFailed => (
                "world.rollback_cleanup_failed",
                "连接回滚清理失败，该连接已隔离。",
                Recovery::Refresh,
            ),
            CommitFailure::InternalFault => (
                "world.storage_internal_fault",
                "存储内部故障，请提供诊断编号。",
                Recovery::ManualReview,
            ),
        };
        Failure {
            code: code.into(),
            stage: self.stage,
            message: message.into(),
            diagnostic_id: self.diagnostic_id.clone(),
            operation_id: None,
            run_id: None,
            step_id: None,
            details: self.reason.clone(),
            recovery,
        }
    }
}

fn constraint_code(
    constraint: Option<&str>,
    state: &tokio_postgres::error::SqlState,
) -> ConstraintCode {
    match constraint {
        Some("world_source_alias_overlap") => ConstraintCode::IdentityAlias,
        Some("world_commit_receipt_pkey" | "world_effect_intent_idempotency") => {
            ConstraintCode::IdempotencyPayload
        }
        Some("world_support_acyclic") => ConstraintCode::SupportCycle,
        Some("world_binding_head_epoch" | "world_state_namespace_epoch") => {
            ConstraintCode::StateEpoch
        }
        Some("world_release_head_pkey" | "world_runtime_generation") => {
            ConstraintCode::HeadGeneration
        }
        Some(
            "world_definition_revision_pkey"
            | "world_assertion_revision_pkey"
            | "world_evidence_revision_pkey",
        ) => ConstraintCode::ImmutableRevision,
        Some("world_immutable_revision" | "world_identity_type_immutable") => {
            ConstraintCode::ImmutableRevision
        }
        _ if state == &tokio_postgres::error::SqlState::FOREIGN_KEY_VIOLATION => {
            ConstraintCode::ForeignReference
        }
        _ => ConstraintCode::DatabaseConstraint,
    }
}

impl fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} ({})",
            self.safe_failure().code,
            self.diagnostic_id
        )
    }
}
impl fmt::Debug for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StoreError")
            .field("reason", &self.reason)
            .field("stage", &self.stage)
            .field("diagnostic_id", &self.diagnostic_id)
            .finish_non_exhaustive()
    }
}
impl Error for StoreError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.source
            .as_deref()
            .map(|source| source as &(dyn Error + 'static))
    }
}
