use super::{
    GraphCallStatus, GraphSummary, OrganizationCallDetail, OrganizationCallOutcome as Outcome,
};
use crate::{
    application::{task_board::MutationResult, team_runtime::TeamRuntimeStatus},
    owner::team_run::{
        ManualTeamCreateOutcome, TeamDeleteOutcome, TeamMaterializationCommandOutcome,
        TeamNodeTerminalResult, TeamRunCommandOutcome, TeamRunTriggerOutcome,
    },
    package::{
        TeamSkillDependencyPlanResult, TeamSkillPackageValidation, TeamSkillSelectionError,
        TeamSkillSelectionId,
    },
    run::{
        approval::HumanDecisionOutcome,
        public_projection::{TeamPublicQueryOutcome, TeamRunPublicSnapshotQueryOutcome},
        scheduler::NodePromptRetryDueQueryOutcome,
        task_board::TaskBoardFacts,
    },
};

pub(crate) trait AuditOutcome {
    fn summarize(&self, detail: &mut OrganizationCallDetail);
}

trait AuditFailure {
    fn outcome(&self) -> Outcome;
}

impl AuditFailure for crate::StoreFault {
    fn outcome(&self) -> Outcome {
        use crate::StoreFault::*;
        match self {
            CommitOutcomeUnknown(_) | RecoveryRequired => Outcome::OutcomeUnknown,
            InvalidFacts
            | RuntimeReceipt(_)
            | Evidence(_)
            | ActivityTransition(_)
            | DeliveryRequest(_)
            | DeliveryReceipt(_)
            | TriggerFire(_)
            | TerminalObservation(_)
            | NativeRunOutputResolution(_)
            | AuthorizedGraphResolution(_)
            | AgentNodeEventResolution(_)
            | GraphPatch(_)
            | EventLedger(_)
            | ControlNodeResolution(_) => Outcome::Rejected,
            _ => Outcome::Unavailable,
        }
    }
}

impl AuditFailure for TeamRuntimeStatus {
    fn outcome(&self) -> Outcome {
        match self {
            Self::Rejected => Outcome::Rejected,
            Self::Unavailable => Outcome::Unavailable,
            Self::OutcomeUnknown => Outcome::OutcomeUnknown,
        }
    }
}

impl AuditOutcome for TeamRuntimeStatus {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        detail.set_outcome(self.outcome());
    }
}

impl AuditFailure for TeamSkillSelectionError {
    fn outcome(&self) -> Outcome {
        match self {
            Self::InvalidSelection => Outcome::Rejected,
            Self::Unavailable => Outcome::Unavailable,
        }
    }
}

impl<T: AuditOutcome, E: AuditFailure> AuditOutcome for Result<T, E> {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        match self {
            Ok(value) => value.summarize(detail),
            Err(error) => detail.set_outcome(error.outcome()),
        }
    }
}

impl<T: AuditOutcome> AuditOutcome for Option<T> {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        match self {
            Some(value) => value.summarize(detail),
            None => detail.set_outcome(Outcome::Unavailable),
        }
    }
}

impl<T: AuditOutcome> AuditOutcome for Vec<T> {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        detail.set_outcome(Outcome::Read);
        for value in self {
            value.summarize(detail);
        }
    }
}

impl OrganizationCallDetail {
    fn set_outcome(&mut self, outcome: Outcome) {
        if matches!(self.outcome, Some(Outcome::OutcomeUnknown)) {
            return;
        }
        if matches!(self.outcome, Some(Outcome::Unavailable | Outcome::Rejected))
            && !matches!(outcome, Outcome::OutcomeUnknown)
        {
            return;
        }
        if !matches!(outcome, Outcome::Read) || self.outcome.is_none() {
            self.outcome = Some(outcome);
        }
    }
}

impl AuditOutcome for TeamSkillSelectionId {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        detail.set_outcome(Outcome::CommandCommitted);
    }
}

impl AuditOutcome for TeamSkillPackageValidation {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        detail.set_outcome(match self {
            Self::Valid { .. } => Outcome::Read,
            Self::Invalid => Outcome::Rejected,
            Self::Unavailable => Outcome::Unavailable,
        });
    }
}

