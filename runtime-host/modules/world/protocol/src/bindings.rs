use crate::{ids::*, sources::ContractRef};
use serde::{Deserialize, Serialize};

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
pub enum SlotKind {
    Connector,
    Identity,
    Schema,
    Resolver,
    Projection,
    Provenance,
    Compiler,
    Policy,
    Action,
    Reconcile,
    Abstraction,
    Evaluation,
    Context,
    AgentBridge,
    Storage,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImplementationRef {
    pub install_id: InstallId,
    pub package_digest: Digest,
    pub artifact_id: ArtifactId,
    pub artifact_digest: Digest,
    pub entrypoint: Entrypoint,
    pub contracts: Vec<ContractRef>,
    pub config_digest: Digest,
    pub dependency_lock: Digest,
    pub checkpoint_format: Option<CheckpointFormatId>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Entrypoint {
    Builtin {
        registration: String,
        revision: Revision,
    },
    Native {
        registration: String,
        host_build: Digest,
    },
    Wasm {
        world: String,
        interface: String,
    },
    Process {
        executable: String,
        protocol: ContractRef,
    },
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindingNode {
    pub id: NodeId,
    pub provider_id: ProviderId,
    pub binding_id: BindingId,
    pub slot: SlotKind,
    pub implementation: ImplementationRef,
    pub ports: Vec<MethodPort>,
    pub required: bool,
    pub state: Option<StateBinding>,
    pub trust: TrustClass,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MethodPort {
    pub name: String,
    pub contract: ContractRef,
    pub request_schema: Digest,
    pub result_schema: Digest,
    pub direction: PortDirection,
    pub required: bool,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PortDirection {
    Import,
    Export,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateBinding {
    pub namespace: StateNamespaceId,
    pub root: StateRef,
    pub schema: Digest,
    pub writer_domain: WriterDomain,
    pub writer_epoch: WriterEpoch,
    pub migration: Option<MigrationId>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TrustClass {
    OrdinaryGuest,
    TrustedNative,
    TrustedProcess,
    PrivateRoot,
}
/// Dependency direction is consumer -> provider, independent of dataflow port wiring.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindingEdge {
    pub consumer: NodeId,
    pub consumer_port: String,
    pub provider: NodeId,
    pub provider_port: String,
    pub contract: ContractRef,
    pub required: bool,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Composition {
    pub binding_id: BindingId,
    pub nodes: Vec<NodeId>,
    pub mode: CompositionMode,
    pub order: Vec<NodeId>,
    pub wiring: Vec<DataflowEdge>,
    pub merge: MergePolicy,
    pub failure: CompositionFailurePolicy,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CompositionMode {
    Single,
    Ordered,
    Chain,
    TypedDag,
    FanOut,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DataflowEdge {
    pub projection: DataflowProjection,
    pub output_node: NodeId,
    pub output_port: String,
    pub input_node: NodeId,
    pub input_port: String,
    pub schema_digest: Digest,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DataflowProjection {
    CompilerIr,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MergePolicy {
    None,
    OrderedConcatenation,
    DisjointFields,
    RequireEqual,
    ExplicitConflict,
    MandatoryAndDenyOverrides,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CompositionFailurePolicy {
    FailClosed,
    CollectIndependent,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivationLock {
    pub world: WorldRef,
    pub id: ActivationLockId,
    pub digest: Digest,
    pub nodes: Vec<BindingNode>,
    pub edges: Vec<BindingEdge>,
    pub compositions: Vec<Composition>,
    pub roots: Vec<NodeId>,
    pub trusted_roots: Vec<NodeId>,
}
/// Identity and content are separate axes: id and digest are excluded from this content digest.
pub fn activation_lock_digest(lock: &ActivationLock) -> Result<Digest, BindingFailure> {
    use sha2::{Digest as _, Sha256};
    let mut nodes = lock.nodes.clone();
    let mut edges = lock.edges.clone();
    let mut compositions = lock.compositions.clone();
    let mut roots = lock.roots.clone();
    let mut trusted = lock.trusted_roots.clone();
    nodes.sort_by(|a, b| a.id.cmp(&b.id));
    for node in &mut nodes {
        node.ports.sort_by(|a, b| a.name.cmp(&b.name));
        node.implementation.contracts.sort_by(|a, b| {
            (&a.id, &a.version, &a.schema_digest).cmp(&(&b.id, &b.version, &b.schema_digest))
        });
    }
    edges.sort_by(|a, b| {
        (&a.consumer, &a.consumer_port, &a.provider, &a.provider_port).cmp(&(
            &b.consumer,
            &b.consumer_port,
            &b.provider,
            &b.provider_port,
        ))
    });
    compositions.sort_by(|a, b| a.binding_id.cmp(&b.binding_id));
    for composition in &mut compositions {
        composition.nodes.sort();
        composition.wiring.sort_by(|a, b| {
            (&a.output_node, &a.output_port, &a.input_node, &a.input_port).cmp(&(
                &b.output_node,
                &b.output_port,
                &b.input_node,
                &b.input_port,
            ))
        });
    }
    roots.sort();
    trusted.sort();
    let bytes = serde_json::to_vec(&(&lock.world, nodes, edges, compositions, roots, trusted))
        .map_err(|_| BindingFailure::InternalFault)?;
    let mut hash = Sha256::new();
    hash.update(b"matcha.world-activation-lock/1\n");
    hash.update(bytes);
    Digest::try_new(format!("sha256:{:x}", hash.finalize()))
        .map_err(|_| BindingFailure::InternalFault)
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindingHead {
    pub world: WorldRef,
    pub channel: ChannelId,
    pub generation: Generation,
    pub activation_lock_id: ActivationLockId,
    pub revision: Revision,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindingHeadCas {
    pub world: WorldRef,
    pub channel: ChannelId,
    pub expected: Option<BindingHead>,
    pub replacement: ActivationLockId,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindingChannel {
    pub binding_id: BindingId,
    pub channel: ChannelId,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivationSelection {
    pub id: ActivationLockId,
    pub nodes: Vec<ImplementationSelection>,
    pub edges: Vec<ProviderSelection>,
    pub compositions: Vec<CompositionSelection>,
    pub roots: Vec<NodeId>,
    pub trusted_roots: Vec<NodeId>,
    pub channels: Vec<BindingChannel>,
    pub heads: Vec<HeadSelection>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImplementationSelection {
    pub id: NodeId,
    pub binding_id: BindingId,
    pub install_id: InstallId,
    pub provider_id: ProviderId,
    pub artifact_id: ArtifactId,
    pub slot: SlotKind,
    pub host_imports: Vec<crate::process::HostImport>,
    pub required: bool,
    pub state_namespace: Option<StateNamespaceId>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderSelection {
    pub consumer: NodeId,
    pub consumer_port: String,
    pub provider: NodeId,
    pub provider_port: String,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompositionSelection {
    pub binding_id: BindingId,
    pub nodes: Vec<NodeId>,
    pub mode: CompositionMode,
    pub order: Vec<NodeId>,
    pub wiring: Vec<DataflowSelection>,
    pub merge: MergePolicy,
    pub failure: CompositionFailurePolicy,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DataflowSelection {
    pub projection: DataflowProjection,
    pub output_node: NodeId,
    pub output_port: String,
    pub input_node: NodeId,
    pub input_port: String,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HeadSelection {
    pub channel: ChannelId,
    pub expected: Option<BindingHead>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivationRequest {
    pub graph: ActivationLock,
    pub channels: Vec<BindingChannel>,
    pub heads: Vec<BindingHeadCas>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExactClosure {
    pub activation_lock_id: ActivationLockId,
    pub root: NodeId,
    pub nodes: Vec<NodeId>,
    pub edges: Vec<BindingEdge>,
    pub affected_bindings: Vec<BindingId>,
    pub affected_heads: Vec<ChannelId>,
    pub affected_domains: Vec<WriterDomain>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PublicationConflictReason {
    EmptyScope,
    ResolutionMismatch,
    RollbackUnproven,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum BindingFailure {
    LockRetiring {
        activation_lock_id: ActivationLockId,
    },
    RetainedReferences {
        activation_lock_id: ActivationLockId,
    },
    MissingActivationLock {
        activation_lock_id: ActivationLockId,
    },
    PackageUnavailable {
        node_id: NodeId,
        install_id: InstallId,
    },
    Quarantined {
        node_id: NodeId,
    },
    ConfigurationChanged {
        node_id: NodeId,
    },
    HeadInvalid,
    PublicationConflict {
        reason: PublicationConflictReason,
    },
    LockIdentityConflict,
    DuplicatePort {
        node_id: NodeId,
        port: String,
    },
    AmbiguousProvider {
        consumer: NodeId,
        port: String,
        providers: Vec<NodeId>,
    },
    InvalidChannels {
        binding_id: BindingId,
    },
    InvalidRoots,
    DuplicateNode {
        node_id: NodeId,
    },
    MissingNode {
        node_id: NodeId,
    },
    MissingRequiredProvider {
        consumer: NodeId,
        contract: ContractRef,
    },
    MissingPort {
        node_id: NodeId,
        port: String,
    },
    ContractMismatch {
        consumer: NodeId,
        provider: NodeId,
        contract: ContractRef,
    },
    SchemaMismatch {
        consumer: NodeId,
        provider: NodeId,
    },
    DependencyCycle {
        nodes: Vec<NodeId>,
    },
    DataflowCycle {
        nodes: Vec<NodeId>,
    },
    InvalidComposition {
        binding_id: BindingId,
    },
    CompositionUnsupportedMerge {
        slot: SlotKind,
        policy: MergePolicy,
    },
    CompositionMergeConflict {
        nodes: Vec<NodeId>,
    },
    CompositionIncomplete {
        nodes: Vec<NodeId>,
    },
    CompositionBlocked {
        dependencies: Vec<NodeId>,
    },
    MergePolicyRequired {
        binding_id: BindingId,
    },
    TrustBoundary {
        node_id: NodeId,
    },
    StateConflict {
        node_id: NodeId,
    },
    DigestMismatch,
    HeadConflict {
        expected: Generation,
        actual: Generation,
    },
    Commit {
        failure: crate::commit::CommitFailure,
    },
    InternalFault,
}
