use crate::owner::discovery::{DiscoveryReservation, DiscoveryResult, ProviderDiscoveries};
use foundation::execution::{CommandRoute, OwnerRuntimeHandle, QueryRoute};
use platform::call::{CallId, CallReceipt, CallRecorder};
use platform::trace::{current_session_trace, session_trace};
use serde_json::json;
use std::sync::Arc;

use crate::call::{ProviderCall, ProviderCallKind};
use crate::llm_client::{LlmClientError, LlmStreamEvent, LlmStreamSink};
use tokio::sync::{mpsc, oneshot};
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
        rx.await.map_err(|_| ())?
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
            account_id: account_id.clone(),
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
            account_id: id.clone(),
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

    pub(crate) async fn discover_provider_model_draft(
        &self,
        request: crate::owner::model_discovery::DraftRequest,
        cancellation: CancellationToken,
    ) -> Result<Vec<ProviderModelDiscoveryView>, crate::owner::model_discovery::Failure> {
        use crate::owner::model_discovery::Failure;
        let cancellation = cancellation.child_token();
        let _cancel_on_drop = cancellation.clone().drop_guard();
        let (reply, rx) = oneshot::channel();
        self.send_query(ProviderQuery::DiscoverModelDraft { request, cancellation, reply })
            .await.map_err(|_| Failure::Unavailable)?;
        rx.await.map_err(|_| Failure::Unavailable)?
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
        self.generate_text_with_selection(request, None, cancellation).await
    }

    pub(crate) async fn generate_selected_text_cancellable(
        &self,
        request: ProviderTextGenerationRequest,
        selection_id: String,
        cancellation: CancellationToken,
    ) -> Result<ProviderTextGenerationOutcome, ()> {
        self.generate_text_with_selection(request, Some(selection_id), cancellation).await
    }

    async fn generate_text_with_selection(
        &self,
        request: ProviderTextGenerationRequest,
        selection_id: Option<String>,
        cancellation: CancellationToken,
    ) -> Result<ProviderTextGenerationOutcome, ()> {
        let call = ProviderCall::begin(
            self.recorder.as_ref(),
            ProviderCallKind::GenerateText,
            "providerGeneration.generateText",
        )
        .await
        .map_err(|_| {
            session_trace(
                "provider-generation.call-begin-failed",
                || json!({ "streaming": false }),
            );
        })?;
        let provider_call_hash = platform::trace::enabled()
            .then(|| {
                call.as_ref()
                    .map(|call| platform::trace::identifier_hash(call.id().as_str()))
            })
            .flatten();
        session_trace("provider-generation.call-begun", || {
            json!({
                "providerCallHash": provider_call_hash, "streaming": false,
            })
        });
        let (reply, rx) = oneshot::channel();
        self.send_query(ProviderQuery::GenerateText {
            call,
            request,
            selection_id,
            cancellation,
            diagnostic_trace: platform::trace::enabled()
                .then(current_session_trace)
                .flatten(),
            stream: None,
            reply,
        })
        .await
        .map_err(|_| {
            eprintln!("[provider] phase=provider-generation.send-query-failed streaming=false");
        })?;
        rx.await.map_err(|_| {
            eprintln!("[provider] phase=provider-generation.reply-channel-failed streaming=false");
        })
    }

    pub async fn stream_generate_text_cancellable(
        &self,
        request: ProviderTextGenerationRequest,
        cancellation: CancellationToken,
        sink: &mut dyn LlmStreamSink,
    ) -> Result<ProviderTextGenerationOutcome, LlmClientError> {
        let cancellation = cancellation.child_token();
        let _cancel_on_drop = cancellation.clone().drop_guard();
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Ok(ProviderTextGenerationOutcome::Cancelled),
            outcome = async {
                let call = ProviderCall::begin(
                    self.recorder.as_ref(),
                    ProviderCallKind::GenerateText,
                    "providerGeneration.generateText",
                )
                .await
                .map_err(|_| {
                    session_trace("provider-generation.call-begin-failed", || json!({ "streaming": true }));
                    LlmClientError::StreamSink("provider owner unavailable".into())
                })?;
                let provider_call_hash = platform::trace::enabled().then(|| call.as_ref().map(|call| platform::trace::identifier_hash(call.id().as_str()))).flatten();
                session_trace("provider-generation.call-begun", || json!({
                    "providerCallHash": provider_call_hash, "streaming": true,
                }));
                let (stream, mut events) = mpsc::channel::<ProviderStreamMessage>(1);
                let (reply, rx) = oneshot::channel();
                self.send_query(ProviderQuery::GenerateText {
                    call,
                    request,
                    selection_id: None,
                    cancellation: cancellation.clone(),
                    diagnostic_trace: platform::trace::enabled().then(current_session_trace).flatten(),
                    stream: Some(stream),
                    reply,
                })
                .await
                .map_err(|_| {
                    eprintln!("[provider] phase=provider-generation.send-query-failed streaming=true");
                    LlmClientError::StreamSink("provider owner unavailable".into())
                })?;
                while let Some(message) = events.recv().await {
                    let (event, ack) = match message {
                        ProviderStreamMessage::Event(event, ack) => (event, ack),
                        ProviderStreamMessage::Failed(error) => return Err(error),
                    };
                    match sink.send(event).await {
                        Ok(()) => { let _ = ack.send(Ok(())); }
                        Err(error) => {
                            let _ = ack.send(Err(LlmClientError::StreamSink("stream consumer failed".into())));
                            return Err(error);
                        }
                    }
                }
                rx.await.map_err(|_| {
                    eprintln!("[provider] phase=provider-generation.reply-channel-failed streaming=true");
                    LlmClientError::StreamSink("provider owner unavailable".into())
                })
            } => outcome,
        }
    }

    pub async fn generate_media_cancellable(
        &self,
        request: crate::media::Request,
        cancellation: CancellationToken,
    ) -> Result<crate::media::Output, crate::media::Failure> {
        let cancellation = cancellation.child_token();
        let _cancel_on_drop = cancellation.clone().drop_guard();
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(crate::media::Failure::Cancelled),
            outcome = async {
                let (reply, rx) = oneshot::channel();
                self.send_query(ProviderQuery::GenerateMedia { request, cancellation: cancellation.clone(), reply })
                    .await.map_err(|_| crate::media::Failure::OwnerUnavailable)?;
                rx.await.map_err(|_| crate::media::Failure::OwnerUnavailable)?
            } => outcome,
        }
    }

    pub async fn list_media_models(
        &self,
        request: crate::media::ListRequest,
    ) -> Result<crate::media::ListOutput, crate::media::Failure> {
        let (reply, rx) = oneshot::channel();
        self.send_query(ProviderQuery::ListMediaModels { request, reply })
            .await
            .map_err(|_| crate::media::Failure::OwnerUnavailable)?;
        rx.await
            .map_err(|_| crate::media::Failure::OwnerUnavailable)?
    }

    pub async fn submit_video_cancellable(
        &self,
        request: crate::media::Request,
        cancellation: CancellationToken,
    ) -> Result<crate::media::VideoTaskOutput, crate::media::Failure> {
        let cancellation = cancellation.child_token();
        let _cancel_on_drop = cancellation.clone().drop_guard();
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(crate::media::Failure::Cancelled),
            outcome = async {
                let (reply, rx) = oneshot::channel();
                self.send_query(ProviderQuery::SubmitVideo { request, cancellation: cancellation.clone(), reply })
                    .await.map_err(|_| crate::media::Failure::OwnerUnavailable)?;
                rx.await.map_err(|_| crate::media::Failure::OwnerUnavailable)?
            } => outcome,
        }
    }

    pub async fn query_video_cancellable(
        &self,
        request: crate::media::VideoTaskRequest,
        cancellation: CancellationToken,
    ) -> Result<crate::media::VideoTaskOutput, crate::media::Failure> {
        let cancellation = cancellation.child_token();
        let _cancel_on_drop = cancellation.clone().drop_guard();
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(crate::media::Failure::Cancelled),
            outcome = async {
                let (reply, rx) = oneshot::channel();
                self.send_query(ProviderQuery::QueryVideo { request, cancellation: cancellation.clone(), reply })
                    .await.map_err(|_| crate::media::Failure::OwnerUnavailable)?;
                rx.await.map_err(|_| crate::media::Failure::OwnerUnavailable)?
            } => outcome,
        }
    }

    pub async fn collect_video_cancellable(
        &self,
        request: crate::media::VideoTaskRequest,
        cancellation: CancellationToken,
    ) -> Result<crate::media::Output, crate::media::Failure> {
        let cancellation = cancellation.child_token();
        let _cancel_on_drop = cancellation.clone().drop_guard();
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(crate::media::Failure::Cancelled),
            outcome = async {
                let (reply, rx) = oneshot::channel();
                self.send_query(ProviderQuery::CollectVideo { request, cancellation: cancellation.clone(), reply })
                    .await.map_err(|_| crate::media::Failure::OwnerUnavailable)?;
                rx.await.map_err(|_| crate::media::Failure::OwnerUnavailable)?
            } => outcome,
        }
    }

    pub async fn prepare_generation_binding(
        &self,
        request: crate::generation::BindingRequest,
    ) -> Result<crate::generation::Binding, crate::generation::Failure> {
        use crate::generation::{Failure, FailureKind, Stage};
        let (reply, rx) = oneshot::channel();
        self.send_query(ProviderQuery::PrepareGenerationBinding { request, reply })
            .await
            .map_err(|_| Failure::new(Stage::Admission, FailureKind::OwnerUnavailable))?;
        rx.await
            .map_err(|_| Failure::new(Stage::Admission, FailureKind::OwnerUnavailable))?
    }

    pub async fn restore_generation_binding(
        &self,
        descriptor: crate::generation::BindingDescriptor,
    ) -> Result<crate::generation::Binding, crate::generation::Failure> {
        use crate::generation::{Failure, FailureKind, Stage};
        let (reply, rx) = oneshot::channel();
        self.send_query(ProviderQuery::RestoreGenerationBinding { descriptor, reply })
            .await
            .map_err(|_| Failure::new(Stage::Admission, FailureKind::OwnerUnavailable))?;
        rx.await
            .map_err(|_| Failure::new(Stage::Admission, FailureKind::OwnerUnavailable))?
    }

    pub async fn count_bound_input(
        &self,
        request: crate::generation::BoundRequest,
        cancellation: CancellationToken,
    ) -> Result<u64, crate::generation::Failure> {
        use crate::generation::{Failure, FailureKind, Stage};
        let cancellation = cancellation.child_token();
        let _cancel_on_drop = cancellation.clone().drop_guard();
        let (reply, rx) = oneshot::channel();
        self.send_query(ProviderQuery::CountBoundInput {
            request,
            cancellation,
            reply,
        })
        .await
        .map_err(|_| Failure::new(Stage::Admission, FailureKind::OwnerUnavailable))?;
        rx.await
            .map_err(|_| Failure::new(Stage::Admission, FailureKind::OwnerUnavailable))?
    }

    pub async fn generate_bound(
        &self,
        request: crate::generation::BoundRequest,
        cancellation: CancellationToken,
        mut sink: Option<&mut dyn LlmStreamSink>,
    ) -> Result<crate::generation::Receipt, crate::generation::Failure> {
        use crate::generation::{Failure, FailureKind, Stage};
        let cancellation = cancellation.child_token();
        let _cancel_on_drop = cancellation.clone().drop_guard();
        let call = ProviderCall::begin(
            self.recorder.as_ref(),
            ProviderCallKind::GenerateText,
            "providerGeneration.generateBound",
        )
        .await
        .map_err(|_| Failure::new(Stage::Admission, FailureKind::AuditUnavailable))?;
        let (stream, mut events) = mpsc::channel::<ProviderStreamMessage>(1);
        let (reply, rx) = oneshot::channel();
        self.send_query(ProviderQuery::GenerateBound {
            call,
            request,
            cancellation: cancellation.clone(),
            stream: sink.is_some().then_some(stream),
            reply,
        })
        .await
        .map_err(|_| Failure::new(Stage::Admission, FailureKind::OwnerUnavailable))?;
        // Do not return on cancellation/sink failure: the owner must first return its partial receipt.
        let mut sink_failed = false;
        while let Some(message) = events.recv().await {
            if let ProviderStreamMessage::Event(event, ack) = message {
                let delivered = if sink_failed {
                    Err(LlmClientError::StreamSink("stream consumer failed".into()))
                } else if let Some(sink) = sink.as_mut() {
                    tokio::select! {
                        biased;
                        _ = cancellation.cancelled() => Err(LlmClientError::StreamSink("stream consumer cancelled".into())),
                        result = sink.send(event) => result,
                    }
                } else {
                    Ok(())
                };
                sink_failed |= delivered.is_err();
                let _ = ack.send(
                    delivered
                        .map_err(|_| LlmClientError::StreamSink("stream consumer failed".into())),
                );
            }
        }
        rx.await
            .map_err(|_| Failure::new(Stage::Admission, FailureKind::OwnerUnavailable))?
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

    pub async fn prepare_private_projection(
        &self,
        endpoint: platform::endpoint::runtime_address::RuntimeEndpoint,
    ) -> ProviderPrivateProjectionEffect {
        let (reply, rx) = oneshot::channel();
        if self
            .owner
            .send_command(ProviderCommand::PreparePrivateProjection { endpoint, reply })
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
    pub(crate) account_id: ProviderAccountId,
}

pub(crate) enum ProviderCommand {
    ConfigurePrivateResolver {
        resolver: Resolver,
        reply: oneshot::Sender<Result<(), ()>>,
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
        endpoint: platform::endpoint::runtime_address::RuntimeEndpoint,
        reply: oneshot::Sender<ProviderPrivateProjectionEffect>,
    },
}

pub(crate) enum ProviderStreamMessage {
    Event(LlmStreamEvent, oneshot::Sender<Result<(), LlmClientError>>),
    Failed(LlmClientError),
}

pub(crate) struct ProviderStreamSink(pub mpsc::Sender<ProviderStreamMessage>);

impl LlmStreamSink for ProviderStreamSink {
    fn send<'a>(
        &'a mut self,
        event: LlmStreamEvent,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), LlmClientError>> + Send + 'a>>
    {
        Box::pin(async move {
            let (ack, rx) = oneshot::channel();
            self.0
                .send(ProviderStreamMessage::Event(event, ack))
                .await
                .map_err(|_| LlmClientError::StreamSink("stream consumer closed".into()))?;
            rx.await
                .map_err(|_| LlmClientError::StreamSink("stream consumer closed".into()))?
        })
    }
}

