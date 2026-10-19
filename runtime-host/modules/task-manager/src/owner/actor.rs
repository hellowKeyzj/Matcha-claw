use std::sync::Arc;

use foundation::execution::{LaneRetention, OwnerSpec};

use crate::{
    TaskExecution, TaskFailure, TaskFailureCode, TaskFailureStage,
    application::{
        call::{CallFailure, record_error},
        commands::{TaskCommand, TaskOwnerKey, TaskQuery},
    },
    domain::model::{TaskCommand as RuntimeCommand, TaskOutcome, TaskRuntimeFailure},
    ports::{TaskRequestAdmission, TaskRuntimeDirectory, TaskSessionPreparation, failure_for_unavailable_ops},
};

pub struct TaskOwnerInput {
    pub admission: Arc<dyn TaskRequestAdmission>,
    pub runtime_directory: Arc<dyn TaskRuntimeDirectory>,
    pub session_preparation: Arc<dyn TaskSessionPreparation>,
}

#[derive(Clone)]
pub(crate) struct TaskShared {
    admission: Arc<dyn TaskRequestAdmission>,
    runtime_directory: Arc<dyn TaskRuntimeDirectory>,
    session_preparation: Arc<dyn TaskSessionPreparation>,
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
                session_preparation: input.session_preparation,
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
        shared: Self::Shared,
        _key: Self::Key,
        _lane: &mut Self::LaneState,
        command: Self::Command,
    ) {
        execute_command(&shared, command).await;
    }

    async fn handle_global_command(
        shared: Self::Shared,
        _global: &mut Self::GlobalState,
        command: Self::Command,
    ) {
        execute_command(&shared, command).await;
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

async fn execute_command(shared: &TaskShared, command: TaskCommand) {
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
            let (execution, failure) = execute_task(shared, command).await;
            if let Some(call) = &mut call {
                call.detail.failure = failure;
                call.detail.diagnostic = execution.failure;
                let status = call.detail.finish(&execution.outcome);
                record_error(call.context.finish(status, &call.detail).await);
            }
            let _ = reply.send(execution);
        }
    }
}

async fn execute_task(
    shared: &TaskShared,
    command: crate::domain::model::TaskCommand,
) -> (TaskExecution, Option<CallFailure>) {
    if shared.admission.admit_task_request().is_err() {
        return (
            TaskExecution::failed(
                TaskOutcome::unavailable(command),
                TaskFailure::new(TaskFailureStage::Admission, TaskFailureCode::AdmissionClosed),
            ),
            Some(CallFailure::AdmissionClosed),
        );
    }
    let Some(ops) = shared.runtime_directory.task_ops(command.scope()) else {
        return (
            TaskExecution::failed(
                failure_for_unavailable_ops(command),
                TaskFailure::new(TaskFailureStage::Runtime, TaskFailureCode::Unsupported),
            ),
            Some(CallFailure::Unsupported),
        );
    };
    if !ops.task_runtime_ready() {
        return (
            TaskExecution::failed(
                TaskOutcome::from_failure(command, TaskRuntimeFailure::Unavailable),
                TaskFailure::new(TaskFailureStage::Runtime, TaskFailureCode::RuntimeNotReady),
            ),
            Some(CallFailure::Unavailable),
        );
    }
    let target = match &command {
        RuntimeCommand::Create { target, .. } | RuntimeCommand::Update { target, .. } => {
            Some(target.session())
        }
        RuntimeCommand::TodoWrite { target, .. } => Some(target),
        RuntimeCommand::List { .. } | RuntimeCommand::Get { .. } | RuntimeCommand::TodoGet { .. } => None,
    };
    if let Some(target) = target {
        if let Err(failure) = shared.session_preparation.prepare(target).await {
            return (
                TaskExecution::failed(
                    TaskOutcome::from_failure(command, TaskRuntimeFailure::TargetRejected),
                    failure,
                ),
                None,
            );
        }
    }
    (ops.task_manager(command).await, None)
}
