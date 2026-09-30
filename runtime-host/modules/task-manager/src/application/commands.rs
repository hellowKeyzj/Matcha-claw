use tokio::sync::oneshot;

use crate::{
    application::call::TaskCall,
    domain::model::{TaskCommand as TaskManagerCommand, TaskOutcome},
};

pub(crate) enum TaskCommand {
    Execute {
        command: TaskManagerCommand,
        call: Option<TaskCall>,
        reply: oneshot::Sender<TaskOutcome>,
    },
}

pub(crate) enum TaskQuery {}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) enum TaskOwnerKey {}

impl TaskCommand {
    pub(crate) fn route(&self) -> foundation::execution::CommandRoute<TaskOwnerKey> {
        foundation::execution::CommandRoute::Global
    }
}

impl TaskQuery {
    pub(crate) fn route(&self) -> foundation::execution::QueryRoute<TaskOwnerKey> {
        foundation::execution::QueryRoute::Global
    }
}
