use crate::{
    expression::{Effect, ExpressionIr, Parameter, TimeWindow},
    ids::*,
    query::QueryIr,
    time::ValidTime,
    value::{Unit, ValueType},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Definition<T> {
    pub reference: DefinitionRef,
    pub scope: ScopeId,
    pub valid_time: ValidTime,
    pub body: T,
    pub content_digest: Digest,
    pub dependencies: Vec<DefinitionRef>,
    pub evidence: Vec<EvidenceRef>,
    pub previous_ref: Option<DefinitionRef>,
    pub lifecycle: DefinitionLifecycle,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "body",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DefinitionBody {
    ObjectType(ObjectType),
    Property(Property),
    RelationType(RelationType),
    Facet(Facet),
    ConceptView(ConceptView),
    Rule(Rule),
    Metric(Metric),
    Function(Function),
    StateModel(StateModel),
    ActionContract(crate::actions::ActionContract),
    Strategy(crate::learning::Strategy),
    PolicyBinding(crate::authorization::PolicyBinding),
    SourceBinding(crate::sources::SourceBinding),
    Extension(ExtensionDefinition),
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionDefinition {
    pub name: String,
    pub contract: crate::sources::ContractRef,
    pub payload: crate::value::Value,
}
#[derive(
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd,
    Serialize,
    Deserialize,
    schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum DefinitionKind {
    ObjectType,
    Property,
    RelationType,
    Facet,
    ConceptView,
    Rule,
    Metric,
    Function,
    StateModel,
    ActionContract,
    Strategy,
    PolicyBinding,
    SourceBinding,
    Extension,
}
impl DefinitionBody {
    pub fn kind(&self) -> DefinitionKind {
        match self {
            Self::ObjectType(_) => DefinitionKind::ObjectType,
            Self::Property(_) => DefinitionKind::Property,
            Self::RelationType(_) => DefinitionKind::RelationType,
            Self::Facet(_) => DefinitionKind::Facet,
            Self::ConceptView(_) => DefinitionKind::ConceptView,
            Self::Rule(_) => DefinitionKind::Rule,
            Self::Metric(_) => DefinitionKind::Metric,
            Self::Function(_) => DefinitionKind::Function,
            Self::StateModel(_) => DefinitionKind::StateModel,
            Self::ActionContract(_) => DefinitionKind::ActionContract,
            Self::Strategy(_) => DefinitionKind::Strategy,
            Self::PolicyBinding(_) => DefinitionKind::PolicyBinding,
            Self::SourceBinding(_) => DefinitionKind::SourceBinding,
            Self::Extension(_) => DefinitionKind::Extension,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KindRequest {
    pub kind: crate::package::KindContract,
    pub definition: Definition<DefinitionBody>,
    pub previous: Option<Definition<DefinitionBody>>,
    pub definitions: Vec<Definition<DefinitionBody>>,
    pub scopes: Vec<Scope>,
    pub operation: KindOperation,
}
impl KindRequest {
    pub fn contract(&self) -> &crate::sources::ContractRef {
        match self.operation {
            KindOperation::Validate => &self.kind.validate,
            KindOperation::Lower => &self.kind.lower,
            KindOperation::Index => &self.kind.index,
            KindOperation::Migrate => &self.kind.migrate,
            KindOperation::Reducer { .. } => &self.kind.reducer,
            KindOperation::Lifecycle => &self.kind.lifecycle,
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum KindOperation {
    Validate,
    Lower,
    Index,
    Migrate,
    Reducer { verb: KindVerb },
    Lifecycle,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum KindVerb {
    Create,
    Refine,
    Deprecate,
    Split,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KindResponse {
    pub contract: crate::sources::ContractRef,
    pub result: KindResult,
}
/// Proposals only; the owner rechecks standard lowering, admitted dependencies and the exact next revision.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum KindResult {
    Validated,
    Lowered { body: DefinitionBody },
    Indexed { dependencies: Vec<DefinitionRef> },
    Migrated { definition: Definition<DefinitionBody> },
    Reduced { definition: Definition<DefinitionBody> },
    LifecycleChecked,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scope {
    pub world: WorldRef,
    pub id: ScopeId,
    pub predicate: ExpressionIr,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DefinitionLifecycle {
    Available,
    Deprecated {
        replacements: Vec<DefinitionRef>,
        reason: String,
        effective_at: crate::time::Timestamp,
    },
    Split {
        replacements: Vec<DefinitionRef>,
        effective_at: crate::time::Timestamp,
    },
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DefinitionEvidenceBinding {
    pub definition: DefinitionRef,
    pub revision: Revision,
    pub evidence: Vec<EvidenceRef>,
    pub previous_revision: Option<Revision>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DefinitionAnnotation {
    pub branch: crate::releases::BranchRef,
    pub target: DefinitionRef,
    pub revision: Revision,
    pub annotation: crate::learning::Annotation,
    pub previous_revision: Option<Revision>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DefinitionLink {
    pub branch: crate::releases::BranchRef,
    pub source: DefinitionRef,
    pub target: DefinitionRef,
    pub relation: crate::learning::SemanticLink,
    pub revision: Revision,
    pub previous_revision: Option<Revision>,
    pub evidence: Vec<EvidenceRef>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectType {
    pub name: String,
    pub identity_rule: Option<DefinitionRef>,
    pub properties: Vec<DefinitionRef>,
    pub interfaces: Vec<DefinitionRef>,
    pub state_model: Option<DefinitionRef>,
    pub source_bindings: Vec<DefinitionRef>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Property {
    pub name: String,
    pub domain: Vec<DefinitionId>,
    pub value_type: ValueType,
    pub cardinality: Cardinality,
    pub nullable: bool,
    pub access_labels: Vec<String>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cardinality {
    pub minimum: u32,
    pub maximum: Option<u32>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelationType {
    pub name: String,
    pub roles: Vec<RoleDefinition>,
    pub properties: Vec<DefinitionRef>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoleDefinition {
    pub id: RoleId,
    pub name: String,
    pub target_type: DefinitionRef,
    pub cardinality: Cardinality,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Facet {
    pub name: String,
    pub attaches_to: Vec<DefinitionId>,
    pub applicability: ExpressionIr,
    pub definitions: Vec<DefinitionRef>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConceptView {
    pub name: String,
    pub inputs: Vec<DefinitionId>,
    pub query: QueryIr,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rule {
    pub name: String,
    pub parameters: Vec<Parameter>,
    pub condition: ExpressionIr,
    pub conclusion: RuleConclusion,
    pub effects: Vec<Effect>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RuleConclusion {
    Attribute {
        subject: ExpressionIr,
        property: DefinitionRef,
        value: ExpressionIr,
        polarity: crate::facts::Polarity,
    },
    Relation {
        relation: ExpressionIr,
        relation_type: DefinitionRef,
        roles: Vec<RuleRoleTemplate>,
        polarity: crate::facts::Polarity,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuleRoleTemplate {
    pub role: RoleId,
    pub object: ExpressionIr,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Metric {
    pub name: String,
    pub parameters: Vec<Parameter>,
    pub expression: ExpressionIr,
    pub result_type: ValueType,
    pub unit: Option<Unit>,
    pub grain: Vec<DefinitionRef>,
    pub window: Option<TimeWindow>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Function {
    pub name: String,
    pub parameters: Vec<Parameter>,
    pub result_type: ValueType,
    pub expression: ExpressionIr,
    pub effects: Vec<Effect>,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub max_evaluations: u64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateModel {
    pub name: String,
    pub property: DefinitionRef,
    pub states: Vec<StateDefinition>,
    pub transitions: Vec<StateTransition>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateDefinition {
    pub id: StateId,
    pub name: String,
    pub terminal: bool,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateTransition {
    pub from: StateId,
    pub to: StateId,
    pub guard: ExpressionIr,
    pub source_constraint: Option<String>,
    pub action: Option<DefinitionRef>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DefinitionFailure {
    Authorization {
        failure: crate::authorization::AuthorizationFailure,
    },
    HeadConflict {
        definition_id: DefinitionId,
        expected: Revision,
        actual: Revision,
        fields: Vec<crate::failure::FieldPath>,
    },
    MissingReference {
        reference: DefinitionRef,
    },
    RevisionConflict {
        expected: Revision,
        actual: Revision,
    },
    ScopeConflict {
        definitions: Vec<DefinitionRef>,
    },
    ValidTimeConflict {
        definitions: Vec<DefinitionRef>,
    },
    TypeMismatch {
        field: crate::failure::FieldPath,
    },
    UnitMismatch {
        field: crate::failure::FieldPath,
    },
    InvalidCardinality {
        field: crate::failure::FieldPath,
    },
    DuplicateLocalId {
        field: crate::failure::FieldPath,
    },
    CyclicDependency {
        definitions: Vec<DefinitionRef>,
    },
    UnknownKind {
        contract_id: ContractId,
    },
    ProviderMissing {
        contract_id: ContractId,
    },
    LifecycleConflict,
    WrongKind {
        reference: DefinitionRef,
        expected: DefinitionKind,
        actual: DefinitionKind,
    },
    CrossWorldReference {
        reference: DefinitionRef,
    },
    DeprecatedReference {
        reference: DefinitionRef,
    },
    ImmutableRevision {
        reference: DefinitionRef,
    },
    KindContractIncomplete {
        contract_id: ContractId,
    },
    InvalidField {
        field: crate::failure::FieldPath,
        reason: DefinitionFieldReason,
    },
    MissingField {
        field: crate::failure::FieldPath,
    },
    LimitExceeded {
        field: crate::failure::FieldPath,
        #[serde(with = "crate::wire::u64_decimal")]
        #[schemars(with = "String")]
        maximum: u64,
    },
    Commit {
        failure: crate::commit::CommitFailure,
    },
    InternalFault,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DefinitionFieldReason {
    Empty,
    Duplicate,
    InvalidDate,
    InvalidTimeZone,
    InvalidCalendar,
    InvalidPrecision,
    InvalidScale,
    NullNotAllowed,
    TypeMismatch,
    InvalidCardinality,
    InvalidInterval,
    InvalidRole,
    InvalidState,
    InvalidTransition,
    ImpureExpression,
    IncompleteContract,
}
