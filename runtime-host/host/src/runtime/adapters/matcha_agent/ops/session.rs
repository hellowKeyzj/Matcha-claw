use super::*;

impl SessionOps for MatchaRuntimeDriver {
    fn admission(&self) -> SessionAdmission {
        SessionAdmission::agent_scoped(
            RuntimeDriverIdentity::matcha_agent().endpoint(),
            crate::sessions::state::SessionProvider::MatchaAgent,
            "matcha-agent",
        )
    }

    fn abort_session<'a>(
        &'a self,
        command: SessionAbortCommand,
    ) -> crate::runtime::driver::SessionFuture<'a, SessionAbortOutcome> {
        let session = self.session.clone();
        Box::pin(async move { abort_session_with_handle(session, command).await })
    }

    fn create_session<'a>(
        &'a self,
        command: SessionCreateCommand,
        epoch: u64,
    ) -> crate::runtime::driver::SessionFuture<'a, SessionCreateOutcome> {
        let session = self.session.clone();
        Box::pin(async move { create_session(session, command, epoch).await })
    }

    fn list_matcha_sessions<'a>(
        &'a self,
    ) -> crate::runtime::driver::SessionFuture<'a, crate::sessions::matcha_session_catalog::Outcome>
    {
        let session = self.session.clone();
        Box::pin(async move { list_matcha_sessions(session).await })
    }

    fn load_matcha_session<'a>(
        &'a self,
        session_id: SessionId,
    ) -> crate::runtime::driver::SessionFuture<
        'a,
        Result<::matcha_agent::session::model::SessionRecord, AppServerClientError>,
    > {
        let session = self.session.clone();
        Box::pin(async move { session.load_session(session_id).await })
    }

    fn load_matcha_history<'a>(
        &'a self,
        command: crate::sessions::matcha_history::Command,
    ) -> crate::runtime::driver::SessionFuture<'a, crate::sessions::matcha_history::Outcome> {
        let session = self.session.clone();
        Box::pin(async move { load_matcha_history(session, command).await })
    }

    fn load_session_timeline<'a>(
        &'a self,
        command: timeline::Command,
        epoch: u64,
    ) -> crate::runtime::driver::SessionFuture<'a, timeline::Outcome> {
        let session = self.session.clone();
        Box::pin(async move { load_matcha_timeline(session, command, epoch).await })
    }

    fn load_session_content<'a>(
        &'a self,
        command: timeline::ContentCommand,
    ) -> crate::runtime::driver::SessionFuture<'a, timeline::ContentOutcome> {
        let session = self.session.clone();
        Box::pin(async move { timeline::load_matcha_content(&session, command).await })
    }

    fn pending_approvals<'a>(
        &'a self,
        command: PendingApprovalsCommand,
    ) -> crate::runtime::driver::SessionFuture<'a, PendingApprovalsOutcome> {
        let session = self.session.clone();
        Box::pin(async move { pending_approvals_with_handle(session, command).await })
    }

    fn respond_to_approval<'a>(
        &'a self,
        command: SessionApprovalCommand,
    ) -> crate::runtime::driver::SessionFuture<'a, SessionApprovalOutcome> {
        let session = self.session.clone();
        Box::pin(async move { respond_to_approval_with_handle(session, command).await })
    }

    fn send_session<'a>(
        &'a self,
        command: SessionSendCommand,
    ) -> crate::runtime::driver::SessionFuture<'a, SessionSendOutcome> {
        let session = self.session.clone();
        let renderer_events = self.renderer_events.clone();
        Box::pin(async move { send_session_with_handle(session, command, renderer_events).await })
    }

    fn wait_session_native_run<'a>(
        &'a self,
        endpoint_session_id: Option<String>,
        native_run_id: String,
    ) -> crate::runtime::driver::SessionFuture<'a, Option<crate::runtime::driver::NativeRunSettled>>
    {
        let Some(endpoint_session_id) = endpoint_session_id else {
            return Box::pin(async { None });
        };
        super::team_terminal::watch_session_native_run_with_handle(
            self.native.clone(),
            endpoint_session_id,
            native_run_id,
        )
    }

    fn select_session_model<'a>(
        &'a self,
        command: ResolvedSessionModelSelection,
    ) -> crate::runtime::driver::SessionFuture<'a, SessionModelSelectionOutcome> {
        let session = self.session.clone();
        Box::pin(async move { select_session_model_with_handle(session, command).await })
    }

    fn session_permission<'a>(
        &'a self,
        _command: SessionPermissionCommand,
    ) -> crate::runtime::driver::SessionFuture<'a, SessionPermissionOutcome> {
        Box::pin(async { SessionPermissionOutcome::unsupported() })
    }
}

