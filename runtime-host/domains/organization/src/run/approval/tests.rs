use super::{
    Approval, ApprovalDecision, ApprovalDurableSnapshot, ApprovalEffect, ApprovalOrigin,
    ApprovalRequest, ApprovalResolutionCause, ApprovalResolutionInput, ApprovalRestoreError,
    ApprovalStatus, ApprovalSubject, ResolveApprovalError, abort_pending_approvals,
    resolve_approval,
};

fn request(approval_id: &str) -> ApprovalRequest {
    ApprovalRequest {
        approval_id: approval_id.to_owned(),
        run_id: "run-01".to_owned(),
        stage_id: "stage-review".to_owned(),
        role_id: "role-lead".to_owned(),
        reason: "A deployment requires review.".to_owned(),
        requested_action: "Deploy release candidate".to_owned(),
        risk_summary: "Production traffic may be affected.".to_owned(),
        idempotency_key: "command-01".to_owned(),
        requested_at: 1_000,
        subject: ApprovalSubject::Stage {
            stage_id: "stage-review".to_owned(),
        },
        origin: ApprovalOrigin::StageContinuation,
        effect: ApprovalEffect::ResumeStage,
        execution_fence: None,
    }
}

#[test]
fn durable_work_node_approval_replays_its_resolution_without_completing_the_node() {
    let mut approval = Approval::request(ApprovalRequest {
        subject: ApprovalSubject::WorkNode {
            node_id: "node-review".to_owned(),
        },
        origin: ApprovalOrigin::WorkNode,
        effect: ApprovalEffect::KeepNodeWaiting,
        execution_fence: Some("node-review:attempt-2".to_owned()),
        ..request("approval-work-node")
    });

    approval
        .resolve_with_receipt(
            ApprovalDecision::Approve,
            2_000,
            Some("Approved by lead.".to_owned()),
            "resolve-work-node-01".to_owned(),
            ApprovalResolutionCause::HumanDecision,
        )
        .unwrap();
    let restored = Approval::restore(approval.durable_snapshot()).unwrap();

    assert_eq!(restored, approval);
    assert_eq!(restored.facts().origin, ApprovalOrigin::WorkNode);
    assert_eq!(restored.facts().effect, ApprovalEffect::KeepNodeWaiting);
    assert_eq!(
        restored.facts().execution_fence.as_deref(),
        Some("node-review:attempt-2")
    );
    assert_eq!(
        restored.resolution().unwrap().idempotency_key,
        "resolve-work-node-01"
    );
    assert_eq!(
        restored.resolution().unwrap().cause,
        ApprovalResolutionCause::HumanDecision
    );
}

#[test]
fn durable_resolution_history_survives_restore_with_the_latest_terminal_projection() {
    let mut approval = Approval::request(request("approval-01"));
    approval
        .resolve_with_receipt(
            ApprovalDecision::Approve,
            2_000,
            Some("Approved.".to_owned()),
            "resolve-01".to_owned(),
            ApprovalResolutionCause::HumanDecision,
        )
        .unwrap();
    approval
        .resolve_with_receipt(
            ApprovalDecision::Deny,
            3_000,
            Some("Denied after review.".to_owned()),
            "resolve-02".to_owned(),
            ApprovalResolutionCause::HumanDecision,
        )
        .unwrap();

    let restored = Approval::restore(approval.durable_snapshot()).unwrap();

    assert_eq!(restored.status(), ApprovalStatus::Denied);
    assert_eq!(restored.resolutions().len(), 2);
    assert_eq!(
        restored.resolutions()[0].decision,
        ApprovalDecision::Approve
    );
    assert_eq!(
        restored.resolution().unwrap().decision,
        ApprovalDecision::Deny
    );
    assert_eq!(restored.resolution().unwrap().idempotency_key, "resolve-02");
}

#[test]
fn durable_snapshot_rejects_noncanonical_teamrun_approval_facts() {
    let cases = [
        ApprovalDurableSnapshot {
            facts: ApprovalRequest {
                stage_id: String::new(),
                ..request("approval-empty-stage")
            },
            status: ApprovalStatus::Pending,
            resolutions: Vec::new(),
        },
        ApprovalDurableSnapshot {
            facts: ApprovalRequest {
                reason: String::new(),
                ..request("approval-empty-reason")
            },
            status: ApprovalStatus::Pending,
            resolutions: Vec::new(),
        },
        ApprovalDurableSnapshot {
            facts: ApprovalRequest {
                requested_action: String::new(),
                ..request("approval-empty-action")
            },
            status: ApprovalStatus::Pending,
            resolutions: Vec::new(),
        },
        ApprovalDurableSnapshot {
            facts: ApprovalRequest {
                risk_summary: String::new(),
                ..request("approval-empty-risk")
            },
            status: ApprovalStatus::Pending,
            resolutions: Vec::new(),
        },
    ];

    for snapshot in cases {
        assert_eq!(
            Approval::restore(snapshot),
            Err(ApprovalRestoreError::InvalidSnapshot)
        );
    }
}

