use super::{interaction, model::send_failure, model_selection, permission};
use crate::{
    client::Client,
    driver::MatchaRuntimeDriver,
    session::{
        model::{RunRecord, RunStatus, SessionId, SessionRecord, valid_agent_id, valid_uuid},
        projection::parse_session_key,
        rpc::{self, Failure, FailureKind},
    },
};
use runtime_directory::RuntimeDriverIdentity;
use serde::Deserialize;
use serde_json::json;
use sessions_module::{
    SessionFuture, SessionOps,
    abort::{SessionAbortCommand, SessionAbortOutcome},
    approval::{
        PendingApprovalsCommand, PendingApprovalsOutcome, SessionApprovalCommand,
        SessionApprovalOutcome,
    },
    create::{SessionAdmission, SessionCreateCommand, SessionCreateOutcome, project_matcha_create},
    delete::{SessionDeleteCommand, SessionDeleteOutcome},
    model_selection::{
        MatchaSessionModelRuntimeCommand, ResolvedSessionModelSelection,
        SessionModelSelectionOutcome,
    },
    rename::{SessionRenameCommand, SessionRenameOutcome},
    send::{SessionSendCommand, SessionSendOutcome},
    session_catalog::{
        SessionCatalog, SessionCatalogCommand, SessionCatalogEntry, SessionCatalogOutcome,
    },
    session_history::{SessionHistoryCommand, SessionHistoryOutcome},
    session_permission::{SessionPermissionCommand, SessionPermissionOutcome},
    timeline,
};
use std::collections::HashSet;
use tokio_util::sync::CancellationToken;

