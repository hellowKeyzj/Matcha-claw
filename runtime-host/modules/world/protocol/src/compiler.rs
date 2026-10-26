use crate::{
    authorization::PolicyRef,
    bindings::{ActivationLock, ImplementationRef},
    definitions::{Definition, DefinitionBody, Scope},
    expression::Effect,
    failure::FieldPath,
    ids::*,
    materials::BlobRef,
    sources::{ContractRef, SourceCapability},
    time::ValidTime,
    value::{Currency, Unit, ValueType},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompileSelection {
    pub activation_lock_id: ActivationLockId,
    pub external_contracts: Vec<ExternalContractSelection>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalContractSelection {
    pub node_id: NodeId,
    pub contract_id: ContractId,
    pub kind: ExternalContractUse,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ExternalContractUse {
    DefinitionKind {
        name: String,
    },
    Function {
        reference: DefinitionRef,
    },
    Source {
        binding: DefinitionRef,
    },
    Policy {
        policy_id: PolicyId,
        revision: Revision,
    },
    CompilerPass,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompileRequest {
    pub world: WorldRef,
    pub base_release: ReleaseId,
    pub activation_lock: ActivationLock,
    pub definitions: Vec<Definition<DefinitionBody>>,
    pub scopes: Vec<Scope>,
    pub targets: Vec<CompileTarget>,
    pub external_contracts: Vec<ExternalContract>,
    pub config_digest: Digest,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalContract {
    pub contract: ContractRef,
    pub implementation: ImplementationRef,
    pub kind: ExternalContractKind,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ExternalContractKind {
    DefinitionKind {
        name: String,
    },
    Function {
        reference: DefinitionRef,
    },
    Source {
        binding: DefinitionRef,
        capabilities: Vec<SourceCapability>,
    },
    Policy {
        policy: PolicyRef,
    },
    CompilerPass {
        pass_id: ProviderId,
    },
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CompileTarget {
    QueryPlan,
    Validator,
    ActionManifest,
    ToolCatalog,
    TypeScriptSdk,
    RustSdk,
}
pub const IR_VERSION: &str = "matcha.world-ir/1";
pub fn artifact_schema(target: CompileTarget) -> Result<Vec<u8>, crate::schema::SchemaFailure> {
    match target {
        CompileTarget::QueryPlan => crate::schema::bytes::<QueryPlanArtifact>(),
        CompileTarget::Validator => crate::schema::bytes::<ValidatorArtifact>(),
        CompileTarget::ActionManifest => crate::schema::bytes::<ActionManifestArtifact>(),
        CompileTarget::ToolCatalog => crate::schema::bytes::<ToolCatalogArtifact>(),
        CompileTarget::TypeScriptSdk | CompileTarget::RustSdk => crate::schema::bytes::<Vec<u8>>(),
    }
}
pub fn artifact_contract(
    target: CompileTarget,
) -> Result<ContractRef, crate::schema::SchemaFailure> {
    let id = match target {
        CompileTarget::QueryPlan => "world.compiler.query-plan",
        CompileTarget::Validator => "world.compiler.validator",
        CompileTarget::ActionManifest => "world.compiler.action-manifest",
        CompileTarget::ToolCatalog => "world.compiler.tool-catalog",
        CompileTarget::TypeScriptSdk => "world.compiler.typescript-sdk",
        CompileTarget::RustSdk => "world.compiler.rust-sdk",
    };
    Ok(ContractRef {
        id: ContractId::try_new(id).map_err(|_| crate::schema::SchemaFailure)?,
        version: "1.0.0".into(),
        schema_digest: crate::schema::hash(&artifact_schema(target)?)?,
    })
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TypedIr {
    pub ir_version: String,
    pub world: WorldRef,
    pub definitions: Vec<DefinitionIr>,
    pub dependencies: DependencyGraph,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryPlanArtifact {
    pub ir_version: String,
    pub ir: TypedIr,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ValidatorArtifact {
    pub ir_version: String,
    pub definitions: Vec<DefinitionIr>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionManifestArtifact {
    pub ir_version: String,
    pub actions: Vec<ActionIr>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolCatalogArtifact {
    pub ir_version: String,
    pub tools: Vec<DefinitionIr>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DefinitionIr {
    pub reference: DefinitionRef,
    pub body_hash: Digest,
    pub body: DefinitionBody,
    pub scope: ScopeId,
    pub valid_time: ValidTime,
    pub annotations: Vec<ExpressionAnnotation>,
    pub policy_refs: Vec<PolicyRef>,
    pub source_requirements: Vec<SourceRequirement>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpressionAnnotation {
    pub field: FieldPath,
    pub result_type: ValueType,
    pub nullable: bool,
    pub optional: bool,
    pub effects: Vec<Effect>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionIr {
    pub reference: DefinitionRef,
    pub contract: crate::actions::ActionContract,
    pub checked_parameters: Vec<crate::expression::Parameter>,
    pub checked_result: ValueType,
    pub policies: Vec<PolicyRef>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceRequirement {
    pub binding: DefinitionRef,
    pub required: Vec<SourceCapability>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DependencyGraph {
    pub edges: Vec<CompileDependency>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompileDependency {
    pub dependent: DefinitionRef,
    pub target: DependencyTarget,
    pub usage: DependencyUse,
    pub selector: FieldPath,
    pub invalidates: Vec<CompileTarget>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "reference",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DependencyTarget {
    Definition(DefinitionRef),
    Contract(ContractRef),
    Implementation(ImplementationRef),
    Config(Digest),
    Unit(Unit),
    Schema(SchemaRef),
    Policy(PolicyRef),
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DependencyUse {
    Type,
    Body,
    Interface,
    Schema,
    SourceCapability,
    Policy,
    Unit,
    Provider,
    CompilerPass,
    Config,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompileResult {
    pub draft: ArtifactDraft,
    pub diagnostics: Vec<CompileDiagnostic>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactDraft {
    pub model_digest: Digest,
    pub targets: Vec<CompileTarget>,
    pub typed_ir: TypedIr,
    pub outputs: Vec<GeneratedArtifact>,
    pub dependencies: DependencyGraph,
    pub checked_callers: Vec<DefinitionRef>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GeneratedArtifact {
    pub kind: CompileTarget,
    pub definition: Option<DefinitionRef>,
    pub contract: ContractRef,
    pub schema_digest: Digest,
    pub relative_path: Option<String>,
    pub bytes: Vec<u8>,
    pub content_digest: Digest,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactManifest {
    pub model_digest: Digest,
    pub targets: Vec<CompileTarget>,
    pub world: WorldRef,
    pub id: ArtifactId,
    pub release_id: ReleaseId,
    pub activation_lock_id: ActivationLockId,
    pub config_digest: Digest,
    pub ir_version: String,
    pub outputs: Vec<ArtifactOutput>,
    pub dependencies: DependencyGraph,
    pub digest: Digest,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactOutput {
    pub kind: CompileTarget,
    pub definition: Option<DefinitionRef>,
    pub contract: ContractRef,
    pub schema_digest: Digest,
    pub content: BlobRef,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompileDiagnostic {
    pub definition: DefinitionRef,
    pub field: FieldPath,
    pub severity: DiagnosticSeverity,
    pub code: String,
    pub diagnostic_id: DiagnosticId,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticSeverity {
    Warning,
    Error,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CompileFailure {
    ReferenceMissing {
        reference: DefinitionRef,
        field: FieldPath,
    },
    ReferenceAmbiguous {
        id: DefinitionId,
        field: FieldPath,
    },
    DependencyCycle {
        path: Vec<DefinitionRef>,
    },
    TypeMismatch {
        definition: DefinitionRef,
        field: FieldPath,
        expected: ValueType,
        actual: ValueType,
    },
    UnitMismatch {
        definition: DefinitionRef,
        field: FieldPath,
        expected: Unit,
        actual: Unit,
    },
    CurrencyMismatch {
        definition: DefinitionRef,
        field: FieldPath,
        expected: Currency,
        actual: Currency,
    },
    TimeMismatch {
        definition: DefinitionRef,
        field: FieldPath,
    },
    ScopeMismatch {
        definition: DefinitionRef,
        field: FieldPath,
    },
    EffectViolation {
        definition: DefinitionRef,
        field: FieldPath,
        effect: Effect,
    },
    SourceCapabilityMissing {
        binding: DefinitionRef,
        capability: SourceCapability,
    },
    PolicyContractMissing {
        policy_id: PolicyId,
    },
    PolicyContractMismatch {
        contract: ContractRef,
    },
    RequiredProviderMissing {
        contract: ContractRef,
    },
    PassContractInvalid {
        provider_id: ProviderId,
    },
    PassOutputInvalid {
        provider_id: ProviderId,
        field: FieldPath,
    },
    ArtifactInvalid {
        field: FieldPath,
    },
    GeneratedSdkInvalid {
        target: CompileTarget,
        field: FieldPath,
    },
    CompatibilityBreak {
        definition: DefinitionRef,
        callers: Vec<DefinitionRef>,
    },
    Definition {
        failure: crate::definitions::DefinitionFailure,
    },
    InvalidExpression {
        definition: DefinitionRef,
        field: FieldPath,
    },
    LimitExceeded {
        field: FieldPath,
    },
    Cancelled,
    InternalFault,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompilerPassRequest {
    pub ir: TypedIr,
    pub declared_reads: Vec<DependencyTarget>,
    pub allowed_rewrites: Vec<FieldPath>,
    pub invariants: Vec<String>,
    pub contract: ContractRef,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompilerPassResult {
    pub ir: TypedIr,
    pub observed_dependencies: Vec<CompileDependency>,
    pub diagnostics: Vec<CompileDiagnostic>,
}
