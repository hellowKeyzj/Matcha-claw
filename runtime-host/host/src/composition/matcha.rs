use std::{path::PathBuf, sync::Arc};

use foundation::{
    process::{
        ShutdownOutcome,
        supervision::{RestartOutcome, StartOutcome, SupervisorSnapshot, TerminationCompletion},
    },
    toolchain::NativeToolchainRuntime,
};
use platform::exchange::InvocationOutcome;
use tokio::sync::mpsc;

use matcha_agent::{
    lifecycle::{output::StartupDiagnosticCategory, secret::Secret},
    peer::{
        LifecycleError as MatchaLifecycleError, MatchaPeer, MatchaPeerFactory, MatchaPeerInput,
        MatchaPeerLifecycleHandle, MatchaPeerSessionHandle, RendererSubscriptionError,
        RoleSessionNativeHandle, RoleSessionPromptHandle, SessionSubscriptionItem,
    },
    session::{
        client::AppServerClientError,
        history::HistoryResult,
        hydration::{HydrationWindowMode, HydrationWindowRequest},
        model::{RunId, SessionId},
    },
    team::{abort_role_sessions, delete_role_sessions, deliver_prompt, deliver_prompt_with_handle},
};

pub use matcha_agent::peer::ConstructionError;

use crate::{
    matcha_history, matcha_session_catalog,
    runtime_driver::{
        LifecycleOps, OwnedRuntimeFuture, RuntimeCapabilitySurface, RuntimeDriver,
        RuntimeDriverIdentity, SessionOps, TeamOps, TeamTerminalOps,
    },
    sessions::abort::{SessionAbortCommand, SessionAbortOutcome},
    sessions::approval::{
        PendingApproval, PendingApprovals, PendingApprovalsCommand, PendingApprovalsOutcome,
        SessionApprovalCommand, SessionApprovalOutcome,
    },
    sessions::create::{
        SessionAdmission, SessionCreateCommand, SessionCreateOutcome, project_matcha_create,
    },
    sessions::model_selection::{
        MatchaProviderRuntimeConfig, ResolvedSessionModelSelection, SessionModelSelectionBinding,
        SessionModelSelectionOutcome, SessionModelSelectionRejection,
    },
    sessions::send::{Attachment, SessionSendCommand, SessionSendOutcome, SessionSendStatus},
    sessions::timeline,
    transport::session_trace,
};

pub(super) struct MatchaAgentInstance {
    peer: Option<MatchaPeer>,
    team: MatchaRuntimeDriver,
}

#[derive(Clone)]
pub(crate) struct MatchaRuntimeDriver {
    lifecycle: MatchaPeerLifecycleHandle,
    session: MatchaPeerSessionHandle,
    prompt: RoleSessionPromptHandle,
    native: RoleSessionNativeHandle,
    renderer_events: Option<mpsc::Sender<SessionSubscriptionItem>>,
}

impl MatchaRuntimeDriver {
    pub(super) fn new(peer: &MatchaPeer) -> Self {
        Self {
            lifecycle: peer.lifecycle_handle(),
            session: peer.session_handle(),
            prompt: peer.role_session_prompt_handle(),
            native: peer.role_session_native_handle(),
            renderer_events: None,
        }
    }
}

impl MatchaAgentInstance {
    pub(super) fn new(peer: MatchaPeer) -> Self {
        let team = MatchaRuntimeDriver::new(&peer);
        Self {
            peer: Some(peer),
            team,
        }
    }

    pub(super) fn runtime_driver(&self) -> Arc<MatchaRuntimeDriver> {
        Arc::new(self.team.clone())
    }

    pub(super) fn set_renderer_events(
        &mut self,
        renderer_events: Option<mpsc::Sender<SessionSubscriptionItem>>,
    ) {
        self.team.renderer_events = renderer_events;
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

    pub(super) async fn confirm_shutdown(
        &self,
    ) -> Result<ShutdownOutcome, matcha_agent::peer::ShutdownError> {
        self.peer().confirm_shutdown().await
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
        Some(&self.team)
    }

    fn team_ops(&self) -> Option<&dyn TeamOps> {
        Some(self)
    }

    fn team_terminal_ops(&self) -> Option<&dyn TeamTerminalOps> {
        Some(self)
    }

    fn lifecycle_ops(&self) -> Option<&dyn LifecycleOps> {
        Some(self)
    }
}

impl RuntimeDriver for MatchaRuntimeDriver {
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

