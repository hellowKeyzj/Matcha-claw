use std::{collections::BTreeSet, sync::Arc};

use arc_swap::ArcSwap;
use environment::{
    ProviderAccount, ProviderAccountId, ProviderCascade, ProviderModel, ProviderModelCapability,
    ProviderModelCatalog, ProviderRouting,
};
use foundation::execution::{CommandRoute, LaneRetention, OwnerSpec, QueryRoute};
use openclaw::{
    port::ProviderNativeConfigurationEffect,
    projection::provider_models::public_provider_model_identities,
};

use super::{
    ProviderAccountsOwner, ProviderModelOwner, ProviderRoutingOwner,
    accounts::{ProviderAccountsDesiredOutcome, ProviderAccountsMutation},
    command::{ProviderCommand, ProviderQuery},
    models::{
        ProviderModelListOutcome, ProviderModelReplaceOutcome, ProviderModelSelectableOutcome,
        ProviderModelView, SelectableProviderModelView,
    },
    routing::ProviderRoutingListOutcome,
};
use crate::{
    runtime_directory::RuntimeDriverDirectory,
    runtime_driver::{LifecycleOps, ProviderNativeConfigurationCommand},
    sessions::model_selection::{
        NativeEndpoint, ResolvedSessionModelSelection, SessionModelSelectionBinding,
        SessionModelSelectionCommand, SessionModelSelectionOutcome, SessionModelSelectionRejection,
    },
    transport::{provider_accounts::ProviderAccountsDelivery, session_trace},
};

struct ProviderSnapshot {
    accounts: Vec<ProviderAccount>,
    catalog: ProviderModelCatalog,
    routing: Option<ProviderRouting>,
}

#[derive(Clone)]
pub(crate) struct ProviderShared {
    snapshot: Arc<ArcSwap<ProviderSnapshot>>,
}

pub(crate) struct ProviderOwner {
    cascade: ProviderCascade,
    accounts: ProviderAccountsOwner,
    models: ProviderModelOwner,
    routing: ProviderRoutingOwner,
    runtime_directory: Arc<RuntimeDriverDirectory>,
    snapshot: Arc<ArcSwap<ProviderSnapshot>>,
}

impl ProviderOwner {
    pub(crate) fn new(
        cascade: ProviderCascade,
        accounts: ProviderAccountsOwner,
        models: ProviderModelOwner,
        routing: ProviderRoutingOwner,
        runtime_directory: Arc<RuntimeDriverDirectory>,
    ) -> Self {
        let snapshot = Arc::new(ArcSwap::new(Arc::new(ProviderSnapshot {
            accounts: cascade.accounts().to_vec(),
            catalog: cascade.catalog().clone(),
            routing: cascade.routing().cloned(),
        })));

        Self {
            cascade,
            accounts,
            models,
            routing,
            runtime_directory,
            snapshot,
        }
    }

    pub(crate) fn lane_retention() -> LaneRetention {
        LaneRetention::LowFrequency
    }
}

impl OwnerSpec for ProviderOwner {
    type Command = ProviderCommand;
    type Query = ProviderQuery;
    type Key = ProviderAccountId;
    type Shared = ProviderShared;
    type GlobalState = ProviderOwner;
    type LaneState = ();

    fn split(self) -> (Self::Shared, Self::GlobalState) {
        (
            ProviderShared {
                snapshot: Arc::clone(&self.snapshot),
            },
            self,
        )
    }

    fn route_command(command: &Self::Command) -> CommandRoute<Self::Key> {
        command.route_command()
    }

    fn route_query(query: &Self::Query) -> QueryRoute<Self::Key> {
        query.route_query()
    }

    fn open_lane(_shared: &Self::Shared, _key: &Self::Key) -> Self::LaneState {}

    async fn handle_keyed_command(
        _shared: Self::Shared,
        _key: Self::Key,
        _lane: &mut Self::LaneState,
        _command: Self::Command,
    ) {
    }

    async fn handle_global_command(
        _shared: Self::Shared,
        state: &mut Self::GlobalState,
        command: Self::Command,
    ) {
        state.handle_provider_command(command).await;
    }

    async fn handle_direct_query(shared: Self::Shared, query: Self::Query) {
        handle_provider_snapshot_query(&shared.snapshot, query).await;
    }

