use std::{collections::BTreeMap, fmt, num::NonZeroU32};

use super::{
    EdgeAction, EdgeDefinition, EdgeId, ExecutorPolicy, GraphDefinition, GraphRunId, GroupId,
    NodeDefinition, NodeId, NodeKind, StartTrigger, WorkAssignment,
};

const VERSION: &str = "1";
const MAX_INPUT_BYTES: usize = 1_048_576;
const MAX_LINES: usize = 4_096;
const MAX_LINE_BYTES: usize = 131_072;
const MAX_NODES: usize = 256;
const MAX_EDGES: usize = 512;
const MAX_SCALAR_BYTES: usize = 65_536;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GraphYamlError {
    InvalidDocument,
    UnsupportedVersion,
    DuplicateField,
    UnknownField,
    MissingField,
    InvalidScalar,
    InvalidNode,
    InvalidEdge,
    InvalidDefinition,
    RunIdentityMismatch,
}

impl fmt::Display for GraphYamlError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidDocument => "graph YAML document is invalid",
            Self::UnsupportedVersion => "graph YAML version is unsupported",
            Self::DuplicateField => "graph YAML repeats a field",
            Self::UnknownField => "graph YAML contains an unsupported field",
            Self::MissingField => "graph YAML is missing a required field",
            Self::InvalidScalar => "graph YAML contains an invalid scalar",
            Self::InvalidNode => "graph YAML contains an invalid node",
            Self::InvalidEdge => "graph YAML contains an invalid edge",
            Self::InvalidDefinition => "graph YAML does not describe a valid graph",
            Self::RunIdentityMismatch => "graph YAML run identity does not match the target run",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for GraphYamlError {}

