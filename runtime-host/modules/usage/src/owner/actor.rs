use std::sync::Arc;

use foundation::execution::{LaneRetention, OwnerSpec};
use platform::call::{CallContext, CallStatus};

use crate::{
    application::{
        call::{self, CallFailure, UsageCallDetail},
        commands::{UsageCommand, UsageOwnerKey, UsageQuery},
    },
    domain::model::{UsageEntry, UsageReadError},
    ports::{UsageRequestAdmission, UsageRuntimeDirectory},
};

pub struct UsageOwnerInput {
    pub admission: Arc<dyn UsageRequestAdmission>,
    pub runtime_directory: Arc<dyn UsageRuntimeDirectory>,
}

#[derive(Clone)]
pub(crate) struct UsageShared {
    admission: Arc<dyn UsageRequestAdmission>,
    runtime_directory: Arc<dyn UsageRuntimeDirectory>,
}

pub(crate) struct UsageGlobalState;
pub(crate) struct UsageLaneState;

pub(crate) struct UsageOwner {
    shared: UsageShared,
}

impl UsageOwner {
    pub fn new(input: UsageOwnerInput) -> Self {
        Self {
            shared: UsageShared {
                admission: input.admission,
                runtime_directory: input.runtime_directory,
            },
        }
    }

    pub const fn lane_retention() -> LaneRetention {
        LaneRetention::LowFrequency
    }
}

impl OwnerSpec for UsageOwner {
    type Command = UsageCommand;
    type Query = UsageQuery;
    type Key = UsageOwnerKey;
    type Shared = UsageShared;
    type GlobalState = UsageGlobalState;
    type LaneState = UsageLaneState;

    fn split(self) -> (Self::Shared, Self::GlobalState) {
        (self.shared, UsageGlobalState)
    }

    fn route_command(command: &Self::Command) -> foundation::execution::CommandRoute<Self::Key> {
        command.route()
    }

    fn route_query(query: &Self::Query) -> foundation::execution::QueryRoute<Self::Key> {
        query.route()
    }

    fn open_lane(_shared: &Self::Shared, _key: &Self::Key) -> Self::LaneState {
        UsageLaneState
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
            UsageQuery::Recent { limit, call, reply } => {
                let _ = reply.send(recent(&shared, limit, call.as_ref()).await);
            }
            UsageQuery::SessionTimeseries {
                agent_id,
                session_id,
                call,
                reply,
            } => {
                let _ = reply
                    .send(session_timeseries(&shared, &agent_id, &session_id, call.as_ref()).await);
            }
            UsageQuery::DefaultLimit { reply } => {
                let _ = reply.send(default_limit(&shared));
            }
            UsageQuery::MaxLimit { reply } => {
                let _ = reply.send(max_limit(&shared));
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

async fn recent(
    shared: &UsageShared,
    limit: usize,
    context: Option<&CallContext<UsageCallDetail>>,
) -> Result<Vec<UsageEntry>, UsageReadError> {
    let detail = UsageCallDetail::recent(limit);
    admit(shared, context, UsageCallDetail::recent(limit)).await?;
    let result = match shared.runtime_directory.usage_ops() {
        Some(ops) => ops.usage_recent(limit).await,
        None => Err(UsageReadError::Unavailable),
    };
    settle(context, detail, &result).await;
    result
}

async fn session_timeseries(
    shared: &UsageShared,
    agent_id: &str,
    session_id: &str,
    context: Option<&CallContext<UsageCallDetail>>,
) -> Result<Vec<UsageEntry>, UsageReadError> {
    admit(shared, context, UsageCallDetail::session_timeseries()).await?;
    let result = match shared.runtime_directory.usage_ops() {
        Some(ops) => ops.session_usage_timeseries(agent_id, session_id).await,
        None => Err(UsageReadError::Unavailable),
    };
    settle(context, UsageCallDetail::session_timeseries(), &result).await;
    result
}

async fn admit(
    shared: &UsageShared,
    context: Option<&CallContext<UsageCallDetail>>,
    detail: UsageCallDetail,
) -> Result<(), UsageReadError> {
    if shared.admission.admit_usage_request().is_err() {
        call::finish(
            context,
            CallStatus::Rejected,
            &detail.failed(CallFailure::AdmissionClosed),
        )
        .await;
        return Err(UsageReadError::Unavailable);
    }
    if let Some(context) = context {
        let recorded = async {
            context.accepted().await?;
            context.running().await
        }
        .await;
        if let Err(error) = recorded {
            eprintln!(
                "[usage:call] admission record failed call_id={} error={error}",
                context.id().as_str()
            );
            call::finish(
                Some(context),
                CallStatus::Rejected,
                &detail.failed(CallFailure::RecordingUnavailable),
            )
            .await;
            return Err(UsageReadError::Unavailable);
        }
    }
    Ok(())
}

async fn settle(
    context: Option<&CallContext<UsageCallDetail>>,
    detail: UsageCallDetail,
    result: &Result<Vec<UsageEntry>, UsageReadError>,
) {
    let status = if result.is_ok() {
        CallStatus::Succeeded
    } else {
        CallStatus::Failed
    };
    call::finish(context, status, &detail.observed(result)).await;
}

fn default_limit(shared: &UsageShared) -> usize {
    shared
        .runtime_directory
        .usage_ops()
        .map_or(100, |ops| ops.default_usage_limit())
}

fn max_limit(shared: &UsageShared) -> usize {
    shared
        .runtime_directory
        .usage_ops()
        .map_or(1_000, |ops| ops.max_usage_limit())
}
