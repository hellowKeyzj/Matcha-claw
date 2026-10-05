use std::{collections::BTreeSet, sync::Arc, time::Duration};

use arc_swap::ArcSwap;
use foundation::execution::{CommandRoute, LaneRetention, OwnerSpec, QueryRoute};
use tokio::time::{Instant, timeout_at};
use platform::trace::{session_trace, with_session_trace};
use serde_json::json;

use crate::{
    ProviderAccount, ProviderAccountId, ProviderCascade, ProviderModel, ProviderModelCapability,
    ProviderModelCatalog, ProviderNativeConfigurationEffect, ProviderPrivateProjectionCommand,
    ProviderPrivateProjectionEffect, ProviderRouting, Resolver,
    api::{ProviderAccountPrivateTransaction, ProviderCommand, ProviderQuery},
    application::receipts::{
        ProviderAccountView, ProviderAccountsDelivery, ProviderCommitOutcome,
        ProviderModelListOutcome, ProviderModelSelectableOutcome, ProviderModelView,
        ProviderNativeConfigurationView, ProviderRoutingListOutcome, ProviderRoutingView,
        SelectableProviderModelView,
    },
    call::{ProviderCall, ProviderCallDiagnosticReason, send_reply},
    ports::ProviderRuntimeDirectory,
};

use super::{
    accounts::{ProviderAccountsDesiredOutcome, ProviderAccountsMutation, ProviderAccountsOwner},
    models::ProviderModelOwner,
    routing::ProviderRoutingOwner,
};

struct ProviderSnapshot {
    accounts: Vec<ProviderAccount>,
    catalog: ProviderModelCatalog,
    routing: Option<ProviderRouting>,
    models: ProviderModelOwner,
}

#[derive(Clone)]
pub(crate) struct ProviderShared {
    snapshot: Arc<ArcSwap<ProviderSnapshot>>,
    runtime_directory: Arc<dyn ProviderRuntimeDirectory>,
}

pub struct ProviderOwnerInput {
    pub cascade: ProviderCascade,
    pub runtime_directory: Arc<dyn ProviderRuntimeDirectory>,
}

pub(crate) struct ProviderOwner {
    cascade: ProviderCascade,
    accounts: ProviderAccountsOwner,
    models: ProviderModelOwner,
    routing: ProviderRoutingOwner,
    runtime_directory: Arc<dyn ProviderRuntimeDirectory>,
    snapshot: Arc<ArcSwap<ProviderSnapshot>>,
}

impl ProviderOwner {
    pub fn new(input: ProviderOwnerInput) -> Self {
        let models = ProviderModelOwner::new();
        let snapshot = Arc::new(ArcSwap::new(Arc::new(ProviderSnapshot {
            accounts: input.cascade.accounts().to_vec(),
            catalog: input.cascade.catalog().clone(),
            routing: input.cascade.routing().cloned(),
            models: models.clone(),
        })));

        Self {
            cascade: input.cascade,
            accounts: ProviderAccountsOwner::new(Resolver::disabled()),
            models,
            routing: ProviderRoutingOwner::new(),
            runtime_directory: input.runtime_directory,
            snapshot,
        }
    }

