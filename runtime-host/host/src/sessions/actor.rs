use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use arc_swap::ArcSwap;
use foundation::execution::{CommandRoute, LaneRetention, OwnerSpec, QueryRoute};
use platform::endpoint::runtime_address::RuntimeEndpoint;
use tokio::sync::Mutex;

use super::{
    abort::SessionAbortOutcome,
    approval::{PendingApprovalsOutcome, SessionApprovalOutcome},
    command::{
        SessionAbortRequest, SessionCommand, SessionEnsureOutcome, SessionEvent,
        SessionEvictOutcome, SessionIngestOutcome, SessionSendRequest, openclaw_agent_lane_key,
        session_lane_key,
    },
    create::{SessionCreateCommand, SessionCreateOutcome},
    delete::SessionDeleteOutcome,
    events::SessionDeltaSource,
    model_selection::{
        MatchaSessionModelRuntimeCommand, NativeEndpoint, SessionModelSelectionOutcome,
        SessionModelSelectionRejection, SessionRuntimeModelCommand,
    },
    openclaw_direct::{self, SessionCatalog},
    query::SessionQuery,
    rename::SessionRenameOutcome,
    send::{SessionSendCommand, SessionSendOutcome},
    session_permission::SessionPermissionOutcome,
    state::{
        MAX_SAFE_INTEGER, RunPhase, RuntimeIssue, RuntimeView, SessionChange, SessionDelta,
        SessionEventBinding, SessionFacts, SessionIdentity, SessionProvider, SessionSourceBinding,
        SessionState, SessionView,
    },
    terminal_hook::{SessionRunTerminalSnapshot, SessionTerminalHook},
    timeline::{self, ContentCommand, ContentOutcome},
};
use crate::{
    provider::handle::ProviderHandle,
    runtime::directory::RuntimeDriverDirectory,
    runtime::driver::{
        LifecycleOps, RuntimeDriver, RuntimeDriverIdentity, RuntimeOperationFailure,
    },
};
use matcha_agent::session::{
    client::AppServerClientError as MatchaAppServerClientError,
    model::{SessionId as MatchaSessionId, WorkerRuntimeState as MatchaWorkerRuntimeState},
};

pub(crate) struct SessionSnapshot {
    pub(crate) states: HashMap<String, SessionState>,
}

pub(crate) struct SessionOwner {
    shared: SessionShared,
}

#[derive(Clone)]
pub(crate) struct SessionShared {
    runtime_directory: Arc<RuntimeDriverDirectory>,
    provider_handle: ProviderHandle,
    snapshot: Arc<ArcSwap<SessionSnapshot>>,
    snapshot_writer: Arc<Mutex<()>>,
    session_delta: Option<SessionDeltaSource>,
    terminal_hook: Option<Arc<dyn SessionTerminalHook>>,
    epoch: u64,
}

pub(crate) struct SessionLane {
    state: Option<SessionState>,
}

static NEXT_SESSION_EPOCH: AtomicU64 = AtomicU64::new(1);
impl SessionOwner {
    pub(crate) fn new(
        runtime_directory: Arc<RuntimeDriverDirectory>,
        provider_handle: ProviderHandle,
        session_delta: Option<SessionDeltaSource>,
        terminal_hook: Option<Arc<dyn SessionTerminalHook>>,
    ) -> (Self, Arc<ArcSwap<SessionSnapshot>>) {
        let snapshot = Arc::new(ArcSwap::new(Arc::new(SessionSnapshot {
            states: HashMap::new(),
        })));
        let shared = SessionShared {
            runtime_directory,
            provider_handle,
            snapshot: Arc::clone(&snapshot),
            snapshot_writer: Arc::new(Mutex::new(())),
            session_delta,
            terminal_hook,
            epoch: next_session_epoch(),
        };

        (Self { shared }, snapshot)
    }

    pub(crate) fn lane_retention() -> LaneRetention {
        LaneRetention::LowFrequency
    }

    #[cfg(test)]
    pub(crate) fn session_epoch_for_test(&self) -> u64 {
        self.shared.epoch
    }
}

fn next_session_epoch() -> u64 {
    let micros = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_micros()).unwrap_or(MAX_SAFE_INTEGER))
        .unwrap_or(1)
        .clamp(1, MAX_SAFE_INTEGER);
    let mut current = NEXT_SESSION_EPOCH.load(Ordering::Relaxed);
    loop {
        let next = current.max(micros);
        match NEXT_SESSION_EPOCH.compare_exchange(
            current,
            next.saturating_add(1).min(MAX_SAFE_INTEGER),
            Ordering::Relaxed,
            Ordering::Relaxed,
        ) {
            Ok(_) => return next,
            Err(observed) => current = observed,
        }
    }
}

impl SessionShared {
    fn open_lane(&self, key: &str) -> SessionLane {
        SessionLane {
            state: self.snapshot.load().states.get(key).cloned(),
        }
    }

    async fn store_snapshot_state(&self, state: SessionState) {
        let _guard = self.snapshot_writer.lock().await;
        let mut states = self.snapshot.load().states.clone();
        let lane_key =
            session_lane_key(state.identity().provider(), state.identity().session_key());
        states.insert(lane_key, state);
        self.snapshot.store(Arc::new(SessionSnapshot { states }));
    }

    fn emit_session_delta(&self, delta: &SessionDelta, state: &SessionState) {
        if let Some(source) = &self.session_delta {
            source.publish(delta.clone());
        }
        if !state.is_team_source() {
            return;
        }
        let Some(hook) = &self.terminal_hook else {
            return;
        };
        for change in &delta.changes {
            let SessionChange::RunPhaseChanged { run_id, phase } = change else {
                continue;
            };
            if !super::state::terminal_run_phase(*phase) {
                continue;
            }
            let Some(final_assistant_text) = state.assistant_text_for_run_id(run_id) else {
                continue;
            };
            hook.run_terminal(SessionRunTerminalSnapshot {
                provider: state.identity().provider(),
                session_key: delta.session_key.clone(),
                route_key: delta.route_key.clone(),
                source_binding: state.source_binding().clone(),
                native_run_id: run_id.clone(),
                phase: *phase,
                final_assistant_text: Some(final_assistant_text),
            });
        }
    }

    fn emit_hydrated_terminals(&self, state: &SessionState) {
        if !state.is_team_source() {
            return;
        }
        let Some(hook) = &self.terminal_hook else {
            return;
        };
        for (run_id, final_assistant_text) in state.final_assistant_texts_by_run() {
            hook.run_terminal(SessionRunTerminalSnapshot {
                provider: state.identity().provider(),
                session_key: state.identity().session_key().to_owned(),
                route_key: None,
                source_binding: state.source_binding().clone(),
                native_run_id: run_id,
                phase: RunPhase::Completed,
                final_assistant_text: Some(final_assistant_text),
            });
        }
    }

    async fn clear_snapshot_state(&self, lane_key: &str) -> bool {
        let _guard = self.snapshot_writer.lock().await;
        let mut states = self.snapshot.load().states.clone();
        let removed = states.remove(lane_key).is_some();
        self.snapshot.store(Arc::new(SessionSnapshot { states }));
        removed
    }

