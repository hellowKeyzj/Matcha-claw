use std::sync::Arc;

use foundation::execution::{LaneRetention, OwnerSpec};

use crate::{
    application::{
        call::{CallFailure, record_error},
        commands::{TaskCommand, TaskOwnerKey, TaskQuery},
    },
    domain::model::{TaskOutcome, TaskRuntimeFailure},
    ports::{TaskRequestAdmission, TaskRuntimeDirectory, failure_for_unavailable_ops},
};

pub struct TaskOwnerInput {
    pub admission: Arc<dyn TaskRequestAdmission>,
    pub runtime_directory: Arc<dyn TaskRuntimeDirectory>,
}

#[derive(Clone)]
pub(crate) struct TaskShared {
    admission: Arc<dyn TaskRequestAdmission>,
    runtime_directory: Arc<dyn TaskRuntimeDirectory>,
}

pub(crate) struct TaskGlobalState;
pub(crate) struct TaskLaneState;

pub(crate) struct TaskOwner {
    shared: TaskShared,
}

impl TaskOwner {
    pub fn new(input: TaskOwnerInput) -> Self {
        Self {
            shared: TaskShared {
                admission: input.admission,
                runtime_directory: input.runtime_directory,
            },
        }
    }

    pub const fn lane_retention() -> LaneRetention {
        LaneRetention::LowFrequency
    }
}

impl OwnerSpec for TaskOwner {
    type Command = TaskCommand;
    type Query = TaskQuery;
    type Key = TaskOwnerKey;
    type Shared = TaskShared;
    type GlobalState = TaskGlobalState;
    type LaneState = TaskLaneState;

    fn split(self) -> (Self::Shared, Self::GlobalState) {
        (self.shared, TaskGlobalState)
    }

    fn route_command(command: &Self::Command) -> foundation::execution::CommandRoute<Self::Key> {
        command.route()
    }

    fn route_query(query: &Self::Query) -> foundation::execution::QueryRoute<Self::Key> {
        query.route()
    }

    fn open_lane(_shared: &Self::Shared, _key: &Self::Key) -> Self::LaneState {
        TaskLaneState
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
            TaskCommand::Execute {
                command,
                mut call,
                reply,
            } => {
                if let Some(call) = &call {
                    record_error(call.context.accepted().await.map(|_| ()));
                    record_error(call.context.running().await);
                }
                let (outcome, failure) = execute_task(&shared, command).await;
                if let Some(call) = &mut call {
                    call.detail.failure = failure;
                    let status = call.detail.finish(&outcome);
                    record_error(call.context.finish(status, &call.detail).await);
                }
                let _ = reply.send(outcome);
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
        _shared: Self::Shared,
        _global: &mut Self::GlobalState,
        _query: Self::Query,
    ) {
    }

    async fn handle_exclusive_query(
        shared: Self::Shared,
        global: &mut Self::GlobalState,
        query: Self::Query,
    ) {
        Self::handle_global_query(shared, global, query).await;
    }
}

async fn execute_task(
    shared: &TaskShared,
    command: crate::domain::model::TaskCommand,
) -> (TaskOutcome, Option<CallFailure>) {
    if shared.admission.admit_task_request().is_err() {
        return (
            TaskOutcome::unavailable(command),
            Some(CallFailure::AdmissionClosed),
        );
    }
    let Some(ops) = shared.runtime_directory.task_ops() else {
        return (
            failure_for_unavailable_ops(command),
            Some(CallFailure::Unsupported),
        );
    };
    if !ops.task_runtime_ready() {
        return (
            TaskOutcome::from_failure(command, TaskRuntimeFailure::Unavailable),
            Some(CallFailure::Unavailable),
        );
    }
    (ops.task_manager(command).await, None)
}
