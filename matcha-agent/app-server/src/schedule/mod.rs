pub mod changes;
mod definition;
mod delivery;
mod store;

use std::{
    collections::BTreeMap,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    sync::{Mutex, Notify},
    task::JoinHandle,
};
use uuid::Uuid;

use crate::{
    config::{self, Config, ConfigStore},
    diagnostics::Diagnostics,
    events::Events,
    rpc::{self, Error},
    session::Sessions,
};
use definition::{Definition, Delivery, Pattern, Timing, next_fire};
use store::{Receipt, Store, Trigger};

// Only config/trigger commits are serialized, never execution or model waits.
static MUTATION: Mutex<()> = Mutex::const_new(());
static CHANGED: Notify = Notify::const_new();
static STOP: OnceLock<CancellationToken> = OnceLock::new();
static SUBMISSIONS: OnceLock<TaskTracker> = OnceLock::new();
static STOPPING: AtomicBool = AtomicBool::new(false);

fn submissions() -> &'static TaskTracker {
    SUBMISSIONS.get_or_init(TaskTracker::new)
}

/// Stop future triggers and wait for owned submission commits; the caller then joins start's handle.
pub async fn shutdown() -> rpc::Result<()> {
    let _guard = MUTATION.lock().await;
    STOPPING.store(true, Ordering::Release);
    if let Some(stop) = STOP.get() {
        stop.cancel();
    }
    submissions().close();
    drop(_guard);
    submissions().wait().await;
    Ok(())
}

