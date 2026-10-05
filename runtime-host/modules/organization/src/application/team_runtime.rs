use std::{
    collections::BTreeSet,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};

use organization::{
    BeginCancellationOutcome, CommandPayload, CreateGraphRunOutcome, EdgeAction, GraphDefinition,
    GraphPatch, GraphPatchOperation, GraphRunId, GraphRunPurgeOutcome, IdempotencyKey, NodeKind,
    ResumeOutcome, RunCommand, StoreFault, TeamDecisionReceipt, TeamDecisionType,
    TeamGraphContextResult, TeamGraphContextView, TeamId, TeamNodeEventOutcome,
    TeamRunDiagnosticsQueryOutcome, TeamRunQueryOutcome, TeamTriggerFireOutcome,
    TriggerFireRequest,
    package::{TeamSkillDependencyPlanResult, TeamSkillPackageValidation},
    run::{
        approval::{HumanDecisionCommand, HumanDecisionOutcome},
        event::{
            GraphEdgeAction, GraphNodeKind, GraphPatch as EventGraphPatch,
            GraphPatchOperation as EventGraphPatchOperation, InvalidEventInput, OpaqueId,
        },
        graph::NodePosition,
        public_projection::TeamRunPublicSnapshotQueryOutcome,
        scheduler::NodePromptRetryDueQueryOutcome,
    },
};

use crate::owner::team_run::{
    ArmedTrigger, TeamDeleteOutcome, TeamMaterializationCommandOutcome, TeamNodeTerminalResolution,
    TeamNodeTerminalResult, TeamRunCommandOutcome, TeamRunTriggerOutcome,
};