    fn list_session_views(&self) -> Vec<SessionView> {
        self.snapshot
            .load()
            .states
            .values()
            .map(|state| state.view())
            .collect()
    }

    fn get_session_view(&self, session_key: &str) -> Option<SessionView> {
        self.snapshot
            .load()
            .states
            .values()
            .find(|state| state.identity().session_key() == session_key)
            .map(|state| state.view())
    }

    fn running_driver(
        &self,
        endpoint: Option<RuntimeEndpoint>,
    ) -> Result<Arc<dyn RuntimeDriver>, RuntimeOperationFailure> {
        let endpoint = endpoint.ok_or(RuntimeOperationFailure::Unsupported)?;
        let driver = self
            .runtime_directory
            .lookup(&endpoint)
            .ok_or(RuntimeOperationFailure::Unsupported)?;
        if driver.lifecycle_ops().is_some_and(LifecycleOps::readiness) {
            Ok(driver)
        } else {
            Err(RuntimeOperationFailure::Unavailable)
        }
    }

    fn running_session_driver(
        &self,
        endpoint: Option<RuntimeEndpoint>,
    ) -> Result<Arc<dyn RuntimeDriver>, RuntimeOperationFailure> {
        let driver = self.running_driver(endpoint)?;
        if driver.session_ops().is_some() {
            Ok(driver)
        } else {
            Err(RuntimeOperationFailure::Unsupported)
        }
    }

    async fn handle_pending_approvals(
        &self,
        command: super::approval::PendingApprovalsCommand,
    ) -> PendingApprovalsOutcome {
        let driver = match self.running_session_driver(command.endpoint.runtime_endpoint()) {
            Ok(driver) => driver,
            Err(RuntimeOperationFailure::Unsupported) => {
                return PendingApprovalsOutcome::Unsupported;
            }
            Err(RuntimeOperationFailure::Unavailable) => {
                return PendingApprovalsOutcome::Unavailable;
            }
            Err(RuntimeOperationFailure::TargetRejected | RuntimeOperationFailure::Unknown) => {
                return PendingApprovalsOutcome::Unavailable;
            }
        };
        let Some(ops) = driver.session_ops() else {
            return PendingApprovalsOutcome::Unsupported;
        };
        ops.pending_approvals(command).await
    }

    async fn handle_timeline(&self, command: timeline::Command) -> timeline::Outcome {
        let endpoint = match command.provider() {
            timeline::Provider::OpenClaw => RuntimeDriverIdentity::open_claw().endpoint(),
            timeline::Provider::Matcha => RuntimeDriverIdentity::matcha_agent().endpoint(),
        };
        let driver = match self.running_session_driver(Some(endpoint)) {
            Ok(driver) => driver,
            Err(failure) => {
                return timeline::Outcome::unavailable(timeline_driver_failure(failure));
            }
        };
        let Some(ops) = driver.session_ops() else {
            return timeline::Outcome::unavailable(
                timeline::UnavailableReason::SessionOpsUnavailable,
            );
        };
        let outcome = ops.load_session_timeline(command.clone(), self.epoch).await;
        if command.operation() != timeline::Operation::Load {
            return outcome;
        }
        let Some(open_ops) = ops.open_session_ops() else {
            return outcome;
        };
        match outcome {
            timeline::Outcome::Unavailable(failure) => timeline::Outcome::Unavailable(failure),
            timeline::Outcome::Complete(view) => timeline::Outcome::Complete(
                open_ops
                    .on_load_session_timeline(&command, view, self.provider_handle.clone())
                    .await,
            ),
            timeline::Outcome::Incomplete(view) => timeline::Outcome::Incomplete(
                open_ops
                    .on_load_session_timeline(&command, view, self.provider_handle.clone())
                    .await,
            ),
        }
    }

    async fn handle_content(&self, command: ContentCommand) -> ContentOutcome {
        let endpoint = match command.provider() {
            timeline::Provider::OpenClaw => RuntimeDriverIdentity::open_claw().endpoint(),
            timeline::Provider::Matcha => RuntimeDriverIdentity::matcha_agent().endpoint(),
        };
        let driver = match self.running_session_driver(Some(endpoint)) {
            Ok(driver) => driver,
            Err(failure) => {
                return ContentOutcome::unavailable(timeline_driver_failure(failure));
            }
        };
        let Some(ops) = driver.session_ops() else {
            return ContentOutcome::unavailable(timeline::UnavailableReason::SessionOpsUnavailable);
        };
        ops.load_session_content(command).await
    }

    async fn handle_list_matcha(&self) -> crate::sessions::matcha_session_catalog::Outcome {
        let driver = match self
            .running_session_driver(Some(RuntimeDriverIdentity::matcha_agent().endpoint()))
        {
            Ok(driver) => driver,
            Err(_) => return crate::sessions::matcha_session_catalog::Outcome::Unavailable,
        };
        let Some(ops) = driver.session_ops() else {
            return crate::sessions::matcha_session_catalog::Outcome::Unavailable;
        };
        let outcome = ops.list_matcha_sessions().await;
        if let crate::sessions::matcha_session_catalog::Outcome::Listed(sessions) = &outcome {
            self.store_matcha_catalog_bindings(sessions).await;
        }
        outcome
    }

    /// Read-only list projection: corrects OpenClaw catalog model refs that our own provider
    /// catalog no longer accepts. Never writes back to the runtime.
    ///
    /// Runs at most one provider judgement for the whole catalog, and at most one
    /// `agents.list`-backed default lookup per distinct stale agent.
    async fn reconcile_openclaw_catalog_models(&self, catalog: SessionCatalog) -> SessionCatalog {
        let endpoint = NativeEndpoint::OpenClawLocal;
        let session_count = catalog.sessions.len();
        let driver = self.openclaw_session_driver();
        let defaults_driver = driver.clone();
        let judge_handle = self.provider_handle.clone();
        let rebound_handle = self.provider_handle.clone();
        let (catalog, corrected) = openclaw_direct::reconcile_catalog_models(
            catalog,
            async move |model_refs| match judge_handle
                .accept_session_runtime_models(endpoint, model_refs)
                .await
            {
                Ok(accepted) => openclaw_direct::CatalogModelJudgement::Accepted(accepted),
                Err(_) => openclaw_direct::CatalogModelJudgement::Unavailable,
            },
            move |agent_id| {
                let driver = defaults_driver.clone();
                Box::pin(async move {
                    match driver
                        .as_ref()
                        .and_then(|driver| driver.session_ops())
                        .and_then(|ops| ops.open_session_ops())
                    {
                        Some(ops) => ops.agent_default_model(agent_id).await,
                        None => None,
                    }
                })
            },
            move |entry, default_model| {
                let Ok(command) = SessionRuntimeModelCommand::try_new(
                    endpoint,
                    entry.key.clone(),
                    Some(entry.endpoint_session_id.clone()),
                    entry.model.clone(),
                    default_model,
                ) else {
                    return Box::pin(async { None });
                };
                let handle = rebound_handle.clone();
                Box::pin(async move {
                    handle
                        .resolve_session_model_rebound(command)
                        .await
                        .ok()
                        .and_then(|selection| selection.openclaw_model_ref().map(str::to_owned))
                })
            },
        )
        .await;
        if corrected > 0 {
            log_session_catalog_model_reconciled(session_count, corrected);
        }
        catalog
    }

