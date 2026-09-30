use foundation::execution::{CommandRoute, OwnerRuntimeHandle, QueryRoute};
use platform::call::{CallId, CallReceipt, CallRecorder};
use std::sync::Arc;
use crate::owner::discovery::{DiscoveryReservation, DiscoveryResult, ProviderDiscoveries};

use crate::call::{ProviderCall, ProviderCallKind};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::{
    ProviderAccountId, ProviderAccountRevision, ProviderModelCapability,
    ProviderPrivateProjectionEffect, ProviderRouting, ProviderTextGenerationModelLimitsOutcome,
    ProviderTextGenerationModelLimitsRequest, ProviderTextGenerationOutcome,
    ProviderTextGenerationRequest, Resolver,
    application::{ProviderAccountDraft, receipts::*},
};

#[derive(Clone)]
pub struct ProviderHandle {
    owner: OwnerRuntimeHandle<ProviderCommand, ProviderQuery>,
    recorder: Option<CallRecorder>,
    discoveries: Arc<ProviderDiscoveries>,
}

impl ProviderHandle {
    pub(crate) fn new(owner: OwnerRuntimeHandle<ProviderCommand, ProviderQuery>) -> Self {
        Self {
            owner,
            recorder: None,
            discoveries: Arc::new(ProviderDiscoveries::default()),
        }
    }

    pub(crate) fn with_call_recorder(mut self, recorder: CallRecorder) -> Self {
        self.recorder = Some(recorder);
        self
    }

    async fn send_command(&self, command: ProviderCommand) -> Result<(), ()> {
        let call = command.call();
        if self.owner.send_command(command).await.is_err() {
            ProviderCall::not_admitted(call).await;
            return Err(());
        }
        Ok(())
    }

    async fn admit_command(&self, command: ProviderCommand) -> Result<CallReceipt, ()> {
        let call = command.call().ok_or(())?;
        if self.owner.try_send_command(command).is_err() {
            ProviderCall::not_admitted(Some(call)).await;
            return Err(());
        }
        call.accepted().await
    }

    async fn send_query(&self, query: ProviderQuery) -> Result<(), ()> {
        let call = query.call();
        if self.owner.send_query(query).await.is_err() {
            ProviderCall::not_admitted(call).await;
            return Err(());
        }
        Ok(())
    }

