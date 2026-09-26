use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
};

use crate::{
    Activity, ActivityClaim, ActivityClaimOutcome, ActivityDispatchOutcome, ActivityId,
    ActivityKind, ActivityLedger, ActivityLedgerSnapshot, ActivityPhase,
    ActivityRegistrationOutcome, ActivityRequest, ActivitySettlement, ActivitySettlementOutcome,
    ActivityTarget, ActivityTransitionError, AgentNodeEventResolution,
    AgentNodeEventResolutionError, Approval, ControlAuthority, ControlNodeResolution,
    ControlNodeResolutionError, ControlNodeResolutionOutcome, DeliveryLedger,
    DeliveryLedgerSnapshot, DeliveryPhase, GraphDefinition, GraphRunId, GraphState, IdempotencyKey,
    MaterializationLifecycleError, MaterializationOperationOutcome, MaterializationReceipt,
    MaterializationRecordOutcome, NodeKind, RunRuntimeReceipt, TeamDefinition, TeamId,
    TeamMaterializationLifecycle, TeamMaterializationRequest, TeamRevision,
    run::artifact::{
        ArtifactEvidenceProvenance, ArtifactLedger, ArtifactRecord, ArtifactRecordOutcome,
        CompletionMetadata, build_graph_completion_artifact,
    },
    run::{
        approval::{ApprovalDurableSnapshot, HumanDecisionCommand, HumanDecisionOutcome},
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
        graph::{GraphDurableSnapshot, GraphEvent, NodeId, reduce},
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
pub struct TeamFacts {
    definition: TeamDefinition,
    revision: TeamRevision,
    tombstoned: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamTombstoneOutcome {
    Tombstoned,
    Replayed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApprovalResolutionOutcome {
    Recorded,
    Replayed,
}

#[derive(Clone, Eq, PartialEq)]
pub struct PendingWorkflowPlanAdmission {
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
pub enum WorkflowPlanAdmissionOutcome {
    Recorded(PendingWorkflowPlanAdmission),
    Replayed(PendingWorkflowPlanAdmission),
    AlreadySubmitted(GraphRunId),
    ConflictingRun,
    ConflictingIdempotency,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkflowPlanSubmitOutcome {
    Submitted(GraphRunId),
    Replayed(GraphRunId),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RunStartGate {
    Intake,
    ProposalPending {
        proposal_id: String,
        summary: String,
        source_delivery_id: String,
    },
    Started,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SetRunStartProposalOutcome {
    Recorded,
    Replayed,
    AlreadyStarted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConfirmRunStartOutcome {
    Started,
    Replayed,
    Intake,
    ProposalMismatch,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContinueRunDiscussionOutcome {
    Intake,
    Replayed,
    AlreadyStarted,
    ProposalMismatch,
}

impl RunStartGate {
    pub fn proposal_id(&self) -> Option<&str> {
        match self {
            Self::ProposalPending { proposal_id, .. } => Some(proposal_id),
            Self::Intake | Self::Started => None,
        }
    }

    pub fn summary(&self) -> Option<&str> {
        match self {
            Self::ProposalPending { summary, .. } => Some(summary),
            Self::Intake | Self::Started => None,
        }
    }

    pub fn source_delivery_id(&self) -> Option<&str> {
        match self {
            Self::ProposalPending {
                source_delivery_id, ..
            } => Some(source_delivery_id),
            Self::Intake | Self::Started => None,
        }
    }

    pub(crate) fn proposal_pending(
        proposal_id: String,
        summary: String,
        source_delivery_id: String,
    ) -> Result<Self, ()> {
        if proposal_id.trim().is_empty()
            || summary.trim().is_empty()
            || source_delivery_id.trim().is_empty()
        {
            return Err(());
        }
        Ok(Self::ProposalPending {
            proposal_id,
            summary,
            source_delivery_id,
        })
    }

    fn set_proposal(
        &mut self,
        proposal_id: String,
        summary: String,
        source_delivery_id: String,
    ) -> Result<SetRunStartProposalOutcome, ()> {
        let next = Self::proposal_pending(proposal_id, summary, source_delivery_id)?;
        match self {
            Self::Started => Ok(SetRunStartProposalOutcome::AlreadyStarted),
            current if *current == next => Ok(SetRunStartProposalOutcome::Replayed),
            current => {
                *current = next;
                Ok(SetRunStartProposalOutcome::Recorded)
            }
        }
    }

    fn confirm_start(&mut self, proposal_id: &str) -> Result<ConfirmRunStartOutcome, ()> {
        if proposal_id.trim().is_empty() {
            return Err(());
        }
        match self {
            Self::ProposalPending {
                proposal_id: existing,
                ..
            } if existing == proposal_id => {
                *self = Self::Started;
                Ok(ConfirmRunStartOutcome::Started)
            }
            Self::ProposalPending { .. } => Ok(ConfirmRunStartOutcome::ProposalMismatch),
            Self::Intake => Ok(ConfirmRunStartOutcome::Intake),
            Self::Started => Ok(ConfirmRunStartOutcome::Replayed),
        }
    }

    fn continue_discussion(
        &mut self,
        proposal_id: &str,
    ) -> Result<ContinueRunDiscussionOutcome, ()> {
        if proposal_id.trim().is_empty() {
            return Err(());
        }
        match self {
            Self::ProposalPending {
                proposal_id: existing,
                ..
            } if existing == proposal_id => {
                *self = Self::Intake;
                Ok(ContinueRunDiscussionOutcome::Intake)
            }
            Self::ProposalPending { .. } => Ok(ContinueRunDiscussionOutcome::ProposalMismatch),
            Self::Intake => Ok(ContinueRunDiscussionOutcome::Replayed),
            Self::Started => Ok(ContinueRunDiscussionOutcome::AlreadyStarted),
        }
    }

    fn can_transition_from(&self, previous: &Self) -> bool {
        matches!(
            (previous, self),
            (Self::Intake, Self::Intake | Self::ProposalPending { .. })
                | (
                    Self::ProposalPending { .. },
                    Self::Intake | Self::ProposalPending { .. } | Self::Started,
                )
                | (Self::Started, Self::Started)
        )
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct WorkflowTemplateFacts {
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
            .field("group_count", &self.plan.groups().len())
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

pub struct TeamRunFactsRestoreInput {
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

pub(crate) struct MaterializationLifecycleFactsRestoreInput {
    pub(crate) teams: Vec<TeamFacts>,
    pub(crate) materializations: Vec<(TeamId, TeamMaterializationLifecycle)>,
    pub(crate) runs: Vec<GraphRunFacts>,
    pub(crate) pending_workflow_plan_admissions: Vec<PendingWorkflowPlanAdmission>,
    pub(crate) templates: Vec<WorkflowTemplateFacts>,
    pub(crate) deliveries: DeliveryLedgerSnapshot,
    pub(crate) activities: ActivityLedgerSnapshot,
    pub(crate) triggers: Vec<TriggerFireRequest>,
    pub(crate) control_resolutions: Vec<ControlNodeResolution>,
    pub(crate) approvals: Vec<ApprovalDurableSnapshot>,
    pub(crate) events: EventLedgerSnapshot,
    pub(crate) evidence: Vec<EvidenceRecord>,
}

pub struct ApprovalResolutionInput {
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
        }
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
pub struct GraphRunFacts {
    team: TeamId,
    frozen_team_revision: TeamRevision,
    graph: GraphState,
    runtime: Option<RunRuntimeReceipt>,
    lifecycle: GraphRunLifecycle,
    start_gate: RunStartGate,
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
            lifecycle,
            start_gate,
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
pub struct OrganizationFacts {
    teams: BTreeMap<String, TeamFacts>,
    materializations: BTreeMap<String, TeamMaterializationLifecycle>,
    runs: BTreeMap<String, GraphRunFacts>,
    deliveries: DeliveryLedger,
    activities: ActivityLedger,
    triggers: TriggerLedger,
    control_resolutions: ControlResolutionLedger,
    approvals: BTreeMap<String, Approval>,
    events: EventLedger,
    evidence: EvidenceLedger,
    artifacts: ArtifactLedger,
    decisions: TeamDecisionLedger,
    templates: BTreeMap<String, WorkflowTemplateFacts>,
    pending_workflow_plan_admissions: BTreeMap<String, PendingWorkflowPlanAdmission>,
    task_board: crate::run::TaskBoardFacts,
    purged_runs: BTreeMap<String, PurgedRunMarker>,
}

impl OrganizationFacts {
    pub fn restore(
        teams: impl IntoIterator<Item = TeamFacts>,
        materializations: impl IntoIterator<Item = MaterializationReceipt>,
        runs: impl IntoIterator<Item = GraphRunFacts>,
        deliveries: DeliveryLedgerSnapshot,
    ) -> Result<Self, OrganizationFactsError> {
        Self::restore_with_triggers(teams, materializations, runs, deliveries, [])
    }

    pub(crate) fn restore_with_triggers(
        teams: impl IntoIterator<Item = TeamFacts>,
        materializations: impl IntoIterator<Item = MaterializationReceipt>,
        runs: impl IntoIterator<Item = GraphRunFacts>,
        deliveries: DeliveryLedgerSnapshot,
        triggers: impl IntoIterator<Item = TriggerFireRequest>,
    ) -> Result<Self, OrganizationFactsError> {
        Self::restore_with_triggers_and_control_resolutions(
            teams,
            materializations,
            runs,
            deliveries,
            triggers,
            [],
        )
    }

    pub(crate) fn restore_with_triggers_and_control_resolutions(
        teams: impl IntoIterator<Item = TeamFacts>,
        materializations: impl IntoIterator<Item = MaterializationReceipt>,
        runs: impl IntoIterator<Item = GraphRunFacts>,
        deliveries: DeliveryLedgerSnapshot,
        triggers: impl IntoIterator<Item = TriggerFireRequest>,
        control_resolutions: impl IntoIterator<Item = ControlNodeResolution>,
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
            control_resolutions: control_resolutions.into_iter().collect(),
            approvals: Vec::new(),
            events: EventLedgerSnapshot::default(),
            evidence: Vec::new(),
        })
    }

    pub(crate) fn restore_with_teamrun_ledgers(
        input: TeamRunFactsRestoreInput,
    ) -> Result<Self, OrganizationFactsError> {
        let TeamRunFactsRestoreInput {
            teams,
            materializations,
            runs,
            pending_workflow_plan_admissions,
            deliveries,
            activities,
            triggers,
            control_resolutions,
            approvals,
            events,
            evidence,
            templates,
        } = input;
        Self::restore_with_materialization_lifecycles_and_decisions_and_artifacts(
            MaterializationLifecycleFactsRestoreInput {
                teams,
                materializations: materializations
                    .into_iter()
                    .map(|receipt| {
                        let team = receipt.team().clone();
                        (team, TeamMaterializationLifecycle::Confirmed(receipt))
                    })
                    .collect(),
                runs,
                pending_workflow_plan_admissions,
                templates,
                deliveries,
                activities,
                triggers,
                control_resolutions,
                approvals,
                events,
                evidence,
            },
            crate::TeamDecisionLedgerSnapshot {
                decisions: Vec::new(),
                events: Vec::new(),
            },
            [],
        )
    }

    pub(crate) fn restore_with_materialization_lifecycles_and_decisions_and_artifacts(
        input: MaterializationLifecycleFactsRestoreInput,
        decision_snapshot: crate::TeamDecisionLedgerSnapshot,
        artifact_records: impl IntoIterator<Item = ArtifactRecord>,
    ) -> Result<Self, OrganizationFactsError> {
        Self::restore_with_materialization_lifecycles_and_decisions_and_artifacts_and_task_board(
            input,
            decision_snapshot,
            artifact_records,
            crate::run::TaskBoardFacts::default(),
        )
    }

    pub(crate) fn restore_with_materialization_lifecycles_and_decisions_and_artifacts_and_task_board(
        input: MaterializationLifecycleFactsRestoreInput,
        decision_snapshot: crate::TeamDecisionLedgerSnapshot,
        artifact_records: impl IntoIterator<Item = ArtifactRecord>,
        task_board: crate::run::TaskBoardFacts,
    ) -> Result<Self, OrganizationFactsError> {
        Self::restore_with_materialization_lifecycles_and_decisions_and_artifacts_and_task_board_and_purged_runs(
            input,
            decision_snapshot,
            artifact_records,
            task_board,
            [],
        )
    }

    pub(crate) fn restore_with_materialization_lifecycles_and_decisions_and_artifacts_and_task_board_and_purged_runs(
        input: MaterializationLifecycleFactsRestoreInput,
        decision_snapshot: crate::TeamDecisionLedgerSnapshot,
        artifact_records: impl IntoIterator<Item = ArtifactRecord>,
        task_board: crate::run::TaskBoardFacts,
        purged_runs: impl IntoIterator<Item = PurgedRunMarker>,
    ) -> Result<Self, OrganizationFactsError> {
        let MaterializationLifecycleFactsRestoreInput {
            teams,
            materializations,
            runs,
            pending_workflow_plan_admissions,
            deliveries,
            activities,
            triggers,
            control_resolutions,
            approvals,
            events,
            evidence,
            templates,
        } = input;
        let mut team_facts = BTreeMap::new();
        for team in teams {
            if team_facts
                .insert(team.team_id().as_str().to_owned(), team)
                .is_some()
            {
                return Err(OrganizationFactsError::DuplicateTeam);
            }
        }

        let mut materialization_facts = BTreeMap::new();
        for (team_id, lifecycle) in materializations {
            let team = team_id.as_str().to_owned();
            if lifecycle.team() != Some(&team_id) || !team_facts.contains_key(&team) {
                return Err(OrganizationFactsError::UnknownMaterializationTeam);
            }
            if materialization_facts.insert(team, lifecycle).is_some() {
                return Err(OrganizationFactsError::DuplicateMaterialization);
            }
        }

        let mut template_facts = BTreeMap::new();
        for template in templates {
            let team = team_facts
                .get(template.team().as_str())
                .ok_or(OrganizationFactsError::UnknownWorkflowTemplateTeam)?;
            if team.tombstoned() || template.source_identity().trim().is_empty() {
                return Err(OrganizationFactsError::InvalidWorkflowTemplate);
            }
            if template_facts
                .insert(template.team().as_str().to_owned(), template)
                .is_some()
            {
                return Err(OrganizationFactsError::DuplicateWorkflowTemplate);
            }
        }

        let mut run_facts = BTreeMap::new();
        for run in runs {
            let team = team_facts
                .get(run.team().as_str())
                .ok_or(OrganizationFactsError::UnknownRunTeam)?;
            if team.revision().get() < run.frozen_team_revision().get() {
                return Err(OrganizationFactsError::FrozenTeamRevisionMismatch);
            }
            if run_facts
                .insert(run.run_id().as_str().to_owned(), run)
                .is_some()
            {
                return Err(OrganizationFactsError::DuplicateRun);
            }
        }
        let mut purged_run_facts = BTreeMap::new();
        for marker in purged_runs {
            if run_facts.contains_key(marker.run_id().as_str())
                || purged_run_facts
                    .insert(marker.run_id().as_str().to_owned(), marker)
                    .is_some()
            {
                return Err(OrganizationFactsError::DuplicatePurgedRunMarker);
            }
        }

        let mut pending_admissions = BTreeMap::new();
        for admission in pending_workflow_plan_admissions {
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
                .values()
                .any(|existing: &PendingWorkflowPlanAdmission| {
                    existing.creation_idempotency_key() == admission.creation_idempotency_key()
                        && existing != &admission
                })
            {
                return Err(OrganizationFactsError::WorkflowPlanAdmissionIdempotencyConflict);
            }
            if pending_admissions
                .insert(admission.run_id().as_str().to_owned(), admission)
                .is_some()
            {
                return Err(OrganizationFactsError::DuplicateWorkflowPlanAdmission);
            }
        }

        for run in run_facts.values() {
            if let Some(receipt) = run.runtime() {
                let team = team_facts
                    .get(run.team().as_str())
                    .expect("run team was validated before runtime receipt alignment");
                let materialization = materialization_facts
                    .get(run.team().as_str())
                    .and_then(TeamMaterializationLifecycle::receipt)
                    .ok_or(OrganizationFactsError::RuntimeMaterializationMissing)?;
                validate_runtime_receipt_alignment(team, run, receipt, materialization)?;
            }
        }

        let deliveries = DeliveryLedger::restore(deliveries)
            .map_err(OrganizationFactsError::InvalidDeliveryLedger)?;
        let activities = ActivityLedger::restore(activities)
            .map_err(OrganizationFactsError::InvalidActivityLedger)?;
        for activity in activities.activities() {
            validate_activity(&run_facts, activity)?;
        }
        let triggers = TriggerLedger::restore(triggers)
            .map_err(OrganizationFactsError::InvalidTriggerLedger)?;
        for request in triggers.requests() {
            validate_trigger_registration(&run_facts, request)?;
        }
        let mut trigger_counts = BTreeMap::new();
        for request in triggers.requests() {
            *trigger_counts
                .entry((request.run_id.clone(), request.start_node_id.clone()))
                .or_insert(0_usize) += 1;
        }
        for ((run_id, start_node_id), count) in &trigger_counts {
            let run = run_facts
                .get(run_id)
                .expect("trigger registration run was just validated");
            let history = run
                .graph()
                .executions()
                .get(&NodeId::new(start_node_id.clone()))
                .expect("trigger registration node belongs to the graph");
            if history
                .attempts()
                .iter()
                .filter(|attempt| matches!(attempt.reason(), crate::AttemptReason::Trigger))
                .count()
                != *count
            {
                return Err(OrganizationFactsError::InvalidTriggerRegistration);
            }
        }
        for (run_id, run) in &run_facts {
            for node in run
                .graph()
                .definition()
                .nodes()
                .iter()
                .filter(|node| node.is_armed_start())
            {
                let registered = trigger_counts
                    .get(&(run_id.clone(), node.id().as_str().to_owned()))
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
        let evidence = EvidenceLedger::restore(evidence)
            .map_err(|_| OrganizationFactsError::InvalidEvidenceLedger)?;
        for record in evidence.records() {
            validate_evidence_provenance(&run_facts, record)?;
        }

        let control_resolutions = ControlResolutionLedger::restore(control_resolutions)
            .map_err(|_| OrganizationFactsError::InvalidControlResolutionLedger)?;
        for resolution in control_resolutions.resolutions() {
            validate_control_node_resolution(&run_facts, &evidence, resolution)?;
        }

        let mut approval_facts = BTreeMap::new();
        for snapshot in approvals {
            let approval = Approval::restore(snapshot)
                .map_err(|_| OrganizationFactsError::InvalidApprovalLedger)?;
            if !run_facts.contains_key(&approval.facts().run_id) {
                return Err(OrganizationFactsError::UnknownApprovalRun);
            }
            if approval_facts
                .insert(approval.facts().approval_id.clone(), approval)
                .is_some()
            {
                return Err(OrganizationFactsError::DuplicateApproval);
            }
        }

        let decisions = TeamDecisionLedger::restore(decision_snapshot)
            .map_err(|_| OrganizationFactsError::InvalidDecisionLedger)?;
        let artifacts = ArtifactLedger::restore(artifact_records)
            .map_err(|_| OrganizationFactsError::InvalidArtifactLedger)?;
        for artifact in artifacts.records() {
            validate_artifact_provenance(&run_facts, artifact)?;
        }

        let events =
            EventLedger::restore(events).map_err(|_| OrganizationFactsError::InvalidEventLedger)?;
        let event_snapshot = events.snapshot();
        for record in event_snapshot.commands() {
            if !run_facts.contains_key(record.run_id().as_str()) {
                return Err(OrganizationFactsError::UnknownEventRun);
            }
        }
        for event in event_snapshot.events() {
            if !run_facts.contains_key(event.run_id()) {
                return Err(OrganizationFactsError::UnknownEventRun);
            }
        }
        validate_approval_resolution_events(&approval_facts, event_snapshot.events())?;
        validate_human_decision_approvals(&run_facts, &approval_facts, &control_resolutions)?;

        let mut resolved_receipts = BTreeSet::new();
        let mut matcha_terminal_correlations = Vec::new();
        for delivery in deliveries.deliveries() {
            let correlation = match delivery.phase() {
                DeliveryPhase::Delivered {
                    native_correlation: Some(correlation),
                    ..
                } => Some(correlation),
                DeliveryPhase::TerminalObserved { observation } => Some(observation.correlation()),
                _ => None,
            };
            if correlation
                .is_some_and(|correlation| matcha_terminal_correlations.contains(correlation))
            {
                return Err(OrganizationFactsError::DuplicateMatchaTerminalCorrelation);
            }
            if let Some(correlation) = correlation {
                matcha_terminal_correlations.push(correlation.clone());
            }
            if !run_facts.contains_key(&delivery.facts().run_id) {
                return Err(OrganizationFactsError::UnknownDeliveryRun);
            }
            if let DeliveryPhase::TerminalObserved { observation } = delivery.phase() {
                let run = run_facts
                    .get(&delivery.facts().run_id)
                    .expect("delivery run was just verified to exist");
                validate_terminal_observation(delivery, run, observation)?;
                if let TerminalObservationResolution::GraphResolved(resolution) =
                    observation.resolution()
                    && !resolved_receipts.insert(resolution.receipt().clone())
                {
                    return Err(OrganizationFactsError::DuplicateAuthorizedGraphResolution);
                }
            }
        }

        Ok(Self {
            teams: team_facts,
            materializations: materialization_facts,
            runs: run_facts,
            templates: template_facts,
            pending_workflow_plan_admissions: pending_admissions,
            deliveries,
            activities,
            triggers,
            control_resolutions,
            approvals: approval_facts,
            events,
            evidence,
            artifacts,
            decisions,
            task_board,
            purged_runs: purged_run_facts,
        })
    }

    pub fn teams(&self) -> impl Iterator<Item = &TeamFacts> {
        self.teams.values()
    }

    pub fn team(&self, team_id: &TeamId) -> Option<&TeamFacts> {
        self.teams.get(team_id.as_str())
    }

    pub fn materializations(&self) -> impl Iterator<Item = &MaterializationReceipt> {
        self.materializations
            .values()
            .filter_map(TeamMaterializationLifecycle::receipt)
    }

    pub fn materialization(&self, team_id: &TeamId) -> Option<&MaterializationReceipt> {
        self.materializations
            .get(team_id.as_str())
            .and_then(TeamMaterializationLifecycle::receipt)
    }

    pub(crate) fn materialization_lifecycles(
        &self,
    ) -> impl Iterator<Item = &TeamMaterializationLifecycle> {
        self.materializations.values()
    }

    pub(crate) fn materialization_recovery_request(
        &self,
        team_id: &TeamId,
    ) -> Option<TeamMaterializationRequest> {
        self.materializations
            .get(team_id.as_str())
            .and_then(TeamMaterializationLifecycle::receipt_recovery_request)
            .cloned()
    }

    pub(crate) fn create_team_materialization(
        &mut self,
        definition: &crate::TeamDefinition,
        request: TeamMaterializationRequest,
    ) -> Result<MaterializationRecordOutcome, OrganizationFactsError> {
        if definition.team_id() != request.intent().team() {
            return Err(OrganizationFactsError::UnknownMaterializationTeam);
        }
        match self.teams.get(definition.team_id().as_str()) {
            Some(team) if team.tombstoned() => return Err(OrganizationFactsError::TeamTombstoned),
            Some(_) => {}
            None => {
                self.teams.insert(
                    definition.team_id().as_str().to_owned(),
                    TeamFacts::new(definition.clone(), TeamRevision::initial(), false),
                );
            }
        }
        self.request_materialization(request)
    }

    pub(crate) fn request_materialization(
        &mut self,
        request: TeamMaterializationRequest,
    ) -> Result<MaterializationRecordOutcome, OrganizationFactsError> {
        let team_id = request.intent().team();
        let team = self
            .teams
            .get(team_id.as_str())
            .ok_or(OrganizationFactsError::UnknownMaterializationTeam)?;
        if team.tombstoned() {
            return Err(OrganizationFactsError::TeamTombstoned);
        }
        match self.materializations.get(team_id.as_str()) {
            None => {
                self.materializations.insert(
                    team_id.as_str().to_owned(),
                    TeamMaterializationLifecycle::requested(request),
                );
                Ok(MaterializationRecordOutcome::Recorded)
            }
            Some(
                TeamMaterializationLifecycle::Requested(existing)
                | TeamMaterializationLifecycle::OutcomeUnknown(existing),
            ) if existing == &request => Ok(MaterializationRecordOutcome::Replayed),
            Some(_) => Err(OrganizationFactsError::MaterializationChanged),
        }
    }

    pub(crate) fn record_materialization_outcome(
        &mut self,
        team_id: &TeamId,
        outcome: MaterializationOperationOutcome,
    ) -> Result<MaterializationRecordOutcome, OrganizationFactsError> {
        self.materializations
            .get_mut(team_id.as_str())
            .ok_or(OrganizationFactsError::UnknownMaterializationTeam)?
            .record_materialization_outcome(outcome)
            .map_err(map_materialization_lifecycle_error)
    }

    pub(crate) fn confirm_materialization(
        &mut self,
        receipt: MaterializationReceipt,
    ) -> Result<MaterializationRecordOutcome, OrganizationFactsError> {
        let team_id = receipt.team().clone();
        self.materializations
            .get_mut(team_id.as_str())
            .ok_or(OrganizationFactsError::UnknownMaterializationTeam)?
            .confirm(receipt)
            .map_err(map_materialization_lifecycle_error)
    }

    pub(crate) fn tombstone_team(
        &mut self,
        team_id: &TeamId,
        cleanup_idempotency_key: IdempotencyKey,
    ) -> Result<TeamTombstoneOutcome, OrganizationFactsError> {
        let outcome = self
            .teams
            .get_mut(team_id.as_str())
            .ok_or(OrganizationFactsError::UnknownTeam)?
            .tombstone();
        if outcome == TeamTombstoneOutcome::Tombstoned
            && let Some(lifecycle) = self.materializations.remove(team_id.as_str())
        {
            self.materializations.insert(
                team_id.as_str().to_owned(),
                lifecycle.tombstone(|receipt| {
                    crate::TeamMaterializationRemoval::new(receipt.clone(), cleanup_idempotency_key)
                }),
            );
        }
        Ok(outcome)
    }

    pub(crate) fn team_materialization_removal(
        &self,
        team_id: &TeamId,
    ) -> Option<crate::TeamMaterializationRemoval> {
        self.teams
            .get(team_id.as_str())
            .filter(|team| team.tombstoned())?;
        self.runs
            .values()
            .filter(|run| run.team() == team_id)
            .all(|run| {
                matches!(
                    run.lifecycle().state(),
                    GraphRunLifecycleState::Tombstoned { .. }
                )
            })
            .then_some(())?;
        self.materializations
            .get(team_id.as_str())?
            .cleanup_request()
            .cloned()
    }

    pub(crate) fn team_materialization_cleanup_confirmed(&self, team_id: &TeamId) -> bool {
        matches!(
            self.materializations.get(team_id.as_str()),
            Some(TeamMaterializationLifecycle::Tombstoned(
                crate::TombstonedMaterialization::Confirmed {
                    cleanup: crate::TeamMaterializationCleanup::Confirmed(_),
                    ..
                }
            ))
        )
    }

    pub(crate) fn record_team_materialization_cleanup_outcome(
        &mut self,
        team_id: &TeamId,
        outcome: MaterializationOperationOutcome,
    ) -> Result<MaterializationRecordOutcome, OrganizationFactsError> {
        self.materializations
            .get_mut(team_id.as_str())
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
            .filter(|run| matches!(run.lifecycle().state(), GraphRunLifecycleState::Active))
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
        if !self.teams.contains_key(template.team().as_str()) {
            return Err(OrganizationFactsError::UnknownWorkflowTemplateTeam);
        }
        if self
            .templates
            .get(template.team().as_str())
            .is_some_and(|current| template.revision() < current.revision())
        {
            return Err(OrganizationFactsError::WorkflowTemplateChanged);
        }
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
        if !matches!(
            self.materializations.get(team.as_str()),
            Some(TeamMaterializationLifecycle::Confirmed(_))
        ) {
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
                self.templates.insert(team.as_str().to_owned(), template);
                self.pending_workflow_plan_admissions
                    .remove(run_id.as_str());
                Ok(WorkflowPlanSubmitOutcome::Submitted(run_id))
            }
            CreateGraphRunOutcome::Replayed(run_id) => {
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

    pub(crate) fn set_run_start_proposal(
        &mut self,
        run_id: &GraphRunId,
        proposal_id: String,
        summary: String,
        source_delivery_id: String,
    ) -> Result<SetRunStartProposalOutcome, OrganizationFactsError> {
        self.runs
            .get_mut(run_id.as_str())
            .ok_or(OrganizationFactsError::UnknownRun)?
            .start_gate
            .set_proposal(proposal_id, summary, source_delivery_id)
            .map_err(|_| OrganizationFactsError::InvalidRunStartGate)
    }

    pub(crate) fn confirm_run_start(
        &mut self,
        run_id: &GraphRunId,
        proposal_id: &str,
    ) -> Result<ConfirmRunStartOutcome, OrganizationFactsError> {
        self.runs
            .get_mut(run_id.as_str())
            .ok_or(OrganizationFactsError::UnknownRun)?
            .start_gate
            .confirm_start(proposal_id)
            .map_err(|_| OrganizationFactsError::InvalidRunStartGate)
    }

    pub(crate) fn continue_run_discussion(
        &mut self,
        run_id: &GraphRunId,
        proposal_id: &str,
    ) -> Result<ContinueRunDiscussionOutcome, OrganizationFactsError> {
        self.runs
            .get_mut(run_id.as_str())
            .ok_or(OrganizationFactsError::UnknownRun)?
            .start_gate
            .continue_discussion(proposal_id)
            .map_err(|_| OrganizationFactsError::InvalidRunStartGate)
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

    pub fn activities(&self) -> &ActivityLedger {
        &self.activities
    }

    pub fn triggers(&self) -> &TriggerLedger {
        &self.triggers
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

    pub(crate) fn decision_snapshot(&self) -> crate::TeamDecisionLedgerSnapshot {
        self.decisions.snapshot()
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

    pub(crate) fn event_snapshot(&self) -> EventLedgerSnapshot {
        self.events.snapshot()
    }

    pub(crate) fn events_for_run(&self, run_id: &str) -> Vec<&crate::run::event::TeamEvent> {
        self.events.events_for_run(run_id).collect()
    }

    pub(crate) fn evidence_records(&self) -> impl Iterator<Item = &EvidenceRecord> {
        self.evidence.records()
    }

    pub fn artifacts(&self) -> impl Iterator<Item = &ArtifactRecord> {
        self.artifacts.records()
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
        let (node_id, execution_fence) = match (&facts.subject, facts.execution_fence.as_deref()) {
            (crate::ApprovalSubject::HumanDecision { node_id }, Some(execution_fence))
                if facts.origin == crate::ApprovalOrigin::HumanDecision
                    && facts.effect == crate::ApprovalEffect::RouteDecisionPorts =>
            {
                (node_id, execution_fence)
            }
            _ => return Err(OrganizationFactsError::InvalidApprovalResolution),
        };
        let run = self
            .runs
            .get(command.run_id().as_str())
            .ok_or(OrganizationFactsError::UnknownApprovalRun)?;
        let node_id = NodeId::new(node_id.clone());
        let attempt = run
            .graph()
            .current_attempt(&node_id)
            .filter(|attempt| attempt.fence().node_execution_id().as_str() == execution_fence)
            .ok_or(OrganizationFactsError::InvalidApprovalResolution)?;
        let resolution = ControlNodeResolution::human_decision(
            command.run_id().clone(),
            node_id,
            attempt.fence().clone(),
            match command.decision() {
                crate::ApprovalDecision::Approve => crate::HumanDecision::Approve,
                crate::ApprovalDecision::Deny => crate::HumanDecision::Deny,
                crate::ApprovalDecision::Abort => crate::HumanDecision::Abort,
            },
            command.resolved_at(),
        )
        .map_err(|_| OrganizationFactsError::InvalidApprovalResolution)?;
        if approval
            .resolution_for_idempotency(command.idempotency_key())
            .is_some()
        {
            if !approval.resolution_receipt_matches(
                command.idempotency_key(),
                command.decision(),
                command.note(),
                command.resolved_at(),
                crate::run::approval::ApprovalResolutionCause::HumanDecision,
            ) {
                return Err(OrganizationFactsError::ConflictingApprovalResolution);
            }
            return match self.apply_control_node_resolution(resolution) {
                Ok(
                    ControlNodeResolutionOutcome::Recorded | ControlNodeResolutionOutcome::Replayed,
                ) => Ok(HumanDecisionOutcome::Replayed),
                Err(_) => Err(OrganizationFactsError::InvalidApprovalResolution),
            };
        }

        let mut candidate = self.clone();
        let approval_outcome = candidate.resolve_approval(ApprovalResolutionInput {
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
        match candidate.apply_control_node_resolution(resolution) {
            Ok(ControlNodeResolutionOutcome::Recorded) => {
                *self = candidate;
                Ok(HumanDecisionOutcome::Recorded)
            }
            Ok(ControlNodeResolutionOutcome::Replayed) | Err(_) => {
                Err(OrganizationFactsError::InvalidApprovalResolution)
            }
        }
    }

    pub(crate) fn resolve_approval(
        &mut self,
        input: ApprovalResolutionInput,
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
            .get_mut(&approval_id)
            .filter(|approval| {
                let facts = approval.facts();
                facts.run_id == run_id && facts.stage_id == stage_id && facts.role_id == role_id
            })
            .ok_or(OrganizationFactsError::UnknownApproval)?;
        let resolution_count = approval.resolutions().len();
        approval
            .resolve_with_receipt(
                decision,
                resolved_at,
                note,
                idempotency_key.as_str().to_owned(),
                crate::run::approval::ApprovalResolutionCause::HumanDecision,
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

    pub(crate) fn accept_native_terminal_context(
        &mut self,
        delivery_id: &crate::DeliveryId,
        endpoint_session_id: crate::EndpointSessionId,
        native_run_id: String,
    ) -> Result<bool, OrganizationFactsError> {
        let delivery = self
            .deliveries
            .delivery(delivery_id)
            .ok_or(OrganizationFactsError::InvalidTerminalObservation)?;
        let run = self
            .runs
            .get(&delivery.facts().run_id)
            .ok_or(OrganizationFactsError::UnknownRun)?;
        let binding = run
            .runtime()
            .and_then(|runtime| {
                runtime.bindings().iter().find(|binding| {
                    binding.role().as_str() == delivery.facts().role_id
                        && binding.session_ref().as_str() == delivery.facts().session_ref
                })
            })
            .ok_or(OrganizationFactsError::InvalidTerminalObservation)?;
        if binding.endpoint_session_id() != &endpoint_session_id {
            return Err(OrganizationFactsError::InvalidTerminalObservation);
        }
        let crate::ActivityExecutionOutcome::Accepted {
            receipt,
            correlation,
        } = crate::ActivityExecutionOutcome::accepted(endpoint_session_id, native_run_id)
        else {
            return Err(OrganizationFactsError::InvalidTerminalObservation);
        };
        match delivery.phase() {
            DeliveryPhase::Delivered {
                receipt: existing,
                native_correlation,
                ..
            } if existing == &receipt && native_correlation.as_ref() == Some(&correlation) => {
                Ok(false)
            }
            DeliveryPhase::TerminalObserved { observation }
                if observation.delivered_receipt() == &receipt
                    && observation.correlation() == &correlation =>
            {
                Ok(false)
            }
            DeliveryPhase::Delivering(claim) => {
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
                .map_err(|_| OrganizationFactsError::InvalidTerminalObservation)?;
                Ok(true)
            }
            DeliveryPhase::OutcomeUnknown { .. } => Ok(self
                .deliveries
                .delivery_mut(delivery_id)
                .expect("validated delivery")
                .confirm_unknown_native_delivery(receipt, correlation)),
            _ => Err(OrganizationFactsError::InvalidTerminalObservation),
        }
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

    pub fn validate(&self) -> Result<(), OrganizationFactsError> {
        Self::restore_with_materialization_lifecycles_and_decisions_and_artifacts(
            MaterializationLifecycleFactsRestoreInput {
                teams: self.teams.values().cloned().collect(),
                materializations: self
                    .materializations
                    .iter()
                    .map(|(team_id, lifecycle)| {
                        (
                            TeamId::try_new(team_id.clone())
                                .expect("materialization index is derived from TeamId"),
                            lifecycle.clone(),
                        )
                    })
                    .collect(),
                runs: self.runs.values().cloned().collect(),
                pending_workflow_plan_admissions: self
                    .pending_workflow_plan_admissions
                    .values()
                    .cloned()
                    .collect(),
                templates: self.templates.values().cloned().collect(),
                deliveries: self.deliveries.snapshot(),
                activities: self.activities.snapshot(),
                triggers: self.triggers.requests().cloned().collect(),
                control_resolutions: self.control_resolutions.resolutions().cloned().collect(),
                approvals: self
                    .approvals
                    .values()
                    .map(Approval::durable_snapshot)
                    .collect(),
                events: self.events.snapshot(),
                evidence: self.evidence.records().cloned().collect(),
            },
            self.decision_snapshot(),
            self.artifacts.records().cloned(),
        )
        .map(|_| ())
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
            if current.team() != previous_run.team()
                || current.frozen_team_revision() != previous_run.frozen_team_revision()
            {
                return Err(OrganizationFactsError::RunOwnershipChanged);
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
        let previous_events = previous.events.snapshot();
        let current_events = self.events.snapshot();
        if !previous_events
            .commands()
            .iter()
            .all(|record| current_events.commands().contains(record))
            || !previous_events
                .events()
                .iter()
                .all(|event| current_events.events().contains(event))
        {
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
        let run = GraphRunFacts::with_lifecycle(
            run.team.clone(),
            run.frozen_team_revision,
            run.graph,
            run.runtime,
            GraphRunLifecycle::created(creation_idempotency_key.to_owned()),
        )?;
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
        let run = self
            .runs
            .get_mut(run_id.as_str())
            .ok_or(OrganizationFactsError::UnknownRun)?;
        let snapshot = run.clone();
        Ok(run
            .lifecycle
            .begin_cancellation(&snapshot, idempotency_key, requested_at))
    }

    pub(crate) fn settle_graph_run_cancellation(
        &mut self,
        run_id: &GraphRunId,
        idempotency_key: &str,
        outcome: RoleAbortOutcome,
        observed_at: u64,
    ) -> Result<SettleCancellationOutcome, OrganizationFactsError> {
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
                    run.graph = reduce(run.graph.clone(), event)
                        .map_err(|_| OrganizationFactsError::InvalidGraphRunLifecycle)?;
                }
            }
            result
        };
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
        let Some(runtime) = run.runtime() else {
            return Ok(GraphRunPurgeOutcome::Rejected(
                GraphRunPurgeRejection::ProofMismatch,
            ));
        };
        match request.native() {
            NativeDeletionEvidence::Rejected => {
                return Ok(GraphRunPurgeOutcome::Rejected(
                    GraphRunPurgeRejection::NativeDeletionRejected,
                ));
            }
            NativeDeletionEvidence::OutcomeUnknown => {
                return Ok(GraphRunPurgeOutcome::OutcomeUnknown(
                    GraphRunPurgeUnknown::NativeDeletionOutcomeUnknown,
                ));
            }
            NativeDeletionEvidence::Confirmed(proof)
                if proof.run_id() != request.run_id() || !proof.covers(runtime.bindings()) =>
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
        self.runs.remove(request.run_id().as_str());
        self.pending_workflow_plan_admissions
            .remove(request.run_id().as_str());
        self.deliveries
            .retain_without_run(request.run_id().as_str());
        self.activities
            .retain_without_run(request.run_id().as_str());
        self.triggers.retain_without_run(request.run_id().as_str());
        self.control_resolutions
            .retain_without_run(request.run_id());
        self.approvals
            .retain(|_, approval| approval.facts().run_id != request.run_id().as_str());
        self.events.retain_without_run(request.run_id().as_str());
        self.evidence.retain_without_run(request.run_id().as_str());
        self.artifacts.retain_without_run(request.run_id().as_str());
        self.decisions.retain_without_run(request.run_id().as_str());
        self.task_board.retain_without_run(request.run_id());
        self.purged_runs
            .insert(request.run_id().as_str().to_owned(), marker);
        self.validate()?;
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
        let run = self
            .runs
            .get_mut(run_id.as_str())
            .ok_or(OrganizationFactsError::UnknownRun)?;
        let snapshot = run.clone();
        Ok(run
            .lifecycle
            .tombstone(&snapshot, idempotency_key, tombstoned_at))
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
        let materialization = self
            .materializations
            .get(run.team().as_str())
            .and_then(TeamMaterializationLifecycle::receipt)
            .ok_or(OrganizationFactsError::RuntimeMaterializationMissing)?;
        validate_runtime_receipt_alignment(team, run, &receipt, materialization)?;
        if run.runtime.is_some() {
            return Err(OrganizationFactsError::RuntimeAlreadyInstalled);
        }

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

        let next_graph = reduce(
            run.graph().clone(),
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
        self.runs
            .get_mut(&recorded.run_id)
            .expect("trigger run was validated before ledger registration")
            .graph = next_graph;
        Ok(TriggerRegistration::Recorded(recorded))
    }

    pub(crate) fn observe_native_terminal(
        &mut self,
        delivery_id: &crate::DeliveryId,
        native_terminal: NativeTerminalStatus,
        observed_at: u64,
    ) -> Result<TerminalObservationOutcome, TerminalObservationError> {
        let mut delivery = self
            .deliveries
            .delivery(delivery_id)
            .cloned()
            .ok_or(TerminalObservationError::DeliveryMismatch)?;
        let run_id = GraphRunId::new(delivery.facts().run_id.clone());
        let mut run = self
            .runs
            .get(run_id.as_str())
            .cloned()
            .ok_or(TerminalObservationError::RunMismatch)?;
        let correlation = match delivery.phase() {
            DeliveryPhase::Delivered {
                native_correlation: Some(correlation),
                ..
            } => correlation.clone(),
            DeliveryPhase::TerminalObserved { observation } => observation.correlation().clone(),
            _ => return Err(TerminalObservationError::DeliveryNotAccepted),
        };
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
                .map_err(|_| TerminalObservationError::DeliveryMismatch)?;
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
                } else {
                    let claim = activity
                        .active_claim()
                        .cloned()
                        .ok_or(TerminalObservationError::StaleFence)?;
                    crate::settle_activity(activity, &claim, settlement)
                        .map_err(|_| TerminalObservationError::StaleFence)?;
                }
            }
        }
        self.runs.insert(run_id.as_str().to_owned(), run);
        *self
            .deliveries
            .delivery_mut(delivery_id)
            .expect("delivery ledger preserves its delivery identity index") = delivery;
        Ok(outcome)
    }

    pub(crate) fn replace_run_graph(
        &mut self,
        run_id: &GraphRunId,
        graph: GraphState,
    ) -> Result<(), OrganizationFactsError> {
        let run = self
            .runs
            .get(run_id.as_str())
            .cloned()
            .ok_or(OrganizationFactsError::UnknownRun)?;
        if graph.definition().run_id() != run_id {
            return Err(OrganizationFactsError::InvalidGraphRun);
        }
        self.runs
            .insert(run_id.as_str().to_owned(), GraphRunFacts { graph, ..run });
        self.cancel_superseded_pending_activities(run_id);
        Ok(())
    }

    pub(crate) fn cancel_superseded_pending_activities(&mut self, run_id: &GraphRunId) {
        let Some(run) = self.runs.get(run_id.as_str()) else {
            return;
        };
        let cancelled = self
            .activities
            .activities()
            .filter(|activity| activity.facts().run_id == *run_id)
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
    ) -> Result<(), crate::GraphPatchError> {
        let run = self
            .runs
            .get(run_id.as_str())
            .cloned()
            .ok_or(crate::GraphPatchError::UnknownRun)?;
        let graph = crate::apply_graph_patch(run.graph(), patch, applied_at)?;
        self.runs
            .insert(run_id.as_str().to_owned(), GraphRunFacts { graph, ..run });
        Ok(())
    }

    pub(crate) fn replace_team_graph(
        &mut self,
        command: crate::RunCommand,
        definition: crate::GraphDefinition,
    ) -> Result<crate::CommandReceipt, crate::RecordCommandError> {
        let run_id = GraphRunId::new(command.run_id().as_str());
        if definition.run_id() != &run_id
            || command.payload() != &crate::CommandPayload::GraphReplace(definition.clone())
        {
            return Err(crate::RecordCommandError::InvalidEventId);
        }
        if let Some(existing) = self
            .events
            .command_by_idempotency(command.run_id(), command.idempotency_key())
        {
            if existing.command() != &command {
                return Err(crate::RecordCommandError::IdempotencyConflict);
            }
            return self.events.try_accept(command);
        }
        let current = self
            .runs
            .get(run_id.as_str())
            .cloned()
            .ok_or(crate::RecordCommandError::InvalidEventId)?;
        let graph = GraphState::initialize(definition, command.created_at());
        let receipt = self.events.try_accept(command)?;
        self.runs.insert(
            run_id.as_str().to_owned(),
            GraphRunFacts { graph, ..current },
        );
        Ok(receipt)
    }

    pub(crate) fn team_graph_patch(
        &mut self,
        command: crate::RunCommand,
        patch: &crate::GraphPatch,
    ) -> Result<crate::CommandReceipt, crate::RecordCommandError> {
        let run_id = GraphRunId::new(command.run_id().as_str());
        if let Some(existing) = self
            .events
            .command_by_idempotency(command.run_id(), command.idempotency_key())
        {
            if existing.command() != &command {
                return Err(crate::RecordCommandError::IdempotencyConflict);
            }
            return self.events.try_accept(command);
        }
        let current = self
            .runs
            .get(run_id.as_str())
            .cloned()
            .ok_or(crate::RecordCommandError::InvalidEventId)?;
        let graph = crate::apply_graph_patch(current.graph(), patch, command.created_at())
            .map_err(|_| crate::RecordCommandError::InvalidEventId)?;
        let receipt = self.events.try_accept(command)?;
        self.runs.insert(
            run_id.as_str().to_owned(),
            GraphRunFacts { graph, ..current },
        );
        Ok(receipt)
    }

    pub(crate) fn team_node_event(
        &mut self,
        command: crate::RunCommand,
        event: crate::TeamNodeEvent,
    ) -> Result<crate::TeamNodeEventOutcome, crate::RecordCommandError> {
        let run_id = GraphRunId::new(command.run_id().as_str());
        let mut run = self
            .runs
            .get(run_id.as_str())
            .cloned()
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
        let outcome = match event.kind() {
            crate::TeamNodeEventKind::Progress => crate::TeamNodeEventOutcome::Progressed,
            crate::TeamNodeEventKind::RequestInput => {
                run.graph = reduce(
                    run.graph,
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
                    risk_summary: "Agent supplied no public risk summary.".to_owned(),
                    idempotency_key: command.idempotency_key().as_str().to_owned(),
                    requested_at: command.created_at(),
                    subject: crate::ApprovalSubject::WorkNode {
                        node_id: node_id.as_str().to_owned(),
                    },
                    origin: crate::ApprovalOrigin::WorkNode,
                    effect: crate::ApprovalEffect::KeepNodeWaiting,
                    execution_fence: Some(fence.node_execution_id().as_str().to_owned()),
                });
                self.approvals
                    .insert(approval.facts().approval_id.clone(), approval);
                run.graph = reduce(
                    run.graph,
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
        self.runs.insert(run_id.as_str().to_owned(), run);
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
                .artifact,
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
        match self.artifacts.record(artifact) {
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
        let mut run = self
            .runs
            .get(run_id.as_str())
            .cloned()
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
        self.runs.insert(run_id.as_str().to_owned(), run);
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
        let mut delivery = self.deliveries.delivery(delivery_id).cloned().ok_or(
            crate::NativeRunOutputResolutionError::AuthorizedResolution(
                AuthorizedGraphResolutionError::DeliveryMismatch,
            ),
        )?;
        let run_id = GraphRunId::new(delivery.facts().run_id.clone());
        let mut run = self.runs.get(run_id.as_str()).cloned().ok_or(
            crate::NativeRunOutputResolutionError::AuthorizedResolution(
                AuthorizedGraphResolutionError::RunMismatch,
            ),
        )?;
        let output = crate::TeamNodeOutput::parse(final_assistant_text)
            .map_err(|_| crate::NativeRunOutputResolutionError::InvalidOutput)?;
        let DeliveryPhase::TerminalObserved { observation } = delivery.phase() else {
            return Err(crate::NativeRunOutputResolutionError::AuthorizedResolution(
                AuthorizedGraphResolutionError::DeliveryNotAwaitingAuthorizedResolution,
            ));
        };
        if matches!(
            observation.resolution(),
            TerminalObservationResolution::GraphResolved(_)
        ) {
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
            .map_err(|_| crate::NativeRunOutputResolutionError::InvalidOutput)?
            .artifact;
            self.record_terminal_completion_artifact(delivery_id, artifact)
                .map_err(|_| crate::NativeRunOutputResolutionError::InvalidOutput)?;
        }
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
        self.runs.insert(run_id.as_str().to_owned(), run);
        *self
            .deliveries
            .delivery_mut(delivery_id)
            .expect("delivery ledger preserves its delivery identity index") = delivery;
        self.cancel_superseded_pending_activities(&run_id);
        Ok(outcome)
    }

    fn settle_resolved_activity(
        &mut self,
        delivery_id: &crate::DeliveryId,
        resolution_outcome: crate::AuthorizedGraphOutcome,
        resolved_at: u64,
    ) -> Result<(), crate::ActivityTransitionError> {
        let activity_id = ActivityId::new(delivery_id.as_str().to_owned())
            .map_err(|_| crate::ActivityTransitionError::StaleClaim)?;
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
            crate::run::activity::resolve_terminal_observed_activity(activity, settlement)?;
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

        let run = self
            .runs
            .get(resolution.graph_run_id().as_str())
            .cloned()
            .ok_or(ControlNodeResolutionError::GraphRunMismatch)?;
        if run.run_id() != resolution.graph_run_id() {
            return Err(ControlNodeResolutionError::GraphRunMismatch);
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
        if resolution.authority() == ControlAuthority::Join
            && (resolution.outcome() != crate::AuthorizedGraphOutcome::Completed
                || resolution.output_port() != "joined"
                || run
                    .graph()
                    .current_attempt(resolution.node_id())
                    .is_none_or(|attempt| attempt.status() != crate::AttemptStatus::Ready))
        {
            return Err(ControlNodeResolutionError::GraphStateMismatch);
        }
        require_control_output_port(run.graph(), resolution.node_id(), resolution.output_port())?;
        let event = match resolution.outcome() {
            crate::AuthorizedGraphOutcome::Completed => GraphEvent::NodeCompleted {
                node_id: resolution.node_id().clone(),
                fence: resolution.fence().clone(),
                output_port: resolution.output_port().to_owned(),
                completed_at: resolution.resolved_at(),
            },
            crate::AuthorizedGraphOutcome::Failed => GraphEvent::NodeFailed {
                node_id: resolution.node_id().clone(),
                fence: resolution.fence().clone(),
                output_port: resolution.output_port().to_owned(),
                failed_at: resolution.resolved_at(),
            },
        };
        let graph = reduce(run.graph().clone(), event).map_err(|error| match error {
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
        self.runs.insert(
            run.run_id().as_str().to_owned(),
            GraphRunFacts { graph, ..run },
        );
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
        validate_activity_request(&self.runs, &request)?;
        self.activities
            .register(request)
            .map_err(|_| OrganizationFactsError::InvalidActivity)
    }

    pub(crate) fn claim_activity(
        &mut self,
        activity_id: &ActivityId,
        claimed_at: u64,
    ) -> Result<ActivityClaimOutcome, OrganizationFactsError> {
        let activity = self
            .activities
            .activity_mut(activity_id)
            .ok_or(OrganizationFactsError::UnknownActivity)?;
        if matches!(
            activity.phase(),
            ActivityPhase::Pending | ActivityPhase::RetryScheduled { .. }
        ) && self
            .runs
            .get(activity.facts().run_id.as_str())
            .and_then(|run| run.graph().current_attempt(&activity.facts().node_id))
            .is_none_or(|attempt| attempt.fence() != &activity.facts().fence)
        {
            return Err(OrganizationFactsError::InvalidActivityTransition);
        }
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
        let mut recovered = false;
        for lifecycle in self.materializations.values_mut() {
            if let TeamMaterializationLifecycle::Requested(request) = lifecycle {
                *lifecycle = TeamMaterializationLifecycle::OutcomeUnknown(request.clone());
                recovered = true;
            }
        }
        recovered
    }

    pub(crate) fn recover_interrupted_deliveries(&mut self, observed_at: u64) -> bool {
        let mut recovered = false;
        for delivery in self.deliveries.deliveries().cloned().collect::<Vec<_>>() {
            if matches!(delivery.phase(), crate::DeliveryPhase::Delivering(_)) {
                let active = self
                    .deliveries
                    .delivery_mut(&delivery.facts().delivery_id)
                    .expect("delivery ledger preserves its delivery identity index");
                let _ = crate::recover_interrupted_delivery(active, observed_at);
                recovered = true;
            }
        }
        recovered
    }

    pub(crate) fn recover_interrupted_activities(&mut self, observed_at: u64) -> bool {
        let mut recovered = false;
        for activity in self.activities.activities().cloned().collect::<Vec<_>>() {
            if activity.active_claim().is_some() {
                let active = self
                    .activities
                    .activity_mut(&activity.facts().activity_id)
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
        let mut recovered = false;
        for run in self.runs.values_mut() {
            recovered |= run.lifecycle.recover_interrupted_cancellation(observed_at);
        }
        recovered
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
        .map(|assignment| assignment.role_id());
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

fn validate_approval_resolution_events(
    approvals: &BTreeMap<String, Approval>,
    events: &[crate::run::event::TeamEvent],
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

    for event in events.iter().filter(|event| {
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

fn validate_human_decision_approvals(
    runs: &BTreeMap<String, GraphRunFacts>,
    approvals: &BTreeMap<String, Approval>,
    resolutions: &ControlResolutionLedger,
) -> Result<(), OrganizationFactsError> {
    for approval in approvals.values().filter(|approval| {
        matches!(
            (
                &approval.facts().subject,
                approval.facts().origin,
                approval.facts().effect
            ),
            (
                crate::ApprovalSubject::HumanDecision { .. },
                crate::ApprovalOrigin::HumanDecision,
                crate::ApprovalEffect::RouteDecisionPorts
            )
        )
    }) {
        let facts = approval.facts();
        let node_id = match &facts.subject {
            crate::ApprovalSubject::HumanDecision { node_id } => NodeId::new(node_id.clone()),
            _ => unreachable!("human-decision approval filter preserves subject"),
        };
        let fence = facts
            .execution_fence
            .as_deref()
            .ok_or(OrganizationFactsError::InvalidApprovalLedger)?;
        let run = runs
            .get(&facts.run_id)
            .ok_or(OrganizationFactsError::UnknownApprovalRun)?;
        if !run
            .graph()
            .executions()
            .get(&node_id)
            .is_some_and(|history| {
                history
                    .attempts()
                    .iter()
                    .any(|attempt| attempt.fence().node_execution_id().as_str() == fence)
            })
        {
            return Err(OrganizationFactsError::InvalidApprovalLedger);
        }
        for receipt in approval.resolutions() {
            let human_decision = match receipt.decision {
                crate::ApprovalDecision::Approve => crate::HumanDecision::Approve,
                crate::ApprovalDecision::Deny => crate::HumanDecision::Deny,
                crate::ApprovalDecision::Abort => crate::HumanDecision::Abort,
            };
            let control = resolutions
                .resolutions()
                .find(|control| {
                    control.authority() == ControlAuthority::HumanDecision
                        && control.graph_run_id().as_str() == facts.run_id
                        && control.node_id() == &node_id
                        && control.fence().node_execution_id().as_str() == fence
                        && control.resolved_at() == receipt.resolved_at
                })
                .ok_or(OrganizationFactsError::InvalidApprovalLedger)?;
            let expected = match human_decision {
                crate::HumanDecision::Approve => "approved",
                crate::HumanDecision::Deny => "rejected",
                crate::HumanDecision::Abort => "aborted",
            };
            if control.output_port() != expected {
                return Err(OrganizationFactsError::InvalidApprovalLedger);
            }
        }
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
    evidence: &EvidenceLedger,
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
    if let Some(rule) = resolution.script_review_rule() {
        let output_port = crate::run::control::script_review_output_port_with_evidence(
            rule,
            resolution.graph_run_id(),
            run.graph(),
            resolution.node_id(),
            resolution.fence(),
            evidence,
        )
        .map_err(|_| OrganizationFactsError::InvalidControlNodeResolution)?;
        if resolution.authority() != ControlAuthority::ScriptReview
            || resolution.outcome() != crate::AuthorizedGraphOutcome::Completed
            || resolution.output_port() != output_port
        {
            return Err(OrganizationFactsError::InvalidControlNodeResolution);
        }
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
    team: &TeamFacts,
    run: &GraphRunFacts,
    receipt: &RunRuntimeReceipt,
    materialization: &MaterializationReceipt,
) -> Result<(), OrganizationFactsError> {
    if team.tombstoned() {
        return Err(OrganizationFactsError::RuntimeTeamTombstoned);
    }
    if receipt.team_run() != run.run_id() {
        return Err(OrganizationFactsError::RuntimeRunMismatch);
    }
    for binding in receipt.bindings() {
        if binding.team() != run.team() {
            return Err(OrganizationFactsError::RuntimeBindingTeamMismatch);
        }
        if !materialization
            .roles()
            .iter()
            .any(|role| role.role() == binding.role())
        {
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

fn validate_activity(
    runs: &BTreeMap<String, GraphRunFacts>,
    activity: &Activity,
) -> Result<(), OrganizationFactsError> {
    validate_activity_request(runs, activity.facts())
}

fn validate_activity_request(
    runs: &BTreeMap<String, GraphRunFacts>,
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
    if history
        .attempts()
        .iter()
        .all(|attempt| attempt.fence() != &request.fence)
        || request.fence.node_execution_id() != &request.node_execution_id
    {
        return Err(OrganizationFactsError::InvalidActivity);
    }
    match (&request.activity_kind, node.kind()) {
        (
            ActivityKind::AgentTask {
                task_id,
                role_id,
                session_ref,
                prompt,
            },
            NodeKind::Work,
        ) => {
            let work = node
                .work_assignment()
                .ok_or(OrganizationFactsError::InvalidActivity)?;
            if work.task_id() != task_id
                || work.role_id() != role_id
                || work.session_ref().as_str() != session_ref
                || !activity_prompt_matches(run.graph().definition(), node, work.prompt(), prompt)
            {
                return Err(OrganizationFactsError::InvalidActivity);
            }
            validate_activity_target(run, role_id, session_ref, &request.target)
        }
        (
            ActivityKind::AgentTask {
                role_id,
                session_ref,
                prompt,
                ..
            },
            NodeKind::Review,
        ) => {
            let review = node
                .review_assignment()
                .ok_or(OrganizationFactsError::InvalidActivity)?;
            if review.role_id() != role_id
                || review.session_ref().as_str() != session_ref
                || !activity_prompt_matches(run.graph().definition(), node, review.prompt(), prompt)
            {
                return Err(OrganizationFactsError::InvalidActivity);
            }
            validate_activity_target(run, role_id, session_ref, &request.target)
        }
        (ActivityKind::Control { .. }, NodeKind::Start | NodeKind::Join | NodeKind::End) => Ok(()),
        _ => Err(OrganizationFactsError::InvalidActivity),
    }
}

fn activity_prompt_matches(
    definition: &GraphDefinition,
    node: &crate::NodeDefinition,
    base_prompt: &str,
    prompt: &str,
) -> bool {
    let Some(composed) =
        crate::run::scheduler::compose_agent_task_prompt(definition, node, base_prompt)
    else {
        return false;
    };
    if prompt == composed {
        return true;
    }
    let Some((prefix, suffix)) = composed.split_once("\n\n<teamrun_completion_protocol>") else {
        return false;
    };
    prompt.starts_with(prefix)
        && prompt.contains("\n\n<teamrun_upstream_context>\n")
        && prompt.ends_with(&format!("\n\n<teamrun_completion_protocol>{suffix}"))
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
        | (ActivityPhase::OutcomeUnknown { .. }, ActivityPhase::Cancelled { .. }) => Ok(()),
        (ActivityPhase::Cancelled { .. }, ActivityPhase::Cancelled { .. }) => Ok(()),
        _ => Err(OrganizationFactsError::InvalidActivityTransition),
    }
}

fn validate_delivery_transition(
    previous: &crate::Delivery,
    current: &crate::Delivery,
) -> Result<(), OrganizationFactsError> {
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
    let node_id = crate::NodeId::new(facts.node_id.clone());
    let history = run
        .graph()
        .executions()
        .get(&node_id)
        .ok_or(OrganizationFactsError::InvalidTerminalObservation)?;
    let attempt = history
        .attempts()
        .iter()
        .find(|attempt| attempt.fence() == observation.fence())
        .ok_or(OrganizationFactsError::InvalidTerminalObservation)?;
    match observation.resolution() {
        TerminalObservationResolution::AwaitingAuthorizedGraphResolution
            if (attempt.status() == crate::AttemptStatus::Waiting
                || (history.current().fence() != observation.fence()
                    && matches!(
                        attempt.status(),
                        crate::AttemptStatus::Ready | crate::AttemptStatus::Running
                    )))
                && attempt.output_port().is_none() => {}
        TerminalObservationResolution::GraphResolved(resolution)
            if observation
                .output()
                .is_none_or(|output| output.decision() == resolution.output_port())
                && resolution.delivery_id() == observation.delivery_id()
                && resolution.graph_run_id() == observation.graph_run_id()
                && resolution.fence() == observation.fence()
                && resolution.resolved_at() >= observation.observed_at()
                && attempt.output_port() == Some(resolution.output_port())
                && matches!(
                    (resolution.outcome(), attempt.status()),
                    (
                        crate::AuthorizedGraphOutcome::Completed,
                        crate::AttemptStatus::Completed,
                    ) | (
                        crate::AuthorizedGraphOutcome::Failed,
                        crate::AttemptStatus::Failed,
                    )
                ) => {}
        TerminalObservationResolution::NodeCancelled
            if attempt.status() == crate::AttemptStatus::Cancelled
                && attempt.output_port().is_none() => {}
        _ => return Err(OrganizationFactsError::InvalidTerminalObservation),
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