#[test]
fn durable_snapshot_rejects_subject_origin_and_effect_that_do_not_describe_the_same_graph_fact() {
    let cases = [
        ApprovalDurableSnapshot {
            facts: ApprovalRequest {
                subject: ApprovalSubject::Stage {
                    stage_id: "stage-other".to_owned(),
                },
                ..request("approval-stage-mismatch")
            },
            status: ApprovalStatus::Pending,
            resolutions: Vec::new(),
        },
        ApprovalDurableSnapshot {
            facts: ApprovalRequest {
                subject: ApprovalSubject::WorkNode {
                    node_id: "node-review".to_owned(),
                },
                ..request("approval-work-node-mismatch")
            },
            status: ApprovalStatus::Pending,
            resolutions: Vec::new(),
        },
        ApprovalDurableSnapshot {
            facts: ApprovalRequest {
                subject: ApprovalSubject::HumanDecision {
                    node_id: "node-review".to_owned(),
                },
                ..request("approval-human-decision-mismatch")
            },
            status: ApprovalStatus::Pending,
            resolutions: Vec::new(),
        },
    ];

    for snapshot in cases {
        assert_eq!(
            Approval::restore(snapshot),
            Err(ApprovalRestoreError::InvalidSnapshot)
        );
    }
}

#[test]
fn requested_approval_starts_pending_without_a_resolution() {
    let approval = Approval::request(request("approval-01"));

    assert_eq!(approval.status(), ApprovalStatus::Pending);
    assert!(approval.is_pending());
    assert!(!approval.is_terminal());
    assert_eq!(approval.resolution(), None);
    assert_eq!(approval.facts().run_id, "run-01");
    assert_eq!(approval.facts().stage_id, "stage-review");
    assert_eq!(approval.facts().role_id, "role-lead");
}

#[test]
fn pending_approval_resolves_to_each_terminal_status() {
    let cases = [
        (ApprovalDecision::Approve, ApprovalStatus::Approved),
        (ApprovalDecision::Deny, ApprovalStatus::Denied),
        (ApprovalDecision::Abort, ApprovalStatus::Aborted),
    ];

    for (decision, expected_status) in cases {
        let mut approval = Approval::request(request("approval-01"));

        approval
            .resolve(decision, 2_000, Some("Reviewed by lead.".to_owned()))
            .unwrap();

        assert_eq!(approval.status(), expected_status);
        assert!(!approval.is_pending());
        assert!(approval.is_terminal());
        assert_eq!(approval.resolution().unwrap().decision, decision,);
        assert_eq!(approval.resolution().unwrap().resolved_at, 2_000);
        assert_eq!(
            approval.resolution().unwrap().note.as_deref(),
            Some("Reviewed by lead."),
        );
    }
}

#[test]
fn terminal_approval_accepts_later_decisions_as_append_only_resolution_history() {
    let mut approval = Approval::request(request("approval-01"));
    approval
        .resolve_with_receipt(
            ApprovalDecision::Deny,
            2_000,
            Some("Outside the release window.".to_owned()),
            "resolve-01".to_owned(),
            ApprovalResolutionCause::HumanDecision,
        )
        .unwrap();
    approval
        .resolve_with_receipt(
            ApprovalDecision::Approve,
            3_000,
            None,
            "resolve-02".to_owned(),
            ApprovalResolutionCause::HumanDecision,
        )
        .unwrap();

    assert_eq!(approval.status(), ApprovalStatus::Approved);
    assert_eq!(approval.facts().requested_at, 1_000);
    assert_eq!(approval.resolutions().len(), 2);
    assert_eq!(approval.resolutions()[0].decision, ApprovalDecision::Deny);
    assert_eq!(
        approval.resolution().unwrap().decision,
        ApprovalDecision::Approve
    );
    assert_eq!(approval.resolution().unwrap().resolved_at, 3_000);
    assert_eq!(
        approval.resolution().unwrap().note.as_deref(),
        Some("Outside the release window."),
    );
}

#[test]
fn resolving_an_unknown_approval_fails_closed_without_creating_a_placeholder() {
    let mut approvals = vec![Approval::request(request("approval-01"))];

    assert_eq!(
        resolve_approval(
            &mut approvals,
            ApprovalResolutionInput {
                approval_id: "approval-missing".to_owned(),
                run_id: "run-01".to_owned(),
                stage_id: "stage-custom".to_owned(),
                role_id: "role-custom".to_owned(),
                decision: ApprovalDecision::Approve,
                resolved_at: 2_000,
                note: Some("Approved.".to_owned()),
                idempotency_key: "resolution-key".to_owned(),
            },
        ),
        Err(ResolveApprovalError::UnknownApproval)
    );
    assert_eq!(approvals, vec![Approval::request(request("approval-01"))]);
}