    fn openclaw_session_driver(&self) -> Option<Arc<dyn RuntimeDriver>> {
        self.running_session_driver(Some(RuntimeDriverIdentity::open_claw().endpoint()))
            .ok()
            .filter(|driver| driver.session_ops().is_some())
    }

    async fn store_matcha_catalog_bindings(
        &self,
        sessions: &[crate::sessions::matcha_session_catalog::Session],
    ) {
        let states = sessions
            .iter()
            .filter_map(|session| matcha_catalog_state(session.endpoint_session_id(), self.epoch))
            .collect::<Vec<_>>();
        if states.is_empty() {
            return;
        }

        let _guard = self.snapshot_writer.lock().await;
        let mut snapshot = self.snapshot.load().states.clone();
        for state in states {
            let lane_key =
                session_lane_key(state.identity().provider(), state.identity().session_key());
            let endpoint_session_id = state.native_session_id().map(str::to_owned);
            let state = match snapshot.remove(&lane_key) {
                Some(existing) if existing.native_session_id().is_some() => existing,
                Some(existing) => existing
                    .with_endpoint_session_id(endpoint_session_id)
                    .unwrap_or(state),
                None => state,
            };
            snapshot.insert(lane_key, state);
        }
        self.snapshot
            .store(Arc::new(SessionSnapshot { states: snapshot }));
    }

    async fn handle_matcha_history(
        &self,
        command: crate::sessions::matcha_history::Command,
    ) -> crate::sessions::matcha_history::Outcome {
        let driver = match self
            .running_session_driver(Some(RuntimeDriverIdentity::matcha_agent().endpoint()))
        {
            Ok(driver) => driver,
            Err(_) => return crate::sessions::matcha_history::Outcome::Unavailable,
        };
        let Some(ops) = driver.session_ops() else {
            return crate::sessions::matcha_history::Outcome::Unavailable;
        };
        ops.load_matcha_history(command).await
    }

    async fn prepare_matcha_send_model_runtime(
        &self,
        command: &SessionSendCommand,
    ) -> Result<(), SessionSendOutcome> {
        if command.endpoint != super::send::NativeEndpoint::MatchaAgentLocal {
            return Ok(());
        }
        let session_id = matcha_session_id(command.endpoint_session_id.as_deref())
            .map_err(|_| SessionSendOutcome::Rejected)?;
        let driver = self
            .running_session_driver(command.endpoint.runtime_endpoint())
            .map_err(send_driver_failure)?;
        let Some(ops) = driver.session_ops() else {
            return Err(SessionSendOutcome::Unsupported);
        };
        let session = ops
            .load_matcha_session(session_id)
            .await
            .map_err(load_matcha_session_failure)?;
        if !matches!(
            session.worker_state,
            MatchaWorkerRuntimeState::Unloaded { .. }
        ) {
            return Ok(());
        }
        if session.model_selection_id.is_none() && session.provider_fingerprint.is_none() {
            return Ok(());
        }
        let Some(model) = session.model else {
            return Ok(());
        };
        let model_runtime = match MatchaSessionModelRuntimeCommand::try_new(
            command.session_key.clone(),
            command.endpoint_session_id.clone(),
            model,
            session.model_selection_id,
            session.provider_fingerprint,
        ) {
            Ok(model_runtime) => model_runtime.with_trace_id(command.trace_id().map(str::to_owned)),
            Err(_) => return Err(SessionSendOutcome::Rejected),
        };
        let model_runtime = self
            .provider_handle
            .resolve_matcha_session_model_runtime(model_runtime)
            .await
            .map_err(session_model_runtime_failure)?;
        match ops.select_session_model(model_runtime).await {
            SessionModelSelectionOutcome::Succeeded => Ok(()),
            outcome => Err(session_model_runtime_failure(outcome)),
        }
    }

    async fn handle_global_command(&self, command: SessionCommand) {
        match command {
            SessionCommand::Send {
                request: SessionSendRequest::OpenClaw(command),
            } => {
                let outcome =
                    super::openclaw_direct::send_chat(&self.runtime_directory, command.params)
                        .await;
                let _ = command.reply.send(outcome);
            }
            SessionCommand::Abort {
                request: SessionAbortRequest::OpenClaw(command),
            } => {
                let outcome =
                    super::openclaw_direct::abort_chat(&self.runtime_directory, command.params)
                        .await;
                let _ = command.reply.send(outcome);
            }
            command => command.send_unavailable(),
        }
    }

    async fn handle_global_query(&self, query: SessionQuery) {
        match query {
            SessionQuery::ListSessions { reply } => {
                let _ = reply.send(self.list_session_views());
            }
            SessionQuery::GetSession { session_key, reply } => {
                let _ = reply.send(self.get_session_view(&session_key));
            }
            SessionQuery::OpenClaw(query) => {
                super::openclaw_direct::reply_query(&self.runtime_directory, query, |catalog| {
                    self.reconcile_openclaw_catalog_models(catalog)
                })
                .await;
            }
            SessionQuery::ListMatcha { reply } => {
                let outcome = self.handle_list_matcha().await;
                let _ = reply.send(outcome);
            }
            SessionQuery::MatchaHistory { command, reply } => {
                let outcome = self.handle_matcha_history(command).await;
                let _ = reply.send(outcome);
            }
            query => query.send_unavailable(),
        }
    }
}

impl SessionLane {
    async fn handle_command(
        &mut self,
        shared: &SessionShared,
        key: String,
        command: SessionCommand,
    ) {
        use SessionCommand::*;
        match command {
            Ensure {
                identity,
                source_binding,
                reply,
            } => {
                let outcome = self
                    .handle_ensure(shared, &key, identity, source_binding)
                    .await;
                let _ = reply.send(outcome);
            }
            Ingest {
                identity,
                event,
                reply,
            } => {
                let outcome = self.handle_ingest(shared, &key, identity, event).await;
                let _ = reply.send(outcome);
            }
            Evict { reply, .. } => {
                let outcome = self.handle_evict(shared, key).await;
                let _ = reply.send(outcome);
            }
            Create { command, reply } => {
                let outcome = self.handle_create(shared, &key, command).await;
                let _ = reply.send(outcome);
            }
            Send { request } => match request {
                SessionSendRequest::Session { command, reply } => {
                    let outcome = self.handle_send(shared, command).await;
                    let _ = reply.send(outcome);
                }
                SessionSendRequest::OpenClaw(command) => {
                    let outcome = super::openclaw_direct::send_chat(
                        &shared.runtime_directory,
                        command.params,
                    )
                    .await;
                    let _ = command.reply.send(outcome);
                }
            },
            Abort { request } => match request {
                SessionAbortRequest::Session { command, reply } => {
                    let outcome = self.handle_abort(shared, command).await;
                    let _ = reply.send(outcome);
                }
                SessionAbortRequest::OpenClaw(command) => {
                    let outcome = super::openclaw_direct::abort_chat(
                        &shared.runtime_directory,
                        command.params,
                    )
                    .await;
                    let _ = command.reply.send(outcome);
                }
            },
            Delete { command, reply } => {
                let outcome = self.handle_delete(shared, command).await;
                let _ = reply.send(outcome);
            }
            Rename { command, reply } => {
                let outcome = self.handle_rename(shared, command).await;
                let _ = reply.send(outcome);
            }
            Approval { command, reply } => {
                let outcome = self.handle_approval(shared, command).await;
                let _ = reply.send(outcome);
            }
            ModelSelection { command, reply } => {
                let outcome = self.handle_model_selection(shared, command).await;
                let _ = reply.send(outcome);
            }
            Permission { command, reply } => {
                let outcome = self.handle_permission(shared, command).await;
                let _ = reply.send(outcome);
            }
        }
    }

