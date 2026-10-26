use std::{error::Error, fmt};

use world_protocol::{
    failure::{Failure, FailureStage, Recovery},
    ids::{DiagnosticId, SourceId},
    sources::MappingFailure,
};

use crate::{authorization::AuthError, definitions::DefinitionError, store::StoreError};

pub(crate) enum MappingError {
    Mapping(MappingFailure),
    Authorization(AuthError),
    Store(StoreError),
    Definition(DefinitionError),
    Release(Box<crate::releases::Error>),
}

impl From<MappingFailure> for MappingError {
    fn from(failure: MappingFailure) -> Self {
        Self::Mapping(failure)
    }
}
impl From<AuthError> for MappingError {
    fn from(failure: AuthError) -> Self {
        Self::Authorization(failure)
    }
}
impl From<StoreError> for MappingError {
    fn from(failure: StoreError) -> Self {
        Self::Store(failure)
    }
}

impl From<crate::releases::Error> for MappingError {
    fn from(error: crate::releases::Error) -> Self {
        Self::Release(Box::new(error))
    }
}
impl From<world_protocol::definitions::DefinitionFailure> for MappingError {
    fn from(error: world_protocol::definitions::DefinitionFailure) -> Self {
        Self::Definition(DefinitionError::Rejected(error))
    }
}
impl From<DefinitionError> for MappingError {
    fn from(error: DefinitionError) -> Self {
        Self::Definition(error)
    }
}

impl fmt::Display for MappingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Mapping(_) => f.write_str("world.source_mapping_failed"),
            Self::Authorization(error) => error.fmt(f),
            Self::Store(error) => error.fmt(f),
            Self::Definition(error) => error.fmt(f),
            Self::Release(error) => error.fmt(f),
        }
    }
}
impl fmt::Debug for MappingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Mapping(failure) => f.debug_tuple("Mapping").field(failure).finish(),
            Self::Authorization(error) => fmt::Debug::fmt(error, f),
            Self::Store(error) => fmt::Debug::fmt(error, f),
            Self::Definition(error) => fmt::Debug::fmt(error, f),
            Self::Release(error) => fmt::Debug::fmt(error, f),
        }
    }
}
impl Error for MappingError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Mapping(_) => None,
            Self::Authorization(error) => Some(error),
            Self::Store(error) => Some(error),
            Self::Definition(error) => Some(error),
            Self::Release(error) => Some(error.as_ref()),
        }
    }
}

pub(crate) fn safe_failure(
    failure: MappingFailure,
    stage: FailureStage,
    diagnostic_id: DiagnosticId,
    _source_id: Option<SourceId>,
) -> Failure<MappingFailure> {
    let (code, message, recovery) = match &failure {
        MappingFailure::SchemaMissing { .. } => (
            "schema_missing",
            "缺少本次映射依赖的源结构。",
            Recovery::Refresh,
        ),
        MappingFailure::MappingChanged { .. } | MappingFailure::RevisionMismatch => (
            "basis_changed",
            "本次映射依赖已变化，请按当前依赖重新编译。",
            Recovery::Refresh,
        ),
        MappingFailure::IdentityUnresolved => (
            "identity_unresolved",
            "来源记录尚未绑定已批准身份。",
            Recovery::ManualReview,
        ),
        MappingFailure::IdentityAmbiguous => (
            "identity_ambiguous",
            "来源记录匹配多个身份，需要明确批准。",
            Recovery::ManualReview,
        ),
        MappingFailure::IncompleteKey | MappingFailure::DuplicateKey => (
            "invalid_key",
            "来源记录键缺失或重复。",
            Recovery::ManualReview,
        ),
        MappingFailure::FieldRemoved { .. } => (
            "field_removed",
            "映射依赖的来源字段缺失。",
            Recovery::Refresh,
        ),
        MappingFailure::FieldRenamed { .. } => (
            "field_renamed",
            "映射依赖的来源字段已改名，需要批准更新。",
            Recovery::ManualReview,
        ),
        MappingFailure::FieldTypeChanged { .. } => (
            "field_type_changed",
            "映射依赖的来源字段类型已变化。",
            Recovery::ManualReview,
        ),
        MappingFailure::PrecisionChanged { .. } => (
            "precision_changed",
            "映射依赖的来源字段精度已变化。",
            Recovery::ManualReview,
        ),
        MappingFailure::InvalidValue { .. } | MappingFailure::TypeMismatch { .. } => (
            "invalid_value",
            "来源值不符合批准的映射类型。",
            Recovery::ManualReview,
        ),
        MappingFailure::UnitMismatch { .. } => (
            "unit_mismatch",
            "来源值的币种或单位与目标不一致。",
            Recovery::ManualReview,
        ),
        MappingFailure::NullNotAllowed { .. } => (
            "null_not_allowed",
            "目标字段不接受来源空值。",
            Recovery::ManualReview,
        ),
        MappingFailure::FormulaUnavailable { .. } => (
            "formula_unavailable",
            "公式没有符合批准策略的当前缓存值。",
            Recovery::ManualReview,
        ),
        MappingFailure::PermissionDenied { .. } => (
            "permission_denied",
            "来源字段未获批准或当前不可读取。",
            Recovery::ManualReview,
        ),
        MappingFailure::CapabilityMissing { .. } => (
            "capability_missing",
            "来源不支持请求的能力。",
            Recovery::ManualReview,
        ),
        MappingFailure::AuthorityMismatch => (
            "authority_mismatch",
            "字段权威与批准的来源、范围或有效时间不一致。",
            Recovery::ManualReview,
        ),
        MappingFailure::CrossWorld => ("cross_world", "来源映射不能跨世界引用。", Recovery::None),
        MappingFailure::BudgetExceeded { .. } => (
            "budget_exceeded",
            "来源映射达到本次资源预算，未提交结果。",
            Recovery::None,
        ),
        MappingFailure::Cancelled => ("cancelled", "来源映射已取消，未提交结果。", Recovery::None),
        MappingFailure::InternalFault => (
            "internal_fault",
            "来源映射内部故障，请提供诊断编号。",
            Recovery::ManualReview,
        ),
    };
    Failure {
        code: format!("world.mapping.{code}"),
        stage,
        message: message.into(),
        diagnostic_id,
        operation_id: None,
        run_id: None,
        step_id: None,
        details: failure,
        recovery,
    }
}