impl AuditOutcome for TeamSkillDependencyPlanResult {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        detail.set_outcome(match self {
            Self::Available { .. } => Outcome::Read,
            Self::Invalid => Outcome::Rejected,
            Self::Unavailable => Outcome::Unavailable,
        });
    }
}

impl AuditOutcome for TeamMaterializationCommandOutcome {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        let outcome = match self {
            Self::Materialized { team_id, .. } => {
                detail.team_reference(team_id.as_str());
                Outcome::Materialized
            }
            Self::OutcomeUnknown => Outcome::OutcomeUnknown,
            Self::Rejected => Outcome::Rejected,
            Self::Unavailable => Outcome::Unavailable,
        };
        detail.set_outcome(outcome);
    }
}

impl AuditOutcome for ManualTeamCreateOutcome {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        match self {
            Self::Created(value) => value.summarize(detail),
            Self::Rejected => detail.set_outcome(Outcome::Rejected),
            Self::OutcomeUnknown => detail.set_outcome(Outcome::OutcomeUnknown),
            Self::Unavailable => detail.set_outcome(Outcome::Unavailable),
        }
    }
}

impl AuditOutcome for TeamDeleteOutcome {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        detail.set_outcome(match self {
            Self::Deleted => Outcome::Tombstoned,
            Self::OutcomeUnknown => Outcome::OutcomeUnknown,
        });
    }
}

impl AuditOutcome for crate::CreateGraphRunOutcome {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        let outcome = match self {
            Self::Created(run_id) | Self::Replayed(run_id) => {
                detail.run_reference(run_id.as_str());
                Outcome::Created
            }
            Self::ConflictingIdempotency | Self::ExistingRun => Outcome::Rejected,
        };
        detail.set_outcome(outcome);
    }
}

impl AuditOutcome for crate::BeginCancellationOutcome {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        detail.set_outcome(match self {
            Self::Started(_) | Self::Replayed(_) => Outcome::Cancelling,
            Self::AlreadyCancelled => Outcome::Cancelled,
            Self::OutcomeUnknown => Outcome::OutcomeUnknown,
            Self::Tombstoned => Outcome::Tombstoned,
        });
    }
}

impl AuditOutcome for crate::TombstoneOutcome {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        detail.set_outcome(match self {
            Self::Tombstoned | Self::Replayed => Outcome::Tombstoned,
            Self::CancellationRequired(_) => Outcome::Cancelling,
            Self::OutcomeUnknown => Outcome::OutcomeUnknown,
        });
    }
}

impl AuditOutcome for crate::GraphRunPurgeOutcome {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        detail.set_outcome(match self {
            Self::Purged | Self::Replayed => Outcome::Purged,
            Self::Rejected(_) => Outcome::Rejected,
            Self::OutcomeUnknown(_) => Outcome::OutcomeUnknown,
        });
    }
}

impl AuditOutcome for TeamRunCommandOutcome {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        let outcome = match self {
            Self::Available(projection) => {
                detail.team_reference(projection.team().as_str());
                detail.run_reference(projection.run().as_str());
                Outcome::CommandCommitted
            }
            Self::Unavailable => Outcome::Unavailable,
            Self::OutcomeUnknown => Outcome::OutcomeUnknown,
        };
        detail.set_outcome(outcome);
    }
}

impl AuditOutcome for TeamRunTriggerOutcome {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        if matches!(
            self.registration(),
            crate::TriggerRegistration::ConflictingIdempotencyKey { .. }
        ) {
            detail.set_outcome(Outcome::Rejected);
        } else {
            self.run().summarize(detail);
        }
    }
}

impl AuditOutcome for crate::TeamTriggerFireOutcome {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        detail.set_outcome(match self {
            Self::Recorded(_) | Self::Replayed(_) => Outcome::CommandCommitted,
            Self::Conflicting { .. } | Self::NotFound | Self::Rejected => Outcome::Rejected,
            Self::Unknown => Outcome::OutcomeUnknown,
        });
    }
}

