use std::{
    collections::HashSet,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};

use foundation::execution::OwnedTask;
use tokio::sync::oneshot;

use super::actor::{SessionLane, SessionShared};
use crate::{
    call::SessionCall,
    command::{SessionCommand, session_identity_lane_key},
    ports::{
        RuntimeOperationFailure, SessionObservation, SessionObservationRequest,
        SessionObserveCommand, SessionObserveOutcome, SessionReleaseOutcome, SessionSync,
    },
    state::{SessionChange, SessionCompleteness, SessionIdentity, SessionState, SessionView},
    timeline,
};

const MAX_WAITERS: usize = 64;
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

fn command_shape(command: &timeline::Command) -> serde_json::Value {
    serde_json::json!({
        "operation": match command.operation() { timeline::Operation::Load => "load", timeline::Operation::Window => "window" },
        "direction": command.direction().as_str(), "limit": command.limit(), "offset": command.offset(),
        "includeCanonical": command.include_canonical(),
        "nativeSessionHash": command.endpoint_session_id().map(crate::trace::fingerprint),
    })
}

pub(super) struct Observation {
    handle: Option<Arc<dyn SessionObservation>>,
    task: Option<OwnedTask<()>>,
    baseline: Option<SessionState>,
    active_command: Option<timeline::Command>,
    committed_command: Option<timeline::Command>,
    committed_view: Option<SessionView>,
    generation: u64,
    closing: bool,
    restart_after_close: bool,
    recovery_available: bool,
    needs_sync: bool,
    leases: HashSet<String>,
    runs: HashSet<String>,
    unknown_send: bool,
    notified_terminals: HashSet<String>,
    waiters: Vec<Waiter>,
}

struct Waiter {
    command: timeline::Command,
    reply: WaiterReply,
    call: Option<SessionCall>,
}

enum WaiterReply {
    Observe {
        lease_id: String,
        lease_added: bool,
        reply: oneshot::Sender<SessionObserveOutcome>,
    },
    Timeline(oneshot::Sender<timeline::Outcome>),
}

impl Observation {
    fn take_failed_waiters(&mut self) -> Vec<Waiter> {
        let waiters = std::mem::take(&mut self.waiters);
        for waiter in &waiters {
            if let WaiterReply::Observe {
                lease_id,
                lease_added: true,
                ..
            } = &waiter.reply
            {
                self.leases.remove(lease_id);
            }
        }
        waiters
    }

    fn demanded(&self) -> bool {
        !self.leases.is_empty()
            || !self.runs.is_empty()
            || self.unknown_send
            || !self.waiters.is_empty()
    }
}

pub(super) fn valid_lease_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

impl SessionShared {
    pub(super) fn observation_generation(&self, identity: &SessionIdentity) -> Option<u64> {
        self.observations
            .lock()
            .expect("session observation lock")
            .get(&session_identity_lane_key(identity))
            .filter(|entry| !entry.closing && entry.handle.is_some())
            .map(|entry| entry.generation)
    }

    pub(super) fn receive_event(&self, identity: &SessionIdentity, changes: &[SessionChange]) {
        if let Some(entry) = self
            .observations
            .lock()
            .expect("session observation lock")
            .get_mut(&session_identity_lane_key(identity))
        {
            for change in changes {
                if let SessionChange::RunPhaseChanged { run_id, phase } = change {
                    if crate::state::terminal_run_phase(*phase) {
                        entry.runs.remove(run_id);
                        if entry.notified_terminals.insert(run_id.clone())
                            && entry.leases.is_empty()
                        {
                            entry.needs_sync = true;
                        }
                    }
                }
            }
        }
    }

    fn watch_observe_reply(
        &self,
        identity: &SessionIdentity,
        lease_id: &str,
        mut reply: oneshot::Sender<SessionObserveOutcome>,
    ) -> oneshot::Sender<SessionObserveOutcome> {
        let (forward, mut received) = oneshot::channel();
        let sender = self
            .completion_handle
            .get()
            .cloned()
            .expect("session completion handle");
        let identity = identity.clone();
        let lease_id = lease_id.to_owned();
        let (task, _) = OwnedTask::spawn(move |cancel| async move {
            tokio::select! {
                _ = cancel.cancelled() => return,
                _ = reply.closed() => {},
                result = &mut received => {
                    if let Ok(outcome) = result {
                        if reply.send(outcome).is_ok() { return; }
                    }
                }
            }
            let (release_reply, _) = oneshot::channel();
            let _ = sender
                .send_command(SessionCommand::Release {
                    identity,
                    lease_id,
                    reply: release_reply,
                })
                .await;
        });
        let mut tasks = self.read_tasks.lock().expect("session read tasks lock");
        tasks.retain(|task| !task.is_finished());
        tasks.push(task);
        forward
    }

    pub(super) fn received_terminal(&self, identity: &SessionIdentity, run_id: &str) -> bool {
        self.observations
            .lock()
            .expect("session observation lock")
            .get(&session_identity_lane_key(identity))
            .is_some_and(|entry| entry.notified_terminals.contains(run_id))
    }

    pub(super) async fn shutdown_observations(&self) {
        let entries =
            std::mem::take(&mut *self.observations.lock().expect("session observation lock"));
        for (_, mut entry) in entries {
            if let Some(task) = entry.task.as_mut() {
                let _ = task.cancel_and_join().await;
            }
            if let Some(handle) = entry.handle {
                handle.close().await;
            }
            for waiter in entry.waiters {
                finish_waiter(waiter, None).await;
            }
        }
    }
}

