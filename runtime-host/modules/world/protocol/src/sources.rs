use crate::{
    expression::ExpressionIr,
    ids::*,
    time::{DurationMs, Timestamp},
    value::{Value, ValueType},
};
use serde::{Deserialize, Serialize};

pub const POSTGRES_REGISTRATION: &str = "source.postgres.v1";
pub const HTTP_JSON_REGISTRATION: &str = "source.http-json.v1";
pub fn read_contract() -> Result<ContractRef, crate::schema::SchemaFailure> {
    crate::slots::slot_contract(crate::bindings::SlotKind::Connector)
}
pub fn discover_contract() -> Result<ContractRef, crate::schema::SchemaFailure> {
    crate::schema::method::<SourceSchemaRequest, SchemaObservation, SourceFailure>(
        "source.discover",
    )
}
pub fn write_contract() -> Result<ContractRef, crate::schema::SchemaFailure> {
    crate::schema::method::<
        crate::actions::EffectIntent,
        crate::actions::SourceReceipt,
        SourceFailure,
    >("source.write")
}
pub fn inspect_contract() -> Result<ContractRef, crate::schema::SchemaFailure> {
    crate::schema::method::<
        crate::actions::EffectIntent,
        crate::actions::SourceReceipt,
        SourceFailure,
    >("source.inspect")
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionRevision {
    pub world: WorldRef,
    pub id: ConnectionId,
    pub revision: Revision,
    pub source_id: SourceId,
    pub name: String,
    pub scope: ScopeId,
    pub connector: ProviderId,
    pub config: SourceConnectionConfig,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "config",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SourceConnectionConfig {
    Postgres(PostgresConnectionConfig),
    HttpJson(HttpJsonConnectionConfig),
    Plugin(PluginConnectionConfig),
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginConnectionConfig {
    pub resources: Vec<PluginResource>,
    pub declared_capabilities: SourceCapabilities,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginResource {
    pub id: String,
    pub fields: Vec<DiscoveredField>,
    pub key: Vec<SourceFieldId>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PostgresConnectionConfig {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub schema: String,
    pub tls: PostgresTls,
    pub logical: Option<PostgresLogicalConfig>,
    pub resources: Vec<PostgresResource>,
    pub declared_capabilities: SourceCapabilities,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PostgresTls {
    Required,
    Disabled,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PostgresLogicalConfig {
    pub slot: String,
    pub plugin: PostgresLogicalPlugin,
    pub snapshot_slot: PostgresSnapshotSlot,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PostgresSnapshotSlot {
    Existing,
    CreateFresh,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PostgresLogicalPlugin {
    Wal2JsonV2,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PostgresResource {
    pub id: String,
    pub table: String,
    pub fields: Vec<SourceResourceField>,
    pub key: Vec<SourceFieldId>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceResourceField {
    pub id: SourceFieldId,
    pub column: String,
    pub value_type: ValueType,
    pub nullable: bool,
    pub optional: bool,
    pub readable: bool,
    pub writable: bool,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HttpJsonConnectionConfig {
    pub origin: String,
    pub read_path: String,
    pub schema_path: Option<String>,
    pub query_path: Option<String>,
    pub write_path: Option<String>,
    pub inspect_path: Option<String>,
    pub changes: Option<HttpJsonChangeFeed>,
    pub resources: Vec<HttpJsonResource>,
    pub declared_capabilities: SourceCapabilities,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HttpJsonChangeFeed {
    pub format: CheckpointFormatId,
    pub read_path: String,
    pub ack_path: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HttpJsonResource {
    pub id: String,
    pub fields: Vec<HttpJsonField>,
    pub key: Vec<SourceFieldId>,
    pub rows_pointer: String,
    pub continuation_pointer: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HttpJsonField {
    pub id: SourceFieldId,
    pub pointer: String,
    pub value_type: ValueType,
    pub nullable: bool,
    pub optional: bool,
    pub readable: bool,
    pub writable: bool,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SourcePlanReason {
    Empty,
    UnknownResource,
    UnknownField,
    FieldNotReadable,
    FieldNotWritable,
    InvalidKey,
    InvalidIdentifier,
    InvalidEndpoint,
    UnsupportedPredicate,
    UnsupportedOrdering,
    UnsupportedHistory,
    UnsupportedLimit,
    InvalidValue,
    CapabilityNotDeclared,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourcePosition {
    pub source_id: SourceId,
    pub incarnation: String,
    pub partition: String,
    pub format: CheckpointFormatId,
    pub cursor: String,
    pub transaction: Option<String>,
    #[serde(with = "crate::wire::optional_u64_decimal")]
    #[schemars(with = "Option<String>")]
    pub event_index: Option<u64>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceCapabilities {
    pub contract: ContractRef,
    pub snapshot: SnapshotCapability,
    pub historical_read: bool,
    pub change_stream: ChangeStreamCapability,
    pub conditional_write: bool,
    pub idempotency_key: bool,
    pub inspect_effect: bool,
    pub predicate_pushdown: bool,
    pub ordering_pushdown: bool,
    pub aggregate_pushdown: bool,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotCapability {
    Transactional,
    StableKeyEnumeration,
    WeakPagination,
    None,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChangeStreamCapability {
    ResumableTransactions,
    ResumableEvents,
    NonReplayable,
    None,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContractRef {
    pub id: ContractId,
    pub version: String,
    pub schema_digest: Digest,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceBinding {
    pub source_id: SourceId,
    pub connection_id: ConnectionId,
    pub connection_revision: Revision,
    pub connector: ProviderId,
    pub resource: String,
    pub namespace: String,
    pub incarnation: String,
    pub scope: ScopeId,
    pub schema: SchemaRef,
    pub mapping: MappingRef,
    pub identity_rule: IdentityRuleRef,
    pub selected_fields: Vec<SourceFieldId>,
    pub field_modes: Vec<FieldMode>,
    pub identity_mapping: IdentityMapping,
    pub field_mapping: Vec<FieldMapping>,
    pub role_mapping: Vec<RoleMapping>,
    pub authority: AuthorityRef,
    pub capabilities: SourceCapabilities,
    pub mode: BindingMode,
    pub sync: SyncPolicy,
    pub retention: RetentionPolicy,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdentityMapping {
    pub type_id: DefinitionId,
    pub key_fields: Vec<String>,
    pub incarnation_field: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FieldMapping {
    pub source_field: String,
    pub property: DefinitionRef,
    pub source_type: ValueType,
    pub transform: Option<SourceTransform>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoleMapping {
    pub source_field: String,
    pub role: RoleId,
    pub target_source_id: SourceId,
    pub target_namespace: String,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorityRef {
    pub policy_id: PolicyId,
    pub revision: Revision,
    pub fields: Vec<DefinitionId>,
    pub roles: Vec<RoleId>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BindingMode {
    Virtual,
    Projected,
    Hybrid,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SyncPolicy {
    OnDemand,
    Poll { interval: DurationMs },
    ChangeStream,
    Webhook,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetentionPolicy {
    pub policy_id: PolicyId,
    pub revision: Revision,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceSchemaRequest {
    pub resource: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceReadPlan {
    pub binding: DefinitionRef,
    pub resource: String,
    pub row_symbol: SymbolId,
    pub fields: Vec<String>,
    pub predicate: Option<ExpressionIr>,
    pub order: Vec<SourceOrder>,
    pub limit: u32,
    pub continuation: Option<String>,
    pub as_of: Option<Timestamp>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceOrder {
    pub field: String,
    pub descending: bool,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceRow {
    pub native_key: String,
    pub incarnation: String,
    pub fields: Vec<SourceField>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceField {
    pub id: SourceFieldId,
    pub name: String,
    pub value: RecordCell,
    pub raw_lexeme: Option<String>,
    pub formula: Option<FormulaValue>,
    pub locator: Option<crate::materials::SourceAnchor>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourcePage {
    pub rows: Vec<SourceRow>,
    pub basis: SourceBasis,
    pub continuation: Option<String>,
    pub complete: bool,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceBasis {
    pub source_id: SourceId,
    pub incarnation: String,
    pub binding: DefinitionRef,
    pub mapping_revision: Revision,
    pub authority_revision: Revision,
    pub schema: SchemaRef,
    pub identity_rule: IdentityRuleRef,
    pub field_definitions: Vec<DefinitionRef>,
    pub position: Option<SourcePosition>,
    pub snapshot: Option<String>,
    pub observed_at: Timestamp,
    pub captured_at: Option<Timestamp>,
    pub last_reconciled_at: Option<Timestamp>,
    pub guarantee: SourceGuarantee,
    pub gap: Option<SourceGap>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SourceGuarantee {
    Projection,
    Authoritative,
    RecordedReplay,
    Assumed,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceGap {
    pub reason: GapReason,
    pub after: Option<SourcePosition>,
    pub before: Option<SourcePosition>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BranchSourceCapture {
    pub branch: crate::releases::BranchRef,
    pub compile_digest: Digest,
    pub model_digest: Digest,
    pub binding: DefinitionRef,
    pub plan_digest: Digest,
    pub source_version: crate::materials::SourceVersionRef,
    pub basis: SourceBasis,
    pub proposals: Vec<BranchRecordProposal>,
    pub evidence: Vec<crate::facts::Evidence>,
    pub failures: Vec<FieldMappingFailure>,
    pub complete: bool,
    pub consistent: bool,
    pub digest: Digest,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BranchRecordProposal {
    pub key: crate::identity::SourceKey,
    pub type_ref: DefinitionRef,
    pub identity: Option<crate::identity::IdentitySnapshot>,
    pub fields: Vec<BranchFieldProposal>,
    pub relations: Vec<BranchRelationProposal>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BranchFieldProposal {
    pub property: DefinitionRef,
    pub cell: crate::value::Cell,
    pub evidence: Vec<EvidenceRef>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BranchRelationProposal {
    pub relation_type: DefinitionRef,
    pub roles: Vec<BranchRoleProposal>,
    pub evidence: Vec<EvidenceRef>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BranchRoleProposal {
    pub role: RoleId,
    pub target_source: SourceId,
    pub target_namespace: String,
    pub native_key: String,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceRecordState {
    pub key: crate::identity::SourceKey,
    pub scope: ScopeId,
    pub revision: Revision,
    pub status: SourceRecordStatus,
    pub basis: SourceBasis,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SourceRecordStatus {
    Available,
    Unavailable,
    NeedsReconcile,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GapReason {
    PositionExpired,
    NonReplayable,
    IncompleteEnumeration,
    PermissionNarrowed,
    SchemaDrift,
    InterruptedSnapshot,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceEvent {
    pub event_id: EventId,
    pub position: SourcePosition,
    pub occurred_at: Option<Timestamp>,
    pub change: SourceChange,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SourceChange {
    Upsert {
        row: SourceRow,
    },
    Delete {
        native_key: String,
        incarnation: String,
    },
    SchemaChanged {
        schema_digest: Digest,
    },
    TransactionEnd {
        transaction: String,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrderedSourceBatch {
    pub binding: DefinitionRef,
    pub epoch: PartitionEpoch,
    pub events: Vec<SourceEvent>,
    pub transaction_complete: bool,
    pub captured: SourcePosition,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceCheckpoint {
    pub binding: DefinitionRef,
    pub epoch: PartitionEpoch,
    pub captured: Option<SourcePosition>,
    pub applied: Option<SourcePosition>,
    pub acknowledged: Option<SourcePosition>,
    pub projected: Option<SourcePosition>,
    pub gap: Option<SourceGap>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SourceFailure {
    Authorization {
        failure: crate::authorization::AuthorizationFailure,
    },
    Commit {
        failure: crate::commit::CommitFailure,
    },
    Binding {
        failure: crate::bindings::BindingFailure,
    },
    Compile {
        failure: crate::compiler::CompileFailure,
    },
    Mapping {
        failure: MappingFailure,
    },
    Release {
        failure: Box<crate::releases::ReleaseFailure>,
    },
    Lifecycle {
        failure: crate::lifecycle::LifecycleFailure,
    },
    Package {
        failure: crate::package::PackageFailure,
    },
    PluginInvocation {
        failure: Box<crate::process::HostFailure>,
    },
    ConcurrentCallLimit,
    BudgetExceeded {
        dimension: crate::budget::BudgetDimension,
    },
    Cleanup {
        primary: Option<Box<SourceFailure>>,
        code: String,
    },
    InvalidPlan {
        field: crate::failure::FieldPath,
        reason: SourcePlanReason,
    },
    ConnectionMissing {
        connection_id: ConnectionId,
    },
    RevisionConflict {
        expected: Revision,
        actual: Revision,
    },
    SqlState {
        code: String,
    },
    ResponseInvalid {
        field: crate::failure::FieldPath,
    },
    ResponseLimit,
    EffectIndeterminate {
        intent_id: EffectIntentId,
    },
    Credential {
        reason: SourceCredentialReason,
    },
    Authentication,
    PermissionDenied,
    Connection,
    ConnectTimeout,
    ReadTimeout,
    RateLimited {
        retry_after: Option<DurationMs>,
    },
    ServiceUnavailable,
    UnsupportedField {
        field: String,
    },
    HistoryUnavailable,
    CapabilityMissing {
        capability: SourceCapability,
    },
    SchemaDrift {
        expected: Digest,
        actual: Digest,
    },
    CheckpointIncompatible {
        format: CheckpointFormatId,
    },
    PositionExpired,
    PositionIncomparable,
    IncompleteTransaction,
    ReaderNotStopped,
    AckChannelNotStopped,
    EpochStale {
        expected: PartitionEpoch,
        actual: PartitionEpoch,
    },
    Gap {
        reason: GapReason,
    },
    ProtocolViolation,
    UpstreamUnrecognized {
        safe_code: String,
    },
    Cancelled,
    InternalFault,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SourceCredentialReason {
    Missing,
    ResolverUnavailable,
    ResolverAuthentication,
    DecryptFailed,
    Invalid,
    StoreUnavailable,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SourceCapability {
    SchemaDiscovery,
    Snapshot,
    History,
    ChangeStream,
    ConditionalWrite,
    Idempotency,
    InspectEffect,
    Filter,
    Sort,
    Aggregate,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RecordCell {
    Missing,
    Known { value: Value },
    Error { code: RecordError },
}
/// Source identities use canonical typed values, never backend-specific textual formatting.
pub fn native_key(cells: &[RecordCell]) -> Result<String, SourceFailure> {
    let invalid = || SourceFailure::ResponseInvalid {
        field: crate::failure::FieldPath(vec!["key".into()]),
    };
    if cells.is_empty() {
        return Err(invalid());
    }
    let mut values = Vec::with_capacity(cells.len());
    for cell in cells {
        let RecordCell::Known { value } = cell else {
            return Err(invalid());
        };
        if matches!(value, Value::Null) {
            return Err(invalid());
        }
        values.push(value);
    }
    serde_json::to_string(&values).map_err(|_| SourceFailure::InternalFault)
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RecordError {
    InvalidNumber,
    InvalidDate,
    InvalidFormula,
    PrecisionLost,
    UnsupportedValue,
    PermissionDenied,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FormulaValue {
    pub expression: String,
    pub cached: Option<Value>,
    pub cache_current: bool,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FieldMode {
    pub field_id: SourceFieldId,
    pub mode: BindingMode,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SchemaObservation {
    pub incarnation: String,
    pub namespace: String,
    pub fields: Vec<DiscoveredField>,
    pub keys: Vec<KeyDeclaration>,
    pub complete: bool,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SchemaDiscovery {
    pub reference: SchemaRef,
    pub source_id: SourceId,
    pub incarnation: String,
    pub namespace: String,
    pub fields: Vec<DiscoveredField>,
    pub keys: Vec<KeyDeclaration>,
    pub complete: bool,
    pub observed_at: Timestamp,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiscoveredField {
    pub id: SourceFieldId,
    pub name: String,
    pub value_type: ValueType,
    pub nullable: bool,
    pub optional: bool,
    pub readable: bool,
    pub writable: bool,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyDeclaration {
    pub fields: Vec<SourceFieldId>,
    pub basis: KeyBasis,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum KeyBasis {
    DeclaredPrimary,
    DeclaredUnique,
    ObservedUnique,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SchemaMapping {
    pub reference: MappingRef,
    pub schema: SchemaRef,
    pub identity_rule: IdentityRuleRef,
    pub type_ref: DefinitionRef,
    pub key_fields: Vec<SourceFieldId>,
    pub fields: Vec<MappedField>,
    pub relations: Vec<MappedRelation>,
    pub delete: DeleteSemantics,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MappedField {
    pub source_field: SourceFieldId,
    pub property: DefinitionRef,
    pub transform: SourceTransform,
    pub missing: MissingSemantics,
    pub null: NullSemantics,
    pub formula: FormulaSemantics,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MappedRelation {
    pub relation_type: DefinitionRef,
    pub roles: Vec<MappedRole>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MappedRole {
    pub role: RoleId,
    pub source_field: SourceFieldId,
    pub target_source: SourceId,
    pub target_namespace: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SourceTransform {
    Identity,
    ExactInteger,
    ExactDecimal,
    Money { currency: crate::value::Currency },
    Quantity { unit: crate::value::Unit },
    Timestamp,
    Text,
    Boolean,
    Date { calendar: String },
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MissingSemantics {
    Unknown,
    Skip,
    Reject,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum NullSemantics {
    KnownNull,
    Reject,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FormulaSemantics {
    RequireCurrentCache,
    PreserveOnly,
    Reject,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DeleteSemantics {
    WithdrawSourceClaims,
    MarkUnavailable,
    RequireReconcile,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordBatch {
    pub source_id: SourceId,
    pub incarnation: String,
    pub schema: SchemaRef,
    pub rows: Vec<SourceRow>,
    pub deleted_keys: Vec<String>,
    pub source_version: crate::materials::SourceVersionRef,
    pub valid_time: crate::time::ValidTime,
    pub complete: bool,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompiledSourcePlan {
    pub blocked_fields: Vec<FieldMappingFailure>,
    pub binding_body: SourceBinding,
    pub schema: SchemaDiscovery,
    pub relation_definitions: Vec<crate::definitions::Definition<crate::definitions::RelationType>>,
    pub binding: DefinitionRef,
    pub mapping: SchemaMapping,
    pub authority: crate::facts::SourceAuthority,
    pub field_definitions: Vec<crate::definitions::Definition<crate::definitions::Property>>,
    pub digest: Digest,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompileSourceRequest {
    pub relation_definitions: Vec<crate::definitions::Definition<crate::definitions::RelationType>>,
    pub binding: crate::definitions::Definition<SourceBinding>,
    pub schema: SchemaDiscovery,
    pub mapping: SchemaMapping,
    pub authority: crate::facts::SourceAuthority,
    pub field_definitions: Vec<crate::definitions::Definition<crate::definitions::Property>>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MapRecordsRequest {
    pub observed_schema: SchemaDiscovery,
    pub source_version: crate::materials::SourceVersion,
    pub batch: RecordBatch,
    pub plan: CompiledSourcePlan,
    pub identities: Vec<crate::identity::IdentityReceipt>,
    pub basis: SourceBasis,
    pub budget: crate::budget::Budget,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MapRecordsResult {
    pub deletions: Vec<SourceDeletionProposal>,
    pub cells: Vec<MappedCellProposal>,
    pub observations: Vec<crate::facts::ObservationDraft>,
    pub evidence: Vec<crate::facts::Evidence>,
    pub failures: Vec<FieldMappingFailure>,
    pub gaps: Vec<SourceGap>,
    pub dependencies: Vec<crate::provenance::ReadDependency>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceDeletionProposal {
    pub key: crate::identity::SourceKey,
    pub subject: crate::identity::SubjectRef,
    pub semantics: DeleteSemantics,
    pub dependencies: Vec<crate::provenance::ReadDependency>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MappedCellProposal {
    pub subject: crate::identity::SubjectRef,
    pub property: DefinitionRef,
    pub cell: crate::value::Cell,
    pub locator: Option<crate::materials::SourceAnchor>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FieldMappingFailure {
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub row: u64,
    pub field: Option<SourceFieldId>,
    pub failure: MappingFailure,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MappingFailure {
    SchemaMissing {
        reference: SchemaRef,
    },
    MappingChanged {
        reference: MappingRef,
    },
    IdentityUnresolved,
    IdentityAmbiguous,
    IncompleteKey,
    DuplicateKey,
    FieldRemoved {
        field: SourceFieldId,
    },
    FieldRenamed {
        field: SourceFieldId,
    },
    FieldTypeChanged {
        field: SourceFieldId,
    },
    PrecisionChanged {
        field: SourceFieldId,
    },
    InvalidValue {
        field: SourceFieldId,
        reason: RecordError,
    },
    TypeMismatch {
        property: DefinitionRef,
    },
    UnitMismatch {
        property: DefinitionRef,
    },
    NullNotAllowed {
        property: DefinitionRef,
    },
    FormulaUnavailable {
        field: SourceFieldId,
    },
    PermissionDenied {
        field: Option<SourceFieldId>,
    },
    CapabilityMissing {
        capability: SourceCapability,
    },
    AuthorityMismatch,
    RevisionMismatch,
    CrossWorld,
    BudgetExceeded {
        dimension: crate::budget::BudgetDimension,
    },
    Cancelled,
    InternalFault,
}
