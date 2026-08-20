use serde::Serialize;

use crate::{ApprovalStatus, GraphRunId, OrganizationFacts, TeamId};

/// The fixed renderer projection for TeamRun approvals. It intentionally omits approval notes,
/// resolution history, native session data, workspace bindings, and command/effect receipts.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamPendingApprovals {
    team_id: String,
    run_id: String,
    approvals: Vec<TeamPendingApproval>,
}

impl TeamPendingApprovals {
    pub fn team_id(&self) -> &str {
        &self.team_id
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn approvals(&self) -> &[TeamPendingApproval] {
        &self.approvals
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamPendingApproval {
    approval_id: String,
    stage_id: String,
    role_id: String,
    reason: String,
    requested_action: String,
    created_at: u64,
}

impl TeamPendingApproval {
    pub fn approval_id(&self) -> &str {
        &self.approval_id
    }

    pub fn stage_id(&self) -> &str {
        &self.stage_id
    }

    pub fn role_id(&self) -> &str {
        &self.role_id
    }

    pub fn reason(&self) -> &str {
        &self.reason
    }

    pub fn requested_action(&self) -> &str {
        &self.requested_action
    }

    pub const fn created_at(&self) -> u64 {
        self.created_at
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TeamPendingApprovalsQueryOutcome {
    Available(TeamPendingApprovals),
    Unavailable,
}

pub fn query_team_pending_approvals(
    facts: &OrganizationFacts,
    team_id: &TeamId,
    run_id: &GraphRunId,
) -> TeamPendingApprovalsQueryOutcome {
    let Some(team) = facts.team(team_id) else {
        return TeamPendingApprovalsQueryOutcome::Unavailable;
    };
    let Some(run) = facts.run(run_id) else {
        return TeamPendingApprovalsQueryOutcome::Unavailable;
    };
    if team.tombstoned() || run.team() != team_id {
        return TeamPendingApprovalsQueryOutcome::Unavailable;
    }

    let approvals = facts
        .approvals()
        .filter(|approval| {
            approval.facts().run_id == run_id.as_str()
                && approval.status() == ApprovalStatus::Pending
        })
        .map(|approval| {
            let facts = approval.facts();
            TeamPendingApproval {
                approval_id: facts.approval_id.clone(),
                stage_id: facts.stage_id.clone(),
                role_id: facts.role_id.clone(),
                reason: facts.reason.clone(),
                requested_action: facts.requested_action.clone(),
                created_at: facts.requested_at,
            }
        })
        .collect();

    TeamPendingApprovalsQueryOutcome::Available(TeamPendingApprovals {
        team_id: team_id.as_str().to_owned(),
        run_id: run_id.as_str().to_owned(),
        approvals,
    })
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroU32;

    use crate::{
        Approval, ApprovalDecision, ApprovalRequest, DeliveryLedger, GraphDefinition,
        GraphRunFacts, GraphRunId, GraphState, MemberId, NodeDefinition, NodeId, OrganizationFacts,
        RoleAssignment, RoleId, RoleKind, TeamDefinition, TeamFacts, TeamId, TeamMember,
        TeamRevision, TeamRole, WorkAssignment,
    };

    use crate::store::TeamRunFactsRestoreInput;

    use crate::run::{
        approval::ApprovalResolutionCause,
        event::{EventLedger, OpaqueId},
    };

    use super::*;

    #[test]
    fn pending_approvals_are_redacted_to_the_fixed_renderer_projection() {
        let projection = available(facts(false));

        assert_eq!(projection.team_id(), "team:one");
        assert_eq!(projection.run_id(), "run:one");
        assert_eq!(projection.approvals().len(), 1);
        let approval = &projection.approvals()[0];
        assert_eq!(approval.approval_id(), "approval:pending");
        assert_eq!(approval.stage_id(), "stage:one");
        assert_eq!(approval.role_id(), "writer");
        assert_eq!(approval.reason(), "Review required");
        assert_eq!(approval.requested_action(), "Approve publication");
        assert_eq!(approval.created_at(), 7);

        let serialized = serde_json::to_string(&projection).unwrap();
        let document: serde_json::Value = serde_json::from_str(&serialized).unwrap();
        assert_eq!(document.as_object().unwrap().len(), 3);
        assert_eq!(document["approvals"][0].as_object().unwrap().len(), 6);
        for omitted in [
            "riskSummary",
            "idempotencyKey",
            "subject",
            "origin",
            "effect",
            "executionFence",
            "note",
            "resolution",
            "workspace",
            "session",
            "receipt",
        ] {
            assert!(!serialized.contains(omitted));
        }
        for private in [
            "private risk summary",
            "private idempotency key",
            "private execution fence",
            "private resolution note",
        ] {
            assert!(!serialized.contains(private));
        }
    }

    #[test]
    fn query_is_unavailable_for_missing_tombstoned_or_foreign_team_run() {
        let organization = facts(false);
        assert_eq!(
            query_team_pending_approvals(
                &organization,
                &TeamId::try_new("team:missing").unwrap(),
                &GraphRunId::new("run:one"),
            ),
            TeamPendingApprovalsQueryOutcome::Unavailable
        );
        assert_eq!(
            query_team_pending_approvals(
                &organization,
                &TeamId::try_new("team:two").unwrap(),
                &GraphRunId::new("run:one"),
            ),
            TeamPendingApprovalsQueryOutcome::Unavailable
        );
        assert_eq!(
            query_team_pending_approvals(&facts(true), &team(), &GraphRunId::new("run:one")),
            TeamPendingApprovalsQueryOutcome::Unavailable
        );
    }

    fn available(facts: OrganizationFacts) -> TeamPendingApprovals {
        match query_team_pending_approvals(&facts, &team(), &GraphRunId::new("run:one")) {
            TeamPendingApprovalsQueryOutcome::Available(projection) => projection,
            TeamPendingApprovalsQueryOutcome::Unavailable => {
                panic!("expected available projection")
            }
        }
    }

    fn facts(tombstoned: bool) -> OrganizationFacts {
        let mut resolved = Approval::request(approval("approval:resolved", "run:one"));
        resolved
            .resolve_with_receipt(
                ApprovalDecision::Approve,
                8,
                Some("private resolution note".to_owned()),
                "resolution:key".to_owned(),
                ApprovalResolutionCause::HumanDecision,
            )
            .unwrap();
        OrganizationFacts::restore_with_teamrun_ledgers(TeamRunFactsRestoreInput {
            teams: vec![TeamFacts::new(
                team_definition(),
                TeamRevision::initial(),
                tombstoned,
            )],
            materializations: Vec::new(),
            runs: vec![
                GraphRunFacts::new(team(), TeamRevision::initial(), graph("run:one"), None)
                    .unwrap(),
                GraphRunFacts::new(team(), TeamRevision::initial(), graph("run:other"), None)
                    .unwrap(),
            ],
            deliveries: DeliveryLedger::default().snapshot(),
            pending_workflow_plan_admissions: Vec::new(),
            templates: Vec::new(),
            triggers: Vec::new(),
            control_resolutions: Vec::new(),
            approvals: vec![
                Approval::request(approval("approval:pending", "run:one")).durable_snapshot(),
                resolved.durable_snapshot(),
                Approval::request(approval("approval:foreign", "run:other")).durable_snapshot(),
            ],
            events: resolved_events(),
            evidence: Vec::new(),
        })
        .unwrap()
    }

    fn resolved_events() -> crate::run::event::EventLedgerSnapshot {
        let mut events = EventLedger::default();
        events
            .append_approval_resolution(
                OpaqueId::try_new("run:one").unwrap(),
                OpaqueId::try_new("approval:resolved").unwrap(),
                ApprovalDecision::Approve,
                OpaqueId::try_new("resolution:key").unwrap(),
                8,
            )
            .unwrap();
        events.snapshot()
    }

    fn approval(approval_id: &str, run_id: &str) -> ApprovalRequest {
        ApprovalRequest {
            approval_id: approval_id.to_owned(),
            run_id: run_id.to_owned(),
            stage_id: "stage:one".to_owned(),
            role_id: "writer".to_owned(),
            reason: "Review required".to_owned(),
            requested_action: "Approve publication".to_owned(),
            risk_summary: "private risk summary".to_owned(),
            idempotency_key: "private idempotency key".to_owned(),
            requested_at: 7,
            subject: crate::ApprovalSubject::Stage {
                stage_id: "stage:one".to_owned(),
            },
            origin: crate::ApprovalOrigin::StageContinuation,
            effect: crate::ApprovalEffect::ResumeStage,
            execution_fence: None,
        }
    }

    fn team() -> TeamId {
        TeamId::try_new("team:one").unwrap()
    }

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
            team(),
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

    fn graph(run_id: &str) -> GraphState {
        GraphState::initialize(
            GraphDefinition::new(
                "graph:one",
                "plan:one",
                GraphRunId::new(run_id),
                "Approval graph",
                vec![NodeDefinition::work(
                    NodeId::new("stage:one"),
                    "Review",
                    NonZeroU32::new(1).unwrap(),
                    WorkAssignment::new("task:one", "writer"),
                )],
                Vec::new(),
            )
            .unwrap(),
            1,
        )
    }
}