    fn team_terminal_ops(&self) -> Option<&dyn TeamTerminalOps> {
        Some(self)
    }

    fn lifecycle_ops(&self) -> Option<&dyn LifecycleOps> {
        Some(self)
    }
}

impl SessionOps for MatchaRuntimeDriver {
    fn admission(&self) -> SessionAdmission {
        SessionAdmission::native_session_key(
            RuntimeDriverIdentity::matcha_agent().endpoint(),
            crate::sessions::state::SessionProvider::MatchaAgent,
            "matcha-agent",
        )
    }

    fn abort_session<'a>(
        &'a self,
        command: SessionAbortCommand,
    ) -> crate::runtime_driver::SessionFuture<'a, SessionAbortOutcome> {
        let session = self.session.clone();
        Box::pin(async move { abort_session_with_handle(session, command).await })
    }

    fn create_session<'a>(
        &'a self,
        command: SessionCreateCommand,
        epoch: u64,
    ) -> crate::runtime_driver::SessionFuture<'a, SessionCreateOutcome> {
        let session = self.session.clone();
        Box::pin(async move { create_session(session, command, epoch).await })
    }

    fn list_matcha_sessions<'a>(
        &'a self,
    ) -> crate::runtime_driver::SessionFuture<'a, matcha_session_catalog::Outcome> {
        let session = self.session.clone();
        Box::pin(async move { list_matcha_sessions(session).await })
    }

    fn load_matcha_session<'a>(
        &'a self,
        session_id: SessionId,
    ) -> crate::runtime_driver::SessionFuture<
        'a,
        Result<matcha_agent::session::model::SessionRecord, AppServerClientError>,
    > {
        let session = self.session.clone();
        Box::pin(async move { session.load_session(session_id).await })
    }

    fn load_matcha_history<'a>(
        &'a self,
        command: matcha_history::Command,
    ) -> crate::runtime_driver::SessionFuture<'a, matcha_history::Outcome> {
        let session = self.session.clone();
        Box::pin(async move { load_matcha_history(session, command).await })
    }

    fn load_session_timeline<'a>(
        &'a self,
        command: timeline::Command,
        epoch: u64,
    ) -> crate::runtime_driver::SessionFuture<'a, timeline::Outcome> {
        let session = self.session.clone();
        Box::pin(async move { load_matcha_timeline(session, command, epoch).await })
    }

    fn load_session_content<'a>(
        &'a self,
        command: timeline::ContentCommand,
    ) -> crate::runtime_driver::SessionFuture<'a, timeline::ContentOutcome> {
        let session = self.session.clone();
        Box::pin(async move { timeline::load_matcha_content(&session, command).await })
    }

    fn pending_approvals<'a>(
        &'a self,
        command: PendingApprovalsCommand,
    ) -> crate::runtime_driver::SessionFuture<'a, PendingApprovalsOutcome> {
        let session = self.session.clone();
        Box::pin(async move { pending_approvals_with_handle(session, command).await })
    }

    fn respond_to_approval<'a>(
        &'a self,
        command: SessionApprovalCommand,
    ) -> crate::runtime_driver::SessionFuture<'a, SessionApprovalOutcome> {
        let session = self.session.clone();
        Box::pin(async move { respond_to_approval_with_handle(session, command).await })
    }

    fn send_session<'a>(
        &'a self,
        command: SessionSendCommand,
    ) -> crate::runtime_driver::SessionFuture<'a, SessionSendOutcome> {
        let session = self.session.clone();
        let renderer_events = self.renderer_events.clone();
        Box::pin(async move { send_session_with_handle(session, command, renderer_events).await })
    }

    fn select_session_model<'a>(
        &'a self,
        command: ResolvedSessionModelSelection,
    ) -> crate::runtime_driver::SessionFuture<'a, SessionModelSelectionOutcome> {
        let session = self.session.clone();
        Box::pin(async move { select_session_model_with_handle(session, command).await })
    }
}