    async fn handle_ensure(
        &mut self,
        shared: &SessionShared,
        key: &str,
        identity: SessionIdentity,
        source_binding: SessionSourceBinding,
    ) -> SessionEnsureOutcome {
        let expected_key = session_lane_key(identity.provider(), identity.session_key());
        if expected_key != key {
            return SessionEnsureOutcome::Failed;
        }

        if let Some(existing) = &mut self.state {
            if !existing.bind_source(source_binding) {
                return SessionEnsureOutcome::Failed;
            }
            let existing = existing.clone();
            shared.store_snapshot_state(existing.clone()).await;
            return SessionEnsureOutcome::Existing(existing);
        }

        let endpoint = RuntimeEndpoint::try_new(
            adapter_id_str(&identity.endpoint.runtime_adapter_id),
            &identity.endpoint.runtime_instance_id,
        );

        let Some(endpoint) = endpoint.ok() else {
            return SessionEnsureOutcome::RuntimeNotFound;
        };

        let Some(runtime) = shared.runtime_directory.lookup(&endpoint) else {
            return SessionEnsureOutcome::RuntimeNotFound;
        };

        let Some(_session_ops) = runtime.session_ops() else {
            return SessionEnsureOutcome::RuntimeNoSessionSupport;
        };

        let state = match SessionState::new(identity, shared.epoch) {
            Ok(state) => state.with_source_binding(source_binding),
            Err(_) => return SessionEnsureOutcome::Failed,
        };

        self.state = Some(state.clone());
        shared.store_snapshot_state(state.clone()).await;

        SessionEnsureOutcome::Created(state)
    }

    async fn handle_ingest(
        &mut self,
        shared: &SessionShared,
        key: &str,
        identity: SessionIdentity,
        event: SessionEvent,
    ) -> SessionIngestOutcome {
        let session_key = event.binding.session_key().to_owned();
        if session_lane_key(identity.provider(), &session_key) != key {
            return SessionIngestOutcome::Rejected {
                reason: "Session key mismatch".to_owned(),
            };
        }
        let provider = identity.endpoint.provider();

        if let Some(state) = &self.state {
            if state.identity().provider() != provider {
                return SessionIngestOutcome::Rejected {
                    reason: "Provider mismatch".to_owned(),
                };
            }
        }

        if let [SessionChange::RecoveryRequired { reason }] = event.changes.as_slice() {
            let result = self
                .apply_recovery_to_state(
                    shared,
                    &session_key,
                    provider,
                    &identity,
                    &SessionSourceBinding::ordinary(),
                    event.binding,
                    event.run_id,
                    event.cursor,
                    *reason,
                )
                .await;
            return Self::map_apply_result(result);
        }

        if let Some(state) = &self.state {
            if state.native_source_epoch_changed(&event.binding) {
                let recovery_result = self
                    .apply_recovery_to_state(
                        shared,
                        &session_key,
                        provider,
                        &identity,
                        &SessionSourceBinding::ordinary(),
                        event.binding.clone(),
                        event.run_id.clone(),
                        event.cursor,
                        super::state::RecoveryReason::EpochChanged,
                    )
                    .await;
                if !matches!(
                    recovery_result,
                    super::state::SessionApplyResult::Applied(_)
                ) {
                    return Self::map_apply_result(recovery_result);
                }
            }
        }

        let result = self
            .apply_changes_to_state(
                shared,
                &session_key,
                provider,
                &identity,
                &SessionSourceBinding::ordinary(),
                event.binding,
                event.run_id,
                event.cursor,
                event.changes,
            )
            .await;
        Self::map_apply_result(result)
    }

    async fn apply_changes_to_state(
        &mut self,
        shared: &SessionShared,
        session_key: &str,
        provider: SessionProvider,
        identity: &SessionIdentity,
        source_binding: &SessionSourceBinding,
        binding: SessionEventBinding,
        run_id: Option<String>,
        native_cursor: Option<u64>,
        changes: Vec<SessionChange>,
    ) -> super::state::SessionApplyResult {
        let state = match self.event_state(shared, session_key, provider, identity, source_binding)
        {
            Ok(state) => state,
            Err(result) => return result,
        };

        let mut next = state;
        let result = next.apply_native_bound(binding, run_id, native_cursor, changes);

        if let super::state::SessionApplyResult::Applied(delta) = &result {
            self.state = Some(next.clone());
            shared.store_snapshot_state(next.clone()).await;
            shared.emit_session_delta(delta, &next);
        }

        result
    }

    async fn apply_recovery_to_state(
        &mut self,
        shared: &SessionShared,
        session_key: &str,
        provider: SessionProvider,
        identity: &SessionIdentity,
        source_binding: &SessionSourceBinding,
        binding: SessionEventBinding,
        run_id: Option<String>,
        native_cursor: Option<u64>,
        reason: super::state::RecoveryReason,
    ) -> super::state::SessionApplyResult {
        let state = match self.event_state(shared, session_key, provider, identity, source_binding)
        {
            Ok(state) => state,
            Err(result) => return result,
        };

        let mut next = state;
        let result = next.apply_native_recovery_bound(binding, run_id, native_cursor, reason);

        if let super::state::SessionApplyResult::Applied(delta) = &result {
            self.state = Some(next.clone());
            shared.store_snapshot_state(next.clone()).await;
            shared.emit_session_delta(delta, &next);
        }

        result
    }

    fn event_state(
        &self,
        shared: &SessionShared,
        session_key: &str,
        provider: SessionProvider,
        identity: &SessionIdentity,
        source_binding: &SessionSourceBinding,
    ) -> Result<SessionState, super::state::SessionApplyResult> {
        match &self.state {
            Some(state) if state.identity().provider() == provider => {
                let mut state = state.clone();
                if state.bind_source(source_binding.clone()) {
                    Ok(state)
                } else {
                    Err(super::state::SessionApplyResult::Rejected {
                        reason: super::state::SessionApplyRejection::InvalidInput,
                    })
                }
            }
            Some(_) => Err(super::state::SessionApplyResult::Rejected {
                reason: super::state::SessionApplyRejection::InvalidInput,
            }),
            None => {
                if identity.session_key() != session_key || identity.provider() != provider {
                    return Err(super::state::SessionApplyResult::Rejected {
                        reason: super::state::SessionApplyRejection::InvalidInput,
                    });
                }
                SessionState::new(identity.clone(), shared.epoch)
                    .map(|state| state.with_source_binding(source_binding.clone()))
                    .map_err(|_| super::state::SessionApplyResult::Rejected {
                        reason: super::state::SessionApplyRejection::InvalidInput,
                    })
            }
        }
    }

