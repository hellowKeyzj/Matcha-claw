use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use futures_util::future::BoxFuture;

use foundation::execution::{
    CommandRoute, LaneRetention, OwnerRuntimeHandle, OwnerSpec, QueryRoute,
};
use organization::{
    DeliveryId, GraphRunId,
    GraphRunLifecycleState, NativeDeletionEvidence,
    NativeTerminalReceiptTarget, OrganizationStore, RoleAbortOutcome, RuntimeEndpointReference,
    StoreFault, TeamId,
    package::{
        TeamSkillDependencyCatalog, TeamSkillDependencyPlanResult, TeamSkillPackageValidation,
        TeamSkillSelectionError, TeamSkillSelectionResolver,
    },
    run::scheduler::{
        NodePromptRetryDueInvalidReason, NodePromptRetryDueQuery, NodePromptRetryDueQueryOutcome,
    },
};

use crate::future::boxed;
use crate::ports::{RuntimeReceiptOutcome, native_effects::RoleSessionRetirementOutcome};
use platform::trace::{
    identifier_hash, runtime_trace, session_trace, with_session_trace,
};
use serde_json::json;
use runtime_directory::OwnedRuntimeFuture;

#[cfg(test)]
use crate::{ActivityExecutionOutcome, owner::team_run::TeamRunActivityStart};

use crate::{
    OrganizationNativeRuntime, OrganizationRuntimeDirectory,
    TeamCreationFailure, TeamCreationFailureReason, TeamCreationStage,
    application::team_runtime::TeamRuntimeStatus,
};

use super::{
    OrganizationCommand, OrganizationQuery,
    team_run::{
        ManualTeamCreateOutcome, ManualTeamMaterializationInput,
        TeamMaterializationCommandOutcome, TeamRunActivityError,
        TeamRunOwner, TeamTriggerFireResolution,
        creation_store_failure,
    },
};

pub struct OrganizationOwnerInput {
    pub store: OrganizationStore,
    pub runtime_directory: Arc<dyn OrganizationRuntimeDirectory>,
    pub member_introductions: Option<Arc<dyn crate::TeamMemberIntroductions>>,
    pub team_skill_selections: TeamSkillSelectionResolver,
}

#[derive(Clone)]
pub(crate) struct OrganizationShared {
    pub(super) runtime_directory: Arc<dyn OrganizationRuntimeDirectory>,
    pub(super) member_introductions: Option<Arc<dyn crate::TeamMemberIntroductions>>,
    store_path: PathBuf,
    pub(super) command_target: Arc<OnceLock<OwnerRuntimeHandle<OrganizationCommand, OrganizationQuery>>>,
    pub(super) team_skill_selections: Arc<tokio::sync::Mutex<TeamSkillSelectionResolver>>,
    schedule_errors: Arc<Mutex<BTreeMap<GraphRunId, StoreFault>>>,
}

pub(crate) struct OrganizationGlobalState {
    store: OrganizationStore,
    team_run: TeamRunOwner,
    terminal_settlement: super::terminal_settlement::TeamRunTerminalSettlement,
}

#[derive(Clone, Eq, Hash, PartialEq)]
pub(crate) enum OrganizationLaneKey {
    Team(TeamId),
    Run(GraphRunId),
    RunRead(GraphRunId),
    TeamRead(TeamId),
    ReceiptsRead,
    TeamSkill,
}

pub(crate) struct OrganizationRunLane {
    pub(super) store_path: PathBuf,
    pub(super) store: Option<OrganizationStore>,
    pub(super) team_run: TeamRunOwner,
    pub(super) native: super::native_operations::NativeOperations,
    pub(super) team_delete: super::team_delete::TeamDeletion,
    message_projection: crate::run::public_projection::TeamRunMessageProjectionCache,
}

struct TeamSkillRuntime {
    runtime: Arc<dyn OrganizationNativeRuntime>,
}

pub(crate) struct OrganizationOwner {
    shared: OrganizationShared,
    global: Box<OrganizationGlobalState>,
}

impl OrganizationOwner {
    pub(crate) fn new(input: OrganizationOwnerInput) -> Self {
        let store_path = input.store.path().to_owned();
        Self {
            shared: OrganizationShared {
                runtime_directory: input.runtime_directory,
                member_introductions: input.member_introductions,
                store_path: store_path.clone(),
                command_target: Arc::new(OnceLock::new()),
                team_skill_selections: Arc::new(tokio::sync::Mutex::new(input.team_skill_selections)),
                schedule_errors: Arc::new(Mutex::new(BTreeMap::new())),
            },
            global: Box::new(OrganizationGlobalState {
                store: input.store,
                team_run: TeamRunOwner::new(),
                terminal_settlement: super::terminal_settlement::TeamRunTerminalSettlement::new(),
            }),
        }
    }

    pub(crate) fn command_target(
        &self,
    ) -> Arc<OnceLock<OwnerRuntimeHandle<OrganizationCommand, OrganizationQuery>>> {
        Arc::clone(&self.shared.command_target)
    }

    pub(crate) const fn lane_retention() -> LaneRetention {
        LaneRetention::LowFrequency
    }
}

impl OrganizationShared {
    pub(super) fn team_prompt_settings(&self) -> Result<crate::prompts::TeamPromptSettings, crate::MemberIntroductionError> {
        OrganizationStore::read_team_prompts(&self.store_path)
            .map_err(|_| crate::MemberIntroductionError::Unavailable)
    }

    pub(super) fn team_runtime_for_endpoint(
        &self,
        endpoint: &RuntimeEndpointReference,
    ) -> Option<Arc<dyn OrganizationNativeRuntime>> {
        self.runtime_directory.team_runtime_for_endpoint(endpoint)
    }

    pub(super) fn team_materialize(
        &self,
        request: organization::TeamMaterializationRequest,
        observer: Option<crate::TeamProvisionObserver>,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        let Some(runtime) = self.team_runtime_for_endpoint(request.intent().endpoint()) else {
            return boxed(move || async move {
                if let Some(observer) = observer {
                    observer.report(crate::TeamProvisionUpdate::Failure(TeamCreationFailure::new(
                        TeamCreationStage::ConfiguringTeam, TeamCreationFailureReason::Unavailable,
                    ))).await;
                }
                session_trace(
                    "runtime.team.native.materialize.end",
                    || json!({"reason": "runtime_missing", "nativeOutcome": "outcome_unknown"}),
                );
                organization::MaterializationOperationOutcome::OutcomeUnknown
            });
        };
        let native = runtime.materialize_team_cancellable(request, observer, cancellation);
        boxed(move || async move {
            let started = platform::trace::enabled().then(Instant::now);
            session_trace("runtime.team.native.materialize.start", || json!({}));
            let outcome = native.await;
            session_trace(
                "runtime.team.native.materialize.end",
                || json!({"nativeOutcome": materialization_outcome_label(&outcome), "elapsedMs": started.map(|started| started.elapsed().as_millis())}),
            );
            outcome
        })
    }

    pub(super) fn team_remove(
        &self,
        removal: organization::TeamMaterializationRemoval,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        let Some(runtime) = self.team_runtime_for_endpoint(removal.receipt().endpoint()) else {
            return boxed(|| async {
                organization::MaterializationOperationOutcome::OutcomeUnknown
            });
        };
        runtime.remove_team_cancellable(removal, cancellation)
    }

    pub(super) fn team_remove_unconfirmed(
        &self,
        request: organization::TeamMaterializationRequest,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        let Some(runtime) = self.team_runtime_for_endpoint(request.intent().endpoint()) else {
            return boxed(|| async {
                session_trace(
                    "runtime.team.native.remove-unconfirmed.end",
                    || json!({"reason": "runtime_missing", "nativeOutcome": "outcome_unknown"}),
                );
                organization::MaterializationOperationOutcome::OutcomeUnknown
            });
        };
        let native = runtime.remove_unconfirmed_team_cancellable(request, cancellation);
        boxed(move || async move {
            let started = platform::trace::enabled().then(Instant::now);
            session_trace("runtime.team.native.remove-unconfirmed.start", || json!({}));
            let outcome = native.await;
            session_trace(
                "runtime.team.native.remove-unconfirmed.end",
                || json!({"nativeOutcome": materialization_outcome_label(&outcome), "elapsedMs": started.map(|started| started.elapsed().as_millis())}),
            );
            outcome
        })
    }

