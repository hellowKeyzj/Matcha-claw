use crate::application::trace::ChannelTraceSpan;
use platform::trace::{channel_trace, with_channel_trace};

use std::sync::Arc;

use foundation::execution::{LaneRetention, OwnerSpec};
use tokio_util::sync::CancellationToken;
use zeroize::{Zeroize, Zeroizing};

use crate::ports::ChannelRuntimeDirectory;

use crate::{
    application::{
        commands::{ChannelCommand, ChannelOwnerUnavailable},
        queries::ChannelQuery,
    },
    domain::{
        catalog::ChannelConfigureOutcome,
        login::{LoginProgressStatus, Outcome as ChannelLoginOutcome},
        operations::{
            ChannelKey, ChannelMutation, ChannelMutationEffect, LoginFinalizationOutcome,
        },
    },
};

#[derive(Clone)]
pub struct ChannelShared {
    runtime_directory: Arc<dyn ChannelRuntimeDirectory>,
    default_endpoint: platform::endpoint::runtime_address::RuntimeEndpoint,
}

pub struct ChannelOwner {
    shared: ChannelShared,
}

pub struct ChannelOwnerInput {
    pub runtime_directory: Arc<dyn ChannelRuntimeDirectory>,
    pub default_endpoint: platform::endpoint::runtime_address::RuntimeEndpoint,
}

pub struct ChannelGlobalState;
pub struct ChannelLaneState {
    pending_login_configs: Vec<PendingLoginConfig>,
}

struct PendingLoginConfig {
    key: ChannelKey,
    agent_id: Option<String>,
    config: Zeroizing<Vec<u8>>,
}

impl ChannelOwner {
    pub fn new(input: ChannelOwnerInput) -> Self {
        Self {
            shared: ChannelShared {
                runtime_directory: input.runtime_directory,
                default_endpoint: input.default_endpoint,
            },
        }
    }

    pub fn lane_retention() -> LaneRetention {
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
        let trace_id = command.trace().and_then(|trace| trace.trace_id.clone());
        with_channel_trace(trace_id, async {
            if let Some(trace) = command.trace() {
                trace.received();
            }
            let mut span = ChannelTraceSpan::begin("channel.owner.command");
            handle_keyed_command(shared, lane, command).await;
            span.finish("replied");
        })
        .await;
    }

