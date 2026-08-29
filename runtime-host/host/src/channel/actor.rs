use std::sync::Arc;

use foundation::execution::{LaneRetention, OwnerSpec};
use tokio_util::sync::CancellationToken;
use zeroize::{Zeroize, Zeroizing};

use crate::runtime_directory::RuntimeDriverDirectory;

use super::{
    catalog::ChannelConfigureOutcome,
    command::{ChannelCommand, ChannelOwnerUnavailable, ChannelQuery},
    login::{LoginProgressStatus, Outcome as ChannelLoginOutcome},
    operations::{ChannelKey, ChannelMutation, ChannelMutationEffect, LoginFinalizationOutcome},
};

#[derive(Clone)]
pub(crate) struct ChannelShared {
    runtime_directory: Arc<RuntimeDriverDirectory>,
}

pub(crate) struct ChannelOwner {
    shared: ChannelShared,
}

pub(crate) struct ChannelOwnerInput {
    pub(crate) runtime_directory: Arc<RuntimeDriverDirectory>,
}

pub(crate) struct ChannelGlobalState;
pub(crate) struct ChannelLaneState {
    pending_login_configs: Vec<PendingLoginConfig>,
}

struct PendingLoginConfig {
    key: ChannelKey,
    config: Zeroizing<Vec<u8>>,
}

impl ChannelOwner {
    pub(crate) fn new(input: ChannelOwnerInput) -> Self {
        Self {
            shared: ChannelShared {
                runtime_directory: input.runtime_directory,
            },
        }
    }

    pub(crate) fn lane_retention() -> LaneRetention {
        LaneRetention::MediumFrequency
    }
}

impl OwnerSpec for ChannelOwner {
    type Command = ChannelCommand;
    type Query = ChannelQuery;
    type Key = ChannelKey;
    type Shared = ChannelShared;
    type GlobalState = ChannelGlobalState;
    type LaneState = ChannelLaneState;

    fn split(self) -> (Self::Shared, Self::GlobalState) {
        (self.shared, ChannelGlobalState)
    }

    fn route_command(command: &Self::Command) -> foundation::execution::CommandRoute<Self::Key> {
        command.route()
    }

    fn route_query(query: &Self::Query) -> foundation::execution::QueryRoute<Self::Key> {
        query.route()
    }

    fn open_lane(_shared: &Self::Shared, _key: &Self::Key) -> Self::LaneState {
        ChannelLaneState {
            pending_login_configs: Vec::new(),
        }
    }

    async fn handle_keyed_command(
        shared: Self::Shared,
        _key: Self::Key,
        lane: &mut Self::LaneState,
        command: Self::Command,
    ) {
        handle_keyed_command(shared, lane, command).await;
    }

    async fn handle_global_command(
        _shared: Self::Shared,
        _state: &mut Self::GlobalState,
        command: Self::Command,
    ) {
        if let ChannelCommand::Shutdown(reply) = command {
            let _ = reply.send(());
        }
    }

    async fn handle_direct_query(shared: Self::Shared, query: Self::Query) {
        handle_channel_query(shared, query).await;
    }

    async fn handle_keyed_query(
        shared: Self::Shared,
        _key: Self::Key,
        _lane: &mut Self::LaneState,
        query: Self::Query,
    ) {
        handle_channel_query(shared, query).await;
    }

    async fn handle_global_query(
        shared: Self::Shared,
        _global: &mut Self::GlobalState,
        query: Self::Query,
    ) {
        handle_channel_query(shared, query).await;
    }

    async fn handle_exclusive_query(
        shared: Self::Shared,
        _global: &mut Self::GlobalState,
        query: Self::Query,
    ) {
        handle_channel_query(shared, query).await;
    }
}

impl ChannelLaneState {
    fn insert_login_config(&mut self, key: ChannelKey, config: Zeroizing<Vec<u8>>) {
        if let Some(pending) = self
            .pending_login_configs
            .iter_mut()
            .find(|pending| pending.key == key)
        {
            pending.config = config;
            return;
        }
        self.pending_login_configs
            .push(PendingLoginConfig { key, config });
    }