    pub const fn lane_retention() -> LaneRetention {
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
                runtime_directory: Arc::clone(&self.runtime_directory),
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
        handle_provider_snapshot_query(&shared, query).await;
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
    async fn handle_provider_command(&mut self, mut command: ProviderCommand) {
        let mut call = command.take_call();
        if ProviderCall::start(&mut call).await.is_err() {
            match command {
                ProviderCommand::ReplaceAccount {
                    transaction, reply, ..
                }
                | ProviderCommand::DeleteAccount {
                    transaction, reply, ..
                } => {
                    let outcome = self.settle_account_transaction(
                        &mut call,
                        transaction.as_ref(),
                        ProviderAccountsDelivery::Rejected,
                    );
                    send_reply(call, reply, outcome).await;
                }
                ProviderCommand::DiscoverModels { reply, .. } => {
                    send_reply(call, reply, crate::ProviderModelDiscoverOutcome::Unavailable).await
                }
                ProviderCommand::ReplaceModels { reply, .. } => {
                    send_reply(call, reply, crate::ProviderModelReplaceOutcome::Unavailable).await
                }
                ProviderCommand::ReplaceRouting { reply, .. } => {
                    send_reply(
                        call,
                        reply,
                        crate::ProviderRoutingReplaceOutcome::Unavailable,
                    )
                    .await
                }
                _ => {}
            }
            return;
        }
        match command {
            ProviderCommand::ConfigurePrivateResolver { resolver, reply } => {
                self.accounts.set_private_resolver(resolver.clone());
                self.models.set_private_resolver(resolver);
                self.update_snapshot();
                let _ = reply.send(());
            }
            ProviderCommand::ReplaceAccount {
                draft,
                transaction,
                reply,
                ..
            } => {
                if !self.claim_account_transaction(&mut call, transaction.as_ref()) {
                    send_reply(call, reply, ProviderAccountsDelivery::Unavailable).await;
                    return;
                }
                let Some(identity_ops) = self.runtime_directory.provider_runtime_identity_ops()
                else {
                    let outcome = self.settle_account_transaction(
                        &mut call,
                        transaction.as_ref(),
                        ProviderAccountsDelivery::Unavailable,
                    );
                    send_reply(call, reply, outcome).await;
                    return;
                };
                let outcome = self
                    .accounts
                    .replace(&mut self.cascade, identity_ops, draft);
                self.update_snapshot();
                if matches!(
                    outcome.desired,
                    ProviderAccountsDesiredOutcome::Stored
                        | ProviderAccountsDesiredOutcome::Deleted
                        | ProviderAccountsDesiredOutcome::Unknown
                ) {
                    ProviderCall::persisted(&mut call, outcome.persisted, outcome.commit).await;
                }
                self.record_private_profile_error(&mut call, &outcome);
                let outcome = self.finish_account_mutation(outcome).await;
                let outcome =
                    self.settle_account_transaction(&mut call, transaction.as_ref(), outcome);
                send_reply(call, reply, outcome).await;
            }
            ProviderCommand::DeleteAccount {
                id,
                revision,
                transaction,
                reply,
                ..
            } => {
                if !self.claim_account_transaction(&mut call, transaction.as_ref()) {
                    send_reply(call, reply, ProviderAccountsDelivery::Unavailable).await;
                    return;
                }
                let Some(identity_ops) = self.runtime_directory.provider_runtime_identity_ops()
                else {
                    let outcome = self.settle_account_transaction(
                        &mut call,
                        transaction.as_ref(),
                        ProviderAccountsDelivery::Unavailable,
                    );
                    send_reply(call, reply, outcome).await;
                    return;
                };
                let outcome = self
                    .accounts
                    .delete(&mut self.cascade, identity_ops, id, revision);
                self.update_snapshot();
                if matches!(
                    outcome.desired,
                    ProviderAccountsDesiredOutcome::Stored
                        | ProviderAccountsDesiredOutcome::Deleted
                        | ProviderAccountsDesiredOutcome::Unknown
                ) {
                    ProviderCall::persisted(&mut call, outcome.persisted, outcome.commit).await;
                }
                self.record_private_profile_error(&mut call, &outcome);
                let outcome = self.finish_account_mutation(outcome).await;
                let outcome =
                    self.settle_account_transaction(&mut call, transaction.as_ref(), outcome);
                send_reply(call, reply, outcome).await;
            }
            ProviderCommand::DiscoverModels {
                account_id,
                mut reservation,
                reply,
                ..
            } => {
                let mut outcome = self
                    .models
                    .discover(self.runtime_directory.as_ref(), &mut self.cascade, &account_id)
                    .await;
                if let crate::ProviderModelDiscoverOutcome::Discovered(models) = &outcome {
                    if reservation.complete(models.clone()).is_err() {
                        outcome = crate::ProviderModelDiscoverOutcome::Unavailable;
                    }
                }
                drop(reservation);
                send_reply(call, reply, outcome).await;
            }
            ProviderCommand::ReplaceModels {
                account_id,
                drafts,
                reply,
                ..
            } => {
                let account_id_str = account_id.as_ref().map(|id| id.as_str().to_string());
                let (outcome, returned_id) = account_id_str
                    .map(|id_str| {
                        self.models.replace_for_account(
                            self.runtime_directory.as_ref(),
                            &mut self.cascade,
                            id_str,
                            drafts,
                        )
                    })
                    .unwrap_or((crate::ProviderModelReplaceOutcome::Rejected, None));
                self.update_snapshot();
                if let crate::ProviderModelReplaceOutcome::DesiredStored {
                    persisted, commit, ..
                } = &outcome
                {
                    ProviderCall::persisted(&mut call, *persisted, *commit).await;
                }
                let outcome = self.finish_model_mutation(outcome, returned_id).await;
                send_reply(call, reply, outcome).await;
            }
            ProviderCommand::ReplaceRouting { routing, reply, .. } => {
                let outcome = self.routing.replace(&mut self.cascade, routing);
                self.update_snapshot();
                if let crate::ProviderRoutingReplaceOutcome::DesiredStored {
                    persisted,
                    commit,
                    ..
                } = &outcome
                {
                    ProviderCall::persisted(&mut call, *persisted, *commit).await;
                }
                let outcome = self.finish_routing_mutation(outcome).await;
                send_reply(call, reply, outcome).await;
            }
            ProviderCommand::PreparePrivateProjection { reply } => {
                let effect = self.prepare_private_projection();
                self.update_snapshot();
                let _ = reply.send(effect);
            }
        }
    }

    fn claim_account_transaction(
        &self,
        call: &mut Option<ProviderCall>,
        transaction: Option<&ProviderAccountPrivateTransaction>,
    ) -> bool {
        let Some(transaction) = transaction else {
            return true;
        };
        let Err(error) = self.accounts.claim_transaction(transaction) else {
            return true;
        };
        if let Some(call) = call {
            call.diagnostic(
                ProviderCallDiagnosticReason::PrivateTransactionSettleFailed,
                Some(error.safe_code()),
            );
        }
        false
    }

    fn settle_account_transaction(
        &self,
        call: &mut Option<ProviderCall>,
        transaction: Option<&ProviderAccountPrivateTransaction>,
        outcome: ProviderAccountsDelivery,
    ) -> ProviderAccountsDelivery {
        let Some(transaction) = transaction else {
            return outcome;
        };
        let settlement = match &outcome {
            ProviderAccountsDelivery::Stored { .. } | ProviderAccountsDelivery::Deleted { .. } => {
                "retained"
            }
            ProviderAccountsDelivery::Unknown { .. } => "unknown",
            _ => "rejected",
        };
        let Err(error) = self.accounts.settle_transaction(transaction, settlement) else {
            return outcome;
        };
        if let Some(call) = call {
            call.diagnostic(
                ProviderCallDiagnosticReason::PrivateTransactionSettleFailed,
                Some(error.safe_code()),
            );
        }
        // Desired facts already committed remain committed; private confirmation is unknown.
        outcome
    }

    fn record_private_profile_error(
        &self,
        call: &mut Option<ProviderCall>,
        outcome: &ProviderAccountsMutation,
    ) {
        if let (Some(call), Err(error)) = (call.as_mut(), &outcome.private) {
            let (reason, code) = error.diagnostic();
            call.diagnostic(reason, code);
        }
    }

    async fn handle_provider_query(&mut self, mut query: ProviderQuery) {
        let mut call = query.take_call();
        if ProviderCall::start(&mut call).await.is_err() {
            return;
        }
        match query {
            ProviderQuery::ListAccounts { reply, .. } => {
                send_reply(
                    call,
                    reply,
                    list_provider_accounts_for_snapshot(&self.snapshot),
                )
                .await;
            }
            ProviderQuery::GetAccount { id, reply, .. } => {
                send_reply(
                    call,
                    reply,
                    get_provider_account_for_snapshot(&self.snapshot, &id),
                )
                .await;
            }
            ProviderQuery::ListModels { reply, .. } => {
                send_reply(
                    call,
                    reply,
                    list_provider_models_for_snapshot(&self.snapshot),
                )
                .await;
            }
            ProviderQuery::SelectableModels {
                capability, reply, ..
            } => {
                send_reply(
                    call,
                    reply,
                    selectable_provider_models_for_snapshot(
                        &self.snapshot,
                        self.runtime_directory.as_ref(),
                        capability,
                    ),
                )
                .await;
            }
            ProviderQuery::ListRouting { reply, .. } => {
                send_reply(
                    call,
                    reply,
                    list_provider_routing_for_snapshot(&self.snapshot),
                )
                .await;
            }
            ProviderQuery::TextGenerationModelLimits { request, reply, .. } => {
                let outcome = self.models.text_generation_model_limits(
                    self.runtime_directory.as_ref(),
                    &self.cascade,
                    request,
                );
                send_reply(call, reply, outcome).await;
            }
            ProviderQuery::GenerateText { .. } => unreachable!("generation uses the direct route"),
            ProviderQuery::SelectSessionModel {
                endpoint,
                session_key,
                endpoint_session_id,
                model_selection_id,
                trace_id,
                reply,
                ..
            } => {
                let outcome = self.models.select_session_model(
                    self.runtime_directory.as_ref(),
                    &self.cascade,
                    endpoint,
                    session_key,
                    endpoint_session_id,
                    model_selection_id,
                    trace_id,
                );
                send_reply(call, reply, outcome).await;
            }
            ProviderQuery::SelectMatchaSessionModelRuntime {
                session_key,
                endpoint_session_id,
                model_id,
                model_selection_id,
                provider_fingerprint,
                trace_id,
                reply,
                ..
            } => {
                let outcome = self.models.select_matcha_session_model_runtime(
                    self.runtime_directory.as_ref(),
                    &self.cascade,
                    session_key,
                    endpoint_session_id,
                    model_id,
                    model_selection_id,
                    provider_fingerprint,
                    trace_id,
                );
                send_reply(call, reply, outcome).await;
            }
            ProviderQuery::AcceptSessionRuntimeModels {
                endpoint,
                model_refs,
                reply,
                ..
            } => {
                let outcome = self.models.accept_runtime_model_refs(
                    self.runtime_directory.as_ref(),
                    &self.cascade,
                    endpoint,
                    &model_refs,
                );
                send_reply(call, reply, outcome).await;
            }
            ProviderQuery::SelectSessionModelRebound {
                endpoint,
                session_key,
                endpoint_session_id,
                current_model,
                default_model,
                trace_id,
                reply,
                ..
            } => {
                let outcome = self.models.select_session_model_rebound(
                    self.runtime_directory.as_ref(),
                    &self.cascade,
                    endpoint,
                    session_key,
                    endpoint_session_id,
                    current_model,
                    default_model,
                    trace_id,
                );
                send_reply(call, reply, outcome).await;
            }
        }
    }

    fn update_snapshot(&self) {
        let new_snapshot = ProviderSnapshot {
            accounts: self.cascade.accounts().to_vec(),
            catalog: self.cascade.catalog().clone(),
            routing: self.cascade.routing().cloned(),
            models: self.models.clone(),
        };
        self.snapshot.store(Arc::new(new_snapshot));
    }

    async fn finish_account_mutation(
        &mut self,
        mutation: ProviderAccountsMutation,
    ) -> ProviderAccountsDelivery {
        let native = if mutation.private.is_err() {
            ProviderNativeConfigurationEffect::Unavailable
        } else if mutation.commit == ProviderCommitOutcome::Committed {
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
        outcome: crate::ProviderModelReplaceOutcome,
        account_id: Option<ProviderAccountId>,
    ) -> crate::ProviderModelReplaceOutcome {
        let crate::ProviderModelReplaceOutcome::DesiredStored {
            persisted, commit, ..
        } = outcome
        else {
            return outcome;
        };
        let Some(account_id) = account_id else {
            return outcome;
        };
        let mut required = self.routing.route_account_ids(&self.cascade);
        required.insert(account_id);
        let native = self.reconcile(&[], &required, false).await;
        crate::ProviderModelReplaceOutcome::DesiredStored {
            persisted,
            native: ProviderNativeConfigurationView::from_effect(&native),
            commit,
        }
    }

    async fn finish_routing_mutation(
        &mut self,
        outcome: crate::ProviderRoutingReplaceOutcome,
    ) -> crate::ProviderRoutingReplaceOutcome {
        let crate::ProviderRoutingReplaceOutcome::DesiredStored {
            persisted, commit, ..
        } = outcome
        else {
            return outcome;
        };
        let required = self.routing.route_account_ids(&self.cascade);
        let native = self.reconcile(&[], &required, false).await;
        crate::ProviderRoutingReplaceOutcome::DesiredStored {
            persisted,
            native: ProviderNativeConfigurationView::from_effect(&native),
            commit,
        }
    }

    fn prepare_private_projection(&mut self) -> ProviderPrivateProjectionEffect {
        if self.cascade.reload().is_err() {
            return ProviderPrivateProjectionEffect::unknown(
                "provider-cascade-unavailable",
                "Provider cascade is unavailable",
            );
        }
        let Some(private_projection) = self.runtime_directory.provider_private_projection_ops()
        else {
            return ProviderPrivateProjectionEffect::unknown(
                "provider-private-projection-unavailable",
                "Provider private projection is unavailable",
            );
        };
        private_projection.prepare_private_projection(ProviderPrivateProjectionCommand {
            accounts: self.cascade.accounts(),
            models: self.cascade.catalog(),
            routing: self.cascade.routing(),
            now_millis: now_millis(),
        })
    }

    async fn reconcile(
        &mut self,
        retired: &[ProviderAccount],
        required_auth_accounts: &BTreeSet<ProviderAccountId>,
        auth_state_refresh_required: bool,
    ) -> ProviderNativeConfigurationEffect {
        let deadline = Instant::now() + Duration::from_secs(30);
        let effect = timeout_at(
            deadline,
            self.reconcile_until(
                retired,
                required_auth_accounts,
                auth_state_refresh_required,
                deadline,
            ),
        )
        .await;
        // Synchronous resolver/native file work cannot be preempted by timeout_at.
        match effect {
            Ok(effect) if Instant::now() < deadline => effect,
            _ => {
                eprintln!(
                    "[startup-trace] source=provider-owner phase=reconcile detail=budget-exhausted budget_ms=30000"
                );
                ProviderNativeConfigurationEffect::Unavailable
            }
        }
    }

    async fn reconcile_until(
        &mut self,
        retired: &[ProviderAccount],
        required_auth_accounts: &BTreeSet<ProviderAccountId>,
        auth_state_refresh_required: bool,
        deadline: Instant,
    ) -> ProviderNativeConfigurationEffect {
        if self.cascade.reload().is_err() || Instant::now() >= deadline {
            return ProviderNativeConfigurationEffect::Unavailable;
        }
        let Some(identity_ops) = self.runtime_directory.provider_runtime_identity_ops() else {
            return ProviderNativeConfigurationEffect::Unavailable;
        };
        let accounts = self.cascade.accounts().to_vec();
        let catalog = self.cascade.catalog().clone();
        let routing = self.cascade.routing().cloned();
        let auth_state_refresh_required =
            match self.accounts.apply_private_profiles_for_provider_config(
                identity_ops,
                &accounts,
                required_auth_accounts,
                deadline,
            ) {
                Ok(applied) => auth_state_refresh_required || applied,
                Err(_) => return ProviderNativeConfigurationEffect::Unavailable,
            };

        let now_millis = now_millis();
        let mut effects = Vec::new();
        for provider_ops in self.runtime_directory.provider_config_ops() {
            if Instant::now() >= deadline {
                return ProviderNativeConfigurationEffect::Unavailable;
            }
            let command = crate::ProviderNativeConfigurationCommand {
                accounts: &accounts,
                models: &catalog,
                routing: routing.as_ref(),
                retired,
                required_auth_accounts,
                auth_state_refresh_required,
                now_millis,
            };
            effects.push(
                provider_ops
                    .reconcile_provider_native_configuration(command)
                    .await,
            );
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

async fn handle_provider_snapshot_query(shared: &ProviderShared, mut query: ProviderQuery) {
    let mut call = query.take_call();
    let started = match &query {
        ProviderQuery::GenerateText { diagnostic_trace, .. } => {
            with_session_trace(diagnostic_trace.clone(), async {
                ProviderCall::start(&mut call).await.map_err(|_| {
                    session_trace("provider-generation.call-start-failed", json!({
                        "providerCallHash": call.as_ref().map(|call| platform::trace::identifier_hash(call.id().as_str())),
                    }));
                })
            }).await
        }
        _ => ProviderCall::start(&mut call).await,
    };
    if started.is_err() {
        return;
    }
    match query {
        ProviderQuery::ListAccounts { reply, .. } => {
            send_reply(
                call,
                reply,
                list_provider_accounts_for_snapshot(&shared.snapshot),
            )
            .await;
        }
        ProviderQuery::GetAccount { id, reply, .. } => {
            send_reply(
                call,
                reply,
                get_provider_account_for_snapshot(&shared.snapshot, &id),
            )
            .await;
        }
        ProviderQuery::ListModels { reply, .. } => {
            send_reply(
                call,
                reply,
                list_provider_models_for_snapshot(&shared.snapshot),
            )
            .await;
        }
        ProviderQuery::SelectableModels {
            capability, reply, ..
        } => {
            send_reply(
                call,
                reply,
                selectable_provider_models_for_snapshot(
                    &shared.snapshot,
                    shared.runtime_directory.as_ref(),
                    capability,
                ),
            )
            .await;
        }
        ProviderQuery::ListRouting { reply, .. } => {
            send_reply(
                call,
                reply,
                list_provider_routing_for_snapshot(&shared.snapshot),
            )
            .await;
        }
        ProviderQuery::TextGenerationModelLimits { reply, .. } => {
            send_reply(
                call,
                reply,
                crate::ProviderTextGenerationModelLimitsOutcome::Rejected,
            )
            .await;
        }
        ProviderQuery::GenerateText {
            request,
            cancellation,
            diagnostic_trace,
            stream,
            reply,
            ..
        } => {
            with_session_trace(diagnostic_trace, async {
                let started = Instant::now();
                let provider_call_hash = call.as_ref().map(|call| platform::trace::identifier_hash(call.id().as_str()));
                session_trace("provider-generation.direct-started", json!({
                    "providerCallHash": provider_call_hash, "streaming": stream.is_some(),
                }));
                let snapshot = shared.snapshot.load_full();
                let mut stream = stream.map(crate::api::ProviderStreamSink);
                let outcome = snapshot
                    .models
                    .generate_text(
                        shared.runtime_directory.as_ref(),
                        &snapshot.accounts,
                        &snapshot.catalog,
                        snapshot.routing.as_ref(),
                        request,
                        cancellation,
                        provider_call_hash.as_deref(),
                        stream
                            .as_mut()
                            .map(|sink| sink as &mut dyn crate::llm_client::LlmStreamSink),
                    )
                    .await;
                let outcome = match outcome {
                    Ok(outcome) => outcome,
                    Err(error) => {
                        if let Some(stream) = &stream {
                            let _ = stream
                                .0
                                .send(crate::api::ProviderStreamMessage::Failed(error))
                                .await;
                        }
                        crate::ProviderTextGenerationOutcome::Unavailable
                    }
                };
                session_trace("provider-generation.direct-completed", json!({
                    "providerCallHash": provider_call_hash,
                    "category": match &outcome {
                        crate::ProviderTextGenerationOutcome::Generated { .. } => "Generated",
                        crate::ProviderTextGenerationOutcome::Rejected => "Rejected",
                        crate::ProviderTextGenerationOutcome::Unavailable => "Unavailable",
                        crate::ProviderTextGenerationOutcome::Cancelled => "Cancelled",
                    },
                    "elapsedMs": started.elapsed().as_millis() as u64,
                }));
                drop(stream);
                send_reply(call, reply, outcome).await;
            }).await;
        }
        ProviderQuery::SelectSessionModel { reply, .. }
        | ProviderQuery::SelectMatchaSessionModelRuntime { reply, .. }
        | ProviderQuery::SelectSessionModelRebound { reply, .. } => {
            send_reply(
                call,
                reply,
                crate::ProviderSessionModelSelectionOutcome::Unavailable,
            )
            .await;
        }
        ProviderQuery::AcceptSessionRuntimeModels { reply, .. } => {
            send_reply(
                call,
                reply,
                crate::ProviderSessionRuntimeModelsOutcome::Unavailable,
            )
            .await;
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
    runtime: &dyn ProviderRuntimeDirectory,
    capability: ProviderModelCapability,
) -> ProviderModelSelectableOutcome {
    let snapshot = snapshot.load_full();
    let Some(identity_ops) = runtime.provider_runtime_identity_ops() else {
        return ProviderModelSelectableOutcome::Unavailable;
    };
    let Ok(identities) = identity_ops.runtime_identities(&snapshot.accounts) else {
        return ProviderModelSelectableOutcome::Unavailable;
    };
    ProviderModelSelectableOutcome::Available(
        snapshot
            .catalog
            .selectable_for(capability)
            .into_iter()
            .filter_map(|model| {
                let account = account_for_snapshot(&snapshot, model.account_id())?;
                let identity = identities
                    .iter()
                    .find(|identity| identity.account_id() == account.id().as_str())?;
                let view = model_view_for_snapshot(&snapshot, model)?;
                let model_reference = identity_ops.runtime_model_ref(
                    identity,
                    account.configuration().kind(),
                    &view.model_id,
                );
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
    Some(ProviderModelView::from_model(account, model))
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| u64::try_from(d.as_millis()).ok())
        .unwrap_or(u64::MAX)
}
