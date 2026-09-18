use std::fmt;

use crate::{
    ApprovalStatus, AttemptStatus, GraphRunId, GraphStatus, OrganizationFacts, TeamId,
    TeamRunQuery, TeamRunQueryOutcome, query_team_run,
};

const MAX_CONTEXT_NODES: usize = 64;
const MAX_CONTEXT_EDGES: usize = 128;
const MAX_CONTEXT_EVENTS: usize = 20;
const MAX_CONTEXT_APPROVALS: usize = 32;
const MAX_CONTEXT_IDENTIFIER_BYTES: usize = 128;
const MAX_CONTEXT_OUTPUT_PORT_BYTES: usize = 128;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamGraphContextView {
    CurrentNode,
    GraphSummary,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamGraphContextQuery {
    team: TeamId,
    run: GraphRunId,
    view: TeamGraphContextView,
    node_execution_id: Option<String>,
}

impl TeamGraphContextQuery {
    pub fn new(
        team: TeamId,
        run: GraphRunId,
        view: TeamGraphContextView,
        node_execution_id: Option<String>,
    ) -> Result<Self, TeamGraphContextQueryError> {
        if !is_bounded_context_value(team.as_str()) || !is_bounded_context_value(run.as_str()) {
            return Err(TeamGraphContextQueryError::InvalidContextIdentity);
        }
        if node_execution_id
            .as_ref()
            .is_some_and(|value| !is_safe_execution_id(value))
        {
            return Err(TeamGraphContextQueryError::InvalidNodeExecutionId);
        }
        if view == TeamGraphContextView::CurrentNode && node_execution_id.is_none() {
            return Err(TeamGraphContextQueryError::NodeExecutionIdRequired);
        }
        Ok(Self {
            team,
            run,
            view,
            node_execution_id,
        })
    }

    pub fn team(&self) -> &TeamId {
        &self.team
    }

    pub fn run(&self) -> &GraphRunId {
        &self.run
    }

    pub const fn view(&self) -> TeamGraphContextView {
        self.view
    }

    pub fn node_execution_id(&self) -> Option<&str> {
        self.node_execution_id.as_deref()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamGraphContextQueryError {
    NodeExecutionIdRequired,
    InvalidNodeExecutionId,
    InvalidContextIdentity,
}

#[derive(Clone, Eq, PartialEq)]
pub struct TeamGraphContext {
    team: TeamId,
    run: GraphRunId,
    graph_status: GraphStatus,
    nodes: Vec<ContextNode>,
    edges: Vec<ContextEdge>,
    pending_approval_ids: Vec<String>,
    recent_event_ids: Vec<String>,
}

impl TeamGraphContext {
    pub fn team(&self) -> &TeamId {
        &self.team
    }

    pub fn run(&self) -> &GraphRunId {
        &self.run
    }

    pub const fn graph_status(&self) -> GraphStatus {
        self.graph_status
    }

    pub fn nodes(&self) -> &[ContextNode] {
        &self.nodes
    }

    pub fn edges(&self) -> &[ContextEdge] {
        &self.edges
    }

    pub fn pending_approval_ids(&self) -> &[String] {
        &self.pending_approval_ids
    }

    pub fn recent_event_ids(&self) -> &[String] {
        &self.recent_event_ids
    }
}

impl fmt::Debug for TeamGraphContext {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TeamGraphContext")
            .field("team", &self.team)
            .field("run", &self.run)
            .field("graph_status", &self.graph_status)
            .field("nodes", &self.nodes)
            .field("edges", &self.edges)
            .field("pending_approval_count", &self.pending_approval_ids.len())
            .field("recent_event_count", &self.recent_event_ids.len())
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContextNode {
    node_id: String,
    node_execution_id: String,
    status: AttemptStatus,
    output_port: Option<String>,
}

impl ContextNode {
    pub fn node_id(&self) -> &str {
        &self.node_id
    }

    pub fn node_execution_id(&self) -> &str {
        &self.node_execution_id
    }

    pub const fn status(&self) -> AttemptStatus {
        self.status
    }

    pub fn output_port(&self) -> Option<&str> {
        self.output_port.as_deref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContextEdge {
    edge_id: String,
    source_node_id: String,
    target_node_id: String,
}

impl ContextEdge {
    pub fn edge_id(&self) -> &str {
        &self.edge_id
    }

    pub fn source_node_id(&self) -> &str {
        &self.source_node_id
    }

    pub fn target_node_id(&self) -> &str {
        &self.target_node_id
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TeamGraphContextResult {
    Available(TeamGraphContext),
    Unavailable,
    OutcomeUnknown,
}

pub fn query_team_graph_context(
    facts: &OrganizationFacts,
    query: &TeamGraphContextQuery,
) -> TeamGraphContextResult {
    match query_team_run(
        facts,
        &TeamRunQuery::get(query.team.clone(), query.run.clone()),
    ) {
        TeamRunQueryOutcome::Unavailable => return TeamGraphContextResult::Unavailable,
        TeamRunQueryOutcome::OutcomeUnknown => return TeamGraphContextResult::OutcomeUnknown,
        TeamRunQueryOutcome::Available(_) => {}
    }
    let Some(run) = facts.run(&query.run) else {
        return TeamGraphContextResult::Unavailable;
    };
    if run.team() != query.team() || run.run_id() != query.run() {
        return TeamGraphContextResult::Unavailable;
    }
    let graph = run.graph();
    let selected = |node: &crate::NodeDefinition| {
        query.view == TeamGraphContextView::GraphSummary
            || query.node_execution_id().is_some_and(|execution_id| {
                graph.current_attempt(node.id()).is_some_and(|attempt| {
                    attempt.fence().node_execution_id().as_str() == execution_id
                })
            })
    };
    let nodes = graph
        .definition()
        .nodes()
        .iter()
        .filter(|node| selected(node))
        .filter(|node| is_safe_context_identifier(node.id().as_str()))
        .filter_map(|node| {
            let attempt = graph.current_attempt(node.id())?;
            let node_execution_id = attempt.fence().node_execution_id().as_str();
            is_safe_context_identifier(node_execution_id).then(|| ContextNode {
                node_id: node.id().as_str().to_owned(),
                node_execution_id: node_execution_id.to_owned(),
                status: attempt.status(),
                output_port: attempt
                    .output_port()
                    .filter(|value| is_safe_context_output_port(value))
                    .map(ToOwned::to_owned),
            })
        })
        .take(MAX_CONTEXT_NODES)
        .collect::<Vec<_>>();
    if query.view == TeamGraphContextView::CurrentNode && nodes.is_empty() {
        return TeamGraphContextResult::Unavailable;
    }
    let selected_ids = nodes.iter().map(|node| node.node_id()).collect::<Vec<_>>();
    let edges = graph
        .definition()
        .edges()
        .iter()
        .filter(|edge| {
            query.view == TeamGraphContextView::GraphSummary
                || selected_ids.iter().any(|id| {
                    edge.source_node_id().as_str() == *id || edge.target_node_id().as_str() == *id
                })
        })
        .filter(|edge| {
            is_safe_context_identifier(edge.id().as_str())
                && is_safe_context_identifier(edge.source_node_id().as_str())
                && is_safe_context_identifier(edge.target_node_id().as_str())
        })
        .take(MAX_CONTEXT_EDGES)
        .map(|edge| ContextEdge {
            edge_id: edge.id().as_str().to_owned(),
            source_node_id: edge.source_node_id().as_str().to_owned(),
            target_node_id: edge.target_node_id().as_str().to_owned(),
        })
        .collect();
    let pending_approval_ids = facts
        .approvals()
        .filter(|approval| {
            approval.facts().run_id == query.run.as_str()
                && approval.status() == ApprovalStatus::Pending
                && is_safe_context_identifier(&approval.facts().approval_id)
        })
        .take(MAX_CONTEXT_APPROVALS)
        .map(|approval| approval.facts().approval_id.clone())
        .collect();
    let mut recent_event_ids = facts
        .events_for_run(query.run.as_str())
        .into_iter()
        .rev()
        .filter(|event| is_safe_context_identifier(event.event_id()))
        .take(MAX_CONTEXT_EVENTS)
        .map(|event| event.event_id().to_owned())
        .collect::<Vec<_>>();
    recent_event_ids.reverse();

    TeamGraphContextResult::Available(TeamGraphContext {
        team: query.team.clone(),
        run: query.run.clone(),
        graph_status: crate::project(graph).status,
        nodes,
        edges,
        pending_approval_ids,
        recent_event_ids,
    })
}

fn is_safe_execution_id(value: &str) -> bool {
    is_safe_context_identifier(value)
}

fn is_bounded_context_value(value: &str) -> bool {
    is_safe_context_identifier(value)
}

fn is_safe_context_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_CONTEXT_IDENTIFIER_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b':'))
}

fn is_safe_context_output_port(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_CONTEXT_OUTPUT_PORT_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_graphic() && !matches!(byte, b'/' | b'\\'))
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroU32;

    use crate::{
        GraphDefinition, GraphRunFacts, GraphState, ManagedAgentReference, MaterializationReceipt,
        MemberId, NodeDefinition, NodeId, OrganizationFacts, RoleAssignment, RoleId, RoleKind,
        RoleMaterializationReceipt, RoleSessionReceipt, RunRuntimeReceipt,
        RuntimeEndpointReference, TeamDefinition, TeamFacts, TeamMember, TeamRevision, TeamRole,
    };

    use super::*;

    const PRIVATE_AGENT: &str = "private-agent-token";
    const PRIVATE_ENDPOINT: &str = "private-runtime-endpoint";
    const PRIVATE_GRAPH_TITLE: &str = "private prompt must not project";
    const PRIVATE_NODE_TITLE: &str = "private node title must not project";

    fn team_definition() -> TeamDefinition {
        let member =
            TeamMember::try_new(MemberId::try_new("member:leader").unwrap(), "Leader").unwrap();
        let role = TeamRole::try_new(
            RoleId::try_new("leader").unwrap(),
            "Leader",
            RoleKind::Leader,
        )
        .unwrap();
        TeamDefinition::try_new(
            TeamId::try_new("team:one").unwrap(),
            "Test team",
            vec![member.clone()],
            vec![role.clone()],
            vec![RoleAssignment::new(
                member.member_id().clone(),
                role.role_id().clone(),
            )],
        )
        .unwrap()
    }

    fn facts() -> OrganizationFacts {
        let endpoint = RuntimeEndpointReference::try_new(PRIVATE_ENDPOINT).unwrap();
        let team = TeamId::try_new("team:one").unwrap();
        let run = GraphRunId::new("run:one");
        let role = RoleId::try_new("leader").unwrap();
        let agent = ManagedAgentReference::try_new(PRIVATE_AGENT).unwrap();
        let materialization = MaterializationReceipt::try_new(
            team.clone(),
            endpoint.clone(),
            vec![RoleMaterializationReceipt::new(
                role.clone(),
                agent.clone(),
                endpoint.clone(),
            )],
        )
        .unwrap();
        let runtime = RunRuntimeReceipt::try_new(
            run.clone(),
            vec![RoleSessionReceipt::with_endpoint_session_id(
                team.clone(),
                run.clone(),
                role,
                crate::RoleSessionRef::initial(),
                crate::EndpointSessionId::try_new("tr-one-leader-rs0").unwrap(),
                agent,
                endpoint,
            )],
        )
        .unwrap();
        OrganizationFacts::restore(
            [TeamFacts::new(
                team_definition(),
                TeamRevision::initial(),
                false,
            )],
            [materialization],
            [GraphRunFacts::new(
                team,
                TeamRevision::initial(),
                GraphState::initialize(
                    GraphDefinition::new(
                        "graph:one",
                        "plan:one",
                        run,
                        PRIVATE_GRAPH_TITLE,
                        vec![NodeDefinition::control(
                            NodeId::new("node:one"),
                            crate::NodeKind::End,
                            PRIVATE_NODE_TITLE,
                            NonZeroU32::new(1).unwrap(),
                        )],
                        Vec::new(),
                    )
                    .unwrap(),
                    1,
                ),
                Some(runtime),
            )
            .unwrap()],
            crate::DeliveryLedgerSnapshot::new(Vec::new()),
        )
        .unwrap()
    }

    #[test]
    fn rejects_untrusted_current_node_identifiers() {
        assert_eq!(
            TeamGraphContextQuery::new(
                TeamId::try_new("team:one").unwrap(),
                GraphRunId::new("run:one"),
                TeamGraphContextView::CurrentNode,
                Some("../private".to_owned()),
            ),
            Err(TeamGraphContextQueryError::InvalidNodeExecutionId)
        );
    }

    #[test]
    fn current_node_view_selects_only_the_matching_execution() {
        let result = query_team_graph_context(
            &facts(),
            &TeamGraphContextQuery::new(
                TeamId::try_new("team:one").unwrap(),
                GraphRunId::new("run:one"),
                TeamGraphContextView::CurrentNode,
                Some("node:one:attempt:1".to_owned()),
            )
            .unwrap(),
        );

        let TeamGraphContextResult::Available(context) = result else {
            panic!("expected an available graph context");
        };
        assert_eq!(context.nodes().len(), 1);
        assert_eq!(context.nodes()[0].node_execution_id(), "node:one:attempt:1");
    }

    #[test]
    fn current_node_view_is_unavailable_when_execution_is_not_current() {
        assert_eq!(
            query_team_graph_context(
                &facts(),
                &TeamGraphContextQuery::new(
                    TeamId::try_new("team:one").unwrap(),
                    GraphRunId::new("run:one"),
                    TeamGraphContextView::CurrentNode,
                    Some("node:one:attempt:2".to_owned()),
                )
                .unwrap(),
            ),
            TeamGraphContextResult::Unavailable
        );
    }

    #[test]
    fn unavailable_and_unknown_team_runs_preserve_query_outcomes() {
        let unavailable = OrganizationFacts::restore(
            [TeamFacts::new(
                team_definition(),
                TeamRevision::initial(),
                false,
            )],
            [],
            [GraphRunFacts::new(
                TeamId::try_new("team:one").unwrap(),
                TeamRevision::initial(),
                GraphState::initialize(
                    GraphDefinition::new(
                        "graph:one",
                        "plan:one",
                        GraphRunId::new("run:one"),
                        "private title",
                        vec![NodeDefinition::control(
                            NodeId::new("node:one"),
                            crate::NodeKind::End,
                            "private node",
                            NonZeroU32::new(1).unwrap(),
                        )],
                        Vec::new(),
                    )
                    .unwrap(),
                    1,
                ),
                None,
            )
            .unwrap()],
            crate::DeliveryLedgerSnapshot::new(Vec::new()),
        )
        .unwrap();
        let query = TeamGraphContextQuery::new(
            TeamId::try_new("team:one").unwrap(),
            GraphRunId::new("run:one"),
            TeamGraphContextView::GraphSummary,
            None,
        )
        .unwrap();
        assert_eq!(
            query_team_graph_context(&unavailable, &query),
            TeamGraphContextResult::Unavailable
        );

        let unknown = OrganizationFacts::restore(
            [TeamFacts::new(
                team_definition(),
                TeamRevision::initial(),
                false,
            )],
            [MaterializationReceipt::try_new(
                TeamId::try_new("team:one").unwrap(),
                RuntimeEndpointReference::try_new(PRIVATE_ENDPOINT).unwrap(),
                vec![RoleMaterializationReceipt::new(
                    RoleId::try_new("leader").unwrap(),
                    ManagedAgentReference::try_new(PRIVATE_AGENT).unwrap(),
                    RuntimeEndpointReference::try_new(PRIVATE_ENDPOINT).unwrap(),
                )],
            )
            .unwrap()],
            [GraphRunFacts::new(
                TeamId::try_new("team:one").unwrap(),
                TeamRevision::initial(),
                GraphState::initialize(
                    GraphDefinition::new(
                        "graph:one",
                        "plan:one",
                        GraphRunId::new("run:one"),
                        "private title",
                        vec![NodeDefinition::control(
                            NodeId::new("node:one"),
                            crate::NodeKind::End,
                            "private node",
                            NonZeroU32::new(1).unwrap(),
                        )],
                        Vec::new(),
                    )
                    .unwrap(),
                    1,
                ),
                None,
            )
            .unwrap()],
            crate::DeliveryLedgerSnapshot::new(Vec::new()),
        )
        .unwrap();
        assert_eq!(
            query_team_graph_context(&unknown, &query),
            TeamGraphContextResult::OutcomeUnknown
        );
    }

    #[test]
    fn query_does_not_project_titles_or_workspace_like_values() {
        let result = query_team_graph_context(
            &facts(),
            &TeamGraphContextQuery::new(
                TeamId::try_new("team:one").unwrap(),
                GraphRunId::new("run:one"),
                TeamGraphContextView::GraphSummary,
                None,
            )
            .unwrap(),
        );

        let TeamGraphContextResult::Available(context) = result else {
            panic!("expected an available graph context");
        };
        assert_eq!(context.nodes().len(), 1);
        assert_eq!(context.nodes()[0].node_id(), "node:one");
        assert_eq!(context.nodes()[0].node_execution_id(), "node:one:attempt:1");
        assert_eq!(context.nodes()[0].status(), AttemptStatus::Ready);
        assert_eq!(context.nodes()[0].output_port(), None);
        let debug = format!("{context:?}");
        for private in [
            PRIVATE_AGENT,
            PRIVATE_ENDPOINT,
            PRIVATE_GRAPH_TITLE,
            PRIVATE_NODE_TITLE,
        ] {
            assert!(!debug.contains(private));
        }
    }
}