pub fn export(definition: &GraphDefinition) -> String {
    let mut yaml = String::from("version: 1\n");
    write_scalar(&mut yaml, "graphId", definition.graph_id());
    write_scalar(&mut yaml, "workflowPlanId", definition.workflow_plan_id());
    write_scalar(&mut yaml, "runId", definition.run_id().as_str());
    write_scalar(&mut yaml, "title", definition.title());
    yaml.push_str("nodes:\n");
    for node in definition.nodes() {
        yaml.push_str("  - ");
        yaml.push_str("id: ");
        yaml.push_str(&quoted(node.id().as_str()));
        yaml.push('\n');
        yaml.push_str("    kind: ");
        yaml.push_str(node_kind_name(node.kind()));
        yaml.push('\n');
        yaml.push_str("    title: ");
        yaml.push_str(&quoted(node.title()));
        yaml.push('\n');
        yaml.push_str("    maxAttempts: ");
        yaml.push_str(&node.max_attempts().get().to_string());
        yaml.push('\n');
        yaml.push_str("    isControl: ");
        yaml.push_str(if node.is_control() { "true" } else { "false" });
        yaml.push('\n');
        if let Some(StartTrigger::Webhook { path }) = node.trigger() {
            yaml.push_str("    webhookPath: ");
            yaml.push_str(&quoted(path));
            yaml.push('\n');
        }
        if let Some(StartTrigger::Cron { expression }) = node.trigger() {
            yaml.push_str("    cronExpression: ");
            yaml.push_str(&quoted(expression));
            yaml.push('\n');
        }
        if let Some(assignment) = node.work_assignment() {
            yaml.push_str("    taskId: ");
            yaml.push_str(&quoted(assignment.task_id()));
            yaml.push('\n');
            yaml.push_str("    prompt: ");
            yaml.push_str(&quoted(assignment.prompt()));
            yaml.push('\n');
            yaml.push_str("    roleId: ");
            yaml.push_str(&quoted(assignment.role_id()));
            yaml.push('\n');
            yaml.push_str("    sessionRef: ");
            yaml.push_str(&quoted(assignment.session_ref().as_str()));
            yaml.push('\n');
            if let Some(kind) = assignment.output_artifact_kind() {
                yaml.push_str("    outputArtifactKind: ");
                yaml.push_str(&quoted(kind));
                yaml.push('\n');
            }
            if let Some(group_id) = assignment.group_id() {
                yaml.push_str("    groupId: ");
                yaml.push_str(&quoted(group_id.as_str()));
                yaml.push('\n');
            }
        }
        if let Some(assignment) = node.review_assignment() {
            yaml.push_str("    roleId: ");
            yaml.push_str(&quoted(assignment.role_id()));
            yaml.push('\n');
            yaml.push_str("    sessionRef: ");
            yaml.push_str(&quoted(assignment.session_ref().as_str()));
            yaml.push('\n');
            yaml.push_str("    prompt: ");
            yaml.push_str(&quoted(assignment.prompt()));
            yaml.push('\n');
        }
        if let Some(group) = node.work_group() {
            yaml.push_str("    groupId: ");
            yaml.push_str(&quoted(group.id().as_str()));
            yaml.push('\n');
            yaml.push_str("    requireCompleted: ");
            yaml.push_str(if group.join_policy().require_completed() {
                "true"
            } else {
                "false"
            });
            yaml.push('\n');
            yaml.push_str("    allowFailed: ");
            yaml.push_str(if group.join_policy().allow_failed() {
                "true"
            } else {
                "false"
            });
            yaml.push('\n');
            yaml.push_str("    retryLimit: ");
            yaml.push_str(&group.join_policy().retry_limit().to_string());
            yaml.push('\n');
        }
    }
    yaml.push_str("edges:\n");
    for edge in definition.edges() {
        yaml.push_str("  - id: ");
        yaml.push_str(&quoted(edge.id().as_str()));
        yaml.push('\n');
        write_indented_scalar(&mut yaml, "from", edge.source_node_id().as_str());
        write_indented_scalar(&mut yaml, "sourcePort", edge.source_port());
        write_indented_scalar(&mut yaml, "to", edge.target_node_id().as_str());
        write_indented_scalar(&mut yaml, "targetPort", edge.target_port());
        yaml.push_str("    action: ");
        yaml.push_str(edge_action_name(edge.action()));
        yaml.push('\n');
        yaml.push_str("    includeUpstreamResult: ");
        yaml.push_str(if edge.payload().include_upstream_result() {
            "true"
        } else {
            "false"
        });
        yaml.push('\n');
        if let Some(dependency) = edge.dependency() {
            write_indented_scalar(
                &mut yaml,
                "dependencyTaskId",
                dependency.dependency_task_id(),
            );
            write_indented_scalar(&mut yaml, "taskId", dependency.task_id());
        }
    }
    yaml
}

pub fn import(input: &str) -> Result<GraphDefinition, GraphYamlError> {
    import_document(parse_document(input)?)
}

pub fn import_for_run(
    input: &str,
    expected_run_id: &GraphRunId,
) -> Result<GraphDefinition, GraphYamlError> {
    let definition = import(input)?;
    if definition.run_id() != expected_run_id {
        return Err(GraphYamlError::RunIdentityMismatch);
    }
    Ok(definition)
}

fn import_document(document: Document) -> Result<GraphDefinition, GraphYamlError> {
    let version = required(&document.scalars, "version")?;
    if version != VERSION {
        return Err(GraphYamlError::UnsupportedVersion);
    }
    let graph_id = required(&document.scalars, "graphId")?;
    let workflow_plan_id = required(&document.scalars, "workflowPlanId")?;
    let run_id = required(&document.scalars, "runId")?;
    let title = required(&document.scalars, "title")?;
    let nodes = document
        .nodes
        .into_iter()
        .map(read_node)
        .collect::<Result<Vec<_>, _>>()?;
    let edges = document
        .edges
        .into_iter()
        .map(read_edge)
        .collect::<Result<Vec<_>, _>>()?;
    GraphDefinition::new(
        graph_id,
        workflow_plan_id,
        GraphRunId::new(run_id),
        title,
        nodes,
        edges,
    )
    .map_err(|_| GraphYamlError::InvalidDefinition)
}

