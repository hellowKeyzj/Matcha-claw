use serde_json::{Value, json};

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum TeamRuntimeOperation {
    PackageValidate,
    DependencyPlan,
    ProvisionAgents,
    Delete,
    RunCreate,
    RoleSessionCreate,
    RunList,
    TriggerList,
    WebhookTriggerFire,
    RunSnapshot,
    NodeReviewHistory,
    DesignStart,
    RunStart,
    RunReworkContinue,
    DesignExit,
    DesignSnapshot,
    DesignGraphPatch,
    GraphSave,
    GraphPatch,
    GraphContext,
    GraphExportYaml,
    GraphImportYaml,
    TriggerFire,
    NodePromptRetryDue,
    NodeEvent,
    RunDiagnostics,
    RunDecisionSubmit,
    Resume,
    ApprovalResolve,
    RunCancel,
    RunDelete,
}

impl TeamRuntimeOperation {
    pub(crate) fn parse(id: &str) -> Option<Self> {
        Some(match id {
            "team.packageValidate" => Self::PackageValidate,
            "team.dependencyPlan" => Self::DependencyPlan,
            "team.provisionAgents" => Self::ProvisionAgents,
            "team.delete" => Self::Delete,
            "team.runCreate" => Self::RunCreate,
            "team.roleSessionCreate" => Self::RoleSessionCreate,
            "team.runList" => Self::RunList,
            "team.triggerList" => Self::TriggerList,
            "team.webhookTriggerFire" => Self::WebhookTriggerFire,
            "team.runSnapshot" => Self::RunSnapshot,
            "team.nodeReviewHistory" => Self::NodeReviewHistory,
            "team.designStart" => Self::DesignStart,
            "team.runStart" => Self::RunStart,
            "team.runReworkContinue" => Self::RunReworkContinue,
            "team.designExit" => Self::DesignExit,
            "team.designSnapshot" => Self::DesignSnapshot,
            "team.designGraphPatch" => Self::DesignGraphPatch,
            "team.graphSave" => Self::GraphSave,
            "team.graphPatch" => Self::GraphPatch,
            "team.graphContext" => Self::GraphContext,
            "team.graphExportYaml" => Self::GraphExportYaml,
            "team.graphImportYaml" => Self::GraphImportYaml,
            "team.triggerFire" => Self::TriggerFire,
            "team.nodePromptRetryDue" => Self::NodePromptRetryDue,
            "team.nodeEvent" => Self::NodeEvent,
            "team.runDiagnostics" => Self::RunDiagnostics,
            "team.runDecisionSubmit" => Self::RunDecisionSubmit,
            "team.resume" => Self::Resume,
            "team.approvalResolve" => Self::ApprovalResolve,
            "team.runCancel" => Self::RunCancel,
            "team.runDelete" => Self::RunDelete,
            _ => return None,
        })
    }

    pub(crate) fn id(self) -> &'static str {
        match self {
            Self::PackageValidate => "team.packageValidate",
            Self::DependencyPlan => "team.dependencyPlan",
            Self::ProvisionAgents => "team.provisionAgents",
            Self::Delete => "team.delete",
            Self::RunCreate => "team.runCreate",
            Self::RoleSessionCreate => "team.roleSessionCreate",
            Self::RunList => "team.runList",
            Self::TriggerList => "team.triggerList",
            Self::WebhookTriggerFire => "team.webhookTriggerFire",
            Self::RunSnapshot => "team.runSnapshot",
            Self::NodeReviewHistory => "team.nodeReviewHistory",
            Self::DesignStart => "team.designStart",
            Self::RunStart => "team.runStart",
            Self::RunReworkContinue => "team.runReworkContinue",
            Self::DesignExit => "team.designExit",
            Self::DesignSnapshot => "team.designSnapshot",
            Self::DesignGraphPatch => "team.designGraphPatch",
            Self::GraphSave => "team.graphSave",
            Self::GraphPatch => "team.graphPatch",
            Self::GraphContext => "team.graphContext",
            Self::GraphExportYaml => "team.graphExportYaml",
            Self::GraphImportYaml => "team.graphImportYaml",
            Self::TriggerFire => "team.triggerFire",
            Self::NodePromptRetryDue => "team.nodePromptRetryDue",
            Self::NodeEvent => "team.nodeEvent",
            Self::RunDiagnostics => "team.runDiagnostics",
            Self::RunDecisionSubmit => "team.runDecisionSubmit",
            Self::Resume => "team.resume",
            Self::ApprovalResolve => "team.approvalResolve",
            Self::RunCancel => "team.runCancel",
            Self::RunDelete => "team.runDelete",
        }
    }

    pub(crate) fn single_stage(self) -> bool {
        !matches!(
            self,
            Self::ProvisionAgents | Self::Delete | Self::RunCreate | Self::RunSnapshot | Self::NodeReviewHistory
                | Self::Resume | Self::RunDelete | Self::RoleSessionCreate
        )
    }
}