    fn map_apply_result(result: super::state::SessionApplyResult) -> SessionIngestOutcome {
        match result {
            super::state::SessionApplyResult::Applied(delta) => {
                SessionIngestOutcome::Applied(delta)
            }
            super::state::SessionApplyResult::Duplicate { cursor } => {
                SessionIngestOutcome::Duplicate { cursor }
            }
            super::state::SessionApplyResult::Stale { cursor, received } => {
                SessionIngestOutcome::Stale { cursor, received }
            }
            super::state::SessionApplyResult::Gap { expected, received } => {
                SessionIngestOutcome::Gap { expected, received }
            }
            super::state::SessionApplyResult::Rejected { reason } => {
                SessionIngestOutcome::Rejected {
                    reason: format!("{:?}", reason),
                }
            }
        }
    }

    async fn handle_evict(
        &mut self,
        shared: &SessionShared,
        session_key: String,
    ) -> SessionEvictOutcome {
        let had_lane_state = self.state.take().is_some();
        let had_snapshot_state = shared.clear_snapshot_state(&session_key).await;
        if had_lane_state || had_snapshot_state {
            SessionEvictOutcome::Evicted
        } else {
            SessionEvictOutcome::NotFound
        }
    }

    fn session_identity(
        &self,
        provider: SessionProvider,
        session_key: &str,
    ) -> Option<SessionIdentity> {
        match &self.state {
            Some(state)
                if state.identity().provider() == provider
                    && state.identity().session_key() == session_key =>
            {
                Some(state.identity().clone())
            }
            _ => SessionIdentity::new(session_key.to_owned(), provider, None),
        }
    }

    fn matcha_native_session_id(
        &mut self,
        shared: &SessionShared,
        session_key: &str,
    ) -> Option<String> {
        if let Some(session_id) = self
            .state
            .as_ref()
            .filter(|state| {
                state.identity().provider() == SessionProvider::MatchaAgent
                    && state.identity().session_key() == session_key
            })
            .and_then(SessionState::native_session_id)
        {
            return Some(session_id.to_owned());
        }

        let lane_key = session_lane_key(SessionProvider::MatchaAgent, session_key);
        let state = shared.snapshot.load().states.get(&lane_key).cloned()?;
        let session_id = state.native_session_id()?.to_owned();
        self.state = Some(state);
        Some(session_id)
    }

    fn bind_matcha_send_command(
        &mut self,
        shared: &SessionShared,
        command: super::send::SessionSendCommand,
    ) -> Result<super::send::SessionSendCommand, SessionSendOutcome> {
        if command.endpoint != super::send::NativeEndpoint::MatchaAgentLocal {
            return Ok(command);
        }
        let Some(session_id) = self.matcha_native_session_id(shared, &command.session_key) else {
            return Err(SessionSendOutcome::Rejected);
        };
        command
            .with_endpoint_session_id(session_id)
            .map_err(|_| SessionSendOutcome::Rejected)
    }

    fn bind_matcha_abort_command(
        &mut self,
        shared: &SessionShared,
        command: super::abort::SessionAbortCommand,
    ) -> Result<super::abort::SessionAbortCommand, SessionAbortOutcome> {
        if command.endpoint != super::abort::NativeEndpoint::MatchaAgentLocal {
            return Ok(command);
        }
        let Some(session_id) = self.matcha_native_session_id(shared, &command.session_key) else {
            return Err(SessionAbortOutcome::Rejected);
        };
        command
            .with_endpoint_session_id(session_id)
            .map_err(|_| SessionAbortOutcome::Rejected)
    }

    fn bind_matcha_model_selection_command(
        &mut self,
        shared: &SessionShared,
        command: super::model_selection::SessionModelSelectionCommand,
    ) -> Result<super::model_selection::SessionModelSelectionCommand, SessionModelSelectionOutcome>
    {
        if command.endpoint != super::model_selection::NativeEndpoint::MatchaAgentLocal {
            return Ok(command);
        }
        let Some(session_id) = self.matcha_native_session_id(shared, &command.session_key) else {
            return Err(SessionModelSelectionOutcome::target_rejected(
                SessionModelSelectionRejection::InvalidSessionKey,
            ));
        };
        command.with_endpoint_session_id(session_id).map_err(|_| {
            SessionModelSelectionOutcome::target_rejected(
                SessionModelSelectionRejection::InvalidSessionKey,
            )
        })
    }

    fn bind_matcha_timeline_command(
        &mut self,
        shared: &SessionShared,
        command: timeline::Command,
    ) -> Result<timeline::Command, timeline::Outcome> {
        if command.provider() != timeline::Provider::Matcha {
            return Ok(command);
        }
        let session_id = self
            .matcha_native_session_id(shared, command.session_key())
            .ok_or_else(|| {
                timeline::Outcome::unavailable(
                    timeline::UnavailableReason::MatchaMissingNativeSessionId,
                )
            })?;
        command.with_endpoint_session_id(session_id).ok_or_else(|| {
            timeline::Outcome::unavailable(timeline::UnavailableReason::MatchaIdentityInvalid)
        })
    }

    fn bind_matcha_content_command(
        &mut self,
        shared: &SessionShared,
        command: ContentCommand,
    ) -> Result<ContentCommand, ContentOutcome> {
        if command.provider() != timeline::Provider::Matcha {
            return Ok(command);
        }
        let session_id = self
            .matcha_native_session_id(shared, command.session_key())
            .ok_or_else(|| {
                ContentOutcome::unavailable(
                    timeline::UnavailableReason::MatchaMissingNativeSessionId,
                )
            })?;
        command.with_endpoint_session_id(session_id).ok_or_else(|| {
            ContentOutcome::unavailable(timeline::UnavailableReason::MatchaIdentityInvalid)
        })
    }

    async fn store_timeline_outcome(
        &mut self,
        shared: &SessionShared,
        outcome: &timeline::Outcome,
    ) {
        let view = match outcome {
            timeline::Outcome::Complete(view) | timeline::Outcome::Incomplete(view) => view,
            timeline::Outcome::Unavailable(_) => return,
        };
        let Some(state) = state_from_view_seeded(view, self.state.as_ref()) else {
            return;
        };
        self.state = Some(state.clone());
        shared.store_snapshot_state(state.clone()).await;
        shared.emit_hydrated_terminals(&state);
    }