#[test]
fn approval_resolution_replays_only_the_exact_idempotency_receipt() {
    let mut approvals = vec![Approval::request(request("approval-01"))];
    resolve_approval(
        &mut approvals,
        ApprovalResolutionInput {
            approval_id: "approval-01".to_owned(),
            run_id: "run-01".to_owned(),
            stage_id: "stage-review".to_owned(),
            role_id: "role-lead".to_owned(),
            decision: ApprovalDecision::Approve,
            resolved_at: 2_000,
            note: Some("Approved.".to_owned()),
            idempotency_key: "resolution-key".to_owned(),
        },
    )
    .unwrap();
    resolve_approval(
        &mut approvals,
        ApprovalResolutionInput {
            approval_id: "approval-01".to_owned(),
            run_id: "run-01".to_owned(),
            stage_id: "stage-review".to_owned(),
            role_id: "role-lead".to_owned(),
            decision: ApprovalDecision::Approve,
            resolved_at: 2_000,
            note: Some("Approved.".to_owned()),
            idempotency_key: "resolution-key".to_owned(),
        },
    )
    .unwrap();

    assert_eq!(approvals[0].status(), ApprovalStatus::Approved);
    assert_eq!(approvals[0].resolutions().len(), 1);
    assert_eq!(
        resolve_approval(
            &mut approvals,
            ApprovalResolutionInput {
                approval_id: "approval-01".to_owned(),
                run_id: "run-01".to_owned(),
                stage_id: "stage-review".to_owned(),
                role_id: "role-lead".to_owned(),
                decision: ApprovalDecision::Deny,
                resolved_at: 3_000,
                note: None,
                idempotency_key: "resolution-key".to_owned(),
            },
        ),
        Err(ResolveApprovalError::ConflictingIdempotencyKey)
    );
    assert_eq!(approvals[0].status(), ApprovalStatus::Approved);
    assert_eq!(approvals[0].resolutions().len(), 1);
}

#[test]
fn approval_debug_redacts_human_facts_and_notes() {
    let mut approval = Approval::request(request("approval-01"));
    approval
        .resolve_with_receipt(
            ApprovalDecision::Approve,
            2_000,
            Some("canary-secret-note".to_owned()),
            "resolution-key".to_owned(),
            ApprovalResolutionCause::HumanDecision,
        )
        .unwrap();

    let rendered = format!("{approval:?}");
    for canary in [
        "A deployment requires review.",
        "Deploy release candidate",
        "Production traffic may be affected.",
        "canary-secret-note",
    ] {
        assert!(!rendered.contains(canary));
    }
}

#[test]
fn aborting_pending_approvals_preserves_existing_terminal_decisions() {
    let mut approvals = vec![
        Approval::request(request("approval-pending")),
        Approval::request(request("approval-approved")),
    ];
    resolve_approval(
        &mut approvals,
        ApprovalResolutionInput {
            approval_id: "approval-approved".to_owned(),
            run_id: "run-01".to_owned(),
            stage_id: "stage-review".to_owned(),
            role_id: "role-lead".to_owned(),
            decision: ApprovalDecision::Approve,
            resolved_at: 2_000,
            note: Some("Approved.".to_owned()),
            idempotency_key: "resolve-approved".to_owned(),
        },
    )
    .unwrap();

    let aborted = abort_pending_approvals(&mut approvals, 3_000, Some("TeamRun cancelled."));

    assert_eq!(aborted, 1);
    assert_eq!(approvals[0].status(), ApprovalStatus::Aborted);
    assert_eq!(approvals[0].resolution().unwrap().resolved_at, 3_000);
    assert_eq!(
        approvals[0].resolution().unwrap().note.as_deref(),
        Some("TeamRun cancelled."),
    );
    assert_eq!(approvals[1].status(), ApprovalStatus::Approved);
    assert_eq!(approvals[1].resolution().unwrap().resolved_at, 2_000);
}

#[test]
fn aborting_terminal_approvals_is_a_no_op() {
    let mut approvals = vec![Approval::request(request("approval-01"))];
    resolve_approval(
        &mut approvals,
        ApprovalResolutionInput {
            approval_id: "approval-01".to_owned(),
            run_id: "run-01".to_owned(),
            stage_id: "stage-review".to_owned(),
            role_id: "role-lead".to_owned(),
            decision: ApprovalDecision::Deny,
            resolved_at: 2_000,
            note: Some("Rejected.".to_owned()),
            idempotency_key: "resolve-denied".to_owned(),
        },
    )
    .unwrap();

    assert_eq!(abort_pending_approvals(&mut approvals, 3_000, None), 0);
    assert_eq!(approvals[0].status(), ApprovalStatus::Denied);
    assert_eq!(approvals[0].resolution().unwrap().resolved_at, 2_000);
}
