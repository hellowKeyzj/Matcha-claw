use world_protocol::{
    api, authorization as auth, budget, commit, compiler, component, expression, facts,
    identity::SubjectRef, ids::*, materials, provenance, query, slots, sources, time, value,
};

use super::{WasmError, bindings::types as w};

pub(super) trait Wire: Sized {
    type Output;
    fn lower(self) -> Result<<Self as Wire>::Output, WasmError>;
    fn lift(value: <Self as Wire>::Output) -> Result<Self, WasmError>;
}
macro_rules! plain {
    ($($ty:ty),*) => {$(impl Wire for $ty {
        type Output = Self;
        fn lower(self) -> Result<Self, WasmError> { Ok(self) }
        fn lift(value: Self) -> Result<Self, WasmError> { Ok(value) }
    })*};
}
plain!(String, bool, u8, u16, u32, u64, i32, i64, f64);
impl<T: Wire> Wire for Vec<T> {
    type Output = Vec<T::Output>;
    fn lower(self) -> Result<<Self as Wire>::Output, WasmError> {
        self.into_iter().map(Wire::lower).collect()
    }
    fn lift(value: <Self as Wire>::Output) -> Result<Self, WasmError> {
        value.into_iter().map(T::lift).collect()
    }
}
impl<T: Wire> Wire for Option<T> {
    type Output = Option<T::Output>;
    fn lower(self) -> Result<<Self as Wire>::Output, WasmError> {
        self.map(Wire::lower).transpose()
    }
    fn lift(value: <Self as Wire>::Output) -> Result<Self, WasmError> {
        value.map(T::lift).transpose()
    }
}
impl<T: Wire> Wire for Box<T> {
    type Output = T::Output;
    fn lower(self) -> Result<<Self as Wire>::Output, WasmError> {
        (*self).lower()
    }
    fn lift(value: <Self as Wire>::Output) -> Result<Self, WasmError> {
        Ok(Box::new(T::lift(value)?))
    }
}
impl<T: Wire, E: Wire> Wire for Result<T, E> {
    type Output = Result<T::Output, E::Output>;
    fn lower(self) -> Result<<Self as Wire>::Output, WasmError> {
        Ok(match self {
            Ok(value) => Ok(value.lower()?),
            Err(error) => Err(error.lower()?),
        })
    }
    fn lift(value: <Self as Wire>::Output) -> Result<Self, WasmError> {
        Ok(match value {
            Ok(value) => Ok(T::lift(value)?),
            Err(error) => Err(E::lift(error)?),
        })
    }
}
macro_rules! text {
    ($($ty:ty),*) => {$(impl Wire for $ty {
        type Output = String;
        fn lower(self) -> Result<String, WasmError> { Ok(self.as_str().to_owned()) }
        fn lift(value: String) -> Result<Self, WasmError> {
            Self::try_new(value).map_err(|_| WasmError::InvalidData { field: stringify!($ty) })
        }
    })*};
}
text!(
    TenantId,
    WorldId,
    DefinitionId,
    AssertionId,
    EvidenceId,
    SupportId,
    WatchId,
    SourceId,
    ScopeId,
    ReleaseId,
    BranchId,
    ObjectId,
    RelationId,
    RoleId,
    RunId,
    ModelCallId,
    InvocationId,
    DiagnosticId,
    TestCaseId,
    InstallId,
    ContractId,
    PolicyId,
    ParameterId,
    SymbolId,
    ConnectionId,
    EffectIntentId,
    CommitId,
    SchemaId,
    MappingId,
    IdentityRuleId,
    CheckpointFormatId,
    SourceFieldId,
    BindingId,
    ChannelId,
    StateRootId,
    OperationId,
    ChangeSetId,
    TaskId,
    CaseId,
    SuiteId,
    EvaluationId,
    TransferId,
    ActivationLockId,
    NodeId,
    ProviderId,
    AbstractionId,
    AbstractionSlotId,
    AcquisitionId,
    ActorId,
    ApprovalId,
    ArtifactId,
    CandidateId,
    DecisionId,
    EventId,
    MigrationId,
    ModelBindingId,
    NativeRunId,
    OriginFamilyId,
    PackageId,
    ParseArtifactId,
    PluginGenerationId,
    ReadReceiptId,
    RequestId,
    ResourceToken,
    SourceReceiptId,
    SourceVersionId,
    StateId,
    StateNamespaceId,
    StepId,
    VerificationId,
    WriterDomain,
    Digest,
    time::Timestamp,
    value::Decimal,
    value::Currency
);
macro_rules! counter {
    ($($ty:ty),*) => {$(impl Wire for $ty {
        type Output = u64;
        fn lower(self) -> Result<u64, WasmError> { Ok(self.0) }
        fn lift(value: u64) -> Result<Self, WasmError> { Ok(Self(value)) }
    })*};
}
counter!(
    Revision,
    Generation,
    PolicyEpoch,
    GrantEpoch,
    PartitionEpoch,
    WriterEpoch,
    time::DurationMs
);
macro_rules! record {
    ($domain:path, $wire:ident; $($field:ident),* $(,)?) => {
        impl Wire for $domain {
            type Output = w::$wire;
            fn lower(self) -> Result<<Self as Wire>::Output, WasmError> {
                Ok(w::$wire { $($field: self.$field.lower()?),* })
            }
            fn lift(value: <Self as Wire>::Output) -> Result<Self, WasmError> {
                Ok(Self { $($field: Wire::lift(value.$field)?),* })
            }
        }
    };
}
macro_rules! unit_enum {
    ($domain:path, $wire:ident; $($variant:ident),* $(,)?) => {
        impl Wire for $domain {
            type Output = w::$wire;
            fn lower(self) -> Result<<Self as Wire>::Output, WasmError> {
                Ok(match self { $(Self::$variant => w::$wire::$variant),* })
            }
            fn lift(value: <Self as Wire>::Output) -> Result<Self, WasmError> {
                Ok(match value { $(w::$wire::$variant => Self::$variant),* })
            }
        }
    };
}
record!(WorldRef, WorldRef; tenant_id, world_id);
macro_rules! revision_ref {
    ($($domain:path),*) => {$(record!($domain, RevisionRef; world, id, revision);)*};
}
revision_ref!(
    DefinitionRef,
    AssertionRef,
    EvidenceRef,
    SupportRef,
    SchemaRef,
    MappingRef,
    IdentityRuleRef,
    StateRef
);
record!(value::Unit, Unit; code, dimension);
impl Wire for time::ValidTime {
    type Output = w::ValidTime;
    fn lower(self) -> Result<<Self as Wire>::Output, WasmError> {
        Ok(w::ValidTime {
            from: self.from.lower()?,
            to: self.to.lower()?,
        })
    }
    fn lift(value: <Self as Wire>::Output) -> Result<Self, WasmError> {
        Self::try_new(Wire::lift(value.from)?, Wire::lift(value.to)?).map_err(|_| {
            WasmError::InvalidData {
                field: "valid_time",
            }
        })
    }
}
impl Wire for value::Value {
    type Output = w::Value;
    fn lower(self) -> Result<<Self as Wire>::Output, WasmError> {
        component::ValueArena::from_value(&self)?.lower()
    }
    fn lift(value: <Self as Wire>::Output) -> Result<Self, WasmError> {
        Ok(component::ValueArena::lift(value)?.into_value()?)
    }
}
record!(component::ValueArena, Value; nodes, root);
record!(component::ValueField, ValueField; name, node);
impl Wire for component::ValueNode {
    type Output = w::ValueNode;
    fn lower(self) -> Result<<Self as Wire>::Output, WasmError> {
        use component::ValueNode as D;
        use w::ValueNode as W;
        Ok(match self {
            D::Null => W::Null,
            D::Boolean { value } => W::Boolean(value),
            D::Integer { value } => W::Integer(value),
            D::Decimal { value } => W::Decimal(value),
            D::Text { value } => W::Text(value),
            D::Money { amount, currency } => W::Money(w::Money { amount, currency }),
            D::Quantity {
                amount,
                unit_code,
                dimension,
            } => W::Quantity(w::Quantity {
                amount,
                unit: w::Unit {
                    code: unit_code,
                    dimension,
                },
            }),
            D::Timestamp { value } => W::Timestamp(value),
            D::Date { value, calendar } => W::Date(w::BusinessDate { value, calendar }),
            D::Duration { milliseconds } => W::Duration(milliseconds),
            D::Object { id } => W::Object(id),
            D::Relation { id } => W::Relation(id),
            D::List { items } => W::List(items),
            D::Record { fields } => W::Record(fields.lower()?),
        })
    }
    fn lift(value: <Self as Wire>::Output) -> Result<Self, WasmError> {
        use component::ValueNode as D;
        use w::ValueNode as W;
        Ok(match value {
            W::Null => D::Null,
            W::Boolean(value) => D::Boolean { value },
            W::Integer(value) => D::Integer { value },
            W::Decimal(value) => D::Decimal { value },
            W::Text(value) => D::Text { value },
            W::Money(w::Money { amount, currency }) => D::Money { amount, currency },
            W::Quantity(w::Quantity { amount, unit }) => D::Quantity {
                amount,
                unit_code: unit.code,
                dimension: unit.dimension,
            },
            W::Timestamp(value) => D::Timestamp { value },
            W::Date(w::BusinessDate { value, calendar }) => D::Date { value, calendar },
            W::Duration(milliseconds) => D::Duration { milliseconds },
            W::Object(id) => D::Object { id },
            W::Relation(id) => D::Relation { id },
            W::List(items) => D::List { items },
            W::Record(fields) => D::Record {
                fields: Wire::lift(fields)?,
            },
        })
    }
}
impl Wire for value::ValueType {
    type Output = w::ValueType;
    fn lower(self) -> Result<<Self as Wire>::Output, WasmError> {
        component::TypeArena::from_type(&self)?.lower()
    }
    fn lift(value: <Self as Wire>::Output) -> Result<Self, WasmError> {
        Ok(component::TypeArena::lift(value)?.into_type()?)
    }
}
record!(component::TypeArena, ValueType; nodes, root);
record!(component::TypeField, TypeField; name, node, nullable, optional);
impl Wire for component::TypeNode {
    type Output = w::TypeNode;
    fn lower(self) -> Result<<Self as Wire>::Output, WasmError> {
        use component::TypeNode as D;
        use w::TypeNode as W;
        Ok(match self {
            D::Null => W::Null,
            D::Boolean => W::Boolean,
            D::Integer => W::Integer,
            D::Decimal { precision, scale } => W::Decimal(w::DecimalType { precision, scale }),
            D::Text { max_length } => W::Text(max_length),
            D::Money { currency } => W::Money(currency),
            D::Quantity {
                unit_code,
                dimension,
            } => W::Quantity(w::Unit {
                code: unit_code,
                dimension,
            }),
            D::Timestamp { time_zone } => W::Timestamp(time_zone),
            D::Date { calendar } => W::Date(calendar),
            D::Duration => W::Duration,
            D::Object { type_id } => W::Object(type_id),
            D::Relation { type_id } => W::Relation(type_id),
            D::List { element, max_items } => W::List(w::ListType { element, max_items }),
            D::Record { fields } => W::Record(fields.lower()?),
        })
    }
    fn lift(value: <Self as Wire>::Output) -> Result<Self, WasmError> {
        use component::TypeNode as D;
        use w::TypeNode as W;
        Ok(match value {
            W::Null => D::Null,
            W::Boolean => D::Boolean,
            W::Integer => D::Integer,
            W::Decimal(w::DecimalType { precision, scale }) => D::Decimal { precision, scale },
            W::Text(max_length) => D::Text { max_length },
            W::Money(currency) => D::Money { currency },
            W::Quantity(unit) => D::Quantity {
                unit_code: unit.code,
                dimension: unit.dimension,
            },
            W::Timestamp(time_zone) => D::Timestamp { time_zone },
            W::Date(calendar) => D::Date { calendar },
            W::Duration => D::Duration,
            W::Object(type_id) => D::Object { type_id },
            W::Relation(type_id) => D::Relation { type_id },
            W::List(w::ListType { element, max_items }) => D::List { element, max_items },
            W::Record(fields) => D::Record {
                fields: Wire::lift(fields)?,
            },
        })
    }
}