    async fn handle_keyed_query(
        _shared: Self::Shared,
        _key: Self::Key,
        _lane: &mut Self::LaneState,
        _query: Self::Query,
    ) {
    }

    async fn handle_global_query(
        _shared: Self::Shared,
        state: &mut Self::GlobalState,
        query: Self::Query,
    ) {
        state.handle_provider_query(query).await;
    }

    async fn handle_exclusive_query(
        _shared: Self::Shared,
        state: &mut Self::GlobalState,
        query: Self::Query,
    ) {
        state.handle_provider_query(query).await;
    }
}

impl ProviderOwner {
    async fn handle_provider_command(&mut self, command: ProviderCommand) {
        use ProviderCommand::*;
        match command {
            ConfigurePrivateResolver { resolver, reply } => {
                self.accounts.set_private_resolver(resolver.clone());
                self.models.set_private_resolver(resolver);
                self.update_snapshot();
                let _ = reply.send(());
            }
            ReplaceAccount { draft, reply } => {
                let outcome = self.accounts.replace(&mut self.cascade, draft);
                let outcome = self.finish_account_mutation(outcome).await;
                self.update_snapshot();
                let _ = reply.send(outcome);
            }
            DeleteAccount {
                id,
                revision,
                reply,
            } => {
                let outcome = self.accounts.delete(&mut self.cascade, id, revision);
                let outcome = self.finish_account_mutation(outcome).await;
                self.update_snapshot();
                let _ = reply.send(outcome);
            }
            ReplaceModels {
                account_id,
                drafts,
                reply,
            } => {
                let account_id_str = account_id.as_ref().map(|id| id.as_str().to_string());
                let (outcome, returned_id) = account_id_str
                    .map(|id_str| {
                        self.models
                            .replace_for_account(&mut self.cascade, id_str, drafts)
                    })
                    .unwrap_or((ProviderModelReplaceOutcome::Rejected, None));
                let outcome = self.finish_model_mutation(outcome, returned_id).await;
                self.update_snapshot();
                let _ = reply.send(outcome);
            }
            ReplaceRouting { routing, reply } => {
                let outcome = self.routing.replace(&mut self.cascade, routing);
                let outcome = self.finish_routing_mutation(outcome).await;
                self.update_snapshot();
                let _ = reply.send(outcome);
            }
            PrepareOpenClawPrivateBootstrap { state_dir, reply } => {
                let effect = self.prepare_openclaw_private_bootstrap(state_dir);
                self.update_snapshot();
                let _ = reply.send(effect);
            }
        }
    }

    async fn handle_provider_query(&self, query: ProviderQuery) {
        use ProviderQuery::*;
        match query {
            ListAccounts { reply } => {
                let _ = reply.send(list_provider_accounts_for_snapshot(&self.snapshot));
            }
            GetAccount { id, reply } => {
                let _ = reply.send(get_provider_account_for_snapshot(&self.snapshot, &id));
            }
            ListModels { reply } => {
                let _ = reply.send(list_provider_models_for_snapshot(&self.snapshot));
            }
            SelectableModels { capability, reply } => {
                let _ = reply.send(selectable_provider_models_for_snapshot(
                    &self.snapshot,
                    capability,
                ));
            }
            ListRouting { reply } => {
                let _ = reply.send(list_provider_routing_for_snapshot(&self.snapshot));
            }
            ResolveSessionModelSelection { command, reply } => {
                let outcome = self.resolve_session_model_selection(command);
                let _ = reply.send(outcome);
            }
        }
    }

    fn update_snapshot(&self) {
        let new_snapshot = ProviderSnapshot {
            accounts: self.cascade.accounts().to_vec(),
            catalog: self.cascade.catalog().clone(),
            routing: self.cascade.routing().cloned(),
        };
        self.snapshot.store(Arc::new(new_snapshot));
    }