struct Document {
    scalars: BTreeMap<String, String>,
    nodes: Vec<BTreeMap<String, String>>,
    edges: Vec<BTreeMap<String, String>>,
    nodes_seen: bool,
    edges_seen: bool,
}

fn parse_document(input: &str) -> Result<Document, GraphYamlError> {
    if input.len() > MAX_INPUT_BYTES {
        return Err(GraphYamlError::InvalidDocument);
    }
    let lines = input.lines().collect::<Vec<_>>();
    if lines.is_empty() || lines.len() > MAX_LINES || !input.ends_with('\n') {
        return Err(GraphYamlError::InvalidDocument);
    }
    if lines
        .iter()
        .any(|line| line.len() > MAX_LINE_BYTES || line.contains('\t'))
    {
        return Err(GraphYamlError::InvalidDocument);
    }
    let mut document = Document {
        scalars: BTreeMap::new(),
        nodes: Vec::new(),
        edges: Vec::new(),
        nodes_seen: false,
        edges_seen: false,
    };
    let mut cursor = 0;
    while cursor < lines.len() {
        let line = lines[cursor];
        cursor += 1;
        if line.trim().is_empty() {
            continue;
        }
        if line.starts_with(' ') || line.contains('\t') {
            return Err(GraphYamlError::InvalidDocument);
        }
        let (field, raw_value) = split_field(line)?;
        match field {
            "nodes" | "edges" if raw_value.is_empty() => {
                let entries = parse_list(&lines, &mut cursor)?;
                if field == "nodes" {
                    if document.nodes_seen {
                        return Err(GraphYamlError::DuplicateField);
                    }
                    document.nodes_seen = true;
                    document.nodes = entries;
                } else {
                    if document.edges_seen {
                        return Err(GraphYamlError::DuplicateField);
                    }
                    document.edges_seen = true;
                    document.edges = entries;
                }
                if document.nodes.len() > MAX_NODES || document.edges.len() > MAX_EDGES {
                    return Err(GraphYamlError::InvalidDocument);
                }
            }
            "version" | "graphId" | "workflowPlanId" | "runId" | "title" => {
                let value = scalar(field, raw_value)?;
                if document.scalars.insert(field.to_owned(), value).is_some() {
                    return Err(GraphYamlError::DuplicateField);
                }
            }
            "nodes" | "edges" => return Err(GraphYamlError::InvalidDocument),
            _ => return Err(GraphYamlError::UnknownField),
        }
    }
    if !document.nodes_seen || !document.edges_seen {
        return Err(GraphYamlError::MissingField);
    }
    if document.nodes.is_empty() {
        return Err(GraphYamlError::InvalidDefinition);
    }
    Ok(document)
}

fn parse_list(
    lines: &[&str],
    cursor: &mut usize,
) -> Result<Vec<BTreeMap<String, String>>, GraphYamlError> {
    let mut entries = Vec::new();
    let mut current = None;
    while *cursor < lines.len() {
        let line = lines[*cursor];
        if line.trim().is_empty() {
            *cursor += 1;
            continue;
        }
        if !line.starts_with(' ') {
            break;
        }
        *cursor += 1;
        if let Some(value) = line.strip_prefix("  - ") {
            if current.is_some() {
                entries.push(current.take().expect("checked above"));
            }
            current = Some(BTreeMap::new());
            insert_field(current.as_mut().expect("just initialized"), value)?;
            continue;
        }
        let Some(value) = line.strip_prefix("    ") else {
            return Err(GraphYamlError::InvalidDocument);
        };
        insert_field(
            current.as_mut().ok_or(GraphYamlError::InvalidDocument)?,
            value,
        )?;
    }
    if let Some(entry) = current {
        entries.push(entry);
    }
    Ok(entries)
}

