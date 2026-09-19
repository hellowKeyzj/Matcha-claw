use serde_json::{Value, json};

use crate::{
    organization::OrganizationHandle, transport::common::authorization::CapabilityDecisionVerifier,
};

const OPERATION_ID: &str = "team.graph.yaml";
const AUTHORIZATION_ENDPOINT: &str = "/api/team/graph";
const AUTHORIZATION_SCOPE: &str = "team:write";
const AUTHORIZATION_SUBJECT: &str = "team-graph-yaml";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

pub(crate) enum Request {
    Export {
        team_id: organization::TeamId,
        run_id: organization::GraphRunId,
    },
    Replace {
        team_id: organization::TeamId,
        command: Box<organization::RunCommand>,
        definition: Box<organization::GraphDefinition>,
    },
    Import {
        team_id: organization::TeamId,
        command_id: organization::run::event::OpaqueId,
        idempotency_key: organization::run::event::OpaqueId,
        yaml: String,
    },
}

pub(crate) fn decode(
    value: Value,
    authorization: &str,
    verifier: &mut CapabilityDecisionVerifier,
    now: u64,
) -> Result<Request, DecodeError> {
    verifier
        .verify(
            authorization,
            now,
            AUTHORIZATION_ENDPOINT,
            AUTHORIZATION_SCOPE,
            OPERATION_ID,
            AUTHORIZATION_SUBJECT,
        )
        .map_err(|_| DecodeError::Unauthorized)?;

    let Value::Object(body) = value else {
        return Err(DecodeError::Invalid);
    };
    let Some(Value::String(action)) = body.get("action") else {
        return Err(DecodeError::Invalid);
    };
    match action.as_str() {
        "export" => decode_export(&body),
        "replace" => decode_replace(&body),
        "import" => decode_import(&body),
        _ => Err(DecodeError::Invalid),
    }
}

pub(crate) enum Delivery {
    Exported { run_id: String, yaml: String },
    Replaced { run_id: String },
    Unavailable,
    Rejected,
}

impl Delivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Exported { .. } | Self::Replaced { .. } => 200,
            Self::Unavailable => 404,
            Self::Rejected => 409,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Exported { run_id, yaml } => json!({
                "success": true,
                "action": "export",
                "runId": run_id,
                "yaml": yaml,
            }),
            Self::Replaced { run_id } => json!({
                "success": true,
                "action": "replace",
                "runId": run_id,
            }),
            Self::Unavailable => json!({
                "success": false,
                "error": "Team graph is unavailable",
            }),
            Self::Rejected => json!({
                "success": false,
                "error": "Team graph update was rejected",
            }),
        }
    }
}

pub(crate) async fn handle(owner: &OrganizationHandle, request: Request) -> Delivery {
    match request {
        Request::Export { team_id, run_id } => {
            match owner.graph_definition(team_id, run_id.clone()).await {
                Ok(Some(definition)) => Delivery::Exported {
                    run_id: run_id.as_str().to_owned(),
                    yaml: organization::export_yaml(&definition),
                },
                Ok(None) | Err(_) => Delivery::Unavailable,
            }
        }
        Request::Replace {
            team_id,
            command,
            definition,
        } => replace(owner, team_id, *command, *definition).await,
        Request::Import {
            team_id,
            command_id,
            idempotency_key,
            yaml,
        } => {
            let definition = match organization::import_yaml(&yaml) {
                Ok(definition) => definition,
                Err(_) => return Delivery::Rejected,
            };
            let command = organization::RunCommand::new(
                match organization::run::event::OpaqueId::try_new(definition.run_id().as_str()) {
                    Ok(run_id) => run_id,
                    Err(_) => return Delivery::Rejected,
                },
                command_id,
                idempotency_key,
                organization::CommandPayload::GraphReplace(definition.clone()),
                now_millis(),
            );
            replace(owner, team_id, command, definition).await
        }
    }
}

