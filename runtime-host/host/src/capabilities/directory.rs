use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

use crate::{
    control::{CommandInput, CommandOutcome, CommandResult, RejectionCode},
    runtime::driver::{RuntimeCapabilityFamily, RuntimeDriverIdentity},
};

const INVALID_INPUT_MESSAGE: &str = "Runtime Host command input is invalid.";
const UNKNOWN_CAPABILITY_MESSAGE: &str = "Capability descriptor is not available.";
const INVALID_SCOPE_MESSAGE: &str = "Capability scope is invalid.";
const SCOPE_NOT_AVAILABLE_MESSAGE: &str = "Capability scope is not available.";

pub(crate) fn list() -> CommandOutcome {
    CommandOutcome::succeeded(CommandResult::public(json!({
        "capabilities": descriptors(),
    })))
}

pub(crate) fn describe(input: CommandInput) -> CommandOutcome {
    let request: DescribeRequest = match decode::<DescribeRequest>(input) {
        Ok(request) if !is_identity_value(&Value::String(request.id.clone())) => {
            return invalid_input();
        }
        Ok(request) => request,
        Err(_) => return invalid_input(),
    };

    if !is_runtime_scope(&request.scope) {
        return CommandOutcome::rejected(RejectionCode::InvalidInput, INVALID_SCOPE_MESSAGE);
    }

    let known = descriptors()
        .into_iter()
        .find(|descriptor| descriptor.get("id") == Some(&Value::String(request.id.clone())));
    let descriptor = match known {
        Some(descriptor) if descriptor.get("scope") == Some(&request.scope) => descriptor,
        Some(_) => match dynamic_descriptor_for_scope(&request.id, &request.scope) {
            Some(descriptor) => descriptor,
            None => {
                return CommandOutcome::rejected(
                    RejectionCode::InvalidInput,
                    SCOPE_NOT_AVAILABLE_MESSAGE,
                );
            }
        },
        None => match dynamic_descriptor_for_scope(&request.id, &request.scope) {
            Some(descriptor) => descriptor,
            None => {
                return CommandOutcome::rejected(
                    RejectionCode::InvalidInput,
                    UNKNOWN_CAPABILITY_MESSAGE,
                );
            }
        },
    };
    if !capability_supported_for_scope(&request.id, &request.scope) {
        return CommandOutcome::rejected(RejectionCode::InvalidInput, SCOPE_NOT_AVAILABLE_MESSAGE);
    }

    CommandOutcome::succeeded(CommandResult::public(json!({
        "capability": descriptor
    })))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DescribeRequest {
    id: String,
    scope: Value,
}

fn decode<T: DeserializeOwned>(input: CommandInput) -> Result<T, ()> {
    serde_json::from_value(input.into_value()).map_err(|_| ())
}

fn invalid_input() -> CommandOutcome {
    CommandOutcome::rejected(RejectionCode::InvalidInput, INVALID_INPUT_MESSAGE)
}

fn descriptors() -> Vec<Value> {
    let mut descriptors = vec![
        plugin_runtime(),
        provider_routing(),
        scheduler_cron(),
        skill_management(),
        integration_channel(),
        openclaw_browser(),
        openclaw_mcp_app(),
        subagent_skills(),
        subagent_tools(),
        subagent_management(),
        team_runtime(),
    ];
    descriptors.sort_by(|left, right| {
        left.get("id")
            .and_then(Value::as_str)
            .cmp(&right.get("id").and_then(Value::as_str))
    });
    descriptors
}

fn dynamic_descriptor_for_scope(id: &str, scope: &Value) -> Option<Value> {
    match (id, scope.get("kind").and_then(Value::as_str)) {
        ("session.prompt", Some("agent")) => Some(scoped_descriptor(
            "session.prompt",
            "session",
            scope.clone(),
            vec![operation("sessions.create", "Create session", "agent")],
        )),
        ("session.prompt", Some("session")) => Some(scoped_descriptor(
            "session.prompt",
            "session",
            scope.clone(),
            vec![
                operation("sessions.prompt", "Prompt session", "session"),
                operation(
                    "sessions.sendWithMedia",
                    "Send session prompt with media",
                    "session",
                ),
                operation("sessions.abort", "Abort session", "session"),
                operation("sessions.load", "Load session", "session"),
            ],
        )),
        ("session.management", Some("runtime-instance")) => Some(scoped_descriptor(
            "session.management",
            "session-management",
            scope.clone(),
            vec![operation(
                "sessions.list",
                "List sessions",
                "runtime-endpoint",
            )],
        )),
        ("session.management", Some("session")) => Some(scoped_descriptor(
            "session.management",
            "session-management",
            scope.clone(),
            vec![
                operation("sessions.window", "Get session window", "session"),
                operation("sessions.content.load", "Load session content", "session"),
                operation("sessions.delete", "Delete session", "session"),
                operation("sessions.rename", "Rename session", "session"),
                operation("sessions.archive", "Archive session", "session"),
                operation("sessions.unarchive", "Unarchive session", "session"),
                operation("sessions.updateStatus", "Update session status", "session"),
                operation("sessions.switch", "Switch session", "session"),
                operation("sessions.resume", "Resume session", "session"),
                operation("sessions.state", "Get session state", "session"),
                operation("sessions.load", "Load session", "session"),
            ],
        )),
        ("session.approval", Some("session")) => Some(scoped_descriptor(
            "session.approval",
            "session-approval",
            scope.clone(),
            vec![
                operation("approvals.list", "List approvals", "session"),
                operation("approvals.resolve", "Resolve approval", "approval"),
            ],
        )),
        ("session.modelSelection", Some("session")) => Some(scoped_descriptor(
            "session.modelSelection",
            "session-model-selection",
            scope.clone(),
            vec![operation(
                "sessions.patchModel",
                "Patch session model",
                "model-selection",
            )],
        )),
        ("tool.invoke", Some("session")) => Some(scoped_descriptor(
            "tool.invoke",
            "tool",
            scope.clone(),
            vec![operation("tools.invoke", "Invoke tool", "tool")],
        )),
        ("task.management", Some("session")) => runtime_identity_for_scope(scope)
            .map(|identity| task_management_descriptor(scope.clone(), identity)),
        ("team.runtime", Some("runtime-instance")) => {
            let identity = runtime_identity_for_scope(scope)?;
            identity
                .capability_surface()
                .supports(RuntimeCapabilityFamily::Team)
                .then(|| team_runtime_descriptor(scope.clone(), identity))
        }
        ("workspace.file", Some("session")) => Some(scoped_descriptor(
            "workspace.file",
            "workspace-file",
            scope.clone(),
            vec![
                operation(
                    "files.readText",
                    "Read workspace text file",
                    "workspace-file",
                ),
                operation(
                    "files.listDir",
                    "List workspace directory",
                    "workspace-file",
                ),
                operation(
                    "files.readBinary",
                    "Read workspace binary file",
                    "workspace-file",
                ),
                operation("files.stat", "Stat workspace file", "workspace-file"),
                operation(
                    "files.writeText",
                    "Write workspace text file",
                    "workspace-file",
                ),
            ],
        )),
        ("workspace.media", Some("session")) => Some(scoped_descriptor(
            "workspace.media",
            "workspace-media",
            scope.clone(),
            vec![
                operation(
                    "media.prepare",
                    "Prepare workspace media",
                    "workspace-media",
                ),
                operation(
                    "media.resolve",
                    "Resolve workspace media",
                    "workspace-media",
                ),
                operation(
                    "media.thumbnail",
                    "Read workspace media thumbnail",
                    "workspace-media",
                ),
                operation(
                    "media.thumbnails",
                    "Read workspace media thumbnails",
                    "workspace-media",
                ),
                operation(
                    "media.stagePaths",
                    "Stage workspace media files",
                    "workspace-media",
                ),
                operation(
                    "media.stageBuffer",
                    "Stage workspace media buffer",
                    "workspace-media",
                ),
            ],
        )),
        _ => None,
    }
}

fn subagent_skills() -> Value {
    json!({
        "id": "subagent.skills",
        "kind": "subagent-skills",
        "scopeKind": "agent",
        "scope": native_agent_scope("main"),
        "targetKinds": ["subagent"],
        "runtimeAdapterId": "openclaw",
        "runtimeInstanceId": "local",
        "targetAgentIds": ["main"],
        "supportLevel": "native",
        "availability": "available",
        "operations": [
            operation("subagentSkills.get", "Get subagent skills", "subagent"),
            operation("subagentSkills.set", "Set subagent skills", "subagent"),
        ],
        "policyScope": "subagent.skills",
        "ownerModuleId": "agent",
        "routeOwnerId": "openclaw",
    })
}

fn subagent_tools() -> Value {
    json!({
        "id": "subagent.tools",
        "kind": "subagent-tools",
        "scopeKind": "agent",
        "scope": native_agent_scope("main"),
        "targetKinds": ["subagent"],
        "runtimeAdapterId": "openclaw",
        "runtimeInstanceId": "local",
        "targetAgentIds": ["main"],
        "supportLevel": "native",
        "availability": "available",
        "operations": [
            operation("subagentTools.get", "Get subagent tools", "subagent"),
            operation("subagentTools.set", "Set subagent tools", "subagent"),
        ],
        "policyScope": "subagent.tools",
        "ownerModuleId": "agent",
        "routeOwnerId": "openclaw",
    })
}

fn subagent_management() -> Value {
    json!({
        "id": "subagent.management",
        "kind": "subagent-management",
        "scopeKind": "agent",
        "scope": native_agent_scope("main"),
        "targetKinds": ["agent", "subagent"],
        "runtimeAdapterId": "openclaw",
        "runtimeInstanceId": "local",
        "targetAgentIds": ["main"],
        "supportLevel": "native",
        "availability": "available",
        "operations": [
            operation("subagents.list", "List subagents", "agent"),
            operation("subagents.displayConfig.get", "Get subagent display configuration", "agent"),
            operation("subagents.description.set", "Set subagent description", "subagent"),
            operation("subagents.model.set", "Set subagent model", "subagent"),
            operation("subagents.skills.set", "Set subagent skills", "subagent"),
            operation("subagents.draft.wait", "Wait for subagent draft", "subagent"),
            operation("subagents.create", "Create subagent", "subagent"),
            operation("subagents.update", "Update subagent", "subagent"),
            operation("subagents.delete", "Delete subagent", "subagent"),
            operation("subagents.files.get", "Get subagent file", "subagent"),
            operation("subagents.files.set", "Set subagent file", "subagent"),
            operation("subagents.files.list", "List subagent files", "subagent"),
        ],
        "policyScope": "subagent.management",
        "ownerModuleId": "agent",
        "routeOwnerId": "openclaw",
    })
}

fn skill_management() -> Value {
    json!({
        "id": "skill.management",
        "kind": "skill-management",
        "scopeKind": "runtime-instance",
        "scope": native_runtime_instance_scope(),
        "targetKinds": ["none", "skill", "skill-bundle"],
        "runtimeAdapterId": "openclaw",
        "runtimeInstanceId": "local",
        "supportLevel": "native",
        "availability": "available",
        "operations": [
            operation("skills.refreshStatus", "Refresh skill status", "none"),
            operation("skills.updateConfig", "Update skill configuration", "skill"),
            operation("skills.updateState", "Update skill state", "skill"),
            operation("skills.updateBatchState", "Update skill state batch", "skill"),
            operation("skills.exportBundles", "Export skill bundles", "skill-bundle"),
            operation("skills.importBundles", "Import skill bundles", "skill-bundle"),
            operation("clawhub.openReadme", "Open skill readme", "skill"),
            operation("clawhub.openPath", "Open skill location", "skill"),
        ],
        "policyScope": "skill.management",
        "ownerModuleId": "skills",
        "routeOwnerId": "openclaw",
    })
}

fn plugin_runtime() -> Value {
    json!({
        "id": "plugin.runtime",
        "kind": "plugin-runtime",
        "scopeKind": "runtime-instance",
        "scope": native_runtime_instance_scope(),
        "targetKinds": ["plugin"],
        "runtimeAdapterId": "openclaw",
        "runtimeInstanceId": "local",
        "supportLevel": "native",
        "availability": "available",
        "operations": [
            operation("plugins.setEnabled", "Set runtime plugin enabled state", "plugin"),
        ],
        "policyScope": "plugin.runtime",
        "ownerModuleId": "plugins",
        "routeOwnerId": "openclaw",
    })
}

fn provider_routing() -> Value {
    json!({
        "id": "provider.routing",
        "kind": "provider-routing",
        "scopeKind": "provider-routing",
        "scope": { "kind": "provider-routing" },
        "targetKinds": ["provider-routing"],
        "runtimeAdapterId": "openclaw",
        "runtimeInstanceId": "local",
        "supportLevel": "native",
        "availability": "available",
        "operations": [
            operation("providerRouting.list", "List provider routing", "provider-routing"),
            operation("providerRouting.replace", "Replace provider routing", "provider-routing"),
        ],
        "policyScope": "provider.routing",
        "ownerModuleId": "environment",
        "routeOwnerId": "provider-routing",
    })
}

fn team_runtime() -> Value {
    team_runtime_descriptor(
        native_runtime_instance_scope(),
        RuntimeDriverIdentity::open_claw(),
    )
}

fn task_management_descriptor(scope: Value, identity: RuntimeDriverIdentity) -> Value {
    json!({
        "id": "task.management",
        "kind": "task-management",
        "scopeKind": "session",
        "scope": scope,
        "targetKinds": ["task-manager"],
        "runtimeAdapterId": identity.runtime_adapter_id(),
        "runtimeInstanceId": identity.runtime_instance_id(),
        "supportLevel": "native",
        "availability": "available",
        "operations": [
            operation("tasks.list", "List tasks", "task-manager"),
            operation("tasks.get", "Get task", "task-manager"),
            operation("tasks.create", "Create task", "task-manager"),
            operation("tasks.update", "Update task", "task-manager"),
            operation("todos.get", "Get todos", "task-manager"),
            operation("todos.write", "Write todos", "task-manager"),
        ],
        "policyScope": "task.management",
        "ownerModuleId": "task-management",
        "routeOwnerId": identity.runtime_adapter_id(),
    })
}

fn team_runtime_descriptor(scope: Value, identity: RuntimeDriverIdentity) -> Value {
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
            operation("team.packageValidate", "Validate TeamSkill package", "team"),
            operation("team.dependencyPlan", "Plan TeamSkill dependencies", "team"),
            operation("team.provisionAgents", "Provision Team managed agents", "team"),
            operation("team.delete", "Delete Team", "team"),
            operation("team.runCreate", "Create TeamRun", "team"),
            operation("team.runList", "List TeamRuns", "team"),
            operation("team.triggerList", "List TeamRun armed triggers", "team"),
            operation("team.webhookTriggerFire", "Fire TeamRun webhook trigger by route", "team"),
            operation("team.runSnapshot", "Read TeamRun snapshot", "team-run"),
            operation("team.graphSave", "Save TeamRun graph config", "team-run"),
            operation("team.graphPatch", "Submit TeamRun graph patch command", "team-run"),
            operation("team.graphContext", "Read compact TeamRun graph context", "team-run"),
            operation("team.graphExportYaml", "Export TeamRun graph YAML", "team-run"),
            operation("team.graphImportYaml", "Import TeamRun graph YAML", "team-run"),
            operation("team.triggerFire", "Fire TeamRun StartNode trigger", "team-run"),
            operation("team.roleMessageSubmit", "Submit Team role chat message", "team-run"),
            operation("team.nodePromptRetryDue", "Read due TeamRun node prompt retry plan", "team-run"),
            operation("team.nodePromptSettled", "Wake TeamRun after a node prompt session turn settles", "none"),
            operation("team.nodeEvent", "Submit TeamRun node event command", "team-run"),
            operation("team.runDiagnostics", "Read TeamRun diagnostics", "team-run"),
            operation("team.runDecisionSubmit", "Submit TeamRun decision", "team-run"),
            operation("team.resume", "Resume Team", "team"),
            operation("team.approvalResolve", "Resolve Team approval", "team-approval"),
            operation("team.runCancel", "Cancel TeamRun", "team-run"),
            operation("team.runDelete", "Delete TeamRun", "team-run"),
        ],
        "policyScope": "team.runtime",
        "ownerModuleId": "organization",
        "routeOwnerId": "team-runtime",
    })
}