impl SessionOps for MatchaRuntimeDriver {
    fn admission(&self) -> SessionAdmission {
        SessionAdmission::new(
            RuntimeDriverIdentity::matcha_agent().endpoint(),
            sessions_module::state::SessionProvider::MatchaAgent,
        )
    }
    fn prepare_observation(
        &self,
        request: sessions_module::SessionObservationRequest,
    ) -> Result<
        std::sync::Arc<dyn sessions_module::SessionObservation>,
        sessions_module::RuntimeOperationFailure,
    > {
        super::observation::prepare(self.session_handle(), self.renderer_events(), request)
    }
    fn agent_scoped_session_key(&self, agent: &str, id: &str) -> Option<String> {
        (valid_agent_id(agent) && valid_uuid(id)).then(|| format!("matcha-agent:{agent}:{id}"))
    }
    fn abort_session<'a>(
        &'a self,
        command: SessionAbortCommand,
    ) -> SessionFuture<'a, SessionAbortOutcome> {
        let client = self.native_client();
        Box::pin(async move { abort(&client, command).await })
    }
    fn create_session<'a>(
        &'a self,
        command: SessionCreateCommand,
        epoch: u64,
    ) -> SessionFuture<'a, SessionCreateOutcome> {
        let client = self.native_client();
        Box::pin(async move {
            if command.endpoint() != &RuntimeDriverIdentity::matcha_agent().endpoint()
                || parse_session_key(command.session_key())
                    != Some((command.agent_id(), command.endpoint_session_id()))
            {
                return SessionCreateOutcome::TargetRejected;
            }
            let Ok(id) = SessionId::try_new(command.endpoint_session_id().to_owned()) else {
                return SessionCreateOutcome::TargetRejected;
            };
            match crate::peer::session_create::create(&client, command.agent_id(), &id).await {
                Ok(record) => project_matcha_create(
                    command.session_key().to_owned(),
                    record.session_id.as_str().to_owned(),
                    Some(record.agent_id),
                    epoch,
                ),
                Err(error) => match error.kind() {
                    FailureKind::Rejected => SessionCreateOutcome::TargetRejected,
                    FailureKind::Unknown => SessionCreateOutcome::Unknown,
                    _ => SessionCreateOutcome::Unavailable,
                },
            }
        })
    }
    fn load_session_catalog<'a>(
        &'a self,
        command: SessionCatalogCommand,
    ) -> SessionFuture<'a, SessionCatalogOutcome> {
        let client = self.native_client();
        Box::pin(async move {
            let identity = RuntimeDriverIdentity::matcha_agent();
            if command.endpoint() != &identity.endpoint() {
                return SessionCatalogOutcome::Unavailable;
            }
            match records(&client).await {
                Ok(records) => {
                    SessionCatalogOutcome::Listed(SessionCatalog {
                        sessions: records
                            .into_iter()
                            .map(|record| {
                                SessionCatalogEntry {
                            endpoint: identity.endpoint(),
                            key: format!(
                                "matcha-agent:{}:{}",
                                record.agent_id,
                                record.session_id.as_str()
                            ),
                            agent_id: record.agent_id,
                            endpoint_session_id: record.session_id.as_str().to_owned(),
                            ownership: None,
                            label: record.title,
                            display_name: record.display_name,
                            model_state: record.model.as_deref().and_then(|model| {
                                sessions_module::state::SessionModelState::selected_from_ref(model)
                                    .ok()
                            }).map(|mut model| {
                                model.selection_id = record.model_selection_id;
                                model
                            }),
                            updated_at: Some(record.updated_at_ms),
                            preferred: Some(false),
                            protocol_id: Some(identity.protocol_id().to_owned()),
                            runtime_endpoint_id: Some(identity.endpoint_id()),
                        }
                            })
                            .collect(),
                    })
                }
                Err(_) => SessionCatalogOutcome::Unavailable,
            }
        })
    }
    fn rename_session<'a>(
        &'a self,
        command: SessionRenameCommand,
    ) -> SessionFuture<'a, SessionRenameOutcome> {
        let client = self.native_client();
        Box::pin(async move {
            let result = async {
                if command.identity.validate().is_err()
                    || command.identity.endpoint
                        != sessions_module::state::SessionEndpoint::local(
                            sessions_module::state::SessionProvider::MatchaAgent,
                        )
                {
                    return Err(Failure::InvalidInput);
                }
                let (agent, id) = parse_session_key(&command.identity.session_key)
                    .ok_or(Failure::InvalidInput)?;
                if agent != command.identity.agent_id {
                    return Err(Failure::InvalidInput);
                }
                rpc::get(&client, id, Some(agent)).await?;
                let record: SessionRecord = rpc::decode(
                    rpc::call(
                        &client,
                        "sessions.rename",
                        json!({"sessionId":id,"title":command.label}),
                    )
                    .await?,
                )?;
                if !record.validate(id, Some(agent))
                    || record.title.as_deref() != Some(command.label.as_str())
                {
                    return Err(Failure::InvalidReadback);
                }
                Ok(())
            }
            .await;
            match result {
                Ok(()) => SessionRenameOutcome::Succeeded,
                Err(error) if error.kind() == FailureKind::Rejected => {
                    SessionRenameOutcome::TargetRejected
                }
                Err(_) => SessionRenameOutcome::Unknown,
            }
        })
    }
    fn delete_session<'a>(
        &'a self,
        command: SessionDeleteCommand,
    ) -> SessionFuture<'a, SessionDeleteOutcome> {
        let client = self.native_client();
        Box::pin(async move {
            let result = async {
                if command.identity.validate().is_err()
                    || command.identity.endpoint
                        != sessions_module::state::SessionEndpoint::local(
                            sessions_module::state::SessionProvider::MatchaAgent,
                        )
                {
                    return Err(Failure::InvalidInput);
                }
                let (agent, id) = parse_session_key(&command.identity.session_key)
                    .ok_or(Failure::InvalidInput)?;
                if agent != command.identity.agent_id {
                    return Err(Failure::InvalidInput);
                }
                let record = match rpc::get(&client, id, Some(agent)).await {
                    Ok(record) => Some(record),
                    Err(error) if error.native_kind() == Some("session_deleting") => Some(
                        records(&client)
                            .await?
                            .into_iter()
                            .find(|record| {
                                record.session_id.as_str() == id && record.agent_id == agent
                            })
                            .ok_or(Failure::InvalidReadback)?,
                    ),
                    // A missing row is not proof of deletion. Only the Server's
                    // agent-bound, completed tombstone can acknowledge a lost reply.
                    Err(error) if error.is_not_found() => None,
                    Err(error) => return Err(error),
                };
                if record.is_some_and(|record| record.status != "deleting") {
                    let closed: SessionRecord = rpc::decode(
                        rpc::call(&client, "sessions.close", json!({"sessionId":id})).await?,
                    )?;
                    if !closed.validate(id, Some(agent)) || closed.status != "closed" {
                        return Err(Failure::InvalidReadback);
                    }
                }
                let receipt = rpc::call(
                    &client,
                    "sessions.delete",
                    json!({"sessionId":id,"expectedAgentId":agent}),
                )
                .await?;
                if receipt.get("sessionId").and_then(|v| v.as_str()) != Some(id)
                    || receipt.get("deleted").and_then(|v| v.as_bool()) != Some(true)
                    || receipt.get("cleanupComplete").and_then(|v| v.as_bool()) != Some(true)
                    || receipt.get("scope").and_then(|v| v.as_str()) != Some("session")
                {
                    return Err(Failure::InvalidReadback);
                }
                Ok(())
            }
            .await;
            match result {
                Ok(()) => SessionDeleteOutcome::Succeeded,
                Err(error) if error.kind() == FailureKind::Rejected => {
                    SessionDeleteOutcome::TargetRejected
                }
                Err(_) => SessionDeleteOutcome::Unknown,
            }
        })
    }
    fn send_session<'a>(
        &'a self,
        command: SessionSendCommand,
    ) -> SessionFuture<'a, SessionSendOutcome> {
        self.send_session_cancellable(command, CancellationToken::new())
    }
    fn send_session_cancellable<'a>(
        &'a self,
        command: SessionSendCommand,
        cancellation: CancellationToken,
    ) -> SessionFuture<'a, SessionSendOutcome> {
        let client = self.native_client();
        Box::pin(async move {
            if command.intent.is_some() {
                return SessionSendOutcome::Unsupported;
            }
            if cancellation.is_cancelled() {
                return SessionSendOutcome::Unavailable;
            }
            let record = match rpc::bound(
                &client,
                &command.identity,
                command.endpoint_session_id.as_deref(),
            )
            .await
            {
                Ok(record) => record,
                Err(error) => return send_failure(error),
            };
            let content = match super::model::content(&command) {
                Ok(content) => content,
                Err(outcome) => return outcome,
            };
            let result = rpc::call_cancellable(
                &client,
                "runs.submit",
                json!({"sessionId":record.session_id.as_str(),"content":content}),
                &cancellation,
            )
            .await;
            match result {
                Ok(receipt) => match (
                    receipt.get("sessionId").and_then(|v| v.as_str()),
                    receipt.get("runId").and_then(|v| v.as_str()),
                    receipt.get("status").and_then(|v| v.as_str()),
                ) {
                    (Some(id), Some(run), Some("queued"))
                        if id == record.session_id.as_str() && valid_uuid(run) =>
                    {
                        SessionSendOutcome::Queued {
                            run_id: run.to_owned(),
                        }
                    }
                    _ => SessionSendOutcome::Unknown,
                },
                Err(error) => send_failure(error),
            }
        })
    }
    fn session_model_runtime_command_cancellable<'a>(
        &'a self,
        identity: &'a sessions_module::state::SessionIdentity,
        endpoint_session_id: Option<&'a str>,
        trace_id: Option<&'a str>,
        cancellation: CancellationToken,
    ) -> SessionFuture<'a, Result<Option<MatchaSessionModelRuntimeCommand>, SessionSendOutcome>>
    {
        let client = self.native_client();
        Box::pin(async move {
            model_selection::restore(&client, identity, endpoint_session_id, trace_id, &cancellation).await
        })
    }
    fn select_session_model<'a>(
        &'a self,
        command: ResolvedSessionModelSelection,
    ) -> SessionFuture<'a, SessionModelSelectionOutcome> {
        self.select_session_model_cancellable(command, CancellationToken::new())
    }
    fn select_session_model_cancellable<'a>(
        &'a self,
        command: ResolvedSessionModelSelection,
        cancellation: CancellationToken,
    ) -> SessionFuture<'a, SessionModelSelectionOutcome> {
        let client = self.native_client();
        Box::pin(async move { model_selection::select(&client, command, &cancellation).await })
    }
    fn load_session_history<'a>(
        &'a self,
        command: SessionHistoryCommand,
    ) -> SessionFuture<'a, SessionHistoryOutcome> {
        let client = self.native_client();
        Box::pin(async move { super::timeline::history(&client, command).await })
    }
    fn load_session_timeline<'a>(
        &'a self,
        command: timeline::Command,
        epoch: u64,
    ) -> SessionFuture<'a, timeline::Outcome> {
        let client = self.native_client();
        Box::pin(async move { super::timeline::load(&client, command, epoch).await })
    }
    fn load_session_content<'a>(
        &'a self,
        command: timeline::ContentCommand,
    ) -> SessionFuture<'a, timeline::ContentOutcome> {
        let client = self.native_client();
        Box::pin(async move { super::timeline::content(&client, command).await })
    }
    fn pending_approvals<'a>(
        &'a self,
        command: PendingApprovalsCommand,
    ) -> SessionFuture<'a, PendingApprovalsOutcome> {
        let client = self.native_client();
        Box::pin(async move { interaction::approvals(&client, command).await })
    }
    fn respond_to_approval<'a>(
        &'a self,
        command: SessionApprovalCommand,
    ) -> SessionFuture<'a, SessionApprovalOutcome> {
        let client = self.native_client();
        Box::pin(async move { interaction::approve(&client, command).await })
    }
    fn pending_questions<'a>(
        &'a self,
        command: sessions_module::question::PendingQuestionsCommand,
    ) -> SessionFuture<'a, sessions_module::question::PendingQuestionsOutcome> {
        let client = self.native_client();
        Box::pin(async move { interaction::questions(&client, command).await })
    }
    fn respond_to_question<'a>(
        &'a self,
        command: sessions_module::question::SessionQuestionCommand,
    ) -> SessionFuture<'a, sessions_module::question::SessionQuestionOutcome> {
        let client = self.native_client();
        Box::pin(async move { interaction::answer(&client, command).await })
    }
    fn session_permission<'a>(
        &'a self,
        command: SessionPermissionCommand,
    ) -> SessionFuture<'a, SessionPermissionOutcome> {
        let client = self.native_client();
        Box::pin(async move { permission::apply(&client, command).await })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogPage {
    sessions: Vec<SessionRecord>,
    next_before_session_id: Option<String>,
}
async fn records(client: &Client) -> Result<Vec<SessionRecord>, Failure> {
    let mut records = Vec::new();
    let mut prior_page_ids = HashSet::new();
    let mut before = None::<String>;
    loop {
        let mut params = json!({"limit":100});
        if let Some(before) = &before {
            params["beforeSessionId"] = json!(before);
        }
        let page: CatalogPage = rpc::decode(rpc::call(client, "sessions.list", params).await?)?;
        if page.sessions.iter().any(|record| {
            !record.validate(record.session_id.as_str(), None)
                || prior_page_ids.contains(&record.session_id)
        }) {
            return Err(Failure::InvalidReadback);
        }
        let next = page.next_before_session_id;
        if next.is_some()
            && (page
                .sessions
                .last()
                .map(|record| record.session_id.as_str())
                != next.as_deref()
                || next == before)
        {
            return Err(Failure::InvalidReadback);
        }
        // Only earlier pages participate in duplicate checks; same-page duplicates remain accepted.
        prior_page_ids.extend(page.sessions.iter().map(|record| record.session_id.clone()));
        records.extend(page.sessions);
        before = next;
        if before.is_none() {
            return Ok(records);
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RunsPage {
    pub runs: Vec<RunRecord>,
    pub current_run: Option<RunRecord>,
    pub latest_seq: u64,
    pub next_before_run_id: Option<String>,
}
pub(super) async fn runs(
    client: &Client,
    id: &str,
    before: Option<&str>,
) -> Result<RunsPage, Failure> {
    let mut params = json!({"sessionId":id,"limit":100});
    if let Some(before) = before {
        params["beforeRunId"] = json!(before);
    }
    let value = rpc::call(client, "runs.list", params).await?;
    if value.get("currentRun").is_none() {
        return Err(Failure::InvalidReadback);
    }
    let page: RunsPage = rpc::decode(value)?;
    if page.latest_seq > sessions_module::state::MAX_SAFE_INTEGER
        || page.runs.len() > 100
        || page
            .current_run
            .as_ref()
            .is_some_and(|run| !run.validate(id))
        || page.runs.iter().enumerate().any(|(index, run)| {
            !run.validate(id)
                || page.runs[..index]
                    .iter()
                    .any(|prior| prior.run_id == run.run_id)
        })
        || (page.next_before_run_id.is_some()
            && (page.runs.last().map(|run| run.run_id.as_str())
                != page.next_before_run_id.as_deref()
                || page.next_before_run_id.as_deref() == before))
    {
        return Err(Failure::InvalidReadback);
    }
    Ok(page)
}
async fn abort(client: &Client, command: SessionAbortCommand) -> SessionAbortOutcome {
    let result = async {
        let record = rpc::bound(
            client,
            &command.identity,
            command.endpoint_session_id.as_deref(),
        )
        .await?;
        if command.approval_ids.is_some() {
            return Err(Failure::InvalidInput);
        }
        let selected = match command.run_id {
            Some(id) => {
                let run: RunRecord =
                    rpc::decode(rpc::call(client, "runs.get", json!({"runId":id})).await?)?;
                if run.run_id != id || !run.validate(record.session_id.as_str()) {
                    return Err(Failure::InvalidReadback);
                }
                vec![run]
            }
            None => {
                let mut selected = Vec::new();
                let mut before = None;
                loop {
                    let page = runs(client, record.session_id.as_str(), before.as_deref()).await?;
                    if page.runs.iter().any(|run| {
                        selected
                            .iter()
                            .any(|prior: &RunRecord| prior.run_id == run.run_id)
                    }) {
                        return Err(Failure::InvalidReadback);
                    }
                    selected.extend(page.runs);
                    before = page.next_before_run_id;
                    if before.is_none() {
                        break selected;
                    }
                }
            }
        };
        for run in selected.into_iter().filter(|run| !run.status.terminal()) {
            let returned: RunRecord =
                rpc::decode(rpc::call(client, "runs.cancel", json!({"runId":run.run_id})).await?)?;
            if !returned.validate(record.session_id.as_str())
                || returned.run_id != run.run_id
                || (!returned.status.terminal() && returned.status != RunStatus::CancelRequested)
            {
                return Err(Failure::InvalidReadback);
            }
        }
        Ok(())
    }
    .await;
    match result {
        Ok(()) => SessionAbortOutcome::Succeeded,
        Err(error) => match error.kind() {
            FailureKind::Rejected => SessionAbortOutcome::Rejected,
            FailureKind::Unknown => SessionAbortOutcome::Unknown,
            _ => SessionAbortOutcome::Unavailable,
        },
    }
}