fn insert_field(entry: &mut BTreeMap<String, String>, line: &str) -> Result<(), GraphYamlError> {
    let (field, raw_value) = split_field(line)?;
    let value = scalar(field, raw_value)?;
    if entry.insert(field.to_owned(), value).is_some() {
        return Err(GraphYamlError::DuplicateField);
    }
    Ok(())
}

fn read_node(mut fields: BTreeMap<String, String>) -> Result<NodeDefinition, GraphYamlError> {
    let id = take(&mut fields, "id")?;
    let kind = parse_node_kind(&take(&mut fields, "kind")?)?;
    let title = take(&mut fields, "title")?;
    let max_attempts = take(&mut fields, "maxAttempts")?
        .parse::<u32>()
        .ok()
        .and_then(NonZeroU32::new)
        .ok_or(GraphYamlError::InvalidNode)?;
    let is_control = fields
        .remove("isControl")
        .ok_or(GraphYamlError::MissingField)?
        .parse::<bool>()
        .map_err(|_| GraphYamlError::InvalidNode)?;
    let webhook_path = fields.remove("webhookPath");
    let cron_expression = fields.remove("cronExpression");
    let task_id = fields.remove("taskId");
    let prompt = fields.remove("prompt");
    let role_id = fields.remove("roleId");
    let session_ref = fields.remove("sessionRef");
    let output_artifact_kind = fields.remove("outputArtifactKind");
    let group_id = fields.remove("groupId");
    let require_completed = fields.remove("requireCompleted");
    let allow_failed = fields.remove("allowFailed");
    let retry_limit = fields.remove("retryLimit");
    if !fields.is_empty() {
        return Err(GraphYamlError::UnknownField);
    }
    match (kind, is_control) {
        (NodeKind::Start, false) => {
            let trigger = match (webhook_path, cron_expression) {
                (None, None) => None,
                (Some(path), None) => Some(StartTrigger::Webhook { path }),
                (None, Some(expression)) => Some(StartTrigger::Cron { expression }),
                (Some(_), Some(_)) => return Err(GraphYamlError::InvalidNode),
            };
            if task_id.is_some()
                || prompt.is_some()
                || role_id.is_some()
                || session_ref.is_some()
                || output_artifact_kind.is_some()
                || group_id.is_some()
                || require_completed.is_some()
                || allow_failed.is_some()
                || retry_limit.is_some()
            {
                return Err(GraphYamlError::InvalidNode);
            }
            Ok(NodeDefinition::start(
                NodeId::new(id),
                title,
                max_attempts,
                trigger,
            ))
        }
        (NodeKind::Work, false) => match (
            task_id,
            prompt,
            role_id,
            session_ref,
            webhook_path,
            cron_expression,
            group_id,
            require_completed,
            allow_failed,
            retry_limit,
        ) {
            (
                Some(task_id),
                Some(prompt),
                Some(role_id),
                session_ref,
                None,
                None,
                group_id,
                None,
                None,
                None,
            ) => Ok(NodeDefinition::work(
                NodeId::new(id),
                title,
                max_attempts,
                WorkAssignment::typed(
                    task_id,
                    prompt,
                    ExecutorPolicy::team_role_session(role_id, role_session_ref(session_ref)?),
                    output_artifact_kind,
                    group_id.map(GroupId::new),
                ),
            )),
            _ => Err(GraphYamlError::InvalidNode),
        },
        (NodeKind::Review, false) => match (
            role_id,
            session_ref,
            prompt,
            webhook_path,
            cron_expression,
            task_id,
            output_artifact_kind,
            group_id,
            require_completed,
            allow_failed,
            retry_limit,
        ) {
            (
                Some(role_id),
                session_ref,
                Some(prompt),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
            ) => Ok(NodeDefinition::review(
                NodeId::new(id),
                title,
                max_attempts,
                super::ReviewAssignment::with_executor(
                    ExecutorPolicy::team_role_session(role_id, role_session_ref(session_ref)?),
                    prompt,
                ),
            )),
            _ => Err(GraphYamlError::InvalidNode),
        },
        (NodeKind::Join, false) => match (
            group_id,
            require_completed,
            allow_failed,
            retry_limit,
            webhook_path,
            cron_expression,
            task_id,
            prompt,
            role_id,
            session_ref,
            output_artifact_kind,
        ) {
            (
                Some(group_id),
                Some(require_completed),
                Some(allow_failed),
                Some(retry_limit),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
            ) => Ok(NodeDefinition::join(
                NodeId::new(id),
                title,
                max_attempts,
                super::WorkGroup::new(
                    GroupId::new(group_id),
                    super::JoinPolicy::new(
                        require_completed
                            .parse()
                            .map_err(|_| GraphYamlError::InvalidNode)?,
                        allow_failed
                            .parse()
                            .map_err(|_| GraphYamlError::InvalidNode)?,
                        retry_limit
                            .parse()
                            .map_err(|_| GraphYamlError::InvalidNode)?,
                    ),
                ),
            )),
            _ => Err(GraphYamlError::InvalidNode),
        },
        (kind, true)
            if matches!(
                kind,
                NodeKind::Start
                    | NodeKind::Review
                    | NodeKind::HumanDecision
                    | NodeKind::ScriptReview
                    | NodeKind::Join
                    | NodeKind::End
            ) && webhook_path.is_none()
                && cron_expression.is_none()
                && task_id.is_none()
                && prompt.is_none()
                && role_id.is_none()
                && session_ref.is_none()
                && output_artifact_kind.is_none()
                && group_id.is_none()
                && require_completed.is_none()
                && allow_failed.is_none()
                && retry_limit.is_none() =>
        {
            Ok(NodeDefinition::control(
                NodeId::new(id),
                kind,
                title,
                max_attempts,
            ))
        }
        _ => Err(GraphYamlError::InvalidNode),
    }
}

