use serde::{Deserialize, Serialize};
use world_protocol::{
    bindings::ImplementationRef,
    ids::*,
    materials::SourceVersionRef,
    sources::{SourceBasis, SourceGap, SourcePosition, SourceRow},
    time::{Timestamp, ValidTime},
};

/// Independent from source configuration, mapping, schema and plugin generation.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Assignment {
    pub world: WorldRef,
    pub source_id: SourceId,
    pub incarnation: String,
    pub partition: String,
    pub epoch: PartitionEpoch,
    pub instance: InvocationLeaseId,
    pub implementation: ImplementationRef,
    pub binding: DefinitionRef,
    pub connection_id: ConnectionId,
    pub connection_revision: Revision,
    pub mapping: MappingRef,
    pub schema: SchemaRef,
    pub identity_rule: IdentityRuleRef,
    pub scope: ScopeId,
    pub format: CheckpointFormatId,
}
impl Assignment {
    /// A joined reader's durable input survives an execution-epoch/lease change, not a model change.
    pub(super) fn continues(&self, previous: &Self) -> bool {
        previous.epoch <= self.epoch
            && self.world == previous.world
            && self.source_id == previous.source_id
            && self.incarnation == previous.incarnation
            && self.partition == previous.partition
            && self.format == previous.format
            && self.binding == previous.binding
            && self.connection_id == previous.connection_id
            && self.connection_revision == previous.connection_revision
            && self.mapping == previous.mapping
            && self.schema == previous.schema
            && self.identity_rule == previous.identity_rule
            && self.scope == previous.scope
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Partition {
    pub assignment: Assignment,
    pub owner_run: Option<RunId>,
    pub desired_running: bool,
    pub revision: Revision,
    pub state: PartitionState,
    pub reader_stopped: bool,
    pub ack_stopped: bool,
    #[serde(default)]
    pub native_fence: Option<CommitId>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SourceParent {
    pub request: world_protocol::api::BindingCommand,
    pub assignment: Assignment,
    pub owner_run: RunId,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SourceSegment {
    pub parent: SourceParent,
    pub request_id: RequestId,
    pub run_id: RunId,
    pub commit_id: CommitId,
    pub budget: world_protocol::budget::Budget,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub(crate) enum PartitionState {
    Running,
    Quiescing,
    Sealed,
    Resuming,
    Gap,
    Fenced,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Checkpoint {
    pub source: world_protocol::sources::SourceCheckpoint,
    pub revision: Revision,
    pub captured_sequence: Option<u64>,
    pub applied_sequence: Option<u64>,
    pub acknowledged_sequence: Option<u64>,
    pub projected_sequence: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct FencedEpoch {
    pub previous: Partition,
    pub assignment: Assignment,
    pub owner_run: RunId,
    pub checkpoint: Checkpoint,
    pub cleanup_only: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) enum CaptureKind {
    Snapshot {
        run: RunId,
        chunk: u64,
        complete: bool,
        consistent: bool,
    },
    Changes {
        transaction: Option<String>,
        complete: bool,
    },
}

/// Stored only by trusted source capture, never deserialized from a guest call.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct CapturedInput {
    pub event_id: EventId,
    pub sequence: u64,
    pub source_version: SourceVersionRef,
    pub basis: SourceBasis,
    pub valid_time: ValidTime,
    pub rows: Vec<SourceRow>,
    pub deletions: Vec<(String, String)>,
    pub kind: CaptureKind,
    pub position: SourcePosition,
    pub gap: Option<SourceGap>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct SyncIdentity {
    pub origin_family: OriginFamilyId,
    pub access: world_protocol::materials::AccessPolicyRef,
    pub retention: world_protocol::sources::RetentionPolicy,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct CaptureReceipt {
    pub event: EventId,
    pub sequence: u64,
    pub checkpoint: Checkpoint,
    pub duplicate: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct ApplyReceipt {
    pub events: Vec<EventId>,
    pub checkpoint: Checkpoint,
    pub failures: Vec<world_protocol::sources::FieldMappingFailure>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Handoff {
    pub id: RunId,
    pub assignment: Assignment,
    pub next: Assignment,
    pub checkpoint: Checkpoint,
    pub sealed_at: Timestamp,
}
