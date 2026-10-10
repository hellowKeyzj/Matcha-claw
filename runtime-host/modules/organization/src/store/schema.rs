use std::fmt;

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub(crate) enum RecordKind {
    Team,
    Materialization,
    RunHeader,
    GraphDefinition,
    GraphMetadata,
    NodePosition,
    Attempt,
    ReadyQueue,
    Activity,
    Delivery,
    Trigger,
    ControlResolution,
    Approval,
    ApprovalResolution,
    Command,
    Event,
    Evidence,
    Artifact,
    Decision,
    DecisionEvent,
    WorkflowTemplate,
    WorkflowAdmission,
    Task,
    Runner,
    Mailbox,
    PurgedRun,
}

impl RecordKind {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Team => "team",
            Self::Materialization => "materialization",
            Self::RunHeader => "run_header",
            Self::GraphDefinition => "graph_definition",
            Self::GraphMetadata => "graph_metadata",
            Self::NodePosition => "node_position",
            Self::Attempt => "attempt",
            Self::ReadyQueue => "ready_queue",
            Self::Activity => "activity",
            Self::Delivery => "delivery",
            Self::Trigger => "trigger",
            Self::ControlResolution => "control_resolution",
            Self::Approval => "approval",
            Self::ApprovalResolution => "approval_resolution",
            Self::Command => "command",
            Self::Event => "event",
            Self::Evidence => "evidence",
            Self::Artifact => "artifact",
            Self::Decision => "decision",
            Self::DecisionEvent => "decision_event",
            Self::WorkflowTemplate => "workflow_template",
            Self::WorkflowAdmission => "workflow_admission",
            Self::Task => "task",
            Self::Runner => "runner",
            Self::Mailbox => "mailbox",
            Self::PurgedRun => "purged_run",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self, super::StoreFault> {
        Ok(match value {
            "team" => Self::Team,
            "materialization" => Self::Materialization,
            "run_header" => Self::RunHeader,
            "graph_definition" => Self::GraphDefinition,
            "graph_metadata" => Self::GraphMetadata,
            "node_position" => Self::NodePosition,
            "attempt" => Self::Attempt,
            "ready_queue" => Self::ReadyQueue,
            "activity" => Self::Activity,
            "delivery" => Self::Delivery,
            "trigger" => Self::Trigger,
            "control_resolution" => Self::ControlResolution,
            "approval" => Self::Approval,
            "approval_resolution" => Self::ApprovalResolution,
            "command" => Self::Command,
            "event" => Self::Event,
            "evidence" => Self::Evidence,
            "artifact" => Self::Artifact,
            "decision" => Self::Decision,
            "decision_event" => Self::DecisionEvent,
            "workflow_template" => Self::WorkflowTemplate,
            "workflow_admission" => Self::WorkflowAdmission,
            "task" => Self::Task,
            "runner" => Self::Runner,
            "mailbox" => Self::Mailbox,
            "purged_run" => Self::PurgedRun,
            _ => return Err(super::StoreFault::CorruptRecord),
        })
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub(crate) struct RecordKey {
    pub(crate) kind: RecordKind,
    pub(crate) scope: String,
    pub(crate) id: String,
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct StoredRecord {
    pub(crate) key: RecordKey,
    pub(crate) team_id: Option<String>,
    pub(crate) run_id: Option<String>,
    pub(crate) payload: Vec<u8>,
}

impl fmt::Debug for StoredRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StoredRecord")
            .field("kind", &self.key.kind)
            .field("payload_bytes", &self.payload.len())
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum RecordChange {
    Put(StoredRecord),
    Delete(RecordKey),
}

pub(crate) const VERSION: u8 = 1;

pub(crate) const CREATE: &str = "
    CREATE TABLE IF NOT EXISTS organization_meta (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        epoch INTEGER NOT NULL CHECK(epoch >= 0),
        initialized INTEGER NOT NULL CHECK(initialized IN (0, 1))
    );
    INSERT OR IGNORE INTO organization_meta(singleton, epoch, initialized) VALUES(1, 0, 0);
    CREATE TABLE IF NOT EXISTS records (
        kind TEXT NOT NULL,
        scope TEXT NOT NULL,
        id TEXT NOT NULL,
        team_id TEXT,
        run_id TEXT,
        payload BLOB,
        epoch INTEGER NOT NULL CHECK(epoch > 0),
        PRIMARY KEY(kind, scope, id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS records_epoch ON records(epoch);
    CREATE INDEX IF NOT EXISTS records_team ON records(team_id, kind);
    CREATE INDEX IF NOT EXISTS records_run ON records(run_id, kind);
";