fn scheduler_cron() -> Value {
    let scope = native_runtime_instance_scope();
    json!({
        "id": "scheduler.cron",
        "kind": "scheduler-cron",
        "scopeKind": "runtime-instance",
        "scope": scope,
        "targetKinds": ["cron-job"],
        "runtimeAdapterId": "openclaw",
        "runtimeInstanceId": "local",
        "supportLevel": "native",
        "availability": "available",
        "operations": [
            operation("cron.trigger", "Trigger cron job", "cron-job"),
            operation("cron.create", "Create cron job", "cron-job"),
            operation("cron.update", "Update cron job", "cron-job"),
            operation("cron.delete", "Delete cron job", "cron-job"),
            operation("cron.toggle", "Toggle cron job", "cron-job"),
        ],
        "policyScope": "scheduler.cron",
        "ownerModuleId": "scheduler",
        "routeOwnerId": "operations",
    })
}

fn integration_channel() -> Value {
    json!({
        "id": "integration.channel",
        "kind": "integration-channel",
        "scopeKind": "runtime-instance",
        "scope": native_runtime_instance_scope(),
        "targetKinds": ["channel", "channel-account", "channel-config", "channel-credentials", "channel-login", "channel-pairing", "channel-status", "channel-snapshot"],
        "runtimeAdapterId": "openclaw",
        "runtimeInstanceId": "local",
        "supportLevel": "native",
        "availability": "available",
        "operations": [
            operation("channels.catalog.read", "Read channel catalog", "channel"),
            operation("channels.configure", "Configure channel account", "channel-config"),
            operation("channels.config.read", "Read channel configuration", "channel-config"),
            operation("channels.credentials.validate", "Validate channel credentials", "channel-credentials"),
            operation("channels.config.delete", "Delete channel configuration", "channel-config"),
            operation("channels.runtime.control", "Control channel account", "channel-account"),
            operation("channels.login", "Start channel login", "channel-login"),
            operation("channels.pairing.list", "List channel pairings", "channel-pairing"),
            operation("channels.pairing.approve", "Approve channel pairing", "channel-pairing"),
            operation("channels.status.read", "Read channel account status", "channel-status"),
            operation("channels.snapshot.read", "Read channel snapshot", "channel-snapshot"),
        ],
        "policyScope": "integration.channel",
        "ownerModuleId": "integration",
        "routeOwnerId": "openclaw",
    })
}