    async fn handle_global_command(
        _shared: Self::Shared,
        _state: &mut Self::GlobalState,
        _command: Self::Command,
    ) {
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
    fn insert_login_config(
        &mut self,
        key: ChannelKey,
        agent_id: Option<String>,
        config: Zeroizing<Vec<u8>>,
    ) {
        if let Some(pending) = self
            .pending_login_configs
            .iter_mut()
            .find(|pending| pending.key == key)
        {
            pending.agent_id = agent_id;
            pending.config = config;
            return;
        }
        self.pending_login_configs.push(PendingLoginConfig {
            key,
            agent_id,
            config,
        });
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
    ) -> Option<(ChannelKey, Option<String>, Zeroizing<Vec<u8>>)> {
        let connected_key = observed_account_id.and_then(|observed_account_id| {
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

        if let Some(connected_key) = connected_key {
            if let Some((agent_id, config)) = self.take_config_for_key(&connected_key) {
                return Some((connected_key, agent_id, config));
            }
            if let Some((agent_id, config)) = self.take_config_for_key(requested_key) {
                return Some((connected_key, agent_id, config));
            }
            if let Some(channel_default_key) = channel_default_key {
                if let Some((agent_id, config)) = self.take_config_for_key(&channel_default_key) {
                    return Some((connected_key, agent_id, config));
                }
            }
            return None;
        }

        if let Some((agent_id, config)) = self.take_config_for_key(requested_key) {
            return Some((requested_key.clone(), agent_id, config));
        }
        let channel_default_key = channel_default_key?;
        self.take_config_for_key(&channel_default_key)
            .map(|(agent_id, config)| (channel_default_key, agent_id, config))
    }

    fn take_config_for_key(
        &mut self,
        key: &ChannelKey,
    ) -> Option<(Option<String>, Zeroizing<Vec<u8>>)> {
        let index = self
            .pending_login_configs
            .iter()
            .position(|pending| pending.key == *key)?;
        let pending = self.pending_login_configs.remove(index);
        Some((pending.agent_id, pending.config))
    }
}

async fn handle_channel_query(shared: ChannelShared, query: ChannelQuery) {
    let trace_id = query.trace().trace_id.clone();
    with_channel_trace(trace_id, async {
        query.trace().received();
        let mut span = ChannelTraceSpan::begin("channel.owner.query");
        match query {
            ChannelQuery::Catalog { reply, .. } => {
                let _ = reply.send(
                    catalog(shared.runtime_directory.as_ref(), &shared.default_endpoint).await,
                );
            }
            ChannelQuery::ConfigRead {
                channel_id,
                account_id,
                reply,
                ..
            } => {
                let _ = reply.send(
                    config_read(
                        shared.runtime_directory.as_ref(),
                        &shared.default_endpoint,
                        channel_id,
                        account_id,
                    )
                    .await,
                );
            }
            ChannelQuery::ConfigureForm {
                channel_id, reply, ..
            } => {
                let _ = reply.send(
                    configure_form(
                        shared.runtime_directory.as_ref(),
                        &shared.default_endpoint,
                        channel_id,
                    )
                    .await,
                );
            }
            ChannelQuery::Pairing {
                channel_id,
                account_id,
                reply,
                ..
            } => {
                let _ = reply.send(
                    pairing(
                        shared.runtime_directory.as_ref(),
                        &shared.default_endpoint,
                        channel_id,
                        account_id,
                    )
                    .await,
                );
            }
            ChannelQuery::Status { reply, .. } => {
                let _ = reply.send(
                    status(shared.runtime_directory.as_ref(), &shared.default_endpoint).await,
                );
            }
            ChannelQuery::Snapshot { reply, .. } => {
                let _ = reply.send(
                    snapshot(shared.runtime_directory.as_ref(), &shared.default_endpoint).await,
                );
            }
        }
        span.finish("replied");
    })
    .await;
}

async fn handle_keyed_command(
    shared: ChannelShared,
    lane: &mut ChannelLaneState,
    command: ChannelCommand,
) {
    match command {
        ChannelCommand::Configure {
            key,
            agent_id,
            values,
            reply,
            ..
        } => {
            let effect = execute_owner_mutation(
                shared,
                lane,
                key,
                ChannelMutation::Configure { agent_id, values },
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
            agent_id,
            config,
            reply,
            ..
        } => {
            lane.insert_login_config(key.clone(), agent_id.clone(), config);
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
                    channel_trace("channel.login.wait", "outcome=cancelled");
                    lane.clear_login_configs();
                    let _ = reply.send(Ok(ChannelLoginOutcome::Cancelled));
                }
            }
        }
        ChannelCommand::LoginCancel { key, reply, .. } => {
            lane.clear_login_configs();
            let effect = execute_mutation(
                shared.runtime_directory.as_ref(),
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
        shared.runtime_directory.as_ref(),
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
    let Some((config_key, agent_id, config, connected_outcome)) =
        check_login_finalization(lane, &key, &effect)
    else {
        channel_trace("channel.login.finalize", "outcome=skipped");
        lane.settle_login_effect(&key, &effect);
        return effect;
    };
    let mut span = ChannelTraceSpan::begin("channel.login.finalize");
    let finalize_effect = execute_mutation(
        shared.runtime_directory.as_ref(),
        config_key,
        ChannelMutation::FinalizeLogin { agent_id, config },
        CancellationToken::new(),
    )
    .await;
    span.finish(finalize_effect.trace_outcome());
    project_finalization(finalize_effect, connected_outcome)
}

fn check_login_finalization(
    lane: &mut ChannelLaneState,
    key: &ChannelKey,
    effect: &ChannelMutationEffect,
) -> Option<(
    ChannelKey,
    Option<String>,
    Zeroizing<Vec<u8>>,
    ChannelLoginOutcome,
)> {
    let ChannelMutationEffect::Login(ChannelLoginOutcome::Progress(progress)) = effect else {
        return None;
    };
    if progress.status != LoginProgressStatus::Connected {
        return None;
    }
    channel_trace("channel.login.confirmed", "outcome=connected");
    let Some((config_key, agent_id, config)) =
        lane.take_login_config(key, progress.account_id.as_deref())
    else {
        channel_trace("channel.login.finalize", "outcome=no_pending_config");
        return None;
    };
    Some((
        config_key,
        agent_id,
        config,
        ChannelLoginOutcome::Progress(progress.clone()),
    ))
}

async fn catalog(
    runtime_directory: &dyn ChannelRuntimeDirectory,
    endpoint: &platform::endpoint::runtime_address::RuntimeEndpoint,
) -> crate::domain::catalog::ChannelCatalogOutcome {
    let Some(ops) = runtime_directory.channel_ops(endpoint) else {
        return crate::domain::catalog::ChannelCatalogOutcome::Unknown;
    };
    ops.channel_catalog().await
}

async fn configure_form(
    runtime_directory: &dyn ChannelRuntimeDirectory,
    endpoint: &platform::endpoint::runtime_address::RuntimeEndpoint,
    channel_id: String,
) -> crate::domain::catalog::ChannelConfigureFormOutcome {
    let Some(ops) = runtime_directory.channel_ops(endpoint) else {
        return crate::domain::catalog::ChannelConfigureFormOutcome::Unknown;
    };
    ops.channel_configure_form(channel_id).await
}

async fn config_read(
    runtime_directory: &dyn ChannelRuntimeDirectory,
    endpoint: &platform::endpoint::runtime_address::RuntimeEndpoint,
    channel_id: String,
    account_id: Option<String>,
) -> crate::projection::config_read::Outcome {
    let Some(ops) = runtime_directory.channel_ops(endpoint) else {
        return crate::projection::config_read::Outcome::Unavailable;
    };
    ops.read_channel_config(channel_id, account_id).await
}

async fn status(
    runtime_directory: &dyn ChannelRuntimeDirectory,
    endpoint: &platform::endpoint::runtime_address::RuntimeEndpoint,
) -> Result<crate::domain::status::ChannelStatusOutcome, crate::domain::status::ChannelStatusFailure>
{
    let Some(ops) = runtime_directory.channel_ops(endpoint) else {
        return Err(crate::domain::status::ChannelStatusFailure::Unavailable);
    };
    ops.observe_channel_accounts().await
}

async fn snapshot(
    runtime_directory: &dyn ChannelRuntimeDirectory,
    endpoint: &platform::endpoint::runtime_address::RuntimeEndpoint,
) -> Result<
    crate::domain::status::ChannelSnapshotOutcome,
    crate::domain::status::ChannelStatusFailure,
> {
    let Some(ops) = runtime_directory.channel_ops(endpoint) else {
        return Err(crate::domain::status::ChannelStatusFailure::Unavailable);
    };
    ops.observe_channel_snapshot().await
}

async fn pairing(
    runtime_directory: &dyn ChannelRuntimeDirectory,
    endpoint: &platform::endpoint::runtime_address::RuntimeEndpoint,
    channel_id: String,
    account_id: Option<String>,
) -> crate::domain::status::ChannelPairingOutcome {
    let Some(ops) = runtime_directory.channel_ops(endpoint) else {
        return crate::domain::status::ChannelPairingOutcome::OutcomeUnknown;
    };
    ops.list_channel_pairing(channel_id, account_id).await
}

async fn execute_mutation(
    runtime_directory: &dyn ChannelRuntimeDirectory,
    key: ChannelKey,
    mutation: ChannelMutation,
    cancellation: CancellationToken,
) -> ChannelMutationEffect {
    let kind = crate::domain::operations::mutation_kind(&mutation);
    let mut span = ChannelTraceSpan::begin(kind.trace_phase());
    let effect = async {
        let Some(ops) = runtime_directory.channel_ops(key.endpoint()) else {
            channel_trace("channel.mutation.admission", "outcome=unavailable");
            return unknown_effect(&mutation);
        };

        match mutation {
            ChannelMutation::Configure { agent_id, values } => {
                let outcome = ops
                    .channel_configure(
                        key.channel_id().to_owned(),
                        key.account_id().unwrap_or_default().to_owned(),
                        agent_id,
                        values,
                    )
                    .await;
                ChannelMutationEffect::Configure(outcome)
            }
            ChannelMutation::DeleteConfig => {
                let outcome = ops
                    .channel_delete_config(
                        key.channel_id().to_owned(),
                        key.account_id().map(str::to_owned),
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
            ChannelMutation::FinalizeLogin {
                agent_id,
                mut config,
            } => {
                let values = match append_enabled(config.as_mut_slice()) {
                    Some(values) => values,
                    None => {
                        return ChannelMutationEffect::LoginFinalized(
                            LoginFinalizationOutcome::Rejected,
                        );
                    }
                };
                let channel = key.channel_id().to_owned();
                let account = key.account_id().unwrap_or_default().to_owned();
                let outcome = ops
                    .finalize_channel_login(channel, account, agent_id, values)
                    .await;
                let outcome = match outcome {
                    ChannelConfigureOutcome::Confirmed => LoginFinalizationOutcome::Confirmed,
                    ChannelConfigureOutcome::TargetRejected => LoginFinalizationOutcome::Rejected,
                    ChannelConfigureOutcome::Unknown => LoginFinalizationOutcome::Unknown,
                };
                ChannelMutationEffect::LoginFinalized(outcome)
            }
        }
    }
    .await;
    span.finish(effect.trace_outcome());
    effect
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
            ChannelMutationEffect::DeleteConfig(crate::domain::delete::Outcome::Unknown)
        }
        ChannelMutation::Control(_) => ChannelMutationEffect::Control(
            crate::domain::control::ChannelControlOutcome::OutcomeUnknown,
        ),
        ChannelMutation::LoginStart { .. }
        | ChannelMutation::LoginWait { .. }
        | ChannelMutation::StopLogin
        | ChannelMutation::Logout => ChannelMutationEffect::Login(ChannelLoginOutcome::Unknown),
        ChannelMutation::PairingApprove { .. } => ChannelMutationEffect::PairingApprove(
            crate::domain::status::ChannelPairingApprovalOutcome::Unknown,
        ),
        ChannelMutation::ValidateCredentials { .. } => {
            ChannelMutationEffect::Credentials(crate::domain::credentials::Outcome::Unknown)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{login::LoginProgress, ports::ChannelOps};

    struct EmptyRuntimeDirectory;

    impl ChannelRuntimeDirectory for EmptyRuntimeDirectory {
        fn channel_ops(
            &self,
            _endpoint: &platform::endpoint::runtime_address::RuntimeEndpoint,
        ) -> Option<&dyn ChannelOps> {
            None
        }
    }

    fn runtime_endpoint() -> platform::endpoint::runtime_address::RuntimeEndpoint {
        platform::endpoint::runtime_address::RuntimeEndpoint::try_new("openclaw", "local")
            .expect("test runtime endpoint is valid")
    }

    fn channel_key(account_id: Option<&str>) -> ChannelKey {
        ChannelKey::try_new(
            runtime_endpoint(),
            "whatsapp",
            account_id.map(str::to_owned),
        )
        .expect("test channel key is valid")
    }

    fn config_bytes(value: &str) -> Zeroizing<Vec<u8>> {
        Zeroizing::new(value.as_bytes().to_vec())
    }

    fn lane_with_config(
        key: ChannelKey,
        agent_id: Option<&str>,
        config: Zeroizing<Vec<u8>>,
    ) -> ChannelLaneState {
        let mut lane = ChannelLaneState {
            pending_login_configs: Vec::new(),
        };
        lane.insert_login_config(key, agent_id.map(str::to_owned), config);
        lane
    }

    fn connected_effect(account_id: Option<&str>) -> ChannelMutationEffect {
        ChannelMutationEffect::Login(ChannelLoginOutcome::Progress(LoginProgress::new(
            "whatsapp".to_owned(),
            account_id.map(str::to_owned),
            None,
            LoginProgressStatus::Connected,
            None,
        )))
    }

    #[test]
    fn connected_account_id_overrides_requested_login_finalization_key() {
        let requested_key = channel_key(Some("requested"));
        let mut lane = lane_with_config(
            requested_key.clone(),
            Some("agent-alpha"),
            config_bytes("requested-config"),
        );

        let (config_key, agent_id, config, _) =
            check_login_finalization(&mut lane, &requested_key, &connected_effect(Some("native")))
                .expect("connected progress finalizes pending login config");

        assert_eq!(config_key.account_id(), Some("native"));
        assert_eq!(agent_id.as_deref(), Some("agent-alpha"));
        assert_eq!(config.as_slice(), b"requested-config");
        assert!(lane.pending_login_configs.is_empty());

        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                use platform::trace::{current_channel_trace, with_channel_trace_sync};
                let trace_id = "12345678-1234-4234-8234-123456789abc".to_owned();
                let trace = with_channel_trace_sync(
                    Some(trace_id.clone()),
                    crate::trace::CommandTrace::capture,
                );
                assert_eq!(trace.trace_id.as_deref(), Some(trace_id.as_str()));
                assert_eq!(current_channel_trace(), None);
                let (reply, received) = tokio::sync::oneshot::channel();
                let command = ChannelCommand::Delete {
                    trace,
                    key: requested_key.clone(),
                    reply,
                };
                let task = tokio::spawn(async move {
                    let shared = ChannelShared {
                        runtime_directory: Arc::new(EmptyRuntimeDirectory),
                        default_endpoint: runtime_endpoint(),
                    };
                    ChannelOwner::handle_keyed_command(shared, requested_key, &mut lane, command)
                        .await;
                    assert_eq!(current_channel_trace(), None);
                });
                assert!(matches!(
                    received.await.unwrap(),
                    Ok(crate::domain::delete::Outcome::Unknown)
                ));
                task.await.unwrap();
            });
    }

    #[test]
    fn connected_account_id_overrides_default_login_finalization_key() {
        let default_key = channel_key(None);
        let mut lane = lane_with_config(default_key.clone(), None, config_bytes("default-config"));

        let (config_key, agent_id, config, _) =
            check_login_finalization(&mut lane, &default_key, &connected_effect(Some("native")))
                .expect("connected progress finalizes pending login config");

        assert_eq!(config_key.account_id(), Some("native"));
        assert_eq!(agent_id, None);
        assert_eq!(config.as_slice(), b"default-config");
        assert!(lane.pending_login_configs.is_empty());
    }

    #[test]
    fn invalid_connected_account_id_keeps_requested_login_finalization_key() {
        let requested_key = channel_key(Some("requested"));
        let mut lane = lane_with_config(
            requested_key.clone(),
            None,
            config_bytes("requested-config"),
        );

        let (config_key, agent_id, config, _) = check_login_finalization(
            &mut lane,
            &requested_key,
            &connected_effect(Some("native account")),
        )
        .expect("connected progress finalizes pending login config");

        assert_eq!(config_key.account_id(), Some("requested"));
        assert_eq!(agent_id, None);
        assert_eq!(config.as_slice(), b"requested-config");
        assert!(lane.pending_login_configs.is_empty());
    }
}