impl TeamOps for MatchaRuntimeDriver {
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
        let prompt = self.prompt.clone();
        Box::pin(async move { deliver_prompt_with_handle(prompt, request).await })
    }

    fn abort_role_sessions(
        &self,
        bindings: Vec<organization::RoleSessionReceipt>,
    ) -> OwnedRuntimeFuture<organization::RoleAbortOutcome> {
        let native = self.native.clone();
        Box::pin(async move {
            for binding in bindings {
                let session = match matcha_agent::session::role::RoleSessionId::try_new(
                    binding.external_session().as_str().to_owned(),
                ) {
                    Ok(session) => session,
                    Err(_) => return organization::RoleAbortOutcome::OutcomeUnknown,
                };
                match native.cancel_role_session(session).await {
                    InvocationOutcome::Succeeded(()) => {}
                    InvocationOutcome::TargetRejected(_)
                    | InvocationOutcome::Cancelled
                    | InvocationOutcome::Unknown => {
                        return organization::RoleAbortOutcome::OutcomeUnknown;
                    }
                }
            }
            organization::RoleAbortOutcome::Confirmed
        })
    }

    fn delete_role_sessions(
        &self,
        run_id: organization::GraphRunId,
        bindings: Vec<organization::RoleSessionReceipt>,
        abort_first: bool,
    ) -> OwnedRuntimeFuture<organization::NativeDeletionEvidence> {
        let native = self.native.clone();
        Box::pin(async move {
            if abort_first {
                for binding in &bindings {
                    let session = match matcha_agent::session::role::RoleSessionId::try_new(
                        binding.external_session().as_str().to_owned(),
                    ) {
                        Ok(session) => session,
                        Err(_) => return organization::NativeDeletionEvidence::OutcomeUnknown,
                    };
                    match native.cancel_role_session(session).await {
                        InvocationOutcome::Succeeded(()) => {}
                        InvocationOutcome::TargetRejected(_)
                        | InvocationOutcome::Cancelled
                        | InvocationOutcome::Unknown => {
                            return organization::NativeDeletionEvidence::OutcomeUnknown;
                        }
                    }
                }
            }
            let mut confirmations = Vec::with_capacity(bindings.len());
            for binding in bindings {
                let session = match matcha_agent::session::role::RoleSessionId::try_new(
                    binding.external_session().as_str().to_owned(),
                ) {
                    Ok(session) => session,
                    Err(_) => return organization::NativeDeletionEvidence::Rejected,
                };
                match native.close_role_session(session).await {
                    InvocationOutcome::Succeeded(()) => {
                        let receipt = organization::RoleSessionDeleteReceipt::new(
                            binding.external_session().clone(),
                        );
                        let Ok(confirmation) =
                            organization::RoleSessionDeletionConfirmation::try_new(
                                binding, receipt,
                            )
                        else {
                            return organization::NativeDeletionEvidence::Rejected;
                        };
                        confirmations.push(confirmation);
                    }
                    InvocationOutcome::TargetRejected(_) => {
                        return organization::NativeDeletionEvidence::Rejected;
                    }
                    InvocationOutcome::Cancelled | InvocationOutcome::Unknown => {
                        return organization::NativeDeletionEvidence::OutcomeUnknown;
                    }
                }
            }
            organization::NativeDeletionProof::try_new(run_id, confirmations).map_or(
                organization::NativeDeletionEvidence::Rejected,
                organization::NativeDeletionEvidence::Confirmed,
            )
        })
    }
}

