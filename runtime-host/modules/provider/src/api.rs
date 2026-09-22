use foundation::execution::{CommandRoute, OwnerRuntimeHandle, QueryRoute};
use tokio::sync::oneshot;

use crate::{
    ProviderAccountId, ProviderAccountRevision, ProviderModelCapability,
    ProviderPrivateProjectionEffect, ProviderRouting, Resolver,
    application::{ProviderAccountDraft, receipts::*},
};

#[derive(Clone)]
pub struct ProviderHandle {
    owner: OwnerRuntimeHandle<ProviderCommand, ProviderQuery>,
}

impl ProviderHandle {
    pub(crate) fn new(owner: OwnerRuntimeHandle<ProviderCommand, ProviderQuery>) -> Self {
        Self { owner }
    }

    pub async fn configure_provider_private_resolver(&self, resolver: Resolver) -> Result<(), ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_command(ProviderCommand::ConfigurePrivateResolver { resolver, reply })
            .await
            .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub async fn list_provider_accounts(&self) -> Result<ProviderAccountsDelivery, ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_query(ProviderQuery::ListAccounts { reply })
            .await
            .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub async fn get_provider_account(
        &self,
        id: ProviderAccountId,
    ) -> Result<ProviderAccountsDelivery, ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_query(ProviderQuery::GetAccount { id, reply })
            .await
            .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub async fn replace_provider_account(
        &self,
        draft: ProviderAccountDraft,
    ) -> Result<ProviderAccountsDelivery, ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_command(ProviderCommand::ReplaceAccount { draft, reply })
            .await
            .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub async fn delete_provider_account(
        &self,
        id: ProviderAccountId,
        revision: ProviderAccountRevision,
    ) -> Result<ProviderAccountsDelivery, ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_command(ProviderCommand::DeleteAccount {
                id,
                revision,
                reply,
            })
            .await
            .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub async fn list_provider_models(&self) -> Result<ProviderModelListOutcome, ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_query(ProviderQuery::ListModels { reply })
            .await
            .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub async fn selectable_provider_models(
        &self,
        capability: ProviderModelCapability,
    ) -> Result<ProviderModelSelectableOutcome, ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_query(ProviderQuery::SelectableModels { capability, reply })
            .await
            .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub async fn discover_provider_models(
        &self,
        account_id: String,
    ) -> Result<ProviderModelDiscoverOutcome, ()> {
        let Ok(account_id) = ProviderAccountId::try_new(account_id) else {
            return Ok(ProviderModelDiscoverOutcome::Rejected);
        };
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_query(ProviderQuery::DiscoverModels { account_id, reply })
            .await
            .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub async fn replace_provider_models(
        &self,
        account_id: String,
        drafts: Vec<ProviderModelDraft>,
    ) -> Result<ProviderModelReplaceOutcome, ()> {
        let account_id = ProviderAccountId::try_new(account_id).ok();
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_command(ProviderCommand::ReplaceModels {
                account_id,
                drafts,
                reply,
            })
            .await
            .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub async fn list_provider_routing(&self) -> Result<ProviderRoutingListOutcome, ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_query(ProviderQuery::ListRouting { reply })
            .await
            .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub async fn replace_provider_routing(
        &self,
        routing: ProviderRouting,
    ) -> Result<ProviderRoutingReplaceOutcome, ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_command(ProviderCommand::ReplaceRouting { routing, reply })
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
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_query(ProviderQuery::SelectSessionModel {
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
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_query(ProviderQuery::SelectMatchaSessionModelRuntime {
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
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_query(ProviderQuery::AcceptSessionRuntimeModels {
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
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_query(ProviderQuery::SelectSessionModelRebound {
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

pub enum ProviderCommand {
    ConfigurePrivateResolver {
        resolver: Resolver,
        reply: oneshot::Sender<()>,
    },
    ReplaceAccount {
        draft: ProviderAccountDraft,
        reply: oneshot::Sender<ProviderAccountsDelivery>,
    },
    DeleteAccount {
        id: ProviderAccountId,
        revision: ProviderAccountRevision,
        reply: oneshot::Sender<ProviderAccountsDelivery>,
    },
    ReplaceModels {
        account_id: Option<ProviderAccountId>,
        drafts: Vec<ProviderModelDraft>,
        reply: oneshot::Sender<ProviderModelReplaceOutcome>,
    },
    ReplaceRouting {
        routing: ProviderRouting,
        reply: oneshot::Sender<ProviderRoutingReplaceOutcome>,
    },
    PreparePrivateProjection {
        reply: oneshot::Sender<ProviderPrivateProjectionEffect>,
    },
}

pub enum ProviderQuery {
    ListAccounts {
        reply: oneshot::Sender<ProviderAccountsDelivery>,
    },
    GetAccount {
        id: ProviderAccountId,
        reply: oneshot::Sender<ProviderAccountsDelivery>,
    },
    ListModels {
        reply: oneshot::Sender<ProviderModelListOutcome>,
    },
    SelectableModels {
        capability: ProviderModelCapability,
        reply: oneshot::Sender<ProviderModelSelectableOutcome>,
    },
    DiscoverModels {
        account_id: ProviderAccountId,
        reply: oneshot::Sender<ProviderModelDiscoverOutcome>,
    },
    ListRouting {
        reply: oneshot::Sender<ProviderRoutingListOutcome>,
    },
    SelectSessionModel {
        endpoint: ProviderSessionEndpoint,
        session_key: String,
        endpoint_session_id: Option<String>,
        model_selection_id: String,
        trace_id: Option<String>,
        reply: oneshot::Sender<ProviderSessionModelSelectionOutcome>,
    },
    SelectMatchaSessionModelRuntime {
        session_key: String,
        endpoint_session_id: Option<String>,
        model_id: String,
        model_selection_id: Option<String>,
        provider_fingerprint: Option<String>,
        trace_id: Option<String>,
        reply: oneshot::Sender<ProviderSessionModelSelectionOutcome>,
    },
    AcceptSessionRuntimeModels {
        endpoint: ProviderSessionEndpoint,
        model_refs: Vec<String>,
        reply: oneshot::Sender<ProviderSessionRuntimeModelsOutcome>,
    },
    SelectSessionModelRebound {
        endpoint: ProviderSessionEndpoint,
        session_key: String,
        endpoint_session_id: Option<String>,
        current_model: Option<String>,
        default_model: Option<String>,
        trace_id: Option<String>,
        reply: oneshot::Sender<ProviderSessionModelSelectionOutcome>,
    },
}

impl ProviderCommand {
    pub(crate) fn route_command(&self) -> CommandRoute<ProviderAccountId> {
        CommandRoute::Global
    }
}

impl ProviderQuery {
    pub(crate) fn route_query(&self) -> QueryRoute<ProviderAccountId> {
        match self {
            Self::ListAccounts { .. }
            | Self::GetAccount { .. }
            | Self::ListModels { .. }
            | Self::SelectableModels { .. }
            | Self::ListRouting { .. } => QueryRoute::Direct,
            Self::DiscoverModels { .. }
            | Self::SelectSessionModel { .. }
            | Self::SelectMatchaSessionModelRuntime { .. }
            | Self::AcceptSessionRuntimeModels { .. }
            | Self::SelectSessionModelRebound { .. } => QueryRoute::Global,
        }
    }
}
