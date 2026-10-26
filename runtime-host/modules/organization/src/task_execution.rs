//! Private, typed execution seam for authorized World tasks. Not a loopback DTO.
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::{
    DeliveryFailure, DeliveryId, DeliveryPhase, DeliveryReceiptReference, ExecutionFence,
    GraphDefinition, GraphRunFacts, GraphRunId, GraphState, GraphStatus, IdempotencyKey,
    NativeDeliveryCorrelation, NativeTerminalStatus, NodeId, OrganizationStore,
    RuntimeEndpointReference, StoreFault, TeamId, TeamNodeOutput, TeamRevision,
    run::{
        delivery::TerminalObservationResolution, graph::project, lifecycle::GraphRunLifecycleState,
    },
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskTemplateSelection {
    pub team_id: TeamId,
    pub team_revision: TeamRevision,
    pub template_run_id: GraphRunId,
    pub template_graph_version: String,
}

#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskExecutionCorrelation {
    pub tenant_id: String,
    pub world_id: String,
    pub task_id: String,
    pub task_revision: u64,
    pub operation_id: String,
    pub incarnation: u64,
    pub world_run_id: String,
    pub step_id: String,
    pub attempt: u32,
    pub case_id: String,
    pub world_request_id: String,
}

#[derive(Clone, Eq, PartialEq)]
pub struct TaskExecutionIdentity {
    pub selection: TaskTemplateSelection,
    pub run_id: GraphRunId,
    pub request_id: IdempotencyKey,
    pub correlation: TaskExecutionCorrelation,
    pub material_digest: String,
}

#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskExecutionBudget {
    pub max_wall_time_ms: u64,
    pub max_steps: u64,
    pub max_source_reads: u64,
    pub max_rows: u64,
    pub max_bytes: u64,
    pub max_model_calls: u64,
    pub max_input_tokens: u64,
    pub max_output_tokens: u64,
    pub max_cost: Option<TaskExecutionCost>,
    pub deadline_unix_ms: Option<i64>,
}

#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskExecutionCost {
    pub amount: String,
    pub currency: String,
}

#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskExecutionContext {
    pub root_request_id: String,
    pub material_digest: String,
    pub budget: TaskExecutionBudget,
    pub correlation: TaskExecutionCorrelation,
}

impl std::fmt::Debug for TaskExecutionContext {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("TaskExecutionContext(<redacted>)")
    }
}

impl std::fmt::Debug for TaskExecutionCorrelation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("TaskExecutionCorrelation(<redacted>)")
    }
}

impl std::fmt::Debug for TaskExecutionBudget {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("TaskExecutionBudget(<redacted>)")
    }
}

impl std::fmt::Debug for TaskExecutionCost {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("TaskExecutionCost(<redacted>)")
    }
}