impl TeamTerminalOps for MatchaRuntimeDriver {
    fn watch_terminal(
        &self,
        target: organization::MatchaTerminalReceiptTarget,
    ) -> OwnedRuntimeFuture<Option<matcha_agent::session::receipt::TerminalRunStatus>> {
        let native = self.native.clone();
        Box::pin(async move { watch_terminal_with_handle(native, target).await })
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

impl TeamTerminalOps for MatchaAgentInstance {
    fn watch_terminal(
        &self,
        target: organization::MatchaTerminalReceiptTarget,
    ) -> OwnedRuntimeFuture<Option<matcha_agent::session::receipt::TerminalRunStatus>> {
        self.team.watch_terminal(target)
    }
}

impl LifecycleOps for MatchaRuntimeDriver {
    fn snapshot(&self) -> SupervisorSnapshot {
        self.lifecycle.snapshot()
    }

    fn subscribe(&self) -> tokio::sync::watch::Receiver<SupervisorSnapshot> {
        self.lifecycle.subscribe()
    }

    fn start(
        &self,
    ) -> OwnedRuntimeFuture<Result<StartOutcome, crate::runtime_driver::RuntimeStartFailure>> {
        let lifecycle = self.lifecycle.clone();
        Box::pin(async move { lifecycle.start().await.map_err(map_matcha_start_failure) })
    }

    fn stop(
        &self,
    ) -> OwnedRuntimeFuture<
        Result<TerminationCompletion, crate::runtime_driver::RuntimeLifecycleFailure>,
    > {
        let lifecycle = self.lifecycle.clone();
        Box::pin(async move {
            lifecycle.advance_source_epoch();
            lifecycle.stop().await.map_err(map_matcha_lifecycle_failure)
        })
    }

    fn restart(
        &self,
    ) -> OwnedRuntimeFuture<Result<RestartOutcome, crate::runtime_driver::RuntimeLifecycleFailure>>
    {
        let lifecycle = self.lifecycle.clone();
        Box::pin(async move {
            lifecycle.advance_source_epoch();
            lifecycle
                .restart()
                .await
                .map_err(map_matcha_lifecycle_failure)
        })
    }
}

impl LifecycleOps for MatchaAgentInstance {
    fn snapshot(&self) -> SupervisorSnapshot {
        self.team.snapshot()
    }

    fn subscribe(&self) -> tokio::sync::watch::Receiver<SupervisorSnapshot> {
        self.team.subscribe()
    }

    fn start(
        &self,
    ) -> OwnedRuntimeFuture<Result<StartOutcome, crate::runtime_driver::RuntimeStartFailure>> {
        self.team.start()
    }

    fn stop(
        &self,
    ) -> OwnedRuntimeFuture<
        Result<TerminationCompletion, crate::runtime_driver::RuntimeLifecycleFailure>,
    > {
        self.team.stop()
    }

    fn restart(
        &self,
    ) -> OwnedRuntimeFuture<Result<RestartOutcome, crate::runtime_driver::RuntimeLifecycleFailure>>
    {
        self.team.restart()
    }
}

fn watch_terminal_with_handle(
    native: RoleSessionNativeHandle,
    target: organization::MatchaTerminalReceiptTarget,
) -> OwnedRuntimeFuture<Option<matcha_agent::session::receipt::TerminalRunStatus>> {
    Box::pin(async move {
        let session_id = match matcha_agent::session::role::RoleSessionId::try_new(
            target.correlation().external_session().as_str().to_owned(),
        ) {
            Ok(session_id) => session_id,
            Err(_) => return None,
        };
        let run_id = match matcha_agent::session::role::RoleRunId::try_new(
            target
                .correlation()
                .native_run_receipt()
                .as_str()
                .to_owned(),
        ) {
            Ok(run_id) => run_id,
            Err(_) => return None,
        };
        native.watch_role_terminal(session_id, run_id).await
    })
}

fn map_matcha_start_failure(
    error: MatchaLifecycleError,
) -> crate::runtime_driver::RuntimeStartFailure {
    match error {
        MatchaLifecycleError::CompletionFailed => {
            crate::runtime_driver::RuntimeStartFailure::CompletionFailed
        }
        MatchaLifecycleError::SupervisorStopped => {
            crate::runtime_driver::RuntimeStartFailure::SupervisorStopped
        }
        MatchaLifecycleError::AlreadySatisfied => {
            unreachable!("Matcha peer start reports already satisfied as Started")
        }
        MatchaLifecycleError::Busy => crate::runtime_driver::RuntimeStartFailure::Busy,
        MatchaLifecycleError::Rejected(rejection) => {
            crate::runtime_driver::RuntimeStartFailure::Rejected(rejection)
        }
        MatchaLifecycleError::ShuttingDown => {
            crate::runtime_driver::RuntimeStartFailure::ShuttingDown
        }
    }
}

fn map_matcha_lifecycle_failure(
    error: MatchaLifecycleError,
) -> crate::runtime_driver::RuntimeLifecycleFailure {
    match error {
        MatchaLifecycleError::CompletionFailed => {
            crate::runtime_driver::RuntimeLifecycleFailure::CompletionFailed
        }
        MatchaLifecycleError::SupervisorStopped => {
            crate::runtime_driver::RuntimeLifecycleFailure::SupervisorStopped
        }
        MatchaLifecycleError::AlreadySatisfied => {
            crate::runtime_driver::RuntimeLifecycleFailure::AlreadySatisfied
        }
        MatchaLifecycleError::Busy => crate::runtime_driver::RuntimeLifecycleFailure::Busy,
        MatchaLifecycleError::Rejected(rejection) => {
            crate::runtime_driver::RuntimeLifecycleFailure::Rejected(rejection)
        }
        MatchaLifecycleError::ShuttingDown => {
            crate::runtime_driver::RuntimeLifecycleFailure::ShuttingDown
        }
    }
}

fn matcha_native_session_id(
    session_key: &str,
    endpoint_session_id: Option<&str>,
) -> Result<SessionId, ()> {
    let session_id = match endpoint_session_id {
        Some(session_id) => session_id,
        None if session_key.starts_with("matcha-agent:") => return Err(()),
        None => session_key,
    };
    SessionId::try_new(session_id.to_owned()).map_err(|_| ())
}

pub(super) async fn abort_session_with_handle(
    session: MatchaPeerSessionHandle,
    command: SessionAbortCommand,
) -> SessionAbortOutcome {
    let session_id = match matcha_native_session_id(
        &command.session_key,
        command.endpoint_session_id.as_deref(),
    ) {
        Ok(session_id) => session_id,
        Err(()) => return SessionAbortOutcome::Rejected,
    };
    let params = match command.run_id {
        Some(run_id) => match matcha_agent::session::model::RunId::try_new(run_id) {
            Ok(run_id) => matcha_agent::session::request::SessionCancelParams::new(session_id)
                .with_run_id(run_id),
            Err(_) => return SessionAbortOutcome::Rejected,
        },
        None => matcha_agent::session::request::SessionCancelParams::new(session_id),
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
    let session_id = match matcha_agent::session::model::SessionId::try_new(command.session_id) {
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
        Err(matcha_agent::session::client::AppServerClientError::ConnectionClosed) => {
            PendingApprovalsOutcome::Unavailable
        }
        Err(matcha_agent::session::client::AppServerClientError::Protocol) => {
            PendingApprovalsOutcome::Unknown
        }
        Err(_) => PendingApprovalsOutcome::Rejected,
    }
}

pub(super) async fn respond_to_approval_with_handle(
    session: MatchaPeerSessionHandle,
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
    match session
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

pub(super) async fn select_session_model_with_handle(
    session: MatchaPeerSessionHandle,
    command: ResolvedSessionModelSelection,
) -> SessionModelSelectionOutcome {
    let trace_id = command.trace_id.clone();
    let diagnostic = command.diagnostic.clone();
    let session_id = match matcha_native_session_id(
        &command.session_key,
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
            "providerRuntime": matcha_provider_runtime_trace(&provider_runtime),
            "accountId": diagnostic.as_ref().map(|diagnostic| diagnostic.account_id()),
            "modelId": diagnostic.as_ref().map(|diagnostic| diagnostic.model_id()),
            "protocol": diagnostic.as_ref().and_then(|diagnostic| diagnostic.protocol()),
            "authMode": diagnostic.as_ref().map(|diagnostic| diagnostic.auth_mode()),
        }),
    );
    let params = match matcha_agent::session::request::SessionSetModelParams::try_new(
        session_id,
        model.clone(),
    ) {
        Ok(params) => params
            .with_model_selection_id(command.model_selection_id)
            .with_provider_fingerprint(provider_fingerprint)
            .with_provider_runtime(matcha_provider_runtime(provider_runtime)),
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
    };
    session_trace::log(
        "runtime.matcha.model-selection.set-model.outcome",
        trace_id.as_deref(),
        serde_json::json!({
            "sessionId": session_id_shape,
            "model": model,
            "outcome": session_model_selection_outcome_label(&outcome),
            "rejectionReason": outcome.rejection_reason(),
        }),
    );
    outcome
}

fn matcha_provider_runtime_trace(
    provider_runtime: &MatchaProviderRuntimeConfig,
) -> serde_json::Value {
    match provider_runtime {
        MatchaProviderRuntimeConfig::AnthropicMessages { base_url, api_key } => {
            serde_json::json!({
                "providerRuntimeKind": "anthropicMessages",
                "hasBaseUrl": base_url.is_some(),
                "hasApiKey": api_key.is_some(),
            })
        }
        MatchaProviderRuntimeConfig::GoogleGenerativeAi { base_url, api_key } => {
            serde_json::json!({
                "providerRuntimeKind": "googleGenerativeAi",
                "hasBaseUrl": base_url.is_some(),
                "hasApiKey": api_key.is_some(),
            })
        }
        MatchaProviderRuntimeConfig::OpenAiChatCompletions { base_url, api_key } => {
            serde_json::json!({
                "providerRuntimeKind": "openAiChatCompletions",
                "hasBaseUrl": base_url.is_some(),
                "hasApiKey": api_key.is_some(),
            })
        }
        MatchaProviderRuntimeConfig::OpenAiResponses { base_url, api_key } => {
            serde_json::json!({
                "providerRuntimeKind": "openAiResponses",
                "hasBaseUrl": base_url.is_some(),
                "hasApiKey": api_key.is_some(),
            })
        }
    }
}

fn session_model_selection_outcome_label(outcome: &SessionModelSelectionOutcome) -> &'static str {
    match outcome {
        SessionModelSelectionOutcome::Succeeded => "succeeded",
        SessionModelSelectionOutcome::TargetRejected { .. } => "target_rejected",
        SessionModelSelectionOutcome::OutcomeUnknown => "outcome_unknown",
        SessionModelSelectionOutcome::Unsupported => "unsupported",
        SessionModelSelectionOutcome::Unavailable => "unavailable",
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
) -> matcha_session_catalog::Outcome {
    match session.list_local_history().await {
        HistoryResult::Complete(catalog) => {
            return matcha_session_catalog::Outcome::Listed(matcha_session_catalog::project_local(
                catalog,
            ));
        }
        HistoryResult::NotFound | HistoryResult::Unavailable => {}
        HistoryResult::Unknown | HistoryResult::Incomplete(_) => {
            return matcha_session_catalog::Outcome::Unavailable;
        }
    }
    match session.list_history().await {
        HistoryResult::Complete(catalog) => {
            matcha_session_catalog::Outcome::Listed(matcha_session_catalog::project(catalog))
        }
        HistoryResult::NotFound
        | HistoryResult::Unavailable
        | HistoryResult::Unknown
        | HistoryResult::Incomplete(_) => matcha_session_catalog::Outcome::Unavailable,
    }
}

pub(super) async fn load_matcha_history(
    session: MatchaPeerSessionHandle,
    command: matcha_history::Command,
) -> matcha_history::Outcome {
    let Some(session_id) = SessionId::try_new(command.session_id).ok() else {
        return matcha_history::Outcome::Incomplete;
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
            return matcha_history::Outcome::Complete(matcha_history::project_hydration(&snapshot));
        }
        HistoryResult::NotFound | HistoryResult::Unavailable => {}
        HistoryResult::Unknown | HistoryResult::Incomplete(_) => {
            return matcha_history::Outcome::Incomplete;
        }
    }
    let result = session.read_canonical_session(session_id, request).await;
    match result {
        HistoryResult::Complete(facts) => {
            matcha_history::Outcome::Complete(matcha_history::project(&facts))
        }
        HistoryResult::Unavailable => matcha_history::Outcome::Unavailable,
        HistoryResult::NotFound | HistoryResult::Unknown | HistoryResult::Incomplete(_) => {
            matcha_history::Outcome::Incomplete
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
            "sessionKey": session_key,
            "routeKey": route_key,
            "endpointSessionId": endpoint_session_id,
            "runId": requested_run_id,
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
    let session_id = match matcha_native_session_id(&session_key, endpoint_session_id.as_deref()) {
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
    let params = match session_prompt_params(command) {
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
            "sessionId": session_id.as_str(),
            "routeKey": route_key,
            "runId": run_id.as_str(),
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
                serde_json::json!({ "error": renderer_subscription_error_kind(&error) }),
            );
            return renderer_subscription_failure_outcome(error);
        }
    };
    session_trace::log(
        "runtime.matcha.send.subscribe-ready",
        trace_id.as_deref(),
        serde_json::json!({
            "sessionId": session_id.as_str(),
            "runId": run_id.as_str(),
        }),
    );
    match session.prompt_session(params).await {
        InvocationOutcome::Succeeded(result) => {
            session_trace::log(
                "runtime.matcha.send.prompt-started",
                trace_id.as_deref(),
                serde_json::json!({ "runId": result.run_id.as_str() }),
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
                serde_json::json!({ "error": app_server_client_error_kind(error) }),
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

fn renderer_subscription_error_kind(error: &RendererSubscriptionError) -> &'static str {
    match error {
        RendererSubscriptionError::RuntimeUnavailable => "runtime-unavailable",
        RendererSubscriptionError::Client(error) => app_server_client_error_kind(*error),
    }
}

fn app_server_client_error_kind(error: AppServerClientError) -> &'static str {
    match error {
        AppServerClientError::InvalidEndpoint => "invalid-endpoint",
        AppServerClientError::HealthDeadline => "health-deadline",
        AppServerClientError::HealthFailed => "health-failed",
        AppServerClientError::UpgradeDeadline => "upgrade-deadline",
        AppServerClientError::UpgradeFailed => "upgrade-failed",
        AppServerClientError::InitializeFailed => "initialize-failed",
        AppServerClientError::RequestDeadline => "request-deadline",
        AppServerClientError::ConnectionClosed => "connection-closed",
        AppServerClientError::UnknownResponse => "unknown-response",
        AppServerClientError::Transport => "transport",
        AppServerClientError::Protocol => "protocol",
        AppServerClientError::PeerRejected => "peer-rejected",
        AppServerClientError::SessionNotFound => "session-not-found",
        AppServerClientError::EventRecoveryRequired => "event-recovery-required",
        AppServerClientError::CloseFailed => "close-failed",
    }
}

fn renderer_subscription_failure_outcome(error: RendererSubscriptionError) -> SessionSendOutcome {
    match error {
        RendererSubscriptionError::RuntimeUnavailable => SessionSendOutcome::Unavailable,
        RendererSubscriptionError::Client(AppServerClientError::SessionNotFound)
        | RendererSubscriptionError::Client(AppServerClientError::PeerRejected) => {
            SessionSendOutcome::Rejected
        }
        RendererSubscriptionError::Client(AppServerClientError::HealthDeadline)
        | RendererSubscriptionError::Client(AppServerClientError::HealthFailed)
        | RendererSubscriptionError::Client(AppServerClientError::UpgradeDeadline)
        | RendererSubscriptionError::Client(AppServerClientError::UpgradeFailed)
        | RendererSubscriptionError::Client(AppServerClientError::InitializeFailed)
        | RendererSubscriptionError::Client(AppServerClientError::ConnectionClosed)
        | RendererSubscriptionError::Client(AppServerClientError::Transport) => {
            SessionSendOutcome::Unavailable
        }
        RendererSubscriptionError::Client(_) => SessionSendOutcome::Unknown,
    }
}

fn session_prompt_params(
    command: SessionSendCommand,
) -> Result<matcha_agent::session::request::SessionPromptParams, ()> {
    let run_id = command.request_run_identity().ok_or(())?.to_owned();
    let session_id =
        matcha_native_session_id(&command.session_key, command.endpoint_session_id.as_deref())?;
    let run_id = matcha_agent::session::model::RunId::try_new(run_id).map_err(|_| ())?;
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

pub(super) fn build_peer(
    input: MatchaAgentInput,
    secret: Secret,
    toolchain: Arc<NativeToolchainRuntime>,
    report_diagnostic: Arc<dyn Fn(StartupDiagnosticCategory) + Send + Sync>,
) -> Result<MatchaPeer, ConstructionError> {
    Ok(MatchaPeerFactory::try_new(
        MatchaPeerInput {
            bun_executable: input.bun_executable,
            entry: input.entry,
            working_directory: input.working_directory,
            storage_root: input.storage_root,
            port: input.port,
            toolchain,
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
    use crate::sessions::send::NativeEndpoint;

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
    fn session_prompt_params_prefers_matcha_endpoint_session_binding() {
        let params = session_prompt_params(
            SessionSendCommand::try_new(
                NativeEndpoint::MatchaAgentLocal,
                "matcha-agent:matcha:native-session-1".into(),
                Some("native-session-1".into()),
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

        assert_eq!(to_value(params).unwrap()["sessionId"], "native-session-1");
    }

    #[test]
    fn idempotency_only_send_uses_request_run_identity() {
        let params = session_prompt_params(
            SessionSendCommand::try_new(
                NativeEndpoint::MatchaAgentLocal,
                "session-1".into(),
                None,
                "renderer-route:test".into(),
                "describe this".into(),
                None,
                Some("idempotency-1".into()),
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
                "runId": "idempotency-1",
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
