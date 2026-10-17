use crate::{
    client::{Client, Delivery},
    session::{
        interaction as native,
        rpc::{self, Failure, FailureKind},
    },
};
use serde_json::json;
use sessions_module::{
    approval::{
        PendingApproval, PendingApprovals, PendingApprovalsCommand, PendingApprovalsOutcome,
        SessionApprovalCommand, SessionApprovalOutcome,
    },
    question::{
        PendingQuestionsCommand, PendingQuestionsOutcome, QuestionAvailability, QuestionDelivery,
        QuestionTarget, SessionQuestionCommand, SessionQuestionOutcome,
    },
};

pub(super) async fn questions(
    client: &Client,
    command: PendingQuestionsCommand,
) -> PendingQuestionsOutcome {
    if command.validate().is_err() {
        return PendingQuestionsOutcome::TargetRejected;
    }
    let result = async {
        let record = rpc::bound(
            client,
            &command.identity,
            Some(&command.endpoint_session_id),
        )
        .await?;
        native::list_questions(client, record.session_id.as_str()).await
    }
    .await;
    match result {
        Ok(questions) => PendingQuestionsOutcome::Listed { questions },
        Err(error) => match error.kind() {
            FailureKind::Rejected => PendingQuestionsOutcome::TargetRejected,
            FailureKind::Unknown => PendingQuestionsOutcome::Unknown,
            _ => PendingQuestionsOutcome::Unavailable,
        },
    }
}
pub(super) async fn answer(
    client: &Client,
    command: SessionQuestionCommand,
) -> SessionQuestionOutcome {
    if command.validate().is_err() {
        return SessionQuestionOutcome::rejected();
    }
    if let Err(error) =
        rpc::bound(client, &command.identity, Some(&command.target.session_id)).await
    {
        return question_failure(error, &command.target, false);
    }
    match native::respond_to_question(client, command.target.clone(), command.answer).await {
        Ok(receipt) => SessionQuestionOutcome::Responded { receipt },
        Err(error) => question_failure(error.failure, &command.target, error.attempted),
    }
}
fn question_failure(
    error: Failure,
    target: &QuestionTarget,
    attempted: bool,
) -> SessionQuestionOutcome {
    let receipt = error.data().and_then(|data| native::receipt(data, target));
    let response_attempt_delivery = if !attempted {
        Some(QuestionDelivery::NotSent)
    } else {
        error
            .data()
            .and_then(|data| data.get("responseAttemptDelivery"))
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok())
            .or_else(|| match error.delivery() {
                Some(Delivery::NotSent) => Some(QuestionDelivery::NotSent),
                Some(Delivery::Unknown) => Some(QuestionDelivery::Unknown),
                _ => Some(QuestionDelivery::Unknown),
            })
    };
    match error.kind() {
        FailureKind::Rejected => SessionQuestionOutcome::TargetRejected {
            receipt,
            response_attempt_delivery,
        },
        FailureKind::Unknown => SessionQuestionOutcome::Unknown {
            receipt,
            response_attempt_delivery,
        },
        _ => SessionQuestionOutcome::Unavailable {
            receipt,
            response_attempt_delivery,
        },
    }
}

pub(super) async fn approvals(
    client: &Client,
    command: PendingApprovalsCommand,
) -> PendingApprovalsOutcome {
    if command.endpoint != sessions_module::send::NativeEndpoint::MatchaAgentLocal {
        return PendingApprovalsOutcome::Unsupported;
    }
    let result = async {
        rpc::get(client, &command.session_id, None).await?;
        native::pending(client, &command.session_id, "approvals")
            .await?
            .iter()
            .filter(|item| {
                item.availability == QuestionAvailability::Pending
                    && item.delivery == QuestionDelivery::NotSent
            })
            .map(|item| {
                Ok(PendingApproval {
                    approval_id: item.approval_id()?,
                    option_ids: vec!["allow".into(), "deny".into()],
                })
            })
            .collect::<Result<Vec<_>, Failure>>()
    }
    .await;
    match result {
        Ok(approvals) => PendingApprovalsOutcome::Found(PendingApprovals { approvals }),
        Err(error) => match error.kind() {
            FailureKind::Rejected => PendingApprovalsOutcome::Rejected,
            FailureKind::Unknown => PendingApprovalsOutcome::Unknown,
            _ => PendingApprovalsOutcome::Unavailable,
        },
    }
}
pub(super) async fn approve(
    client: &Client,
    command: SessionApprovalCommand,
) -> SessionApprovalOutcome {
    if command.endpoint != sessions_module::send::NativeEndpoint::MatchaAgentLocal {
        return SessionApprovalOutcome::Unsupported;
    }
    let result=async {
        rpc::get(client,&command.session_id,None).await?;
        let items=native::pending(client,&command.session_id,"approvals").await?;
        let item=items.iter().find(|item|item.approval_id().ok().as_deref()==Some(command.approval_id.as_str())).ok_or(Failure::InvalidInput)?;
        if item.availability != QuestionAvailability::Pending || item.delivery != QuestionDelivery::NotSent { return Err(Failure::InvalidInput); }
        let target=item.target();
        let decision=match command.option_id.as_str(){
            "allow"=>json!({"behavior":"allow","decisionClassification":"user_temporary"}),
            "deny"=>json!({"behavior":"deny","message":"Permission denied by user","interrupt":false,"decisionClassification":"user_reject"}),
            _=>return Err(Failure::InvalidInput),
        };
        let value=rpc::call(client,"approvals.respond",json!({"sessionId":target.session_id,"instanceId":target.instance_id,"nativeRequestId":target.native_request_id,"response":{"type":"permission","decision":decision}})).await?;
        let receipt=native::receipt(&value,&target).ok_or(Failure::InvalidReadback)?;
        if receipt.delivery!=QuestionDelivery::Sent {return Err(Failure::InvalidReadback);}Ok(())
    }.await;
    match result {
        Ok(()) => SessionApprovalOutcome::Responded,
        Err(error) => match error.kind() {
            FailureKind::Rejected => SessionApprovalOutcome::Rejected,
            FailureKind::Unknown => SessionApprovalOutcome::Unknown,
            _ => SessionApprovalOutcome::Unavailable,
        },
    }
}