impl TaskExecutionContext {
    pub fn valid(&self) -> bool {
        let c = &self.correlation;
        [
            self.root_request_id.as_str(), self.material_digest.as_str(),
            c.tenant_id.as_str(), c.world_id.as_str(), c.task_id.as_str(),
            c.operation_id.as_str(), c.world_run_id.as_str(), c.step_id.as_str(),
            c.case_id.as_str(), c.world_request_id.as_str(),
        ].iter().all(|value| !value.trim().is_empty())
            && c.task_revision > 0 && c.attempt > 0
            && self.budget.max_cost.as_ref().is_none_or(|cost| {
                !cost.amount.trim().is_empty() && !cost.currency.trim().is_empty()
            })
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub enum TaskRunMeasurement {
    #[default]
    Unavailable,
    Available(TaskNativeMeasurement),
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "availability", rename_all = "snake_case", deny_unknown_fields)]
pub enum TaskMetric<T> {
    Available { value: T, provenance: String },
    Unavailable { provenance: String, reason: String },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskMeasurementScope {
    NativeQuery,
    NativeEmbeddedRun,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskMeasurementCoverage {
    ForegroundQueryResponses,
    CoreModelRequests,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskNativeMeasurement {
    pub scope: TaskMeasurementScope,
    pub coverage: TaskMeasurementCoverage,
    pub complete: bool,
    pub elapsed_ms: TaskMetric<u64>,
    pub input_tokens: TaskMetric<u64>,
    pub output_tokens: TaskMetric<u64>,
    pub cache_read_input_tokens: TaskMetric<u64>,
    pub cache_creation_input_tokens: TaskMetric<u64>,
    pub cost: TaskMetric<TaskExecutionCost>,
    pub model_calls: TaskMetric<u64>,
    pub steps: TaskMetric<u64>,
    pub source_reads: TaskMetric<u64>,
    pub rows: TaskMetric<u64>,
    pub bytes: TaskMetric<u64>,
}

/// Facts from one exact native run, not a World business outcome or aggregate usage.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskNativeExecution {
    pub endpoint_session_id: String,
    pub native_run_id: String,
    pub native_request_id: Option<String>,
    pub native_message_id: Option<String>,
    pub measurement: TaskRunMeasurement,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TaskNativeObservation {
    pub execution_context: Option<TaskExecutionContext>,
    pub native_request_id: Option<String>,
    pub native_message_id: Option<String>,
    pub measurement: TaskRunMeasurement,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskNativePhase {
    Queued,
    Started,
    WaitingForApproval,
    CancellationRequested,
    Cancelled,
    Completed,
    Failed,
    Interrupted,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TaskActivityInspection {
    Found {
        execution: TaskNativeExecution,
        phase: TaskNativePhase,
        assistant_texts: Vec<String>,
    },
    Unknown,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskBudgetDimension {
    WallTime,
    Steps,
    SourceReads,
    Rows,
    Bytes,
    ModelCalls,
    InputTokens,
    OutputTokens,
    Cost,
    Deadline,
}

#[derive(Clone)]
pub struct TaskExecutionRequest {
    pub identity: TaskExecutionIdentity,
    /// Rendered by the World owner from current-authorized material; never expected/oracle data.
    pub execution_prompt: String,
    pub budget: TaskExecutionBudget,
    pub created_at: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TaskExecutionRejection {
    InvalidInput,
    SelectionChanged,
    RequestConflict,
    NoAgentTask,
    RuntimeRejected,
    StartRejected,
    UnsupportedBudget {
        dimensions: Vec<TaskBudgetDimension>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TaskExecutionState {
    Pending,
    Accepted,
    Terminal,
    Rejected(TaskExecutionRejection),
    Unknown,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskExecutionSentness {
    NotSent,
    MayHaveSent,
}

#[derive(Clone)]
pub struct TaskExecutionReceipt {
    pub sentness: TaskExecutionSentness,
    pub identity: TaskExecutionIdentity,
    pub state: TaskExecutionState,
    pub graph_status: Option<GraphStatus>,
    pub activities: Vec<TaskActivityReceipt>,
    pub usage: TaskUsageCoverage,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskUsageCoverage {
    /// The Organization terminal producer currently carries no exact native usage facts.
    Unavailable,
}

#[derive(Clone)]
pub struct TaskActivityReceipt {
    pub delivery_id: DeliveryId,
    pub request_id: IdempotencyKey,
    pub node_id: NodeId,
    pub fence: ExecutionFence,
    pub retired: bool,
    pub endpoint: RuntimeEndpointReference,
    pub native_execution: Option<TaskNativeExecution>,
    pub state: TaskActivityState,
}

#[derive(Clone)]
pub enum TaskActivityState {
    Pending,
    Accepted {
        receipt: DeliveryReceiptReference,
        correlation: NativeDeliveryCorrelation,
    },
    Terminal {
        correlation: NativeDeliveryCorrelation,
        status: NativeTerminalStatus,
        output: Option<TeamNodeOutput>,
        resolution: TerminalObservationResolution,
    },
    Rejected {
        failure: DeliveryFailure,
    },
    Unknown,
    Unavailable,
}

impl TaskExecutionReceipt {
    pub(crate) fn new(identity: TaskExecutionIdentity, state: TaskExecutionState) -> Self {
        Self {
            sentness: TaskExecutionSentness::MayHaveSent,
            identity,
            state,
            graph_status: None,
            activities: Vec::new(),
            usage: TaskUsageCoverage::Unavailable,
        }
    }

    pub(crate) fn not_sent(mut self) -> Self {
        self.sentness = TaskExecutionSentness::NotSent;
        self
    }
}

impl TaskExecutionIdentity {
    pub(crate) fn valid(&self) -> bool {
        let c = &self.correlation;
        [
            self.run_id.as_str(),
            self.material_digest.as_str(),
            c.tenant_id.as_str(),
            c.world_id.as_str(),
            c.task_id.as_str(),
            c.operation_id.as_str(),
            c.world_run_id.as_str(),
            c.step_id.as_str(),
            c.case_id.as_str(),
            c.world_request_id.as_str(),
        ]
        .iter()
        .all(|value| !value.trim().is_empty())
            && c.task_revision > 0
            && c.attempt > 0
    }

    fn binding(&self) -> serde_json::Value {
        let s = &self.selection;
        let c = &self.correlation;
        json!({
            "team": s.team_id.as_str(), "teamRevision": s.team_revision.get().to_string(),
            "templateRun": s.template_run_id.as_str(), "templateVersion": s.template_graph_version,
            "run": self.run_id.as_str(), "request": self.request_id.as_str(),
            "tenant": c.tenant_id, "world": c.world_id, "task": c.task_id,
            "taskRevision": c.task_revision.to_string(), "operation": c.operation_id,
            "incarnation": c.incarnation.to_string(), "worldRun": c.world_run_id,
            "step": c.step_id, "attempt": c.attempt, "case": c.case_id,
            "worldRequest": c.world_request_id, "materialDigest": self.material_digest,
        })
    }

    fn plan_id(&self) -> String {
        format!("world-task:{}", hash(&self.binding().to_string()))
    }
}

impl TaskExecutionRequest {
    pub(crate) fn execution_context(&self) -> TaskExecutionContext {
        TaskExecutionContext {
            root_request_id: self.identity.request_id.as_str().to_owned(),
            material_digest: self.identity.material_digest.clone(),
            budget: self.budget.clone(),
            correlation: self.identity.correlation.clone(),
        }
    }

    fn budget_binding(&self) -> serde_json::Value {
        let b = &self.budget;
        json!({
            "wallTime": b.max_wall_time_ms.to_string(), "steps": b.max_steps.to_string(),
            "sourceReads": b.max_source_reads.to_string(), "rows": b.max_rows.to_string(),
            "bytes": b.max_bytes.to_string(), "modelCalls": b.max_model_calls.to_string(),
            "inputTokens": b.max_input_tokens.to_string(), "outputTokens": b.max_output_tokens.to_string(),
            "cost": b.max_cost.as_ref().map(|cost| json!({"amount": cost.amount, "currency": cost.currency})),
            "deadline": b.deadline_unix_ms.map(|value| value.to_string()),
        })
    }

    fn graph_id(&self) -> String {
        format!(
            "world-task-graph:{}",
            hash(
                &json!({
                    "identity": self.identity.binding(), "prompt": self.execution_prompt,
                    "budget": self.budget_binding(),
                })
                .to_string()
            )
        )
    }

}

impl TaskExecutionBudget {
    pub fn required_dimensions(&self) -> Vec<TaskBudgetDimension> {
        let mut dimensions = vec![
            TaskBudgetDimension::WallTime,
            TaskBudgetDimension::Steps,
            TaskBudgetDimension::SourceReads,
            TaskBudgetDimension::Rows,
            TaskBudgetDimension::Bytes,
            TaskBudgetDimension::ModelCalls,
            TaskBudgetDimension::InputTokens,
            TaskBudgetDimension::OutputTokens,
        ];
        if self.max_cost.is_some() {
            dimensions.push(TaskBudgetDimension::Cost);
        }
        if self.deadline_unix_ms.is_some() {
            dimensions.push(TaskBudgetDimension::Deadline);
        }
        dimensions
    }
}

impl TaskExecutionRequest {
    pub(crate) fn instantiate(
        &self,
        store: &OrganizationStore,
    ) -> Result<GraphRunFacts, TaskExecutionRejection> {
        if !self.identity.valid() || !self.execution_context().valid()
            || self.execution_prompt.trim().is_empty() {
            return Err(TaskExecutionRejection::InvalidInput);
        }
        let selection = &self.identity.selection;
        let team = store
            .facts()
            .team(&selection.team_id)
            .ok_or(TaskExecutionRejection::SelectionChanged)?;
        if team.tombstoned()
            || team.revision() != selection.team_revision
            || store.facts().materialization(&selection.team_id).is_none()
        {
            return Err(TaskExecutionRejection::SelectionChanged);
        }
        let template = store
            .facts()
            .run(&selection.template_run_id)
            .ok_or(TaskExecutionRejection::SelectionChanged)?;
        if template.team() != &selection.team_id
            || crate::store::codec::graph_version(template.graph().definition())
                .ok()
                .as_ref()
                != Some(&selection.template_graph_version)
        {
            return Err(TaskExecutionRejection::SelectionChanged);
        }
        let source = template.graph().definition();
        let mut nodes = source.nodes().to_vec();
        let context =
            json!({"identity": self.identity.binding(), "task": self.execution_prompt}).to_string();
        let mut bound = false;
        for node in &mut nodes {
            let prompt = node
                .work_assignment()
                .map(|work| work.prompt())
                .or_else(|| node.review_assignment().map(|review| review.prompt()));
            if let Some(prompt) = prompt {
                let prompt = format!("{prompt}\n\n<world_task>{context}</world_task>");
                bound |= node.set_agent_prompt(prompt);
            }
        }
        if !bound {
            return Err(TaskExecutionRejection::NoAgentTask);
        }
        let definition = GraphDefinition::new(
            self.graph_id(),
            self.identity.plan_id(),
            self.identity.run_id.clone(),
            source.title(),
            nodes,
            source.edges().to_vec(),
        )
        .map_err(|_| TaskExecutionRejection::InvalidInput)?;
        let mut run = GraphRunFacts::new(
            selection.team_id.clone(),
            selection.team_revision,
            GraphState::initialize_with_layout(
                definition,
                template.graph().layout().clone(),
                self.created_at,
            ),
            None,
        )
        .map_err(|_| TaskExecutionRejection::InvalidInput)?;
        run.restore_task_execution_context(Some(self.execution_context()))
            .map_err(|_| TaskExecutionRejection::InvalidInput)?;
        for node in run.graph().definition().nodes() {
            let role = node
                .work_assignment()
                .map(|work| work.role_id())
                .or_else(|| node.review_assignment().map(|review| review.role_id()));
            if role.is_some_and(|role| {
                !team
                    .definition()
                    .roles()
                    .iter()
                    .any(|item| item.role_id().as_str() == role)
            }) {
                return Err(TaskExecutionRejection::SelectionChanged);
            }
        }
        Ok(run)
    }

    pub(crate) fn matches_payload(&self, run: &GraphRunFacts) -> bool {
        matches_identity(run, &self.identity)
            && run.graph().definition().graph_id() == self.graph_id()
    }
}

fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

pub(crate) fn matches_identity(run: &GraphRunFacts, identity: &TaskExecutionIdentity) -> bool {
    run.team() == &identity.selection.team_id
        && run.run_id() == &identity.run_id
        && run.frozen_team_revision() == identity.selection.team_revision
        && run
            .lifecycle()
            .matches_creation(identity.request_id.as_str())
        && run.graph().definition().workflow_plan_id() == identity.plan_id()
        && run.task_execution_context().is_some_and(|context| {
            context.root_request_id == identity.request_id.as_str()
                && context.material_digest == identity.material_digest
                && context.correlation == identity.correlation
        })
}

pub(crate) fn inspect(
    store: &OrganizationStore,
    identity: TaskExecutionIdentity,
) -> TaskExecutionReceipt {
    let Some(run) = store.facts().run(&identity.run_id) else {
        return TaskExecutionReceipt::new(identity, TaskExecutionState::Unavailable);
    };
    if !identity.valid() || !matches_identity(run, &identity) {
        return TaskExecutionReceipt::new(
            identity,
            TaskExecutionState::Rejected(TaskExecutionRejection::RequestConflict),
        );
    }
    let Some(team) = store.facts().team(run.team()) else {
        return TaskExecutionReceipt::new(identity, TaskExecutionState::Unavailable);
    };
    if team.tombstoned() || team.revision() != identity.selection.team_revision {
        return TaskExecutionReceipt::new(
            identity,
            TaskExecutionState::Rejected(TaskExecutionRejection::SelectionChanged),
        );
    }
    let mut receipt = TaskExecutionReceipt::new(identity, TaskExecutionState::Pending);
    receipt.graph_status = Some(project(run.graph()).status);
    for delivery in store.facts().deliveries().deliveries() {
        let facts = delivery.facts();
        let node_id = NodeId::new(facts.node_id.clone());
        if facts.team_id != run.team().as_str() || facts.run_id != run.run_id().as_str() {
            continue;
        }
        let activity =
            store.facts().activities().activities().find(|activity| {
                activity.facts().activity_id.as_str() == facts.delivery_id.as_str()
            });
        let Some(activity) = activity else {
            receipt.state = TaskExecutionState::Unknown;
            continue;
        };
        let request = activity.facts();
        let fence = request.fence.clone();
        if request.run_id != *run.run_id()
            || request.node_id != node_id
            || request.node_execution_id.as_str() != facts.node_execution_id
            || request.idempotency_key != facts.idempotency_key
        {
            receipt.state = TaskExecutionState::Unknown;
            continue;
        }
        let binding = run.runtime().and_then(|runtime| {
            runtime.bindings().iter().find(|binding| {
                binding.role().as_str() == facts.role_id
                    && binding.session_ref().as_str() == facts.session_ref
            })
        });
        let Some(binding) = binding else {
            receipt.state = TaskExecutionState::Unknown;
            continue;
        };
        let state = match delivery.phase() {
            DeliveryPhase::Pending | DeliveryPhase::Delivering(_) => TaskActivityState::Pending,
            DeliveryPhase::Delivered {
                receipt,
                native_correlation: Some(correlation),
                ..
            } if correlation.endpoint_session_id() == binding.endpoint_session_id() => {
                TaskActivityState::Accepted {
                    receipt: receipt.clone(),
                    correlation: correlation.clone(),
                }
            }
            DeliveryPhase::TerminalObserved { observation }
                if observation.endpoint_session_id() == binding.endpoint_session_id()
                    && observation.graph_run_id() == run.run_id().as_str()
                    && observation.node_id() == node_id.as_str()
                    && observation.fence() == &fence =>
            {
                TaskActivityState::Terminal {
                    correlation: observation.correlation().clone(),
                    status: observation.native_terminal(),
                    output: observation.output().cloned(),
                    resolution: observation.resolution().clone(),
                }
            }
            DeliveryPhase::Failed { failure, .. }
            | DeliveryPhase::RetryScheduled { failure, .. } => {
                TaskActivityState::Rejected { failure: *failure }
            }
            DeliveryPhase::Cancelled { .. } => TaskActivityState::Unavailable,
            DeliveryPhase::Delivered { .. }
            | DeliveryPhase::TerminalObserved { .. }
            | DeliveryPhase::OutcomeUnknown { .. } => TaskActivityState::Unknown,
        };
        receipt.activities.push(TaskActivityReceipt {
            delivery_id: facts.delivery_id.clone(),
            request_id: IdempotencyKey::try_new(facts.idempotency_key.clone())
                .expect("durable delivery key is valid"),
            retired: run.execution_is_retired(&node_id, &fence),
            node_id,
            fence,
            endpoint: binding.endpoint().clone(),
            native_execution: delivery.task_native_execution().cloned(),
            state,
        });
    }
    if run.runtime().is_none()
        || !matches!(run.start_gate(), crate::RunStartGate::Started)
        || matches!(
            run.lifecycle().state(),
            GraphRunLifecycleState::OutcomeUnknown { .. }
                | GraphRunLifecycleState::Cancelling { .. }
        )
        || receipt.state == TaskExecutionState::Unknown
        || receipt
            .activities
            .iter()
            .any(|activity| matches!(activity.state, TaskActivityState::Unknown))
    {
        receipt.state = TaskExecutionState::Unknown;
    } else if matches!(
        run.lifecycle().state(),
        GraphRunLifecycleState::Cancelled { .. }
    ) || (matches!(
        receipt.graph_status,
        Some(GraphStatus::Completed | GraphStatus::Failed)
    ) && !receipt.activities.is_empty()
        && receipt
            .activities
            .iter()
            .all(|activity| matches!(activity.state, TaskActivityState::Terminal { .. })))
    {
        receipt.state = TaskExecutionState::Terminal;
    } else if receipt.activities.iter().any(|activity| {
        matches!(
            activity.state,
            TaskActivityState::Accepted { .. } | TaskActivityState::Terminal { .. }
        )
    }) {
        receipt.state = TaskExecutionState::Accepted;
    }
    receipt
}

pub(crate) fn store_failure(
    identity: TaskExecutionIdentity,
    error: &StoreFault,
) -> TaskExecutionReceipt {
    let state = if matches!(
        error,
        StoreFault::CommitOutcomeUnknown(_) | StoreFault::RecoveryRequired
    ) {
        TaskExecutionState::Unknown
    } else {
        TaskExecutionState::Unavailable
    };
    TaskExecutionReceipt::new(identity, state)
}