impl AuditOutcome for crate::ConfirmRunStartOutcome {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        detail.set_outcome(match self {
            Self::Started | Self::Replayed => Outcome::Started,
            Self::Intake => Outcome::Intake,
            Self::ProposalMismatch => Outcome::Rejected,
        });
    }
}

impl AuditOutcome for crate::ContinueRunDiscussionOutcome {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        detail.set_outcome(match self {
            Self::Intake | Self::Replayed => Outcome::Intake,
            Self::AlreadyStarted => Outcome::Started,
            Self::ProposalMismatch => Outcome::Rejected,
        });
    }
}

impl AuditOutcome for crate::TeamNodeEventOutcome {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        detail.set_outcome(match self {
            Self::Progressed => Outcome::CommandCommitted,
            Self::WaitingForInput => Outcome::WaitingForInput,
            Self::ApprovalRequested => Outcome::ApprovalRequested,
            Self::TerminalReceiptRequired => Outcome::TerminalReceiptRequired,
        });
    }
}

impl AuditOutcome for TeamNodeTerminalResult {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        detail.set_outcome(Outcome::TerminalRecorded);
    }
}

macro_rules! committed {
    ($($ty:ty),+ $(,)?) => { $(impl AuditOutcome for $ty {
        fn summarize(&self, detail: &mut OrganizationCallDetail) { detail.set_outcome(Outcome::CommandCommitted); }
    })+ };
}
committed!(
    HumanDecisionOutcome,
    crate::TeamDecisionReceipt,
    MutationResult
);

impl AuditOutcome for crate::TeamRunQueryOutcome {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        detail.set_outcome(match self {
            Self::Available(_) => Outcome::Read,
            Self::Unavailable => Outcome::Unavailable,
            Self::OutcomeUnknown => Outcome::OutcomeUnknown,
        });
    }
}

impl AuditOutcome for crate::TeamRoleSessionQueryOutcome {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        detail.set_outcome(match self {
            Self::Available(_) => Outcome::Read,
            Self::Unavailable => Outcome::Unavailable,
            Self::OutcomeUnknown => Outcome::OutcomeUnknown,
        });
    }
}

impl AuditOutcome for crate::TeamGraphContextResult {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        detail.set_outcome(match self {
            Self::Available(_) => Outcome::Read,
            Self::Unavailable => Outcome::Unavailable,
            Self::OutcomeUnknown => Outcome::OutcomeUnknown,
        });
    }
}

fn public_graph(graph: &crate::run::public_projection::TeamPublicGraph) -> GraphSummary {
    use crate::run::public_projection::TeamPublicGraphStatus as Status;
    GraphSummary {
        status: match graph.status() {
            Status::Pending => GraphCallStatus::Pending,
            Status::Ready => GraphCallStatus::Ready,
            Status::Running => GraphCallStatus::Running,
            Status::Waiting => GraphCallStatus::Waiting,
            Status::Completed => GraphCallStatus::Completed,
            Status::Failed => GraphCallStatus::Failed,
            Status::Cancelled => GraphCallStatus::Cancelled,
        },
        nodes: graph.nodes().len() as u64,
        edges: graph.edges().len() as u64,
    }
}

impl AuditOutcome for TeamPublicQueryOutcome {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        match self {
            Self::Available(view) => {
                detail.team_reference(view.team_id());
                detail.run_reference(view.run_id());
                detail.graph = Some(public_graph(view.graph()));
                detail.set_outcome(Outcome::Read);
            }
            Self::Unavailable => detail.set_outcome(Outcome::Unavailable),
        }
    }
}

impl AuditOutcome for TeamRunPublicSnapshotQueryOutcome {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        match self {
            Self::Available(view) => {
                detail.team_reference(view.run().team_id());
                detail.run_reference(view.run().run_id());
                detail.graph = Some(public_graph(view.graph()));
                detail.set_outcome(Outcome::Read);
            }
            Self::Unavailable(_) => detail.set_outcome(Outcome::Unavailable),
        }
    }
}

impl AuditOutcome for crate::TeamRunDiagnosticsQueryOutcome {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        detail.set_outcome(match self {
            Self::Available(_) => Outcome::Read,
            Self::Unavailable(_) => Outcome::Unavailable,
        });
    }
}

