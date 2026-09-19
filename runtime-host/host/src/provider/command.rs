use environment::{
    ProviderAccountId, ProviderAccountRevision, ProviderModelCapability, ProviderRouting,
};
use foundation::execution::{CommandRoute, QueryRoute};
use openclaw::lifecycle::state_dir::CanonicalStateDir;
use tokio::sync::oneshot;

use crate::{
    provider::{account_draft::ProviderAccountDraft, auth::Resolver},
    sessions::model_selection::{
        MatchaSessionModelRuntimeCommand, NativeEndpoint, ResolvedSessionModelSelection,
        SessionModelSelectionCommand, SessionModelSelectionOutcome, SessionRuntimeModelCommand,
    },
};

use super::{
    accounts::ProviderAccountsDelivery,
    models::{
        ProviderModelDiscoverOutcome, ProviderModelDraft, ProviderModelListOutcome,
        ProviderModelReplaceOutcome, ProviderModelSelectableOutcome,
    },
    routing::{ProviderRoutingListOutcome, ProviderRoutingReplaceOutcome},
};

pub(crate) enum ProviderCommand {
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
    PrepareOpenClawPrivateBootstrap {
        state_dir: CanonicalStateDir,
        reply: oneshot::Sender<openclaw::bootstrap::PrivateProjectionEffect>,
    },
}

pub(crate) enum ProviderQuery {
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
    ResolveSessionModelSelection {
        command: SessionModelSelectionCommand,
        reply: oneshot::Sender<Result<ResolvedSessionModelSelection, SessionModelSelectionOutcome>>,
    },
    ResolveMatchaSessionModelRuntime {
        command: MatchaSessionModelRuntimeCommand,
        reply: oneshot::Sender<Result<ResolvedSessionModelSelection, SessionModelSelectionOutcome>>,
    },
    AcceptSessionRuntimeModels {
        endpoint: NativeEndpoint,
        model_refs: Vec<String>,
        reply: oneshot::Sender<Result<Vec<bool>, SessionModelSelectionOutcome>>,
    },
    ResolveSessionModelRebound {
        command: SessionRuntimeModelCommand,
        reply: oneshot::Sender<Result<ResolvedSessionModelSelection, SessionModelSelectionOutcome>>,
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
            | Self::AcceptSessionRuntimeModels { .. }
            | Self::ResolveSessionModelRebound { .. }
            | Self::ResolveSessionModelSelection { .. }
            | Self::ResolveMatchaSessionModelRuntime { .. } => QueryRoute::Global,
        }
    }
}