fn openclaw_browser() -> Value {
    json!({
        "id": "openclaw.browser",
        "kind": "openclaw-browser",
        "scopeKind": "runtime-instance",
        "scope": native_runtime_instance_scope(),
        "targetKinds": ["none"],
        "runtimeAdapterId": "openclaw",
        "runtimeInstanceId": "local",
        "supportLevel": "native",
        "availability": "available",
        "operations": [
            operation("browser.request", "Request Browser runtime", "none"),
        ],
        "policyScope": "openclaw.browser",
        "ownerModuleId": "openclaw-gateway",
        "routeOwnerId": "openclaw",
    })
}

fn openclaw_mcp_app() -> Value {
    json!({
        "id": "openclaw.mcpApp",
        "kind": "openclaw-mcp-app",
        "scopeKind": "runtime-instance",
        "scope": native_runtime_instance_scope(),
        "targetKinds": ["none"],
        "runtimeAdapterId": "openclaw",
        "runtimeInstanceId": "local",
        "supportLevel": "native",
        "availability": "available",
        "operations": [
            operation("mcp.app.*", "Request MCP app view", "none"),
        ],
        "policyScope": "openclaw.mcpApp",
        "ownerModuleId": "openclaw-gateway",
        "routeOwnerId": "openclaw",
    })
}