pub(crate) enum ProviderQuery {
    DiscoverModelDraft {
        request: crate::owner::model_discovery::DraftRequest,
        cancellation: CancellationToken,
        reply: oneshot::Sender<Result<Vec<ProviderModelDiscoveryView>, crate::owner::model_discovery::Failure>>,
    },
    ListMediaModels {
        request: crate::media::ListRequest,
        reply: oneshot::Sender<Result<crate::media::ListOutput, crate::media::Failure>>,
    },
    SubmitVideo {
        request: crate::media::Request,
        cancellation: CancellationToken,
        reply: oneshot::Sender<Result<crate::media::VideoTaskOutput, crate::media::Failure>>,
    },
    QueryVideo {
        request: crate::media::VideoTaskRequest,
        cancellation: CancellationToken,
        reply: oneshot::Sender<Result<crate::media::VideoTaskOutput, crate::media::Failure>>,
    },
    CollectVideo {
        request: crate::media::VideoTaskRequest,
        cancellation: CancellationToken,
        reply: oneshot::Sender<Result<crate::media::Output, crate::media::Failure>>,
    },
    GenerateMedia {
        request: crate::media::Request,
        cancellation: CancellationToken,
        reply: oneshot::Sender<Result<crate::media::Output, crate::media::Failure>>,
    },
    PrepareGenerationBinding {
        request: crate::generation::BindingRequest,
        reply: oneshot::Sender<Result<crate::generation::Binding, crate::generation::Failure>>,
    },
    RestoreGenerationBinding {
        descriptor: crate::generation::BindingDescriptor,
        reply: oneshot::Sender<Result<crate::generation::Binding, crate::generation::Failure>>,
    },
    CountBoundInput {
        request: crate::generation::BoundRequest,
        cancellation: CancellationToken,
        reply: oneshot::Sender<Result<u64, crate::generation::Failure>>,
    },
    GenerateBound {
        call: Option<ProviderCall>,
        request: crate::generation::BoundRequest,
        cancellation: CancellationToken,
        stream: Option<mpsc::Sender<ProviderStreamMessage>>,
        reply: oneshot::Sender<Result<crate::generation::Receipt, crate::generation::Failure>>,
    },
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
    TextGenerationModelLimits {
        call: Option<ProviderCall>,
        request: ProviderTextGenerationModelLimitsRequest,
        reply: oneshot::Sender<ProviderTextGenerationModelLimitsOutcome>,
    },
    GenerateText {
        call: Option<ProviderCall>,
        request: ProviderTextGenerationRequest,
        selection_id: Option<String>,
        cancellation: CancellationToken,
        diagnostic_trace: Option<String>,
        stream: Option<mpsc::Sender<ProviderStreamMessage>>,
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
            | Self::GenerateBound { call, .. } => call.clone(),
            Self::DiscoverModelDraft { .. }
            | Self::PrepareGenerationBinding { .. }
            | Self::RestoreGenerationBinding { .. }
            | Self::CountBoundInput { .. }
            | Self::GenerateMedia { .. }
            | Self::ListMediaModels { .. }
            | Self::SubmitVideo { .. }
            | Self::QueryVideo { .. }
            | Self::CollectVideo { .. } => None,
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
            | Self::GenerateBound { call, .. } => call.take(),
            Self::DiscoverModelDraft { .. }
            | Self::PrepareGenerationBinding { .. }
            | Self::RestoreGenerationBinding { .. }
            | Self::CountBoundInput { .. }
            | Self::GenerateMedia { .. }
            | Self::ListMediaModels { .. }
            | Self::SubmitVideo { .. }
            | Self::QueryVideo { .. }
            | Self::CollectVideo { .. } => None,
        }
    }

    pub(crate) fn route_query(&self) -> QueryRoute<ProviderAccountId> {
        match self {
            Self::ListAccounts { .. }
            | Self::GetAccount { .. }
            | Self::ListModels { .. }
            | Self::SelectableModels { .. }
            | Self::ListRouting { .. }
            | Self::TextGenerationModelLimits { .. }
            | Self::GenerateText { .. }
            | Self::DiscoverModelDraft { .. }
            | Self::PrepareGenerationBinding { .. }
            | Self::RestoreGenerationBinding { .. }
            | Self::CountBoundInput { .. }
            | Self::GenerateBound { .. }
            | Self::GenerateMedia { .. }
            | Self::ListMediaModels { .. }
            | Self::SubmitVideo { .. }
            | Self::QueryVideo { .. }
            | Self::CollectVideo { .. } => QueryRoute::Direct,
            Self::SelectSessionModel { .. } | Self::SelectMatchaSessionModelRuntime { .. } => {
                QueryRoute::Global
            }
        }
    }
}
