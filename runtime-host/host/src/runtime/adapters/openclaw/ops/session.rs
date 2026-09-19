use super::*;
use crate::sessions::{
    model_selection::{
        NativeEndpoint, SessionModelSelectionDiagnostic, SessionRuntimeModelCommand,
        SessionRuntimeModelSource,
    },
    state::SessionView,
    timeline,
};

impl OpenClawInstance {
    pub(crate) async fn list_sessions(
        &self,
        params: openclaw::session::protocol::SessionsListParams,
    ) -> Result<openclaw::session::protocol::SessionsListResult, openclaw::port::OpenClawSessionError>
    {
        self.session_gateway.list_sessions(params).await
    }

    pub(crate) async fn history(
        &self,
        params: openclaw::session::protocol::ChatHistoryParams,
    ) -> Result<openclaw::session::protocol::ChatHistoryResult, openclaw::port::OpenClawSessionError>
    {
        self.session_gateway.history(params).await
    }

    pub(crate) async fn send_chat(
        &self,
        params: openclaw::session::protocol::ChatSendParams,
    ) -> Result<
        InvocationOutcome<
            openclaw::session::protocol::ChatSendResult,
            openclaw::port::OpenClawSessionError,
        >,
        openclaw::port::OpenClawSessionError,
    > {
        self.session_gateway.send_chat(params).await
    }

    pub(crate) async fn abort_chat(
        &self,
        params: openclaw::session::protocol::ChatAbortParams,
    ) -> Result<
        InvocationOutcome<
            openclaw::session::protocol::ChatAbortResult,
            openclaw::port::OpenClawSessionError,
        >,
        openclaw::port::OpenClawSessionError,
    > {
        self.session_gateway.abort_chat(params).await
    }

    pub(crate) async fn patch_session_label(
        &self,
        params: openclaw::session::protocol::SessionLabelPatchParams,
    ) -> Result<
        InvocationOutcome<
            openclaw::session::protocol::SessionLabelPatchResult,
            openclaw::port::OpenClawSessionError,
        >,
        openclaw::port::OpenClawSessionError,
    > {
        self.session_gateway.patch_session_label(params).await
    }

    pub(crate) async fn delete_session(
        &self,
        params: openclaw::session::protocol::SessionDeleteParams,
    ) -> Result<
        InvocationOutcome<
            openclaw::session::protocol::SessionDeleteResult,
            openclaw::port::OpenClawSessionError,
        >,
        openclaw::port::OpenClawSessionError,
    > {
        self.session_gateway.delete_session(params).await
    }

    pub(crate) async fn abort_session(&self, command: SessionAbortCommand) -> SessionAbortOutcome {
        let session_key =
            match openclaw::session::protocol::SessionKey::try_new(command.session_key) {
                Ok(session_key) => session_key,
                Err(_) => return SessionAbortOutcome::Rejected,
            };
        let params = match command.run_id {
            Some(run_id) => match openclaw::session::protocol::RunId::try_new(run_id) {
                Ok(run_id) => {
                    openclaw::session::protocol::ChatAbortParams::new(session_key).for_run(run_id)
                }
                Err(_) => return SessionAbortOutcome::Rejected,
            },
            None => openclaw::session::protocol::ChatAbortParams::new(session_key),
        };
        match self.session_gateway.abort_chat(params).await {
            Ok(InvocationOutcome::Succeeded(_)) => SessionAbortOutcome::Succeeded,
            Ok(InvocationOutcome::TargetRejected(_)) => SessionAbortOutcome::Rejected,
            Ok(InvocationOutcome::Cancelled | InvocationOutcome::Unknown) | Err(_) => {
                SessionAbortOutcome::Unknown
            }
        }
    }