    fn remove_login_config(&mut self, key: &ChannelKey) {
        self.pending_login_configs
            .retain(|pending| pending.key != *key);
    }

    fn clear_login_configs(&mut self) {
        self.pending_login_configs.clear();
    }

    fn settle_login_effect(&mut self, key: &ChannelKey, effect: &ChannelMutationEffect) {
        match effect {
            ChannelMutationEffect::Login(ChannelLoginOutcome::Progress(progress))
                if progress.status != LoginProgressStatus::Connected => {}
            ChannelMutationEffect::Login(_) => {
                self.remove_login_config(key);
            }
            _ => {}
        }
    }

    fn take_login_config(
        &mut self,
        requested_key: &ChannelKey,
        observed_account_id: Option<&str>,
    ) -> Option<(ChannelKey, Zeroizing<Vec<u8>>)> {
        let observed_key = observed_account_id.and_then(|observed_account_id| {
            ChannelKey::try_new(
                requested_key.endpoint().clone(),
                requested_key.channel_id().to_owned(),
                Some(observed_account_id.to_owned()),
            )
            .ok()
        });
        let channel_default_key = ChannelKey::try_new(
            requested_key.endpoint().clone(),
            requested_key.channel_id().to_owned(),
            None,
        )
        .ok();

        if let Some(observed_key) = observed_key {
            if let Some(config) = self.take_config_for_key(&observed_key) {
                return Some((observed_key, config));
            }
        }
        if let Some(config) = self.take_config_for_key(requested_key) {
            return Some((requested_key.clone(), config));
        }
        let channel_default_key = channel_default_key?;
        self.take_config_for_key(&channel_default_key)
            .map(|config| (channel_default_key, config))
    }

    fn take_config_for_key(&mut self, key: &ChannelKey) -> Option<Zeroizing<Vec<u8>>> {
        let index = self
            .pending_login_configs
            .iter()
            .position(|pending| pending.key == *key)?;
        Some(self.pending_login_configs.remove(index).config)
    }
}

async fn handle_channel_query(shared: ChannelShared, query: ChannelQuery) {
    match query {
        ChannelQuery::Catalog { reply } => {
            let _ = reply.send(catalog(&shared.runtime_directory).await);
        }
        ChannelQuery::ConfigRead {
            channel_id,
            account_id,
            reply,
        } => {
            let _ =
                reply.send(config_read(&shared.runtime_directory, channel_id, account_id).await);
        }
        ChannelQuery::ConfigureForm { channel_id, reply } => {
            let _ = reply.send(configure_form(&shared.runtime_directory, channel_id).await);
        }
        ChannelQuery::Pairing {
            channel_id,
            account_id,
            reply,
        } => {
            let _ = reply.send(pairing(&shared.runtime_directory, channel_id, account_id).await);
        }
        ChannelQuery::Status { reply } => {
            let _ = reply.send(status(&shared.runtime_directory).await);
        }
        ChannelQuery::Snapshot { reply } => {
            let _ = reply.send(snapshot(&shared.runtime_directory).await);
        }
    }
}