pub(super) async fn abort_session_with_handle(
    session: MatchaPeerSessionHandle,
    command: SessionAbortCommand,
) -> SessionAbortOutcome {
    let session_id =
        match adapters::session::matcha_native_session_id(command.endpoint_session_id.as_deref()) {
            Ok(session_id) => session_id,
            Err(()) => return SessionAbortOutcome::Rejected,
        };
    let params = match command.run_id {
        Some(run_id) => match ::matcha_agent::session::model::RunId::try_new(run_id) {
            Ok(run_id) => ::matcha_agent::session::request::SessionCancelParams::new(session_id)
                .with_run_id(run_id),
            Err(_) => return SessionAbortOutcome::Rejected,
        },
        None => ::matcha_agent::session::request::SessionCancelParams::new(session_id),
    };
    match session.cancel_session(params).await {
        InvocationOutcome::Succeeded(_) => SessionAbortOutcome::Succeeded,
        InvocationOutcome::TargetRejected(_) => SessionAbortOutcome::Rejected,
        InvocationOutcome::Cancelled | InvocationOutcome::Unknown => SessionAbortOutcome::Unknown,
    }
}

pub(super) async fn pending_approvals_with_handle(
    session: MatchaPeerSessionHandle,
    command: PendingApprovalsCommand,
) -> PendingApprovalsOutcome {
    let session_id = match ::matcha_agent::session::model::SessionId::try_new(command.session_id) {
        Ok(session_id) => session_id,
        Err(_) => return PendingApprovalsOutcome::Rejected,
    };
    match session.pending_approvals(session_id).await {
        Ok(approvals) => PendingApprovalsOutcome::Found(PendingApprovals {
            approvals: approvals
                .into_iter()
                .map(|(approval_id, option_ids)| PendingApproval {
                    approval_id: approval_id.as_str().to_owned(),
                    option_ids: option_ids
                        .into_iter()
                        .map(|option_id| option_id.as_str().to_owned())
                        .collect(),
                })
                .collect(),
        }),
        Err(::matcha_agent::session::client::AppServerClientError::ConnectionClosed) => {
            PendingApprovalsOutcome::Unavailable
        }
        Err(::matcha_agent::session::client::AppServerClientError::Protocol) => {
            PendingApprovalsOutcome::Unknown
        }
        Err(_) => PendingApprovalsOutcome::Rejected,
    }
}

pub(super) async fn respond_to_approval_with_handle(
    session: MatchaPeerSessionHandle,
    command: SessionApprovalCommand,
) -> SessionApprovalOutcome {
    let session_id = match ::matcha_agent::session::model::SessionId::try_new(command.session_id) {
        Ok(session_id) => session_id,
        Err(_) => return SessionApprovalOutcome::Rejected,
    };
    let approval_id = match ::matcha_agent::session::model::ApprovalId::try_new(command.approval_id)
    {
        Ok(approval_id) => approval_id,
        Err(_) => return SessionApprovalOutcome::Rejected,
    };
    let option_id = match ::matcha_agent::session::model::OptionId::try_new(command.option_id) {
        Ok(option_id) => option_id,
        Err(_) => return SessionApprovalOutcome::Rejected,
    };
    match session
        .respond_to_approval(
            ::matcha_agent::session::approval::ApprovalRespondParams::new(
                session_id,
                approval_id,
                option_id,
            ),
        )
        .await
    {
        InvocationOutcome::Succeeded(()) => SessionApprovalOutcome::Responded,
        InvocationOutcome::TargetRejected(_) => SessionApprovalOutcome::Rejected,
        InvocationOutcome::Cancelled | InvocationOutcome::Unknown => {
            SessionApprovalOutcome::Unknown
        }
    }
}