    pub(crate) async fn session_permission(
        &self,
        command: SessionPermissionCommand,
    ) -> SessionPermissionOutcome {
        let session_key = match openclaw::session::protocol::SessionKey::try_new(
            command.session_key().to_owned(),
        ) {
            Ok(session_key) => session_key,
            Err(_) => return SessionPermissionOutcome::unsupported(),
        };
        let outcome = match command.action() {
            SessionPermissionAction::Get => self
                .session_gateway
                .get_session_permission(session_key)
                .await
                .map(InvocationOutcome::Succeeded),
            SessionPermissionAction::Set { permission_mode } => {
                self.session_gateway
                    .set_session_permission(
                        openclaw::session::protocol::SessionPermissionPatchParams::new(
                            session_key,
                            permission_mode.map(Into::into),
                        ),
                    )
                    .await
            }
        };
        match outcome {
            Ok(InvocationOutcome::Succeeded(projection)) => SessionPermissionOutcome::projection(
                SessionPermissionProjection::from_openclaw(projection),
            ),
            Ok(InvocationOutcome::TargetRejected(_)) => SessionPermissionOutcome::unsupported(),
            Ok(InvocationOutcome::Cancelled | InvocationOutcome::Unknown) | Err(_) => {
                SessionPermissionOutcome::Unavailable
            }
        }
    }

    pub(crate) async fn session_runtime_model_facts(
        &self,
        session_key: String,
    ) -> Result<
        SessionRuntimeModelFacts,
        crate::sessions::RuntimeSessionError<openclaw::port::OpenClawSessionError>,
    > {
        let session_key =
            openclaw::session::protocol::SessionKey::try_new(session_key).map_err(|_| {
                crate::sessions::RuntimeSessionError::Client(
                    openclaw::port::OpenClawSessionError::TargetRejected,
                )
            })?;
        let row = self
            .session_gateway
            .describe_session(openclaw::session::protocol::SessionDescribeParams::new(
                session_key,
                None,
            ))
            .await
            .map_err(crate::sessions::RuntimeSessionError::Client)?;
        Ok(match row {
            Some(row) => SessionRuntimeModelFacts {
                current_model: row.model_ref(),
                agent_id: row.agent_id.map(|agent_id| agent_id.as_str().to_owned()),
                model_override_source: row.model_override_source.map(|source| match source {
                    openclaw::session::protocol::SessionModelOverrideSource::User => {
                        SessionRuntimeModelSource::User
                    }
                    openclaw::session::protocol::SessionModelOverrideSource::Auto => {
                        SessionRuntimeModelSource::Auto
                    }
                }),
            },
            None => SessionRuntimeModelFacts {
                current_model: None,
                agent_id: None,
                model_override_source: None,
            },
        })
    }

    async fn configured_agent_model(&self, agent_id: &str) -> Option<String> {
        self.gateway
            .lock()
            .await
            .list_agents()
            .await
            .ok()?
            .agents
            .into_iter()
            .find(|agent| agent.id == agent_id)
            .and_then(|agent| agent.model)
    }

    pub(crate) async fn select_session_model(
        &self,
        command: ResolvedSessionModelSelection,
    ) -> SessionModelSelectionOutcome {
        let session_key =
            match openclaw::session::protocol::SessionKey::try_new(command.session_key) {
                Ok(session_key) => session_key,
                Err(_) => {
                    return SessionModelSelectionOutcome::target_rejected(
                        SessionModelSelectionRejection::InvalidSessionKey,
                    );
                }
            };
        let model = match command.binding {
            SessionModelSelectionBinding::OpenClaw(model) => model,
            SessionModelSelectionBinding::Matcha { .. } => {
                return SessionModelSelectionOutcome::target_rejected(
                    SessionModelSelectionRejection::BindingMismatch,
                );
            }
        };
        let params =
            openclaw::session::protocol::SessionModelPatchParams::new(session_key, Some(model));
        match self
            .session_gateway
            .patch_session_model_diagnostic(params)
            .await
        {
            Ok(InvocationOutcome::Succeeded(_)) => SessionModelSelectionOutcome::Succeeded,
            Ok(InvocationOutcome::TargetRejected(
                openclaw::port::SessionModelPatchFailure::TargetRejected(Some(rejection)),
            )) => SessionModelSelectionOutcome::target_rejected(
                SessionModelSelectionRejection::OpenClawRuntimeTargetRejected(
                    OpenClawPatchRejection::new(
                        rejection.code().to_owned(),
                        rejection.message().to_owned(),
                    ),
                ),
            ),
            Ok(InvocationOutcome::TargetRejected(_)) => {
                SessionModelSelectionOutcome::target_rejected(
                    SessionModelSelectionRejection::RuntimeTargetRejected,
                )
            }
            Ok(InvocationOutcome::Cancelled | InvocationOutcome::Unknown) | Err(_) => {
                SessionModelSelectionOutcome::OutcomeUnknown
            }
        }
    }

