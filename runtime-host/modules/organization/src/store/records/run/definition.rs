use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{
    DependencyMetadata, EdgeAction, EdgeDefinition, EdgeId, EdgePayloadPolicy, ExecutorPolicy,
    GraphDefinition, GraphRunId, NodeDefinition, NodeId, NodeKind, ReviewAssignment,
    RoleSessionRef, ScriptReviewRule, StartTrigger, TeamId, WorkAssignment,
    store::{
        StoreFault,
        content::{ContentRef, ContentScope, ContentStore},
    },
};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Definition {
    graph: String,
    workflow_plan: String,
    run: String,
    title: String,
    nodes: Vec<Node>,
    edges: Vec<Edge>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HistoricalDefinition {
    graph: String,
    workflow_plan: String,
    run: String,
    title: String,
    nodes: Vec<HistoricalNode>,
    edges: Vec<Edge>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HistoricalNode {
    id: String,
    title: String,
    max_attempts: u32,
    configuration: Configuration,
}

fn read_text(
    scope: ContentScope<'_>,
    reference: &ContentRef,
    contents: &ContentStore,
) -> Result<String, StoreFault> {
    String::from_utf8(contents.read(scope, reference)?).map_err(|_| StoreFault::CorruptRecord)
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Node {
    id: String,
    title: String,
    rework_limits: BTreeMap<String, u32>,
    configuration: Configuration,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    approval_prompt: Option<ContentRef>,
}

#[derive(Serialize, Deserialize)]
enum Configuration {
    Start(Option<Trigger>),
    Work {
        task: String,
        role: String,
        session: String,
        prompt: ContentRef,
        artifact_kind: Option<String>,
    },
    Review {
        role: String,
        session: String,
        prompt: ContentRef,
    },
    Join,
    Control(Kind),
    ScriptReview(Rule),
}

#[derive(Serialize, Deserialize)]
enum Trigger {
    Webhook(String),
    Cron(String),
}

#[derive(Serialize, Deserialize)]
enum Kind {
    Start,
    Review,
    HumanDecision,
    ScriptReview,
    Join,
    End,
}

#[derive(Serialize, Deserialize)]
enum Rule {
    PassThrough,
    AssertAllUpstreamCompleted,
    AssertNoBlockingGate,
    AssertArtifactExists,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Edge {
    id: String,
    source: String,
    source_port: String,
    target: String,
    target_port: String,
    action: Action,
    include_upstream_result: bool,
    dependency: Option<(String, String)>,
}

#[derive(Serialize, Deserialize)]
enum Action {
    Activate,
    Rework,
    Gate,
    Finish,
}

pub(crate) fn encode_definition(
    team: &TeamId,
    scope_run: &GraphRunId,
    definition: &GraphDefinition,
    contents: &ContentStore,
) -> Result<Vec<u8>, StoreFault> {
    serde_json::to_vec(&build_definition(team, scope_run, definition, contents)?)
        .map_err(|_| StoreFault::InvalidFacts)
}

pub(super) fn build_definition(
    team: &TeamId,
    scope_run: &GraphRunId,
    definition: &GraphDefinition,
    contents: &ContentStore,
) -> Result<Definition, StoreFault> {
    let scope = ContentScope::Run {
        team,
        run: scope_run,
    };
    let nodes = definition
        .nodes()
        .iter()
        .map(|node| {
            let configuration = if let Some(rule) = node.script_review_rule() {
                Configuration::ScriptReview(match rule {
                    ScriptReviewRule::PassThrough => Rule::PassThrough,
                    ScriptReviewRule::AssertAllUpstreamCompleted => {
                        Rule::AssertAllUpstreamCompleted
                    }
                    ScriptReviewRule::AssertNoBlockingGate => Rule::AssertNoBlockingGate,
                    ScriptReviewRule::AssertArtifactExists => Rule::AssertArtifactExists,
                })
            } else if node.is_control() {
                Configuration::Control(match node.kind() {
                    NodeKind::Start => Kind::Start,
                    NodeKind::Review => Kind::Review,
                    NodeKind::HumanDecision => Kind::HumanDecision,
                    NodeKind::ScriptReview => Kind::ScriptReview,
                    NodeKind::Join => Kind::Join,
                    NodeKind::End => Kind::End,
                    NodeKind::Work => return Err(StoreFault::InvalidFacts),
                })
            } else {
                match node.kind() {
                    NodeKind::Start => {
                        Configuration::Start(node.trigger().map(|trigger| match trigger {
                            StartTrigger::Webhook { path } => Trigger::Webhook(path.clone()),
                            StartTrigger::Cron { expression } => Trigger::Cron(expression.clone()),
                        }))
                    }
                    NodeKind::Work => {
                        let work = node.work_assignment().ok_or(StoreFault::InvalidFacts)?;
                        Configuration::Work {
                            task: work.task_id().to_owned(),
                            role: work.role_id().to_owned(),
                            session: work.session_ref().as_str().to_owned(),
                            prompt: contents.put(scope, work.prompt().as_bytes())?,
                            artifact_kind: work.output_artifact_kind().map(str::to_owned),
                        }
                    }
                    NodeKind::Review => {
                        let review = node.review_assignment().ok_or(StoreFault::InvalidFacts)?;
                        Configuration::Review {
                            role: review.role_id().to_owned(),
                            session: review.session_ref().as_str().to_owned(),
                            prompt: contents.put(scope, review.prompt().as_bytes())?,
                        }
                    }
                    NodeKind::Join => Configuration::Join,
                    _ => return Err(StoreFault::InvalidFacts),
                }
            };
            Ok(Node {
                id: node.id().as_str().to_owned(),
                title: node.title().to_owned(),
                rework_limits: node.rework_limits().clone(),
                configuration,
                approval_prompt: node.approval_prompt()
                    .map(|prompt| contents.put(scope, prompt.as_bytes())).transpose()?,
            })
        })
        .collect::<Result<Vec<_>, StoreFault>>()?;
    let edges = definition
        .edges()
        .iter()
        .map(|edge| Edge {
            id: edge.id().as_str().to_owned(),
            source: edge.source_node_id().as_str().to_owned(),
            source_port: edge.source_port().to_owned(),
            target: edge.target_node_id().as_str().to_owned(),
            target_port: edge.target_port().to_owned(),
            action: match edge.action() {
                EdgeAction::Activate => Action::Activate,
                EdgeAction::Rework => Action::Rework,
                EdgeAction::Gate => Action::Gate,
                EdgeAction::Finish => Action::Finish,
            },
            include_upstream_result: edge.payload().include_upstream_result(),
            dependency: edge.dependency().map(|value| {
                (
                    value.dependency_task_id().to_owned(),
                    value.task_id().to_owned(),
                )
            }),
        })
        .collect();
    Ok(Definition {
        graph: definition.graph_id().to_owned(),
        workflow_plan: definition.workflow_plan_id().to_owned(),
        run: definition.run_id().as_str().to_owned(),
        title: definition.title().to_owned(),
        nodes,
        edges,
    })
}

pub(crate) fn decode_definition(
    team: &TeamId,
    scope_run: &GraphRunId,
    bytes: &[u8],
    contents: &ContentStore,
) -> Result<GraphDefinition, StoreFault> {
    let row: Definition = serde_json::from_slice(bytes).map_err(|_| StoreFault::CorruptRecord)?;
    restore_definition(row, team, scope_run, contents)
}

// This is an audit-only reader, never a canonical graph fallback.
pub(super) fn decode_historical_sqlite_definition(
    team: &TeamId,
    scope_run: &GraphRunId,
    bytes: &[u8],
    contents: &ContentStore,
) -> Result<GraphDefinition, StoreFault> {
    let row: HistoricalDefinition =
        serde_json::from_slice(bytes).map_err(|_| StoreFault::CorruptRecord)?;
    let nodes = row
        .nodes
        .into_iter()
        .map(|node| {
            if node.max_attempts == 0 {
                return Err(StoreFault::InvalidFacts);
            }
            let kind = match &node.configuration {
                Configuration::Start(_) => NodeKind::Start,
                Configuration::Work { .. } => NodeKind::Work,
                Configuration::Review { .. } => NodeKind::Review,
                Configuration::Join => NodeKind::Join,
                Configuration::ScriptReview(_) => NodeKind::ScriptReview,
                Configuration::Control(kind) => match kind {
                    Kind::Start => NodeKind::Start,
                    Kind::Review => NodeKind::Review,
                    Kind::HumanDecision => NodeKind::HumanDecision,
                    Kind::ScriptReview => NodeKind::ScriptReview,
                    Kind::Join => NodeKind::Join,
                    Kind::End => NodeKind::End,
                },
            };
            let rework_limits = kind
                .source_ports()
                .iter()
                .filter(|port| kind.accepts_edge_action(port.as_str(), EdgeAction::Rework))
                .map(|port| (port.as_str().to_owned(), 3))
                .collect();
            Ok(Node {
                id: node.id,
                title: node.title,
                rework_limits,
                configuration: node.configuration,
                approval_prompt: None,
            })
        })
        .collect::<Result<Vec<_>, StoreFault>>()?;
    restore_definition(
        Definition {
            graph: row.graph,
            workflow_plan: row.workflow_plan,
            run: row.run,
            title: row.title,
            nodes,
            edges: row.edges,
        },
        team,
        scope_run,
        contents,
    )
}

pub(super) fn restore_definition(
    row: Definition,
    team: &TeamId,
    scope_run: &GraphRunId,
    contents: &ContentStore,
) -> Result<GraphDefinition, StoreFault> {
    let scope = ContentScope::Run {
        team,
        run: scope_run,
    };
    let nodes = row
        .nodes
        .into_iter()
        .map(|node| {
            let id = NodeId::new(node.id);
            let approval_prompt = match (&node.configuration, node.approval_prompt) {
                (Configuration::Control(Kind::HumanDecision), Some(reference)) => {
                    Some(read_text(scope, &reference, contents)?)
                }
                (_, None) => None,
                _ => return Err(StoreFault::InvalidFacts),
            };
            let definition = match node.configuration {
                Configuration::Start(trigger) => NodeDefinition::start(
                    id,
                    node.title,
                    trigger.map(|value| match value {
                        Trigger::Webhook(path) => StartTrigger::Webhook { path },
                        Trigger::Cron(expression) => StartTrigger::Cron { expression },
                    }),
                ),
                Configuration::Work {
                    task,
                    role,
                    session,
                    prompt,
                    artifact_kind,
                } => NodeDefinition::work(
                    id,
                    node.title,
                    WorkAssignment::typed(
                        task,
                        read_text(scope, &prompt, contents)?,
                        executor(role, session)?,
                        artifact_kind,
                    ),
                ),
                Configuration::Review {
                    role,
                    session,
                    prompt,
                } => NodeDefinition::review(
                    id,
                    node.title,
                    ReviewAssignment::with_executor(
                        executor(role, session)?,
                        read_text(scope, &prompt, contents)?,
                    ),
                ),
                Configuration::Join => NodeDefinition::join(id, node.title),
                Configuration::Control(Kind::HumanDecision) => {
                    NodeDefinition::human_decision(id, node.title, approval_prompt)
                }
                Configuration::Control(kind) => NodeDefinition::control(
                    id,
                    match kind {
                        Kind::Start => NodeKind::Start,
                        Kind::Review => NodeKind::Review,
                        Kind::HumanDecision => NodeKind::HumanDecision,
                        Kind::ScriptReview => NodeKind::ScriptReview,
                        Kind::Join => NodeKind::Join,
                        Kind::End => NodeKind::End,
                    },
                    node.title,
                ),
                Configuration::ScriptReview(rule) => NodeDefinition::script_review(
                    id,
                    node.title,
                    match rule {
                        Rule::PassThrough => ScriptReviewRule::PassThrough,
                        Rule::AssertAllUpstreamCompleted => {
                            ScriptReviewRule::AssertAllUpstreamCompleted
                        }
                        Rule::AssertNoBlockingGate => ScriptReviewRule::AssertNoBlockingGate,
                        Rule::AssertArtifactExists => ScriptReviewRule::AssertArtifactExists,
                    },
                ),
            };
            if definition
                .rework_limits()
                .keys()
                .ne(node.rework_limits.keys())
            {
                return Err(StoreFault::InvalidFacts);
            }
            Ok(definition.with_rework_limits(node.rework_limits))
        })
        .collect::<Result<Vec<_>, StoreFault>>()?;
    let edges = row
        .edges
        .into_iter()
        .map(|edge| {
            EdgeDefinition::new(
                EdgeId::new(edge.id),
                NodeId::new(edge.source),
                edge.source_port,
                NodeId::new(edge.target),
                edge.target_port,
                match edge.action {
                    Action::Activate => EdgeAction::Activate,
                    Action::Rework => EdgeAction::Rework,
                    Action::Gate => EdgeAction::Gate,
                    Action::Finish => EdgeAction::Finish,
                },
            )
            .with_payload(EdgePayloadPolicy::new(edge.include_upstream_result))
            .with_dependency_opt(
                edge.dependency
                    .map(|(dependency, task)| DependencyMetadata::new(dependency, task)),
            )
        })
        .collect();
    // Audit commands may carry a different payload run; the enclosing canonical row checks identity.
    GraphDefinition::from_durable(
        row.graph,
        row.workflow_plan,
        GraphRunId::new(row.run),
        row.title,
        nodes,
        edges,
    )
    .map_err(|_| StoreFault::InvalidFacts)
}

fn executor(role: String, session: String) -> Result<ExecutorPolicy, StoreFault> {
    Ok(ExecutorPolicy::team_role_session(
        role,
        RoleSessionRef::try_new(session).map_err(|_| StoreFault::InvalidFacts)?,
    ))
}
