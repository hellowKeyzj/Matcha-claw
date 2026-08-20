use std::{path::PathBuf, sync::Arc};

use foundation::process::{ShutdownOutcome, supervision::SupervisorSnapshot};
use platform::exchange::InvocationOutcome;

use matcha_agent::{
    lifecycle::{output::StartupDiagnosticCategory, secret::Secret},
    peer::{JoinError, MatchaPeer, MatchaPeerFactory, MatchaPeerInput, MatchaPeerLifecycleHandle},
    team::{MatchaTeamNativeEffects, abort_role_sessions, delete_role_sessions, deliver_prompt},
};

pub use matcha_agent::peer::ConstructionError;

use crate::{
    runtime_driver::{
        LifecycleOps, OwnedRuntimeFuture, RuntimeCapabilitySurface, RuntimeDriver,
        RuntimeDriverIdentity, SessionOps, TeamOps,
    },
    session_abort::{SessionAbortCommand, SessionAbortOutcome},
    session_approval::{
        PendingApproval, PendingApprovals, PendingApprovalsCommand, PendingApprovalsOutcome,
        SessionApprovalCommand, SessionApprovalOutcome,
    },
    session_create::{SessionCreateCommand, SessionCreateOutcome, project_matcha_create},
    session_model_selection::{
        MatchaProviderRuntimeConfig, ResolvedSessionModelSelection, SessionModelSelectionBinding,
        SessionModelSelectionOutcome, SessionModelSelectionRejection,
    },
    session_send::{Attachment, SessionSendCommand, SessionSendOutcome, SessionSendStatus},
};

pub(super) struct MatchaAgentInstance {
    peer: Option<MatchaPeer>,
}

impl MatchaAgentInstance {
    pub(super) const fn new(peer: MatchaPeer) -> Self {
        Self { peer: Some(peer) }
    }

    pub(super) fn peer(&self) -> &MatchaPeer {
        self.peer
            .as_ref()
            .expect("matcha peer must be present before shutdown completes")
    }

    pub(super) fn peer_if_present(&self) -> Option<&MatchaPeer> {
        self.peer.as_ref()
    }

    pub(super) fn take_peer(&mut self) -> MatchaPeer {
        self.peer
            .take()
            .expect("matcha peer must be present before shutdown completes")
    }

    pub(super) fn snapshot(&self) -> SupervisorSnapshot {
        self.peer().snapshot()
    }

    pub(super) fn lifecycle_handle(&self) -> MatchaPeerLifecycleHandle {
        self.peer().lifecycle_handle()
    }

    pub(super) async fn confirm_shutdown(
        &self,
    ) -> Result<ShutdownOutcome, matcha_agent::peer::ShutdownError> {
        self.peer().confirm_shutdown().await
    }

    pub(super) async fn join(mut self) -> Result<(), JoinError> {
        self.take_peer().join().await
    }
}

impl RuntimeDriver for MatchaAgentInstance {
    fn identity(&self) -> RuntimeDriverIdentity {
        RuntimeDriverIdentity::matcha_agent()
    }

    fn capability_surface(&self) -> RuntimeCapabilitySurface {
        RuntimeCapabilitySurface::matcha_agent()
    }

    fn session_ops(&self) -> Option<&dyn SessionOps> {
        Some(self)
    }

    fn team_ops(&self) -> Option<&dyn TeamOps> {
        Some(self)
    }

    fn lifecycle_ops(&self) -> Option<&dyn LifecycleOps> {
        Some(self)
    }
}

impl SessionOps for MatchaAgentInstance {
    fn abort_session<'a>(
        &'a self,
        command: SessionAbortCommand,
    ) -> crate::runtime_driver::SessionFuture<'a, SessionAbortOutcome> {
        Box::pin(abort_session(self.peer(), command))
    }

    fn create_session<'a>(
        &'a self,
        command: SessionCreateCommand,
        epoch: u64,
    ) -> crate::runtime_driver::SessionFuture<'a, SessionCreateOutcome> {
        Box::pin(create_session(self.peer(), command, epoch))
    }

    fn pending_approvals<'a>(
        &'a self,
        command: PendingApprovalsCommand,
    ) -> crate::runtime_driver::SessionFuture<'a, PendingApprovalsOutcome> {
        Box::pin(pending_approvals(self.peer(), command))
    }

    fn respond_to_approval<'a>(
        &'a self,
        command: SessionApprovalCommand,
    ) -> crate::runtime_driver::SessionFuture<'a, SessionApprovalOutcome> {
        Box::pin(respond_to_approval(self.peer(), command))
    }

    fn send_session<'a>(
        &'a self,
        command: SessionSendCommand,
    ) -> crate::runtime_driver::SessionFuture<'a, SessionSendOutcome> {
        Box::pin(send_session(self.peer(), command))
    }

    fn select_session_model<'a>(
        &'a self,
        command: ResolvedSessionModelSelection,
    ) -> crate::runtime_driver::SessionFuture<'a, SessionModelSelectionOutcome> {
        Box::pin(select_session_model(self.peer(), command))
    }
}
impl TeamOps for MatchaAgentInstance {
    fn materialize_team(
        &self,
        _request: organization::TeamMaterializationRequest,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        Box::pin(async {
            organization::MaterializationOperationOutcome::Rejected {
                rejection: organization::MaterializationRejection::Permanent,
            }
        })
    }

