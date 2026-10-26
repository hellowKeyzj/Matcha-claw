use std::{
    error::Error as StdError,
    fmt,
    sync::atomic::{AtomicU64, Ordering},
};

use world_protocol::{
    definitions::{DefinitionFailure, DefinitionFieldReason},
    facts::FactFailure,
    failure::{Failure, FailureStage, Recovery},
    ids::DiagnosticId,
};

use crate::store::StoreError;

static DIAGNOSTICS: AtomicU64 = AtomicU64::new(1);

pub(crate) struct Error {
    pub(crate) reason: FactFailure,
    diagnostic_id: DiagnosticId,
    source: Option<Box<dyn StdError + Send + Sync>>,
}

impl Error {
    pub(crate) fn host_failure(&self) -> world_protocol::process::HostFailure {
        if let Some(error) = self.source.as_deref().and_then(|source| source.downcast_ref::<crate::releases::Error>()) {
            return error.host_failure();
        }
        if let Some(error) = self.source.as_deref().and_then(|source| source.downcast_ref::<crate::query::QueryError>()) {
            return error.host_failure();
        }
        world_protocol::process::HostFailure::Operation(
            world_protocol::operation::OperationFailure::Fact(self.reason.clone()),
        )
    }

    pub(super) fn caused_by(
        reason: FactFailure,
        source: impl StdError + Send + Sync + 'static,
    ) -> Self {
        let mut error = Self::from(reason);
        error.source = Some(Box::new(source));
        error
    }

