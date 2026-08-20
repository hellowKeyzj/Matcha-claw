use std::num::NonZeroU32;

use organization::{
    EdgeAction, EdgeDefinition, EdgeId, GraphPatchOperation, NodeDefinition, NodeId, NodeKind,
    WorkAssignment,
};
use serde_json::{Map, Value};

pub(crate) fn strict_object(value: Option<&Value>) -> Result<&Map<String, Value>, ()> {
    value.and_then(Value::as_object).ok_or(())
}

pub(crate) fn require_exact_keys(object: &Map<String, Value>, allowed: &[&str]) -> Result<(), ()> {
    object
        .keys()
        .all(|key| allowed.contains(&key.as_str()))
        .then_some(())
        .ok_or(())
}

pub(crate) fn require_required_keys(
    object: &Map<String, Value>,
    required: &[&str],
) -> Result<(), ()> {
    required
        .iter()
        .all(|key| object.contains_key(*key))
        .then_some(())
        .ok_or(())
}

pub(crate) fn required_string<'a>(
    object: &'a Map<String, Value>,
    key: &str,
) -> Result<&'a str, ()> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(())
}

pub(crate) fn optional_string(
    object: &Map<String, Value>,
    key: &str,
) -> Result<Option<String>, ()> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.is_empty() => Ok(Some(value.clone())),
        _ => Err(()),
    }
}

pub(crate) fn array<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a Vec<Value>, ()> {
    object
        .get(key)
        .and_then(Value::as_array)
        .filter(|values| !values.is_empty())
        .ok_or(())
}

pub(crate) fn parse_graph_patch_operation(value: &Value) -> Result<GraphPatchOperation, ()> {
    let object = value.as_object().ok_or(())?;
    let op = required_string(object, "op")?;
    match op {
        "add_node" | "replace_node" => {
            require_exact_keys(object, &["op", "nodeId", "kind", "roleId"])?;
            let node_id = NodeId::new(required_string(object, "nodeId")?);
            let kind = node_kind(required_string(object, "kind")?)?;
            let node = match kind {
                NodeKind::Work => NodeDefinition::work(
                    node_id,
                    "mcp-work",
                    NonZeroU32::new(1).expect("one is non-zero"),
                    WorkAssignment::new("mcp-task", optional_string(object, "roleId")?.ok_or(())?),
                ),
                NodeKind::Start => NodeDefinition::start(
                    node_id,
                    "mcp-start",
                    NonZeroU32::new(1).expect("one is non-zero"),
                    None,
                ),
                kind => NodeDefinition::control(
                    node_id,
                    kind,
                    "mcp-control",
                    NonZeroU32::new(1).expect("one is non-zero"),
                ),
            };
            Ok(if op == "add_node" {
                GraphPatchOperation::AddNode(node)
            } else {
                GraphPatchOperation::ReplaceNode(node)
            })
        }
        "remove_node" => {
            require_exact_keys(object, &["op", "nodeId"])?;
            Ok(GraphPatchOperation::RemoveNode(NodeId::new(
                required_string(object, "nodeId")?,
            )))
        }
        "add_edge" | "replace_edge" => {
            require_exact_keys(
                object,
                &["op", "edgeId", "sourceNodeId", "targetNodeId", "action"],
            )?;
            let edge = EdgeDefinition::new(
                EdgeId::new(required_string(object, "edgeId")?),
                NodeId::new(required_string(object, "sourceNodeId")?),
                "out",
                NodeId::new(required_string(object, "targetNodeId")?),
                "in",
                edge_action(required_string(object, "action")?)?,
            );
            Ok(if op == "add_edge" {
                GraphPatchOperation::AddEdge(edge)
            } else {
                GraphPatchOperation::ReplaceEdge(edge)
            })
        }
        "remove_edge" => {
            require_exact_keys(object, &["op", "edgeId"])?;
            Ok(GraphPatchOperation::RemoveEdge(EdgeId::new(
                required_string(object, "edgeId")?,
            )))
        }
        _ => Err(()),
    }
}

pub(crate) fn approval_action(
    arguments: &Map<String, Value>,
) -> Result<organization::ApprovalAction, ()> {
    match required_string(arguments, "approvalAction")? {
        "continue_node" => Ok(organization::ApprovalAction::ContinueNode),
        "execute_tool" => Ok(organization::ApprovalAction::ExecuteTool),
        "publish_result" => Ok(organization::ApprovalAction::PublishResult),
        "external_action" => Ok(organization::ApprovalAction::ExternalAction),
        _ => Err(()),
    }
}

fn node_kind(value: &str) -> Result<NodeKind, ()> {
    match value {
        "start" => Ok(NodeKind::Start),
        "work" => Ok(NodeKind::Work),
        "review" => Ok(NodeKind::Review),
        "human_decision" => Ok(NodeKind::HumanDecision),
        "script_review" => Ok(NodeKind::ScriptReview),
        "join" => Ok(NodeKind::Join),
        "end" => Ok(NodeKind::End),
        _ => Err(()),
    }
}

fn edge_action(value: &str) -> Result<EdgeAction, ()> {
    match value {
        "activate" => Ok(EdgeAction::Activate),
        "rework" => Ok(EdgeAction::Rework),
        "gate" => Ok(EdgeAction::Gate),
        "finish" => Ok(EdgeAction::Finish),
        _ => Err(()),
    }
}