    pub(crate) async fn send_session(&self, command: SessionSendCommand) -> SessionSendOutcome {
        let idempotency_key = match command.request_run_identity().map(str::to_owned) {
            Some(idempotency_key) => idempotency_key,
            None => return SessionSendOutcome::Rejected,
        };
        let session_key =
            match openclaw::session::protocol::SessionKey::try_new(command.session_key) {
                Ok(session_key) => session_key,
                Err(_) => return SessionSendOutcome::Rejected,
            };
        let idempotency_key = match openclaw::session::protocol::RunId::try_new(idempotency_key) {
            Ok(idempotency_key) => idempotency_key,
            Err(_) => return SessionSendOutcome::Rejected,
        };
        let mut params = match openclaw::session::protocol::ChatSendParams::try_new(
            session_key,
            command.message,
            idempotency_key,
        ) {
            Ok(params) => params,
            Err(_) => return SessionSendOutcome::Rejected,
        };
        if let Some(receipt) = command.system_provenance_receipt {
            params = params.with_system_provenance_receipt(receipt);
        }
        for attachment in command.attachments {
            let attachment = match map_attachment(attachment) {
                Ok(attachment) => attachment,
                Err(()) => return SessionSendOutcome::Rejected,
            };
            params = match params.try_with_attachment(attachment) {
                Ok(params) => params,
                Err(_) => return SessionSendOutcome::Rejected,
            };
        }
        match self
            .session_gateway
            .enqueue_chat(params, command.route_key)
            .await
        {
            Ok(result) => SessionSendOutcome::Queued {
                run_id: result.run_id.as_str().to_owned(),
            },
            Err(_) => SessionSendOutcome::Unavailable,
        }
    }
}

fn project_openclaw_session_catalog(
    result: openclaw::session::protocol::SessionsListResult,
) -> crate::sessions::openclaw_direct::SessionCatalog {
    crate::sessions::openclaw_direct::SessionCatalog {
        sessions: result
            .sessions
            .into_iter()
            .filter_map(project_openclaw_session_catalog_entry)
            .collect(),
    }
}

fn project_openclaw_session_catalog_entry(
    session: openclaw::session::protocol::SessionSummary,
) -> Option<crate::sessions::openclaw_direct::SessionCatalogEntry> {
    let entry = session.agent_scoped_catalog_entry()?;
    Some(crate::sessions::openclaw_direct::SessionCatalogEntry {
        key: entry.session_key.as_str().to_owned(),
        agent_id: entry.agent_id.as_str().to_owned(),
        endpoint_session_id: entry.endpoint_session_id,
        model: session.model,
        updated_at: session.updated_at,
    })
}

