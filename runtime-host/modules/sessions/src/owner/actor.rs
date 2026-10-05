use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex as StdMutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use super::session_ownership;
use arc_swap::ArcSwap;
use connectors::{
    ConnectorSecretRef, ConnectorSecretResolution, ConnectorSecretResolverPort,
    ConnectorSecretValue, InvalidConnectorSecretRef,
};
use foundation::execution::{CommandRoute, LaneRetention, OwnerSpec, QueryRoute, OwnerRuntimeHandle};
use super::observation::Observation;
use platform::endpoint::runtime_address::RuntimeEndpoint;
use tokio::sync::Mutex;

use crate::ports::{
    LifecycleOps, RuntimeDriver, RuntimeDriverIdentity, RuntimeOperationFailure,
    SessionOwnershipReader, SessionRuntimeDirectory,
};
use crate::{
    abort::SessionAbortOutcome,
    approval::{PendingApprovalsOutcome, SessionApprovalOutcome},
    command::{
        SessionCommand, SessionEnsureOutcome, SessionEvent,
        SessionEvictOutcome, SessionIngestOutcome, SessionSendRequest, openclaw_agent_lane_key,
        session_identity_lane_key,
    },
    create::{SessionCreateCommand, SessionCreateOutcome},
    delete::SessionDeleteOutcome,
    events::SessionDeltaSource,
    model_selection::{
        MatchaProviderRuntimeConfig, MatchaProviderSecret, MatchaSessionModelRuntimeCommand,
        NativeEndpoint, ResolvedSessionModelSelection, SessionModelSelectionBinding,
        SessionModelSelectionDiagnostic, SessionModelSelectionOutcome,
        SessionModelSelectionRejection, SessionRuntimeModelCommand,
    },
    query::SessionQuery,
    rename::SessionRenameOutcome,
    send::{SessionDeliveryContext, SessionSendCommand, SessionSendOutcome},
    session_catalog::{
        self, SessionCatalog, SessionCatalogCommand, SessionCatalogEntry, SessionCatalogOutcome,
    },
    session_history::{SessionHistoryCommand, SessionHistoryFailure, SessionHistoryOutcome},
    session_permission::SessionPermissionOutcome,
    state::{
        MAX_SAFE_INTEGER, RunPhase, RuntimeIssue, RuntimeView, SessionChange, SessionDelta,
        SessionEventBinding, SessionFacts, SessionIdentity, SessionProvider, SessionSourceBinding,
        SessionState, SessionView,
    },
    terminal_hook::{SessionRunTerminalSnapshot, SessionTerminalHook},
    timeline::{self, ContentCommand, ContentOutcome},
};
use provider_module::{
    ProviderHandle, ProviderSessionEndpoint, ProviderSessionModelSelection,
    ProviderSessionModelSelectionOutcome, ProviderSessionRuntimeModelsOutcome,
};

pub struct SessionSnapshot {
    pub states: HashMap<String, SessionState>,
}

pub struct SessionOwner {
    shared: SessionShared,
}

pub struct SessionOwnerInput {
    pub runtime_directory: Arc<dyn SessionRuntimeDirectory>,
    pub ownership_reader: Arc<dyn SessionOwnershipReader>,
    pub provider_handle: ProviderHandle,
    pub session_delta: Option<SessionDeltaSource>,
    pub terminal_hook: Option<Arc<dyn SessionTerminalHook>>,
}

#[derive(Clone)]
pub struct SessionShared {
    runtime_directory: Arc<dyn SessionRuntimeDirectory>,
    pub(super) ownership_reader: Arc<dyn SessionOwnershipReader>,
    provider_handle: ProviderHandle,
    private_resolver: Arc<StdMutex<Arc<dyn ConnectorSecretResolverPort>>>,
    pub(super) snapshot: Arc<ArcSwap<SessionSnapshot>>,
    snapshot_writer: Arc<Mutex<()>>,
    pub(super) session_delta: Option<SessionDeltaSource>,
    terminal_hook: Option<Arc<dyn SessionTerminalHook>>,
    pub(super) epoch: u64,
    pub(super) observations: Arc<StdMutex<HashMap<String, Observation>>>,
    pub(super) completion_handle: Arc<OnceLock<OwnerRuntimeHandle<SessionCommand, SessionQuery>>>,
    pub(super) read_tasks: Arc<StdMutex<Vec<foundation::execution::OwnedTask<()>>>>,
}

pub struct SessionLane {
    pub(super) state: Option<SessionState>,
}

#[cfg(test)]
mod tests;

static NEXT_SESSION_EPOCH: AtomicU64 = AtomicU64::new(1);
impl SessionOwner {
    pub fn new(
        runtime_directory: Arc<dyn SessionRuntimeDirectory>,
        ownership_reader: Arc<dyn SessionOwnershipReader>,
        provider_handle: ProviderHandle,
        session_delta: Option<SessionDeltaSource>,
        terminal_hook: Option<Arc<dyn SessionTerminalHook>>,
    ) -> (Self, Arc<ArcSwap<SessionSnapshot>>) {
        let snapshot = Arc::new(ArcSwap::new(Arc::new(SessionSnapshot {
            states: HashMap::new(),
        })));
        let shared = SessionShared {
            runtime_directory,
            ownership_reader,
            provider_handle,
            private_resolver: Arc::new(StdMutex::new(Arc::new(
                provider_module::Resolver::disabled(),
            ))),
            snapshot: Arc::clone(&snapshot),
            snapshot_writer: Arc::new(Mutex::new(())),
            session_delta,
            terminal_hook,
            epoch: next_session_epoch(),
            observations: Arc::new(StdMutex::new(HashMap::new())),
            completion_handle: Arc::new(OnceLock::new()),
            read_tasks: Arc::new(StdMutex::new(Vec::new())),
        };

        (Self { shared }, snapshot)
    }

    pub(crate) fn completion_handle_slot(&self) -> Arc<OnceLock<OwnerRuntimeHandle<SessionCommand, SessionQuery>>> {
        Arc::clone(&self.shared.completion_handle)
    }

    pub fn lane_retention() -> LaneRetention {
        LaneRetention::LowFrequency
    }