async fn replace(
    owner: &OrganizationHandle,
    team_id: organization::TeamId,
    command: organization::RunCommand,
    definition: organization::GraphDefinition,
) -> Delivery {
    if command.run_id().as_str() != definition.run_id().as_str()
        || !matches!(command.payload(), organization::CommandPayload::GraphReplace(payload) if payload == &definition)
    {
        return Delivery::Rejected;
    }
    let run_id = definition.run_id().clone();
    match owner
        .graph_definition(team_id.clone(), run_id.clone())
        .await
    {
        Ok(Some(_)) => {}
        Ok(None) | Err(_) => return Delivery::Unavailable,
    }
    match owner.graph_save(command, definition).await {
        Ok(Ok(_)) => Delivery::Replaced {
            run_id: run_id.as_str().to_owned(),
        },
        Ok(Err(_)) => Delivery::Rejected,
        Err(_) => Delivery::Unavailable,
    }
}

fn decode_export(body: &serde_json::Map<String, Value>) -> Result<Request, DecodeError> {
    if body.len() != 3 {
        return Err(DecodeError::Invalid);
    }
    Ok(Request::Export {
        team_id: team_id(body)?,
        run_id: run_id(body)?,
    })
}

fn decode_replace(body: &serde_json::Map<String, Value>) -> Result<Request, DecodeError> {
    if body.len() != 5 {
        return Err(DecodeError::Invalid);
    }
    let team_id = team_id(body)?;
    let command_id = opaque(body, "commandId")?;
    let idempotency_key = opaque(body, "idempotencyKey")?;
    let Some(definition) = body.get("graph") else {
        return Err(DecodeError::Invalid);
    };
    let definition = decode_definition(definition)?;
    let command = organization::RunCommand::new(
        organization::run::event::OpaqueId::try_new(definition.run_id().as_str())
            .map_err(|_| DecodeError::Invalid)?,
        command_id,
        idempotency_key,
        organization::CommandPayload::GraphReplace(definition.clone()),
        now_millis(),
    );
    Ok(Request::Replace {
        team_id,
        command: Box::new(command),
        definition: Box::new(definition),
    })
}

fn decode_import(body: &serde_json::Map<String, Value>) -> Result<Request, DecodeError> {
    if body.len() != 5 {
        return Err(DecodeError::Invalid);
    }
    let Some(Value::String(yaml)) = body.get("yaml") else {
        return Err(DecodeError::Invalid);
    };
    if yaml.is_empty() || yaml.len() > 256 * 1024 || yaml.contains('\0') {
        return Err(DecodeError::Invalid);
    }
    Ok(Request::Import {
        team_id: team_id(body)?,
        command_id: opaque(body, "commandId")?,
        idempotency_key: opaque(body, "idempotencyKey")?,
        yaml: yaml.clone(),
    })
}

fn team_id(body: &serde_json::Map<String, Value>) -> Result<organization::TeamId, DecodeError> {
    let Some(Value::String(value)) = body.get("teamId") else {
        return Err(DecodeError::Invalid);
    };
    organization::TeamId::try_new(value.clone()).map_err(|_| DecodeError::Invalid)
}

fn run_id(body: &serde_json::Map<String, Value>) -> Result<organization::GraphRunId, DecodeError> {
    let Some(Value::String(value)) = body.get("runId") else {
        return Err(DecodeError::Invalid);
    };
    valid_text(value)?;
    Ok(organization::GraphRunId::new(value.clone()))
}

