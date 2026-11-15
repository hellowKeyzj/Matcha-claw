mod activity_prompt;
mod approval;
mod changes;
mod prompts;
mod deletion;
mod refresh;
mod role_sessions;
mod workspace;
mod transaction;

use approval::validate_approval_resolutions;
use transaction::{DeliveryIndexEntries, DeliveryIndexes, FactsJournal};
pub(crate) use role_sessions::{RoleSessionIntent, RoleSessionPhase};
use crate::team::lifecycle::{TeamMaterializationGroups, materialization_matches_request};
use crate::{ConfirmedTeamMaterialization, RuntimeEndpointReference};

use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
};

use platform::trace::{identifier_hash, runtime_trace};
use serde_json::json;

#[cfg(test)]
use crate::{ActivityLedgerSnapshot, DeliveryLedgerSnapshot, run::approval::ApprovalDurableSnapshot};

use crate::{
    Activity, ActivityClaim, ActivityClaimOutcome, ActivityDispatchOutcome, ActivityId,
    ActivityKind, ActivityLedger, ActivityPhase,
    ActivityRegistrationOutcome, ActivityRequest, ActivitySettlement, ActivitySettlementOutcome,
    ActivityTarget, ActivityTransitionError, AgentNodeEventResolution,
    AgentNodeEventResolutionError, Approval, ControlAuthority, ControlNodeResolution,
    ControlNodeResolutionError, ControlNodeResolutionOutcome, DeliveryLedger,
    DeliveryPhase, GraphDefinition, GraphRunId, GraphState, IdempotencyKey,
    MaterializationLifecycleError, MaterializationOperationOutcome, MaterializationReceipt,
    MaterializationRecordOutcome, NodeKind, RunRuntimeReceipt, TeamDefinition, TeamId,
    TeamMaterializationLifecycle, TeamMaterializationRequest, TeamRevision,
    run::artifact::{
        ArtifactEvidenceProvenance, ArtifactLedger, ArtifactRecord, ArtifactRecordOutcome,
        CompletionMetadata, build_graph_completion_artifact,
    },
    run::{
        approval::{ApprovalBinding, HumanDecisionCommand, HumanDecisionOutcome},
        control::ControlResolutionLedger,
        decision::{
            TeamDecisionCommand, TeamDecisionLedger, TeamDecisionReceipt, TeamDecisionRecordError,
        },
        delivery::{
            AuthorizedGraphResolution, AuthorizedGraphResolutionError,
            AuthorizedGraphResolutionOutcome, NativeTerminalStatus, TerminalObservation,
            TerminalObservationError, TerminalObservationOutcome, TerminalObservationResolution,
            observe_native_terminal as apply_terminal_observation,
            resolve_authorized_graph_outcome as apply_authorized_graph_resolution,
            resolve_native_run_output as apply_native_run_output,
        },
        event::{EventLedger, EventLedgerSnapshot},
        evidence::{EvidenceLedger, EvidenceRecord, RecordOutcome},
        graph::{ExecutionFence, GraphDurableSnapshot, GraphEvent, NodeId},
        lifecycle::{
            BeginCancellationOutcome, CreateGraphRunOutcome, GraphRunLifecycle,
            GraphRunLifecycleState, ResumeOutcome, RoleAbortOutcome, SettleCancellationOutcome,
            TombstoneOutcome,
        },
        purge::{
            GraphRunPurgeOutcome, GraphRunPurgeRejection, GraphRunPurgeUnknown,
            NativeDeletionEvidence, TeamRunPurgeRequest,
        },
        trigger::{
            RestoreTriggerLedgerError, TriggerFireError, TriggerFireRequest, TriggerLedger,
            TriggerRegistration,
        },
    },
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TeamFacts {
    definition: TeamDefinition,
    revision: TeamRevision,
    tombstoned: bool,
    workspace_directory_name: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TeamTombstoneOutcome {
    Tombstoned,
    Replayed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ApprovalResolutionOutcome {
    Recorded,
    Replayed,
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct PendingWorkflowPlanAdmission {
    team_id: TeamId,
    run_id: GraphRunId,
    creation_idempotency_key: String,
    team_revision: TeamRevision,
    source_identity: String,
    created_at: u64,
}

impl fmt::Debug for PendingWorkflowPlanAdmission {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PendingWorkflowPlanAdmission")
            .field("team_id", &self.team_id)
            .field("run_id", &self.run_id)
            .field("creation_idempotency_key", &"<redacted>")
            .field("team_revision", &self.team_revision)
            .field("source_identity", &"<redacted>")
            .field("created_at", &self.created_at)
            .finish()
    }
}

impl PendingWorkflowPlanAdmission {
    pub fn try_new(
        team_id: TeamId,
        run_id: GraphRunId,
        creation_idempotency_key: impl Into<String>,
        team_revision: TeamRevision,
        source_identity: impl Into<String>,
        created_at: u64,
    ) -> Result<Self, OrganizationFactsError> {
        let creation_idempotency_key = creation_idempotency_key.into();
        let source_identity = source_identity.into();
        if run_id.as_str().trim().is_empty()
            || creation_idempotency_key.trim().is_empty()
            || source_identity.trim().is_empty()
        {
            return Err(OrganizationFactsError::InvalidWorkflowPlanAdmission);
        }
        Ok(Self {
            team_id,
            run_id,
            creation_idempotency_key,
            team_revision,
            source_identity,
            created_at,
        })
    }

    pub fn team_id(&self) -> &TeamId {
        &self.team_id
    }

    pub fn run_id(&self) -> &GraphRunId {
        &self.run_id
    }

    pub fn creation_idempotency_key(&self) -> &str {
        &self.creation_idempotency_key
    }

    pub const fn team_revision(&self) -> TeamRevision {
        self.team_revision
    }

    pub fn source_identity(&self) -> &str {
        &self.source_identity
    }

    pub const fn created_at(&self) -> u64 {
        self.created_at
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PurgedRunMarker {
    run_id: GraphRunId,
    idempotency_key: String,
    purged_at: u64,
}

impl PurgedRunMarker {
    pub(crate) fn try_new(
        run_id: GraphRunId,
        idempotency_key: String,
        purged_at: u64,
    ) -> Result<Self, OrganizationFactsError> {
        if run_id.as_str().trim().is_empty() || idempotency_key.trim().is_empty() {
            return Err(OrganizationFactsError::InvalidPurgedRunMarker);
        }
        Ok(Self {
            run_id,
            idempotency_key,
            purged_at,
        })
    }

    pub(crate) fn run_id(&self) -> &GraphRunId {
        &self.run_id
    }

    pub(crate) fn idempotency_key(&self) -> &str {
        &self.idempotency_key
    }

    pub(crate) const fn purged_at(&self) -> u64 {
        self.purged_at
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum WorkflowPlanAdmissionOutcome {
    Recorded(PendingWorkflowPlanAdmission),
    Replayed(PendingWorkflowPlanAdmission),
    AlreadySubmitted(GraphRunId),
    ConflictingRun,
    ConflictingIdempotency,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum WorkflowPlanSubmitOutcome {
    Submitted(GraphRunId),
    Replayed(GraphRunId),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum RunStartGate {
    Intake,
    Designing {
        design_epoch: String,
        prompt_generation: Option<String>,
    },
    Started,
}

impl RunStartGate {
    pub(super) fn exit_design(&mut self, epoch: &str) -> Result<bool, ()> {
        match self {
            Self::Intake => Ok(false),
            Self::Designing { design_epoch, .. } if design_epoch == epoch => {
                *self = Self::Intake;
                Ok(true)
            }
            _ => Err(()),
        }
    }

    pub(crate) fn valid(&self) -> bool {
        match self {
            Self::Intake | Self::Started => true,
            Self::Designing {
                design_epoch,
                prompt_generation,
            } => {
                !design_epoch.trim().is_empty()
                    && prompt_generation
                        .as_ref()
                        .is_none_or(|value| !value.trim().is_empty())
            }
        }
    }

    fn can_transition_from(&self, previous: &Self) -> bool {
        if !self.valid() {
            return false;
        }
        if matches!(self, Self::Designing { .. }) {
            return !matches!(previous, Self::Started);
        }
        if matches!(previous, Self::Designing { .. }) {
            return matches!(self, Self::Intake | Self::Started);
        }
        matches!(
            (previous, self),
            (Self::Intake, Self::Intake | Self::Started)
                | (Self::Started, Self::Started)
        )
    }
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct WorkflowTemplateFacts {
    team: TeamId,
    source_identity: String,
    revision: u64,
    plan: crate::run::WorkflowPlan,
}

impl fmt::Debug for WorkflowTemplateFacts {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkflowTemplateFacts")
            .field("team", &self.team)
            .field("source_identity", &"<redacted>")
            .field("revision", &self.revision)
            .field("workflow_plan_id", &self.plan.workflow_plan_id())
            .field("run_id", &self.plan.run_id())
            .field("title", &self.plan.title())
            .field("status", &self.plan.status())
            .field("task_count", &self.plan.tasks().len())
            .field("created_at", &self.plan.created_at())
            .finish()
    }
}

impl WorkflowTemplateFacts {
    pub fn new(
        team: TeamId,
        source_identity: impl Into<String>,
        revision: u64,
        plan: crate::run::WorkflowPlan,
    ) -> Result<Self, OrganizationFactsError> {
        let source_identity = source_identity.into();
        if source_identity.trim().is_empty() || crate::run::compile_workflow_plan(&plan).is_err() {
            return Err(OrganizationFactsError::InvalidWorkflowTemplate);
        }
        Ok(Self {
            team,
            source_identity,
            revision,
            plan,
        })
    }

    pub(crate) fn from_plan(
        team: TeamId,
        source_identity: String,
        revision: u64,
        plan: crate::run::WorkflowPlan,
    ) -> Result<Self, OrganizationFactsError> {
        Self::new(team, source_identity, revision, plan)
    }

    pub fn team(&self) -> &TeamId {
        &self.team
    }
    pub fn source_identity(&self) -> &str {
        &self.source_identity
    }
    pub const fn revision(&self) -> u64 {
        self.revision
    }
    pub fn plan(&self) -> &crate::run::WorkflowPlan {
        &self.plan
    }

    pub fn instantiate(
        &self,
        run_id: GraphRunId,
        idempotency_key: &str,
        created_at: u64,
    ) -> Result<GraphState, OrganizationFactsError> {
        if idempotency_key.trim().is_empty() {
            return Err(OrganizationFactsError::InvalidWorkflowTemplate);
        }
        let compilation = crate::run::compile_workflow_plan(&self.plan)
            .map_err(|_| OrganizationFactsError::InvalidWorkflowTemplate)?;
        let definition = GraphDefinition::new(
            format!("team-graph:{}", run_id.as_str()),
            format!("graph-{idempotency_key}"),
            run_id,
            compilation.definition().title().to_owned(),
            compilation.definition().nodes().to_vec(),
            compilation.definition().edges().to_vec(),
        )
        .map_err(|_| OrganizationFactsError::InvalidWorkflowTemplate)?;
        Ok(GraphState::initialize(definition, created_at))
    }
}

#[cfg(test)]
pub(crate) struct TeamRunFactsRestoreInput {
    pub teams: Vec<TeamFacts>,
    pub materializations: Vec<MaterializationReceipt>,
    pub runs: Vec<GraphRunFacts>,
    pub pending_workflow_plan_admissions: Vec<PendingWorkflowPlanAdmission>,
    pub templates: Vec<WorkflowTemplateFacts>,
    pub deliveries: DeliveryLedgerSnapshot,
    pub activities: ActivityLedgerSnapshot,
    pub triggers: Vec<TriggerFireRequest>,
    pub control_resolutions: Vec<ControlNodeResolution>,
    pub approvals: Vec<ApprovalDurableSnapshot>,
    pub events: EventLedgerSnapshot,
    pub evidence: Vec<EvidenceRecord>,
}

#[derive(Default)]
pub(crate) struct FactsRestoreInput {
    pub(crate) teams: Vec<TeamFacts>,
    pub(crate) materializations: Vec<(TeamId, TeamMaterializationGroups)>,
    pub(crate) runs: Vec<GraphRunFacts>,
    pub(crate) pending_workflow_plan_admissions: Vec<PendingWorkflowPlanAdmission>,
    pub(crate) templates: Vec<WorkflowTemplateFacts>,
    pub(crate) deliveries: DeliveryLedger,
    pub(crate) activities: ActivityLedger,
    pub(crate) triggers: Vec<TriggerFireRequest>,
    pub(crate) control_resolutions: Vec<ControlNodeResolution>,
    pub(crate) approvals: Vec<Approval>,
    pub(crate) events: EventLedgerSnapshot,
    pub(crate) evidence: Vec<EvidenceRecord>,
    pub(crate) decisions: TeamDecisionLedger,
    pub(crate) artifacts: Vec<ArtifactRecord>,
    pub(crate) task_board: crate::run::TaskBoardFacts,
    pub(crate) purged_runs: Vec<PurgedRunMarker>,
    pub(crate) team_prompts: crate::prompts::TeamPromptSettings,
}

pub(crate) struct ApprovalResolutionInput {
    pub run_id: GraphRunId,
    pub approval_id: String,
    pub stage_id: String,
    pub role_id: String,
    pub decision: crate::ApprovalDecision,
    pub resolved_at: u64,
    pub note: Option<String>,
    pub idempotency_key: String,
}

impl TeamFacts {
    pub fn new(definition: TeamDefinition, revision: TeamRevision, tombstoned: bool) -> Self {
        Self {
            definition,
            revision,
            tombstoned,
            workspace_directory_name: None,
        }
    }

    pub(crate) fn workspace_directory_name(&self) -> Option<&str> {
        self.workspace_directory_name.as_deref()
    }

    pub(crate) fn restore_workspace_directory_name(&mut self, name: Option<String>) -> Result<(), OrganizationFactsError> {
        if name.as_ref().is_some_and(|name| !crate::run::workspace::valid_directory_name(name))
            || self.workspace_directory_name.as_ref().is_some_and(|old| Some(old) != name.as_ref()) {
            return Err(OrganizationFactsError::InvalidTeamTransition);
        }
        self.workspace_directory_name = name;
        Ok(())
    }

    pub fn definition(&self) -> &TeamDefinition {
        &self.definition
    }

    pub fn team_id(&self) -> &TeamId {
        self.definition.team_id()
    }

    pub const fn revision(&self) -> TeamRevision {
        self.revision
    }

    pub const fn tombstoned(&self) -> bool {
        self.tombstoned
    }

    fn tombstone(&mut self) -> TeamTombstoneOutcome {
        if self.tombstoned {
            TeamTombstoneOutcome::Replayed
        } else {
            self.tombstoned = true;
            TeamTombstoneOutcome::Tombstoned
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct GraphRunFacts {
    team: TeamId,
    frozen_team_revision: TeamRevision,
    graph: GraphState,
    runtime: Option<RunRuntimeReceipt>,
    workspace: Option<crate::RunWorkspace>,
    role_session_intents: BTreeMap<String, RoleSessionIntent>,
    deletion_confirmations: Vec<crate::RoleSessionDeletionConfirmation>,
    lifecycle: GraphRunLifecycle,
    pub(super) start_gate: RunStartGate,
    pub(super) retired_executions: BTreeSet<(NodeId, ExecutionFence)>,
    pub(super) task_execution_context: Option<crate::TaskExecutionContext>,
}

impl GraphRunFacts {
    pub fn new(
        team: TeamId,
        frozen_team_revision: TeamRevision,
        graph: GraphState,
        runtime: Option<RunRuntimeReceipt>,
    ) -> Result<Self, OrganizationFactsError> {
        Self::with_lifecycle_and_start_gate(
            team,
            frozen_team_revision,
            graph,
            runtime,
            GraphRunLifecycle::active(),
            RunStartGate::Intake,
        )
    }

    pub(crate) fn with_lifecycle(
        team: TeamId,
        frozen_team_revision: TeamRevision,
        graph: GraphState,
        runtime: Option<RunRuntimeReceipt>,
        lifecycle: GraphRunLifecycle,
    ) -> Result<Self, OrganizationFactsError> {
        Self::with_lifecycle_and_start_gate(
            team,
            frozen_team_revision,
            graph,
            runtime,
            lifecycle,
            RunStartGate::Intake,
        )
    }

    pub(crate) fn with_lifecycle_and_start_gate(
        team: TeamId,
        frozen_team_revision: TeamRevision,
        graph: GraphState,
        runtime: Option<RunRuntimeReceipt>,
        lifecycle: GraphRunLifecycle,
        start_gate: RunStartGate,
    ) -> Result<Self, OrganizationFactsError> {
        if graph.definition().run_id().as_str().trim().is_empty() {
            return Err(OrganizationFactsError::InvalidGraphRun);
        }
        if !start_gate.valid() {
            return Err(OrganizationFactsError::InvalidRunStartGate);
        }
        if runtime
            .as_ref()
            .is_some_and(|runtime| runtime.team_run() != graph.definition().run_id())
        {
            return Err(OrganizationFactsError::RuntimeRunMismatch);
        }
        Ok(Self {
            team,
            frozen_team_revision,
            graph,
            runtime,
            workspace: None,
            role_session_intents: BTreeMap::new(),
            deletion_confirmations: Vec::new(),
            lifecycle,
            start_gate,
            retired_executions: BTreeSet::new(),
            task_execution_context: None,
        })
    }

    pub(crate) fn workspace(&self) -> Option<&crate::RunWorkspace> {
        self.workspace.as_ref()
    }

    pub(crate) fn workspace_ready(&self) -> bool {
        self.workspace().is_some_and(crate::RunWorkspace::is_prepared) && self.runtime().is_some()
    }

    pub(crate) fn restore_workspace(&mut self, workspace: Option<crate::RunWorkspace>) -> Result<(), OrganizationFactsError> {
        self.validate_workspace_transition(self.workspace.as_ref(), workspace.as_ref())?;
        self.workspace = workspace;
        Ok(())
    }

    fn validate_workspace_transition(
        &self, previous: Option<&crate::RunWorkspace>, current: Option<&crate::RunWorkspace>,
    ) -> Result<(), OrganizationFactsError> {
        if previous.is_some_and(|previous| current.is_none_or(|current| {
            previous.root() != current.root() || (previous.is_prepared() && !current.is_prepared())
        })) {
            return Err(OrganizationFactsError::RunOwnershipChanged);
        }
        Ok(())
    }

    pub(crate) fn task_execution_context(&self) -> Option<&crate::TaskExecutionContext> {
        self.task_execution_context.as_ref()
    }

    pub(crate) fn restore_task_execution_context(
        &mut self,
        context: Option<crate::TaskExecutionContext>,
    ) -> Result<(), OrganizationFactsError> {
        if context.as_ref().is_some_and(|context| !context.valid()
            || (!self.lifecycle.creation_idempotency_key().is_empty()
                && context.root_request_id != self.lifecycle.creation_idempotency_key()))
            || self.task_execution_context.as_ref().is_some_and(|old| Some(old) != context.as_ref())
        {
            return Err(OrganizationFactsError::InvalidGraphRun);
        }
        self.task_execution_context = context;
        Ok(())
    }

    pub(crate) fn retired_executions(&self) -> &BTreeSet<(NodeId, ExecutionFence)> {
        &self.retired_executions
    }

    pub(crate) fn restore_retired_executions(
        &mut self,
        retired: BTreeSet<(NodeId, ExecutionFence)>,
    ) -> Result<(), OrganizationFactsError> {
        self.validate_retired_executions(&retired)?;
        self.retired_executions = retired;
        Ok(())
    }

    fn validate_retired_executions(
        &self,
        retired: &BTreeSet<(NodeId, ExecutionFence)>,
    ) -> Result<(), OrganizationFactsError> {
        for (node, fence) in retired {
            let number = fence
                .attempt_id()
                .as_str()
                .strip_prefix(&format!("{}:attempt:", node.as_str()))
                .and_then(|number| number.parse::<std::num::NonZeroU32>().ok())
                .ok_or(OrganizationFactsError::InvalidGraphRun)?;
            if node.as_str().trim().is_empty()
                || fence.attempt_id() != &crate::AttemptId::for_node(node, number)
                || !fence.node_execution_id().matches_attempt(node, number)
                || self
                    .graph
                    .executions()
                    .values()
                    .flat_map(|history| history.attempts())
                    .any(|attempt| attempt.fence() == fence)
            {
                return Err(OrganizationFactsError::InvalidGraphRun);
            }
        }
        Ok(())
    }

    pub(crate) fn execution_is_retired(&self, node: &NodeId, fence: &ExecutionFence) -> bool {
        self.retired_executions
            .contains(&(node.clone(), fence.clone()))
    }

    fn retired_execution_has_attempt(&self, node: &NodeId, fence: &ExecutionFence) -> bool {
        self.graph.executions().get(node).is_some_and(|history| {
            history
                .attempts()
                .iter()
                .any(|attempt| attempt.fence().attempt_id() == fence.attempt_id())
        })
    }

    pub fn team(&self) -> &TeamId {
        &self.team
    }

    pub const fn frozen_team_revision(&self) -> TeamRevision {
        self.frozen_team_revision
    }

    pub fn graph(&self) -> &GraphState {
        &self.graph
    }

    pub(crate) fn graph_mut(&mut self) -> &mut GraphState {
        &mut self.graph
    }

    pub(crate) fn replace_header(
        &mut self, team: TeamId, revision: TeamRevision, runtime: Option<RunRuntimeReceipt>,
        lifecycle: GraphRunLifecycle, start_gate: RunStartGate,
    ) {
        self.team = team;
        self.frozen_team_revision = revision;
        self.runtime = runtime;
        self.lifecycle = lifecycle;
        self.start_gate = start_gate;
    }

    pub fn runtime(&self) -> Option<&RunRuntimeReceipt> {
        self.runtime.as_ref()
    }

    pub fn lifecycle(&self) -> &GraphRunLifecycle {
        &self.lifecycle
    }

    pub fn start_gate(&self) -> &RunStartGate {
        &self.start_gate
    }

    pub fn run_id(&self) -> &GraphRunId {
        self.graph.definition().run_id()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Default)]
pub(crate) struct OrganizationFacts {
    teams: BTreeMap<String, TeamFacts>,
    materializations: BTreeMap<String, TeamMaterializationGroups>,
    runs: BTreeMap<String, GraphRunFacts>,
    deliveries: DeliveryLedger,
    activities: ActivityLedger,
    triggers: TriggerLedger,
    control_resolutions: ControlResolutionLedger,
    approvals: BTreeMap<String, Approval>,
    approval_ids_by_run: BTreeMap<String, BTreeSet<String>>,
    events: EventLedger,
    evidence: EvidenceLedger,
    artifacts: ArtifactLedger,
    decisions: TeamDecisionLedger,
    templates: BTreeMap<String, WorkflowTemplateFacts>,
    pending_workflow_plan_admissions: BTreeMap<String, PendingWorkflowPlanAdmission>,
    task_board: crate::run::TaskBoardFacts,
    purged_runs: BTreeMap<String, PurgedRunMarker>,
    team_prompts: crate::prompts::TeamPromptSettings,
    journal: FactsJournal,
    delivery_indexes: DeliveryIndexes,
}

impl OrganizationFacts {
    #[cfg(test)]
    pub fn restore(
        teams: impl IntoIterator<Item = TeamFacts>,
        materializations: impl IntoIterator<Item = MaterializationReceipt>,
        runs: impl IntoIterator<Item = GraphRunFacts>,
        deliveries: DeliveryLedgerSnapshot,
    ) -> Result<Self, OrganizationFactsError> {
        Self::restore_with_triggers(teams, materializations, runs, deliveries, [])
    }

    #[cfg(test)]
    pub(crate) fn restore_with_triggers(
        teams: impl IntoIterator<Item = TeamFacts>,
        materializations: impl IntoIterator<Item = MaterializationReceipt>,
        runs: impl IntoIterator<Item = GraphRunFacts>,
        deliveries: DeliveryLedgerSnapshot,
        triggers: impl IntoIterator<Item = TriggerFireRequest>,
    ) -> Result<Self, OrganizationFactsError> {
        Self::restore_with_teamrun_ledgers(TeamRunFactsRestoreInput {
            teams: teams.into_iter().collect(),
            materializations: materializations.into_iter().collect(),
            runs: runs.into_iter().collect(),
            pending_workflow_plan_admissions: Vec::new(),
            templates: Vec::new(),
            deliveries,
            activities: ActivityLedgerSnapshot::new(Vec::new()),
            triggers: triggers.into_iter().collect(),
            control_resolutions: Vec::new(),
            approvals: Vec::new(),
            events: EventLedgerSnapshot::default(),
            evidence: Vec::new(),
        })
    }

    #[cfg(test)]
    pub(crate) fn restore_with_teamrun_ledgers(
        input: TeamRunFactsRestoreInput,
    ) -> Result<Self, OrganizationFactsError> {
        let mut headers = FactsRestoreInput {
            teams: input.teams,
            materializations: input.materializations.into_iter().map(|receipt| {
                (receipt.team().clone(), TeamMaterializationGroups {
                    requests: None,
                    groups: vec![TeamMaterializationLifecycle::Confirmed(receipt)],
                })
            }).collect(),
            runs: input.runs,
            pending_workflow_plan_admissions: input.pending_workflow_plan_admissions,
            templates: input.templates,
            ..FactsRestoreInput::default()
        };
        let mut facts = Self::restore_headers(&mut headers)?;
        facts.deliveries = DeliveryLedger::restore(input.deliveries)
            .map_err(OrganizationFactsError::InvalidDeliveryLedger)?;
        facts.activities = ActivityLedger::restore(input.activities)
            .map_err(OrganizationFactsError::InvalidActivityLedger)?;
        facts.restore_registrations(input.triggers, input.evidence, input.control_resolutions)?;
        for snapshot in input.approvals {
            let approval = Approval::restore(snapshot)
                .map_err(|_| OrganizationFactsError::InvalidApprovalLedger)?;
            facts.restore_approval(approval)?;
        }
        facts.finish_restore(Vec::new(), input.events)?;
        Ok(facts)
    }

    pub(crate) fn from_restored(mut input: FactsRestoreInput) -> Result<Self, OrganizationFactsError> {
        let mut facts = Self::restore_headers(&mut input)?;
        facts.deliveries = input.deliveries;
        facts.activities = input.activities;
        facts.decisions = input.decisions;
        facts.task_board = input.task_board;
        facts.team_prompts = input.team_prompts;
        facts.restore_registrations(input.triggers, input.evidence, input.control_resolutions)?;
        for approval in input.approvals {
            facts.restore_approval(approval)?;
        }
        facts.finish_restore(input.artifacts, input.events)?;
        Ok(facts)
    }

    fn restore_headers(input: &mut FactsRestoreInput) -> Result<Self, OrganizationFactsError> {
        let mut team_facts = BTreeMap::new();
        for team in std::mem::take(&mut input.teams) {
            if team_facts
                .insert(team.team_id().as_str().to_owned(), team)
                .is_some()
            {
                return Err(OrganizationFactsError::DuplicateTeam);
            }
        }

        let mut materialization_facts = BTreeMap::new();
        for (team_id, lifecycle) in std::mem::take(&mut input.materializations) {
            let team = team_id.as_str().to_owned();
            validate_materialization(&team_facts, &team_id, &lifecycle)?;
            if materialization_facts.insert(team, lifecycle).is_some() {
                return Err(OrganizationFactsError::DuplicateMaterialization);
            }
        }

        let mut template_facts = BTreeMap::new();
        for template in std::mem::take(&mut input.templates) {
            validate_template(&team_facts, &template)?;
            if template_facts
                .insert(template.team().as_str().to_owned(), template)
                .is_some()
            {
                return Err(OrganizationFactsError::DuplicateWorkflowTemplate);
            }
        }

        validate_team_workspaces(&team_facts)?;
        let mut run_facts = BTreeMap::new();
        for run in std::mem::take(&mut input.runs) {
            validate_restored_run(&team_facts, &run)?;
            if run_facts
                .insert(run.run_id().as_str().to_owned(), run)
                .is_some()
            {
                return Err(OrganizationFactsError::DuplicateRun);
            }
        }
        let mut purged_run_facts = BTreeMap::new();
        for marker in std::mem::take(&mut input.purged_runs) {
            if run_facts.contains_key(marker.run_id().as_str())
                || purged_run_facts
                    .insert(marker.run_id().as_str().to_owned(), marker)
                    .is_some()
            {
                return Err(OrganizationFactsError::DuplicatePurgedRunMarker);
            }
        }

        let mut pending_admissions = BTreeMap::new();
        for admission in std::mem::take(&mut input.pending_workflow_plan_admissions) {
            validate_admission(&team_facts, &run_facts, pending_admissions.values(), &admission)?;
            if pending_admissions
                .insert(admission.run_id().as_str().to_owned(), admission)
                .is_some()
            {
                return Err(OrganizationFactsError::DuplicateWorkflowPlanAdmission);
            }
        }

        let facts = Self {
            teams: team_facts,
            materializations: materialization_facts,
            runs: run_facts,
            templates: template_facts,
            pending_workflow_plan_admissions: pending_admissions,
            purged_runs: purged_run_facts,
            ..Self::default()
        };
        facts.validate_runtime_receipts()?;
        Ok(facts)
    }

    fn restore_registrations(
        &mut self,
        triggers: Vec<TriggerFireRequest>,
        evidence: Vec<EvidenceRecord>,
        control_resolutions: Vec<ControlNodeResolution>,
    ) -> Result<(), OrganizationFactsError> {
        self.triggers = TriggerLedger::restore(triggers)
            .map_err(OrganizationFactsError::InvalidTriggerLedger)?;
        self.validate_trigger_attempts()?;
        self.evidence = EvidenceLedger::restore(evidence)
            .map_err(|_| OrganizationFactsError::InvalidEvidenceLedger)?;
        for record in self.evidence.records() {
            validate_evidence_provenance(&self.runs, record)?;
        }

        self.control_resolutions = ControlResolutionLedger::restore(control_resolutions)
            .map_err(|_| OrganizationFactsError::InvalidControlResolutionLedger)?;
        for resolution in self.control_resolutions.resolutions() {
            validate_control_node_resolution(&self.runs, resolution)?;
        }

        Ok(())
    }

    fn restore_approval(&mut self, approval: Approval) -> Result<(), OrganizationFactsError> {
        if !self.runs.contains_key(&approval.facts().run_id) {
            return Err(OrganizationFactsError::UnknownApprovalRun);
        }
        if self.approvals.contains_key(&approval.facts().approval_id) {
            return Err(OrganizationFactsError::DuplicateApproval);
        }
        self.insert_approval(approval);
        Ok(())
    }

    fn finish_restore(
        &mut self,
        artifact_records: Vec<ArtifactRecord>,
        events: EventLedgerSnapshot,
    ) -> Result<(), OrganizationFactsError> {
        self.artifacts = ArtifactLedger::restore(artifact_records)
            .map_err(|_| OrganizationFactsError::InvalidArtifactLedger)?;
        for artifact in self.artifacts.records() {
            validate_artifact_provenance(&self.runs, artifact)?;
        }
        self.validate_activities()?;

        self.events =
            EventLedger::restore(events).map_err(|_| OrganizationFactsError::InvalidEventLedger)?;
        self.validate_event_dependents()?;
        self.delivery_indexes = self.validate_deliveries()?.into_owned();
        Ok(())
    }

    fn validate_runtime_receipts(&self) -> Result<(), OrganizationFactsError> {
        for run in self.runs.values() {
            run.validate_role_session_intents()?;
            run.validate_deletion_confirmations(&run.deletion_confirmations)?;
            if let Some(receipt) = run.runtime() {
                let materialization = self.materializations
                    .get(run.team().as_str())
                    .and_then(TeamMaterializationGroups::retained_receipts)
                    .ok_or(OrganizationFactsError::RuntimeMaterializationMissing)?;
                validate_runtime_receipt_alignment(run, receipt, materialization)?;
            }
        }

        Ok(())
    }

    fn validate_activities(&self) -> Result<(), OrganizationFactsError> {
        for activity in self.activities.activities() {
            validate_activity(&self.runs, &self.artifacts, activity)?;
            if let Some(proof) = activity.settlement_proof() {
                validate_agent_activity_settlement(&self.runs, &self.deliveries, activity, proof)?;
            }
            if let Some(claim) = activity.native_terminal_claim() {
                validate_native_confirmed_activity_claim(&self.runs, &self.deliveries, activity, claim)?;
            }
        }
        Ok(())
    }

    fn validate_trigger_attempts(&self) -> Result<(), OrganizationFactsError> {
        let mut trigger_counts = BTreeMap::new();
        for request in self.triggers.requests() {
            validate_trigger_registration(&self.runs, request)?;
            *trigger_counts
                .entry((request.run_id.as_str(), request.start_node_id.as_str()))
                .or_insert(0_usize) += 1;
        }
        for (run_id, run) in &self.runs {
            for node in run
                .graph()
                .definition()
                .nodes()
                .iter()
                .filter(|node| node.is_armed_start())
            {
                let registered = trigger_counts
                    .get(&(run_id.as_str(), node.id().as_str()))
                    .copied()
                    .unwrap_or_default();
                let attempts = run
                    .graph()
                    .executions()
                    .get(node.id())
                    .expect("definition nodes always have an execution history")
                    .attempts()
                    .iter()
                    .filter(|attempt| matches!(attempt.reason(), crate::AttemptReason::Trigger))
                    .count();
                if attempts != registered {
                    return Err(OrganizationFactsError::InvalidTriggerRegistration);
                }
            }
        }
        Ok(())
    }

    fn validate_event_dependents(&self) -> Result<(), OrganizationFactsError> {
        for record in self.events.commands() {
            if !self.runs.contains_key(record.run_id().as_str()) {
                return Err(OrganizationFactsError::UnknownEventRun);
            }
        }
        for event in self.events.events() {
            if !self.runs.contains_key(event.run_id()) {
                return Err(OrganizationFactsError::UnknownEventRun);
            }
        }
        validate_approval_resolution_events(&self.approvals, self.events.events())?;
        validate_approvals(&self.runs, self.approvals.values(), &self.control_resolutions)?;

        Ok(())
    }

    fn validate_deliveries(&self) -> Result<DeliveryIndexEntries<'_>, OrganizationFactsError> {
        let mut indexes = DeliveryIndexEntries::default();
        for delivery in self.deliveries.deliveries() {
            let id = &delivery.facts().delivery_id;
            if let Some(key) = transaction::correlation_key(delivery, self.runs.get(&delivery.facts().run_id))?
                && indexes.correlations.insert(key, id).is_some()
            {
                return Err(OrganizationFactsError::DuplicateMatchaTerminalCorrelation);
            }
            if !self.runs.contains_key(&delivery.facts().run_id) {
                return Err(OrganizationFactsError::UnknownDeliveryRun);
            }
            if let DeliveryPhase::TerminalObserved { observation } = delivery.phase() {
                let run = self.runs
                    .get(&delivery.facts().run_id)
                    .expect("delivery run was just verified to exist");
                validate_terminal_observation(delivery, run, observation)?;
                if let TerminalObservationResolution::GraphResolved(resolution) =
                    observation.resolution()
                    && indexes.receipts.insert(resolution.receipt().as_str(), id).is_some()
                {
                    return Err(OrganizationFactsError::DuplicateAuthorizedGraphResolution);
                }
            }
        }

        Ok(indexes)
    }

    pub fn teams(&self) -> impl Iterator<Item = &TeamFacts> {
        self.teams.values()
    }

    pub fn team(&self, team_id: &TeamId) -> Option<&TeamFacts> {
        self.teams.get(team_id.as_str())
    }

    pub fn materializations(&self) -> impl Iterator<Item = &MaterializationReceipt> {
        self.materialization_lifecycles().filter_map(TeamMaterializationLifecycle::receipt)
    }

    pub fn materialization(&self, team_id: &TeamId) -> Option<ConfirmedTeamMaterialization<'_>> {
        self.materializations.get(team_id.as_str())?.retained_receipts()
    }

    pub(crate) fn materialization_requests(&self, team_id: &TeamId) -> Option<&[TeamMaterializationRequest]> {
        self.materializations.get(team_id.as_str())?.requests.as_deref()
    }

    pub(crate) fn materialization_lifecycle(
        &self,
        team_id: &TeamId,
        endpoint: &RuntimeEndpointReference,
    ) -> Option<&TeamMaterializationLifecycle> {
        self.materializations.get(team_id.as_str())?.groups.iter()
            .find(|group| group.endpoint() == endpoint)
    }

    pub(crate) fn materialization_groups(&self) -> impl Iterator<Item = &TeamMaterializationGroups> {
        self.materializations.values()
    }

    pub(crate) fn materialization_lifecycles(&self) -> impl Iterator<Item = &TeamMaterializationLifecycle> {
        self.materializations.values().flat_map(|value| value.groups())
    }

    pub(crate) fn materialization_recovery_request(
        &self,
        team_id: &TeamId,
        endpoint: &RuntimeEndpointReference,
    ) -> Option<TeamMaterializationRequest> {
        self.materialization_lifecycle(team_id, endpoint)?
            .receipt_recovery_request().cloned()
    }

    pub(crate) fn create_team_materialization(
        &mut self,
        definition: &crate::TeamDefinition,
        requests: Vec<TeamMaterializationRequest>,
    ) -> Result<MaterializationRecordOutcome, OrganizationFactsError> {
        let materialization = TeamMaterializationGroups {
            groups: requests.iter().cloned().map(TeamMaterializationLifecycle::requested).collect(),
            requests: Some(requests),
        };
        validate_materialization_definition(definition, &materialization)?;
        match self.teams.get(definition.team_id().as_str()) {
            Some(team) if team.tombstoned() => return Err(OrganizationFactsError::TeamTombstoned),
            Some(team) if team.definition() != definition => return Err(OrganizationFactsError::MaterializationChanged),
            Some(_) => {}
            None => {
                self.touch_team(definition.team_id().as_str());
                self.teams.insert(
                    definition.team_id().as_str().to_owned(),
                    TeamFacts::new(definition.clone(), TeamRevision::initial(), false),
                );
            }
        }
        match self.materializations.get(definition.team_id().as_str()) {
            None => {
                self.touch_materialization(definition.team_id().as_str());
                self.materializations.insert(definition.team_id().as_str().to_owned(), materialization);
                Ok(MaterializationRecordOutcome::Recorded)
            }
            Some(existing) if existing.requests == materialization.requests => Ok(MaterializationRecordOutcome::Replayed),
            Some(_) => Err(OrganizationFactsError::MaterializationChanged),
        }
    }

    #[cfg(test)]
    pub(crate) fn request_materialization(
        &mut self,
        request: TeamMaterializationRequest,
    ) -> Result<MaterializationRecordOutcome, OrganizationFactsError> {
        let definition = self.team(request.intent().team())
            .ok_or(OrganizationFactsError::UnknownMaterializationTeam)?.definition().clone();
        self.create_team_materialization(&definition, vec![request])
    }

    pub(crate) fn record_materialization_outcome(
        &mut self,
        team_id: &TeamId,
        endpoint: &RuntimeEndpointReference,
        outcome: MaterializationOperationOutcome,
    ) -> Result<MaterializationRecordOutcome, OrganizationFactsError> {
        self.touch_materialization(team_id.as_str());
        self.materializations.get_mut(team_id.as_str())
            .and_then(|value| value.groups.iter_mut().find(|group| group.endpoint() == endpoint))
            .ok_or(OrganizationFactsError::UnknownMaterializationTeam)?
            .record_materialization_outcome(outcome)
            .map_err(map_materialization_lifecycle_error)
    }

    pub(crate) fn confirm_materialization(
        &mut self,
        receipt: MaterializationReceipt,
    ) -> Result<MaterializationRecordOutcome, OrganizationFactsError> {
        let team_id = receipt.team().clone();
        self.touch_materialization(team_id.as_str());
        self.materializations.get_mut(team_id.as_str())
            .and_then(|value| value.groups.iter_mut().find(|group| group.endpoint() == receipt.endpoint()))
            .ok_or(OrganizationFactsError::UnknownMaterializationTeam)?
            .confirm(receipt)
            .map_err(map_materialization_lifecycle_error)
    }

    pub(crate) fn tombstone_team(
        &mut self,
        team_id: &TeamId,
        cleanup_idempotency_key: IdempotencyKey,
    ) -> Result<TeamTombstoneOutcome, OrganizationFactsError> {
        self.touch_team(team_id.as_str());
        let outcome = self.teams.get_mut(team_id.as_str())
            .ok_or(OrganizationFactsError::UnknownTeam)?.tombstone();
        if outcome == TeamTombstoneOutcome::Tombstoned && self.materializations.contains_key(team_id.as_str()) {
            self.touch_materialization(team_id.as_str());
            let materialization = self.materializations.get_mut(team_id.as_str()).expect("existing materialization");
            let grouped = materialization.groups.len() > 1;
            for lifecycle in &mut materialization.groups {
                let key = if grouped {
                    crate::team::materialization::endpoint_idempotency_key(&cleanup_idempotency_key, lifecycle.endpoint())
                } else {
                    cleanup_idempotency_key.clone()
                };
                *lifecycle = lifecycle.clone().tombstone(|receipt| {
                    crate::TeamMaterializationRemoval::new(receipt.clone(), key)
                });
            }
        }
        Ok(outcome)
    }

    fn team_materialization_cleanup_allowed(&self, team_id: &TeamId) -> bool {
        self.team(team_id).is_some_and(TeamFacts::tombstoned)
            && self.runs.values().filter(|run| run.team() == team_id).all(|run| {
                run.runtime().is_none()
                    && matches!(run.lifecycle().state(), GraphRunLifecycleState::Tombstoned { .. })
            })
    }

    pub(crate) fn team_materialization_removal(
        &self,
        team_id: &TeamId,
        endpoint: &RuntimeEndpointReference,
    ) -> Option<crate::TeamMaterializationRemoval> {
        self.team_materialization_cleanup_allowed(team_id).then_some(())?;
        self.materialization_lifecycle(team_id, endpoint)?.cleanup_request().cloned()
    }

    pub(crate) fn team_unconfirmed_materialization_cleanup_request(
        &self,
        team_id: &TeamId,
        endpoint: &RuntimeEndpointReference,
    ) -> Option<TeamMaterializationRequest> {
        self.team_materialization_cleanup_allowed(team_id).then_some(())?;
        match self.materialization_lifecycle(team_id, endpoint)? {
            TeamMaterializationLifecycle::Tombstoned(crate::TombstonedMaterialization::OutcomeUnknown(request)) => Some(request.clone()),
            _ => None,
        }
    }

    pub(crate) fn team_materialization_cleanup_confirmed(&self, team_id: &TeamId) -> bool {
        self.team(team_id).is_some_and(TeamFacts::tombstoned)
            && self.materializations.get(team_id.as_str()).is_some_and(|value| {
                value.groups.iter().all(|group| matches!(group,
                    TeamMaterializationLifecycle::Tombstoned(crate::TombstonedMaterialization::None(_))
                    | TeamMaterializationLifecycle::Tombstoned(crate::TombstonedMaterialization::Confirmed {
                        cleanup: crate::TeamMaterializationCleanup::Confirmed(_), ..
                    })
                ))
            })
    }

    pub(crate) fn record_team_materialization_cleanup_outcome(
        &mut self,
        team_id: &TeamId,
        endpoint: &RuntimeEndpointReference,
        outcome: MaterializationOperationOutcome,
    ) -> Result<MaterializationRecordOutcome, OrganizationFactsError> {
        self.touch_materialization(team_id.as_str());
        self.materializations.get_mut(team_id.as_str())
            .and_then(|value| value.groups.iter_mut().find(|group| group.endpoint() == endpoint))
            .ok_or(OrganizationFactsError::UnknownMaterializationTeam)?
            .record_cleanup_outcome(outcome)
            .map_err(map_materialization_lifecycle_error)
    }

    pub fn runs(&self) -> impl Iterator<Item = &GraphRunFacts> {
        self.runs.values()
    }

    pub fn armed_trigger_facts(&self) -> impl Iterator<Item = crate::ArmedTriggerFacts> + '_ {
        self.runs
            .values()
            .filter(|run| matches!(run.lifecycle().state(), GraphRunLifecycleState::Active)
                && matches!(run.start_gate(), RunStartGate::Started))
            .flat_map(|run| {
                run.graph()
                    .definition()
                    .nodes()
                    .iter()
                    .filter(|node| node.is_armed_start())
                    .filter_map(move |node| {
                        Some(crate::ArmedTriggerFacts {
                            team_id: run.team().clone(),
                            run_id: run.run_id().clone(),
                            start_node_id: node.id().clone(),
                            trigger: node.trigger()?.clone(),
                        })
                    })
            })
    }

    pub fn templates(&self) -> impl Iterator<Item = &WorkflowTemplateFacts> {
        self.templates.values()
    }

    pub fn pending_workflow_plan_admissions(
        &self,
    ) -> impl Iterator<Item = &PendingWorkflowPlanAdmission> {
        self.pending_workflow_plan_admissions.values()
    }

    pub fn pending_workflow_plan_admission(
        &self,
        run_id: &GraphRunId,
    ) -> Option<&PendingWorkflowPlanAdmission> {
        self.pending_workflow_plan_admissions.get(run_id.as_str())
    }

    pub fn template(&self, team_id: &TeamId) -> Option<&WorkflowTemplateFacts> {
        self.templates.get(team_id.as_str())
    }

    pub fn replace_workflow_template(
        &mut self,
        template: WorkflowTemplateFacts,
    ) -> Result<(), OrganizationFactsError> {
        match self.teams.get(template.team().as_str()) {
            Some(team) if team.tombstoned() => {
                return Err(OrganizationFactsError::InvalidWorkflowTemplate);
            }
            Some(_) => {}
            None => return Err(OrganizationFactsError::UnknownWorkflowTemplateTeam),
        }
        if self
            .templates
            .get(template.team().as_str())
            .is_some_and(|current| template.revision() < current.revision())
        {
            return Err(OrganizationFactsError::WorkflowTemplateChanged);
        }
        self.touch_template(template.team().as_str());
        self.templates
            .insert(template.team().as_str().to_owned(), template);
        Ok(())
    }

    pub(crate) fn admit_workflow_plan_run(
        &mut self,
        admission: PendingWorkflowPlanAdmission,
    ) -> Result<WorkflowPlanAdmissionOutcome, OrganizationFactsError> {
        let run_id = admission.run_id().as_str().to_owned();
        if let Some(existing) = self.runs.get(&run_id) {
            return Ok(
                if existing
                    .lifecycle()
                    .matches_creation(admission.creation_idempotency_key())
                {
                    WorkflowPlanAdmissionOutcome::AlreadySubmitted(existing.run_id().clone())
                } else {
                    WorkflowPlanAdmissionOutcome::ConflictingRun
                },
            );
        }
        if self
            .pending_workflow_plan_admissions
            .values()
            .any(|existing| {
                existing.creation_idempotency_key() == admission.creation_idempotency_key()
                    && existing != &admission
            })
        {
            return Ok(WorkflowPlanAdmissionOutcome::ConflictingIdempotency);
        }
        if let Some(existing) = self.pending_workflow_plan_admissions.get(&run_id) {
            return Ok(if existing == &admission {
                WorkflowPlanAdmissionOutcome::Replayed(existing.clone())
            } else {
                WorkflowPlanAdmissionOutcome::ConflictingRun
            });
        }
        let team = self
            .teams
            .get(admission.team_id().as_str())
            .ok_or(OrganizationFactsError::UnknownWorkflowPlanAdmissionTeam)?;
        if team.tombstoned() || team.revision().get() < admission.team_revision().get() {
            return Err(OrganizationFactsError::InvalidWorkflowPlanAdmission);
        }
        self.touch_admission(&run_id);
        self.pending_workflow_plan_admissions
            .insert(run_id, admission.clone());
        Ok(WorkflowPlanAdmissionOutcome::Recorded(admission))
    }

    pub(crate) fn submit_workflow_plan(
        &mut self,
        team: TeamId,
        run_id: GraphRunId,
        creation_idempotency_key: &str,
        source_identity: String,
        team_revision: TeamRevision,
        plan: crate::run::WorkflowPlan,
    ) -> Result<WorkflowPlanSubmitOutcome, OrganizationFactsError> {
        self.submit_workflow_plan_with_template_revision(
            team,
            run_id,
            creation_idempotency_key,
            source_identity,
            team_revision,
            team_revision.get(),
            plan,
        )
    }

    fn submit_workflow_plan_with_template_revision(
        &mut self,
        team: TeamId,
        run_id: GraphRunId,
        creation_idempotency_key: &str,
        source_identity: String,
        team_revision: TeamRevision,
        template_revision: u64,
        plan: crate::run::WorkflowPlan,
    ) -> Result<WorkflowPlanSubmitOutcome, OrganizationFactsError> {
        if let Some(existing) = self.runs.get(run_id.as_str()) {
            if !existing
                .lifecycle()
                .matches_creation(creation_idempotency_key)
            {
                return Err(OrganizationFactsError::WorkflowPlanAdmissionRunConflict);
            }
            if existing.team() != &team || existing.frozen_team_revision() != team_revision {
                return Err(OrganizationFactsError::WorkflowPlanAdmissionRevisionMismatch);
            }
            let template = self
                .templates
                .get(team.as_str())
                .ok_or(OrganizationFactsError::UnknownWorkflowPlanAdmission)?;
            if template.source_identity() != source_identity
                || template.revision() != template_revision
                || template.plan() != &plan
            {
                return Err(OrganizationFactsError::WorkflowPlanAdmissionSourceMismatch);
            }
            return Ok(WorkflowPlanSubmitOutcome::Replayed(
                existing.run_id().clone(),
            ));
        }

        let admission = self
            .pending_workflow_plan_admissions
            .get(run_id.as_str())
            .cloned()
            .ok_or(OrganizationFactsError::UnknownWorkflowPlanAdmission)?;
        if admission.team_id() != &team {
            return Err(OrganizationFactsError::WorkflowPlanAdmissionTeamMismatch);
        }
        if admission.team_revision() != team_revision {
            return Err(OrganizationFactsError::WorkflowPlanAdmissionRevisionMismatch);
        }
        if admission.source_identity() != source_identity {
            return Err(OrganizationFactsError::WorkflowPlanAdmissionSourceMismatch);
        }
        if admission.creation_idempotency_key() != creation_idempotency_key {
            return Err(OrganizationFactsError::WorkflowPlanAdmissionIdempotencyConflict);
        }
        let team_facts = self
            .teams
            .get(team.as_str())
            .ok_or(OrganizationFactsError::UnknownRunTeam)?;
        if team_facts.tombstoned() {
            return Err(OrganizationFactsError::TeamTombstoned);
        }
        if team_facts.revision() != admission.team_revision() {
            return Err(OrganizationFactsError::WorkflowPlanAdmissionRevisionMismatch);
        }
        if self.materializations.get(team.as_str())
            .and_then(TeamMaterializationGroups::confirmed).is_none()
        {
            return Err(OrganizationFactsError::WorkflowPlanAdmissionMaterializationMissing);
        }
        if plan.run_id() != run_id.as_str() {
            return Err(OrganizationFactsError::InvalidWorkflowTemplate);
        }
        let template =
            WorkflowTemplateFacts::new(team.clone(), source_identity, template_revision, plan)
                .map_err(|_| OrganizationFactsError::InvalidWorkflowTemplate)?;
        if self.templates.get(team.as_str()).is_some_and(|current| {
            template.revision() < current.revision()
                || (template.revision() == current.revision() && template != *current)
        }) {
            return Err(OrganizationFactsError::WorkflowTemplateChanged);
        }
        let graph = template.instantiate(
            run_id.clone(),
            creation_idempotency_key,
            admission.created_at(),
        )?;
        let run = GraphRunFacts::new(team.clone(), team_revision, graph, None)?;
        match self.create_graph_run(run, creation_idempotency_key)? {
            CreateGraphRunOutcome::Created(run_id) => {
                self.touch_template(team.as_str());
                self.touch_admission(run_id.as_str());
                self.templates.insert(team.as_str().to_owned(), template);
                self.pending_workflow_plan_admissions
                    .remove(run_id.as_str());
                Ok(WorkflowPlanSubmitOutcome::Submitted(run_id))
            }
            CreateGraphRunOutcome::Replayed(run_id) => {
                self.touch_admission(run_id.as_str());
                self.pending_workflow_plan_admissions
                    .remove(run_id.as_str());
                Ok(WorkflowPlanSubmitOutcome::Replayed(run_id))
            }
            CreateGraphRunOutcome::ConflictingIdempotency => {
                Err(OrganizationFactsError::WorkflowPlanAdmissionIdempotencyConflict)
            }
            CreateGraphRunOutcome::ExistingRun => {
                Err(OrganizationFactsError::WorkflowPlanAdmissionRunConflict)
            }
        }
    }

    pub(crate) fn create_workflow_plan_run(
        &mut self,
        team: TeamId,
        run_id: GraphRunId,
        creation_idempotency_key: &str,
        plan: crate::run::WorkflowPlan,
        source_identity: String,
        template_revision: u64,
        created_at: u64,
    ) -> Result<CreateGraphRunOutcome, OrganizationFactsError> {
        if creation_idempotency_key.trim().is_empty() {
            return Err(OrganizationFactsError::InvalidGraphRunLifecycle);
        }
        let run_id_string = run_id.as_str().to_owned();
        if let Some(existing) = self.runs.get(&run_id_string) {
            return Ok(
                if existing
                    .lifecycle()
                    .matches_creation(creation_idempotency_key)
                {
                    CreateGraphRunOutcome::Replayed(existing.run_id().clone())
                } else {
                    CreateGraphRunOutcome::ExistingRun
                },
            );
        }
        if self.runs.values().any(|existing| {
            existing
                .lifecycle()
                .matches_creation(creation_idempotency_key)
        }) {
            return Ok(CreateGraphRunOutcome::ConflictingIdempotency);
        }
        let team_revision = self
            .teams
            .get(team.as_str())
            .ok_or(OrganizationFactsError::UnknownRunTeam)?
            .revision();
        let admission = PendingWorkflowPlanAdmission::try_new(
            team.clone(),
            run_id.clone(),
            creation_idempotency_key,
            team_revision,
            source_identity.clone(),
            created_at,
        )?;
        self.touch_admission(run_id.as_str());
        self.pending_workflow_plan_admissions
            .insert(run_id.as_str().to_owned(), admission);
        match self.submit_workflow_plan_with_template_revision(
            team,
            run_id,
            creation_idempotency_key,
            source_identity,
            team_revision,
            template_revision,
            plan,
        )? {
            WorkflowPlanSubmitOutcome::Submitted(run_id) => {
                Ok(CreateGraphRunOutcome::Created(run_id))
            }
            WorkflowPlanSubmitOutcome::Replayed(run_id) => {
                Ok(CreateGraphRunOutcome::Replayed(run_id))
            }
        }
    }

    pub fn run(&self, run_id: &GraphRunId) -> Option<&GraphRunFacts> {
        self.runs.get(run_id.as_str())
    }

    pub(super) fn design_run_mut(&mut self, run_id: &GraphRunId) -> Option<&mut GraphRunFacts> {
        self.touch_run(run_id.as_str());
        self.runs.get_mut(run_id.as_str())
    }

    pub(super) fn apply_graph_event(&mut self, run_id: &GraphRunId, event: GraphEvent) -> Result<(), super::StoreFault> {
        self.require_started_run(run_id).map_err(|_| super::StoreFault::InvalidFacts)?;
        self.touch_run(run_id.as_str());
        self.runs.get_mut(run_id.as_str()).expect("validated run")
            .graph.apply_event(event).map_err(super::StoreFault::GraphReduce)?;
        self.cancel_superseded_pending_activities(run_id);
        Ok(())
    }

    pub(crate) fn purged_run_marker(&self, run_id: &GraphRunId) -> Option<&PurgedRunMarker> {
        self.purged_runs.get(run_id.as_str())
    }

    pub(crate) fn purged_run_markers(&self) -> impl Iterator<Item = &PurgedRunMarker> {
        self.purged_runs.values()
    }

    pub fn deliveries(&self) -> &DeliveryLedger {
        &self.deliveries
    }

    pub(crate) fn deliveries_for_run(&self, run_id: &str) -> impl Iterator<Item = &crate::Delivery> {
        self.deliveries.deliveries_for_run(run_id)
    }

    pub fn activities(&self) -> &ActivityLedger {
        &self.activities
    }

    pub(crate) fn activities_for_run(&self, run_id: &str) -> impl Iterator<Item = &Activity> {
        self.activities.activities_for_run(run_id)
    }

    pub fn triggers(&self) -> &TriggerLedger {
        &self.triggers
    }

    pub(crate) fn decision_ledger(&self) -> &TeamDecisionLedger {
        &self.decisions
    }

    pub fn decisions(&self) -> impl Iterator<Item = &crate::TeamDecision> {
        self.decisions.decisions()
    }

    pub fn decision(&self, run_id: &str, idempotency_key: &str) -> Option<&crate::TeamDecision> {
        self.decisions.decision(run_id, idempotency_key)
    }

    pub(crate) fn record_decision(
        &mut self,
        command: TeamDecisionCommand,
    ) -> Result<TeamDecisionReceipt, TeamDecisionRecordError> {
        self.decisions.record(command)
    }

    pub fn control_node_resolution(&self, idempotency_key: &str) -> Option<&ControlNodeResolution> {
        self.control_resolutions.resolution(idempotency_key)
    }

    pub(crate) fn control_node_resolutions(&self) -> impl Iterator<Item = &ControlNodeResolution> {
        self.control_resolutions.resolutions()
    }

    pub(crate) fn approvals(&self) -> impl Iterator<Item = &Approval> {
        self.approvals.values()
    }

    pub(crate) fn approvals_for_run(&self, run_id: &str) -> impl Iterator<Item = &Approval> {
        self.approval_ids_by_run.get(run_id).into_iter().flatten()
            .map(|id| self.approvals.get(id).expect("approval Run index references its approval"))
    }

    pub(crate) fn events(&self) -> &EventLedger {
        &self.events
    }

    pub(super) fn accept_run_command(&mut self, command: crate::RunCommand) -> Result<(), super::StoreFault> {
        self.events.try_accept(command).map(|_| ()).map_err(super::StoreFault::EventLedger)
    }

    pub(crate) fn event_snapshot(&self) -> EventLedgerSnapshot {
        self.events.snapshot()
    }

    pub(crate) fn events_for_run(&self, run_id: &str) -> Vec<&crate::run::event::TeamEvent> {
        self.events.events_for_run(run_id).collect()
    }

    pub(crate) fn evidence(&self) -> &EvidenceLedger {
        &self.evidence
    }

    pub(crate) fn evidence_records(&self) -> impl Iterator<Item = &EvidenceRecord> {
        self.evidence.records()
    }

    pub fn artifacts(&self) -> impl Iterator<Item = &ArtifactRecord> {
        self.artifacts.records()
    }

    pub(crate) fn artifacts_for_run(&self, run_id: &str) -> impl Iterator<Item = &ArtifactRecord> {
        self.artifacts.records_for_run(run_id)
    }

    pub fn task_board(&self) -> &crate::run::TaskBoardFacts {
        &self.task_board
    }
    pub(crate) fn task_board_mut(&mut self) -> &mut crate::run::TaskBoardFacts {
        &mut self.task_board
    }

    pub fn artifact(
        &self,
        artifact_id: &crate::run::artifact::ArtifactId,
    ) -> Option<&ArtifactRecord> {
        self.artifacts.artifact(artifact_id)
    }

    pub(crate) fn record_artifact(
        &mut self,
        record: ArtifactRecord,
    ) -> Result<ArtifactRecordOutcome, OrganizationFactsError> {
        if let Some(existing) = self.artifacts.artifact(record.artifact_id()) {
            return if existing == &record {
                Ok(ArtifactRecordOutcome::Replayed(existing.clone()))
            } else {
                Ok(ArtifactRecordOutcome::ConflictingArtifactId {
                    artifact_id: record.artifact_id().clone(),
                })
            };
        }
        validate_current_artifact_provenance(&self.runs, &record)?;
        Ok(self.artifacts.record(record))
    }

    pub(crate) fn record_evidence(
        &mut self,
        record: EvidenceRecord,
    ) -> Result<RecordOutcome, OrganizationFactsError> {
        match self.evidence.evidence(record.evidence_id()) {
            Some(existing) if evidence_replay_matches(existing, &record) => {
                Ok(RecordOutcome::Replayed(existing.clone()))
            }
            Some(_) => Err(OrganizationFactsError::ConflictingEvidenceId),
            None => {
                validate_current_evidence_provenance(&self.runs, &record)?;
                match self.evidence.record(record) {
                    outcome @ RecordOutcome::Recorded(_) => Ok(outcome),
                    RecordOutcome::Replayed(_) | RecordOutcome::ConflictingEvidenceId { .. } => {
                        unreachable!("evidence identity was checked before recording")
                    }
                }
            }
        }
    }

    pub(crate) fn require_started_run(&self, run_id: &GraphRunId) -> Result<&GraphRunFacts, OrganizationFactsError> {
        self.run(run_id).filter(|run| {
            matches!(run.start_gate(), RunStartGate::Started)
                && matches!(run.lifecycle().state(), GraphRunLifecycleState::Active)
                && self.team(run.team()).is_some_and(|team| !team.tombstoned())
        }).ok_or(OrganizationFactsError::InvalidGraphRun)
    }

    pub(crate) fn request_human_decision(
        &mut self,
        run_id: &GraphRunId,
        node_id: NodeId,
        fence: ExecutionFence,
        requested_at: u64,
    ) -> Result<bool, OrganizationFactsError> {
        use sha2::{Digest, Sha256};
        use crate::run::event::{ApprovalAction, ApprovalCommand, CommandPayload, OpaqueId, RunCommand};
        let run = self.require_started_run(run_id)?;
        let node = run.graph().definition().node(&node_id)
            .filter(|node| node.kind() == NodeKind::HumanDecision)
            .ok_or(OrganizationFactsError::InvalidApprovalLedger)?;
        let attempt = run.graph().current_attempt(&node_id)
            .filter(|attempt| attempt.fence() == &fence)
            .ok_or(OrganizationFactsError::InvalidApprovalLedger)?;
        if self.approvals_for_run(run_id.as_str()).any(|approval| {
            let facts = approval.facts();
            matches!(facts.binding(), Some(ApprovalBinding::HumanDecision { node_id: approval_node, execution_fence })
                if approval_node == node_id.as_str() && execution_fence == fence.node_execution_id().as_str())
        }) {
            return Ok(false);
        }
        if run.graph().is_rework_blocked(&node_id) {
            return Ok(false);
        }
        if attempt.status() != crate::AttemptStatus::Ready {
            return Err(OrganizationFactsError::InvalidApprovalLedger);
        }
        let team = self.team(run.team()).ok_or(OrganizationFactsError::UnknownTeam)?;
        let leader = team.definition().roles().iter().find(|role| role.kind() == crate::RoleKind::Leader)
            .ok_or(OrganizationFactsError::InvalidApprovalLedger)?;
        if !run.runtime().is_some_and(|runtime| runtime.bindings().iter().any(|binding| binding.role() == leader.role_id())) {
            return Err(OrganizationFactsError::InvalidApprovalLedger);
        }
        let mut digest = Sha256::new();
        for part in [run_id.as_str(), node_id.as_str(), fence.attempt_id().as_str(), fence.node_execution_id().as_str()] {
            digest.update((part.len() as u64).to_le_bytes());
            digest.update(part.as_bytes());
        }
        let identity = format!("human-decision-{:x}", digest.finalize());
        let opaque = |value: &str| OpaqueId::try_new(value).map_err(|_| OrganizationFactsError::InvalidEventLedger);
        let approval_id = opaque(&identity)?;
        let role_id = opaque(leader.role_id().as_str())?;
        let content = crate::run::approval::ApprovalContent {
            title: node.title().to_owned(),
            body: node.approval_prompt().map(str::to_owned),
            artifact_ids: self.approval_input_artifacts(run_id, run.graph(), &node_id),
        };
        let command = RunCommand::new(opaque(run_id.as_str())?, approval_id.clone(), approval_id.clone(),
            CommandPayload::ApprovalRequest(ApprovalCommand::new(approval_id.clone(), opaque(fence.node_execution_id().as_str())?, role_id.clone(), ApprovalAction::ContinueNode)), requested_at);
        let approval = Approval::request(crate::ApprovalRequest {
            approval_id: identity.clone(), run_id: run_id.as_str().to_owned(), stage_id: node_id.as_str().to_owned(),
            role_id: role_id.as_str().to_owned(), reason: "Human decision required.".to_owned(),
            requested_action: "continue_node".to_owned(), risk_summary: String::new(), content: Some(content),
            idempotency_key: identity.clone(), requested_at,
            subject: crate::ApprovalSubject::HumanDecision { node_id: node_id.as_str().to_owned() },
            origin: crate::ApprovalOrigin::HumanDecision, effect: crate::ApprovalEffect::RouteDecisionPorts,
            execution_fence: Some(fence.node_execution_id().as_str().to_owned()),
        });
        self.touch_run(run_id.as_str());
        self.runs.get_mut(run_id.as_str()).expect("validated run").graph
            .apply_event(GraphEvent::NodeWaiting { node_id, fence, waiting_at: requested_at })
            .map_err(|_| OrganizationFactsError::InvalidGraphRun)?;
        if self.events.try_accept(command).map_err(|_| OrganizationFactsError::InvalidEventLedger)?.is_replay() {
            return Err(OrganizationFactsError::InvalidApprovalLedger);
        }
        self.insert_approval(approval);
        Ok(true)
    }

    pub(crate) fn resolve_human_decision(
        &mut self,
        command: HumanDecisionCommand,
    ) -> Result<HumanDecisionOutcome, OrganizationFactsError> {
        let approval = self
            .approvals
            .get(command.approval_id())
            .ok_or(OrganizationFactsError::UnknownApproval)?;
        let facts = approval.facts();
        if facts.run_id != command.run_id().as_str() {
            return Err(OrganizationFactsError::UnknownApprovalRun);
        }
        let (node_id, execution_fence, route_decision) = match facts.binding() {
            Some(ApprovalBinding::HumanDecision { node_id, execution_fence }) => {
                (node_id, execution_fence, true)
            }
            Some(ApprovalBinding::WorkNode { node_id, execution_fence }) => {
                (node_id, execution_fence, false)
            }
            _ => return Err(OrganizationFactsError::InvalidApprovalResolution),
        };
        if approval.resolution_for_idempotency(command.idempotency_key()).is_some() {
            return if approval.resolution_receipt_matches(command.idempotency_key(), command.decision(), command.note(), command.resolved_at(), crate::run::approval::ApprovalResolutionCause::HumanDecision) {
                Ok(HumanDecisionOutcome::Replayed)
            } else {
                Err(OrganizationFactsError::ConflictingApprovalResolution)
            };
        }
        let run = self.require_started_run(command.run_id())?;
        let node_id = NodeId::new(node_id);
        let attempt = run
            .graph()
            .current_attempt(&node_id)
            .filter(|attempt| attempt.fence().node_execution_id().as_str() == execution_fence)
            .ok_or(OrganizationFactsError::InvalidApprovalResolution)?;
        if attempt.status() != crate::AttemptStatus::Waiting {
            return Err(OrganizationFactsError::InvalidApprovalResolution);
        }
        let node = run.graph().definition().node(&node_id)
            .ok_or(OrganizationFactsError::InvalidApprovalResolution)?;
        if !route_decision && node.work_assignment().map(|assignment| assignment.role_id())
            .or_else(|| node.review_assignment().map(|assignment| assignment.role_id())) != Some(facts.role_id.as_str())
        {
            return Err(OrganizationFactsError::InvalidApprovalResolution);
        }
        let resolution = if route_decision {
            Some(ControlNodeResolution::human_decision(
                command.run_id().clone(), node_id, attempt.fence().clone(),
                match command.decision() {
                    crate::ApprovalDecision::Approve => crate::HumanDecision::Approve,
                    crate::ApprovalDecision::Deny => crate::HumanDecision::Deny,
                    crate::ApprovalDecision::Abort => crate::HumanDecision::Abort,
                }, command.resolved_at(),
            ).map_err(|_| OrganizationFactsError::InvalidApprovalResolution)?)
        } else { None };

        let approval_outcome = self.resolve_approval(ApprovalResolutionInput {
            run_id: command.run_id().clone(),
            approval_id: command.approval_id().to_owned(),
            stage_id: facts.stage_id.clone(),
            role_id: facts.role_id.clone(),
            decision: command.decision(),
            resolved_at: command.resolved_at(),
            note: command.note().map(str::to_owned),
            idempotency_key: command.idempotency_key().to_owned(),
        })?;
        if approval_outcome != ApprovalResolutionOutcome::Recorded {
            return Err(OrganizationFactsError::ConflictingApprovalResolution);
        }
        if let Some(resolution) = resolution {
            if self.apply_control_node_resolution(resolution)
                .map_err(|_| OrganizationFactsError::InvalidApprovalResolution)? != ControlNodeResolutionOutcome::Recorded
            {
                return Err(OrganizationFactsError::InvalidApprovalResolution);
            }
        }
        Ok(HumanDecisionOutcome::Recorded)
    }

    pub(crate) fn resolve_approval(
        &mut self,
        input: ApprovalResolutionInput,
    ) -> Result<ApprovalResolutionOutcome, OrganizationFactsError> {
        self.resolve_approval_with_cause(input, crate::run::approval::ApprovalResolutionCause::HumanDecision)
    }

    fn resolve_approval_with_cause(
        &mut self,
        input: ApprovalResolutionInput,
        cause: crate::run::approval::ApprovalResolutionCause,
    ) -> Result<ApprovalResolutionOutcome, OrganizationFactsError> {
        let ApprovalResolutionInput {
            run_id,
            approval_id,
            stage_id,
            role_id,
            decision,
            resolved_at,
            note,
            idempotency_key,
        } = input;
        let run_id = run_id.as_str();
        if !self.runs.contains_key(run_id)
            || self
                .approvals
                .get(&approval_id)
                .is_some_and(|approval| approval.facts().run_id != run_id)
        {
            return Err(OrganizationFactsError::UnknownApprovalRun);
        }
        let idempotency_key = crate::run::event::OpaqueId::try_new(idempotency_key)
            .map_err(|_| OrganizationFactsError::InvalidEventLedger)?;
        let approval = self
            .approvals
            .get(&approval_id)
            .filter(|approval| {
                let facts = approval.facts();
                facts.run_id == run_id && facts.stage_id == stage_id && facts.role_id == role_id
            })
            .ok_or(OrganizationFactsError::UnknownApproval)?;
        if cause == crate::run::approval::ApprovalResolutionCause::HumanDecision
            && approval.resolution_for_idempotency(idempotency_key.as_str()).is_none()
        {
            self.require_started_run(&GraphRunId::new(run_id))?;
        }
        self.touch_approval(&approval_id);
        let approval = self.approvals.get_mut(&approval_id).expect("validated approval");
        let resolution_count = approval.resolutions().len();
        approval
            .resolve_with_receipt(
                decision,
                resolved_at,
                note,
                idempotency_key.as_str().to_owned(),
                cause,
            )
            .map_err(|error| match error {
                crate::run::approval::ApprovalResolutionError::InvalidResolution => {
                    OrganizationFactsError::InvalidApprovalResolution
                }
                crate::run::approval::ApprovalResolutionError::ConflictingIdempotencyKey => {
                    OrganizationFactsError::ConflictingApprovalResolution
                }
            })?;
        if approval.resolutions().len() == resolution_count {
            return Ok(ApprovalResolutionOutcome::Replayed);
        }
        self.events
            .append_approval_resolution(
                crate::run::event::OpaqueId::try_new(run_id)
                    .map_err(|_| OrganizationFactsError::InvalidEventLedger)?,
                crate::run::event::OpaqueId::try_new(&approval_id)
                    .map_err(|_| OrganizationFactsError::InvalidEventLedger)?,
                decision,
                idempotency_key,
                resolved_at,
            )
            .map_err(|_| OrganizationFactsError::InvalidEventLedger)?;
        Ok(ApprovalResolutionOutcome::Recorded)
    }

    pub(crate) fn record_task_native_execution(
        &mut self,
        delivery_id: &crate::DeliveryId,
        native: crate::TaskNativeExecution,
    ) -> Result<(), OrganizationFactsError> {
        let invalid = OrganizationFactsError::InvalidTerminalObservation;
        let delivery = self.deliveries.delivery(delivery_id).ok_or(invalid.clone())?;
        let run = self.runs.get(&delivery.facts().run_id).ok_or(invalid.clone())?;
        if run.task_execution_context().is_none()
            || native.native_request_id.as_deref() != Some(delivery.facts().idempotency_key.as_str())
            || native.native_message_id.as_ref().is_none_or(|id| id.trim().is_empty())
        { return Err(invalid); }
        if let Some(old) = delivery.task_native_execution() {
            if old == &native { return Ok(()); }
            if old.endpoint_session_id != native.endpoint_session_id || old.native_run_id != native.native_run_id
                || old.native_request_id != native.native_request_id || old.native_message_id != native.native_message_id
                || !matches!(old.measurement, crate::TaskRunMeasurement::Unavailable)
            { return Err(invalid); }
        }
        let endpoint = crate::EndpointSessionId::try_new(native.endpoint_session_id.clone())
            .map_err(|_| invalid.clone())?;
        self.accept_native_terminal_context(delivery_id, endpoint, native.native_run_id.clone())?;
        self.deliveries.delivery_mut(delivery_id).ok_or(invalid)?
            .task_native_execution = Some(native);
        Ok(())
    }

    pub(crate) fn accept_native_terminal_context(
        &mut self,
        delivery_id: &crate::DeliveryId,
        endpoint_session_id: crate::EndpointSessionId,
        native_run_id: String,
    ) -> Result<bool, OrganizationFactsError> {
        let mut phase = "delivery_lookup";
        let result = (|| {
            let delivery = self
                .deliveries
                .delivery(delivery_id)
                .ok_or(OrganizationFactsError::InvalidTerminalObservation)?;
            runtime_trace("runtime.team_run.terminal.facts.accept_context", || json!({
                "deliveryHash": identifier_hash(delivery_id.as_str()),
                "runHash": identifier_hash(&delivery.facts().run_id),
                "nodeHash": identifier_hash(&delivery.facts().node_id),
                "nativeRunHash": identifier_hash(&native_run_id), "outcome": "begin",
            }));
            phase = "run_lookup";
            let run = self
                .runs
                .get(&delivery.facts().run_id)
                .ok_or(OrganizationFactsError::UnknownRun)?;
            phase = "binding_lookup";
            let binding = run
                .runtime()
                .and_then(|runtime| {
                    runtime.bindings().iter().find(|binding| {
                        binding.role().as_str() == delivery.facts().role_id
                            && binding.session_ref().as_str() == delivery.facts().session_ref
                    })
                })
                .ok_or(OrganizationFactsError::InvalidTerminalObservation)?;
            phase = "endpoint_match";
            if binding.endpoint_session_id() != &endpoint_session_id {
                return Err(OrganizationFactsError::InvalidTerminalObservation);
            }
            phase = "receipt_correlation";
            let crate::ActivityExecutionOutcome::Accepted { receipt, correlation } =
                crate::ActivityExecutionOutcome::accepted(endpoint_session_id, native_run_id)
            else {
                return Err(OrganizationFactsError::InvalidTerminalObservation);
            };
            phase = "delivery_phase_or_correlation";
            runtime_trace("runtime.team_run.terminal.facts.correlation", || {
                let (delivery_phase, receipt_matches, correlation_matches) = match delivery.phase() {
                    DeliveryPhase::Delivered { receipt: existing, native_correlation, .. } =>
                        ("delivered", Some(existing == &receipt), Some(native_correlation.as_ref() == Some(&correlation))),
                    DeliveryPhase::TerminalObserved { observation } =>
                        ("terminal_observed", Some(observation.delivered_receipt() == &receipt), Some(observation.correlation() == &correlation)),
                    DeliveryPhase::Delivering(_) => ("delivering", None, None),
                    DeliveryPhase::OutcomeUnknown { .. } => ("outcome_unknown", None, None),
                    _ => ("not_accepted", None, None),
                };
                json!({
                    "deliveryHash": identifier_hash(delivery_id.as_str()), "phase": delivery_phase,
                    "receiptMatches": receipt_matches, "correlationMatches": correlation_matches,
                })
            });
            match delivery.phase() {
                DeliveryPhase::Delivered { receipt: existing, native_correlation, .. }
                    if existing == &receipt && native_correlation.as_ref() == Some(&correlation) => Ok(false),
                DeliveryPhase::TerminalObserved { observation }
                    if observation.delivered_receipt() == &receipt && observation.correlation() == &correlation => Ok(false),
                DeliveryPhase::Delivering(claim) => {
                    phase = "settle_delivery";
                    let claim = claim.clone();
                    self.settle_delivery(
                        &claim,
                        crate::DeliveryReceipt::Accepted {
                            receipt,
                            native_correlation: Some(correlation),
                            accepted_at: claim.claimed_at(),
                        },
                        0,
                    )
                    .map_err(|error| {
                        runtime_trace("runtime.team_run.terminal.facts.accept_context", || json!({
                            "deliveryHash": identifier_hash(delivery_id.as_str()), "phase": "settle_delivery",
                            "outcome": "error", "error": crate::trace::terminal_error(&super::StoreFault::DeliveryReceipt(Box::new(error))),
                        }));
                        OrganizationFactsError::InvalidTerminalObservation
                    })?;
                    Ok(true)
                }
                DeliveryPhase::OutcomeUnknown { .. } => {
                    phase = "confirm_unknown_delivery";
                    Ok(self.deliveries.delivery_mut(delivery_id).expect("validated delivery")
                        .confirm_unknown_native_delivery(receipt, correlation))
                }
                _ => Err(OrganizationFactsError::InvalidTerminalObservation),
            }
        })();
        runtime_trace("runtime.team_run.terminal.facts.accept_context", || json!({
            "deliveryHash": identifier_hash(delivery_id.as_str()), "phase": phase,
            "outcome": match &result { Ok(true) => "recorded", Ok(false) => "replayed", Err(_) => "error" },
            "reason": result.as_ref().err().map(crate::trace::terminal_facts_reason),
        }));
        result
    }

    pub(super) fn native_terminal_target(
        &self,
        delivery_id: &crate::DeliveryId,
    ) -> Option<super::NativeTerminalReceiptTarget> {
        let delivery = self.deliveries.delivery(delivery_id)?;
        let (correlation, existing_observation) = match delivery.phase() {
            DeliveryPhase::Delivered {
                native_correlation: Some(correlation),
                ..
            } => (correlation.clone(), None),
            DeliveryPhase::TerminalObserved { observation } => {
                (observation.correlation().clone(), Some(observation))
            }
            _ => return None,
        };
        let run = self.runs.get(&delivery.facts().run_id)?;
        let node_id = NodeId::new(delivery.facts().node_id.clone());
        let fence = existing_observation.map_or_else(
            || {
                run.graph()
                    .executions()
                    .get(&node_id)?
                    .attempts()
                    .iter()
                    .find(|attempt| {
                        attempt.fence().node_execution_id().as_str()
                            == delivery.facts().node_execution_id
                    })
                    .map(|attempt| attempt.fence().clone())
                    .or_else(|| {
                        run.retired_executions
                            .iter()
                            .find(|(node, fence)| {
                                node == &node_id
                                    && fence.node_execution_id().as_str()
                                        == delivery.facts().node_execution_id
                            })
                            .map(|(_, fence)| fence.clone())
                    })
            },
            |observation| Some(observation.fence().clone()),
        )?;
        if fence.node_execution_id().as_str() != delivery.facts().node_execution_id {
            return None;
        }
        let role_id = crate::RoleId::try_new(delivery.facts().role_id.clone()).ok()?;
        let session_ref =
            crate::RoleSessionRef::try_new(delivery.facts().session_ref.clone()).ok()?;
        let endpoint = run
            .runtime()?
            .bindings()
            .iter()
            .find(|binding| binding.role() == &role_id && binding.session_ref() == &session_ref)
            .map(|binding| binding.endpoint().clone())?;
        Some(super::NativeTerminalReceiptTarget::new(
            delivery.facts().delivery_id.clone(),
            run.run_id().clone(),
            node_id,
            fence,
            role_id,
            endpoint,
            correlation,
        ))
    }

    pub(super) fn native_terminal_is_retired(
        &self,
        target: &super::NativeTerminalReceiptTarget,
    ) -> Result<bool, OrganizationFactsError> {
        if self.native_terminal_target(target.delivery_id()).as_ref() != Some(target) {
            return Err(OrganizationFactsError::InvalidTerminalObservation);
        }
        let run = self
            .runs
            .get(target.graph_run_id().as_str())
            .ok_or(OrganizationFactsError::UnknownRun)?;
        if !run.execution_is_retired(target.node_id(), target.fence()) {
            return Ok(false);
        }
        let activity_id = ActivityId::new(target.delivery_id().as_str())
            .map_err(|_| OrganizationFactsError::InvalidActivity)?;
        let activity = self
            .activities
            .activity(&activity_id)
            .ok_or(OrganizationFactsError::InvalidActivity)?;
        validate_activity(&self.runs, &self.artifacts, activity)?;
        if activity.facts().run_id != *target.graph_run_id()
            || activity.facts().node_id != *target.node_id()
            || activity.facts().fence != *target.fence()
        {
            return Err(OrganizationFactsError::InvalidActivity);
        }
        if let Some(proof) = activity.settlement_proof() {
            validate_agent_activity_settlement(&self.runs, &self.deliveries, activity, proof)?;
        }
        if let Some(claim) = activity
            .active_claim()
            .or_else(|| activity.native_terminal_claim())
        {
            validate_native_confirmed_activity_claim(
                &self.runs,
                &self.deliveries,
                activity,
                claim,
            )?;
        } else if activity.settlement_proof().is_none() {
            return Err(OrganizationFactsError::InvalidActivityTransition);
        }
        let delivery = self
            .deliveries
            .delivery(target.delivery_id())
            .ok_or(OrganizationFactsError::InvalidTerminalObservation)?;
        let binding = run
            .runtime()
            .and_then(|runtime| {
                runtime.bindings().iter().find(|binding| {
                    binding.role().as_str() == delivery.facts().role_id
                        && binding.session_ref().as_str() == delivery.facts().session_ref
                })
            })
            .ok_or(OrganizationFactsError::InvalidActivityTarget)?;
        if target.correlation().endpoint_session_id() != binding.endpoint_session_id() {
            return Err(OrganizationFactsError::InvalidTerminalObservation);
        }
        Ok(true)
    }

    pub fn validate(&self) -> Result<(), OrganizationFactsError> {
        let mut team_ids = BTreeSet::new();
        for team in self.teams.values() {
            if !team_ids.insert(team.team_id().as_str()) {
                return Err(OrganizationFactsError::DuplicateTeam);
            }
        }
        for (team_id, lifecycle) in &self.materializations {
            let team_id = TeamId::try_new(team_id.clone())
                .expect("materialization index is derived from TeamId");
            validate_materialization(&self.teams, &team_id, lifecycle)?;
        }
        let mut template_teams = BTreeSet::new();
        for template in self.templates.values() {
            validate_template(&self.teams, template)?;
            if !template_teams.insert(template.team().as_str()) {
                return Err(OrganizationFactsError::DuplicateWorkflowTemplate);
            }
        }
        validate_team_workspaces(&self.teams)?;
        let mut run_ids = BTreeSet::new();
        for run in self.runs.values() {
            validate_restored_run(&self.teams, run)?;
            if !run_ids.insert(run.run_id()) {
                return Err(OrganizationFactsError::DuplicateRun);
            }
        }
        let mut admissions = Vec::new();
        let mut admission_runs = BTreeSet::new();
        for admission in self.pending_workflow_plan_admissions.values() {
            validate_admission(&self.teams, &self.runs, admissions.iter().copied(), admission)?;
            if !admission_runs.insert(admission.run_id()) {
                return Err(OrganizationFactsError::DuplicateWorkflowPlanAdmission);
            }
            admissions.push(admission);
        }
        self.validate_runtime_receipts()?;
        self.deliveries.validate().map_err(OrganizationFactsError::InvalidDeliveryLedger)?;
        self.activities.validate().map_err(OrganizationFactsError::InvalidActivityLedger)?;
        self.validate_activities()?;
        let mut trigger_keys = BTreeSet::new();
        for request in self.triggers.requests() {
            request.validate().map_err(|error| OrganizationFactsError::InvalidTriggerLedger(
                RestoreTriggerLedgerError::InvalidRequest(error),
            ))?;
            if !trigger_keys.insert((&request.run_id, &request.idempotency_key)) {
                return Err(OrganizationFactsError::InvalidTriggerLedger(
                    RestoreTriggerLedgerError::DuplicateIdempotencyKey(request.idempotency_key.clone()),
                ));
            }
        }
        self.validate_trigger_attempts()?;
        for record in self.evidence.records() {
            validate_evidence_provenance(&self.runs, record)?;
        }
        let mut resolution_keys = BTreeSet::new();
        for resolution in self.control_resolutions.resolutions() {
            if !resolution_keys.insert(resolution.idempotency_key()) {
                return Err(OrganizationFactsError::InvalidControlResolutionLedger);
            }
        }
        for resolution in self.control_resolutions.resolutions() {
            validate_control_node_resolution(&self.runs, resolution)?;
        }
        let mut approval_ids = BTreeSet::new();
        for approval in self.approvals.values() {
            approval.validate().map_err(|_| OrganizationFactsError::InvalidApprovalLedger)?;
            if !self.runs.contains_key(&approval.facts().run_id) {
                return Err(OrganizationFactsError::UnknownApprovalRun);
            }
            if !approval_ids.insert(&approval.facts().approval_id) {
                return Err(OrganizationFactsError::DuplicateApproval);
            }
        }
        self.decisions.validate().map_err(|_| OrganizationFactsError::InvalidDecisionLedger)?;
        for artifact in self.artifacts.records() {
            validate_artifact_provenance(&self.runs, artifact)?;
        }
        self.events.validate().map_err(|_| OrganizationFactsError::InvalidEventLedger)?;
        self.validate_event_dependents()?;
        self.validate_deliveries().map(|_| ())
    }

    pub(crate) fn validate_transition_from(
        &self,
        previous: &OrganizationFacts,
    ) -> Result<(), OrganizationFactsError> {
        self.validate()?;
        self.task_board
            .validate()
            .map_err(|_| OrganizationFactsError::InvalidTaskBoard)?;
        for (team_id, previous_team) in &previous.teams {
            let current = self
                .teams
                .get(team_id)
                .ok_or(OrganizationFactsError::RemovedTeam)?;
            if current.revision().get() < previous_team.revision().get()
                || (current.revision() == previous_team.revision()
                    && current.definition() != previous_team.definition())
                || (previous_team.tombstoned() && !current.tombstoned())
                || previous_team.workspace_directory_name.as_ref().is_some_and(|name| current.workspace_directory_name.as_ref() != Some(name))
            {
                return Err(OrganizationFactsError::InvalidTeamTransition);
            }
        }
        for (team_id, previous_materialization) in &previous.materializations {
            let current = self
                .materializations
                .get(team_id)
                .ok_or(OrganizationFactsError::RemovedMaterialization)?;
            if !current.can_transition_from(previous_materialization) {
                return Err(OrganizationFactsError::MaterializationChanged);
            }
        }
        for (team_id, previous_template) in &previous.templates {
            let current = self
                .templates
                .get(team_id)
                .ok_or(OrganizationFactsError::WorkflowTemplateChanged)?;
            if current.team() != previous_template.team()
                || current.revision() < previous_template.revision()
                || (current.revision() == previous_template.revision()
                    && current != previous_template)
            {
                return Err(OrganizationFactsError::WorkflowTemplateChanged);
            }
        }
        for (run_id, previous_admission) in &previous.pending_workflow_plan_admissions {
            if let Some(current) = self.pending_workflow_plan_admissions.get(run_id) {
                if current != previous_admission {
                    return Err(OrganizationFactsError::WorkflowPlanAdmissionChanged);
                }
            } else {
                let run = self
                    .runs
                    .get(run_id)
                    .ok_or(OrganizationFactsError::WorkflowPlanAdmissionChanged)?;
                let template = self
                    .templates
                    .get(previous_admission.team_id().as_str())
                    .ok_or(OrganizationFactsError::WorkflowPlanAdmissionChanged)?;
                if run.team() != previous_admission.team_id()
                    || run.frozen_team_revision() != previous_admission.team_revision()
                    || template.team() != previous_admission.team_id()
                    || template.source_identity() != previous_admission.source_identity()
                    || template.plan().run_id() != run.run_id().as_str()
                {
                    return Err(OrganizationFactsError::WorkflowPlanAdmissionChanged);
                }
            }
        }
        for (run_id, previous_run) in &previous.runs {
            let current = self
                .runs
                .get(run_id)
                .ok_or(OrganizationFactsError::RemovedRun)?;
            current.validate_session_transition(previous_run.runtime(), &previous_run.role_session_intents)?;
            if previous_run.deletion_confirmations.iter().any(|confirmation| !current.deletion_confirmations.contains(confirmation)) {
                return Err(OrganizationFactsError::InvalidGraphRun);
            }
            if previous_run.workspace().is_none() && current.workspace().is_some() { return Err(OrganizationFactsError::RunOwnershipChanged); }
            current.validate_workspace_transition(previous_run.workspace(), current.workspace())?;
            if current.team() != previous_run.team()
                || current.frozen_team_revision() != previous_run.frozen_team_revision()
                || current.task_execution_context != previous_run.task_execution_context
            {
                return Err(OrganizationFactsError::RunOwnershipChanged);
            }
            if !previous_run
                .retired_executions
                .is_subset(&current.retired_executions)
            {
                return Err(OrganizationFactsError::InvalidGraphRun);
            }
            if !current
                .lifecycle()
                .can_transition_from(previous_run.lifecycle())
            {
                return Err(OrganizationFactsError::InvalidGraphRunLifecycle);
            }
            if !current
                .start_gate()
                .can_transition_from(previous_run.start_gate())
            {
                return Err(OrganizationFactsError::InvalidRunStartGate);
            }
        }
        for delivery in previous.deliveries.deliveries() {
            let current = self
                .deliveries
                .delivery(&delivery.facts().delivery_id)
                .ok_or(OrganizationFactsError::RemovedDelivery)?;
            if current.facts() != delivery.facts() {
                return Err(OrganizationFactsError::DeliveryIdentityChanged);
            }
            validate_delivery_transition(delivery, current)?;
        }
        for activity in previous.activities.activities() {
            let current = self
                .activities
                .activity(&activity.facts().activity_id)
                .ok_or(OrganizationFactsError::RemovedActivity)?;
            if current.facts() != activity.facts() {
                return Err(OrganizationFactsError::ActivityIdentityChanged);
            }
            validate_activity_transition(activity, current)?;
        }
        for activity in self.activities.activities() {
            if previous.activities.activity(&activity.facts().activity_id).is_none() {
                validate_new_activity_prompt(&self.runs, activity.facts(), self.team_prompts())?;
            }
        }
        for request in previous.triggers.requests() {
            if self
                .triggers
                .request(&request.run_id, &request.idempotency_key)
                != Some(request)
            {
                return Err(OrganizationFactsError::TriggerRegistrationChanged);
            }
        }
        for resolution in previous.control_resolutions.resolutions() {
            if self
                .control_resolutions
                .resolution(resolution.idempotency_key())
                != Some(resolution)
            {
                return Err(OrganizationFactsError::ControlResolutionChanged);
            }
        }
        for record in previous.evidence.records() {
            if self.evidence.evidence(record.evidence_id()) != Some(record) {
                return Err(OrganizationFactsError::EvidenceChanged);
            }
        }
        for record in previous.artifacts.records() {
            if self.artifacts.artifact(record.artifact_id()) != Some(record) {
                return Err(OrganizationFactsError::ArtifactChanged);
            }
        }
        for (approval_id, previous_approval) in &previous.approvals {
            let current_approval = self
                .approvals
                .get(approval_id)
                .ok_or(OrganizationFactsError::ApprovalChanged)?;
            if current_approval.facts() != previous_approval.facts()
                || !current_approval
                    .resolutions()
                    .starts_with(previous_approval.resolutions())
                || (previous_approval.is_pending()
                    && !current_approval.is_pending()
                    && !current_approval.is_terminal())
            {
                return Err(OrganizationFactsError::ApprovalChanged);
            }
        }
        if !self.events.preserves_history(&previous.events) {
            return Err(OrganizationFactsError::EventLedgerChanged);
        }
        Ok(())
    }

    pub(crate) fn create_graph_run(
        &mut self,
        run: GraphRunFacts,
        creation_idempotency_key: &str,
    ) -> Result<CreateGraphRunOutcome, OrganizationFactsError> {
        if creation_idempotency_key.trim().is_empty() {
            return Err(OrganizationFactsError::InvalidGraphRunLifecycle);
        }
        let run_id = run.run_id().as_str().to_owned();
        if let Some(existing) = self.runs.get(&run_id) {
            return Ok(
                if existing
                    .lifecycle()
                    .matches_creation(creation_idempotency_key)
                {
                    CreateGraphRunOutcome::Replayed(existing.run_id().clone())
                } else {
                    CreateGraphRunOutcome::ExistingRun
                },
            );
        }
        if self.runs.values().any(|existing| {
            existing
                .lifecycle()
                .matches_creation(creation_idempotency_key)
        }) {
            return Ok(CreateGraphRunOutcome::ConflictingIdempotency);
        }
        let team = self
            .teams
            .get(run.team().as_str())
            .ok_or(OrganizationFactsError::UnknownRunTeam)?;
        if team.tombstoned() || team.revision().get() < run.frozen_team_revision().get() {
            return Err(OrganizationFactsError::InvalidGraphRunLifecycle);
        }
        if self.materialization(&run.team).is_none() {
            return Err(OrganizationFactsError::RunMaterializationMissing);
        }
        let context = run.task_execution_context.clone();
        let mut run = GraphRunFacts::with_lifecycle(
            run.team.clone(),
            run.frozen_team_revision,
            run.graph,
            run.runtime,
            GraphRunLifecycle::created(creation_idempotency_key.to_owned()),
        )?;
        run.restore_task_execution_context(context)?;
        self.touch_run(&run_id);
        self.runs.insert(run_id.clone(), run);
        Ok(CreateGraphRunOutcome::Created(GraphRunId::new(run_id)))
    }

    pub(crate) fn begin_graph_run_cancellation(
        &mut self,
        run_id: &GraphRunId,
        idempotency_key: &str,
        requested_at: u64,
    ) -> Result<BeginCancellationOutcome, OrganizationFactsError> {
        if idempotency_key.trim().is_empty() {
            return Err(OrganizationFactsError::InvalidGraphRunLifecycle);
        }
        self.touch_run(run_id.as_str());
        let run = self
            .runs
            .get_mut(run_id.as_str())
            .ok_or(OrganizationFactsError::UnknownRun)?;
        let plan = crate::run::lifecycle::cancellation_plan(run);
        let outcome = run.lifecycle.begin_cancellation(plan, idempotency_key, requested_at);
        if let GraphRunLifecycleState::Cancelled { idempotency_key, .. } = run.lifecycle.state() {
            // The durable cancellation settles remaining approvals now, without another native abort.
            let key = idempotency_key.clone();
            self.settle_graph_run_cancellation(run_id, &key, RoleAbortOutcome::Confirmed, requested_at)?;
        }
        let pending = self.activities_for_run(run_id.as_str())
            .filter(|activity| matches!(activity.phase(), ActivityPhase::Pending | ActivityPhase::RetryScheduled { .. }))
            .map(|activity| activity.facts().activity_id.clone())
            .collect::<Vec<_>>();
        for activity_id in pending {
            self.activities.activity_mut(&activity_id).expect("selected activity exists").cancel(requested_at);
            if let Ok(delivery_id) = crate::DeliveryId::new(activity_id.as_str())
                && let Some(delivery) = self.deliveries.delivery_mut(&delivery_id)
                && matches!(delivery.phase(), DeliveryPhase::Pending | DeliveryPhase::RetryScheduled { .. })
            {
                delivery.cancel(requested_at);
            }
        }
        Ok(outcome)
    }

    pub(crate) fn settle_graph_run_cancellation(
        &mut self,
        run_id: &GraphRunId,
        idempotency_key: &str,
        outcome: RoleAbortOutcome,
        observed_at: u64,
    ) -> Result<SettleCancellationOutcome, OrganizationFactsError> {
        self.touch_run(run_id.as_str());
        let result = {
            let run = self
                .runs
                .get_mut(run_id.as_str())
                .ok_or(OrganizationFactsError::UnknownRun)?;
            let result = run
                .lifecycle
                .settle_cancellation(idempotency_key, outcome, observed_at)
                .map_err(|_| OrganizationFactsError::InvalidGraphRunLifecycle)?;
            if result == SettleCancellationOutcome::Cancelled {
                let events = run
                    .graph
                    .executions()
                    .values()
                    .filter_map(|history| {
                        let attempt = history.current();
                        attempt
                            .status()
                            .accepts_outcome()
                            .then(|| GraphEvent::NodeCancelled {
                                node_id: attempt.node_id().clone(),
                                fence: attempt.fence().clone(),
                                cancelled_at: observed_at,
                            })
                    })
                    .collect::<Vec<_>>();
                for event in events {
                    run.graph.apply_event(event)
                        .map_err(|_| OrganizationFactsError::InvalidGraphRunLifecycle)?;
                }
            }
            result
        };
        if matches!(result, SettleCancellationOutcome::Cancelled | SettleCancellationOutcome::Replayed) {
            let resolution_key = approval::cancellation_resolution_key(idempotency_key);
            let pending = self.approvals_for_run(run_id.as_str())
                .filter(|approval| approval.is_pending())
                .map(|approval| {
                    let facts = approval.facts();
                    ApprovalResolutionInput {
                        run_id: run_id.clone(), approval_id: facts.approval_id.clone(),
                        stage_id: facts.stage_id.clone(), role_id: facts.role_id.clone(),
                        decision: crate::ApprovalDecision::Abort, resolved_at: observed_at.max(facts.requested_at),
                        note: None, idempotency_key: resolution_key.clone(),
                    }
                }).collect::<Vec<_>>();
            for input in pending {
                self.resolve_approval_with_cause(input, crate::run::approval::ApprovalResolutionCause::RunCancelled)?;
            }
        }
        Ok(result)
    }

    pub(crate) fn purge_graph_run(
        &mut self,
        request: TeamRunPurgeRequest,
        purged_at: u64,
    ) -> Result<GraphRunPurgeOutcome, OrganizationFactsError> {
        if request.idempotency_key().trim().is_empty() {
            return Ok(GraphRunPurgeOutcome::Rejected(
                GraphRunPurgeRejection::InvalidIdempotencyKey,
            ));
        }
        if let Some(marker) = self.purged_run_marker(request.run_id()) {
            return Ok(if marker.idempotency_key() == request.idempotency_key() {
                GraphRunPurgeOutcome::Replayed
            } else {
                GraphRunPurgeOutcome::Rejected(GraphRunPurgeRejection::AlreadyPurged)
            });
        }
        let Some(run) = self.run(request.run_id()) else {
            return Ok(GraphRunPurgeOutcome::OutcomeUnknown(
                GraphRunPurgeUnknown::MissingRun,
            ));
        };
        if !matches!(
            run.lifecycle().state(),
            GraphRunLifecycleState::Tombstoned { .. }
        ) {
            return Ok(GraphRunPurgeOutcome::Rejected(
                GraphRunPurgeRejection::NotTombstoned,
            ));
        }
        if run.runtime().is_none() && run.workspace().is_none() {
            return Ok(GraphRunPurgeOutcome::Rejected(GraphRunPurgeRejection::ProofMismatch));
        }
        let confirmed = run.confirmed_role_sessions();
        match request.native() {
            NativeDeletionEvidence::Rejected | NativeDeletionEvidence::Partial { failure: crate::NativeDeletionFailure::Rejected, .. } => {
                return Ok(GraphRunPurgeOutcome::Rejected(
                    GraphRunPurgeRejection::NativeDeletionRejected,
                ));
            }
            NativeDeletionEvidence::OutcomeUnknown | NativeDeletionEvidence::Partial { failure: crate::NativeDeletionFailure::OutcomeUnknown, .. } => {
                return Ok(GraphRunPurgeOutcome::OutcomeUnknown(
                    GraphRunPurgeUnknown::NativeDeletionOutcomeUnknown,
                ));
            }
            NativeDeletionEvidence::Confirmed(proof)
                if proof.run_id() != request.run_id() || !proof.covers(&confirmed) =>
            {
                return Ok(GraphRunPurgeOutcome::Rejected(
                    GraphRunPurgeRejection::ProofMismatch,
                ));
            }
            NativeDeletionEvidence::Confirmed(_) => {}
        }

        let marker = PurgedRunMarker::try_new(
            request.run_id().clone(),
            request.idempotency_key().to_owned(),
            purged_at,
        )?;
        self.remove_run(request.run_id().as_str());
        self.touch_admission(request.run_id().as_str());
        self.pending_workflow_plan_admissions
            .remove(request.run_id().as_str());
        self.deliveries
            .retain_without_run(request.run_id().as_str());
        self.activities
            .retain_without_run(request.run_id().as_str());
        self.triggers.retain_without_run(request.run_id().as_str());
        self.control_resolutions
            .retain_without_run(request.run_id());
        let approvals = self.approvals_for_run(request.run_id().as_str())
            .map(|approval| approval.facts().approval_id.clone()).collect::<Vec<_>>();
        for id in approvals { self.remove_approval(&id); }
        self.events.retain_without_run(request.run_id().as_str());
        self.evidence.retain_without_run(request.run_id().as_str());
        self.artifacts.retain_without_run(request.run_id().as_str());
        self.decisions.retain_without_run(request.run_id().as_str());
        self.task_board.retain_without_run(request.run_id());
        self.touch_purged(request.run_id().as_str());
        self.purged_runs
            .insert(request.run_id().as_str().to_owned(), marker);
        Ok(GraphRunPurgeOutcome::Purged)
    }

    pub(crate) fn tombstone_graph_run(
        &mut self,
        run_id: &GraphRunId,
        idempotency_key: &str,
        tombstoned_at: u64,
    ) -> Result<TombstoneOutcome, OrganizationFactsError> {
        if idempotency_key.trim().is_empty() {
            return Err(OrganizationFactsError::InvalidGraphRunLifecycle);
        }
        self.touch_run(run_id.as_str());
        let run = self
            .runs
            .get_mut(run_id.as_str())
            .ok_or(OrganizationFactsError::UnknownRun)?;
        let plan = crate::run::lifecycle::cancellation_plan(run);
        Ok(run
            .lifecycle
            .tombstone(plan, idempotency_key, tombstoned_at))
    }

    pub(crate) fn resume_graph_runs(&self, team_id: &TeamId) -> Vec<ResumeOutcome> {
        self.runs
            .values()
            .filter(|run| run.team() == team_id)
            .map(|run| match run.lifecycle().state() {
                GraphRunLifecycleState::Active | GraphRunLifecycleState::Cancelling { .. } => {
                    ResumeOutcome::Active(run.run_id().clone())
                }
                GraphRunLifecycleState::Cancelled { .. } => {
                    ResumeOutcome::Cancelled(run.run_id().clone())
                }
                GraphRunLifecycleState::OutcomeUnknown { .. } => {
                    ResumeOutcome::OutcomeUnknown(run.run_id().clone())
                }
                GraphRunLifecycleState::Tombstoned { .. } => {
                    ResumeOutcome::Tombstoned(run.run_id().clone())
                }
            })
            .collect()
    }

    pub(crate) fn install_runtime_receipt(
        &mut self,
        receipt: RunRuntimeReceipt,
    ) -> Result<(), OrganizationFactsError> {
        let run_id = receipt.team_run().as_str().to_owned();
        let run = self
            .runs
            .get(&run_id)
            .ok_or(OrganizationFactsError::RuntimeRunMissing)?;
        let team = self
            .teams
            .get(run.team().as_str())
            .expect("run restore preserves its team");
        if team.tombstoned() {
            return Err(OrganizationFactsError::RuntimeTeamTombstoned);
        }
        if !matches!(run.lifecycle().state(), GraphRunLifecycleState::Active) {
            return Err(OrganizationFactsError::InvalidGraphRunLifecycle);
        }
        let materialization = self.materialization(run.team())
            .ok_or(OrganizationFactsError::RuntimeMaterializationMissing)?;
        validate_runtime_receipt_alignment(run, &receipt, materialization)?;
        if run.runtime.is_some() {
            return Err(OrganizationFactsError::RuntimeAlreadyInstalled);
        }

        self.touch_run(&run_id);
        self.runs
            .get_mut(&run_id)
            .expect("validated runtime receipt run must remain present")
            .runtime = Some(receipt);
        Ok(())
    }

    pub(crate) fn fire_trigger(
        &mut self,
        request: TriggerFireRequest,
        fired_at: u64,
    ) -> Result<TriggerRegistration, TriggerFireError> {
        request
            .validate()
            .map_err(TriggerFireError::InvalidRequest)?;
        if let Some(existing) = self
            .triggers
            .request(&request.run_id, &request.idempotency_key)
        {
            return if existing == &request {
                Ok(TriggerRegistration::Replayed(existing.clone()))
            } else {
                Ok(TriggerRegistration::ConflictingIdempotencyKey {
                    idempotency_key: request.idempotency_key,
                })
            };
        }

        let run = self
            .runs
            .get(&request.run_id)
            .ok_or(TriggerFireError::RunMismatch)?;
        if run.run_id().as_str() != request.run_id {
            return Err(TriggerFireError::RunMismatch);
        }
        if !matches!(run.lifecycle().state(), GraphRunLifecycleState::Active) {
            return Err(TriggerFireError::RunMismatch);
        }
        if !matches!(run.start_gate(), RunStartGate::Started) {
            return Err(TriggerFireError::RunNotStarted);
        }
        let node_id = NodeId::new(request.start_node_id.clone());
        let node = run
            .graph()
            .definition()
            .node(&node_id)
            .ok_or(TriggerFireError::Reduce(crate::ReduceError::UnknownNode(
                node_id,
            )))?;
        if !node.is_armed_start() {
            return Err(TriggerFireError::Reduce(
                crate::ReduceError::TriggerNotArmed(node.id().clone()),
            ));
        }
        if !source_matches_trigger(request.source, node.trigger()) {
            return Err(TriggerFireError::SourceMismatch);
        }

        let scope = run.graph().trigger_scope(node.id()).map_err(TriggerFireError::Reduce)?;
        if !run.graph().trigger_busy_nodes(node.id()).map_err(TriggerFireError::Reduce)?.is_empty()
            || self.activities_for_run(&request.run_id).any(|activity| {
                run.graph().execution_scope(&activity.facts().node_id)
                    .is_ok_and(|occupied| !occupied.is_disjoint(&scope))
                    && matches!(activity.phase(), ActivityPhase::Claimed(_) | ActivityPhase::Dispatched(_)
                        | ActivityPhase::OutcomeUnknown { .. } | ActivityPhase::TerminalObserved { .. })
            })
            || self.deliveries_for_run(&request.run_id).any(|delivery| {
                run.graph().execution_scope(&NodeId::new(&delivery.facts().node_id))
                    .is_ok_and(|occupied| !occupied.is_disjoint(&scope))
                    && (matches!(delivery.phase(), DeliveryPhase::Delivering(_) | DeliveryPhase::Delivered { .. }
                        | DeliveryPhase::OutcomeUnknown { .. })
                        || matches!(delivery.phase(), DeliveryPhase::TerminalObserved { observation }
                            if matches!(observation.resolution(), TerminalObservationResolution::AwaitingAuthorizedGraphResolution)))
            })
        {
            return Err(TriggerFireError::Busy);
        }
        self.touch_run(&request.run_id);
        self.runs.get_mut(&request.run_id).expect("validated trigger run").graph.apply_event(
            GraphEvent::TriggerFired {
                node_id: NodeId::new(request.start_node_id.clone()),
                fired_at,
            },
        )
        .map_err(TriggerFireError::Reduce)?;
        let TriggerRegistration::Recorded(recorded) = self
            .triggers
            .register(request)
            .map_err(TriggerFireError::InvalidRequest)?
        else {
            unreachable!("trigger ledger was checked before recording")
        };
        Ok(TriggerRegistration::Recorded(recorded))
    }

    pub(crate) fn observe_native_terminal(
        &mut self,
        delivery_id: &crate::DeliveryId,
        native_terminal: NativeTerminalStatus,
        observed_at: u64,
    ) -> Result<TerminalObservationOutcome, TerminalObservationError> {
        let activity_id = ActivityId::new(delivery_id.as_str())
            .map_err(|_| TerminalObservationError::DeliveryMismatch)?;
        let terminal_claim = self.activities.activity(&activity_id).and_then(|activity| {
            let claim = activity.active_claim()?;
            validate_native_confirmed_activity_claim(&self.runs, &self.deliveries, activity, claim)
                .ok()?;
            Some(claim.clone())
        });
        let mut delivery = self
            .deliveries
            .delivery(delivery_id)
            .cloned()
            .ok_or(TerminalObservationError::DeliveryMismatch)?;
        let run_id = GraphRunId::new(delivery.facts().run_id.clone());
        self.touch_run(run_id.as_str());
        let run = self
            .runs
            .get_mut(run_id.as_str())
            .ok_or(TerminalObservationError::RunMismatch)?;
        let correlation = match delivery.phase() {
            DeliveryPhase::Delivered {
                native_correlation: Some(correlation),
                ..
            } => correlation.clone(),
            DeliveryPhase::TerminalObserved { observation } => observation.correlation().clone(),
            _ => return Err(TerminalObservationError::DeliveryNotAccepted),
        };
        runtime_trace("runtime.team_run.terminal.facts.observe", || json!({
            "deliveryHash": identifier_hash(delivery_id.as_str()),
            "runHash": identifier_hash(run_id.as_str()),
            "nodeHash": identifier_hash(&delivery.facts().node_id),
            "nativeRunHash": identifier_hash(correlation.native_run_receipt().as_str()),
            "outcome": "begin",
        }));
        let outcome = apply_terminal_observation(
            &mut delivery,
            &mut run.graph,
            correlation.endpoint_session_id().clone(),
            correlation.native_run_receipt().clone(),
            native_terminal,
            observed_at,
        )?;
        if !matches!(outcome, TerminalObservationOutcome::Replayed) {
            let activity_id = ActivityId::new(delivery_id.as_str().to_owned())
                .map_err(|_| {
                    runtime_trace("runtime.team_run.terminal.facts.activity", || json!({
                        "deliveryHash": identifier_hash(delivery_id.as_str()), "phase": "observe",
                        "outcome": "error", "reason": "invalid_activity_id",
                    }));
                    TerminalObservationError::DeliveryMismatch
                })?;
            if let Some(activity) = self.activities.activity_mut(&activity_id) {
                let settlement = match outcome {
                    TerminalObservationOutcome::RecordedAwaitingAuthorizedGraphResolution => {
                        ActivitySettlement::TerminalObserved { observed_at }
                    }
                    TerminalObservationOutcome::RecordedNodeCancelled => {
                        ActivitySettlement::Cancelled {
                            cancelled_at: observed_at,
                        }
                    }
                    TerminalObservationOutcome::Replayed => {
                        unreachable!("replayed outcome was filtered")
                    }
                };
                if matches!(activity.phase(), ActivityPhase::OutcomeUnknown { .. }) {
                    activity.confirm_unknown_native_terminal(native_terminal, observed_at);
                    runtime_trace("runtime.team_run.terminal.facts.activity", || json!({
                        "deliveryHash": identifier_hash(delivery_id.as_str()), "phase": "observe",
                        "outcome": "unknown_confirmed",
                    }));
                } else {
                    let claim = activity
                        .active_claim()
                        .cloned()
                        .ok_or(TerminalObservationError::StaleFence)
                        .inspect_err(|_| {
                            runtime_trace("runtime.team_run.terminal.facts.activity", || json!({
                                "deliveryHash": identifier_hash(delivery_id.as_str()), "phase": "observe",
                                "outcome": "error", "reason": "active_claim_missing",
                            }));
                        })?;
                    if terminal_claim.as_ref() == Some(&claim)
                        && !activity.retain_native_terminal_claim(&claim)
                    {
                        return Err(TerminalObservationError::StaleFence);
                    }
                    let result = crate::settle_activity(activity, &claim, settlement);
                    runtime_trace("runtime.team_run.terminal.facts.activity", || json!({
                        "deliveryHash": identifier_hash(delivery_id.as_str()), "phase": "observe",
                        "outcome": if result.is_ok() { "recorded" } else { "error" },
                        "error": result.as_ref().err().map(|error| crate::trace::terminal_error(&super::StoreFault::ActivityTransition(error.clone()))),
                    }));
                    result.map_err(|_| TerminalObservationError::StaleFence)?;
                }
            } else {
                runtime_trace("runtime.team_run.terminal.facts.activity", || json!({
                    "deliveryHash": identifier_hash(delivery_id.as_str()), "phase": "observe", "outcome": "absent",
                }));
            }
        }
        *self
            .deliveries
            .delivery_mut(delivery_id)
            .expect("delivery ledger preserves its delivery identity index") = delivery;
        if let Some(activity) = self.activities.activity(&activity_id)
            && let Some(claim) = activity.native_terminal_claim()
        {
            validate_native_confirmed_activity_claim(&self.runs, &self.deliveries, activity, claim)
                .map_err(|_| TerminalObservationError::StaleFence)?;
        }
        Ok(outcome)
    }

    pub(crate) fn replace_run_graph(
        &mut self,
        run_id: &GraphRunId,
        graph: GraphState,
    ) -> Result<(), OrganizationFactsError> {
        if graph.definition().run_id() != run_id {
            return Err(OrganizationFactsError::InvalidGraphRun);
        }
        self.touch_run(run_id.as_str());
        self.runs.get_mut(run_id.as_str()).ok_or(OrganizationFactsError::UnknownRun)?
            .graph.replace_with(graph);
        self.cancel_superseded_pending_activities(run_id);
        Ok(())
    }

    pub(crate) fn cancel_superseded_pending_activities(&mut self, run_id: &GraphRunId) {
        let Some(run) = self.runs.get(run_id.as_str()) else {
            return;
        };
        let cancelled = self
            .activities_for_run(run_id.as_str())
            .filter(|activity| {
                matches!(
                    activity.phase(),
                    ActivityPhase::Pending | ActivityPhase::RetryScheduled { .. }
                )
            })
            .filter_map(|activity| {
                let current = run.graph().current_attempt(&activity.facts().node_id)?;
                (current.fence() != &activity.facts().fence)
                    .then(|| (activity.facts().activity_id.clone(), current.created_at()))
            })
            .collect::<Vec<_>>();
        for (activity_id, cancelled_at) in cancelled {
            self.activities
                .activity_mut(&activity_id)
                .expect("selected activity exists")
                .cancel(cancelled_at);
            if let Ok(delivery_id) = crate::DeliveryId::new(activity_id.as_str())
                && let Some(delivery) = self.deliveries.delivery_mut(&delivery_id)
                && matches!(
                    delivery.phase(),
                    DeliveryPhase::Pending | DeliveryPhase::RetryScheduled { .. }
                )
            {
                delivery.cancel(cancelled_at);
            }
        }
    }

    pub(crate) fn apply_graph_patch(
        &mut self,
        run_id: &GraphRunId,
        patch: &crate::GraphPatch,
        applied_at: u64,
    ) -> Result<(), crate::StoreFault> {
        self.touch_run(run_id.as_str());
        let run = self.runs.get_mut(run_id.as_str())
            .ok_or(crate::StoreFault::GraphPatch(crate::GraphPatchError::UnknownRun))?;
        let previous_definition = run.graph.definition().clone();
        crate::run::graph::apply_graph_patch_in_place(&mut run.graph, patch, applied_at)
            .map_err(crate::StoreFault::GraphPatch)?;
        let changed = run.graph.definition() != &previous_definition;
        if changed {
            let run = self.runs.get(run_id.as_str()).expect("validated run");
            if matches!(run.start_gate(), RunStartGate::Started) {
                run.graph.definition().validate_join_inputs().map_err(|error| {
                    crate::StoreFault::GraphPatch(crate::GraphPatchError::Definition(error))
                })?;
            }
            if matches!(run.start_gate(), RunStartGate::Designing { .. }) {
                crate::application::design::validate_definition(self, run, run.graph.definition(), false)?;
            } else {
                crate::application::design::validate_assignments(
                    self, run, run.graph.definition(), Some(&previous_definition),
                )?;
            }
            super::design::invalidate_graph_design(self.runs.get_mut(run_id.as_str()).expect("validated run"));
        }
        Ok(())
    }

    pub(crate) fn replace_team_graph(
        &mut self,
        command: crate::RunCommand,
        definition: crate::GraphDefinition,
    ) -> Result<crate::CommandReceipt, crate::StoreFault> {
        let run_id = GraphRunId::new(command.run_id().as_str());
        if definition.run_id() != &run_id
            || command.payload() != &crate::CommandPayload::GraphReplace(definition.clone())
        {
            return Err(crate::StoreFault::EventLedger(crate::RecordCommandError::InvalidEventId));
        }
        if let Some(existing) = self
            .events
            .command_by_idempotency(command.run_id(), command.idempotency_key())
        {
            if existing.command() != &command {
                return Err(crate::StoreFault::EventLedger(crate::RecordCommandError::IdempotencyConflict));
            }
            return self.events.try_accept(command).map_err(crate::StoreFault::EventLedger);
        }
        let current = self
            .runs
            .get(run_id.as_str())
            .ok_or(crate::StoreFault::GraphPatch(crate::GraphPatchError::UnknownRun))?;
        definition.validate().and_then(|_| definition.validate_references(Some(current.graph().definition())))
            .map_err(|error| crate::StoreFault::GraphPatch(crate::GraphPatchError::Definition(error)))?;
        let graph = GraphState::initialize(definition, command.created_at())
            .with_current_identity(current.graph());
        let changed = graph.definition() != current.graph().definition();
        if changed && matches!(current.start_gate(), RunStartGate::Started) {
            graph.definition().validate_join_inputs().map_err(|error| {
                crate::StoreFault::GraphPatch(crate::GraphPatchError::Definition(error))
            })?;
        }
        if matches!(current.start_gate(), RunStartGate::Designing { .. })
        {
            crate::application::design::validate_definition(
                self,
                &current,
                graph.definition(),
                false,
            )?;
        } else {
            crate::application::design::validate_assignments(self, &current, graph.definition(), None)?;
        }
        self.events
            .replay(&command)
            .map_err(crate::StoreFault::EventLedger)?;
        self.touch_run(run_id.as_str());
        let previous = std::mem::replace(
            &mut self
                .runs
                .get_mut(run_id.as_str())
                .expect("validated run")
                .graph,
            graph,
        );
        let admissible = self.validate_replaced_graph_dependents(run_id.as_str());
        let graph = std::mem::replace(
            &mut self
                .runs
                .get_mut(run_id.as_str())
                .expect("validated run")
                .graph,
            previous,
        );
        admissible.map_err(|_| crate::StoreFault::InvalidFacts)?;
        let graph = graph.with_replacement_identity(command.command_id());
        let receipt = self
            .events
            .try_accept(command)
            .map_err(crate::StoreFault::EventLedger)?;
        let updated = self.runs.get_mut(run_id.as_str()).expect("validated run");
        updated
            .retired_executions
            .extend(
                updated
                    .graph
                    .executions()
                    .iter()
                    .flat_map(|(node, history)| {
                        history
                            .attempts()
                            .iter()
                            .map(|attempt| (node.clone(), attempt.fence().clone()))
                    }),
            );
        updated.graph.replace_with(graph);
        if changed {
            super::design::invalidate_graph_design(updated);
        }
        self.cancel_superseded_pending_activities(&run_id);
        Ok(receipt)
    }

    pub(crate) fn team_graph_patch(
        &mut self,
        command: crate::RunCommand,
        patch: &crate::GraphPatch,
    ) -> Result<crate::CommandReceipt, crate::StoreFault> {
        let run_id = GraphRunId::new(command.run_id().as_str());
        if let Some(existing) = self
            .events
            .command_by_idempotency(command.run_id(), command.idempotency_key())
        {
            if existing.command() != &command {
                return Err(crate::StoreFault::EventLedger(
                    crate::RecordCommandError::IdempotencyConflict,
                ));
            }
            return self
                .events
                .try_accept(command)
                .map_err(crate::StoreFault::EventLedger);
        }
        self.touch_run(run_id.as_str());
        let current = self.runs.get_mut(run_id.as_str())
            .ok_or(crate::StoreFault::GraphPatch(crate::GraphPatchError::UnknownRun))?;
        let previous_definition = current.graph.definition().clone();
        crate::run::graph::apply_graph_patch_in_place(&mut current.graph, patch, command.created_at())
            .map_err(crate::StoreFault::GraphPatch)?;
        let changed = current.graph.definition() != &previous_definition;
        let current = self.runs.get(run_id.as_str()).expect("validated run");
        if changed && matches!(current.start_gate(), RunStartGate::Started) {
            current.graph.definition().validate_join_inputs().map_err(|error| {
                crate::StoreFault::GraphPatch(crate::GraphPatchError::Definition(error))
            })?;
        }
        if matches!(current.start_gate(), RunStartGate::Designing { .. }) {
            crate::application::design::validate_definition(self, current, current.graph.definition(), false)?;
        } else if changed {
            crate::application::design::validate_assignments(
                self, current, current.graph.definition(), Some(&previous_definition),
            )?;
        }
        let receipt = self.events.try_accept(command).map_err(crate::StoreFault::EventLedger)?;
        if changed {
            super::design::invalidate_graph_design(self.runs.get_mut(run_id.as_str()).expect("validated run"));
        }
        Ok(receipt)
    }

    pub(crate) fn team_node_event(
        &mut self,
        command: crate::RunCommand,
        event: crate::TeamNodeEvent,
    ) -> Result<crate::TeamNodeEventOutcome, crate::RecordCommandError> {
        let run_id = GraphRunId::new(command.run_id().as_str());
        let run = self
            .runs
            .get(run_id.as_str())
            .ok_or(crate::RecordCommandError::InvalidEventId)?;
        let (node_id, fence, role_id) = current_node_event_target(run.graph(), &event)
            .ok_or(crate::RecordCommandError::InvalidEventId)?;
        let approval_id = match event.kind() {
            crate::TeamNodeEventKind::RequestApproval { .. } => Some(
                crate::run::event::OpaqueId::try_new(format!(
                    "team-approval-{}",
                    command.idempotency_key().as_str()
                ))
                .map_err(|_| crate::RecordCommandError::InvalidEventId)?,
            ),
            _ => None,
        };
        let resolved_role_id = role_id
            .as_deref()
            .map(crate::run::event::OpaqueId::try_new)
            .transpose()
            .map_err(|_| crate::RecordCommandError::InvalidEventId)?;
        let Some(payload) = event.command_payload(approval_id.clone(), resolved_role_id) else {
            return Ok(crate::TeamNodeEventOutcome::TerminalReceiptRequired);
        };
        if command.payload() != &payload {
            return Err(crate::RecordCommandError::IdempotencyConflict);
        }
        let approval_content = if matches!(event.kind(), crate::TeamNodeEventKind::RequestApproval { .. }) {
            let submission = event.approval_submission();
            let mut artifact_ids = self.approval_input_artifacts(&run_id, run.graph(), &node_id);
            if let Some(submission) = submission {
                for id in submission.artifact_ids() {
                    let artifact_id = crate::run::ArtifactId::new(id).map_err(|_| crate::RecordCommandError::InvalidEventId)?;
                    if self.artifacts.artifact(&artifact_id).is_none_or(|artifact| artifact.run_id() != run_id.as_str()) {
                        return Err(crate::RecordCommandError::InvalidEventId);
                    }
                }
                artifact_ids.extend(submission.artifact_ids().iter().cloned());
                artifact_ids.sort();
                artifact_ids.dedup();
            }
            let node = run.graph().definition().node(&node_id).ok_or(crate::RecordCommandError::InvalidEventId)?;
            Some(crate::run::approval::ApprovalContent {
                title: node.title().to_owned(),
                body: submission.map(|submission| submission.body().to_owned()),
                artifact_ids,
            })
        } else { None };
        let existing = self.events.try_accept(command.clone())?;
        if existing.is_replay() {
            return Ok(match event.kind() {
                crate::TeamNodeEventKind::Progress => crate::TeamNodeEventOutcome::Progressed,
                crate::TeamNodeEventKind::RequestInput => {
                    crate::TeamNodeEventOutcome::WaitingForInput
                }
                crate::TeamNodeEventKind::RequestApproval { .. } => {
                    crate::TeamNodeEventOutcome::ApprovalRequested
                }
                crate::TeamNodeEventKind::Complete | crate::TeamNodeEventKind::Reject => {
                    return Err(crate::RecordCommandError::RejectionConflict);
                }
            });
        }
        self.require_started_run(&run_id).map_err(|_| crate::RecordCommandError::InvalidEventId)?;
        let outcome = match event.kind() {
            crate::TeamNodeEventKind::Progress => crate::TeamNodeEventOutcome::Progressed,
            crate::TeamNodeEventKind::RequestInput => {
                self.touch_run(run_id.as_str());
                self.runs.get_mut(run_id.as_str()).expect("validated run").graph.apply_event(
                    GraphEvent::NodeWaiting {
                        node_id,
                        fence,
                        waiting_at: command.created_at(),
                    },
                )
                .map_err(|_| crate::RecordCommandError::InvalidEventId)?;
                crate::TeamNodeEventOutcome::WaitingForInput
            }
            crate::TeamNodeEventKind::RequestApproval { action } => {
                let approval_id = approval_id.expect("approval request creates its identifier");
                let approval = Approval::request(crate::ApprovalRequest {
                    approval_id: approval_id.as_str().to_owned(),
                    run_id: run_id.as_str().to_owned(),
                    stage_id: node_id.as_str().to_owned(),
                    role_id: role_id.expect("approval request resolves a role"),
                    reason: "Agent requested approval.".to_owned(),
                    requested_action: approval_action_name(action).to_owned(),
                    risk_summary: event.approval_submission().and_then(|submission| submission.risk()).unwrap_or("").to_owned(),
                    content: approval_content,
                    idempotency_key: command.idempotency_key().as_str().to_owned(),
                    requested_at: command.created_at(),
                    subject: crate::ApprovalSubject::WorkNode {
                        node_id: node_id.as_str().to_owned(),
                    },
                    origin: crate::ApprovalOrigin::WorkNode,
                    effect: crate::ApprovalEffect::KeepNodeWaiting,
                    execution_fence: Some(fence.node_execution_id().as_str().to_owned()),
                });
                self.insert_approval(approval);
                self.touch_run(run_id.as_str());
                self.runs.get_mut(run_id.as_str()).expect("validated run").graph.apply_event(
                    GraphEvent::NodeWaiting {
                        node_id,
                        fence,
                        waiting_at: command.created_at(),
                    },
                )
                .map_err(|_| crate::RecordCommandError::InvalidEventId)?;
                crate::TeamNodeEventOutcome::ApprovalRequested
            }
            crate::TeamNodeEventKind::Complete | crate::TeamNodeEventKind::Reject => {
                return Err(crate::RecordCommandError::RejectionConflict);
            }
        };
        Ok(outcome)
    }

    pub(crate) fn apply_agent_node_event_resolution(
        &mut self,
        event: AgentNodeEventResolution,
    ) -> Result<AuthorizedGraphResolutionOutcome, AgentNodeEventResolutionError> {
        let run = self
            .runs
            .get(event.graph_run_id().as_str())
            .ok_or(AgentNodeEventResolutionError::NodeMismatch)?;
        let delivery = self
            .deliveries
            .delivery(event.delivery_id())
            .ok_or(AgentNodeEventResolutionError::NodeMismatch)?;
        if delivery.facts().run_id != event.graph_run_id().as_str()
            || delivery.facts().node_execution_id != event.fence().node_execution_id().as_str()
        {
            return Err(AgentNodeEventResolutionError::NodeMismatch);
        }
        let node_id = NodeId::new(delivery.facts().node_id.clone());
        let node = run
            .graph()
            .definition()
            .node(&node_id)
            .ok_or(AgentNodeEventResolutionError::NodeMismatch)?;
        let resolution = event.authorized_resolution(node.kind())?;

        // Build the opaque artifact before reducing the graph so malformed or conflicting
        // artifact identity cannot leave a graph transition partially applied.
        let artifact = if resolution.outcome() == crate::AuthorizedGraphOutcome::Completed
            && (event.summary().is_some()
                || event
                    .completion_receipt()
                    .is_some_and(|receipt| receipt.artifact_evidence().next().is_some()))
        {
            let attempt = run
                .graph()
                .executions()
                .get(&node_id)
                .and_then(|history| {
                    history
                        .attempts()
                        .iter()
                        .find(|attempt| attempt.fence() == resolution.fence())
                })
                .ok_or(AgentNodeEventResolutionError::CompletionReceiptMismatch)?;
            let evidence = event
                .completion_receipt()
                .into_iter()
                .flat_map(|receipt| receipt.artifact_evidence())
                .map(|evidence| {
                    ArtifactEvidenceProvenance::new(evidence.reference().reference(), "artifact")
                        .map_err(|_| AgentNodeEventResolutionError::CompletionReceiptMismatch)
                })
                .collect::<Result<Vec<_>, _>>()?;
            Some(
                build_graph_completion_artifact(
                    event.graph_run_id(),
                    node,
                    attempt,
                    delivery.facts().role_id.clone(),
                    CompletionMetadata {
                        output_port: resolution.output_port().to_owned(),
                        summary: event.summary().map(ToOwned::to_owned),
                        evidence,
                    },
                    event
                        .artifact_source_envelope_id()
                        .or_else(|| {
                            event
                                .completion_receipt()
                                .map(|receipt| receipt.receipt().as_str())
                        })
                        .unwrap_or(event.receipt().as_str()),
                    event
                        .artifact_idempotency_key()
                        .unwrap_or(event.receipt().as_str()),
                    resolution.resolved_at(),
                )
                .map_err(|_| AgentNodeEventResolutionError::CompletionReceiptMismatch)?
                .artifact.with_delivery_files(
                    Some(crate::RoleSessionRef::try_new(delivery.facts().session_ref.clone())
                        .map_err(|_| AgentNodeEventResolutionError::CompletionReceiptMismatch)?),
                    Vec::new(),
                ).map_err(|_| AgentNodeEventResolutionError::CompletionReceiptMismatch)?,
            )
        } else {
            None
        };

        if let Some(artifact) = &artifact
            && let Some(existing) = self.artifacts.artifact(artifact.artifact_id())
            && existing != artifact
        {
            return Err(AgentNodeEventResolutionError::CompletionReceiptMismatch);
        }

        if let Some(artifact) = artifact {
            self.record_terminal_completion_artifact(event.delivery_id(), artifact)
                .map_err(|_| AgentNodeEventResolutionError::CompletionReceiptMismatch)?;
        }
        self.apply_authorized_graph_resolution(resolution)
            .map_err(AgentNodeEventResolutionError::AuthorizedResolution)
    }

    fn record_terminal_completion_artifact(
        &mut self,
        delivery_id: &crate::DeliveryId,
        artifact: ArtifactRecord,
    ) -> Result<(), OrganizationFactsError> {
        let delivery = self
            .deliveries
            .delivery(delivery_id)
            .ok_or(OrganizationFactsError::InvalidTerminalObservation)?;
        let DeliveryPhase::TerminalObserved { observation } = delivery.phase() else {
            return Err(OrganizationFactsError::InvalidTerminalObservation);
        };
        if artifact.run_id() != observation.graph_run_id()
            || artifact.fence() != observation.fence()
            || artifact.node_id() != observation.node_id()
            || artifact.role_id() != observation.role_id()
        {
            return Err(OrganizationFactsError::InvalidTerminalObservation);
        }
        // Only a verified delivery terminal can attach its completion to superseded history.
        validate_artifact_provenance(&self.runs, &artifact)?;
        let recorded = self.artifacts.record(artifact);
        runtime_trace("runtime.team_run.terminal.facts.artifact", || json!({
            "deliveryHash": identifier_hash(delivery_id.as_str()), "phase": "record",
            "outcome": match &recorded {
                ArtifactRecordOutcome::Recorded(_) => "recorded",
                ArtifactRecordOutcome::Replayed(_) => "replayed",
                ArtifactRecordOutcome::ConflictingArtifactId { .. } => "conflicting_artifact_id",
            },
        }));
        match recorded {
            ArtifactRecordOutcome::Recorded(_) | ArtifactRecordOutcome::Replayed(_) => Ok(()),
            ArtifactRecordOutcome::ConflictingArtifactId { .. } => {
                Err(OrganizationFactsError::InvalidTerminalObservation)
            }
        }
    }

    pub(crate) fn apply_authorized_graph_resolution(
        &mut self,
        resolution: AuthorizedGraphResolution,
    ) -> Result<AuthorizedGraphResolutionOutcome, AuthorizedGraphResolutionError> {
        let run_id = GraphRunId::new(resolution.graph_run_id().to_owned());
        self.touch_run(run_id.as_str());
        let run = self
            .runs
            .get_mut(run_id.as_str())
            .ok_or(AuthorizedGraphResolutionError::RunMismatch)?;
        let mut delivery = self
            .deliveries
            .delivery(resolution.delivery_id())
            .cloned()
            .ok_or(AuthorizedGraphResolutionError::DeliveryMismatch)?;
        let delivery_id = delivery.facts().delivery_id.clone();
        let resolved_at = resolution.resolved_at();
        let outcome = apply_authorized_graph_resolution(&mut delivery, &mut run.graph, resolution)?;
        if matches!(outcome, AuthorizedGraphResolutionOutcome::Recorded)
            && let DeliveryPhase::TerminalObserved { observation } = delivery.phase()
            && let TerminalObservationResolution::GraphResolved(resolution) =
                observation.resolution()
        {
            self.settle_resolved_activity(&delivery_id, resolution.outcome(), resolved_at)
                .map_err(|_| AuthorizedGraphResolutionError::GraphStateMismatch)?;
        }
        self.cancel_superseded_pending_activities(&run_id);
        *self
            .deliveries
            .delivery_mut(&delivery_id)
            .expect("delivery ledger preserves its delivery identity index") = delivery;
        Ok(outcome)
    }

    pub(crate) fn resolve_native_run_output(
        &mut self,
        delivery_id: &crate::DeliveryId,
        receipt: crate::AuthorizedGraphResolutionReceipt,
        final_assistant_text: String,
        resolved_at: u64,
    ) -> Result<AuthorizedGraphResolutionOutcome, crate::NativeRunOutputResolutionError> {
        let output = crate::TeamNodeOutput::parse(final_assistant_text)
            .map_err(|_| crate::NativeRunOutputResolutionError::InvalidOutput)?;
        self.resolve_parsed_native_output(delivery_id, receipt, output, resolved_at)
    }

    fn resolve_parsed_native_output(
        &mut self,
        delivery_id: &crate::DeliveryId,
        receipt: crate::AuthorizedGraphResolutionReceipt,
        output: crate::TeamNodeOutput,
        resolved_at: u64,
    ) -> Result<AuthorizedGraphResolutionOutcome, crate::NativeRunOutputResolutionError> {
        let mut delivery = self.deliveries.delivery(delivery_id).cloned().ok_or(
            crate::NativeRunOutputResolutionError::AuthorizedResolution(
                AuthorizedGraphResolutionError::DeliveryMismatch,
            ),
        )?;
        let run_id = GraphRunId::new(delivery.facts().run_id.clone());
        let run = self.runs.get(run_id.as_str()).ok_or(
            crate::NativeRunOutputResolutionError::AuthorizedResolution(
                AuthorizedGraphResolutionError::RunMismatch,
            ),
        )?;
        let DeliveryPhase::TerminalObserved { observation } = delivery.phase() else {
            return Err(crate::NativeRunOutputResolutionError::AuthorizedResolution(
                AuthorizedGraphResolutionError::DeliveryNotAwaitingAuthorizedResolution,
            ));
        };
        if matches!(
            observation.resolution(),
            TerminalObservationResolution::GraphResolved(_)
        ) {
            self.touch_run(run_id.as_str());
            let run = self.runs.get_mut(run_id.as_str()).expect("validated run");
            return apply_native_run_output(
                &mut delivery,
                &mut run.graph,
                receipt,
                output,
                resolved_at,
            );
        }
        if observation.native_terminal() == NativeTerminalStatus::Completed {
            let node_id = NodeId::new(observation.node_id());
            let node = run.graph().definition().node(&node_id).ok_or(
                crate::NativeRunOutputResolutionError::AuthorizedResolution(
                    AuthorizedGraphResolutionError::NodeMismatch,
                ),
            )?;
            let attempt = run.graph().executions()[&node_id]
                .attempts()
                .iter()
                .find(|attempt| attempt.fence() == observation.fence())
                .ok_or(crate::NativeRunOutputResolutionError::AuthorizedResolution(
                    AuthorizedGraphResolutionError::StaleFence,
                ))?;
            let artifact = build_graph_completion_artifact(
                &run_id,
                node,
                attempt,
                delivery.facts().role_id.clone(),
                CompletionMetadata {
                    output_port: output.decision().to_owned(),
                    summary: Some(output.summary().to_owned()),
                    evidence: Vec::new(),
                },
                format!("team-node-event:{}", receipt.as_str()),
                receipt.as_str(),
                resolved_at,
            )
            .map_err(|error| {
                runtime_trace("runtime.team_run.terminal.facts.artifact", || json!({
                    "deliveryHash": identifier_hash(delivery_id.as_str()), "phase": "build",
                    "outcome": "error", "reason": match error {
                        crate::run::artifact::ArtifactRecordError::BlankIdentity => "blank_identity",
                        crate::run::artifact::ArtifactRecordError::InvalidEvidenceProvenance => "invalid_evidence_provenance",
                        crate::run::artifact::ArtifactRecordError::InvalidKind => "invalid_kind",
                        crate::run::artifact::ArtifactRecordError::InvalidTitle => "invalid_title",
                        crate::run::artifact::ArtifactRecordError::InvalidContentReference => "invalid_content_reference",
                        crate::run::artifact::ArtifactRecordError::InvalidSummary => "invalid_summary",
                        crate::run::artifact::ArtifactRecordError::InvalidFiles => "invalid_files",
                    },
                }));
                crate::NativeRunOutputResolutionError::InvalidOutput
            })?
            .artifact.with_delivery_files(
                Some(crate::RoleSessionRef::try_new(delivery.facts().session_ref.clone())
                    .map_err(|_| crate::NativeRunOutputResolutionError::InvalidOutput)?),
                output.files().to_vec(),
            ).map_err(|_| crate::NativeRunOutputResolutionError::InvalidOutput)?;
            self.record_terminal_completion_artifact(delivery_id, artifact)
                .map_err(|error| {
                    runtime_trace("runtime.team_run.terminal.facts.artifact", || json!({
                        "deliveryHash": identifier_hash(delivery_id.as_str()), "phase": "record",
                        "outcome": "error", "reason": crate::trace::terminal_facts_reason(&error),
                    }));
                    crate::NativeRunOutputResolutionError::InvalidOutput
                })?;
        }
        self.touch_run(run_id.as_str());
        let run = self.runs.get_mut(run_id.as_str()).expect("validated run");
        let outcome =
            apply_native_run_output(&mut delivery, &mut run.graph, receipt, output, resolved_at)?;
        if matches!(outcome, AuthorizedGraphResolutionOutcome::Recorded)
            && let crate::DeliveryPhase::TerminalObserved { observation } = delivery.phase()
            && let TerminalObservationResolution::GraphResolved(resolution) =
                observation.resolution()
        {
            self.settle_resolved_activity(
                delivery_id,
                resolution.outcome(),
                resolution.resolved_at(),
            )
            .map_err(|_| {
                crate::NativeRunOutputResolutionError::AuthorizedResolution(
                    AuthorizedGraphResolutionError::GraphStateMismatch,
                )
            })?;
        }
        *self
            .deliveries
            .delivery_mut(delivery_id)
            .expect("delivery ledger preserves its delivery identity index") = delivery;
        self.cancel_superseded_pending_activities(&run_id);
        Ok(outcome)
    }

    pub(crate) fn settle_native_terminal(
        &mut self,
        target: &super::NativeTerminalReceiptTarget,
        status: NativeTerminalStatus,
        output: Result<Option<crate::TeamNodeOutput>, crate::application::team_message::TeamMessageFailure>,
        settled_at: u64,
    ) -> Result<AuthorizedGraphResolutionOutcome, super::StoreFault> {
        use super::StoreFault;
        let existing = self.deliveries.delivery(target.delivery_id()).and_then(|delivery| match delivery.phase() {
            DeliveryPhase::TerminalObserved { observation } => Some(observation),
            _ => None,
        });
        let observed_at = existing.map_or(settled_at, TerminalObservation::observed_at);
        let resolved_at = existing.and_then(|observation| match observation.resolution() {
            TerminalObservationResolution::GraphResolved(resolution) => Some(resolution.resolved_at()),
            _ => None,
        }).unwrap_or(settled_at);
        let mut phase = "observe_native_terminal";
        let result = (|| {
            let observed = self.observe_native_terminal(target.delivery_id(), status, observed_at)
                .map_err(StoreFault::TerminalObservation)?;
            runtime_trace("runtime.team_run.terminal.facts.observe", || json!({
                "deliveryHash": identifier_hash(target.delivery_id().as_str()),
                "runHash": identifier_hash(target.graph_run_id().as_str()),
                "outcome": match observed {
                    TerminalObservationOutcome::Replayed => "replayed",
                    TerminalObservationOutcome::RecordedNodeCancelled => "node_cancelled",
                    TerminalObservationOutcome::RecordedAwaitingAuthorizedGraphResolution => "awaiting_resolution",
                },
            }));
            if status == NativeTerminalStatus::Cancelled {
                return Ok(if observed == TerminalObservationOutcome::Replayed {
                    AuthorizedGraphResolutionOutcome::Replayed
                } else {
                    AuthorizedGraphResolutionOutcome::Recorded
                });
            }
            if let Ok(Some(output)) = output {
                phase = "resolve_output";
                return self.resolve_parsed_native_output(
                    target.delivery_id(),
                    crate::AuthorizedGraphResolutionReceipt::try_new(format!("native-settled:{}", target.delivery_id().as_str()))
                        .map_err(|_| StoreFault::InvalidFacts)?,
                    output,
                    resolved_at,
                ).map_err(StoreFault::NativeRunOutputResolution);
            }
            let failure = output.err();
            phase = "completed_output_missing";
            if failure.is_none() && status == NativeTerminalStatus::Completed {
                return Err(StoreFault::InvalidFacts);
            }
            phase = "failure_receipt";
            let receipt = match failure {
                Some(failure) => failure.receipt(target.delivery_id()),
                None => crate::AuthorizedGraphResolutionReceipt::try_new(format!("native-settled:{}", target.delivery_id().as_str()))
                    .map_err(|_| StoreFault::InvalidFacts)?,
            };
            phase = "failure_observation";
            let observation = match self.deliveries.delivery(target.delivery_id()).map(|delivery| delivery.phase()) {
                Some(DeliveryPhase::TerminalObserved { observation }) => observation,
                _ => return Err(StoreFault::InvalidFacts),
            };
            phase = "build_evidence";
            let record = failure.map(|failure| failure.evidence(observation, resolved_at)).transpose()?;
            phase = "build_failure_resolution";
            let resolution = crate::AuthorizedGraphResolution::new(
                receipt, target.delivery_id().clone(), target.graph_run_id().as_str(), observation.fence().clone(),
                crate::AuthorizedGraphOutcome::Failed, "failed", resolved_at,
            ).map_err(|error| {
                runtime_trace("runtime.team_run.terminal.facts.resolution", || json!({
                    "deliveryHash": identifier_hash(target.delivery_id().as_str()), "outcome": "error",
                    "reason": match error {
                        crate::run::delivery::InvalidAuthorizedGraphResolution::BlankGraphRunId => "blank_graph_run_id",
                        crate::run::delivery::InvalidAuthorizedGraphResolution::BlankOutputPort => "blank_output_port",
                        crate::run::delivery::InvalidAuthorizedGraphResolution::UnsafeOutputPort => "unsafe_output_port",
                    },
                }));
                StoreFault::InvalidFacts
            })?;
            phase = "resolve_failure";
            let outcome = self.apply_authorized_graph_resolution(resolution)
                .map_err(StoreFault::AuthorizedGraphResolution)?;
            if let Some(record) = record {
                phase = "validate_evidence";
                validate_evidence_provenance(&self.runs, &record).map_err(|error| {
                    runtime_trace("runtime.team_run.terminal.facts.evidence", || json!({
                        "deliveryHash": identifier_hash(target.delivery_id().as_str()),
                        "outcome": "error", "reason": crate::trace::terminal_facts_reason(&error),
                    }));
                    StoreFault::InvalidFacts
                })?;
                phase = "record_evidence";
                let recorded = self.evidence.record(record);
                runtime_trace("runtime.team_run.terminal.facts.evidence", || json!({
                    "deliveryHash": identifier_hash(target.delivery_id().as_str()),
                    "outcome": match &recorded {
                        RecordOutcome::Recorded(_) => "recorded",
                        RecordOutcome::Replayed(_) => "replayed",
                        RecordOutcome::ConflictingEvidenceId { .. } => "conflicting_evidence_id",
                    },
                }));
                match recorded {
                    RecordOutcome::Recorded(_) | RecordOutcome::Replayed(_) => {}
                    RecordOutcome::ConflictingEvidenceId { .. } => return Err(StoreFault::InvalidFacts),
                }
            }
            Ok(outcome)
        })();
        runtime_trace("runtime.team_run.terminal.facts.settle", || json!({
            "deliveryHash": identifier_hash(target.delivery_id().as_str()),
            "runHash": identifier_hash(target.graph_run_id().as_str()),
            "nativeRunHash": identifier_hash(target.correlation().native_run_receipt().as_str()),
            "phase": phase,
            "outcome": match &result {
                Ok(AuthorizedGraphResolutionOutcome::Recorded) => "recorded",
                Ok(AuthorizedGraphResolutionOutcome::Replayed) => "replayed",
                Err(_) => "error",
            },
            "error": result.as_ref().err().map(crate::trace::terminal_error),
        }));
        result
    }

    fn settle_resolved_activity(
        &mut self,
        delivery_id: &crate::DeliveryId,
        resolution_outcome: crate::AuthorizedGraphOutcome,
        resolved_at: u64,
    ) -> Result<(), crate::ActivityTransitionError> {
        let activity_id = ActivityId::new(delivery_id.as_str().to_owned())
            .map_err(|_| {
                runtime_trace("runtime.team_run.terminal.facts.activity", || json!({
                    "deliveryHash": identifier_hash(delivery_id.as_str()), "phase": "resolve",
                    "outcome": "error", "reason": "invalid_activity_id",
                }));
                crate::ActivityTransitionError::StaleClaim
            })?;
        if let Some(activity) = self.activities.activity_mut(&activity_id) {
            let settlement = match resolution_outcome {
                crate::AuthorizedGraphOutcome::Completed => ActivitySettlement::Completed {
                    completed_at: resolved_at,
                },
                crate::AuthorizedGraphOutcome::Failed => ActivitySettlement::Failed {
                    failed_at: resolved_at,
                    failure: crate::ActivityFailure::Rejected,
                },
            };
            let result = crate::run::activity::resolve_terminal_observed_activity(activity, settlement);
            runtime_trace("runtime.team_run.terminal.facts.activity", || json!({
                "deliveryHash": identifier_hash(delivery_id.as_str()), "phase": "resolve",
                "outcome": if result.is_ok() { "recorded" } else { "error" },
                "error": result.as_ref().err().map(|error| crate::trace::terminal_error(&super::StoreFault::ActivityTransition(error.clone()))),
            }));
            result?;
        } else {
            runtime_trace("runtime.team_run.terminal.facts.activity", || json!({
                "deliveryHash": identifier_hash(delivery_id.as_str()), "phase": "resolve", "outcome": "absent",
            }));
        }
        Ok(())
    }

    pub(crate) fn apply_control_node_resolution(
        &mut self,
        resolution: ControlNodeResolution,
    ) -> Result<ControlNodeResolutionOutcome, ControlNodeResolutionError> {
        match self
            .control_resolutions
            .resolution(resolution.idempotency_key())
        {
            Some(existing) if existing == &resolution => {
                return Ok(ControlNodeResolutionOutcome::Replayed);
            }
            Some(_) => return Err(ControlNodeResolutionError::ConflictingResolution),
            None => {}
        }

        let run = self.require_started_run(resolution.graph_run_id())
            .map_err(|_| ControlNodeResolutionError::GraphStateMismatch)?;
        if run.run_id() != resolution.graph_run_id() {
            return Err(ControlNodeResolutionError::GraphRunMismatch);
        }
        if resolution.authority() == ControlAuthority::HumanDecision
            && !self.approvals_for_run(resolution.graph_run_id().as_str()).any(|approval| {
                let facts = approval.facts();
                matches!(facts.binding(), Some(ApprovalBinding::HumanDecision { node_id, execution_fence })
                    if node_id == resolution.node_id().as_str()
                        && execution_fence == resolution.fence().node_execution_id().as_str())
                    && approval.resolution().is_some_and(|receipt| {
                        receipt.cause == crate::run::approval::ApprovalResolutionCause::HumanDecision
                            && receipt.resolved_at == resolution.resolved_at()
                            && resolution.outcome() == crate::AuthorizedGraphOutcome::Completed
                            && resolution.output_port() == match receipt.decision {
                                crate::ApprovalDecision::Approve => "approved",
                                crate::ApprovalDecision::Deny => "rejected",
                                crate::ApprovalDecision::Abort => "aborted",
                            }
                    })
            })
        {
            return Err(ControlNodeResolutionError::GraphStateMismatch);
        }
        let expected_kind = match resolution.authority() {
            ControlAuthority::HumanDecision => crate::NodeKind::HumanDecision,
            ControlAuthority::ScriptReview => crate::NodeKind::ScriptReview,
            ControlAuthority::Join => crate::NodeKind::Join,
        };
        crate::run::control::require_resolvable_control_node(
            run.graph(),
            resolution.node_id(),
            resolution.fence(),
            expected_kind,
        )?;
        if resolution.authority() == ControlAuthority::ScriptReview
            && run.graph().definition().node(resolution.node_id()).and_then(|node| node.script_review_rule())
                != resolution.script_review_rule()
        {
            return Err(ControlNodeResolutionError::GraphStateMismatch);
        }
        if let Some(rule) = resolution.script_review_rule() {
            let output_port = crate::run::control::script_review_output_port_with_evidence(
                rule,
                resolution.graph_run_id(),
                run.graph(),
                resolution.node_id(),
                resolution.fence(),
                &self.evidence,
            )?;
            if resolution.authority() != ControlAuthority::ScriptReview
                || resolution.outcome() != crate::AuthorizedGraphOutcome::Completed
                || resolution.output_port() != output_port
            {
                return Err(ControlNodeResolutionError::GraphStateMismatch);
            }
        }
        if resolution.authority() == ControlAuthority::Join {
            if resolution.outcome() != crate::AuthorizedGraphOutcome::Completed
                || resolution.output_port() != "joined"
            {
                return Err(ControlNodeResolutionError::GraphStateMismatch);
            }
            crate::run::control::require_join_ready(run.graph(), resolution.node_id())?;
        }
        require_control_output_port(run.graph(), resolution.node_id(), resolution.output_port())?;
        let event = resolution.graph_event();
        let run_id = resolution.graph_run_id().clone();
        self.touch_run(run_id.as_str());
        self.runs.get_mut(run_id.as_str()).expect("validated control run").graph
            .apply_event(event).map_err(|error| match error {
            crate::ReduceError::UnknownNode(node_id) => {
                ControlNodeResolutionError::UnknownNode(node_id)
            }
            crate::ReduceError::StaleFence { node_id } => {
                ControlNodeResolutionError::StaleFence { node_id }
            }
            crate::ReduceError::InvalidTransition { node_id, status } => {
                ControlNodeResolutionError::NodeNotAwaitingResolution { node_id, status }
            }
            _ => ControlNodeResolutionError::GraphStateMismatch,
        })?;
        let crate::run::control::ControlResolutionRecord::Recorded =
            self.control_resolutions.record(resolution)
        else {
            return Err(ControlNodeResolutionError::ConflictingResolution);
        };
        Ok(ControlNodeResolutionOutcome::Recorded)
    }

    pub(crate) fn register_delivery(
        &mut self,
        request: crate::DeliveryRequest,
    ) -> Result<crate::RegisterOutcome, crate::DeliveryRequestError> {
        self.deliveries.register(request)
    }

    pub(crate) fn register_activity(
        &mut self,
        request: ActivityRequest,
    ) -> Result<ActivityRegistrationOutcome, OrganizationFactsError> {
        validate_activity_request(&self.runs, &self.artifacts, &request)?;
        if self.activities.activity(&request.activity_id).is_none()
            && self.activities.activity_by_idempotency_key(
                request.run_id.as_str(),
                &request.idempotency_key,
            ).is_none()
        {
            let run = self.require_started_run(&request.run_id)?;
            if run.graph().is_rework_blocked(&request.node_id)
                || run.graph().current_attempt(&request.node_id).is_none_or(|attempt| attempt.fence() != &request.fence || attempt.status() != crate::AttemptStatus::Ready)
            {
                return Err(OrganizationFactsError::InvalidActivity);
            }
            run.graph().definition().validate_node_configuration().map_err(|_| OrganizationFactsError::InvalidActivity)?;
            validate_new_activity_prompt(&self.runs, &request, self.team_prompts())?;
        }
        self.activities
            .register(request)
            .map_err(|_| OrganizationFactsError::InvalidActivity)
    }

    pub(crate) fn claim_activity(
        &mut self,
        activity_id: &ActivityId,
        claimed_at: u64,
    ) -> Result<ActivityClaimOutcome, OrganizationFactsError> {
        let activity = self.activities.activity(activity_id)
            .ok_or(OrganizationFactsError::UnknownActivity)?;
        if matches!(activity.phase(), ActivityPhase::Pending | ActivityPhase::RetryScheduled { .. }) {
            let run = self.require_started_run(&activity.facts().run_id)?;
            if run.graph().is_rework_blocked(&activity.facts().node_id)
                || run.graph().current_attempt(&activity.facts().node_id)
                    .is_none_or(|attempt| attempt.fence() != &activity.facts().fence)
            {
                return Err(OrganizationFactsError::InvalidActivityTransition);
            }
        }
        let activity = self.activities.activity_mut(activity_id).expect("validated activity");
        Ok(crate::claim_activity(activity, claimed_at))
    }

    pub(crate) fn dispatch_activity(
        &mut self,
        claim: &ActivityClaim,
        dispatched_at: u64,
    ) -> Result<ActivityDispatchOutcome, OrganizationFactsError> {
        let activity = self
            .activities
            .activity_mut(claim.activity_id())
            .ok_or(OrganizationFactsError::UnknownActivity)?;
        crate::dispatch_activity(activity, claim, dispatched_at)
            .map_err(|_| OrganizationFactsError::InvalidActivityTransition)
    }

    pub(crate) fn settle_activity(
        &mut self,
        claim: &ActivityClaim,
        settlement: ActivitySettlement,
    ) -> Result<ActivitySettlementOutcome, ActivityTransitionError> {
        let activity = self.activities.activity_mut(claim.activity_id()).ok_or(
            ActivityTransitionError::CannotSettle {
                phase: ActivityPhase::Cancelled { cancelled_at: 0 },
            },
        )?;
        crate::settle_activity(activity, claim, settlement)
    }

    pub(crate) fn validate_native_confirmed_activity_claim(
        &self,
        activity: &Activity,
        claim: &ActivityClaim,
    ) -> Result<(), OrganizationFactsError> {
        validate_native_confirmed_activity_claim(&self.runs, &self.deliveries, activity, claim)
    }

    pub(crate) fn validate_agent_activity_settlement(
        &self,
        activity: &Activity,
        proof: &crate::run::activity::SettlementProof,
    ) -> Result<(), OrganizationFactsError> {
        validate_agent_activity_settlement(&self.runs, &self.deliveries, activity, proof)
    }

    pub(crate) fn record_agent_activity_settlement(
        &mut self,
        proof: crate::run::activity::SettlementProof,
    ) -> Result<(), OrganizationFactsError> {
        let activity = self
            .activities
            .activity(proof.claim.activity_id())
            .ok_or(OrganizationFactsError::UnknownActivity)?;
        validate_agent_activity_settlement(&self.runs, &self.deliveries, activity, &proof)?;
        if matches!(proof.receipt, crate::DeliveryReceipt::Rejected { .. })
            && let ActivityPhase::Failed { failed_at, .. } = activity.phase()
        {
            let request = activity.facts();
            let (run_id, node_id, fence, failed_at) = (
                request.run_id.clone(),
                request.node_id.clone(),
                request.fence.clone(),
                *failed_at,
            );
            self.touch_run(run_id.as_str());
            let run = self.runs.get_mut(run_id.as_str())
                .ok_or(OrganizationFactsError::UnknownActivityRun)?;
            if !run.execution_is_retired(&node_id, &fence) {
                let history = run.graph.executions().get(&node_id)
                    .ok_or(OrganizationFactsError::InvalidActivityTransition)?;
                let attempt = history.attempts().iter().find(|attempt| attempt.fence() == &fence)
                    .ok_or(OrganizationFactsError::InvalidActivityTransition)?;
                if attempt.status().accepts_outcome() {
                    let superseded = history.current().fence() != &fence;
                    let event = GraphEvent::NodeFailed {
                        node_id, fence, output_port: "failed".to_owned(), failed_at,
                    };
                    if superseded {
                        run.graph.settle_superseded(event)
                    } else {
                        run.graph.apply_event(event)
                    }.map_err(|_| OrganizationFactsError::InvalidActivityTransition)?;
                }
            }
        }
        let activity = self
            .activities
            .activity_mut(proof.claim.activity_id())
            .ok_or(OrganizationFactsError::UnknownActivity)?;
        if !activity.record_settlement_proof(proof) {
            return Err(OrganizationFactsError::InvalidActivityTransition);
        }
        Ok(())
    }

    pub(crate) fn claim_delivery(
        &mut self,
        delivery_id: &crate::DeliveryId,
        claimed_at: u64,
    ) -> Result<crate::DeliveryStart, crate::DeliveryReceiptError> {
        let delivery = self.deliveries.delivery_mut(delivery_id).ok_or_else(|| {
            crate::DeliveryReceiptError::DeliveryMismatch {
                delivery_id: delivery_id.clone(),
            }
        })?;
        Ok(crate::begin_delivery(delivery, claimed_at))
    }

    pub(crate) fn settle_delivery(
        &mut self,
        claim: &crate::DeliveryClaim,
        receipt: crate::DeliveryReceipt,
        retry_at: u64,
    ) -> Result<crate::DeliveryResolution, crate::DeliveryReceiptError> {
        let delivery = self
            .deliveries
            .delivery_mut(claim.delivery_id())
            .ok_or_else(|| crate::DeliveryReceiptError::DeliveryMismatch {
                delivery_id: claim.delivery_id().clone(),
            })?;
        crate::settle_delivery(delivery, claim, receipt, retry_at)
    }

    /// A persisted request may have reached the provider before a process stop, but it
    /// has no readback receipt yet. Conservatively retain the intent as unknown rather
    /// than allowing startup to issue the external effect again.
    pub(crate) fn recover_interrupted_materializations(&mut self) -> bool {
        let keys = self.materializations.iter()
            .filter(|(_, value)| value.groups.iter().any(|group| matches!(group, TeamMaterializationLifecycle::Requested(_))))
            .map(|(key, _)| key.clone()).collect::<Vec<_>>();
        for key in &keys {
            self.touch_materialization(key);
            let materialization = self.materializations.get_mut(key).expect("selected materialization");
            for lifecycle in &mut materialization.groups {
                if let TeamMaterializationLifecycle::Requested(request) = lifecycle {
                    *lifecycle = TeamMaterializationLifecycle::OutcomeUnknown(request.clone());
                }
            }
        }
        !keys.is_empty()
    }

    pub(crate) fn recover_interrupted_deliveries(&mut self, observed_at: u64) -> bool {
        let mut recovered = false;
        let ids = self.deliveries.deliveries()
            .filter(|delivery| matches!(delivery.phase(), crate::DeliveryPhase::Delivering(_)))
            .map(|delivery| delivery.facts().delivery_id.clone()).collect::<Vec<_>>();
        for id in ids {
            {
                let active = self
                    .deliveries
                    .delivery_mut(&id)
                    .expect("delivery ledger preserves its delivery identity index");
                let _ = crate::recover_interrupted_delivery(active, observed_at);
                recovered = true;
            }
        }
        recovered
    }

    pub(crate) fn recover_interrupted_activities(&mut self, observed_at: u64) -> bool {
        let mut recovered = false;
        let ids = self.activities.activities()
            .filter(|activity| activity.active_claim().is_some())
            .map(|activity| activity.facts().activity_id.clone()).collect::<Vec<_>>();
        for id in ids {
            {
                let active = self
                    .activities
                    .activity_mut(&id)
                    .expect("activity ledger preserves its activity identity index");
                if crate::recover_interrupted_activity(active, observed_at)
                    == ActivitySettlementOutcome::OutcomeUnknown
                {
                    recovered = true;
                }
            }
        }
        recovered
    }

    pub(crate) fn recover_interrupted_graph_run_cancellations(&mut self, observed_at: u64) -> bool {
        let ids = self.runs.iter()
            .filter(|(_, run)| matches!(run.lifecycle.state(), GraphRunLifecycleState::Cancelling { .. }))
            .map(|(id, _)| id.clone()).collect::<Vec<_>>();
        for id in &ids {
            self.touch_run(id);
            self.runs.get_mut(id).expect("selected run").lifecycle.recover_interrupted_cancellation(observed_at);
        }
        !ids.is_empty()
    }
}

fn current_node_event_target(
    graph: &GraphState,
    event: &crate::TeamNodeEvent,
) -> Option<(NodeId, crate::ExecutionFence, Option<String>)> {
    let attempt = graph
        .executions()
        .values()
        .map(crate::NodeExecutionHistory::current)
        .find(|attempt| {
            attempt.fence().node_execution_id().as_str() == event.node_execution_id().as_str()
        })?;
    let node = graph.definition().node(attempt.node_id())?;
    let role_id = node
        .work_assignment()
        .map(|assignment| assignment.role_id())
        .or_else(|| node.review_assignment().map(|assignment| assignment.role_id()));
    if event
        .role_id()
        .is_some_and(|role| role_id != Some(role.as_str()))
    {
        return None;
    }
    Some((
        node.id().clone(),
        attempt.fence().clone(),
        role_id.map(ToOwned::to_owned),
    ))
}

fn approval_action_name(action: crate::ApprovalAction) -> &'static str {
    match action {
        crate::ApprovalAction::ContinueNode => "continue_node",
        crate::ApprovalAction::ExecuteTool => "execute_tool",
        crate::ApprovalAction::PublishResult => "publish_result",
        crate::ApprovalAction::ExternalAction => "external_action",
    }
}

pub(super) fn validate_materialization(
    teams: &BTreeMap<String, TeamFacts>,
    team_id: &TeamId,
    materialization: &TeamMaterializationGroups,
) -> Result<(), OrganizationFactsError> {
    let team = teams.get(team_id.as_str()).ok_or(OrganizationFactsError::UnknownMaterializationTeam)?;
    validate_materialization_definition(team.definition(), materialization)
}

fn validate_materialization_definition(
    definition: &TeamDefinition,
    materialization: &TeamMaterializationGroups,
) -> Result<(), OrganizationFactsError> {
    if materialization.groups.is_empty() {
        return Err(OrganizationFactsError::InvalidMaterializationLifecycle);
    }
    let mut endpoints = BTreeSet::new();
    let mut roles = BTreeSet::new();
    let mut agents = BTreeSet::new();
    for group in &materialization.groups {
        if group.team() != Some(definition.team_id()) {
            return Err(OrganizationFactsError::UnknownMaterializationTeam);
        }
        if !endpoints.insert(group.endpoint()) {
            return Err(OrganizationFactsError::DuplicateMaterialization);
        }
        if let Some(request) = group.request() {
            for role in request.intent().agents() {
                if !roles.insert(role.role().as_str()) {
                    return Err(OrganizationFactsError::MaterializationReceiptDoesNotMatchIntent);
                }
                if let crate::RoleMaterializationAgent::External { agent } = role.agent()
                    && !agents.insert((group.endpoint(), agent)) {
                    return Err(OrganizationFactsError::MaterializationReceiptDoesNotMatchIntent);
                }
            }
        } else if let Some(receipt) = group.receipt() {
            for role in receipt.roles() {
                if !roles.insert(role.role().as_str()) || !agents.insert((role.endpoint(), role.agent())) {
                    return Err(OrganizationFactsError::MaterializationReceiptDoesNotMatchIntent);
                }
            }
        }
    }
    if roles.len() != definition.roles().len()
        || definition.roles().iter().any(|role| !roles.contains(role.role_id().as_str())) {
        return Err(OrganizationFactsError::MaterializationReceiptDoesNotMatchIntent);
    }
    if let Some(requests) = &materialization.requests {
        let mut requested_endpoints = BTreeSet::new();
        if requests.len() != materialization.groups.len() {
            return Err(OrganizationFactsError::MaterializationChanged);
        }
        for request in requests {
            let intent = request.intent();
            if intent.team() != definition.team_id()
                || !requested_endpoints.insert(intent.endpoint())
                || (requests.len() > 1 && intent.source() != crate::MaterializationSource::Manual) {
                return Err(OrganizationFactsError::MaterializationChanged);
            }
            let group = materialization.groups.iter().find(|group| group.endpoint() == intent.endpoint())
                .ok_or(OrganizationFactsError::MaterializationChanged)?;
            if group.request().is_some_and(|saved| saved != request)
                || group.receipt().is_some_and(|receipt| !materialization_matches_request(receipt, request)) {
                return Err(OrganizationFactsError::MaterializationReceiptDoesNotMatchIntent);
            }
        }
    }
    Ok(())
}

fn validate_template(
    team_facts: &BTreeMap<String, TeamFacts>,
    template: &WorkflowTemplateFacts,
) -> Result<(), OrganizationFactsError> {
    if !team_facts.contains_key(template.team().as_str()) {
        return Err(OrganizationFactsError::UnknownWorkflowTemplateTeam);
    }
    if template.source_identity().trim().is_empty() {
        return Err(OrganizationFactsError::InvalidWorkflowTemplate);
    }
    Ok(())
}

fn validate_team_workspaces(team_facts: &BTreeMap<String, TeamFacts>) -> Result<(), OrganizationFactsError> {
    let mut workspace_names = BTreeSet::new();
    for team in team_facts.values() {
        if let Some(name) = team.workspace_directory_name()
            && (!crate::run::workspace::valid_directory_name(name) || !workspace_names.insert(name.to_lowercase())) {
            return Err(OrganizationFactsError::InvalidTeamTransition);
        }
    }
    Ok(())
}

fn validate_restored_run(
    team_facts: &BTreeMap<String, TeamFacts>,
    run: &GraphRunFacts,
) -> Result<(), OrganizationFactsError> {
    if run.task_execution_context.as_ref().is_some_and(|context| {
        !context.valid() || context.root_request_id != run.lifecycle().creation_idempotency_key()
    }) {
        return Err(OrganizationFactsError::InvalidGraphRun);
    }
    run.validate_retired_executions(&run.retired_executions)?;
    let team = team_facts
        .get(run.team().as_str())
        .ok_or(OrganizationFactsError::UnknownRunTeam)?;
    OrganizationFacts::validate_run_workspace(run, team)?;
    if team.revision().get() < run.frozen_team_revision().get() {
        return Err(OrganizationFactsError::FrozenTeamRevisionMismatch);
    }
    Ok(())
}

fn validate_admission<'a>(
    team_facts: &BTreeMap<String, TeamFacts>,
    run_facts: &BTreeMap<String, GraphRunFacts>,
    mut pending_admissions: impl Iterator<Item = &'a PendingWorkflowPlanAdmission>,
    admission: &PendingWorkflowPlanAdmission,
) -> Result<(), OrganizationFactsError> {
    let team = team_facts
        .get(admission.team_id().as_str())
        .ok_or(OrganizationFactsError::UnknownWorkflowPlanAdmissionTeam)?;
    if team.tombstoned() || team.revision().get() < admission.team_revision().get() {
        return Err(OrganizationFactsError::InvalidWorkflowPlanAdmission);
    }
    if run_facts.contains_key(admission.run_id().as_str()) {
        return Err(OrganizationFactsError::WorkflowPlanAdmissionRunConflict);
    }
    if pending_admissions
        .any(|existing: &PendingWorkflowPlanAdmission| {
            existing.creation_idempotency_key() == admission.creation_idempotency_key()
                && existing != admission
        })
    {
        return Err(OrganizationFactsError::WorkflowPlanAdmissionIdempotencyConflict);
    }
    Ok(())
}

fn validate_artifact_provenance(
    runs: &BTreeMap<String, GraphRunFacts>,
    record: &ArtifactRecord,
) -> Result<(), OrganizationFactsError> {
    let run = runs
        .get(record.run_id())
        .ok_or(OrganizationFactsError::UnknownEvidenceRun)?;
    run.graph()
        .executions()
        .values()
        .flat_map(|history| history.attempts())
        .any(|attempt| attempt.fence() == record.fence())
        .then_some(())
        .or_else(|| {
            run.retired_executions
                .iter()
                .any(|(node, fence)| {
                    fence == record.fence() && run.retired_execution_has_attempt(node, fence)
                })
                .then_some(())
        })
        .ok_or(OrganizationFactsError::StaleEvidenceNodeExecution)
}

fn validate_current_artifact_provenance(
    runs: &BTreeMap<String, GraphRunFacts>,
    record: &ArtifactRecord,
) -> Result<(), OrganizationFactsError> {
    let run = runs
        .get(record.run_id())
        .ok_or(OrganizationFactsError::UnknownEvidenceRun)?;
    run.graph()
        .executions()
        .values()
        .any(|history| history.current().fence() == record.fence())
        .then_some(())
        .ok_or(OrganizationFactsError::StaleEvidenceNodeExecution)
}

fn validate_evidence_provenance(
    runs: &BTreeMap<String, GraphRunFacts>,
    record: &EvidenceRecord,
) -> Result<(), OrganizationFactsError> {
    let run = runs
        .get(record.run_id())
        .ok_or(OrganizationFactsError::UnknownEvidenceRun)?;
    run.graph()
        .executions()
        .values()
        .flat_map(|history| history.attempts())
        .any(|attempt| attempt.fence().node_execution_id().as_str() == record.node_execution_id())
        .then_some(())
        .or_else(|| {
            run.retired_executions
                .iter()
                .any(|(node, fence)| {
                    fence.node_execution_id().as_str() == record.node_execution_id()
                        && run.retired_execution_has_attempt(node, fence)
                })
                .then_some(())
        })
        .ok_or(OrganizationFactsError::StaleEvidenceNodeExecution)
}

fn validate_current_evidence_provenance(
    runs: &BTreeMap<String, GraphRunFacts>,
    record: &EvidenceRecord,
) -> Result<(), OrganizationFactsError> {
    let run = runs
        .get(record.run_id())
        .ok_or(OrganizationFactsError::UnknownEvidenceRun)?;
    run.graph()
        .executions()
        .values()
        .any(|history| {
            history.current().fence().node_execution_id().as_str() == record.node_execution_id()
        })
        .then_some(())
        .ok_or(OrganizationFactsError::StaleEvidenceNodeExecution)
}

fn evidence_replay_matches(existing: &EvidenceRecord, record: &EvidenceRecord) -> bool {
    existing.evidence_id() == record.evidence_id()
        && existing.run_id() == record.run_id()
        && existing.node_execution_id() == record.node_execution_id()
        && existing.reference() == record.reference()
}

fn validate_approval_resolution_events<'a>(
    approvals: &BTreeMap<String, Approval>,
    events: impl Iterator<Item = &'a crate::run::event::TeamEvent>,
) -> Result<(), OrganizationFactsError> {
    let mut resolution_counts = BTreeMap::new();
    for approval in approvals.values() {
        for resolution in approval.resolutions() {
            *resolution_counts
                .entry((
                    approval.facts().run_id.as_str(),
                    approval.facts().approval_id.as_str(),
                    approval_decision_tag(resolution.decision),
                    resolution.idempotency_key.as_str(),
                    resolution.resolved_at,
                ))
                .or_insert(0_usize) += 1;
        }
    }

    for event in events.filter(|event| {
        matches!(
            event.payload(),
            crate::run::event::TeamEventPayload::ApprovalResolved { .. }
        )
    }) {
        let crate::run::event::TeamEventPayload::ApprovalResolved {
            approval_id,
            decision,
            status,
        } = event.payload()
        else {
            unreachable!("approval resolution event filter preserves payload variant");
        };
        if *status != decision.status() {
            return Err(OrganizationFactsError::InvalidApprovalLedger);
        }
        let Some(count) = resolution_counts.get_mut(&(
            event.run_id(),
            approval_id.as_str(),
            approval_decision_tag(*decision),
            event.idempotency_key(),
            event.created_at(),
        )) else {
            return Err(OrganizationFactsError::InvalidApprovalLedger);
        };
        *count = count
            .checked_sub(1)
            .ok_or(OrganizationFactsError::InvalidApprovalLedger)?;
    }

    resolution_counts
        .values()
        .all(|count| *count == 0)
        .then_some(())
        .ok_or(OrganizationFactsError::InvalidApprovalLedger)
}

fn validate_approvals<'a>(
    runs: &BTreeMap<String, GraphRunFacts>,
    approvals: impl Iterator<Item = &'a Approval>,
    resolutions: &ControlResolutionLedger,
) -> Result<(), OrganizationFactsError> {
    for approval in approvals {
        let run = runs.get(&approval.facts().run_id)
            .ok_or(OrganizationFactsError::UnknownApprovalRun)?;
        validate_approval_resolutions(run, approval, approval.resolutions(), resolutions)?;
    }
    Ok(())
}

fn approval_decision_tag(decision: crate::ApprovalDecision) -> u8 {
    match decision {
        crate::ApprovalDecision::Approve => 0,
        crate::ApprovalDecision::Deny => 1,
        crate::ApprovalDecision::Abort => 2,
    }
}

fn require_control_output_port(
    graph: &GraphState,
    node_id: &NodeId,
    output_port: &str,
) -> Result<(), ControlNodeResolutionError> {
    let mut outgoing = graph.definition().outgoing_edges(node_id);
    match outgoing.next() {
        None => Ok(()),
        Some(first) if first.source_port() == output_port => Ok(()),
        Some(_) if outgoing.any(|edge| edge.source_port() == output_port) => Ok(()),
        Some(_) => Err(ControlNodeResolutionError::OutputPortDoesNotMatchEdge {
            node_id: node_id.clone(),
        }),
    }
}

fn validate_control_node_resolution(
    runs: &BTreeMap<String, GraphRunFacts>,
    resolution: &ControlNodeResolution,
) -> Result<(), OrganizationFactsError> {
    let run = runs
        .get(resolution.graph_run_id().as_str())
        .ok_or(OrganizationFactsError::InvalidControlNodeResolution)?;
    if run.run_id() != resolution.graph_run_id() {
        return Err(OrganizationFactsError::InvalidControlNodeResolution);
    }
    let expected_kind = match resolution.authority() {
        ControlAuthority::HumanDecision => crate::NodeKind::HumanDecision,
        ControlAuthority::ScriptReview => crate::NodeKind::ScriptReview,
        ControlAuthority::Join => crate::NodeKind::Join,
    };
    if run
        .graph()
        .definition()
        .node(resolution.node_id())
        .is_none_or(|node| node.kind() != expected_kind)
    {
        return Err(OrganizationFactsError::InvalidControlNodeResolution);
    }
    require_control_output_port(run.graph(), resolution.node_id(), resolution.output_port())
        .map_err(|_| OrganizationFactsError::InvalidControlNodeResolution)?;
    // Settled receipts attest past decisions; current rules and evidence cannot re-evaluate them.
    if resolution.authority() == ControlAuthority::ScriptReview
        && (resolution.script_review_rule().is_none()
            || resolution.outcome() != crate::AuthorizedGraphOutcome::Completed
            || !matches!(resolution.output_port(), "passed" | "failed"))
    {
        return Err(OrganizationFactsError::InvalidControlNodeResolution);
    }
    let attempt = run
        .graph()
        .executions()
        .get(resolution.node_id())
        .and_then(|history| {
            history
                .attempts()
                .iter()
                .find(|attempt| attempt.fence() == resolution.fence())
        })
        .ok_or(OrganizationFactsError::InvalidControlNodeResolution)?;
    let expected_status = match resolution.outcome() {
        crate::AuthorizedGraphOutcome::Completed => crate::AttemptStatus::Completed,
        crate::AuthorizedGraphOutcome::Failed => crate::AttemptStatus::Failed,
    };
    (attempt.status() == expected_status
        && attempt.output_port() == Some(resolution.output_port())
        && attempt.updated_at() == resolution.resolved_at())
    .then_some(())
    .ok_or(OrganizationFactsError::InvalidControlNodeResolution)
}

fn map_materialization_lifecycle_error(
    error: MaterializationLifecycleError,
) -> OrganizationFactsError {
    match error {
        MaterializationLifecycleError::InvalidTransition => {
            OrganizationFactsError::InvalidMaterializationLifecycle
        }
        MaterializationLifecycleError::OperationReceiptMismatch => {
            OrganizationFactsError::MaterializationOperationReceiptMismatch
        }
        MaterializationLifecycleError::ReceiptDoesNotMatchIntent => {
            OrganizationFactsError::MaterializationReceiptDoesNotMatchIntent
        }
    }
}

fn validate_runtime_receipt_alignment(
    run: &GraphRunFacts,
    receipt: &RunRuntimeReceipt,
    materialization: ConfirmedTeamMaterialization<'_>,
) -> Result<(), OrganizationFactsError> {
    if receipt.team_run() != run.run_id() {
        return Err(OrganizationFactsError::RuntimeRunMismatch);
    }
    for binding in receipt.bindings().iter().chain(run.role_session_intents.values().map(|intent| &intent.binding)) {
        if binding.team() != run.team() {
            return Err(OrganizationFactsError::RuntimeBindingTeamMismatch);
        }
        if !materialization.roles().any(|role| {
            role.role() == binding.role() && role.agent() == binding.agent() && role.endpoint() == binding.endpoint()
        }) {
            return Err(OrganizationFactsError::RuntimeRoleBindingSetMismatch);
        }
    }

    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OrganizationFactsError {
    DuplicateTeam,
    DuplicateMaterialization,
    UnknownMaterializationTeam,
    UnknownTeam,
    TeamTombstoned,
    InvalidMaterializationLifecycle,
    MaterializationOperationReceiptMismatch,
    MaterializationReceiptDoesNotMatchIntent,
    DuplicateRun,
    UnknownRunTeam,
    FrozenTeamRevisionMismatch,
    InvalidGraphRun,
    RuntimeRunMismatch,
    RuntimeRunMissing,
    RuntimeMaterializationMissing,
    RunMaterializationMissing,
    RuntimeTeamTombstoned,
    RuntimeMaterializationEndpointMismatch,
    RuntimeAlreadyInstalled,
    RuntimeRoleBindingSetMismatch,
    RuntimeBindingTeamMismatch,
    InvalidDeliveryLedger(crate::RestoreLedgerError),
    InvalidActivityLedger(crate::RestoreActivityLedgerError),
    InvalidTriggerLedger(RestoreTriggerLedgerError),
    InvalidControlResolutionLedger,
    InvalidDecisionLedger,
    InvalidArtifactLedger,
    InvalidControlNodeResolution,
    InvalidApprovalLedger,
    InvalidEvidenceLedger,
    ArtifactChanged,
    UnknownEvidenceRun,
    StaleEvidenceNodeExecution,
    ConflictingEvidenceId,
    EvidenceChanged,
    DuplicateApproval,
    UnknownApproval,
    UnknownApprovalRun,
    InvalidApprovalResolution,
    ConflictingApprovalResolution,
    InvalidEventLedger,
    UnknownEventRun,
    UnknownRun,
    InvalidGraphRunLifecycle,
    InvalidRunStartGate,
    UnknownDeliveryRun,
    UnknownActivityRun,
    UnknownActivity,
    InvalidActivity,
    InvalidActivityTarget,
    InvalidTerminalObservation,
    DuplicateAuthorizedGraphResolution,
    DuplicateMatchaTerminalCorrelation,
    RemovedTeam,
    InvalidTeamTransition,
    RemovedMaterialization,
    MaterializationChanged,
    RemovedRun,
    RunOwnershipChanged,
    RemovedDelivery,
    DeliveryIdentityChanged,
    InvalidDeliveryTransition,
    RemovedActivity,
    ActivityIdentityChanged,
    InvalidActivityTransition,
    InvalidTriggerRegistration,
    TriggerRegistrationChanged,
    ControlResolutionChanged,
    ApprovalChanged,
    EventLedgerChanged,
    InvalidTaskBoard,
    InvalidWorkflowTemplate,
    UnknownWorkflowTemplateTeam,
    DuplicateWorkflowTemplate,
    WorkflowTemplateChanged,
    InvalidWorkflowPlanAdmission,
    InvalidPurgedRunMarker,
    DuplicatePurgedRunMarker,
    UnknownWorkflowPlanAdmission,
    UnknownWorkflowPlanAdmissionTeam,
    DuplicateWorkflowPlanAdmission,
    WorkflowPlanAdmissionChanged,
    WorkflowPlanAdmissionTeamMismatch,
    WorkflowPlanAdmissionRevisionMismatch,
    WorkflowPlanAdmissionSourceMismatch,
    WorkflowPlanAdmissionMaterializationMissing,
    WorkflowPlanAdmissionRunConflict,
    WorkflowPlanAdmissionIdempotencyConflict,
}

fn validate_native_confirmed_activity_claim(
    runs: &BTreeMap<String, GraphRunFacts>,
    deliveries: &DeliveryLedger,
    activity: &Activity,
    claim: &ActivityClaim,
) -> Result<(), OrganizationFactsError> {
    let invalid = OrganizationFactsError::InvalidActivityTransition;
    let delivery_id = crate::DeliveryId::new(claim.activity_id().as_str())
        .map_err(|_| OrganizationFactsError::InvalidActivityTransition)?;
    let delivery = deliveries.delivery(&delivery_id)
        .ok_or(OrganizationFactsError::InvalidActivityTransition)?;
    let facts = activity.facts();
    let request = delivery.facts();
    let run = runs.get(facts.run_id.as_str())
        .ok_or(OrganizationFactsError::UnknownActivityRun)?;
    if claim.activity_id() != &facts.activity_id
        || claim.attempt() == 0
        || claim.attempt() > facts.max_attempts
        || claim.generation() != u64::from(claim.attempt())
        || claim.generation().checked_add(1) != Some(activity.next_claim_generation())
        || delivery.completed_attempts() != claim.attempt()
        || claim.generation().checked_add(1) != Some(delivery.next_claim_generation())
        || request.team_id != run.team().as_str()
        || request.run_id != facts.run_id.as_str()
        || request.node_id != facts.node_id.as_str()
        || request.node_execution_id != facts.fence.node_execution_id().as_str()
        || request.idempotency_key != facts.idempotency_key
        || request.max_attempts != facts.max_attempts
    {
        return Err(invalid);
    }
    let ActivityKind::AgentTask { task_id, role_id, session_ref, .. } = &facts.activity_kind else {
        return Err(invalid);
    };
    if request.task_id.as_str() != task_id
        || request.role_id.as_str() != role_id
        || request.session_ref.as_str() != session_ref
    {
        return Err(invalid);
    }
    let binding = run.runtime().and_then(|runtime| runtime.bindings().iter().find(|binding| {
        binding.role().as_str() == role_id && binding.session_ref().as_str() == session_ref
    })).ok_or(OrganizationFactsError::InvalidActivityTarget)?;
    let correlation = match delivery.phase() {
        DeliveryPhase::Delivered { accepted_at, native_correlation: Some(correlation), .. }
            if activity.active_claim() == Some(claim)
                && matches!(activity.phase(), ActivityPhase::Dispatched(_))
                && activity.completed_attempts() == claim.attempt() - 1
                && *accepted_at >= claim.claimed_at() => correlation,
        DeliveryPhase::TerminalObserved { observation }
            if activity.native_terminal_claim() == Some(claim)
                && activity.valid_native_terminal_claim()
                && observation.fence() == &facts.fence => {
            validate_terminal_observation(delivery, run, observation)?;
            let matching_phase = match (observation.resolution(), activity.phase()) {
                (
                    TerminalObservationResolution::AwaitingAuthorizedGraphResolution,
                    ActivityPhase::TerminalObserved { observed_at },
                ) => *observed_at == observation.observed_at(),
                (
                    TerminalObservationResolution::GraphResolved(resolution),
                    ActivityPhase::Completed { completed_at },
                ) => resolution.outcome() == crate::AuthorizedGraphOutcome::Completed
                    && *completed_at == resolution.resolved_at(),
                (
                    TerminalObservationResolution::GraphResolved(resolution),
                    ActivityPhase::Failed { failed_at, failure: crate::ActivityFailure::Rejected },
                ) => resolution.outcome() == crate::AuthorizedGraphOutcome::Failed
                    && *failed_at == resolution.resolved_at(),
                (
                    TerminalObservationResolution::NodeCancelled,
                    ActivityPhase::Cancelled { cancelled_at },
                ) => *cancelled_at == observation.observed_at(),
                _ => false,
            };
            if !matching_phase {
                return Err(invalid);
            }
            observation.correlation()
        }
        _ => return Err(invalid),
    };
    if correlation.endpoint_session_id() != binding.endpoint_session_id() {
        return Err(invalid);
    }
    Ok(())
}

fn validate_agent_activity_settlement(
    runs: &BTreeMap<String, GraphRunFacts>,
    deliveries: &DeliveryLedger,
    activity: &Activity,
    proof: &crate::run::activity::SettlementProof,
) -> Result<(), OrganizationFactsError> {
    let invalid = OrganizationFactsError::InvalidActivityTransition;
    if !proof.valid_for(activity) || !activity.valid_native_terminal_claim() {
        return Err(invalid);
    }
    let delivery_id = crate::DeliveryId::new(proof.claim.activity_id().as_str())
        .map_err(|_| OrganizationFactsError::InvalidActivityTransition)?;
    let delivery = deliveries
        .delivery(&delivery_id)
        .ok_or(OrganizationFactsError::InvalidActivityTransition)?;
    let request = delivery.facts();
    let facts = activity.facts();
    let claim = &proof.claim;
    if request.run_id != facts.run_id.as_str()
        || request.node_id != facts.node_id.as_str()
        || request.node_execution_id != facts.fence.node_execution_id().as_str()
        || request.idempotency_key != facts.idempotency_key
        || request.max_attempts != facts.max_attempts
        || delivery.completed_attempts() != claim.attempt()
        || claim.generation().checked_add(1) != Some(delivery.next_claim_generation())
    {
        return Err(invalid);
    }
    use crate::{DeliveryReceipt as R, DeliveryResolution as D};
    let matches = match (&proof.receipt, delivery.phase()) {
        (
            R::Accepted { receipt, native_correlation, accepted_at },
            DeliveryPhase::Delivered {
                receipt: stored,
                native_correlation: correlation,
                accepted_at: stored_at,
            },
        ) => receipt == stored && native_correlation == correlation && accepted_at == stored_at,
        (
            R::Accepted { receipt, native_correlation, .. },
            DeliveryPhase::TerminalObserved { observation },
        ) => {
            observation.delivered_receipt() == receipt
                && native_correlation.as_ref() == Some(observation.correlation())
                && observation.fence() == &facts.fence
        }
        (
            R::Rejected { failure, observed_at },
            DeliveryPhase::RetryScheduled { retry_at, failure: stored },
        ) => {
            failure == stored
                && proof.delivery_outcome == (D::RetryScheduled { retry_at: *retry_at })
                && *retry_at == crate::run::delivery::delivery_retry_at(*observed_at)
        }
        (
            R::Rejected { failure, observed_at },
            DeliveryPhase::Failed { failed_at, failure: stored },
        ) => failure == stored && observed_at == failed_at && proof.delivery_outcome == D::Failed,
        (R::Rejected { .. }, DeliveryPhase::Cancelled { cancelled_at }) => {
            matches!(proof.delivery_outcome, D::RetryScheduled { .. })
                && matches!(activity.phase(), ActivityPhase::Cancelled { cancelled_at: at } if at == cancelled_at)
        }
        (
            R::OutcomeUnknown { observed_at },
            DeliveryPhase::OutcomeUnknown { observed_at: stored },
        ) => observed_at == stored,
        // Runtime-native confirmation can advance an already committed unknown receipt.
        (
            R::OutcomeUnknown { observed_at },
            DeliveryPhase::Delivered { accepted_at, native_correlation: Some(correlation), .. },
        ) => {
            let binding = runs.get(facts.run_id.as_str()).and_then(|run| run.runtime())
                .and_then(|runtime| runtime.bindings().iter().find(|binding| {
                    binding.role().as_str() == request.role_id
                        && binding.session_ref().as_str() == request.session_ref
                }));
            *observed_at >= claim.claimed_at()
                && *accepted_at >= claim.claimed_at()
                && binding.is_some_and(|binding| binding.endpoint_session_id() == correlation.endpoint_session_id())
                && matches!(activity.phase(), ActivityPhase::OutcomeUnknown { observed_at: stored } if stored == observed_at)
        }
        (R::OutcomeUnknown { .. }, DeliveryPhase::TerminalObserved { observation }) => {
            let run = runs.get(facts.run_id.as_str()).ok_or(invalid.clone())?;
            let binding = run.runtime().and_then(|runtime| runtime.bindings().iter().find(|binding| {
                binding.role().as_str() == request.role_id
                    && binding.session_ref().as_str() == request.session_ref
            }));
            let matching_phase = match (observation.resolution(), activity.phase()) {
                (TerminalObservationResolution::AwaitingAuthorizedGraphResolution,
                    ActivityPhase::TerminalObserved { observed_at }) => *observed_at == observation.observed_at(),
                (TerminalObservationResolution::GraphResolved(resolution),
                    ActivityPhase::Completed { completed_at }) => resolution.outcome() == crate::AuthorizedGraphOutcome::Completed
                        && *completed_at == resolution.resolved_at(),
                (TerminalObservationResolution::GraphResolved(resolution),
                    ActivityPhase::Failed { failed_at, failure: crate::ActivityFailure::Rejected }) => resolution.outcome() == crate::AuthorizedGraphOutcome::Failed
                        && *failed_at == resolution.resolved_at(),
                (TerminalObservationResolution::NodeCancelled,
                    ActivityPhase::Cancelled { cancelled_at }) => *cancelled_at == observation.observed_at(),
                _ => false,
            };
            observation.fence() == &facts.fence
                && binding.is_some_and(|binding| binding.endpoint_session_id() == observation.correlation().endpoint_session_id())
                && matching_phase
                && validate_terminal_observation(delivery, run, observation).is_ok()
        }
        _ => false,
    };
    if matches {
        Ok(())
    } else {
        Err(invalid)
    }
}

fn validate_activity(
    runs: &BTreeMap<String, GraphRunFacts>,
    artifacts: &ArtifactLedger,
    activity: &Activity,
) -> Result<(), OrganizationFactsError> {
    validate_activity_request(runs, artifacts, activity.facts())
}

fn validate_activity_request(
    runs: &BTreeMap<String, GraphRunFacts>,
    artifacts: &ArtifactLedger,
    request: &ActivityRequest,
) -> Result<(), OrganizationFactsError> {
    request
        .validate()
        .map_err(|_| OrganizationFactsError::InvalidActivity)?;
    let run = runs
        .get(request.run_id.as_str())
        .ok_or(OrganizationFactsError::UnknownActivityRun)?;
    let node = run
        .graph()
        .definition()
        .node(&request.node_id)
        .ok_or(OrganizationFactsError::InvalidActivity)?;
    let history = run
        .graph()
        .executions()
        .get(&request.node_id)
        .ok_or(OrganizationFactsError::InvalidActivity)?;
    if (history
        .attempts()
        .iter()
        .all(|attempt| attempt.fence() != &request.fence)
        && !(run.execution_is_retired(&request.node_id, &request.fence)
            && run.retired_execution_has_attempt(&request.node_id, &request.fence)))
        || request.fence.node_execution_id() != &request.node_execution_id
    {
        return Err(OrganizationFactsError::InvalidActivity);
    }
    if request.input_artifact_ids.as_ref().is_some_and(|ids| {
        ids.iter().any(|id| artifacts.artifact(id)
            .is_none_or(|artifact| artifact.run_id() != request.run_id.as_str()))
    }) {
        return Err(OrganizationFactsError::InvalidActivity);
    }
    match (&request.activity_kind, node.kind()) {
        (
            ActivityKind::AgentTask {
                task_id,
                role_id,
                session_ref,
                ..
            },
            NodeKind::Work,
        ) => {
            let work = node
                .work_assignment()
                .ok_or(OrganizationFactsError::InvalidActivity)?;
            if work.task_id() != task_id
                || work.role_id() != role_id
                || work.session_ref().as_str() != session_ref
            {
                return Err(OrganizationFactsError::InvalidActivity);
            }
            validate_activity_target(run, role_id, session_ref, &request.target)
        }
        (
            ActivityKind::AgentTask {
                role_id,
                session_ref,
                ..
            },
            NodeKind::Review,
        ) => {
            let review = node
                .review_assignment()
                .ok_or(OrganizationFactsError::InvalidActivity)?;
            if review.role_id() != role_id
                || review.session_ref().as_str() != session_ref
            {
                return Err(OrganizationFactsError::InvalidActivity);
            }
            validate_activity_target(run, role_id, session_ref, &request.target)
        }
        (ActivityKind::Control { .. }, NodeKind::Start | NodeKind::Join | NodeKind::End) => Ok(()),
        _ => Err(OrganizationFactsError::InvalidActivity),
    }
}

fn validate_new_activity_prompt(
    runs: &BTreeMap<String, GraphRunFacts>,
    request: &ActivityRequest,
    prompts: &crate::prompts::TeamPromptSettings,
) -> Result<(), OrganizationFactsError> {
    let ActivityKind::AgentTask { prompt, .. } = &request.activity_kind else {
        return Ok(());
    };
    let run = runs
        .get(request.run_id.as_str())
        .ok_or(OrganizationFactsError::UnknownActivityRun)?;
    let node = run.graph().definition().node(&request.node_id)
        .ok_or(OrganizationFactsError::InvalidActivity)?;
    let base_prompt = node.work_assignment().map(|work| work.prompt())
        .or_else(|| node.review_assignment().map(|review| review.prompt()))
        .ok_or(OrganizationFactsError::InvalidActivity)?;
    let mut raw_request = request.clone();
    if let ActivityKind::AgentTask { prompt, .. } = &mut raw_request.activity_kind {
        *prompt = base_prompt.to_owned();
    }
    let (prefix, suffix) = crate::run::scheduler::agent_task_prompt_parts(
        run.team(), node, &raw_request, prompts,
    ).ok_or(OrganizationFactsError::InvalidActivity)?;
    let upstream = prompt.strip_prefix(&prefix).and_then(|rest| rest.strip_suffix(&suffix));
    if upstream.is_some_and(|context| {
        context.is_empty() || (context.starts_with("\n\n<teamrun_upstream_context>\n")
            && context.ends_with("\n</teamrun_upstream_context>"))
    })
    {
        Ok(())
    } else {
        Err(OrganizationFactsError::InvalidActivity)
    }
}

fn validate_activity_target(
    run: &GraphRunFacts,
    role_id: &str,
    session_ref: &str,
    target: &ActivityTarget,
) -> Result<(), OrganizationFactsError> {
    let role = crate::RoleId::try_new(role_id.to_owned())
        .map_err(|_| OrganizationFactsError::InvalidActivity)?;
    let session_ref = crate::RoleSessionRef::try_new(session_ref.to_owned())
        .map_err(|_| OrganizationFactsError::InvalidActivity)?;
    let binding =
        run.runtime()
            .and_then(|runtime| {
                runtime.bindings().iter().find(|binding| {
                    binding.role() == &role && binding.session_ref() == &session_ref
                })
            })
            .ok_or(OrganizationFactsError::InvalidActivityTarget)?;
    if binding.session_ref().as_str() != target.as_str() {
        return Err(OrganizationFactsError::InvalidActivityTarget);
    }
    Ok(())
}

fn validate_trigger_registration(
    runs: &BTreeMap<String, GraphRunFacts>,
    request: &TriggerFireRequest,
) -> Result<(), OrganizationFactsError> {
    let run = runs
        .get(&request.run_id)
        .ok_or(OrganizationFactsError::InvalidTriggerRegistration)?;
    let node = run
        .graph()
        .definition()
        .node(&NodeId::new(request.start_node_id.clone()))
        .ok_or(OrganizationFactsError::InvalidTriggerRegistration)?;
    source_matches_trigger(request.source, node.trigger())
        .then_some(())
        .ok_or(OrganizationFactsError::InvalidTriggerRegistration)
}

fn source_matches_trigger(
    source: crate::TriggerSource,
    trigger: Option<&crate::StartTrigger>,
) -> bool {
    matches!(
        (source, trigger),
        (
            crate::TriggerSource::Cron,
            Some(crate::StartTrigger::Cron { .. })
        ) | (
            crate::TriggerSource::Webhook,
            Some(crate::StartTrigger::Webhook { .. })
        )
    )
}

fn validate_activity_transition(
    previous: &Activity,
    current: &Activity,
) -> Result<(), OrganizationFactsError> {
    match (previous.phase(), current.phase()) {
        (ActivityPhase::Pending, _) => Ok(()),
        (ActivityPhase::Claimed(_), ActivityPhase::Claimed(_))
        | (ActivityPhase::Claimed(_), ActivityPhase::Dispatched(_))
        | (ActivityPhase::Claimed(_), ActivityPhase::OutcomeUnknown { .. })
        | (ActivityPhase::Claimed(_), ActivityPhase::Cancelled { .. }) => Ok(()),
        (ActivityPhase::Dispatched(_), ActivityPhase::Dispatched(_))
        | (ActivityPhase::Dispatched(_), ActivityPhase::RetryScheduled { .. })
        | (ActivityPhase::Dispatched(_), ActivityPhase::TerminalObserved { .. })
        | (ActivityPhase::Dispatched(_), ActivityPhase::Completed { .. })
        | (ActivityPhase::Dispatched(_), ActivityPhase::Failed { .. })
        | (ActivityPhase::Dispatched(_), ActivityPhase::OutcomeUnknown { .. })
        | (ActivityPhase::Dispatched(_), ActivityPhase::Cancelled { .. }) => Ok(()),
        (ActivityPhase::RetryScheduled { retry_at, .. }, ActivityPhase::Dispatched(dispatch))
            if previous.completed_attempts() == current.completed_attempts()
                && dispatch.claim().generation() == previous.next_claim_generation()
                && dispatch.claim().claimed_at() >= *retry_at
                && dispatch.dispatched_at() == dispatch.claim().claimed_at()
                && current.settlement_proof().is_none()
                && current.validate_restored().is_ok() => Ok(()),
        (ActivityPhase::RetryScheduled { .. }, ActivityPhase::RetryScheduled { .. })
        | (ActivityPhase::RetryScheduled { .. }, ActivityPhase::Claimed(_))
        | (ActivityPhase::RetryScheduled { .. }, ActivityPhase::Cancelled { .. }) => Ok(()),
        (ActivityPhase::TerminalObserved { .. }, ActivityPhase::TerminalObserved { .. })
        | (ActivityPhase::TerminalObserved { .. }, ActivityPhase::Completed { .. })
        | (ActivityPhase::TerminalObserved { .. }, ActivityPhase::Failed { .. }) => Ok(()),
        (ActivityPhase::Completed { .. }, ActivityPhase::Completed { .. }) => Ok(()),
        (ActivityPhase::Failed { .. }, ActivityPhase::Failed { .. }) => Ok(()),
        (ActivityPhase::OutcomeUnknown { .. }, ActivityPhase::OutcomeUnknown { .. })
        | (ActivityPhase::OutcomeUnknown { .. }, ActivityPhase::TerminalObserved { .. })
        | (ActivityPhase::OutcomeUnknown { .. }, ActivityPhase::Completed { .. })
        | (ActivityPhase::OutcomeUnknown { .. }, ActivityPhase::Failed { .. })
        | (ActivityPhase::OutcomeUnknown { .. }, ActivityPhase::Cancelled { .. }) => Ok(()),
        (ActivityPhase::Cancelled { .. }, ActivityPhase::Cancelled { .. }) => Ok(()),
        _ => Err(OrganizationFactsError::InvalidActivityTransition),
    }
}

fn validate_delivery_transition(
    previous: &crate::Delivery,
    current: &crate::Delivery,
) -> Result<(), OrganizationFactsError> {
    if let Some(old) = previous.task_native_execution() {
        let Some(native) = current.task_native_execution() else {
            return Err(OrganizationFactsError::InvalidDeliveryTransition);
        };
        if old.endpoint_session_id != native.endpoint_session_id || old.native_run_id != native.native_run_id
            || old.native_request_id != native.native_request_id || old.native_message_id != native.native_message_id
            || (old.measurement != native.measurement && !matches!(old.measurement, crate::TaskRunMeasurement::Unavailable))
        { return Err(OrganizationFactsError::InvalidDeliveryTransition); }
    }
    match (previous.phase(), current.phase()) {
        (
            DeliveryPhase::TerminalObserved {
                observation: previous,
            },
            DeliveryPhase::TerminalObserved {
                observation: current,
            },
        ) if previous.matches_native_fact(current) => {
            match (previous.resolution(), current.resolution()) {
                (
                    TerminalObservationResolution::AwaitingAuthorizedGraphResolution,
                    TerminalObservationResolution::AwaitingAuthorizedGraphResolution,
                ) => Ok(()),
                (
                    TerminalObservationResolution::NodeCancelled,
                    TerminalObservationResolution::NodeCancelled,
                ) => Ok(()),
                (
                    TerminalObservationResolution::GraphResolved(previous),
                    TerminalObservationResolution::GraphResolved(current),
                ) if previous == current => Ok(()),
                (
                    TerminalObservationResolution::AwaitingAuthorizedGraphResolution,
                    TerminalObservationResolution::GraphResolved(_),
                ) => Ok(()),
                _ => Err(OrganizationFactsError::InvalidDeliveryTransition),
            }
        }
        (DeliveryPhase::TerminalObserved { .. }, _) => {
            Err(OrganizationFactsError::InvalidDeliveryTransition)
        }
        _ => Ok(()),
    }
}

fn validate_terminal_observation(
    delivery: &crate::Delivery,
    run: &GraphRunFacts,
    observation: &TerminalObservation,
) -> Result<(), OrganizationFactsError> {
    let facts = delivery.facts();
    if observation.delivery_id() != &facts.delivery_id
        || observation.graph_run_id() != facts.run_id
        || observation.node_id() != facts.node_id
        || observation.fence().node_execution_id().as_str() != facts.node_execution_id
        || observation.role_id() != facts.role_id
    {
        return Err(OrganizationFactsError::InvalidTerminalObservation);
    }
    match (observation.native_terminal(), observation.resolution()) {
        (
            NativeTerminalStatus::Completed
            | NativeTerminalStatus::Failed
            | NativeTerminalStatus::Interrupted,
            TerminalObservationResolution::AwaitingAuthorizedGraphResolution
            | TerminalObservationResolution::GraphResolved(_),
        )
        | (NativeTerminalStatus::Cancelled, TerminalObservationResolution::NodeCancelled) => {}
        _ => return Err(OrganizationFactsError::InvalidTerminalObservation),
    }
    if !crate::run::delivery::terminal_observation_matches_graph(run.graph(), observation)
        || matches!(observation.resolution(), TerminalObservationResolution::GraphResolved(resolution)
            if observation.output().is_some_and(|output| output.decision() != resolution.output_port()))
    {
        return Err(OrganizationFactsError::InvalidTerminalObservation);
    }
    Ok(())
}

impl fmt::Display for OrganizationFactsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("organization durable facts violate domain invariants")
    }
}

impl std::error::Error for OrganizationFactsError {}

impl GraphRunFacts {
    pub(crate) fn durable_snapshot(&self) -> GraphDurableSnapshot {
        self.graph.durable_snapshot()
    }
}
