use std::sync::Arc;

use foundation::execution::{LaneRetention, OwnerSpec};

use crate::{
    PlatformToolsOutcome,
    application::commands::{PlatformToolsCommand, PlatformToolsOwnerKey, PlatformToolsQuery},
    ports::{PlatformToolsOps, PlatformToolsRequestAdmission},
};

pub struct PlatformToolsOwnerInput {
    pub admission: Arc<dyn PlatformToolsRequestAdmission>,
    pub tools: Arc<dyn PlatformToolsOps>,
}

#[derive(Clone)]
pub(crate) struct PlatformToolsShared {
    admission: Arc<dyn PlatformToolsRequestAdmission>,
    tools: Arc<dyn PlatformToolsOps>,
}

pub(crate) struct PlatformToolsGlobalState;
pub(crate) struct PlatformToolsLaneState;

pub(crate) struct PlatformToolsOwner {
    shared: PlatformToolsShared,
}

impl PlatformToolsOwner {
    pub fn new(input: PlatformToolsOwnerInput) -> Self {
        Self {
            shared: PlatformToolsShared {
                admission: input.admission,
                tools: input.tools,
            },
        }
    }

    pub const fn lane_retention() -> LaneRetention {
        LaneRetention::LowFrequency
    }
}

impl OwnerSpec for PlatformToolsOwner {
    type Command = PlatformToolsCommand;
    type Query = PlatformToolsQuery;
    type Key = PlatformToolsOwnerKey;
    type Shared = PlatformToolsShared;
    type GlobalState = PlatformToolsGlobalState;
    type LaneState = PlatformToolsLaneState;

    fn split(self) -> (Self::Shared, Self::GlobalState) {
        (self.shared, PlatformToolsGlobalState)
    }

    fn route_command(command: &Self::Command) -> foundation::execution::CommandRoute<Self::Key> {
        command.route()
    }

    fn route_query(query: &Self::Query) -> foundation::execution::QueryRoute<Self::Key> {
        query.route()
    }

    fn open_lane(_shared: &Self::Shared, _key: &Self::Key) -> Self::LaneState {
        PlatformToolsLaneState
    }

    async fn handle_keyed_command(
        _shared: Self::Shared,
        _key: Self::Key,
        _lane: &mut Self::LaneState,
        _command: Self::Command,
    ) {
    }

    async fn handle_global_command(
        _shared: Self::Shared,
        _global: &mut Self::GlobalState,
        command: Self::Command,
    ) {
        match command {}
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
            PlatformToolsQuery::List { reply } => {
                let _ = reply.send(list_tools(&shared).await);
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

async fn list_tools(shared: &PlatformToolsShared) -> PlatformToolsOutcome {
    if shared.admission.admit_platform_tools_request().is_err()
        || !shared.tools.platform_tools_ready()
    {
        return PlatformToolsOutcome::Unavailable;
    }
    shared.tools.platform_tools().await
}
