use platform::mcp::{ToolCallOutcome, ToolProvider};
use serde_json::{Map, Value, json};

use super::team_run::TeamRunMcpFacade;

impl ToolProvider for TeamRunMcpFacade {
    fn tools(&self) -> Vec<Value> {
        vec![
            node_event_tool(),
            approval_resolve_tool(),
            graph_patch_tool(),
            graph_context_tool(),
            decision_submit_tool(),
            evidence_record_tool(),
        ]
    }

    fn call(&mut self, name: &str, arguments: &Map<String, Value>) -> Option<ToolCallOutcome> {
        match name {
            "team_graph_context"
            | "team_graph_patch"
            | "team_node_event"
            | "team_approval_resolve"
            | "team_run_decision_submit"
            | "team_evidence_record" => Some(self.call_host(name, arguments)),
            _ => None,
        }
    }
}

fn schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object", "additionalProperties": false,
        "properties": properties, "required": required,
    })
}

fn identifier() -> Value {
    json!({ "type": "string", "minLength": 1 })
}

fn graph_patch_tool() -> Value {
    json!({
        "name": "team_graph_patch",
        "description": "Design the selected TeamRun workflow. Only the current Designing epoch and prompt generation may change a run that has not Started. Read team_graph_context first; preserve its graph version, real role IDs and explicit ports. This does not start execution.",
        "inputSchema": schema(json!({
            "teamId": identifier(), "runId": identifier(),
            "designEpoch": identifier(), "promptGeneration": identifier(),
            "expectedGraphVersion": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
            "commandId": identifier(), "idempotencyKey": identifier(),
            "baseGraphId": identifier(), "baseWorkflowPlanId": identifier(),
            "operations": {
                "type": "array", "minItems": 1,
                "items": { "oneOf": [
                    schema(json!({
                        "op": { "enum": ["add_node", "replace_node"] },
                        "node": node_schema()
                    }), &["op", "node"]),
                    schema(json!({ "op": { "const": "remove_node" }, "nodeId": identifier() }), &["op", "nodeId"]),
                    schema(json!({
                        "op": { "enum": ["add_edge", "replace_edge"] },
                        "edge": edge_schema()
                    }), &["op", "edge"]),
                    schema(json!({ "op": { "const": "remove_edge" }, "edgeId": identifier() }), &["op", "edgeId"]),
                    schema(json!({
                        "op": { "const": "set_node_position" }, "nodeId": identifier(),
                        "position": schema(json!({ "x": { "type": "integer", "minimum": i64::MIN, "maximum": i64::MAX }, "y": { "type": "integer", "minimum": i64::MIN, "maximum": i64::MAX } }), &["x", "y"])
                    }), &["op", "nodeId", "position"]),
                    schema(json!({
                        "op": { "const": "set_metadata" },
                        "metadata": { "type": "object", "minProperties": 1, "additionalProperties": { "oneOf": [{ "type": "string" }, { "type": "boolean" }, { "type": "integer", "minimum": 0, "maximum": u64::MAX }] } }
                    }), &["op", "metadata"])
                ] }
            }
        }), &["teamId", "runId", "designEpoch", "promptGeneration", "expectedGraphVersion", "commandId", "idempotencyKey", "baseGraphId", "baseWorkflowPlanId", "operations"])
    })
}

fn node_schema() -> Value {
    schema(
        json!({
            "nodeId": identifier(), "title": identifier(),
            "kind": { "enum": ["start", "work", "review", "human_decision", "script_review", "join", "end"] },
            "maxAttempts": { "type": "integer", "minimum": 1, "maximum": u32::MAX },
            "taskId": identifier(), "roleId": identifier(),
            "groupId": { "type": ["string", "null"], "minLength": 1 },
            "executor": schema(json!({ "roleId": identifier() }), &["roleId"]),
            "config": schema(json!({
                "prompt": { "type": "string" }, "outputArtifactKind": identifier(),
                "sessionRef": { "type": "string", "minLength": 1, "pattern": "^rs[0-9]+$", "description": "Preserve this role's sessionRef from team_graph_context for the current run. It must exactly match that role's existing binding in this run, never another run; it is a RoleSessionRef rsN slot, not a native session identity." },
                "maxAttempts": { "type": "integer", "minimum": 1, "maximum": u32::MAX },
                "join": schema(json!({
                    "requireCompleted": { "type": "boolean" },
                    "allowFailed": { "type": "boolean" },
                    "retryLimit": { "type": "integer", "minimum": 0, "maximum": u32::MAX }
                }), &["requireCompleted", "allowFailed", "retryLimit"]),
                "trigger": { "oneOf": [
                    schema(json!({ "mode": { "const": "cron" }, "cron": identifier() }), &["mode", "cron"]),
                    schema(json!({ "mode": { "const": "webhook" }, "path": identifier() }), &["mode"])
                ] }
            }), &[])
        }),
        &["nodeId", "title", "kind"],
    )
}

