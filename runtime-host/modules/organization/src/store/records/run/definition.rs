use std::num::NonZeroU32;

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
struct Definition {
    graph: String,
    workflow_plan: String,
    run: String,
    title: String,
    nodes: Vec<Node>,
    edges: Vec<Edge>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Body {
    sha256: [u8; 32],
    byte_len: u64,
}

impl Body {
    fn put(
        scope: ContentScope<'_>,
        text: &str,
        contents: &ContentStore,
    ) -> Result<Self, StoreFault> {
        let reference = contents.put(scope, text.as_bytes())?;
        Ok(Self {
            sha256: reference.sha256,
            byte_len: reference.byte_len,
        })
    }

    fn read(self, scope: ContentScope<'_>, contents: &ContentStore) -> Result<String, StoreFault> {
        String::from_utf8(contents.read(
            scope,
            &ContentRef {
                sha256: self.sha256,
                byte_len: self.byte_len,
            },
        )?)
        .map_err(|_| StoreFault::CorruptRecord)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Node {
    id: String,
    title: String,
    max_attempts: u32,
    configuration: Configuration,
}

#[derive(Serialize, Deserialize)]
enum Configuration {
    Start(Option<Trigger>),
    Work {
        task: String,
        role: String,
        session: String,
        prompt: Body,
        artifact_kind: Option<String>,
    },
    Review {
        role: String,
        session: String,
        prompt: Body,
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
                            prompt: Body::put(scope, work.prompt(), contents)?,
                            artifact_kind: work.output_artifact_kind().map(str::to_owned),
                        }
                    }
                    NodeKind::Review => {
                        let review = node.review_assignment().ok_or(StoreFault::InvalidFacts)?;
                        Configuration::Review {
                            role: review.role_id().to_owned(),
                            session: review.session_ref().as_str().to_owned(),
                            prompt: Body::put(scope, review.prompt(), contents)?,
                        }
                    }
                    NodeKind::Join => Configuration::Join,
                    _ => return Err(StoreFault::InvalidFacts),
                }
            };
            Ok(Node {
                id: node.id().as_str().to_owned(),
                title: node.title().to_owned(),
                max_attempts: node.max_attempts().get(),
                configuration,
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
    serde_json::to_vec(&Definition {
        graph: definition.graph_id().to_owned(),
        workflow_plan: definition.workflow_plan_id().to_owned(),
        run: definition.run_id().as_str().to_owned(),
        title: definition.title().to_owned(),
        nodes,
        edges,
    })
    .map_err(|_| StoreFault::InvalidFacts)
}

pub(crate) fn decode_definition(
    team: &TeamId,
    scope_run: &GraphRunId,
    bytes: &[u8],
    contents: &ContentStore,
) -> Result<GraphDefinition, StoreFault> {
    let row: Definition = serde_json::from_slice(bytes).map_err(|_| StoreFault::CorruptRecord)?;
    let scope = ContentScope::Run {
        team,
        run: scope_run,
    };
    let nodes = row
        .nodes
        .into_iter()
        .map(|node| {
            let id = NodeId::new(node.id);
            let attempts = NonZeroU32::new(node.max_attempts).ok_or(StoreFault::InvalidFacts)?;
            Ok(match node.configuration {
                Configuration::Start(trigger) => NodeDefinition::start(
                    id,
                    node.title,
                    attempts,
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
                    attempts,
                    WorkAssignment::typed(
                        task,
                        prompt.read(scope, contents)?,
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
                    attempts,
                    ReviewAssignment::with_executor(
                        executor(role, session)?,
                        prompt.read(scope, contents)?,
                    ),
                ),
                Configuration::Join => NodeDefinition::join(id, node.title, attempts),
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
                    attempts,
                ),
                Configuration::ScriptReview(rule) => NodeDefinition::script_review(
                    id,
                    node.title,
                    attempts,
                    match rule {
                        Rule::PassThrough => ScriptReviewRule::PassThrough,
                        Rule::AssertAllUpstreamCompleted => {
                            ScriptReviewRule::AssertAllUpstreamCompleted
                        }
                        Rule::AssertNoBlockingGate => ScriptReviewRule::AssertNoBlockingGate,
                        Rule::AssertArtifactExists => ScriptReviewRule::AssertArtifactExists,
                    },
                ),
            })
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
