use crate::{
    actions::{ActionProposal, ActionProposalRequest, ActionStatus, ActionSubmitRequest},
    bindings::{ActivationLock, ActivationRequest, ActivationSelection, BindingHead},
    definitions::{Definition, DefinitionBody, DefinitionKind},
    evaluation::{EvaluationReport, TestBranch},
    facts::ObservationDraft,
    ids::*,
    learning::{Candidate, ChangeSet},
    materials::{BlobRef, ParseArtifact, SourceVersion, SourceVersionRef},
    operation::{OperationAccepted, OperationKey},
    package::InstalledRecord,
    provenance::ExplanationGraph,
    query::{Page, PageRequest, QueryPage, QueryRequest, ReadMode},
    sources::{SchemaMapping, SourceCapabilities, SourceCheckpoint},
    time::Timestamp,
    value::Value,
};
use serde::{Deserialize, Serialize};

macro_rules! operation_names {
    ($ty:ident { $($variant:ident => ($kind:literal, $operation:literal)),+ $(,)? }) => {
        impl $ty {
            pub const OPERATIONS: &'static [(&'static str, &'static str)] = &[$(($kind, $operation)),+];
            pub fn operation_name(&self) -> &'static str { match self { $(Self::$variant(_) => $operation),+ } }
        }
    };
}
pub(crate) use operation_names;

