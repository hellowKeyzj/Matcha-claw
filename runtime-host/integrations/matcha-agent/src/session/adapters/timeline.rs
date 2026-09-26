use super::*;
use sessions_module::state::{
    ApprovalPhase, ApprovalView, ItemStatus, MissingFact, OmissionReason, RunPhase, RuntimeView,
    SessionCompleteness, SessionContent, SessionFact, SessionIdentity, SessionItem,
    SessionProvider, SessionView, SessionWindow, ToolPhase, ToolView,
};

pub(super) async fn load_matcha_timeline(
    session: MatchaPeerSessionHandle,
    command: session_timeline::Command,
    epoch: u64,
) -> session_timeline::Outcome {
    let Some(session_id) = matcha_native_session_id(command.endpoint_session_id()) else {
        return session_timeline::Outcome::unavailable(
            session_timeline::UnavailableReason::MatchaMissingNativeSessionId,
        );
    };
    let mode = match command.direction() {
        session_timeline::Direction::Latest => HydrationWindowMode::Latest,
        session_timeline::Direction::Older => HydrationWindowMode::Older,
        session_timeline::Direction::Newer => HydrationWindowMode::Newer,
    };
    let request = HydrationWindowRequest::new(mode, command.limit(), command.offset());
    let local_history = session
        .load_local_history(session_id.clone(), request)
        .await;
    match local_history {
        HistoryResult::Complete(snapshot) => {
            let Some(identity) = SessionIdentity::new(
                command.session_key().to_owned(),
                SessionProvider::MatchaAgent,
                command.agent_id().map(str::to_owned),
            ) else {
                return session_timeline::Outcome::unavailable(
                    session_timeline::UnavailableReason::MatchaIdentityInvalid,
                );
            };
            return project_matcha_hydration_view(
                &identity,
                command.endpoint_session_id().map(str::to_owned),
                &snapshot,
                epoch,
            )
            .map(session_timeline::Outcome::Incomplete)
            .unwrap_or_else(|| {
                session_timeline::Outcome::unavailable(
                    session_timeline::UnavailableReason::MatchaProjectionInvalid,
                )
            });
        }
        HistoryResult::Incomplete(reason) => {
            return session_timeline::Outcome::unavailable_with_diagnostic(
                session_timeline::UnavailableReason::MatchaReadIncomplete,
                matcha_hydration_diagnostic("matcha.local-history", reason),
            );
        }
        HistoryResult::Unknown => {
            return session_timeline::Outcome::unavailable(
                session_timeline::UnavailableReason::MatchaReadUnknown,
            );
        }
        HistoryResult::NotFound | HistoryResult::Unavailable => {}
    }
    let facts = match session.read_canonical_session(session_id, request).await {
        HistoryResult::Complete(facts) => facts,
        HistoryResult::Incomplete(reason) => {
            return session_timeline::Outcome::unavailable_with_diagnostic(
                session_timeline::UnavailableReason::MatchaReadIncomplete,
                matcha_hydration_diagnostic("matcha.canonical", reason),
            );
        }
        HistoryResult::NotFound => {
            return session_timeline::Outcome::unavailable(
                session_timeline::UnavailableReason::MatchaReadNotFound,
            );
        }
        HistoryResult::Unavailable => {
            return session_timeline::Outcome::unavailable(
                session_timeline::UnavailableReason::MatchaReadUnavailable,
            );
        }
        HistoryResult::Unknown => {
            return session_timeline::Outcome::unavailable(
                session_timeline::UnavailableReason::MatchaReadUnknown,
            );
        }
    };
    let Some(identity) = SessionIdentity::new(
        command.session_key().to_owned(),
        SessionProvider::MatchaAgent,
        command.agent_id().map(str::to_owned),
    ) else {
        return session_timeline::Outcome::unavailable(
            session_timeline::UnavailableReason::MatchaIdentityInvalid,
        );
    };
    project_matcha_view(
        &identity,
        command.endpoint_session_id().map(str::to_owned),
        &facts,
        epoch,
    )
    .map(session_timeline::Outcome::Incomplete)
    .unwrap_or_else(|| {
        session_timeline::Outcome::unavailable(
            session_timeline::UnavailableReason::MatchaProjectionInvalid,
        )
    })
}

