use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
};

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct GraphRunId(String);

impl GraphRunId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct NodeId(String);

impl NodeId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct EdgeId(String);

impl EdgeId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NodeKind {
    Start,
    Work,
    Review,
    HumanDecision,
    ScriptReview,
    Join,
    End,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeOutputPort {
    Completed,
    Rework,
    Approved,
    Rejected,
    Aborted,
    Passed,
    Failed,
    Joined,
}

impl NodeOutputPort {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Rework => "rework",
            Self::Approved => "approved",
            Self::Rejected => "rejected",
            Self::Aborted => "aborted",
            Self::Passed => "passed",
            Self::Failed => "failed",
            Self::Joined => "joined",
        }
    }
}

impl NodeKind {
    pub const fn source_ports(self) -> &'static [NodeOutputPort] {
        use NodeOutputPort::*;
        match self {
            Self::Start | Self::Work => &[Completed],
            Self::Review => &[Completed, Rework],
            Self::HumanDecision => &[Approved, Rejected, Aborted],
            Self::ScriptReview => &[Passed, Failed],
            Self::Join => &[Joined],
            Self::End => &[],
        }
    }

    pub const fn target_ports(self) -> &'static [&'static str] {
        match self {
            Self::Start => &[],
            _ => &["input"],
        }
    }

    pub fn resolve_source_port(self, supplied: Option<&str>) -> Option<&'static str> {
        match supplied {
            Some(supplied) => self.source_ports().iter().map(|port| port.as_str()).find(|port| *port == supplied),
            None => match self.source_ports() {
                [port] => Some(port.as_str()),
                _ => None,
            },
        }
    }

    pub fn resolve_target_port(self, supplied: Option<&str>) -> Option<&'static str> {
        match supplied {
            Some(supplied) => self.target_ports().iter().copied().find(|port| *port == supplied),
            None => match self.target_ports() {
                [port] => Some(*port),
                _ => None,
            },
        }
    }

    pub fn source_port_actions(self, port: &str) -> &'static [EdgeAction] {
        use EdgeAction::*;
        if self.resolve_source_port(Some(port)).is_none() {
            return &[];
        }
        match (self, port) {
            (Self::Review, "rework") => &[Rework],
            (Self::HumanDecision, "rejected" | "aborted") | (Self::ScriptReview, "failed") => {
                &[Activate, Rework, Gate, Finish]
            }
            _ => &[Activate, Gate, Finish],
        }
    }

    pub fn accepts_edge_action(self, port: &str, action: EdgeAction) -> bool {
        self.source_port_actions(port).contains(&action)
    }

    pub fn accepts_completed_output(self, port: &str) -> bool {
        self.resolve_source_port(Some(port)).is_some()
            || (self == Self::End && port == NodeOutputPort::Completed.as_str())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EdgeAction {
    Activate,
    Rework,
    Gate,
    Finish,
}

impl EdgeAction {
    pub(crate) fn activates_target(self) -> bool {
        matches!(self, Self::Activate | Self::Gate | Self::Finish)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StartTrigger {
    Webhook { path: String },
    Cron { expression: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExecutorPolicy {
    TeamRole {
        role_id: String,
        session_ref: crate::RoleSessionRef,
    },
}

impl ExecutorPolicy {
    pub fn team_role(role_id: impl Into<String>) -> Self {
        Self::team_role_session(role_id, crate::RoleSessionRef::initial())
    }

    pub fn team_role_session(
        role_id: impl Into<String>,
        session_ref: crate::RoleSessionRef,
    ) -> Self {
        Self::TeamRole {
            role_id: role_id.into(),
            session_ref,
        }
    }

    pub fn role_id(&self) -> &str {
        match self {
            Self::TeamRole { role_id, .. } => role_id,
        }
    }

    pub fn session_ref(&self) -> &crate::RoleSessionRef {
        match self {
            Self::TeamRole { session_ref, .. } => session_ref,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkAssignment {
    task_id: String,
    prompt: String,
    executor: ExecutorPolicy,
    output_artifact_kind: Option<String>,
}

impl WorkAssignment {
    pub fn new(task_id: impl Into<String>, role_id: impl Into<String>) -> Self {
        Self::typed(
            task_id,
            String::new(),
            ExecutorPolicy::team_role(role_id),
            None,
        )
    }

    pub fn typed(
        task_id: impl Into<String>,
        prompt: impl Into<String>,
        executor: ExecutorPolicy,
        output_artifact_kind: Option<String>,
    ) -> Self {
        Self {
            task_id: task_id.into(),
            prompt: prompt.into(),
            executor,
            output_artifact_kind,
        }
    }

    pub fn task_id(&self) -> &str {
        &self.task_id
    }

    pub fn prompt(&self) -> &str {
        &self.prompt
    }

    pub fn executor(&self) -> &ExecutorPolicy {
        &self.executor
    }

    pub fn role_id(&self) -> &str {
        self.executor.role_id()
    }

    pub fn session_ref(&self) -> &crate::RoleSessionRef {
        self.executor.session_ref()
    }

    pub fn output_artifact_kind(&self) -> Option<&str> {
        self.output_artifact_kind.as_deref()
    }

}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReviewAssignment {
    executor: ExecutorPolicy,
    prompt: String,
}

impl ReviewAssignment {
    pub fn new(role_id: impl Into<String>, prompt: impl Into<String>) -> Self {
        Self::with_executor(ExecutorPolicy::team_role(role_id), prompt)
    }

    pub fn with_executor(executor: ExecutorPolicy, prompt: impl Into<String>) -> Self {
        Self {
            executor,
            prompt: prompt.into(),
        }
    }

    pub fn executor(&self) -> &ExecutorPolicy {
        &self.executor
    }

    pub fn role_id(&self) -> &str {
        self.executor.role_id()
    }

    pub fn session_ref(&self) -> &crate::RoleSessionRef {
        self.executor.session_ref()
    }

    pub fn prompt(&self) -> &str {
        &self.prompt
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EdgePayloadPolicy {
    include_upstream_result: bool,
}

impl EdgePayloadPolicy {
    pub const fn new(include_upstream_result: bool) -> Self {
        Self {
            include_upstream_result,
        }
    }

    pub const fn include_upstream_result(&self) -> bool {
        self.include_upstream_result
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DependencyMetadata {
    dependency_task_id: String,
    task_id: String,
}

impl DependencyMetadata {
    pub fn new(dependency_task_id: impl Into<String>, task_id: impl Into<String>) -> Self {
        Self {
            dependency_task_id: dependency_task_id.into(),
            task_id: task_id.into(),
        }
    }

    pub fn dependency_task_id(&self) -> &str {
        &self.dependency_task_id
    }

    pub fn task_id(&self) -> &str {
        &self.task_id
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum NodeConfiguration {
    Start(Option<StartTrigger>),
    Work(WorkAssignment),
    Review(ReviewAssignment),
    Join,
    // Retains the original control encoding, including editable values rejected by validation.
    Control(NodeKind),
    HumanDecision(String),
    ScriptReview(crate::ScriptReviewRule),
}

impl NodeConfiguration {
    fn kind(&self) -> NodeKind {
        match self {
            Self::Start(_) => NodeKind::Start,
            Self::Work(_) => NodeKind::Work,
            Self::Review(_) => NodeKind::Review,
            Self::Join => NodeKind::Join,
            Self::Control(kind) => *kind,
            Self::HumanDecision(_) => NodeKind::HumanDecision,
            Self::ScriptReview(_) => NodeKind::ScriptReview,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NodeDefinition {
    id: NodeId,
    title: String,
    rework_limits: BTreeMap<String, u32>,
    configuration: NodeConfiguration,
}

impl NodeDefinition {
    fn new(id: NodeId, title: impl Into<String>, configuration: NodeConfiguration) -> Self {
        Self {
            id,
            title: title.into(),
            rework_limits: default_rework_limits(configuration.kind()),
            configuration,
        }
    }

    pub fn start(
        id: NodeId,
        title: impl Into<String>,
        trigger: Option<StartTrigger>,
    ) -> Self {
        Self::new(id, title, NodeConfiguration::Start(trigger))
    }

    pub fn control(
        id: NodeId,
        kind: NodeKind,
        title: impl Into<String>,
    ) -> Self {
        Self::new(id, title, NodeConfiguration::Control(kind))
    }

    pub fn human_decision(
        id: NodeId,
        title: impl Into<String>,
        prompt: Option<String>,
    ) -> Self {
        let configuration = match prompt.filter(|prompt| !prompt.trim().is_empty()) {
            Some(prompt) => NodeConfiguration::HumanDecision(prompt),
            None => NodeConfiguration::Control(NodeKind::HumanDecision),
        };
        Self::new(id, title, configuration)
    }

    pub fn approval_prompt(&self) -> Option<&str> {
        match &self.configuration {
            NodeConfiguration::HumanDecision(prompt) => Some(prompt),
            _ => None,
        }
    }

    pub fn script_review(
        id: NodeId,
        title: impl Into<String>,
        rule: crate::ScriptReviewRule,
    ) -> Self {
        Self::new(id, title, NodeConfiguration::ScriptReview(rule))
    }

    pub fn script_review_rule(&self) -> Option<crate::ScriptReviewRule> {
        match &self.configuration {
            NodeConfiguration::ScriptReview(rule) => Some(*rule),
            _ => None,
        }
    }

    pub fn work(
        id: NodeId,
        title: impl Into<String>,
        assignment: WorkAssignment,
    ) -> Self {
        Self::new(id, title, NodeConfiguration::Work(assignment))
    }

    pub fn review(
        id: NodeId,
        title: impl Into<String>,
        assignment: ReviewAssignment,
    ) -> Self {
        Self::new(id, title, NodeConfiguration::Review(assignment))
    }

    pub fn join(
        id: NodeId,
        title: impl Into<String>,
    ) -> Self {
        Self::new(id, title, NodeConfiguration::Join)
    }

    pub fn id(&self) -> &NodeId {
        &self.id
    }

    pub fn kind(&self) -> NodeKind {
        self.configuration.kind()
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn rework_limits(&self) -> &BTreeMap<String, u32> {
        &self.rework_limits
    }

    pub fn rework_limit(&self, port: &str) -> Option<u32> {
        self.rework_limits.get(port).copied()
    }

    pub fn with_rework_limits(mut self, limits: BTreeMap<String, u32>) -> Self {
        self.rework_limits.extend(limits);
        self
    }

    pub(super) fn set_rework_limit(&mut self, port: String, max_reworks: u32) {
        self.rework_limits.insert(port, max_reworks);
    }

    pub fn is_control(&self) -> bool {
        matches!(self.configuration, NodeConfiguration::Control(_) | NodeConfiguration::HumanDecision(_) | NodeConfiguration::ScriptReview(_))
    }

    pub fn trigger(&self) -> Option<&StartTrigger> {
        match &self.configuration {
            NodeConfiguration::Start(trigger) => trigger.as_ref(),
            _ => None,
        }
    }

    pub fn work_assignment(&self) -> Option<&WorkAssignment> {
        match &self.configuration {
            NodeConfiguration::Work(work) => Some(work),
            _ => None,
        }
    }

    pub fn review_assignment(&self) -> Option<&ReviewAssignment> {
        match &self.configuration {
            NodeConfiguration::Review(review) => Some(review),
            _ => None,
        }
    }

    pub(crate) fn set_agent_prompt(&mut self, prompt: String) -> bool {
        match &mut self.configuration {
            NodeConfiguration::Work(work) => work.prompt = prompt,
            NodeConfiguration::Review(review) => review.prompt = prompt,
            _ => return false,
        }
        true
    }

    pub(crate) fn is_armed_start(&self) -> bool {
        matches!(self.configuration, NodeConfiguration::Start(Some(_)))
    }

    pub(super) fn validate_assignment(&self) -> Result<(), DefinitionError> {
        match &self.configuration {
            NodeConfiguration::Work(work)
                if work.task_id.trim().is_empty() || work.role_id().trim().is_empty() =>
            {
                Err(DefinitionError::InvalidWorkAssignment(self.id.clone()))
            }
            NodeConfiguration::Control(NodeKind::Work) => {
                Err(DefinitionError::InvalidWorkAssignment(self.id.clone()))
            }
            NodeConfiguration::Review(review)
                if review.role_id().trim().is_empty() || review.prompt.trim().is_empty() =>
            {
                Err(DefinitionError::InvalidReviewAssignment(self.id.clone()))
            }
            _ => Ok(()),
        }
    }
}

fn default_rework_limits(kind: NodeKind) -> BTreeMap<String, u32> {
    kind.source_ports().iter().map(|port| port.as_str())
        .filter(|port| kind.accepts_edge_action(port, EdgeAction::Rework))
        .map(|port| (port.to_owned(), 3))
        .collect()
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EdgeDefinition {
    id: EdgeId,
    source_node_id: NodeId,
    source_port: String,
    target_node_id: NodeId,
    target_port: String,
    action: EdgeAction,
    payload: EdgePayloadPolicy,
    dependency: Option<DependencyMetadata>,
}

impl EdgeDefinition {
    pub fn new(
        id: EdgeId,
        source_node_id: NodeId,
        source_port: impl Into<String>,
        target_node_id: NodeId,
        target_port: impl Into<String>,
        action: EdgeAction,
    ) -> Self {
        Self {
            id,
            source_node_id,
            source_port: source_port.into(),
            target_node_id,
            target_port: target_port.into(),
            action,
            payload: EdgePayloadPolicy::new(true),
            dependency: None,
        }
    }

    pub fn with_dependency(mut self, dependency: DependencyMetadata) -> Self {
        self.dependency = Some(dependency);
        self
    }

    pub fn with_dependency_opt(mut self, dependency: Option<DependencyMetadata>) -> Self {
        self.dependency = dependency;
        self
    }

    pub fn with_payload(mut self, payload: EdgePayloadPolicy) -> Self {
        self.payload = payload;
        self
    }

    pub fn id(&self) -> &EdgeId {
        &self.id
    }

    pub fn source_node_id(&self) -> &NodeId {
        &self.source_node_id
    }

    pub fn source_port(&self) -> &str {
        &self.source_port
    }

    pub fn target_node_id(&self) -> &NodeId {
        &self.target_node_id
    }

    pub fn target_port(&self) -> &str {
        &self.target_port
    }

    pub fn action(&self) -> EdgeAction {
        self.action
    }

    pub const fn payload(&self) -> EdgePayloadPolicy {
        self.payload
    }

    pub fn dependency(&self) -> Option<&DependencyMetadata> {
        self.dependency.as_ref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GraphDefinition {
    graph_id: String,
    workflow_plan_id: String,
    run_id: GraphRunId,
    title: String,
    nodes: Vec<NodeDefinition>,
    edges: Vec<EdgeDefinition>,
}

impl GraphDefinition {
    pub fn new(
        graph_id: impl Into<String>,
        workflow_plan_id: impl Into<String>,
        run_id: GraphRunId,
        title: impl Into<String>,
        nodes: Vec<NodeDefinition>,
        edges: Vec<EdgeDefinition>,
    ) -> Result<Self, DefinitionError> {
        let definition = Self::from_durable(graph_id, workflow_plan_id, run_id, title, nodes, edges)?;
        definition.validate_ports()?;
        definition.validate_node_configuration()?;
        Ok(definition)
    }

    pub(crate) fn from_durable(
        graph_id: impl Into<String>,
        workflow_plan_id: impl Into<String>,
        run_id: GraphRunId,
        title: impl Into<String>,
        nodes: Vec<NodeDefinition>,
        edges: Vec<EdgeDefinition>,
    ) -> Result<Self, DefinitionError> {
        let definition = Self {
            graph_id: graph_id.into(),
            workflow_plan_id: workflow_plan_id.into(),
            run_id,
            title: title.into(),
            nodes,
            edges,
        };
        definition.validate_structure()?;
        Ok(definition)
    }

    pub fn graph_id(&self) -> &str {
        &self.graph_id
    }

    pub fn workflow_plan_id(&self) -> &str {
        &self.workflow_plan_id
    }

    pub fn run_id(&self) -> &GraphRunId {
        &self.run_id
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn nodes(&self) -> &[NodeDefinition] {
        &self.nodes
    }

    pub fn edges(&self) -> &[EdgeDefinition] {
        &self.edges
    }

    pub fn node(&self, id: &NodeId) -> Option<&NodeDefinition> {
        self.nodes.iter().find(|node| node.id == *id)
    }

    pub fn incoming_edges(&self, target: &NodeId) -> impl Iterator<Item = &EdgeDefinition> {
        self.edges
            .iter()
            .filter(move |edge| edge.target_node_id == *target)
    }

    pub fn outgoing_edges(&self, source: &NodeId) -> impl Iterator<Item = &EdgeDefinition> {
        self.edges
            .iter()
            .filter(move |edge| edge.source_node_id == *source)
    }

    pub fn execution_root_ids(&self) -> Vec<NodeId> {
        self.nodes
            .iter()
            .filter(|node| {
                node.kind() != NodeKind::Join && !self
                    .incoming_edges(&node.id)
                    .any(|edge| edge.action.activates_target())
            })
            .map(|node| node.id.clone())
            .collect()
    }

    pub(crate) fn reachable_from(&self, source: &NodeId) -> BTreeSet<NodeId> {
        let mut reachable = BTreeSet::new();
        let mut pending = VecDeque::from([source.clone()]);
        while let Some(current) = pending.pop_front() {
            for edge in self.outgoing_edges(&current) {
                if reachable.insert(edge.target_node_id.clone()) {
                    pending.push_back(edge.target_node_id.clone());
                }
            }
        }
        reachable.remove(source);
        reachable
    }

    pub fn validate(&self) -> Result<(), DefinitionError> {
        self.validate_structure()?;
        self.validate_ports()?;
        self.validate_node_configuration()
    }

    pub fn validate_node_configuration(&self) -> Result<(), DefinitionError> {
        for node in &self.nodes {
            match &node.configuration {
                NodeConfiguration::Control(NodeKind::Review) => {
                    return Err(DefinitionError::InvalidReviewAssignment(node.id().clone()));
                }
                NodeConfiguration::Control(NodeKind::ScriptReview) => {
                    return Err(DefinitionError::MissingScriptReviewRule(node.id().clone()));
                }
                NodeConfiguration::Start(Some(StartTrigger::Cron { expression })) => {
                    crate::run::scheduler::validate_cron_expression(expression)
                        .map_err(|_| DefinitionError::InvalidStartCronExpression(node.id().clone()))?;
                }
                _ => {}
            }
        }
        self.validate_trigger_batches()?;
        Ok(())
    }

    fn validate_trigger_batches(&self) -> Result<(), DefinitionError> {
        let mut sources = self.nodes.iter().map(|node| (node.id().clone(), BTreeSet::<NodeId>::new()))
            .collect::<BTreeMap<_, _>>();
        let roots = self.execution_root_ids();
        let initial_source = roots.iter().find(|id| self.node(id).is_some_and(|node| !node.is_armed_start()));
        for root in &roots {
            let source = if self.node(root).is_some_and(|node| node.is_armed_start()) {
                root
            } else {
                initial_source.expect("ordinary root has initial source")
            };
            let mut reachable = self.reachable_from(root);
            reachable.insert(root.clone());
            for id in reachable { sources.get_mut(&id).expect("reachable node exists").insert(source.clone()); }
        }
        for node in &self.nodes {
            let mut inputs = self.incoming_edges(node.id()).filter(|edge| edge.action() == EdgeAction::Gate);
            let Some(first) = inputs.next() else { continue };
            let common = &sources[first.source_node_id()];
            if common.is_empty() || inputs.any(|edge| &sources[edge.source_node_id()] != common) {
                return Err(DefinitionError::IncompatibleTriggerBatches { node_id: node.id().clone() });
            }
        }
        Ok(())
    }

    pub fn validate_ports(&self) -> Result<(), DefinitionError> {
        let nodes = self.nodes.iter().map(|node| (node.id(), node)).collect::<BTreeMap<_, _>>();
        for edge in &self.edges {
            let source = nodes[edge.source_node_id()];
            let target = nodes[edge.target_node_id()];
            if source.kind().resolve_source_port(Some(edge.source_port())).is_none() {
                return Err(DefinitionError::InvalidEdgeSourcePort {
                    edge_id: edge.id().clone(),
                    node_id: source.id().clone(),
                    source_port: edge.source_port().to_owned(),
                });
            }
            if target.kind().resolve_target_port(Some(edge.target_port())).is_none() {
                return Err(DefinitionError::InvalidEdgeTargetPort {
                    edge_id: edge.id().clone(),
                    node_id: target.id().clone(),
                    target_port: edge.target_port().to_owned(),
                });
            }
            if !source.kind().accepts_edge_action(edge.source_port(), edge.action())
                || (target.kind() == NodeKind::Join && edge.action() != EdgeAction::Gate)
            {
                return Err(DefinitionError::InvalidEdgeAction(edge.id().clone()));
            }
        }
        Ok(())
    }

    pub fn validate_join_inputs(&self) -> Result<(), DefinitionError> {
        let gated = self.edges.iter().filter(|edge| edge.action() == EdgeAction::Gate)
            .map(EdgeDefinition::target_node_id).collect::<BTreeSet<_>>();
        if let Some(node) = self.nodes.iter()
            .find(|node| node.kind() == NodeKind::Join && !gated.contains(node.id())) {
            return Err(DefinitionError::JoinWithoutIncomingGate(node.id().clone()));
        }
        Ok(())
    }

    pub(crate) fn validate_references(&self, previous: Option<&Self>) -> Result<(), DefinitionError> {
        let nodes = self.nodes.iter().map(|node| (node.id(), node)).collect::<BTreeMap<_, _>>();
        let previous_nodes = previous.into_iter().flat_map(|graph| &graph.nodes)
            .map(|node| (node.id(), node)).collect::<BTreeMap<_, _>>();
        let previous_edges = previous.into_iter().flat_map(|graph| &graph.edges)
            .map(|edge| (edge.id(), edge)).collect::<BTreeMap<_, _>>();
        for edge in &self.edges {
            let Some(dependency) = edge.dependency() else { continue };
            let source = nodes[edge.source_node_id()].work_assignment();
            let target = nodes[edge.target_node_id()].work_assignment();
            let (Some(source), Some(target)) = (source, target) else { continue };
            let unchanged = previous_edges.get(edge.id()).is_some_and(|prior| {
                prior.dependency() == Some(dependency)
                    && prior.source_node_id() == edge.source_node_id()
                    && prior.target_node_id() == edge.target_node_id()
                    && previous_nodes.get(edge.source_node_id())
                        .and_then(|node| node.work_assignment()).map(WorkAssignment::task_id) == Some(source.task_id())
                    && previous_nodes.get(edge.target_node_id())
                        .and_then(|node| node.work_assignment()).map(WorkAssignment::task_id) == Some(target.task_id())
            });
            if !unchanged && (dependency.dependency_task_id() != source.task_id()
                || dependency.task_id() != target.task_id()) {
                return Err(DefinitionError::DependencyTaskMismatch(edge.id().clone()));
            }
        }
        Ok(())
    }

    // Restoring historical facts must not apply today's editable port vocabulary.
    pub(crate) fn validate_structure(&self) -> Result<(), DefinitionError> {
        if self.graph_id.trim().is_empty() {
            return Err(DefinitionError::EmptyGraphId);
        }
        if self.workflow_plan_id.trim().is_empty() {
            return Err(DefinitionError::EmptyWorkflowPlanId);
        }
        if self.run_id.as_str().trim().is_empty() {
            return Err(DefinitionError::EmptyRunId);
        }
        if self.title.trim().is_empty() {
            return Err(DefinitionError::EmptyGraphTitle);
        }
        if self.nodes.is_empty() {
            return Err(DefinitionError::NoNodes);
        }

        let mut nodes = BTreeMap::new();
        let mut task_ids = BTreeSet::new();
        for node in &self.nodes {
            if let Some(port) = node.rework_limits().keys()
                .find(|port| !node.kind().accepts_edge_action(port, EdgeAction::Rework))
            {
                return Err(DefinitionError::InvalidReworkPort {
                    node_id: node.id().clone(), source_port: port.clone(),
                });
            }
            if node.id.as_str().trim().is_empty() {
                return Err(DefinitionError::EmptyNodeId);
            }
            if nodes.insert(node.id.clone(), node).is_some() {
                return Err(DefinitionError::DuplicateNodeId(node.id.clone()));
            }
            if node.title.trim().is_empty() {
                return Err(DefinitionError::EmptyNodeTitle(node.id.clone()));
            }
            node.validate_assignment()?;
            if let Some(work) = node.work_assignment() {
                if !task_ids.insert(work.task_id.clone()) {
                    return Err(DefinitionError::DuplicateWorkTaskId(work.task_id.clone()));
                }
            }
            if let Some(trigger) = node.trigger() {
                let value = match trigger {
                    StartTrigger::Webhook { path } => path,
                    StartTrigger::Cron { expression } => expression,
                };
                if value.trim().is_empty() {
                    return Err(DefinitionError::EmptyStartTrigger(node.id.clone()));
                }
            }
        }

        let mut edge_ids = BTreeSet::new();
        for edge in &self.edges {
            if edge.id.as_str().trim().is_empty() {
                return Err(DefinitionError::EmptyEdgeId);
            }
            if !edge_ids.insert(edge.id.clone()) {
                return Err(DefinitionError::DuplicateEdgeId(edge.id.clone()));
            }
            if !nodes.contains_key(&edge.source_node_id) {
                return Err(DefinitionError::UnknownEdgeSource {
                    edge_id: edge.id.clone(),
                    node_id: edge.source_node_id.clone(),
                });
            };
            if !nodes.contains_key(&edge.target_node_id) {
                return Err(DefinitionError::UnknownEdgeTarget {
                    edge_id: edge.id.clone(),
                    node_id: edge.target_node_id.clone(),
                });
            }
            if edge.source_port.trim().is_empty() || edge.target_port.trim().is_empty() {
                return Err(DefinitionError::EmptyEdgePort(edge.id.clone()));
            }
        }

        self.validate_activation_graph_acyclic()?;

        // Structural restore and editable drafts allow an unconnected Join; it is not an execution root.
        let roots = self.nodes.iter().filter(|node| !self.incoming_edges(node.id())
            .any(|edge| edge.action().activates_target()))
            .map(|node| node.id().clone()).collect::<Vec<_>>();
        if roots.is_empty() {
            return Err(DefinitionError::NoExecutionRoot);
        }
        let mut reachable = BTreeSet::new();
        for root in &roots {
            reachable.insert(root.clone());
            reachable.extend(self.reachable_from(root));
        }
        if let Some(node) = self.nodes.iter().find(|node| !reachable.contains(&node.id)) {
            return Err(DefinitionError::UnreachableNode(node.id.clone()));
        }
        Ok(())
    }

    fn validate_activation_graph_acyclic(&self) -> Result<(), DefinitionError> {
        let mut incoming_count = self
            .nodes
            .iter()
            .map(|node| (node.id.clone(), 0_usize))
            .collect::<BTreeMap<_, _>>();
        for edge in self
            .edges
            .iter()
            .filter(|edge| edge.action.activates_target())
        {
            *incoming_count
                .get_mut(&edge.target_node_id)
                .expect("definition endpoints validated") += 1;
        }
        let mut pending = incoming_count
            .iter()
            .filter_map(|(id, count)| (*count == 0).then_some(id.clone()))
            .collect::<VecDeque<_>>();
        let mut visited = 0;
        while let Some(node_id) = pending.pop_front() {
            visited += 1;
            for edge in self
                .outgoing_edges(&node_id)
                .filter(|edge| edge.action.activates_target())
            {
                let count = incoming_count
                    .get_mut(&edge.target_node_id)
                    .expect("definition endpoints validated");
                *count -= 1;
                if *count == 0 {
                    pending.push_back(edge.target_node_id.clone());
                }
            }
        }
        if visited == self.nodes.len() {
            Ok(())
        } else {
            let node_id = incoming_count
                .into_iter()
                .find_map(|(id, count)| (count > 0).then_some(id))
                .expect("a cyclic graph contains a remaining node");
            Err(DefinitionError::ActivationCycle(node_id))
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DefinitionError {
    EmptyGraphId,
    EmptyWorkflowPlanId,
    EmptyRunId,
    EmptyGraphTitle,
    NoNodes,
    EmptyNodeId,
    DuplicateNodeId(NodeId),
    EmptyNodeTitle(NodeId),
    InvalidWorkAssignment(NodeId),
    InvalidReviewAssignment(NodeId),
    MissingScriptReviewRule(NodeId),
    InvalidStartCronExpression(NodeId),
    MissingAssignmentRole(NodeId),
    MissingAssignmentSession(NodeId),
    JoinWithoutIncomingGate(NodeId),
    DependencyTaskMismatch(EdgeId),
    MissingDependencyTask(EdgeId),
    WorkAssignmentOnControlNode(NodeId),
    ReviewAssignmentOnControlNode(NodeId),
    DuplicateWorkTaskId(String),
    TriggerOnNonStartNode(NodeId),
    EmptyStartTrigger(NodeId),
    EmptyEdgeId,
    DuplicateEdgeId(EdgeId),
    UnknownEdgeSource {
        edge_id: EdgeId,
        node_id: NodeId,
    },
    UnknownEdgeTarget {
        edge_id: EdgeId,
        node_id: NodeId,
    },
    EmptyEdgePort(EdgeId),
    InvalidEdgeSourcePort {
        edge_id: EdgeId,
        node_id: NodeId,
        source_port: String,
    },
    InvalidEdgeTargetPort {
        edge_id: EdgeId,
        node_id: NodeId,
        target_port: String,
    },
    MissingEdgeSourcePort {
        edge_id: EdgeId,
        node_id: NodeId,
    },
    MissingEdgeTargetPort {
        edge_id: EdgeId,
        node_id: NodeId,
    },
    InvalidEdgeAction(EdgeId),
    InvalidReworkPort { node_id: NodeId, source_port: String },
    AmbiguousEdgeAction(EdgeId),
    NoExecutionRoot,
    UnreachableNode(NodeId),
    ActivationCycle(NodeId),
    IncompatibleTriggerBatches { node_id: NodeId },
}