impl SessionLane {
    pub(super) fn prepare_observer(
        &mut self,
        shared: &SessionShared,
        identity: &SessionIdentity,
    ) -> Result<(), RuntimeOperationFailure> {
        let key = session_identity_lane_key(identity);
        if shared
            .observations
            .lock()
            .expect("session observation lock")
            .get(&key)
            .is_some_and(|entry| entry.closing || entry.handle.is_some())
        {
            return Ok(());
        }
        let endpoint = platform::endpoint::runtime_address::RuntimeEndpoint::try_new(
            identity.provider().as_str(),
            &identity.endpoint.runtime_instance_id,
        )
        .ok();
        let driver = shared.running_session_driver(endpoint)?;
        let ops = driver
            .session_ops()
            .ok_or(RuntimeOperationFailure::Unsupported)?;
        let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
        let endpoint_session_id = self
            .state
            .as_ref()
            .and_then(SessionState::native_session_id)
            .map(str::to_owned);
        let handle = ops.prepare_observation(SessionObservationRequest {
            identity: identity.clone(),
            endpoint_session_id,
            generation,
        })?;
        let mut entries = shared
            .observations
            .lock()
            .expect("session observation lock");
        if let Some(entry) = entries.get_mut(&key) {
            entry.handle = Some(handle);
            entry.generation = generation;
            entry.committed_command = None;
            entry.committed_view = None;
            entry.needs_sync = false;
        } else {
            entries.insert(
                key,
                Observation {
                    handle: Some(handle),
                    task: None,
                    baseline: None,
                    active_command: None,
                    committed_command: None,
                    committed_view: None,
                    generation,
                    closing: false,
                    restart_after_close: false,
                    recovery_available: true,
                    needs_sync: false,
                    leases: HashSet::new(),
                    runs: HashSet::new(),
                    unknown_send: false,
                    notified_terminals: HashSet::new(),
                    waiters: Vec::new(),
                },
            );
        }
        Ok(())
    }

    fn start_sync(
        &mut self,
        shared: &SessionShared,
        identity: &SessionIdentity,
        command: timeline::Command,
    ) {
        let Some(sender) = shared.completion_handle.get().cloned() else {
            return;
        };
        let mut observations = shared
            .observations
            .lock()
            .expect("session observation lock");
        let Some(entry) = observations.get_mut(&session_identity_lane_key(identity)) else {
            return;
        };
        if entry.closing || entry.baseline.is_some() {
            if crate::trace::enabled() {
                crate::trace::log_unscoped("sessions.sync.skip", serde_json::json!({
                    "identity": crate::trace::identity_shape(identity), "generation": entry.generation,
                    "reason": if entry.closing { "closing" } else { "sync_inflight" }, "closing": entry.closing,
                    "needsSync": entry.needs_sync, "hasBaseline": entry.baseline.is_some(),
                    "request": command_shape(&command), "activeRequest": entry.active_command.as_ref().map(command_shape),
                    "committedRequest": entry.committed_command.as_ref().map(command_shape),
                    "matchesActive": entry.active_command.as_ref() == Some(&command),
                    "matchesCommitted": entry.committed_command.as_ref() == Some(&command),
                    "waiters": entry.waiters.len(), "leases": entry.leases.len(), "runs": entry.runs.len(), "unknownSend": entry.unknown_send,
                }));
            }
            return;
        }
        let Some(handle) = entry.handle.clone() else {
            return;
        };
        let Some(baseline) = self.state.clone() else {
            return;
        };
        if crate::trace::enabled() {
            crate::trace::log_unscoped("sessions.sync.start", serde_json::json!({
                "identity": crate::trace::identity_shape(identity), "generation": entry.generation,
                "closing": entry.closing, "needsSyncBefore": entry.needs_sync, "needsSyncAfter": false,
                "baseline": crate::trace::view_shape(&baseline.view()), "waiters": entry.waiters.len(),
                "request": command_shape(&command), "activeRequest": entry.active_command.as_ref().map(command_shape),
                "committedRequest": entry.committed_command.as_ref().map(command_shape),
                "matchesCommitted": entry.committed_command.as_ref() == Some(&command),
                "leases": entry.leases.len(), "runs": entry.runs.len(), "unknownSend": entry.unknown_send,
                "reason": if !entry.waiters.is_empty() { "waiter_request" } else if entry.needs_sync { "needs_sync" } else { "demand_without_committed_view" },
            }));
        }
        entry.baseline = Some(baseline);
        entry.active_command = Some(command.clone());
        entry.needs_sync = false;
        let identity = identity.clone();
        let generation = entry.generation;
        let epoch = shared.epoch;
        let (task, _) = OwnedTask::spawn(move |cancel| async move {
            let started = crate::trace::enabled().then(Instant::now);
            let result = tokio::select! { _ = cancel.cancelled() => return, result = handle.sync(command, epoch) => result };
            if let Some(started) = started {
                let elapsed = started.elapsed().as_secs_f64() * 1000.0;
                crate::trace::log_unscoped("sessions.sync.runtime_returned", serde_json::json!({
                    "identity": crate::trace::identity_shape(&identity), "generation": generation,
                    "runtimeSyncElapsedMs": elapsed, "timingScope": "handle_sync_including_runtime_trace_excluding_completion_lane",
                    "succeeded": result.is_ok(),
                }));
            }
            tokio::select! { _ = cancel.cancelled() => {}, _ = sender.send_command(SessionCommand::SyncCompleted { identity, generation, result }) => {} }
        });
        entry.task = Some(task);
    }

    fn latest_command(
        &self,
        identity: &SessionIdentity,
        window: timeline::WindowRequest,
    ) -> timeline::Command {
        timeline::Command::new(
            timeline::Operation::Load,
            identity.clone(),
            window,
            self.state
                .as_ref()
                .and_then(SessionState::native_session_id)
                .map(str::to_owned),
            true,
        )
        .expect("validated observation timeline")
    }