fn opaque(
    body: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<organization::run::event::OpaqueId, DecodeError> {
    let Some(Value::String(value)) = body.get(field) else {
        return Err(DecodeError::Invalid);
    };
    organization::run::event::OpaqueId::try_new(value.clone()).map_err(|_| DecodeError::Invalid)
}

fn decode_definition(value: &Value) -> Result<organization::GraphDefinition, DecodeError> {
    let Value::Object(graph) = value else {
        return Err(DecodeError::Invalid);
    };
    if graph.len() != 6 {
        return Err(DecodeError::Invalid);
    }
    let graph_id = text(graph, "graphId")?;
    let workflow_plan_id = text(graph, "workflowPlanId")?;
    let run_id = organization::GraphRunId::new(text(graph, "runId")?);
    let title = text(graph, "title")?;
    let nodes = decode_nodes(graph.get("nodes").ok_or(DecodeError::Invalid)?)?;
    let edges = decode_edges(graph.get("edges").ok_or(DecodeError::Invalid)?)?;
    organization::GraphDefinition::new(graph_id, workflow_plan_id, run_id, title, nodes, edges)
        .map_err(|_| DecodeError::Invalid)
}

fn reject_keys(
    object: &serde_json::Map<String, Value>,
    allowed: &[&str],
) -> Result<(), DecodeError> {
    object
        .keys()
        .all(|key| allowed.contains(&key.as_str()))
        .then_some(())
        .ok_or(DecodeError::Invalid)
}

fn decode_nodes(value: &Value) -> Result<Vec<organization::NodeDefinition>, DecodeError> {
    let Value::Array(nodes) = value else {
        return Err(DecodeError::Invalid);
    };
    nodes.iter().map(decode_node).collect()
}

fn decode_node(value: &Value) -> Result<organization::NodeDefinition, DecodeError> {
    let Value::Object(node) = value else {
        return Err(DecodeError::Invalid);
    };
    let id = organization::NodeId::new(text(node, "id")?);
    let title = text(node, "title")?;
    let max_attempts = node
        .get("maxAttempts")
        .and_then(Value::as_u64)
        .and_then(|value| value.try_into().ok())
        .and_then(std::num::NonZeroU32::new)
        .ok_or(DecodeError::Invalid)?;
    let kind = match text(node, "kind")?.as_str() {
        "start" => organization::NodeKind::Start,
        "work" => organization::NodeKind::Work,
        "review" => organization::NodeKind::Review,
        "humanDecision" => organization::NodeKind::HumanDecision,
        "scriptReview" => organization::NodeKind::ScriptReview,
        "join" => organization::NodeKind::Join,
        "end" => organization::NodeKind::End,
        _ => return Err(DecodeError::Invalid),
    };
    match kind {
        organization::NodeKind::Start => {
            reject_keys(node, &["id", "kind", "title", "maxAttempts", "trigger"])?;
            let trigger = match node.get("trigger") {
                Some(Value::Null) | None => None,
                Some(Value::Object(trigger)) => match text(trigger, "kind")?.as_str() {
                    "webhook" => {
                        reject_keys(trigger, &["kind", "path"])?;
                        Some(organization::StartTrigger::Webhook {
                            path: text(trigger, "path")?,
                        })
                    }
                    "cron" => {
                        reject_keys(trigger, &["kind", "expression"])?;
                        Some(organization::StartTrigger::Cron {
                            expression: text(trigger, "expression")?,
                        })
                    }
                    _ => return Err(DecodeError::Invalid),
                },
                _ => return Err(DecodeError::Invalid),
            };
            Ok(organization::NodeDefinition::start(
                id,
                title,
                max_attempts,
                trigger,
            ))
        }
        organization::NodeKind::Work => {
            let Some(Value::Object(work)) = node.get("work") else {
                return Err(DecodeError::Invalid);
            };
            reject_keys(node, &["id", "kind", "title", "maxAttempts", "work"])?;
            let task_id = text(work, "taskId")?;
            let role_id = text(work, "roleId")?;
            let prompt = match work.get("prompt") {
                Some(Value::String(value)) => value.clone(),
                None => String::new(),
                _ => return Err(DecodeError::Invalid),
            };
            let output_artifact_kind = match work.get("outputArtifactKind") {
                Some(Value::String(value)) => Some(value.clone()),
                None => None,
                _ => return Err(DecodeError::Invalid),
            };
            let group_id = match work.get("groupId") {
                Some(Value::String(value)) => Some(organization::GroupId::new(value)),
                None => None,
                _ => return Err(DecodeError::Invalid),
            };
            if let Some(executor) = work.get("executor") {
                let Value::Object(executor) = executor else {
                    return Err(DecodeError::Invalid);
                };
                reject_keys(executor, &["kind", "roleId"])?;
                if text(executor, "kind")? != "team-role" || text(executor, "roleId")? != role_id {
                    return Err(DecodeError::Invalid);
                }
            }
            reject_keys(
                work,
                &[
                    "taskId",
                    "roleId",
                    "prompt",
                    "executor",
                    "outputArtifactKind",
                    "groupId",
                ],
            )?;
            Ok(organization::NodeDefinition::work(
                id,
                title,
                max_attempts,
                organization::WorkAssignment::typed(
                    task_id,
                    prompt,
                    organization::ExecutorPolicy::team_role(role_id),
                    output_artifact_kind,
                    group_id,
                ),
            ))
        }
        organization::NodeKind::Join => {
            reject_keys(node, &["id", "kind", "title", "maxAttempts", "group"])?;
            let Some(Value::Object(group)) = node.get("group") else {
                return Err(DecodeError::Invalid);
            };
            reject_keys(group, &["groupId", "join"])?;
            let group_id = organization::GroupId::new(text(group, "groupId")?);
            let Some(Value::Object(join)) = group.get("join") else {
                return Err(DecodeError::Invalid);
            };
            reject_keys(join, &["requireCompleted", "allowFailed", "retryLimit"])?;
            let Some(require_completed) = join.get("requireCompleted").and_then(Value::as_bool)
            else {
                return Err(DecodeError::Invalid);
            };
            let Some(allow_failed) = join.get("allowFailed").and_then(Value::as_bool) else {
                return Err(DecodeError::Invalid);
            };
            let Some(retry_limit) = join
                .get("retryLimit")
                .and_then(Value::as_u64)
                .and_then(|v| v.try_into().ok())
            else {
                return Err(DecodeError::Invalid);
            };
            Ok(organization::NodeDefinition::join(
                id,
                title,
                max_attempts,
                organization::WorkGroup::new(
                    group_id,
                    organization::JoinPolicy::new(require_completed, allow_failed, retry_limit),
                ),
            ))
        }
        _ => {
            reject_keys(node, &["id", "kind", "title", "maxAttempts"])?;
            Ok(organization::NodeDefinition::control(
                id,
                kind,
                title,
                max_attempts,
            ))
        }
    }
}

fn decode_edges(value: &Value) -> Result<Vec<organization::EdgeDefinition>, DecodeError> {
    let Value::Array(edges) = value else {
        return Err(DecodeError::Invalid);
    };
    edges.iter().map(decode_edge).collect()
}

fn decode_edge(value: &Value) -> Result<organization::EdgeDefinition, DecodeError> {
    let Value::Object(edge) = value else {
        return Err(DecodeError::Invalid);
    };
    reject_keys(
        edge,
        &[
            "id",
            "from",
            "sourcePort",
            "to",
            "targetPort",
            "action",
            "payload",
            "dependency",
        ],
    )?;
    let action = match text(edge, "action")?.as_str() {
        "activate" => organization::EdgeAction::Activate,
        "rework" => organization::EdgeAction::Rework,
        "gate" => organization::EdgeAction::Gate,
        "finish" => organization::EdgeAction::Finish,
        _ => return Err(DecodeError::Invalid),
    };
    let mut definition = organization::EdgeDefinition::new(
        organization::EdgeId::new(text(edge, "id")?),
        organization::NodeId::new(text(edge, "from")?),
        text(edge, "sourcePort")?,
        organization::NodeId::new(text(edge, "to")?),
        text(edge, "targetPort")?,
        action,
    );
    if let Some(Value::Object(payload)) = edge.get("payload") {
        reject_keys(payload, &["includeUpstreamResult"])?;
        let Some(include) = payload
            .get("includeUpstreamResult")
            .and_then(Value::as_bool)
        else {
            return Err(DecodeError::Invalid);
        };
        definition = definition.with_payload(organization::EdgePayloadPolicy::new(include));
    } else if edge.contains_key("payload") {
        return Err(DecodeError::Invalid);
    }
    if let Some(Value::Object(dependency)) = edge.get("dependency") {
        reject_keys(dependency, &["dependencyTaskId", "taskId"])?;
        definition = definition.with_dependency(organization::DependencyMetadata::new(
            text(dependency, "dependencyTaskId")?,
            text(dependency, "taskId")?,
        ));
    } else if edge.contains_key("dependency") {
        return Err(DecodeError::Invalid);
    }
    Ok(definition)
}

fn text(object: &serde_json::Map<String, Value>, field: &str) -> Result<String, DecodeError> {
    let Some(Value::String(value)) = object.get(field) else {
        return Err(DecodeError::Invalid);
    };
    valid_text(value)?;
    Ok(value.clone())
}

fn valid_text(value: &str) -> Result<(), DecodeError> {
    if value.is_empty()
        || value.len() > 4096
        || value.contains('\0')
        || value.chars().any(char::is_control)
    {
        return Err(DecodeError::Invalid);
    }
    Ok(())
}

fn now_millis() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

pub(crate) mod handler;

#[cfg(test)]
mod tests {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::{Signer as _, SigningKey};
    use serde_json::json;

    use super::*;

    #[test]
    fn decodes_only_closed_graph_export_replace_and_import_requests() {
        assert!(matches!(
            decode_with_authorization(json!({
                "action": "export",
                "teamId": "team:one",
                "runId": "run:one",
            })),
            Request::Export { .. }
        ));
        assert!(matches!(
            decode_with_authorization(json!({
                "action": "import",
                "teamId": "team:one",
                "commandId": "command:one",
                "idempotencyKey": "replace:one",
                "yaml": r#"version: 1
graphId: "graph:one"
workflowPlanId: "plan:one"
runId: "run:one"
title: "One"
nodes:
  - id: "start"
    kind: start
    title: "Start"
    maxAttempts: 1
edges:
"#,
            })),
            Request::Import { .. }
        ));
        for invalid in [
            json!({ "action": "export", "teamId": "team:one" }),
            json!({ "action": "export", "teamId": "team:one", "runId": "run:one", "private": true }),
            json!({ "action": "unknown", "teamId": "team:one", "runId": "run:one" }),
        ] {
            assert!(matches!(decode_result(invalid), Err(DecodeError::Invalid)));
        }
    }

    #[test]
    fn delivery_errors_are_fixed_and_redacted() {
        assert_eq!(
            Delivery::Rejected.body(),
            json!({ "success": false, "error": "Team graph update was rejected" })
        );
        assert_eq!(
            Delivery::Unavailable.body(),
            json!({ "success": false, "error": "Team graph is unavailable" })
        );
    }

    fn decode_with_authorization(value: Value) -> Request {
        decode_result(value).expect("valid fixed request")
    }

    fn decode_result(value: Value) -> Result<Request, DecodeError> {
        let mut verifier =
            CapabilityDecisionVerifier::try_new(&verification_key()).expect("verifier");
        let authorization = decision();
        decode(value, &authorization, &mut verifier, 1)
    }

    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[31; 32])
    }

    fn verification_key() -> String {
        let mut bytes = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        bytes.extend_from_slice(signing_key().verifying_key().as_bytes());
        URL_SAFE_NO_PAD.encode(bytes)
    }

    fn decision() -> String {
        let payload = json!({
            "version": 1,
            "principal": "localhost-test",
            "endpoint": AUTHORIZATION_ENDPOINT,
            "scope": AUTHORIZATION_SCOPE,
            "capability": OPERATION_ID,
            "subject": AUTHORIZATION_SUBJECT,
            "expiresAt": 60_000,
            "correlation": "team-graph-test",
            "revision": "test",
        });
        let payload =
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("serialize decision"));
        let signed = format!("capability-decision.v1.{payload}");
        let signature = URL_SAFE_NO_PAD.encode(signing_key().sign(signed.as_bytes()).to_bytes());
        format!("{signed}.{signature}")
    }
}