pub(super) async fn load_matcha_content(
    session: MatchaPeerSessionHandle,
    command: session_timeline::ContentCommand,
) -> session_timeline::ContentOutcome {
    let Some(session_id) = matcha_native_session_id(command.endpoint_session_id()) else {
        return session_timeline::ContentOutcome::unavailable(
            session_timeline::UnavailableReason::MatchaMissingNativeSessionId,
        );
    };
    match session
        .load_local_history_content(
            session_id,
            command.content_ref().to_owned(),
            command.offset(),
            command.limit(),
        )
        .await
    {
        HistoryResult::Complete(chunk) => {
            session_timeline::ContentOutcome::Complete(session_timeline::ContentChunk {
                content_ref: chunk.content_ref().to_owned(),
                offset: chunk.offset(),
                text: chunk.text().to_owned(),
                next_offset: chunk.next_offset(),
                total_bytes: chunk.total_bytes(),
                complete: chunk.complete(),
            })
        }
        HistoryResult::NotFound => session_timeline::ContentOutcome::unavailable(
            session_timeline::UnavailableReason::MatchaReadNotFound,
        ),
        HistoryResult::Unavailable => session_timeline::ContentOutcome::unavailable(
            session_timeline::UnavailableReason::MatchaReadUnavailable,
        ),
        HistoryResult::Unknown | HistoryResult::Incomplete(_) => {
            session_timeline::ContentOutcome::unavailable(
                session_timeline::UnavailableReason::MatchaReadUnknown,
            )
        }
    }
}

fn matcha_native_session_id(endpoint_session_id: Option<&str>) -> Option<SessionId> {
    SessionId::try_new(endpoint_session_id?.to_owned()).ok()
}

fn matcha_hydration_diagnostic(
    source: &'static str,
    reason: crate::session::hydration::HydrationIncomplete,
) -> session_timeline::UnavailableDiagnostic {
    let rejection = reason.transcript_rejection();
    session_timeline::UnavailableDiagnostic::new(
        source,
        rejection.and_then(|rejection| rejection.message_index()),
        rejection.and_then(|rejection| rejection.block_index()),
        rejection.and_then(|rejection| rejection.block_type()),
        rejection
            .map(|rejection| rejection.field())
            .unwrap_or("hydration"),
        rejection
            .map(|rejection| rejection.reason())
            .unwrap_or_else(|| matcha_hydration_reason(reason)),
        rejection
            .map(|rejection| rejection.actual())
            .unwrap_or("hydration_incomplete"),
    )
}

const fn matcha_hydration_reason(
    reason: crate::session::hydration::HydrationIncomplete,
) -> &'static str {
    match reason {
        crate::session::hydration::HydrationIncomplete::ReplayRecoveryRequired => {
            "replay_recovery_required"
        }
        crate::session::hydration::HydrationIncomplete::ReplayIncomplete => "replay_incomplete",
        crate::session::hydration::HydrationIncomplete::TranscriptRejected(_) => {
            "transcript_rejected"
        }
        crate::session::hydration::HydrationIncomplete::ConnectionInterrupted => {
            "connection_interrupted"
        }
        crate::session::hydration::HydrationIncomplete::SourceRejected => "source_rejected",
        crate::session::hydration::HydrationIncomplete::SourceUnavailable => "source_unavailable",
        crate::session::hydration::HydrationIncomplete::ProtocolRejected => "protocol_rejected",
        crate::session::hydration::HydrationIncomplete::ConnectionCloseFailed => {
            "connection_close_failed"
        }
    }
}

