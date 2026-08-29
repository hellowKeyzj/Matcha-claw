use std::sync::Arc;

use arc_swap::ArcSwap;
use foundation::execution::{CommandRoute, LaneRetention, OwnerSpec, QueryRoute};

use super::{
    SettingsCommand, SettingsQuery,
    desired::{
        self, Desired, Outcome, PendingDesired, PublicDesiredSnapshot, SettingsSnapshot, Settlement,
    },
};
use crate::{
    runtime_directory::RuntimeDriverDirectory,
    runtime_driver::{RuntimeOperationFailure, SettingsProjectionEffect},
};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) enum SettingsPartitionKey {
    Global,
}

#[derive(Clone)]
pub(crate) struct SettingsShared {
    runtime_directory: Arc<RuntimeDriverDirectory>,
}

pub(crate) struct SettingsGlobalState {
    state: desired::DesiredState,
    snapshot: Arc<ArcSwap<SettingsSnapshot>>,
}

pub(crate) struct SettingsOwner {
    shared: SettingsShared,
    global: SettingsGlobalState,
}

impl SettingsOwner {
    pub(crate) fn new(
        state: desired::DesiredState,
        runtime_directory: Arc<RuntimeDriverDirectory>,
    ) -> Self {
        let snapshot = Arc::new(ArcSwap::new(Arc::new(state.snapshot())));
        Self {
            shared: SettingsShared { runtime_directory },
            global: SettingsGlobalState { state, snapshot },
        }
    }

    pub(crate) const fn lane_retention() -> LaneRetention {
        LaneRetention::LowFrequency
    }
}

impl SettingsGlobalState {
    fn publish_snapshot(&self) {
        self.snapshot.store(Arc::new(self.state.snapshot()));
    }

    async fn replace(
        &mut self,
        shared: &SettingsShared,
        correlation: String,
        desired: Desired,
    ) -> Settlement {
        let (revision, prior_outcome) = self.state.replace(correlation, desired);
        self.publish_snapshot();
        if let Some(outcome) = prior_outcome {
            return Settlement { revision, outcome };
        }

        match self.state.pending() {
            Some(pending) if pending.revision == revision => {
                self.settle_pending(shared, pending, true).await
            }
            _ => Settlement::unknown(revision),
        }
    }

    async fn recover_pending(&mut self, shared: &SettingsShared) -> Option<Settlement> {
        let pending = self.state.pending()?;
        Some(self.settle_pending(shared, pending, true).await)
    }

    async fn apply_saved_projection(&mut self, shared: &SettingsShared) -> Outcome {
        self.apply_desired(shared, self.state.desired(), false)
            .await
    }

    async fn settle_pending(
        &mut self,
        shared: &SettingsShared,
        pending: PendingDesired,
        restart_changed_projection: bool,
    ) -> Settlement {
        let outcome = self
            .apply_desired(shared, pending.desired, restart_changed_projection)
            .await;
        self.state.settle(pending.revision, outcome);
        self.publish_snapshot();
        Settlement {
            revision: pending.revision,
            outcome,
        }
    }

    async fn apply_desired(
        &self,
        shared: &SettingsShared,
        desired: Desired,
        restart_changed_projection: bool,
    ) -> Outcome {
        let Some(driver) = shared.runtime_directory.settings_driver() else {
            return Outcome::Unknown;
        };
        let Some(settings) = driver.settings_ops() else {
            return Outcome::Unknown;
        };
        let (browser_mode, proxy_endpoint) = desired.projection();
        match settings
            .apply_settings_projection(browser_mode, proxy_endpoint)
            .await
        {
            Ok(SettingsProjectionEffect::Unchanged) => Outcome::Confirmed,
            Ok(SettingsProjectionEffect::Changed) => {
                let Some(lifecycle) = driver.lifecycle_ops() else {
                    return Outcome::Unknown;
                };
                if lifecycle.readiness() && !restart_changed_projection {
                    return Outcome::Unknown;
                }
                if !lifecycle.readiness() || lifecycle.restart().await.is_ok() {
                    Outcome::Confirmed
                } else {
                    Outcome::Unknown
                }
            }
            Err(RuntimeOperationFailure::TargetRejected) => Outcome::Rejected,
            Err(_) => Outcome::Unknown,
        }
    }

    fn pending(&self) -> Option<PendingDesired> {
        self.snapshot.load_full().pending.clone()
    }

    fn desired_snapshot(&self) -> PublicDesiredSnapshot {
        self.snapshot.load_full().desired.clone()
    }

    fn gateway_auto_start(&self) -> bool {
        self.snapshot.load_full().desired.gateway_auto_start
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
            SettingsCommand::Replace { .. }
            | SettingsCommand::RecoverPending { .. }
            | SettingsCommand::ApplySavedProjection { .. } => CommandRoute::Global,
        }
    }

    fn route_query(query: &Self::Query) -> QueryRoute<Self::Key> {
        match query {
            SettingsQuery::Pending { .. }
            | SettingsQuery::DesiredSnapshot { .. }
            | SettingsQuery::GatewayAutoStart { .. } => QueryRoute::Global,
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
            SettingsCommand::Replace {
                correlation,
                desired,
                reply,
            } => {
                let _ = reply.send(state.replace(&shared, correlation, desired).await);
            }
            SettingsCommand::RecoverPending { reply } => {
                let _ = reply.send(state.recover_pending(&shared).await);
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
            SettingsQuery::Pending { reply } => {
                let _ = reply.send(state.pending());
            }
            SettingsQuery::DesiredSnapshot { reply } => {
                let _ = reply.send(state.desired_snapshot());
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
