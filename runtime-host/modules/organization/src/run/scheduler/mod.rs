mod cron;
mod retry_due;
mod terminal_observation;

use super::trigger::{TriggerFireRequest, TriggerFireRequestError, TriggerSource};

pub use cron::{CronScheduleError, next_cron_slot_after};
pub use retry_due::{
    NodePromptRetryDueInvalidReason, NodePromptRetryDueItem, NodePromptRetryDuePlan,
    NodePromptRetryDueQuery, NodePromptRetryDueQueryError, NodePromptRetryDueQueryOutcome,
    NodePromptRetryDueResolution, NodePromptRetryDueUnknownReason, produce_node_prompt_retry_due,
    query_node_prompt_retry_due,
};
pub use terminal_observation::{TerminalObservationPlan, plan_terminal_observations};

use super::{
    activity::{ActivityId, ActivityKind, ActivityRequest, ActivityRequestError, ActivityTarget},
    graph::{AttemptStatus, ExecutionFence, GraphRunId, GraphState, GroupId, NodeId, NodeKind},
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReadyNodeSchedule {
    activity_id: ActivityId,
    run_id: GraphRunId,
    node_id: NodeId,
    fence: ExecutionFence,
    activity_kind: ActivityKind,
    idempotency_key: String,
    group_id: Option<GroupId>,
}

impl ReadyNodeSchedule {
    pub fn activity_id(&self) -> &ActivityId {
        &self.activity_id
    }

    pub fn run_id(&self) -> &GraphRunId {
        &self.run_id
    }

    pub fn node_id(&self) -> &NodeId {
        &self.node_id
    }

    pub fn fence(&self) -> &ExecutionFence {
        &self.fence
    }

    pub fn activity_kind(&self) -> &ActivityKind {
        &self.activity_kind
    }

    pub fn idempotency_key(&self) -> &str {
        &self.idempotency_key
    }

    pub fn bind_activity_target(
        &self,
        target: ActivityTarget,
        created_at: u64,
        max_attempts: u32,
    ) -> Result<ActivityRequest, ActivityRequestError> {
        let request = ActivityRequest {
            activity_id: self.activity_id.clone(),
            run_id: self.run_id.clone(),
            node_id: self.node_id.clone(),
            node_execution_id: self.fence.node_execution_id().clone(),
            fence: self.fence.clone(),
            activity_kind: self.activity_kind.clone(),
            target,
            idempotency_key: self.idempotency_key.clone(),
            created_at,
            max_attempts,
        };
        request.validate()?;
        Ok(request)
    }

    pub fn group_id(&self) -> Option<&GroupId> {
        self.group_id.as_ref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReadyScheduleError {
    ZeroParallelLimit,
    ActiveParallelExceedsLimit,
    StaleReadyQueue(NodeId),
}

/// Selects a deterministic bounded scheduling wave from the graph's durable ready facts.
///
/// The scheduler does not infer ports from native terminal observations and does not mutate the
/// graph. Group membership is read only from typed work assignments; join readiness is owned by
/// the graph reducer.
pub fn schedule_ready_nodes(
    graph: &GraphState,
    max_parallel: usize,
    active_parallel: usize,
) -> Result<Vec<ReadyNodeSchedule>, ReadyScheduleError> {
    if max_parallel == 0 {
        return Err(ReadyScheduleError::ZeroParallelLimit);
    }
    if active_parallel > max_parallel {
        return Err(ReadyScheduleError::ActiveParallelExceedsLimit);
    }
    let capacity = max_parallel - active_parallel;
    let mut scheduled = Vec::with_capacity(capacity);
    for item in graph.ready_queue() {
        if scheduled.len() == capacity {
            break;
        }
        let Some(attempt) = graph.current_attempt(item.node_id()) else {
            return Err(ReadyScheduleError::StaleReadyQueue(item.node_id().clone()));
        };
        if attempt.status() != AttemptStatus::Ready || attempt.fence() != item.fence() {
            return Err(ReadyScheduleError::StaleReadyQueue(item.node_id().clone()));
        }
        let Some(node) = graph.definition().node(item.node_id()) else {
            return Err(ReadyScheduleError::StaleReadyQueue(item.node_id().clone()));
        };
        let Some(activity_kind) = activity_kind_for_ready_node(graph.definition(), node) else {
            continue;
        };
        let idempotency_key = activity_idempotency_key(graph.definition().run_id(), item.fence());
        let activity_id = ActivityId::new(idempotency_key.clone())
            .map_err(|_| ReadyScheduleError::StaleReadyQueue(item.node_id().clone()))?;
        let group_id = node
            .work_assignment()
            .and_then(|work| work.group_id())
            .cloned();
        scheduled.push(ReadyNodeSchedule {
            activity_id,
            run_id: graph.definition().run_id().clone(),
            node_id: item.node_id().clone(),
            fence: item.fence().clone(),
            activity_kind,
            idempotency_key,
            group_id,
        });
    }
    Ok(scheduled)
}

fn activity_kind_for_ready_node(
    definition: &crate::GraphDefinition,
    node: &crate::NodeDefinition,
) -> Option<ActivityKind> {
    match node.kind() {
        NodeKind::Work => {
            let work = node.work_assignment()?;
            if work.prompt().trim().is_empty() {
                return None;
            }
            Some(ActivityKind::AgentTask {
                task_id: work.task_id().to_owned(),
                role_id: work.role_id().to_owned(),
                session_ref: work.session_ref().as_str().to_owned(),
                prompt: compose_agent_task_prompt(definition, node, work.prompt())?,
            })
        }
        NodeKind::Review => {
            let review = node.review_assignment()?;
            if review.prompt().trim().is_empty() {
                return None;
            }
            Some(ActivityKind::AgentTask {
                task_id: node.id().as_str().to_owned(),
                role_id: review.role_id().to_owned(),
                session_ref: review.session_ref().as_str().to_owned(),
                prompt: compose_agent_task_prompt(definition, node, review.prompt())?,
            })
        }
        NodeKind::Start
        | NodeKind::HumanDecision
        | NodeKind::ScriptReview
        | NodeKind::Join
        | NodeKind::End => None,
    }
}

pub(crate) fn compose_agent_task_prompt(
    definition: &crate::GraphDefinition,
    node: &crate::NodeDefinition,
    base_prompt: &str,
) -> Option<String> {
    compose_agent_task_prompt_with_upstream_context(definition, node, base_prompt, &[])
}

pub(crate) struct UpstreamPromptContext<'a> {
    pub(crate) summary: &'a str,
    pub(crate) tasks: Vec<&'a str>,
}

pub(crate) fn compose_agent_task_prompt_with_upstream_context(
    definition: &crate::GraphDefinition,
    node: &crate::NodeDefinition,
    base_prompt: &str,
    upstream: &[UpstreamPromptContext<'_>],
) -> Option<String> {
    let (decisions, source_ports) = match node.kind() {
        NodeKind::Work => (work_decisions(), work_decision_ports()),
        NodeKind::Review => (review_decisions(), review_decision_ports()),
        NodeKind::Start
        | NodeKind::HumanDecision
        | NodeKind::ScriptReview
        | NodeKind::Join
        | NodeKind::End => return None,
    };
    Some(append_completion_protocol(
        &append_upstream_context(base_prompt, upstream),
        decisions,
        allowed_role_ids(definition, node, source_ports),
    ))
}

fn append_upstream_context(prompt: &str, upstream: &[UpstreamPromptContext<'_>]) -> String {
    if upstream.is_empty() {
        return prompt.to_owned();
    }
    let mut composed = prompt.to_owned();
    composed.push_str("\n\n<teamrun_upstream_context>");
    for context in upstream {
        composed.push_str("\n- summary: ");
        composed.push_str(context.summary);
        for task in &context.tasks {
            composed.push_str("\n  task: ");
            composed.push_str(task);
        }
    }
    composed.push_str("\n</teamrun_upstream_context>");
    composed
}

fn append_completion_protocol(
    prompt: &str,
    decisions: &'static str,
    allowed_role_ids: Vec<String>,
) -> String {
    format!(
        "{prompt}\n\n<teamrun_completion_protocol>\n你处于 TeamRun 团队模式。完成当前节点任务后，在最终回复末尾追加一个 `<team_message>` 控制块\n\n`<team_message>` 控制块内必须是合法 JSON，结构如下：\n<team_message>{{\"summary\":\"\",\"decision\":\"\",\"dispatch\":[]}}</team_message>\n\n字段：\n- `summary`：中文写本节点交付摘要；包含完成内容、关键结论、产物/改动、风险、下游节点必要上下文\n- `decision`：选择当前节点的一个后续流向。只能选择下面列出的值：\n{decisions}\n- `dispatch`：给下游节点 role 的具体任务；没有任务时填 `[]`。每项包含：\n  - `role_id`：下游 role id，只能选择以下团队role：\n{}\n  - `task`：给该 role 的具体任务。\n\n要求：\n- 整条最终回复只能出现一个 `<team_message>`\n- 不要新增未说明字段\n</teamrun_completion_protocol>",
        format_allowed_role_ids(&allowed_role_ids)
    )
}

fn work_decisions() -> &'static str {
    "- `completed`：当前节点已完成，继续正常后续节点。"
}

fn review_decisions() -> &'static str {
    "- `completed`：审查/验收通过，继续正常后续节点。\n- `rework`：审查/验收不通过，返回返工路径。"
}

fn work_decision_ports() -> &'static [&'static str] {
    &["completed"]
}

fn review_decision_ports() -> &'static [&'static str] {
    &["completed", "rework"]
}