    pub(super) async fn observe(
        &mut self,
        shared: &SessionShared,
        command: SessionObserveCommand,
        reply: oneshot::Sender<SessionObserveOutcome>,
        call: Option<SessionCall>,
    ) {
        let identity = command.identity;
        if identity.validate().is_err()
            || !valid_lease_id(&command.lease_id)
            || command.window.direction() != timeline::Direction::Latest
            || !(1..=200).contains(&command.window.limit())
        {
            crate::call::reply(call.as_ref(), reply, SessionObserveOutcome::Rejected).await;
            return;
        }
        if self.state.is_none() {
            self.state = shared
                .snapshot
                .load()
                .states
                .get(&session_identity_lane_key(&identity))
                .cloned();
        }
        if self.state.is_none() {
            self.state = SessionState::new(identity.clone(), shared.epoch).ok();
        }
        if let Err(failure) = self.prepare_observer(shared, &identity) {
            crate::call::reply(call.as_ref(), reply, observe_failure(failure)).await;
            return;
        }
        if shared
            .observations
            .lock()
            .expect("session observation lock")
            .get(&session_identity_lane_key(&identity))
            .is_some_and(|entry| entry.waiters.len() >= MAX_WAITERS)
        {
            crate::call::reply(call.as_ref(), reply, SessionObserveOutcome::Unavailable).await;
            return;
        }
        let reply = shared.watch_observe_reply(&identity, &command.lease_id, reply);
        let timeline = self.latest_command(&identity, command.window);
        let immediate = {
            let mut entries = shared
                .observations
                .lock()
                .expect("session observation lock");
            let entry = entries
                .get_mut(&session_identity_lane_key(&identity))
                .expect("prepared observation");
            entry.recovery_available = true;
            if entry.closing {
                entry.restart_after_close = true;
            }
            let ready = !entry.closing
                && !entry.needs_sync
                && entry.baseline.is_none()
                && entry.committed_command.as_ref() == Some(&timeline);
            if crate::trace::enabled() {
                crate::trace::log_unscoped("sessions.observation.ready", serde_json::json!({
                    "identity": crate::trace::identity_shape(&identity), "generation": entry.generation,
                    "request": command_shape(&timeline), "activeRequest": entry.active_command.as_ref().map(command_shape),
                    "committedRequest": entry.committed_command.as_ref().map(command_shape),
                    "matchesActive": entry.active_command.as_ref() == Some(&timeline),
                    "matchesCommitted": entry.committed_command.as_ref() == Some(&timeline),
                    "ready": ready, "hasCommittedView": entry.committed_view.is_some(),
                    "closing": entry.closing, "needsSync": entry.needs_sync, "hasBaseline": entry.baseline.is_some(),
                    "waiters": entry.waiters.len(), "leases": entry.leases.len(), "runs": entry.runs.len(), "unknownSend": entry.unknown_send,
                    "reason": if entry.closing { "closing" } else if entry.needs_sync { "needs_sync" }
                        else if entry.baseline.is_some() { "sync_inflight" } else if entry.committed_command.is_none() { "no_committed_request" }
                        else if entry.committed_command.as_ref() != Some(&timeline) { "request_mismatch" }
                        else if entry.committed_view.is_none() { "no_committed_view" } else { "reuse_committed_view" },
                }));
            }
            if ready {
                entry.leases.insert(command.lease_id.clone());
                entry.committed_view.clone()
            } else {
                None
            }
        };
        if let Some(mut view) = immediate {
            let current = self.state.as_ref().expect("observation state").view();
            view.items = current.items;
            view.tools = current.tools;
            view.approvals = current.approvals;
            view.runtime = current.runtime;
            view.goal = current.goal;
            view.window = current.window;
            view.completeness = current.completeness;
            view.epoch = current.epoch;
            view.seq = current.seq;
            view.cursor = current.cursor;
            super::session_ownership::enrich_views(
                shared.ownership_reader.as_ref(),
                std::slice::from_mut(&mut view),
            )
            .await;
            crate::call::reply(
                call.as_ref(),
                reply,
                SessionObserveOutcome::Observed {
                    lease_id: command.lease_id,
                    view,
                },
            )
            .await;
            return;
        }
        {
            let mut entries = shared
                .observations
                .lock()
                .expect("session observation lock");
            let entry = entries
                .get_mut(&session_identity_lane_key(&identity))
                .expect("prepared observation");
            let lease_added = entry.leases.insert(command.lease_id.clone());
            entry.waiters.push(Waiter {
                command: timeline.clone(),
                reply: WaiterReply::Observe {
                    lease_id: command.lease_id,
                    lease_added,
                    reply,
                },
                call,
            });
        }
        self.start_sync(shared, &identity, timeline);
    }

    pub(super) async fn latest_timeline(
        &mut self,
        shared: &SessionShared,
        command: timeline::Command,
        reply: oneshot::Sender<timeline::Outcome>,
        call: Option<SessionCall>,
    ) {
        let identity = command.identity().clone();
        if self.state.is_none() {
            self.state = SessionState::new(identity.clone(), shared.epoch).ok();
        }
        let waiter = Waiter {
            command: command.clone(),
            reply: WaiterReply::Timeline(reply),
            call,
        };
        if let Err(failure) = self.prepare_observer(shared, &identity) {
            finish_failed_waiter(waiter, failure).await;
            return;
        }
        let rejected = {
            let mut entries = shared
                .observations
                .lock()
                .expect("session observation lock");
            let entry = entries
                .get_mut(&session_identity_lane_key(&identity))
                .expect("prepared observation");
            entry.recovery_available = true;
            if entry.closing {
                entry.restart_after_close = true;
            }
            if entry.waiters.len() >= MAX_WAITERS {
                Some(waiter)
            } else {
                entry.waiters.push(waiter);
                None
            }
        };
        if let Some(waiter) = rejected {
            finish_waiter(waiter, None).await;
            return;
        }
        self.start_sync(shared, &identity, command);
    }

