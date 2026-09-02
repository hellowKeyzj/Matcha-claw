use std::{fmt, num::NonZeroU64};

use sha2::{Digest, Sha256};

use crate::{ApprovalDecision, ApprovalStatus};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TeamEventIdentityKind {
    Command,
    Approval,
}

impl TeamEventIdentityKind {
    const fn label(self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::Approval => "approval",
        }
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct OpaqueId(String);

impl OpaqueId {
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidEventInput> {
        let value = value.into();
        if value.is_empty()
            || value.len() > 128
            || !value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b':')
            })
        {
            return Err(InvalidEventInput::OpaqueId);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidEventInput {
    OpaqueId,
    EmptyGraphPatch,
    GraphPatchIdentity,
}

impl fmt::Display for InvalidEventInput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::OpaqueId => {
                formatter.write_str("event identifiers must be bounded opaque identifiers")
            }
            Self::EmptyGraphPatch => formatter.write_str("graph patches must contain an operation"),
            Self::GraphPatchIdentity => {
                formatter.write_str("graph patch audit identities must be graph-level identifiers")
            }
        }
    }
}

impl std::error::Error for InvalidEventInput {}

pub(crate) fn team_event_id(
    kind: TeamEventIdentityKind,
    run_id: &str,
    causation_id: &str,
    sequence: u64,
) -> Result<OpaqueId, InvalidEventInput> {
    let candidate = match kind {
        TeamEventIdentityKind::Command => format!("team-event-{run_id}-{causation_id}-{sequence}"),
        TeamEventIdentityKind::Approval => {
            format!("team-event-{run_id}-approval-{causation_id}-{sequence}")
        }
    };
    if let Ok(id) = OpaqueId::try_new(candidate.clone()) {
        return Ok(id);
    }

    use fmt::Write as _;

    let digest = Sha256::digest(candidate.as_bytes());
    let mut value = String::with_capacity(80);
    write!(&mut value, "team-event-{}:{sequence}:", kind.label())
        .expect("writing to String cannot fail");
    for byte in digest {
        write!(&mut value, "{byte:02x}").expect("writing to String cannot fail");
    }
    OpaqueId::try_new(value)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GraphNodeKind {
    Start,
    Work,
    Review,
    HumanDecision,
    ScriptReview,
    Join,
    End,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GraphEdgeAction {
    Activate,
    Rework,
    Gate,
    Finish,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GraphPatchOperation {
    AddNode {
        node_id: String,
        kind: GraphNodeKind,
        role_id: Option<String>,
    },
    ReplaceNode {
        node_id: String,
        kind: GraphNodeKind,
        role_id: Option<String>,
    },
    RemoveNode {
        node_id: String,
    },
    AddEdge {
        edge_id: String,
        source_node_id: String,
        target_node_id: String,
        action: GraphEdgeAction,
    },
    ReplaceEdge {
        edge_id: String,
        source_node_id: String,
        target_node_id: String,
        action: GraphEdgeAction,
    },
    RemoveEdge {
        edge_id: String,
    },
    SetMetadata {
        key: OpaqueId,
        value: MetadataValue,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MetadataValue {
    Enabled(bool),
    Revision(u64),
    OpaqueId(OpaqueId),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GraphPatch {
    base_graph_id: String,
    base_workflow_plan_id: String,
    operations: Vec<GraphPatchOperation>,
}

impl GraphPatch {
    pub fn try_new(
        base_graph_id: impl Into<String>,
        base_workflow_plan_id: impl Into<String>,
        operations: Vec<GraphPatchOperation>,
    ) -> Result<Self, InvalidEventInput> {
        let base_graph_id = base_graph_id.into();
        let base_workflow_plan_id = base_workflow_plan_id.into();
        if !is_graph_patch_identity(&base_graph_id)
            || !is_graph_patch_identity(&base_workflow_plan_id)
        {
            return Err(InvalidEventInput::GraphPatchIdentity);
        }
        if operations.is_empty() {
            return Err(InvalidEventInput::EmptyGraphPatch);
        }
        if !operations
            .iter()
            .all(graph_patch_operation_has_valid_identity)
        {
            return Err(InvalidEventInput::GraphPatchIdentity);
        }
        Ok(Self {
            base_graph_id,
            base_workflow_plan_id,
            operations,
        })
    }

    pub fn base_graph_id(&self) -> &str {
        &self.base_graph_id
    }

    pub fn base_workflow_plan_id(&self) -> &str {
        &self.base_workflow_plan_id
    }

    pub fn operations(&self) -> &[GraphPatchOperation] {
        &self.operations
    }
}

fn is_graph_patch_identity(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 16 * 1024 && !value.chars().any(char::is_control)
}

fn graph_patch_operation_has_valid_identity(operation: &GraphPatchOperation) -> bool {
    match operation {
        GraphPatchOperation::AddNode {
            node_id, role_id, ..
        }
        | GraphPatchOperation::ReplaceNode {
            node_id, role_id, ..
        } => {
            is_graph_patch_identity(node_id)
                && role_id.as_deref().is_none_or(is_graph_patch_identity)
        }
        GraphPatchOperation::RemoveNode { node_id } => is_graph_patch_identity(node_id),
        GraphPatchOperation::AddEdge {
            edge_id,
            source_node_id,
            target_node_id,
            ..
        }
        | GraphPatchOperation::ReplaceEdge {
            edge_id,
            source_node_id,
            target_node_id,
            ..
        } => {
            is_graph_patch_identity(edge_id)
                && is_graph_patch_identity(source_node_id)
                && is_graph_patch_identity(target_node_id)
        }
        GraphPatchOperation::RemoveEdge { edge_id } => is_graph_patch_identity(edge_id),
        GraphPatchOperation::SetMetadata { .. } => true,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApprovalAction {
    ContinueNode,
    ExecuteTool,
    PublishResult,
    ExternalAction,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ApprovalCommand {
    approval_id: OpaqueId,
    node_execution_id: OpaqueId,
    role_id: OpaqueId,
    action: ApprovalAction,
}

impl ApprovalCommand {
    pub fn new(
        approval_id: OpaqueId,
        node_execution_id: OpaqueId,
        role_id: OpaqueId,
        action: ApprovalAction,
    ) -> Self {
        Self {
            approval_id,
            node_execution_id,
            role_id,
            action,
        }
    }

    pub fn approval_id(&self) -> &OpaqueId {
        &self.approval_id
    }

    pub fn node_execution_id(&self) -> &OpaqueId {
        &self.node_execution_id
    }

    pub fn role_id(&self) -> &OpaqueId {
        &self.role_id
    }

    pub fn action(&self) -> ApprovalAction {
        self.action
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NodeEventKind {
    Progress,
    RequestInput,
    Complete,
    Reject,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NodeProgressCommand {
    node_execution_id: OpaqueId,
    event: NodeEventKind,
}

impl NodeProgressCommand {
    pub fn new(node_execution_id: OpaqueId) -> Self {
        Self::progress(node_execution_id)
    }

    pub fn progress(node_execution_id: OpaqueId) -> Self {
        Self {
            node_execution_id,
            event: NodeEventKind::Progress,
        }
    }

    pub fn request_input(node_execution_id: OpaqueId) -> Self {
        Self {
            node_execution_id,
            event: NodeEventKind::RequestInput,
        }
    }

    pub fn with_event(node_execution_id: OpaqueId, event: NodeEventKind) -> Self {
        Self {
            node_execution_id,
            event,
        }
    }

    pub fn node_execution_id(&self) -> &OpaqueId {
        &self.node_execution_id
    }

    pub const fn event(&self) -> NodeEventKind {
        self.event
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommandType {
    GraphPatch,
    GraphReplace,
    NodeProgress,
    ApprovalRequest,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandPayload {
    GraphPatch(GraphPatch),
    GraphReplace(crate::GraphDefinition),
    NodeProgress(NodeProgressCommand),
    ApprovalRequest(ApprovalCommand),
}

impl CommandPayload {
    pub fn command_type(&self) -> CommandType {
        match self {
            Self::GraphPatch(_) => CommandType::GraphPatch,
            Self::GraphReplace(_) => CommandType::GraphReplace,
            Self::NodeProgress(_) => CommandType::NodeProgress,
            Self::ApprovalRequest(_) => CommandType::ApprovalRequest,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunCommand {
    run_id: OpaqueId,
    command_id: OpaqueId,
    idempotency_key: OpaqueId,
    payload: CommandPayload,
    created_at: u64,
}

impl RunCommand {
    pub fn new(
        run_id: OpaqueId,
        command_id: OpaqueId,
        idempotency_key: OpaqueId,
        payload: CommandPayload,
        created_at: u64,
    ) -> Self {
        Self {
            run_id,
            command_id,
            idempotency_key,
            payload,
            created_at,
        }
    }

    pub fn run_id(&self) -> &OpaqueId {
        &self.run_id
    }

    pub fn command_id(&self) -> &OpaqueId {
        &self.command_id
    }

    pub fn idempotency_key(&self) -> &OpaqueId {
        &self.idempotency_key
    }

    pub fn command_type(&self) -> CommandType {
        self.payload.command_type()
    }

    pub fn payload(&self) -> &CommandPayload {
        &self.payload
    }

    pub fn created_at(&self) -> u64 {
        self.created_at
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommandStatus {
    Accepted,
    Rejected,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommandRejection {
    UnknownRun,
    StaleNodeExecution,
    InvalidGraphPatch,
    AuthorizationDenied,
    TerminalReceiptRequired,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandRecord {
    sequence: NonZeroU64,
    command: RunCommand,
    status: CommandStatus,
    rejection_reason: Option<CommandRejection>,
    created_at: u64,
    accepted_at: Option<u64>,
    rejected_at: Option<u64>,
}

impl CommandRecord {
    pub(crate) fn from_durable(
        sequence: NonZeroU64,
        command: RunCommand,
        status: CommandStatus,
        rejection_reason: Option<CommandRejection>,
    ) -> Option<Self> {
        match (status, rejection_reason) {
            (CommandStatus::Accepted, None) => Some(Self::accepted(sequence, command)),
            (CommandStatus::Rejected, Some(reason)) => {
                Some(Self::rejected(sequence, command, reason))
            }
            _ => None,
        }
    }

    pub(crate) fn accepted(sequence: NonZeroU64, command: RunCommand) -> Self {
        let created_at = command.created_at();
        Self {
            sequence,
            command,
            status: CommandStatus::Accepted,
            rejection_reason: None,
            created_at,
            accepted_at: Some(created_at),
            rejected_at: None,
        }
    }

    pub(crate) fn rejected(
        sequence: NonZeroU64,
        command: RunCommand,
        rejection_reason: CommandRejection,
    ) -> Self {
        let created_at = command.created_at();
        Self {
            sequence,
            command,
            status: CommandStatus::Rejected,
            rejection_reason: Some(rejection_reason),
            created_at,
            accepted_at: None,
            rejected_at: Some(created_at),
        }
    }

    pub fn sequence(&self) -> u64 {
        self.sequence.get()
    }

    pub fn run_id(&self) -> &OpaqueId {
        self.command.run_id()
    }

    pub fn command_id(&self) -> &OpaqueId {
        self.command.command_id()
    }

    pub fn command_type(&self) -> CommandType {
        self.command.command_type()
    }

    pub fn idempotency_key(&self) -> &OpaqueId {
        self.command.idempotency_key()
    }

    pub fn command(&self) -> &RunCommand {
        &self.command
    }

    pub fn status(&self) -> CommandStatus {
        self.status
    }

    pub fn is_accepted(&self) -> bool {
        self.status == CommandStatus::Accepted
    }

    pub fn is_rejected(&self) -> bool {
        self.status == CommandStatus::Rejected
    }

    pub fn rejection_reason(&self) -> Option<CommandRejection> {
        self.rejection_reason
    }

    pub fn created_at(&self) -> u64 {
        self.created_at
    }

    pub fn accepted_at(&self) -> Option<u64> {
        self.accepted_at
    }

    pub fn rejected_at(&self) -> Option<u64> {
        self.rejected_at
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamEventType {
    GraphPatchAccepted,
    GraphReplaced,
    NodeProgressed,
    ApprovalRequested,
    ApprovalResolved,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TeamEventPayload {
    GraphPatchAccepted {
        base_graph_id: String,
        base_workflow_plan_id: String,
        operation_count: NonZeroU64,
    },
    GraphReplaced {
        graph_id: String,
        workflow_plan_id: String,
    },
    NodeProgressed {
        node_execution_id: OpaqueId,
    },
    ApprovalRequested {
        approval_id: OpaqueId,
        node_execution_id: OpaqueId,
        role_id: OpaqueId,
        action: ApprovalAction,
    },
    ApprovalResolved {
        approval_id: OpaqueId,
        decision: ApprovalDecision,
        status: ApprovalStatus,
    },
}

impl TeamEventPayload {
    pub fn approval_id(&self) -> Option<&str> {
        match self {
            Self::ApprovalRequested { approval_id, .. }
            | Self::ApprovalResolved { approval_id, .. } => Some(approval_id.as_str()),
            Self::GraphPatchAccepted { .. }
            | Self::GraphReplaced { .. }
            | Self::NodeProgressed { .. } => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamEvent {
    event_id: OpaqueId,
    run_id: OpaqueId,
    sequence: NonZeroU64,
    event_type: TeamEventType,
    payload: TeamEventPayload,
    causation_id: OpaqueId,
    idempotency_key: OpaqueId,
    created_at: u64,
}

/// Durable facts needed to restore a team event without regenerating its identity.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TeamEventDurableInput {
    pub(crate) event_id: OpaqueId,
    pub(crate) run_id: OpaqueId,
    pub(crate) sequence: NonZeroU64,
    pub(crate) event_type: TeamEventType,
    pub(crate) payload: TeamEventPayload,
    pub(crate) causation_id: OpaqueId,
    pub(crate) idempotency_key: OpaqueId,
    pub(crate) created_at: u64,
}

impl TeamEvent {
    pub(crate) fn approval_resolved(
        run_id: OpaqueId,
        sequence: NonZeroU64,
        approval_id: OpaqueId,
        decision: ApprovalDecision,
        idempotency_key: OpaqueId,
        created_at: u64,
    ) -> Result<Self, InvalidEventInput> {
        let event_id = team_event_id(
            TeamEventIdentityKind::Approval,
            run_id.as_str(),
            approval_id.as_str(),
            sequence.get(),
        )?;
        let status = decision.status();
        Ok(Self {
            event_id,
            run_id,
            sequence,
            event_type: TeamEventType::ApprovalResolved,
            payload: TeamEventPayload::ApprovalResolved {
                approval_id: approval_id.clone(),
                decision,
                status,
            },
            causation_id: approval_id,
            idempotency_key,
            created_at,
        })
    }

    pub(crate) fn from_durable(input: TeamEventDurableInput) -> Self {
        let TeamEventDurableInput {
            event_id,
            run_id,
            sequence,
            event_type,
            payload,
            causation_id,
            idempotency_key,
            created_at,
        } = input;
        Self {
            event_id,
            run_id,
            sequence,
            event_type,
            payload,
            causation_id,
            idempotency_key,
            created_at,
        }
    }

    pub(crate) fn from_command(
        command: &RunCommand,
        sequence: NonZeroU64,
    ) -> Result<Self, InvalidEventInput> {
        let (event_type, payload) = match command.payload() {
            CommandPayload::GraphPatch(patch) => (
                TeamEventType::GraphPatchAccepted,
                TeamEventPayload::GraphPatchAccepted {
                    base_graph_id: patch.base_graph_id().to_owned(),
                    base_workflow_plan_id: patch.base_workflow_plan_id().to_owned(),
                    operation_count: NonZeroU64::new(patch.operations().len() as u64)
                        .expect("validated graph patches contain one operation"),
                },
            ),
            CommandPayload::GraphReplace(definition) => (
                TeamEventType::GraphReplaced,
                TeamEventPayload::GraphReplaced {
                    graph_id: definition.graph_id().to_owned(),
                    workflow_plan_id: definition.workflow_plan_id().to_owned(),
                },
            ),
            CommandPayload::NodeProgress(progress) => (
                TeamEventType::NodeProgressed,
                TeamEventPayload::NodeProgressed {
                    node_execution_id: progress.node_execution_id().clone(),
                },
            ),
            CommandPayload::ApprovalRequest(approval) => (
                TeamEventType::ApprovalRequested,
                TeamEventPayload::ApprovalRequested {
                    approval_id: approval.approval_id().clone(),
                    node_execution_id: approval.node_execution_id().clone(),
                    role_id: approval.role_id().clone(),
                    action: approval.action(),
                },
            ),
        };
        let event_id = team_event_id(
            TeamEventIdentityKind::Command,
            command.run_id().as_str(),
            command.command_id().as_str(),
            sequence.get(),
        )?;
        Ok(Self {
            event_id,
            run_id: command.run_id().clone(),
            sequence,
            event_type,
            payload,
            causation_id: command.command_id().clone(),
            idempotency_key: command.idempotency_key().clone(),
            created_at: command.created_at(),
        })
    }

    pub fn event_id(&self) -> &str {
        self.event_id.as_str()
    }

    pub fn run_id(&self) -> &str {
        self.run_id.as_str()
    }

    pub(crate) fn run_id_value(&self) -> &OpaqueId {
        &self.run_id
    }

    #[cfg(test)]
    pub(crate) fn with_event_id(mut self, event_id: OpaqueId) -> Self {
        self.event_id = event_id;
        self
    }

    #[cfg(test)]
    pub(crate) fn with_sequence(mut self, sequence: NonZeroU64) -> Self {
        self.sequence = sequence;
        self
    }

    #[cfg(test)]
    pub(crate) fn with_causation_id(mut self, causation_id: OpaqueId) -> Self {
        self.causation_id = causation_id;
        self
    }

    pub fn sequence(&self) -> u64 {
        self.sequence.get()
    }

    pub fn event_type(&self) -> TeamEventType {
        self.event_type
    }

    pub fn payload(&self) -> &TeamEventPayload {
        &self.payload
    }

    pub fn causation_id(&self) -> &str {
        self.causation_id.as_str()
    }

    pub fn idempotency_key(&self) -> &str {
        self.idempotency_key.as_str()
    }

    pub fn created_at(&self) -> u64 {
        self.created_at
    }
}