fn allowed_role_ids(
    definition: &crate::GraphDefinition,
    node: &crate::NodeDefinition,
    source_ports: &[&str],
) -> Vec<String> {
    let mut role_ids: Vec<String> = Vec::new();
    for edge in definition
        .outgoing_edges(node.id())
        .filter(|edge| source_ports.contains(&edge.source_port()))
    {
        let Some(target) = definition.node(edge.target_node_id()) else {
            continue;
        };
        let role_id = match target.kind() {
            NodeKind::Work => target.work_assignment().map(|work| work.role_id()),
            NodeKind::Review => target.review_assignment().map(|review| review.role_id()),
            NodeKind::Start
            | NodeKind::HumanDecision
            | NodeKind::ScriptReview
            | NodeKind::Join
            | NodeKind::End => None,
        };
        if let Some(role_id) = role_id {
            if !role_ids.iter().any(|existing| existing.as_str() == role_id) {
                role_ids.push(role_id.to_owned());
            }
        }
    }
    role_ids
}

fn format_allowed_role_ids(role_ids: &[String]) -> String {
    if role_ids.is_empty() {
        return "- 无".to_owned();
    }
    role_ids
        .iter()
        .map(|role_id| format!("- `{role_id}`"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn activity_idempotency_key(run_id: &GraphRunId, fence: &ExecutionFence) -> String {
    format!(
        "team-graph-activity:{}:{}",
        run_id.as_str(),
        fence.attempt_id().as_str()
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArmedCronTrigger {
    pub run_id: String,
    pub start_node_id: String,
    pub next_slot_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DueCronTriggerPlan {
    pub next_slot_at: Option<u64>,
    pub fire: TriggerFireRequest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CronTriggerScheduleError {
    InvalidTrigger(TriggerFireRequestError),
    NonAdvancingNextSlot,
}

pub fn plan_due_cron_trigger(
    trigger: ArmedCronTrigger,
    now: u64,
    next_slot_after_now: Option<u64>,
) -> Result<Option<DueCronTriggerPlan>, CronTriggerScheduleError> {
    if trigger.next_slot_at > now {
        return Ok(None);
    }
    if next_slot_after_now.is_some_and(|next_slot_at| next_slot_at <= now) {
        return Err(CronTriggerScheduleError::NonAdvancingNextSlot);
    }

    let idempotency_key = format!(
        "team-cron:{}:{}:{}",
        trigger.run_id, trigger.start_node_id, trigger.next_slot_at
    );
    let fire = TriggerFireRequest::try_new(
        trigger.run_id,
        trigger.start_node_id,
        TriggerSource::Cron,
        idempotency_key,
    )
    .map_err(CronTriggerScheduleError::InvalidTrigger)?;

    Ok(Some(DueCronTriggerPlan {
        next_slot_at: next_slot_after_now,
        fire,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn armed(next_slot_at: u64) -> ArmedCronTrigger {
        ArmedCronTrigger {
            run_id: "run-1".into(),
            start_node_id: "start-1".into(),
            next_slot_at,
        }
    }

    fn expected_prompt(prompt: &str, decisions: &str, allowed_role_ids: &str) -> String {
        format!(
            "{prompt}\n\n<teamrun_completion_protocol>\n你处于 TeamRun 团队模式。完成当前节点任务后，在最终回复末尾追加一个 `<team_message>` 控制块\n\n`<team_message>` 控制块内必须是合法 JSON，结构如下：\n<team_message>{{\"summary\":\"\",\"decision\":\"\",\"dispatch\":[]}}</team_message>\n\n字段：\n- `summary`：中文写本节点交付摘要；包含完成内容、关键结论、产物/改动、风险、下游节点必要上下文\n- `decision`：选择当前节点的一个后续流向。只能选择下面列出的值：\n{decisions}\n- `dispatch`：给下游节点 role 的具体任务；没有任务时填 `[]`。每项包含：\n  - `role_id`：下游 role id，只能选择以下团队role：\n{allowed_role_ids}\n  - `task`：给该 role 的具体任务。\n\n要求：\n- 整条最终回复只能出现一个 `<team_message>`\n- 不要新增未说明字段\n</teamrun_completion_protocol>"
        )
    }

    #[test]
    fn skips_a_slot_that_is_not_due() {
        assert_eq!(plan_due_cron_trigger(armed(101), 100, Some(200)), Ok(None));
    }

    #[test]
    fn advances_before_requesting_a_due_slot() {
        let plan = plan_due_cron_trigger(armed(100), 100, Some(200));

        assert_eq!(
            plan,
            Ok(Some(DueCronTriggerPlan {
                next_slot_at: Some(200),
                fire: TriggerFireRequest {
                    run_id: "run-1".into(),
                    start_node_id: "start-1".into(),
                    source: TriggerSource::Cron,
                    idempotency_key: "team-cron:run-1:start-1:100".into(),
                },
            }))
        );
    }

    #[test]
    fn rejects_a_successor_that_cannot_prevent_refiring_the_elapsed_slot() {
        assert_eq!(
            plan_due_cron_trigger(armed(100), 1_000, Some(1_000)),
            Err(CronTriggerScheduleError::NonAdvancingNextSlot)
        );
    }

    #[test]
    fn disarms_when_the_due_slot_has_no_successor() {
        let plan = plan_due_cron_trigger(armed(100), 100, None)
            .unwrap()
            .unwrap();

        assert_eq!(plan.next_slot_at, None);
    }

    #[test]
    fn fires_the_elapsed_slot_once_when_reconciling_late() {
        let plan = plan_due_cron_trigger(armed(100), 1_000, Some(1_100))
            .unwrap()
            .unwrap();

        assert_eq!(plan.next_slot_at, Some(1_100));
        assert_eq!(plan.fire.source, TriggerSource::Cron);
        assert_eq!(plan.fire.idempotency_key, "team-cron:run-1:start-1:100");
    }

    #[test]
    fn schedule_ready_nodes_uses_typed_group_facts_and_parallel_capacity() {
        use crate::run::graph::{
            EdgeAction, EdgeDefinition, EdgeId, ExecutorPolicy, GraphDefinition, GraphRunId,
            NodeDefinition, NodeId, WorkAssignment,
        };
        use std::num::NonZeroU32;

        let work_a = NodeId::new("work-a");
        let work_b = NodeId::new("work-b");
        let graph = GraphState::initialize(
            GraphDefinition::new(
                "graph-1",
                "plan-1",
                GraphRunId::new("run-1"),
                "graph",
                vec![
                    NodeDefinition::work(
                        work_a.clone(),
                        "work a",
                        NonZeroU32::new(1).unwrap(),
                        WorkAssignment::typed(
                            "task-a",
                            "prompt",
                            ExecutorPolicy::team_role("role-a"),
                            None,
                            Some(GroupId::new("group-a")),
                        ),
                    ),
                    NodeDefinition::work(
                        work_b.clone(),
                        "work b",
                        NonZeroU32::new(1).unwrap(),
                        WorkAssignment::typed(
                            "task-b",
                            "next prompt",
                            ExecutorPolicy::team_role("role-b"),
                            None,
                            None,
                        ),
                    ),
                ],
                vec![EdgeDefinition::new(
                    EdgeId::new("work-a-work-b"),
                    work_a,
                    "completed",
                    work_b,
                    "input",
                    EdgeAction::Activate,
                )],
            )
            .unwrap(),
            1,
        );
        let selected = schedule_ready_nodes(&graph, 2, 1).unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(
            selected[0].activity_id().as_str(),
            "team-graph-activity:run-1:work-a:attempt:1"
        );
        assert_eq!(
            selected[0].idempotency_key(),
            selected[0].activity_id().as_str()
        );
        assert_eq!(selected[0].run_id().as_str(), "run-1");
        assert_eq!(selected[0].node_id().as_str(), "work-a");
        assert_eq!(selected[0].group_id().map(GroupId::as_str), Some("group-a"));
        assert!(matches!(
            selected[0].activity_kind(),
            ActivityKind::AgentTask { task_id, role_id, session_ref, prompt }
                if task_id == "task-a"
                    && role_id == "role-a"
                    && session_ref == "rs0"
                    && prompt == &expected_prompt(
                        "prompt",
                        work_decisions(),
                        "- `role-b`",
                    )
        ));
        let request = selected[0]
            .bind_activity_target(ActivityTarget::new("session-a").unwrap(), 3, 1)
            .unwrap();
        assert_eq!(request.activity_id, selected[0].activity_id().clone());
        assert_eq!(request.run_id, selected[0].run_id().clone());
        assert_eq!(request.node_id, selected[0].node_id().clone());
        assert_eq!(request.fence, selected[0].fence().clone());
        assert_eq!(request.target.as_str(), "session-a");
        assert_eq!(request.created_at, 3);
    }

    #[test]
    fn ready_scheduler_skips_agent_nodes_without_executable_prompt() {
        use crate::run::graph::{GraphDefinition, GraphRunId, NodeDefinition, NodeId};
        use std::num::NonZeroU32;

        let graph = GraphState::initialize(
            GraphDefinition::new(
                "graph-1",
                "plan-1",
                GraphRunId::new("run-1"),
                "graph",
                vec![NodeDefinition::work(
                    NodeId::new("work"),
                    "work",
                    NonZeroU32::new(1).unwrap(),
                    crate::WorkAssignment::new("task", "role"),
                )],
                Vec::new(),
            )
            .unwrap(),
            1,
        );

        assert!(schedule_ready_nodes(&graph, 1, 0).unwrap().is_empty());
        assert_eq!(graph.ready_queue().len(), 1);
    }

    #[test]
    fn work_prompt_lists_no_allowed_roles_without_downstream_agent_nodes() {
        use crate::run::graph::{
            ExecutorPolicy, GraphDefinition, GraphRunId, NodeDefinition, NodeId, WorkAssignment,
        };
        use std::num::NonZeroU32;

        let graph = GraphState::initialize(
            GraphDefinition::new(
                "graph-1",
                "plan-1",
                GraphRunId::new("run-1"),
                "graph",
                vec![NodeDefinition::work(
                    NodeId::new("work"),
                    "work",
                    NonZeroU32::new(1).unwrap(),
                    WorkAssignment::typed(
                        "task",
                        "solo prompt",
                        ExecutorPolicy::team_role("role"),
                        None,
                        None,
                    ),
                )],
                Vec::new(),
            )
            .unwrap(),
            1,
        );

        let selected = schedule_ready_nodes(&graph, 1, 0).unwrap();

        assert!(matches!(
            selected[0].activity_kind(),
            ActivityKind::AgentTask { prompt, .. }
                if prompt == &expected_prompt("solo prompt", work_decisions(), "- 无")
        ));
    }

    #[test]
    fn review_prompt_lists_completed_and_rework_decisions_with_downstream_roles() {
        use crate::run::graph::{
            EdgeAction, EdgeDefinition, EdgeId, ExecutorPolicy, GraphDefinition, GraphRunId,
            NodeDefinition, NodeId, ReviewAssignment, WorkAssignment,
        };
        use std::num::NonZeroU32;

        let review = NodeId::new("review");
        let accepted = NodeId::new("accepted");
        let rework = NodeId::new("rework");
        let graph = GraphState::initialize(
            GraphDefinition::new(
                "graph-1",
                "plan-1",
                GraphRunId::new("run-1"),
                "graph",
                vec![
                    NodeDefinition::review(
                        review.clone(),
                        "review",
                        NonZeroU32::new(1).unwrap(),
                        ReviewAssignment::new("reviewer", "review prompt"),
                    ),
                    NodeDefinition::work(
                        accepted.clone(),
                        "accepted",
                        NonZeroU32::new(1).unwrap(),
                        WorkAssignment::typed(
                            "task-accepted",
                            "accepted prompt",
                            ExecutorPolicy::team_role("role-accepted"),
                            None,
                            None,
                        ),
                    ),
                    NodeDefinition::work(
                        rework.clone(),
                        "rework",
                        NonZeroU32::new(2).unwrap(),
                        WorkAssignment::typed(
                            "task-rework",
                            "rework prompt",
                            ExecutorPolicy::team_role("role-rework"),
                            None,
                            None,
                        ),
                    ),
                ],
                vec![
                    EdgeDefinition::new(
                        EdgeId::new("review-accepted"),
                        review.clone(),
                        "completed",
                        accepted,
                        "input",
                        EdgeAction::Activate,
                    ),
                    EdgeDefinition::new(
                        EdgeId::new("review-rework"),
                        review.clone(),
                        "rework",
                        rework,
                        "input",
                        EdgeAction::Rework,
                    ),
                ],
            )
            .unwrap(),
            1,
        );

        let selected = schedule_ready_nodes(&graph, 1, 0).unwrap();

        assert_eq!(selected[0].node_id(), &review);
        assert!(matches!(
            selected[0].activity_kind(),
            ActivityKind::AgentTask { prompt, .. }
                if prompt == &expected_prompt(
                    "review prompt",
                    review_decisions(),
                    "- `role-accepted`\n- `role-rework`",
                )
        ));
    }

    #[test]
    fn rework_schedules_work_then_review_again_before_finishing() {
        use crate::run::graph::{
            AttemptReason, AttemptStatus, EdgeAction, EdgeDefinition, EdgeId, ExecutorPolicy,
            GraphDefinition, GraphEvent, GraphRunId, GraphState, NodeDefinition, NodeId,
            ReviewAssignment, WorkAssignment, reduce,
        };
        use std::num::NonZeroU32;

        let work = NodeId::new("work");
        let review = NodeId::new("review");
        let graph = GraphState::initialize(
            GraphDefinition::new(
                "graph-1",
                "plan-1",
                GraphRunId::new("run-1"),
                "graph",
                vec![
                    NodeDefinition::work(
                        work.clone(),
                        "work",
                        NonZeroU32::new(2).unwrap(),
                        WorkAssignment::typed(
                            "task-work",
                            "work prompt",
                            ExecutorPolicy::team_role("builder"),
                            None,
                            None,
                        ),
                    ),
                    NodeDefinition::review(
                        review.clone(),
                        "review",
                        NonZeroU32::new(2).unwrap(),
                        ReviewAssignment::new("reviewer", "review prompt"),
                    ),
                ],
                vec![
                    EdgeDefinition::new(
                        EdgeId::new("work-review"),
                        work.clone(),
                        "completed",
                        review.clone(),
                        "input",
                        EdgeAction::Activate,
                    ),
                    EdgeDefinition::new(
                        EdgeId::new("review-work"),
                        review.clone(),
                        "rework",
                        work.clone(),
                        "input",
                        EdgeAction::Rework,
                    ),
                ],
            )
            .unwrap(),
            1,
        );

        let work_fence = graph.current_attempt(&work).unwrap().fence().clone();
        let graph = reduce(
            graph,
            GraphEvent::NodeCompleted {
                node_id: work.clone(),
                fence: work_fence,
                output_port: "completed".into(),
                completed_at: 2,
            },
        )
        .unwrap();
        assert_eq!(graph.ready_queue()[0].node_id(), &review);

        let review_fence = graph.current_attempt(&review).unwrap().fence().clone();
        let graph = reduce(
            graph,
            GraphEvent::NodeCompleted {
                node_id: review.clone(),
                fence: review_fence,
                output_port: "rework".into(),
                completed_at: 3,
            },
        )
        .unwrap();
        let work_attempt = graph.current_attempt(&work).unwrap();
        assert_eq!(work_attempt.number(), NonZeroU32::new(2).unwrap());
        assert_eq!(work_attempt.status(), AttemptStatus::Ready);
        assert_eq!(work_attempt.reason(), &AttemptReason::Rework);

        let selected = schedule_ready_nodes(&graph, 1, 0).unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].node_id(), &work);
        assert_eq!(
            selected[0].activity_id().as_str(),
            "team-graph-activity:run-1:work:attempt:2"
        );
        assert_eq!(
            graph.current_attempt(&review).unwrap().status(),
            AttemptStatus::Pending
        );
        let graph = reduce(
            graph,
            GraphEvent::NodeCompleted {
                node_id: work,
                fence: selected[0].fence().clone(),
                output_port: "completed".into(),
                completed_at: 4,
            },
        )
        .unwrap();
        let selected = schedule_ready_nodes(&graph, 1, 0).unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].node_id(), &review);
        assert_eq!(
            selected[0].activity_id().as_str(),
            "team-graph-activity:run-1:review:attempt:2"
        );
        let graph = reduce(
            graph,
            GraphEvent::NodeCompleted {
                node_id: review,
                fence: selected[0].fence().clone(),
                output_port: "completed".into(),
                completed_at: 5,
            },
        )
        .unwrap();
        assert!(schedule_ready_nodes(&graph, 1, 0).unwrap().is_empty());
        assert_eq!(
            crate::run::graph::project(&graph).status,
            crate::run::graph::GraphStatus::Completed
        );
        assert_eq!(
            GraphState::restore_durable(graph.durable_snapshot()).unwrap(),
            graph
        );
    }

    #[test]
    fn ready_scheduler_skips_control_nodes_that_are_consumed_by_control_execution() {
        use crate::run::graph::{
            EdgeAction, EdgeDefinition, EdgeId, GraphDefinition, GraphEvent, GraphRunId,
            NodeDefinition, NodeId, reduce,
        };
        use std::num::NonZeroU32;

        let start = NodeId::new("start");
        let work = NodeId::new("work");
        let definition = GraphDefinition::new(
            "graph-1",
            "plan-1",
            GraphRunId::new("run-1"),
            "graph",
            vec![
                NodeDefinition::start(start.clone(), "start", NonZeroU32::new(1).unwrap(), None),
                NodeDefinition::work(
                    work.clone(),
                    "work",
                    NonZeroU32::new(1).unwrap(),
                    crate::WorkAssignment::typed(
                        "task",
                        "prompt",
                        crate::ExecutorPolicy::team_role("role"),
                        None,
                        None,
                    ),
                ),
            ],
            vec![EdgeDefinition::new(
                EdgeId::new("start-work"),
                start.clone(),
                "completed",
                work.clone(),
                "input",
                EdgeAction::Activate,
            )],
        )
        .unwrap();
        let graph = GraphState::initialize(definition, 1);

        assert!(schedule_ready_nodes(&graph, 1, 0).unwrap().is_empty());
        let fence = graph.current_attempt(&start).unwrap().fence().clone();
        let graph = reduce(
            graph,
            GraphEvent::NodeCompleted {
                node_id: start,
                fence,
                output_port: "completed".to_owned(),
                completed_at: 2,
            },
        )
        .unwrap();
        let scheduled = schedule_ready_nodes(&graph, 1, 0).unwrap();
        assert_eq!(scheduled.len(), 1);
        assert_eq!(scheduled[0].node_id(), &work);
    }

    #[test]
    fn ready_scheduler_is_a_read_only_projection_and_does_not_start_work() {
        use crate::run::graph::{
            GraphDefinition, GraphEvent, GraphRunId, NodeDefinition, NodeId, reduce,
        };
        use std::num::NonZeroU32;

        let node_id = NodeId::new("work");
        let graph = GraphState::initialize(
            GraphDefinition::new(
                "graph-1",
                "plan-1",
                GraphRunId::new("run-1"),
                "graph",
                vec![NodeDefinition::work(
                    node_id.clone(),
                    "work",
                    NonZeroU32::new(1).unwrap(),
                    crate::WorkAssignment::typed(
                        "task",
                        "prompt",
                        crate::ExecutorPolicy::team_role("role"),
                        None,
                        None,
                    ),
                )],
                Vec::new(),
            )
            .unwrap(),
            1,
        );
        let scheduled = schedule_ready_nodes(&graph, 1, 0).unwrap();
        assert_eq!(scheduled.len(), 1);
        assert_eq!(
            graph.current_attempt(&node_id).unwrap().status(),
            AttemptStatus::Ready
        );
        assert_eq!(graph.ready_queue().len(), 1);

        let started = reduce(
            graph,
            GraphEvent::AttemptStarted {
                node_id: node_id.clone(),
                fence: scheduled[0].fence().clone(),
                started_at: 2,
            },
        )
        .unwrap();
        assert_eq!(
            started.current_attempt(&node_id).unwrap().status(),
            AttemptStatus::Running
        );
        assert!(started.ready_queue().is_empty());
    }

    #[test]
    fn rejects_stale_ready_facts_and_invalid_parallel_limits() {
        use crate::run::graph::{GraphDefinition, GraphRunId, NodeDefinition, NodeId};
        use std::num::NonZeroU32;
        let graph = GraphState::initialize(
            GraphDefinition::new(
                "graph-1",
                "plan-1",
                GraphRunId::new("run-1"),
                "graph",
                vec![NodeDefinition::control(
                    NodeId::new("end"),
                    crate::NodeKind::End,
                    "end",
                    NonZeroU32::new(1).unwrap(),
                )],
                Vec::new(),
            )
            .unwrap(),
            1,
        );
        assert_eq!(
            schedule_ready_nodes(&graph, 0, 0),
            Err(ReadyScheduleError::ZeroParallelLimit)
        );
        assert_eq!(
            schedule_ready_nodes(&graph, 1, 2),
            Err(ReadyScheduleError::ActiveParallelExceedsLimit)
        );
    }

    #[test]
    fn rejects_a_due_trigger_without_a_run_identity() {
        let result = plan_due_cron_trigger(
            ArmedCronTrigger {
                run_id: " ".into(),
                start_node_id: "start-1".into(),
                next_slot_at: 100,
            },
            100,
            Some(200),
        );

        assert_eq!(
            result,
            Err(CronTriggerScheduleError::InvalidTrigger(
                TriggerFireRequestError::InvalidRunId
            ))
        );
    }
}