pub(super) async fn select_session_model_with_handle(
    session: MatchaPeerSessionHandle,
    command: ResolvedSessionModelSelection,
) -> SessionModelSelectionOutcome {
    let trace_id = command.trace_id.clone();
    let diagnostic = command.diagnostic.clone();
    let session_id = match adapters::session::matcha_native_session_id(
        command.endpoint_session_id.as_deref(),
    ) {
        Ok(session_id) => session_id,
        Err(()) => {
            session_trace::log(
                "runtime.matcha.model-selection.set-model.rejected",
                trace_id.as_deref(),
                serde_json::json!({
                    "reason": SessionModelSelectionRejection::InvalidSessionKey.as_str(),
                    "sessionKey": session_trace::id_shape(Some(&command.session_key)),
                    "endpointSessionId": session_trace::id_shape(command.endpoint_session_id.as_deref()),
                }),
            );
            return SessionModelSelectionOutcome::target_rejected(
                SessionModelSelectionRejection::InvalidSessionKey,
            );
        }
    };
    let SessionModelSelectionBinding::Matcha {
        model,
        provider_fingerprint,
        provider_runtime,
    } = command.binding
    else {
        session_trace::log(
            "runtime.matcha.model-selection.set-model.rejected",
            trace_id.as_deref(),
            serde_json::json!({
                "reason": SessionModelSelectionRejection::BindingMismatch.as_str(),
                "sessionId": session_trace::id_shape(Some(session_id.as_str())),
            }),
        );
        return SessionModelSelectionOutcome::target_rejected(
            SessionModelSelectionRejection::BindingMismatch,
        );
    };
    let session_id_shape = session_trace::id_shape(Some(session_id.as_str()));
    session_trace::log(
        "runtime.matcha.model-selection.set-model.dispatch",
        trace_id.as_deref(),
        serde_json::json!({
            "sessionId": session_id_shape.clone(),
            "model": &model,
            "modelSelectionId": session_trace::id_shape(Some(&command.model_selection_id)),
            "providerFingerprint": session_trace::id_shape(Some(&provider_fingerprint)),
            "providerRuntime": adapters::session::matcha_provider_runtime_trace(&provider_runtime),
            "accountId": diagnostic.as_ref().map(|diagnostic| diagnostic.account_id()),
            "modelId": diagnostic.as_ref().map(|diagnostic| diagnostic.model_id()),
            "protocol": diagnostic.as_ref().and_then(|diagnostic| diagnostic.protocol()),
            "authMode": diagnostic.as_ref().map(|diagnostic| diagnostic.auth_mode()),
        }),
    );
    let params = match ::matcha_agent::session::request::SessionSetModelParams::try_new(
        session_id,
        model.clone(),
    ) {
        Ok(params) => params
            .with_model_selection_id(command.model_selection_id)
            .with_provider_fingerprint(provider_fingerprint)
            .with_provider_runtime(adapters::session::matcha_provider_runtime(provider_runtime)),
        Err(_) => {
            session_trace::log(
                "runtime.matcha.model-selection.set-model.rejected",
                trace_id.as_deref(),
                serde_json::json!({
                    "reason": SessionModelSelectionRejection::InvalidModel.as_str(),
                    "sessionId": session_id_shape,
                    "model": model,
                }),
            );
            return SessionModelSelectionOutcome::target_rejected(
                SessionModelSelectionRejection::InvalidModel,
            );
        }
    };
    let outcome = match session.set_session_model(params).await {
        InvocationOutcome::Succeeded(_) => SessionModelSelectionOutcome::Succeeded,
        InvocationOutcome::TargetRejected(
            ::matcha_agent::session::client::AppServerClientError::SessionNotFound,
        ) => SessionModelSelectionOutcome::target_rejected(
            SessionModelSelectionRejection::SessionNotFound,
        ),
        InvocationOutcome::TargetRejected(_) => SessionModelSelectionOutcome::target_rejected(
            SessionModelSelectionRejection::RuntimeTargetRejected,
        ),
        InvocationOutcome::Cancelled | InvocationOutcome::Unknown => {
            SessionModelSelectionOutcome::OutcomeUnknown
        }
    };
    session_trace::log(
        "runtime.matcha.model-selection.set-model.outcome",
        trace_id.as_deref(),
        serde_json::json!({
            "sessionId": session_id_shape,
            "model": model,
            "outcome": adapters::session::session_model_selection_outcome_label(&outcome),
            "rejectionReason": outcome.rejection_reason(),
        }),
    );
    outcome
}