    pub(super) fn prepare_send_receive(
        &mut self,
        shared: &SessionShared,
        identity: &SessionIdentity,
        run_id: Option<&str>,
    ) -> Result<(), RuntimeOperationFailure> {
        if self.state.is_none() {
            self.state = SessionState::new(identity.clone(), shared.epoch).ok();
        }
        self.prepare_observer(shared, identity)?;
        let needs_sync = {
            let mut entries = shared
                .observations
                .lock()
                .expect("session observation lock");
            let entry = entries
                .get_mut(&session_identity_lane_key(identity))
                .expect("prepared observation");
            entry.recovery_available = true;
            if entry.closing {
                return Err(RuntimeOperationFailure::Unavailable);
            }
            if let Some(run_id) = run_id {
                if !entry.notified_terminals.contains(run_id) {
                    entry.runs.insert(run_id.to_owned());
                }
            } else {
                entry.unknown_send = true;
            }
            entry.committed_view.is_none() || entry.needs_sync
        };
        if needs_sync {
            let command = self.latest_command(identity, timeline::WindowRequest::latest());
            self.start_sync(shared, identity, command);
        }
        Ok(())
    }

    pub(super) fn prepare_goal_receive(
        &mut self,
        shared: &SessionShared,
        identity: &SessionIdentity,
        endpoint_session_id: Option<&str>,
    ) -> Result<(String, Option<String>), RuntimeOperationFailure> {
        let state = self.state.clone().or_else(|| SessionState::new(identity.clone(), shared.epoch).ok())
            .ok_or(RuntimeOperationFailure::TargetRejected)?;
        if state.identity() != identity || endpoint_session_id.is_some_and(|id| state.native_session_id().is_some_and(|native| native != id)) {
            return Err(RuntimeOperationFailure::TargetRejected);
        }
        let state = if state.native_session_id().is_none() {
            state.with_endpoint_session_id(endpoint_session_id.map(str::to_owned))
                .map_err(|_| RuntimeOperationFailure::TargetRejected)?
        } else { state };
        let native_session_id = state.native_session_id().map(str::to_owned);
        self.state = Some(state);
        self.prepare_observer(shared, identity)?;
        let lease = format!("\0goal:{}", NEXT_GENERATION.fetch_add(1, Ordering::Relaxed));
        let mut entries = shared.observations.lock().expect("session observation lock");
        let entry = entries.get_mut(&session_identity_lane_key(identity)).expect("prepared observation");
        if entry.closing {
            return Err(RuntimeOperationFailure::Unavailable);
        }
        entry.recovery_available = true;
        entry.leases.insert(lease.clone());
        let needs_sync = entry.committed_view.is_none() || entry.needs_sync;
        drop(entries);
        if needs_sync {
            let command = self.latest_command(identity, timeline::WindowRequest::latest());
            self.start_sync(shared, identity, command);
        }
        Ok((lease, native_session_id))
    }

    pub(super) fn finish_goal_receive(
        &self,
        shared: &SessionShared,
        identity: &SessionIdentity,
        lease: &str,
        outcome: Option<&crate::send::SessionSendOutcome>,
    ) {
        if let Some(entry) = shared.observations.lock().expect("session observation lock").get_mut(&session_identity_lane_key(identity)) {
            entry.leases.remove(lease);
            match outcome {
                Some(crate::send::SessionSendOutcome::Succeeded { run_id, .. }) if !entry.notified_terminals.contains(run_id) => {
                    entry.runs.insert(run_id.clone());
                }
                Some(crate::send::SessionSendOutcome::Unknown) => entry.unknown_send = true,
                _ => {}
            }
        }
    }

    pub(super) fn send_receive_outcome(
        &self,
        shared: &SessionShared,
        identity: &SessionIdentity,
        requested: Option<&str>,
        outcome: &crate::send::SessionSendOutcome,
    ) {
        use crate::send::SessionSendOutcome::*;
        if let Some(entry) = shared
            .observations
            .lock()
            .expect("session observation lock")
            .get_mut(&session_identity_lane_key(identity))
        {
            match outcome {
                Queued { run_id } | Succeeded { run_id, .. } => {
                    if let Some(requested) = requested {
                        entry.runs.remove(requested);
                    }
                    if !entry.notified_terminals.contains(run_id) {
                        entry.runs.insert(run_id.clone());
                    }
                    if requested.is_none() {
                        entry.unknown_send = false;
                    }
                }
                Rejected | Unavailable | Unsupported => {
                    if let Some(requested) = requested {
                        entry.runs.remove(requested);
                    } else {
                        entry.unknown_send = false;
                    }
                }
                Unknown => {}
            }
        }
    }

    pub(super) async fn release(
        &mut self,
        shared: &SessionShared,
        identity: SessionIdentity,
        lease_id: String,
    ) -> SessionReleaseOutcome {
        if identity.validate().is_err() || !valid_lease_id(&lease_id) {
            return SessionReleaseOutcome::Rejected;
        }
        let (removed, waiters) = {
            let mut entries = shared
                .observations
                .lock()
                .expect("session observation lock");
            if let Some(entry) = entries.get_mut(&session_identity_lane_key(&identity)) {
                let removed = entry.leases.remove(&lease_id);
                let (released, pending): (Vec<_>, Vec<_>) = std::mem::take(&mut entry.waiters).into_iter().partition(|waiter| matches!(&waiter.reply, WaiterReply::Observe { lease_id: pending, .. } if pending == &lease_id));
                entry.waiters = pending;
                (removed, released)
            } else {
                (false, Vec::new())
            }
        };
        for waiter in waiters {
            if let WaiterReply::Observe { lease_id, reply, .. } = waiter.reply {
                crate::call::reply(
                    waiter.call.as_ref(),
                    reply,
                    SessionObserveOutcome::Released { lease_id },
                )
                .await;
            }
        }
        self.continue_observation(shared, &identity);
        if removed {
            SessionReleaseOutcome::Released
        } else {
            SessionReleaseOutcome::NotFound
        }
    }