    pub(crate) fn safe_failure(&self) -> Failure<FactFailure> {
        if let FactFailure::SourceMapping { failure } = &self.reason {
            let failure = crate::sources::mapping::safe_failure(
                failure.clone(),
                FailureStage::Validate,
                self.diagnostic_id.clone(),
                None,
            );
            return Failure {
                code: failure.code,
                stage: failure.stage,
                message: failure.message,
                diagnostic_id: failure.diagnostic_id,
                operation_id: failure.operation_id,
                run_id: failure.run_id,
                step_id: failure.step_id,
                details: self.reason.clone(),
                recovery: failure.recovery,
            };
        }
        if let FactFailure::Commit { failure } = &self.reason {
            let failure = self
                .source
                .as_deref()
                .and_then(|source| source.downcast_ref::<StoreError>())
                .map(StoreError::safe_failure)
                .unwrap_or_else(|| {
                    StoreError::new(failure.clone(), FailureStage::Validate).safe_failure()
                });
            return Failure {
                code: failure.code,
                stage: failure.stage,
                message: failure.message,
                diagnostic_id: self.diagnostic_id.clone(),
                operation_id: failure.operation_id,
                run_id: failure.run_id,
                step_id: failure.step_id,
                details: self.reason.clone(),
                recovery: failure.recovery,
            };
        }
        let (code, message, recovery) = match &self.reason {
            FactFailure::SourceMapping { .. } => unreachable!("source mapping handled above"),
            FactFailure::Compilation { failure } => compilation_diagnostic(failure),
            FactFailure::Provenance { failure } => provenance_diagnostic(failure),
            FactFailure::AccessDenied => (
                "world.fact_access_denied",
                "当前操作无权访问或修改所请求的事实。",
                Recovery::None,
            ),
            FactFailure::Cancelled => (
                "world.fact_cancelled",
                "事实准入已取消，未提交变更。",
                Recovery::None,
            ),
            FactFailure::RevisionConflict { actual, .. } => (
                "world.fact_revision_conflict",
                "事实修订已经变化。",
                Recovery::Rebase {
                    current_revision: *actual,
                },
            ),
            FactFailure::SupersedesMismatch { .. } => (
                "world.fact_supersedes_mismatch",
                "后继修订与当前事实身份不一致。",
                Recovery::Refresh,
            ),
            FactFailure::EvidenceUnavailable { .. } => (
                "world.evidence_unavailable",
                "证据暂不可访问，不代表其内容被撤回。",
                Recovery::RetryRead { after: None },
            ),
            FactFailure::EvidenceDeleted { .. } => (
                "world.evidence_deleted",
                "证据内容已删除，不能用于新的准入。",
                Recovery::None,
            ),
            FactFailure::EvidenceMissing { .. } | FactFailure::EvidenceIncomplete { .. } => (
                "world.evidence_incomplete",
                "准入所需的精确证据尚不完整。",
                Recovery::RequestEvidence {
                    evidence: Vec::new(),
                },
            ),
            FactFailure::InvalidEvidenceLocator { .. } => (
                "world.evidence_locator_invalid",
                "证据定位不符合来源坐标契约。",
                Recovery::None,
            ),
            FactFailure::EvidenceCycle { .. } => (
                "world.evidence_cycle",
                "证据血缘含循环引用。",
                Recovery::None,
            ),
            FactFailure::SourceAuthorityDenied { .. } => (
                "world.source_authority_denied",
                "来源没有所请求字段或完整关系角色组的有效权威。",
                Recovery::None,
            ),
            FactFailure::SourceCapabilityMissing { .. } => (
                "world.source_capability_missing",
                "来源不具备本次观察要求的能力。",
                Recovery::None,
            ),
            FactFailure::InvalidRecordedTime => (
                "world.fact_recorded_time_invalid",
                "观察或记录时间不符合不可变修订顺序。",
                Recovery::None,
            ),
            FactFailure::Structural { field } => (
                "world.fact_invalid_structure",
                "事实结构与精确定义不一致。",
                Recovery::CorrectInput {
                    fields: vec![field.clone()],
                },
            ),
            FactFailure::TypeMismatch { field } => (
                "world.fact_type_mismatch",
                "事实值类型与精确定义不一致。",
                Recovery::CorrectInput {
                    fields: vec![field.clone()],
                },
            ),
            FactFailure::UnitMismatch { field } => (
                "world.fact_unit_mismatch",
                "事实单位或币种与精确定义不一致。",
                Recovery::CorrectInput {
                    fields: vec![field.clone()],
                },
            ),
            FactFailure::ScopeMismatch | FactFailure::CrossWorld => (
                "world.fact_scope_mismatch",
                "事实或引用不属于允许的范围。",
                Recovery::None,
            ),
            FactFailure::ValidTimeMismatch => (
                "world.fact_valid_time_mismatch",
                "事实有效时间不在定义或授权范围内。",
                Recovery::None,
            ),
            FactFailure::MissingDefinition { .. } | FactFailure::MissingSubject { .. } => (
                "world.fact_reference_missing",
                "事实引用的精确资源不可用。",
                Recovery::Refresh,
            ),
            FactFailure::NullNotAllowed { .. } | FactFailure::InvalidRoleGroup { .. } => (
                "world.fact_contract_mismatch",
                "空值或完整关系角色组不符合定义。",
                Recovery::None,
            ),
            FactFailure::Commit { .. } | FactFailure::InternalFault => (
                "world.fact_internal_fault",
                "事实处理内部故障，请提供诊断编号。",
                Recovery::ManualReview,
            ),
        };
        Failure {
            code: code.into(),
            stage: FailureStage::Validate,
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

impl From<FactFailure> for Error {
    fn from(reason: FactFailure) -> Self {
        Self {
            reason,
            diagnostic_id: DiagnosticId::try_new(format!(
                "fact-{}-{}",
                std::process::id(),
                DIAGNOSTICS.fetch_add(1, Ordering::Relaxed)
            ))
            .expect("bounded diagnostic identifier"),
            source: None,
        }
    }
}

impl From<Error> for crate::owner::Error {
    fn from(error: Error) -> Self {
        if error.source.as_deref().is_some_and(|source| source.is::<crate::releases::Error>() || source.is::<crate::query::QueryError>()) {
            return Self::from_host_failure(error.host_failure(), FailureStage::Validate).caused(error);
        }
        let failure = error.safe_failure();
        Self::from_failure(Failure {
            code: failure.code,
            stage: failure.stage,
            message: failure.message,
            diagnostic_id: failure.diagnostic_id,
            operation_id: failure.operation_id,
            run_id: failure.run_id,
            step_id: failure.step_id,
            details: world_protocol::api::ApiFailure::Operation(
                world_protocol::operation::OperationFailure::Fact(failure.details),
            ),
            recovery: failure.recovery,
        })
        .caused(error)
    }
}

impl From<StoreError> for Error {
    fn from(source: StoreError) -> Self {
        let failure = crate::facts::support::provenance_failure(&source);
        let reason = match failure {
            world_protocol::provenance::ProvenanceFailure::Commit { failure } => {
                FactFailure::Commit { failure }
            }
            failure => FactFailure::Provenance { failure },
        };
        Self::caused_by(reason, source)
    }
}

impl From<crate::authorization::AuthError> for Error {
    fn from(source: crate::authorization::AuthError) -> Self {
        match source {
            crate::authorization::AuthError::Store(source) => Self::from(source),
            source @ crate::authorization::AuthError::Denied(_) => {
                Self::caused_by(FactFailure::AccessDenied, source)
            }
            source @ crate::authorization::AuthError::Codec(_) => {
                Self::caused_by(FactFailure::InternalFault, source)
            }
        }
    }
}

impl From<crate::identity::IdentityError> for Error {
    fn from(source: crate::identity::IdentityError) -> Self {
        use world_protocol::identity::IdentityFailure;
        match source {
            crate::identity::IdentityError::Store(source) => Self::from(source),
            crate::identity::IdentityError::Fact(source) => source,
            crate::identity::IdentityError::Rejected(reason) => {
                let failure = match &reason {
                    IdentityFailure::UnresolvedIdentity { subject } => {
                        FactFailure::MissingSubject {
                            subject: subject.clone(),
                        }
                    }
                    IdentityFailure::RevisionConflict { expected, actual } => {
                        FactFailure::RevisionConflict {
                            expected: *expected,
                            actual: *actual,
                        }
                    }
                    IdentityFailure::CrossWorld => FactFailure::CrossWorld,
                    IdentityFailure::PermissionDenied => FactFailure::AccessDenied,
                    IdentityFailure::Cancelled => FactFailure::Cancelled,
                    IdentityFailure::ScopeConflict | IdentityFailure::CandidateScopeIncomplete => {
                        FactFailure::ScopeMismatch
                    }
                    IdentityFailure::InvalidInterval => FactFailure::ValidTimeMismatch,
                    IdentityFailure::UnresolvedType { reference } => {
                        FactFailure::MissingDefinition {
                            reference: reference.clone(),
                        }
                    }
                    IdentityFailure::TypeKindMismatch { .. } => FactFailure::TypeMismatch {
                        field: world_protocol::failure::FieldPath(vec![
                            "subject".into(),
                            "type".into(),
                        ]),
                    },
                    IdentityFailure::BasisChanged { resource } => FactFailure::Commit {
                        failure: world_protocol::commit::CommitFailure::ReadDependencyChanged {
                            resource: resource.clone(),
                        },
                    },
                    IdentityFailure::Commit { failure } => FactFailure::Commit {
                        failure: failure.clone(),
                    },
                    IdentityFailure::Ambiguous { .. }
                    | IdentityFailure::AliasConflict { .. }
                    | IdentityFailure::OverlappingIncarnation { .. }
                    | IdentityFailure::InvalidMerge
                    | IdentityFailure::InvalidSplit
                    | IdentityFailure::ImpactSetChanged => FactFailure::Structural {
                        field: world_protocol::failure::FieldPath(vec![
                            "identity".into(),
                            "basis".into(),
                        ]),
                    },
                    IdentityFailure::InternalFault => FactFailure::InternalFault,
                };
                Self::caused_by(failure, crate::identity::IdentityError::Rejected(reason))
            }
        }
    }
}

impl From<DefinitionFailure> for Error {
    fn from(source: DefinitionFailure) -> Self {
        let reason = match &source {
            DefinitionFailure::MissingReference { reference } => FactFailure::MissingDefinition {
                reference: reference.clone(),
            },
            DefinitionFailure::TypeMismatch { field } => FactFailure::TypeMismatch {
                field: field.clone(),
            },
            DefinitionFailure::UnitMismatch { field } => FactFailure::UnitMismatch {
                field: field.clone(),
            },
            DefinitionFailure::ScopeConflict { .. } => FactFailure::ScopeMismatch,
            DefinitionFailure::ValidTimeConflict { .. }
            | DefinitionFailure::DeprecatedReference { .. } => FactFailure::ValidTimeMismatch,
            DefinitionFailure::RevisionConflict { expected, actual } => {
                FactFailure::RevisionConflict {
                    expected: *expected,
                    actual: *actual,
                }
            }
            DefinitionFailure::InvalidField {
                field,
                reason: DefinitionFieldReason::NullNotAllowed,
            } => FactFailure::TypeMismatch {
                field: field.clone(),
            },
            DefinitionFailure::InvalidField { field, .. }
            | DefinitionFailure::InvalidCardinality { field }
            | DefinitionFailure::MissingField { field }
            | DefinitionFailure::DuplicateLocalId { field }
            | DefinitionFailure::LimitExceeded { field, .. } => FactFailure::Structural {
                field: field.clone(),
            },
            DefinitionFailure::CrossWorldReference { .. } => FactFailure::CrossWorld,
            DefinitionFailure::WrongKind { .. } => FactFailure::TypeMismatch {
                field: world_protocol::failure::FieldPath(vec!["definition".into(), "kind".into()]),
            },
            DefinitionFailure::LifecycleConflict | DefinitionFailure::ImmutableRevision { .. } => {
                FactFailure::Structural {
                    field: world_protocol::failure::FieldPath(vec![
                        "definition".into(),
                        "lifecycle".into(),
                    ]),
                }
            }
            DefinitionFailure::Authorization { .. } => FactFailure::AccessDenied,
            DefinitionFailure::Commit { failure } => FactFailure::Commit {
                failure: failure.clone(),
            },
            DefinitionFailure::HeadConflict {
                expected, actual, ..
            } => FactFailure::RevisionConflict {
                expected: *expected,
                actual: *actual,
            },
            DefinitionFailure::CyclicDependency { .. }
            | DefinitionFailure::UnknownKind { .. }
            | DefinitionFailure::ProviderMissing { .. }
            | DefinitionFailure::KindContractIncomplete { .. } => FactFailure::Structural {
                field: world_protocol::failure::FieldPath(vec![
                    "definition".into(),
                    "contract".into(),
                ]),
            },
            DefinitionFailure::InternalFault => FactFailure::InternalFault,
        };
        Self::caused_by(reason, DefinitionCause(source))
    }
}

impl From<crate::definitions::DefinitionError> for Error {
    fn from(source: crate::definitions::DefinitionError) -> Self {
        match source {
            crate::definitions::DefinitionError::Rejected(failure) => failure.into(),
            source @ crate::definitions::DefinitionError::Compile(_) => {
                let crate::definitions::DefinitionError::Compile(failure) = &source else {
                    unreachable!()
                };
                Self::caused_by(
                    FactFailure::Compilation {
                        failure: failure.clone(),
                    },
                    source,
                )
            }
            crate::definitions::DefinitionError::Store(error) => error.into(),
            crate::definitions::DefinitionError::Codec(error) => {
                Self::caused_by(FactFailure::InternalFault, error)
            }
        }
    }
}

impl From<crate::query::QueryError> for Error {
    fn from(source: crate::query::QueryError) -> Self {
        use crate::query::QueryError;
        match source {
            QueryError::Store(error) => error.into(),
            QueryError::Authorization(error) => error.into(),
            QueryError::Identity(error) => error.into(),
            QueryError::Mapping(error) => error.into(),
            QueryError::Definition(error) => error.into(),
            QueryError::Fact(error) => error,
            source => Self::caused_by(FactFailure::InternalFault, source),
        }
    }
}

impl From<crate::sources::mapping::MappingError> for Error {
    fn from(source: crate::sources::mapping::MappingError) -> Self {
        use crate::sources::mapping::MappingError;
        match source {
            MappingError::Store(error) => error.into(),
            MappingError::Authorization(error) => error.into(),
            MappingError::Definition(error) => error.into(),
            MappingError::Release(error) => Self::caused_by(FactFailure::InternalFault, *error),
            MappingError::Mapping(failure) => Self::caused_by(
                FactFailure::SourceMapping {
                    failure: failure.clone(),
                },
                MappingError::Mapping(failure),
            ),
        }
    }
}

fn compilation_diagnostic(
    failure: &world_protocol::compiler::CompileFailure,
) -> (&'static str, &'static str, Recovery) {
    use world_protocol::compiler::CompileFailure;
    match failure {
        CompileFailure::ReferenceMissing { .. } | CompileFailure::ReferenceAmbiguous { .. } => (
            "world.fact_compile_reference",
            "编译依赖的精确定义不可用或不唯一。",
            Recovery::Refresh,
        ),
        CompileFailure::DependencyCycle { .. } => (
            "world.fact_compile_cycle",
            "定义依赖包含循环。",
            Recovery::None,
        ),
        CompileFailure::TypeMismatch { field, .. } => (
            "world.fact_compile_type",
            "定义表达式类型不匹配。",
            Recovery::CorrectInput {
                fields: vec![field.clone()],
            },
        ),
        CompileFailure::UnitMismatch { field, .. }
        | CompileFailure::CurrencyMismatch { field, .. } => (
            "world.fact_compile_unit",
            "定义表达式单位或币种不匹配。",
            Recovery::CorrectInput {
                fields: vec![field.clone()],
            },
        ),
        CompileFailure::TimeMismatch { .. } => (
            "world.fact_compile_time",
            "定义表达式时间语义不匹配。",
            Recovery::None,
        ),
        CompileFailure::ScopeMismatch { .. } => (
            "world.fact_compile_scope",
            "定义表达式越出允许范围。",
            Recovery::None,
        ),
        CompileFailure::EffectViolation { .. } => (
            "world.fact_compile_effect",
            "定义表达式声明了不允许的效果。",
            Recovery::None,
        ),
        CompileFailure::SourceCapabilityMissing { .. } => (
            "world.fact_compile_source_capability",
            "来源缺少编译所需的能力。",
            Recovery::None,
        ),
        CompileFailure::PolicyContractMissing { .. }
        | CompileFailure::PolicyContractMismatch { .. } => (
            "world.fact_compile_policy",
            "所需策略契约不可用或不兼容。",
            Recovery::Refresh,
        ),
        CompileFailure::RequiredProviderMissing { .. }
        | CompileFailure::PassContractInvalid { .. }
        | CompileFailure::PassOutputInvalid { .. } => (
            "world.fact_compile_provider",
            "必需的编译实现不可用或输出不符合契约。",
            Recovery::Refresh,
        ),
        CompileFailure::ArtifactInvalid { .. } | CompileFailure::GeneratedSdkInvalid { .. } => (
            "world.fact_compile_artifact",
            "编译制品不符合输出契约。",
            Recovery::None,
        ),
        CompileFailure::CompatibilityBreak { .. } => (
            "world.fact_compile_compatibility",
            "定义变更破坏已有调用契约。",
            Recovery::None,
        ),
        CompileFailure::Definition { failure } => {
            let safe = Error::from(failure.clone()).safe_failure();
            (
                "world.fact_compile_definition",
                "定义校验未通过。",
                safe.recovery,
            )
        }
        CompileFailure::InvalidExpression { field, .. }
        | CompileFailure::LimitExceeded { field } => (
            "world.fact_compile_expression",
            "定义表达式无效或超出编译资源限制。",
            Recovery::CorrectInput {
                fields: vec![field.clone()],
            },
        ),
        CompileFailure::Cancelled => (
            "world.fact_cancelled",
            "定义编译已取消，未提交变更。",
            Recovery::None,
        ),
        CompileFailure::InternalFault => (
            "world.fact_compile_internal_fault",
            "定义编译内部故障，请提供诊断编号。",
            Recovery::ManualReview,
        ),
    }
}

fn provenance_diagnostic(
    failure: &world_protocol::provenance::ProvenanceFailure,
) -> (&'static str, &'static str, Recovery) {
    use world_protocol::provenance::ProvenanceFailure;
    match failure {
        ProvenanceFailure::DependencyMissing { .. } => (
            "world.fact_support_dependency_missing",
            "缺少可信的规则求值或范围证明，未接受派生事实。",
            Recovery::None,
        ),
        ProvenanceFailure::LimitExceeded { .. } => (
            "world.fact_support_limit",
            "支持图处理达到本次资源上限，未提交变更。",
            Recovery::None,
        ),
        ProvenanceFailure::Dirty { .. } => (
            "world.fact_support_dirty",
            "支持依据尚待重算，未提交派生事实。",
            Recovery::Refresh,
        ),
        ProvenanceFailure::Cancelled => (
            "world.fact_cancelled",
            "事实准入已取消，未提交变更。",
            Recovery::None,
        ),
        ProvenanceFailure::CleanupFailed => (
            "world.fact_support_cleanup_failed",
            "支持清理未完成，请提供诊断编号。",
            Recovery::ManualReview,
        ),
        ProvenanceFailure::UnclosedRange { .. } | ProvenanceFailure::IncompleteNegativeRange => (
            "world.fact_support_range_incomplete",
            "授权范围尚未完整覆盖，不能据此接受否定结论。",
            Recovery::Refresh,
        ),
        ProvenanceFailure::CyclicSupport { .. } => (
            "world.fact_support_cycle",
            "支持图包含循环自证，未接受派生事实。",
            Recovery::None,
        ),
        ProvenanceFailure::MissingPremise => (
            "world.fact_support_missing_premise",
            "所需的精确支持前提不可用。",
            Recovery::Refresh,
        ),
        ProvenanceFailure::CrossScope => (
            "world.fact_support_scope_mismatch",
            "支持依据不属于结论允许的范围。",
            Recovery::None,
        ),
        ProvenanceFailure::InvalidInterval => (
            "world.fact_support_interval_invalid",
            "支持区间不能覆盖结论的有效时间。",
            Recovery::None,
        ),
        ProvenanceFailure::BasisChanged { .. } => (
            "world.fact_support_basis_changed",
            "支持依据已经变化，需要重新读取。",
            Recovery::Refresh,
        ),
        ProvenanceFailure::Commit { .. } | ProvenanceFailure::InternalFault => (
            "world.fact_internal_fault",
            "事实处理内部故障，请提供诊断编号。",
            Recovery::ManualReview,
        ),
    }
}

#[derive(Debug)]
struct DefinitionCause(DefinitionFailure);
impl fmt::Display for DefinitionCause {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "definition admission: {:?}", self.0)
    }
}
impl StdError for DefinitionCause {}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} ({})",
            self.safe_failure().code,
            self.diagnostic_id
        )
    }
}
impl fmt::Debug for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, formatter)
    }
}
impl StdError for Error {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        self.source
            .as_deref()
            .map(|source| source as &(dyn StdError + 'static))
    }
}