// These macros describe only fixed WIT shapes; they do not serialize a generic payload.
macro_rules! tagged {
    ($domain:path, $wire:ident;
        units [$($unit:ident),* $(,)?];
        single [$($variant:ident { $field:ident }),* $(,)?];
        records [$($record:ident { $($member:ident),+ } => $payload:ident),* $(,)?]
    ) => { impl Wire for $domain {
        type Output = w::$wire;
        fn lower(self) -> Result<<Self as Wire>::Output, WasmError> {
            Ok(match self {
                $(Self::$unit => w::$wire::$unit,)*
                $(Self::$variant { $field } => w::$wire::$variant($field.lower()?),)*
                $(Self::$record { $($member),+ } => w::$wire::$record(w::$payload { $($member: $member.lower()?),+ }),)*
            })
        }
        fn lift(value: <Self as Wire>::Output) -> Result<Self, WasmError> {
            Ok(match value {
                $(w::$wire::$unit => Self::$unit,)*
                $(w::$wire::$variant(value) => Self::$variant { $field: Wire::lift(value)? },)*
                $(w::$wire::$record(value) => Self::$record { $($member: Wire::lift(value.$member)?),+ },)*
            })
        }
    }};
}
macro_rules! tuple_enum {
    ($domain:path, $wire:ident; $($variant:ident),* $(,)?) => { impl Wire for $domain {
        type Output = w::$wire;
        fn lower(self) -> Result<<Self as Wire>::Output, WasmError> { Ok(match self { $(Self::$variant(value) => w::$wire::$variant(value.lower()?)),* }) }
        fn lift(value: <Self as Wire>::Output) -> Result<Self, WasmError> { Ok(match value { $(w::$wire::$variant(value) => Self::$variant(Wire::lift(value)?)),* }) }
    }};
}
tagged!(SubjectRef, Subject; units []; single [Object { id }, Relation { id }]; records []);
unit_enum!(value::UnknownReason, UnknownReason; NotObserved, Unmapped, NeedsEvidence, Unsupported, IncompleteCoverage, PendingRecomputation);
tagged!(value::Cell, Cell; units []; single [Known { value }, Unknown { reason }, Conflicted { assertions }]; records [SourceUnavailable { source_id, failure } => Unavailable]);
tagged!(value::DirtyState, DirtyState; units [Clean]; single []; records [Dirty { generation, invalidated_at, watches } => DirtyDetail]);
record!(query::FieldCell, FieldCell; property, cell, evidence, dirty);
record!(slots::ProjectedCell, ProjectedCell; subject, field);
record!(facts::AttributeClaim, AttributeClaim; subject, property, value);
record!(facts::RoleBinding, RoleBinding; role, object_id);
record!(facts::RelationClaim, RelationClaim; relation_id, relation_type, roles);
tuple_enum!(facts::Claim, Claim; Attribute, Relation);
unit_enum!(facts::Polarity, Polarity; Positive, Negative);
unit_enum!(facts::AssertionStatus, AssertionStatus; Candidate, Accepted, Rejected, Withdrawn);
impl Wire for facts::AssertionOrigin {
    type Output = w::AssertionOrigin;
    fn lower(self) -> Result<<Self as Wire>::Output, WasmError> {
        Ok(match self {
            Self::Source {
                binding,
                authority,
                position,
            } => w::AssertionOrigin::Source(w::SourceOrigin {
                binding: binding.lower()?,
                authority: authority.lower()?,
                position: position.lower()?,
            }),
            Self::Derived {} => w::AssertionOrigin::Derived,
            Self::HumanObservation { invocation_id } => {
                w::AssertionOrigin::HumanObservation(invocation_id.lower()?)
            }
            Self::Extraction {
                run_id,
                model_call_id,
            } => w::AssertionOrigin::Extraction(w::ExtractionOrigin {
                run_id: run_id.lower()?,
                model_call_id: model_call_id.lower()?,
            }),
        })
    }
    fn lift(value: <Self as Wire>::Output) -> Result<Self, WasmError> {
        Ok(match value {
            w::AssertionOrigin::Source(value) => Self::Source {
                binding: Wire::lift(value.binding)?,
                authority: Wire::lift(value.authority)?,
                position: Wire::lift(value.position)?,
            },
            w::AssertionOrigin::Derived => Self::Derived {},
            w::AssertionOrigin::HumanObservation(value) => Self::HumanObservation {
                invocation_id: Wire::lift(value)?,
            },
            w::AssertionOrigin::Extraction(value) => Self::Extraction {
                run_id: Wire::lift(value.run_id)?,
                model_call_id: Wire::lift(value.model_call_id)?,
            },
        })
    }
}
record!(facts::Assertion, Assertion; reference, scope, claim, polarity, valid_time, recorded_at, superseded_at, status, origin, evidence, supersedes);
record!(facts::ObservationDraft, ObservationDraft; claim, polarity, scope, valid_time, observed_at, origin, evidence, supersedes);
record!(sources::AuthorityRef, AuthorityRef; policy_id, revision, fields, roles);
tagged!(facts::AuthorityOwnership, AuthorityOwnership; units []; single [Properties { properties }]; records [RelationRoles { relation_type, roles } => OwnedRoles]);
record!(facts::SourceAuthority, SourceAuthority; incarnation, world, source_id, binding, authority, scope, valid_time, recorded_at, ownership);
record!(sources::SourcePosition, SourcePosition; source_id, incarnation, partition, format, cursor, transaction, event_index);
tagged!(provenance::ReadDependency, ReadDependency; units []; single [Assertion { reference }, Evidence { reference }, Definition { reference }, TimeBoundary { at }]; records [Watch { id, generation } => WatchDependency, Source { position, binding } => SourceReadDependency, Identity { subject, revision } => IdentityDependency, AliasRange { digest, generation } => AliasDependency, SourceMapping { mapping, identity_rule, authority, binding } => MappingDependency, SourceField { schema, field, value_type, nullable, optional, name } => SourceFieldDependency]);
tuple_enum!(provenance::PremiseRef, Premise; Assertion, Evidence, Read);
unit_enum!(provenance::SupportStatus, SupportStatus; Valid, Invalid, Pending);
record!(provenance::SupportSet, SupportSet; reference, conclusion, rule, arguments, scope, valid_time, release_id, branch_id, premises, status, dirty);
unit_enum!(sources::SourceGuarantee, SourceGuarantee; Projection, Authoritative, RecordedReplay, Assumed);
unit_enum!(sources::GapReason, GapReason; PositionExpired, NonReplayable, IncompleteEnumeration, PermissionNarrowed, SchemaDrift, InterruptedSnapshot);
record!(sources::SourceGap, SourceGap; reason, after, before);
record!(sources::SourceBasis, SourceBasis; source_id, incarnation, binding, mapping_revision, authority_revision, schema, identity_rule, field_definitions, position, snapshot, observed_at, captured_at, last_reconciled_at, guarantee, gap);
record!(budget::Cost, Cost; amount, currency);
record!(budget::Budget, Budget; max_wall_time, max_steps, max_source_reads, max_rows, max_bytes, max_model_calls, max_input_tokens, max_output_tokens, max_cost, deadline);
record!(compiler::CompileDiagnostic, Diagnostic; definition, field, severity, code, diagnostic_id);
unit_enum!(compiler::DiagnosticSeverity, DiagnosticSeverity; Warning, Error);
impl Wire for world_protocol::failure::FieldPath {
    type Output = Vec<String>;
    fn lower(self) -> Result<<Self as Wire>::Output, WasmError> {
        Ok(self.0)
    }
    fn lift(value: <Self as Wire>::Output) -> Result<Self, WasmError> {
        Ok(Self(value))
    }
}
record!(slots::ProjectionSourceWitness, ProjectionSourceWitness; basis, cell);
record!(slots::ProjectionRequest, ProjectionRequest; world, release_id, definitions, scopes, scope, valid_time, known_at, cells, fixed, assertions, sources, basis, dependencies, budget);
record!(slots::ProjectionResult, ProjectionResult; cells, dependencies, diagnostics);
record!(slots::ReconcileRequest, ReconcileRequest; world, release_id, definitions, scopes, scope, valid_time, known_at, cells, fixed, assertions, sources, basis, dependencies, budget);
record!(slots::ReconcileResult, ReconcileResult; selected, conflicts, observations, dependencies);
record!(slots::OracleQueryObservation, OracleQueryObservation; step_id, page);
record!(slots::OracleRequest, OracleRequest; world, test_case_id, fixture, expected, observed, queries, budget);
record!(slots::OracleResult, OracleResult; passed, evidence, diagnostics, evidence_satisfied, evidence_required, conflicts_detected, conflicts_present);
tagged!(slots::ProjectionFailure, ProjectionFailure; units [BasisChanged, BudgetExceeded, Cancelled, InternalFault]; single [InvalidInput { field }]; records []);
tagged!(slots::ReconcileFailure, ReconcileFailure; units [AuthorityMissing, BasisChanged, BudgetExceeded, Cancelled, InternalFault]; single [InvalidInput { field }]; records []);
unit_enum!(slots::OracleFailure, OracleFailure; BadFixture, SchemaMismatch, Unavailable, BudgetExceeded, Cancelled, InternalFault);
record!(api::ConfigValue, ConfigValue; name, value);
record!(api::PackageConfigView, PackageConfig; install_id, revision, digest, fields);

