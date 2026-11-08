use std::sync::Arc;

use arc_swap::ArcSwap;
use foundation::execution::{CommandRoute, LaneRetention, OwnerSpec, QueryRoute};
use platform::trace::{session_trace, with_session_trace};
use serde_json::json;
use tokio::time::Instant;

use crate::{
    ProviderAccount, ProviderAccountId, ProviderCascade, ProviderModel, ProviderModelCapability,
    ProviderModelCatalog, ProviderNativeConfigurationEffect, ProviderRouting, ProviderRuntimeReport,
    Resolver,
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

pub(super) struct ProviderSnapshot {
    pub(super) accounts: Vec<ProviderAccount>,
    pub(super) catalog: ProviderModelCatalog,
    pub(super) routing: Option<ProviderRouting>,
    models: ProviderModelOwner,
    pub(super) reports: Vec<ProviderRuntimeReport>,
}

#[derive(Clone)]
pub(crate) struct ProviderShared {
    snapshot: Arc<ArcSwap<ProviderSnapshot>>,
    runtime_directory: Arc<dyn ProviderRuntimeDirectory>,
    generation_bindings: crate::adapters::generation_bindings::GenerationBindings,
}

pub struct ProviderOwnerInput {
    pub cascade: ProviderCascade,
    pub runtime_directory: Arc<dyn ProviderRuntimeDirectory>,
}

pub(crate) struct ProviderOwner {
    pub(super) cascade: ProviderCascade,
    pub(super) accounts: ProviderAccountsOwner,
    models: ProviderModelOwner,
    routing: ProviderRoutingOwner,
    pub(super) runtime_directory: Arc<dyn ProviderRuntimeDirectory>,
    pub(super) snapshot: Arc<ArcSwap<ProviderSnapshot>>,
    generation_bindings: crate::adapters::generation_bindings::GenerationBindings,
}

impl ProviderOwner {
    pub fn new(input: ProviderOwnerInput) -> Self {
        let models = ProviderModelOwner::new();
        let snapshot = Arc::new(ArcSwap::new(Arc::new(ProviderSnapshot {
            accounts: input.cascade.accounts().to_vec(),
            catalog: input.cascade.catalog().clone(),
            routing: input.cascade.routing().cloned(),
            models: models.clone(),
            reports: Vec::new(),
        })));

        Self {
            generation_bindings: crate::adapters::generation_bindings::GenerationBindings::new(
                input.cascade.generation_bindings_path(),
            ),
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
                generation_bindings: self.generation_bindings.clone(),
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
                    let outcome = self
                        .settle_account_transaction(
                            &mut call,
                            transaction.as_ref(),
                            ProviderAccountsDelivery::Rejected,
                        )
                        .await;
                    send_reply(call, reply, outcome).await;
                }
                ProviderCommand::DiscoverModels { reply, .. } => {
                    send_reply(
                        call,
                        reply,
                        crate::ProviderModelDiscoverOutcome::Unavailable,
                    )
                    .await
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
                // Before routes/ready: reconcile only this freshly reloaded canonical inventory.
                if self.cascade.reload().is_err() {
                    let _ = reply.send(Err(()));
                    return;
                }
                if resolver
                    .recover_account_credentials(self.cascade.accounts())
                    .await
                    .is_err()
                {
                    let _ = reply.send(Err(()));
                    return;
                }
                self.accounts.set_private_resolver(resolver.clone());
                self.models.set_private_resolver(resolver);
                self.update_snapshot();
                let _ = reply.send(Ok(()));
            }
            ProviderCommand::ReplaceAccount {
                draft,
                transaction,
                reply,
                ..
            } => {
                let transaction = match transaction {
                    Some(transaction) => Some(transaction),
                    None => {
                        let Ok(account_id) = draft.account_id() else {
                            send_reply(call, reply, ProviderAccountsDelivery::Rejected).await;
                            return;
                        };
                        match self
                            .accounts
                            .begin_transaction(
                                account_id,
                                draft.revision_value(),
                                "replace",
                                !matches!(draft.auth_mode(), "local" | "cliReuse"),
                            )
                            .await
                        {
                            Ok(transaction) => transaction,
                            Err(error) => {
                                if let Some(call) = &mut call {
                                    call.diagnostic(ProviderCallDiagnosticReason::PrivateTransactionSettleFailed, Some(error.safe_code()));
                                }
                                send_reply(call, reply, ProviderAccountsDelivery::Unavailable)
                                    .await;
                                return;
                            }
                        }
                    }
                };
                if !self
                    .claim_account_transaction(&mut call, transaction.as_ref())
                    .await
                {
                    let outcome = self
                        .settle_account_transaction(
                            &mut call,
                            transaction.as_ref(),
                            ProviderAccountsDelivery::Unavailable,
                        )
                        .await;
                    send_reply(call, reply, outcome).await;
                    return;
                }
                let identity_ops = self.runtime_directory.provider_runtime_identity_ops(
                    &crate::ProviderSessionEndpoint::OpenClawLocal.runtime_endpoint(),
                );
                let snapshot = &self.snapshot;
                let models = &self.models;
                let outcome = self
                    .accounts
                    .replace(
                        &mut self.cascade,
                        identity_ops,
                        draft,
                        transaction.as_ref(),
                        |cascade| publish_provider_snapshot(snapshot, cascade, models, &[]),
                    )
                    .await;
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
                let outcome = self.finish_account_mutation(outcome, &mut call).await;
                let outcome = self
                    .settle_account_transaction(&mut call, transaction.as_ref(), outcome)
                    .await;
                send_reply(call, reply, outcome).await;
            }
            ProviderCommand::DeleteAccount {
                id,
                revision,
                transaction,
                reply,
                ..
            } => {
                let transaction = match transaction {
                    Some(transaction) => Some(transaction),
                    None => {
                        match self
                            .accounts
                            .begin_transaction(id.clone(), revision.get(), "delete", false)
                            .await
                        {
                            Ok(transaction) => transaction,
                            Err(error) => {
                                if let Some(call) = &mut call {
                                    call.diagnostic(ProviderCallDiagnosticReason::PrivateTransactionSettleFailed, Some(error.safe_code()));
                                }
                                send_reply(call, reply, ProviderAccountsDelivery::Unavailable)
                                    .await;
                                return;
                            }
                        }
                    }
                };
                if !self
                    .claim_account_transaction(&mut call, transaction.as_ref())
                    .await
                {
                    let outcome = self
                        .settle_account_transaction(
                            &mut call,
                            transaction.as_ref(),
                            ProviderAccountsDelivery::Unavailable,
                        )
                        .await;
                    send_reply(call, reply, outcome).await;
                    return;
                }
                let identity_ops = self.runtime_directory.provider_runtime_identity_ops(
                    &crate::ProviderSessionEndpoint::OpenClawLocal.runtime_endpoint(),
                );
                let snapshot = &self.snapshot;
                let models = &self.models;
                let outcome = self
                    .accounts
                    .delete(
                        &mut self.cascade,
                        identity_ops,
                        id,
                        revision,
                        transaction.as_ref(),
                        |cascade| publish_provider_snapshot(snapshot, cascade, models, &[]),
                    )
                    .await;
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
                let outcome = self.finish_account_mutation(outcome, &mut call).await;
                let outcome = self
                    .settle_account_transaction(&mut call, transaction.as_ref(), outcome)
                    .await;
                send_reply(call, reply, outcome).await;
            }
            ProviderCommand::DiscoverModels {
                account_id,
                mut reservation,
                reply,
                ..
            } => {
                let mut diagnostic = None;
                let mut outcome = self
                    .models
                    .discover(
                        self.runtime_directory.as_ref(),
                        &mut self.cascade,
                        &account_id,
                        &mut diagnostic,
                    )
                    .await;
                if let (Some(call), Some(reason)) = (call.as_mut(), diagnostic) {
                    let (reason, code) = reason.diagnostic();
                    call.diagnostic(reason, code);
                }
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
                let outcome = self
                    .finish_model_mutation(outcome, returned_id, &mut call)
                    .await;
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
                let outcome = self.finish_routing_mutation(outcome, &mut call).await;
                send_reply(call, reply, outcome).await;
            }
            ProviderCommand::PreparePrivateProjection { endpoint, reply } => {
                let effect = self.prepare_private_projection(&endpoint).await;
                self.update_snapshot();
                let _ = reply.send(effect);
            }
        }
    }

    async fn claim_account_transaction(
        &mut self,
        call: &mut Option<ProviderCall>,
        transaction: Option<&ProviderAccountPrivateTransaction>,
    ) -> bool {
        let Some(transaction) = transaction else {
            return true;
        };
        if self.cascade.reload().is_err() {
            return false;
        }
        self.update_snapshot();
        let previous_reference = self
            .cascade
            .account(&transaction.account_id)
            .and_then(|account| account.configuration().credential())
            .map(crate::CredentialReference::as_str);
        let Err(error) = self
            .accounts
            .claim_transaction(transaction, previous_reference)
            .await
        else {
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

    async fn settle_account_transaction(
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
        let committed = matches!(
            &outcome,
            ProviderAccountsDelivery::Stored {
                commit: ProviderCommitOutcome::Committed,
                ..
            } | ProviderAccountsDelivery::Deleted {
                commit: ProviderCommitOutcome::Committed,
                ..
            } | ProviderAccountsDelivery::Unknown {
                commit: ProviderCommitOutcome::Committed,
                ..
            }
        );
        let Err(error) = self
            .accounts
            .settle_transaction(transaction, settlement, committed)
            .await
        else {
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
            ProviderCall::not_admitted(call).await;
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
            ProviderQuery::DiscoverModelDraft { .. }
            | ProviderQuery::TextGenerationModelLimits { .. }
            | ProviderQuery::GenerateText { .. }
            | ProviderQuery::GenerateMedia { .. }
            | ProviderQuery::ListMediaModels { .. }
            | ProviderQuery::SubmitVideo { .. }
            | ProviderQuery::QueryVideo { .. }
            | ProviderQuery::CollectVideo { .. }
            | ProviderQuery::PrepareGenerationBinding { .. }
            | ProviderQuery::RestoreGenerationBinding { .. }
            | ProviderQuery::CountBoundInput { .. }
            | ProviderQuery::GenerateBound { .. } => {
                unreachable!("text generation queries use the direct route")
            }
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
        }
    }

    pub(super) fn update_snapshot(&self) {
        self.publish_reports(&[]);
    }

    pub(super) fn publish_reports(&self, reports: &[ProviderRuntimeReport]) {
        publish_provider_snapshot(&self.snapshot, &self.cascade, &self.models, reports);
    }

    async fn finish_account_mutation(
        &mut self,
        mutation: ProviderAccountsMutation,
        call: &mut Option<ProviderCall>,
    ) -> ProviderAccountsDelivery {
        let native = if mutation.commit == ProviderCommitOutcome::Committed {
            let failures = mutation.private.as_ref().err()
                .and_then(|error| mutation.account.as_ref().or_else(|| mutation.retired.first())
                    .map(|account| error.account_execution(account)))
                .into_iter()
                .collect();
            let mut native = self
                .reconcile(
                    &mutation.retired,
                    mutation.required_auth_accounts(),
                    mutation.auth_state_refresh_required,
                    failures,
                    call,
                )
                .await;
            if mutation.private.is_err() {
                native = native.merge(ProviderNativeConfigurationEffect::Unavailable);
            }
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
        call: &mut Option<ProviderCall>,
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
        let native = self.reconcile(&[], &required, false, Vec::new(), call).await;
        crate::ProviderModelReplaceOutcome::DesiredStored {
            persisted,
            native: ProviderNativeConfigurationView::from_effect(&native),
            commit,
        }
    }

    async fn finish_routing_mutation(
        &mut self,
        outcome: crate::ProviderRoutingReplaceOutcome,
        call: &mut Option<ProviderCall>,
    ) -> crate::ProviderRoutingReplaceOutcome {
        let crate::ProviderRoutingReplaceOutcome::DesiredStored {
            persisted, commit, ..
        } = outcome
        else {
            return outcome;
        };
        let required = self.routing.route_account_ids(&self.cascade);
        let native = self.reconcile(&[], &required, false, Vec::new(), call).await;
        crate::ProviderRoutingReplaceOutcome::DesiredStored {
            persisted,
            native: ProviderNativeConfigurationView::from_effect(&native),
            commit,
        }
    }

}

fn publish_provider_snapshot(
    snapshot: &ArcSwap<ProviderSnapshot>,
    cascade: &ProviderCascade,
    models: &ProviderModelOwner,
    reports: &[ProviderRuntimeReport],
) {
    let previous = snapshot.load_full();
    let reports = super::reconciliation::current_reports(&previous, cascade, reports);
    snapshot.store(Arc::new(ProviderSnapshot {
        accounts: cascade.accounts().to_vec(),
        catalog: cascade.catalog().clone(),
        routing: cascade.routing().cloned(),
        models: models.clone(),
        reports,
    }));
}

async fn handle_provider_snapshot_query(shared: &ProviderShared, mut query: ProviderQuery) {
    let mut call = query.take_call();
    let started = match &query {
        ProviderQuery::GenerateText { diagnostic_trace, .. } => {
            with_session_trace(diagnostic_trace.clone(), async {
                ProviderCall::start(&mut call).await.map_err(|_| {
                    session_trace("provider-generation.call-start-failed", || json!({
                        "providerCallHash": call.as_ref().map(|call| platform::trace::identifier_hash(call.id().as_str())),
                    }));
                })
            }).await
        }
        _ => ProviderCall::start(&mut call).await,
    };
    if started.is_err() {
        ProviderCall::not_admitted(call).await;
        if let ProviderQuery::GenerateBound { reply, .. } = query {
            let _ = reply.send(Err(crate::generation::Failure::new(
                crate::generation::Stage::Admission,
                crate::generation::FailureKind::AuditUnavailable,
            )));
        }
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
        ProviderQuery::DiscoverModelDraft { request, cancellation, reply } => {
            let snapshot = shared.snapshot.load_full();
            let outcome = snapshot.models.discover_draft(
                shared.runtime_directory.as_ref(), &snapshot.accounts, request, cancellation,
            ).await;
            let _ = reply.send(outcome);
        }
        ProviderQuery::GenerateMedia {
            request,
            cancellation,
            reply,
        } => {
            let snapshot = shared.snapshot.load_full();
            let outcome = crate::media::generate(
                snapshot.models.media_client.as_ref(),
                &snapshot.models.private_resolver,
                &snapshot.accounts,
                &snapshot.catalog,
                snapshot.routing.as_ref(),
                request,
                cancellation,
            )
            .await;
            let _ = reply.send(outcome);
        }
        ProviderQuery::ListMediaModels { request, reply } => {
            let snapshot = shared.snapshot.load_full();
            let outcome = crate::media::list(
                &snapshot.accounts,
                &snapshot.catalog,
                snapshot.routing.as_ref(),
                request,
            );
            let _ = reply.send(outcome);
        }
        ProviderQuery::SubmitVideo {
            request,
            cancellation,
            reply,
        } => {
            let snapshot = shared.snapshot.load_full();
            let outcome = crate::media::submit_video(
                snapshot.models.media_client.as_ref(),
                &snapshot.models.private_resolver,
                &snapshot.accounts,
                &snapshot.catalog,
                snapshot.routing.as_ref(),
                request,
                cancellation,
            )
            .await;
            let _ = reply.send(outcome);
        }
        ProviderQuery::QueryVideo {
            request,
            cancellation,
            reply,
        } => {
            let snapshot = shared.snapshot.load_full();
            let outcome = crate::media::query_video(
                snapshot.models.media_client.as_ref(),
                &snapshot.models.private_resolver,
                &snapshot.accounts,
                &snapshot.catalog,
                request,
                cancellation,
            )
            .await;
            let _ = reply.send(outcome);
        }
        ProviderQuery::CollectVideo {
            request,
            cancellation,
            reply,
        } => {
            let snapshot = shared.snapshot.load_full();
            let outcome = crate::media::collect_video(
                snapshot.models.media_client.as_ref(),
                &snapshot.models.private_resolver,
                &snapshot.accounts,
                &snapshot.catalog,
                request,
                cancellation,
            )
            .await;
            let _ = reply.send(outcome);
        }
        ProviderQuery::PrepareGenerationBinding { request, reply } => {
            let snapshot = shared.snapshot.load_full();
            let outcome = snapshot.models.prepare_generation_binding(
                shared.runtime_directory.as_ref(),
                &snapshot.accounts,
                &snapshot.catalog,
                snapshot.routing.as_ref(),
                &shared.generation_bindings,
                request,
            );
            let _ = reply.send(outcome);
        }
        ProviderQuery::RestoreGenerationBinding { descriptor, reply } => {
            let snapshot = shared.snapshot.load_full();
            let outcome = snapshot.models.restore_generation_binding(
                &snapshot.accounts,
                &snapshot.catalog,
                &shared.generation_bindings,
                descriptor,
            );
            let _ = reply.send(outcome);
        }
        ProviderQuery::CountBoundInput {
            request,
            cancellation,
            reply,
        } => {
            let snapshot = shared.snapshot.load_full();
            let outcome = snapshot
                .models
                .count_bound_input(&snapshot.accounts, &snapshot.catalog, request, cancellation)
                .await;
            let _ = reply.send(outcome);
        }
        ProviderQuery::GenerateBound {
            request,
            cancellation,
            stream,
            reply,
            ..
        } => {
            let snapshot = shared.snapshot.load_full();
            let call_reference = call.as_ref().map(|call| call.id().as_str().to_owned());
            let mut stream = stream.map(crate::api::ProviderStreamSink);
            let outcome = snapshot
                .models
                .generate_bound(
                    &snapshot.accounts,
                    &snapshot.catalog,
                    request,
                    cancellation,
                    call_reference,
                    stream
                        .as_mut()
                        .map(|sink| sink as &mut dyn crate::llm_client::LlmStreamSink),
                )
                .await;
            drop(stream);
            send_reply(call, reply, outcome).await;
        }
        ProviderQuery::TextGenerationModelLimits { request, reply, .. } => {
            let snapshot = shared.snapshot.load_full();
            let outcome = snapshot.models.text_generation_model_limits(
                shared.runtime_directory.as_ref(),
                &snapshot.accounts,
                &snapshot.catalog,
                snapshot.routing.as_ref(),
                request,
            );
            send_reply(call, reply, outcome).await;
        }
        ProviderQuery::GenerateText {
            request,
            selection_id,
            cancellation,
            diagnostic_trace,
            stream,
            reply,
            ..
        } => {
            with_session_trace(diagnostic_trace, async {
                let started = platform::trace::enabled().then(Instant::now);
                let provider_call_hash = platform::trace::enabled().then(|| call.as_ref().map(|call| platform::trace::identifier_hash(call.id().as_str()))).flatten();
                session_trace("provider-generation.direct-started", || json!({
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
                        selection_id.as_deref(),
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
                        let reason = crate::ProviderTextGenerationUnavailableReason::from(&error);
                        if let Some(stream) = &stream {
                            let _ = stream
                                .0
                                .send(crate::api::ProviderStreamMessage::Failed(error))
                                .await;
                        }
                        crate::ProviderTextGenerationOutcome::Unavailable { reason }
                    }
                };
                session_trace("provider-generation.direct-completed", || json!({
                    "providerCallHash": provider_call_hash,
                    "category": match &outcome {
                        crate::ProviderTextGenerationOutcome::Generated { .. } => "Generated",
                        crate::ProviderTextGenerationOutcome::Rejected => "Rejected",
                        crate::ProviderTextGenerationOutcome::Unavailable { .. } => "Unavailable",
                        crate::ProviderTextGenerationOutcome::Cancelled => "Cancelled",
                    },
                    "elapsedMs": started.map(|started| started.elapsed().as_millis() as u64),
                }));
                drop(stream);
                send_reply(call, reply, outcome).await;
            }).await;
        }
        ProviderQuery::SelectSessionModel { reply, .. }
        | ProviderQuery::SelectMatchaSessionModelRuntime { reply, .. } => {
            send_reply(
                call,
                reply,
                crate::ProviderSessionModelSelectionOutcome::Unavailable,
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
            } else if platform::trace::enabled() {
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
    ProviderAccountsDelivery::List {
        accounts: snapshot
            .accounts
            .iter()
            .map(ProviderAccountView::from_account)
            .collect(),
        reports: snapshot.reports.clone(),
    }
}

fn get_provider_account_for_snapshot(
    snapshot: &ArcSwap<ProviderSnapshot>,
    id: &ProviderAccountId,
) -> ProviderAccountsDelivery {
    let snapshot = snapshot.load_full();
    account_for_snapshot(&snapshot, id)
        .map(ProviderAccountView::from_account)
        .map(|account| ProviderAccountsDelivery::Account {
            account,
            reports: snapshot.reports.clone(),
        })
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
    let Some(identity_ops) = runtime.provider_runtime_identity_ops(
        &crate::ProviderSessionEndpoint::OpenClawLocal.runtime_endpoint(),
    ) else {
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