    fn remove_team(
        &self,
        _removal: organization::TeamMaterializationRemoval,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        Box::pin(async { organization::MaterializationOperationOutcome::OutcomeUnknown })
    }

    fn recover_team_materialization(
        &self,
        _request: organization::TeamMaterializationRequest,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        Box::pin(async { organization::MaterializationOperationOutcome::OutcomeUnknown })
    }

    fn confirm_team_run_receipt(
        &self,
        _receipt: organization::RunRuntimeReceipt,
    ) -> OwnedRuntimeFuture<crate::composition::RuntimeReceiptOutcome> {
        Box::pin(async { crate::composition::RuntimeReceiptOutcome::OutcomeUnknown })
    }

    fn deliver_prompt(
        &self,
        request: organization::PromptDeliveryRequest,
    ) -> OwnedRuntimeFuture<organization::PromptDeliveryOutcome> {
        Box::pin(deliver_prompt(self.peer(), request))
    }

    fn abort_role_sessions(
        &self,
        bindings: Vec<organization::RoleSessionReceipt>,
    ) -> OwnedRuntimeFuture<organization::RoleAbortOutcome> {
        Box::pin(abort_role_sessions(self.peer(), bindings))
    }

    fn delete_role_sessions(
        &self,
        run_id: organization::GraphRunId,
        bindings: Vec<organization::RoleSessionReceipt>,
        abort_first: bool,
    ) -> OwnedRuntimeFuture<organization::NativeDeletionEvidence> {
        Box::pin(delete_role_sessions(
            self.peer(),
            run_id,
            bindings,
            abort_first,
        ))
    }
}

impl LifecycleOps for MatchaAgentInstance {
    fn snapshot(&self) -> SupervisorSnapshot {
        self.snapshot()
    }
}

pub(super) async fn abort_session(
    peer: &MatchaPeer,
    command: SessionAbortCommand,
) -> SessionAbortOutcome {
    let session_id = match matcha_agent::session::model::SessionId::try_new(command.session_key) {
        Ok(session_id) => session_id,
        Err(_) => return SessionAbortOutcome::Rejected,
    };
    let params = match command.run_id {
        Some(run_id) => match matcha_agent::session::model::RunId::try_new(run_id) {
            Ok(run_id) => matcha_agent::session::request::SessionCancelParams::new(session_id)
                .with_run_id(run_id),
            Err(_) => return SessionAbortOutcome::Rejected,
        },
        None => matcha_agent::session::request::SessionCancelParams::new(session_id),
    };
    match peer.cancel_session(params).await {
        InvocationOutcome::Succeeded(_) => SessionAbortOutcome::Succeeded,
        InvocationOutcome::TargetRejected(_) => SessionAbortOutcome::Rejected,
        InvocationOutcome::Cancelled | InvocationOutcome::Unknown => SessionAbortOutcome::Unknown,
    }
}

pub(super) async fn pending_approvals(
    peer: &MatchaPeer,
    command: PendingApprovalsCommand,
) -> PendingApprovalsOutcome {
    let session_id = match matcha_agent::session::model::SessionId::try_new(command.session_id) {
        Ok(session_id) => session_id,
        Err(_) => return PendingApprovalsOutcome::Rejected,
    };
    match peer.pending_approvals(session_id).await {
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
        Err(matcha_agent::session::client::AppServerClientError::ConnectionClosed) => {
            PendingApprovalsOutcome::Unavailable
        }
        Err(matcha_agent::session::client::AppServerClientError::Protocol) => {
            PendingApprovalsOutcome::Unknown
        }
        Err(_) => PendingApprovalsOutcome::Rejected,
    }
}

