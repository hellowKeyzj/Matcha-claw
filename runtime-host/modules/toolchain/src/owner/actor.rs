use std::sync::Arc;

use foundation::execution::{LaneRetention, OwnerSpec};

use crate::{
    NativeToolchain, PrepareOutcome, ToolchainRequestAdmissionClosed, ToolchainStatus,
    application::commands::{ToolchainCommand, ToolchainOwnerKey, ToolchainQuery},
    ports::ToolchainRequestAdmission,
};

pub struct ToolchainOwnerInput {
    pub admission: Arc<dyn ToolchainRequestAdmission>,
    pub toolchain: Arc<NativeToolchain>,
}

#[derive(Clone)]
pub(crate) struct ToolchainShared {
    admission: Arc<dyn ToolchainRequestAdmission>,
    toolchain: Arc<NativeToolchain>,
}

pub(crate) struct ToolchainGlobalState;
pub(crate) struct ToolchainLaneState;

pub(crate) struct ToolchainOwner {
    shared: ToolchainShared,
}

impl ToolchainOwner {
    pub fn new(input: ToolchainOwnerInput) -> Self {
        Self {
            shared: ToolchainShared {
                admission: input.admission,
                toolchain: input.toolchain,
            },
        }
    }

    pub const fn lane_retention() -> LaneRetention {
        LaneRetention::LowFrequency
    }
}

impl OwnerSpec for ToolchainOwner {
    type Command = ToolchainCommand;
    type Query = ToolchainQuery;
    type Key = ToolchainOwnerKey;
    type Shared = ToolchainShared;
    type GlobalState = ToolchainGlobalState;
    type LaneState = ToolchainLaneState;

    fn split(self) -> (Self::Shared, Self::GlobalState) {
        (self.shared, ToolchainGlobalState)
    }

    fn route_command(command: &Self::Command) -> foundation::execution::CommandRoute<Self::Key> {
        command.route()
    }

    fn route_query(query: &Self::Query) -> foundation::execution::QueryRoute<Self::Key> {
        query.route()
    }

    fn open_lane(_shared: &Self::Shared, _key: &Self::Key) -> Self::LaneState {
        ToolchainLaneState
    }

    async fn handle_keyed_command(
        _shared: Self::Shared,
        _key: Self::Key,
        _lane: &mut Self::LaneState,
        _command: Self::Command,
    ) {
    }

    async fn handle_global_command(
        shared: Self::Shared,
        _global: &mut Self::GlobalState,
        command: Self::Command,
    ) {
        match command {
            ToolchainCommand::Prepare { reply } => {
                let _ = reply.send(prepare(&shared).await);
            }
        }
    }

    async fn handle_direct_query(_shared: Self::Shared, _query: Self::Query) {}

    async fn handle_keyed_query(
        _shared: Self::Shared,
        _key: Self::Key,
        _lane: &mut Self::LaneState,
        _query: Self::Query,
    ) {
    }

    async fn handle_global_query(
        shared: Self::Shared,
        _global: &mut Self::GlobalState,
        query: Self::Query,
    ) {
        match query {
            ToolchainQuery::Status { reply } => {
                let _ = reply.send(status(&shared).await);
            }
        }
    }

    async fn handle_exclusive_query(
        shared: Self::Shared,
        global: &mut Self::GlobalState,
        query: Self::Query,
    ) {
        Self::handle_global_query(shared, global, query).await;
    }
}

async fn status(
    shared: &ToolchainShared,
) -> Result<ToolchainStatus, ToolchainRequestAdmissionClosed> {
    shared.admission.admit_toolchain_request()?;
    Ok(shared.toolchain.status().await)
}

async fn prepare(
    shared: &ToolchainShared,
) -> Result<PrepareOutcome, ToolchainRequestAdmissionClosed> {
    shared.admission.admit_toolchain_request()?;
    Ok(shared.toolchain.prepare().await)
}