pub const QUERY_ENDPOINT: &str = "/api/world/query";
pub const COMMAND_ENDPOINT: &str = "/api/world/command";
pub const OPERATION_ENDPOINT: &str = "/api/world/operation";
pub const PEER_ENDPOINT: &str = "/api/world/peer";
pub const MAX_PAGE_ITEMS: u32 = 500;
pub const MAX_QUERY_DEPTH: usize = 64;
pub const MAX_QUERY_NODES: usize = 4096;
pub const MAX_REQUEST_BYTES: usize = 1_048_576;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryEnvelope {
    pub world: WorldRef,
    pub query: WorldQuery,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "request",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorldQuery {
    Discover(DiscoverQuery),
    Objects(QueryRequest),
    Relations(QueryRequest),
    Explain(ExplainQuery),
    Materials(ListQuery),
    SourceVersion(SourceVersionQuery),
    ParseArtifact(ParseArtifactQuery),
    MaterialDraft(crate::materials::MaterialDraftRef),
    Connections(ListQuery),
    Capabilities(ConnectionQuery),
    SourceSchema(SourceSchemaQuery),
    BranchSourceContext(BranchSourceContextQuery),
    Mappings(ListQuery),
    SyncStatus(BindingQuery),
    Definitions(DefinitionsQuery),
    Definition(DefinitionQuery),
    Changes(ListQuery),
    Change(ChangeQuery),
    Branches(ListQuery),
    Evaluations(ListQuery),
    Evaluation(EvaluationQuery),
    Tasks(TasksQuery),
    Task(crate::learning::TaskRef),
    TaskContract(crate::learning::TaskRef),
    Abstractions(AbstractionsQuery),
    Abstraction(crate::abstraction::AbstractionRef),
    WorldView(WorldViewQuery),
    Suites(ListQuery),
    Suite(crate::evaluation::SuiteRef),
    SuiteCreationContext(crate::releases::BranchRef),
    TestCases(TestCasesQuery),
    ExactTestCase(crate::evaluation::TestRevision),
    FrozenSuite(crate::evaluation::SuiteRef),
    Releases(ListQuery),
    ActionProposals(ListQuery),
    ActionStatus(OperationKey),
    Packages(ListQuery),
    PackageTrustPolicy(PackageTrustPolicyQuery),
    Bindings(ListQuery),
    ActivationPlan(ActivationSelection),
    BindingHead(ChannelQuery),
    PackageConfig(InstallQuery),
    Contributions(InstallQuery),
    DrainStatus(OperationKey),
    BackupStatus(OperationKey),
    RestoreStatus(OperationKey),
    DeleteStatus(OperationKey),
    UploadStatus(UploadKey),
}
crate::api::operation_names!(WorldQuery {
    Discover => ("discover", "world.discover"),
    Objects => ("objects", "objects.query"),
    Relations => ("relations", "relations.query"),
    Explain => ("explain", "assertion.explain"),
    Materials => ("materials", "materials.list"),
    SourceVersion => ("source_version", "source-version.get"),
    ParseArtifact => ("parse_artifact", "parse-artifact.get"),
    MaterialDraft => ("material_draft", "material-draft.get"),
    Connections => ("connections", "connections.list"),
    Capabilities => ("capabilities", "connection.capabilities"),
    SourceSchema => ("source_schema", "source-schema.get"),
    BranchSourceContext => ("branch_source_context", "source.branch.context.get"),
    Mappings => ("mappings", "mappings.list"),
    SyncStatus => ("sync_status", "sync.status"),
    Definitions => ("definitions", "definitions.list"),
    Definition => ("definition", "definition.get"),
    Changes => ("changes", "changes.list"),
    Change => ("change", "change.get"),
    Branches => ("branches", "branches.list"),
    Evaluations => ("evaluations", "evaluations.list"),
    Evaluation => ("evaluation", "evaluation.get"),
    Tasks => ("tasks", "tasks.list"),
    Task => ("task", "task.get"),
    TaskContract => ("task_contract", "task.contract.get"),
    Abstractions => ("abstractions", "abstractions.list"),
    Abstraction => ("abstraction", "abstraction.get"),
    WorldView => ("world_view", "world-view.get"),
    Suites => ("suites", "suites.list"),
    Suite => ("suite", "suite.get"),
    SuiteCreationContext => ("suite_creation_context", "suite.creation-context"),
    TestCases => ("test_cases", "test-cases.list"),
    ExactTestCase => ("exact_test_case", "test-case.get"),
    FrozenSuite => ("frozen_suite", "suite.frozen"),
    Releases => ("releases", "releases.list"),
    ActionProposals => ("action_proposals", "action-proposals.list"),
    ActionStatus => ("action_status", "action.status"),
    Packages => ("packages", "packages.list"),
    PackageTrustPolicy => ("package_trust_policy", "package.trust-policy.get"),
    Bindings => ("bindings", "bindings.list"),
    ActivationPlan => ("activation_plan", "activation.plan"),
    BindingHead => ("binding_head", "binding.head"),
    PackageConfig => ("package_config", "package.config"),
    Contributions => ("contributions", "package.contributions"),
    DrainStatus => ("drain_status", "drain.status"),
    BackupStatus => ("backup_status", "backup.status"),
    RestoreStatus => ("restore_status", "restore.status"),
    DeleteStatus => ("delete_status", "delete.status"),
    UploadStatus => ("upload_status", "upload.status")
});
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "result",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum QueryResult {
    Discover(WorldDescription),
    Objects(QueryPage),
    Relations(QueryPage),
    Explain(ExplanationGraph),
    Materials(Page<SourceVersion>),
    SourceVersion(SourceVersion),
    ParseArtifact(ParseArtifact),
    MaterialDraft(crate::materials::MaterialDraft),
    Connections(Page<ConnectionView>),
    Capabilities(SourceCapabilities),
    SourceSchema(Option<crate::sources::SchemaDiscovery>),
    BranchSourceContext(BranchSourceContext),
    Mappings(Page<SchemaMapping>),
    SyncStatus(SourceCheckpoint),
    Definitions(Page<Definition<DefinitionBody>>),
    Definition(Option<Definition<DefinitionBody>>),
    Changes(Page<ChangeSet>),
    Change(Option<ChangeSet>),
    Branches(Page<BranchView>),
    Evaluations(Page<EvaluationReport>),
    Evaluation(EvaluationReport),
    Tasks(Page<crate::learning::TaskSummary>),
    Task(Option<crate::learning::TaskSummary>),
    TaskContract(Option<crate::learning::TaskContract>),
    Abstractions(Page<crate::abstraction::AbstractionContract>),
    Abstraction(Option<crate::abstraction::AbstractionContract>),
    WorldView(crate::slots::ContextResult),
    Suites(Page<crate::evaluation::SuiteSummary>),
    Suite(Option<crate::evaluation::SuiteSummary>),
    SuiteCreationContext(crate::evaluation::SuiteCreationContext),
    TestCases(Page<crate::evaluation::TestRevision>),
    ExactTestCase(crate::learning::TestCase),
    FrozenSuite(crate::evaluation::FrozenSuite),
    Releases(Page<ReleaseView>),
    ActionProposals(Page<ActionProposal>),
    ActionStatus(ActionStatus),
    Packages(Page<InstalledRecord>),
    PackageTrustPolicy(crate::package::TrustPolicy),
    Bindings(Page<ActivationLock>),
    ActivationPlan(ActivationRequest),
    BindingHead(Option<BindingHead>),
    PackageConfig(PackageConfigView),
    Contributions(Vec<crate::package::Contribution>),
    Operation(crate::operation::OperationReceipt),
    Upload(UploadReceipt),
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandEnvelope {
    pub world: WorldRef,
    pub request_id: RequestId,
    pub command: WorldCommand,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "request",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorldCommand {
    ImportMaterials(ImportMaterials),
    ProposeMaterialDraft(ProposeMaterialDraft),
    ConfigureConnection(ConfigureConnection),
    DiscoverSchema(DiscoverSchema),
    ConfigurePolicy(ConfigurePolicy),
    ConfigureRetention(ConfigureRetention),
    SetMapping(SetMapping),
    SetBranchMapping(SetBranchMapping),
    ApproveBranchSourceAuthority(ApproveBranchSourceAuthority),
    StartSync(BindingCommand),
    StopSync(BindingCommand),
    Observe(ObserveRequest),
    EvaluateRule(EvaluateRuleRequest),
    Reconcile(ReconcileRequest),
    ProposeChange(ProposeChange),
    ProposeAbstraction(ProposeAbstraction),
    ValidateChange(ChangeCommand),
    RebaseChange(RebaseChange),
    TestBranch(TestBranch),
    RecordTask(crate::learning::TaskContract),
    ResolveTask(ResolveTaskRequest),
    RecordTestCase(RecordTestCase),
    FreezeSuite(crate::evaluation::FreezeSuite),
    Publish(PublishRequest),
    Rollback(RollbackRequest),
    ActionPropose(ActionProposalRequest),
    ActionApprove(ApproveAction),
    ActionSubmit(ActionSubmitRequest),
    ActionReconcile(OperationKey),
    ActionCompensate(OperationKey),
    InstallPackage(InstallPackage),
    GrantPackage(GrantPackage),
    ReplacePackageTrustPolicy(ReplacePackageTrustPolicy),
    ConfigurePackage(ConfigurePackage),
    EnablePackage(InstallCommand),
    DisablePackage(InstallCommand),
    UpgradePackage(UpgradePackage),
    UninstallPackage(InstallCommand),
    MigratePackage(MigratePackage),
    Activate(ActivationRequest),
    Backup(BackupRequest),
    Restore(RestoreRequest),
    DeleteWorld(DeleteWorld),
    BeginUpload(BeginUpload),
    UploadChunk(UploadChunk),
    SealUpload(SealUpload),
    AbortUpload(UploadKey),
}
crate::api::operation_names!(WorldCommand {
    ImportMaterials => ("import_materials", "materials.import"),
    ProposeMaterialDraft => ("propose_material_draft", "material-draft.propose"),
    ConfigureConnection => ("configure_connection", "connection.configure"),
    DiscoverSchema => ("discover_schema", "schema.discover"),
    ConfigurePolicy => ("configure_policy", "policy.configure"),
    ConfigureRetention => ("configure_retention", "retention.configure"),
    SetMapping => ("set_mapping", "mapping.set"),
    SetBranchMapping => ("set_branch_mapping", "source.branch.mapping.set"),
    ApproveBranchSourceAuthority => ("approve_branch_source_authority", "source.branch.authority.approve"),
    StartSync => ("start_sync", "sync.start"),
    StopSync => ("stop_sync", "sync.stop"),
    Observe => ("observe", "observe"),
    EvaluateRule => ("evaluate_rule", "rule.evaluate"),
    Reconcile => ("reconcile", "reconcile"),
    ProposeChange => ("propose_change", "change.propose"),
    ProposeAbstraction => ("propose_abstraction", "abstraction.propose"),
    ValidateChange => ("validate_change", "change.validate"),
    RebaseChange => ("rebase_change", "change.rebase"),
    TestBranch => ("test_branch", "branch.test"),
    RecordTask => ("record_task", "task.record"),
    ResolveTask => ("resolve_task", "task.resolve"),
    RecordTestCase => ("record_test_case", "test-case.record"),
    FreezeSuite => ("freeze_suite", "suite.freeze"),
    Publish => ("publish", "release.publish"),
    Rollback => ("rollback", "release.rollback"),
    ActionPropose => ("action_propose", "action.propose"),
    ActionApprove => ("action_approve", "action.approve"),
    ActionSubmit => ("action_submit", "action.submit"),
    ActionReconcile => ("action_reconcile", "action.reconcile"),
    ActionCompensate => ("action_compensate", "action.compensate"),
    InstallPackage => ("install_package", "package.install"),
    GrantPackage => ("grant_package", "package.grant"),
    ReplacePackageTrustPolicy => ("replace_package_trust_policy", "package.trust-policy.replace"),
    ConfigurePackage => ("configure_package", "package.configure"),
    EnablePackage => ("enable_package", "package.enable"),
    DisablePackage => ("disable_package", "package.disable"),
    UpgradePackage => ("upgrade_package", "package.upgrade"),
    UninstallPackage => ("uninstall_package", "package.uninstall"),
    MigratePackage => ("migrate_package", "package.migrate"),
    Activate => ("activate", "binding.activate"),
    Backup => ("backup", "world.backup"),
    Restore => ("restore", "world.restore"),
    DeleteWorld => ("delete_world", "world.delete"),
    BeginUpload => ("begin_upload", "upload.begin"),
    UploadChunk => ("upload_chunk", "upload.chunk"),
    SealUpload => ("seal_upload", "upload.seal"),
    AbortUpload => ("abort_upload", "upload.abort")
});
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "result",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CommandResult {
    Upload(UploadReceipt),
    Accepted(OperationAccepted),
    Proposal(ActionProposal),
    Approval(crate::authorization::ApprovalBinding),
    Change(ChangeSet),
    Candidate(Candidate),
    Commit(crate::commit::CommitReceipt),
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiscoverQuery {
    pub include_capabilities: bool,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListQuery {
    pub page: PageRequest,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestCasesQuery {
    pub task: crate::learning::TaskRef,
    pub page: PageRequest,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TasksQuery {
    pub scope: ScopeId,
    pub page: PageRequest,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AbstractionsQuery {
    pub task: crate::learning::TaskRef,
    pub page: PageRequest,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorldViewQuery {
    pub task: crate::learning::TaskRef,
    pub query: QueryRequest,
    pub budget: crate::budget::Budget,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExplainQuery {
    pub assertion: AssertionRef,
    pub read_mode: ReadMode,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceVersionQuery {
    pub reference: SourceVersionRef,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParseArtifactQuery {
    pub id: ParseArtifactId,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionQuery {
    pub id: ConnectionId,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceSchemaQuery {
    pub source_id: SourceId,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BranchSourceContextQuery {
    pub branch: crate::releases::BranchRef,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BranchSourceContext {
    pub branch: crate::releases::BranchRef,
    pub status: crate::learning::ChangeStatus,
    pub bindings: Vec<BranchSourceContextEntry>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BranchSourceContextEntry {
    pub binding: Definition<crate::sources::SourceBinding>,
    pub targets: Vec<Definition<DefinitionBody>>,
    pub schema: crate::sources::SchemaDiscovery,
    pub mapping: Option<SchemaMapping>,
    pub authority: BranchSourceAuthorityState,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "authority",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum BranchSourceAuthorityState {
    Draft(crate::facts::SourceAuthority),
    Approved(crate::facts::SourceAuthority),
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindingQuery {
    pub binding: DefinitionRef,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DefinitionsQuery {
    pub kind: Option<DefinitionKind>,
    pub page: PageRequest,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DefinitionQuery {
    pub reference: DefinitionRef,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeQuery {
    pub id: ChangeSetId,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvaluationQuery {
    pub id: EvaluationId,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelQuery {
    pub channel: ChannelId,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallQuery {
    pub install_id: InstallId,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageTrustPolicyQuery {}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorldDescription {
    pub world: WorldRef,
    pub revision: Revision,
    pub incarnation: Generation,
    pub status: WorldStatus,
    pub operations: Vec<String>,
    pub active_release: Option<ReleaseId>,
    pub active_release_head: Option<crate::releases::ReleaseHead>,
    pub editing_context: Option<crate::compiler::CompileRequest>,
    pub material_scopes: Vec<MaterialScope>,
    pub read_modes: Vec<ReadGuarantee>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaterialScope {
    pub scope: ScopeId,
    pub access: Vec<crate::materials::AccessPolicyRef>,
    pub retention: Vec<crate::sources::RetentionPolicy>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorldStatus {
    NotConfigured,
    Ready,
    Draining,
    Restoring,
    Deleting,
    Retained,
    Unavailable,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReadGuarantee {
    Projected,
    Authoritative,
    After,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionView {
    pub id: ConnectionId,
    pub revision: Revision,
    pub source_id: SourceId,
    pub name: String,
    pub connector: ProviderId,
    pub configured: bool,
    pub capabilities: Option<SourceCapabilities>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BranchView {
    pub id: BranchId,
    pub revision: Revision,
    pub base_release: ReleaseId,
    pub basis: crate::evaluation::BranchBasis,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseView {
    pub id: ReleaseId,
    pub artifact_id: ArtifactId,
    pub activation_lock_id: ActivationLockId,
    pub published_at: Timestamp,
    pub previous: Option<ReleaseId>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageConfigView {
    pub install_id: InstallId,
    pub revision: Revision,
    pub digest: Digest,
    pub fields: Vec<ConfigValue>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigValue {
    pub name: String,
    pub value: Value,
}
/// A content digest, independent of install identity and CAS revision; fields are sorted by exact name.
pub fn package_config_digest(
    fields: &[ConfigValue],
) -> Result<Digest, crate::schema::SchemaFailure> {
    use sha2::{Digest as _, Sha256};
    let mut fields: Vec<_> = fields.iter().collect();
    fields.sort_by(|a, b| a.name.cmp(&b.name));
    if fields.windows(2).any(|pair| pair[0].name == pair[1].name) {
        return Err(crate::schema::SchemaFailure);
    }
    let bytes = serde_json::to_vec(&fields).map_err(|_| crate::schema::SchemaFailure)?;
    let mut hash = Sha256::new();
    hash.update(b"matcha.world-package-config/1\n");
    hash.update(bytes);
    Digest::try_new(format!("sha256:{:x}", hash.finalize()))
        .map_err(|_| crate::schema::SchemaFailure)
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveTaskRequest {
    pub task: crate::learning::TaskRef,
    pub abstraction_id: AbstractionId,
    pub abstraction_revision: Revision,
    pub query: QueryRequest,
    pub input: Value,
    pub test: crate::evaluation::TestRevision,
    pub execution: InvestigationSelection,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum InvestigationSelection {
    Openclaw {
        agent_id: AgentId,
        session_key: String,
        native_session_id: NativeSessionId,
    },
    MatchaAgent {
        agent_id: AgentId,
        native_session_id: NativeSessionId,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordTestCase {
    pub test: crate::learning::TestCase,
    pub fixture: UploadKey,
    pub expected: UploadKey,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UploadKey {
    pub transfer_id: TransferId,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BeginUpload {
    pub name: String,
    pub media_type: String,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub size: u64,
    pub digest: Digest,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UploadChunk {
    pub transfer_id: TransferId,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub offset: u64,
    pub digest: Digest,
    pub bytes: Vec<u8>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SealUpload {
    pub transfer_id: TransferId,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub size: u64,
    pub digest: Digest,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UploadReceipt {
    pub transfer_id: TransferId,
    pub revision: Revision,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub received: u64,
    pub state: UploadState,
    pub expires_at: Timestamp,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum UploadState {
    Receiving,
    Sealed { blob: BlobRef },
    Aborted,
    Retained { failure: UploadFailure },
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum UploadFailure {
    NotFound,
    Expired,
    AlreadySealed,
    OffsetMismatch {
        #[serde(with = "crate::wire::u64_decimal")]
        #[schemars(with = "String")]
        expected: u64,
        #[serde(with = "crate::wire::u64_decimal")]
        #[schemars(with = "String")]
        actual: u64,
    },
    ChunkTooLarge,
    ChunkDigestMismatch,
    SizeMismatch,
    DigestMismatch,
    AdmissionMismatch,
    Storage {
        failure: crate::materials::MaterialFailure,
    },
}
pub const MAX_UPLOAD_CHUNK_BYTES: usize = 131_072;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposeMaterialDraft {
    pub draft: crate::materials::MaterialDraftRef,
    pub task: crate::learning::TaskRef,
    pub compile: crate::materials::MaterialCompileSelection,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportMaterials {
    pub sources: Vec<MaterialInput>,
    pub scope: ScopeId,
    pub access: crate::materials::AccessPolicyRef,
    pub retention: crate::sources::RetentionPolicy,
    pub task: Option<crate::learning::TaskRef>,
    pub compile: Option<crate::compiler::CompileSelection>,
    pub budget: crate::budget::Budget,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MaterialInput {
    SealedUpload {
        transfer_id: TransferId,
        blob: BlobRef,
        name: String,
        media_type: String,
    },
    Upload {
        name: String,
        media_type: String,
        bytes: Vec<u8>,
    },
    Blob {
        name: String,
        media_type: String,
        blob: BlobRef,
    },
    WikiSource {
        project_id: String,
        source_id: String,
        version: String,
    },
    WikiPage {
        project_id: String,
        page_id: String,
        version: String,
    },
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiscoverSchema {
    pub connection: ConnectionId,
    pub connection_revision: Revision,
    pub resource: String,
    pub target_schema: SchemaRef,
    pub expected_schema: Option<SchemaRef>,
    pub branch: Option<crate::releases::BranchRef>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigureConnection {
    pub expected_revision: Option<Revision>,
    pub connection: crate::sources::ConnectionRevision,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigurePolicy {
    pub scope: ScopeId,
    pub rule: crate::authorization::PolicyRule,
    pub mandatory: bool,
    pub available: bool,
    pub expected_revision: Option<Revision>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigureRetention {
    pub scope: ScopeId,
    pub policy: crate::sources::RetentionPolicy,
    pub expected_revision: Option<Revision>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetMapping {
    pub binding: DefinitionRef,
    pub mapping: SchemaMapping,
    /// Expected active binding-head revision, not the mapping revision.
    pub expected_revision: Revision,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetBranchMapping {
    pub branch: crate::releases::BranchRef,
    pub binding: DefinitionRef,
    pub mapping: SchemaMapping,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApproveBranchSourceAuthority {
    pub branch: crate::releases::BranchRef,
    pub authority: crate::facts::SourceAuthority,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindingCommand {
    pub binding: DefinitionRef,
    pub expected_revision: Revision,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObserveRequest {
    pub observations: Vec<ObservationDraft>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvaluateRuleRequest {
    pub release_id: ReleaseId,
    pub rule: DefinitionRef,
    pub arguments: Vec<crate::query::QueryArgument>,
    pub scope: ScopeId,
    pub valid_time: crate::time::ValidTime,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<crate::releases::BranchRef>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReconcileRequest {
    pub subjects: Vec<crate::identity::SubjectRef>,
    pub bindings: Vec<DefinitionRef>,
    pub read_mode: ReadMode,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposeChange {
    pub task: crate::learning::TaskRef,
    pub compile: crate::compiler::CompileSelection,
    pub base_release: ReleaseId,
    pub operations: Vec<crate::learning::SemanticOperation>,
    pub evidence: Vec<EvidenceRef>,
    pub cases: Vec<CaseId>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposeAbstraction {
    pub change: ProposeChange,
    pub abstraction: crate::abstraction::AbstractionDraft,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeCommand {
    pub id: ChangeSetId,
    pub expected_revision: Revision,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RebaseChange {
    pub id: ChangeSetId,
    pub expected_revision: Revision,
    pub new_base: ReleaseId,
    pub compile: crate::compiler::CompileSelection,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishRequest {
    pub change_set_id: ChangeSetId,
    pub expected_revision: Revision,
    pub evaluation_id: EvaluationId,
    pub artifact_id: ArtifactId,
    pub head: crate::releases::ReleaseHeadCas,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RollbackRequest {
    pub release_id: ReleaseId,
    pub head: crate::releases::ReleaseHeadCas,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApproveAction {
    pub proposal_id: CandidateId,
    pub proposal_digest: Digest,
    pub expires_at: Timestamp,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallPackage {
    pub upload: UploadKey,
    pub package: BlobRef,
    pub request_key: RequestId,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrantPackage {
    pub install_id: InstallId,
    pub expected_revision: Revision,
    pub grants: Vec<crate::package::RequestedAccess>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplacePackageTrustPolicy {
    pub expected_revision: Revision,
    pub policy: crate::package::TrustPolicy,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigurePackage {
    pub install_id: InstallId,
    pub expected_revision: Revision,
    pub fields: Vec<ConfigValue>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallCommand {
    pub install_id: InstallId,
    pub expected_revision: Revision,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpgradePackage {
    pub install_id: InstallId,
    pub expected_revision: Revision,
    pub upload: UploadKey,
    pub package: BlobRef,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigratePackage {
    pub install_id: InstallId,
    pub migration_id: MigrationId,
    pub expected_revision: Revision,
    pub source_lock: ActivationLockId,
    pub source_node: NodeId,
    pub migration: crate::state::StateMigration,
    pub implementation: crate::bindings::ImplementationRef,
    pub activation: ActivationRequest,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupRequest {
    pub include_materials: bool,
    pub expected_release: ReleaseId,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreRequest {
    pub manifest: BlobRef,
    pub expected_incarnation: Generation,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteWorld {
    pub expected_incarnation: Generation,
    pub expected_revision: Revision,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerRequest {
    pub world: WorldRef,
    pub request_id: RequestId,
    pub operation: PeerOperation,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "request",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PeerOperation {
    Discover(DiscoverQuery),
    Query(QueryRequest),
    Explain(ExplainQuery),
    ActionPropose(ActionProposalRequest),
    ActionSubmit(ActionSubmitRequest),
    ActionStatus(OperationKey),
    Observe(ObserveRequest),
    ChangePropose(ProposeChange),
    BranchTest(TestBranch),
}
crate::api::operation_names!(PeerOperation {
    Discover => ("discover", "world.discover"),
    Query => ("query", "query"),
    Explain => ("explain", "assertion.explain"),
    ActionPropose => ("action_propose", "action.propose"),
    ActionSubmit => ("action_submit", "action.submit"),
    ActionStatus => ("action_status", "action.status"),
    Observe => ("observe", "observe"),
    ChangePropose => ("change_propose", "change.propose"),
    BranchTest => ("branch_test", "branch.test")
});
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "result",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PeerResponse {
    Discover(WorldDescription),
    Query(QueryPage),
    Explain(ExplanationGraph),
    ActionPropose(ActionProposal),
    Accepted(OperationAccepted),
    ActionStatus(ActionStatus),
    Change(ChangeSet),
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "failure",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ApiFailure {
    Upload(UploadFailure),
    Input(crate::failure::InputFailure),
    Authorization(crate::authorization::AuthorizationFailure),
    Release(crate::releases::ReleaseFailure),
    Query(crate::query::QueryFailure),
    Operation(crate::operation::OperationFailure),
    Transport(TransportFailure),
    NotConfigured,
    NotFound,
    RevisionConflict,
    UnsupportedOperation,
    InternalFault,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TransportFailure {
    DuplicateKey,
    DepthLimit,
    SizeLimit,
    JsonSyntax,
    UnexpectedEof,
    ContractData,
    InvalidSignature,
    WrongAudience,
    DeadlineExpired,
    Disconnected,
}
