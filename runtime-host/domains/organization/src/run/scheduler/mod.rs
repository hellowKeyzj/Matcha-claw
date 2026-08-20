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

use super::graph::{AttemptStatus, ExecutionFence, GraphState, GroupId, NodeId};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReadyNodeSchedule {
    node_id: NodeId,
    fence: ExecutionFence,
    group_id: Option<GroupId>,
}

impl ReadyNodeSchedule {
    pub fn node_id(&self) -> &NodeId {
        &self.node_id
    }

    pub fn fence(&self) -> &ExecutionFence {
        &self.fence
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
        let group_id = graph
            .definition()
            .node(item.node_id())
            .and_then(|node| node.work_assignment())
            .and_then(|work| work.group_id())
            .cloned();
        scheduled.push(ReadyNodeSchedule {
            node_id: item.node_id().clone(),
            fence: item.fence().clone(),
            group_id,
        });
    }
    Ok(scheduled)
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
            ExecutorPolicy, GraphDefinition, GraphRunId, NodeDefinition, NodeId, WorkAssignment,
        };
        use std::num::NonZeroU32;

        let graph = GraphState::initialize(
            GraphDefinition::new(
                "graph-1",
                "plan-1",
                GraphRunId::new("run-1"),
                "graph",
                vec![
                    NodeDefinition::work(
                        NodeId::new("work-a"),
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
                        NodeId::new("work-b"),
                        "work b",
                        NonZeroU32::new(1).unwrap(),
                        WorkAssignment::new("task-b", "role-b"),
                    ),
                ],
                Vec::new(),
            )
            .unwrap(),
            1,
        );
        let selected = schedule_ready_nodes(&graph, 2, 1).unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].node_id().as_str(), "work-a");
        assert_eq!(selected[0].group_id().map(GroupId::as_str), Some("group-a"));
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