fn operation(id: &'static str, title: &'static str, target_kind: &'static str) -> Value {
    json!({
        "id": id,
        "title": title,
        "targetKind": target_kind,
        "targetRequired": target_kind != "none",
    })
}

fn scoped_descriptor(id: &str, kind: &str, scope: Value, operations: Vec<Value>) -> Value {
    json!({
        "id": id,
        "kind": kind,
        "scopeKind": scope.get("kind").and_then(Value::as_str).unwrap_or("unknown"),
        "scope": scope,
        "targetKinds": target_kinds(&operations),
        "runtimeAdapterId": "openclaw",
        "runtimeInstanceId": "local",
        "supportLevel": "native",
        "availability": "available",
        "operations": operations,
        "policyScope": id,
        "ownerModuleId": kind,
        "routeOwnerId": "openclaw",
    })
}

fn target_kinds(operations: &[Value]) -> Vec<&str> {
    let mut kinds = operations
        .iter()
        .filter_map(|operation| operation.get("targetKind").and_then(Value::as_str))
        .collect::<Vec<_>>();
    kinds.sort_unstable();
    kinds.dedup();
    kinds
}

fn native_endpoint() -> Value {
    native_endpoint_for(RuntimeDriverIdentity::open_claw())
}

fn native_endpoint_for(identity: RuntimeDriverIdentity) -> Value {
    json!({
        "kind": "native-runtime",
        "runtimeAdapterId": identity.runtime_adapter_id(),
        "runtimeInstanceId": identity.runtime_instance_id(),
    })
}