    pub async fn configure_provider_private_resolver(&self, resolver: Resolver) -> Result<(), ()> {
        let (reply, rx) = oneshot::channel();
        self.send_command(ProviderCommand::ConfigurePrivateResolver { resolver, reply })
            .await
            .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub async fn list_provider_accounts(&self) -> Result<ProviderAccountsDelivery, ()> {
        let call = ProviderCall::begin(
            self.recorder.as_ref(),
            ProviderCallKind::ListAccounts,
            "providerAccounts.list",
        )
        .await?;
        let (reply, rx) = oneshot::channel();
        self.send_query(ProviderQuery::ListAccounts { call, reply })
            .await
            .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub async fn get_provider_account(
        &self,
        id: ProviderAccountId,
    ) -> Result<ProviderAccountsDelivery, ()> {
        let call = ProviderCall::begin(
            self.recorder.as_ref(),
            ProviderCallKind::GetAccount,
            "providerAccounts.get",
        )
        .await?;
        let (reply, rx) = oneshot::channel();
        self.send_query(ProviderQuery::GetAccount { call, id, reply })
            .await
            .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub async fn admit_replace_provider_account(
        &self,
        draft: ProviderAccountDraft,
        transaction_id: Option<String>,
    ) -> Result<CallReceipt, ProviderAccountAdmissionError> {
        let mut call = ProviderCall::begin(
            self.recorder.as_ref(),
            ProviderCallKind::ReplaceAccount,
            "providerAccounts.replace",
        )
        .await
        .map_err(|_| ProviderAccountAdmissionError::NotAdmitted)?
        .ok_or(ProviderAccountAdmissionError::NotAdmitted)?;
        let account_id = match draft.account_id() {
            Ok(id) => id,
            Err(_) => {
                ProviderCall::not_admitted(Some(call)).await;
                return Err(ProviderAccountAdmissionError::NotAdmitted);
            }
        };
        call.account(Some(&account_id), Some(draft.revision_value()));
        let transaction = transaction_id.map(|id| ProviderAccountPrivateTransaction {
            id,
            reference: format!("credential:v1:{}", account_id.as_str()),
            revision: draft.revision_value(),
        });
        let (reply, _) = oneshot::channel();
        self.admit_account_command(ProviderCommand::ReplaceAccount {
            call: Some(call),
            draft,
            transaction,
            reply,
        })
        .await
    }

    pub async fn admit_delete_provider_account(
        &self,
        id: ProviderAccountId,
        revision: ProviderAccountRevision,
        transaction_id: Option<String>,
    ) -> Result<CallReceipt, ProviderAccountAdmissionError> {
        let mut call = ProviderCall::begin(
            self.recorder.as_ref(),
            ProviderCallKind::DeleteAccount,
            "providerAccounts.delete",
        )
        .await
        .map_err(|_| ProviderAccountAdmissionError::NotAdmitted)?
        .ok_or(ProviderAccountAdmissionError::NotAdmitted)?;
        call.account(Some(&id), Some(revision.get()));
        let transaction = transaction_id.map(|transaction_id| ProviderAccountPrivateTransaction {
            id: transaction_id,
            reference: format!("credential:v1:{}", id.as_str()),
            revision: revision.get(),
        });
        let (reply, _) = oneshot::channel();
        self.admit_account_command(ProviderCommand::DeleteAccount {
            call: Some(call),
            id,
            revision,
            transaction,
            reply,
        })
        .await
    }

    async fn admit_account_command(
        &self,
        command: ProviderCommand,
    ) -> Result<CallReceipt, ProviderAccountAdmissionError> {
        let call = command
            .call()
            .ok_or(ProviderAccountAdmissionError::NotAdmitted)?;
        if self.owner.try_send_command(command).is_err() {
            ProviderCall::not_admitted(Some(call)).await;
            return Err(ProviderAccountAdmissionError::NotAdmitted);
        }
        call.accepted()
            .await
            .map_err(|_| ProviderAccountAdmissionError::Unavailable)
    }

    pub async fn replace_provider_account(
        &self,
        draft: ProviderAccountDraft,
    ) -> Result<ProviderAccountsDelivery, ()> {
        let call = ProviderCall::begin(
            self.recorder.as_ref(),
            ProviderCallKind::ReplaceAccount,
            "providerAccounts.replace",
        )
        .await?;
        let (reply, rx) = oneshot::channel();
        self.send_command(ProviderCommand::ReplaceAccount {
            call,
            draft,
            transaction: None,
            reply,
        })
        .await
        .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub async fn delete_provider_account(
        &self,
        id: ProviderAccountId,
        revision: ProviderAccountRevision,
    ) -> Result<ProviderAccountsDelivery, ()> {
        let call = ProviderCall::begin(
            self.recorder.as_ref(),
            ProviderCallKind::DeleteAccount,
            "providerAccounts.delete",
        )
        .await?;
        let (reply, rx) = oneshot::channel();
        self.send_command(ProviderCommand::DeleteAccount {
            call,
            id,
            revision,
            transaction: None,
            reply,
        })
        .await
        .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub async fn list_provider_models(&self) -> Result<ProviderModelListOutcome, ()> {
        let call = ProviderCall::begin(
            self.recorder.as_ref(),
            ProviderCallKind::ListModels,
            "providerModels.list",
        )
        .await?;
        let (reply, rx) = oneshot::channel();
        self.send_query(ProviderQuery::ListModels { call, reply })
            .await
            .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub async fn selectable_provider_models(
        &self,
        capability: ProviderModelCapability,
    ) -> Result<ProviderModelSelectableOutcome, ()> {
        let call = ProviderCall::begin(
            self.recorder.as_ref(),
            ProviderCallKind::SelectableModels,
            "providerModels.listSelectable",
        )
        .await?;
        let (reply, rx) = oneshot::channel();
        self.send_query(ProviderQuery::SelectableModels {
            call,
            capability,
            reply,
        })
        .await
        .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub async fn admit_discover_provider_models(
        &self,
        account_id: String,
    ) -> Result<CallReceipt, ()> {
        let account_id = ProviderAccountId::try_new(account_id).map_err(|_| ())?;
        let mut call = ProviderCall::begin(
            self.recorder.as_ref(),
            ProviderCallKind::DiscoverModels,
            "providerModels.discover",
        )
        .await?
        .ok_or(())?;
        call.account(Some(&account_id), None);
        let reservation = match DiscoveryReservation::try_new(
            Arc::clone(&self.discoveries),
            call.id().clone(),
            account_id.clone(),
        ) {
            Ok(reservation) => reservation,
            Err(()) => {
                ProviderCall::not_admitted(Some(call)).await;
                return Err(());
            }
        };
        let (reply, _) = oneshot::channel();
        self.admit_command(ProviderCommand::DiscoverModels {
            call: Some(call),
            account_id,
            reservation,
            reply,
        })
        .await
    }

    pub(crate) fn read_provider_model_discovery(
        &self,
        call_id: &CallId,
        account_id: &ProviderAccountId,
    ) -> Result<DiscoveryResult, ()> {
        self.discoveries.read(call_id, account_id)
    }

    pub async fn replace_provider_models(
        &self,
        account_id: String,
        drafts: Vec<ProviderModelDraft>,
    ) -> Result<ProviderModelReplaceOutcome, ()> {
        let account_id = ProviderAccountId::try_new(account_id).ok();
        let call = ProviderCall::begin(
            self.recorder.as_ref(),
            ProviderCallKind::ReplaceModels,
            "providerModels.replace",
        )
        .await?;
        let (reply, rx) = oneshot::channel();
        self.send_command(ProviderCommand::ReplaceModels {
            call,
            account_id,
            drafts,
            reply,
        })
        .await
        .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub async fn admit_replace_provider_models(
        &self,
        account_id: String,
        drafts: Vec<ProviderModelDraft>,
    ) -> Result<CallReceipt, ()> {
        let account_id = ProviderAccountId::try_new(account_id).ok();
        let mut call = ProviderCall::begin(
            self.recorder.as_ref(),
            ProviderCallKind::ReplaceModels,
            "providerModels.replace",
        )
        .await?
        .ok_or(())?;
        call.account(account_id.as_ref(), None);
        let (reply, _) = oneshot::channel();
        self.admit_command(ProviderCommand::ReplaceModels {
            call: Some(call),
            account_id,
            drafts,
            reply,
        })
        .await
    }

    pub async fn admit_replace_provider_routing(
        &self,
        routing: ProviderRouting,
    ) -> Result<CallReceipt, ()> {
        let call = ProviderCall::begin(
            self.recorder.as_ref(),
            ProviderCallKind::ReplaceRouting,
            "providerRouting.replace",
        )
        .await?
        .ok_or(())?;
        let (reply, _) = oneshot::channel();
        self.admit_command(ProviderCommand::ReplaceRouting {
            call: Some(call),
            routing,
            reply,
        })
        .await
    }

    pub async fn list_provider_routing(&self) -> Result<ProviderRoutingListOutcome, ()> {
        let call = ProviderCall::begin(
            self.recorder.as_ref(),
            ProviderCallKind::ListRouting,
            "providerRouting.list",
        )
        .await?;
        let (reply, rx) = oneshot::channel();
        self.send_query(ProviderQuery::ListRouting { call, reply })
            .await
            .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub async fn text_generation_model_limits(
        &self,
        request: ProviderTextGenerationModelLimitsRequest,
    ) -> Result<ProviderTextGenerationModelLimitsOutcome, ()> {
        let call = ProviderCall::begin(
            self.recorder.as_ref(),
            ProviderCallKind::TextGenerationModelLimits,
            "providerGeneration.modelLimits",
        )
        .await?;
        let (reply, rx) = oneshot::channel();
        self.send_query(ProviderQuery::TextGenerationModelLimits {
            call,
            request,
            reply,
        })
        .await
        .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub async fn generate_text(
        &self,
        request: ProviderTextGenerationRequest,
    ) -> Result<ProviderTextGenerationOutcome, ()> {
        self.generate_text_cancellable(request, CancellationToken::new())
            .await
    }

    pub async fn generate_text_cancellable(
        &self,
        request: ProviderTextGenerationRequest,
        cancellation: CancellationToken,
    ) -> Result<ProviderTextGenerationOutcome, ()> {
        let call = ProviderCall::begin(
            self.recorder.as_ref(),
            ProviderCallKind::GenerateText,
            "providerGeneration.generateText",
        )
        .await?;
        let (reply, rx) = oneshot::channel();
        self.send_query(ProviderQuery::GenerateText {
            call,
            request,
            cancellation,
            reply,
        })
        .await
        .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub async fn replace_provider_routing(
        &self,
        routing: ProviderRouting,
    ) -> Result<ProviderRoutingReplaceOutcome, ()> {
        let call = ProviderCall::begin(
            self.recorder.as_ref(),
            ProviderCallKind::ReplaceRouting,
            "providerRouting.replace",
        )
        .await?;
        let (reply, rx) = oneshot::channel();
        self.send_command(ProviderCommand::ReplaceRouting {
            call,
            routing,
            reply,
        })
        .await
        .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub async fn prepare_private_projection(&self) -> ProviderPrivateProjectionEffect {
        let (reply, rx) = oneshot::channel();
        if self
            .owner
            .send_command(ProviderCommand::PreparePrivateProjection { reply })
            .await
            .is_err()
        {
            return ProviderPrivateProjectionEffect::unknown(
                "provider-owner-unavailable",
                "Provider owner is unavailable",
            );
        }
        rx.await.unwrap_or_else(|_| {
            ProviderPrivateProjectionEffect::unknown(
                "provider-owner-response-unavailable",
                "Provider owner response is unavailable",
            )
        })
    }

    pub async fn select_session_model(
        &self,
        endpoint: ProviderSessionEndpoint,
        session_key: String,
        endpoint_session_id: Option<String>,
        model_selection_id: String,
        trace_id: Option<String>,
    ) -> Result<ProviderSessionModelSelectionOutcome, ()> {
        let call = ProviderCall::begin(
            self.recorder.as_ref(),
            ProviderCallKind::SelectSessionModel,
            "providerSession.selectModel",
        )
        .await?;
        let (reply, rx) = oneshot::channel();
        self.send_query(ProviderQuery::SelectSessionModel {
            call,
            endpoint,
            session_key,
            endpoint_session_id,
            model_selection_id,
            trace_id,
            reply,
        })
        .await
        .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub async fn select_matcha_session_model_runtime(
        &self,
        session_key: String,
        endpoint_session_id: Option<String>,
        model_id: String,
        model_selection_id: Option<String>,
        provider_fingerprint: Option<String>,
        trace_id: Option<String>,
    ) -> Result<ProviderSessionModelSelectionOutcome, ()> {
        let call = ProviderCall::begin(
            self.recorder.as_ref(),
            ProviderCallKind::SelectMatchaSessionModelRuntime,
            "providerSession.selectMatchaModel",
        )
        .await?;
        let (reply, rx) = oneshot::channel();
        self.send_query(ProviderQuery::SelectMatchaSessionModelRuntime {
            call,
            session_key,
            endpoint_session_id,
            model_id,
            model_selection_id,
            provider_fingerprint,
            trace_id,
            reply,
        })
        .await
        .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub async fn accept_session_runtime_models(
        &self,
        endpoint: ProviderSessionEndpoint,
        model_refs: Vec<String>,
    ) -> Result<ProviderSessionRuntimeModelsOutcome, ()> {
        let call = ProviderCall::begin(
            self.recorder.as_ref(),
            ProviderCallKind::AcceptSessionRuntimeModels,
            "providerSession.acceptRuntimeModels",
        )
        .await?;
        let (reply, rx) = oneshot::channel();
        self.send_query(ProviderQuery::AcceptSessionRuntimeModels {
            call,
            endpoint,
            model_refs,
            reply,
        })
        .await
        .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub async fn select_session_model_rebound(
        &self,
        endpoint: ProviderSessionEndpoint,
        session_key: String,
        endpoint_session_id: Option<String>,
        current_model: Option<String>,
        default_model: Option<String>,
        trace_id: Option<String>,
    ) -> Result<ProviderSessionModelSelectionOutcome, ()> {
        let call = ProviderCall::begin(
            self.recorder.as_ref(),
            ProviderCallKind::SelectSessionModelRebound,
            "providerSession.selectModelRebound",
        )
        .await?;
        let (reply, rx) = oneshot::channel();
        self.send_query(ProviderQuery::SelectSessionModelRebound {
            call,
            endpoint,
            session_key,
            endpoint_session_id,
            current_model,
            default_model,
            trace_id,
            reply,
        })
        .await
        .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }
}

#[derive(Clone, Copy, Debug)]
pub enum ProviderAccountAdmissionError {
    NotAdmitted,
    Unavailable,
}

pub(crate) struct ProviderAccountPrivateTransaction {
    pub(crate) id: String,
    pub(crate) reference: String,
    pub(crate) revision: u64,
}

pub(crate) enum ProviderCommand {
    ConfigurePrivateResolver {
        resolver: Resolver,
        reply: oneshot::Sender<()>,
    },
    ReplaceAccount {
        call: Option<ProviderCall>,
        draft: ProviderAccountDraft,
        transaction: Option<ProviderAccountPrivateTransaction>,
        reply: oneshot::Sender<ProviderAccountsDelivery>,
    },
    DeleteAccount {
        call: Option<ProviderCall>,
        id: ProviderAccountId,
        revision: ProviderAccountRevision,
        transaction: Option<ProviderAccountPrivateTransaction>,
        reply: oneshot::Sender<ProviderAccountsDelivery>,
    },
    DiscoverModels {
        call: Option<ProviderCall>,
        account_id: ProviderAccountId,
        reservation: DiscoveryReservation,
        reply: oneshot::Sender<ProviderModelDiscoverOutcome>,
    },
    ReplaceModels {
        call: Option<ProviderCall>,
        account_id: Option<ProviderAccountId>,
        drafts: Vec<ProviderModelDraft>,
        reply: oneshot::Sender<ProviderModelReplaceOutcome>,
    },
    ReplaceRouting {
        call: Option<ProviderCall>,
        routing: ProviderRouting,
        reply: oneshot::Sender<ProviderRoutingReplaceOutcome>,
    },
    PreparePrivateProjection {
        reply: oneshot::Sender<ProviderPrivateProjectionEffect>,
    },
}

pub(crate) enum ProviderQuery {
    ListAccounts {
        call: Option<ProviderCall>,
        reply: oneshot::Sender<ProviderAccountsDelivery>,
    },
    GetAccount {
        call: Option<ProviderCall>,
        id: ProviderAccountId,
        reply: oneshot::Sender<ProviderAccountsDelivery>,
    },
    ListModels {
        call: Option<ProviderCall>,
        reply: oneshot::Sender<ProviderModelListOutcome>,
    },
    SelectableModels {
        call: Option<ProviderCall>,
        capability: ProviderModelCapability,
        reply: oneshot::Sender<ProviderModelSelectableOutcome>,
    },
    ListRouting {
        call: Option<ProviderCall>,
        reply: oneshot::Sender<ProviderRoutingListOutcome>,
    },
    SelectSessionModel {
        call: Option<ProviderCall>,
        endpoint: ProviderSessionEndpoint,
        session_key: String,
        endpoint_session_id: Option<String>,
        model_selection_id: String,
        trace_id: Option<String>,
        reply: oneshot::Sender<ProviderSessionModelSelectionOutcome>,
    },
    SelectMatchaSessionModelRuntime {
        call: Option<ProviderCall>,
        session_key: String,
        endpoint_session_id: Option<String>,
        model_id: String,
        model_selection_id: Option<String>,
        provider_fingerprint: Option<String>,
        trace_id: Option<String>,
        reply: oneshot::Sender<ProviderSessionModelSelectionOutcome>,
    },
    AcceptSessionRuntimeModels {
        call: Option<ProviderCall>,
        endpoint: ProviderSessionEndpoint,
        model_refs: Vec<String>,
        reply: oneshot::Sender<ProviderSessionRuntimeModelsOutcome>,
    },
    SelectSessionModelRebound {
        call: Option<ProviderCall>,
        endpoint: ProviderSessionEndpoint,
        session_key: String,
        endpoint_session_id: Option<String>,
        current_model: Option<String>,
        default_model: Option<String>,
        trace_id: Option<String>,
        reply: oneshot::Sender<ProviderSessionModelSelectionOutcome>,
    },
    TextGenerationModelLimits {
        call: Option<ProviderCall>,
        request: ProviderTextGenerationModelLimitsRequest,
        reply: oneshot::Sender<ProviderTextGenerationModelLimitsOutcome>,
    },
    GenerateText {
        call: Option<ProviderCall>,
        request: ProviderTextGenerationRequest,
        cancellation: CancellationToken,
        reply: oneshot::Sender<ProviderTextGenerationOutcome>,
    },
}

impl ProviderCommand {
    fn call(&self) -> Option<ProviderCall> {
        match self {
            Self::ReplaceAccount { call, .. }
            | Self::DeleteAccount { call, .. }
            | Self::DiscoverModels { call, .. }
            | Self::ReplaceModels { call, .. }
            | Self::ReplaceRouting { call, .. } => call.clone(),
            Self::ConfigurePrivateResolver { .. } | Self::PreparePrivateProjection { .. } => None,
        }
    }

    pub(crate) fn take_call(&mut self) -> Option<ProviderCall> {
        match self {
            Self::ReplaceAccount { call, .. }
            | Self::DeleteAccount { call, .. }
            | Self::DiscoverModels { call, .. }
            | Self::ReplaceModels { call, .. }
            | Self::ReplaceRouting { call, .. } => call.take(),
            Self::ConfigurePrivateResolver { .. } | Self::PreparePrivateProjection { .. } => None,
        }
    }

    pub(crate) fn route_command(&self) -> CommandRoute<ProviderAccountId> {
        CommandRoute::Global
    }
}

impl ProviderQuery {
    fn call(&self) -> Option<ProviderCall> {
        match self {
            Self::ListAccounts { call, .. }
            | Self::GetAccount { call, .. }
            | Self::ListModels { call, .. }
            | Self::SelectableModels { call, .. }
            | Self::ListRouting { call, .. }
            | Self::TextGenerationModelLimits { call, .. }
            | Self::GenerateText { call, .. }
            | Self::SelectSessionModel { call, .. }
            | Self::SelectMatchaSessionModelRuntime { call, .. }
            | Self::AcceptSessionRuntimeModels { call, .. }
            | Self::SelectSessionModelRebound { call, .. } => call.clone(),
        }
    }

    pub(crate) fn take_call(&mut self) -> Option<ProviderCall> {
        match self {
            Self::ListAccounts { call, .. }
            | Self::GetAccount { call, .. }
            | Self::ListModels { call, .. }
            | Self::SelectableModels { call, .. }
            | Self::ListRouting { call, .. }
            | Self::TextGenerationModelLimits { call, .. }
            | Self::GenerateText { call, .. }
            | Self::SelectSessionModel { call, .. }
            | Self::SelectMatchaSessionModelRuntime { call, .. }
            | Self::AcceptSessionRuntimeModels { call, .. }
            | Self::SelectSessionModelRebound { call, .. } => call.take(),
        }
    }

    pub(crate) fn route_query(&self) -> QueryRoute<ProviderAccountId> {
        match self {
            Self::ListAccounts { .. }
            | Self::GetAccount { .. }
            | Self::ListModels { .. }
            | Self::SelectableModels { .. }
            | Self::ListRouting { .. } => QueryRoute::Direct,
            Self::SelectSessionModel { .. }
            | Self::SelectMatchaSessionModelRuntime { .. }
            | Self::AcceptSessionRuntimeModels { .. }
            | Self::SelectSessionModelRebound { .. }
            | Self::TextGenerationModelLimits { .. }
            | Self::GenerateText { .. } => QueryRoute::Global,
        }
    }
}
