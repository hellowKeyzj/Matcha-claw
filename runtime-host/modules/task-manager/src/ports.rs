use std::{future::Future, pin::Pin};

use crate::{
    TaskExecution,
    domain::model::{TaskCommand, TaskOutcome, TaskRuntimeFailure},
};

pub type TaskFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait TaskRequestAdmission: Send + Sync {
    fn admit_task_request(&self) -> Result<(), TaskRequestAdmissionClosed>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TaskRequestAdmissionClosed;

pub trait TaskRuntimeDirectory: Send + Sync {
    fn task_ops(&self, scope: &platform::endpoint::runtime_address::RuntimeScope) -> Option<&dyn TaskOps>;
}

pub trait TaskSessionPreparation: Send + Sync {
    fn prepare<'a>(
        &'a self,
        target: &'a crate::SessionTarget,
    ) -> TaskFuture<'a, Result<(), crate::TaskFailure>>;
}

pub trait TaskOps: Send + Sync {
    fn task_manager<'a>(&'a self, command: TaskCommand) -> TaskFuture<'a, TaskExecution>;

    fn task_runtime_ready(&self) -> bool;
}

pub fn failure_for_unavailable_ops(command: TaskCommand) -> TaskOutcome {
    TaskOutcome::from_failure(command, TaskRuntimeFailure::Unsupported)
}
