use std::{collections::BTreeSet, sync::Arc};

use arc_swap::ArcSwap;
use environment::{
    ProviderAccount, ProviderAccountId, ProviderCascade, ProviderModel, ProviderModelCapability,
    ProviderModelCatalog, ProviderRouting,
};
use foundation::execution::{CommandRoute, LaneRetention, OwnerSpec, QueryRoute};
use openclaw::port::ProviderNativeConfigurationEffect;

use super::{
    ProviderAccountsOwner, ProviderModelOwner, ProviderRoutingOwner,
    accounts::{
        ProviderAccountView, ProviderAccountsDelivery, ProviderAccountsDesiredOutcome,
        ProviderAccountsMutation,
    },
    command::{ProviderCommand, ProviderQuery},
    models::{
        ProviderModelDiscoverOutcome, ProviderModelListOutcome, ProviderModelReplaceOutcome,
        ProviderModelSelectableOutcome, ProviderModelView, SelectableProviderModelView,
    },
    native::ProviderNativeConfigurationView,
    routing::{ProviderRoutingListOutcome, ProviderRoutingView},
    runtime_identity::provider_runtime_identities,
};
use crate::{
    runtime::directory::RuntimeDriverDirectory,
    runtime::driver::ProviderNativeConfigurationCommand,
    sessions::model_selection::{
        MatchaSessionModelRuntimeCommand, NativeEndpoint, ResolvedSessionModelSelection,
        SessionModelSelectionBinding, SessionModelSelectionCommand, SessionModelSelectionOutcome,
        SessionModelSelectionRejection,
    },
    transport::sessions::trace as session_trace,
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

    async fn handle_provider_query(&mut self, query: ProviderQuery) {
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
            DiscoverModels { account_id, reply } => {
                let _ = reply.send(self.models.discover(&mut self.cascade, &account_id).await);
            }
            ListRouting { reply } => {
                let _ = reply.send(list_provider_routing_for_snapshot(&self.snapshot));
            }
            ResolveSessionModelSelection { command, reply } => {
                let outcome = self.resolve_session_model_selection(command);
                let _ = reply.send(outcome);
            }
            ResolveMatchaSessionModelRuntime { command, reply } => {
                let outcome = self.resolve_matcha_session_model_runtime(command);
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
    ) -> ProviderAccountsDelivery {
        eprintln!(
            "[startup-trace] source=provider-owner phase=account-mutation detail=start desired={:?} kind={:?} persisted={:?} commit={:?} private_ok={} account_present={} retired={} required_auth={} auth_refresh={}",
            mutation.desired,
            mutation.kind,
            mutation.persisted,
            mutation.commit,
            mutation.private.is_ok(),
            mutation.account.is_some(),
            mutation.retired.len(),
            mutation.required_auth_accounts().len(),
            mutation.auth_state_refresh_required
        );
        let native = if mutation.private.is_err() {
            eprintln!(
                "[startup-trace] source=provider-owner phase=account-mutation detail=private-projection-failed"
            );
            ProviderNativeConfigurationEffect::Unavailable
        } else if mutation.commit == super::accounts::ProviderCommitOutcome::Committed {
            eprintln!(
                "[startup-trace] source=provider-owner phase=account-mutation detail=reconcile-start"
            );
            let native = self
                .reconcile(
                    &mutation.retired,
                    mutation.required_auth_accounts(),
                    mutation.auth_state_refresh_required,
                )
                .await;
            log_provider_native_effect("account-mutation", &native);
            native
        } else {
            eprintln!(
                "[startup-trace] source=provider-owner phase=account-mutation detail=commit-not-confirmed"
            );
            ProviderNativeConfigurationEffect::Unavailable
        };
        match mutation.desired {
            ProviderAccountsDesiredOutcome::Stored => ProviderAccountsDelivery::Stored {
                account: ProviderAccountView::from_account(
                    mutation
                        .account
                        .as_ref()
                        .expect("stored provider account must contain an account"),
                ),
                persisted: mutation.persisted,
                native: ProviderNativeConfigurationView::from_effect(&native),
                commit: mutation.commit,
            },
            ProviderAccountsDesiredOutcome::Deleted => ProviderAccountsDelivery::Deleted {
                persisted: mutation.persisted,
                native: ProviderNativeConfigurationView::from_effect(&native),
                commit: mutation.commit,
            },
            ProviderAccountsDesiredOutcome::Rejected => ProviderAccountsDelivery::Rejected,
            ProviderAccountsDesiredOutcome::Unknown => ProviderAccountsDelivery::Unknown {
                desired: mutation
                    .kind
                    .expect("unknown provider account mutation must have a kind"),
                persisted: mutation.persisted,
                native: ProviderNativeConfigurationView::from_effect(&native),
                commit: mutation.commit,
            },
            ProviderAccountsDesiredOutcome::Unavailable => ProviderAccountsDelivery::Unavailable,
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
        let native = self
            .reconcile(&[], &BTreeSet::from([account_id]), false)
            .await;
        super::models::ProviderModelReplaceOutcome::DesiredStored {
            persisted,
            native: ProviderNativeConfigurationView::from_effect(&native),
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
        let native = self.reconcile(&[], &required, false).await;
        super::routing::ProviderRoutingReplaceOutcome::DesiredStored {
            persisted,
            native: ProviderNativeConfigurationView::from_effect(&native),
            commit,
        }
    }

    fn resolve_matcha_session_model_runtime(
        &self,
        command: MatchaSessionModelRuntimeCommand,
    ) -> Result<ResolvedSessionModelSelection, SessionModelSelectionOutcome> {
        let selection = match self.models.resolve_matcha_runtime(
            &self.cascade,
            environment::ProviderModelCapability::Chat,
            &command.model,
            command.model_selection_id.as_deref(),
            command.provider_fingerprint.as_deref(),
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
                "runtime.model-selection.rehydrated",
                command.trace_id.as_deref(),
                serde_json::json!({
                    "endpoint": format!("{:?}", NativeEndpoint::MatchaAgentLocal),
                    "sessionKey": session_trace::id_shape(Some(&command.session_key)),
                    "endpointSessionId": session_trace::id_shape(command.endpoint_session_id.as_deref()),
                    "modelSelectionId": command.model_selection_id.as_deref().map(|id| session_trace::id_shape(Some(id))),
                    "providerFingerprint": command.provider_fingerprint.as_deref().map(|fingerprint| session_trace::id_shape(Some(fingerprint))),
                    "accountId": diagnostic.account_id(),
                    "modelId": diagnostic.model_id(),
                    "protocol": diagnostic.protocol(),
                    "authMode": diagnostic.auth_mode(),
                }),
            );
        }
        let binding = self
            .models
            .matcha_model_binding(&self.cascade, &selection)
            .map_err(|_| {
                SessionModelSelectionOutcome::target_rejected_with_diagnostic(
                    SessionModelSelectionRejection::MatchaProviderRuntimeUnavailable,
                    diagnostic.clone(),
                )
            })?;
        Ok(ResolvedSessionModelSelection {
            endpoint: NativeEndpoint::MatchaAgentLocal,
            session_key: command.session_key,
            endpoint_session_id: command.endpoint_session_id,
            model_selection_id: selection.selection_id,
            binding: SessionModelSelectionBinding::Matcha {
                model: binding.model,
                provider_fingerprint: binding.provider_fingerprint,
                provider_runtime: binding.provider_runtime,
            },
            diagnostic,
            trace_id: command.trace_id,
        })
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
            model_selection_id: command.model_selection_id,
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
                providers: openclaw::bootstrap::ConfigWriteEffect::unknown(
                    "provider-cascade-unavailable",
                    "Provider cascade is unavailable",
                ),
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
        auth_state_refresh_required: bool,
    ) -> ProviderNativeConfigurationEffect {
        if self.cascade.reload().is_err() {
            return ProviderNativeConfigurationEffect::Unavailable;
        }
        let accounts = self.cascade.accounts().to_vec();
        let catalog = self.cascade.catalog().clone();
        let routing = self.cascade.routing().cloned();
        let auth_state_refresh_required = match self
            .accounts
            .apply_private_profiles_for_provider_config(&accounts, required_auth_accounts)
        {
            Ok(applied) => auth_state_refresh_required || applied,
            Err(_) => return ProviderNativeConfigurationEffect::Unavailable,
        };

        let now_millis = now_millis();
        let mut effects = Vec::new();
        for driver in self.runtime_directory.all_drivers() {
            if let Some(provider_ops) = driver.provider_config_ops() {
                let command = ProviderNativeConfigurationCommand {
                    accounts: &accounts,
                    models: &catalog,
                    routing: routing.as_ref(),
                    retired,
                    required_auth_accounts,
                    auth_state_refresh_required,
                    now_millis,
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
        ProviderQuery::DiscoverModels { reply, .. } => {
            let _ = reply.send(ProviderModelDiscoverOutcome::Unavailable);
        }
        ProviderQuery::ResolveSessionModelSelection { reply, .. }
        | ProviderQuery::ResolveMatchaSessionModelRuntime { reply, .. } => {
            let _ = reply.send(Err(SessionModelSelectionOutcome::Unavailable));
        }
    }
}

fn log_provider_native_effect(phase: &str, native: &ProviderNativeConfigurationEffect) {
    match native {
        ProviderNativeConfigurationEffect::Evidence(evidence) => {
            if let Some(diagnostic) = evidence.diagnostic() {
                eprintln!(
                    "[startup-trace] source=provider-owner phase={phase} detail=reconcile-outcome changed={} applied={:?} observed={:?} diagnostic_phase={} diagnostic_reason={} method={} expected_path={} detail_len={}",
                    evidence.changed(),
                    evidence.applied(),
                    evidence.observed(),
                    diagnostic.phase(),
                    diagnostic.reason(),
                    diagnostic.method().unwrap_or("none"),
                    diagnostic.expected_path().unwrap_or("none"),
                    diagnostic.detail().map(str::len).unwrap_or(0)
                );
            } else {
                eprintln!(
                    "[startup-trace] source=provider-owner phase={phase} detail=reconcile-outcome changed={} applied={:?} observed={:?}",
                    evidence.changed(),
                    evidence.applied(),
                    evidence.observed()
                );
            }
        }
        ProviderNativeConfigurationEffect::Unavailable => eprintln!(
            "[startup-trace] source=provider-owner phase={phase} detail=reconcile-outcome unavailable=true"
        ),
    }
}

fn list_provider_accounts_for_snapshot(
    snapshot: &ArcSwap<ProviderSnapshot>,
) -> ProviderAccountsDelivery {
    let snapshot = snapshot.load_full();
    ProviderAccountsDelivery::List(
        snapshot
            .accounts
            .iter()
            .map(ProviderAccountView::from_account)
            .collect(),
    )
}

fn get_provider_account_for_snapshot(
    snapshot: &ArcSwap<ProviderSnapshot>,
    id: &ProviderAccountId,
) -> ProviderAccountsDelivery {
    let snapshot = snapshot.load_full();
    account_for_snapshot(&snapshot, id)
        .map(ProviderAccountView::from_account)
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
    let Ok(identities) = provider_runtime_identities(&snapshot.accounts) else {
        return ProviderModelSelectableOutcome::Unavailable;
    };
    ProviderModelSelectableOutcome::Available(
        snapshot
            .catalog
            .selectable_for(capability)
            .into_iter()
            .filter_map(|model| {
                let account = account_for_snapshot(&snapshot, model.account_id())?;
                let identity = identities.get(account.id().as_str())?;
                let view = model_view_for_snapshot(&snapshot, model)?;
                let model_reference =
                    identity.runtime_model_ref(account.configuration().kind(), &view.model_id);
                Some(SelectableProviderModelView {
                    model: view,
                    selection_id: model.selection_id(),
                    model_references: vec![model_reference],
                })
            })
            .collect(),
    )
}

fn list_provider_routing_for_snapshot(
    snapshot: &ArcSwap<ProviderSnapshot>,
) -> ProviderRoutingListOutcome {
    let snapshot = snapshot.load_full();
    ProviderRoutingListOutcome::Desired(
        snapshot
            .routing
            .as_ref()
            .map(ProviderRoutingView::from_routing),
    )
}

fn account_for_snapshot<'a>(
    snapshot: &'a ProviderSnapshot,
    id: &ProviderAccountId,
) -> Option<&'a ProviderAccount> {
    snapshot.accounts.iter().find(|account| account.id() == id)
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
        capabilities: model
            .capabilities()
            .iter()
            .copied()
            .map(super::models::provider_model_capability_name)
            .collect(),
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