fn project_matcha_view(
    identity: &SessionIdentity,
    endpoint_session_id: Option<String>,
    facts: &crate::session::facts::NativeSessionFacts,
    epoch: u64,
) -> Option<SessionView> {
    let projection = CanonicalSessionAssembler::project(facts);
    let transcript = projection.transcript_window();
    let messages = projection.transcript_messages();
    let items = matcha_items(messages);
    let tools = matcha_tools(messages);
    let approvals = matcha_approvals(&projection);
    let (phase, active_run_id) = match projection.native_worker_state() {
        crate::session::model::WorkerRuntimeState::Running { run_id, .. } => {
            (RunPhase::Started, Some(run_id.as_str().to_owned()))
        }
        crate::session::model::WorkerRuntimeState::WaitingForApproval { run_id, .. } => (
            RunPhase::WaitingForApproval,
            Some(run_id.as_str().to_owned()),
        ),
        _ if !projection.pending_approvals().is_empty() => (
            RunPhase::WaitingForApproval,
            projection
                .runs()
                .iter()
                .rev()
                .find(|run| {
                    matches!(
                        &run.status,
                        crate::session::model::RunStatus::WaitingForApproval { .. }
                    )
                })
                .map(|run| run.run_id.as_str().to_owned()),
        ),
        _ => {
            let queued_run_id = projection
                .runs()
                .iter()
                .rev()
                .find(|run| matches!(&run.status, crate::session::model::RunStatus::Queued { .. }))
                .map(|run| run.run_id.as_str().to_owned());

            match queued_run_id {
                Some(run_id) => (RunPhase::Queued, Some(run_id)),
                None => (RunPhase::Completed, None),
            }
        }
    };
    let runtime = RuntimeView {
        phase,
        active_run_id,
        issue: None,
        run_progress: None,
        runtime_activity: None,
        error_detail: None,
    };
    let mut missing = vec![
        MissingFact::Artifacts,
        MissingFact::ContextTokens,
        MissingFact::Tasks,
        MissingFact::PartialRuntime,
    ];
    if projection.usage().is_none() {
        missing.push(MissingFact::Usage);
    }
    let view = SessionView {
        session_key: identity.session_key.clone(),
        endpoint_session_id,
        ownership: None,
        model_state: None,
        identity: identity.clone(),
        epoch,
        seq: 0,
        cursor: 0,
        items: SessionFact::Complete(items),
        tools: SessionFact::Complete(tools),
        approvals: SessionFact::Complete(approvals),
        runtime: SessionFact::Incomplete {
            facts: runtime,
            gaps: vec![MissingFact::PartialRuntime],
        },
        window: SessionFact::Complete(SessionWindow {
            total_item_count: transcript.total_item_count() as u64,
            window_start_offset: transcript.window_start_offset() as u64,
            window_end_offset: transcript.window_end_offset() as u64,
            has_more: transcript.has_more(),
            has_newer: transcript.has_newer(),
            is_at_latest: transcript.is_at_latest(),
        }),
        completeness: SessionCompleteness::Incomplete { missing },
    };
    view.validate().ok().map(|_| view)
}

fn project_matcha_hydration_view(
    identity: &SessionIdentity,
    endpoint_session_id: Option<String>,
    snapshot: &HydrationSnapshot,
    epoch: u64,
) -> Option<SessionView> {
    let transcript = snapshot.window();
    let view = SessionView {
        session_key: identity.session_key.clone(),
        endpoint_session_id,
        ownership: None,
        model_state: None,
        identity: identity.clone(),
        epoch,
        seq: 0,
        cursor: 0,
        items: SessionFact::Complete(matcha_items(snapshot.messages())),
        tools: SessionFact::Complete(matcha_tools(snapshot.messages())),
        approvals: SessionFact::Incomplete {
            facts: Vec::new(),
            gaps: vec![MissingFact::EventOnly],
        },
        runtime: SessionFact::Incomplete {
            facts: RuntimeView {
                phase: RunPhase::Completed,
                active_run_id: None,
                issue: None,
                run_progress: None,
                runtime_activity: None,
                error_detail: None,
            },
            gaps: vec![MissingFact::PartialRuntime],
        },
        window: SessionFact::Complete(SessionWindow {
            total_item_count: transcript.total_item_count() as u64,
            window_start_offset: transcript.window_start_offset() as u64,
            window_end_offset: transcript.window_end_offset() as u64,
            has_more: transcript.has_more(),
            has_newer: transcript.has_newer(),
            is_at_latest: transcript.is_at_latest(),
        }),
        completeness: SessionCompleteness::Incomplete {
            missing: vec![
                MissingFact::Catalog,
                MissingFact::Usage,
                MissingFact::Artifacts,
                MissingFact::ContextTokens,
                MissingFact::Tasks,
                MissingFact::ReplayCursor,
                MissingFact::PartialRuntime,
                MissingFact::EventOnly,
            ],
        },
    };
    view.validate().ok().map(|_| view)
}

fn matcha_items(messages: &[crate::session::hydration::HydratedMessage]) -> Vec<SessionItem> {
    messages
        .iter()
        .enumerate()
        .map(|(index, message)| {
            let item_id = message
                .id()
                .or(message.origin_message_id())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("source:{index}"));
            let text = message.text();
            let content = matcha_content(message);
            match message.role() {
                HydratedMessageRole::User => SessionItem::UserMessage {
                    item_id,
                    message_id: message.id().map(str::to_owned),
                    text,
                    content,
                    status: ItemStatus::Final,
                },
                HydratedMessageRole::Assistant => SessionItem::AssistantTurn {
                    item_id,
                    run_id: None,
                    message_id: message.id().map(str::to_owned),
                    status: ItemStatus::Final,
                    segments: content,
                    text,
                },
                HydratedMessageRole::System => SessionItem::System {
                    item_id,
                    text,
                    status: ItemStatus::Final,
                },
            }
        })
        .collect()
}