pub(super) async fn respond_to_approval(
    peer: &MatchaPeer,
    command: SessionApprovalCommand,
) -> SessionApprovalOutcome {
    let session_id = match matcha_agent::session::model::SessionId::try_new(command.session_id) {
        Ok(session_id) => session_id,
        Err(_) => return SessionApprovalOutcome::Rejected,
    };
    let approval_id = match matcha_agent::session::model::ApprovalId::try_new(command.approval_id) {
        Ok(approval_id) => approval_id,
        Err(_) => return SessionApprovalOutcome::Rejected,
    };
    let option_id = match matcha_agent::session::model::OptionId::try_new(command.option_id) {
        Ok(option_id) => option_id,
        Err(_) => return SessionApprovalOutcome::Rejected,
    };
    match peer
        .respond_to_approval(matcha_agent::session::approval::ApprovalRespondParams::new(
            session_id,
            approval_id,
            option_id,
        ))
        .await
    {
        InvocationOutcome::Succeeded(()) => SessionApprovalOutcome::Responded,
        InvocationOutcome::TargetRejected(_) => SessionApprovalOutcome::Rejected,
        InvocationOutcome::Cancelled | InvocationOutcome::Unknown => {
            SessionApprovalOutcome::Unknown
        }
    }
}

pub(super) async fn select_session_model(
    peer: &MatchaPeer,
    command: ResolvedSessionModelSelection,
) -> SessionModelSelectionOutcome {
    let session_id = match matcha_agent::session::model::SessionId::try_new(command.session_key) {
        Ok(session_id) => session_id,
        Err(_) => {
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
        return SessionModelSelectionOutcome::target_rejected(
            SessionModelSelectionRejection::BindingMismatch,
        );
    };
    let params =
        match matcha_agent::session::request::SessionSetModelParams::try_new(session_id, model) {
            Ok(params) => params
                .with_provider_fingerprint(provider_fingerprint)
                .with_provider_runtime(matcha_provider_runtime(provider_runtime)),
            Err(_) => {
                return SessionModelSelectionOutcome::target_rejected(
                    SessionModelSelectionRejection::InvalidModel,
                );
            }
        };
    match peer.set_session_model(params).await {
        InvocationOutcome::Succeeded(_) => SessionModelSelectionOutcome::Succeeded,
        InvocationOutcome::TargetRejected(
            matcha_agent::session::client::AppServerClientError::SessionNotFound,
        ) => SessionModelSelectionOutcome::target_rejected(
            SessionModelSelectionRejection::SessionNotFound,
        ),
        InvocationOutcome::TargetRejected(_) => SessionModelSelectionOutcome::target_rejected(
            SessionModelSelectionRejection::RuntimeTargetRejected,
        ),
        InvocationOutcome::Cancelled | InvocationOutcome::Unknown => {
            SessionModelSelectionOutcome::OutcomeUnknown
        }
    }
}

fn matcha_provider_runtime(
    provider_runtime: MatchaProviderRuntimeConfig,
) -> matcha_agent::session::request::SessionProviderRuntime {
    match provider_runtime {
        MatchaProviderRuntimeConfig::AnthropicMessages { base_url, api_key } => {
            matcha_agent::session::request::SessionProviderRuntime::anthropic_messages(
                base_url,
                api_key.map(|value| value.into_private_string()),
            )
        }
        MatchaProviderRuntimeConfig::GoogleGenerativeAi { base_url, api_key } => {
            matcha_agent::session::request::SessionProviderRuntime::google_generative_ai(
                base_url,
                api_key.map(|value| value.into_private_string()),
            )
        }
        MatchaProviderRuntimeConfig::OpenAiChatCompletions { base_url, api_key } => {
            matcha_agent::session::request::SessionProviderRuntime::open_ai_chat_completions(
                base_url,
                api_key.map(|value| value.into_private_string()),
            )
        }
        MatchaProviderRuntimeConfig::OpenAiResponses { base_url, api_key } => {
            matcha_agent::session::request::SessionProviderRuntime::open_ai_responses(
                base_url,
                api_key.map(|value| value.into_private_string()),
            )
        }
    }
}

pub(super) async fn create_session(
    peer: &MatchaPeer,
    command: SessionCreateCommand,
    epoch: u64,
) -> SessionCreateOutcome {
    let agent_id = command.agent_id_owned();
    let session_id = match command.into_matcha_session_id() {
        Ok(session_id) => session_id,
        Err(_) => return SessionCreateOutcome::TargetRejected,
    };
    match peer.create_session(session_id).await {
        InvocationOutcome::Succeeded(returned) => {
            project_matcha_create(returned.as_str().to_owned(), Some(agent_id), epoch)
        }
        InvocationOutcome::Cancelled | InvocationOutcome::Unknown => {
            SessionCreateOutcome::Unavailable
        }
        InvocationOutcome::TargetRejected(_) => SessionCreateOutcome::TargetRejected,
    }
}

pub(super) async fn send_session(
    peer: &MatchaPeer,
    command: SessionSendCommand,
) -> SessionSendOutcome {
    let params = match session_prompt_params(command) {
        Ok(params) => params,
        Err(()) => return SessionSendOutcome::Rejected,
    };
    match peer.prompt_session(params).await {
        InvocationOutcome::Succeeded(result) => SessionSendOutcome::Succeeded {
            run_id: result.run_id.as_str().to_owned(),
            status: SessionSendStatus::Started,
        },
        InvocationOutcome::TargetRejected(_) => SessionSendOutcome::Rejected,
        InvocationOutcome::Cancelled | InvocationOutcome::Unknown => SessionSendOutcome::Unknown,
    }
}

fn session_prompt_params(
    command: SessionSendCommand,
) -> Result<matcha_agent::session::request::SessionPromptParams, ()> {
    let session_id =
        matcha_agent::session::model::SessionId::try_new(command.session_key).map_err(|_| ())?;
    let run_id =
        matcha_agent::session::model::RunId::try_new(command.run_id.ok_or(())?).map_err(|_| ())?;
    let params =
        matcha_agent::session::request::SessionPromptParams::try_new(session_id, command.message)
            .map_err(|_| ())?
            .with_run_id(run_id);
    if command.attachments.is_empty() {
        return Ok(params);
    }
    let attachments = command
        .attachments
        .into_iter()
        .map(map_attachment)
        .collect::<Result<Vec<_>, ()>>()?;
    let attachments = matcha_agent::session::request::AttachmentPromptPayload::try_new(attachments)
        .map_err(|_| ())?;
    Ok(params.with_attachments(attachments))
}

fn map_attachment(
    attachment: Attachment,
) -> Result<matcha_agent::session::request::PromptAttachment, ()> {
    matcha_agent::session::request::PromptAttachment::try_new(
        attachment.file_name,
        attachment.mime_type,
        attachment.content,
    )
    .map_err(|_| ())
}

pub struct MatchaAgentInput {
    pub bun_executable: PathBuf,
    pub entry: PathBuf,
    pub working_directory: PathBuf,
    pub storage_root: PathBuf,
    pub port: u16,
    #[cfg(windows)]
    pub git_bash: PathBuf,
    #[cfg(unix)]
    pub guardian_executable: PathBuf,
}

pub(super) fn team_native_effects(peer: &MatchaPeer) -> MatchaTeamNativeEffects<'_> {
    MatchaTeamNativeEffects::new(peer)
}

