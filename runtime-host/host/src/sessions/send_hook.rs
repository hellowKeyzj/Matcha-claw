use std::{future::Future, pin::Pin, sync::Arc};

use super::{SessionHandle, send::SessionSendCommand};

pub(crate) type SessionSendHookFuture<'a> =
    Pin<Box<dyn Future<Output = Result<SessionSendHookPrepared, ()>> + Send + 'a>>;

pub(crate) trait SessionSendHook: Send + Sync {
    fn before_send<'a>(
        &'a self,
        command: SessionSendCommand,
        now_millis: u64,
    ) -> SessionSendHookFuture<'a>;
}

pub(crate) trait SessionSendHookState: Send {
    fn after_queued(self: Box<Self>, session: SessionHandle, native_run_id: String);
}

pub(crate) struct SessionSendHookPrepared {
    pub(crate) command: SessionSendCommand,
    state: Option<Box<dyn SessionSendHookState>>,
}

impl SessionSendHookPrepared {
    pub(crate) fn unchanged(command: SessionSendCommand) -> Self {
        Self {
            command,
            state: None,
        }
    }

    pub(crate) fn with_state(
        command: SessionSendCommand,
        state: Box<dyn SessionSendHookState>,
    ) -> Self {
        Self {
            command,
            state: Some(state),
        }
    }
}

pub(crate) struct PreparedSessionSend {
    command: SessionSendCommand,
    states: Vec<Box<dyn SessionSendHookState>>,
}

impl PreparedSessionSend {
    pub(crate) fn into_parts(self) -> (SessionSendCommand, Vec<Box<dyn SessionSendHookState>>) {
        (self.command, self.states)
    }
}

#[derive(Clone, Default)]
pub(crate) struct SessionSendHookSet {
    hooks: Arc<[Arc<dyn SessionSendHook>]>,
}

impl SessionSendHookSet {
    pub(crate) fn new(hooks: Vec<Arc<dyn SessionSendHook>>) -> Self {
        Self {
            hooks: hooks.into(),
        }
    }

    pub(crate) async fn prepare(
        &self,
        mut command: SessionSendCommand,
        now_millis: u64,
    ) -> Result<PreparedSessionSend, ()> {
        let mut states = Vec::new();
        for hook in self.hooks.iter() {
            let prepared = hook.before_send(command, now_millis).await?;
            command = prepared.command;
            if let Some(state) = prepared.state {
                states.push(state);
            }
        }
        Ok(PreparedSessionSend { command, states })
    }

    pub(crate) fn after_queued(
        &self,
        states: Vec<Box<dyn SessionSendHookState>>,
        session: SessionHandle,
        native_run_id: String,
    ) {
        for state in states {
            state.after_queued(session.clone(), native_run_id.clone());
        }
    }
}