    async fn finish_account_mutation(
        &mut self,
        mutation: ProviderAccountsMutation,
    ) -> crate::transport::provider_accounts::ProviderAccountsDelivery {
        let native = if mutation.private.is_err() {
            ProviderNativeConfigurationEffect::Unavailable
        } else if mutation.commit == super::accounts::ProviderCommitOutcome::Committed {
            self.reconcile(&mutation.retired, &mutation.required_auth_accounts())
                .await
        } else {
            ProviderNativeConfigurationEffect::Unavailable
        };
        match mutation.desired {
            ProviderAccountsDesiredOutcome::Stored => {
                crate::transport::provider_accounts::ProviderAccountsDelivery::Stored {
                    account: mutation
                        .account
                        .expect("stored provider account must contain an account"),
                    persisted: mutation.persisted,
                    native,
                    commit: mutation.commit,
                }
            }
            ProviderAccountsDesiredOutcome::Deleted => {
                crate::transport::provider_accounts::ProviderAccountsDelivery::Deleted {
                    persisted: mutation.persisted,
                    native,
                    commit: mutation.commit,
                }
            }
            ProviderAccountsDesiredOutcome::Rejected => {
                crate::transport::provider_accounts::ProviderAccountsDelivery::Rejected
            }
            ProviderAccountsDesiredOutcome::Unknown => {
                crate::transport::provider_accounts::ProviderAccountsDelivery::Unknown {
                    desired: mutation
                        .kind
                        .expect("unknown provider account mutation must have a kind"),
                    persisted: mutation.persisted,
                    native,
                    commit: mutation.commit,
                }
            }
            ProviderAccountsDesiredOutcome::Unavailable => {
                crate::transport::provider_accounts::ProviderAccountsDelivery::Unavailable
            }
        }
    }

    async fn finish_model_mutation(
        &mut self,
        outcome: super::models::ProviderModelReplaceOutcome,
        account_id: Option<ProviderAccountId>,
    ) -> super::models::ProviderModelReplaceOutcome {
        let super::models::ProviderModelReplaceOutcome::DesiredStored {
            persisted, commit, ..
        } = outcome
        else {
            return outcome;
        };
        let Some(account_id) = account_id else {
            return outcome;
        };
        let native = self.reconcile(&[], &BTreeSet::from([account_id])).await;
        super::models::ProviderModelReplaceOutcome::DesiredStored {
            persisted,
            native,
            commit,
        }
    }

    async fn finish_routing_mutation(
        &mut self,
        outcome: super::routing::ProviderRoutingReplaceOutcome,
    ) -> super::routing::ProviderRoutingReplaceOutcome {
        let super::routing::ProviderRoutingReplaceOutcome::DesiredStored {
            persisted, commit, ..
        } = outcome
        else {
            return outcome;
        };
        let required = self.routing.route_account_ids(&self.cascade);
        let native = self.reconcile(&[], &required).await;
        super::routing::ProviderRoutingReplaceOutcome::DesiredStored {
            persisted,
            native,
            commit,
        }
    }

    fn resolve_session_model_selection(
        &self,
        command: SessionModelSelectionCommand,
    ) -> Result<ResolvedSessionModelSelection, SessionModelSelectionOutcome> {
        let Some(capability) = session_model_capability(command.endpoint) else {
            return Err(SessionModelSelectionOutcome::Unsupported);
        };
        let selection = match self.models.resolve_selection(
            &self.cascade,
            capability,
            &command.model_selection_id,
        ) {
            Ok(Some(selection)) => selection,
            Ok(None) => {
                return Err(SessionModelSelectionOutcome::target_rejected(
                    SessionModelSelectionRejection::ModelSelectionNotFound,
                ));
            }
            Err(()) => return Err(SessionModelSelectionOutcome::Unavailable),
        };
        let diagnostic = Some(selection.diagnostic());
        if let Some(diagnostic) = diagnostic.as_ref() {
            session_trace::log(
                "runtime.model-selection.resolved",
                command.trace_id.as_deref(),
                serde_json::json!({
                    "endpoint": format!("{:?}", command.endpoint),
                    "sessionKey": session_trace::id_shape(Some(&command.session_key)),
                    "endpointSessionId": session_trace::id_shape(command.endpoint_session_id.as_deref()),
                    "modelSelectionId": session_trace::id_shape(Some(&command.model_selection_id)),
                    "accountId": diagnostic.account_id(),
                    "modelId": diagnostic.model_id(),
                    "protocol": diagnostic.protocol(),
                    "authMode": diagnostic.auth_mode(),
                }),
            );
        }
        let binding = match command.endpoint {
            NativeEndpoint::OpenClawLocal => {
                let model = self
                    .models
                    .openclaw_model_ref(&self.cascade, &selection)
                    .map_err(|_| {
                        SessionModelSelectionOutcome::target_rejected_with_diagnostic(
                            SessionModelSelectionRejection::OpenClawModelRefInvalid,
                            diagnostic.clone(),
                        )
                    })?;
                let model =
                    openclaw::session::protocol::ModelRef::try_new(model).map_err(|_| {
                        SessionModelSelectionOutcome::target_rejected_with_diagnostic(
                            SessionModelSelectionRejection::OpenClawModelRefInvalid,
                            diagnostic.clone(),
                        )
                    })?;
                SessionModelSelectionBinding::OpenClaw(model)
            }
            NativeEndpoint::MatchaAgentLocal => {
                let binding = self
                    .models
                    .matcha_model_binding(&self.cascade, &selection)
                    .map_err(|_| {
                        SessionModelSelectionOutcome::target_rejected_with_diagnostic(
                            SessionModelSelectionRejection::MatchaProviderRuntimeUnavailable,
                            diagnostic.clone(),
                        )
                    })?;
                SessionModelSelectionBinding::Matcha {
                    model: binding.model,
                    provider_fingerprint: binding.provider_fingerprint,
                    provider_runtime: binding.provider_runtime,
                }
            }
            NativeEndpoint::Unsupported => return Err(SessionModelSelectionOutcome::Unsupported),
        };
        Ok(ResolvedSessionModelSelection {
            endpoint: command.endpoint,
            session_key: command.session_key,
            endpoint_session_id: command.endpoint_session_id,
            binding,
            diagnostic,
            trace_id: command.trace_id,
        })
    }