fn role_session_ref(value: Option<String>) -> Result<crate::RoleSessionRef, GraphYamlError> {
    match value {
        Some(value) => {
            crate::RoleSessionRef::try_new(value).map_err(|_| GraphYamlError::InvalidNode)
        }
        None => Ok(crate::RoleSessionRef::initial()),
    }
}

fn read_edge(mut fields: BTreeMap<String, String>) -> Result<EdgeDefinition, GraphYamlError> {
    let id = take(&mut fields, "id")?;
    let from = take(&mut fields, "from")?;
    let source_port = take(&mut fields, "sourcePort")?;
    let to = take(&mut fields, "to")?;
    let target_port = take(&mut fields, "targetPort")?;
    let action = parse_edge_action(&take(&mut fields, "action")?)?;
    let include_upstream_result = fields
        .remove("includeUpstreamResult")
        .ok_or(GraphYamlError::MissingField)?
        .parse::<bool>()
        .map_err(|_| GraphYamlError::InvalidEdge)?;
    let dependency_task_id = fields.remove("dependencyTaskId");
    let dependency_task = fields.remove("taskId");
    let dependency = match (dependency_task_id, dependency_task) {
        (None, None) => None,
        (Some(dependency_task_id), Some(task_id)) => {
            Some(super::DependencyMetadata::new(dependency_task_id, task_id))
        }
        _ => return Err(GraphYamlError::InvalidEdge),
    };
    if !fields.is_empty() {
        return Err(GraphYamlError::UnknownField);
    }
    Ok(EdgeDefinition::new(
        EdgeId::new(id),
        NodeId::new(from),
        source_port,
        NodeId::new(to),
        target_port,
        action,
    )
    .with_payload(super::EdgePayloadPolicy::new(include_upstream_result))
    .with_dependency_opt(dependency))
}