pub fn listed() -> Vec<Value> {
    vec![team_runtime_descriptor(
        native_runtime_instance_scope(),
        runtime_directory::RuntimeDriverIdentity::open_claw(),
    )]
}

pub fn describe(id: &str, scope: &Value) -> Option<Value> {
    if id != "team.runtime" || scope.get("kind").and_then(Value::as_str) != Some("runtime-instance")
    {
        return None;
    }
    let identity = runtime_identity_for_scope(scope)?;
    runtime_directory::RuntimeCapabilitySurface::for_identity(identity)
        .supports(runtime_directory::RuntimeCapabilityFamily::Team)
        .then(|| team_runtime_descriptor(scope.clone(), identity))
}

pub fn team_runtime_descriptor(
    scope: Value,
    identity: runtime_directory::RuntimeDriverIdentity,
) -> Value {
    json!({
        "id": "team.runtime",
        "kind": "team-runtime",
        "scopeKind": "runtime-instance",
        "scope": scope,
        "targetKinds": ["none", "team", "team-run", "team-approval"],
        "runtimeAdapterId": identity.runtime_adapter_id(),
        "runtimeInstanceId": identity.runtime_instance_id(),
        "supportLevel": "native",
        "availability": "available",
        "operations": [
            operation(TeamRuntimeOperation::PackageValidate, "Validate TeamSkill package", "team"),
            operation(TeamRuntimeOperation::DependencyPlan, "Plan TeamSkill dependencies", "team"),
            operation(TeamRuntimeOperation::ProvisionAgents, "Provision Team managed agents", "team"),
            operation(TeamRuntimeOperation::Delete, "Delete Team", "team"),
            operation(TeamRuntimeOperation::RunCreate, "Create TeamRun", "team"),
            operation(TeamRuntimeOperation::RoleSessionCreate, "Create TeamRun role session", "team-run"),
            operation(TeamRuntimeOperation::RunList, "List TeamRuns", "team"),
            operation(TeamRuntimeOperation::TriggerList, "List TeamRun armed triggers", "team"),
            operation(TeamRuntimeOperation::WebhookTriggerFire, "Fire TeamRun webhook trigger by route", "team"),
            team_run_snapshot_operation(),
            team_node_review_history_operation(),
            operation(TeamRuntimeOperation::DesignStart, "Begin TeamRun workflow design", "team"),
            operation(TeamRuntimeOperation::RunStart, "Start TeamRun workflow", "team"),
            team_run_rework_continue_operation(),
            operation(TeamRuntimeOperation::DesignExit, "Return TeamRun workflow design to discussion", "team"),
            operation(TeamRuntimeOperation::DesignSnapshot, "Read complete TeamRun workflow design", "team"),
            operation(TeamRuntimeOperation::DesignGraphPatch, "Save TeamRun workflow design patch", "team"),
            operation(TeamRuntimeOperation::GraphSave, "Save TeamRun graph config", "team-run"),
            operation(TeamRuntimeOperation::GraphPatch, "Submit TeamRun graph patch command", "team-run"),
            operation(TeamRuntimeOperation::GraphContext, "Read compact TeamRun graph context", "team-run"),
            operation(TeamRuntimeOperation::GraphExportYaml, "Export TeamRun graph YAML", "team-run"),
            operation(TeamRuntimeOperation::GraphImportYaml, "Import TeamRun graph YAML", "team-run"),
            operation(TeamRuntimeOperation::TriggerFire, "Fire TeamRun StartNode trigger", "team-run"),
            operation(TeamRuntimeOperation::NodePromptRetryDue, "Read due TeamRun node prompt retry plan", "team-run"),
            operation(TeamRuntimeOperation::NodeEvent, "Submit TeamRun node event command", "team-run"),
            operation(TeamRuntimeOperation::RunDiagnostics, "Read TeamRun diagnostics", "team-run"),
            operation(TeamRuntimeOperation::RunDecisionSubmit, "Submit TeamRun decision", "team-run"),
            operation(TeamRuntimeOperation::Resume, "Resume Team", "team"),
            operation(TeamRuntimeOperation::ApprovalResolve, "Resolve Team approval", "team-approval"),
            operation(TeamRuntimeOperation::RunCancel, "Cancel TeamRun", "team-run"),
            operation(TeamRuntimeOperation::RunDelete, "Delete TeamRun", "team-run"),
        ],
        "policyScope": "team.runtime",
        "ownerModuleId": "organization",
        "routeOwnerId": "team-runtime",
    })
}

fn native_runtime_instance_scope() -> Value {
    let identity = runtime_directory::RuntimeDriverIdentity::open_claw();
    json!({
        "kind": "runtime-instance",
        "endpoint": {
            "kind": "native-runtime",
            "runtimeAdapterId": identity.runtime_adapter_id(),
            "runtimeInstanceId": identity.runtime_instance_id(),
        },
    })
}