    fn prepare_openclaw_private_bootstrap(
        &mut self,
        state_dir: openclaw::lifecycle::state_dir::CanonicalStateDir,
    ) -> openclaw::bootstrap::PrivateProjectionEffect {
        if self.cascade.reload().is_err() {
            return openclaw::bootstrap::PrivateProjectionEffect {
                providers: openclaw::bootstrap::ConfigWriteEffect::Unknown,
                restart: openclaw::bootstrap::RestartPreparation::Unknown,
            };
        }
        openclaw::bootstrap::PrivateProjectionEffect::apply(
            state_dir,
            self.cascade.accounts(),
            self.cascade.catalog(),
            self.cascade.routing(),
            now_millis(),
        )
    }

    async fn reconcile(
        &mut self,
        retired: &[ProviderAccount],
        required_auth_accounts: &BTreeSet<ProviderAccountId>,
    ) -> ProviderNativeConfigurationEffect {
        if self.cascade.reload().is_err() {
            return ProviderNativeConfigurationEffect::Unavailable;
        }
        let accounts = self.cascade.accounts().to_vec();
        let catalog = self.cascade.catalog().clone();
        let routing = self.cascade.routing().cloned();
        if self
            .accounts
            .apply_private_profiles_for_provider_config(&accounts, required_auth_accounts)
            .is_err()
        {
            return ProviderNativeConfigurationEffect::Unavailable;
        }

        let mut effects = Vec::new();
        for driver in self.runtime_directory.all_drivers() {
            if !driver.lifecycle_ops().is_some_and(LifecycleOps::readiness) {
                continue;
            }
            if let Some(provider_ops) = driver.provider_config_ops() {
                let command = ProviderNativeConfigurationCommand {
                    accounts: &accounts,
                    models: &catalog,
                    routing: routing.as_ref(),
                    retired,
                    required_auth_accounts,
                    now_millis: now_millis(),
                };
                let effect = provider_ops
                    .reconcile_provider_native_configuration(command)
                    .await;
                effects.push(effect);
            }
        }

        if effects.is_empty() {
            ProviderNativeConfigurationEffect::Unavailable
        } else {
            effects
                .into_iter()
                .reduce(|acc, effect| acc.merge(effect))
                .unwrap()
        }
    }
}

async fn handle_provider_snapshot_query(
    snapshot: &ArcSwap<ProviderSnapshot>,
    query: ProviderQuery,
) {
    match query {
        ProviderQuery::ListAccounts { reply } => {
            let _ = reply.send(list_provider_accounts_for_snapshot(snapshot));
        }
        ProviderQuery::GetAccount { id, reply } => {
            let _ = reply.send(get_provider_account_for_snapshot(snapshot, &id));
        }
        ProviderQuery::ListModels { reply } => {
            let _ = reply.send(list_provider_models_for_snapshot(snapshot));
        }
        ProviderQuery::SelectableModels { capability, reply } => {
            let _ = reply.send(selectable_provider_models_for_snapshot(
                snapshot, capability,
            ));
        }
        ProviderQuery::ListRouting { reply } => {
            let _ = reply.send(list_provider_routing_for_snapshot(snapshot));
        }
        ProviderQuery::ResolveSessionModelSelection { reply, .. } => {
            let _ = reply.send(Err(SessionModelSelectionOutcome::Unavailable));
        }
    }
}