    pub(super) fn close_if_idle(&self, shared: &SessionShared, identity: &SessionIdentity) {
        let idle = shared
            .observations
            .lock()
            .expect("session observation lock")
            .get(&session_identity_lane_key(identity))
            .is_some_and(|entry| {
                !entry.demanded() && !entry.needs_sync && entry.baseline.is_none()
            });
        if idle {
            self.close_observation(shared, identity, false);
        }
    }

    fn close_observation(&self, shared: &SessionShared, identity: &SessionIdentity, restart: bool) {
        let Some(sender) = shared.completion_handle.get().cloned() else {
            return;
        };
        let mut entries = shared
            .observations
            .lock()
            .expect("session observation lock");
        let Some(entry) = entries.get_mut(&session_identity_lane_key(identity)) else {
            return;
        };
        if entry.closing {
            if crate::trace::enabled() {
                crate::trace::log_unscoped("sessions.observation.close_skip", serde_json::json!({
                    "identity": crate::trace::identity_shape(identity), "generation": entry.generation,
                    "reason": "already_closing", "closing": entry.closing, "needsSync": entry.needs_sync,
                    "restartRequested": restart, "restartAfterClose": entry.restart_after_close || restart,
                }));
            }
            entry.restart_after_close |= restart;
            return;
        }
        let handle = if restart { entry.handle.clone() } else { entry.handle.take() };
        let Some(handle) = handle else {
            return;
        };
        if crate::trace::enabled() {
            crate::trace::log_unscoped("sessions.observation.close", serde_json::json!({
                "identity": crate::trace::identity_shape(identity), "generation": entry.generation,
                "restart": restart, "closingBefore": entry.closing, "closingAfter": true,
                "needsSync": entry.needs_sync, "hasBaseline": entry.baseline.is_some(),
                "leases": entry.leases.len(), "runs": entry.runs.len(), "unknownSend": entry.unknown_send,
            }));
        }
        entry.closing = true;
        entry.restart_after_close = restart;
        entry.baseline = None;
        entry.active_command = None;
        entry.committed_view = None;
        entry.committed_command = None;
        let mut previous = entry.task.take();
        let identity = identity.clone();
        let generation = entry.generation;
        let (task, _) = OwnedTask::spawn(move |cancel| async move {
            if let Some(task) = previous.as_mut() {
                let _ = task.cancel_and_join().await;
            }
            let restarted = if restart {
                let next_generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
                if crate::trace::enabled() {
                    crate::trace::log_unscoped("sessions.observation.restart", serde_json::json!({
                        "identity": crate::trace::identity_shape(&identity), "oldGeneration": generation,
                        "newGeneration": next_generation, "closing": true,
                    }));
                }
                let result = handle.restart(next_generation).await.map(|()| next_generation);
                if crate::trace::enabled() {
                    crate::trace::log_unscoped("sessions.observation.restart_outcome", serde_json::json!({
                        "identity": crate::trace::identity_shape(&identity), "oldGeneration": generation,
                        "newGeneration": next_generation, "outcome": if result.is_ok() { "succeeded" } else { "failed" },
                    }));
                }
                if result.is_err() { handle.close().await; }
                Some(result)
            } else {
                handle.close().await;
                None
            };
            tokio::select! { _ = cancel.cancelled() => {}, _ = sender.send_command(SessionCommand::ObservationClosed { identity, generation, restarted }) => {} }
        });
        entry.task = Some(task);
    }

    pub(super) async fn observation_closed(
        &mut self,
        shared: &SessionShared,
        identity: SessionIdentity,
        generation: u64,
        restarted: Option<Result<u64, RuntimeOperationFailure>>,
    ) {
        let restart = {
            let mut entries = shared
                .observations
                .lock()
                .expect("session observation lock");
            let key = session_identity_lane_key(&identity);
            let Some(entry) = entries.get_mut(&key) else {
                return;
            };
            if entry.generation != generation || !entry.closing {
                if crate::trace::enabled() {
                    crate::trace::log_unscoped("sessions.observation.closed_reject", serde_json::json!({
                        "identity": crate::trace::identity_shape(&identity), "reason": "generation_or_closing_mismatch",
                        "generation": generation, "currentGeneration": entry.generation,
                        "closing": entry.closing, "needsSync": entry.needs_sync,
                    }));
                }
                return;
            }
            entry.task.take();
            entry.closing = false;
            match restarted {
                Some(Ok(generation)) => {
                    entry.generation = generation;
                    entry.needs_sync = true;
                }
                Some(Err(_)) => { entry.handle = None; }
                None => {}
            }
            if crate::trace::enabled() {
                crate::trace::log_unscoped("sessions.observation.closed", serde_json::json!({
                    "identity": crate::trace::identity_shape(&identity), "oldGeneration": generation,
                    "newGeneration": entry.generation, "closing": entry.closing, "needsSync": entry.needs_sync,
                    "outcome": match restarted { Some(Ok(_)) => "restarted", Some(Err(_)) => "restart_failed", None => "closed" },
                    "hasHandle": entry.handle.is_some(), "demanded": entry.demanded(),
                }));
            }
            if !entry.demanded() && !entry.needs_sync {
                entries.remove(&key);
                return;
            }
            entry.restart_after_close
        };
        let prepared = match restarted {
            Some(result) => result.map(|_| ()),
            None if restart => self.prepare_observer(shared, &identity),
            None => Err(RuntimeOperationFailure::Unavailable),
        };
        match prepared {
            Ok(()) => self.continue_observation(shared, &identity),
            Err(failure) => {
                let waiters = shared
                    .observations
                    .lock()
                    .expect("session observation lock")
                    .get_mut(&session_identity_lane_key(&identity))
                    .map(Observation::take_failed_waiters)
                    .unwrap_or_default();
                for waiter in waiters {
                    finish_failed_waiter(waiter, failure).await;
                }
            }
        }
    }