fn matcha_content(message: &crate::session::hydration::HydratedMessage) -> Vec<SessionContent> {
    message
        .content()
        .iter()
        .map(|block| match block {
            crate::session::hydration::HydratedContentBlock::Text { text } => {
                SessionContent::Text { text: text.clone() }
            }
            crate::session::hydration::HydratedContentBlock::LargeText(text) => {
                SessionContent::LargeText {
                    text: text.text().to_owned(),
                    content_ref: text.content_ref().to_owned(),
                    total_bytes: text.total_bytes(),
                    loaded_bytes: text.loaded_bytes(),
                }
            }
            crate::session::hydration::HydratedContentBlock::Thinking { text } => {
                SessionContent::Thinking { text: text.clone() }
            }
            crate::session::hydration::HydratedContentBlock::ToolUse(tool) => {
                SessionContent::ToolUse {
                    name: tool.name().to_owned(),
                    tool_call_id: tool.tool_call_id().to_owned(),
                }
            }
            crate::session::hydration::HydratedContentBlock::ToolResult(result) => {
                match result.tool_call_id() {
                    Some(tool_call_id) => SessionContent::ToolResult {
                        tool_call_id: tool_call_id.to_owned(),
                        summary: result.body().map(str::to_owned),
                        is_error: result.is_error().unwrap_or(false),
                    },
                    None => SessionContent::Omitted {
                        reason: OmissionReason::Unknown,
                    },
                }
            }
            crate::session::hydration::HydratedContentBlock::Image(image) => {
                SessionContent::Media {
                    media_type: Some(image.media_type().to_owned()),
                    reference: image.reference().to_owned(),
                }
            }
        })
        .collect()
}

fn matcha_tools(messages: &[crate::session::hydration::HydratedMessage]) -> Vec<ToolView> {
    let mut tools = Vec::new();
    for message in messages {
        for block in message.content() {
            match block {
                crate::session::hydration::HydratedContentBlock::ToolUse(tool) => {
                    upsert_matcha_tool_use(&mut tools, tool);
                }
                crate::session::hydration::HydratedContentBlock::ToolResult(result) => {
                    if let Some(tool_call_id) = result.tool_call_id() {
                        upsert_matcha_tool_result(&mut tools, tool_call_id, result);
                    }
                }
                _ => {}
            }
        }
    }
    tools
}

fn upsert_matcha_tool_use(
    tools: &mut Vec<ToolView>,
    tool: &crate::session::hydration::HydratedToolUse,
) {
    if let Some(existing) = tools
        .iter_mut()
        .find(|existing| existing.tool_call_id == tool.tool_call_id())
    {
        if existing.name.is_none() {
            existing.name = Some(tool.name().to_owned());
        }
        if tool.input().is_some() {
            existing.input = tool.input().cloned();
        }
        if tool.input_text().is_some() {
            existing.input_text = tool.input_text().map(str::to_owned);
        }
        return;
    }

    tools.push(ToolView {
        tool_call_id: tool.tool_call_id().to_owned(),
        run_id: None,
        name: Some(tool.name().to_owned()),
        phase: ToolPhase::Started,
        input: tool.input().cloned(),
        input_text: tool.input_text().map(str::to_owned),
        summary: None,
        output: None,
        details: None,
        is_error: None,
    });
}

fn upsert_matcha_tool_result(
    tools: &mut Vec<ToolView>,
    tool_call_id: &str,
    result: &crate::session::hydration::HydratedToolResult,
) {
    let phase = matcha_tool_result_phase(result.is_error());
    if let Some(existing) = tools
        .iter_mut()
        .find(|existing| existing.tool_call_id == tool_call_id)
    {
        existing.phase = phase;
        if result.body().is_some() {
            existing.summary = result.body().map(str::to_owned);
        }
        if result.is_error().is_some() {
            existing.is_error = result.is_error();
        }
        return;
    }

    tools.push(ToolView {
        tool_call_id: tool_call_id.to_owned(),
        run_id: None,
        name: None,
        phase,
        input: None,
        input_text: None,
        summary: result.body().map(str::to_owned),
        output: None,
        details: None,
        is_error: result.is_error(),
    });
}

const fn matcha_tool_result_phase(is_error: Option<bool>) -> ToolPhase {
    if matches!(is_error, Some(true)) {
        ToolPhase::Failed
    } else {
        ToolPhase::Completed
    }
}

fn matcha_approvals(
    view: &crate::session::canonical::CanonicalSessionView<'_>,
) -> Vec<ApprovalView> {
    view.pending_approvals()
        .iter()
        .map(|approval| ApprovalView {
            approval_id: approval.approval_id().as_str().to_owned(),
            run_id: None,
            phase: ApprovalPhase::Requested,
            option_ids: approval
                .option_ids()
                .iter()
                .map(|option| option.as_str().to_owned())
                .collect(),
        })
        .collect()
}