pub(super) fn build_peer(
    input: MatchaAgentInput,
    secret: Secret,
    report_diagnostic: Arc<dyn Fn(StartupDiagnosticCategory) + Send + Sync>,
) -> Result<MatchaPeer, ConstructionError> {
    Ok(MatchaPeerFactory::try_new(
        MatchaPeerInput {
            bun_executable: input.bun_executable,
            entry: input.entry,
            working_directory: input.working_directory,
            storage_root: input.storage_root,
            port: input.port,
            report_diagnostic,
            #[cfg(windows)]
            git_bash: input.git_bash,
            #[cfg(unix)]
            guardian_executable: input.guardian_executable,
        },
        secret,
    )?
    .build())
}

#[cfg(test)]
mod tests {
    use serde_json::{json, to_value};

    use super::*;
    use crate::session_send::NativeEndpoint;

    #[test]
    fn text_send_omits_the_app_server_attachment_payload() {
        let params = session_prompt_params(
            SessionSendCommand::try_new(
                NativeEndpoint::MatchaAgentLocal,
                "session-1".into(),
                None,
                "renderer-route:test".into(),
                "describe this".into(),
                Some("run-1".into()),
                None,
                None,
                vec![],
                None,
            )
            .unwrap(),
        )
        .unwrap();

        assert_eq!(
            to_value(params).unwrap(),
            json!({
                "sessionId": "session-1",
                "prompt": "describe this",
                "runId": "run-1",
            })
        );
    }

    #[test]
    fn attachment_send_maps_to_the_typed_app_server_attachment_payload() {
        let params = session_prompt_params(
            SessionSendCommand::try_new(
                NativeEndpoint::MatchaAgentLocal,
                "session-1".into(),
                None,
                "renderer-route:test".into(),
                "describe this".into(),
                Some("run-1".into()),
                None,
                None,
                vec![Attachment {
                    mime_type: "application/pdf".into(),
                    file_name: "review.pdf".into(),
                    content: "aGVsbG8=".into(),
                }],
                None,
            )
            .unwrap(),
        )
        .unwrap();

        let payload = to_value(params).unwrap();
        assert_eq!(
            payload,
            json!({
                "sessionId": "session-1",
                "prompt": "describe this",
                "runId": "run-1",
                "payload": {
                    "version": "attachments-v1",
                    "attachments": [{
                        "name": "review.pdf",
                        "mediaType": "application/pdf",
                        "data": "aGVsbG8="
                    }],
                },
            })
        );
        assert!(!payload.to_string().contains("private-image.png"));
    }
}