impl SessionOpenOps for OpenClawInstance {
    fn on_load_session_timeline<'a>(
        &'a self,
        command: &'a timeline::Command,
        view: SessionView,
        provider_handle: ProviderHandle,
    ) -> crate::runtime::driver::SessionFuture<'a, SessionView> {
        Box::pin(async move {
            log_session_model_reconcile_entered(command.session_key());
            let Ok(facts) = self
                .session_runtime_model_facts(command.session_key().to_owned())
                .await
            else {
                log_session_model_reconcile_skipped("describe", command, None, None);
                return view;
            };
            let endpoint = NativeEndpoint::OpenClawLocal;
            if matches!(
                facts.model_override_source,
                Some(SessionRuntimeModelSource::User | SessionRuntimeModelSource::Auto)
            ) {
                if let Some(model) = facts.current_model.as_deref() {
                    let accepted = provider_handle
                        .accept_session_runtime_models(endpoint, vec![model.to_owned()])
                        .await;
                    if matches!(accepted.as_ref(), Ok(accepted) if accepted.first() == Some(&true))
                    {
                        log_session_model_reconcile_kept(command.session_key(), model);
                        return SessionView {
                            model: Some(model.to_owned()),
                            ..view
                        };
                    }
                    if accepted.is_err() {
                        log_session_model_reconcile_skipped(
                            "judge_unavailable",
                            command,
                            facts.current_model.as_deref(),
                            None,
                        );
                    }
                }
            }
            let default_model = match facts.agent_id.as_deref() {
                Some(agent_id) => self.configured_agent_model(agent_id).await,
                None => None,
            };
            let Ok(rebound) = SessionRuntimeModelCommand::try_new(
                endpoint,
                command.session_key().to_owned(),
                command.endpoint_session_id().map(str::to_owned),
                facts.current_model.clone(),
                default_model.clone(),
            ) else {
                log_session_model_reconcile_skipped(
                    "command_invalid",
                    command,
                    facts.current_model.as_deref(),
                    default_model.as_deref(),
                );
                return view;
            };
            let Ok(mut selection) = provider_handle.resolve_session_model_rebound(rebound).await
            else {
                log_session_model_reconcile_skipped(
                    "rebound_unresolved",
                    command,
                    facts.current_model.as_deref(),
                    default_model.as_deref(),
                );
                return view;
            };
            let resolved_model = selection.openclaw_model_ref().map(str::to_owned);
            let diagnostic = selection.diagnostic.take();
            let outcome = self.select_session_model(selection).await;
            if outcome != SessionModelSelectionOutcome::Succeeded {
                log_session_model_reconcile_skipped(
                    "patch_rejected",
                    command,
                    facts.current_model.as_deref(),
                    resolved_model.as_deref(),
                );
                log_session_model_patch_rejected(command.session_key(), &outcome);
                return view;
            }
            log_session_model_reconciled(
                command.session_key(),
                facts.current_model.as_deref(),
                resolved_model.as_deref(),
                diagnostic.as_ref(),
            );
            SessionView {
                model: resolved_model,
                ..view
            }
        })
    }

    fn agent_default_model<'a>(
        &'a self,
        agent_id: String,
    ) -> crate::runtime::driver::SessionFuture<'a, Option<String>> {
        Box::pin(async move { self.configured_agent_model(&agent_id).await })
    }
}

fn log_session_model_reconciled(
    session_key: &str,
    previous_model: Option<&str>,
    resolved_model: Option<&str>,
    diagnostic: Option<&SessionModelSelectionDiagnostic>,
) {
    use crate::transport::sessions::trace as session_trace;

    if std::env::var("MATCHACLAW_SESSION_TRACE").as_deref() != Ok("1") {
        return;
    }
    eprintln!(
        "{}",
        serde_json::json!({
            "prefix": "session-trace",
            "source": "runtime-host",
            "stage": "runtime.session-model.reconciled",
            "sessionKey": session_trace::id_shape(Some(session_key)),
            "previousModel": session_trace::id_shape(previous_model),
            "resolvedModel": session_trace::id_shape(resolved_model),
            "accountId": diagnostic.map(SessionModelSelectionDiagnostic::account_id),
            "modelId": diagnostic.map(SessionModelSelectionDiagnostic::model_id),
        })
    );
}

fn log_session_model_reconcile_entered(session_key: &str) {
    use crate::transport::sessions::trace as session_trace;

    if std::env::var("MATCHACLAW_SESSION_TRACE").as_deref() != Ok("1") {
        return;
    }
    eprintln!(
        "{}",
        serde_json::json!({
            "prefix": "session-trace",
            "source": "runtime-host",
            "stage": "runtime.session-model.reconcile-entered",
            "sessionKey": session_trace::id_shape(Some(session_key)),
        })
    );
}