impl AuditOutcome for crate::run::TeamPendingApprovalsQueryOutcome {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        detail.set_outcome(match self {
            Self::Available(_) => Outcome::Read,
            Self::Unavailable => Outcome::Unavailable,
        });
    }
}

impl AuditOutcome for NodePromptRetryDueQueryOutcome {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        detail.set_outcome(match self {
            Self::Available(_) => Outcome::Read,
            Self::Unknown(_) => Outcome::OutcomeUnknown,
            Self::Invalid(_) => Outcome::Rejected,
        });
    }
}

macro_rules! reads {
    ($($ty:ty),+ $(,)?) => { $(impl AuditOutcome for $ty {
        fn summarize(&self, detail: &mut OrganizationCallDetail) { detail.set_outcome(Outcome::Read); }
    })+ };
}
reads!(
    crate::GraphDefinition,
    String,
    TaskBoardFacts,
    crate::RoleSessionReceipt,
    crate::owner::team_run::ArmedTrigger
);

impl AuditOutcome for crate::ResumeOutcome {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        detail.set_outcome(match self {
            Self::OutcomeUnknown(_) => Outcome::OutcomeUnknown,
            _ => Outcome::CommandCommitted,
        });
    }
}

impl AuditOutcome for crate::TeamRuntimeControlOutcome {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        match self {
            Self::Succeeded(_) => {}
            Self::Unknown(_) => detail.set_outcome(Outcome::OutcomeUnknown),
            Self::InvalidInput | Self::Failed(_) => detail.set_outcome(Outcome::Rejected),
            Self::Unavailable => detail.set_outcome(Outcome::Unavailable),
        }
    }
}

impl AuditOutcome for crate::adapters::loopback::graph::Delivery {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        let outcome = match self {
            Self::Exported { run_id, .. } => {
                detail.run_reference(run_id);
                Outcome::Read
            }
            Self::Replaced { run_id } => {
                detail.run_reference(run_id);
                Outcome::CommandCommitted
            }
            Self::Unavailable => Outcome::Unavailable,
            Self::Rejected => Outcome::Rejected,
        };
        detail.set_outcome(outcome);
    }
}

impl AuditOutcome for crate::TeamRuntimeCommandOutcome {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        use crate::TeamRuntimeCommandOutcome::*;
        match self {
            PackageValidate(value) => value.summarize(detail),
            DependencyPlan(value) => value.summarize(detail),
            ProvisionAgents(value) => value.summarize(detail),
            Delete(value) => value.summarize(detail),
            RunCreate(value) => value.summarize(detail),
            RunList(value) => value.summarize(detail),
            TriggerList(value) => value.summarize(detail),
            WebhookTriggerFire(value) => value.summarize(detail),
            RunSnapshot { snapshot, .. } => snapshot.summarize(detail),
            RunSnapshotInvalidInput => detail.set_outcome(Outcome::Rejected),
            GraphSave(value) | GraphPatch(value) | GraphImportYaml(value) => {
                value.summarize(detail)
            }
            GraphContext(value) => value.summarize(detail),
            GraphExportYaml(value) => value.summarize(detail),
            TriggerFire(value) => value.summarize(detail),
            RunStartConfirm(value) => value.summarize(detail),
            RunStartContinue(value) => value.summarize(detail),
            NodePromptRetryDue(value) => value.summarize(detail),
            NodeEvent(value) => value.summarize(detail),
            RunDiagnostics(value) => value.summarize(detail),
            RunDecisionSubmit(value) => value.summarize(detail),
            Resume { outcomes, .. } => outcomes.summarize(detail),
            ApprovalResolve(value) => value.summarize(detail),
            RunCancel(value) => value.summarize(detail),
            RunDelete(value) => value.summarize(detail),
        }
    }
}

impl AuditOutcome for crate::application::team_runtime::TeamNodeEventCommandOutcome {
    fn summarize(&self, detail: &mut OrganizationCallDetail) {
        match self {
            Self::NonTerminal(value) => value.summarize(detail),
            Self::Terminal(value) => value.summarize(detail),
        }
    }
}
