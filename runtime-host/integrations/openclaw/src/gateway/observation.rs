use std::{collections::HashMap, sync::{Arc, Mutex as StdMutex, atomic::{AtomicU64, Ordering}}};

use sessions_module::{ports::{RuntimeOperationFailure, SessionObservationRequest, SessionSync}, state::SessionIdentity};
use tokio::sync::{Mutex, oneshot};

use crate::session::{trace, window::{PageRequest, SessionWindow}};

pub(crate) enum HistoryRead {
    Projected(Option<SessionSync>),
    NeedsContent { window: SessionWindow, source_epoch: crate::gateway::ingress::GatewayEpoch },
}

pub(crate) fn identity_key(identity: &SessionIdentity) -> String {
    serde_json::to_string(identity).expect("session identity serializes")
}

pub(crate) struct Observation {
    pub(crate) identity: SessionIdentity,
    pub(crate) generation: u64,
    pub(crate) source_epoch: Option<u64>,
    pub(crate) subscribed_epoch: Option<u64>,
    pub(crate) cursor: Option<String>,
    pub(crate) cursor_page: Option<PageRequest>,
    pub(crate) paused: bool,
}

pub(crate) enum OrderedContext {
    Subscribe { identity: SessionIdentity, generation: u64, reply: oneshot::Sender<Result<(), RuntimeOperationFailure>> },
    Describe { identity: SessionIdentity, generation: u64, supported: bool, reply: oneshot::Sender<Result<(), RuntimeOperationFailure>> },
    History { identity: SessionIdentity, generation: u64, page: PageRequest, host_epoch: u64,
        reply: oneshot::Sender<Result<HistoryRead, RuntimeOperationFailure>> },
}

pub(crate) struct Observations {
    pub(crate) entries: StdMutex<HashMap<String, Observation>>,
    pub(crate) pending: StdMutex<HashMap<String, OrderedContext>>,
    pub(crate) native: Mutex<()>,
    current_epoch: AtomicU64,
}

impl Observations {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self { entries: StdMutex::new(HashMap::new()), pending: StdMutex::new(HashMap::new()), native: Mutex::new(()), current_epoch: AtomicU64::new(0) })
    }

    pub(crate) fn prepare(&self, request: SessionObservationRequest) -> Result<(), RuntimeOperationFailure> {
        let key = identity_key(&request.identity);
        let mut entries = self.entries.lock().expect("observation registry lock poisoned");
        if entries.contains_key(&key) {
            if trace::enabled() {
                trace::log_unscoped("runtime.openclaw.observation.prepare.rejected", serde_json::json!({
                    "identity": sessions_module::trace::identity_shape(&request.identity), "generation": request.generation,
                    "reason": "already_prepared" }));
            }
            return Err(RuntimeOperationFailure::Unavailable);
        }
        let epoch = self.current_epoch.load(Ordering::Acquire);
        if trace::enabled() {
            trace::log_unscoped("runtime.openclaw.observation.prepare.install", serde_json::json!({
                "identity": sessions_module::trace::identity_shape(&request.identity), "generation": request.generation,
                "sourceEpoch": (epoch != 0).then_some(epoch), "subscribedEpoch": null, "cursorPresent": false, "paused": false }));
        }
        entries.insert(key, Observation { identity: request.identity, generation: request.generation,
            source_epoch: (epoch != 0).then_some(epoch), subscribed_epoch: None, cursor: None, cursor_page: None, paused: false });
        Ok(())
    }

    pub(crate) fn restart(&self, identity: &SessionIdentity, generation: u64, next_generation: u64) -> Result<(), RuntimeOperationFailure> {
        let mut entries = self.entries.lock().expect("observation registry lock poisoned");
        let entry = entries.get_mut(&identity_key(identity)).filter(|entry| entry.generation == generation).ok_or(RuntimeOperationFailure::Unavailable)?;
        if trace::enabled() {
            trace::log_unscoped("runtime.openclaw.observation.restart.registry", serde_json::json!({
                "identity": sessions_module::trace::identity_shape(identity), "generation": generation, "nextGeneration": next_generation,
                "previousSourceEpoch": entry.source_epoch, "sourceEpoch": null,
                "previousSubscribedEpoch": entry.subscribed_epoch, "cursorPresent": entry.cursor.is_some(),
                "cursorHash": entry.cursor.as_deref().map(sessions_module::trace::fingerprint),
                "previousPaused": entry.paused, "nextPaused": true, "nextCursorPresent": false }));
        }
        entry.generation = next_generation;
        entry.source_epoch = None;
        entry.subscribed_epoch = None;
        entry.cursor = None;
        entry.cursor_page = None;
        entry.paused = true;
        Ok(())
    }

    pub(crate) fn activate(&self, epoch: u64) {
        let mut entries = self.entries.lock().expect("observation registry lock poisoned");
        self.current_epoch.store(epoch, Ordering::Release);
        for entry in entries.values_mut().filter(|entry| entry.source_epoch.is_none()) {
            entry.source_epoch = Some(epoch);
        }
        if trace::enabled() {
            trace::log_unscoped("runtime.openclaw.observation.source.activate", serde_json::json!({
                "sourceEpoch": epoch, "observationCount": entries.len() }));
            for entry in entries.values() {
                trace::log_unscoped("runtime.openclaw.observation.source.binding", serde_json::json!({
                    "identity": sessions_module::trace::identity_shape(&entry.identity), "generation": entry.generation,
                    "sourceEpoch": entry.source_epoch, "activeSourceEpoch": epoch, "subscribedEpoch": entry.subscribed_epoch,
                    "cursorPresent": entry.cursor.is_some(), "cursorHash": entry.cursor.as_deref().map(sessions_module::trace::fingerprint), "paused": entry.paused }));
            }
        }
    }

    pub(crate) fn deactivate(&self, epoch: u64) {
        let _entries = self.entries.lock().expect("observation registry lock poisoned");
        let result = self.current_epoch.compare_exchange(epoch, 0, Ordering::AcqRel, Ordering::Acquire);
        if trace::enabled() {
            trace::log_unscoped("runtime.openclaw.observation.source.deactivate", serde_json::json!({
                "sourceEpoch": epoch, "deactivated": result.is_ok(), "activeSourceEpoch": result.err() }));
        }
    }

    pub(crate) fn is_active(&self, identity: &SessionIdentity, generation: u64, epoch: u64) -> bool {
        let entries = self.entries.lock().expect("observation registry lock poisoned");
        self.current_epoch.load(Ordering::Acquire) == epoch
            && entries.get(&identity_key(identity)).is_some_and(|entry|
                entry.generation == generation && entry.source_epoch == Some(epoch) && !entry.paused)
    }

    pub(crate) fn contains(&self, identity: &SessionIdentity, generation: u64, epoch: Option<u64>) -> bool {
        self.entries.lock().expect("observation registry lock poisoned")
            .get(&identity_key(identity)).is_some_and(|entry| entry.generation == generation && epoch.is_none_or(|epoch| entry.source_epoch == Some(epoch)))
    }
}