fn log_session_model_reconcile_kept(session_key: &str, model: &str) {
    use crate::transport::sessions::trace as session_trace;

    if std::env::var("MATCHACLAW_SESSION_TRACE").as_deref() != Ok("1") {
        return;
    }
    eprintln!(
        "{}",
        serde_json::json!({
            "prefix": "session-trace",
            "source": "runtime-host",
            "stage": "runtime.session-model.reconcile-kept",
            "sessionKey": session_trace::id_shape(Some(session_key)),
            "model": session_trace::id_shape(Some(model)),
        })
    );
}

fn log_session_model_reconcile_skipped(
    reason: &'static str,
    command: &timeline::Command,
    current_model: Option<&str>,
    candidate_model: Option<&str>,
) {
    use crate::transport::sessions::trace as session_trace;

    if std::env::var("MATCHACLAW_SESSION_TRACE").as_deref() != Ok("1") {
        return;
    }
    eprintln!(
        "{}",
        serde_json::json!({
            "prefix": "session-trace",
            "source": "runtime-host",
            "stage": "runtime.session-model.reconcile-skipped",
            "reason": reason,
            "sessionKey": session_trace::id_shape(Some(command.session_key())),
            "endpointSessionId": session_trace::id_shape(command.endpoint_session_id()),
            "currentModel": session_trace::id_shape(current_model),
            "candidateModel": session_trace::id_shape(candidate_model),
        })
    );
}

fn log_session_model_patch_rejected(session_key: &str, outcome: &SessionModelSelectionOutcome) {
    use crate::transport::sessions::trace as session_trace;

    if std::env::var("MATCHACLAW_SESSION_TRACE").as_deref() != Ok("1") {
        return;
    }
    eprintln!(
        "{}",
        serde_json::json!({
            "prefix": "session-trace",
            "source": "runtime-host",
            "stage": "runtime.session-model.patch-rejected",
            "sessionKey": session_trace::id_shape(Some(session_key)),
            "rejection": outcome.rejection_reason(),
            "peerCode": outcome
                .openclaw_patch_rejection()
                .map(|rejection| rejection.code().to_owned()),
            "peerMessage": outcome
                .openclaw_patch_rejection()
                .map(|rejection| rejection.message().to_owned()),
        })
    );
}

impl SessionOps for OpenClawInstance {
    fn admission(&self) -> SessionAdmission {
        SessionAdmission::new(RuntimeDriverIdentity::open_claw())
    }