    pub(super) fn team_cancel_role_sessions(
        &self,
        bindings: Vec<organization::RoleSessionReceipt>,
        readback: bool,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> OwnedRuntimeFuture<RoleAbortOutcome> {
        let shared = self.clone();
        boxed(move || async move {
            let groups = super::run_delete::group_role_sessions(bindings).into_iter().collect();
            let outcomes = foundation::pipeline::map_concurrent(4, groups, |(endpoint, bindings)| {
                let runtime = shared.team_runtime_for_endpoint(&endpoint);
                let cancellation = cancellation.clone();
                async move {
                    Ok::<_, foundation::pipeline::PipelineError>(match runtime {
                        Some(runtime) if readback => runtime.readback_role_cancellation_cancellable(bindings, cancellation).await,
                        Some(runtime) => runtime.abort_role_sessions_cancellable(bindings, cancellation).await,
                        None => RoleAbortOutcome::OutcomeUnknown,
                    })
                }
            }).await;
            match outcomes {
                Ok(outcomes) if outcomes.iter().all(|outcome| *outcome == RoleAbortOutcome::Confirmed) => RoleAbortOutcome::Confirmed,
                _ => RoleAbortOutcome::OutcomeUnknown,
            }
        })
    }

    pub(super) fn team_delete_role_sessions(
        &self,
        run_id: GraphRunId,
        bindings: Vec<organization::RoleSessionReceipt>,
        abort_first: bool,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> OwnedRuntimeFuture<NativeDeletionEvidence> {
        let shared = self.clone();
        boxed(move || async move {
            let groups = super::run_delete::group_role_sessions(bindings).into_iter().collect();
            let outcomes = foundation::pipeline::map_concurrent(4, groups, |(endpoint, bindings)| {
                let runtime = shared.team_runtime_for_endpoint(&endpoint);
                let run_id = run_id.clone();
                let cancellation = cancellation.clone();
                async move {
                    Ok::<_, foundation::pipeline::PipelineError>(match runtime {
                        Some(runtime) => runtime.delete_role_sessions_cancellable(run_id, bindings, abort_first, cancellation).await,
                        None => NativeDeletionEvidence::OutcomeUnknown,
                    })
                }
            }).await;
            let Ok(outcomes) = outcomes else { return NativeDeletionEvidence::OutcomeUnknown; };
            let mut confirmations = Vec::new();
            let mut failure = None;
            for outcome in outcomes {
                if let Some(proof) = outcome.proof() {
                    if proof.run_id() != &run_id {
                        failure = Some(crate::NativeDeletionFailure::OutcomeUnknown);
                        continue;
                    }
                    confirmations.extend_from_slice(proof.confirmations());
                }
                failure = failure.max(outcome.failure());
            }
            NativeDeletionEvidence::from_confirmations(run_id, confirmations, failure)
        })
    }

    pub(super) fn team_retire_unconfirmed_role_sessions(
        &self,
        bindings: Vec<organization::RoleSessionReceipt>,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> OwnedRuntimeFuture<RoleSessionRetirementOutcome> {
        let shared = self.clone();
        boxed(move || async move {
            if bindings.is_empty() { return RoleSessionRetirementOutcome::OutcomeUnknown; }
            let groups = super::run_delete::group_role_sessions(bindings).into_iter().collect();
            let outcomes = foundation::pipeline::map_concurrent(4, groups, |(endpoint, bindings)| {
                let runtime = shared.team_runtime_for_endpoint(&endpoint);
                let cancellation = cancellation.clone();
                async move {
                    Ok::<_, foundation::pipeline::PipelineError>(match runtime {
                        Some(runtime) => runtime.retire_unconfirmed_role_sessions(bindings, cancellation).await,
                        None => RoleSessionRetirementOutcome::OutcomeUnknown,
                    })
                }
            }).await;
            match outcomes {
                Ok(outcomes) if outcomes.iter().all(|outcome| *outcome == RoleSessionRetirementOutcome::Confirmed) => RoleSessionRetirementOutcome::Confirmed,
                _ => RoleSessionRetirementOutcome::OutcomeUnknown,
            }
        })
    }

    fn team_skill_runtime(&self, endpoint: &RuntimeEndpointReference) -> Option<TeamSkillRuntime> {
        self.runtime_directory
            .team_runtime_for_endpoint(endpoint)
            .map(|runtime| TeamSkillRuntime { runtime })
    }
}

impl TeamSkillRuntime {
    async fn installed_skill_names(
        &self,
        source_agent: Option<organization::ManagedAgentReference>,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> Option<Vec<String>> {
        tokio::select! {
            _ = cancellation.cancelled() => None,
            names = self.runtime.installed_skill_names(source_agent) => names,
        }
    }
}

impl OrganizationGlobalState {
    fn refresh(&mut self) -> Result<(), StoreFault> {
        self.store.refresh()
    }

    fn active_run_ids(&self) -> Vec<GraphRunId> {
        self.store
            .facts()
            .runs()
            .filter(|run| matches!(run.lifecycle().state(), GraphRunLifecycleState::Active))
            .map(|run| run.run_id().clone())
            .collect()
    }

    fn native_terminal_target(
        &self,
        delivery_id: &DeliveryId,
    ) -> Option<NativeTerminalReceiptTarget> {
        self.team_run
            .native_terminal_target(&self.store, delivery_id)
    }

}

impl OrganizationRunLane {
    fn new(store_path: PathBuf) -> Self {
        Self {
            store_path,
            store: None,
            team_run: TeamRunOwner::new(),
            native: super::native_operations::NativeOperations::default(),
            team_delete: super::team_delete::TeamDeletion::default(),
            message_projection: Default::default(),
        }
    }

    pub(super) fn open_store<'a>(
        store: &'a mut Option<OrganizationStore>,
        path: &std::path::Path,
    ) -> Result<&'a mut OrganizationStore, StoreFault> {
        if let Some(store) = store {
            store.refresh()?;
        } else {
            *store = Some(OrganizationStore::open_live(path)?);
        }
        Ok(store.as_mut().expect("run lane store was opened"))
    }
}

impl OwnerSpec for OrganizationOwner {
    const PENDING_LIFECYCLE: bool = true;

    type Command = OrganizationCommand;
    type Query = OrganizationQuery;
    type Key = OrganizationLaneKey;
    type Shared = OrganizationShared;
    type GlobalState = Box<OrganizationGlobalState>;
    type LaneState = Box<OrganizationRunLane>;

    fn split(self) -> (Self::Shared, Self::GlobalState) {
        (self.shared, self.global)
    }

    fn route_command(command: &Self::Command) -> CommandRoute<Self::Key> {
        match command {
            OrganizationCommand::NativeOperationSettled { key } => CommandRoute::KeyedControl(key.clone()),
            OrganizationCommand::RunNativeLease { run_id, .. } => CommandRoute::KeyedControl(OrganizationLaneKey::Run(run_id.clone())),
            OrganizationCommand::RunCancel { run_id, .. } => CommandRoute::KeyedControl(OrganizationLaneKey::Run(run_id.clone())),
            OrganizationCommand::TaskCancel { identity, .. } => CommandRoute::KeyedControl(OrganizationLaneKey::Run(identity.run_id.clone())),
            OrganizationCommand::TeamSkillAuthorize { .. } => CommandRoute::Keyed(OrganizationLaneKey::TeamSkill),
            OrganizationCommand::TeamSkillMaterialize { team_id, .. }
            | OrganizationCommand::RecoverTeamReceipts { team_id, .. }
            | OrganizationCommand::ManualTeamMaterialize { team_id, .. }
            | OrganizationCommand::ManualTeamCreate { team_id, .. }
            | OrganizationCommand::TeamDelete { team_id, .. }
            | OrganizationCommand::DrainTeamDeleteTasks { team_id, .. } => {
                CommandRoute::Keyed(OrganizationLaneKey::Team(team_id.clone()))
            }
            OrganizationCommand::TeamDeleteRunNativeSettled { team_id, .. }
            | OrganizationCommand::TeamDeleteUnconfirmedRunSettled { team_id, .. }
            | OrganizationCommand::TeamDeleteRemovalSettled { team_id, .. } => {
                CommandRoute::KeyedControl(OrganizationLaneKey::Team(team_id.clone()))
            }
            OrganizationCommand::ManualTeamRunCreate { run, .. } => {
                CommandRoute::Keyed(OrganizationLaneKey::Run(run.run_id().clone()))
            }
            OrganizationCommand::TaskCreate { request, .. } => {
                CommandRoute::Keyed(OrganizationLaneKey::Run(request.identity.run_id.clone()))
            }
            OrganizationCommand::TaskNativeExecutionObserved { identity, .. } => {
                CommandRoute::Keyed(OrganizationLaneKey::Run(identity.run_id.clone()))
            }
            OrganizationCommand::RunPurge { request, .. } => CommandRoute::Keyed(OrganizationLaneKey::Run(request.run_id().clone())),
            OrganizationCommand::RecoverRoleSessions { run_id, .. }
            | OrganizationCommand::RoleSessionCreate { run_id, .. }
            | OrganizationCommand::RunDeleteAndPurge { run_id, .. }
            | OrganizationCommand::RunCreate { run_id, .. }
            | OrganizationCommand::RunCreateFromTeamTemplate { run_id, .. }
            | OrganizationCommand::RunDelete { run_id, .. }
            | OrganizationCommand::RunStart { run_id, .. }
            | OrganizationCommand::NodeTerminalResolve { run_id, .. }
            | OrganizationCommand::TaskBoardMutate { run_id, .. }
            | OrganizationCommand::ScheduleReadyNodes { run_id, .. }
            | OrganizationCommand::ClaimActivity { run_id, .. }
            | OrganizationCommand::AdmitActivityDispatch { run_id, .. }
            | OrganizationCommand::SettleActivity { run_id, .. }
            | OrganizationCommand::NativeRunSettled { run_id, .. } => {
                CommandRoute::Keyed(OrganizationLaneKey::Run(run_id.clone()))
            }
            OrganizationCommand::RunReworkContinue { request, .. } => {
                CommandRoute::Keyed(OrganizationLaneKey::Run(request.run_id.clone()))
            }
            OrganizationCommand::RuntimeGraphPatch { scope, .. } => {
                CommandRoute::Keyed(OrganizationLaneKey::Run(scope.run_id.clone()))
            }
            OrganizationCommand::RecordEvidence { record, .. } => {
                CommandRoute::Keyed(OrganizationLaneKey::Run(GraphRunId::new(record.run_id())))
            }
            OrganizationCommand::Design { operation, .. } => {
                CommandRoute::Keyed(OrganizationLaneKey::Run(operation.run_id().clone()))
            }
            OrganizationCommand::TriggerFire { request, .. } => {
                CommandRoute::Keyed(OrganizationLaneKey::Run(GraphRunId::new(request.run_id.clone())))
            }
            OrganizationCommand::GraphSave { command, .. }
            | OrganizationCommand::NodeEvent { command, .. } => {
                CommandRoute::Keyed(OrganizationLaneKey::Run(GraphRunId::new(command.run_id().as_str())))
            }
            OrganizationCommand::GraphPatch { patch, .. } => {
                CommandRoute::Keyed(OrganizationLaneKey::Run(patch.run_id.clone()))
            }
            OrganizationCommand::ApprovalResolve { command, .. } => {
                CommandRoute::Keyed(OrganizationLaneKey::Run(command.run_id().clone()))
            }
            OrganizationCommand::DecisionSubmit { command, .. } => {
                CommandRoute::Keyed(OrganizationLaneKey::Run(GraphRunId::new(command.run_id())))
            }
            OrganizationCommand::SaveTeamPrompts { .. }
            | OrganizationCommand::RecoverMaterializationReceipts { .. }
            | OrganizationCommand::TeamMessageTerminalObserved { .. }
            | OrganizationCommand::TeamMessageRepairQueued { .. }
            | OrganizationCommand::TeamMessageRepairRejected { .. }
            | OrganizationCommand::WebhookTriggerFire { .. } => CommandRoute::Global,
        }
    }

    fn route_query(query: &Self::Query) -> QueryRoute<Self::Key> {
        match query {
            OrganizationQuery::RunSnapshot { query, .. } => QueryRoute::Keyed(OrganizationLaneKey::RunRead(query.run().clone())),
            OrganizationQuery::TaskInspect { identity, .. } => QueryRoute::Keyed(OrganizationLaneKey::RunRead(identity.run_id.clone())),
            OrganizationQuery::RuntimeGraphContext { scope, .. } => QueryRoute::Keyed(OrganizationLaneKey::Run(scope.run_id.clone())),
            OrganizationQuery::RunWorkspaceBinding { run_id, .. }
            | OrganizationQuery::TeamRunPublicProjection { run_id, .. }
            | OrganizationQuery::TeamRunPublicSnapshot { run_id, .. }
            | OrganizationQuery::NodeReviewHistory { run_id, .. }
            | OrganizationQuery::TeamRunDiagnostics { run_id, .. }
            | OrganizationQuery::GraphDefinition { run_id, .. }
            | OrganizationQuery::GraphYaml { run_id, .. }
            | OrganizationQuery::TaskBoardRead { run_id, .. }
            | OrganizationQuery::PendingApprovals { run_id, .. }
            | OrganizationQuery::NodePromptRetryDue { run_id, .. } => {
                QueryRoute::Keyed(OrganizationLaneKey::RunRead(run_id.clone()))
            }
            OrganizationQuery::GraphContext { query, .. } => QueryRoute::Keyed(OrganizationLaneKey::RunRead(query.run().clone())),
            OrganizationQuery::RunList { team_id, .. }
            | OrganizationQuery::RoleSessions { team_id, .. }
            | OrganizationQuery::Resume { team_id, .. }
            | OrganizationQuery::TriggerList { team_id: Some(team_id), .. } => QueryRoute::Keyed(OrganizationLaneKey::TeamRead(team_id.clone())),
            OrganizationQuery::RoleSessionReceipts { .. } => QueryRoute::Keyed(OrganizationLaneKey::ReceiptsRead),
            OrganizationQuery::WorkflowRunTeam { .. }
            | OrganizationQuery::TeamSkillValidate { .. }
            | OrganizationQuery::TeamSkillDependencyPlan { .. }
            | OrganizationQuery::TeamSkillSelectionValidate { .. }
            | OrganizationQuery::TeamSkillSelectionDependencyPlan { .. } => QueryRoute::Direct,
            OrganizationQuery::TeamPromptSettings { .. }
            | OrganizationQuery::StartGatePromptPlan { .. }
            | OrganizationQuery::TriggerList { team_id: None, .. }
            | OrganizationQuery::NativeDeliveryByRun { .. }
            | OrganizationQuery::TeamMessageTerminalContext { .. }
            | OrganizationQuery::TeamMessageFileValidation { .. }
            | OrganizationQuery::PendingTeamMessageRepairs { .. }
            | OrganizationQuery::ActiveRunIds { .. }
            | OrganizationQuery::MatchaTerminalTarget { .. } => QueryRoute::Global,
        }
    }

    fn open_lane(shared: &Self::Shared, _key: &Self::Key) -> Self::LaneState {
        Box::new(OrganizationRunLane::new(shared.store_path.clone()))
    }

    fn keyed_command_ready(
        _shared: &Self::Shared,
        _key: &Self::Key,
        lane: &Self::LaneState,
        command: &Self::Command,
    ) -> bool {
        lane.native.ready(command)
    }

    fn lane_has_pending(_shared: &Self::Shared, _key: &Self::Key, lane: &Self::LaneState) -> bool {
        lane.native.has_pending() || lane.team_delete.has_pending()
    }

    async fn shutdown(
        shared: Self::Shared,
        _global: &mut Self::GlobalState,
        lanes: Vec<(Self::Key, Self::LaneState)>,
    ) {
        for (_, lane) in &lanes {
            lane.native.cancel();
            lane.team_delete.cancel();
        }
        for (key, mut lane) in lanes {
            super::native_operations::shutdown(&shared, key, &mut lane).await;
            lane.team_delete.shutdown().await;
        }
    }

    fn handle_keyed_command(
        shared: Self::Shared,
        key: Self::Key,
        state: &mut Self::LaneState,
        command: Self::Command,
    ) -> impl std::future::Future<Output = ()> + Send {
        let state = state.as_mut();
        let execution: BoxFuture<'_, ()> = match command {
            command @ (OrganizationCommand::TeamDelete { .. }
                | OrganizationCommand::TeamDeleteRunNativeSettled { .. }
                | OrganizationCommand::TeamDeleteUnconfirmedRunSettled { .. }
                | OrganizationCommand::TeamDeleteRemovalSettled { .. }
                | OrganizationCommand::DrainTeamDeleteTasks { .. }) => super::team_delete::handle(shared, state, command),
            command @ (OrganizationCommand::NativeOperationSettled { .. }
                | OrganizationCommand::RunNativeLease { .. }
                | OrganizationCommand::RecoverRoleSessions { .. }
                | OrganizationCommand::RoleSessionCreate { .. }
                | OrganizationCommand::ManualTeamRunCreate { .. }
                | OrganizationCommand::RunCreateFromTeamTemplate { .. }
                | OrganizationCommand::TaskCreate { .. }
                | OrganizationCommand::TaskCancel { .. }
                | OrganizationCommand::RunCancel { .. }
                | OrganizationCommand::RunDeleteAndPurge { .. }) => super::native_operations::handle(shared, key, state, command),
            OrganizationCommand::TeamSkillAuthorize { package_root, reply } => boxed(move || async move {
                if !reply.running().await { return; }
                let outcome = shared.team_skill_selections.lock().await.authorize(package_root);
                let _ = reply.send(outcome).await;
            }),
            OrganizationCommand::TeamSkillMaterialize { selection_id, endpoint, source_agent, team_id, idempotency_key, reply } => boxed(move || async move {
                if !reply.running().await { return; }
                match OrganizationRunLane::open_store(&mut state.store, &state.store_path) {
                    Ok(store) => super::team_skill::materialize(store, &shared, selection_id,
                        endpoint, source_agent, team_id, idempotency_key, reply).await,
                    Err(error) => {
                        reply.creation_failure(creation_store_failure(TeamCreationStage::Submitting, &error)).await;
                        reply.materialization(None, Err(&error)).await;
                        let _ = reply.send(TeamMaterializationCommandOutcome::Unavailable).await;
                    }
                }
            }),
            OrganizationCommand::RecoverTeamReceipts { materialization, removal, guard, cancellation, reply, .. } => boxed(move || async move {
                if let Ok(store) = OrganizationRunLane::open_store(&mut state.store, &state.store_path) {
                    super::recovery::team(store, &shared, materialization, removal, cancellation).await;
                }
                drop(guard);
                let _ = reply.send(());
            }),
            OrganizationCommand::RunPurge { request, reply } => boxed(move || async move {
                if !reply.running().await { return; }
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path)
                    .and_then(|store| state.team_run.purge(store, request));
                let _ = reply.send(outcome).await;
            }),
            OrganizationCommand::ManualTeamMaterialize {
                team_id,
                team_name,
                roles,
                idempotency_key,
                reply,
            } => boxed(move || async move {
                if !reply.running().await { return; }
                with_session_trace(reply.trace_id(), async {
                    let started = platform::trace::enabled().then(Instant::now);
                    session_trace("runtime.team.refresh.start", || json!({}));
                    let refreshed = OrganizationRunLane::open_store(&mut state.store, &state.store_path);
                    trace_store_result("runtime.team.refresh.end", started, &refreshed);
                    if let Err(error) = &refreshed {
                        reply.creation_failure(creation_store_failure(TeamCreationStage::Submitting, error)).await;
                        let _ = reply
                            .send(TeamMaterializationCommandOutcome::Unavailable)
                            .await;
                        return;
                    }
                    let owner_started = platform::trace::enabled().then(Instant::now);
                    session_trace("runtime.team.owner.start", || json!({}));
                    let outcome = super::manual_team::manual_team_materialize(
                            refreshed.expect("manual team store was opened"),
                            &shared,
                            team_id,
                            team_name,
                            roles,
                            idempotency_key,
                            Some(&reply),
                        )
                        .await;
                    session_trace(
                        "runtime.team.owner.end",
                        || json!({"reason": match &outcome {
                    TeamMaterializationCommandOutcome::Materialized { .. } => "succeeded",
                    TeamMaterializationCommandOutcome::Rejected => "rejected",
                    TeamMaterializationCommandOutcome::Unavailable => "unavailable",
                    TeamMaterializationCommandOutcome::OutcomeUnknown => "outcome_unknown",
                }, "elapsedMs": owner_started.map(|started| started.elapsed().as_millis())}),
                    );
                    let _ = reply.send(outcome).await;
                })
                .await;
            }),
            OrganizationCommand::ManualTeamCreate {
                team_id,
                team_name,
                roles,
                materialization_idempotency_key,
                run,
                run_idempotency_key,
                reply,
                continue_run,
            } => boxed(move || async move {
                if !reply.running().await { return; }
                with_session_trace(reply.trace_id(), boxed(|| async {
                    let started = platform::trace::enabled().then(Instant::now);
                    session_trace("runtime.team.refresh.start", || json!({}));
                    let refreshed = OrganizationRunLane::open_store(&mut state.store, &state.store_path);
                    trace_store_result("runtime.team.refresh.end", started, &refreshed);
                    if let Err(error) = &refreshed {
                        reply.creation_failure(creation_store_failure(TeamCreationStage::Submitting, error)).await;
                        let _ = reply.send(ManualTeamCreateOutcome::Unavailable).await;
                        return;
                    }
                    let owner_started = platform::trace::enabled().then(Instant::now);
                    session_trace("runtime.team.owner.start", || json!({}));
                    let prepared = super::manual_team::prepare_manual_team_run(
                            refreshed.expect("manual team store was opened"),
                            &shared,
                            ManualTeamMaterializationInput {
                                team_id,
                                team_name,
                                roles,
                                materialization_idempotency_key,
                                run,
                                run_idempotency_key,
                            },
                            &reply,
                        )
                        .await;
                    match prepared {
                        Ok((team_id, run, run_idempotency_key)) => {
                            // The caller hands off outside the owner mailbox, so bounded admission cannot hold this lane.
                            if let Err((_, _, _, reply)) = continue_run.send((team_id, run, run_idempotency_key, reply)) {
                                let _ = reply.send(ManualTeamCreateOutcome::Unavailable).await;
                            }
                        }
                        Err(outcome) => {
                            session_trace("runtime.team.owner.end", || json!({
                                "reason": "materialization_not_confirmed",
                                "elapsedMs": owner_started.map(|started| started.elapsed().as_millis()),
                            }));
                            let _ = reply.send(outcome).await;
                        }
                    }
                }))
                .await;
            }),

            OrganizationCommand::RunCreate {
                team_id,
                run_id,
                idempotency_key,
                workflow_plan,
                source_identity,
                template_revision,
                created_at,
                reply,
            } => boxed(move || async move {
                if !reply.running().await { return; }
                let outcome = match OrganizationRunLane::open_store(&mut state.store, &state.store_path) {
                    Ok(mut store) => {
                        state
                            .team_run
                            .create_for_team(
                                &mut store,
                                team_id,
                                run_id,
                                &idempotency_key,
                                workflow_plan,
                                source_identity,
                                template_revision,
                                created_at,
                            )
                            .await
                    }
                    Err(error) => Err(error),
                };
                let _ = reply.send(outcome).await;
            }),
            OrganizationCommand::TaskNativeExecutionObserved { identity, request, execution, reply } => boxed(move || async move {
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path)
                    .and_then(|mut store| super::task_execution::record_inspection(
                        &mut store, identity, request, execution,
                    ));
                let _ = reply.send(outcome);
            }),
            OrganizationCommand::RunDelete {
                run_id,
                idempotency_key,
                tombstoned_at,
                reply,
            } => boxed(move || async move {
                if !reply.running().await { return; }
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path).and_then(|mut store| {
                    state
                        .team_run
                        .tombstone(&mut store, &run_id, &idempotency_key, tombstoned_at)
                });
                let _ = reply.send(outcome).await;
            }),
            OrganizationCommand::RunStart { team_id, run_id, epoch, version, reply } => boxed(move || async move {
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path).and_then(|store| {
                    store.start_run(&team_id, &run_id, epoch.as_deref(), &version)
                });
                let _ = reply.send(outcome);
            }),
            OrganizationCommand::RunReworkContinue { request, reply } => boxed(move || async move {
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path)
                    .and_then(|store| store.continue_rework(&request, now_millis()));
                let _ = reply.send(outcome);
            }),
            OrganizationCommand::RuntimeGraphPatch { scope, patch, reply } => boxed(move || async move {
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path).and_then(|store| {
                    store.runtime_graph_patch(&scope, patch)
                });
                let _ = reply.send(outcome);
            }),
            OrganizationCommand::Design { operation, resolver, reply } => boxed(move || async move {
                let snapshot_run = matches!(&operation, crate::application::design::DesignOperation::Snapshot { .. })
                    .then(|| operation.run_id().clone());
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path).and_then(|mut store| {
                    crate::application::design::execute(&mut store, operation, resolver.as_ref())
                }).map(|(mut value, changed)| {
                    if let Some(run_id) = snapshot_run
                        && value["runtimeError"].is_null()
                    {
                        let error = shared.schedule_errors.lock()
                            .expect("organization schedule observations poisoned")
                            .get(&run_id).cloned();
                        value["runtimeError"] = error.map_or(serde_json::Value::Null,
                            crate::application::team_mcp::design_rejected);
                    }
                    (value, changed)
                });
                let _ = reply.send(outcome);
            }),
            OrganizationCommand::TriggerFire {
                request,
                fired_at,
                reply,
            } => boxed(move || async move {
                if !reply.running().await { return; }
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path).and_then(|mut store| {
                    state.team_run.fire_trigger(&mut store, request, fired_at)
                });
                let _ = reply.send(outcome).await;
            }),
            OrganizationCommand::GraphSave { command, definition, reply } => boxed(move || async move {
                if !reply.running().await { return; }
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path).and_then(|mut store| {
                    state.team_run.replace_graph(&mut store, command, definition)
                });
                let _ = reply.send(outcome).await;
            }),
            OrganizationCommand::GraphPatch { patch, reply } => boxed(move || async move {
                if !reply.running().await { return; }
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path).and_then(|mut store| {
                    state.team_run.apply_graph_patch(&mut store, patch)
                });
                let _ = reply.send(outcome).await;
            }),
            OrganizationCommand::NodeEvent {
                command,
                event,
                reply,
            } => boxed(move || async move {
                if !reply.running().await { return; }
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path).and_then(|store| {
                    store.team_node_event(command, event)
                });
                let _ = reply.send(outcome).await;
            }),
            OrganizationCommand::NodeTerminalResolve {
                run_id,
                node_execution_id,
                event,
                terminal,
                summary,
                output_port,
                idempotency_key,
                resolved_at,
                reply,
            } => boxed(move || async move {
                if !reply.running().await { return; }
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path).and_then(|mut store| {
                    state.team_run.resolve_node_terminal(
                        &mut store,
                        &run_id,
                        &node_execution_id,
                        &event,
                        terminal.as_ref(),
                        &summary,
                        output_port.as_deref(),
                        &idempotency_key,
                        resolved_at,
                    )
                });
                let _ = reply.send(outcome).await;
            }),
            OrganizationCommand::ApprovalResolve { command, reply } => boxed(move || async move {
                if !reply.running().await { return; }
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path).and_then(|store| {
                    store.resolve_human_decision(command)
                });
                let _ = reply.send(outcome).await;
            }),
            OrganizationCommand::DecisionSubmit { command, reply } => boxed(move || async move {
                if !reply.running().await { return; }
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path)
                    .and_then(|store| store.record_decision(command));
                let _ = reply.send(outcome).await;
            }),
            OrganizationCommand::TaskBoardMutate {
                team_id,
                run_id,
                operation,
                reply,
            } => boxed(move || async move {
                if !reply.running().await { return; }
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path)
                    .map_err(crate::application::task_board::MutationError::Store)
                    .and_then(|mut store| {
                        crate::application::task_board::mutate(&mut store, team_id, run_id, operation)
                    });
                let _ = reply.send(outcome).await;
            }),
            OrganizationCommand::ScheduleReadyNodes { run_id, now, reply } => boxed(move || async move {
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path).inspect_err(|error| {
                    runtime_trace("runtime.team_run.schedule.store.open.error", || json!({
                        "runHash": identifier_hash(run_id.as_str()), "errorKind": store_fault_label(error),
                    }));
                }).and_then(|mut store| {
                    crate::owner::run_scheduler::schedule_run_activities(
                        &mut store,
                        run_id.clone(),
                        now,
                    )
                });
                let changed = {
                    let mut errors = shared.schedule_errors.lock()
                        .expect("organization schedule observations poisoned");
                    match &outcome {
                        Ok(_) => errors.remove(&run_id).is_some(),
                        Err(error) if errors.get(&run_id) == Some(error) => false,
                        Err(error) => {
                            errors.insert(run_id, error.clone());
                            true
                        }
                    }
                };
                let _ = reply.send((outcome, changed));
            }),
            OrganizationCommand::ClaimActivity {
                run_id,
                activity_id,
                claimed_at,
                reply,
            } => boxed(move || async move {
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path)
                    .map_err(TeamRunActivityError::Store)
                    .and_then(|mut store| {
                        if !crate::owner::run_scheduler::activity_belongs_to(
                            &store, &run_id, &activity_id,
                        ) {
                            return Err(TeamRunActivityError::TargetUnavailable);
                        }
                        state
                            .team_run
                            .claim_agent_activity(&mut store, activity_id, claimed_at)
                    });
                let _ = reply.send(outcome);
            }),
            OrganizationCommand::AdmitActivityDispatch { run_id, claim, request, reply } => boxed(move || async move {
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path)
                    .and_then(|store| {
                        if request.delivery_request().run_id != run_id.as_str() {
                            return Ok(false);
                        }
                        store.admit_agent_activity_dispatch(&claim, &request)
                    });
                let _ = reply.send(outcome);
            }),
            OrganizationCommand::SettleActivity {
                run_id,
                claim,
                outcome,
                observed_at,
                reply,
            } => boxed(move || async move {
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path)
                    .map_err(TeamRunActivityError::Store)
                    .and_then(|mut store| {
                        if store.activity_was_purged(&run_id, claim.activity_id())
                            .map_err(TeamRunActivityError::Store)?
                        {
                            return Err(TeamRunActivityError::Retired);
                        }
                        if !crate::owner::run_scheduler::activity_belongs_to(
                            &store,
                            &run_id,
                            claim.activity_id(),
                        ) {
                            return Err(TeamRunActivityError::SessionMismatch);
                        }
                        state
                            .team_run
                            .settle_agent_activity_dispatch(&mut store, claim, outcome, observed_at)
                    });
                let _ = reply.send(outcome);
            }),
            OrganizationCommand::NativeRunSettled {
                file_validation,
                run_id,
                delivery_id,
                settled,
                settled_at,
                reply,
            } => boxed(move || async move {
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path).and_then(|mut store| {
                    super::team_run::resolve_native_settled_output_validated(
                        &mut store,
                        &run_id,
                        &delivery_id,
                        settled,
                        settled_at,
                        file_validation,
                    )
                });
                let _ = reply.send(outcome);
            }),
            OrganizationCommand::RecordEvidence { record, reply } => boxed(move || async move {
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path)
                    .and_then(|store| store.record_evidence(record));
                let _ = reply.send(outcome);
            }),
            OrganizationCommand::SaveTeamPrompts { .. }
            | OrganizationCommand::WebhookTriggerFire { .. }
            | OrganizationCommand::RecoverMaterializationReceipts { .. }
            | OrganizationCommand::TeamMessageTerminalObserved { .. }
            | OrganizationCommand::TeamMessageRepairQueued { .. }
            | OrganizationCommand::TeamMessageRepairRejected { .. } => {
                unreachable!("organization command routed to wrong run lane")
            }
        };
        execution
    }

    fn handle_global_command(
        _shared: Self::Shared,
        state: &mut Self::GlobalState,
        command: Self::Command,
    ) -> impl std::future::Future<Output = ()> + Send {
        let state = state.as_mut();
        let execution: BoxFuture<'_, ()> = match command {
            OrganizationCommand::SaveTeamPrompts { expected_revision, values, reply } => boxed(move || async move {
                if !reply.running().await { return; }
                let outcome = state.store.save_team_prompts(expected_revision, values);
                let _ = reply.send(outcome).await;
            }),
            OrganizationCommand::TeamMessageTerminalObserved {
                identity,
                resolver,
                file_validation,
                task_observation,
                inspection,
                native_run_id,
                delivery_context,
                status,
                assistant_texts,
                settled_at,
                reply,
            } => boxed(move || async move {
                let started = platform::trace::enabled().then(std::time::Instant::now);
                let native_run_hash = platform::trace::enabled().then(|| identifier_hash(&native_run_id));
                let delivery_hash = platform::trace::enabled().then(|| delivery_context.as_ref().map(|(delivery, _)| identifier_hash(delivery.as_str()))).flatten();
                runtime_trace("runtime.team_run.terminal.owner.begin", || json!({
                    "nativeRunHash": native_run_hash, "deliveryHash": delivery_hash,
                    "phase": format!("{status:?}"), "candidateCount": assistant_texts.as_ref().ok().map(Vec::len),
                    "hasDeliveryContext": delivery_context.is_some(),
                }));
                use super::terminal_settlement::TerminalObservationOutcome;
                let outcome = state.terminal_settlement.observe_team_message_terminal(
                    &mut state.store,
                    &state.team_run,
                    identity,
                    resolver.as_ref(),
                    native_run_id,
                    delivery_context,
                    task_observation,
                    inspection,
                    status,
                    assistant_texts,
                    settled_at,
                    file_validation,
                );
                runtime_trace("runtime.team_run.terminal.owner.result", || json!({
                    "nativeRunHash": native_run_hash, "deliveryHash": delivery_hash,
                    "outcome": match &outcome {
                        Ok(TerminalObservationOutcome::Observed(organization::TeamMessageTerminalObservation::Ignored)) => "ignored",
                        Ok(TerminalObservationOutcome::Observed(organization::TeamMessageTerminalObservation::Repair(_))) => "repair",
                        Ok(TerminalObservationOutcome::Observed(organization::TeamMessageTerminalObservation::Settled)) => "settled",
                        Ok(TerminalObservationOutcome::Inspect { .. }) => "request_receipt_unconfirmed",
                        Err(_) => "store_error",
                    },
                    "repairNativeRunHash": match &outcome {
                        Ok(TerminalObservationOutcome::Observed(organization::TeamMessageTerminalObservation::Repair(repair))) => Some(identifier_hash(repair.requested_run_id())),
                        _ => None,
                    },
                    "error": outcome.as_ref().err().map(crate::trace::terminal_error),
                    "elapsedMs": started.map(|start| start.elapsed().as_millis()),
                }));
                if reply.send(outcome).is_err() {
                    runtime_trace("runtime.team_run.terminal.owner.result", || json!({
                        "nativeRunHash": native_run_hash, "deliveryHash": delivery_hash,
                        "outcome": "reply_closed",
                    }));
                }
            }),
            OrganizationCommand::TeamMessageRepairQueued {
                identity,
                requested_run_id,
                repair,
                reply,
            } => boxed(move || async move {
                let native_run_hash = platform::trace::enabled().then(|| identifier_hash(&requested_run_id));
                state
                    .terminal_settlement
                    .repair_queued(&identity, requested_run_id, &repair);
                let replied = reply.send(()).is_ok();
                runtime_trace("runtime.team_run.repair.queued.owner", || json!({
                    "nativeRunHash": native_run_hash,
                    "repairNativeRunHash": identifier_hash(repair.requested_run_id()),
                    "attempt": repair.attempt(), "outcome": "processed", "replyAccepted": replied,
                }));
            }),
            OrganizationCommand::TeamMessageRepairRejected { identity, repair, reply } => boxed(move || async move {
                let started = platform::trace::enabled().then(std::time::Instant::now);
                runtime_trace("runtime.team_run.repair.rejected.owner.begin", || json!({
                    "nativeRunHash": identifier_hash(repair.requested_run_id()), "attempt": repair.attempt(),
                }));
                let outcome = state.terminal_settlement.repair_rejected(
                    &mut state.store,
                    &state.team_run,
                    &identity,
                    &repair,
                );
                runtime_trace("runtime.team_run.repair.rejected.owner.result", || json!({
                    "nativeRunHash": identifier_hash(repair.requested_run_id()), "attempt": repair.attempt(),
                    "outcome": if outcome.is_ok() { "processed" } else { "store_error" },
                    "error": outcome.as_ref().err().map(crate::trace::terminal_error),
                    "elapsedMs": started.map(|start| start.elapsed().as_millis()),
                }));
                if reply.send(outcome).is_err() {
                    runtime_trace("runtime.team_run.repair.rejected.owner.result", || json!({
                        "nativeRunHash": identifier_hash(repair.requested_run_id()), "outcome": "reply_closed",
                    }));
                }
            }),
            OrganizationCommand::WebhookTriggerFire {
                webhook_path,
                idempotency_key,
                fired_at,
                reply,
            } => boxed(move || async move {
                if !reply.running().await { return; }
                if state.refresh().is_err() {
                    let _ = reply.send(Err(TeamRuntimeStatus::Unavailable)).await;
                    return;
                }
                let outcome = match state.team_run.resolve_webhook_fire(
                    state.team_run.armed_triggers(&state.store, None),
                    &webhook_path,
                    idempotency_key,
                ) {
                    TeamTriggerFireResolution::Request(request) => state
                        .team_run
                        .fire_team_trigger(&mut state.store, request, fired_at)
                        .map_err(|_| TeamRuntimeStatus::Unavailable),
                    TeamTriggerFireResolution::NotFound => {
                        Ok(organization::TeamTriggerFireOutcome::NotFound)
                    }
                    TeamTriggerFireResolution::Rejected => {
                        Ok(organization::TeamTriggerFireOutcome::Rejected)
                    }
                };
                let _ = reply.send(outcome).await;
            }),
            OrganizationCommand::RecoverMaterializationReceipts { reply } => boxed(move || async move {
                let plan = if state.refresh().is_ok() {
                    super::recovery::plan(&state.store)
                } else {
                    super::recovery::RecoveryPlan { teams: Vec::new(), runs: Vec::new() }
                };
                let _ = reply.send(plan);
            }),
            OrganizationCommand::TeamDelete { .. }
            | OrganizationCommand::TeamDeleteRunNativeSettled { .. }
            | OrganizationCommand::TeamDeleteUnconfirmedRunSettled { .. }
            | OrganizationCommand::TeamDeleteRemovalSettled { .. }
            | OrganizationCommand::DrainTeamDeleteTasks { .. }
            | OrganizationCommand::RecordEvidence { .. }
            | OrganizationCommand::NativeOperationSettled { .. }
            | OrganizationCommand::RunNativeLease { .. }
            | OrganizationCommand::TeamSkillAuthorize { .. }
            | OrganizationCommand::RoleSessionCreate { .. }
            | OrganizationCommand::TeamSkillMaterialize { .. }
            | OrganizationCommand::RecoverTeamReceipts { .. }
            | OrganizationCommand::RecoverRoleSessions { .. }
            | OrganizationCommand::RunPurge { .. }
            | OrganizationCommand::ManualTeamMaterialize { .. }
            | OrganizationCommand::ManualTeamCreate { .. }
            | OrganizationCommand::ManualTeamRunCreate { .. }
            | OrganizationCommand::RunDeleteAndPurge { .. }
            | OrganizationCommand::RunCreate { .. }
            | OrganizationCommand::RunCreateFromTeamTemplate { .. }
            | OrganizationCommand::TaskCreate { .. }
            | OrganizationCommand::TaskNativeExecutionObserved { .. }
            | OrganizationCommand::TaskCancel { .. }
            | OrganizationCommand::RunCancel { .. }
            | OrganizationCommand::RunDelete { .. }
            | OrganizationCommand::Design { .. }
            | OrganizationCommand::RuntimeGraphPatch { .. }
            | OrganizationCommand::RunStart { .. }
            | OrganizationCommand::RunReworkContinue { .. }
            | OrganizationCommand::TriggerFire { .. }
            | OrganizationCommand::GraphSave { .. }
            | OrganizationCommand::GraphPatch { .. }
            | OrganizationCommand::NodeEvent { .. }
            | OrganizationCommand::NodeTerminalResolve { .. }
            | OrganizationCommand::ApprovalResolve { .. }
            | OrganizationCommand::DecisionSubmit { .. }
            | OrganizationCommand::TaskBoardMutate { .. }
            | OrganizationCommand::ScheduleReadyNodes { .. }
            | OrganizationCommand::ClaimActivity { .. }
            | OrganizationCommand::AdmitActivityDispatch { .. }
            | OrganizationCommand::SettleActivity { .. }
            | OrganizationCommand::NativeRunSettled { .. } => {
                unreachable!("organization command routed to global lane")
            }
        };
        execution
    }

    fn handle_direct_query(shared: Self::Shared, query: Self::Query) -> impl std::future::Future<Output = ()> + Send {
        let execution: BoxFuture<'_, ()> = match query {
            OrganizationQuery::WorkflowRunTeam { run_id, reply } => boxed(move || async move {
                let team = OrganizationStore::read_run_team(&shared.store_path, &run_id).ok().flatten();
                let _ = reply.send(team);
            }),
            OrganizationQuery::TeamSkillValidate { package_root, reply } => boxed(move || async move {
                if !reply.running().await { return; }
                let _ = reply.send(organization::package::validate_team_skill_package(package_root)).await;
            }),
            OrganizationQuery::TeamSkillDependencyPlan { package_root, reply } => boxed(move || async move {
                if !reply.running().await { return; }
                let _ = reply.send(organization::package::plan_team_skill_dependencies(package_root)).await;
            }),
            OrganizationQuery::TeamSkillSelectionValidate { selection_id, reply } => boxed(move || async move {
                if !reply.running().await { return; }
                let reader = shared.team_skill_selections.lock().await.package_reader(&selection_id);
                let package = reader.and_then(|reader| reader.read().map_err(TeamSkillSelectionError::from));
                let outcome = TeamSkillPackageValidation::from_package(selection_id, package);
                let _ = reply.send(outcome).await;
            }),
            OrganizationQuery::TeamSkillSelectionDependencyPlan { selection_id, endpoint, source_agent, reply } => boxed(move || async move {
                if !reply.running().await { return; }
                let Some(runtime) = shared.team_skill_runtime(&endpoint) else {
                    let _ = reply.send(TeamSkillDependencyPlanResult::Unavailable).await;
                    return;
                };
                let outcome = match runtime.installed_skill_names(source_agent, reply.cancellation()).await {
                    Some(names) => {
                        let reader = shared.team_skill_selections.lock().await.package_reader(&selection_id);
                        let package = reader.and_then(|reader| reader.read().map_err(TeamSkillSelectionError::from));
                        TeamSkillDependencyPlanResult::from_package(
                            selection_id, package, &TeamSkillDependencyCatalog::from_installed_names(names),
                        )
                    }
                    None => TeamSkillDependencyPlanResult::Unavailable,
                };
                let _ = reply.send(outcome).await;
            }),
            _ => unreachable!("organization direct query"),
        };
        execution
    }

    fn handle_keyed_query(
        _shared: Self::Shared,
        _key: Self::Key,
        state: &mut Self::LaneState,
        query: Self::Query,
    ) -> impl std::future::Future<Output = ()> + Send {
        let state = state.as_mut();
        let execution: BoxFuture<'_, ()> = match query {
            OrganizationQuery::RunList { team_id, reply } => boxed(move || async move {
                if !reply.running().await { return; }
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path)
                    .map(|store| state.team_run.list(store, &team_id));
                let _ = reply.send(outcome).await;
            }),
            OrganizationQuery::RoleSessions { team_id, reply } => boxed(move || async move {
                if !reply.running().await { return; }
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path)
                    .map_or(organization::TeamRoleSessionQueryOutcome::Unavailable, |store| state.team_run.query_role_sessions(store, &team_id));
                let _ = reply.send(outcome).await;
            }),
            OrganizationQuery::RoleSessionReceipts { reply } => boxed(move || async move {
                if !reply.running().await { return; }
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path).map(|store| {
                    store.facts().runs().filter_map(|run| run.runtime()).flat_map(|runtime| runtime.bindings()).cloned().collect()
                });
                let _ = reply.send(outcome).await;
            }),
            OrganizationQuery::TaskInspect { identity, reply } => boxed(move || async move {
                if !reply.running().await { return; }
                let outcome = match OrganizationRunLane::open_store(&mut state.store, &state.store_path) {
                    Ok(store) => {
                        let receipt = crate::task_execution::inspect(&store, identity.clone());
                        match super::task_execution::inspection_requests(&store, &receipt) {
                            Ok(requests) => (receipt, requests),
                            Err(error) => (crate::task_execution::store_failure(identity, &error), Vec::new()),
                        }
                    }
                    Err(error) => (crate::task_execution::store_failure(identity, &error), Vec::new()),
                };
                let _ = reply.send(outcome).await;
            }),
            OrganizationQuery::RunWorkspaceBinding { team_id, run_id, endpoint, access, reply } => boxed(move || async move {
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path)
                    .and_then(|store| crate::run::query::query_run_workspace_binding(store.facts(), &team_id, &run_id, &endpoint, access));
                let _ = reply.send(outcome);
            }),
            OrganizationQuery::RunSnapshot { query, reply } => boxed(move || async move {
                if !reply.running().await { return; }
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path)
                    .map_or(organization::TeamRunQueryOutcome::Unavailable, |store| {
                        state.team_run.query(&store, &query)
                    });
                let _ = reply.send(outcome).await;
            }),
            OrganizationQuery::TeamRunPublicProjection {
                team_id,
                run_id,
                reply,
            } => boxed(move || async move {
                if !reply.running().await { return; }
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path).map_or(
                    organization::run::public_projection::TeamPublicQueryOutcome::Unavailable,
                    |store| {
                        crate::application::projection::team_public_projection(
                            &store, &team_id, &run_id,
                        )
                    },
                );
                let _ = reply.send(outcome).await;
            }),
            OrganizationQuery::TeamRunPublicSnapshot {
                team_id,
                run_id,
                event_cursor,
                event_limit,
                message_cursor,
                reply,
            } => boxed(move || async move {
                if !reply.running().await { return; }
                let outcome = match OrganizationRunLane::open_store(&mut state.store, &state.store_path) {
                    Ok(store) => {
                        let (snapshot, role_sessions) = crate::application::projection::team_run_public_snapshot(
                            &store, team_id, run_id, event_cursor, event_limit, message_cursor,
                            &mut state.message_projection,
                        );
                        let failure = snapshot.is_none().then(|| TeamCreationFailure::new(
                            TeamCreationStage::LoadingTeam, TeamCreationFailureReason::InvalidInput,
                        ));
                        (snapshot, failure, role_sessions)
                    }
                    Err(error) => (None, Some(creation_store_failure(TeamCreationStage::LoadingTeam, &error)), None),
                };
                if let Some(failure) = outcome.1 { reply.creation_failure(failure).await; }
                let _ = reply.send(outcome).await;
            }),
            OrganizationQuery::NodeReviewHistory { team_id, run_id, node_id, query, reply } => boxed(move || async move {
                if !reply.running().await { return; }
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path)
                    .map(|store| crate::application::projection::team_node_review_history(
                        store, &team_id, &run_id, &node_id, &query,
                    ));
                let _ = reply.send(outcome).await;
            }),
            OrganizationQuery::TeamRunDiagnostics { run_id, reply } => boxed(move || async move {
                if !reply.running().await { return; }
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path).map_or(
                    organization::TeamRunDiagnosticsQueryOutcome::Unavailable(
                        organization::TeamRunDiagnosticsUnavailableReason::MissingRun,
                    ),
                    |store| {
                        store.facts().run(&run_id).map_or(
                            organization::TeamRunDiagnosticsQueryOutcome::Unavailable(
                                organization::TeamRunDiagnosticsUnavailableReason::MissingRun,
                            ),
                            |run| {
                                organization::query_team_run_diagnostics(
                                    store.facts(),
                                    run.team(),
                                    &run_id,
                                )
                            },
                        )
                    },
                );
                let _ = reply.send(outcome).await;
            }),
            OrganizationQuery::RuntimeGraphContext { scope, reply } => boxed(move || async move {
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path).and_then(|store| {
                    store.runtime_graph_context(&scope)
                });
                let _ = reply.send(outcome);
            }),
            OrganizationQuery::GraphContext { query, reply } => boxed(move || async move {
                if !reply.running().await { return; }
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path)
                    .map_or(organization::TeamGraphContextResult::Unavailable, |store| {
                        state.team_run.graph_context(&store, &query)
                    });
                let _ = reply.send(outcome).await;
            }),
            OrganizationQuery::GraphDefinition {
                team_id,
                run_id,
                reply,
            } => boxed(move || async move {
                if !reply.running().await { return; }
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path)
                    .ok()
                    .and_then(|store| state.team_run.graph_definition(&store, &team_id, &run_id));
                let _ = reply.send(outcome).await;
            }),
            OrganizationQuery::GraphYaml { run_id, reply } => boxed(move || async move {
                if !reply.running().await { return; }
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path).ok().and_then(|store| {
                    store
                        .facts()
                        .run(&run_id)
                        .map(|run| organization::export_yaml(run.graph().definition()))
                });
                let _ = reply.send(outcome).await;
            }),
            OrganizationQuery::TaskBoardRead {
                team_id,
                run_id,
                reply,
            } => boxed(move || async move {
                if !reply.running().await { return; }
                let outcome = match OrganizationRunLane::open_store(&mut state.store, &state.store_path) {
                    Ok(store) => store.task_board().scoped(&team_id, &run_id),
                    Err(_) => {
                        reply.unavailable().await;
                        organization::run::task_board::TaskBoardFacts::default()
                    }
                };
                let _ = reply.send(outcome).await;
            }),
            OrganizationQuery::PendingApprovals {
                team_id,
                run_id,
                reply,
            } => boxed(move || async move {
                if !reply.running().await { return; }
                let outcome = OrganizationRunLane::open_store(&mut state.store, &state.store_path).map_or(
                    organization::run::TeamPendingApprovalsQueryOutcome::Unavailable,
                    |store| {
                        state
                            .team_run
                            .query_pending_approvals(&store, &team_id, &run_id)
                    },
                );
                let _ = reply.send(outcome).await;
            }),
            OrganizationQuery::NodePromptRetryDue { run_id, reply } => boxed(move || async move {
                if !reply.running().await { return; }
                let query = NodePromptRetryDueQuery::new(run_id, now_millis());
                let outcome = query.map_or(
                    NodePromptRetryDueQueryOutcome::Invalid(
                        NodePromptRetryDueInvalidReason::InvalidFacts,
                    ),
                    |query| {
                        OrganizationRunLane::open_store(&mut state.store, &state.store_path).map_or(
                            NodePromptRetryDueQueryOutcome::Invalid(
                                NodePromptRetryDueInvalidReason::InvalidFacts,
                            ),
                            |store| state.team_run.retry_due(&store, &query),
                        )
                    },
                );
                let _ = reply.send(outcome).await;
            }),
            OrganizationQuery::Resume { team_id, reply } => boxed(move || async move {
                if !reply.running().await { return; }
                let outcome = match OrganizationRunLane::open_store(&mut state.store, &state.store_path) {
                    Ok(store) => state.team_run.resume(store, &team_id),
                    Err(_) => {
                        reply.unavailable().await;
                        Vec::new()
                    }
                };
                let _ = reply.send(outcome).await;
            }),
            OrganizationQuery::TriggerList { team_id: Some(team_id), reply } => boxed(move || async move {
                if !reply.running().await { return; }
                let outcome = match OrganizationRunLane::open_store(&mut state.store, &state.store_path) {
                    Ok(store) => state.team_run.armed_triggers(store, Some(&team_id)),
                    Err(_) => {
                        reply.unavailable().await;
                        Vec::new()
                    }
                };
                let _ = reply.send(outcome).await;
            }),
            OrganizationQuery::WorkflowRunTeam { .. }
            | OrganizationQuery::TeamSkillValidate { .. }
            | OrganizationQuery::TeamSkillDependencyPlan { .. }
            | OrganizationQuery::TeamSkillSelectionValidate { .. }
            | OrganizationQuery::TeamSkillSelectionDependencyPlan { .. }
            | OrganizationQuery::TeamPromptSettings { .. }
            | OrganizationQuery::StartGatePromptPlan { .. }
            | OrganizationQuery::TriggerList { team_id: None, .. }
            | OrganizationQuery::NativeDeliveryByRun { .. }
            | OrganizationQuery::TeamMessageTerminalContext { .. }
            | OrganizationQuery::TeamMessageFileValidation { .. }
            | OrganizationQuery::PendingTeamMessageRepairs { .. }
            | OrganizationQuery::ActiveRunIds { .. }
            | OrganizationQuery::MatchaTerminalTarget { .. } => {
                unreachable!("global organization query routed to run lane")
            }
        };
        execution
    }

    fn handle_global_query(
        shared: Self::Shared,
        state: &mut Self::GlobalState,
        query: Self::Query,
    ) -> impl std::future::Future<Output = ()> + Send {
        let state = state.as_mut();
        let execution: BoxFuture<'_, ()> = match query {
            OrganizationQuery::TeamPromptSettings { reply } => boxed(move || async move {
                if !reply.running().await { return; }
                let outcome = state.refresh().map(|()| state.store.facts().team_prompts().clone())
                    .map_err(crate::TeamPromptSettingsError::Store);
                let _ = reply.send(outcome).await;
            }),
            OrganizationQuery::StartGatePromptPlan {
                lookup,
                inject_prompt,
                resolver,
                trace_id,
                reply,
            } => boxed(move || async move {
                let outcome = with_session_trace(trace_id, async {
                    let outcome = state.refresh().and_then(|()| {
                        crate::application::start_gate_control::prepare_prompt(
                            &mut state.store,
                            &lookup,
                            resolver.as_ref(),
                            inject_prompt,
                        )
                    });
                    match &outcome {
                        Ok(Some(plan)) => {
                            session_trace("runtime.start-gate.prompt", || json!({
                                "outcome": "prepared",
                                "mode": if plan.design { "design" } else { "discussion" },
                                "generationRegistered": plan.design,
                                "designTokenPresent": plan.design,
                            }));
                        }
                        Err(_) => session_trace("runtime.start-gate.prompt", || json!({
                            "outcome": "error", "reason": "store_or_prompt_failed",
                        })),
                        Ok(None) => {}
                    }
                    outcome
                })
                .await;
                let _ = reply.send(outcome);
            }),
            OrganizationQuery::TriggerList { team_id: None, reply } => boxed(move || async move {
                if !reply.running().await { return; }
                let outcome = match state.refresh() {
                    Ok(()) => state
                        .team_run
                        .armed_triggers(&state.store, None),
                    Err(_) => {
                        reply.unavailable().await;
                        Vec::new()
                    }
                };
                let _ = reply.send(outcome).await;
            }),
            OrganizationQuery::NativeDeliveryByRun {
                identity,
                resolver,
                native_run_id,
                reply,
            } => boxed(move || async move {
                let outcome = match state.refresh() {
                    Ok(()) => state
                        .team_run
                        .native_delivery_by_run(&state.store, &identity, &native_run_id, resolver.as_ref())
                        .ok()
                        .flatten(),
                    Err(_) => None,
                };
                let _ = reply.send(outcome);
            }),
            OrganizationQuery::TeamMessageFileValidation { identity, resolver, native_run_id, delivery_context, native_request_id, assistant_texts, reply } => boxed(move || async move {
                let outcome = state.refresh().and_then(|()| state.terminal_settlement.plan_file_validation(
                    &state.store, &state.team_run, &identity, resolver.as_ref(), &native_run_id, delivery_context.as_ref(), native_request_id.as_deref(), &assistant_texts,
                ));
                let _ = reply.send(outcome);
            }),
            OrganizationQuery::TeamMessageTerminalContext {
                identity,
                resolver,
                native_run_id,
                reply,
            } => boxed(move || async move {
                let outcome = match state.refresh() {
                    Ok(()) => state
                        .team_run
                        .native_delivery_by_run(&state.store, &identity, &native_run_id, resolver.as_ref())
                        .ok()
                        .flatten()
                        .and_then(|delivery_id| {
                            let target = state
                                .team_run
                                .native_terminal_target(&state.store, &delivery_id)?;
                            Some(organization::TeamMessageTerminalContext::new(
                                target.graph_run_id().clone(),
                                delivery_id,
                                target.correlation().endpoint_session_id().clone(),
                            ))
                        }),
                    Err(_) => None,
                };
                let _ = reply.send(outcome);
            }),
            OrganizationQuery::PendingTeamMessageRepairs { reply } => boxed(move || async move {
                let _ = reply.send(state.terminal_settlement.has_pending_repairs());
            }),
            OrganizationQuery::ActiveRunIds { reply } => boxed(move || async move {
                let outcome = match state.refresh() {
                    Ok(()) => {
                        let run_ids = state.active_run_ids();
                        let active: BTreeSet<_> = run_ids.iter().collect();
                        shared.schedule_errors.lock()
                            .expect("organization schedule observations poisoned")
                            .retain(|run_id, _| active.contains(run_id));
                        run_ids
                    }
                    Err(error) => {
                        runtime_trace("runtime.team_run.active_runs.refresh.error", || json!({
                            "errorKind": store_fault_label(&error),
                        }));
                        Vec::new()
                    }
                };
                let _ = reply.send(outcome);
            }),
            OrganizationQuery::MatchaTerminalTarget { delivery_id, reply } => boxed(move || async move {
                let outcome = match state.refresh() {
                    Ok(()) => state.native_terminal_target(&delivery_id),
                    Err(_) => None,
                };
                let _ = reply.send(outcome);
            }),
            OrganizationQuery::WorkflowRunTeam { .. }
            | OrganizationQuery::TeamSkillValidate { .. }
            | OrganizationQuery::TeamSkillDependencyPlan { .. }
            | OrganizationQuery::TeamSkillSelectionValidate { .. }
            | OrganizationQuery::TeamSkillSelectionDependencyPlan { .. }
            | OrganizationQuery::Resume { .. }
            | OrganizationQuery::TriggerList { team_id: Some(_), .. }
            | OrganizationQuery::RunList { .. }
            | OrganizationQuery::RoleSessions { .. }
            | OrganizationQuery::RoleSessionReceipts { .. }
            | OrganizationQuery::RunSnapshot { .. }
            | OrganizationQuery::RunWorkspaceBinding { .. }
            | OrganizationQuery::TaskInspect { .. }
            | OrganizationQuery::TeamRunPublicProjection { .. }
            | OrganizationQuery::TeamRunPublicSnapshot { .. }
            | OrganizationQuery::NodeReviewHistory { .. }
            | OrganizationQuery::TeamRunDiagnostics { .. }
            | OrganizationQuery::GraphContext { .. }
            | OrganizationQuery::RuntimeGraphContext { .. }
            | OrganizationQuery::GraphDefinition { .. }
            | OrganizationQuery::GraphYaml { .. }
            | OrganizationQuery::TaskBoardRead { .. }
            | OrganizationQuery::PendingApprovals { .. }
            | OrganizationQuery::NodePromptRetryDue { .. } => {
                unreachable!("run-local organization query routed to global lane")
            }
        };
        execution
    }

    async fn handle_exclusive_query(
        _shared: Self::Shared,
        _state: &mut Self::GlobalState,
        _query: Self::Query,
    ) {
    }
}

