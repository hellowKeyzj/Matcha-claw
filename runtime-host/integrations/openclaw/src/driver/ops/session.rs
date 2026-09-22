use super::*;
use sessions_module::{
    model_selection::{
        NativeEndpoint, SessionModelSelectionDiagnostic, SessionRuntimeModelCommand,
        SessionRuntimeModelSource,
    },
    state::{SessionProvider, SessionView},
    timeline,
};

impl OpenClawDriver {
    pub(crate) async fn list_sessions(
        &self,
        params: crate::session::protocol::SessionsListParams,
    ) -> Result<crate::session::protocol::SessionsListResult, crate::port::OpenClawSessionError>
    {
        self.session_gateway.list_sessions(params).await
    }

    pub(crate) async fn history(
        &self,
        params: crate::session::protocol::ChatHistoryParams,
    ) -> Result<crate::session::protocol::ChatHistoryResult, crate::port::OpenClawSessionError>
    {
        self.session_gateway.history(params).await
    }

    pub(crate) async fn send_chat(
        &self,
        params: crate::session::protocol::ChatSendParams,
    ) -> Result<
        InvocationOutcome<
            crate::session::protocol::ChatSendResult,
            crate::port::OpenClawSessionError,
        >,
        crate::port::OpenClawSessionError,
    > {
        self.session_gateway.send_chat(params).await
    }

    pub(crate) async fn abort_chat(
        &self,
        params: crate::session::protocol::ChatAbortParams,
    ) -> Result<
        InvocationOutcome<
            crate::session::protocol::ChatAbortResult,
            crate::port::OpenClawSessionError,
        >,
        crate::port::OpenClawSessionError,
    > {
        self.session_gateway.abort_chat(params).await
    }

    pub(crate) async fn patch_session_label(
        &self,
        params: crate::session::protocol::SessionLabelPatchParams,
    ) -> Result<
        InvocationOutcome<
            crate::session::protocol::SessionLabelPatchResult,
            crate::port::OpenClawSessionError,
        >,
        crate::port::OpenClawSessionError,
    > {
        self.session_gateway.patch_session_label(params).await
    }

    pub(crate) async fn delete_session(
        &self,
        params: crate::session::protocol::SessionDeleteParams,
    ) -> Result<
        InvocationOutcome<
            crate::session::protocol::SessionDeleteResult,
            crate::port::OpenClawSessionError,
        >,
        crate::port::OpenClawSessionError,
    > {
        self.session_gateway.delete_session(params).await
    }

