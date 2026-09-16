use super::*;

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
        updated_at: session.updated_at,
    })
}

impl SessionOps for OpenClawInstance {
    fn admission(&self) -> SessionAdmission {
        SessionAdmission::agent_scoped(
            RuntimeDriverIdentity::open_claw().endpoint(),
            crate::sessions::state::SessionProvider::OpenClaw,
            "agent",
        )
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
            let params = match command.clone().into_openclaw_params() {
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