fn runtime_identity_for_scope(scope: &Value) -> Option<runtime_directory::RuntimeDriverIdentity> {
    if scope.get("kind").and_then(Value::as_str)? != "runtime-instance" {
        return None;
    }
    runtime_identity_for_endpoint(scope.get("endpoint")?)
}

fn runtime_identity_for_endpoint(
    endpoint: &Value,
) -> Option<runtime_directory::RuntimeDriverIdentity> {
    let object = endpoint.as_object()?;
    if object.get("kind").and_then(Value::as_str)? != "native-runtime" {
        return None;
    }
    let adapter = object.get("runtimeAdapterId").and_then(Value::as_str)?;
    let instance = object.get("runtimeInstanceId").and_then(Value::as_str)?;
    for identity in [
        runtime_directory::RuntimeDriverIdentity::open_claw(),
        runtime_directory::RuntimeDriverIdentity::matcha_agent(),
    ] {
        if adapter == identity.runtime_adapter_id() && instance == identity.runtime_instance_id() {
            return Some(identity);
        }
    }
    None
}

fn team_run_rework_continue_operation() -> Value {
    let mut descriptor = operation(TeamRuntimeOperation::RunReworkContinue, "Increase TeamRun rework limit and continue", "team-run");
    descriptor["inputSchema"] = json!({
        "type": "object", "additionalProperties": false,
        "required": ["teamId", "runId", "nodeId", "sourcePort", "batchId", "sourceNodeExecutionId", "maxReworks", "expectedGraphVersion", "commandId", "idempotencyKey"],
        "properties": {
            "teamId": { "type": "string", "minLength": 1 },
            "runId": { "type": "string", "minLength": 1 },
            "nodeId": { "type": "string", "minLength": 1 },
            "sourcePort": { "type": "string", "minLength": 1 },
            "batchId": { "type": "integer", "minimum": 1, "maximum": 9007199254740991u64 },
            "sourceNodeExecutionId": { "type": "string", "minLength": 1 },
            "maxReworks": { "type": "integer", "minimum": 0, "maximum": u32::MAX },
            "expectedGraphVersion": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
            "commandId": { "type": "string", "minLength": 1 },
            "idempotencyKey": { "type": "string", "minLength": 1 },
        },
    });
    descriptor
}

fn team_run_snapshot_operation() -> Value {
    let mut descriptor = operation(TeamRuntimeOperation::RunSnapshot, "Read TeamRun snapshot", "team-run");
    descriptor["inputSchema"] = json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "teamId": { "type": "string" },
            "runId": { "type": "string" },
            "eventCursor": { "type": "integer", "minimum": 0 },
            "eventLimit": { "type": "integer", "minimum": 0 },
            "messageCursor": {
                "type": "object", "additionalProperties": false,
                "required": ["revision", "messageId", "bodyOffset"],
                "properties": {
                    "revision": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
                    "messageId": { "type": "string", "minLength": 1, "maxLength": 512 },
                    "bodyOffset": { "type": "integer", "minimum": 0, "maximum": 9007199254740991u64 },
                },
            },
        },
    });
    descriptor
}

fn team_node_review_history_operation() -> Value {
    let mut descriptor = operation(TeamRuntimeOperation::NodeReviewHistory, "Read Agent review history", "team-run");
    let identity = json!({ "type": "string", "minLength": 1, "maxLength": 4096 });
    let revision = json!({ "type": "string", "pattern": "^[0-9a-f]{64}$" });
    descriptor["inputSchema"] = json!({
        "type": "object", "additionalProperties": false,
        "required": ["teamId", "runId", "nodeId", "query"],
        "properties": {
            "teamId": identity,
            "runId": identity,
            "nodeId": identity,
            "query": {
                "oneOf": [
                    {
                        "type": "object", "additionalProperties": false,
                        "required": ["kind"],
                        "properties": {
                            "kind": { "const": "list" },
                            "cursor": {
                                "type": "object", "additionalProperties": false,
                                "required": ["revision", "nodeExecutionId", "attemptId"],
                                "properties": { "revision": revision, "nodeExecutionId": identity, "attemptId": identity },
                            },
                        },
                    },
                    {
                        "type": "object", "additionalProperties": false,
                        "required": ["kind", "nodeExecutionId", "attemptId"],
                        "properties": {
                            "kind": { "const": "messages" },
                            "nodeExecutionId": identity,
                            "attemptId": identity,
                            "cursor": {
                                "type": "object", "additionalProperties": false,
                                "required": ["revision", "messageId", "bodyOffset"],
                                "properties": {
                                    "revision": revision,
                                    "messageId": { "type": "string", "minLength": 1, "maxLength": 512 },
                                    "bodyOffset": { "type": "integer", "minimum": 0, "maximum": 9007199254740991u64 },
                                },
                            },
                        },
                    },
                ],
            },
        },
    });
    descriptor
}

fn operation(operation: TeamRuntimeOperation, title: &'static str, target_kind: &'static str) -> Value {
    json!({
        "id": operation.id(),
        "title": title,
        "targetKind": target_kind,
        "targetRequired": target_kind != "none",
    })
}