    pub(crate) async fn abort_session(&self, command: SessionAbortCommand) -> SessionAbortOutcome {
        let session_key = match crate::session::protocol::SessionKey::try_new(command.session_key) {
            Ok(session_key) => session_key,
            Err(_) => return SessionAbortOutcome::Rejected,
        };
        let params = match command.run_id {
            Some(run_id) => match crate::session::protocol::RunId::try_new(run_id) {
                Ok(run_id) => {
                    crate::session::protocol::ChatAbortParams::new(session_key).for_run(run_id)
                }
                Err(_) => return SessionAbortOutcome::Rejected,
            },
            None => crate::session::protocol::ChatAbortParams::new(session_key),
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
        let session_key =
            match crate::session::protocol::SessionKey::try_new(command.session_key().to_owned()) {
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
                        crate::session::protocol::SessionPermissionPatchParams::new(
                            session_key,
                            permission_mode.map(openclaw_session_permission_mode),
                        ),
                    )
                    .await
            }
        };
        match outcome {
            Ok(InvocationOutcome::Succeeded(projection)) => SessionPermissionOutcome::projection(
                project_openclaw_session_permission(projection),
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
        sessions_module::RuntimeSessionError<crate::port::OpenClawSessionError>,
    > {
        let session_key =
            crate::session::protocol::SessionKey::try_new(session_key).map_err(|_| {
                sessions_module::RuntimeSessionError::Client(
                    crate::port::OpenClawSessionError::TargetRejected,
                )
            })?;
        let row = self
            .session_gateway
            .describe_session(crate::session::protocol::SessionDescribeParams::new(
                session_key,
                None,
            ))
            .await
            .map_err(sessions_module::RuntimeSessionError::Client)?;
        Ok(match row {
            Some(row) => SessionRuntimeModelFacts {
                current_model: row.model_ref(),
                agent_id: row.agent_id.map(|agent_id| agent_id.as_str().to_owned()),
                model_override_source: row.model_override_source.map(|source| match source {
                    crate::session::protocol::SessionModelOverrideSource::User => {
                        SessionRuntimeModelSource::User
                    }
                    crate::session::protocol::SessionModelOverrideSource::Auto => {
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
        let session_key = match crate::session::protocol::SessionKey::try_new(command.session_key) {
            Ok(session_key) => session_key,
            Err(_) => {
                return SessionModelSelectionOutcome::target_rejected(
                    SessionModelSelectionRejection::InvalidSessionKey,
                );
            }
        };
        let model = match command.binding {
            SessionModelSelectionBinding::OpenClaw(model) => {
                match crate::session::protocol::ModelRef::try_new(model) {
                    Ok(model) => model,
                    Err(_) => {
                        return SessionModelSelectionOutcome::target_rejected_with_diagnostic(
                            SessionModelSelectionRejection::OpenClawModelRefInvalid,
                            command.diagnostic.clone(),
                        );
                    }
                }
            }
            SessionModelSelectionBinding::Matcha { .. } => {
                return SessionModelSelectionOutcome::target_rejected(
                    SessionModelSelectionRejection::BindingMismatch,
                );
            }
        };
        let params =
            crate::session::protocol::SessionModelPatchParams::new(session_key, Some(model));
        match self
            .session_gateway
            .patch_session_model_diagnostic(params)
            .await
        {
            Ok(InvocationOutcome::Succeeded(_)) => SessionModelSelectionOutcome::Succeeded,
            Ok(InvocationOutcome::TargetRejected(
                crate::port::SessionModelPatchFailure::TargetRejected(Some(rejection)),
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
        let session_key = match crate::session::protocol::SessionKey::try_new(command.session_key) {
            Ok(session_key) => session_key,
            Err(_) => return SessionSendOutcome::Rejected,
        };
        let idempotency_key = match crate::session::protocol::RunId::try_new(idempotency_key) {
            Ok(idempotency_key) => idempotency_key,
            Err(_) => return SessionSendOutcome::Rejected,
        };
        let mut params = match crate::session::protocol::ChatSendParams::try_new(
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

fn openclaw_session_permission_mode(
    mode: sessions_module::session_permission::SessionPermissionMode,
) -> crate::session::protocol::SessionPermissionMode {
    match mode {
        sessions_module::session_permission::SessionPermissionMode::ReadOnly => {
            crate::session::protocol::SessionPermissionMode::ReadOnly
        }
        sessions_module::session_permission::SessionPermissionMode::Guarded => {
            crate::session::protocol::SessionPermissionMode::Guarded
        }
        sessions_module::session_permission::SessionPermissionMode::Workspace => {
            crate::session::protocol::SessionPermissionMode::Workspace
        }
        sessions_module::session_permission::SessionPermissionMode::Full => {
            crate::session::protocol::SessionPermissionMode::Full
        }
    }
}

fn project_openclaw_session_permission(
    projection: crate::session::protocol::SessionPermissionProjection,
) -> SessionPermissionProjection {
    if projection.supported {
        SessionPermissionProjection::supported(
            projection
                .mode
                .map(project_openclaw_session_permission_mode),
            projection
                .default_mode
                .map(project_openclaw_session_permission_mode),
            projection.pending,
            projection.can_select_full,
        )
    } else {
        SessionPermissionProjection::unsupported("Session permission is unsupported")
    }
}

fn project_openclaw_session_permission_mode(
    mode: crate::session::protocol::SessionPermissionMode,
) -> sessions_module::session_permission::SessionPermissionMode {
    match mode {
        crate::session::protocol::SessionPermissionMode::ReadOnly => {
            sessions_module::session_permission::SessionPermissionMode::ReadOnly
        }
        crate::session::protocol::SessionPermissionMode::Guarded => {
            sessions_module::session_permission::SessionPermissionMode::Guarded
        }
        crate::session::protocol::SessionPermissionMode::Workspace => {
            sessions_module::session_permission::SessionPermissionMode::Workspace
        }
        crate::session::protocol::SessionPermissionMode::Full => {
            sessions_module::session_permission::SessionPermissionMode::Full
        }
    }
}

fn openclaw_create_params(
    command: &SessionCreateCommand,
    model: crate::session::protocol::ModelRef,
) -> Result<crate::session::protocol::SessionCreateParams, ()> {
    let agent_id = crate::session::protocol::AgentId::try_new(command.agent_id().to_owned())
        .map_err(|_| ())?;
    let endpoint_session_id = crate::session::protocol::EndpointSessionId::try_new(
        command.endpoint_session_id().to_owned(),
    )
    .map_err(|_| ())?;
    crate::session::protocol::SessionCreateParams::try_new(agent_id, endpoint_session_id, model)
        .map_err(|_| ())
}

fn project_openclaw_create(
    command: &SessionCreateCommand,
    outcome: InvocationOutcome<
        crate::session::protocol::SessionCreateResult,
        crate::port::OpenClawSessionError,
    >,
    epoch: u64,
) -> SessionCreateOutcome {
    match outcome {
        InvocationOutcome::Succeeded(result) => {
            let _ = result;
            sessions_module::create::project_created_session_view(
                command.session_key().to_owned(),
                Some(command.endpoint_session_id().to_owned()),
                SessionProvider::OpenClaw,
                Some(command.agent_id().to_owned()),
                epoch,
            )
            .map(SessionCreateOutcome::Succeeded)
            .unwrap_or(SessionCreateOutcome::Unknown)
        }
        InvocationOutcome::TargetRejected(_) => SessionCreateOutcome::TargetRejected,
        InvocationOutcome::Cancelled | InvocationOutcome::Unknown => SessionCreateOutcome::Unknown,
    }
}

const fn project_openclaw_create_error(
    error: crate::port::OpenClawSessionError,
) -> SessionCreateOutcome {
    match error {
        crate::port::OpenClawSessionError::TargetRejected => SessionCreateOutcome::TargetRejected,
        crate::port::OpenClawSessionError::SessionConnection
        | crate::port::OpenClawSessionError::RequestIdExhausted
        | crate::port::OpenClawSessionError::RequestDeadline
        | crate::port::OpenClawSessionError::ConnectionClosed
        | crate::port::OpenClawSessionError::UnknownResponse
        | crate::port::OpenClawSessionError::Transport
        | crate::port::OpenClawSessionError::Protocol(_)
        | crate::port::OpenClawSessionError::EventBackpressure => SessionCreateOutcome::Unavailable,
    }
}

fn openclaw_rename_params(
    command: &SessionRenameCommand,
) -> Result<crate::session::protocol::SessionLabelPatchParams, ()> {
    let agent_id =
        crate::session::protocol::AgentId::try_new(command.agent_id.clone()).map_err(|_| ())?;
    let prefix = format!("agent:{}:", agent_id.as_str());
    let endpoint_session_id = command
        .session_key
        .strip_prefix(&prefix)
        .and_then(|value| {
            crate::session::protocol::EndpointSessionId::try_new(value.to_owned()).ok()
        })
        .ok_or(())?;
    let session_key =
        crate::session::protocol::AgentScopedSessionKey::try_new(agent_id, endpoint_session_id)
            .map_err(|_| ())?;
    let session_key =
        crate::session::protocol::SessionKey::try_new(session_key.as_str().to_owned())
            .map_err(|_| ())?;
    crate::session::protocol::SessionLabelPatchParams::try_new(session_key, command.label.clone())
        .map_err(|_| ())
}

fn project_openclaw_rename(
    outcome: InvocationOutcome<
        crate::session::protocol::SessionLabelPatchResult,
        crate::port::OpenClawSessionError,
    >,
) -> SessionRenameOutcome {
    match outcome {
        InvocationOutcome::Succeeded(_) => SessionRenameOutcome::Succeeded,
        InvocationOutcome::TargetRejected(_) => SessionRenameOutcome::TargetRejected,
        InvocationOutcome::Cancelled | InvocationOutcome::Unknown => SessionRenameOutcome::Unknown,
    }
}

const fn project_openclaw_rename_error(
    error: crate::port::OpenClawSessionError,
) -> SessionRenameOutcome {
    match error {
        crate::port::OpenClawSessionError::TargetRejected => SessionRenameOutcome::TargetRejected,
        crate::port::OpenClawSessionError::SessionConnection
        | crate::port::OpenClawSessionError::RequestIdExhausted
        | crate::port::OpenClawSessionError::RequestDeadline
        | crate::port::OpenClawSessionError::ConnectionClosed
        | crate::port::OpenClawSessionError::UnknownResponse
        | crate::port::OpenClawSessionError::Transport
        | crate::port::OpenClawSessionError::Protocol(_)
        | crate::port::OpenClawSessionError::EventBackpressure => SessionRenameOutcome::Unknown,
    }
}

fn openclaw_delete_params(
    command: &SessionDeleteCommand,
) -> Result<crate::session::protocol::SessionDeleteParams, ()> {
    let agent_id =
        crate::session::protocol::AgentId::try_new(command.agent_id.clone()).map_err(|_| ())?;
    let scoped = command.session_key.strip_prefix("agent:").ok_or(())?;
    let (actual_agent_id, endpoint_session_id) = scoped.split_once(':').ok_or(())?;
    if actual_agent_id != agent_id.as_str() {
        return Err(());
    }
    let endpoint_session_id =
        crate::session::protocol::EndpointSessionId::try_new(endpoint_session_id.to_owned())
            .map_err(|_| ())?;
    let key =
        crate::session::protocol::AgentScopedSessionKey::try_new(agent_id, endpoint_session_id)
            .map_err(|_| ())?;
    Ok(crate::session::protocol::SessionDeleteParams::new(key))
}

fn project_openclaw_delete(
    outcome: InvocationOutcome<
        crate::session::protocol::SessionDeleteResult,
        crate::port::OpenClawSessionError,
    >,
) -> SessionDeleteOutcome {
    match outcome {
        InvocationOutcome::Succeeded(crate::session::protocol::SessionDeleteResult {
            deleted: true,
        }) => SessionDeleteOutcome::Succeeded,
        InvocationOutcome::Succeeded(crate::session::protocol::SessionDeleteResult {
            deleted: false,
        })
        | InvocationOutcome::TargetRejected(_) => SessionDeleteOutcome::TargetRejected,
        InvocationOutcome::Cancelled | InvocationOutcome::Unknown => SessionDeleteOutcome::Unknown,
    }
}

const fn project_openclaw_delete_error(
    error: crate::port::OpenClawSessionError,
) -> SessionDeleteOutcome {
    match error {
        crate::port::OpenClawSessionError::TargetRejected => SessionDeleteOutcome::TargetRejected,
        crate::port::OpenClawSessionError::SessionConnection
        | crate::port::OpenClawSessionError::RequestIdExhausted
        | crate::port::OpenClawSessionError::RequestDeadline
        | crate::port::OpenClawSessionError::ConnectionClosed
        | crate::port::OpenClawSessionError::UnknownResponse
        | crate::port::OpenClawSessionError::Transport
        | crate::port::OpenClawSessionError::Protocol(_)
        | crate::port::OpenClawSessionError::EventBackpressure => SessionDeleteOutcome::Unknown,
    }
}

fn project_openclaw_session_catalog(
    result: crate::session::protocol::SessionsListResult,
) -> SessionCatalog {
    SessionCatalog {
        sessions: result
            .sessions
            .into_iter()
            .filter_map(project_openclaw_session_catalog_entry)
            .collect(),
    }
}

fn project_openclaw_session_catalog_entry(
    session: crate::session::protocol::SessionSummary,
) -> Option<SessionCatalogEntry> {
    let entry = session.agent_scoped_catalog_entry()?;
    Some(SessionCatalogEntry {
        endpoint: RuntimeDriverIdentity::open_claw().endpoint(),
        key: entry.session_key.as_str().to_owned(),
        agent_id: entry.agent_id.as_str().to_owned(),
        endpoint_session_id: entry.endpoint_session_id,
        model: session.model,
        updated_at: session.updated_at,
        preferred: None,
        protocol_id: None,
        runtime_endpoint_id: None,
    })
}

fn project_openclaw_session_history(
    result: crate::session::protocol::ChatHistoryResult,
) -> SessionHistoryView {
    SessionHistoryView {
        messages: result
            .messages
            .into_iter()
            .map(project_openclaw_session_history_message)
            .collect(),
    }
}

fn project_openclaw_session_history_message(
    message: crate::session::protocol::HistoryMessage,
) -> SessionHistoryMessage {
    SessionHistoryMessage {
        role: match message.role {
            crate::session::protocol::HistoryRole::User => SessionHistoryRole::User,
            crate::session::protocol::HistoryRole::Assistant => SessionHistoryRole::Assistant,
        },
        text: message.text,
    }
}

const fn project_openclaw_session_history_error(
    error: crate::port::OpenClawSessionError,
) -> SessionHistoryFailure {
    match error {
        crate::port::OpenClawSessionError::TargetRejected => SessionHistoryFailure::Rejected,
        crate::port::OpenClawSessionError::RequestDeadline => SessionHistoryFailure::Deadline,
        crate::port::OpenClawSessionError::Protocol(_)
        | crate::port::OpenClawSessionError::UnknownResponse => SessionHistoryFailure::Protocol,
        crate::port::OpenClawSessionError::SessionConnection
        | crate::port::OpenClawSessionError::RequestIdExhausted
        | crate::port::OpenClawSessionError::ConnectionClosed
        | crate::port::OpenClawSessionError::Transport
        | crate::port::OpenClawSessionError::EventBackpressure => {
            SessionHistoryFailure::Unavailable
        }
    }
}

impl SessionOpenOps for OpenClawDriver {
    fn on_load_session_timeline<'a>(
        &'a self,
        command: &'a timeline::Command,
        view: SessionView,
        provider_handle: ProviderHandle,
    ) -> sessions_module::SessionFuture<'a, SessionView> {
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
                        .accept_session_runtime_models(
                            provider_module::ProviderSessionEndpoint::OpenClawLocal,
                            vec![model.to_owned()],
                        )
                        .await;
                    if matches!(accepted.as_ref(), Ok(provider_module::ProviderSessionRuntimeModelsOutcome::Accepted(accepted)) if accepted.first() == Some(&true))
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
            let Ok(provider_module::ProviderSessionModelSelectionOutcome::Selected(selection)) =
                provider_handle
                    .select_session_model_rebound(
                        provider_module::ProviderSessionEndpoint::OpenClawLocal,
                        rebound.session_key,
                        rebound.endpoint_session_id,
                        rebound.current_model,
                        rebound.default_model,
                        rebound.trace_id,
                    )
                    .await
            else {
                log_session_model_reconcile_skipped(
                    "rebound_unresolved",
                    command,
                    facts.current_model.as_deref(),
                    default_model.as_deref(),
                );
                return view;
            };
            let resolved_model = Some(selection.runtime_model_ref);
            let diagnostic = Some(SessionModelSelectionDiagnostic::new(
                selection.account_id,
                selection.model_id,
                selection.protocol,
                selection.auth_mode,
            ));
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
    ) -> sessions_module::SessionFuture<'a, Option<String>> {
        Box::pin(async move { self.configured_agent_model(&agent_id).await })
    }
}

fn log_session_model_reconciled(
    session_key: &str,
    previous_model: Option<&str>,
    resolved_model: Option<&str>,
    diagnostic: Option<&SessionModelSelectionDiagnostic>,
) {
    use sessions_module::trace as session_trace;

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
    use sessions_module::trace as session_trace;

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
    use sessions_module::trace as session_trace;

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
    use sessions_module::trace as session_trace;

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

impl SessionOps for OpenClawDriver {
    fn admission(&self) -> SessionAdmission {
        SessionAdmission::new(
            RuntimeDriverIdentity::open_claw().endpoint(),
            sessions_module::state::SessionProvider::OpenClaw,
            None,
        )
    }

    fn abort_session<'a>(
        &'a self,
        command: SessionAbortCommand,
    ) -> sessions_module::SessionFuture<'a, SessionAbortOutcome> {
        Box::pin(self.abort_session(command))
    }

    fn create_session<'a>(
        &'a self,
        command: SessionCreateCommand,
        epoch: u64,
    ) -> sessions_module::SessionFuture<'a, SessionCreateOutcome> {
        Box::pin(async move {
            let default_model = match self.configured_agent_model(command.agent_id()).await {
                Some(model) => model,
                None => return SessionCreateOutcome::Unavailable,
            };
            let model = match crate::session::protocol::ModelRef::try_new(default_model) {
                Ok(model) => model,
                Err(_) => return SessionCreateOutcome::TargetRejected,
            };
            let params = match openclaw_create_params(&command, model) {
                Ok(params) => params,
                Err(_) => return SessionCreateOutcome::TargetRejected,
            };
            match self.session_gateway.create_session(params).await {
                Ok(outcome) => project_openclaw_create(&command, outcome, epoch),
                Err(error) => project_openclaw_create_error(error),
            }
        })
    }

    fn load_session_catalog<'a>(
        &'a self,
        command: SessionCatalogCommand,
    ) -> sessions_module::SessionFuture<'a, SessionCatalogOutcome> {
        Box::pin(async move {
            if command.endpoint() != &RuntimeDriverIdentity::open_claw().endpoint() {
                return SessionCatalogOutcome::Unavailable;
            }
            match self
                .list_sessions(crate::session::protocol::SessionsListParams::default())
                .await
            {
                Ok(result) => {
                    SessionCatalogOutcome::Listed(project_openclaw_session_catalog(result))
                }
                Err(_) => SessionCatalogOutcome::Unavailable,
            }
        })
    }

    fn open_session_ops(&self) -> Option<&dyn SessionOpenOps> {
        Some(self)
    }

    fn load_session_history<'a>(
        &'a self,
        command: SessionHistoryCommand,
    ) -> sessions_module::SessionFuture<'a, SessionHistoryOutcome> {
        Box::pin(async move {
            let session_key = match crate::session::protocol::SessionKey::try_new(
                command.session_key().to_owned(),
            ) {
                Ok(session_key) => session_key,
                Err(_) => return SessionHistoryOutcome::Failed(SessionHistoryFailure::Protocol),
            };
            let mut params = crate::session::protocol::ChatHistoryParams::new(session_key);
            if let Some(limit) = command.limit() {
                params = match params.try_with_limit(limit) {
                    Ok(params) => params,
                    Err(_) => {
                        return SessionHistoryOutcome::Failed(SessionHistoryFailure::Protocol);
                    }
                };
            }
            match self.history(params).await {
                Ok(result) => {
                    SessionHistoryOutcome::Loaded(project_openclaw_session_history(result))
                }
                Err(error) => {
                    SessionHistoryOutcome::Failed(project_openclaw_session_history_error(error))
                }
            }
        })
    }

    fn rename_session<'a>(
        &'a self,
        command: SessionRenameCommand,
    ) -> sessions_module::SessionFuture<'a, SessionRenameOutcome> {
        Box::pin(async move {
            let params = match openclaw_rename_params(&command) {
                Ok(params) => params,
                Err(_) => return SessionRenameOutcome::TargetRejected,
            };
            match self.patch_session_label(params).await {
                Ok(outcome) => project_openclaw_rename(outcome),
                Err(error) => project_openclaw_rename_error(error),
            }
        })
    }

    fn delete_session<'a>(
        &'a self,
        command: SessionDeleteCommand,
    ) -> sessions_module::SessionFuture<'a, SessionDeleteOutcome> {
        Box::pin(async move {
            let params = match openclaw_delete_params(&command) {
                Ok(params) => params,
                Err(_) => return SessionDeleteOutcome::TargetRejected,
            };
            match self.delete_session(params).await {
                Ok(outcome) => project_openclaw_delete(outcome),
                Err(error) => project_openclaw_delete_error(error),
            }
        })
    }