pub(super) async fn create_session(
    session: MatchaPeerSessionHandle,
    command: SessionCreateCommand,
    epoch: u64,
) -> SessionCreateOutcome {
    let agent_id = command.agent_id_owned();
    let session_key = command.session_key().to_owned();
    let endpoint_session_id = command.endpoint_session_id().to_owned();
    let session_id = match command.into_matcha_session_id() {
        Ok(session_id) => session_id,
        Err(_) => return SessionCreateOutcome::TargetRejected,
    };
    match session.create_session(session_id).await {
        InvocationOutcome::Succeeded(returned) => {
            let _ = returned;
            project_matcha_create(session_key, endpoint_session_id, Some(agent_id), epoch)
        }
        InvocationOutcome::Cancelled | InvocationOutcome::Unknown => {
            SessionCreateOutcome::Unavailable
        }
        InvocationOutcome::TargetRejected(_) => SessionCreateOutcome::TargetRejected,
    }
}

pub(super) async fn list_matcha_sessions(
    session: MatchaPeerSessionHandle,
) -> crate::sessions::matcha_session_catalog::Outcome {
    match session.list_local_history().await {
        HistoryResult::Complete(catalog) => {
            crate::sessions::matcha_session_catalog::Outcome::Listed(
                crate::sessions::matcha_session_catalog::project_local(catalog),
            )
        }
        HistoryResult::NotFound
        | HistoryResult::Unavailable
        | HistoryResult::Unknown
        | HistoryResult::Incomplete(_) => {
            crate::sessions::matcha_session_catalog::Outcome::Unavailable
        }
    }
}

pub(super) async fn load_matcha_history(
    session: MatchaPeerSessionHandle,
    command: crate::sessions::matcha_history::Command,
) -> crate::sessions::matcha_history::Outcome {
    let Some(session_id) = SessionId::try_new(command.session_id).ok() else {
        return crate::sessions::matcha_history::Outcome::Incomplete;
    };
    let request = HydrationWindowRequest::new(
        HydrationWindowMode::Latest,
        HydrationWindowRequest::MAX_LIMIT,
        None,
    );
    match session
        .load_local_history(session_id.clone(), request)
        .await
    {
        HistoryResult::Complete(snapshot) => {
            return crate::sessions::matcha_history::Outcome::Complete(
                crate::sessions::matcha_history::project_hydration(&snapshot),
            );
        }
        HistoryResult::NotFound | HistoryResult::Unavailable => {}
        HistoryResult::Unknown | HistoryResult::Incomplete(_) => {
            return crate::sessions::matcha_history::Outcome::Incomplete;
        }
    }
    let result = session.read_canonical_session(session_id, request).await;
    match result {
        HistoryResult::Complete(facts) => crate::sessions::matcha_history::Outcome::Complete(
            crate::sessions::matcha_history::project(&facts),
        ),
        HistoryResult::Unavailable => crate::sessions::matcha_history::Outcome::Unavailable,
        HistoryResult::NotFound | HistoryResult::Unknown | HistoryResult::Incomplete(_) => {
            crate::sessions::matcha_history::Outcome::Incomplete
        }
    }
}

pub(super) async fn load_matcha_timeline(
    session: MatchaPeerSessionHandle,
    command: timeline::Command,
    epoch: u64,
) -> timeline::Outcome {
    timeline::load_matcha(&session, command, epoch).await
}