    fn continue_observation(&mut self, shared: &SessionShared, identity: &SessionIdentity) {
        let command = {
            let entries = shared
                .observations
                .lock()
                .expect("session observation lock");
            let Some(entry) = entries.get(&session_identity_lane_key(identity)) else {
                return;
            };
            if entry.closing || entry.baseline.is_some() || entry.handle.is_none() {
                if crate::trace::enabled() {
                    crate::trace::log_unscoped("sessions.observation.continue_skip", serde_json::json!({
                        "identity": crate::trace::identity_shape(identity), "generation": entry.generation,
                        "reason": if entry.closing { "closing" } else if entry.baseline.is_some() { "sync_inflight" } else { "no_handle" },
                        "activeRequest": entry.active_command.as_ref().map(command_shape),
                        "committedRequest": entry.committed_command.as_ref().map(command_shape),
                        "nextWaiterRequest": entry.waiters.first().map(|waiter| command_shape(&waiter.command)),
                        "needsSync": entry.needs_sync, "waiters": entry.waiters.len(), "leases": entry.leases.len(),
                        "runs": entry.runs.len(), "unknownSend": entry.unknown_send,
                    }));
                }
                return;
            }
            let command = entry
                .waiters
                .first()
                .map(|waiter| waiter.command.clone())
                .or_else(|| {
                    (entry.needs_sync || (entry.demanded() && entry.committed_view.is_none())).then(
                        || {
                            entry.committed_command.clone().unwrap_or_else(|| {
                                self.latest_command(identity, timeline::WindowRequest::latest())
                            })
                        },
                    )
                });
            if crate::trace::enabled() {
                crate::trace::log_unscoped("sessions.observation.continue", serde_json::json!({
                    "identity": crate::trace::identity_shape(identity), "generation": entry.generation,
                    "request": command.as_ref().map(command_shape), "activeRequest": entry.active_command.as_ref().map(command_shape),
                    "committedRequest": entry.committed_command.as_ref().map(command_shape),
                    "needsSync": entry.needs_sync, "hasCommittedView": entry.committed_view.is_some(),
                    "waiters": entry.waiters.len(), "leases": entry.leases.len(), "runs": entry.runs.len(), "unknownSend": entry.unknown_send,
                    "reason": if !entry.waiters.is_empty() { "first_waiter" } else if entry.needs_sync { "needs_sync" }
                        else if entry.demanded() && entry.committed_view.is_none() { "demand_without_committed_view" }
                        else if entry.demanded() { "demand_satisfied" } else { "idle" },
                    "selection": if !entry.waiters.is_empty() { "first_waiter_request" } else if command.is_none() { "none" }
                        else if entry.committed_command.is_some() { "committed_request" } else { "default_latest_request" },
                }));
            }
            command
        };
        if let Some(command) = command {
            self.start_sync(shared, identity, command);
        } else {
            self.close_if_idle(shared, identity);
        }
    }