async fn handle_keyed_command(
    shared: ChannelShared,
    lane: &mut ChannelLaneState,
    command: ChannelCommand,
) {
    match command {
        ChannelCommand::Configure {
            key, values, reply, ..
        } => {
            let effect = execute_owner_mutation(
                shared,
                lane,
                key,
                ChannelMutation::Configure { values },
                CancellationToken::new(),
            )
            .await;
            let outcome = match effect {
                ChannelMutationEffect::Configure(outcome) => Ok(outcome),
                _ => Err(ChannelOwnerUnavailable),
            };
            let _ = reply.send(outcome);
        }
        ChannelCommand::Delete { key, reply, .. } => {
            let effect = execute_owner_mutation(
                shared,
                lane,
                key,
                ChannelMutation::DeleteConfig,
                CancellationToken::new(),
            )
            .await;
            let outcome = match effect {
                ChannelMutationEffect::DeleteConfig(outcome) => Ok(outcome),
                _ => Err(ChannelOwnerUnavailable),
            };
            let _ = reply.send(outcome);
        }
        ChannelCommand::LoginStart {
            key,
            force,
            timeout_ms,
            config,
            reply,
            ..
        } => {
            lane.insert_login_config(key.clone(), config);
            let effect = execute_owner_mutation(
                shared,
                lane,
                key,
                ChannelMutation::LoginStart { force, timeout_ms },
                CancellationToken::new(),
            )
            .await;
            let outcome = match effect {
                ChannelMutationEffect::Login(outcome) => Ok(outcome),
                _ => Err(ChannelOwnerUnavailable),
            };
            let _ = reply.send(outcome);
        }
        ChannelCommand::LoginWait {
            key,
            timeout_ms,
            session_key,
            current_qr_data_url,
            cancellation,
            reply,
            ..
        } => {
            let mutation = ChannelMutation::LoginWait {
                timeout_ms,
                session_key,
                current_qr_data_url,
            };
            let effect = execute_owner_mutation(shared, lane, key, mutation, cancellation.clone());
            tokio::select! {
                effect = effect => {
                    let outcome = match effect {
                        ChannelMutationEffect::Login(outcome) => Ok(outcome),
                        _ => Err(ChannelOwnerUnavailable),
                    };
                    let _ = reply.send(outcome);
                }
                _ = cancellation.cancelled() => {
                    lane.clear_login_configs();
                    let _ = reply.send(Ok(ChannelLoginOutcome::Cancelled));
                }
            }
        }
        ChannelCommand::LoginCancel { key, reply, .. } => {
            lane.clear_login_configs();
            let effect = execute_mutation(
                &shared.runtime_directory,
                key,
                ChannelMutation::StopLogin,
                CancellationToken::new(),
            )
            .await;
            let outcome = match effect {
                ChannelMutationEffect::Login(outcome) => Ok(outcome),
                _ => Err(ChannelOwnerUnavailable),
            };
            let _ = reply.send(outcome);
        }
        ChannelCommand::Logout { key, reply, .. } => {
            let effect = execute_owner_mutation(
                shared,
                lane,
                key.clone(),
                ChannelMutation::Logout,
                CancellationToken::new(),
            )
            .await;
            lane.remove_login_config(&key);
            let outcome = match effect {
                ChannelMutationEffect::Login(outcome) => Ok(outcome),
                _ => Err(ChannelOwnerUnavailable),
            };
            let _ = reply.send(outcome);
        }
        ChannelCommand::Control {
            key, action, reply, ..
        } => {
            let effect = execute_owner_mutation(
                shared,
                lane,
                key,
                ChannelMutation::Control(action),
                CancellationToken::new(),
            )
            .await;
            let outcome = match effect {
                ChannelMutationEffect::Control(outcome) => Ok(outcome),
                _ => Err(ChannelOwnerUnavailable),
            };
            let _ = reply.send(outcome);
        }
        ChannelCommand::PairingApprove {
            key, code, reply, ..
        } => {
            let effect = execute_owner_mutation(
                shared,
                lane,
                key,
                ChannelMutation::PairingApprove { code },
                CancellationToken::new(),
            )
            .await;
            let outcome = match effect {
                ChannelMutationEffect::PairingApprove(outcome) => Ok(outcome),
                _ => Err(ChannelOwnerUnavailable),
            };
            let _ = reply.send(outcome);
        }
        ChannelCommand::ValidateCredentials {
            key, config, reply, ..
        } => {
            let effect = execute_owner_mutation(
                shared,
                lane,
                key,
                ChannelMutation::ValidateCredentials { config },
                CancellationToken::new(),
            )
            .await;
            let outcome = match effect {
                ChannelMutationEffect::Credentials(outcome) => Ok(outcome),
                _ => Err(ChannelOwnerUnavailable),
            };
            let _ = reply.send(outcome);
        }
        ChannelCommand::Shutdown(_) => {}
    }
}