    fn abort_session<'a>(
        &'a self,
        command: SessionAbortCommand,
    ) -> crate::runtime::driver::SessionFuture<'a, SessionAbortOutcome> {
        Box::pin(self.abort_session(command))
    }

    fn create_session<'a>(
        &'a self,
        command: SessionCreateCommand,
        epoch: u64,
    ) -> crate::runtime::driver::SessionFuture<'a, SessionCreateOutcome> {
        Box::pin(async move {
            let default_model = match self.configured_agent_model(command.agent_id()).await {
                Some(model) => model,
                None => return SessionCreateOutcome::Unavailable,
            };
            let model = match openclaw::session::protocol::ModelRef::try_new(default_model) {
                Ok(model) => model,
                Err(_) => return SessionCreateOutcome::TargetRejected,
            };
            let params = match command.clone().into_openclaw_params(model) {
                Ok(params) => params,
                Err(_) => return SessionCreateOutcome::TargetRejected,
            };
            match self.session_gateway.create_session(params).await {
                Ok(outcome) => project_openclaw_create(&command, outcome, epoch),
                Err(error) => project_create_client_error(error),
            }
        })
    }

    fn openclaw_session_catalog<'a>(
        &'a self,
    ) -> crate::runtime::driver::SessionFuture<
        'a,
        Result<
            crate::sessions::openclaw_direct::SessionCatalog,
            crate::sessions::RuntimeSessionError<openclaw::port::OpenClawSessionError>,
        >,
    > {
        Box::pin(async move {
            let result = self
                .list_sessions(openclaw::session::protocol::SessionsListParams::default())
                .await
                .map_err(crate::sessions::RuntimeSessionError::Client)?;
            Ok(project_openclaw_session_catalog(result))
        })
    }

    fn open_session_ops(&self) -> Option<&dyn SessionOpenOps> {
        Some(self)
    }

    fn history<'a>(
        &'a self,
        params: openclaw::session::protocol::ChatHistoryParams,
    ) -> crate::runtime::driver::SessionFuture<
        'a,
        Result<
            openclaw::session::protocol::ChatHistoryResult,
            crate::sessions::RuntimeSessionError<openclaw::port::OpenClawSessionError>,
        >,
    > {
        Box::pin(async move {
            self.history(params)
                .await
                .map_err(crate::sessions::RuntimeSessionError::Client)
        })
    }

    fn load_openclaw_session_replay<'a>(
        &'a self,
        request: crate::sessions::timeline::OpenClawReplayRequest,
    ) -> crate::runtime::driver::SessionFuture<
        'a,
        Result<
            crate::sessions::timeline::OpenClawReplayWindow,
            crate::sessions::RuntimeSessionError<openclaw::port::OpenClawSessionError>,
        >,
    > {
        Box::pin(async move {
            let direction = match request.window().direction() {
                crate::sessions::timeline::Direction::Latest => {
                    openclaw::session_window::Direction::Latest
                }
                crate::sessions::timeline::Direction::Older => {
                    openclaw::session_window::Direction::Older
                }
                crate::sessions::timeline::Direction::Newer => {
                    openclaw::session_window::Direction::Newer
                }
            };
            let page_request = openclaw::session_window::PageRequest::new(
                direction,
                request.window().limit(),
                request.window().offset(),
            )
            .ok_or(crate::sessions::RuntimeSessionError::Client(
                openclaw::port::OpenClawSessionError::TargetRejected,
            ))?;
            let source = openclaw::session::load_session_replay_source(
                self.state_dir(),
                request.session_key().clone(),
                page_request,
            )
            .map_err(|error| {
                crate::sessions::RuntimeSessionError::Client(match error {
                    openclaw::session::SessionReplaySourceError::MissingStateDir => {
                        openclaw::port::OpenClawSessionError::SessionConnection
                    }
                    openclaw::session::SessionReplaySourceError::UnsupportedSessionKey => {
                        openclaw::port::OpenClawSessionError::TargetRejected
                    }
                    openclaw::session::SessionReplaySourceError::AgentStoreUnavailable
                    | openclaw::session::SessionReplaySourceError::StoreReadFailed => {
                        openclaw::port::OpenClawSessionError::Transport
                    }
                    openclaw::session::SessionReplaySourceError::SessionUnavailable => {
                        openclaw::port::OpenClawSessionError::UnknownResponse
                    }
                    openclaw::session::SessionReplaySourceError::SourceMalformed
                    | openclaw::session::SessionReplaySourceError::SourceUndecodable { .. } => {
                        openclaw::port::OpenClawSessionError::Protocol(None)
                    }
                })
            })?;
            let range = source.source_range();
            let total_item_count = source.total_source_events() as u64;
            let window = crate::sessions::state::SessionWindow {
                total_item_count,
                window_start_offset: range.start() as u64,
                window_end_offset: range.end() as u64,
                has_more: range.start() > 0,
                has_newer: range.end() < source.total_source_events(),
                is_at_latest: range.end() >= source.total_source_events(),
            };
            let replay = openclaw::session::materialize_session_replay_rows(
                source.session_key().clone(),
                source.into_rows(),
                None,
                None,
            )
            .map_err(|_| {
                crate::sessions::RuntimeSessionError::Client(
                    openclaw::port::OpenClawSessionError::Protocol(None),
                )
            })?;
            crate::sessions::timeline::OpenClawReplayWindow::new(replay, window).ok_or(
                crate::sessions::RuntimeSessionError::Client(
                    openclaw::port::OpenClawSessionError::Protocol(None),
                ),
            )
        })
    }

    fn rename_session<'a>(
        &'a self,
        command: SessionRenameCommand,
    ) -> crate::runtime::driver::SessionFuture<'a, SessionRenameOutcome> {
        Box::pin(async move {
            let params = match command.into_openclaw_params() {
                Ok(params) => params,
                Err(_) => return SessionRenameOutcome::TargetRejected,
            };
            match self.patch_session_label(params).await {
                Ok(outcome) => project_openclaw_rename(outcome),
                Err(error) => project_rename_client_error(error),
            }
        })
    }

    fn delete_session<'a>(
        &'a self,
        command: SessionDeleteCommand,
    ) -> crate::runtime::driver::SessionFuture<'a, SessionDeleteOutcome> {
        Box::pin(async move {
            let params = match command.into_openclaw_params() {
                Ok(params) => params,
                Err(_) => return SessionDeleteOutcome::TargetRejected,
            };
            match self.delete_session(params).await {
                Ok(outcome) => project_openclaw_delete(outcome),
                Err(error) => project_delete_client_error(error),
            }
        })
    }

    fn load_session_timeline<'a>(
        &'a self,
        command: crate::sessions::timeline::Command,
        epoch: u64,
    ) -> crate::runtime::driver::SessionFuture<'a, crate::sessions::timeline::Outcome> {
        Box::pin(crate::sessions::timeline::load_openclaw(
            self, command, epoch,
        ))
    }

    fn load_session_content<'a>(
        &'a self,
        command: crate::sessions::timeline::ContentCommand,
    ) -> crate::runtime::driver::SessionFuture<'a, crate::sessions::timeline::ContentOutcome> {
        Box::pin(async move { crate::sessions::timeline::load_openclaw_content(command) })
    }

    fn send_open_claw_chat<'a>(
        &'a self,
        params: openclaw::session::protocol::ChatSendParams,
    ) -> crate::runtime::driver::SessionFuture<
        'a,
        Result<
            InvocationOutcome<
                openclaw::session::protocol::ChatSendResult,
                openclaw::port::OpenClawSessionError,
            >,
            crate::sessions::RuntimeSessionError<openclaw::port::OpenClawSessionError>,
        >,
    > {
        Box::pin(async move {
            self.send_chat(params)
                .await
                .map_err(crate::sessions::RuntimeSessionError::Client)
        })
    }

    fn send_session<'a>(
        &'a self,
        command: SessionSendCommand,
    ) -> crate::runtime::driver::SessionFuture<'a, SessionSendOutcome> {
        Box::pin(self.send_session(command))
    }

    fn abort_open_claw_chat<'a>(
        &'a self,
        params: openclaw::session::protocol::ChatAbortParams,
    ) -> crate::runtime::driver::SessionFuture<
        'a,
        Result<
            InvocationOutcome<
                openclaw::session::protocol::ChatAbortResult,
                openclaw::port::OpenClawSessionError,
            >,
            crate::sessions::RuntimeSessionError<openclaw::port::OpenClawSessionError>,
        >,
    > {
        Box::pin(async move {
            self.abort_chat(params)
                .await
                .map_err(crate::sessions::RuntimeSessionError::Client)
        })
    }

    fn select_session_model<'a>(
        &'a self,
        command: ResolvedSessionModelSelection,
    ) -> crate::runtime::driver::SessionFuture<'a, SessionModelSelectionOutcome> {
        Box::pin(self.select_session_model(command))
    }

    fn session_permission<'a>(
        &'a self,
        command: SessionPermissionCommand,
    ) -> crate::runtime::driver::SessionFuture<'a, SessionPermissionOutcome> {
        Box::pin(self.session_permission(command))
    }
}

fn map_attachment(
    attachment: Attachment,
) -> Result<openclaw::session::protocol::ChatAttachment, ()> {
    openclaw::session::protocol::ChatAttachment::try_new(
        attachment.mime_type,
        attachment.file_name,
        attachment.content,
    )
    .map_err(|_| ())
}
