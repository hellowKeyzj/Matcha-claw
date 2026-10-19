use tokio::sync::oneshot;

use crate::{
    TaskExecution, application::call::TaskCall, domain::model::TaskCommand as TaskManagerCommand,
};

pub(crate) enum TaskCommand {
    Execute {
        command: TaskManagerCommand,
        call: Option<TaskCall>,
        reply: oneshot::Sender<TaskExecution>,
    },
}

pub(crate) enum TaskQuery {}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct TaskOwnerKey(String);

impl TaskCommand {
    pub(crate) fn route(&self) -> foundation::execution::CommandRoute<TaskOwnerKey> {
        let Self::Execute { command, .. } = self;
        let platform::endpoint::runtime_address::RuntimeScope::Session(identity) = command.scope() else {
            return foundation::execution::CommandRoute::Exclusive;
        };
        let scope_key = identity.endpoint().canonical_key();
        let key = match command {
            TaskManagerCommand::List { target }
            | TaskManagerCommand::Get { target, .. }
            | TaskManagerCommand::Create { target, .. }
            | TaskManagerCommand::Update { target, .. } => match target.team_key() {
                Some(team_key) => scope_lane_key(&format!("team:{team_key}")),
                None => scope_lane_key(target.session_key()),
            },
            TaskManagerCommand::TodoWrite { target, .. }
            | TaskManagerCommand::TodoGet { target } => {
                scope_lane_key(target.session_key())
            }
        };
        #[cfg(windows)]
        if !key.0.is_ascii() || key.0.ends_with(['.', ' ']) {
            return foundation::execution::CommandRoute::Exclusive;
        }
        foundation::execution::CommandRoute::Keyed(TaskOwnerKey(format!("{scope_key}:{}", key.0)))
    }
}

// Coalesce native task/todo path aliases; the request's scope identity stays unchanged.
fn scope_lane_key(scope: &str) -> TaskOwnerKey {
    let key: String = scope
        .chars()
        .map(|ch| match ch {
            '\u{0}'..='\u{1f}' | '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            ch => ch,
        })
        .collect();
    #[cfg(windows)]
    let key = key.to_ascii_lowercase();
    TaskOwnerKey(key)
}

impl TaskQuery {
    pub(crate) fn route(&self) -> foundation::execution::QueryRoute<TaskOwnerKey> {
        foundation::execution::QueryRoute::Global
    }
}
