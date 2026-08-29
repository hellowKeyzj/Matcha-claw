use environment::{
    ProviderAccountId, ProviderAccountRevision, ProviderModelCapability, ProviderRouting,
};
use foundation::execution::OwnerRuntimeHandle;
use openclaw::lifecycle::state_dir::CanonicalStateDir;
use tokio::sync::oneshot;

use crate::{
    sessions::model_selection::{
        ResolvedSessionModelSelection, SessionModelSelectionCommand, SessionModelSelectionOutcome,
    },
    transport::provider_accounts::{
        AccountDraft, ProviderAccountsDelivery, private_auth::Resolver,
    },
};

use super::{
    command::{ProviderCommand, ProviderQuery},
    models::{
        ProviderModelDraft, ProviderModelListOutcome, ProviderModelReplaceOutcome,
        ProviderModelSelectableOutcome,
    },
    routing::{ProviderRoutingListOutcome, ProviderRoutingReplaceOutcome},
};

#[derive(Clone)]
pub(crate) struct ProviderHandle {
    owner: OwnerRuntimeHandle<ProviderCommand, ProviderQuery>,
}

impl ProviderHandle {
    pub(crate) fn new(owner: OwnerRuntimeHandle<ProviderCommand, ProviderQuery>) -> Self {
        Self { owner }
    }

    pub(crate) async fn configure_provider_private_resolver(
        &self,
        resolver: Resolver,
    ) -> Result<(), ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_command(ProviderCommand::ConfigurePrivateResolver { resolver, reply })
            .await
            .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub(crate) async fn list_provider_accounts(&self) -> Result<ProviderAccountsDelivery, ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_query(ProviderQuery::ListAccounts { reply })
            .await
            .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub(crate) async fn get_provider_account(
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

    pub(crate) async fn replace_provider_account(
        &self,
        draft: AccountDraft,
    ) -> Result<ProviderAccountsDelivery, ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_command(ProviderCommand::ReplaceAccount { draft, reply })
            .await
            .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub(crate) async fn delete_provider_account(
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

    pub(crate) async fn list_provider_models(&self) -> Result<ProviderModelListOutcome, ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_query(ProviderQuery::ListModels { reply })
            .await
            .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub(crate) async fn selectable_provider_models(
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

    pub(crate) async fn replace_provider_models(
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

    pub(crate) async fn list_provider_routing(&self) -> Result<ProviderRoutingListOutcome, ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_query(ProviderQuery::ListRouting { reply })
            .await
            .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }

    pub(crate) async fn replace_provider_routing(
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

    pub(crate) async fn prepare_openclaw_private_bootstrap(
        &self,
        state_dir: CanonicalStateDir,
    ) -> openclaw::bootstrap::PrivateProjectionEffect {
        let (reply, rx) = oneshot::channel();
        if self
            .owner
            .send_command(ProviderCommand::PrepareOpenClawPrivateBootstrap { state_dir, reply })
            .await
            .is_err()
        {
            return openclaw::bootstrap::PrivateProjectionEffect {
                providers: openclaw::bootstrap::ConfigWriteEffect::Unknown,
                restart: openclaw::bootstrap::RestartPreparation::Unknown,
            };
        }
        rx.await
            .unwrap_or(openclaw::bootstrap::PrivateProjectionEffect {
                providers: openclaw::bootstrap::ConfigWriteEffect::Unknown,
                restart: openclaw::bootstrap::RestartPreparation::Unknown,
            })
    }

    pub(crate) async fn resolve_session_model_selection(
        &self,
        command: SessionModelSelectionCommand,
    ) -> Result<ResolvedSessionModelSelection, SessionModelSelectionOutcome> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_query(ProviderQuery::ResolveSessionModelSelection { command, reply })
            .await
            .map_err(|_| SessionModelSelectionOutcome::Unavailable)?;
        rx.await
            .map_err(|_| SessionModelSelectionOutcome::Unavailable)?
    }
}
