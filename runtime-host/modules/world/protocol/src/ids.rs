use serde::{Deserialize, Serialize};
use std::{fmt, str::FromStr};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidId;
impl fmt::Display for InvalidId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("invalid world identifier")
    }
}
impl std::error::Error for InvalidId {}

macro_rules! identifiers {
    ($($name:ident),+ $(,)?) => {$(
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize, schemars::JsonSchema)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);
        impl $name {
            pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidId> {
                let value = value.into();
                if value.is_empty() || value.len() > 256 || !value.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b)) {
                    return Err(InvalidId);
                }
                Ok(Self(value))
            }
            pub fn as_str(&self) -> &str { &self.0 }
        }
        impl TryFrom<String> for $name {
            type Error = InvalidId;
            fn try_from(value: String) -> Result<Self, Self::Error> { Self::try_new(value) }
        }
        impl From<$name> for String { fn from(value: $name) -> Self { value.0 } }
        impl FromStr for $name {
            type Err = InvalidId;
            fn from_str(value: &str) -> Result<Self, Self::Err> { Self::try_new(value) }
        }
        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(&self.0) }
        }
    )+};
}
identifiers!(
    TenantId,
    WorldId,
    BranchId,
    ObjectId,
    RelationId,
    DefinitionId,
    AssertionId,
    EvidenceId,
    SupportId,
    WatchId,
    SourceId,
    ScopeId,
    ReleaseId,
    ReadReceiptId,
    CommitId,
    OperationId,
    RunId,
    StepId,
    BindingId,
    ActivationLockId,
    DiagnosticId,
    EventId,
    WriterDomain,
    RoleId,
    StateId,
    ParameterId,
    SymbolId,
    NodeId,
    ArtifactId,
    CandidateId,
    ChangeSetId,
    TaskId,
    CaseId,
    TestCaseId,
    SuiteId,
    EvaluationId,
    AbstractionId,
    AbstractionSlotId,
    SourceVersionId,
    ParseArtifactId,
    BlockId,
    ContentId,
    OriginFamilyId,
    ConnectionId,
    ApprovalId,
    EffectIntentId,
    SourceReceiptId,
    VerificationId,
    DecisionId,
    InvocationId,
    ActorId,
    DelegationId,
    AgentId,
    PolicyId,
    GrantId,
    PackageId,
    PublisherId,
    InstallId,
    ProviderId,
    ContractId,
    StateNamespaceId,
    MigrationId,
    UpdateId,
    PluginGenerationId,
    InvocationLeaseId,
    ResourceToken,
    AcquisitionId,
    RequestId,
    StreamId,
    ChannelId,
    CheckpointFormatId,
    ModelBindingId,
    ModelCallId,
    NativeEndpointId,
    NativeSessionId,
    NativeRunId,
    ToolCallId,
    TransferId,
    StateRootId,
    SourceFieldId,
    SchemaId,
    MappingId,
    IdentityRuleId
);

macro_rules! counters {
    ($($name:ident),+ $(,)?) => {$(
        #[derive(Clone, Copy, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize, schemars::JsonSchema)]
        #[serde(transparent)]
        pub struct $name(#[serde(with = "crate::wire::u64_decimal")] #[schemars(with = "String")] pub u64);
    )+};
}
counters!(
    Revision,
    Generation,
    WriterEpoch,
    PolicyEpoch,
    GrantEpoch,
    PartitionEpoch,
    Sequence
);

#[derive(
    Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(try_from = "String", into = "String")]
pub struct Digest(String);
impl Digest {
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidId> {
        let value = value.into();
        if !value.starts_with("sha256:")
            || value.len() != 71
            || !value.as_bytes()[7..]
                .iter()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
        {
            return Err(InvalidId);
        }
        Ok(Self(value))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl TryFrom<String> for Digest {
    type Error = InvalidId;
    fn try_from(value: String) -> Result<Self, InvalidId> {
        Self::try_new(value)
    }
}
impl From<Digest> for String {
    fn from(value: Digest) -> Self {
        value.0
    }
}
impl fmt::Display for Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl FromStr for Digest {
    type Err = InvalidId;
    fn from_str(value: &str) -> Result<Self, InvalidId> {
        Self::try_new(value)
    }
}

#[derive(
    Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorldRef {
    pub tenant_id: TenantId,
    pub world_id: WorldId,
}

macro_rules! revision_refs {
    ($($name:ident => $id:ident),+ $(,)?) => {$(
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize, schemars::JsonSchema)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct $name { pub world: WorldRef, pub id: $id, pub revision: Revision }
    )+};
}
revision_refs!(DefinitionRef => DefinitionId, AssertionRef => AssertionId, EvidenceRef => EvidenceId,
    SupportRef => SupportId, StateRef => StateRootId, SchemaRef => SchemaId, MappingRef => MappingId, IdentityRuleRef => IdentityRuleId);

#[derive(
    Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ResourceRef {
    Object { id: ObjectId },
    Relation { id: RelationId },
    Definition { id: DefinitionId },
    Assertion { id: AssertionId },
    Evidence { id: EvidenceId },
    Support { id: SupportId },
    Watch { id: WatchId },
    Head { channel: ChannelId },
    State { id: StateRootId },
    Binding { id: BindingId },
    Operation { id: OperationId },
    Source { id: SourceId },
    Package { id: InstallId },
    ChangeSet { id: ChangeSetId },
    Branch { id: BranchId },
    Task { id: TaskId },
    Case { id: CaseId },
    TestCase { id: TestCaseId },
    Suite { id: SuiteId },
    Evaluation { id: EvaluationId },
}
