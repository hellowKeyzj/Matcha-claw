use serde_json::{Value, json};
use std::sync::OnceLock;
use tokio::sync::Mutex;
use tokio_util::task::TaskTracker;

pub(super) enum Operation {
    Stop,
    Logout,
    Delete,
    Pair(String),
}

static ADMISSION: Mutex<()> = Mutex::const_new(());
static TASKS: OnceLock<TaskTracker> = OnceLock::new();
static CLEANUP_FAILURE: Mutex<Option<Error>> = Mutex::const_new(None);
fn tasks() -> &'static TaskTracker {
    TASKS.get_or_init(TaskTracker::new)
}

pub(super) async fn dispatch(
    operation: Operation,
    id: String,
    config: ConfigStore,
    sessions: Sessions,
) -> rpc::Result<Value> {
    let admission = ADMISSION.lock().await;
    if tasks().is_closed() {
        return Err(Error::unavailable(
            "channel_stopping",
            "Channels are shutting down",
        ));
    }
    let task = tasks().spawn(async move {
        let result = mutate(operation, id, config, sessions).await;
        if let Err(error) = &result
            && error.data.as_ref().is_some_and(|data| {
                ["cleanupError", "cleanupFailures", "failures"]
                    .iter()
                    .any(|key| data.get(*key).is_some())
                    || data.get("cleanupComplete") == Some(&Value::Bool(false))
            })
        {
            CLEANUP_FAILURE
                .lock()
                .await
                .get_or_insert_with(|| error.clone());
        }
        result
    });
    drop(admission);
    task.await.map_err(|source| {
        Error::new(
            -32006,
            "channel_operation_unknown",
            "Channel cleanup outcome could not be confirmed",
        )
        .with_source(source)
    })?
}

pub(super) async fn shutdown() -> rpc::Result<()> {
    let admission = ADMISSION.lock().await;
    tasks().close();
    drop(admission);
    tasks().wait().await;
    match CLEANUP_FAILURE.lock().await.as_ref() {
        Some(error) => Err(error.clone()),
        None => Ok(()),
    }
}

use super::{Definition, definition, login};
use crate::{
    cli::command,
    config::ConfigStore,
    rpc::{self, Error},
    session::Sessions,
};

async fn mutate(
    operation: Operation,
    id: String,
    config: ConfigStore,
    sessions: Sessions,
) -> rpc::Result<Value> {
    let snapshot = config.snapshot().await;
    let expected = snapshot.channels.get(&id).cloned();
    let binding = definition(&snapshot, &id)?;
    let _admission = sessions.agent_guard(&binding.agent_id).await;
    let snapshot = config.snapshot().await;
    if snapshot.channels.get(&id) != expected.as_ref() {
        return Err(Error::conflict(
            "channel_changed",
            "The channel binding changed before cleanup",
        ));
    }
    if let Operation::Pair(code) = operation {
        command::run(
            &snapshot,
            config.paths(),
            &binding.agent_id,
            vec!["weixin".into(), "access".into(), "pair".into(), code],
        )
        .await
        .map_err(|error| error.with_data(json!({"stage":"nativePair","outcome":"unknown"})))?;
        return Ok(json!({"id":id,"paired":true,"application":"nativeAccessStore"}));
    }
    if !matches!(operation, Operation::Stop) {
        for (other_id, value) in &snapshot.channels {
            let other: Definition = serde_json::from_value(value.clone())
                .map_err(|_| Error::invalid("Stored channel definition is invalid"))?;
            if *other_id != id
                && other.agent_id == binding.agent_id
                && other.source == binding.source
            {
                return Err(Error::conflict(
                    "channel_account_shared",
                    "Other bindings reference this Agent's single native account; remove the ambiguity before clearing credentials",
                ));
            }
        }
        login::cancel(&id, &binding.agent_id, None)
            .await
            .map_err(|error| {
                error.with_data(
                    json!({"stage":"loginCleanup","credentialsCleared":false,"outcome":"unknown"}),
                )
            })?;
    }
    if let Some(session_id) = &binding.session_id {
        sessions
            .dispatch("sessions.close", json!({"sessionId":session_id}))
            .await
            .map_err(|error| {
                error.with_data(
                    json!({"stage":"consumerClose","credentialsCleared":false,"outcome":"unknown"}),
                )
            })?;
        let native = sessions.native_snapshot(session_id).await.map_err(|error| {
            error.with_data(json!({"stage":"consumerObservation","credentialsCleared":false,"outcome":"unknown"}))
        })?;
        if native
            .get("instanceId")
            .is_some_and(|value| !value.is_null())
            || native.get("launching").and_then(Value::as_bool) == Some(true)
        {
            return Err(Error::new(
                -32006,
                "channel_consumer_cleanup",
                "The bound native consumer could not be confirmed stopped",
            ).with_data(json!({"stage":"consumerObservation","credentialsCleared":false,"outcome":"unknown"})));
        }
    }
    if matches!(operation, Operation::Stop) {
        return Ok(
            json!({"id":id,"stopped":true,"application":"boundSessionClosed","credentialsCleared":false}),
        );
    }
    command::run(
        &snapshot,
        config.paths(),
        &binding.agent_id,
        vec!["weixin".into(), "login".into(), "clear".into()],
    )
    .await
    .map_err(|error| {
        error.with_data(
            json!({"stage":"nativeAccountClear","consumerStopped":true,"outcome":"unknown"}),
        )
    })?;
    if matches!(operation, Operation::Delete) {
        let channel_id = id.clone();
        config.update(move |config| {
            if config.channels.get(&channel_id) != expected.as_ref() {
                return Err(Error::conflict("channel_changed", "The channel binding changed before deletion"));
            }
            config.channels.remove(&channel_id);
            for agent in config.agents.values_mut() {
                agent.channels.retain(|channel| channel != &channel_id);
            }
            Ok(())
        }).await.map_err(|error| error.with_data(json!({"stage":"configDelete","consumerStopped":true,"credentialsCleared":true,"outcome":"partial"})))?;
        return Ok(
            json!({"id":id,"deleted":true,"stopped":true,"credentialsCleared":true,"nativeAccessRetained":true}),
        );
    }
    Ok(
        json!({"id":id,"cleared":true,"stopped":true,"application":"nativeAccountStore","nativeAccessRetained":true}),
    )
}