    async fn handle_create(
        &mut self,
        shared: &SessionShared,
        key: &str,
        command: SessionCreateCommand,
    ) -> SessionCreateOutcome {
        if session_lane_key(command.provider(), command.session_key()) != key {
            return SessionCreateOutcome::Unknown;
        }
        let driver = match shared.running_session_driver(Some(command.endpoint().clone())) {
            Ok(driver) => driver,
            Err(RuntimeOperationFailure::Unsupported | RuntimeOperationFailure::Unavailable) => {
                return SessionCreateOutcome::Unknown;
            }
            Err(RuntimeOperationFailure::TargetRejected) => {
                return SessionCreateOutcome::TargetRejected;
            }
            Err(RuntimeOperationFailure::Unknown) => return SessionCreateOutcome::Unknown,
        };
        let Some(ops) = driver.session_ops() else {
            return SessionCreateOutcome::Unknown;
        };
        match ops.create_session(command, shared.epoch).await {
            SessionCreateOutcome::Succeeded(view) => {
                let Some(state) = state_from_view(&view) else {
                    return SessionCreateOutcome::Unknown;
                };
                self.state = Some(state.clone());
                shared.store_snapshot_state(state).await;
                SessionCreateOutcome::Succeeded(view)
            }
            outcome => outcome,
        }
    }

    async fn handle_send(
        &mut self,
        shared: &SessionShared,
        command: super::send::SessionSendCommand,
    ) -> SessionSendOutcome {
        let provider = command.endpoint.provider();
        let session_key = command.session_key.clone();
        let route_key = command.route_key.clone();
        let source_binding = command.source_binding.clone();
        let failure_run_id = match command.endpoint {
            super::send::NativeEndpoint::OpenClawLocal => None,
            super::send::NativeEndpoint::MatchaAgentLocal => {
                command.request_run_identity().map(str::to_owned)
            }
            super::send::NativeEndpoint::Unsupported => None,
        };
        let identity = self.session_identity(provider, &session_key);
        let binding = SessionEventBinding::new(session_key.clone(), Some(route_key), None);
        let command = match self.bind_matcha_send_command(shared, command) {
            Ok(command) => command,
            Err(outcome) => {
                self.apply_send_outcome(
                    shared,
                    &session_key,
                    provider,
                    identity,
                    &source_binding,
                    binding,
                    &outcome,
                    failure_run_id,
                )
                .await;
                return outcome;
            }
        };

        let outcome = match shared.prepare_matcha_send_model_runtime(&command).await {
            Ok(()) => match shared.running_session_driver(command.endpoint.runtime_endpoint()) {
                Ok(driver) => match driver.session_ops() {
                    Some(ops) => ops.send_session(command).await,
                    None => SessionSendOutcome::Unsupported,
                },
                Err(RuntimeOperationFailure::Unsupported) => SessionSendOutcome::Unsupported,
                Err(RuntimeOperationFailure::Unavailable) => SessionSendOutcome::Unavailable,
                Err(RuntimeOperationFailure::TargetRejected) => SessionSendOutcome::Rejected,
                Err(RuntimeOperationFailure::Unknown) => SessionSendOutcome::Unknown,
            },
            Err(outcome) => outcome,
        };
        self.apply_send_outcome(
            shared,
            &session_key,
            provider,
            identity,
            &source_binding,
            binding,
            &outcome,
            failure_run_id,
        )
        .await;
        outcome
    }

    async fn apply_send_outcome(
        &mut self,
        shared: &SessionShared,
        session_key: &str,
        provider: SessionProvider,
        identity: Option<SessionIdentity>,
        source_binding: &SessionSourceBinding,
        binding: Option<SessionEventBinding>,
        outcome: &SessionSendOutcome,
        failure_run_id: Option<String>,
    ) {
        let (Some(identity), Some(binding)) = (identity, binding) else {
            return;
        };
        let (run_id, runtime) = match send_outcome_runtime(outcome, failure_run_id) {
            Some(projection) => projection,
            None => return,
        };
        let _ = self
            .apply_changes_to_state(
                shared,
                session_key,
                provider,
                &identity,
                source_binding,
                binding,
                run_id,
                None,
                vec![SessionChange::RuntimeChanged { runtime }],
            )
            .await;
    }

    async fn handle_abort(
        &mut self,
        shared: &SessionShared,
        command: super::abort::SessionAbortCommand,
    ) -> SessionAbortOutcome {
        let command = match self.bind_matcha_abort_command(shared, command) {
            Ok(command) => command,
            Err(outcome) => return outcome,
        };
        let driver = match shared.running_session_driver(command.endpoint.runtime_endpoint()) {
            Ok(driver) => driver,
            Err(RuntimeOperationFailure::Unsupported) => return SessionAbortOutcome::Unsupported,
            Err(RuntimeOperationFailure::Unavailable) => return SessionAbortOutcome::Unavailable,
            Err(RuntimeOperationFailure::TargetRejected | RuntimeOperationFailure::Unknown) => {
                return SessionAbortOutcome::Unknown;
            }
        };
        let Some(ops) = driver.session_ops() else {
            return SessionAbortOutcome::Unsupported;
        };
        ops.abort_session(command).await
    }

    async fn handle_delete(
        &mut self,
        shared: &SessionShared,
        command: super::delete::SessionDeleteCommand,
    ) -> SessionDeleteOutcome {
        let lane_key = openclaw_agent_lane_key(&command.agent_id, &command.session_key);
        let driver = match shared
            .running_session_driver(Some(RuntimeDriverIdentity::open_claw().endpoint()))
        {
            Ok(driver) => driver,
            Err(_) => return SessionDeleteOutcome::Unknown,
        };
        let Some(ops) = driver.session_ops() else {
            return SessionDeleteOutcome::Unknown;
        };
        let outcome = ops.delete_session(command).await;
        if outcome == SessionDeleteOutcome::Succeeded {
            self.state = None;
            shared.clear_snapshot_state(&lane_key).await;
        }
        outcome
    }

    async fn handle_rename(
        &mut self,
        shared: &SessionShared,
        command: super::rename::SessionRenameCommand,
    ) -> SessionRenameOutcome {
        let driver = match shared
            .running_session_driver(Some(RuntimeDriverIdentity::open_claw().endpoint()))
        {
            Ok(driver) => driver,
            Err(_) => return SessionRenameOutcome::Unknown,
        };
        let Some(ops) = driver.session_ops() else {
            return SessionRenameOutcome::Unknown;
        };
        ops.rename_session(command).await
    }

    async fn handle_approval(
        &mut self,
        shared: &SessionShared,
        command: super::approval::SessionApprovalCommand,
    ) -> SessionApprovalOutcome {
        let driver = match shared.running_session_driver(command.endpoint.runtime_endpoint()) {
            Ok(driver) => driver,
            Err(RuntimeOperationFailure::Unsupported) => {
                return SessionApprovalOutcome::Unsupported;
            }
            Err(RuntimeOperationFailure::Unavailable) => {
                return SessionApprovalOutcome::Unavailable;
            }
            Err(RuntimeOperationFailure::TargetRejected | RuntimeOperationFailure::Unknown) => {
                return SessionApprovalOutcome::Unavailable;
            }
        };
        let Some(ops) = driver.session_ops() else {
            return SessionApprovalOutcome::Unsupported;
        };
        ops.respond_to_approval(command).await
    }