fn list_provider_accounts_for_snapshot(
    snapshot: &ArcSwap<ProviderSnapshot>,
) -> ProviderAccountsDelivery {
    let snapshot = snapshot.load_full();
    ProviderAccountsDelivery::List(snapshot.accounts.iter().map(account_json).collect())
}

fn get_provider_account_for_snapshot(
    snapshot: &ArcSwap<ProviderSnapshot>,
    id: &ProviderAccountId,
) -> ProviderAccountsDelivery {
    let snapshot = snapshot.load_full();
    account_for_snapshot(&snapshot, id)
        .map(account_json)
        .map(ProviderAccountsDelivery::Account)
        .unwrap_or(ProviderAccountsDelivery::Missing)
}

fn list_provider_models_for_snapshot(
    snapshot: &ArcSwap<ProviderSnapshot>,
) -> ProviderModelListOutcome {
    let snapshot = snapshot.load_full();
    ProviderModelListOutcome::Available(
        snapshot
            .catalog
            .models()
            .iter()
            .filter_map(|model| model_view_for_snapshot(&snapshot, model))
            .collect(),
    )
}

fn selectable_provider_models_for_snapshot(
    snapshot: &ArcSwap<ProviderSnapshot>,
    capability: ProviderModelCapability,
) -> ProviderModelSelectableOutcome {
    let snapshot = snapshot.load_full();
    let Ok(identities) = public_provider_model_identities(&snapshot.accounts) else {
        return ProviderModelSelectableOutcome::Unavailable;
    };
    ProviderModelSelectableOutcome::Available(
        snapshot
            .catalog
            .selectable_for(capability)
            .into_iter()
            .filter_map(|model| {
                let account = account_for_snapshot(&snapshot, model.account_id())?;
                let _identity = identities.get(account.id().as_str())?;
                let view = model_view_for_snapshot(&snapshot, model)?;
                Some(SelectableProviderModelView {
                    model: view,
                    selection_id: model.selection_id(),
                })
            })
            .collect(),
    )
}

fn list_provider_routing_for_snapshot(
    snapshot: &ArcSwap<ProviderSnapshot>,
) -> ProviderRoutingListOutcome {
    let snapshot = snapshot.load_full();
    ProviderRoutingListOutcome::Desired(snapshot.routing.clone())
}

fn account_for_snapshot<'a>(
    snapshot: &'a ProviderSnapshot,
    id: &ProviderAccountId,
) -> Option<&'a ProviderAccount> {
    snapshot.accounts.iter().find(|account| account.id() == id)
}

fn account_json(account: &ProviderAccount) -> serde_json::Value {
    crate::transport::provider_accounts::account_json_for_owner(account)
}

fn model_view_for_snapshot(
    snapshot: &ProviderSnapshot,
    model: &ProviderModel,
) -> Option<ProviderModelView> {
    let account = account_for_snapshot(snapshot, model.account_id())?;
    Some(ProviderModelView {
        account_id: account.id().as_str().to_owned(),
        label: account.configuration().label().to_owned(),
        model_id: model.model_id().to_owned(),
        capabilities: model.capabilities().to_vec(),
        context_window: model.context_window(),
        max_tokens: model.max_tokens(),
        timeout_ms: model.timeout_ms(),
        aspect_ratio: model.aspect_ratio().map(str::to_owned),
        resolution: model.resolution().map(str::to_owned),
        quality: model.quality().map(str::to_owned),
    })
}

fn session_model_capability(
    endpoint: NativeEndpoint,
) -> Option<environment::ProviderModelCapability> {
    match endpoint {
        NativeEndpoint::OpenClawLocal | NativeEndpoint::MatchaAgentLocal => {
            Some(environment::ProviderModelCapability::Chat)
        }
        NativeEndpoint::Unsupported => None,
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| u64::try_from(d.as_millis()).ok())
        .unwrap_or(u64::MAX)
}