pub(super) async fn send_session_with_handle(
    session: MatchaPeerSessionHandle,
    command: SessionSendCommand,
    renderer_events: Option<mpsc::Sender<SessionSubscriptionItem>>,
) -> SessionSendOutcome {
    let trace_id = command.trace_id().map(str::to_owned);
    let route_key = command.route_key.clone();
    let session_key = command.session_key.clone();
    let endpoint_session_id = command.endpoint_session_id.clone();
    let message_len = command.message.len();
    let attachment_count = command.attachments.len();
    let has_renderer_events = renderer_events.is_some();
    let requested_run_id = command.request_run_identity().map(str::to_owned);
    session_trace::log(
        "runtime.matcha.send.received",
        trace_id.as_deref(),
        serde_json::json!({
            "sessionKey": session_trace::id_shape(Some(&session_key)),
            "routeKey": session_trace::id_shape(Some(route_key.as_str())),
            "endpointSessionId": session_trace::id_shape(endpoint_session_id.as_deref()),
            "runId": session_trace::id_shape(requested_run_id.as_deref()),
            "messageLength": message_len,
            "attachmentCount": attachment_count,
            "hasRendererEventSink": has_renderer_events,
        }),
    );
    let Some(renderer_events) = renderer_events else {
        session_trace::log(
            "runtime.matcha.send.unavailable",
            trace_id.as_deref(),
            serde_json::json!({ "reason": "missing-renderer-event-sink" }),
        );
        return SessionSendOutcome::Unavailable;
    };
    let session_id =
        match adapters::session::matcha_native_session_id(endpoint_session_id.as_deref()) {
            Ok(session_id) => session_id,
            Err(()) => {
                session_trace::log(
                    "runtime.matcha.send.rejected",
                    trace_id.as_deref(),
                    serde_json::json!({ "reason": "invalid-session-id" }),
                );
                return SessionSendOutcome::Rejected;
            }
        };
    let run_id = match requested_run_id
        .as_deref()
        .and_then(|run_id| RunId::try_new(run_id.to_owned()).ok())
    {
        Some(run_id) => run_id,
        None => {
            session_trace::log(
                "runtime.matcha.send.rejected",
                trace_id.as_deref(),
                serde_json::json!({ "reason": "invalid-run-id" }),
            );
            return SessionSendOutcome::Rejected;
        }
    };
    let params = match adapters::session::session_prompt_params(command, session_id.clone()) {
        Ok(params) => params,
        Err(()) => {
            session_trace::log(
                "runtime.matcha.send.rejected",
                trace_id.as_deref(),
                serde_json::json!({ "reason": "invalid-prompt-params" }),
            );
            return SessionSendOutcome::Rejected;
        }
    };
    session_trace::log(
        "runtime.matcha.send.subscribe-start",
        trace_id.as_deref(),
        serde_json::json!({
            "sessionId": session_trace::id_shape(Some(session_id.as_str())),
            "routeKey": session_trace::id_shape(Some(route_key.as_str())),
            "runId": session_trace::id_shape(Some(run_id.as_str())),
        }),
    );
    let subscription = match session
        .subscribe_renderer_events(
            session_id.clone(),
            session_key.clone(),
            run_id.clone(),
            route_key,
            renderer_events,
            trace_id.clone(),
        )
        .await
    {
        Ok(subscription) => subscription,
        Err(error) => {
            session_trace::log(
                "runtime.matcha.send.subscribe-failed",
                trace_id.as_deref(),
                serde_json::json!({ "error": adapters::session::renderer_subscription_error_kind(&error) }),
            );
            return adapters::session::renderer_subscription_failure_outcome(error);
        }
    };
    session_trace::log(
        "runtime.matcha.send.subscribe-ready",
        trace_id.as_deref(),
        serde_json::json!({
            "sessionId": session_trace::id_shape(Some(session_id.as_str())),
            "runId": session_trace::id_shape(Some(run_id.as_str())),
        }),
    );
    match session.prompt_session(params).await {
        InvocationOutcome::Succeeded(result) => {
            session_trace::log(
                "runtime.matcha.send.prompt-started",
                trace_id.as_deref(),
                serde_json::json!({
                    "runId": session_trace::id_shape(Some(result.run_id.as_str())),
                }),
            );
            SessionSendOutcome::Succeeded {
                run_id: result.run_id.as_str().to_owned(),
                status: SessionSendStatus::Started,
            }
        }
        InvocationOutcome::TargetRejected(error) => {
            subscription.abort();
            session_trace::log(
                "runtime.matcha.send.prompt-rejected",
                trace_id.as_deref(),
                serde_json::json!({ "error": adapters::session::app_server_client_error_kind(error) }),
            );
            SessionSendOutcome::Rejected
        }
        InvocationOutcome::Cancelled | InvocationOutcome::Unknown => {
            subscription.abort();
            session_trace::log(
                "runtime.matcha.send.prompt-unknown",
                trace_id.as_deref(),
                serde_json::json!({}),
            );
            SessionSendOutcome::Unknown
        }
    }
}