    #[cfg(test)]
    pub fn session_epoch_for_test(&self) -> u64 {
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

    pub(super) async fn store_snapshot_state(&self, state: SessionState) {
        let _guard = self.snapshot_writer.lock().await;
        let mut states = self.snapshot.load().states.clone();
        let lane_key =
            session_identity_lane_key(state.identity());
        states.insert(lane_key, state);
        self.snapshot.store(Arc::new(SessionSnapshot { states }));
    }

    pub(super) fn terminal_snapshots(
        delta: &SessionDelta,
        state: &mut SessionState,
    ) -> Vec<SessionRunTerminalSnapshot> {
        if !state.is_team_source() {
            return Vec::new();
        }
        delta
            .changes
            .iter()
            .filter_map(|change| {
                let SessionChange::RunPhaseChanged { run_id, phase } = change else {
                    return None;
                };
                if !crate::state::terminal_run_phase(*phase) {
                    return None;
                }
                Some(SessionRunTerminalSnapshot {
                    identity: state.identity().clone(),
                    source_binding: state.source_binding().clone(),
                    native_run_id: run_id.clone(),
                    delivery_context: state.run_delivery_contexts.remove(run_id),
                    phase: *phase,
                    final_assistant_text: state.assistant_text_for_run_id(run_id),
                })
            })
            .collect()
    }

    pub(super) fn emit_session_delta(&self, delta: &SessionDelta, terminals: Vec<SessionRunTerminalSnapshot>) {
        if let Some(source) = &self.session_delta {
            source.publish(delta.clone());
        }
        self.emit_terminals(terminals);
    }

    pub(super) fn emit_terminals(&self, terminals: Vec<SessionRunTerminalSnapshot>) {
        if let Some(hook) = &self.terminal_hook {
            for terminal in terminals {
                hook.run_terminal(terminal);
            }
        }
    }

    async fn clear_snapshot_state(&self, lane_key: &str) -> bool {
        let _guard = self.snapshot_writer.lock().await;
        let mut states = self.snapshot.load().states.clone();
        let removed = states.remove(lane_key).is_some();
        self.snapshot.store(Arc::new(SessionSnapshot { states }));
        removed
    }

    async fn list_session_views(&self) -> Vec<SessionView> {
        let mut views = self
            .snapshot
            .load()
            .states
            .values()
            .map(|state| state.view())
            .collect::<Vec<_>>();
        session_ownership::enrich_views(self.ownership_reader.as_ref(), &mut views).await;
        views
    }

    async fn get_session_view(&self, session_key: &str) -> Option<SessionView> {
        let mut view = self
            .snapshot
            .load()
            .states
            .values()
            .find(|state| state.identity().session_key() == session_key)
            .map(|state| state.view())?;
        session_ownership::enrich_views(
            self.ownership_reader.as_ref(),
            std::slice::from_mut(&mut view),
        )
        .await;
        Some(view)
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

    pub(super) fn running_session_driver(
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
        command: crate::approval::PendingApprovalsCommand,
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
        let driver = match self.running_session_driver(identity_endpoint(command.identity())) {
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
        let driver = match self.running_session_driver(identity_endpoint(command.identity())) {
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

    async fn handle_session_catalog(
        &self,
        command: SessionCatalogCommand,
    ) -> SessionCatalogOutcome {
        let endpoint = command.endpoint().clone();
        let driver = match self.running_session_driver(Some(endpoint.clone())) {
            Ok(driver) => driver,
            Err(_) => return SessionCatalogOutcome::Unavailable,
        };
        let Some(ops) = driver.session_ops() else {
            return SessionCatalogOutcome::Unavailable;
        };
        let mut catalog = match ops.load_session_catalog(command).await {
            SessionCatalogOutcome::Listed(catalog) => catalog,
            SessionCatalogOutcome::Unavailable => return SessionCatalogOutcome::Unavailable,
        };
        if endpoint == RuntimeDriverIdentity::open_claw().endpoint() {
            catalog = self
                .reconcile_session_catalog_models(endpoint, catalog)
                .await;
        } else if endpoint == RuntimeDriverIdentity::matcha_agent().endpoint() {
            self.store_catalog_bindings(&catalog).await;
        }
        session_ownership::enrich_catalog(self.ownership_reader.as_ref(), &mut catalog).await;
        SessionCatalogOutcome::Listed(catalog)
    }

    /// Read-only list projection: corrects catalog model refs that our own provider catalog no
    /// longer accepts. Never writes back to the runtime.
    ///
    /// Runs at most one provider judgement for the whole catalog, and at most one
    /// `agents.list`-backed default lookup per distinct stale agent.
    async fn reconcile_session_catalog_models(
        &self,
        endpoint: RuntimeEndpoint,
        catalog: SessionCatalog,
    ) -> SessionCatalog {
        let runtime_endpoint = NativeEndpoint::from_runtime_endpoint(endpoint.clone());
        let session_count = catalog.sessions.len();
        let driver = self.running_session_driver(Some(endpoint)).ok();
        let defaults_driver = driver.clone();
        let judge_handle = self.provider_handle.clone();
        let rebound_handle = self.provider_handle.clone();
        let (catalog, corrected) = session_catalog::reconcile_catalog_models(
            catalog,
            async move |model_refs| match judge_handle
                .accept_session_runtime_models(
                    provider_session_endpoint(runtime_endpoint),
                    model_refs,
                )
                .await
            {
                Ok(ProviderSessionRuntimeModelsOutcome::Accepted(accepted)) => {
                    session_catalog::CatalogModelJudgement::Accepted(accepted)
                }
                _ => session_catalog::CatalogModelJudgement::Unavailable,
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
                let endpoint = NativeEndpoint::from_runtime_endpoint(entry.endpoint.clone());
                let Ok(command) = SessionRuntimeModelCommand::try_new(
                    endpoint,
                    entry.key.clone(),
                    Some(entry.endpoint_session_id.clone()),
                    entry
                        .model_state
                        .as_ref()
                        .and_then(|model_state| model_state.selected_ref())
                        .map(str::to_owned),
                    default_model,
                ) else {
                    return Box::pin(async { None });
                };
                let handle = rebound_handle.clone();
                Box::pin(async move {
                    let outcome = handle
                        .select_session_model_rebound(
                            provider_session_endpoint(command.endpoint),
                            command.session_key,
                            command.endpoint_session_id,
                            command.current_model,
                            command.default_model,
                            command.trace_id,
                        )
                        .await
                        .ok()?;
                    match outcome {
                        ProviderSessionModelSelectionOutcome::Selected(selection) => {
                            Some(selection.runtime_model_ref)
                        }
                        _ => None,
                    }
                })
            },
        )
        .await;
        if corrected > 0 {
            log_session_catalog_model_reconciled(session_count, corrected);
        }
        catalog
    }

    async fn store_catalog_bindings(&self, catalog: &SessionCatalog) {
        let states = catalog
            .sessions
            .iter()
            .filter(|session| session.endpoint == RuntimeDriverIdentity::matcha_agent().endpoint())
            .filter_map(|session| catalog_state(session, self.epoch))
            .collect::<Vec<_>>();
        if states.is_empty() {
            return;
        }

        let _guard = self.snapshot_writer.lock().await;
        let mut snapshot = self.snapshot.load().states.clone();
        for state in states {
            let lane_key =
                session_identity_lane_key(state.identity());
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

    async fn handle_session_history(
        &self,
        command: SessionHistoryCommand,
    ) -> SessionHistoryOutcome {
        let driver = match self.running_session_driver(Some(command.endpoint().clone())) {
            Ok(driver) => driver,
            Err(_) => {
                return SessionHistoryOutcome::Failed(SessionHistoryFailure::Unavailable);
            }
        };
        let Some(ops) = driver.session_ops() else {
            return SessionHistoryOutcome::Failed(SessionHistoryFailure::Unavailable);
        };
        ops.load_session_history(command).await
    }

    async fn resolve_matcha_session_model_runtime(
        &self,
        command: MatchaSessionModelRuntimeCommand,
    ) -> Result<ResolvedSessionModelSelection, SessionModelSelectionOutcome> {
        let outcome = self
            .provider_handle
            .select_matcha_session_model_runtime(
                command.session_key,
                command.endpoint_session_id,
                command.model,
                command.model_selection_id,
                command.provider_fingerprint,
                command.trace_id,
            )
            .await
            .map_err(|_| SessionModelSelectionOutcome::Unavailable)?;
        self.provider_selection_outcome(outcome)
    }

    async fn resolve_session_model_selection(
        &self,
        command: crate::model_selection::SessionModelSelectionCommand,
    ) -> Result<ResolvedSessionModelSelection, SessionModelSelectionOutcome> {
        let outcome = self
            .provider_handle
            .select_session_model(
                provider_session_endpoint(command.endpoint),
                command.session_key,
                command.endpoint_session_id,
                command.model_selection_id,
                command.trace_id,
            )
            .await
            .map_err(|_| SessionModelSelectionOutcome::Unavailable)?;
        self.provider_selection_outcome(outcome)
    }

    fn provider_selection_outcome(
        &self,
        outcome: ProviderSessionModelSelectionOutcome,
    ) -> Result<ResolvedSessionModelSelection, SessionModelSelectionOutcome> {
        match outcome {
            ProviderSessionModelSelectionOutcome::Selected(selection) => {
                self.resolved_provider_selection(selection)
            }
            ProviderSessionModelSelectionOutcome::Unsupported => {
                Err(SessionModelSelectionOutcome::Unsupported)
            }
            ProviderSessionModelSelectionOutcome::Rejected => {
                Err(SessionModelSelectionOutcome::target_rejected(
                    SessionModelSelectionRejection::ModelSelectionNotFound,
                ))
            }
            ProviderSessionModelSelectionOutcome::Unavailable => {
                Err(SessionModelSelectionOutcome::Unavailable)
            }
        }
    }

    fn resolved_provider_selection(
        &self,
        selection: ProviderSessionModelSelection,
    ) -> Result<ResolvedSessionModelSelection, SessionModelSelectionOutcome> {
        let diagnostic = Some(SessionModelSelectionDiagnostic::new(
            selection.account_id.clone(),
            selection.model_id.clone(),
            selection.protocol,
            selection.auth_mode,
        ));
        let binding = match selection.endpoint {
            ProviderSessionEndpoint::OpenClawLocal => {
                SessionModelSelectionBinding::OpenClaw(selection.runtime_model_ref)
            }
            ProviderSessionEndpoint::MatchaAgentLocal => {
                let provider_runtime =
                    matcha_provider_runtime_config(&selection, &self.private_resolver)?;
                SessionModelSelectionBinding::Matcha {
                    model: selection.model_id.clone(),
                    provider_fingerprint: selection.provider_fingerprint.clone(),
                    provider_runtime,
                }
            }
        };
        Ok(ResolvedSessionModelSelection {
            endpoint: host_session_endpoint(selection.endpoint),
            session_key: selection.session_key,
            endpoint_session_id: selection.endpoint_session_id,
            model_selection_id: selection.model_selection_id,
            binding,
            diagnostic,
            trace_id: selection.trace_id,
        })
    }

    async fn prepare_matcha_send_model_runtime(
        &self,
        command: &SessionSendCommand,
    ) -> Result<(), SessionSendOutcome> {
        if command.identity.provider() != SessionProvider::MatchaAgent {
            return Ok(());
        }
        let driver = self
            .running_session_driver(identity_endpoint(&command.identity))
            .map_err(send_driver_failure)?;
        let Some(ops) = driver.session_ops() else {
            return Err(SessionSendOutcome::Unsupported);
        };
        let Some(model_runtime) = ops.send_model_runtime_command(command).await? else {
            return Ok(());
        };
        let model_runtime = self
            .resolve_matcha_session_model_runtime(model_runtime)
            .await
            .map_err(session_model_runtime_failure)?;
        match ops.select_session_model(model_runtime).await {
            SessionModelSelectionOutcome::Succeeded { .. } => Ok(()),
            outcome => Err(session_model_runtime_failure(outcome)),
        }
    }

    async fn handle_global_command(&self, command: SessionCommand) {
        match command {
            SessionCommand::ConfigurePrivateResolver { resolver, reply } => {
                *self
                    .private_resolver
                    .lock()
                    .expect("Session private resolver lock poisoned") = resolver;
                let _ = reply.send(());
            }
            command => command.send_unavailable(),
        }
    }

    async fn handle_global_query(&self, query: SessionQuery) {
        let Ok((query, call)) = crate::call::query_parts(query).await else {
            return;
        };
        match query {
            SessionQuery::BoundaryOutcome { outcome, reply, .. } => {
                crate::call::reply(call.as_ref(), reply, outcome).await;
            }
            SessionQuery::EventsSubscribed { reply } => {
                crate::call::reply(call.as_ref(), reply, ()).await;
            }
            SessionQuery::ListSessions { reply } => {
                crate::call::reply(call.as_ref(), reply, self.list_session_views().await).await;
            }
            SessionQuery::GetSession { session_key, reply } => {
                crate::call::reply(call.as_ref(), reply, self.get_session_view(&session_key).await).await;
            }
            SessionQuery::Catalog { command, reply } => {
                let outcome = self.handle_session_catalog(command).await;
                crate::call::reply(call.as_ref(), reply, outcome).await;
            }
            SessionQuery::History { command, reply } => {
                let outcome = self.handle_session_history(command).await;
                crate::call::reply(call.as_ref(), reply, outcome).await;
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
        let Ok((command, call)) = crate::call::command_parts(command).await else {
            return;
        };
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
            SendCompleted { command, goal_demand, outcome, reply, call } => {
                let outcome = super::goal::validate_start_outcome(&command, outcome);
                if let Some((lease, native_session_id)) = &goal_demand {
                    let received = match &outcome {
                        SessionSendOutcome::Succeeded { goal: Some(receipt), .. } => Some(receipt.session_id.as_str()),
                        _ => native_session_id.as_deref(),
                    };
                    if !self.goal_completion_matches(&command.identity, native_session_id.as_deref(), received) {
                        self.finish_goal_receive(shared, &command.identity, lease, None);
                        self.close_if_idle(shared, &command.identity);
                        crate::call::reply(call.as_ref(), reply, SessionSendOutcome::Unknown).await;
                        return;
                    }
                }
                self.complete_send(shared, command, goal_demand, &outcome).await;
                crate::call::reply(call.as_ref(), reply, outcome).await;
            }
            Goal { command, reply } => self.start_goal(shared, command, reply, call).await,
            GoalCompleted { command, demand_lease, outcome, reply, call } => {
                let outcome = self.complete_goal(shared, &command, &demand_lease, outcome).await;
                crate::call::reply(call.as_ref(), reply, outcome).await;
            }
            SyncCompleted { identity, generation, result } => self.sync_completed(shared, identity, generation, result).await,
            ObservationClosed { identity, generation, restarted } => self.observation_closed(shared, identity, generation, restarted).await,
            Release { identity, lease_id, reply } => {
                let outcome = self.release(shared, identity, lease_id).await;
                crate::call::reply(call.as_ref(), reply, outcome).await;
            }
            Evict { reply, .. } => {
                let outcome = self.handle_evict(shared, key).await;
                crate::call::reply(call.as_ref(), reply, outcome).await;
            }
            Create { command, reply } => {
                let outcome = self.handle_create(shared, &key, command).await;
                crate::call::reply(call.as_ref(), reply, outcome).await;
            }
            Send { request } => match request {
                SessionSendRequest::Session { command, reply } => {
                    self.start_send(shared, command, reply, call).await;
                }
            },
            Delete { command, reply } => {
                let outcome = self.handle_delete(shared, command).await;
                crate::call::reply(call.as_ref(), reply, outcome).await;
            }
            Rename { command, reply } => {
                let outcome = self.handle_rename(shared, command).await;
                crate::call::reply(call.as_ref(), reply, outcome).await;
            }
            Approval { command, reply } => {
                let outcome = self.handle_approval(shared, command).await;
                crate::call::reply(call.as_ref(), reply, outcome).await;
            }
            ModelSelection { command, reply } => {
                let outcome = self.handle_model_selection(shared, command).await;
                crate::call::reply(call.as_ref(), reply, outcome).await;
            }
            Permission { command, reply } => {
                let outcome = self.handle_permission(shared, command).await;
                crate::call::reply(call.as_ref(), reply, outcome).await;
            }
            ConfigurePrivateResolver { reply, .. } => {
                let _ = reply.send(());
            }
            command @ Audited { .. } => command.send_unavailable(),
        }
    }

    async fn handle_ensure(
        &mut self,
        shared: &SessionShared,
        key: &str,
        identity: SessionIdentity,
        source_binding: SessionSourceBinding,
    ) -> SessionEnsureOutcome {
        let expected_key = session_identity_lane_key(&identity);
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
        if crate::trace::enabled() {
            crate::trace::log_unscoped("sessions.ingest.input", serde_json::json!({
                "identity": crate::trace::identity_shape(&identity),
                "bindingIdentity": crate::trace::identity_shape(event.binding.identity()),
                "generation": event.binding.generation(), "currentGeneration": shared.observation_generation(&identity),
                "sourceEpoch": event.binding.source_epoch(), "nativeCursor": event.cursor,
                "contiguous": event.binding.source_cursor_contiguous(),
                "runHash": event.run_id.as_deref().map(crate::trace::fingerprint),
                "changes": crate::trace::changes_shape(&event.changes),
                "before": self.state.as_ref().map(|state| crate::trace::view_shape(&state.view())),
            }));
        }
        if session_identity_lane_key(&identity) != key || event.binding.identity() != &identity
            || event.binding.generation().is_some_and(|generation| shared.observation_generation(&identity) != Some(generation)) {
            if crate::trace::enabled() {
                crate::trace::log_unscoped("sessions.ingest.reject", serde_json::json!({
                    "identity": crate::trace::identity_shape(&identity), "reason": "identity_or_generation_mismatch",
                    "laneMatches": session_identity_lane_key(&identity) == key,
                    "bindingMatches": event.binding.identity() == &identity,
                    "generation": event.binding.generation(), "currentGeneration": shared.observation_generation(&identity),
                }));
            }
            return SessionIngestOutcome::Rejected {
                reason: "Session key mismatch".to_owned(),
            };
        }
        let provider = identity.endpoint.provider();
        let receive_changes = event.changes.clone();

        if let Some(state) = &self.state {
            if state.identity().provider() != provider {
                if crate::trace::enabled() {
                    crate::trace::log_unscoped("sessions.ingest.reject", serde_json::json!({
                        "identity": crate::trace::identity_shape(&identity), "reason": "provider_mismatch",
                    }));
                }
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
            self.recover_observation(shared, &identity);
            return Self::map_apply_result(&identity, result);
        }

        if let Some(state) = &self.state {
            if state.native_source_epoch_changed(&event.binding) {
                if crate::trace::enabled() {
                    crate::trace::log_unscoped("sessions.ingest.source_boundary", serde_json::json!({
                        "identity": crate::trace::identity_shape(&identity), "reason": "source_epoch_changed",
                        "generation": event.binding.generation(), "sourceEpoch": event.binding.source_epoch(),
                        "nativeCursor": event.cursor, "before": crate::trace::view_shape(&state.view()),
                    }));
                }
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
                        crate::state::RecoveryReason::EpochChanged,
                    )
                    .await;
                if !matches!(
                    recovery_result,
                    crate::state::SessionApplyResult::Applied(_)
                ) {
                    return Self::map_apply_result(&identity, recovery_result);
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
                None,
            )
            .await;
        match &result {
            crate::state::SessionApplyResult::Applied(_) | crate::state::SessionApplyResult::Consumed { .. } => {
                shared.receive_event(&identity, &receive_changes);
                if receive_changes.iter().any(|change| matches!(change, SessionChange::RunPhaseChanged { phase, .. } if crate::state::terminal_run_phase(*phase))) {
                    self.sync_after_terminal(shared, &identity);
                }
            }
            crate::state::SessionApplyResult::Gap { .. } | crate::state::SessionApplyResult::Rejected { .. } => self.recover_observation(shared, &identity),
            _ => {}
        }
        Self::map_apply_result(&identity, result)
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
        delivery_context: Option<SessionDeliveryContext>,
    ) -> crate::state::SessionApplyResult {
        let state = match self.event_state(shared, session_key, provider, identity, source_binding)
        {
            Ok(state) => state,
            Err(result) => return result,
        };

        let mut next = state;
        let evicted = if binding.generation().is_some() {
            let observation_changes = next.observation_changes(&binding, run_id.as_deref(), &changes);
            match next.reserve_observation_capacity(&observation_changes) {
                Ok(evicted) => evicted,
                Err(_) => return crate::state::SessionApplyResult::Rejected { reason: crate::state::SessionApplyRejection::InvalidInput },
            }
        } else { false };
        if let (Some(run_id), Some(context)) = (&run_id, delivery_context) {
            next.run_delivery_contexts.insert(run_id.clone(), context);
        }
        let result = next.apply_native_bound(binding, run_id, native_cursor, changes);

        match &result {
            crate::state::SessionApplyResult::Applied(delta) => {
                let terminals = SessionShared::terminal_snapshots(delta, &mut next);
                self.state = Some(next.clone());
                shared.store_snapshot_state(next).await;
                if evicted {
                    shared.emit_terminals(terminals);
                    if let Some(source) = &shared.session_delta {
                        let mut terminal_delta = delta.clone();
                        terminal_delta.changes.retain(|change| matches!(change, SessionChange::RunPhaseChanged { phase, .. } if crate::state::terminal_run_phase(*phase)));
                        if !terminal_delta.changes.is_empty() { source.publish(terminal_delta); }
                        source.resync(delta.identity.clone(), delta.epoch, delta.seq);
                    }
                } else { shared.emit_session_delta(delta, terminals); }
            }
            crate::state::SessionApplyResult::Consumed { .. } => {
                self.state = Some(next.clone()); shared.store_snapshot_state(next).await;
            }
            _ => {}
        }

        if crate::trace::enabled() {
            crate::trace::log_unscoped("sessions.ingest.after", serde_json::json!({
                "identity": crate::trace::identity_shape(identity), "evicted": evicted,
                "committed": matches!(&result, crate::state::SessionApplyResult::Applied(_) | crate::state::SessionApplyResult::Consumed { .. }),
                "after": self.state.as_ref().map(|state| crate::trace::view_shape(&state.view())),
            }));
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
        reason: crate::state::RecoveryReason,
    ) -> crate::state::SessionApplyResult {
        let state = match self.event_state(shared, session_key, provider, identity, source_binding)
        {
            Ok(state) => state,
            Err(result) => return result,
        };

        let mut next = state;
        let result = next.apply_native_recovery_bound(binding, run_id, native_cursor, reason);

        if let crate::state::SessionApplyResult::Applied(delta) = &result {
            let terminals = SessionShared::terminal_snapshots(delta, &mut next);
            self.state = Some(next.clone());
            shared.store_snapshot_state(next).await;
            shared.emit_session_delta(delta, terminals);
        }
        if crate::trace::enabled() {
            crate::trace::log_unscoped("sessions.ingest.recovery_after", serde_json::json!({
                "identity": crate::trace::identity_shape(identity), "reason": reason,
                "committed": matches!(&result, crate::state::SessionApplyResult::Applied(_)),
                "after": self.state.as_ref().map(|state| crate::trace::view_shape(&state.view())),
            }));
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
    ) -> Result<SessionState, crate::state::SessionApplyResult> {
        match &self.state {
            Some(state) if state.identity() == identity => {
                let mut state = state.clone();
                if state.bind_source(source_binding.clone()) {
                    Ok(state)
                } else {
                    Err(crate::state::SessionApplyResult::Rejected {
                        reason: crate::state::SessionApplyRejection::InvalidInput,
                    })
                }
            }
            Some(_) => Err(crate::state::SessionApplyResult::Rejected {
                reason: crate::state::SessionApplyRejection::InvalidInput,
            }),
            None => {
                if identity.session_key() != session_key || identity.provider() != provider {
                    return Err(crate::state::SessionApplyResult::Rejected {
                        reason: crate::state::SessionApplyRejection::InvalidInput,
                    });
                }
                SessionState::new(identity.clone(), shared.epoch)
                    .map(|state| state.with_source_binding(source_binding.clone()))
                    .map_err(|_| crate::state::SessionApplyResult::Rejected {
                        reason: crate::state::SessionApplyRejection::InvalidInput,
                    })
            }
        }
    }

    fn map_apply_result(identity: &SessionIdentity, result: crate::state::SessionApplyResult) -> SessionIngestOutcome {
        if crate::trace::enabled() {
            use crate::state::{SessionApplyRejection, SessionApplyResult};
            let summary = match &result {
                SessionApplyResult::Applied(delta) => serde_json::json!({
                    "outcome": "applied", "identity": crate::trace::identity_shape(&delta.identity),
                    "epoch": delta.epoch, "seq": delta.seq, "cursor": delta.cursor,
                    "changes": crate::trace::changes_shape(&delta.changes),
                }),
                SessionApplyResult::Consumed { cursor } => serde_json::json!({ "outcome": "consumed", "nativeCursor": cursor }),
                SessionApplyResult::Duplicate { cursor } => serde_json::json!({ "outcome": "duplicate", "nativeCursor": cursor }),
                SessionApplyResult::Stale { cursor, received } => serde_json::json!({ "outcome": "stale", "nativeCursor": cursor, "receivedNativeCursor": received }),
                SessionApplyResult::Gap { expected, received } => serde_json::json!({ "outcome": "gap", "expectedNativeCursor": expected, "receivedNativeCursor": received }),
                SessionApplyResult::Rejected { reason } => serde_json::json!({ "outcome": "rejected", "reason": match reason {
                    SessionApplyRejection::InvalidInput => "invalid_input",
                    SessionApplyRejection::InvalidChange => "invalid_change",
                    SessionApplyRejection::CursorConflict { .. } => "cursor_conflict",
                    SessionApplyRejection::SequenceExhausted => "sequence_exhausted",
                    SessionApplyRejection::EventBackpressure => "event_backpressure",
                    SessionApplyRejection::EventSinkUnavailable => "event_sink_unavailable",
                } }),
            };
            crate::trace::log_unscoped("sessions.ingest.outcome", serde_json::json!({
                "identity": crate::trace::identity_shape(identity), "result": summary,
            }));
        }
        match result {
            crate::state::SessionApplyResult::Applied(delta) => {
                SessionIngestOutcome::Applied(delta)
            }
            crate::state::SessionApplyResult::Consumed { cursor } => SessionIngestOutcome::Consumed { cursor },
            crate::state::SessionApplyResult::Duplicate { cursor } => {
                SessionIngestOutcome::Duplicate { cursor }
            }
            crate::state::SessionApplyResult::Stale { cursor, received } => {
                SessionIngestOutcome::Stale { cursor, received }
            }
            crate::state::SessionApplyResult::Gap { expected, received } => {
                SessionIngestOutcome::Gap { expected, received }
            }
            crate::state::SessionApplyResult::Rejected { reason } => {
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

        let snapshot = shared.snapshot.load();
        let mut matching = snapshot.states.values().filter(|state| state.identity().provider() == SessionProvider::MatchaAgent && state.identity().session_key() == session_key);
        let state = matching.next()?.clone();
        if matching.next().is_some() { return None; }
        let session_id = state.native_session_id()?.to_owned();
        self.state = Some(state);
        Some(session_id)
    }

    fn identity_native_session_id(&mut self, shared: &SessionShared, identity: &SessionIdentity) -> Option<String> {
        if self.state.as_ref().is_none_or(|state| state.identity() != identity) {
            self.state = shared.snapshot.load().states.get(&session_identity_lane_key(identity)).cloned();
        }
        self.state.as_ref().and_then(SessionState::native_session_id).map(str::to_owned)
    }

    fn bind_matcha_send_command(
        &mut self,
        shared: &SessionShared,
        command: crate::send::SessionSendCommand,
    ) -> Result<crate::send::SessionSendCommand, SessionSendOutcome> {
        if command.identity.provider() != SessionProvider::MatchaAgent {
            return Ok(command);
        }
        let Some(session_id) = self.identity_native_session_id(shared, &command.identity) else {
            return Err(SessionSendOutcome::Rejected);
        };
        command
            .with_endpoint_session_id(session_id)
            .map_err(|_| SessionSendOutcome::Rejected)
    }

    fn bind_matcha_model_selection_command(
        &mut self,
        shared: &SessionShared,
        command: crate::model_selection::SessionModelSelectionCommand,
    ) -> Result<crate::model_selection::SessionModelSelectionCommand, SessionModelSelectionOutcome>
    {
        if command.endpoint != crate::model_selection::NativeEndpoint::MatchaAgentLocal {
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
            .identity_native_session_id(shared, command.identity())
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
            .identity_native_session_id(shared, command.identity())
            .ok_or_else(|| {
                ContentOutcome::unavailable(
                    timeline::UnavailableReason::MatchaMissingNativeSessionId,
                )
            })?;
        command.with_endpoint_session_id(session_id).ok_or_else(|| {
            ContentOutcome::unavailable(timeline::UnavailableReason::MatchaIdentityInvalid)
        })
    }

    async fn handle_create(
        &mut self,
        shared: &SessionShared,
        key: &str,
        command: SessionCreateCommand,
    ) -> SessionCreateOutcome {
        if session_identity_lane_key(&command.identity()) != key {
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
        let identity = command.identity();
        match ops.create_session(command, shared.epoch).await {
            SessionCreateOutcome::Succeeded(mut view) => {
                if view.identity != identity { return SessionCreateOutcome::Unknown; }
                let Some(state) = state_from_view(&view) else {
                    return SessionCreateOutcome::Unknown;
                };
                self.state = Some(state.clone());
                shared.store_snapshot_state(state).await;
                session_ownership::enrich_views(
                    shared.ownership_reader.as_ref(),
                    std::slice::from_mut(&mut view),
                )
                .await;
                SessionCreateOutcome::Succeeded(view)
            }
            outcome => outcome,
        }
    }

    async fn start_send(
        &mut self,
        shared: &SessionShared,
        command: crate::send::SessionSendCommand,
        reply: tokio::sync::oneshot::Sender<SessionSendOutcome>,
        call: Option<crate::call::SessionCall>,
    ) {
        if let Some(intent) = &command.intent {
            if command.clone().with_intent(intent.clone()).is_err() {
                crate::call::reply(call.as_ref(), reply, SessionSendOutcome::Rejected).await;
                return;
            }
            match shared.running_session_driver(identity_endpoint(&command.identity)) {
                Ok(driver) if driver.session_ops().is_some_and(|ops| ops.supports_goal()) => {},
                Ok(_) => { crate::call::reply(call.as_ref(), reply, SessionSendOutcome::Unsupported).await; return; },
                Err(failure) => { crate::call::reply(call.as_ref(), reply, send_driver_failure(failure)).await; return; },
            }
        }
        let provider = command.identity.provider();
        let session_key = command.identity.session_key.clone();
        let source_binding = command.source_binding.clone();
        let requested_run_id = command.request_run_identity().map(str::to_owned);
        let failure_run_id = if provider == SessionProvider::MatchaAgent { requested_run_id.clone() } else { None };
        let identity = Some(command.identity.clone());
        let binding = SessionEventBinding::new(command.identity.clone(), None);
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
                    None,
                )
                .await;
                crate::call::reply(call.as_ref(), reply, outcome).await;
                return;
            }
        };

        let receive_identity = command.identity.clone();
        if crate::trace::enabled() {
            crate::trace::log_unscoped("sessions.send.receive_demand", serde_json::json!({
                "identity": crate::trace::identity_shape(&receive_identity),
                "traceIdHash": command.trace_id().map(crate::trace::fingerprint),
                "requestedRunHash": requested_run_id.as_deref().map(crate::trace::fingerprint),
                "generation": shared.observation_generation(&receive_identity),
            }));
        }
        let goal_demand = if command.intent.is_some() {
            match self.prepare_goal_receive(shared, &receive_identity, command.endpoint_session_id.as_deref()) {
                Ok(demand) => Some(demand),
                Err(failure) => { crate::call::reply(call.as_ref(), reply, send_driver_failure(failure)).await; return; }
            }
        } else {
            if let Err(failure) = self.prepare_send_receive(shared, &receive_identity, requested_run_id.as_deref()) {
                crate::call::reply(call.as_ref(), reply, send_driver_failure(failure)).await;
                return;
            }
            None
        };
        let Some(sender) = shared.completion_handle.get().cloned() else {
            if let Some((lease, _)) = &goal_demand {
                self.finish_goal_receive(shared, &receive_identity, lease, None);
                self.close_if_idle(shared, &receive_identity);
            }
            crate::call::reply(call.as_ref(), reply, SessionSendOutcome::Unavailable).await;
            return;
        };
        let mut next = match self.event_state(shared, &session_key, provider, &receive_identity, &source_binding) {
            Ok(state) => state,
            Err(_) => {
                if let Some((lease, _)) = &goal_demand {
                    self.finish_goal_receive(shared, &receive_identity, lease, None);
                } else {
                    self.send_receive_outcome(shared, &receive_identity, requested_run_id.as_deref(), &SessionSendOutcome::Rejected);
                }
                self.close_if_idle(shared, &receive_identity);
                crate::call::reply(call.as_ref(), reply, SessionSendOutcome::Rejected).await;
                return;
            }
        };
        if let (Some(run_id), Some(context)) = (&requested_run_id, &command.delivery_context) {
            if !next.has_terminal_run(run_id) {
                next.run_delivery_contexts.insert(run_id.clone(), context.clone());
            }
        }
        self.state = Some(next.clone());
        shared.store_snapshot_state(next).await;
        let shared_for_tasks = shared.clone();
        let shared = shared.clone();
        let (task, _) = foundation::execution::OwnedTask::spawn(move |cancel| async move {
            let send = async {
                match shared.prepare_matcha_send_model_runtime(&command).await {
                    Ok(()) => match shared.running_session_driver(identity_endpoint(&command.identity)) {
                        Ok(driver) => match driver.session_ops() {
                            Some(ops) => ops.send_session(command.clone()).await,
                            None => SessionSendOutcome::Unsupported,
                        },
                        Err(failure) => send_driver_failure(failure),
                    },
                    Err(outcome) => outcome,
                }
            };
            let outcome = tokio::select! {
                _ = cancel.cancelled() => { crate::call::reply(call.as_ref(), reply, SessionSendOutcome::Unknown).await; return; },
                outcome = send => outcome,
            };
            tokio::select! { _ = cancel.cancelled() => {}, _ = sender.send_command(SessionCommand::SendCompleted { command, goal_demand, outcome, reply, call }) => {} }
        });
        let mut tasks = shared_for_tasks.read_tasks.lock().expect("session read tasks lock");
        tasks.retain(|task| !task.is_finished());
        tasks.push(task);
    }

    async fn complete_send(&mut self, shared: &SessionShared, command: SessionSendCommand, goal_demand: Option<(String, Option<String>)>, outcome: &SessionSendOutcome) {
        let identity = command.identity.clone();
        let requested = command.request_run_identity().map(str::to_owned);
        if let Some(requested) = &requested {
            let remove = match outcome {
                SessionSendOutcome::Queued { run_id } | SessionSendOutcome::Succeeded { run_id, .. } => run_id != requested,
                SessionSendOutcome::Rejected | SessionSendOutcome::Unavailable | SessionSendOutcome::Unsupported => true,
                SessionSendOutcome::Unknown => false,
            };
            if remove && let Some(state) = &mut self.state {
                if state.run_delivery_contexts.remove(requested).is_some() {
                    shared.store_snapshot_state(state.clone()).await;
                }
            }
        }
        let replayed_goal = matches!(outcome, SessionSendOutcome::Succeeded { goal: Some(receipt), .. } if receipt.replayed == Some(true));
        let receive_outcome = if replayed_goal { &SessionSendOutcome::Rejected } else { outcome };
        if let Some((lease, _)) = &goal_demand {
            self.finish_goal_receive(shared, &identity, lease, Some(receive_outcome));
        } else {
            self.send_receive_outcome(shared, &identity, requested.as_deref(), receive_outcome);
        }
        if crate::trace::enabled() {
            crate::trace::log_unscoped("sessions.send.completed", serde_json::json!({
                "identity": crate::trace::identity_shape(&identity), "traceIdHash": command.trace_id().map(crate::trace::fingerprint),
                "requestedRunHash": requested.as_deref().map(crate::trace::fingerprint),
                "returnedRunHash": match outcome {
                    SessionSendOutcome::Queued { run_id } | SessionSendOutcome::Succeeded { run_id, .. } => Some(crate::trace::fingerprint(run_id)),
                    _ => None,
                },
                "outcome": match outcome {
                    SessionSendOutcome::Queued { .. } => "queued", SessionSendOutcome::Succeeded { .. } => "succeeded",
                    SessionSendOutcome::Rejected => "rejected", SessionSendOutcome::Unavailable => "unavailable",
                    SessionSendOutcome::Unsupported => "unsupported", SessionSendOutcome::Unknown => "unknown",
                },
                "generation": shared.observation_generation(&identity),
            }));
        }
        if !replayed_goal {
            self.apply_send_outcome(shared, identity.session_key(), identity.provider(), Some(identity.clone()), &command.source_binding,
                SessionEventBinding::new(identity.clone(), None), outcome,
                if identity.provider() == SessionProvider::MatchaAgent { requested } else { None }, command.delivery_context).await;
        }
        if command.intent.is_some() && matches!(outcome, SessionSendOutcome::Succeeded { .. } | SessionSendOutcome::Unknown) {
            self.refresh_goal(shared, &identity);
        } else {
            self.close_if_idle(shared, &identity);
        }
    }

    pub(super) async fn apply_send_outcome(
        &mut self,
        shared: &SessionShared,
        session_key: &str,
        provider: SessionProvider,
        identity: Option<SessionIdentity>,
        source_binding: &SessionSourceBinding,
        binding: Option<SessionEventBinding>,
        outcome: &SessionSendOutcome,
        failure_run_id: Option<String>,
        delivery_context: Option<SessionDeliveryContext>,
    ) {
        let (Some(identity), Some(binding)) = (identity, binding) else {
            return;
        };
        let (run_id, runtime) = match send_outcome_runtime(outcome, failure_run_id) {
            Some(projection) => projection,
            None => return,
        };
        if matches!(outcome, SessionSendOutcome::Queued { .. } | SessionSendOutcome::Succeeded { .. })
            && run_id.as_deref().is_some_and(|run_id| shared.received_terminal(&identity, run_id)) {
            return;
        }
        let delivery_context = match outcome {
            SessionSendOutcome::Queued { .. } | SessionSendOutcome::Succeeded { .. } => {
                delivery_context
            }
            _ => None,
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
                delivery_context,
            )
            .await;
    }

    async fn handle_delete(
        &mut self,
        shared: &SessionShared,
        command: crate::delete::SessionDeleteCommand,
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
        command: crate::rename::SessionRenameCommand,
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
        command: crate::approval::SessionApprovalCommand,
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
        command: crate::session_permission::SessionPermissionCommand,
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
        command: crate::model_selection::SessionModelSelectionCommand,
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
        let command = match shared.resolve_session_model_selection(command).await {
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
        let Ok((query, call)) = crate::call::query_parts(query).await else {
            return;
        };
        match query {
            SessionQuery::BoundaryOutcome { outcome, reply, .. } => {
                crate::call::reply(call.as_ref(), reply, outcome).await;
            }
            SessionQuery::EventsSubscribed { reply } => {
                crate::call::reply(call.as_ref(), reply, ()).await;
            }
            SessionQuery::ListSessions { reply } => {
                crate::call::reply(call.as_ref(), reply, shared.list_session_views().await).await;
            }
            SessionQuery::GetSession { session_key, reply } => {
                crate::call::reply(call.as_ref(), reply, shared.get_session_view(&session_key).await).await;
            }
            SessionQuery::PendingApprovals { command, reply } => {
                let outcome = shared.handle_pending_approvals(command).await;
                crate::call::reply(call.as_ref(), reply, outcome).await;
            }
            SessionQuery::Observe { command, reply } => self.observe(shared, command, reply, call).await,
            SessionQuery::Timeline { command, reply } => {
                let command = match self.bind_matcha_timeline_command(shared, command) {
                    Ok(command) => command,
                    Err(outcome) => { crate::call::reply(call.as_ref(), reply, outcome).await; return; }
                };
                if command.direction() == timeline::Direction::Latest {
                    self.latest_timeline(shared, command, reply, call).await;
                } else {
                    let shared_for_tasks = shared.clone();
                    let shared = shared.clone();
                    // Pagination is a read, never a replacement for the latest running state.
                    let identity = command.identity().clone();
                    let committed = self.state.as_ref().map(SessionState::view);
                    let (task, _) = foundation::execution::OwnedTask::spawn(move |cancel| async move {
                        let mut outcome = tokio::select! { _ = cancel.cancelled() => return, outcome = shared.handle_timeline(command) => outcome };
                        if let timeline::Outcome::Complete(view) | timeline::Outcome::Incomplete(view) = &mut outcome {
                            let snapshot = shared.snapshot.load();
                            if let Some(watermark) = snapshot.states.get(&session_identity_lane_key(&identity)).map(SessionState::view).or(committed) {
                                view.epoch = watermark.epoch; view.seq = watermark.seq; view.cursor = watermark.cursor;
                            }
                        }
                        session_ownership::enrich_timeline(shared.ownership_reader.as_ref(), &mut outcome).await;
                        crate::call::reply(call.as_ref(), reply, outcome).await;
                    });
                    let mut tasks = shared_for_tasks.read_tasks.lock().expect("session read tasks lock");
                    tasks.retain(|task| !task.is_finished());
                    tasks.push(task);
                }
            }
            SessionQuery::Content { command, reply } => {
                let outcome = match self.bind_matcha_content_command(shared, command) {
                    Ok(command) => shared.handle_content(command).await,
                    Err(outcome) => outcome,
                };
                crate::call::reply(call.as_ref(), reply, outcome).await;
            }
            SessionQuery::History { command, reply } => {
                let outcome = shared.handle_session_history(command).await;
                crate::call::reply(call.as_ref(), reply, outcome).await;
            }
            SessionQuery::Catalog { command, reply } => {
                let outcome = shared.handle_session_catalog(command).await;
                crate::call::reply(call.as_ref(), reply, outcome).await;
            }
            query @ (SessionQuery::Abort { .. } | SessionQuery::Audited { .. }) => query.send_unavailable(),
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
        let Ok((query, call)) = crate::call::query_parts(query).await else {
            return;
        };
        match query {
            SessionQuery::BoundaryOutcome { outcome, reply, .. } => {
                crate::call::reply(call.as_ref(), reply, outcome).await;
            }
            SessionQuery::EventsSubscribed { reply } => {
                crate::call::reply(call.as_ref(), reply, ()).await;
            }
            SessionQuery::ListSessions { reply } => {
                crate::call::reply(call.as_ref(), reply, shared.list_session_views().await).await;
            }
            SessionQuery::GetSession { session_key, reply } => {
                crate::call::reply(call.as_ref(), reply, shared.get_session_view(&session_key).await).await;
            }
            SessionQuery::Abort { command, reply } => {
                let outcome: SessionAbortOutcome = shared.handle_abort(command).await;
                crate::call::reply(call.as_ref(), reply, outcome).await;
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
        shared.shutdown_observations().await;
        let tasks = std::mem::take(&mut *shared.read_tasks.lock().expect("session read tasks lock"));
        for mut task in tasks { let _ = task.cancel_and_join().await; }
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

fn provider_session_endpoint(endpoint: NativeEndpoint) -> ProviderSessionEndpoint {
    match endpoint {
        NativeEndpoint::OpenClawLocal | NativeEndpoint::Unsupported => {
            ProviderSessionEndpoint::OpenClawLocal
        }
        NativeEndpoint::MatchaAgentLocal => ProviderSessionEndpoint::MatchaAgentLocal,
    }
}

fn host_session_endpoint(endpoint: ProviderSessionEndpoint) -> NativeEndpoint {
    match endpoint {
        ProviderSessionEndpoint::OpenClawLocal => NativeEndpoint::OpenClawLocal,
        ProviderSessionEndpoint::MatchaAgentLocal => NativeEndpoint::MatchaAgentLocal,
    }
}

fn matcha_provider_runtime_config(
    selection: &ProviderSessionModelSelection,
    private_resolver: &StdMutex<Arc<dyn ConnectorSecretResolverPort>>,
) -> Result<MatchaProviderRuntimeConfig, SessionModelSelectionOutcome> {
    let api_key = match selection.auth_mode {
        "local" => None,
        "api_key" => Some(matcha_provider_api_key(selection, private_resolver)?),
        _ => {
            return Err(
                SessionModelSelectionOutcome::target_rejected_with_diagnostic(
                    SessionModelSelectionRejection::MatchaProviderRuntimeUnavailable,
                    Some(selection_diagnostic(selection)),
                ),
            );
        }
    };
    let base_url = selection.account_endpoint.clone();
    match selection.protocol {
        Some("anthropic_messages") => {
            Ok(MatchaProviderRuntimeConfig::AnthropicMessages { base_url, api_key })
        }
        Some("google_generative_ai") => {
            Ok(MatchaProviderRuntimeConfig::GoogleGenerativeAi { base_url, api_key })
        }
        Some("open_ai_completions") => {
            Ok(MatchaProviderRuntimeConfig::OpenAiChatCompletions { base_url, api_key })
        }
        Some("open_ai_responses") => {
            Ok(MatchaProviderRuntimeConfig::OpenAiResponses { base_url, api_key })
        }
        _ => Err(
            SessionModelSelectionOutcome::target_rejected_with_diagnostic(
                SessionModelSelectionRejection::MatchaProviderRuntimeUnavailable,
                Some(selection_diagnostic(selection)),
            ),
        ),
    }
}

fn matcha_provider_api_key(
    selection: &ProviderSessionModelSelection,
    private_resolver: &StdMutex<Arc<dyn ConnectorSecretResolverPort>>,
) -> Result<MatchaProviderSecret, SessionModelSelectionOutcome> {
    let diagnostic = Some(selection_diagnostic(selection));
    let reference = selection.credential_ref.as_ref().ok_or_else(|| {
        SessionModelSelectionOutcome::target_rejected_with_diagnostic(
            SessionModelSelectionRejection::MatchaProviderRuntimeUnavailable,
            diagnostic.clone(),
        )
    })?;
    let reference =
        ConnectorSecretRef::try_new(reference.as_str()).map_err(|InvalidConnectorSecretRef| {
            SessionModelSelectionOutcome::target_rejected_with_diagnostic(
                SessionModelSelectionRejection::MatchaProviderRuntimeUnavailable,
                diagnostic.clone(),
            )
        })?;
    let resolver = private_resolver
        .lock()
        .expect("Session private resolver lock poisoned")
        .clone();
    let resolved = resolver.resolve(&reference).map_err(|_| {
        SessionModelSelectionOutcome::target_rejected_with_diagnostic(
            SessionModelSelectionRejection::MatchaProviderRuntimeUnavailable,
            diagnostic.clone(),
        )
    })?;
    let ConnectorSecretResolution::Resolved { value, .. } = resolved else {
        return Err(
            SessionModelSelectionOutcome::target_rejected_with_diagnostic(
                SessionModelSelectionRejection::MatchaProviderRuntimeUnavailable,
                diagnostic,
            ),
        );
    };
    MatchaProviderSecret::new(connector_secret_to_string(&value)?).map_err(|_| {
        SessionModelSelectionOutcome::target_rejected_with_diagnostic(
            SessionModelSelectionRejection::MatchaProviderRuntimeUnavailable,
            Some(selection_diagnostic(selection)),
        )
    })
}

fn selection_diagnostic(
    selection: &ProviderSessionModelSelection,
) -> SessionModelSelectionDiagnostic {
    SessionModelSelectionDiagnostic::new(
        selection.account_id.clone(),
        selection.model_id.clone(),
        selection.protocol,
        selection.auth_mode,
    )
}

fn connector_secret_to_string(
    value: &ConnectorSecretValue,
) -> Result<String, SessionModelSelectionOutcome> {
    let mut secret = None;
    value.with_private_bytes(|bytes| {
        secret = std::str::from_utf8(bytes).ok().map(str::to_owned);
    });
    secret.ok_or(SessionModelSelectionOutcome::Unavailable)
}

fn session_model_runtime_failure(outcome: SessionModelSelectionOutcome) -> SessionSendOutcome {
    match outcome {
        SessionModelSelectionOutcome::Succeeded { .. } => SessionSendOutcome::Unknown,
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
        SessionSendOutcome::Unknown => return None,
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

fn identity_endpoint(identity: &SessionIdentity) -> Option<RuntimeEndpoint> {
    RuntimeEndpoint::try_new(identity.provider().as_str(), &identity.endpoint.runtime_instance_id).ok()
}

fn state_from_view(view: &SessionView) -> Option<SessionState> {
    let facts = SessionFacts {
        items: view.items.clone(),
        tools: view.tools.clone(),
        approvals: view.approvals.clone(),
        runtime: view.runtime.clone(),
        window: view.window.clone(),
        completeness: view.completeness.clone(),
    };
    SessionState::from_view_parts(view.identity.clone(), view.epoch, view.seq, view.cursor, facts)
        .ok()?
        .with_endpoint_session_id(view.endpoint_session_id.clone())
        .ok()?
        .with_goal(view.goal.clone())
        .ok()
}

fn catalog_state(entry: &SessionCatalogEntry, epoch: u64) -> Option<SessionState> {
    let endpoint = NativeEndpoint::from_runtime_endpoint(entry.endpoint.clone());
    let identity = SessionIdentity::new(
        entry.key.clone(),
        endpoint.provider(),
        entry.agent_id.clone(),
    )?;
    SessionState::new(identity, epoch)
        .ok()?
        .with_endpoint_session_id(Some(entry.endpoint_session_id.clone()))
        .ok()
}