struct WakeOnDrop;
impl Drop for WakeOnDrop {
    fn drop(&mut self) {
        CHANGED.notify_one();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListParams {
    agent_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GetParams {
    id: String,
    #[serde(default = "history_size")]
    limit: usize,
}
fn history_size() -> usize {
    20
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IdParams {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeleteParams {
    id: String,
    expected_revision: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WriteParams {
    id: Option<String>,
    expected_revision: Option<String>,
    agent_id: String,
    cron: Option<String>,
    schedule: Option<Pattern>,
    prompt: String,
    name: Option<String>,
    model: Option<String>,
    #[serde(default)]
    delivery: Delivery,
    #[serde(default = "enabled")]
    enabled: bool,
    #[serde(default = "enabled")]
    recurring: bool,
    session_id: Option<String>,
}
fn enabled() -> bool {
    true
}

impl WriteParams {
    fn definition(self) -> Definition {
        Definition {
            agent_id: self.agent_id,
            cron: self.cron,
            schedule: self.schedule,
            prompt: self.prompt,
            name: self.name,
            model: self.model,
            delivery: self.delivery,
            created_at_ms: Some(rpc::now_ms()),
            updated_at_ms: Some(rpc::now_ms()),
            enabled: self.enabled,
            recurring: self.recurring,
            session_id: self.session_id,
        }
    }
}

pub(crate) fn validate_config(config: &Config) -> rpc::Result<()> {
    for (id, value) in &config.schedules {
        config::validate_id(id)?;
        let definition: Definition = serde_json::from_value(value.clone())
            .map_err(|_| Error::invalid("Stored schedule definition is invalid"))?;
        definition.validate()?;
        if !config.agents.contains_key(&definition.agent_id) {
            return Err(Error::not_found("Schedule Agent"));
        }
    }
    Ok(())
}

async fn definition(config: &ConfigStore, id: &str) -> rpc::Result<Definition> {
    config::validate_id(id)?;
    let snapshot = config.snapshot().await;
    let value = snapshot
        .schedules
        .get(id)
        .ok_or_else(|| Error::not_found("Schedule"))?;
    let definition: Definition = serde_json::from_value(value.clone())
        .map_err(|_| Error::invalid("Stored schedule definition is invalid"))?;
    definition.validate()?;
    if !snapshot.agents.contains_key(&definition.agent_id) {
        return Err(Error::not_found("Agent"));
    }
    Ok(definition)
}

async fn sync(store: &Store, id: &str, definition: &Definition, reset: bool) -> rpc::Result<()> {
    let schedule = definition.validate()?;
    let next = if definition.enabled {
        match &schedule {
            Timing::At(at) => Some(*at),
            _ => next_fire(&schedule, rpc::now_ms())?,
        }
    } else {
        None
    };
    let owned_session_id = definition
        .session_id
        .is_none()
        .then(|| Uuid::new_v4().to_string());
    store
        .sync(
            id,
            definition,
            store::TriggerState {
                next_fire_ms: next,
                owned_session_id,
            },
            reset,
        )
        .await
}

async fn view(
    store: &Store,
    id: &str,
    definition: &Definition,
    limit: Option<usize>,
) -> rpc::Result<Value> {
    let receipts = store.receipts(id, limit.unwrap_or(1)).await?;
    let mut view = json!({"id":id,"revision":definition.fingerprint()?,"definition":definition,"state":store.state(id).await?,"lastReceipt":receipts.first(),"lastFinishedReceipt":store.finished(id).await?,"runningReceipt":store.running(id).await?});
    if limit.is_some() {
        view["receipts"] = rpc::value(receipts)?;
    }
    Ok(view)
}

pub async fn dispatch(
    method: &str,
    params: Value,
    config: &ConfigStore,
    sessions: &Sessions,
) -> rpc::Result<Value> {
    if !matches!(
        method,
        "schedules.list"
            | "schedules.get"
            | "schedules.history"
            | "schedules.create"
            | "schedules.update"
            | "schedules.delete"
            | "schedules.run"
    ) {
        return Err(Error::method(method));
    }
    let store = Store::open(&config.paths().database()).await?;
    match method {
        "schedules.list" => {
            let params: ListParams = rpc::params(params)?;
            if let Some(agent_id) = &params.agent_id {
                config::validate_id(agent_id)?;
            }
            let _guard = MUTATION.lock().await;
            let snapshot = config.snapshot().await;
            let mut schedules = Vec::new();
            for (id, value) in snapshot.schedules {
                let definition: Definition = serde_json::from_value(value)
                    .map_err(|_| Error::invalid("Stored schedule definition is invalid"))?;
                if params
                    .agent_id
                    .as_ref()
                    .is_some_and(|agent_id| *agent_id != definition.agent_id)
                {
                    continue;
                }
                sync(&store, &id, &definition, false).await?;
                schedules.push(view(&store, &id, &definition, None).await?);
            }
            Ok(json!({"schedules":schedules}))
        }
        "schedules.get" => {
            let params: GetParams = rpc::params(params)?;
            let _guard = MUTATION.lock().await;
            let definition = definition(config, &params.id).await?;
            sync(&store, &params.id, &definition, false).await?;
            view(&store, &params.id, &definition, Some(params.limit)).await
        }
        "schedules.history" => {
            let params: GetParams = rpc::params(params)?;
            config::validate_id(&params.id)?;
            let receipts = store.receipts(&params.id, params.limit).await?;
            if receipts.is_empty() && !config.snapshot().await.schedules.contains_key(&params.id) {
                return Err(Error::not_found("Schedule history"));
            }
            Ok(json!({"id":params.id,"receipts":receipts}))
        }
        "schedules.create" | "schedules.update" => {
            let params: WriteParams = rpc::params(params)?;
            let update = method == "schedules.update";
            let id = match (&params.id, update) {
                (Some(id), _) => id.clone(),
                (None, false) => Uuid::new_v4().to_string(),
                (None, true) => return Err(Error::invalid("Schedule update requires id")),
            };
            config::validate_id(&id)?;
            let expected_revision = params.expected_revision.clone();
            if !update && expected_revision.is_some() {
                return Err(Error::invalid("expectedRevision only applies to updates"));
            }
            let mut definition = params.definition();
            if !update
                && let Some(Pattern::Every { anchor_ms, .. }) = &mut definition.schedule
                && anchor_ms.is_none()
            {
                *anchor_ms = definition.created_at_ms;
            }
            let parsed = definition.validate()?;
            if !update && definition.enabled && next_fire(&parsed, rpc::now_ms())?.is_none() {
                return Err(Error::invalid("The schedule has no future occurrence"));
            }
            if let Some(session_id) = &definition.session_id {
                let session = sessions
                    .dispatch("sessions.get", json!({"sessionId":session_id}))
                    .await?;
                if session.get("agentId").and_then(Value::as_str) != Some(&definition.agent_id) {
                    return Err(Error::conflict(
                        "schedule_session_agent",
                        "The target session belongs to another Agent",
                    ));
                }
                if session.get("model").and_then(Value::as_str) != definition.model.as_deref() {
                    return Err(Error::conflict(
                        "schedule_session_model",
                        "The target session has a different native model override",
                    ));
                }
            }
            let guard = MUTATION.lock().await;
            if STOPPING.load(Ordering::Acquire) {
                return Err(Error::unavailable(
                    "schedule_stopping",
                    "The scheduler is shutting down",
                ));
            }
            let config = config.clone();
            let committed = submissions().spawn(async move {
                let _guard = guard;
                let _wake = WakeOnDrop;
                let stored_id = id.clone();
                let stored = definition.clone();
                config
                    .update(move |config| {
                        if !config.agents.contains_key(&stored.agent_id) {
                            return Err(Error::not_found("Agent"));
                        }
                        match (update, config.schedules.contains_key(&stored_id)) {
                            (true, false) => return Err(Error::not_found("Schedule")),
                            (false, true) => {
                                return Err(Error::conflict(
                                    "schedule_exists",
                                    "The schedule id already exists",
                                ));
                            }
                            _ => {}
                        }
                        let mut stored = stored;
                        if update {
                            let previous: Definition = serde_json::from_value(config.schedules[&stored_id].clone())
                                .map_err(|_| Error::invalid("Stored schedule definition is invalid"))?;
                            if expected_revision.as_ref().is_some_and(|expected| previous.fingerprint().as_ref().ok() != Some(expected)) {
                                return Err(Error::conflict("schedule_revision_conflict", "The schedule changed; read its current revision before updating"));
                            }
                            stored.created_at_ms = previous.created_at_ms;
                            if let Some(Pattern::Every { anchor_ms, .. }) = &mut stored.schedule
                                && anchor_ms.is_none()
                            {
                                *anchor_ms = match &previous.schedule {
                                    Some(Pattern::Every { anchor_ms, .. }) => *anchor_ms,
                                    _ => previous.created_at_ms,
                                }.or(Some(rpc::now_ms()));
                            }
                            if stored.enabled && stored.timing_fingerprint()? != previous.timing_fingerprint()?
                                && next_fire(&stored.validate()?, rpc::now_ms())?.is_none() {
                                return Err(Error::invalid("The schedule has no future occurrence"));
                            }
                        }
                        stored.updated_at_ms = Some(rpc::now_ms());
                        config.schedules.insert(stored_id, rpc::value(&stored)?);
                        Ok(stored)
                    })
                    .await
                    .map(|stored| definition = stored)?;
                sync(&store, &id, &definition, true)
                    .await
                    .map_err(|error| {
                        error.with_data(json!({"configurationCommitted":true,"stateApplied":false}))
                    })?;
                view(&store, &id, &definition, None).await.map_err(|error| {
                    error.with_data(json!({"configurationCommitted":true,"stateApplied":true,"readbackConfirmed":false}))
                })
            });
            committed.await.map_err(|source| {
                Error::new(
                    -32006,
                    "schedule_configuration_unknown",
                    "The schedule configuration task ended without a confirmed result",
                )
                .with_source(source)
            })?
        }
        "schedules.delete" => {
            let params: DeleteParams = rpc::params(params)?;
            config::validate_id(&params.id)?;
            let guard = MUTATION.lock().await;
            if STOPPING.load(Ordering::Acquire) {
                return Err(Error::unavailable(
                    "schedule_stopping",
                    "The scheduler is shutting down",
                ));
            }
            let config = config.clone();
            let committed = submissions().spawn(async move {
                let _guard = guard;
                let _wake = WakeOnDrop;
                let id = params.id.clone();
                config.update(move |config| {
                    let previous = config.schedules.get(&id).ok_or_else(|| Error::not_found("Schedule"))?;
                    let previous: Definition = serde_json::from_value(previous.clone())
                        .map_err(|_| Error::invalid("Stored schedule definition is invalid"))?;
                    if params.expected_revision.as_ref().is_some_and(|expected| previous.fingerprint().as_ref().ok() != Some(expected)) {
                        return Err(Error::conflict("schedule_revision_conflict", "The schedule changed; read its current revision before deleting"));
                    }
                    config.schedules.remove(&id);
                    Ok(())
                }).await?;
                store.remove(&params.id).await.map_err(|error| error.with_data(json!({"configurationCommitted":true,"stateApplied":false})))?;
                Ok(json!({"id":params.id,"deleted":true,"submittedRunsCancelled":false,"receiptsRetained":true}))
            });
            committed.await.map_err(|source| {
                Error::new(
                    -32006,
                    "schedule_configuration_unknown",
                    "The schedule configuration task ended without a confirmed result",
                )
                .with_source(source)
            })?
        }
        "schedules.run" => {
            let params: IdParams = rpc::params(params)?;
            let submitted = {
                let _guard = MUTATION.lock().await;
                if STOPPING.load(Ordering::Acquire) {
                    return Err(Error::unavailable(
                        "schedule_stopping",
                        "The scheduler is shutting down",
                    ));
                }
                let definition = definition(config, &params.id).await?;
                sync(&store, &params.id, &definition, false).await?;
                let state = store
                    .state(&params.id)
                    .await?
                    .ok_or_else(|| Error::internal("schedule_state_missing"))?;
                let session_id = definition
                    .session_id
                    .clone()
                    .or(state.owned_session_id)
                    .ok_or_else(|| Error::internal("schedule_session_missing"))?;
                let receipt = store
                    .claim(
                        &params.id,
                        definition.fingerprint()?,
                        rpc::now_ms(),
                        None,
                        Trigger::Manual,
                        session_id,
                    )
                    .await?
                    .ok_or_else(|| {
                        Error::conflict(
                            "schedule_changed",
                            "Schedule changed before the run was claimed",
                        )
                    })?;
                let store = store.clone();
                let sessions = sessions.clone();
                // The durable receipt owns this submission even if the RPC future is cancelled.
                submissions().spawn(async move {
                    delivery::submit(&store, &sessions, &definition, receipt).await
                })
            };
            let receipt = submitted.await.map_err(|source| Error::new(-32006, "schedule_submission_task", "Submission was interrupted; inspect the receipt and do not automatically retry").with_source(source))??;
            CHANGED.notify_one();
            rpc::value(receipt)
        }
        _ => unreachable!(),
    }
}

struct Entry {
    definition: Definition,
    timing: Timing,
    fingerprint: String,
}

async fn refresh(config: &ConfigStore, store: &Store) -> rpc::Result<BTreeMap<String, Entry>> {
    let snapshot = config.snapshot().await;
    let mut entries = BTreeMap::new();
    for (id, value) in snapshot.schedules {
        config::validate_id(&id)?;
        let definition: Definition = serde_json::from_value(value)
            .map_err(|_| Error::invalid("Stored schedule definition is invalid"))?;
        if !snapshot.agents.contains_key(&definition.agent_id) {
            return Err(Error::not_found("Schedule Agent"));
        }
        let cron = definition.validate()?;
        sync(store, &id, &definition, false).await?;
        entries.insert(
            id,
            Entry {
                fingerprint: definition.fingerprint()?,
                definition,
                timing: cron,
            },
        );
    }
    store.retain(entries.keys().cloned().collect()).await?;
    Ok(entries)
}

async fn claim_due(
    store: &Store,
    entries: &BTreeMap<String, Entry>,
    missed_before_ms: Option<u64>,
) -> rpc::Result<Option<(Definition, Receipt)>> {
    let Some((id, due)) = store.earliest().await? else {
        return Ok(None);
    };
    let now = rpc::now_ms();
    if due > missed_before_ms.unwrap_or(now) {
        return Ok(None);
    }
    // A concurrent configuration commit has already queued a reload notification.
    let Some(entry) = entries.get(&id) else {
        return Ok(None);
    };
    let next = if entry.definition.enabled && entry.definition.recurring {
        next_fire(&entry.timing, now)?
    } else {
        None
    };
    let state = store
        .state(&id)
        .await?
        .ok_or_else(|| Error::internal("schedule_state_missing"))?;
    let session_id = entry
        .definition
        .session_id
        .clone()
        .or(state.owned_session_id)
        .ok_or_else(|| Error::internal("schedule_session_missing"))?;
    Ok(store
        .claim(
            &id,
            entry.fingerprint.clone(),
            due,
            next,
            if missed_before_ms.is_some() {
                Trigger::Missed
            } else {
                Trigger::Cron
            },
            session_id,
        )
        .await?
        .map(|receipt| (entry.definition.clone(), receipt)))
}

pub async fn start(
    config: Arc<ConfigStore>,
    sessions: Sessions,
    events: Events,
    diagnostics: Diagnostics,
) -> rpc::Result<JoinHandle<()>> {
    let stop = CancellationToken::new();
    STOP.set(stop.clone()).map_err(|_| {
        Error::conflict(
            "schedule_already_started",
            "The scheduler has already been started",
        )
    })?;
    let store = Store::open(&config.paths().database()).await?;
    let entries = {
        let _guard = MUTATION.lock().await;
        store.recover_dispatching().await?;
        let entries = refresh(&config, &store).await?;
        // Offline windows are evidence; the fixed cutoff excludes new matches during recovery.
        let recovered_at_ms = rpc::now_ms();
        while let Some((_definition, receipt)) =
            claim_due(&store, &entries, Some(recovered_at_ms)).await?
        {
            delivery::publish(&receipt, &events, &diagnostics).await;
        }
        entries
    };
    Ok(tokio::spawn(async move {
        let mut entries = entries;
        loop {
            let changed = CHANGED.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let next = match store.earliest().await {
                Ok(next) => next,
                Err(error) => {
                    delivery::report(&diagnostics, "next_fire", &error).await;
                    eprintln!(
                        "schedule worker stopped because its durable trigger state is unavailable"
                    );
                    break;
                }
            };
            // This is an observation cadence for pending Runs and clock jumps, not a Run deadline.
            let wait = next
                .map(|(_, due)| due.saturating_sub(rpc::now_ms()))
                .unwrap_or(1000)
                .min(1000);
            let reload = tokio::select! {
                _ = stop.cancelled() => break,
                _ = &mut changed => true,
                _ = tokio::time::sleep(Duration::from_millis(wait)) => false,
            };
            if reload {
                let _guard = MUTATION.lock().await;
                match refresh(&config, &store).await {
                    Ok(updated) => entries = updated,
                    Err(error) => {
                        delivery::report(&diagnostics, "refresh", &error).await;
                        eprintln!(
                            "schedule worker stopped because definitions could not be reconciled"
                        );
                        break;
                    }
                }
            }
            if let Err(error) = delivery::reconcile(&store, &sessions, &events, &diagnostics).await
            {
                delivery::report(&diagnostics, "receipts", &error).await;
            }
            loop {
                let submitted = {
                    let _guard = MUTATION.lock().await;
                    if stop.is_cancelled() {
                        return;
                    }
                    match claim_due(&store, &entries, None).await {
                        Ok(Some((definition, receipt))) => {
                            let store = store.clone();
                            let sessions = sessions.clone();
                            Ok(Some(submissions().spawn(async move {
                                delivery::submit(&store, &sessions, &definition, receipt).await
                            })))
                        }
                        Ok(None) => Ok(None),
                        Err(error) => Err(error),
                    }
                };
                match submitted {
                    Ok(Some(submitted)) => {
                        // Only submit is owned here; model execution belongs to Sessions.
                        match submitted.await {
                            Ok(Ok(receipt)) => {
                                delivery::publish(&receipt, &events, &diagnostics).await
                            }
                            Ok(Err(error)) => {
                                delivery::report(&diagnostics, "submit", &error).await
                            }
                            Err(_) => eprintln!(
                                "schedule submission task ended without a receipt confirmation"
                            ),
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        delivery::report(&diagnostics, "claim", &error).await;
                        eprintln!(
                            "schedule worker stopped because a durable trigger could not be claimed"
                        );
                        return;
                    }
                }
            }
        }
    }))
}