fn required<'a>(
    fields: &'a BTreeMap<String, String>,
    field: &str,
) -> Result<&'a str, GraphYamlError> {
    fields
        .get(field)
        .map(String::as_str)
        .ok_or(GraphYamlError::MissingField)
}

fn take(fields: &mut BTreeMap<String, String>, field: &str) -> Result<String, GraphYamlError> {
    fields.remove(field).ok_or(GraphYamlError::MissingField)
}

fn split_field(line: &str) -> Result<(&str, &str), GraphYamlError> {
    let Some((field, value)) = line.split_once(':') else {
        return Err(GraphYamlError::InvalidDocument);
    };
    if field.is_empty() || !field.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return Err(GraphYamlError::InvalidDocument);
    }
    Ok((field, value.trim_start()))
}

fn scalar(field: &str, value: &str) -> Result<String, GraphYamlError> {
    if value.len() > MAX_SCALAR_BYTES
        || value.is_empty() && field != "prompt"
        || value.contains('\t')
    {
        return Err(GraphYamlError::InvalidScalar);
    }
    let parsed = if value.starts_with('"') {
        serde_json::from_str::<String>(value).map_err(|_| GraphYamlError::InvalidScalar)?
    } else {
        if value.contains(':') || value.contains('#') || value.chars().any(char::is_whitespace) {
            return Err(GraphYamlError::InvalidScalar);
        }
        value.to_owned()
    };
    if parsed.len() > MAX_SCALAR_BYTES
        || (parsed.is_empty() && field != "prompt")
        || parsed.chars().any(char::is_control)
    {
        return Err(GraphYamlError::InvalidScalar);
    }
    if !value.starts_with('"')
        && !matches!(
            field,
            "version"
                | "kind"
                | "maxAttempts"
                | "isControl"
                | "action"
                | "includeUpstreamResult"
                | "sessionRef"
                | "requireCompleted"
                | "allowFailed"
                | "retryLimit"
        )
    {
        return Err(GraphYamlError::InvalidScalar);
    }
    Ok(parsed)
}

fn parse_node_kind(value: &str) -> Result<NodeKind, GraphYamlError> {
    match value {
        "start" => Ok(NodeKind::Start),
        "work" => Ok(NodeKind::Work),
        "review" => Ok(NodeKind::Review),
        "humanDecision" => Ok(NodeKind::HumanDecision),
        "scriptReview" => Ok(NodeKind::ScriptReview),
        "join" => Ok(NodeKind::Join),
        "end" => Ok(NodeKind::End),
        _ => Err(GraphYamlError::InvalidNode),
    }
}

fn parse_edge_action(value: &str) -> Result<EdgeAction, GraphYamlError> {
    match value {
        "activate" => Ok(EdgeAction::Activate),
        "rework" => Ok(EdgeAction::Rework),
        "gate" => Ok(EdgeAction::Gate),
        "finish" => Ok(EdgeAction::Finish),
        _ => Err(GraphYamlError::InvalidEdge),
    }
}

fn node_kind_name(kind: NodeKind) -> &'static str {
    match kind {
        NodeKind::Start => "start",
        NodeKind::Work => "work",
        NodeKind::Review => "review",
        NodeKind::HumanDecision => "humanDecision",
        NodeKind::ScriptReview => "scriptReview",
        NodeKind::Join => "join",
        NodeKind::End => "end",
    }
}

fn edge_action_name(action: EdgeAction) -> &'static str {
    match action {
        EdgeAction::Activate => "activate",
        EdgeAction::Rework => "rework",
        EdgeAction::Gate => "gate",
        EdgeAction::Finish => "finish",
    }
}

fn write_scalar(yaml: &mut String, key: &str, value: &str) {
    yaml.push_str(key);
    yaml.push_str(": ");
    yaml.push_str(&quoted(value));
    yaml.push('\n');
}

fn write_indented_scalar(yaml: &mut String, key: &str, value: &str) {
    yaml.push_str("    ");
    write_scalar(yaml, key, value);
}