macro_rules! variant {
    ($domain:path, $wire:ident;
        units [$($unit:ident),* $(,)?];
        tuples [$($tuple:ident),* $(,)?];
        records [$($record:ident { $($member:ident),+ } => $payload:ident),* $(,)?]
    ) => { impl Wire for $domain {
        type Output = w::$wire;
        fn lower(self) -> Result<<Self as Wire>::Output, WasmError> {
            Ok(match self {
                $(Self::$unit => w::$wire::$unit,)*
                $(Self::$tuple(value) => w::$wire::$tuple(value.lower()?),)*
                $(Self::$record { $($member),+ } => w::$wire::$record(w::$payload { $($member: $member.lower()?),+ }),)*
            })
        }
        fn lift(value: <Self as Wire>::Output) -> Result<Self, WasmError> {
            Ok(match value {
                $(w::$wire::$unit => Self::$unit,)*
                $(w::$wire::$tuple(value) => Self::$tuple(Wire::lift(value)?),)*
                $(w::$wire::$record(value) => Self::$record { $($member: Wire::lift(value.$member)?),+ },)*
            })
        }
    }};
}

#[path = "convert/abstraction.rs"]
mod abstraction_types;
#[path = "convert/actions.rs"]
mod actions_types;
#[path = "convert/api.rs"]
mod api_types;
#[path = "convert/authorization.rs"]
mod authorization_types;
#[path = "convert/bindings.rs"]
mod bindings_types;
#[path = "convert/commit.rs"]
mod commit_types;
#[path = "convert/compiler.rs"]
mod compiler_types;
#[path = "convert/definitions.rs"]
mod definitions_types;
#[path = "convert/evaluation.rs"]
mod evaluation_types;
#[path = "convert/expression.rs"]
mod expression_types;
#[path = "convert/facts.rs"]
mod facts_types;
#[path = "convert/failure.rs"]
mod failure_types;
#[path = "convert/generation.rs"]
mod generation_types;
#[path = "convert/identity.rs"]
mod identity_types;
#[path = "convert/learning.rs"]
mod learning_types;
#[path = "convert/lifecycle.rs"]
mod lifecycle_types;
#[path = "convert/materials.rs"]
mod materials_types;
#[path = "convert/operation.rs"]
mod operation_types;
#[path = "convert/package.rs"]
mod package_types;
#[path = "convert/process.rs"]
mod process_types;
#[path = "convert/provenance.rs"]
mod provenance_types;
#[path = "convert/query.rs"]
mod query_types;
#[path = "convert/releases.rs"]
mod releases_types;
#[path = "convert/slots.rs"]
mod slots_types;
mod source;
#[path = "convert/sources.rs"]
mod sources_types;
#[path = "convert/state.rs"]
mod state_types;