    async fn handle_permission(
        &mut self,
        shared: &SessionShared,
        command: super::session_permission::SessionPermissionCommand,
    ) -> SessionPermissionOutcome {
        let Some(endpoint) = command.endpoint.runtime_endpoint() else {
            return SessionPermissionOutcome::unsupported();
        };
        let driver = match shared.running_session_driver(Some(endpoint)) {
            Ok(driver) => driver,
            Err(RuntimeOperationFailure::Unsupported) => {
                return SessionPermissionOutcome::unsupported();
            }
            Err(RuntimeOperationFailure::Unavailable) => {
                return SessionPermissionOutcome::Unavailable;
            }
            Err(RuntimeOperationFailure::TargetRejected | RuntimeOperationFailure::Unknown) => {
                return SessionPermissionOutcome::Unavailable;
            }
        };
        let Some(ops) = driver.session_ops() else {
            return SessionPermissionOutcome::unsupported();
        };
        ops.session_permission(command).await
    }

    async fn handle_model_selection(
        &mut self,
        shared: &SessionShared,
        command: super::model_selection::SessionModelSelectionCommand,
    ) -> SessionModelSelectionOutcome {
        let command = match self.bind_matcha_model_selection_command(shared, command) {
            Ok(command) => command,
            Err(outcome) => return outcome,
        };
        let Some(endpoint) = command.endpoint.runtime_endpoint() else {
            return SessionModelSelectionOutcome::Unsupported;
        };
        if let Err(failure) = shared
            .running_session_driver(Some(endpoint.clone()))
            .map(|_| ())
        {
            return match failure {
                RuntimeOperationFailure::Unsupported => SessionModelSelectionOutcome::Unsupported,
                RuntimeOperationFailure::Unavailable => SessionModelSelectionOutcome::Unavailable,
                RuntimeOperationFailure::TargetRejected => {
                    SessionModelSelectionOutcome::target_rejected(
                        SessionModelSelectionRejection::RuntimeTargetRejected,
                    )
                }
                RuntimeOperationFailure::Unknown => SessionModelSelectionOutcome::OutcomeUnknown,
            };
        }
        let command = match shared
            .provider_handle
            .resolve_session_model_selection(command)
            .await
        {
            Ok(command) => command,
            Err(outcome) => return outcome,
        };
        let diagnostic = command.diagnostic.clone();
        let driver = match shared.running_session_driver(Some(endpoint)) {
            Ok(driver) => driver,
            Err(RuntimeOperationFailure::Unsupported) => {
                return SessionModelSelectionOutcome::Unsupported;
            }
            Err(RuntimeOperationFailure::Unavailable) => {
                return SessionModelSelectionOutcome::Unavailable;
            }
            Err(RuntimeOperationFailure::TargetRejected) => {
                return SessionModelSelectionOutcome::target_rejected(
                    SessionModelSelectionRejection::RuntimeTargetRejected,
                );
            }
            Err(RuntimeOperationFailure::Unknown) => {
                return SessionModelSelectionOutcome::OutcomeUnknown;
            }
        };
        let Some(ops) = driver.session_ops() else {
            return SessionModelSelectionOutcome::Unsupported;
        };
        ops.select_session_model(command)
            .await
            .with_diagnostic(diagnostic)
    }

    async fn handle_query(&mut self, shared: &SessionShared, query: SessionQuery) {
        match query {
            SessionQuery::ListSessions { reply } => {
                let _ = reply.send(shared.list_session_views());
            }
            SessionQuery::GetSession { session_key, reply } => {
                let _ = reply.send(shared.get_session_view(&session_key));
            }
            SessionQuery::PendingApprovals { command, reply } => {
                let outcome = shared.handle_pending_approvals(command).await;
                let _ = reply.send(outcome);
            }
            SessionQuery::Timeline { command, reply } => {
                let outcome = match self.bind_matcha_timeline_command(shared, command) {
                    Ok(command) => shared.handle_timeline(command).await,
                    Err(outcome) => outcome,
                };
                self.store_timeline_outcome(shared, &outcome).await;
                let _ = reply.send(outcome);
            }
            SessionQuery::Content { command, reply } => {
                let outcome = match self.bind_matcha_content_command(shared, command) {
                    Ok(command) => shared.handle_content(command).await,
                    Err(outcome) => outcome,
                };
                let _ = reply.send(outcome);
            }
            SessionQuery::OpenClaw(query) => {
                super::openclaw_direct::reply_query(&shared.runtime_directory, query, |catalog| {
                    shared.reconcile_openclaw_catalog_models(catalog)
                })
                .await;
            }
            SessionQuery::MatchaHistory { command, reply } => {
                let outcome = shared.handle_matcha_history(command).await;
                let _ = reply.send(outcome);
            }
            query @ SessionQuery::ListMatcha { .. } => {
                shared.handle_global_query(query).await;
            }
        }
    }
}

impl OwnerSpec for SessionOwner {
    type Command = SessionCommand;
    type Query = SessionQuery;
    type Key = String;
    type Shared = SessionShared;
    type GlobalState = ();
    type LaneState = SessionLane;

    fn split(self) -> (Self::Shared, Self::GlobalState) {
        (self.shared, ())
    }

    fn route_command(command: &Self::Command) -> CommandRoute<Self::Key> {
        command.route()
    }

    fn route_query(query: &Self::Query) -> QueryRoute<Self::Key> {
        query.route()
    }

    fn open_lane(shared: &Self::Shared, key: &Self::Key) -> Self::LaneState {
        shared.open_lane(key)
    }

    async fn handle_keyed_command(
        shared: Self::Shared,
        key: Self::Key,
        lane: &mut Self::LaneState,
        command: Self::Command,
    ) {
        lane.handle_command(&shared, key, command).await;
    }

    async fn handle_global_command(
        shared: Self::Shared,
        _state: &mut Self::GlobalState,
        command: Self::Command,
    ) {
        shared.handle_global_command(command).await;
    }

    async fn handle_direct_query(shared: Self::Shared, query: Self::Query) {
        match query {
            SessionQuery::ListSessions { reply } => {
                let _ = reply.send(shared.list_session_views());
            }
            SessionQuery::GetSession { session_key, reply } => {
                let _ = reply.send(shared.get_session_view(&session_key));
            }
            query => query.send_unavailable(),
        }
    }

    async fn handle_keyed_query(
        shared: Self::Shared,
        _key: Self::Key,
        lane: &mut Self::LaneState,
        query: Self::Query,
    ) {
        lane.handle_query(&shared, query).await;
    }

    async fn handle_global_query(
        shared: Self::Shared,
        _state: &mut Self::GlobalState,
        query: Self::Query,
    ) {
        shared.handle_global_query(query).await;
    }

    async fn handle_exclusive_query(
        shared: Self::Shared,
        state: &mut Self::GlobalState,
        query: Self::Query,
    ) {
        Self::handle_global_query(shared, state, query).await;
    }