fn quoted(value: &str) -> String {
    serde_json::to_string(value).expect("strings always encode as JSON")
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroU32;

    use super::*;

    fn definition() -> GraphDefinition {
        GraphDefinition::new(
            "graph:release",
            "plan:release",
            GraphRunId::new("run:release"),
            "private release graph",
            vec![
                NodeDefinition::start(
                    NodeId::new("start"),
                    "private trigger title",
                    NonZeroU32::new(2).unwrap(),
                    Some(StartTrigger::Webhook {
                        path: "release-ready".into(),
                    }),
                ),
                NodeDefinition::work(
                    NodeId::new("work"),
                    "private work title",
                    NonZeroU32::new(3).unwrap(),
                    WorkAssignment::new("task:release", "operator"),
                ),
            ],
            vec![EdgeDefinition::new(
                EdgeId::new("start-work"),
                NodeId::new("start"),
                "completed",
                NodeId::new("work"),
                "input",
                EdgeAction::Activate,
            )],
        )
        .unwrap()
    }

    #[test]
    fn canonical_yaml_round_trips_the_final_graph_facts() {
        let yaml = export(&definition());

        assert!(yaml.starts_with("version: 1\n"));
        assert_eq!(import(&yaml), Ok(definition()));
        assert_eq!(export(&import(&yaml).unwrap()), yaml);
    }

    #[test]
    fn grammar_keeps_runtime_state_and_generic_configs_out_of_graph_yaml() {
        let yaml = r#"version: 1
graphId: "graph:release"
workflowPlanId: "plan:release"
runId: "run:release"
title: "private graph"
nodes:
  - id: "start"
    kind: start
    title: "Start"
    maxAttempts: 1
    isControl: false
    config: "secret-token"
edges:
"#;

        assert_eq!(import(yaml), Err(GraphYamlError::UnknownField));
    }

    #[test]
    fn rejects_noncanonical_or_unrecognized_yaml_before_definition_construction() {
        let canonical = export(&definition());
        assert_eq!(
            import(&canonical[..canonical.len() - 1]),
            Err(GraphYamlError::InvalidDocument)
        );
        assert_eq!(
            import(&canonical.replace("version: 1", "version: 2")),
            Err(GraphYamlError::UnsupportedVersion)
        );
        assert_eq!(
            import(&canonical.replace("nodes:\n", "nodes:\n  # comment\n")),
            Err(GraphYamlError::InvalidDocument)
        );
        assert_eq!(
            import(&canonical.replacen("edges:\n", "edges:\nedges:\n", 1)),
            Err(GraphYamlError::DuplicateField)
        );
    }

    #[test]
    fn round_trips_a_definition_without_edges() {
        let definition = GraphDefinition::new(
            "graph:single",
            "plan:single",
            GraphRunId::new("run:single"),
            "single start",
            vec![NodeDefinition::start(
                NodeId::new("start"),
                "Start",
                NonZeroU32::new(1).unwrap(),
                Some(StartTrigger::Cron {
                    expression: "0 * * * *".into(),
                }),
            )],
            Vec::new(),
        )
        .unwrap();

        assert_eq!(import(&export(&definition)), Ok(definition));
    }

    #[test]
    fn rejects_ambiguous_start_trigger_and_redacts_input_from_errors() {
        let yaml = r#"version: 1
graphId: "graph:release"
workflowPlanId: "plan:release"
runId: "run:release"
title: "private graph"
nodes:
  - id: "start"
    kind: start
    title: "Start"
    maxAttempts: 1
    isControl: false
    webhookPath: "release"
    cronExpression: "* * * * *"
edges:
"#;

        let error = import(yaml).unwrap_err();
        assert_eq!(error, GraphYamlError::InvalidNode);
        assert!(!error.to_string().contains("private"));
        assert!(!format!("{error:?}").contains("private"));
    }
}