    fn load_session_timeline<'a>(
        &'a self,
        command: sessions_module::timeline::Command,
        epoch: u64,
    ) -> sessions_module::SessionFuture<'a, sessions_module::timeline::Outcome> {
        Box::pin(self.load_openclaw_session_timeline(command, epoch))
    }

    fn load_session_content<'a>(
        &'a self,
        command: sessions_module::timeline::ContentCommand,
    ) -> sessions_module::SessionFuture<'a, sessions_module::timeline::ContentOutcome> {
        Box::pin(async move {
            let _ = command;
            sessions_module::timeline::ContentOutcome::unavailable(
                sessions_module::timeline::UnavailableReason::RuntimeUnsupported,
            )
        })
    }

    fn send_session<'a>(
        &'a self,
        command: SessionSendCommand,
    ) -> sessions_module::SessionFuture<'a, SessionSendOutcome> {
        Box::pin(self.send_session(command))
    }

    fn select_session_model<'a>(
        &'a self,
        command: ResolvedSessionModelSelection,
    ) -> sessions_module::SessionFuture<'a, SessionModelSelectionOutcome> {
        Box::pin(self.select_session_model(command))
    }

    fn session_permission<'a>(
        &'a self,
        command: SessionPermissionCommand,
    ) -> sessions_module::SessionFuture<'a, SessionPermissionOutcome> {
        Box::pin(self.session_permission(command))
    }
}

fn map_attachment(attachment: Attachment) -> Result<crate::session::protocol::ChatAttachment, ()> {
    crate::session::protocol::ChatAttachment::try_new(
        attachment.mime_type,
        attachment.file_name,
        attachment.content,
    )
    .map_err(|_| ())
}
