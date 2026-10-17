use std::sync::Arc;

use foundation::execution::{OwnedTask, TaskHandle};
use futures_util::{FutureExt, future::Shared};
use platform::call::{CallContext, CallFuture, CallLogError, CallReceipt, CallRecorder, CallStatus};
use tokio::sync::{Mutex, mpsc, oneshot};

use crate::{ConfigurationOutcome, Operation, OperationOutcome, call, ports::{AgentPluginsPort, PluginsPort}};

pub(crate) struct Operations {
    sender: mpsc::Sender<Command>,
    task: Mutex<Option<OwnedTask<()>>>,
    lifecycle: TaskHandle,
}

pub(crate) enum Mutation {
    Configuration { plugin_id: String, enabled: bool },
    Operation { plugin_id: String, operation: Operation },
}

impl Mutation {
    fn detail(&self, outcome: Option<call::Outcome>) -> call::Detail {
        match self {
            Self::Configuration { plugin_id, enabled } => call::Detail::Configuration {
                plugin_id: call::plugin_identity(plugin_id), enabled: *enabled, outcome,
            },
            Self::Operation { plugin_id, operation } => call::Detail::Operation {
                plugin_id: call::plugin_identity(plugin_id), operation: *operation, outcome,
            },
        }
    }

    fn command(&self) -> &'static str {
        match self {
            Self::Configuration { .. } => "plugins.setEnabled",
            Self::Operation { .. } => "plugins.operation",
        }
    }
}

pub(crate) enum Target {
    OpenClaw(Arc<dyn PluginsPort>),
    Agent { plugins: Arc<dyn AgentPluginsPort>, agent_id: String },
}

struct Command {
    target: Target,
    mutation: Mutation,
    context: CallContext<call::Detail>,
    accepted: Shared<CallFuture<CallReceipt>>,
    reply: oneshot::Sender<call::Outcome>,
}

impl Operations {
    pub(crate) fn spawn() -> Self {
        let (sender, mut receiver) = mpsc::channel::<Command>(32);
        let (task, lifecycle) = OwnedTask::spawn(move |cancellation| async move {
            let mut closing = false;
            loop {
                let command = tokio::select! {
                    biased;
                    _ = cancellation.cancelled(), if !closing => {
                        closing = true;
                        receiver.close();
                        continue;
                    },
                    command = receiver.recv() => match command {
                        Some(command) => command,
                        None => break,
                    },
                };
                let outcome = if command.accepted.await.is_err() {
                    call::Outcome::Rejected
                } else {
                    match command.context.running().await {
                        Ok(()) => execute(&command.target, &command.mutation).await,
                        Err(_) => {
                            eprintln!("[plugins-call] running transition failed");
                            call::Outcome::Unknown
                        }
                    }
                };
                let detail = command.mutation.detail(Some(outcome));
                if command.context.finish(status(outcome), &detail).await.is_err() {
                    eprintln!("[plugins-call] terminal transition failed");
                }
                let _ = command.reply.send(outcome);
            }
        });
        Self { sender, task: Mutex::new(Some(task)), lifecycle }
    }

    pub(crate) async fn submit(
        &self,
        recorder: &CallRecorder,
        target: Target,
        mutation: Mutation,
    ) -> Result<(CallReceipt, oneshot::Receiver<call::Outcome>), CallLogError> {
        let detail = mutation.detail(None);
        let context = recorder.begin(mutation.command(), &detail).await?;
        if self.lifecycle.is_cancelled()
            || matches!(&target, Target::OpenClaw(plugins) if plugins.admit_mutation().is_err()) {
            let detail = mutation.detail(Some(call::Outcome::Rejected));
            context.finish(CallStatus::Rejected, &detail).await?;
            return Err(CallLogError::Unavailable);
        }
        let permit = match self.sender.clone().try_reserve_owned() {
            Ok(permit) => permit,
            Err(error) => {
                let detail = mutation.detail(Some(call::Outcome::Rejected));
                context.finish(CallStatus::Rejected, &detail).await?;
                return Err(match error {
                    mpsc::error::TrySendError::Full(_) => CallLogError::QueueFull,
                    mpsc::error::TrySendError::Closed(_) => CallLogError::Unavailable,
                });
            }
        };
        let admission_context = context.clone();
        let accepted: CallFuture<CallReceipt> = Box::pin(async move { admission_context.accepted().await });
        let accepted = accepted.shared();
        let (reply, receiver) = oneshot::channel();
        permit.send(Command { target, mutation, context, accepted: accepted.clone(), reply });
        Ok((accepted.await?, receiver))
    }

    pub(crate) async fn stop(&self) {
        if let Some(mut task) = self.task.lock().await.take() {
            if task.cancel_and_join().await.is_err() {
                eprintln!("[plugins-call] shutdown join failed");
            }
        }
    }
}

async fn execute(target: &Target, mutation: &Mutation) -> call::Outcome {
    match (target, mutation) {
        (Target::OpenClaw(plugins), Mutation::Configuration { plugin_id, enabled }) => plugins
            .set_enabled_admitted(plugin_id.clone(), *enabled).await
            .map(call::Outcome::from).unwrap_or(call::Outcome::Unknown),
        (Target::OpenClaw(plugins), Mutation::Operation { plugin_id, operation }) => plugins
            .operation_admitted(*operation, plugin_id.clone()).await
            .map(call::Outcome::from).unwrap_or(call::Outcome::Unknown),
        (Target::Agent { plugins, agent_id }, Mutation::Configuration { plugin_id, enabled }) =>
            plugins.set_enabled(agent_id, plugin_id, *enabled).await.into(),
        (Target::Agent { plugins, agent_id }, Mutation::Operation { plugin_id, operation }) =>
            plugins.operation(agent_id, *operation, plugin_id).await.into(),
    }
}

fn status(outcome: call::Outcome) -> CallStatus {
    match outcome {
        call::Outcome::Configured => CallStatus::Succeeded,
        call::Outcome::Rejected => CallStatus::Rejected,
        call::Outcome::Unknown => CallStatus::Unknown,
    }
}

impl From<call::Outcome> for ConfigurationOutcome {
    fn from(outcome: call::Outcome) -> Self {
        match outcome {
            call::Outcome::Configured => Self::Configured,
            call::Outcome::Rejected => Self::Rejected,
            call::Outcome::Unknown => Self::Unknown,
        }
    }
}

impl From<call::Outcome> for OperationOutcome {
    fn from(outcome: call::Outcome) -> Self {
        match outcome {
            call::Outcome::Configured => Self::Configured,
            call::Outcome::Rejected => Self::Rejected,
            call::Outcome::Unknown => Self::Unknown,
        }
    }
}