    pub(super) async fn sync_completed(
        &mut self,
        shared: &SessionShared,
        identity: SessionIdentity,
        generation: u64,
        result: Result<SessionSync, RuntimeOperationFailure>,
    ) {
        let (baseline, command) = {
            let mut entries = shared
                .observations
                .lock()
                .expect("session observation lock");
            let Some(entry) = entries.get_mut(&session_identity_lane_key(&identity)) else {
                return;
            };
            if entry.generation != generation || entry.closing {
                if crate::trace::enabled() {
                    crate::trace::log_unscoped("sessions.sync.reject", serde_json::json!({
                        "identity": crate::trace::identity_shape(&identity), "reason": "generation_or_closing_mismatch",
                        "generation": generation, "currentGeneration": entry.generation,
                        "closing": entry.closing, "needsSync": entry.needs_sync,
                    }));
                }
                return;
            }
            if crate::trace::enabled() {
                crate::trace::log_unscoped("sessions.sync.completed", serde_json::json!({
                    "identity": crate::trace::identity_shape(&identity), "generation": generation,
                    "closing": entry.closing, "needsSync": entry.needs_sync,
                    "hasBaseline": entry.baseline.is_some(), "hasCommand": entry.active_command.is_some(),
                    "outcome": match &result {
                        Ok(_) => "succeeded", Err(RuntimeOperationFailure::TargetRejected) => "target_rejected",
                        Err(RuntimeOperationFailure::Unknown) => "unknown", Err(RuntimeOperationFailure::Unsupported) => "unsupported",
                        Err(RuntimeOperationFailure::Unavailable) => "unavailable",
                    },
                }));
            }
            let Some(baseline) = entry.baseline.take() else {
                return;
            };
            let Some(command) = entry.active_command.take() else {
                return;
            };
            entry.task.take();
            (baseline, command)
        };
        let input_trace_started = crate::trace::enabled().then(Instant::now);
        if crate::trace::enabled() {
            if let Ok(sync) = &result {
                crate::trace::log_unscoped("sessions.sync.input", serde_json::json!({
                    "identity": crate::trace::identity_shape(&identity), "generation": generation,
                    "incoming": crate::trace::view_shape(&sync.view), "baseline": crate::trace::view_shape(&baseline.view()),
                    "current": self.state.as_ref().map(|state| crate::trace::view_shape(&state.view())),
                    "replayBaseline": sync.replay_baseline.as_ref().map(crate::trace::view_shape),
                    "sourceEpoch": sync.source_epoch, "cut": match sync.cut {
                        crate::ports::SessionSyncCut::Snapshot => serde_json::json!({ "kind": "snapshot" }),
                        crate::ports::SessionSyncCut::EventFrontier { cursor, contiguous } => serde_json::json!({ "kind": "event_frontier", "nativeCursor": cursor, "contiguous": contiguous }),
                    },
                    "retiredItemCount": sync.retired_item_ids.len(),
                    "retiredItemHashes": sync.retired_item_ids.iter().take(crate::state::MAX_ITEMS).map(|id| crate::trace::fingerprint(id)).collect::<Vec<_>>(),
                    "terminalRunCount": sync.terminal_runs.len(),
                    "terminalRuns": sync.terminal_runs.iter().take(crate::state::MAX_ITEMS).map(|run| serde_json::json!({ "runHash": crate::trace::fingerprint(&run.run_id), "phase": run.phase })).collect::<Vec<_>>(),
                }));
            }
        }
        let input_trace_elapsed_ms = input_trace_started.map(|started| started.elapsed().as_secs_f64() * 1000.0);
        let failure = result
            .as_ref()
            .err()
            .copied()
            .unwrap_or(RuntimeOperationFailure::Unavailable);
        let view = match result {
            Ok(mut sync) if sync.view.identity == identity => {
                super::session_ownership::enrich_views(
                    shared.ownership_reader.as_ref(),
                    std::slice::from_mut(&mut sync.view),
                )
                .await;
                let mut next = self.state.clone().unwrap_or_else(|| baseline.clone());
                let mut terminal_commit_failed = false;
                for terminal in &sync.terminal_runs {
                    if next.has_terminal_run(&terminal.run_id) {
                        continue;
                    }
                    let current = next.view();
                    let Some(cursor) = current.cursor.checked_add(1) else {
                        terminal_commit_failed = true;
                        break;
                    };
                    let binding = crate::state::SessionEventBinding::new(identity.clone(), None)
                        .expect("validated sync identity");
                    match next.apply_bound(
                        binding,
                        None,
                        cursor,
                        vec![SessionChange::RunPhaseChanged {
                            run_id: terminal.run_id.clone(),
                            phase: terminal.phase,
                        }],
                    ) {
                        crate::state::SessionApplyResult::Applied(delta) => {
                            let terminals = SessionShared::terminal_snapshots(&delta, &mut next);
                            self.state = Some(next.clone());
                            shared.store_snapshot_state(next.clone()).await;
                            shared.receive_event(&identity, &delta.changes);
                            shared.emit_session_delta(&delta, terminals);
                        }
                        _ => {
                            terminal_commit_failed = true;
                            break;
                        }
                    }
                }
                let reconciled = if terminal_commit_failed {
                    Err(crate::state::SessionStateError::InvalidFacts)
                } else if crate::trace::enabled() {
                    let current = next.view();
                    crate::trace::with_context(serde_json::json!({
                        "identity": crate::trace::identity_shape(&identity), "generation": generation,
                        "sourceEpoch": sync.source_epoch, "syncEpoch": sync.view.epoch, "syncSeq": sync.view.seq,
                        "epoch": current.epoch, "seq": current.seq, "cursor": current.cursor,
                    }), || {
                        let started = Instant::now();
                        let reconciled = next.reconcile_sync(&sync, &baseline);
                        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
                        let item_count = |view: &SessionView| match &view.items {
                            crate::state::SessionFact::Complete(items) | crate::state::SessionFact::Incomplete { facts: items, .. } => Some(items.len()),
                            _ => None,
                        };
                        crate::trace::log_unscoped("sessions.sync.reconcile_timing", serde_json::json!({
                            "reconcileElapsedMs": elapsed, "inputTraceElapsedMs": input_trace_elapsed_ms,
                            "timingScope": "reconcile_sync_including_internal_trace_excluding_view_clone_and_outer_trace",
                            "request": command_shape(&command), "succeeded": reconciled.is_ok(),
                            "incomingItemCount": item_count(&sync.view), "currentItemCount": item_count(&current),
                            "resultItemCount": reconciled.as_ref().ok().and_then(item_count),
                            "incomingWindow": &sync.view.window, "currentWindow": &current.window,
                            "resultWindow": reconciled.as_ref().ok().map(|view| &view.window),
                        }));
                        reconciled
                    })
                } else {
                    next.reconcile_sync(&sync, &baseline)
                };
                match reconciled {
                    Ok(mut view) => {
                        view.ownership = sync.view.ownership;
                        view.model_state = sync.view.model_state;
                        {
                            let mut entries = shared
                                .observations
                                .lock()
                                .expect("session observation lock");
                            let entry = entries
                                .get_mut(&session_identity_lane_key(&identity))
                                .expect("sync observation");
                            entry.committed_command = Some(command.clone());
                            entry.committed_view = Some(view.clone());
                            entry.recovery_available = true;
                            for terminal in &sync.terminal_runs {
                                entry.runs.remove(&terminal.run_id);
                                entry.notified_terminals.insert(terminal.run_id.clone());
                            }
                        }
                        self.state = Some(next.clone());
                        shared.store_snapshot_state(next).await;
                        if crate::trace::enabled() {
                            let trace_started = Instant::now();
                            crate::trace::log_unscoped("sessions.sync.reconciled", serde_json::json!({
                                "identity": crate::trace::identity_shape(&identity), "generation": generation,
                                "outcome": "committed", "view": crate::trace::view_shape(&view),
                            }));
                            let trace_elapsed_ms = trace_started.elapsed().as_secs_f64() * 1000.0;
                            crate::trace::log_unscoped("sessions.sync.reconciled_trace_timing", serde_json::json!({
                                "identity": crate::trace::identity_shape(&identity), "generation": generation,
                                "reconciledTraceElapsedMs": trace_elapsed_ms, "timingScope": "reconciled_view_shape_hash_emit_excluding_this_log",
                            }));
                        }
                        if let Some(source) = &shared.session_delta {
                            source.resync(identity.clone(), view.epoch, view.seq);
                        }
                        Some(view)
                    }
                    Err(_) => {
                        if crate::trace::enabled() {
                            crate::trace::log_unscoped("sessions.sync.reconciled", serde_json::json!({
                                "identity": crate::trace::identity_shape(&identity), "generation": generation,
                                "outcome": "rejected", "reason": if terminal_commit_failed { "terminal_commit_failed" } else { "reconcile_rejected" },
                                "current": crate::trace::view_shape(&next.view()),
                            }));
                        }
                        None
                    },
                }
            }
            _ => {
                if crate::trace::enabled() {
                    crate::trace::log_unscoped("sessions.sync.reject", serde_json::json!({
                        "identity": crate::trace::identity_shape(&identity), "generation": generation,
                        "reason": "sync_failed_or_identity_mismatch",
                    }));
                }
                None
            },
        };
        if view.is_none() {
            let (waiters, restart) = {
                let mut entries = shared
                    .observations
                    .lock()
                    .expect("session observation lock");
                let entry = entries
                    .get_mut(&session_identity_lane_key(&identity))
                    .expect("sync observation");
                let restart = failure != RuntimeOperationFailure::TargetRejected
                    && entry.recovery_available
                    && entry.demanded();
                if crate::trace::enabled() {
                    crate::trace::log_unscoped("sessions.sync.failure_close", serde_json::json!({
                        "identity": crate::trace::identity_shape(&identity), "generation": entry.generation,
                        "restart": restart, "recoveryAvailable": entry.recovery_available,
                        "needsSync": entry.needs_sync, "closing": entry.closing, "demanded": entry.demanded(),
                    }));
                }
                entry.recovery_available = false;
                let waiters = if restart {
                    Vec::new()
                } else {
                    entry.take_failed_waiters()
                };
                (waiters, restart)
            };
            for waiter in waiters {
                finish_failed_waiter(waiter, failure).await;
            }
            self.close_observation(shared, &identity, restart);
            return;
        }
        let waiters = {
            let mut entries = shared
                .observations
                .lock()
                .expect("session observation lock");
            let entry = entries
                .get_mut(&session_identity_lane_key(&identity))
                .expect("sync observation");
            let (ready, pending): (Vec<_>, Vec<_>) = std::mem::take(&mut entry.waiters)
                .into_iter()
                .partition(|waiter| waiter.command == command);
            entry.waiters = pending;
            ready
        };
        for waiter in waiters {
            finish_waiter(waiter, view.clone()).await;
        }
        self.continue_observation(shared, &identity);
    }