    async fn shutdown(
        shared: Self::Shared,
        _state: &mut Self::GlobalState,
        lanes: Vec<(Self::Key, Self::LaneState)>,
    ) {
        for (_key, lane) in lanes {
            if let Some(state) = lane.state {
                shared.store_snapshot_state(state).await;
            }
        }
    }
}

fn log_session_catalog_model_reconciled(session_count: usize, corrected_count: usize) {
    if std::env::var("MATCHACLAW_SESSION_TRACE").as_deref() != Ok("1") {
        return;
    }
    eprintln!(
        "{}",
        serde_json::json!({
            "prefix": "session-trace",
            "source": "runtime-host",
            "stage": "runtime.session-catalog.model-reconciled",
            "sessionCount": session_count,
            "correctedCount": corrected_count,
        })
    );
}

fn send_driver_failure(failure: RuntimeOperationFailure) -> SessionSendOutcome {
    match failure {
        RuntimeOperationFailure::Unsupported => SessionSendOutcome::Unsupported,
        RuntimeOperationFailure::Unavailable => SessionSendOutcome::Unavailable,
        RuntimeOperationFailure::TargetRejected => SessionSendOutcome::Rejected,
        RuntimeOperationFailure::Unknown => SessionSendOutcome::Unknown,
    }
}

fn load_matcha_session_failure(error: MatchaAppServerClientError) -> SessionSendOutcome {
    match error {
        MatchaAppServerClientError::SessionNotFound | MatchaAppServerClientError::PeerRejected => {
            SessionSendOutcome::Rejected
        }
        MatchaAppServerClientError::HealthDeadline
        | MatchaAppServerClientError::HealthFailed
        | MatchaAppServerClientError::UpgradeDeadline
        | MatchaAppServerClientError::UpgradeFailed
        | MatchaAppServerClientError::InitializeFailed
        | MatchaAppServerClientError::RequestDeadline
        | MatchaAppServerClientError::ConnectionClosed
        | MatchaAppServerClientError::Transport => SessionSendOutcome::Unavailable,
        MatchaAppServerClientError::InvalidEndpoint
        | MatchaAppServerClientError::UnknownResponse
        | MatchaAppServerClientError::Protocol
        | MatchaAppServerClientError::EventRecoveryRequired
        | MatchaAppServerClientError::CloseFailed => SessionSendOutcome::Unknown,
    }
}

fn session_model_runtime_failure(outcome: SessionModelSelectionOutcome) -> SessionSendOutcome {
    match outcome {
        SessionModelSelectionOutcome::Succeeded => SessionSendOutcome::Unknown,
        SessionModelSelectionOutcome::TargetRejected {
            reason: SessionModelSelectionRejection::MatchaProviderRuntimeUnavailable,
            ..
        } => SessionSendOutcome::Unavailable,
        SessionModelSelectionOutcome::TargetRejected { .. } => SessionSendOutcome::Rejected,
        SessionModelSelectionOutcome::OutcomeUnknown => SessionSendOutcome::Unknown,
        SessionModelSelectionOutcome::Unsupported => SessionSendOutcome::Unsupported,
        SessionModelSelectionOutcome::Unavailable => SessionSendOutcome::Unavailable,
    }
}

fn send_outcome_runtime(
    outcome: &SessionSendOutcome,
    failure_run_id: Option<String>,
) -> Option<(Option<String>, RuntimeView)> {
    let (run_id, phase, issue) = match outcome {
        SessionSendOutcome::Queued { run_id } => (Some(run_id.clone()), RunPhase::Queued, None),
        SessionSendOutcome::Succeeded { run_id, .. } => {
            (Some(run_id.clone()), RunPhase::Started, None)
        }
        SessionSendOutcome::Rejected => (
            failure_run_id,
            RunPhase::Failed,
            Some(RuntimeIssue::Rejected),
        ),
        SessionSendOutcome::Unavailable => (
            failure_run_id,
            RunPhase::Failed,
            Some(RuntimeIssue::Unavailable),
        ),
        SessionSendOutcome::Unknown => (
            failure_run_id,
            RunPhase::Failed,
            Some(RuntimeIssue::Unknown),
        ),
        SessionSendOutcome::Unsupported => return None,
    };
    let active_run_id = match phase {
        RunPhase::Cancelled | RunPhase::Completed | RunPhase::Failed | RunPhase::Interrupted => {
            None
        }
        _ => run_id.clone(),
    };
    Some((
        run_id.clone(),
        RuntimeView {
            phase,
            active_run_id,
            issue,
            run_progress: None,
            runtime_activity: None,
            error_detail: None,
        },
    ))
}

fn timeline_driver_failure(failure: RuntimeOperationFailure) -> timeline::UnavailableReason {
    match failure {
        RuntimeOperationFailure::Unsupported => timeline::UnavailableReason::RuntimeUnsupported,
        RuntimeOperationFailure::Unavailable => timeline::UnavailableReason::RuntimeUnavailable,
        RuntimeOperationFailure::TargetRejected => {
            timeline::UnavailableReason::RuntimeTargetRejected
        }
        RuntimeOperationFailure::Unknown => timeline::UnavailableReason::RuntimeUnknown,
    }
}

fn adapter_id_str(provider: &SessionProvider) -> &'static str {
    provider.as_str()
}

fn state_from_view(view: &SessionView) -> Option<SessionState> {
    state_from_view_seeded(view, None)
}

fn state_from_view_seeded(
    view: &SessionView,
    previous: Option<&SessionState>,
) -> Option<SessionState> {
    let facts = SessionFacts {
        items: view.items.clone(),
        tools: view.tools.clone(),
        approvals: view.approvals.clone(),
        runtime: view.runtime.clone(),
        window: view.window.clone(),
        completeness: view.completeness.clone(),
    };
    let (seq, cursor) = match previous {
        Some(state) if state.epoch() == view.epoch => {
            (state.seq().max(view.seq), state.cursor().max(view.cursor))
        }
        _ => (view.seq, view.cursor),
    };
    let source_binding = previous
        .map(|state| state.source_binding().clone())
        .unwrap_or_else(SessionSourceBinding::ordinary);
    SessionState::from_view_parts(view.identity.clone(), view.epoch, seq, cursor, facts)
        .ok()?
        .with_source_binding(source_binding)
        .with_endpoint_session_id(view.endpoint_session_id.clone())
        .ok()
}

fn matcha_catalog_state(endpoint_session_id: &str, epoch: u64) -> Option<SessionState> {
    let identity = RuntimeDriverIdentity::matcha_agent();
    let agent_id = identity.default_agent_id();
    let identity = SessionIdentity::new(
        identity.rendered_session_key(agent_id, endpoint_session_id)?,
        SessionProvider::MatchaAgent,
        Some(agent_id.to_owned()),
    )?;
    SessionState::new(identity, epoch)
        .ok()?
        .with_endpoint_session_id(Some(endpoint_session_id.to_owned()))
        .ok()
}

fn matcha_session_id(session_id: Option<&str>) -> Result<MatchaSessionId, ()> {
    MatchaSessionId::try_new(session_id.ok_or(())?.to_owned()).map_err(|_| ())
}