fn native_runtime_instance_scope() -> Value {
    json!({
        "kind": "runtime-instance",
        "endpoint": native_endpoint(),
    })
}

fn native_agent_scope(agent_id: &str) -> Value {
    json!({
        "kind": "agent",
        "endpoint": native_endpoint(),
        "agentId": agent_id,
    })
}

fn is_runtime_scope(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let Some(kind) = object.get("kind").and_then(Value::as_str) else {
        return false;
    };
    match kind {
        "app" | "provider-routing" => has_exact_keys(object, &["kind"]),
        "runtime-instance" => {
            has_exact_keys(object, &["kind", "endpoint"])
                && object.get("endpoint").is_some_and(is_runtime_endpoint)
        }
        "agent" => {
            has_exact_keys(object, &["kind", "endpoint", "agentId"])
                && object.get("endpoint").is_some_and(is_runtime_endpoint)
                && object.get("agentId").is_some_and(is_identity_value)
        }
        "session" => {
            has_exact_keys(object, &["kind", "identity"])
                && object.get("identity").is_some_and(is_session_identity)
        }
        "workspace" => {
            has_only_keys(object, &["kind", "endpoint", "workspaceId", "sourceId"])
                && object.get("endpoint").is_some_and(is_runtime_endpoint)
                && optional_identity(object, "workspaceId")
                && optional_identity(object, "sourceId")
        }
        "team-run" => {
            has_only_keys(object, &["kind", "endpoint", "runId", "teamId"])
                && object.get("endpoint").is_some_and(is_runtime_endpoint)
                && object.get("runId").is_some_and(is_identity_value)
                && optional_identity(object, "teamId")
        }
        _ => false,
    }
}

fn capability_supported_for_scope(id: &str, scope: &Value) -> bool {
    let Some(identity) = runtime_identity_for_scope(scope) else {
        return true;
    };
    identity
        .capability_surface()
        .availability_for_descriptor(id)
        .is_none_or(|availability| availability.is_supported())
}