async fn execute_owner_mutation(
    shared: ChannelShared,
    lane: &mut ChannelLaneState,
    key: ChannelKey,
    mutation: ChannelMutation,
    cancellation: CancellationToken,
) -> ChannelMutationEffect {
    let effect = execute_mutation(
        &shared.runtime_directory,
        key.clone(),
        mutation,
        cancellation,
    )
    .await;
    finalize_login_effect(shared, lane, key, effect).await
}

async fn finalize_login_effect(
    shared: ChannelShared,
    lane: &mut ChannelLaneState,
    key: ChannelKey,
    effect: ChannelMutationEffect,
) -> ChannelMutationEffect {
    let Some((config_key, config, connected_outcome)) =
        check_login_finalization(lane, &key, &effect)
    else {
        lane.settle_login_effect(&key, &effect);
        return effect;
    };
    let finalize_effect = execute_mutation(
        &shared.runtime_directory,
        config_key,
        ChannelMutation::FinalizeLogin { config },
        CancellationToken::new(),
    )
    .await;
    project_finalization(finalize_effect, connected_outcome)
}

fn check_login_finalization(
    lane: &mut ChannelLaneState,
    key: &ChannelKey,
    effect: &ChannelMutationEffect,
) -> Option<(ChannelKey, Zeroizing<Vec<u8>>, ChannelLoginOutcome)> {
    let ChannelMutationEffect::Login(ChannelLoginOutcome::Progress(progress)) = effect else {
        return None;
    };
    if progress.status != LoginProgressStatus::Connected {
        return None;
    }
    let (config_key, config) = lane.take_login_config(key, progress.account_id.as_deref())?;
    Some((
        config_key,
        config,
        ChannelLoginOutcome::Progress(progress.clone()),
    ))
}

async fn catalog(
    runtime_directory: &RuntimeDriverDirectory,
) -> crate::channel::catalog::ChannelCatalogOutcome {
    let Some(driver) = runtime_directory
        .lookup(&crate::runtime_driver::RuntimeDriverIdentity::open_claw().endpoint())
    else {
        return crate::channel::catalog::ChannelCatalogOutcome::Unknown;
    };
    let Some(ops) = driver.channel_ops() else {
        return crate::channel::catalog::ChannelCatalogOutcome::Unknown;
    };
    ops.channel_catalog().await
}

async fn configure_form(
    runtime_directory: &RuntimeDriverDirectory,
    channel_id: String,
) -> crate::channel::catalog::ChannelConfigureFormOutcome {
    let Some(driver) = runtime_directory
        .lookup(&crate::runtime_driver::RuntimeDriverIdentity::open_claw().endpoint())
    else {
        return crate::channel::catalog::ChannelConfigureFormOutcome::Unknown;
    };
    let Some(ops) = driver.channel_ops() else {
        return crate::channel::catalog::ChannelConfigureFormOutcome::Unknown;
    };
    ops.channel_configure_form(channel_id).await
}

async fn config_read(
    runtime_directory: &RuntimeDriverDirectory,
    channel_id: String,
    account_id: Option<String>,
) -> crate::channel::config_read::Outcome {
    let Some(driver) = runtime_directory
        .lookup(&crate::runtime_driver::RuntimeDriverIdentity::open_claw().endpoint())
    else {
        return crate::channel::config_read::Outcome::Unknown;
    };
    let Some(ops) = driver.channel_ops() else {
        return crate::channel::config_read::Outcome::Unknown;
    };
    ops.read_channel_config(channel_id, account_id).await
}

async fn status(
    runtime_directory: &RuntimeDriverDirectory,
) -> Result<
    crate::channel::status::ChannelStatusOutcome,
    crate::channel::status::ChannelStatusFailure,
> {
    let Some(driver) = runtime_directory
        .lookup(&crate::runtime_driver::RuntimeDriverIdentity::open_claw().endpoint())
    else {
        return Err(crate::channel::status::ChannelStatusFailure::Unavailable);
    };
    let Some(ops) = driver.channel_ops() else {
        return Err(crate::channel::status::ChannelStatusFailure::Unavailable);
    };
    ops.observe_channel_accounts().await
}

