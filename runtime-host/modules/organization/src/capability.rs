use serde_json::{Value, json};

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
            operation("team.packageValidate", "Validate TeamSkill package", "team"),
            operation("team.dependencyPlan", "Plan TeamSkill dependencies", "team"),
            operation("team.provisionAgents", "Provision Team managed agents", "team"),
            operation("team.delete", "Delete Team", "team"),
            operation("team.runCreate", "Create TeamRun", "team"),
            operation("team.runList", "List TeamRuns", "team"),
            operation("team.triggerList", "List TeamRun armed triggers", "team"),
            operation("team.webhookTriggerFire", "Fire TeamRun webhook trigger by route", "team"),
            operation("team.runSnapshot", "Read TeamRun snapshot", "team-run"),
            operation("team.designStart", "Begin TeamRun workflow design", "team"),
            operation("team.runStart", "Start TeamRun workflow", "team"),
            operation("team.designExit", "Return TeamRun workflow design to discussion", "team"),
            operation("team.designSnapshot", "Read complete TeamRun workflow design", "team"),
            operation("team.designGraphPatch", "Save TeamRun workflow design patch", "team"),
            operation("team.graphSave", "Save TeamRun graph config", "team-run"),
            operation("team.graphPatch", "Submit TeamRun graph patch command", "team-run"),
            operation("team.graphContext", "Read compact TeamRun graph context", "team-run"),
            operation("team.graphExportYaml", "Export TeamRun graph YAML", "team-run"),
            operation("team.graphImportYaml", "Import TeamRun graph YAML", "team-run"),
            operation("team.triggerFire", "Fire TeamRun StartNode trigger", "team-run"),
            operation("team.nodePromptRetryDue", "Read due TeamRun node prompt retry plan", "team-run"),
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

fn operation(id: &'static str, title: &'static str, target_kind: &'static str) -> Value {
    json!({
        "id": id,
        "title": title,
        "targetKind": target_kind,
        "targetRequired": target_kind != "none",
    })
}