fn runtime_identity_for_scope(scope: &Value) -> Option<RuntimeDriverIdentity> {
    match scope.get("kind").and_then(Value::as_str)? {
        "runtime-instance" | "agent" | "workspace" | "team-run" => {
            runtime_identity_for_endpoint(scope.get("endpoint")?)
        }
        "session" => runtime_identity_for_endpoint(scope.get("identity")?.get("endpoint")?),
        _ => None,
    }
}

fn runtime_identity_for_endpoint(endpoint: &Value) -> Option<RuntimeDriverIdentity> {
    let object = endpoint.as_object()?;
    if object.get("kind").and_then(Value::as_str)? != "native-runtime" {
        return None;
    }
    let adapter = object.get("runtimeAdapterId").and_then(Value::as_str)?;
    let instance = object.get("runtimeInstanceId").and_then(Value::as_str)?;
    for identity in [
        RuntimeDriverIdentity::open_claw(),
        RuntimeDriverIdentity::matcha_agent(),
    ] {
        if adapter == identity.runtime_adapter_id() && instance == identity.runtime_instance_id() {
            return Some(identity);
        }
    }
    None
}

fn is_runtime_endpoint(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    match object.get("kind").and_then(Value::as_str) {
        Some("native-runtime") => {
            has_exact_keys(object, &["kind", "runtimeAdapterId", "runtimeInstanceId"])
                && object
                    .get("runtimeAdapterId")
                    .is_some_and(is_identity_value)
                && object
                    .get("runtimeInstanceId")
                    .is_some_and(is_identity_value)
        }
        Some("protocol-connector") => {
            has_exact_keys(object, &["kind", "protocolId", "connectorId", "endpointId"])
                && object.get("protocolId").is_some_and(is_identity_value)
                && object.get("connectorId").is_some_and(is_identity_value)
                && object.get("endpointId").is_some_and(is_identity_value)
        }
        _ => false,
    }
}

fn is_session_identity(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    has_exact_keys(object, &["endpoint", "agentId", "sessionKey"])
        && object.get("endpoint").is_some_and(is_runtime_endpoint)
        && object.get("agentId").is_some_and(is_identity_value)
        && object.get("sessionKey").is_some_and(is_identity_value)
}

fn optional_identity(object: &Map<String, Value>, key: &str) -> bool {
    object.get(key).is_none_or(is_identity_value)
}

fn is_identity_value(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|value| !value.trim().is_empty() && !value.contains('\0'))
}

fn has_exact_keys(object: &Map<String, Value>, expected: &[&str]) -> bool {
    object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key))
}