async fn snapshot(
    runtime_directory: &RuntimeDriverDirectory,
) -> Result<
    crate::channel::status::ChannelSnapshotOutcome,
    crate::channel::status::ChannelStatusFailure,
> {
    let Some(driver) = runtime_directory
        .lookup(&crate::runtime_driver::RuntimeDriverIdentity::open_claw().endpoint())
    else {
        return Err(crate::channel::status::ChannelStatusFailure::Unavailable);
    };
    let Some(ops) = driver.channel_ops() else {
        return Err(crate::channel::status::ChannelStatusFailure::Unavailable);
    };
    ops.observe_channel_snapshot().await
}

async fn pairing(
    runtime_directory: &RuntimeDriverDirectory,
    channel_id: String,
    account_id: Option<String>,
) -> crate::channel::status::ChannelPairingOutcome {
    let Some(driver) = runtime_directory
        .lookup(&crate::runtime_driver::RuntimeDriverIdentity::open_claw().endpoint())
    else {
        return crate::channel::status::ChannelPairingOutcome::OutcomeUnknown;
    };
    let Some(ops) = driver.channel_ops() else {
        return crate::channel::status::ChannelPairingOutcome::OutcomeUnknown;
    };
    ops.list_channel_pairing(channel_id, account_id).await
}

async fn execute_mutation(
    runtime_directory: &RuntimeDriverDirectory,
    key: ChannelKey,
    mutation: ChannelMutation,
    cancellation: CancellationToken,
) -> ChannelMutationEffect {
    let Some(driver) = runtime_directory.lookup(key.endpoint()) else {
        return unknown_effect(&mutation);
    };
    let Some(ops) = driver.channel_ops() else {
        return unknown_effect(&mutation);
    };

    match mutation {
        ChannelMutation::Configure { values } => {
            let outcome = ops
                .channel_configure(
                    key.channel_id().to_owned(),
                    key.account_id().unwrap_or_default().to_owned(),
                    values,
                )
                .await;
            ChannelMutationEffect::Configure(outcome)
        }
        ChannelMutation::DeleteConfig => {
            let outcome = ops
                .channel_delete_config(
                    key.channel_id().to_owned(),
                    key.account_id().unwrap_or_default().to_owned(),
                )
                .await;
            ChannelMutationEffect::DeleteConfig(outcome)
        }
        ChannelMutation::Control(action) => {
            let outcome = ops
                .control_channel_account(
                    action,
                    key.channel_id().to_owned(),
                    key.account_id().unwrap_or_default().to_owned(),
                )
                .await;
            ChannelMutationEffect::Control(outcome)
        }
        ChannelMutation::LoginStart { force, timeout_ms } => {
            let outcome = ops
                .start_channel_login(
                    key.channel_id().to_owned(),
                    force,
                    timeout_ms,
                    key.account_id().map(str::to_owned),
                )
                .await;
            ChannelMutationEffect::Login(outcome)
        }
        ChannelMutation::LoginWait {
            timeout_ms,
            session_key,
            current_qr_data_url,
        } => {
            let outcome = ops
                .wait_channel_login_owned(
                    key.channel_id().to_owned(),
                    timeout_ms,
                    key.account_id().map(str::to_owned),
                    session_key,
                    current_qr_data_url,
                    cancellation,
                )
                .await;
            ChannelMutationEffect::Login(outcome)
        }
        ChannelMutation::StopLogin => {
            let outcome = ops
                .stop_channel_login(
                    key.channel_id().to_owned(),
                    key.account_id().map(str::to_owned),
                )
                .await;
            ChannelMutationEffect::Login(outcome)
        }
        ChannelMutation::Logout => {
            let outcome = ops
                .logout_channel(
                    key.channel_id().to_owned(),
                    key.account_id().map(str::to_owned),
                )
                .await;
            ChannelMutationEffect::Login(outcome)
        }
        ChannelMutation::PairingApprove { code } => {
            let outcome = ops
                .approve_channel_pairing(
                    key.channel_id().to_owned(),
                    key.account_id().map(str::to_owned),
                    code,
                )
                .await;
            ChannelMutationEffect::PairingApprove(outcome)
        }
        ChannelMutation::ValidateCredentials { config } => {
            let outcome = ops
                .validate_channel_credentials(key.channel_id().to_owned(), config)
                .await;
            ChannelMutationEffect::Credentials(outcome)
        }
        ChannelMutation::FinalizeLogin { mut config } => {
            let values = match append_enabled(config.as_mut_slice()) {
                Some(values) => values,
                None => {
                    return ChannelMutationEffect::LoginFinalized(
                        LoginFinalizationOutcome::Rejected,
                    );
                }
            };
            let outcome = ops
                .channel_configure(
                    key.channel_id().to_owned(),
                    key.account_id().unwrap_or_default().to_owned(),
                    values,
                )
                .await;
            ChannelMutationEffect::LoginFinalized(match outcome {
                ChannelConfigureOutcome::Confirmed => LoginFinalizationOutcome::Confirmed,
                ChannelConfigureOutcome::TargetRejected => LoginFinalizationOutcome::Rejected,
                ChannelConfigureOutcome::Unknown => LoginFinalizationOutcome::Unknown,
            })
        }
    }
}

