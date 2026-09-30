use std::sync::Arc;

use foundation::execution::{CommandRoute, LaneRetention, OwnerSpec, QueryRoute};

use crate::{
    adapters::store::{DesiredState, PendingDesired},
    application::{
        call::{SettingsCallDetail, SettingsOperation, settlement_status},
        commands::SettingsCommand,
        operations,
        queries::SettingsQuery,
        receipts::{Outcome, Settlement},
    },
    domain::Desired,
    ports::SettingsRuntimeDirectory,
    projection::public::DesiredReadModel,
};

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum SettingsPartitionKey {
    Global,
}

#[derive(Clone)]
pub struct SettingsShared {
    runtime_directory: Arc<dyn SettingsRuntimeDirectory>,
}

pub struct SettingsGlobalState {
    state: DesiredState,
}

pub struct SettingsOwnerInput {
    pub state_dir: std::path::PathBuf,
    pub runtime_directory: Arc<dyn SettingsRuntimeDirectory>,
}

pub struct SettingsOwner {
    shared: SettingsShared,
    global: SettingsGlobalState,
}

impl SettingsOwner {
    pub fn new(input: SettingsOwnerInput) -> Result<Self, ()> {
        Ok(Self {
            shared: SettingsShared {
                runtime_directory: input.runtime_directory,
            },
            global: SettingsGlobalState {
                state: DesiredState::open(&input.state_dir).map_err(|_| ())?,
            },
        })
    }

    pub const fn lane_retention() -> LaneRetention {
        LaneRetention::LowFrequency
    }
}

impl SettingsGlobalState {
    async fn replace(
        &mut self,
        shared: &SettingsShared,
        correlation: String,
        desired: Desired,
    ) -> Settlement {
        let (revision, prior_outcome) = self.state.replace(correlation, desired);
        if let Some(outcome) = prior_outcome {
            return Settlement { revision, outcome };
        }

        match self.state.pending() {
            Some(pending) if pending.revision == revision => {
                self.settle_pending(shared, pending).await
            }
            _ => Settlement::unknown(revision),
        }
    }

    async fn recover_pending(&mut self, shared: &SettingsShared) -> Option<Settlement> {
        let pending = self.state.pending()?;
        Some(self.settle_pending(shared, pending).await)
    }

    async fn apply_saved_projection(&mut self, shared: &SettingsShared) -> Outcome {
        self.apply_desired(shared, self.state.desired()).await
    }

    async fn settle_pending(
        &mut self,
        shared: &SettingsShared,
        pending: PendingDesired,
    ) -> Settlement {
        let outcome = self.apply_desired(shared, pending.desired).await;
        self.state.settle(pending.revision, outcome);
        Settlement {
            revision: pending.revision,
            outcome,
        }
    }

    async fn apply_desired(&self, shared: &SettingsShared, desired: Desired) -> Outcome {
        operations::apply_saved_desired(shared.runtime_directory.as_ref(), desired).await
    }

    fn desired_read_model(&self) -> DesiredReadModel {
        DesiredReadModel::new(self.state.desired_snapshot())
    }

    fn gateway_auto_start(&self) -> bool {
        self.state.gateway_auto_start()
    }
}

impl OwnerSpec for SettingsOwner {
    type Command = SettingsCommand;
    type Query = SettingsQuery;
    type Key = SettingsPartitionKey;
    type Shared = SettingsShared;
    type GlobalState = SettingsGlobalState;
    type LaneState = ();

    fn split(self) -> (Self::Shared, Self::GlobalState) {
        (self.shared, self.global)
    }

    fn route_command(command: &Self::Command) -> CommandRoute<Self::Key> {
        match command {
            SettingsCommand::ReplaceDesired { .. }
            | SettingsCommand::RecoverPendingProjection { .. }
            | SettingsCommand::ApplySavedProjection { .. } => CommandRoute::Global,
        }
    }

    fn route_query(query: &Self::Query) -> QueryRoute<Self::Key> {
        match query {
            SettingsQuery::DesiredReadModel { .. } | SettingsQuery::GatewayAutoStart { .. } => {
                QueryRoute::Global
            }
        }
    }

    fn open_lane(_shared: &Self::Shared, _key: &Self::Key) -> Self::LaneState {}

    async fn handle_keyed_command(
        _shared: Self::Shared,
        _key: Self::Key,
        _state: &mut Self::LaneState,
        _command: Self::Command,
    ) {
    }

    async fn handle_global_command(
        shared: Self::Shared,
        state: &mut Self::GlobalState,
        command: Self::Command,
    ) {
        match command {
            SettingsCommand::ReplaceDesired {
                correlation,
                desired,
                call,
            } => {
                if let Err(error) = call.running().await {
                    eprintln!(
                        "settings call {} audit running failed: {error}",
                        call.id().as_str()
                    );
                }
                let launch_at_startup = desired.launch_at_startup();
                let settlement = state.replace(&shared, correlation, desired).await;
                if let Err(error) = call
                    .finish(
                        settlement_status(settlement),
                        &SettingsCallDetail::settled(settlement, launch_at_startup),
                    )
                    .await
                {
                    eprintln!(
                        "settings call {} audit finish failed: {error}",
                        call.id().as_str()
                    );
                }
            }
            SettingsCommand::RecoverPendingProjection { reply } => {
                let _ = state.recover_pending(&shared).await;
                let _ = reply.send(());
            }
            SettingsCommand::ApplySavedProjection { reply } => {
                let _ = reply.send(state.apply_saved_projection(&shared).await);
            }
        }
    }

    async fn handle_direct_query(_shared: Self::Shared, _query: Self::Query) {}

    async fn handle_keyed_query(
        _shared: Self::Shared,
        _key: Self::Key,
        _state: &mut Self::LaneState,
        _query: Self::Query,
    ) {
    }

    async fn handle_global_query(
        _shared: Self::Shared,
        state: &mut Self::GlobalState,
        query: Self::Query,
    ) {
        match query {
            SettingsQuery::DesiredReadModel { call, reply } => {
                let result = async {
                    call.running().await?;
                    let snapshot = state.desired_read_model();
                    call.finish(
                        platform::call::CallStatus::Succeeded,
                        &SettingsCallDetail::new(SettingsOperation::ReadCurrent),
                    )
                    .await?;
                    Ok(snapshot)
                }
                .await;
                if let Err(error) = &result {
                    eprintln!(
                        "settings call {} audit read failed: {error}",
                        call.id().as_str()
                    );
                }
                let _ = reply.send(result);
            }
            SettingsQuery::GatewayAutoStart { reply } => {
                let _ = reply.send(state.gateway_auto_start());
            }
        }
    }

    async fn handle_exclusive_query(
        _shared: Self::Shared,
        _state: &mut Self::GlobalState,
        _query: Self::Query,
    ) {
    }
}