fn has_only_keys(object: &Map<String, Value>, allowed: &[&str]) -> bool {
    object.keys().all(|key| allowed.contains(&key.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::to_value;

    #[test]
    fn list_is_complete_sorted_and_public_safe() {
        let outcome = to_value(list()).unwrap();
        assert_eq!(
            outcome["result"]["capabilities"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec![
                "integration.channel",
                "openclaw.browser",
                "openclaw.mcpApp",
                "plugin.runtime",
                "provider.routing",
                "scheduler.cron",
                "skill.management",
                "subagent.management",
                "subagent.skills",
                "subagent.tools",
                "team.runtime",
            ]
        );
        let browser = &outcome["result"]["capabilities"][1];
        assert_eq!(browser["kind"], "openclaw-browser");
        assert_eq!(browser["operations"][0]["id"], "browser.request");
        let mcp_app = &outcome["result"]["capabilities"][2];
        assert_eq!(mcp_app["kind"], "openclaw-mcp-app");
        assert_eq!(mcp_app["operations"][0]["id"], "mcp.app.*");
        let skill_config = &outcome["result"]["capabilities"][8];
        assert_eq!(skill_config["kind"], "subagent-skills");
        assert_eq!(skill_config["scopeKind"], "agent");
        assert_eq!(skill_config["scope"]["agentId"], "main");
        assert_eq!(skill_config["targetKinds"], json!(["subagent"]));
        assert_eq!(skill_config["operations"].as_array().unwrap().len(), 2);
        assert_eq!(skill_config["operations"][0]["id"], "subagentSkills.get");
        assert_eq!(skill_config["operations"][1]["id"], "subagentSkills.set");
        let tool_config = &outcome["result"]["capabilities"][9];
        assert_eq!(tool_config["kind"], "subagent-tools");
        assert_eq!(tool_config["scopeKind"], "agent");
        assert_eq!(tool_config["scope"]["agentId"], "main");
        assert_eq!(tool_config["targetKinds"], json!(["subagent"]));
        assert_eq!(tool_config["operations"].as_array().unwrap().len(), 2);
        assert_eq!(tool_config["operations"][0]["id"], "subagentTools.get");
        assert_eq!(tool_config["operations"][1]["id"], "subagentTools.set");
        let channel = &outcome["result"]["capabilities"][0];
        assert_eq!(channel["kind"], "integration-channel");
        assert_eq!(channel["operations"].as_array().unwrap().len(), 11);
        assert_eq!(channel["operations"][0]["id"], "channels.catalog.read");
        assert_eq!(channel["operations"][10]["id"], "channels.snapshot.read");
        let scheduler_cron = &outcome["result"]["capabilities"][5];
        assert_eq!(scheduler_cron["kind"], "scheduler-cron");
        assert_eq!(scheduler_cron["supportLevel"], "native");
        assert_eq!(scheduler_cron["operations"].as_array().unwrap().len(), 5);
        assert_eq!(scheduler_cron["operations"][0]["id"], "cron.trigger");
        assert_eq!(scheduler_cron["operations"][4]["id"], "cron.toggle");
        let subagent = &outcome["result"]["capabilities"][7];
        assert_eq!(subagent["kind"], "subagent-management");
        assert_eq!(subagent["scopeKind"], "agent");
        assert_eq!(subagent["scope"]["agentId"], "main");
        assert_eq!(subagent["targetKinds"], json!(["agent", "subagent"]));
        assert_eq!(subagent["supportLevel"], "native");
        assert_eq!(subagent["operations"].as_array().unwrap().len(), 12);
        assert_eq!(
            subagent["operations"][0],
            json!({
                "id": "subagents.list",
                "title": "List subagents",
                "targetKind": "agent",
                "targetRequired": true,
            })
        );
        assert_eq!(
            subagent["operations"][1],
            json!({
                "id": "subagents.displayConfig.get",
                "title": "Get subagent display configuration",
                "targetKind": "agent",
                "targetRequired": true,
            })
        );
        let team = &outcome["result"]["capabilities"][10];
        assert_eq!(team["kind"], "team-runtime");
        assert_eq!(team["supportLevel"], "native");
        let settled = team["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|operation| operation["id"] == "team.nodePromptSettled")
            .unwrap();
        assert_eq!(settled["targetKind"], "none");
        assert_eq!(settled["targetRequired"], false);
        let retry_due = team["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|operation| operation["id"] == "team.nodePromptRetryDue")
            .unwrap();
        assert_eq!(
            retry_due["title"],
            "Read due TeamRun node prompt retry plan"
        );
        for private in [
            "token",
            "secret",
            "pid",
            "argv",
            "path",
            "sessionKey",
            "rawPayload",
        ] {
            assert!(!contains_key(&outcome, private), "private={private}");
        }
    }

    fn contains_key(value: &Value, key: &str) -> bool {
        match value {
            Value::Object(object) => object
                .iter()
                .any(|(name, value)| name == key || contains_key(value, key)),
            Value::Array(values) => values.iter().any(|value| contains_key(value, key)),
            _ => false,
        }
    }

    #[test]
    fn describe_requires_exact_id_and_scope() {
        let request = CommandInput(json!({
            "id": "scheduler.cron",
            "scope": native_runtime_instance_scope(),
        }));
        let outcome = to_value(describe(request)).unwrap();
        assert_eq!(outcome["kind"], "succeeded");
        assert_eq!(outcome["result"]["capability"]["id"], "scheduler.cron");
        assert_eq!(
            outcome["result"]["capability"]["operations"]
                .as_array()
                .unwrap()
                .len(),
            5
        );

        for (id, operation_id, title, target_kind, scope) in [
            (
                "openclaw.browser",
                "browser.request",
                "Request Browser runtime",
                "none",
                native_runtime_instance_scope(),
            ),
            (
                "openclaw.mcpApp",
                "mcp.app.*",
                "Request MCP app view",
                "none",
                native_runtime_instance_scope(),
            ),
            (
                "subagent.skills",
                "subagentSkills.get",
                "Get subagent skills",
                "subagent",
                native_agent_scope("main"),
            ),
            (
                "subagent.tools",
                "subagentTools.get",
                "Get subagent tools",
                "subagent",
                native_agent_scope("main"),
            ),
        ] {
            let described = to_value(describe(CommandInput(json!({
                "id": id,
                "scope": scope,
            }))))
            .unwrap();
            assert_eq!(described["kind"], "succeeded");
            assert_eq!(described["result"]["capability"]["id"], id);
            assert_eq!(
                described["result"]["capability"]["operations"][0],
                json!({
                    "id": operation_id,
                    "title": title,
                    "targetKind": target_kind,
                    "targetRequired": target_kind != "none",
                })
            );
        }

        let unknown = to_value(describe(CommandInput(json!({
            "id": "unknown.capability",
            "scope": native_runtime_instance_scope(),
        }))))
        .unwrap();
        assert_eq!(unknown["error"]["code"], "INVALID_INPUT");
        assert_eq!(unknown["error"]["message"], UNKNOWN_CAPABILITY_MESSAGE);

        let wrong_scope = to_value(describe(CommandInput(json!({
            "id": "scheduler.cron",
            "scope": native_agent_scope("main"),
        }))))
        .unwrap();
        assert_eq!(wrong_scope["error"]["message"], SCOPE_NOT_AVAILABLE_MESSAGE);
    }

    #[test]
    fn describe_gates_runtime_family_descriptors_by_surface() {
        let matcha_runtime = json!({
            "kind": "runtime-instance",
            "endpoint": native_endpoint_for(RuntimeDriverIdentity::matcha_agent()),
        });
        let session = to_value(describe(CommandInput(json!({
            "id": "session.management",
            "scope": matcha_runtime.clone(),
        }))))
        .unwrap();
        assert_eq!(session["kind"], "succeeded");
        assert_eq!(session["result"]["capability"]["id"], "session.management");

        let team = to_value(describe(CommandInput(json!({
            "id": "team.runtime",
            "scope": matcha_runtime,
        }))))
        .unwrap();
        assert_eq!(team["kind"], "succeeded");
        assert_eq!(team["result"]["capability"]["id"], "team.runtime");
        assert_eq!(
            team["result"]["capability"]["runtimeAdapterId"],
            "matcha-agent"
        );

        let workspace_file = to_value(describe(CommandInput(json!({
            "id": "workspace.file",
            "scope": {
                "kind": "session",
                "identity": {
                    "endpoint": native_endpoint(),
                    "agentId": "main",
                    "sessionKey": "agent:main:session-1",
                },
            },
        }))))
        .unwrap();
        assert_eq!(workspace_file["kind"], "succeeded");
        assert_eq!(
            workspace_file["result"]["capability"]["id"],
            "workspace.file"
        );
        assert_eq!(
            workspace_file["result"]["capability"]["operations"]
                .as_array()
                .unwrap()
                .iter()
                .map(|operation| operation["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec![
                "files.readText",
                "files.listDir",
                "files.readBinary",
                "files.stat",
                "files.writeText",
            ]
        );

        let openclaw_task = to_value(describe(CommandInput(json!({
            "id": "task.management",
            "scope": {
                "kind": "session",
                "identity": {
                    "endpoint": native_endpoint(),
                    "agentId": "main",
                    "sessionKey": "agent:main:session-1",
                },
            },
        }))))
        .unwrap();
        assert_eq!(openclaw_task["kind"], "succeeded");
        assert_eq!(
            openclaw_task["result"]["capability"]["runtimeAdapterId"],
            "openclaw"
        );

        let matcha_task = to_value(describe(CommandInput(json!({
            "id": "task.management",
            "scope": {
                "kind": "session",
                "identity": {
                    "endpoint": native_endpoint_for(RuntimeDriverIdentity::matcha_agent()),
                    "agentId": "matcha",
                    "sessionKey": "matcha-session",
                },
            },
        }))))
        .unwrap();
        assert_eq!(matcha_task["error"]["message"], SCOPE_NOT_AVAILABLE_MESSAGE);

        let cron = to_value(describe(CommandInput(json!({
            "id": "scheduler.cron",
            "scope": {
                "kind": "runtime-instance",
                "endpoint": native_endpoint_for(RuntimeDriverIdentity::matcha_agent()),
            },
        }))))
        .unwrap();
        assert_eq!(cron["error"]["message"], SCOPE_NOT_AVAILABLE_MESSAGE);
    }

    #[test]
    fn describe_rejects_invalid_and_unknown_scope_fields() {
        for scope in [
            json!({ "kind": "runtime-instance", "endpoint": {} }),
            json!({
                "kind": "runtime-instance",
                "endpoint": native_endpoint(),
                "private": "must-not-pass",
            }),
            json!({
                "kind": "workspace",
                "endpoint": native_endpoint(),
                "workspaceId": null,
            }),
        ] {
            let outcome = to_value(describe(CommandInput(json!({
                "id": "scheduler.cron",
                "scope": scope,
            }))))
            .unwrap();
            assert_eq!(outcome["error"]["code"], "INVALID_INPUT");
            assert_eq!(outcome["error"]["message"], INVALID_SCOPE_MESSAGE);
        }

        let unknown_request_field = to_value(describe(CommandInput(json!({
            "id": "scheduler.cron",
            "scope": native_runtime_instance_scope(),
            "unexpected": true,
        }))))
        .unwrap();
        assert_eq!(unknown_request_field["error"]["code"], "INVALID_INPUT");
        assert_eq!(
            unknown_request_field["error"]["message"],
            INVALID_INPUT_MESSAGE
        );
    }
}