pub enum TeamRuntimeStatus {
    Rejected,
    Unavailable,
    OutcomeUnknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TeamNodeEventCommandOutcome {
    NonTerminal(TeamNodeEventOutcome),
    Terminal(TeamNodeTerminalResult),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamRuntimeCreateSource {
    TeamSkill,
    Manual,
}

/// Typed owner ingress for the legacy `team.runtime` operation family.
///
/// This is deliberately an owner request, not a public DTO. Public adapters must construct the
/// domain inputs below before entering the Host actor; unsupported legacy projections remain an
/// explicit status rather than an invented success payload.
pub struct ManualTeamProvision {
    pub team_name: String,
    pub roles: Vec<organization::ManualTeamRoleBinding>,
}

pub struct TeamGraphPatchDraft {
    pub(crate) run_id: GraphRunId,
    pub(crate) audit_run_id: OpaqueId,
    pub command_id: OpaqueId,
    pub(crate) idempotency_key: OpaqueId,
    pub(crate) base_graph_id: Option<String>,
    pub(crate) base_workflow_plan_id: Option<String>,
    pub(crate) operations: Vec<GraphPatchOperation>,
    pub(crate) created_at: u64,
}

pub(crate) enum TeamGraphPatchResolveError {
    InvalidInput,
}

impl TeamGraphPatchDraft {
    pub fn new(
        run_id: GraphRunId,
        audit_run_id: OpaqueId,
        command_id: OpaqueId,
        idempotency_key: OpaqueId,
        base_graph_id: Option<String>,
        base_workflow_plan_id: Option<String>,
        operations: Vec<GraphPatchOperation>,
        created_at: u64,
    ) -> Self {
        Self {
            run_id,
            audit_run_id,
            command_id,
            idempotency_key,
            base_graph_id,
            base_workflow_plan_id,
            operations,
            created_at,
        }
    }

    pub(crate) fn resolve(
        self,
        current: &GraphDefinition,
    ) -> Result<(RunCommand, GraphPatch), TeamGraphPatchResolveError> {
        let base_graph_id = self
            .base_graph_id
            .unwrap_or_else(|| current.graph_id().to_owned());
        let base_workflow_plan_id = self
            .base_workflow_plan_id
            .unwrap_or_else(|| current.workflow_plan_id().to_owned());
        let patch = GraphPatch::new(
            base_graph_id.clone(),
            base_workflow_plan_id.clone(),
            self.operations,
        )
        .map_err(|_| TeamGraphPatchResolveError::InvalidInput)?;
        let command_patch = EventGraphPatch::try_new(
            base_graph_id,
            base_workflow_plan_id,
            patch
                .operations()
                .iter()
                .map(team_event_graph_patch_operation)
                .collect::<Vec<_>>(),
        )
        .map_err(map_event_input)?
        .with_content_fingerprint(
            crate::store::codec::graph_patch_fingerprint(&patch)
                .map_err(|_| TeamGraphPatchResolveError::InvalidInput)?,
        );
        Ok((
            RunCommand::new(
                self.audit_run_id,
                self.command_id,
                self.idempotency_key,
                CommandPayload::GraphPatch(command_patch),
                self.created_at,
            ),
            patch,
        ))
    }
}

fn map_event_input(_: InvalidEventInput) -> TeamGraphPatchResolveError {
    TeamGraphPatchResolveError::InvalidInput
}

fn team_event_graph_patch_operation(operation: &GraphPatchOperation) -> EventGraphPatchOperation {
    match operation {
        GraphPatchOperation::AddNode(node) => EventGraphPatchOperation::AddNode {
            node_id: node.id().as_str().to_owned(),
            kind: team_event_graph_node_kind(node.kind()),
            role_id: team_event_graph_node_role_id(node),
        },
        GraphPatchOperation::ReplaceNode(node) => EventGraphPatchOperation::ReplaceNode {
            node_id: node.id().as_str().to_owned(),
            kind: team_event_graph_node_kind(node.kind()),
            role_id: team_event_graph_node_role_id(node),
        },
        GraphPatchOperation::RemoveNode(node_id) => EventGraphPatchOperation::RemoveNode {
            node_id: node_id.as_str().to_owned(),
        },
        GraphPatchOperation::AddEdge(edge) => EventGraphPatchOperation::AddEdge {
            edge_id: edge.id().as_str().to_owned(),
            source_node_id: edge.source_node_id().as_str().to_owned(),
            target_node_id: edge.target_node_id().as_str().to_owned(),
            action: team_event_graph_edge_action(edge.action()),
        },
        GraphPatchOperation::ReplaceEdge(edge) => EventGraphPatchOperation::ReplaceEdge {
            edge_id: edge.id().as_str().to_owned(),
            source_node_id: edge.source_node_id().as_str().to_owned(),
            target_node_id: edge.target_node_id().as_str().to_owned(),
            action: team_event_graph_edge_action(edge.action()),
        },
        GraphPatchOperation::RemoveEdge(edge_id) => EventGraphPatchOperation::RemoveEdge {
            edge_id: edge_id.as_str().to_owned(),
        },
        GraphPatchOperation::SetNodePosition { node_id, position } => {
            EventGraphPatchOperation::SetNodePosition {
                node_id: node_id.as_str().to_owned(),
                x: position.x(),
                y: position.y(),
            }
        }
        GraphPatchOperation::SetMetadata { key, value } => EventGraphPatchOperation::SetMetadata {
            key: key.clone(),
            value: value.clone(),
        },
    }
}

fn team_event_graph_node_kind(kind: NodeKind) -> GraphNodeKind {
    match kind {
        NodeKind::Start => GraphNodeKind::Start,
        NodeKind::Work => GraphNodeKind::Work,
        NodeKind::Review => GraphNodeKind::Review,
        NodeKind::HumanDecision => GraphNodeKind::HumanDecision,
        NodeKind::ScriptReview => GraphNodeKind::ScriptReview,
        NodeKind::Join => GraphNodeKind::Join,
        NodeKind::End => GraphNodeKind::End,
    }
}

fn team_event_graph_edge_action(action: EdgeAction) -> GraphEdgeAction {
    match action {
        EdgeAction::Activate => GraphEdgeAction::Activate,
        EdgeAction::Rework => GraphEdgeAction::Rework,
        EdgeAction::Gate => GraphEdgeAction::Gate,
        EdgeAction::Finish => GraphEdgeAction::Finish,
    }
}

fn team_event_graph_node_role_id(node: &organization::NodeDefinition) -> Option<String> {
    node.work_assignment()
        .map(|assignment| assignment.role_id())
        .or_else(|| {
            node.review_assignment()
                .map(|assignment| assignment.role_id())
        })
        .map(str::to_owned)
}

pub enum TeamRuntimeCommand {
    Design {
        operation: crate::application::design::DesignOperation,
    },
    PackageValidate {
        package_root: PathBuf,
    },
    DependencyPlan {
        package_root: PathBuf,
    },
    ProvisionAgents {
        package_root: PathBuf,
        team_id: Option<TeamId>,
        idempotency_key: IdempotencyKey,
        endpoint: organization::RuntimeEndpointReference,
        source: TeamRuntimeCreateSource,
        manual_team: Option<ManualTeamProvision>,
    },
    Delete {
        team_id: TeamId,
        idempotency_key: IdempotencyKey,
        observed_at: u64,
    },
    RunCreate {
        team_id: Option<TeamId>,
        package_root: PathBuf,
        run_id: Option<GraphRunId>,
        idempotency_key: IdempotencyKey,
        source: TeamRuntimeCreateSource,
    },
    RunList {
        team_id: TeamId,
    },
    TriggerList {
        team_id: Option<TeamId>,
    },
    WebhookTriggerFire {
        webhook_path: String,
        idempotency_key: String,
        fired_at: u64,
    },
    RunSnapshot {
        team_id: Option<TeamId>,
        run_id: GraphRunId,
        event_cursor: Option<u64>,
        event_limit: Option<u64>,
    },
    GraphSave {
        command: Box<organization::RunCommand>,
        definition: GraphDefinition,
    },
    GraphPatch {
        patch: TeamGraphPatchDraft,
    },
    GraphContext {
        team_id: Option<TeamId>,
        run_id: GraphRunId,
        view: TeamGraphContextView,
        node_execution_id: Option<String>,
    },
    GraphExportYaml {
        run_id: GraphRunId,
    },
    GraphImportYaml {
        command: Box<organization::RunCommand>,
        definition: GraphDefinition,
    },
    TriggerFire {
        request: TriggerFireRequest,
        fired_at: u64,
    },
    RunStartConfirm {
        run_id: GraphRunId,
        proposal_id: String,
    },
    RunStartContinue {
        run_id: GraphRunId,
        proposal_id: String,
    },
    NodePromptRetryDue {
        run_id: GraphRunId,
    },
    NodeEvent {
        run_id: GraphRunId,
        node_execution_id: OpaqueId,
        event: OpaqueId,
        summary: String,
        role_id: Option<OpaqueId>,
        requested_action: Option<String>,
        idempotency_key: IdempotencyKey,
        terminal_resolution: Option<TeamNodeTerminalResolution>,
        output_port: Option<String>,
    },
    RunDiagnostics {
        run_id: GraphRunId,
    },
    RunDecisionSubmit {
        run_id: GraphRunId,
        decision: TeamDecisionType,
        note: Option<String>,
        idempotency_key: OpaqueId,
        resolved_at: u64,
    },
    Resume {
        team_id: TeamId,
    },
    ApprovalResolve {
        command: HumanDecisionCommand,
    },
    RunCancel {
        run_id: GraphRunId,
        idempotency_key: IdempotencyKey,
        requested_at: u64,
    },
    RunDelete {
        run_id: GraphRunId,
        idempotency_key: IdempotencyKey,
        tombstoned_at: u64,
    },
}

pub enum TeamRuntimeCommandOutcome {
    Design {
        read: bool,
        result: Result<Value, StoreFault>,
    },
    PackageValidate(TeamSkillPackageValidation),
    DependencyPlan(TeamSkillDependencyPlanResult),
    ProvisionAgents(TeamMaterializationCommandOutcome),
    Delete(Result<TeamDeleteOutcome, StoreFault>),
    RunCreate(Result<CreateGraphRunOutcome, TeamRuntimeStatus>),
    RunList(Vec<TeamRunQueryOutcome>),
    TriggerList(Vec<ArmedTrigger>),
    WebhookTriggerFire(Result<TeamTriggerFireOutcome, TeamRuntimeStatus>),
    RunSnapshot {
        snapshot: TeamRunPublicSnapshotQueryOutcome,
        role_sessions: Option<Vec<organization::RoleSessionReceipt>>,
    },
    RunSnapshotInvalidInput,
    GraphSave(Result<TeamRunCommandOutcome, StoreFault>),
    GraphPatch(Result<TeamRunCommandOutcome, StoreFault>),
    GraphContext(TeamGraphContextResult),
    GraphExportYaml(Result<String, TeamRuntimeStatus>),
    GraphImportYaml(Result<TeamRunCommandOutcome, StoreFault>),
    TriggerFire(Result<TeamRunTriggerOutcome, StoreFault>),
    RunStartConfirm(Result<organization::ConfirmRunStartOutcome, StoreFault>),
    RunStartContinue(Result<organization::ContinueRunDiscussionOutcome, StoreFault>),
    NodePromptRetryDue(NodePromptRetryDueQueryOutcome),
    NodeEvent(Result<TeamNodeEventCommandOutcome, TeamRuntimeStatus>),
    RunDiagnostics(TeamRunDiagnosticsQueryOutcome),
    RunDecisionSubmit(Result<TeamDecisionReceipt, TeamRuntimeStatus>),
    Resume {
        team_id: TeamId,
        outcomes: Vec<ResumeOutcome>,
        runs: Vec<TeamRunQueryOutcome>,
    },
    ApprovalResolve(Result<HumanDecisionOutcome, StoreFault>),
    RunCancel(Result<BeginCancellationOutcome, StoreFault>),
    RunDelete(Result<GraphRunPurgeOutcome, StoreFault>),
}

#[derive(Clone, Copy)]
enum RunCommandIdentityKind {
    GraphImportYaml,
    GraphSave,
    GraphPatch,
}

impl RunCommandIdentityKind {
    const fn label(self) -> &'static str {
        match self {
            Self::GraphImportYaml => "graph-import-yaml",
            Self::GraphSave => "graph-save",
            Self::GraphPatch => "graph-patch",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamRuntimeDecodeError {
    InvalidInput,
    Unavailable,
}
pub fn decode_team_runtime_command(
    operation_id: &str,
    target: &Value,
    input: &Value,
    endpoint: organization::RuntimeEndpointReference,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let input = input
        .as_object()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    match operation_id {
        "team.packageValidate" | "team.dependencyPlan" => {
            let target = target
                .as_object()
                .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
            if target.len() != 2
                || target.get("kind") != Some(&json!("team"))
                || input.len() != 1
                || target.get("packagePath") != input.get("packagePath")
            {
                return Err(TeamRuntimeDecodeError::InvalidInput);
            }
            let package_path = input
                .get("packagePath")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
            let package_root = PathBuf::from(package_path);
            if operation_id == "team.packageValidate" {
                Ok(TeamRuntimeCommand::PackageValidate { package_root })
            } else {
                Ok(TeamRuntimeCommand::DependencyPlan { package_root })
            }
        }
        "team.provisionAgents" => decode_team_provision(input, target, endpoint),
        "team.delete" => decode_team_delete(input, target),
        "team.runDelete" => decode_team_run_delete(input, target),
        "team.runList" => {
            let team_id = decode_team_id_target(target, input)?;
            if input.len() != 1 {
                return Err(TeamRuntimeDecodeError::InvalidInput);
            }
            Ok(TeamRuntimeCommand::RunList { team_id })
        }
        "team.resume" => decode_team_resume(input, target),
        "team.triggerList" => {
            if !input.is_empty() {
                return Err(TeamRuntimeDecodeError::InvalidInput);
            }
            let team_id = match target {
                Value::Null => None,
                Value::Object(target)
                    if target.len() == 1 && target.get("kind") == Some(&json!("team")) =>
                {
                    None
                }
                Value::Object(target)
                    if target.len() == 2 && target.get("kind") == Some(&json!("team")) =>
                {
                    target
                        .get("teamId")
                        .and_then(Value::as_str)
                        .filter(|value| !value.trim().is_empty())
                        .map(|value| organization::TeamId::try_new(value.to_owned()))
                        .transpose()
                        .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?
                }
                _ => return Err(TeamRuntimeDecodeError::InvalidInput),
            };
            Ok(TeamRuntimeCommand::TriggerList { team_id })
        }
        "team.designStart"
        | "team.designContinue"
        | "team.designExit"
        | "team.designSnapshot"
        | "team.designGraphPatch" => super::design::decode(operation_id, input, target),
        "team.runCreate" => decode_team_run_create(input, target),
        "team.webhookTriggerFire" => decode_team_webhook_trigger(input, target),
        "team.graphSave" => decode_team_graph_save(input, target),
        "team.graphPatch" => decode_team_graph_patch(input, target),
        "team.graphContext" => decode_team_graph_context(input, target),
        "team.nodePromptRetryDue" => decode_team_node_prompt_retry_due(input, target),
        "team.nodeEvent" => decode_team_node_event(input, target),
        "team.runDecisionSubmit" => decode_team_run_decision(input, target),
        "team.runSnapshot" => decode_team_snapshot(input, target),
        "team.graphExportYaml" => decode_team_graph_export(input, target),
        "team.graphImportYaml" => decode_team_graph_import(input, target),
        "team.runDiagnostics" => decode_team_run_diagnostics(input, target),
        "team.proposalConfirm" | "team.runStartConfirm" => {
            decode_team_run_start_confirm(input, target)
        }
        "team.proposalContinue"
        | "team.proposalCancel"
        | "team.runStartContinue"
        | "team.runStartReject" => decode_team_run_start_continue(input, target),
        "team.triggerFire" => decode_team_trigger(input, target),
        "team.approvalResolve" => decode_team_approval(input, target),
        "team.runCancel" => decode_team_run_cancel(input, target),
        _ => Err(TeamRuntimeDecodeError::Unavailable),
    }
}

fn decode_team_run_start_confirm(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let (_, run_id) = decode_team_target(target, input, false)?;
    let proposal_id = decode_start_proposal_id(input)?;
    Ok(TeamRuntimeCommand::RunStartConfirm {
        run_id,
        proposal_id,
    })
}

fn decode_team_run_start_continue(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let (_, run_id) = decode_team_target(target, input, false)?;
    let proposal_id = decode_start_proposal_id(input)?;
    Ok(TeamRuntimeCommand::RunStartContinue {
        run_id,
        proposal_id,
    })
}

fn decode_start_proposal_id(
    input: &serde_json::Map<String, Value>,
) -> Result<String, TeamRuntimeDecodeError> {
    if !input.keys().all(|key| {
        matches!(
            key.as_str(),
            "runId" | "teamId" | "proposalId" | "idempotencyKey"
        )
    }) {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    input
        .get("proposalId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .ok_or(TeamRuntimeDecodeError::InvalidInput)
}

fn decode_team_run_cancel(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let (_, run_id) = decode_team_target(target, input, false)?;
    if !input.keys().all(|key| {
        matches!(
            key.as_str(),
            "runId" | "teamId" | "reason" | "idempotencyKey"
        )
    }) || input
        .get("reason")
        .is_some_and(|value| value.as_str().is_none())
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let idempotency_key = input
        .get("idempotencyKey")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let idempotency_key = organization::IdempotencyKey::try_new(idempotency_key.to_owned())
        .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
    Ok(TeamRuntimeCommand::RunCancel {
        run_id,
        idempotency_key,
        requested_at: now_millis(),
    })
}

fn decode_team_delete(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let target = target
        .as_object()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    if target.len() != 2
        || target.get("kind") != Some(&json!("team"))
        || input.len() != 2
        || target.get("teamId") != input.get("teamId")
        || input.get("kind") != Some(&json!("team"))
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let team_id = organization::TeamId::try_new(
        input
            .get("teamId")
            .and_then(Value::as_str)
            .filter(|value| valid_identifier(value))
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?
            .to_owned(),
    )
    .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
    let idempotency_key =
        organization::IdempotencyKey::try_new(format!("team-delete:{}", team_id.as_str()))
            .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
    Ok(TeamRuntimeCommand::Delete {
        team_id,
        idempotency_key,
        observed_at: now_millis(),
    })
}

fn decode_team_run_delete(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let (_, run_id) = decode_team_target(target, input, false)?;
    if input.len() != 1 {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let idempotency_key =
        organization::IdempotencyKey::try_new(format!("run-delete:{}", run_id.as_str()))
            .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
    Ok(TeamRuntimeCommand::RunDelete {
        run_id,
        idempotency_key,
        tombstoned_at: now_millis(),
    })
}

fn decode_team_run_create(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let target = target
        .as_object()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    if target.get("kind") != Some(&json!("team"))
        || !(target.len() == 2 || target.len() == 3)
        || target.get("packagePath") != input.get("packagePath")
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    if !input.keys().all(|key| {
        matches!(
            key.as_str(),
            "packagePath" | "teamId" | "runId" | "idempotencyKey" | "sourceType"
        )
    }) {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let package_path = input
        .get("packagePath")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let team_id = decode_optional_team_id(input.get("teamId"), target.get("teamId"))?;
    let run_id = input
        .get("runId")
        .map(|value| {
            value
                .as_str()
                .filter(|value| valid_identifier(value))
                .map(|value| organization::GraphRunId::new(value.to_owned()))
                .ok_or(TeamRuntimeDecodeError::InvalidInput)
        })
        .transpose()?;
    let idempotency_key = decode_idempotency_key(input, "idempotencyKey")?;
    let source = decode_team_runtime_source(input.get("sourceType"))?;
    Ok(TeamRuntimeCommand::RunCreate {
        team_id,
        package_root: PathBuf::from(package_path),
        run_id,
        idempotency_key,
        source,
    })
}

fn decode_optional_team_id(
    input_team: Option<&Value>,
    target_team: Option<&Value>,
) -> Result<Option<organization::TeamId>, TeamRuntimeDecodeError> {
    match (target_team, input_team) {
        (None, None) => Ok(None),
        (Some(target_team), Some(input_team)) if target_team == input_team => {
            let team_id = input_team
                .as_str()
                .filter(|value| valid_identifier(value))
                .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
            organization::TeamId::try_new(team_id.to_owned())
                .map(Some)
                .map_err(|_| TeamRuntimeDecodeError::InvalidInput)
        }
        _ => Err(TeamRuntimeDecodeError::InvalidInput),
    }
}

fn decode_idempotency_key(
    input: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<organization::IdempotencyKey, TeamRuntimeDecodeError> {
    let value = input
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    organization::IdempotencyKey::try_new(value.to_owned())
        .map_err(|_| TeamRuntimeDecodeError::InvalidInput)
}

fn decode_team_runtime_source(
    value: Option<&Value>,
) -> Result<TeamRuntimeCreateSource, TeamRuntimeDecodeError> {
    match value.and_then(Value::as_str) {
        None | Some("teamskill") => Ok(TeamRuntimeCreateSource::TeamSkill),
        Some("manual") => Ok(TeamRuntimeCreateSource::Manual),
        Some(_) => Err(TeamRuntimeDecodeError::InvalidInput),
    }
}

fn decode_team_provision(
    input: &serde_json::Map<String, Value>,
    target: &Value,
    endpoint: organization::RuntimeEndpointReference,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let target = target
        .as_object()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    if target.get("kind") != Some(&json!("team"))
        || !(target.len() == 2 || target.len() == 3)
        || target.get("packagePath") != input.get("packagePath")
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let team_id = decode_optional_team_id(input.get("teamId"), target.get("teamId"))?;
    let package_path = input
        .get("packagePath")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let idempotency_key = decode_idempotency_key(input, "idempotencyKey")?;
    let source = decode_team_runtime_source(input.get("sourceType"))?;
    let manual_team = match source {
        TeamRuntimeCreateSource::TeamSkill => {
            if input.contains_key("manualTeam") {
                return Err(TeamRuntimeDecodeError::InvalidInput);
            }
            None
        }
        TeamRuntimeCreateSource::Manual => Some(decode_manual_team_provision(
            input
                .get("manualTeam")
                .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
        )?),
    };
    if team_id.is_none() {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    if !input.keys().all(|key| {
        matches!(
            key.as_str(),
            "packagePath" | "teamId" | "idempotencyKey" | "sourceType" | "manualTeam"
        )
    }) {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    Ok(TeamRuntimeCommand::ProvisionAgents {
        package_root: PathBuf::from(package_path),
        team_id,
        idempotency_key,
        endpoint,
        source,
        manual_team,
    })
}

fn decode_manual_team_provision(
    value: &Value,
) -> Result<ManualTeamProvision, TeamRuntimeDecodeError> {
    let record = value
        .as_object()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    if !record
        .keys()
        .all(|key| matches!(key.as_str(), "name" | "description" | "version" | "members"))
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let team_name = manual_required_string(record, "name")?;
    let members = record
        .get("members")
        .and_then(Value::as_array)
        .filter(|members| !members.is_empty())
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let mut leader_count = 0usize;
    let mut role_ids = BTreeSet::new();
    let mut agent_ids = BTreeSet::new();
    let mut roles = Vec::with_capacity(members.len());
    for member in members {
        roles.push(decode_manual_team_member_provision(
            member,
            &mut leader_count,
            &mut role_ids,
            &mut agent_ids,
        )?);
    }
    if leader_count != 1 {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    Ok(ManualTeamProvision {
        team_name: team_name.to_owned(),
        roles,
    })
}

fn decode_manual_team_member_provision(
    value: &Value,
    leader_count: &mut usize,
    role_ids: &mut BTreeSet<String>,
    agent_ids: &mut BTreeSet<String>,
) -> Result<organization::ManualTeamRoleBinding, TeamRuntimeDecodeError> {
    let member = value
        .as_object()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    if !member.keys().all(|key| {
        matches!(
            key.as_str(),
            "agentId"
                | "agentName"
                | "workspace"
                | "roleId"
                | "skills"
                | "tools"
                | "model"
                | "isLeader"
        )
    }) {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let agent_id = manual_required_string(member, "agentId")?;
    let _workspace = manual_required_string(member, "workspace")?;
    let declared_role = manual_required_string(member, "roleId")?;
    let leader = matches!(member.get("isLeader").and_then(Value::as_bool), Some(true));
    let role_id = if leader {
        *leader_count += 1;
        organization::LEADER_ROLE_ID
    } else {
        if declared_role == organization::LEADER_ROLE_ID {
            return Err(TeamRuntimeDecodeError::InvalidInput);
        }
        declared_role
    };
    if !agent_ids.insert(agent_id.to_owned()) || !role_ids.insert(role_id.to_owned()) {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let member_name = member
        .get("agentName")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(agent_id);
    let role = organization::RoleId::try_new(role_id.to_owned())
        .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
    let agent = organization::ManagedAgentReference::try_new(agent_id.to_owned())
        .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
    let tools = member
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|tool| !tool.is_empty())
        .map(str::to_owned)
        .collect();
    organization::ManualTeamRoleBinding::try_new(role, member_name.to_owned(), agent, leader)
        .map(|binding| binding.with_tools(tools))
        .map_err(|_| TeamRuntimeDecodeError::InvalidInput)
}

fn manual_required_string<'a>(
    record: &'a serde_json::Map<String, Value>,
    field: &str,
) -> Result<&'a str, TeamRuntimeDecodeError> {
    record
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(TeamRuntimeDecodeError::InvalidInput)
}

fn decode_team_snapshot(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let (team_id, run_id) = decode_team_target(target, input, false)?;
    if !input.keys().all(|key| {
        matches!(
            key.as_str(),
            "runId" | "teamId" | "eventCursor" | "eventLimit"
        )
    }) {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let event_cursor = optional_u64(input, "eventCursor")?;
    if let Some(event_limit) = optional_u64(input, "eventLimit")? {
        usize::try_from(event_limit).map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
    }
    Ok(TeamRuntimeCommand::RunSnapshot {
        team_id,
        run_id,
        event_cursor,
        event_limit: optional_u64(input, "eventLimit")?,
    })
}

fn decode_team_graph_export(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let (_, run_id) = decode_team_target(target, input, false)?;
    if input.len() != 1 {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    Ok(TeamRuntimeCommand::GraphExportYaml { run_id })
}

fn decode_team_graph_import(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let (_, run_id) = decode_team_target(target, input, false)?;
    if input.len() != 3 {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let yaml = input
        .get("yaml")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let definition = organization::import_for_run(yaml, &run_id)
        .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
    let idempotency_key = decode_opaque(input, "idempotencyKey")?;
    let command_id = bounded_run_command_id(
        RunCommandIdentityKind::GraphImportYaml,
        idempotency_key.as_str(),
    )?;
    let run_id = decode_opaque_value(run_id.as_str())?;
    Ok(TeamRuntimeCommand::GraphImportYaml {
        command: Box::new(organization::RunCommand::new(
            run_id,
            command_id,
            idempotency_key,
            organization::CommandPayload::GraphReplace(definition.clone()),
            now_millis(),
        )),
        definition,
    })
}

fn decode_team_run_diagnostics(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let (_, run_id) = decode_team_target(target, input, false)?;
    if input.len() != 1 {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    Ok(TeamRuntimeCommand::RunDiagnostics { run_id })
}

fn decode_team_node_prompt_retry_due(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let (_, run_id) = decode_team_target(target, input, false)?;
    if input.len() != 1 {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    Ok(TeamRuntimeCommand::NodePromptRetryDue { run_id })
}

fn decode_team_trigger(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let (_, run_id) = decode_team_target(target, input, false)?;
    let source = match input.get("triggerSource").and_then(Value::as_str) {
        Some("cron") => organization::TriggerSource::Cron,
        Some("webhook") => organization::TriggerSource::Webhook,
        _ => return Err(TeamRuntimeDecodeError::InvalidInput),
    };
    if let Some(value) = input.get("payloadSummary")
        && !value.is_string()
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    if !input.keys().all(|key| {
        matches!(
            key.as_str(),
            "runId"
                | "teamId"
                | "startNodeId"
                | "triggerSource"
                | "payloadSummary"
                | "idempotencyKey"
        )
    }) {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let request = organization::TriggerFireRequest::try_new(
        run_id.as_str(),
        input
            .get("startNodeId")
            .and_then(Value::as_str)
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
        source,
        input
            .get("idempotencyKey")
            .and_then(Value::as_str)
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
    )
    .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
    Ok(TeamRuntimeCommand::TriggerFire {
        request,
        fired_at: now_millis(),
    })
}

fn decode_team_approval(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let target = target
        .as_object()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    if target.len() != 3
        || target.get("kind") != Some(&json!("team-approval"))
        || target.get("runId") != input.get("runId")
        || target.get("approvalId") != input.get("approvalId")
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let decision = match input.get("decision").and_then(Value::as_str) {
        Some("approve") => organization::ApprovalDecision::Approve,
        Some("deny") => organization::ApprovalDecision::Deny,
        Some("abort") => organization::ApprovalDecision::Abort,
        _ => return Err(TeamRuntimeDecodeError::InvalidInput),
    };
    let allowed = ["runId", "approvalId", "decision", "note", "idempotencyKey"];
    if !input.keys().all(|key| allowed.contains(&key.as_str()))
        || !input.contains_key("runId")
        || !input.contains_key("approvalId")
        || !input.contains_key("idempotencyKey")
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let run_id = organization::GraphRunId::new(
        input
            .get("runId")
            .and_then(Value::as_str)
            .filter(|value| valid_identifier(value))
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?
            .to_owned(),
    );
    let approval_id = organization::run::event::OpaqueId::try_new(
        input
            .get("approvalId")
            .and_then(Value::as_str)
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?
            .to_owned(),
    )
    .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
    let idempotency_key = organization::run::event::OpaqueId::try_new(
        input
            .get("idempotencyKey")
            .and_then(Value::as_str)
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?
            .to_owned(),
    )
    .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
    let note = input.get("note").map(|note| {
        note.as_str()
            .filter(|note| !note.trim().is_empty())
            .map(str::to_owned)
            .ok_or(TeamRuntimeDecodeError::InvalidInput)
    });
    let note = match note {
        None => None,
        Some(note) => Some(note?),
    };
    let command = organization::run::approval::HumanDecisionCommand::new(
        run_id,
        approval_id,
        decision,
        note,
        idempotency_key,
        now_millis(),
    )
    .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
    Ok(TeamRuntimeCommand::ApprovalResolve { command })
}

fn decode_team_id_target(
    target: &Value,
    input: &serde_json::Map<String, Value>,
) -> Result<organization::TeamId, TeamRuntimeDecodeError> {
    let target = target
        .as_object()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    if target.get("kind") != Some(&json!("team"))
        || target.len() != 2
        || target.get("teamId") != input.get("teamId")
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    organization::TeamId::try_new(
        input
            .get("teamId")
            .and_then(Value::as_str)
            .filter(|value| valid_identifier(value))
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?
            .to_owned(),
    )
    .map_err(|_| TeamRuntimeDecodeError::InvalidInput)
}

fn decode_team_resume(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let team_id = decode_team_id_target(target, input)?;
    if input.len() != 2 {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let idempotency_key = input
        .get("idempotencyKey")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    organization::IdempotencyKey::try_new(idempotency_key.to_owned())
        .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
    Ok(TeamRuntimeCommand::Resume { team_id })
}

fn decode_team_webhook_trigger(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    if !(target.is_null()
        || target
            .as_object()
            .is_some_and(|target| target.len() == 1 && target.get("kind") == Some(&json!("team"))))
        || !input
            .keys()
            .all(|key| matches!(key.as_str(), "webhookPath" | "idempotencyKey"))
        || input.len() != 2
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let webhook_path = input
        .get("webhookPath")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?
        .to_owned();
    let idempotency_key = input
        .get("idempotencyKey")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?
        .to_owned();
    organization::run::trigger::TriggerFireRequest::try_new(
        "webhook",
        "webhook",
        organization::TriggerSource::Webhook,
        &idempotency_key,
    )
    .map_err(|_| TeamRuntimeDecodeError::InvalidInput)?;
    Ok(TeamRuntimeCommand::WebhookTriggerFire {
        webhook_path,
        idempotency_key,
        fired_at: now_millis(),
    })
}

fn decode_team_graph_context(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let (team_id, run_id) = decode_team_target(target, input, true)?;
    if !input.keys().all(|key| {
        matches!(
            key.as_str(),
            "runId" | "teamId" | "view" | "nodeExecutionId"
        )
    }) || input.len() < 2
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let view = match input.get("view").and_then(Value::as_str) {
        Some("current_node") | Some("currentNode") => {
            organization::TeamGraphContextView::CurrentNode
        }
        Some("graph_summary") | Some("graphSummary") => {
            organization::TeamGraphContextView::GraphSummary
        }
        _ => return Err(TeamRuntimeDecodeError::InvalidInput),
    };
    let node_execution_id = input
        .get("nodeExecutionId")
        .map(|value| {
            value
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned)
                .ok_or(TeamRuntimeDecodeError::InvalidInput)
        })
        .transpose()?;
    match view {
        organization::TeamGraphContextView::CurrentNode if node_execution_id.is_none() => {
            return Err(TeamRuntimeDecodeError::InvalidInput);
        }
        organization::TeamGraphContextView::GraphSummary if node_execution_id.is_some() => {
            return Err(TeamRuntimeDecodeError::InvalidInput);
        }
        _ => {}
    }
    Ok(TeamRuntimeCommand::GraphContext {
        team_id,
        run_id,
        view,
        node_execution_id,
    })
}

fn decode_team_graph_save(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let (_, run_id) = decode_team_target(target, input, false)?;
    if !input.keys().all(|key| {
        matches!(
            key.as_str(),
            "runId" | "graph" | "idempotencyKey" | "summary" | "metadata"
        )
    }) || input.len() < 3
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    if let Some(summary) = input.get("summary")
        && !summary.is_string()
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    if let Some(metadata) = input.get("metadata")
        && !metadata.is_object()
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let graph = input
        .get("graph")
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let definition = decode_team_graph_definition(graph, &run_id)?;
    let idempotency_key = decode_opaque(input, "idempotencyKey")?;
    let command_id =
        bounded_run_command_id(RunCommandIdentityKind::GraphSave, idempotency_key.as_str())?;
    let run_id = decode_opaque_value(run_id.as_str())?;
    Ok(TeamRuntimeCommand::GraphSave {
        command: Box::new(organization::RunCommand::new(
            run_id,
            command_id,
            idempotency_key,
            organization::CommandPayload::GraphReplace(definition.clone()),
            now_millis(),
        )),
        definition,
    })
}

fn decode_team_graph_patch(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let (_, run_id) = decode_team_target(target, input, false)?;
    if !input.keys().all(|key| {
        matches!(
            key.as_str(),
            "runId" | "summary" | "patch" | "idempotencyKey" | "metadata"
        )
    }) || input.len() < 4
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    if input.get("summary").and_then(Value::as_str).is_none() {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    if let Some(metadata) = input.get("metadata")
        && !metadata.is_object()
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let idempotency_key = decode_opaque(input, "idempotencyKey")?;
    let command_id =
        bounded_run_command_id(RunCommandIdentityKind::GraphPatch, idempotency_key.as_str())?;
    let audit_run_id = decode_opaque_value(run_id.as_str())?;
    let patch = decode_team_graph_patch_value(
        input
            .get("patch")
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
        run_id,
        audit_run_id,
        command_id,
        idempotency_key,
    )?;
    Ok(TeamRuntimeCommand::GraphPatch { patch })
}

fn decode_team_node_event(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let (_, run_id) = decode_team_target(target, input, false)?;
    if !input.keys().all(|key| {
        matches!(
            key.as_str(),
            "runId"
                | "nodeExecutionId"
                | "event"
                | "summary"
                | "idempotencyKey"
                | "roleId"
                | "outputPort"
                | "evidenceRefs"
                | "requestedAction"
                | "risk"
                | "metadata"
                | "result"
                | "deliveryId"
                | "receipt"
                | "nodeId"
                | "attemptNumber"
        )
    }) {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let event = decode_opaque(input, "event")?;
    if !matches!(
        event.as_str(),
        "progress" | "request_input" | "request_approval" | "reject" | "complete"
    ) {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let node_execution_id = decode_opaque(input, "nodeExecutionId")?;
    let summary = input
        .get("summary")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .or_else(|| {
            input
                .get("result")
                .and_then(Value::as_object)
                .and_then(|result| result.get("summary"))
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned)
        })
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let terminal_resolution = if matches!(event.as_str(), "complete" | "reject") {
        decode_optional_team_node_terminal_resolution(input)?
    } else {
        None
    };
    let role_id = input
        .get("roleId")
        .map(|_| decode_opaque(input, "roleId"))
        .transpose()?;
    let requested_action = input
        .get("requestedAction")
        .map(|value| {
            value
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned)
                .ok_or(TeamRuntimeDecodeError::InvalidInput)
        })
        .transpose()?;
    let output_port = input
        .get("outputPort")
        .map(|value| {
            value
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned)
                .ok_or(TeamRuntimeDecodeError::InvalidInput)
        })
        .transpose()?;
    if let Some(value) = input.get("metadata")
        && !value.is_object()
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    if let Some(value) = input.get("evidenceRefs")
        && !value.is_array()
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    Ok(TeamRuntimeCommand::NodeEvent {
        run_id,
        node_execution_id,
        event,
        summary,
        role_id,
        requested_action,
        idempotency_key: decode_idempotency_key(input, "idempotencyKey")?,
        terminal_resolution,
        output_port,
    })
}

fn decode_optional_team_node_terminal_resolution(
    input: &serde_json::Map<String, Value>,
) -> Result<Option<TeamNodeTerminalResolution>, TeamRuntimeDecodeError> {
    if !(input.contains_key("deliveryId")
        || input.contains_key("receipt")
        || input.contains_key("nodeId")
        || input.contains_key("attemptNumber"))
    {
        return Ok(None);
    }
    let attempt_number = input
        .get("attemptNumber")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .and_then(std::num::NonZeroU32::new)
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    Ok(Some(TeamNodeTerminalResolution::new(
        input
            .get("deliveryId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?
            .to_owned(),
        input
            .get("receipt")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?
            .to_owned(),
        input
            .get("nodeId")
            .and_then(Value::as_str)
            .filter(|value| valid_identifier(value))
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?
            .to_owned(),
        attempt_number,
        input
            .get("summary")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?
            .to_owned(),
        input
            .get("outputPort")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?
            .to_owned(),
    )))
}

fn decode_team_run_decision(
    input: &serde_json::Map<String, Value>,
    target: &Value,
) -> Result<TeamRuntimeCommand, TeamRuntimeDecodeError> {
    let (_, run_id) = decode_team_target(target, input, false)?;
    if !input.keys().all(|key| {
        matches!(
            key.as_str(),
            "runId" | "decision" | "note" | "idempotencyKey"
        )
    }) || input.len() < 3
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let decision = match input.get("decision").and_then(Value::as_str) {
        Some("retry") => organization::TeamDecisionType::Retry,
        Some("proceed_degraded") => organization::TeamDecisionType::ProceedDegraded,
        Some("abort") => organization::TeamDecisionType::Abort,
        _ => return Err(TeamRuntimeDecodeError::InvalidInput),
    };
    let note = input
        .get("note")
        .map(|value| {
            value
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned)
                .ok_or(TeamRuntimeDecodeError::InvalidInput)
        })
        .transpose()?;
    Ok(TeamRuntimeCommand::RunDecisionSubmit {
        run_id,
        decision,
        note,
        idempotency_key: decode_opaque(input, "idempotencyKey")?,
        resolved_at: now_millis(),
    })
}

fn decode_opaque(
    input: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<organization::run::event::OpaqueId, TeamRuntimeDecodeError> {
    decode_opaque_value(
        input
            .get(field)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
    )
}

fn decode_opaque_value(
    value: &str,
) -> Result<organization::run::event::OpaqueId, TeamRuntimeDecodeError> {
    organization::run::event::OpaqueId::try_new(value.to_owned())
        .map_err(|_| TeamRuntimeDecodeError::InvalidInput)
}

fn bounded_run_command_id(
    kind: RunCommandIdentityKind,
    idempotency_key: &str,
) -> Result<organization::run::event::OpaqueId, TeamRuntimeDecodeError> {
    let label = kind.label();
    let candidate = format!("{label}:{idempotency_key}");
    if let Ok(command_id) = decode_opaque_value(&candidate) {
        return Ok(command_id);
    }

    use sha2::{Digest, Sha256};
    use std::fmt::Write as _;

    let digest = Sha256::digest(idempotency_key.as_bytes());
    let mut value = String::with_capacity(label.len() + 65);
    value.push_str(label);
    value.push(':');
    for byte in digest {
        write!(&mut value, "{byte:02x}").expect("writing to String cannot fail");
    }
    decode_opaque_value(&value)
}

fn decode_team_graph_definition(
    value: &Value,
    run_id: &organization::GraphRunId,
) -> Result<organization::GraphDefinition, TeamRuntimeDecodeError> {
    let graph = value
        .as_object()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    if let Some(graph_run_id) = graph.get("runId")
        && graph_run_id.as_str() != Some(run_id.as_str())
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let graph_id = graph_string_field(graph, "graphId")
        .map(str::to_owned)
        .unwrap_or_else(|| default_team_graph_id(run_id));
    let workflow_plan_id = graph_string_field(graph, "workflowPlanId")
        .map(str::to_owned)
        .unwrap_or_else(|| default_team_workflow_plan_id(run_id));
    let title = graph_string_field(graph, "title")
        .map(str::to_owned)
        .unwrap_or_else(|| "Team graph".to_owned());
    let nodes = decode_team_graph_nodes(
        graph
            .get("nodes")
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
    )?;
    let edges = decode_team_graph_edges(
        graph
            .get("edges")
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
    )?;
    organization::GraphDefinition::new(
        graph_id,
        workflow_plan_id,
        run_id.clone(),
        title,
        nodes,
        edges,
    )
    .map_err(|_| TeamRuntimeDecodeError::InvalidInput)
}

fn default_team_graph_id(run_id: &organization::GraphRunId) -> String {
    format!("graph:{}", run_id.as_str())
}

fn default_team_workflow_plan_id(run_id: &organization::GraphRunId) -> String {
    format!("workflow:{}", run_id.as_str())
}

fn graph_string_field<'a>(
    object: &'a serde_json::Map<String, Value>,
    field: &str,
) -> Option<&'a str> {
    object
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty() && valid_identifier(value))
}

fn graph_text_field<'a>(
    object: &'a serde_json::Map<String, Value>,
    field: &str,
) -> Option<&'a str> {
    object
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

fn decode_team_graph_nodes(
    value: &Value,
) -> Result<Vec<organization::NodeDefinition>, TeamRuntimeDecodeError> {
    let nodes = value
        .as_array()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    nodes.iter().map(decode_team_graph_node).collect()
}

fn decode_team_graph_node(
    value: &Value,
) -> Result<organization::NodeDefinition, TeamRuntimeDecodeError> {
    let node = value
        .as_object()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let node_id = graph_string_field(node, "nodeId")
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?
        .to_owned();
    let id = organization::NodeId::new(node_id.clone());
    let title = graph_string_field(node, "title")
        .unwrap_or(node_id.as_str())
        .to_owned();
    let config = node.get("config").and_then(Value::as_object);
    let max_attempts = decode_team_graph_node_max_attempts(node, config)?;
    let kind =
        decode_team_graph_node_kind(node.get("kind").and_then(Value::as_str).unwrap_or("work"))?;
    match kind {
        organization::NodeKind::Start => Ok(organization::NodeDefinition::start(
            id,
            title,
            max_attempts,
            decode_team_graph_start_trigger(config)?,
        )),
        organization::NodeKind::Work => {
            let task_id = graph_string_field(node, "taskId").unwrap_or(node_id.as_str());
            let role_id = decode_team_graph_role_id(node).unwrap_or("team");
            let prompt = config
                .and_then(|config| graph_text_field(config, "prompt"))
                .unwrap_or("");
            let output_artifact_kind = config
                .and_then(|config| graph_text_field(config, "outputArtifactKind"))
                .map(str::to_owned);
            let group_id = graph_string_field(node, "groupId")
                .map(|group_id| organization::GroupId::new(group_id.to_owned()));
            Ok(organization::NodeDefinition::work(
                id,
                title,
                max_attempts,
                organization::WorkAssignment::typed(
                    task_id,
                    prompt,
                    organization::ExecutorPolicy::team_role_session(
                        role_id,
                        decode_team_graph_session_ref(config)?,
                    ),
                    output_artifact_kind,
                    group_id,
                ),
            ))
        }
        organization::NodeKind::Review => {
            let role_id = decode_team_graph_role_id(node);
            let prompt = config.and_then(|config| graph_text_field(config, "prompt"));
            if let (Some(role_id), Some(prompt)) = (role_id, prompt) {
                Ok(organization::NodeDefinition::review(
                    id,
                    title,
                    max_attempts,
                    organization::ReviewAssignment::with_executor(
                        organization::ExecutorPolicy::team_role_session(
                            role_id,
                            decode_team_graph_session_ref(config)?,
                        ),
                        prompt,
                    ),
                ))
            } else {
                Ok(organization::NodeDefinition::control(
                    id,
                    kind,
                    title,
                    max_attempts,
                ))
            }
        }
        organization::NodeKind::Join => Ok(organization::NodeDefinition::join(
            id,
            title,
            max_attempts,
            organization::WorkGroup::new(
                organization::GroupId::new(graph_string_field(node, "groupId").unwrap_or("group")),
                decode_team_graph_join_policy(config)?,
            ),
        )),
        _ => Ok(organization::NodeDefinition::control(
            id,
            kind,
            title,
            max_attempts,
        )),
    }
}

fn decode_team_graph_session_ref(
    config: Option<&serde_json::Map<String, Value>>,
) -> Result<organization::RoleSessionRef, TeamRuntimeDecodeError> {
    match config.and_then(|config| config.get("sessionRef")) {
        None => Ok(organization::RoleSessionRef::initial()),
        Some(value) => organization::RoleSessionRef::try_new(
            value.as_str().ok_or(TeamRuntimeDecodeError::InvalidInput)?,
        )
        .map_err(|_| TeamRuntimeDecodeError::InvalidInput),
    }
}

fn decode_team_graph_join_policy(
    config: Option<&serde_json::Map<String, Value>>,
) -> Result<organization::JoinPolicy, TeamRuntimeDecodeError> {
    let Some(value) = config.and_then(|config| config.get("join")) else {
        return Ok(organization::JoinPolicy::new(true, false, 0));
    };
    let join = value
        .as_object()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    Ok(organization::JoinPolicy::new(
        join.get("requireCompleted")
            .and_then(Value::as_bool)
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
        join.get("allowFailed")
            .and_then(Value::as_bool)
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
        join.get("retryLimit")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
    ))
}

fn decode_team_graph_node_kind(
    kind: &str,
) -> Result<organization::NodeKind, TeamRuntimeDecodeError> {
    match kind {
        "start" => Ok(organization::NodeKind::Start),
        "work" => Ok(organization::NodeKind::Work),
        "review" => Ok(organization::NodeKind::Review),
        "human_decision" | "humanDecision" => Ok(organization::NodeKind::HumanDecision),
        "script_review" | "scriptReview" => Ok(organization::NodeKind::ScriptReview),
        "join" => Ok(organization::NodeKind::Join),
        "end" => Ok(organization::NodeKind::End),
        _ => Err(TeamRuntimeDecodeError::InvalidInput),
    }
}

fn decode_team_graph_node_max_attempts(
    node: &serde_json::Map<String, Value>,
    config: Option<&serde_json::Map<String, Value>>,
) -> Result<std::num::NonZeroU32, TeamRuntimeDecodeError> {
    let Some(value) = node
        .get("maxAttempts")
        .or_else(|| config.and_then(|config| config.get("maxAttempts")))
    else {
        return Ok(std::num::NonZeroU32::MIN);
    };
    value
        .as_u64()
        .and_then(|value| u32::try_from(value).ok())
        .and_then(std::num::NonZeroU32::new)
        .ok_or(TeamRuntimeDecodeError::InvalidInput)
}

fn decode_team_graph_role_id(node: &serde_json::Map<String, Value>) -> Option<&str> {
    graph_string_field(node, "roleId").or_else(|| {
        node.get("executor")
            .and_then(Value::as_object)
            .and_then(|executor| graph_string_field(executor, "roleId"))
    })
}

fn decode_team_graph_start_trigger(
    config: Option<&serde_json::Map<String, Value>>,
) -> Result<Option<organization::StartTrigger>, TeamRuntimeDecodeError> {
    let Some(trigger) = config
        .and_then(|config| config.get("trigger"))
        .and_then(Value::as_object)
    else {
        return Ok(None);
    };
    match trigger
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("webhook")
    {
        "cron" => Ok(Some(organization::StartTrigger::Cron {
            expression: graph_text_field(trigger, "cron")
                .ok_or(TeamRuntimeDecodeError::InvalidInput)?
                .to_owned(),
        })),
        "webhook" => {
            Ok(
                graph_text_field(trigger, "path").map(|path| organization::StartTrigger::Webhook {
                    path: path.to_owned(),
                }),
            )
        }
        _ => Err(TeamRuntimeDecodeError::InvalidInput),
    }
}

fn decode_team_graph_edges(
    value: &Value,
) -> Result<Vec<organization::EdgeDefinition>, TeamRuntimeDecodeError> {
    let edges = value
        .as_array()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    edges.iter().map(decode_team_graph_edge).collect()
}

fn decode_team_graph_edge(
    value: &Value,
) -> Result<organization::EdgeDefinition, TeamRuntimeDecodeError> {
    let edge = value
        .as_object()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let action = decode_team_graph_edge_action(
        edge.get("action")
            .and_then(Value::as_str)
            .unwrap_or("activate"),
    )?;
    let source_node_id = graph_string_field(edge, "sourceNodeId")
        .or_else(|| graph_string_field(edge, "fromNodeId"))
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let target_node_id = graph_string_field(edge, "targetNodeId")
        .or_else(|| graph_string_field(edge, "toNodeId"))
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let include_upstream_result = match edge
        .get("payload")
        .and_then(Value::as_object)
        .and_then(|payload| payload.get("includeUpstreamResult"))
    {
        Some(value) => value
            .as_bool()
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
        None => true,
    };
    let dependency = match edge.get("dependency") {
        None | Some(Value::Null) => None,
        Some(value) => {
            let dependency = value
                .as_object()
                .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
            Some(organization::DependencyMetadata::new(
                graph_string_field(dependency, "dependencyTaskId")
                    .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
                graph_string_field(dependency, "taskId")
                    .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
            ))
        }
    };
    Ok(organization::EdgeDefinition::new(
        organization::EdgeId::new(
            graph_string_field(edge, "edgeId").ok_or(TeamRuntimeDecodeError::InvalidInput)?,
        ),
        organization::NodeId::new(source_node_id),
        graph_string_field(edge, "sourcePort").unwrap_or("default"),
        organization::NodeId::new(target_node_id),
        graph_string_field(edge, "targetPort").unwrap_or("default"),
        action,
    )
    .with_payload(organization::EdgePayloadPolicy::new(
        include_upstream_result,
    ))
    .with_dependency_opt(dependency))
}

fn decode_team_graph_edge_action(
    action: &str,
) -> Result<organization::EdgeAction, TeamRuntimeDecodeError> {
    match action {
        "activate" => Ok(organization::EdgeAction::Activate),
        "rework" => Ok(organization::EdgeAction::Rework),
        "gate" => Ok(organization::EdgeAction::Gate),
        "finish" => Ok(organization::EdgeAction::Finish),
        _ => Err(TeamRuntimeDecodeError::InvalidInput),
    }
}

pub(crate) fn decode_team_graph_patch_value(
    value: &Value,
    run_id: organization::GraphRunId,
    audit_run_id: organization::run::event::OpaqueId,
    command_id: organization::run::event::OpaqueId,
    idempotency_key: organization::run::event::OpaqueId,
) -> Result<TeamGraphPatchDraft, TeamRuntimeDecodeError> {
    let patch = value
        .as_object()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let base_graph_id = graph_string_field(patch, "baseGraphId").map(str::to_owned);
    let base_workflow_plan_id = graph_string_field(patch, "baseWorkflowPlanId").map(str::to_owned);
    let operation_values = patch
        .get("operations")
        .and_then(Value::as_array)
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let mut operations = Vec::with_capacity(operation_values.len());
    for value in operation_values {
        let operation = value
            .as_object()
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
        let op = operation
            .get("op")
            .and_then(Value::as_str)
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
        match op {
            "add_node" => operations.push(organization::GraphPatchOperation::AddNode(
                decode_team_graph_node(
                    operation
                        .get("node")
                        .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
                )?,
            )),
            "replace_node" => operations.push(organization::GraphPatchOperation::ReplaceNode(
                decode_team_graph_node(
                    operation
                        .get("node")
                        .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
                )?,
            )),
            "remove_node" => operations.push(organization::GraphPatchOperation::RemoveNode(
                organization::NodeId::new(
                    graph_string_field(operation, "nodeId")
                        .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
                ),
            )),
            "add_edge" => operations.push(organization::GraphPatchOperation::AddEdge(
                decode_team_graph_edge(
                    operation
                        .get("edge")
                        .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
                )?,
            )),
            "replace_edge" => operations.push(organization::GraphPatchOperation::ReplaceEdge(
                decode_team_graph_edge(
                    operation
                        .get("edge")
                        .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
                )?,
            )),
            "remove_edge" => operations.push(organization::GraphPatchOperation::RemoveEdge(
                organization::EdgeId::new(
                    graph_string_field(operation, "edgeId")
                        .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
                ),
            )),
            "set_node_position" => {
                operations.push(organization::GraphPatchOperation::SetNodePosition {
                    node_id: organization::NodeId::new(
                        graph_string_field(operation, "nodeId")
                            .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
                    ),
                    position: decode_team_graph_node_position(
                        operation
                            .get("position")
                            .ok_or(TeamRuntimeDecodeError::InvalidInput)?,
                    )?,
                })
            }
            "set_metadata" => decode_team_graph_metadata_patch(operation, &mut operations)?,
            _ => return Err(TeamRuntimeDecodeError::Unavailable),
        }
    }
    if operations.is_empty() {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    Ok(TeamGraphPatchDraft::new(
        run_id,
        audit_run_id,
        command_id,
        idempotency_key,
        base_graph_id,
        base_workflow_plan_id,
        operations,
        now_millis(),
    ))
}

fn decode_team_graph_node_position(value: &Value) -> Result<NodePosition, TeamRuntimeDecodeError> {
    let position = value
        .as_object()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let x = position
        .get("x")
        .and_then(Value::as_i64)
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    let y = position
        .get("y")
        .and_then(Value::as_i64)
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    Ok(NodePosition::new(x, y))
}

fn decode_team_graph_metadata_patch(
    operation: &serde_json::Map<String, Value>,
    operations: &mut Vec<organization::GraphPatchOperation>,
) -> Result<(), TeamRuntimeDecodeError> {
    let metadata = operation
        .get("metadata")
        .and_then(Value::as_object)
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    if metadata.is_empty() {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    for (key, value) in metadata {
        operations.push(organization::GraphPatchOperation::SetMetadata {
            key: decode_opaque_value(key)?,
            value: decode_team_graph_metadata_value(value)?,
        });
    }
    Ok(())
}

fn decode_team_graph_metadata_value(
    value: &Value,
) -> Result<organization::run::event::MetadataValue, TeamRuntimeDecodeError> {
    match value {
        Value::Bool(value) => Ok(organization::run::event::MetadataValue::Enabled(*value)),
        Value::Number(value) => value
            .as_u64()
            .map(organization::run::event::MetadataValue::Revision)
            .ok_or(TeamRuntimeDecodeError::InvalidInput),
        Value::String(value) => Ok(organization::run::event::MetadataValue::OpaqueId(
            decode_opaque_value(value)?,
        )),
        _ => Err(TeamRuntimeDecodeError::InvalidInput),
    }
}

fn decode_team_target(
    target: &Value,
    input: &serde_json::Map<String, Value>,
    require_team_id: bool,
) -> Result<(Option<organization::TeamId>, organization::GraphRunId), TeamRuntimeDecodeError> {
    let target = target
        .as_object()
        .ok_or(TeamRuntimeDecodeError::InvalidInput)?;
    if target.get("kind") != Some(&json!("team-run"))
        || !(target.len() == 2 || target.len() == 3)
        || target.get("runId") != input.get("runId")
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let run_id = organization::GraphRunId::new(
        input
            .get("runId")
            .and_then(Value::as_str)
            .filter(|value| valid_identifier(value))
            .ok_or(TeamRuntimeDecodeError::InvalidInput)?
            .to_owned(),
    );
    let target_team = target.get("teamId");
    let input_team = input.get("teamId");
    if target_team.is_some() != input_team.is_some()
        || target_team != input_team
        || (require_team_id && target_team.is_none())
    {
        return Err(TeamRuntimeDecodeError::InvalidInput);
    }
    let team_id = target_team
        .map(|value| {
            organization::TeamId::try_new(
                value
                    .as_str()
                    .filter(|value| valid_identifier(value))
                    .ok_or(TeamRuntimeDecodeError::InvalidInput)?
                    .to_owned(),
            )
            .map_err(|_| TeamRuntimeDecodeError::InvalidInput)
        })
        .transpose()?;
    Ok((team_id, run_id))
}

fn optional_u64(
    input: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<Option<u64>, TeamRuntimeDecodeError> {
    input
        .get(field)
        .map(|value| value.as_u64().ok_or(TeamRuntimeDecodeError::InvalidInput))
        .transpose()
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 4096 && !value.chars().any(char::is_control)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn test_runtime_endpoint() -> organization::RuntimeEndpointReference {
        organization::RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap()
    }

    #[test]
    fn graph_context_decode_requires_node_execution_id_only_for_current_node_view() {
        let target = json!({ "kind": "team-run", "teamId": "team:one", "runId": "run:one" });
        let current = decode_team_runtime_command(
            "team.graphContext",
            &target,
            &json!({
                "teamId": "team:one",
                "runId": "run:one",
                "view": "currentNode",
                "nodeExecutionId": "node:attempt:1",
            }),
            test_runtime_endpoint(),
        )
        .unwrap();
        assert!(matches!(
            current,
            TeamRuntimeCommand::GraphContext {
                view: organization::TeamGraphContextView::CurrentNode,
                node_execution_id: Some(node_execution_id),
                ..
            } if node_execution_id == "node:attempt:1"
        ));

        let summary = decode_team_runtime_command(
            "team.graphContext",
            &target,
            &json!({
                "teamId": "team:one",
                "runId": "run:one",
                "view": "graph_summary",
            }),
            test_runtime_endpoint(),
        )
        .unwrap();
        assert!(matches!(
            summary,
            TeamRuntimeCommand::GraphContext {
                view: organization::TeamGraphContextView::GraphSummary,
                node_execution_id: None,
                ..
            }
        ));

        for input in [
            json!({
                "teamId": "team:one",
                "runId": "run:one",
                "view": "current_node",
            }),
            json!({
                "teamId": "team:one",
                "runId": "run:one",
                "view": "graphSummary",
                "nodeExecutionId": "node:attempt:1",
            }),
        ] {
            assert!(
                decode_team_runtime_command(
                    "team.graphContext",
                    &target,
                    &input,
                    test_runtime_endpoint()
                )
                .is_err()
            );
        }
    }

    #[test]
    fn graph_node_attempt_budget_is_explicit_and_never_silently_repaired() {
        for budget in [json!(1), json!(3), json!(u32::MAX)] {
            let node = decode_team_graph_node(&json!({
                "nodeId": "work", "kind": "work", "maxAttempts": budget,
            }))
            .unwrap();
            assert_eq!(
                u64::from(node.max_attempts().get()),
                budget.as_u64().unwrap()
            );
        }
        for budget in [
            json!(0),
            json!(-1),
            json!(1.5),
            json!(4294967296_u64),
            json!("3"),
            Value::Null,
        ] {
            assert!(
                decode_team_graph_node(&json!({
                    "nodeId": "work", "kind": "work", "maxAttempts": budget,
                }))
                .is_err()
            );
        }
        assert_eq!(
            decode_team_graph_node(&json!({ "nodeId": "work" }))
                .unwrap()
                .max_attempts(),
            std::num::NonZeroU32::MIN,
        );
    }

    #[test]
    fn graph_patch_decode_bounds_command_identity_for_renderer_keys() {
        let key = "graph-patch:0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz012345";
        let command = decode_team_runtime_command(
            "team.graphPatch",
            &json!({ "kind": "team-run", "runId": "run:one" }),
            &json!({
                "runId": "run:one",
                "summary": "graph_patch",
                "idempotencyKey": key,
                "patch": {
                    "baseGraphId": "graph:one",
                    "baseWorkflowPlanId": "workflow:one",
                    "operations": [{ "op": "remove_node", "nodeId": "node:old" }],
                },
            }),
            test_runtime_endpoint(),
        )
        .unwrap();

        assert!(matches!(
            command,
            TeamRuntimeCommand::GraphPatch { patch }
                if patch.command_id.as_str().starts_with("graph-patch:")
                    && patch.command_id.as_str() != format!("graph-patch:{key}")
                    && patch.command_id.as_str().len() <= 128
        ));
    }

    #[test]
    fn run_decision_decode_accepts_supported_decisions() {
        for (value, expected) in [
            ("retry", organization::TeamDecisionType::Retry),
            (
                "proceed_degraded",
                organization::TeamDecisionType::ProceedDegraded,
            ),
            ("abort", organization::TeamDecisionType::Abort),
        ] {
            let command = decode_team_runtime_command(
                "team.runDecisionSubmit",
                &json!({ "kind": "team-run", "runId": "run:one" }),
                &json!({
                    "runId": "run:one",
                    "decision": value,
                    "idempotencyKey": format!("decision:{value}"),
                }),
                test_runtime_endpoint(),
            )
            .unwrap();
            assert!(matches!(
                command,
                TeamRuntimeCommand::RunDecisionSubmit { decision, .. } if decision == expected
            ));
        }
    }
}