fn append_enabled(bytes: &mut [u8]) -> Option<Zeroizing<Vec<u8>>> {
    let Some(start) = bytes.iter().position(|byte| !byte.is_ascii_whitespace()) else {
        bytes.zeroize();
        return None;
    };
    let end = bytes
        .iter()
        .rposition(|byte| !byte.is_ascii_whitespace())
        .expect("non-empty byte slice has an end");
    if bytes.get(start) != Some(&b'{') || bytes.get(end) != Some(&b'}') {
        bytes.zeroize();
        return None;
    }

    let mut values = Vec::with_capacity(end.saturating_sub(start) + 16);
    values.extend_from_slice(&bytes[start..end]);
    if bytes[start + 1..end]
        .iter()
        .any(|byte| !byte.is_ascii_whitespace())
    {
        values.push(b',');
    }
    values.extend_from_slice(br#""enabled":true}"#);
    bytes.zeroize();
    Some(Zeroizing::new(values))
}

fn unknown_effect(mutation: &ChannelMutation) -> ChannelMutationEffect {
    match mutation {
        ChannelMutation::Configure { .. } => {
            ChannelMutationEffect::Configure(ChannelConfigureOutcome::Unknown)
        }
        ChannelMutation::DeleteConfig => {
            ChannelMutationEffect::DeleteConfig(crate::channel::delete::Outcome::Unknown)
        }
        ChannelMutation::Control(_) => ChannelMutationEffect::Control(
            crate::channel::control::ChannelControlOutcome::OutcomeUnknown,
        ),
        ChannelMutation::LoginStart { .. }
        | ChannelMutation::LoginWait { .. }
        | ChannelMutation::StopLogin
        | ChannelMutation::Logout => ChannelMutationEffect::Login(ChannelLoginOutcome::Unknown),
        ChannelMutation::PairingApprove { .. } => ChannelMutationEffect::PairingApprove(
            crate::channel::status::ChannelPairingApprovalOutcome::Unknown,
        ),
        ChannelMutation::ValidateCredentials { .. } => {
            ChannelMutationEffect::Credentials(crate::channel::credentials::Outcome::Unknown)
        }
        ChannelMutation::FinalizeLogin { .. } => {
            ChannelMutationEffect::LoginFinalized(LoginFinalizationOutcome::Unknown)
        }
    }
}

fn project_finalization(
    effect: ChannelMutationEffect,
    connected_outcome: ChannelLoginOutcome,
) -> ChannelMutationEffect {
    match effect {
        ChannelMutationEffect::LoginFinalized(LoginFinalizationOutcome::Confirmed) => {
            ChannelMutationEffect::Login(connected_outcome)
        }
        ChannelMutationEffect::LoginFinalized(LoginFinalizationOutcome::Rejected) => {
            ChannelMutationEffect::Login(ChannelLoginOutcome::Rejected)
        }
        _ => ChannelMutationEffect::Login(ChannelLoginOutcome::Unknown),
    }
}