fn edge_schema() -> Value {
    schema(
        json!({
            "edgeId": identifier(), "sourceNodeId": identifier(), "sourcePort": identifier(),
            "targetNodeId": identifier(), "targetPort": identifier(),
            "action": { "enum": ["activate", "rework", "gate", "finish"] },
            "payload": schema(json!({ "includeUpstreamResult": { "type": "boolean" } }), &["includeUpstreamResult"]),
            "dependency": { "oneOf": [
                schema(json!({ "dependencyTaskId": identifier(), "taskId": identifier() }), &["dependencyTaskId", "taskId"]),
                { "type": "null" }
            ] }
        }),
        &[
            "edgeId",
            "sourceNodeId",
            "sourcePort",
            "targetNodeId",
            "targetPort",
            "action",
        ],
    )
}

fn graph_context_tool() -> Value {
    json!({
        "name": "team_graph_context",
        "description": "Read a redacted running TeamRun graph context. To read a full workflow design with title, task prompts, real roles, ports, payloads, layout and version, supply the current designEpoch and promptGeneration. Design access requires Designing; neither query starts execution.",
        "inputSchema": { "type": "object", "oneOf": [
            schema(json!({
                "teamId": identifier(), "runId": identifier(),
                "view": { "enum": ["current_node", "graph_summary"] },
                "nodeExecutionId": { "type": ["string", "null"], "minLength": 1 }
            }), &["teamId", "runId", "view"]),
            schema(json!({
                "teamId": identifier(), "runId": identifier(),
                "designEpoch": identifier(), "promptGeneration": identifier(),
                "view": { "enum": ["current_node", "graph_summary"] },
                "nodeExecutionId": { "type": ["string", "null"], "minLength": 1 }
            }), &["teamId", "runId", "designEpoch", "promptGeneration", "view"])
        ] }
    })
}

fn approval_resolve_tool() -> Value {
    json!({
        "name": "team_approval_resolve",
        "description": "Resolve an existing TeamRun approval receipt.",
        "inputSchema": schema(json!({
            "runId": identifier(), "approvalId": identifier(),
            "decision": { "enum": ["approve", "deny", "abort"] },
            "note": { "type": ["string", "null"], "minLength": 1 },
            "idempotencyKey": identifier()
        }), &["runId", "approvalId", "decision", "idempotencyKey"])
    })
}

fn node_event_tool() -> Value {
    json!({
        "name": "team_node_event",
        "description": "Record a legacy/manual TeamRun node event. Terminal complete/reject events are accepted only as non-scheduler evidence; runtime terminal settle remains the completion path.",
        "inputSchema": { "type": "object", "allOf": [schema(json!({
            "runId": identifier(), "commandId": identifier(), "idempotencyKey": identifier(),
            "nodeExecutionId": identifier(),
            "roleId": { "type": ["string", "null"], "minLength": 1 },
            "event": { "enum": ["progress", "request_input", "request_approval", "complete", "reject"] },
            "approvalAction": { "enum": ["continue_node", "execute_tool", "publish_result", "external_action"] },
            "deliveryId": identifier(), "receipt": identifier(), "nodeId": identifier(),
            "attemptNumber": { "type": "integer", "minimum": 1, "maximum": u32::MAX },
            "summary": { "type": "string", "minLength": 1, "maxLength": 512 },
            "outputPort": identifier()
        }), &["runId", "commandId", "idempotencyKey", "nodeExecutionId", "event"]),
            {
                "if": { "properties": { "event": { "const": "request_approval" } }, "required": ["event"] },
                "then": { "required": ["approvalAction"] }
            },
            {
                "if": { "properties": { "event": { "enum": ["complete", "reject"] } }, "required": ["event"] },
                "then": { "required": ["deliveryId", "receipt", "nodeId", "attemptNumber", "summary", "outputPort"] }
            }
        ] }
    })
}

fn decision_submit_tool() -> Value {
    json!({
        "name": "team_run_decision_submit",
        "description": "Submit a TeamRun continuation decision for a paused run stage.",
        "inputSchema": schema(json!({
            "runId": identifier(), "stageId": { "type": ["string", "null"], "minLength": 1 },
            "decision": { "enum": ["retry", "proceed_degraded", "abort"] },
            "note": { "type": ["string", "null"], "minLength": 1 },
            "idempotencyKey": identifier()
        }), &["runId", "decision", "idempotencyKey"])
    })
}

fn evidence_record_tool() -> Value {
    json!({
        "name": "team_evidence_record",
        "description": "Record an opaque artifact evidence reference for a current TeamRun node execution.",
        "inputSchema": schema(json!({
            "evidenceId": identifier(), "runId": identifier(), "nodeExecutionId": identifier(),
            "referenceKind": { "const": "artifact" }, "reference": identifier(),
            "label": { "type": ["string", "null"], "minLength": 1 }
        }), &["evidenceId", "runId", "nodeExecutionId", "referenceKind", "reference"])
    })
}