    pub(super) fn recover_observation(
        &mut self,
        shared: &SessionShared,
        identity: &SessionIdentity,
    ) {
        let restart = {
            let mut entries = shared
                .observations
                .lock()
                .expect("session observation lock");
            let Some(entry) = entries.get_mut(&session_identity_lane_key(identity)) else {
                return;
            };
            if crate::trace::enabled() {
                crate::trace::log_unscoped("sessions.observation.recover", serde_json::json!({
                    "identity": crate::trace::identity_shape(identity), "generation": entry.generation,
                    "needsSyncBefore": entry.needs_sync, "needsSyncAfter": true, "closing": entry.closing,
                    "restart": entry.recovery_available, "hasBaseline": entry.baseline.is_some(),
                }));
            }
            entry.needs_sync = true;
            let restart = entry.recovery_available;
            entry.recovery_available = false;
            restart
        };
        self.close_observation(shared, identity, restart);
    }

    pub(super) fn refresh_goal(&mut self, shared: &SessionShared, identity: &SessionIdentity) {
        if let Some(entry) = shared.observations.lock().expect("session observation lock").get_mut(&session_identity_lane_key(identity)) {
            entry.needs_sync = true;
        }
        self.continue_observation(shared, identity);
    }

    pub(super) fn sync_after_terminal(
        &mut self,
        shared: &SessionShared,
        identity: &SessionIdentity,
    ) {
        self.continue_observation(shared, identity);
    }
}

fn observe_failure(failure: RuntimeOperationFailure) -> SessionObserveOutcome {
    match failure {
        RuntimeOperationFailure::TargetRejected => SessionObserveOutcome::Rejected,
        RuntimeOperationFailure::Unknown => SessionObserveOutcome::Unknown,
        RuntimeOperationFailure::Unsupported | RuntimeOperationFailure::Unavailable => {
            SessionObserveOutcome::Unavailable
        }
    }
}

async fn finish_failed_waiter(waiter: Waiter, failure: RuntimeOperationFailure) {
    match waiter.reply {
        WaiterReply::Observe { reply, .. } => {
            crate::call::reply(waiter.call.as_ref(), reply, observe_failure(failure)).await
        }
        WaiterReply::Timeline(reply) => {
            let reason = match failure {
                RuntimeOperationFailure::TargetRejected => {
                    timeline::UnavailableReason::RuntimeTargetRejected
                }
                RuntimeOperationFailure::Unknown => timeline::UnavailableReason::RuntimeUnknown,
                RuntimeOperationFailure::Unsupported => {
                    timeline::UnavailableReason::RuntimeUnsupported
                }
                RuntimeOperationFailure::Unavailable => {
                    timeline::UnavailableReason::RuntimeUnavailable
                }
            };
            crate::call::reply(
                waiter.call.as_ref(),
                reply,
                timeline::Outcome::unavailable(reason),
            )
            .await;
        }
    }
}

async fn finish_waiter(waiter: Waiter, view: Option<SessionView>) {
    match waiter.reply {
        WaiterReply::Observe {
            lease_id, reply, ..
        } => {
            let outcome = view
                .map(|view| SessionObserveOutcome::Observed { lease_id, view })
                .unwrap_or(SessionObserveOutcome::Unavailable);
            crate::call::reply(waiter.call.as_ref(), reply, outcome).await;
        }
        WaiterReply::Timeline(reply) => {
            let outcome = view
                .map(|view| {
                    if matches!(view.completeness, SessionCompleteness::Complete) {
                        timeline::Outcome::Complete(view)
                    } else {
                        timeline::Outcome::Incomplete(view)
                    }
                })
                .unwrap_or_else(|| {
                    timeline::Outcome::unavailable(timeline::UnavailableReason::RuntimeUnavailable)
                });
            crate::call::reply(waiter.call.as_ref(), reply, outcome).await;
        }
    }
}
