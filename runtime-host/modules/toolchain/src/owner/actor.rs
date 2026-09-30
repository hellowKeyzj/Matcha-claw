use std::sync::Arc;

use foundation::execution::{LaneRetention, OwnerSpec};
use platform::call::{CallContext, CallStatus};

use crate::{
    NativeToolchain, PrepareOutcome, ToolchainRequestAdmissionClosed, ToolchainStatus,
    application::{
        call::{self, CallFailure, ToolchainCallDetail},
        commands::{ToolchainCommand, ToolchainOwnerKey, ToolchainQuery},
    },
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
            ToolchainCommand::AdmitPrepare { call } => {
                if let Err(error) = call.running().await {
                    eprintln!(
                        "[toolchain:call] running record failed call_id={} error={error}",
                        call.id().as_str()
                    );
                    call::finish(
                        Some(&call),
                        CallStatus::Rejected,
                        &ToolchainCallDetail::prepare().failed(CallFailure::RecordingUnavailable),
                    )
                    .await;
                    return;
                }
                execute_prepare(&shared, Some(&call)).await;
            }
            ToolchainCommand::Prepare { call, reply } => {
                let _ = reply.send(prepare(&shared, call.as_ref()).await);
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
            ToolchainQuery::Status { call, reply } => {
                let _ = reply.send(status(&shared, call.as_ref()).await);
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
    context: Option<&CallContext<ToolchainCallDetail>>,
) -> Result<ToolchainStatus, ToolchainRequestAdmissionClosed> {
    admit(shared, context, ToolchainCallDetail::status()).await?;
    let status = shared.toolchain.status().await;
    call::finish(
        context,
        call::observed_status(&status),
        &ToolchainCallDetail::observed(&status),
    )
    .await;
    Ok(status)
}

async fn prepare(
    shared: &ToolchainShared,
    context: Option<&CallContext<ToolchainCallDetail>>,
) -> Result<PrepareOutcome, ToolchainRequestAdmissionClosed> {
    admit(shared, context, ToolchainCallDetail::prepare()).await?;
    Ok(execute_prepare(shared, context).await)
}

async fn execute_prepare(
    shared: &ToolchainShared,
    context: Option<&CallContext<ToolchainCallDetail>>,
) -> PrepareOutcome {
    let outcome = shared.toolchain.prepare().await;
    call::finish(
        context,
        call::prepared_status(outcome),
        &ToolchainCallDetail::prepared(outcome),
    )
    .await;
    outcome
}

async fn admit(
    shared: &ToolchainShared,
    context: Option<&CallContext<ToolchainCallDetail>>,
    detail: ToolchainCallDetail,
) -> Result<(), ToolchainRequestAdmissionClosed> {
    if let Err(error) = shared.admission.admit_toolchain_request() {
        call::finish(
            context,
            CallStatus::Rejected,
            &detail.failed(CallFailure::AdmissionClosed),
        )
        .await;
        return Err(error);
    }
    if let Some(context) = context {
        let recorded = async {
            context.accepted().await?;
            context.running().await
        }
        .await;
        if let Err(error) = recorded {
            eprintln!(
                "[toolchain:call] admission record failed call_id={} error={error}",
                context.id().as_str()
            );
            call::finish(
                Some(context),
                CallStatus::Rejected,
                &detail.failed(CallFailure::RecordingUnavailable),
            )
            .await;
            return Err(ToolchainRequestAdmissionClosed);
        }
    }
    Ok(())
}