pub(super) fn materialization_outcome_label(
    outcome: &organization::MaterializationOperationOutcome,
) -> &'static str {
    match outcome {
        organization::MaterializationOperationOutcome::Confirmed { .. } => "confirmed",
        organization::MaterializationOperationOutcome::Rejected { .. } => "rejected",
        organization::MaterializationOperationOutcome::Accepted { .. } => "accepted",
        organization::MaterializationOperationOutcome::OutcomeUnknown => "outcome_unknown",
    }
}

pub(super) fn runtime_receipt_label(outcome: &RuntimeReceiptOutcome) -> &'static str {
    match outcome {
        RuntimeReceiptOutcome::Installed => "installed",
        RuntimeReceiptOutcome::Rejected => "rejected",
        RuntimeReceiptOutcome::OutcomeUnknown => "outcome_unknown",
        RuntimeReceiptOutcome::Unavailable => "unavailable",
    }
}

pub(super) fn trace_store_result<T>(stage: &'static str, started: Option<Instant>, result: &Result<T, StoreFault>) {
    session_trace(
        stage,
        || json!({"reason": result.as_ref().map_or_else(store_fault_label, |_| "committed"), "elapsedMs": started.map(|started| started.elapsed().as_millis())}),
    );
}

pub(super) fn store_fault_label(error: &StoreFault) -> &'static str {
    match error {
        StoreFault::WriterBusy => "writer_busy",
        StoreFault::Lock(_) => "lock",
        StoreFault::Read(_) => "read",
        StoreFault::Recovery(_) => "recovery",
        StoreFault::Commit(_) => "commit",
        StoreFault::CommitOutcomeUnknown(_) => "commit_outcome_unknown",
        StoreFault::RecoveryRequired => "recovery_required",
        StoreFault::MigrationRequired => "migration_required",
        StoreFault::RecordTooLarge => "record_too_large",
        StoreFault::LogFull => "log_full",
        StoreFault::EpochOverflow => "epoch_overflow",
        StoreFault::CorruptRecord => "corrupt_record",
        StoreFault::UnsupportedSchemaVersion(_) => "unsupported_schema_version",
        StoreFault::InvalidFacts => "invalid_facts",
        StoreFault::Design(_) => "design",
        StoreFault::RuntimeGraph(_) => "runtime_graph",
        StoreFault::GraphPatchInput(_) => "graph_patch_input",
        StoreFault::RuntimeReceipt(_) => "runtime_receipt",
        StoreFault::Evidence(_) => "evidence",
        StoreFault::ActivityTransition(_) => "activity_transition",
        StoreFault::DeliveryRequest(_) => "delivery_request",
        StoreFault::DeliveryReceipt(_) => "delivery_receipt",
        StoreFault::TriggerFire(_) => "trigger_fire",
        StoreFault::TerminalObservation(_) => "terminal_observation",
        StoreFault::NativeRunOutputResolution(_) => "native_run_output_resolution",
        StoreFault::AuthorizedGraphResolution(_) => "authorized_graph_resolution",
        StoreFault::AgentNodeEventResolution(_) => "agent_node_event_resolution",
        StoreFault::GraphPatch(_) => "graph_patch",
        StoreFault::EventLedger(_) => "event_ledger",
        StoreFault::ControlNodeResolution(_) => "control_node_resolution",
        StoreFault::ControlExecution(_) => "control_execution",
        StoreFault::ReadySchedule(_) => "ready_schedule",
        StoreFault::GraphReduce(_) => "graph_reduce",
    }
}

