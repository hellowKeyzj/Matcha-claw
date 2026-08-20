use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
};

use super::{
    DependencyMetadata, EdgeAction, EdgeDefinition, EdgeId, EdgePayloadPolicy, ExecutorPolicy,
    GraphDefinition, GraphRunId, GroupId, NodeDefinition, NodeId, WorkAssignment,
};

/// Typed workflow facts consumed by the TeamRun graph compiler.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkflowPlan {
    workflow_plan_id: String,
    run_id: String,
    title: String,
    status: String,
    groups: Vec<WorkflowGroup>,
    tasks: Vec<WorkflowTask>,
    idempotency_key: String,
    created_at: u64,
}

impl WorkflowPlan {
    pub fn new(
        workflow_plan_id: impl Into<String>,
        run_id: impl Into<String>,
        title: impl Into<String>,
        status: impl Into<String>,
        groups: Vec<WorkflowGroup>,
        tasks: Vec<WorkflowTask>,
        idempotency_key: impl Into<String>,
        created_at: u64,
    ) -> Self {
        Self {
            workflow_plan_id: workflow_plan_id.into(),
            run_id: run_id.into(),
            title: title.into(),
            status: status.into(),
            groups,
            tasks,
            idempotency_key: idempotency_key.into(),
            created_at,
        }
    }

