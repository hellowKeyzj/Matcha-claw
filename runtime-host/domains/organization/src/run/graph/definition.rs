use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    num::NonZeroU32,
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

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct GroupId(String);

impl GroupId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JoinPolicy {
    require_completed: bool,
    allow_failed: bool,
    retry_limit: u32,
}

impl JoinPolicy {
    pub const fn new(require_completed: bool, allow_failed: bool, retry_limit: u32) -> Self {
        Self {
            require_completed,
            allow_failed,
            retry_limit,
        }
    }

    pub const fn require_completed(&self) -> bool {
        self.require_completed
    }

    pub const fn allow_failed(&self) -> bool {
        self.allow_failed
    }

    pub const fn retry_limit(&self) -> u32 {
        self.retry_limit
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkGroup {
    id: GroupId,
    join_policy: JoinPolicy,
}

impl WorkGroup {
    pub fn new(id: GroupId, join_policy: JoinPolicy) -> Self {
        Self { id, join_policy }
    }

    pub fn id(&self) -> &GroupId {
        &self.id
    }

    pub fn join_policy(&self) -> &JoinPolicy {
        &self.join_policy
    }
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
    group_id: Option<GroupId>,
}

impl WorkAssignment {
    pub fn new(task_id: impl Into<String>, role_id: impl Into<String>) -> Self {
        Self::typed(
            task_id,
            String::new(),
            ExecutorPolicy::team_role(role_id),
            None,
            None,
        )
    }

    pub fn typed(
        task_id: impl Into<String>,
        prompt: impl Into<String>,
        executor: ExecutorPolicy,
        output_artifact_kind: Option<String>,
        group_id: Option<GroupId>,
    ) -> Self {
        Self {
            task_id: task_id.into(),
            prompt: prompt.into(),
            executor,
            output_artifact_kind,
            group_id,
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

    pub fn group_id(&self) -> Option<&GroupId> {
        self.group_id.as_ref()
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
pub struct NodeDefinition {
    id: NodeId,
    kind: NodeKind,
    title: String,
    max_attempts: NonZeroU32,
    is_control: bool,
    trigger: Option<StartTrigger>,
    work: Option<WorkAssignment>,
    review: Option<ReviewAssignment>,
    group: Option<WorkGroup>,
}

impl NodeDefinition {
    pub fn start(
        id: NodeId,
        title: impl Into<String>,
        max_attempts: NonZeroU32,
        trigger: Option<StartTrigger>,
    ) -> Self {
        Self {
            id,
            kind: NodeKind::Start,
            title: title.into(),
            max_attempts,
            is_control: false,
            trigger,
            work: None,
            review: None,
            group: None,
        }
    }

    pub fn control(
        id: NodeId,
        kind: NodeKind,
        title: impl Into<String>,
        max_attempts: NonZeroU32,
    ) -> Self {
        Self {
            id,
            kind,
            title: title.into(),
            max_attempts,
            is_control: true,
            trigger: None,
            work: None,
            review: None,
            group: None,
        }
    }

    pub fn work(
        id: NodeId,
        title: impl Into<String>,
        max_attempts: NonZeroU32,
        assignment: WorkAssignment,
    ) -> Self {
        Self {
            id,
            kind: NodeKind::Work,
            title: title.into(),
            max_attempts,
            is_control: false,
            trigger: None,
            work: Some(assignment),
            review: None,
            group: None,
        }
    }

    pub fn review(
        id: NodeId,
        title: impl Into<String>,
        max_attempts: NonZeroU32,
        assignment: ReviewAssignment,
    ) -> Self {
        Self {
            id,
            kind: NodeKind::Review,
            title: title.into(),
            max_attempts,
            is_control: false,
            trigger: None,
            work: None,
            review: Some(assignment),
            group: None,
        }
    }

    pub fn join(
        id: NodeId,
        title: impl Into<String>,
        max_attempts: NonZeroU32,
        group: WorkGroup,
    ) -> Self {
        Self {
            id,
            kind: NodeKind::Join,
            title: title.into(),
            max_attempts,
            is_control: false,
            trigger: None,
            work: None,
            review: None,
            group: Some(group),
        }
    }

    pub fn id(&self) -> &NodeId {
        &self.id
    }

    pub fn kind(&self) -> NodeKind {
        self.kind
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn max_attempts(&self) -> NonZeroU32 {
        self.max_attempts
    }

    pub fn is_control(&self) -> bool {
        self.is_control
    }

    pub fn trigger(&self) -> Option<&StartTrigger> {
        self.trigger.as_ref()
    }

    pub fn work_assignment(&self) -> Option<&WorkAssignment> {
        self.work.as_ref()
    }

    pub fn review_assignment(&self) -> Option<&ReviewAssignment> {
        self.review.as_ref()
    }

    pub fn work_group(&self) -> Option<&WorkGroup> {
        self.group.as_ref()
    }

    pub(crate) fn is_armed_start(&self) -> bool {
        self.kind == NodeKind::Start && self.trigger.is_some()
    }
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
        let definition = Self {
            graph_id: graph_id.into(),
            workflow_plan_id: workflow_plan_id.into(),
            run_id,
            title: title.into(),
            nodes,
            edges,
        };
        definition.validate()?;
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
                !self
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
            if node.id.as_str().trim().is_empty() {
                return Err(DefinitionError::EmptyNodeId);
            }
            if nodes.insert(node.id.clone(), node).is_some() {
                return Err(DefinitionError::DuplicateNodeId(node.id.clone()));
            }
            if node.title.trim().is_empty() {
                return Err(DefinitionError::EmptyNodeTitle(node.id.clone()));
            }
            match (node.kind, &node.work, &node.review) {
                (NodeKind::Work, Some(work), None)
                    if !work.task_id.trim().is_empty() && !work.role_id().trim().is_empty() =>
                {
                    if !task_ids.insert(work.task_id.clone()) {
                        return Err(DefinitionError::DuplicateWorkTaskId(work.task_id.clone()));
                    }
                }
                (NodeKind::Work, _, _) => {
                    return Err(DefinitionError::InvalidWorkAssignment(node.id.clone()));
                }
                (NodeKind::Review, None, None) => {}
                (NodeKind::Review, None, Some(review))
                    if !review.role_id().trim().is_empty() && !review.prompt.trim().is_empty() => {}
                (NodeKind::Review, None, Some(_)) => {
                    return Err(DefinitionError::InvalidReviewAssignment(node.id.clone()));
                }
                (NodeKind::Review, Some(_), _) => {
                    return Err(DefinitionError::WorkAssignmentOnControlNode(
                        node.id.clone(),
                    ));
                }
                (_, Some(_), _) => {
                    return Err(DefinitionError::WorkAssignmentOnControlNode(
                        node.id.clone(),
                    ));
                }
                (_, _, Some(_)) => {
                    return Err(DefinitionError::ReviewAssignmentOnControlNode(
                        node.id.clone(),
                    ));
                }
                _ => {}
            }
            if node.kind != NodeKind::Start && node.trigger.is_some() {
                return Err(DefinitionError::TriggerOnNonStartNode(node.id.clone()));
            }
            if let Some(trigger) = &node.trigger {
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
            }
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

        let roots = self.execution_root_ids();
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
    WorkAssignmentOnControlNode(NodeId),
    ReviewAssignmentOnControlNode(NodeId),
    DuplicateWorkTaskId(String),
    TriggerOnNonStartNode(NodeId),
    EmptyStartTrigger(NodeId),
    EmptyEdgeId,
    DuplicateEdgeId(EdgeId),
    UnknownEdgeSource { edge_id: EdgeId, node_id: NodeId },
    UnknownEdgeTarget { edge_id: EdgeId, node_id: NodeId },
    EmptyEdgePort(EdgeId),
    NoExecutionRoot,
    UnreachableNode(NodeId),
    ActivationCycle(NodeId),
}