pub(super) fn manual_runtime_receipt_outcome(outcome: RuntimeReceiptOutcome) -> ManualTeamCreateOutcome {
    match outcome {
        RuntimeReceiptOutcome::Installed => ManualTeamCreateOutcome::OutcomeUnknown,
        RuntimeReceiptOutcome::Rejected => ManualTeamCreateOutcome::Rejected,
        RuntimeReceiptOutcome::OutcomeUnknown => ManualTeamCreateOutcome::OutcomeUnknown,
        RuntimeReceiptOutcome::Unavailable => ManualTeamCreateOutcome::Unavailable,
    }
}

pub(super) fn runtime_receipt_failure_reason(outcome: &RuntimeReceiptOutcome) -> TeamCreationFailureReason {
    match outcome {
        RuntimeReceiptOutcome::Installed | RuntimeReceiptOutcome::OutcomeUnknown => TeamCreationFailureReason::OutcomeUnknown,
        RuntimeReceiptOutcome::Rejected => TeamCreationFailureReason::Rejected,
        RuntimeReceiptOutcome::Unavailable => TeamCreationFailureReason::Unavailable,
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::{NativeRunSettled, owner::run_scheduler::schedule_ready_nodes};
    use foundation::execution::OwnedTask;
    use super::super::team_run::TeamDeleteOutcome;
    use std::{
        fs,
        num::NonZeroU32,
        path::PathBuf,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };

    use organization::{
        ActivityFailure, ActivityPhase, BeginCancellationOutcome, DeliveryLedgerSnapshot, EdgeAction, EdgeDefinition, EdgeId,
        ExecutorPolicy, GraphDefinition, GraphEvent, GraphRunFacts, GraphState, IdempotencyKey,
        ManagedAgentReference, MaterializationReceipt, MemberId, NodeDefinition, NodeId,
        OrganizationFacts, RoleAssignment, RoleId, RoleKind, RoleMaterializationReceipt,
        RoleSessionReceipt, RoleSessionRef, RunRuntimeReceipt, RuntimeEndpointReference,
        TeamDefinition, TeamFacts, TeamMember, TeamRevision, TeamRole, WorkAssignment, reduce,
    };

    pub(crate) fn native_cycle_graph(limit: u32) -> GraphState {
        GraphState::initialize(
            GraphDefinition::new(
                "native-cycle",
                "plan",
                GraphRunId::new("run:one"),
                "cycle",
                vec![
                    NodeDefinition::work(
                        NodeId::new("work"),
                        "work",
                        NonZeroU32::new(limit).unwrap(),
                        WorkAssignment::typed(
                            "task",
                            "work prompt",
                            ExecutorPolicy::team_role("leader"),
                            None,
                        ),
                    ),
                    NodeDefinition::review(
                        NodeId::new("review"),
                        "review",
                        NonZeroU32::new(limit).unwrap(),
                        organization::ReviewAssignment::new("leader", "review prompt"),
                    ),
                    NodeDefinition::control(
                        NodeId::new("end"),
                        organization::NodeKind::End,
                        "end",
                        NonZeroU32::new(1).unwrap(),
                    ),
                ],
                vec![
                    EdgeDefinition::new(
                        EdgeId::new("work-review"),
                        NodeId::new("work"),
                        "completed",
                        NodeId::new("review"),
                        "input",
                        EdgeAction::Activate,
                    ),
                    EdgeDefinition::new(
                        EdgeId::new("review-work"),
                        NodeId::new("review"),
                        "rework",
                        NodeId::new("work"),
                        "input",
                        EdgeAction::Rework,
                    ),
                    EdgeDefinition::new(
                        EdgeId::new("review-end"),
                        NodeId::new("review"),
                        "completed",
                        NodeId::new("end"),
                        "input",
                        EdgeAction::Finish,
                    ),
                ],
            )
            .unwrap(),
            1,
        )
    }

    pub(crate) fn claim_native_activity(
        store: &mut OrganizationStore,
        now: u64,
    ) -> (
        organization::ActivityClaim,
        DeliveryId,
        organization::EndpointSessionId,
    ) {
        let owner = TeamRunOwner::new();
        let ids = schedule_ready_nodes(store, GraphRunId::new("run:one"), now).unwrap();
        assert_eq!(ids.len(), 1);
        let TeamRunActivityStart::Claimed { claim, request } = owner
            .claim_agent_activity(store, ids[0].clone(), now + 1)
            .unwrap()
        else {
            panic!("claim");
        };
        (
            claim,
            request.delivery_request().delivery_id.clone(),
            request.binding().endpoint_session_id().clone(),
        )
    }

    pub(crate) fn settle_native_output(
        store: &mut OrganizationStore,
        delivery_id: &DeliveryId,
        status: organization::NativeTerminalStatus,
        text: Option<String>,
        now: u64,
    ) {
        let target = store.native_terminal_target(delivery_id).unwrap();
        TeamRunOwner::new()
            .observe_native_terminal(store, target, status, now)
            .unwrap();
        crate::owner::team_run::resolve_native_settled_output(
            store,
            &GraphRunId::new("run:one"),
            delivery_id,
            NativeRunSettled {
                status,
                final_assistant_text: text,
            },
            now,
        )
        .unwrap();
    }

    fn native_text(decision: &str) -> String {
        format!(
            r#"<team_message>{{"summary":"review feedback","decision":"{decision}"}}</team_message>"#
        )
    }

    #[test]
    fn native_terminal_before_acceptance_is_durable_and_late_acceptance_is_noop() {
        let (temp, mut store) = store_with_graph(native_cycle_graph(2));
        let path = temp.path().join("organization-facts.log");
        let (claim, delivery_id, session) = claim_native_activity(&mut store, 3);
        store
            .accept_native_terminal_context(&delivery_id, session.clone(), "native:one".into())
            .unwrap();
        settle_native_output(
            &mut store,
            &delivery_id,
            organization::NativeTerminalStatus::Completed,
            Some(native_text("completed")),
            5,
        );
        let len = fs::metadata(&path).unwrap().len();
        TeamRunOwner::new()
            .settle_agent_activity_dispatch(
                &mut store,
                claim.clone(),
                ActivityExecutionOutcome::accepted(session.clone(), "native:one".into()),
            )
            .unwrap();
        assert_eq!(fs::metadata(&path).unwrap().len(), len);
        assert!(matches!(
            store
                .facts()
                .activities()
                .activity(claim.activity_id())
                .unwrap()
                .phase(),
            ActivityPhase::Completed { .. }
        ));
        assert!(
            TeamRunOwner::new()
                .settle_agent_activity_dispatch(
                    &mut store,
                    claim,
                    ActivityExecutionOutcome::accepted(session, "native:conflict".into())
                )
                .is_err()
        );
        assert_eq!(fs::metadata(&path).unwrap().len(), len);
        drop(store);
        let store = OrganizationStore::open(&path).unwrap();
        let organization::DeliveryPhase::TerminalObserved { observation } = store
            .facts()
            .deliveries()
            .delivery(&delivery_id)
            .unwrap()
            .phase()
        else {
            panic!("terminal");
        };
        assert_eq!(observation.output().unwrap().summary(), "review feedback");
    }

    #[test]
    fn native_rework_rereview_finish_and_exhaustion_survive_reopen() {
        for exhausted in [false, true] {
            let (temp, mut store) = store_with_graph(native_cycle_graph(2));
            let mut last_delivery = None;
            for (index, decision) in [
                "completed",
                "rework",
                "completed",
                if exhausted { "rework" } else { "completed" },
            ]
            .iter()
            .enumerate()
            {
                let now = 3 + index as u64 * 4;
                let (claim, delivery_id, session) = claim_native_activity(&mut store, now);
                if index == 2 {
                    let organization::ActivityKind::AgentTask { prompt, .. } = &store
                        .facts()
                        .activities()
                        .activity(claim.activity_id())
                        .unwrap()
                        .facts()
                        .activity_kind
                    else {
                        panic!("agent");
                    };
                    assert!(prompt.contains("review feedback"));
                }
                store
                    .accept_native_terminal_context(
                        &delivery_id,
                        session,
                        format!("native:{index}"),
                    )
                    .unwrap();
                settle_native_output(
                    &mut store,
                    &delivery_id,
                    organization::NativeTerminalStatus::Completed,
                    Some(native_text(decision)),
                    now + 2,
                );
                let len = fs::metadata(temp.path().join("organization-facts.log"))
                    .unwrap()
                    .len();
                settle_native_output(
                    &mut store,
                    &delivery_id,
                    organization::NativeTerminalStatus::Completed,
                    Some(native_text(decision)),
                    now + 3,
                );
                assert_eq!(
                    fs::metadata(temp.path().join("organization-facts.log"))
                        .unwrap()
                        .len(),
                    len
                );
                last_delivery = Some((claim.activity_id().clone(), delivery_id));
            }
            if !exhausted {
                assert!(
                    schedule_ready_nodes(
                        &mut store,
                        GraphRunId::new("run:one"),
                        20
                    )
                    .unwrap()
                    .is_empty()
                );
            }
            drop(store);
            let store =
                OrganizationStore::open(temp.path().join("organization-facts.log")).unwrap();
            let organization::run::public_projection::TeamRunPublicSnapshotQueryOutcome::Available(
                snapshot,
            ) = organization::run::public_projection::query_team_run_public_snapshot(
                store.facts(),
                &team_id(),
                &GraphRunId::new("run:one"),
            )
            else {
                panic!("snapshot");
            };
            assert_eq!(
                snapshot
                    .graph()
                    .nodes()
                    .iter()
                    .find(|node| node.node_id() == "review")
                    .unwrap()
                    .status_reason(),
                exhausted.then_some("rework_limit_exceeded")
            );
            let run = store.facts().run(&GraphRunId::new("run:one")).unwrap();
            if !exhausted {
                assert_eq!(
                    run.graph()
                        .current_attempt(&NodeId::new("end"))
                        .unwrap()
                        .status(),
                    organization::AttemptStatus::Completed
                );
                assert!(run.graph().ready_queue().is_empty());
            }
            let review = run.graph().current_attempt(&NodeId::new("review")).unwrap();
            assert_eq!(review.number().get(), 2);
            assert_eq!(
                review.status(),
                if exhausted {
                    organization::AttemptStatus::Failed
                } else {
                    organization::AttemptStatus::Completed
                }
            );
            let (activity_id, delivery_id) = last_delivery.unwrap();
            assert_eq!(
                matches!(
                    store
                        .facts()
                        .activities()
                        .activity(&activity_id)
                        .unwrap()
                        .phase(),
                    ActivityPhase::Failed { .. }
                ),
                exhausted
            );
            let organization::DeliveryPhase::TerminalObserved { observation } = store
                .facts()
                .deliveries()
                .delivery(&delivery_id)
                .unwrap()
                .phase()
            else {
                panic!("terminal");
            };
            assert_eq!(
                observation.native_terminal(),
                organization::NativeTerminalStatus::Completed
            );
            assert_eq!(
                observation.output().unwrap().decision(),
                if exhausted { "rework" } else { "completed" }
            );
            if exhausted {
                assert_eq!(
                    run.graph()
                        .current_attempt(&NodeId::new("end"))
                        .unwrap()
                        .status(),
                    organization::AttemptStatus::Pending
                );
            }
        }
    }

    #[test]
    fn superseded_pending_is_cancelled_but_native_inflight_drains_exact_history() {
        for in_flight in [false, true] {
            let (temp, mut store) =
                store_with_graph(reworkable_review_graph(GraphRunId::new("run:one")));
            let ids = schedule_ready_nodes(
                &mut store,
                GraphRunId::new("run:one"),
                3,
            )
            .unwrap();
            let old = store
                .facts()
                .activities()
                .activity(&ids[0])
                .unwrap()
                .facts()
                .fence
                .clone();
            let delivery_id = if in_flight {
                let TeamRunActivityStart::Claimed { request, .. } = TeamRunOwner::new()
                    .claim_agent_activity(&mut store, ids[0].clone(), 4)
                    .unwrap()
                else {
                    panic!("claim");
                };
                let delivery_id = request.delivery_request().delivery_id.clone();
                store
                    .accept_native_terminal_context(
                        &delivery_id,
                        request.binding().endpoint_session_id().clone(),
                        "native:old".into(),
                    )
                    .unwrap();
                Some(delivery_id)
            } else {
                None
            };
            store
                .apply_graph_event(
                    &GraphRunId::new("run:one"),
                    GraphEvent::ReworkRequested {
                        node_id: NodeId::new("review"),
                        requested_at: 5,
                    },
                )
                .unwrap();
            let current = store
                .facts()
                .run(&GraphRunId::new("run:one"))
                .unwrap()
                .graph()
                .current_attempt(&NodeId::new("review"))
                .unwrap()
                .clone();
            if let Some(delivery_id) = delivery_id {
                assert!(matches!(
                    store
                        .facts()
                        .activities()
                        .activity(&ids[0])
                        .unwrap()
                        .phase(),
                    ActivityPhase::Dispatched(_)
                ));
                assert!(
                    schedule_ready_nodes(
                        &mut store,
                        GraphRunId::new("run:one"),
                        6
                    )
                    .unwrap()
                    .is_empty()
                );
                settle_native_output(
                    &mut store,
                    &delivery_id,
                    organization::NativeTerminalStatus::Completed,
                    Some(native_text("rework")),
                    7,
                );
                let graph = store
                    .facts()
                    .run(&GraphRunId::new("run:one"))
                    .unwrap()
                    .graph();
                assert_eq!(
                    graph.current_attempt(&NodeId::new("review")).unwrap(),
                    &current
                );
                assert_eq!(
                    graph.executions()[&NodeId::new("review")]
                        .attempts()
                        .iter()
                        .find(|attempt| attempt.fence() == &old)
                        .unwrap()
                        .status(),
                    organization::AttemptStatus::Completed
                );
            } else {
                assert!(matches!(
                    store
                        .facts()
                        .activities()
                        .activity(&ids[0])
                        .unwrap()
                        .phase(),
                    ActivityPhase::Cancelled { .. }
                ));
                assert!(!matches!(
                    store.claim_activity(&ids[0], 6).unwrap(),
                    organization::ActivityClaimOutcome::Claimed(_)
                ));
            }
            let new_ids = schedule_ready_nodes(
                &mut store,
                GraphRunId::new("run:one"),
                8,
            )
            .unwrap();
            assert_eq!(new_ids.len(), 1);
            assert_ne!(new_ids[0], ids[0]);
            drop(store);
            OrganizationStore::open(temp.path().join("organization-facts.log")).unwrap();
        }
    }

    #[test]
    fn unknown_dispatch_then_textless_native_failure_drains_activity() {
        for status in [
            organization::NativeTerminalStatus::Failed,
            organization::NativeTerminalStatus::Interrupted,
            organization::NativeTerminalStatus::Cancelled,
        ] {
            let (temp, mut store) = store_with_graph(native_cycle_graph(2));
            let (claim, delivery_id, session) = claim_native_activity(&mut store, 3);
            TeamRunOwner::new()
                .settle_agent_activity_dispatch(
                    &mut store,
                    claim.clone(),
                    ActivityExecutionOutcome::Unknown,
                )
                .unwrap();
            store
                .accept_native_terminal_context(&delivery_id, session, "native:one".into())
                .unwrap();
            crate::owner::team_run::resolve_native_settled_output(
                &mut store,
                &GraphRunId::new("run:one"),
                &delivery_id,
                NativeRunSettled { status, final_assistant_text: None },
                5,
            )
            .unwrap();
            drop(store);
            let store =
                OrganizationStore::open(temp.path().join("organization-facts.log")).unwrap();
            assert!(matches!(
                store
                    .facts()
                    .activities()
                    .activity(claim.activity_id())
                    .unwrap()
                    .phase(),
                ActivityPhase::Failed { .. } | ActivityPhase::Cancelled { .. }
            ));
            let organization::DeliveryPhase::TerminalObserved { observation } = store
                .facts()
                .deliveries()
                .delivery(&delivery_id)
                .unwrap()
                .phase()
            else {
                panic!("terminal");
            };
            assert!(observation.output().is_none());
        }
    }

    #[test]
    fn scheduler_registers_downstream_ready_work_activity() {
        let graph = downstream_work_graph();
        let downstream_fence = graph
            .current_attempt(&NodeId::new("downstream"))
            .unwrap()
            .fence()
            .clone();
        let (_temp_dir, mut store) = store_with_graph(graph);
        let activity_ids = schedule_ready_nodes(
            &mut store,
            GraphRunId::new("run:one"),
            3,
        )
        .unwrap();

        assert_eq!(activity_ids.len(), 1);
        let activity = store
            .facts()
            .activities()
            .activity(&activity_ids[0])
            .unwrap();
        assert_eq!(activity.facts().node_id.as_str(), "downstream");
        assert_eq!(
            activity.facts().node_execution_id,
            *downstream_fence.node_execution_id()
        );
        assert!(matches!(activity.phase(), ActivityPhase::Pending));
        assert!(
            schedule_ready_nodes(
                &mut store,
                GraphRunId::new("run:one"),
                4,
            )
            .unwrap()
            .is_empty()
        );
        assert_eq!(store.facts().activities().activities().count(), 1);
    }

    #[test]
    fn scheduler_reserves_review_local_session_for_the_same_wave() {
        let graph = review_and_work_graph();
        let review_fence = graph
            .current_attempt(&NodeId::new("review"))
            .unwrap()
            .fence()
            .clone();
        let (_temp_dir, mut store) = store_with_graph(graph);
        let activity_ids = schedule_ready_nodes(
            &mut store,
            GraphRunId::new("run:one"),
            3,
        )
        .unwrap();

        assert_eq!(activity_ids.len(), 1);
        let activities = store.facts().activities().activities().collect::<Vec<_>>();
        assert_eq!(activities.len(), 1);
        let activity = activities[0];
        assert_eq!(activity.facts().node_id.as_str(), "review");
        assert_eq!(
            activity.facts().node_execution_id,
            *review_fence.node_execution_id()
        );
        assert!(matches!(activity.phase(), ActivityPhase::Pending));
    }

    #[test]
    fn scheduler_reuses_the_same_role_binding_after_terminal_activity() {
        let graph = same_role_work_graph(GraphRunId::new("run:one"));
        let (_temp_dir, mut store) = store_with_graph(graph);
        let first = schedule_ready_nodes(
            &mut store,
            GraphRunId::new("run:one"),
            3,
        )
        .unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(
            store
                .facts()
                .activities()
                .activity(&first[0])
                .unwrap()
                .facts()
                .node_id
                .as_str(),
            "node-a"
        );
        let organization::ActivityClaimOutcome::Claimed(claim) =
            store.claim_activity(&first[0], 4).unwrap()
        else {
            panic!("first activity must be claimable");
        };
        store.dispatch_activity(&claim, 4).unwrap();
        store
            .settle_activity(
                &claim,
                organization::ActivitySettlement::Completed { completed_at: 5 },
            )
            .unwrap();
        let fence = store
            .facts()
            .run(&GraphRunId::new("run:one"))
            .unwrap()
            .graph()
            .current_attempt(&NodeId::new("node-a"))
            .unwrap()
            .fence()
            .clone();
        store
            .apply_graph_event(
                &GraphRunId::new("run:one"),
                GraphEvent::NodeCompleted {
                    node_id: NodeId::new("node-a"),
                    fence,
                    output_port: "completed".to_owned(),
                    completed_at: 5,
                },
            )
            .unwrap();

        let second = schedule_ready_nodes(
            &mut store,
            GraphRunId::new("run:one"),
            6,
        )
        .unwrap();

        assert_eq!(second.len(), 1);
        let activity = store.facts().activities().activity(&second[0]).unwrap();
        assert_eq!(activity.facts().node_id.as_str(), "node-c");
        assert_eq!(activity.facts().target.as_str(), "rs0");
    }

    #[test]
    fn scheduler_allows_different_role_bindings_in_the_same_wave() {
        let graph = leader_and_reviewer_graph(GraphRunId::new("run:one"));
        let temp_dir = tempfile::tempdir().unwrap();
        let mut store =
            OrganizationStore::open(temp_dir.path().join("organization-facts.log")).unwrap();
        store
            .replace_facts(two_role_facts(vec![(
                graph,
                two_role_runtime_receipt(GraphRunId::new("run:one")),
            )]))
            .unwrap();
        let activity_ids = schedule_ready_nodes(
            &mut store,
            GraphRunId::new("run:one"),
            3,
        )
        .unwrap();

        assert_eq!(activity_ids.len(), 2);
        let mut activities = store.facts().activities().activities().collect::<Vec<_>>();
        activities.sort_by(|left, right| left.facts().node_id.cmp(&right.facts().node_id));
        assert_eq!(activities[0].facts().node_id.as_str(), "leader-work");
        assert_eq!(activities[0].facts().target.as_str(), "rs0");
        assert_eq!(activities[1].facts().node_id.as_str(), "reviewer-work");
        assert_eq!(activities[1].facts().target.as_str(), "rs0");
        assert!(
            activities
                .iter()
                .all(|activity| matches!(activity.phase(), ActivityPhase::Pending))
        );
    }

    #[test]
    fn scheduler_namespaces_activity_identity_by_run() {
        let run_one = GraphRunId::new("run:one");
        let run_two = GraphRunId::new("run:two");
        let (_temp_dir, mut store) = store_with_runs(vec![
            (
                single_work_graph(run_one.clone()),
                runtime_receipt_for(run_one.clone()),
            ),
            (
                single_work_graph(run_two.clone()),
                runtime_receipt_for(run_two.clone()),
            ),
        ]);

        let first = schedule_ready_nodes(&mut store, run_one, 3).unwrap();
        let second = schedule_ready_nodes(&mut store, run_two, 4).unwrap();

        assert_eq!(first.len(), 1);
        assert_eq!(second.len(), 1);
        assert_ne!(first[0], second[0]);
        let activities = store.facts().activities().activities().collect::<Vec<_>>();
        assert_eq!(activities.len(), 2);
        assert!(
            activities
                .iter()
                .any(|activity| activity.facts().run_id.as_str() == "run:one")
        );
        assert!(
            activities
                .iter()
                .any(|activity| activity.facts().run_id.as_str() == "run:two")
        );
    }

    #[test]
    fn scheduler_namespaces_review_rework_activity_identity_by_attempt() {
        let mut graph = reworkable_review_graph(GraphRunId::new("run:one"));
        let first_fence = graph
            .current_attempt(&NodeId::new("review"))
            .unwrap()
            .fence()
            .clone();
        let (_temp_dir, mut store) = store_with_graph(graph.clone());
        let first = schedule_ready_nodes(
            &mut store,
            GraphRunId::new("run:one"),
            3,
        )
        .unwrap();
        let organization::ActivityClaimOutcome::Claimed(claim) =
            store.claim_activity(&first[0], 4).unwrap()
        else {
            panic!("first review activity must be claimable");
        };
        store.dispatch_activity(&claim, 4).unwrap();
        store
            .settle_activity(
                &claim,
                organization::ActivitySettlement::Failed {
                    failed_at: 5,
                    failure: ActivityFailure::Rejected,
                },
            )
            .unwrap();
        let rework = GraphEvent::ReworkRequested {
            node_id: NodeId::new("review"),
            requested_at: 6,
        };
        graph = reduce(graph, rework.clone()).unwrap();
        let second_fence = graph
            .current_attempt(&NodeId::new("review"))
            .unwrap()
            .fence()
            .clone();
        store
            .apply_graph_event(&GraphRunId::new("run:one"), rework)
            .unwrap();

        let second = schedule_ready_nodes(
            &mut store,
            GraphRunId::new("run:one"),
            7,
        )
        .unwrap();

        assert_eq!(second.len(), 1);
        assert_ne!(first[0], second[0]);
        assert_ne!(first_fence.attempt_id(), second_fence.attempt_id());
        let activities = store.facts().activities().activities().collect::<Vec<_>>();
        assert_eq!(activities.len(), 2);
        assert!(activities.iter().any(|activity| {
            activity.facts().node_execution_id == *second_fence.node_execution_id()
        }));
    }

    #[tokio::test]
    async fn team_skill_materialize_rejects_missing_required_dependencies_before_native_effect() {
        let root = package_root("missing-required-dependency");
        let temp_dir = tempfile::tempdir().unwrap();
        let selections = temp_dir.path().join("team-skill-selections.json");
        let store = store_without_team_materialization().1;
        let mut selections = TeamSkillSelectionResolver::open(selections).unwrap();
        let selection_id = selections.authorize(&root).unwrap();
        let driver = Arc::new(FixedTeamDriver::new(
            organization::MaterializationOperationOutcome::OutcomeUnknown,
        ));
        let mut system = foundation::execution::OwnerRuntimeSystem::spawn(Default::default());
        let (module, mut owner) = crate::spawn_owner(&system, crate::OrganizationOwnerInput {
            store,
            runtime_directory: Arc::new(FixedRuntimeDirectory { driver: driver.clone() }),
            member_introductions: None,
            team_skill_selections: selections,
        });

        assert_eq!(
            module.handle().team_skill_materialize(
                selection_id,
                RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap(),
                None,
                team_id(),
                idempotency_key("team-skill:materialize"),
            ).await.unwrap(),
            TeamMaterializationCommandOutcome::Rejected,
        );
        let _ = owner.cancel_and_join().await;
        let _ = system.cancel_and_join().await;
        assert_eq!(driver.materialize_count(), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn team_delete_repeated_after_cleanup_unknown_remains_unknown_without_native_replay() {
        let (temp_dir, store) = store_with_team_materialization(openclaw_materialization_receipt());
        let driver = Arc::new(FixedTeamDriver::new(
            organization::MaterializationOperationOutcome::OutcomeUnknown,
        ));
        let mut running = running_organization(temp_dir, store, driver.clone());

        assert_eq!(
            running
                .handle
                .team_delete(team_id(), idempotency_key("team-delete:team:one"), 1)
                .await
                .unwrap(),
            Ok(TeamDeleteOutcome::OutcomeUnknown)
        );
        wait_for(|| driver.remove_count() == 1).await;
        assert_eq!(
            running
                .handle
                .team_delete(team_id(), idempotency_key("team-delete:team:one"), 2)
                .await
                .unwrap(),
            Ok(TeamDeleteOutcome::OutcomeUnknown)
        );
        assert_eq!(driver.remove_count(), 1);
        running.shutdown().await;
    }

    #[tokio::test]
    async fn team_delete_settles_cancelled_run_before_materialization_cleanup() {
        let receipt = openclaw_materialization_receipt();
        let (temp_dir, mut store) =
            store_with_openclaw_run(single_work_graph(GraphRunId::new("run:one")));
        let started = store
            .begin_graph_run_cancellation(&GraphRunId::new("run:one"), "run-cancel:one", 1)
            .unwrap();
        assert!(matches!(started, BeginCancellationOutcome::Started(_)));
        assert_eq!(
            store.settle_graph_run_cancellation(
                &GraphRunId::new("run:one"),
                "run-cancel:one",
                RoleAbortOutcome::Confirmed,
                2
            ),
            Ok(organization::SettleCancellationOutcome::Cancelled)
        );
        let driver = Arc::new(
            FixedTeamDriver::new(organization::MaterializationOperationOutcome::Confirmed {
                receipt,
            })
            .with_delete_evidence(confirmed_deletion_evidence_for(GraphRunId::new("run:one"))),
        );
        let mut running = running_organization(temp_dir, store, driver.clone());
        let facts_path = running.facts_path();

        assert_eq!(
            running
                .handle
                .team_delete(team_id(), idempotency_key("team-delete:team:one"), 3)
                .await
                .unwrap(),
            Ok(TeamDeleteOutcome::OutcomeUnknown)
        );
        wait_for_store(&facts_path, |store| {
            store.facts().run(&GraphRunId::new("run:one")).is_none()
                && store.team_materialization_cleanup_confirmed(&team_id())
        })
        .await;
        assert_eq!(driver.delete_count(), 1);
        assert_eq!(driver.remove_count(), 1);
        running.shutdown().await;
    }

    #[tokio::test]
    async fn team_delete_same_key_unknown_run_remains_unknown_without_native_replay() {
        let receipt = openclaw_materialization_receipt();
        let (temp_dir, mut store) =
            store_with_openclaw_run(single_work_graph(GraphRunId::new("run:one")));
        let started = store
            .begin_graph_run_cancellation(&GraphRunId::new("run:one"), "team-delete:team:one", 1)
            .unwrap();
        assert!(matches!(started, BeginCancellationOutcome::Started(_)));
        assert_eq!(
            store.settle_graph_run_cancellation(
                &GraphRunId::new("run:one"),
                "team-delete:team:one",
                RoleAbortOutcome::OutcomeUnknown,
                2,
            ),
            Ok(organization::SettleCancellationOutcome::OutcomeUnknown)
        );
        let driver = Arc::new(
            FixedTeamDriver::new(organization::MaterializationOperationOutcome::Confirmed {
                receipt,
            })
            .with_delete_evidence(confirmed_deletion_evidence_for(GraphRunId::new("run:one"))),
        );
        let mut running = running_organization(temp_dir, store, driver.clone());
        let facts_path = running.facts_path();

        assert_eq!(
            running
                .handle
                .team_delete(team_id(), idempotency_key("team-delete:team:one"), 3)
                .await
                .unwrap(),
            Ok(TeamDeleteOutcome::OutcomeUnknown)
        );
        assert_eq!(driver.delete_count(), 0);
        assert_eq!(driver.remove_count(), 0);
        let store = OrganizationStore::open(&facts_path).unwrap();
        assert!(matches!(
            store
                .facts()
                .run(&GraphRunId::new("run:one"))
                .unwrap()
                .lifecycle()
                .state(),
            GraphRunLifecycleState::OutcomeUnknown { .. }
        ));
        running.shutdown().await;
    }

    #[tokio::test]
    async fn team_delete_confirmed_cleanup_replays_deleted_without_second_native_remove() {
        let receipt = openclaw_materialization_receipt();
        let (temp_dir, store) = store_with_team_materialization(receipt.clone());
        let driver = Arc::new(FixedTeamDriver::new(
            organization::MaterializationOperationOutcome::Confirmed { receipt },
        ));
        let mut running = running_organization(temp_dir, store, driver.clone());
        let facts_path = running.facts_path();

        assert_eq!(
            running
                .handle
                .team_delete(team_id(), idempotency_key("team-delete:team:one"), 1)
                .await
                .unwrap(),
            Ok(TeamDeleteOutcome::OutcomeUnknown)
        );
        wait_for_store(&facts_path, |store| {
            store.team_materialization_cleanup_confirmed(&team_id())
        })
        .await;
        assert_eq!(
            running
                .handle
                .team_delete(team_id(), idempotency_key("team-delete:team:one"), 2)
                .await
                .unwrap(),
            Ok(TeamDeleteOutcome::Deleted)
        );
        assert_eq!(driver.remove_count(), 1);
        running.shutdown().await;
    }

    #[tokio::test]
    async fn team_delete_without_materialization_tombstones_without_native_remove() {
        let (temp_dir, store) = store_without_team_materialization();
        let driver = Arc::new(FixedTeamDriver::new(
            organization::MaterializationOperationOutcome::OutcomeUnknown,
        ));
        let mut running = running_organization(temp_dir, store, driver.clone());

        assert_eq!(
            running
                .handle
                .team_delete(team_id(), idempotency_key("team-delete:team:one"), 1)
                .await
                .unwrap(),
            Ok(TeamDeleteOutcome::Deleted)
        );
        let store = OrganizationStore::open(running.facts_path()).unwrap();
        assert!(store.facts().team(&team_id()).unwrap().tombstoned());
        assert_eq!(driver.remove_count(), 0);
        running.shutdown().await;
    }

    #[tokio::test]
    async fn team_delete_unknown_local_team_deletes_without_native_remove() {
        let temp_dir = tempfile::tempdir().unwrap();
        let store =
            OrganizationStore::open(temp_dir.path().join("organization-facts.log")).unwrap();
        let driver = Arc::new(FixedTeamDriver::new(
            organization::MaterializationOperationOutcome::OutcomeUnknown,
        ));
        let mut running = running_organization(temp_dir, store, driver.clone());

        assert_eq!(
            running
                .handle
                .team_delete(team_id(), idempotency_key("team-delete:team:one"), 1)
                .await
                .unwrap(),
            Ok(TeamDeleteOutcome::Deleted)
        );
        assert_eq!(driver.remove_count(), 0);
        running.shutdown().await;
    }

    fn downstream_work_graph() -> GraphState {
        let mut graph = GraphState::initialize(
            GraphDefinition::new(
                "graph:downstream-work",
                "plan:downstream-work",
                GraphRunId::new("run:one"),
                "downstream work",
                vec![
                    work_node("upstream", "task:upstream", "upstream prompt"),
                    work_node("downstream", "task:downstream", "downstream prompt"),
                ],
                vec![EdgeDefinition::new(
                    EdgeId::new("edge:upstream-downstream"),
                    NodeId::new("upstream"),
                    "completed",
                    NodeId::new("downstream"),
                    "input",
                    EdgeAction::Activate,
                )],
            )
            .unwrap(),
            1,
        );
        let fence = graph
            .current_attempt(&NodeId::new("upstream"))
            .unwrap()
            .fence()
            .clone();
        graph = reduce(
            graph,
            GraphEvent::NodeCompleted {
                node_id: NodeId::new("upstream"),
                fence,
                output_port: "completed".to_owned(),
                completed_at: 2,
            },
        )
        .unwrap();
        graph
    }

    fn review_and_work_graph() -> GraphState {
        GraphState::initialize(
            GraphDefinition::new(
                "graph:review-work",
                "plan:review-work",
                GraphRunId::new("run:one"),
                "review work",
                vec![
                    NodeDefinition::review(
                        NodeId::new("review"),
                        "review",
                        NonZeroU32::new(1).unwrap(),
                        organization::ReviewAssignment::new("leader", "review prompt"),
                    ),
                    work_node("work", "task:work", "work prompt"),
                ],
                Vec::new(),
            )
            .unwrap(),
            1,
        )
    }

    fn single_work_graph(run_id: GraphRunId) -> GraphState {
        GraphState::initialize(
            GraphDefinition::new(
                format!("graph:{}", run_id.as_str()),
                "plan:single-work",
                run_id,
                "single work",
                vec![work_node("work", "task:work", "work prompt")],
                Vec::new(),
            )
            .unwrap(),
            1,
        )
    }

    fn same_role_work_graph(run_id: GraphRunId) -> GraphState {
        GraphState::initialize(
            GraphDefinition::new(
                format!("graph:{}", run_id.as_str()),
                "plan:same-role-work",
                run_id,
                "same role work",
                vec![
                    work_node("node-a", "task:a", "a prompt"),
                    work_node("node-c", "task:c", "c prompt"),
                ],
                vec![EdgeDefinition::new(
                    EdgeId::new("edge:a-c"),
                    NodeId::new("node-a"),
                    "completed",
                    NodeId::new("node-c"),
                    "input",
                    EdgeAction::Activate,
                )],
            )
            .unwrap(),
            1,
        )
    }

    fn leader_and_reviewer_graph(run_id: GraphRunId) -> GraphState {
        GraphState::initialize(
            GraphDefinition::new(
                format!("graph:{}", run_id.as_str()),
                "plan:two-role-work",
                run_id,
                "two role work",
                vec![
                    work_node("leader-work", "task:leader", "leader prompt"),
                    NodeDefinition::work(
                        NodeId::new("reviewer-work"),
                        "reviewer-work",
                        NonZeroU32::new(1).unwrap(),
                        WorkAssignment::typed(
                            "task:reviewer",
                            "reviewer prompt",
                            ExecutorPolicy::team_role("reviewer"),
                            None,
                        ),
                    ),
                ],
                Vec::new(),
            )
            .unwrap(),
            1,
        )
    }

    fn reworkable_review_graph(run_id: GraphRunId) -> GraphState {
        GraphState::initialize(
            GraphDefinition::new(
                format!("graph:{}", run_id.as_str()),
                "plan:rework-review",
                run_id,
                "review rework",
                vec![NodeDefinition::review(
                    NodeId::new("review"),
                    "review",
                    NonZeroU32::new(2).unwrap(),
                    organization::ReviewAssignment::new("leader", "review prompt"),
                )],
                Vec::new(),
            )
            .unwrap(),
            1,
        )
    }

    fn work_node(id: &str, task_id: &str, prompt: &str) -> NodeDefinition {
        NodeDefinition::work(
            NodeId::new(id),
            id,
            NonZeroU32::new(1).unwrap(),
            WorkAssignment::typed(
                task_id,
                prompt,
                ExecutorPolicy::team_role("leader"),
                None,
            ),
        )
    }

    pub(crate) fn store_with_graph(graph: GraphState) -> (tempfile::TempDir, OrganizationStore) {
        store_with_runs(vec![(graph, runtime_receipt())])
    }

    fn package_root(name: &str) -> PathBuf {
        static NEXT_PACKAGE_ROOT: AtomicUsize = AtomicUsize::new(0);
        let sequence = NEXT_PACKAGE_ROOT.fetch_add(1, Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!(
            "matchaclaw-team-skill-{name}-{}-{sequence}",
            std::process::id(),
        ));
        fs::create_dir_all(root.join("roles")).unwrap();
        fs::write(root.join("SKILL.md"), "---\nname: research\nversion: 1.0.0\ndescription: Research package\nkind: team-skill\nroles:\n  - id: researcher\n    purpose: Research facts\n---\n# Research\n").unwrap();
        fs::write(root.join("workflow.md"), "# Workflow").unwrap();
        fs::write(root.join("dependencies.yaml"), "skills:\n  - name: web\n    required: true\n    purpose: Search\n    source: clawhub:web\n").unwrap();
        fs::write(root.join("roles/researcher.md"), "# Researcher").unwrap();
        root
    }

    fn store_with_runs(
        runs: Vec<(GraphState, RunRuntimeReceipt)>,
    ) -> (tempfile::TempDir, OrganizationStore) {
        let temp_dir = tempfile::tempdir().unwrap();
        let mut store =
            OrganizationStore::open(temp_dir.path().join("organization-facts.log")).unwrap();
        store.replace_facts(facts_with_runs(runs)).unwrap();
        (temp_dir, store)
    }

    fn store_with_openclaw_run(graph: GraphState) -> (tempfile::TempDir, OrganizationStore) {
        let temp_dir = tempfile::tempdir().unwrap();
        let mut store =
            OrganizationStore::open(temp_dir.path().join("organization-facts.log")).unwrap();
        store
            .replace_facts(
                OrganizationFacts::restore(
                    [TeamFacts::new(
                        team_definition(),
                        TeamRevision::initial(),
                        false,
                    )],
                    [openclaw_materialization_receipt()],
                    [GraphRunFacts::new(
                        team_id(),
                        TeamRevision::initial(),
                        graph,
                        Some(openclaw_runtime_receipt(GraphRunId::new("run:one"))),
                    )
                    .unwrap()],
                    DeliveryLedgerSnapshot::new(Vec::new()),
                )
                .unwrap(),
            )
            .unwrap();
        (temp_dir, store)
    }

    fn store_with_team_materialization(
        receipt: MaterializationReceipt,
    ) -> (tempfile::TempDir, OrganizationStore) {
        let temp_dir = tempfile::tempdir().unwrap();
        let mut store =
            OrganizationStore::open(temp_dir.path().join("organization-facts.log")).unwrap();
        store
            .replace_facts(
                OrganizationFacts::restore(
                    [TeamFacts::new(
                        team_definition(),
                        TeamRevision::initial(),
                        false,
                    )],
                    [receipt],
                    [],
                    DeliveryLedgerSnapshot::new(Vec::new()),
                )
                .unwrap(),
            )
            .unwrap();
        (temp_dir, store)
    }

    fn store_without_team_materialization() -> (tempfile::TempDir, OrganizationStore) {
        let temp_dir = tempfile::tempdir().unwrap();
        let mut store =
            OrganizationStore::open(temp_dir.path().join("organization-facts.log")).unwrap();
        store
            .replace_facts(
                OrganizationFacts::restore(
                    [TeamFacts::new(
                        team_definition(),
                        TeamRevision::initial(),
                        false,
                    )],
                    [],
                    [],
                    DeliveryLedgerSnapshot::new(Vec::new()),
                )
                .unwrap(),
            )
            .unwrap();
        (temp_dir, store)
    }

    struct RunningOrganization {
        _temp_dir: tempfile::TempDir,
        facts_path: PathBuf,
        system: foundation::execution::OwnerRuntimeSystem,
        owner: OwnedTask<()>,
        handle: crate::OrganizationHandle,
    }

    impl RunningOrganization {
        fn facts_path(&self) -> PathBuf {
            self.facts_path.clone()
        }

        async fn shutdown(&mut self) {
            let _ = self.owner.cancel_and_join().await;
            let _ = self.system.cancel_and_join().await;
        }
    }

    fn running_organization(
        temp_dir: tempfile::TempDir,
        store: OrganizationStore,
        driver: Arc<FixedTeamDriver>,
    ) -> RunningOrganization {
        let facts_path = store.path().to_owned();
        let system = foundation::execution::OwnerRuntimeSystem::spawn(Default::default());
        let (module, owner) = crate::spawn_owner(
            &system,
            crate::OrganizationOwnerInput {
                store,
                runtime_directory: Arc::new(FixedRuntimeDirectory { driver }),
                member_introductions: None,
                team_skill_selections: TeamSkillSelectionResolver::open(
                    temp_dir.path().join("team-skill-selections.json"),
                )
                .unwrap(),
            },
        );
        RunningOrganization {
            _temp_dir: temp_dir,
            facts_path,
            system,
            owner,
            handle: module.handle().clone(),
        }
    }

    async fn wait_for(mut done: impl FnMut() -> bool) {
        for _ in 0..100 {
            if done() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(done());
    }

    async fn wait_for_store(path: &std::path::Path, done: impl Fn(&OrganizationStore) -> bool) {
        wait_for(|| {
            OrganizationStore::open(path)
                .map(|store| done(&store))
                .unwrap_or(false)
        })
        .await;
    }

    fn started_run_facts(
        team: TeamId,
        graph: GraphState,
        runtime: RunRuntimeReceipt,
    ) -> GraphRunFacts {
        GraphRunFacts::with_lifecycle_and_start_gate(
            team,
            TeamRevision::initial(),
            graph,
            Some(runtime),
            organization::GraphRunLifecycle::active(),
            organization::RunStartGate::Started,
        )
        .unwrap()
    }

    fn facts_with_graph(graph: GraphState) -> OrganizationFacts {
        facts_with_runs(vec![(graph, runtime_receipt())])
    }

    fn facts_with_runs(runs: Vec<(GraphState, RunRuntimeReceipt)>) -> OrganizationFacts {
        facts_with_deliveries(runs, DeliveryLedgerSnapshot::new(Vec::new()))
    }

    fn facts_with_deliveries(
        runs: Vec<(GraphState, RunRuntimeReceipt)>,
        deliveries: DeliveryLedgerSnapshot,
    ) -> OrganizationFacts {
        let materialization = materialization_receipt();
        OrganizationFacts::restore(
            [TeamFacts::new(
                team_definition(),
                TeamRevision::initial(),
                false,
            )],
            [materialization],
            runs.into_iter()
                .map(|(graph, runtime)| started_run_facts(team_id(), graph, runtime))
                .collect::<Vec<_>>(),
            deliveries,
        )
        .unwrap()
    }

    fn two_role_facts(runs: Vec<(GraphState, RunRuntimeReceipt)>) -> OrganizationFacts {
        OrganizationFacts::restore(
            [TeamFacts::new(
                two_role_team_definition(),
                TeamRevision::initial(),
                false,
            )],
            [two_role_materialization_receipt()],
            runs.into_iter()
                .map(|(graph, runtime)| started_run_facts(team_id(), graph, runtime))
                .collect::<Vec<_>>(),
            DeliveryLedgerSnapshot::new(Vec::new()),
        )
        .unwrap()
    }

    fn team_definition() -> TeamDefinition {
        let member_id = MemberId::try_new("member:leader").unwrap();
        let role_id = RoleId::try_new("leader").unwrap();
        TeamDefinition::try_new(
            team_id(),
            "Team",
            vec![TeamMember::try_new(member_id.clone(), "Leader").unwrap()],
            vec![TeamRole::try_new(role_id.clone(), "Leader", RoleKind::Leader).unwrap()],
            vec![RoleAssignment::new(member_id, role_id)],
        )
        .unwrap()
    }

    fn two_role_team_definition() -> TeamDefinition {
        let leader_member = MemberId::try_new("member:leader").unwrap();
        let reviewer_member = MemberId::try_new("member:reviewer").unwrap();
        let leader_role = RoleId::try_new("leader").unwrap();
        let reviewer_role = RoleId::try_new("reviewer").unwrap();
        TeamDefinition::try_new(
            team_id(),
            "Team",
            vec![
                TeamMember::try_new(leader_member.clone(), "Leader").unwrap(),
                TeamMember::try_new(reviewer_member.clone(), "Reviewer").unwrap(),
            ],
            vec![
                TeamRole::try_new(leader_role.clone(), "Leader", RoleKind::Leader).unwrap(),
                TeamRole::try_new(reviewer_role.clone(), "Reviewer", RoleKind::Member).unwrap(),
            ],
            vec![
                RoleAssignment::new(leader_member, leader_role),
                RoleAssignment::new(reviewer_member, reviewer_role),
            ],
        )
        .unwrap()
    }

    fn materialization_receipt() -> MaterializationReceipt {
        MaterializationReceipt::try_new(
            team_id(),
            RuntimeEndpointReference::try_new("endpoint:one").unwrap(),
            vec![RoleMaterializationReceipt::new(
                RoleId::try_new("leader").unwrap(),
                ManagedAgentReference::try_new("agent:leader").unwrap(),
                RuntimeEndpointReference::try_new("endpoint:one").unwrap(),
            )],
        )
        .unwrap()
    }

    fn openclaw_materialization_receipt() -> MaterializationReceipt {
        MaterializationReceipt::try_new(
            team_id(),
            RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap(),
            vec![RoleMaterializationReceipt::new(
                RoleId::try_new("leader").unwrap(),
                ManagedAgentReference::try_new("agent:leader").unwrap(),
                RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap(),
            )],
        )
        .unwrap()
    }

    fn two_role_materialization_receipt() -> MaterializationReceipt {
        MaterializationReceipt::try_new(
            team_id(),
            RuntimeEndpointReference::try_new("endpoint:one").unwrap(),
            vec![
                RoleMaterializationReceipt::new(
                    RoleId::try_new("leader").unwrap(),
                    ManagedAgentReference::try_new("agent:leader").unwrap(),
                    RuntimeEndpointReference::try_new("endpoint:one").unwrap(),
                ),
                RoleMaterializationReceipt::new(
                    RoleId::try_new("reviewer").unwrap(),
                    ManagedAgentReference::try_new("agent:reviewer").unwrap(),
                    RuntimeEndpointReference::try_new("endpoint:one").unwrap(),
                ),
            ],
        )
        .unwrap()
    }

    fn idempotency_key(value: &str) -> IdempotencyKey {
        IdempotencyKey::try_new(value).unwrap()
    }

    struct FixedTeamDriver {
        outcome: organization::MaterializationOperationOutcome,
        delete_evidence: NativeDeletionEvidence,
        materialize_count: AtomicUsize,
        remove_count: AtomicUsize,
        delete_count: AtomicUsize,
    }

    impl FixedTeamDriver {
        fn new(outcome: organization::MaterializationOperationOutcome) -> Self {
            Self {
                outcome,
                delete_evidence: NativeDeletionEvidence::OutcomeUnknown,
                materialize_count: AtomicUsize::new(0),
                remove_count: AtomicUsize::new(0),
                delete_count: AtomicUsize::new(0),
            }
        }

        fn with_delete_evidence(mut self, evidence: NativeDeletionEvidence) -> Self {
            self.delete_evidence = evidence;
            self
        }

        fn materialize_count(&self) -> usize {
            self.materialize_count.load(Ordering::SeqCst)
        }

        fn remove_count(&self) -> usize {
            self.remove_count.load(Ordering::SeqCst)
        }

        fn delete_count(&self) -> usize {
            self.delete_count.load(Ordering::SeqCst)
        }
    }

    struct FixedRuntimeDirectory {
        driver: Arc<FixedTeamDriver>,
    }

    impl OrganizationRuntimeDirectory for FixedRuntimeDirectory {
        fn team_runtime_for_endpoint(
            &self,
            _endpoint: &RuntimeEndpointReference,
        ) -> Option<Arc<dyn OrganizationNativeRuntime>> {
            Some(self.driver.clone())
        }

        fn open_claw_runtime(&self) -> Option<Arc<dyn OrganizationNativeRuntime>> {
            Some(self.driver.clone())
        }
    }

    impl OrganizationNativeRuntime for FixedTeamDriver {
        fn materialize_team(
            &self,
            _request: organization::TeamMaterializationRequest,
        ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
            self.materialize_count.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { organization::MaterializationOperationOutcome::OutcomeUnknown })
        }

        fn remove_team(
            &self,
            _removal: organization::TeamMaterializationRemoval,
        ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
            self.remove_count.fetch_add(1, Ordering::SeqCst);
            let outcome = self.outcome.clone();
            Box::pin(async move { outcome })
        }

        fn recover_team_materialization(
            &self,
            _request: organization::TeamMaterializationRequest,
        ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
            Box::pin(async { organization::MaterializationOperationOutcome::OutcomeUnknown })
        }

        fn confirm_team_run_receipt(
            &self,
            _receipt: RunRuntimeReceipt,
        ) -> OwnedRuntimeFuture<RuntimeReceiptOutcome> {
            Box::pin(async { RuntimeReceiptOutcome::OutcomeUnknown })
        }

        fn abort_role_sessions(
            &self,
            _bindings: Vec<organization::RoleSessionReceipt>,
        ) -> OwnedRuntimeFuture<RoleAbortOutcome> {
            Box::pin(async { RoleAbortOutcome::OutcomeUnknown })
        }

        fn delete_role_sessions(
            &self,
            _run_id: GraphRunId,
            _bindings: Vec<organization::RoleSessionReceipt>,
            _abort_first: bool,
        ) -> OwnedRuntimeFuture<NativeDeletionEvidence> {
            self.delete_count.fetch_add(1, Ordering::SeqCst);
            let evidence = self.delete_evidence.clone();
            Box::pin(async move { evidence })
        }

        fn installed_skill_names(&self, _source_agent: Option<organization::ManagedAgentReference>) -> OwnedRuntimeFuture<Option<Vec<String>>> {
            Box::pin(async { Some(Vec::new()) })
        }
    }

    fn confirmed_deletion_evidence_for(run_id: GraphRunId) -> NativeDeletionEvidence {
        let binding = openclaw_runtime_receipt(run_id.clone()).bindings()[0].clone();
        let receipt =
            organization::RoleSessionDeleteReceipt::new(binding.endpoint_session_id().clone());
        let confirmation =
            organization::RoleSessionDeletionConfirmation::try_new(binding, receipt).unwrap();
        NativeDeletionEvidence::Confirmed(
            organization::NativeDeletionProof::try_new(run_id, vec![confirmation]).unwrap(),
        )
    }

    fn runtime_receipt() -> RunRuntimeReceipt {
        runtime_receipt_for(GraphRunId::new("run:one"))
    }

    fn openclaw_runtime_receipt(run_id: GraphRunId) -> RunRuntimeReceipt {
        RunRuntimeReceipt::try_new(
            run_id.clone(),
            vec![RoleSessionReceipt::new(
                team_id(),
                run_id,
                RoleId::try_new("leader").unwrap(),
                RoleSessionRef::try_new("rs0").unwrap(),
                ManagedAgentReference::try_new("agent:leader").unwrap(),
                RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap(),
            )],
        )
        .unwrap()
    }

    fn two_role_runtime_receipt(run_id: GraphRunId) -> RunRuntimeReceipt {
        RunRuntimeReceipt::try_new(
            run_id.clone(),
            vec![
                RoleSessionReceipt::new(
                    team_id(),
                    run_id.clone(),
                    RoleId::try_new("leader").unwrap(),
                    RoleSessionRef::try_new("rs0").unwrap(),
                    ManagedAgentReference::try_new("agent:leader").unwrap(),
                    RuntimeEndpointReference::try_new("endpoint:one").unwrap(),
                ),
                RoleSessionReceipt::new(
                    team_id(),
                    run_id,
                    RoleId::try_new("reviewer").unwrap(),
                    RoleSessionRef::try_new("rs0").unwrap(),
                    ManagedAgentReference::try_new("agent:reviewer").unwrap(),
                    RuntimeEndpointReference::try_new("endpoint:one").unwrap(),
                ),
            ],
        )
        .unwrap()
    }

    fn runtime_receipt_for(run_id: GraphRunId) -> RunRuntimeReceipt {
        RunRuntimeReceipt::try_new(
            run_id.clone(),
            vec![RoleSessionReceipt::new(
                team_id(),
                run_id,
                RoleId::try_new("leader").unwrap(),
                RoleSessionRef::try_new("rs0").unwrap(),
                ManagedAgentReference::try_new("agent:leader").unwrap(),
                RuntimeEndpointReference::try_new("endpoint:one").unwrap(),
            )],
        )
        .unwrap()
    }

    fn team_id() -> TeamId {
        TeamId::try_new("team:one").unwrap()
    }
}