    pub fn workflow_plan_id(&self) -> &str {
        &self.workflow_plan_id
    }
    pub fn run_id(&self) -> &str {
        &self.run_id
    }
    pub fn title(&self) -> &str {
        &self.title
    }
    pub fn status(&self) -> &str {
        &self.status
    }
    pub fn groups(&self) -> &[WorkflowGroup] {
        &self.groups
    }
    pub fn tasks(&self) -> &[WorkflowTask] {
        &self.tasks
    }
    pub fn idempotency_key(&self) -> &str {
        &self.idempotency_key
    }
    pub const fn created_at(&self) -> u64 {
        self.created_at
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkflowTask {
    task_id: String,
    role_id: String,
    title: String,
    prompt: String,
    depends_on_task_ids: Vec<String>,
    output_artifact_kind: Option<String>,
}

impl WorkflowTask {
    pub fn new(
        task_id: impl Into<String>,
        role_id: impl Into<String>,
        title: impl Into<String>,
        prompt: impl Into<String>,
        depends_on_task_ids: Vec<String>,
        output_artifact_kind: Option<String>,
    ) -> Self {
        Self {
            task_id: task_id.into(),
            role_id: role_id.into(),
            title: title.into(),
            prompt: prompt.into(),
            depends_on_task_ids,
            output_artifact_kind,
        }
    }

    pub fn task_id(&self) -> &str {
        &self.task_id
    }
    pub fn role_id(&self) -> &str {
        &self.role_id
    }
    pub fn title(&self) -> &str {
        &self.title
    }
    pub fn prompt(&self) -> &str {
        &self.prompt
    }
    pub fn depends_on_task_ids(&self) -> &[String] {
        &self.depends_on_task_ids
    }
    pub fn output_artifact_kind(&self) -> Option<&str> {
        self.output_artifact_kind.as_deref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkflowGroup {
    group_id: String,
    title: String,
    task_ids: Vec<String>,
    join: WorkflowJoinPolicy,
}

impl WorkflowGroup {
    pub fn new(
        group_id: impl Into<String>,
        title: impl Into<String>,
        task_ids: Vec<String>,
        join: WorkflowJoinPolicy,
    ) -> Self {
        Self {
            group_id: group_id.into(),
            title: title.into(),
            task_ids,
            join,
        }
    }

    pub fn group_id(&self) -> &str {
        &self.group_id
    }
    pub fn title(&self) -> &str {
        &self.title
    }
    pub fn task_ids(&self) -> &[String] {
        &self.task_ids
    }
    pub const fn join(&self) -> &WorkflowJoinPolicy {
        &self.join
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WorkflowJoinPolicy {
    require_completed: bool,
    allow_failed: bool,
    retry_limit: u32,
}

impl WorkflowJoinPolicy {
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

/// The compiled graph plus plan facts that are not part of `GraphDefinition`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkflowPlanCompilation {
    definition: GraphDefinition,
    groups: Vec<WorkflowGroup>,
    status: String,
    idempotency_key: String,
    created_at: u64,
}

impl WorkflowPlanCompilation {
    pub fn definition(&self) -> &GraphDefinition {
        &self.definition
    }
    pub fn groups(&self) -> &[WorkflowGroup] {
        &self.groups
    }
    pub fn status(&self) -> &str {
        &self.status
    }
    pub fn idempotency_key(&self) -> &str {
        &self.idempotency_key
    }
    pub const fn created_at(&self) -> u64 {
        self.created_at
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkflowPlanCompileError {
    EmptyWorkflowPlanId,
    EmptyRunId,
    EmptyTitle,
    EmptyStatus,
    EmptyIdempotencyKey,
    EmptyTaskId,
    EmptyTaskRoleId,
    EmptyTaskTitle,
    EmptyTaskPrompt,
    EmptyOutputArtifactKind,
    DuplicateTaskId(String),
    EmptyGroupId,
    EmptyGroupTitle,
    EmptyGroupTaskId,
    DuplicateGroupId(String),
    UnknownGroupTask {
        group_id: String,
        task_id: String,
    },
    DuplicateGroupTask {
        group_id: String,
        task_id: String,
    },
    TaskAssignedToMultipleGroups {
        task_id: String,
    },
    UnknownDependency {
        task_id: String,
        dependency_task_id: String,
    },
    DuplicateDependency {
        task_id: String,
        dependency_task_id: String,
    },
    InvalidGraphDefinition(super::DefinitionError),
}

impl fmt::Display for WorkflowPlanCompileError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyWorkflowPlanId => formatter.write_str("workflow plan ID must not be empty"),
            Self::EmptyRunId => formatter.write_str("workflow run ID must not be empty"),
            Self::EmptyTitle => formatter.write_str("workflow plan title must not be empty"),
            Self::EmptyStatus => formatter.write_str("workflow plan status must not be empty"),
            Self::EmptyIdempotencyKey => {
                formatter.write_str("workflow plan idempotency key must not be empty")
            }
            Self::EmptyTaskId => formatter.write_str("workflow task ID must not be empty"),
            Self::EmptyTaskRoleId => formatter.write_str("workflow task role ID must not be empty"),
            Self::EmptyTaskTitle => formatter.write_str("workflow task title must not be empty"),
            Self::EmptyTaskPrompt => formatter.write_str("workflow task prompt must not be empty"),
            Self::EmptyOutputArtifactKind => {
                formatter.write_str("workflow task output artifact kind must not be empty")
            }
            Self::DuplicateTaskId(task_id) => write!(
                formatter,
                "workflow plan contains duplicate task ID {task_id:?}"
            ),
            Self::EmptyGroupId => formatter.write_str("workflow group ID must not be empty"),
            Self::EmptyGroupTitle => formatter.write_str("workflow group title must not be empty"),
            Self::EmptyGroupTaskId => {
                formatter.write_str("workflow group task ID must not be empty")
            }
            Self::DuplicateGroupId(group_id) => write!(
                formatter,
                "workflow plan contains duplicate group ID {group_id:?}"
            ),
            Self::UnknownGroupTask { group_id, task_id } => write!(
                formatter,
                "workflow group {group_id:?} references unknown task {task_id:?}"
            ),
            Self::DuplicateGroupTask { group_id, task_id } => write!(
                formatter,
                "workflow group {group_id:?} repeats task {task_id:?}"
            ),
            Self::TaskAssignedToMultipleGroups { task_id } => write!(
                formatter,
                "workflow task {task_id:?} belongs to multiple groups"
            ),
            Self::UnknownDependency {
                task_id,
                dependency_task_id,
            } => write!(
                formatter,
                "workflow task {task_id:?} depends on unknown task {dependency_task_id:?}"
            ),
            Self::DuplicateDependency {
                task_id,
                dependency_task_id,
            } => write!(
                formatter,
                "workflow task {task_id:?} repeats dependency {dependency_task_id:?}"
            ),
            Self::InvalidGraphDefinition(_) => {
                formatter.write_str("workflow plan does not compile to a valid graph definition")
            }
        }
    }
}

impl std::error::Error for WorkflowPlanCompileError {}

/// Compiles only typed workflow facts. Review/control nodes remain external graph-template facts.
pub fn compile_workflow_plan(
    plan: &WorkflowPlan,
) -> Result<WorkflowPlanCompilation, WorkflowPlanCompileError> {
    validate_plan_scalars(plan)?;

    let tasks_by_id = build_tasks_by_id(&plan.tasks)?;
    let group_by_task_id = build_group_membership(&plan.groups, &tasks_by_id)?;
    validate_dependencies(&plan.tasks, &tasks_by_id)?;

    let nodes = plan
        .tasks
        .iter()
        .map(|task| {
            let group_id = group_by_task_id
                .get(task.task_id())
                .cloned()
                .map(GroupId::new);
            NodeDefinition::work(
                NodeId::new(workflow_task_node_id(task.task_id())),
                task.title().to_owned(),
                std::num::NonZeroU32::MIN,
                WorkAssignment::typed(
                    task.task_id().to_owned(),
                    task.prompt().to_owned(),
                    ExecutorPolicy::team_role(task.role_id().to_owned()),
                    task.output_artifact_kind().map(ToOwned::to_owned),
                    group_id,
                ),
            )
        })
        .collect();
    let edges = plan
        .tasks
        .iter()
        .flat_map(|task| {
            task.depends_on_task_ids().iter().map(move |dependency| {
                EdgeDefinition::new(
                    EdgeId::new(workflow_dependency_edge_id(dependency, task.task_id())),
                    NodeId::new(workflow_task_node_id(dependency)),
                    "completed",
                    NodeId::new(workflow_task_node_id(task.task_id())),
                    "input",
                    EdgeAction::Activate,
                )
                .with_payload(EdgePayloadPolicy::new(true))
                .with_dependency(DependencyMetadata::new(
                    dependency.clone(),
                    task.task_id().to_owned(),
                ))
            })
        })
        .collect();

    let definition = GraphDefinition::new(
        format!("workflow-plan:{}", plan.workflow_plan_id()),
        plan.workflow_plan_id().to_owned(),
        GraphRunId::new(plan.run_id().to_owned()),
        plan.title().to_owned(),
        nodes,
        edges,
    )
    .map_err(WorkflowPlanCompileError::InvalidGraphDefinition)?;

    Ok(WorkflowPlanCompilation {
        definition,
        groups: plan.groups.clone(),
        status: plan.status.clone(),
        idempotency_key: plan.idempotency_key.clone(),
        created_at: plan.created_at,
    })
}

pub fn workflow_task_node_id(task_id: &str) -> String {
    format!("workflow-task:{task_id}")
}

pub fn workflow_dependency_edge_id(dependency_task_id: &str, task_id: &str) -> String {
    format!("workflow-task-dependency:{dependency_task_id}:{task_id}")
}

fn validate_plan_scalars(plan: &WorkflowPlan) -> Result<(), WorkflowPlanCompileError> {
    if plan.workflow_plan_id.trim().is_empty() {
        return Err(WorkflowPlanCompileError::EmptyWorkflowPlanId);
    }
    if plan.run_id.trim().is_empty() {
        return Err(WorkflowPlanCompileError::EmptyRunId);
    }
    if plan.title.trim().is_empty() {
        return Err(WorkflowPlanCompileError::EmptyTitle);
    }
    if plan.status.trim().is_empty() {
        return Err(WorkflowPlanCompileError::EmptyStatus);
    }
    if plan.idempotency_key.trim().is_empty() {
        return Err(WorkflowPlanCompileError::EmptyIdempotencyKey);
    }
    Ok(())
}

fn build_tasks_by_id(
    tasks: &[WorkflowTask],
) -> Result<BTreeMap<String, &WorkflowTask>, WorkflowPlanCompileError> {
    let mut tasks_by_id = BTreeMap::new();
    for task in tasks {
        if task.task_id.trim().is_empty() {
            return Err(WorkflowPlanCompileError::EmptyTaskId);
        }
        if task.role_id.trim().is_empty() {
            return Err(WorkflowPlanCompileError::EmptyTaskRoleId);
        }
        if task.title.trim().is_empty() {
            return Err(WorkflowPlanCompileError::EmptyTaskTitle);
        }
        if task.prompt.trim().is_empty() {
            return Err(WorkflowPlanCompileError::EmptyTaskPrompt);
        }
        if task
            .output_artifact_kind
            .as_deref()
            .is_some_and(|kind| kind.trim().is_empty())
        {
            return Err(WorkflowPlanCompileError::EmptyOutputArtifactKind);
        }
        if tasks_by_id.insert(task.task_id.clone(), task).is_some() {
            return Err(WorkflowPlanCompileError::DuplicateTaskId(
                task.task_id.clone(),
            ));
        }
    }
    Ok(tasks_by_id)
}

fn build_group_membership(
    groups: &[WorkflowGroup],
    tasks_by_id: &BTreeMap<String, &WorkflowTask>,
) -> Result<BTreeMap<String, String>, WorkflowPlanCompileError> {
    let mut groups_by_id = BTreeMap::new();
    let mut group_by_task_id = BTreeMap::new();
    for group in groups {
        if group.group_id.trim().is_empty() {
            return Err(WorkflowPlanCompileError::EmptyGroupId);
        }
        if group.title.trim().is_empty() {
            return Err(WorkflowPlanCompileError::EmptyGroupTitle);
        }
        if groups_by_id.insert(group.group_id.clone(), group).is_some() {
            return Err(WorkflowPlanCompileError::DuplicateGroupId(
                group.group_id.clone(),
            ));
        }
        for task_id in &group.task_ids {
            if task_id.trim().is_empty() {
                return Err(WorkflowPlanCompileError::EmptyGroupTaskId);
            }
            if !tasks_by_id.contains_key(task_id) {
                return Err(WorkflowPlanCompileError::UnknownGroupTask {
                    group_id: group.group_id.clone(),
                    task_id: task_id.clone(),
                });
            }
            if let Some(previous_group_id) =
                group_by_task_id.insert(task_id.clone(), group.group_id.clone())
            {
                if previous_group_id == group.group_id {
                    return Err(WorkflowPlanCompileError::DuplicateGroupTask {
                        group_id: group.group_id.clone(),
                        task_id: task_id.clone(),
                    });
                }
                return Err(WorkflowPlanCompileError::TaskAssignedToMultipleGroups {
                    task_id: task_id.clone(),
                });
            }
        }
    }
    Ok(group_by_task_id)
}

fn validate_dependencies(
    tasks: &[WorkflowTask],
    tasks_by_id: &BTreeMap<String, &WorkflowTask>,
) -> Result<(), WorkflowPlanCompileError> {
    for task in tasks {
        let mut dependency_ids = BTreeSet::new();
        for dependency_task_id in &task.depends_on_task_ids {
            if dependency_task_id.trim().is_empty() {
                return Err(WorkflowPlanCompileError::UnknownDependency {
                    task_id: task.task_id.clone(),
                    dependency_task_id: dependency_task_id.clone(),
                });
            }
            if !tasks_by_id.contains_key(dependency_task_id) {
                return Err(WorkflowPlanCompileError::UnknownDependency {
                    task_id: task.task_id.clone(),
                    dependency_task_id: dependency_task_id.clone(),
                });
            }
            if !dependency_ids.insert(dependency_task_id) {
                return Err(WorkflowPlanCompileError::DuplicateDependency {
                    task_id: task.task_id.clone(),
                    dependency_task_id: dependency_task_id.clone(),
                });
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str, dependencies: &[&str]) -> WorkflowTask {
        WorkflowTask::new(
            id,
            format!("role-{id}"),
            format!("Task {id}"),
            format!("Prompt {id}"),
            dependencies
                .iter()
                .map(|value| (*value).to_owned())
                .collect(),
            Some(format!("artifact-{id}")),
        )
    }

    fn plan() -> WorkflowPlan {
        WorkflowPlan::new(
            "plan-1",
            "run-1",
            "Workflow",
            "active",
            vec![WorkflowGroup::new(
                "group-1",
                "First",
                vec!["task-a".into(), "task-b".into()],
                WorkflowJoinPolicy::new(true, false, 2),
            )],
            vec![
                task("task-a", &[]),
                task("task-b", &["task-a"]),
                task("task-c", &[]),
            ],
            "idem-1",
            42,
        )
    }

    #[test]
    fn compiles_typed_plan_without_inventing_control_nodes() {
        let compilation = compile_workflow_plan(&plan()).unwrap();
        assert_eq!(compilation.definition().graph_id(), "workflow-plan:plan-1");
        assert_eq!(compilation.definition().nodes().len(), 3);
        assert!(
            compilation
                .definition()
                .nodes()
                .iter()
                .all(|node| node.kind() == super::super::NodeKind::Work)
        );
        assert_eq!(compilation.definition().edges().len(), 1);
        let edge = &compilation.definition().edges()[0];
        assert_eq!(edge.id().as_str(), "workflow-task-dependency:task-a:task-b");
        assert_eq!(edge.source_node_id().as_str(), "workflow-task:task-a");
        assert_eq!(edge.target_node_id().as_str(), "workflow-task:task-b");
        assert_eq!(edge.action(), EdgeAction::Activate);
        assert!(edge.payload().include_upstream_result());
        assert_eq!(edge.dependency().unwrap().dependency_task_id(), "task-a");
        assert_eq!(compilation.status(), "active");
        assert_eq!(compilation.idempotency_key(), "idem-1");
        assert_eq!(compilation.created_at(), 42);
        assert_eq!(compilation.groups()[0].join().retry_limit(), 2);
    }

    #[test]
    fn compiled_definition_round_trips_through_durable_graph_facts() {
        let compilation = compile_workflow_plan(&plan()).unwrap();
        let state = super::super::GraphState::initialize(compilation.definition().clone(), 10);
        let restored = super::super::GraphState::restore_durable(state.durable_snapshot()).unwrap();
        assert_eq!(restored.definition(), compilation.definition());
    }

    #[test]
    fn rejects_duplicate_tasks_and_unknown_references() {
        let duplicate = WorkflowPlan::new(
            "plan",
            "run",
            "title",
            "active",
            vec![],
            vec![task("a", &[]), task("a", &[])],
            "idem",
            1,
        );
        assert_eq!(
            compile_workflow_plan(&duplicate),
            Err(WorkflowPlanCompileError::DuplicateTaskId("a".into()))
        );

        let unknown_group = WorkflowPlan::new(
            "plan",
            "run",
            "title",
            "active",
            vec![WorkflowGroup::new(
                "g",
                "G",
                vec!["missing".into()],
                WorkflowJoinPolicy::new(true, false, 0),
            )],
            vec![task("a", &[])],
            "idem",
            1,
        );
        assert_eq!(
            compile_workflow_plan(&unknown_group),
            Err(WorkflowPlanCompileError::UnknownGroupTask {
                group_id: "g".into(),
                task_id: "missing".into()
            })
        );

        let unknown_dependency = WorkflowPlan::new(
            "plan",
            "run",
            "title",
            "active",
            vec![],
            vec![task("a", &["missing"])],
            "idem",
            1,
        );
        assert_eq!(
            compile_workflow_plan(&unknown_dependency),
            Err(WorkflowPlanCompileError::UnknownDependency {
                task_id: "a".into(),
                dependency_task_id: "missing".into()
            })
        );

        let duplicate_dependency = WorkflowPlan::new(
            "plan",
            "run",
            "title",
            "active",
            vec![],
            vec![task("a", &[]), task("b", &["a", "a"])],
            "idem",
            1,
        );
        assert_eq!(
            compile_workflow_plan(&duplicate_dependency),
            Err(WorkflowPlanCompileError::DuplicateDependency {
                task_id: "b".into(),
                dependency_task_id: "a".into()
            })
        );
    }
}
