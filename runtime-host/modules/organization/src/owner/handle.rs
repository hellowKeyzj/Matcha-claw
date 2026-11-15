use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::{ActivityExecutionOutcome, NativeRunSettled, run::event::{TeamRunWake, TeamRunWakeReason}};
use foundation::execution::OwnerRuntimeHandle;
use futures_util::future::BoxFuture;

use organization::{
    ActivityClaim, ActivityId, BeginCancellationOutcome, CreateGraphRunOutcome, DeliveryId,
    GraphDefinition, GraphRunId, IdempotencyKey, NativeTerminalReceiptTarget, ResumeOutcome,
    RunCommand, StoreFault, TeamDecisionCommand, TeamDecisionReceipt, TeamGraphContextQuery,
    TeamGraphContextResult, TeamId, TeamNodeEvent, TeamNodeEventOutcome, TeamRunQuery,
    TeamRunQueryOutcome, TeamTriggerFireOutcome, TombstoneOutcome, TriggerFireRequest,
    package::{
        TeamSkillDependencyPlanResult, TeamSkillPackageValidation, TeamSkillSelectionError,
        TeamSkillSelectionId,
    },
    run::{
        approval::{HumanDecisionCommand, HumanDecisionOutcome},
        event::OpaqueId,
        public_projection::{TeamPublicQueryOutcome, TeamRunPublicSnapshotQueryOutcome},
        scheduler::NodePromptRetryDueQueryOutcome,
        task_board::TaskBoardFacts,
    },
};

use crate::{
    OrganizationPhase, RequestAdmissionClosed,
    application::{
        start_gate_control::{StartGatePromptPlan, StartGateRuntimeBindingLookup},
        team_runtime::{
            TeamNodeEventCommandOutcome, TeamRuntimeCommand, TeamRuntimeCommandOutcome,
            TeamRuntimeCreateSource, TeamRuntimeStatus,
        },
    },
};

use super::{
    OrganizationCommand, OrganizationQuery,
    team_run::{
        ArmedTrigger, ManualTeamCreateOutcome, TeamDeleteOutcome,
        TeamMaterializationCommandOutcome, TeamNodeTerminalResolution, TeamNodeTerminalResult,
        TeamRunActivityError, TeamRunActivityOutcome, TeamRunActivityStart,
        TeamRunCommandOutcome, TeamRunTriggerOutcome,
    },
};

#[derive(Clone)]
pub struct OrganizationHandle {
    inner: OwnerRuntimeHandle<OrganizationCommand, OrganizationQuery>,
    schedule_changes: tokio::sync::watch::Sender<TeamRunWake>,
    terminal_recovery: tokio::sync::watch::Sender<()>,
    activity_executor: Arc<std::sync::OnceLock<Arc<dyn crate::TeamActivityExecutor>>>,
    call: Option<crate::call::CallScope>,
    cancellation: tokio_util::sync::CancellationToken,
    native_teams: Arc<std::sync::Mutex<HashMap<TeamId, std::sync::Weak<tokio::sync::RwLock<()>>>>>,
    team_delete_slots: Arc<tokio::sync::Semaphore>,
    native_operation_slots: Arc<tokio::sync::Semaphore>,
    native_cancel_slots: Arc<tokio::sync::Semaphore>,
    runtime_directory: Option<Arc<dyn crate::OrganizationRuntimeDirectory>>,
}

impl OrganizationHandle {
    pub(crate) fn new(inner: OwnerRuntimeHandle<OrganizationCommand, OrganizationQuery>) -> Self {
        let (schedule_changes, _) =
            tokio::sync::watch::channel(TeamRunWake::new(TeamRunWakeReason::GraphChanged, None));
        let (terminal_recovery, _) = tokio::sync::watch::channel(());
        Self {
            inner,
            schedule_changes,
            terminal_recovery,
            activity_executor: Arc::new(std::sync::OnceLock::new()),
            call: None,
            cancellation: tokio_util::sync::CancellationToken::new(),
            native_teams: Arc::new(std::sync::Mutex::new(HashMap::new())),
            team_delete_slots: Arc::new(tokio::sync::Semaphore::new(64)),
            native_operation_slots: Arc::new(tokio::sync::Semaphore::new(64)),
            native_cancel_slots: Arc::new(tokio::sync::Semaphore::new(64)),
            runtime_directory: None,
        }
    }

    fn send_command(
        &self,
        command: OrganizationCommand,
    ) -> BoxFuture<'_, Result<(), foundation::execution::OwnerRuntimeSendError>> {
        crate::future::boxed(move || self.inner.send_command(command))
    }

    fn send_query(
        &self,
        query: OrganizationQuery,
    ) -> BoxFuture<'_, Result<(), foundation::execution::OwnerRuntimeSendError>> {
        crate::future::boxed(move || self.inner.send_query(query))
    }

    pub(crate) fn with_runtime_directory(mut self, directory: Arc<dyn crate::OrganizationRuntimeDirectory>) -> Self {
        self.runtime_directory = Some(directory);
        self
    }

    fn native_team(&self, team: &TeamId) -> Arc<tokio::sync::RwLock<()>> {
        let mut teams = self.native_teams.lock().expect("organization native teams poisoned");
        teams.retain(|_, lock| lock.strong_count() != 0);
        if let Some(lock) = teams.get(team).and_then(std::sync::Weak::upgrade) { return lock; }
        let lock = Arc::new(tokio::sync::RwLock::new(()));
        teams.insert(team.clone(), Arc::downgrade(&lock));
        lock
    }

    async fn native_operation_slot(&self, cancelling: bool) -> Result<tokio::sync::OwnedSemaphorePermit, RequestAdmissionClosed> {
        let slots = if cancelling { &self.native_cancel_slots } else { &self.native_operation_slots };
        tokio::select! {
            biased;
            _ = self.cancellation.cancelled() => Err(closed_error()),
            slot = Arc::clone(slots).acquire_owned() => slot.map_err(|_| closed_error()),
        }
    }

    async fn native_team_guard(&self, team: &TeamId) -> Result<Arc<tokio::sync::OwnedRwLockReadGuard<()>>, RequestAdmissionClosed> {
        tokio::select! {
            biased;
            _ = self.cancellation.cancelled() => Err(closed_error()),
            guard = self.native_team(team).read_owned() => Ok(guard.into()),
        }
    }

    async fn native_run_guard(&self, run: &GraphRunId) -> Result<Option<Arc<tokio::sync::OwnedRwLockReadGuard<()>>>, RequestAdmissionClosed> {
        match self.workflow_run_team(run.clone()).await? {
            Some(team) => self.native_team_guard(&team).await.map(Some),
            None => Ok(None),
        }
    }

    async fn run_native_lease(&self, run_id: GraphRunId) -> Result<Option<Arc<tokio::sync::OwnedRwLockReadGuard<()>>>, RequestAdmissionClosed> {
        let (reply, receiver) = tokio::sync::oneshot::channel();
        self.send_command(OrganizationCommand::RunNativeLease { run_id, reply }).await.map_err(closed)?;
        tokio::select! {
            biased;
            _ = self.cancellation.cancelled() => Err(closed_error()),
            lease = receiver => lease.map_err(|_| closed_error()),
        }
    }

    pub(crate) fn bind_activity_executor(&self, executor: Arc<dyn crate::TeamActivityExecutor>) {
        let _ = self.activity_executor.set(executor);
    }

    pub(crate) fn with_call(mut self, call: crate::call::CallScope) -> Self {
        self.call = Some(call);
        self
    }

    pub(crate) fn with_cancellation(mut self, cancellation: tokio_util::sync::CancellationToken) -> Self {
        self.cancellation = cancellation;
        self
    }

    fn reply_channel<T>(&self) -> (crate::call::CallReply<T>, tokio::sync::oneshot::Receiver<T>) {
        let (reply, receiver) = tokio::sync::oneshot::channel();
        (crate::call::CallReply::new(reply, self.call.clone()).with_cancellation(self.cancellation.clone()), receiver)
    }

    pub async fn team_prompt_settings(&self) -> Result<crate::prompts::TeamPromptSettings, crate::TeamPromptSettingsError> {
        let (reply, receiver) = self.reply_channel();
        self.send_query(OrganizationQuery::TeamPromptSettings { reply }).await
            .map_err(|_| crate::TeamPromptSettingsError::Unavailable)?;
        self.call_admitted().await;
        receiver.await.map_err(|_| crate::TeamPromptSettingsError::Unavailable)?
    }

    pub async fn save_team_prompts(
        &self,
        expected_revision: u64,
        values: std::collections::BTreeMap<String, String>,
    ) -> Result<crate::prompts::TeamPromptSettings, crate::TeamPromptSettingsError> {
        let (reply, receiver) = self.reply_channel();
        self.send_command(OrganizationCommand::SaveTeamPrompts { expected_revision, values, reply }).await
            .map_err(|_| crate::TeamPromptSettingsError::Unavailable)?;
        self.call_admitted().await;
        match receiver.await {
            Ok(outcome) => outcome,
            Err(_) => {
                self.summarize_call(&TeamRuntimeStatus::OutcomeUnknown).await;
                Err(crate::TeamPromptSettingsError::Store(
                    StoreFault::CommitOutcomeUnknown(std::io::ErrorKind::UnexpectedEof),
                ))
            }
        }
    }

    pub fn subscribe_schedule_changes(&self) -> tokio::sync::watch::Receiver<TeamRunWake> {
        self.schedule_changes.subscribe()
    }

    pub(crate) fn subscribe_terminal_recovery(&self) -> tokio::sync::watch::Receiver<()> {
        self.terminal_recovery.subscribe()
    }

    pub(super) fn retry_terminal_deliveries(&self) {
        self.terminal_recovery.send_replace(());
    }

    fn publish_team_run_wake(&self, reason: TeamRunWakeReason, run_id: Option<GraphRunId>) {
        self.schedule_changes
            .send_replace(TeamRunWake::new(reason, run_id));
    }

    pub async fn execute_team_runtime(
        &self,
        command: TeamRuntimeCommand,
    ) -> Result<TeamRuntimeCommandOutcome, RequestAdmissionClosed> {
        if let Some(workflows) = self.call.as_ref().and_then(crate::call::CallScope::workflows) {
            if !command.operation().single_stage() {
                return workflows.runtime(self.clone(), command).await;
            }
        }
        self.execute_team_runtime_inline(command).await
    }

    pub(crate) async fn execute_team_runtime_inline(
        &self,
        command: TeamRuntimeCommand,
    ) -> Result<TeamRuntimeCommandOutcome, RequestAdmissionClosed> {
        let outcome = execute_team_runtime(self, command).await.ok_or_else(closed_error);
        if let (Some(call), Ok(outcome)) = (&self.call, &outcome) {
            call.summarize(outcome).await;
        }
        outcome
    }

    pub(crate) async fn execute_team_runtime_capability_request(
        &self,
        resolver: std::sync::Arc<dyn crate::RoleSessionIdentityResolver>,
        request: crate::TeamRuntimeCapabilityRequest,
    ) -> Result<(String, crate::TeamRuntimeControlOutcome), crate::TeamRuntimeDecodeError> {
        if let Some(workflows) = self.call.as_ref().and_then(crate::call::CallScope::workflows) {
            if !request.single_stage() {
                return workflows.capability(self.clone(), request, resolver).await;
            }
        }
        self.execute_runtime_capability_inline(resolver, request)
            .await
    }

    pub(crate) async fn admit_team_capability(
        &self,
        resolver: std::sync::Arc<dyn crate::RoleSessionIdentityResolver>,
        request: crate::TeamRuntimeCapabilityRequest,
    ) -> Result<platform::call::CallReceipt, crate::TeamRuntimeDecodeError> {
        let call = self
            .call
            .as_ref()
            .ok_or(crate::TeamRuntimeDecodeError::Unavailable)?;
        let workflows = call
            .workflows()
            .ok_or(crate::TeamRuntimeDecodeError::Unavailable)?;
        workflows
            .admit_capability(self.clone(), call, request, resolver)
            .await
    }

    pub(crate) async fn admit_team_workflow(
        &self,
        request: crate::call::TeamWorkflow,
    ) -> Result<platform::call::CallReceipt, crate::TeamRuntimeDecodeError> {
        let call = self.call.as_ref().ok_or(crate::TeamRuntimeDecodeError::Unavailable)?;
        let workflows = call.workflows().ok_or(crate::TeamRuntimeDecodeError::Unavailable)?;
        workflows.admit_team(self.clone(), call, request).await
    }

    pub(crate) async fn execute_runtime_capability_inline(
        &self,
        resolver: std::sync::Arc<dyn crate::RoleSessionIdentityResolver>,
        request: crate::TeamRuntimeCapabilityRequest,
    ) -> Result<(String, crate::TeamRuntimeControlOutcome), crate::TeamRuntimeDecodeError> {
        let outcome = crate::application::team_runtime_control::execute_inline(self, resolver, request).await;
        if let Ok((_, outcome)) = &outcome {
            self.summarize_call(outcome).await;
        }
        outcome
    }

    pub(crate) async fn drain_team_delete_tasks(&self) -> Result<(), RequestAdmissionClosed> {
        let teams = self.native_teams.lock().expect("organization native teams poisoned")
            .keys().cloned().collect::<Vec<_>>();
        for team_id in teams {
            loop {
                let (reply, receiver) = tokio::sync::oneshot::channel();
                self.send_command(OrganizationCommand::DrainTeamDeleteTasks { team_id: team_id.clone(), reply })
                    .await.map_err(closed)?;
                let tasks = receiver.await.map_err(|_| closed_error())?;
                if tasks.is_empty() { break; }
                for mut task in tasks {
                    let _ = task.cancel_and_join().await;
                }
                // The next Team command follows all settlements sent by the joined producers.
            }
        }
        Ok(())
    }

    pub(crate) fn call_trace_id(&self) -> Option<String> {
        self.call.as_ref().filter(|_| platform::trace::enabled()).map(crate::call::CallScope::trace_id)
    }

    pub(crate) async fn call_admitted(&self) {
        if let Some(call) = &self.call { call.admitted().await; }
    }

    pub(crate) async fn call_running(&self) -> bool {
        match &self.call {
            Some(call) => call.running().await,
            None => true,
        }
    }

    pub(crate) async fn summarize_call<T: crate::call::outcome::AuditOutcome>(&self, value: &T) {
        if let Some(call) = &self.call { call.summarize(value).await; }
    }

    pub(crate) async fn finish_workflow(&self, failed: bool) {
        if let Some(call) = &self.call { call.finish(failed).await; }
    }

    pub(crate) async fn execute_graph_workflow(
        &self,
        request: crate::adapters::loopback::graph::Request,
    ) -> crate::adapters::loopback::graph::Delivery {
        if !matches!(request, crate::adapters::loopback::graph::Request::Export { .. }) {
            if let Some(workflows) = self.call.as_ref().and_then(crate::call::CallScope::workflows) {
                return workflows.graph(self.clone(), request).await;
            }
        }
        crate::adapters::loopback::graph::handle(self, request).await
    }

    pub async fn team_skill_authorize(
        &self,
        package_root: PathBuf,
    ) -> Result<Result<TeamSkillSelectionId, TeamSkillSelectionError>, RequestAdmissionClosed> {
        let (reply, reply_rx) = self.reply_channel();
        self.send_command(OrganizationCommand::TeamSkillAuthorize {
                package_root,
                reply,
            })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn team_skill_validate(
        &self,
        package_root: PathBuf,
    ) -> Result<TeamSkillPackageValidation, RequestAdmissionClosed> {
        let (reply, reply_rx) = self.reply_channel();
        self.send_query(OrganizationQuery::TeamSkillValidate {
                package_root,
                reply,
            })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn team_skill_dependency_plan(
        &self,
        package_root: PathBuf,
    ) -> Result<TeamSkillDependencyPlanResult, RequestAdmissionClosed> {
        let (reply, reply_rx) = self.reply_channel();
        self.send_query(OrganizationQuery::TeamSkillDependencyPlan {
                package_root,
                reply,
            })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn team_skill_selection_validate(
        &self,
        selection_id: TeamSkillSelectionId,
    ) -> Result<TeamSkillPackageValidation, RequestAdmissionClosed> {
        let (reply, reply_rx) = self.reply_channel();
        self.send_query(OrganizationQuery::TeamSkillSelectionValidate {
                selection_id,
                reply,
            })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn team_skill_selection_dependency_plan(
        &self,
        selection_id: TeamSkillSelectionId,
        endpoint: organization::RuntimeEndpointReference,
        source_agent: Option<organization::ManagedAgentReference>,
    ) -> Result<TeamSkillDependencyPlanResult, RequestAdmissionClosed> {
        let (reply, reply_rx) = self.reply_channel();
        self.send_query(OrganizationQuery::TeamSkillSelectionDependencyPlan {
                selection_id,
                endpoint,
                source_agent,
                reply,
            })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn team_skill_materialize(
        &self,
        selection_id: TeamSkillSelectionId,
        endpoint: organization::RuntimeEndpointReference,
        source_agent: Option<organization::ManagedAgentReference>,
        team_id: TeamId,
        idempotency_key: IdempotencyKey,
    ) -> Result<TeamMaterializationCommandOutcome, RequestAdmissionClosed> {
        if let Some(call) = &self.call { call.references(Some(team_id.as_str()), None, None).await; }
        let (reply, reply_rx) = self.reply_channel();
        let reply = reply.with_native_guard(self.native_team_guard(&team_id).await?);
        self.send_command(OrganizationCommand::TeamSkillMaterialize {
                selection_id,
                endpoint,
                source_agent,
                team_id,
                idempotency_key,
                reply,
            })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn manual_team_materialize(
        &self,
        team_id: TeamId,
        team_name: String,
        roles: Vec<organization::ManualTeamRoleBinding>,
        idempotency_key: IdempotencyKey,
    ) -> Result<TeamMaterializationCommandOutcome, RequestAdmissionClosed> {
        let (reply, reply_rx) = self.reply_channel();
        let reply = reply.with_native_guard(self.native_team_guard(&team_id).await?);
        platform::trace::session_trace("runtime.team.owner.enqueue.start", || serde_json::json!({}));
        self.send_command(OrganizationCommand::ManualTeamMaterialize {
                team_id,
                team_name,
                roles,
                idempotency_key,
                reply,
            })
            .await
            .map_err(|error| {
                platform::trace::session_trace(
                    "runtime.team.owner.enqueue.end",
                    || serde_json::json!({"reason": "admission_closed"}),
                );
                closed(error)
            })?;
        platform::trace::session_trace(
            "runtime.team.owner.enqueue.end",
            || serde_json::json!({"reason": "queued"}),
        );
        self.call_admitted().await;
        reply_rx.await.map_err(|_| {
            platform::trace::session_trace(
                "runtime.team.owner.reply",
                || serde_json::json!({"reason": "sender_closed"}),
            );
            closed_error()
        })
    }

    pub(crate) async fn manual_team_create(
        &self,
        team_id: TeamId,
        team_name: String,
        roles: Vec<organization::ManualTeamRoleBinding>,
        materialization_idempotency_key: IdempotencyKey,
        run: organization::GraphRunFacts,
        run_idempotency_key: String,
    ) -> Result<ManualTeamCreateOutcome, RequestAdmissionClosed> {
        if let Some(call) = &self.call { call.references(Some(team_id.as_str()), Some(run.run_id().as_str()), None).await; }
        let native_slot = self.native_operation_slot(false).await?;
        let (reply, reply_rx) = self.reply_channel();
        let reply = reply.with_native_guard(self.native_team_guard(&team_id).await?);
        let (continue_run, continuation) = tokio::sync::oneshot::channel();
        platform::trace::session_trace("runtime.team.owner.enqueue.start", || serde_json::json!({}));
        self.send_command(OrganizationCommand::ManualTeamCreate {
                team_id,
                team_name,
                roles,
                materialization_idempotency_key,
                run,
                run_idempotency_key,
                reply,
                continue_run,
            })
            .await
            .map_err(|error| {
                platform::trace::session_trace(
                    "runtime.team.owner.enqueue.end",
                    || serde_json::json!({"reason": "admission_closed"}),
                );
                closed(error)
            })?;
        platform::trace::session_trace(
            "runtime.team.owner.enqueue.end",
            || serde_json::json!({"reason": "queued"}),
        );
        self.call_admitted().await;
        if let Ok((team_id, run, run_idempotency_key, reply)) = continuation.await {
            self.send_command(OrganizationCommand::ManualTeamRunCreate {
                native_slot, team_id, run, run_idempotency_key, reply,
            }).await.map_err(closed)?;
        }
        reply_rx.await.map_err(|_| {
            platform::trace::session_trace(
                "runtime.team.owner.reply",
                || serde_json::json!({"reason": "sender_closed"}),
            );
            closed_error()
        })
    }

    pub async fn team_delete(
        &self,
        team_id: TeamId,
        idempotency_key: IdempotencyKey,
        observed_at: u64,
    ) -> Result<Result<TeamDeleteOutcome, StoreFault>, RequestAdmissionClosed> {
        let (reply, reply_rx) = self.reply_channel();
        let lock = self.native_team(&team_id);
        let guard = tokio::select! {
            biased;
            _ = self.cancellation.cancelled() => return Err(closed_error()),
            guard = lock.write_owned() => guard,
        };
        let slot = tokio::select! {
            biased;
            _ = self.cancellation.cancelled() => return Err(closed_error()),
            slot = Arc::clone(&self.team_delete_slots).acquire_owned() => slot.map_err(|_| closed_error())?,
        };
        self.send_command(OrganizationCommand::TeamDelete {
                guard,
                slot,
                team_id,
                idempotency_key,
                observed_at,
                reply,
            })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn run_create(
        &self,
        team_id: TeamId,
        run_id: GraphRunId,
        idempotency_key: String,
        workflow_plan: organization::WorkflowPlan,
        source_identity: String,
        template_revision: u64,
        created_at: u64,
    ) -> Result<Result<CreateGraphRunOutcome, StoreFault>, RequestAdmissionClosed> {
        let wake_run_id = run_id.clone();
        let (reply, reply_rx) = self.reply_channel();
        let reply = reply.with_native_guard(self.native_team_guard(&team_id).await?);
        self.send_command(OrganizationCommand::RunCreate {
                team_id,
                run_id,
                idempotency_key,
                workflow_plan,
                source_identity,
                template_revision,
                created_at,
                reply,
            })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        let outcome = reply_rx.await.map_err(|_| closed_error())?;
        if outcome.is_ok() {
            self.publish_team_run_wake(TeamRunWakeReason::RunStarted, Some(wake_run_id));
        }
        Ok(outcome)
    }

    pub async fn execute_task(
        &self,
        request: crate::task_execution::TaskExecutionRequest,
    ) -> Result<crate::task_execution::TaskExecutionReceipt, RequestAdmissionClosed> {
        use crate::task_execution::{TaskExecutionReceipt, TaskExecutionRejection, TaskExecutionState};
        let identity = request.identity.clone();
        if let Some(call) = &self.call {
            call.references(Some(identity.selection.team_id.as_str()), Some(identity.run_id.as_str()), None).await;
        }
        let native_slot = self.native_operation_slot(false).await?;
        let (reply, receiver) = self.reply_channel();
        let reply = reply.with_native_guard(self.native_team_guard(&identity.selection.team_id).await?);
        self.send_command(OrganizationCommand::TaskCreate { native_slot, request, reply }).await.map_err(closed)?;
        self.call_admitted().await;
        let version = match receiver.await.map_err(|_| closed_error())? {
            Ok(version) => version,
            Err(receipt) => return Ok(receipt),
        };
        let started = self.execute_team_runtime(TeamRuntimeCommand::RunStart {
            team_id: identity.selection.team_id.clone(), run_id: identity.run_id.clone(), epoch: None, version,
        }).await?;
        match started {
            TeamRuntimeCommandOutcome::RunStart(Ok(())) => self.inspect_task(identity).await,
            TeamRuntimeCommandOutcome::RunStart(Err(StoreFault::InvalidFacts | StoreFault::Design(_))) =>
                Ok(TaskExecutionReceipt::new(identity, TaskExecutionState::Rejected(TaskExecutionRejection::StartRejected))),
            TeamRuntimeCommandOutcome::RunStart(Err(error)) => Ok(crate::task_execution::store_failure(identity, &error)),
            _ => Ok(TaskExecutionReceipt::new(identity,
                TaskExecutionState::Rejected(TaskExecutionRejection::StartRejected))),
        }
    }

    pub async fn inspect_task(
        &self,
        identity: crate::task_execution::TaskExecutionIdentity,
    ) -> Result<crate::task_execution::TaskExecutionReceipt, RequestAdmissionClosed> {
        use crate::task_execution::{TaskActivityInspection, TaskExecutionState, TaskNativePhase};
        let (mut receipt, requests) = self.task_inspection_snapshot(identity.clone()).await?;
        if requests.is_empty() { return Ok(receipt); }
        let Some(executor) = self.activity_executor.get() else {
            receipt.state = TaskExecutionState::Unavailable;
            return Ok(receipt);
        };
        let mut read_failure = None;
        for request in requests {
            let inspected = tokio::select! {
                _ = self.cancellation.cancelled() => {
                    read_failure = Some(TaskExecutionState::Unknown);
                    break;
                }
                inspected = executor.inspect_cancellable(request.clone(), self.cancellation.clone()) => inspected,
            };
            match inspected {
                TaskActivityInspection::Found { mut execution, phase, .. } => {
                    // Live counters are not an immutable terminal measurement.
                    if !matches!(phase, TaskNativePhase::Cancelled | TaskNativePhase::Completed
                        | TaskNativePhase::Failed | TaskNativePhase::Interrupted) {
                        execution.measurement = crate::TaskRunMeasurement::Unavailable;
                    }
                    let (reply, receiver) = tokio::sync::oneshot::channel();
                    self.send_command(OrganizationCommand::TaskNativeExecutionObserved {
                        identity: identity.clone(), request, execution, reply,
                    }).await.map_err(closed)?;
                    if receiver.await.map_err(|_| closed_error())?.is_err() {
                        read_failure = Some(TaskExecutionState::Unknown);
                    }
                }
                TaskActivityInspection::Unknown => read_failure = Some(TaskExecutionState::Unknown),
                TaskActivityInspection::Unavailable => {
                    if read_failure.is_none() { read_failure = Some(TaskExecutionState::Unavailable); }
                }
            }
        }
        receipt = self.task_inspection_snapshot(identity).await?.0;
        if !matches!(receipt.state, TaskExecutionState::Terminal | TaskExecutionState::Rejected(_)) {
            if let Some(state) = read_failure { receipt.state = state; }
        }
        Ok(receipt)
    }

    async fn task_inspection_snapshot(
        &self,
        identity: crate::task_execution::TaskExecutionIdentity,
    ) -> Result<(crate::task_execution::TaskExecutionReceipt, Vec<crate::ActivityExecutionRequest>), RequestAdmissionClosed> {
        let (reply, receiver) = self.reply_channel();
        self.send_query(OrganizationQuery::TaskInspect { identity, reply }).await.map_err(closed)?;
        self.call_admitted().await;
        receiver.await.map_err(|_| closed_error())
    }

    /// Observes the original run through the existing durable-fact wake stream; never sends.
    pub async fn wait_task(
        &self,
        identity: crate::task_execution::TaskExecutionIdentity,
    ) -> Result<crate::task_execution::TaskExecutionReceipt, RequestAdmissionClosed> {
        use crate::task_execution::TaskExecutionState;
        // Subscribe before reading so a commit between the read and await cannot be lost.
        let mut changes = self.subscribe_schedule_changes();
        loop {
            let mut receipt = self.inspect_task(identity.clone()).await?;
            if !matches!(receipt.state, TaskExecutionState::Pending | TaskExecutionState::Accepted) {
                return Ok(receipt);
            }
            tokio::select! {
                _ = self.cancellation.cancelled() => {
                    receipt.state = TaskExecutionState::Unknown;
                    return Ok(receipt);
                }
                changed = changes.changed() => {
                    if changed.is_err() {
                        receipt.state = TaskExecutionState::Unavailable;
                        return Ok(receipt);
                    }
                    // watch coalesces changes: the last run id may hide this run's prior change.
                }
            }
        }
    }

    pub async fn cancel_task(
        &self,
        identity: crate::task_execution::TaskExecutionIdentity,
        idempotency_key: IdempotencyKey,
        requested_at: u64,
    ) -> Result<crate::task_execution::TaskExecutionReceipt, RequestAdmissionClosed> {
        let run_id = identity.run_id.clone();
        let guard = match self.run_native_lease(run_id.clone()).await? {
            Some(guard) => guard,
            None => self.native_team_guard(&identity.selection.team_id).await?,
        };
        let native_slot = self.native_operation_slot(true).await?;
        let (reply, receiver) = self.reply_channel();
        let reply = reply.with_native_guard(guard);
        self.send_command(OrganizationCommand::TaskCancel {
            native_slot, identity, idempotency_key, requested_at, reply,
        }).await.map_err(closed)?;
        self.call_admitted().await;
        let receipt = receiver.await.map_err(|_| closed_error())?;
        self.publish_team_run_wake(TeamRunWakeReason::GraphChanged, Some(run_id));
        Ok(receipt)
    }

    pub async fn run_create_from_team_template(
        &self,
        team_id: TeamId,
        run_id: GraphRunId,
        idempotency_key: IdempotencyKey,
        created_at: u64,
    ) -> Result<(Result<CreateGraphRunOutcome, TeamRuntimeStatus>, Option<crate::TeamCreationFailure>, Option<crate::run::public_projection::TeamRunPublicWorkspace>), RequestAdmissionClosed> {
        if let Some(call) = &self.call {
            call.references(Some(team_id.as_str()), Some(run_id.as_str()), None).await;
        }
        let wake_run_id = run_id.clone();
        let native_slot = self.native_operation_slot(false).await?;
        let (reply, reply_rx) = self.reply_channel();
        let reply = reply.with_native_guard(self.native_team_guard(&team_id).await?);
        self.send_command(OrganizationCommand::RunCreateFromTeamTemplate {
                native_slot,
                team_id,
                run_id,
                idempotency_key,
                created_at,
                reply,
            })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        let outcome = reply_rx.await.map_err(|_| closed_error())?;
        if outcome.0.is_ok() {
            self.publish_team_run_wake(TeamRunWakeReason::RunStarted, Some(wake_run_id));
        }
        Ok(outcome)
    }

    pub async fn run_list(
        &self,
        team_id: TeamId,
    ) -> Result<Result<Vec<crate::TeamRunListEntry>, StoreFault>, RequestAdmissionClosed> {
        let (reply, reply_rx) = self.reply_channel();
        self.send_query(OrganizationQuery::RunList { team_id, reply })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn run_workspace_binding(
        &self, team: TeamId, run: GraphRunId, endpoint: crate::RuntimeEndpointReference,
        access: crate::RunWorkspaceAccess,
    ) -> Result<Result<Option<crate::RunWorkspaceBinding>, StoreFault>, RequestAdmissionClosed> {
        let (reply, receiver) = tokio::sync::oneshot::channel();
        self.send_query(OrganizationQuery::RunWorkspaceBinding { team_id: team, run_id: run, endpoint, access, reply })
            .await.map_err(closed)?;
        receiver.await.map_err(|_| closed_error())
    }

    pub async fn run_snapshot(
        &self,
        query: TeamRunQuery,
    ) -> Result<TeamRunQueryOutcome, RequestAdmissionClosed> {
        let (reply, reply_rx) = self.reply_channel();
        self.send_query(OrganizationQuery::RunSnapshot { query, reply })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn team_run_public_projection(
        &self,
        team_id: TeamId,
        run_id: GraphRunId,
    ) -> Result<TeamPublicQueryOutcome, RequestAdmissionClosed> {
        let (reply, reply_rx) = self.reply_channel();
        self.send_query(OrganizationQuery::TeamRunPublicProjection {
                team_id,
                run_id,
                reply,
            })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn team_run_public_snapshot(
        &self,
        team_id: Option<TeamId>,
        run_id: GraphRunId,
        event_cursor: Option<u64>,
        event_limit: Option<u64>,
        message_cursor: Option<crate::run::public_projection::TeamRunMessageCursor>,
    ) -> Result<(Option<TeamRunPublicSnapshotQueryOutcome>, Option<crate::TeamCreationFailure>, Option<Vec<crate::RoleSessionReceipt>>), RequestAdmissionClosed> {
        let (reply, reply_rx) = self.reply_channel();
        self.send_query(OrganizationQuery::TeamRunPublicSnapshot {
                team_id,
                run_id,
                event_cursor,
                event_limit,
                message_cursor,
                reply,
            })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub(crate) async fn node_review_history(
        &self,
        team_id: TeamId,
        run_id: GraphRunId,
        node_id: crate::NodeId,
        query: crate::run::public_projection::TeamNodeReviewHistoryQuery,
    ) -> Result<Result<Option<crate::run::public_projection::TeamNodeReviewHistoryResult>, StoreFault>, RequestAdmissionClosed> {
        let (reply, reply_rx) = self.reply_channel();
        self.send_query(OrganizationQuery::NodeReviewHistory { team_id, run_id, node_id, query, reply })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn team_run_diagnostics(
        &self,
        run_id: GraphRunId,
    ) -> Result<organization::TeamRunDiagnosticsQueryOutcome, RequestAdmissionClosed> {
        let (reply, reply_rx) = self.reply_channel();
        self.send_query(OrganizationQuery::TeamRunDiagnostics { run_id, reply })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn role_sessions(
        &self,
        team_id: TeamId,
    ) -> Result<organization::TeamRoleSessionQueryOutcome, RequestAdmissionClosed> {
        let (reply, reply_rx) = self.reply_channel();
        self.send_query(OrganizationQuery::RoleSessions { team_id, reply })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn session_ownership(
        &self,
        queries: Vec<(platform::endpoint::runtime_address::SessionIdentity, String)>,
        resolver: Arc<dyn crate::RoleSessionIdentityResolver>,
    ) -> Result<
        Result<
            Option<HashMap<platform::endpoint::runtime_address::SessionIdentity, crate::RoleSessionReceipt>>,
            StoreFault,
        >,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = self.reply_channel();
        self.send_query(OrganizationQuery::RoleSessionReceipts { reply })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        let receipts = reply_rx.await.map_err(|_| closed_error())?;
        Ok(receipts.map(|receipts| {
            crate::application::projection::session_ownership(receipts, queries, resolver.as_ref())
        }))
    }

    async fn run_start(
        &self,
        team_id: TeamId,
        run_id: GraphRunId,
        epoch: Option<String>,
        version: String,
    ) -> Result<Result<(), StoreFault>, RequestAdmissionClosed> {
        let wake_run_id = run_id.clone();
        let (reply, rx) = tokio::sync::oneshot::channel();
        self.send_command(OrganizationCommand::RunStart {
            team_id, run_id, epoch, version, reply,
        }).await.map_err(closed)?;
        let outcome = rx.await.map_err(|_| closed_error())?;
        if matches!(outcome, Ok(true)) {
            self.publish_team_run_wake(TeamRunWakeReason::RunStarted, Some(wake_run_id));
        }
        Ok(outcome.map(|_| ()))
    }

    pub async fn continue_rework(
        &self,
        request: crate::ReworkContinueRequest,
    ) -> Result<Result<(), StoreFault>, RequestAdmissionClosed> {
        let run_id = request.run_id.clone();
        if let Some(call) = &self.call {
            call.references(
                Some(request.team_id.as_str()),
                Some(run_id.as_str()),
                Some(request.command_id.as_str()),
            ).await;
        }
        let (reply, receiver) = tokio::sync::oneshot::channel();
        self.send_command(OrganizationCommand::RunReworkContinue { request, reply })
            .await.map_err(closed)?;
        let outcome = receiver.await.map_err(|_| closed_error())?;
        if outcome.is_ok() {
            self.publish_team_run_wake(TeamRunWakeReason::GraphChanged, Some(run_id));
        }
        Ok(outcome)
    }

    pub(crate) async fn design_operation(
        &self,
        operation: crate::application::design::DesignOperation,
        resolver: std::sync::Arc<dyn crate::RoleSessionIdentityResolver>,
    ) -> Result<Result<serde_json::Value, StoreFault>, RequestAdmissionClosed> {
        let run_id = operation.run_id().clone();
        let (reply, rx) = tokio::sync::oneshot::channel();
        self.send_command(OrganizationCommand::Design {
                operation,
                resolver,
                reply,
            })
            .await
            .map_err(closed)?;
        let outcome = rx.await.map_err(|_| closed_error())?;
        if matches!(&outcome, Ok((_, true))) {
            self.publish_team_run_wake(TeamRunWakeReason::StartGateChanged, Some(run_id));
        }
        Ok(outcome.map(|(result, _)| result))
    }

    pub async fn record_evidence(
        &self,
        record: crate::run::evidence::EvidenceRecord,
    ) -> Result<Result<crate::run::evidence::RecordOutcome, StoreFault>, RequestAdmissionClosed>
    {
        let (reply, rx) = tokio::sync::oneshot::channel();
        self.send_command(OrganizationCommand::RecordEvidence { record, reply })
            .await
            .map_err(closed)?;
        rx.await.map_err(|_| closed_error())
    }

    pub(crate) async fn runtime_graph_context(
        &self,
        scope: crate::TeamRunExecutionScope,
    ) -> Result<Result<serde_json::Value, StoreFault>, RequestAdmissionClosed> {
        let (reply, rx) = tokio::sync::oneshot::channel();
        self.send_query(OrganizationQuery::RuntimeGraphContext { scope, reply })
            .await.map_err(closed)?;
        rx.await.map_err(|_| closed_error())
    }

    pub(crate) async fn runtime_graph_patch(
        &self,
        scope: crate::TeamRunExecutionScope,
        patch: crate::store::RuntimePromptPatch,
    ) -> Result<Result<serde_json::Value, StoreFault>, RequestAdmissionClosed> {
        let (reply, rx) = tokio::sync::oneshot::channel();
        self.send_command(OrganizationCommand::RuntimeGraphPatch { scope, patch, reply })
            .await.map_err(closed)?;
        rx.await.map_err(|_| closed_error())
    }

    pub(crate) async fn create_role_session(
        &self,
        team_id: TeamId,
        run_id: GraphRunId,
        role_id: crate::RoleId,
        idempotency_key: IdempotencyKey,
        scope: crate::application::team_runtime::RoleSessionCreateScope,
    ) -> Result<Result<crate::RoleSessionReceipt, crate::application::team_runtime::RoleSessionCreateError>, RequestAdmissionClosed> {
        if let Some(call) = &self.call {
            call.references(Some(team_id.as_str()), Some(run_id.as_str()), Some(idempotency_key.as_str())).await;
        }
        let native_slot = self.native_operation_slot(false).await?;
        let (reply, receiver) = self.reply_channel();
        let reply = reply.with_native_guard(self.native_team_guard(&team_id).await?);
        self.send_command(OrganizationCommand::RoleSessionCreate {
            native_slot, team_id, run_id, role_id, idempotency_key, scope, reply,
        }).await.map_err(closed)?;
        self.call_admitted().await;
        receiver.await.map_err(|_| closed_error())
    }

    pub async fn execute_team_mcp(
        &self,
        name: String,
        args: serde_json::Value,
        resolver: std::sync::Arc<dyn crate::RoleSessionIdentityResolver>,
    ) -> Result<serde_json::Value, RequestAdmissionClosed> {
        crate::application::team_mcp::execute(self, &name, args, resolver).await
    }

    pub async fn start_gate_prompt_plan(
        &self,
        lookup: StartGateRuntimeBindingLookup,
        resolver: std::sync::Arc<dyn crate::RoleSessionIdentityResolver>,
        inject_prompt: bool,
    ) -> Result<Option<StartGatePromptPlan>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.send_query(OrganizationQuery::StartGatePromptPlan {
                lookup,
                inject_prompt,
                resolver,
                trace_id: platform::trace::enabled().then(platform::trace::current_session_trace).flatten(),
                reply,
            })
            .await
            .map_err(closed)?;
        let outcome = reply_rx
            .await
            .map_err(|_| closed_error())?
            .map_err(|_| closed_error())?;
        if let Some(plan) = &outcome {
            if plan.design {
                self.publish_team_run_wake(
                    TeamRunWakeReason::StartGateChanged,
                    Some(plan.run_id().clone()),
                );
            }
        }
        Ok(outcome)
    }

    pub async fn run_cancel(
        &self,
        run_id: GraphRunId,
        idempotency_key: String,
        requested_at: u64,
    ) -> Result<Result<BeginCancellationOutcome, StoreFault>, RequestAdmissionClosed> {
        let guard = match self.run_native_lease(run_id.clone()).await? {
            Some(guard) => Some(guard),
            None => tokio::select! {
                biased;
                _ = self.cancellation.cancelled() => return Err(closed_error()),
                guard = self.native_run_guard(&run_id) => guard?,
            },
        };
        let native_slot = self.native_operation_slot(true).await?;
        let (reply, reply_rx) = self.reply_channel();
        let reply = match guard {
            Some(guard) => reply.with_native_guard(guard),
            None => reply,
        };
        self.send_command(OrganizationCommand::RunCancel {
                native_slot,
                run_id,
                idempotency_key,
                requested_at,
                reply,
            })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn run_delete(
        &self,
        run_id: GraphRunId,
        idempotency_key: String,
        tombstoned_at: u64,
    ) -> Result<Result<TombstoneOutcome, StoreFault>, RequestAdmissionClosed> {
        let (reply, reply_rx) = self.reply_channel();
        self.send_command(OrganizationCommand::RunDelete {
                run_id,
                idempotency_key,
                tombstoned_at,
                reply,
            })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn run_delete_and_purge(
        &self,
        run_id: GraphRunId,
        idempotency_key: String,
        observed_at: u64,
    ) -> Result<Result<organization::GraphRunPurgeOutcome, StoreFault>, RequestAdmissionClosed>
    {
        if let Some(call) = &self.call { call.references(None, Some(run_id.as_str()), None).await; }
        let native_slot = self.native_operation_slot(false).await?;
        let (reply, reply_rx) = self.reply_channel();
        let reply = match self.native_run_guard(&run_id).await? {
            Some(guard) => reply.with_native_guard(guard),
            None => reply,
        };
        self.send_command(OrganizationCommand::RunDeleteAndPurge {
                native_slot,
                run_id,
                idempotency_key,
                observed_at,
                reply,
            })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn run_purge(
        &self,
        request: organization::TeamRunPurgeRequest,
    ) -> Result<Result<organization::GraphRunPurgeOutcome, StoreFault>, RequestAdmissionClosed>
    {
        let (reply, reply_rx) = self.reply_channel();
        let reply = match self.native_run_guard(request.run_id()).await? {
            Some(guard) => reply.with_native_guard(guard),
            None => reply,
        };
        self.send_command(OrganizationCommand::RunPurge { request, reply })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn trigger_list(
        &self,
        team_id: Option<TeamId>,
    ) -> Result<Vec<ArmedTrigger>, RequestAdmissionClosed> {
        let (reply, reply_rx) = self.reply_channel();
        self.send_query(OrganizationQuery::TriggerList { team_id, reply })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn trigger_fire(
        &self,
        request: TriggerFireRequest,
        fired_at: u64,
    ) -> Result<Result<TeamRunTriggerOutcome, StoreFault>, RequestAdmissionClosed> {
        let wake_run_id = GraphRunId::new(request.run_id.clone());
        let (reply, reply_rx) = self.reply_channel();
        self.send_command(OrganizationCommand::TriggerFire {
                request,
                fired_at,
                reply,
            })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        let outcome = reply_rx.await.map_err(|_| closed_error())?;
        if outcome.is_ok() {
            self.publish_team_run_wake(TeamRunWakeReason::TriggerFired, Some(wake_run_id));
        }
        Ok(outcome)
    }

    pub async fn webhook_trigger_fire(
        &self,
        webhook_path: String,
        idempotency_key: String,
        fired_at: u64,
    ) -> Result<Result<TeamTriggerFireOutcome, TeamRuntimeStatus>, RequestAdmissionClosed> {
        let (reply, reply_rx) = self.reply_channel();
        self.send_command(OrganizationCommand::WebhookTriggerFire {
                webhook_path,
                idempotency_key,
                fired_at,
                reply,
            })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        let outcome = reply_rx.await.map_err(|_| closed_error())?;
        if let Ok(TeamTriggerFireOutcome::Recorded(request) | TeamTriggerFireOutcome::Replayed(request)) = &outcome {
            self.publish_team_run_wake(
                TeamRunWakeReason::TriggerFired,
                Some(GraphRunId::new(request.trigger.run_id.clone())),
            );
        }
        Ok(outcome)
    }

    pub async fn graph_save(
        &self,
        command: RunCommand,
        definition: GraphDefinition,
    ) -> Result<Result<TeamRunCommandOutcome, StoreFault>, RequestAdmissionClosed> {
        let wake_run_id = GraphRunId::new(command.run_id().as_str().to_owned());
        if let Some(call) = &self.call {
            call.references(None, Some(command.run_id().as_str()), Some(command.command_id().as_str())).await;
        }
        let (reply, reply_rx) = self.reply_channel();
        self.send_command(OrganizationCommand::GraphSave {
                command,
                definition,
                reply,
            })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        let outcome = reply_rx.await.map_err(|_| closed_error())?;
        if outcome.is_ok() {
            self.publish_team_run_wake(TeamRunWakeReason::GraphChanged, Some(wake_run_id));
        }
        Ok(outcome)
    }

    pub async fn graph_patch(
        &self,
        patch: crate::application::team_runtime::TeamGraphPatchDraft,
    ) -> Result<Result<TeamRunCommandOutcome, StoreFault>, RequestAdmissionClosed> {
        if let Some(call) = &self.call {
            call.references(None, Some(patch.run_id.as_str()), Some(patch.command_id.as_str())).await;
        }
        let (reply, reply_rx) = self.reply_channel();
        self.send_command(OrganizationCommand::GraphPatch { patch, reply })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        let outcome = reply_rx.await.map_err(|_| closed_error())?;
        if outcome.is_ok() {
            self.publish_team_run_wake(TeamRunWakeReason::GraphChanged, None);
        }
        Ok(outcome)
    }

    pub async fn graph_context(
        &self,
        query: TeamGraphContextQuery,
    ) -> Result<TeamGraphContextResult, RequestAdmissionClosed> {
        let (reply, reply_rx) = self.reply_channel();
        self.send_query(OrganizationQuery::GraphContext { query, reply })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn graph_definition(
        &self,
        team_id: TeamId,
        run_id: GraphRunId,
    ) -> Result<Option<GraphDefinition>, RequestAdmissionClosed> {
        let (reply, reply_rx) = self.reply_channel();
        self.send_query(OrganizationQuery::GraphDefinition {
                team_id,
                run_id,
                reply,
            })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn graph_yaml(
        &self,
        run_id: GraphRunId,
    ) -> Result<Option<String>, RequestAdmissionClosed> {
        let (reply, reply_rx) = self.reply_channel();
        self.send_query(OrganizationQuery::GraphYaml { run_id, reply })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn node_event(
        &self,
        command: RunCommand,
        event: TeamNodeEvent,
    ) -> Result<Result<TeamNodeEventOutcome, StoreFault>, RequestAdmissionClosed> {
        let wake_run_id = GraphRunId::new(command.run_id().as_str().to_owned());
        let (reply, reply_rx) = self.reply_channel();
        self.send_command(OrganizationCommand::NodeEvent {
                command,
                event,
                reply,
            })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        let outcome = reply_rx.await.map_err(|_| closed_error())?;
        if outcome.is_ok() {
            self.publish_team_run_wake(TeamRunWakeReason::NodeEventRecorded, Some(wake_run_id));
        }
        Ok(outcome)
    }

    pub async fn node_prompt_retry_due(
        &self,
        run_id: GraphRunId,
    ) -> Result<NodePromptRetryDueQueryOutcome, RequestAdmissionClosed> {
        let (reply, reply_rx) = self.reply_channel();
        self.send_query(OrganizationQuery::NodePromptRetryDue { run_id, reply })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn node_terminal_resolve(
        &self,
        run_id: GraphRunId,
        node_execution_id: OpaqueId,
        event: String,
        terminal: Option<TeamNodeTerminalResolution>,
        summary: String,
        output_port: Option<String>,
        idempotency_key: String,
        resolved_at: u64,
    ) -> Result<Result<TeamNodeTerminalResult, StoreFault>, RequestAdmissionClosed> {
        let wake_run_id = run_id.clone();
        let (reply, reply_rx) = self.reply_channel();
        self.send_command(OrganizationCommand::NodeTerminalResolve {
                run_id,
                node_execution_id,
                event,
                terminal,
                summary,
                output_port,
                idempotency_key,
                resolved_at,
                reply,
            })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        let outcome = reply_rx.await.map_err(|_| closed_error())?;
        if outcome.is_ok() {
            self.publish_team_run_wake(TeamRunWakeReason::TerminalSettled, Some(wake_run_id));
        }
        Ok(outcome)
    }

    pub async fn approval_resolve(
        &self,
        command: HumanDecisionCommand,
    ) -> Result<Result<HumanDecisionOutcome, StoreFault>, RequestAdmissionClosed> {
        let wake_run_id = command.run_id().clone();
        let (reply, reply_rx) = self.reply_channel();
        self.send_command(OrganizationCommand::ApprovalResolve { command, reply })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        let outcome = reply_rx.await.map_err(|_| closed_error())?;
        if outcome.is_ok() {
            self.publish_team_run_wake(TeamRunWakeReason::ApprovalResolved, Some(wake_run_id));
        }
        Ok(outcome)
    }

    pub async fn decision_submit(
        &self,
        command: TeamDecisionCommand,
    ) -> Result<Result<TeamDecisionReceipt, StoreFault>, RequestAdmissionClosed> {
        let wake_run_id = GraphRunId::new(command.run_id().to_owned());
        let (reply, reply_rx) = self.reply_channel();
        self.send_command(OrganizationCommand::DecisionSubmit { command, reply })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        let outcome = reply_rx.await.map_err(|_| closed_error())?;
        if outcome.is_ok() {
            self.publish_team_run_wake(TeamRunWakeReason::DecisionSubmitted, Some(wake_run_id));
        }
        Ok(outcome)
    }

    pub async fn task_board_read(
        &self,
        team_id: TeamId,
        run_id: GraphRunId,
    ) -> Result<TaskBoardFacts, RequestAdmissionClosed> {
        let (reply, reply_rx) = self.reply_channel();
        self.send_query(OrganizationQuery::TaskBoardRead {
                team_id,
                run_id,
                reply,
            })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub(crate) async fn task_board_mutate(
        &self,
        team_id: TeamId,
        run_id: GraphRunId,
        operation: crate::application::task_board::TaskBoardMutation,
    ) -> Result<
        Result<crate::application::task_board::MutationResult, crate::application::task_board::MutationError>,
        RequestAdmissionClosed,
    > {
        let (reply, reply_rx) = self.reply_channel();
        self.send_command(OrganizationCommand::TaskBoardMutate {
                team_id,
                run_id,
                operation,
                reply,
            })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn pending_approvals(
        &self,
        team_id: TeamId,
        run_id: GraphRunId,
    ) -> Result<organization::run::TeamPendingApprovalsQueryOutcome, RequestAdmissionClosed> {
        let (reply, reply_rx) = self.reply_channel();
        self.send_query(OrganizationQuery::PendingApprovals {
                team_id,
                run_id,
                reply,
            })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub async fn resume(
        &self,
        team_id: TeamId,
    ) -> Result<Vec<ResumeOutcome>, RequestAdmissionClosed> {
        let (reply, reply_rx) = self.reply_channel();
        self.send_query(OrganizationQuery::Resume { team_id, reply })
            .await
            .map_err(closed)?;
        self.call_admitted().await;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub(crate) async fn native_delivery_by_run(
        &self,
        identity: platform::endpoint::runtime_address::SessionIdentity,
        resolver: Arc<dyn crate::RoleSessionIdentityResolver>,
        native_run_id: String,
    ) -> Result<Option<DeliveryId>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.send_query(OrganizationQuery::NativeDeliveryByRun {
                identity,
                resolver,
                native_run_id,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub(crate) async fn schedule_ready_nodes(
        &self,
        run_id: GraphRunId,
        now: u64,
    ) -> Result<Result<Vec<ActivityId>, StoreFault>, RequestAdmissionClosed> {
        let wake_run_id = run_id.clone();
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.send_command(OrganizationCommand::ScheduleReadyNodes { run_id, now, reply })
            .await
            .map_err(closed)?;
        let (outcome, changed) = reply_rx.await.map_err(|_| closed_error())?;
        if changed {
            self.publish_team_run_wake(
                TeamRunWakeReason::SchedulerObservationChanged,
                Some(wake_run_id),
            );
        }
        Ok(outcome)
    }

    pub(crate) async fn claim_activity(
        &self,
        run_id: GraphRunId,
        activity_id: ActivityId,
        claimed_at: u64,
    ) -> Result<Result<TeamRunActivityStart, TeamRunActivityError>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.send_command(OrganizationCommand::ClaimActivity {
                run_id,
                activity_id,
                claimed_at,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub(crate) async fn admit_activity_dispatch(
        &self,
        run_id: GraphRunId,
        claim: ActivityClaim,
        request: crate::ActivityExecutionRequest,
    ) -> Result<Result<bool, StoreFault>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.send_command(OrganizationCommand::AdmitActivityDispatch {
            run_id, claim, request, reply,
        }).await.map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub(crate) async fn settle_activity(
        &self,
        run_id: GraphRunId,
        claim: ActivityClaim,
        outcome: ActivityExecutionOutcome,
        observed_at: u64,
    ) -> Result<Result<TeamRunActivityOutcome, TeamRunActivityError>, RequestAdmissionClosed> {
        let wake_run_id = run_id.clone();
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.send_command(OrganizationCommand::SettleActivity {
                run_id,
                claim,
                outcome,
                observed_at,
                reply,
            })
            .await
            .map_err(closed)?;
        let outcome = reply_rx.await.map_err(|_| closed_error())?;
        if outcome.is_ok() {
            self.publish_team_run_wake(TeamRunWakeReason::SchedulerObservationChanged, Some(wake_run_id));
        }
        Ok(outcome)
    }

    async fn validate_team_message_files(
        &self,
        identity: platform::endpoint::runtime_address::SessionIdentity,
        resolver: Arc<dyn crate::RoleSessionIdentityResolver>,
        native_run_id: String, delivery_context: Option<(DeliveryId, crate::EndpointSessionId)>,
        native_request_id: Option<String>,
        assistant_texts: Vec<String>,
    ) -> Result<Result<Option<(crate::run::workspace::RunFileValidationPlan, Result<(), crate::RunFileValidationError>)>, StoreFault>, RequestAdmissionClosed> {
        let (reply, receiver) = tokio::sync::oneshot::channel();
        self.send_query(OrganizationQuery::TeamMessageFileValidation {
            identity, resolver, native_run_id, delivery_context, native_request_id, assistant_texts, reply,
        }).await.map_err(closed)?;
        let plan = match receiver.await.map_err(|_| closed_error())? {
            Ok(plan) => plan,
            Err(error) => return Ok(Err(error)),
        };
        let Some(plan) = plan else { return Ok(Ok(None)); };
        let outcome = match self.runtime_directory.as_ref().and_then(|directory| directory.team_runtime_for_endpoint(plan.binding.endpoint())) {
            Some(runtime) => runtime.validate_run_files(plan.binding.clone(), plan.workspace.clone(), plan.paths.clone(), self.cancellation.clone()).await,
            None => Err(crate::RunFileValidationError::Unavailable),
        };
        Ok(Ok(Some((plan, outcome))))
    }

    pub(crate) async fn team_message_terminal_observed(
        &self,
        identity: platform::endpoint::runtime_address::SessionIdentity,
        resolver: Arc<dyn crate::RoleSessionIdentityResolver>,
        native_run_id: String,
        delivery_context: Option<(DeliveryId, crate::EndpointSessionId)>,
        status: organization::NativeTerminalStatus,
        assistant_texts: Result<Vec<String>, ()>,
        settled_at: u64,
        task_observation: crate::task_execution::TaskNativeObservation,
    ) -> Result<
        Result<organization::TeamMessageTerminalObservation, StoreFault>,
        RequestAdmissionClosed,
    > {
        let native_run_hash = platform::trace::enabled().then(|| platform::trace::identifier_hash(&native_run_id));
        let mut assistant_texts = assistant_texts.map_err(|()| crate::application::team_message::TeamMessageFailure::ResultReadFailed);
        let file_validation = if status == organization::NativeTerminalStatus::Completed
            && let Ok(assistant_texts) = &assistant_texts
        {
            match self.validate_team_message_files(
                identity.clone(), resolver.clone(), native_run_id.clone(), delivery_context.clone(), task_observation.native_request_id.clone(), assistant_texts.clone(),
            ).await? {
                Ok(validation) => validation,
                Err(error) => return Ok(Err(error)),
            }
        } else {
            None
        };
        use super::terminal_settlement::TerminalObservationOutcome;
        let mut inspection = None;
        let outcome = loop {
            let recheck = inspection.is_some();
            let (reply, reply_rx) = tokio::sync::oneshot::channel();
            self.send_command(OrganizationCommand::TeamMessageTerminalObserved {
                identity: identity.clone(),
                resolver: resolver.clone(),
                file_validation: file_validation.clone(),
                task_observation: task_observation.clone(),
                inspection: inspection.take(),
                native_run_id: native_run_id.clone(),
                delivery_context: delivery_context.clone(),
                status,
                assistant_texts: std::mem::replace(&mut assistant_texts, Ok(Vec::new())),
                settled_at,
                reply,
            }).await.map_err(|error| {
                platform::trace::runtime_trace("runtime.team_run.terminal.wake", || serde_json::json!({
                    "nativeRunHash": native_run_hash, "published": false, "error": "admission_closed",
                }));
                closed(error)
            })?;
            match reply_rx.await.map_err(|_| {
                platform::trace::runtime_trace("runtime.team_run.terminal.wake", || serde_json::json!({
                    "nativeRunHash": native_run_hash, "published": false, "error": "reply_closed",
                }));
                closed_error()
            })? {
                Ok(TerminalObservationOutcome::Observed(outcome)) => break Ok(outcome),
                Ok(TerminalObservationOutcome::Inspect { request, assistant_texts: retained }) => {
                    if recheck { return Ok(Err(StoreFault::InvalidFacts)); }
                    assistant_texts = retained;
                    let Some(executor) = self.activity_executor.get() else { return Ok(Err(StoreFault::InvalidFacts)); };
                    let inspected = executor.inspect_cancellable(request.clone(), self.cancellation.clone()).await;
                    let crate::task_execution::TaskActivityInspection::Found { execution, phase, .. } = inspected else {
                        return Ok(Err(StoreFault::InvalidFacts));
                    };
                    if !matches!((status, phase),
                        (organization::NativeTerminalStatus::Completed, crate::task_execution::TaskNativePhase::Completed)
                        | (organization::NativeTerminalStatus::Failed, crate::task_execution::TaskNativePhase::Failed)
                        | (organization::NativeTerminalStatus::Cancelled, crate::task_execution::TaskNativePhase::Cancelled)
                        | (organization::NativeTerminalStatus::Interrupted, crate::task_execution::TaskNativePhase::Interrupted))
                    {
                        return Ok(Err(StoreFault::InvalidFacts));
                    }
                    inspection = Some((request, execution));
                }
                Err(error) => break Err(error),
            }
        };
        let published = matches!(
            &outcome,
            Ok(organization::TeamMessageTerminalObservation::Settled
                | organization::TeamMessageTerminalObservation::Repair(_))
        );
        if published {
            self.publish_team_run_wake(TeamRunWakeReason::TerminalSettled, None);
        }
        platform::trace::runtime_trace("runtime.team_run.terminal.wake", || serde_json::json!({
            "nativeRunHash": native_run_hash, "published": published, "reason": "terminal_settled",
            "error": outcome.as_ref().err().map(crate::trace::terminal_error),
        }));
        Ok(outcome)
    }

    pub(crate) async fn has_pending_team_message_repairs(
        &self,
    ) -> Result<bool, RequestAdmissionClosed> {
        let (reply, receiver) = tokio::sync::oneshot::channel();
        self.send_query(OrganizationQuery::PendingTeamMessageRepairs { reply })
            .await
            .map_err(closed)?;
        receiver.await.map_err(|_| closed_error())
    }

    pub(crate) async fn team_message_repair_queued(
        &self,
        identity: platform::endpoint::runtime_address::SessionIdentity,
        requested_run_id: String,
        repair: organization::TeamMessageRepairDispatch,
    ) -> Result<(), RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.send_command(OrganizationCommand::TeamMessageRepairQueued {
                identity,
                requested_run_id,
                repair,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub(crate) async fn team_message_repair_rejected(
        &self,
        identity: platform::endpoint::runtime_address::SessionIdentity,
        repair: organization::TeamMessageRepairDispatch,
    ) -> Result<Result<(), StoreFault>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.send_command(OrganizationCommand::TeamMessageRepairRejected { identity, repair, reply })
            .await
            .map_err(closed)?;
        let outcome = reply_rx.await.map_err(|_| closed_error())?;
        if outcome.is_ok() {
            self.publish_team_run_wake(TeamRunWakeReason::RepairRejected, None);
        }
        Ok(outcome)
    }

    pub(crate) async fn native_run_settled(
        &self,
        identity: platform::endpoint::runtime_address::SessionIdentity,
        resolver: Arc<dyn crate::RoleSessionIdentityResolver>,
        run_id: GraphRunId,
        delivery_id: DeliveryId,
        settled: NativeRunSettled,
        settled_at: u64,
    ) -> Result<Result<crate::store::NativeTerminalSettlement, StoreFault>, RequestAdmissionClosed>
    {
        let file_validation = if settled.status == organization::NativeTerminalStatus::Completed {
            if let Some(target) = self.native_terminal_target(delivery_id.clone()).await? {
                if target.graph_run_id() != &run_id { return Ok(Err(StoreFault::InvalidFacts)); }
                match self.validate_team_message_files(
                    identity, resolver,
                    target.correlation().native_run_receipt().as_str().to_owned(),
                    Some((delivery_id.clone(), target.correlation().endpoint_session_id().clone())),
                    None, settled.final_assistant_text.iter().cloned().collect(),
                ).await? { Ok(validation) => validation, Err(error) => return Ok(Err(error)) }
            } else { None }
        } else { None };
        let wake_run_id = run_id.clone();
        let wake_reason = if settled.status == organization::NativeTerminalStatus::Cancelled {
            TeamRunWakeReason::RunCancelled
        } else {
            TeamRunWakeReason::NativeRunSettled
        };
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.send_command(OrganizationCommand::NativeRunSettled {
                file_validation,
                run_id,
                delivery_id,
                settled,
                settled_at,
                reply,
            })
            .await
            .map_err(closed)?;
        let outcome = reply_rx.await.map_err(|_| closed_error())?;
        if outcome.is_ok() {
            self.publish_team_run_wake(wake_reason, Some(wake_run_id));
        }
        Ok(outcome)
    }

    /// Resolves the owning delivery by complete session identity and native run id.
    pub(crate) async fn team_message_terminal_context(
        &self,
        identity: platform::endpoint::runtime_address::SessionIdentity,
        resolver: Arc<dyn crate::RoleSessionIdentityResolver>,
        native_run_id: String,
    ) -> Result<Option<organization::TeamMessageTerminalContext>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.send_query(OrganizationQuery::TeamMessageTerminalContext {
                identity,
                resolver,
                native_run_id,
                reply,
            })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub(crate) async fn native_run_settled_by_native_run_id(
        &self,
        identity: platform::endpoint::runtime_address::SessionIdentity,
        resolver: Arc<dyn crate::RoleSessionIdentityResolver>,
        native_run_id: String,
        settled: NativeRunSettled,
        settled_at: u64,
    ) -> Result<(), RequestAdmissionClosed> {
        let Some(delivery_id) = self.native_delivery_by_run(identity.clone(), resolver.clone(), native_run_id).await? else {
            return Ok(());
        };
        let Some(target) = self.native_terminal_target(delivery_id.clone()).await? else {
            return Ok(());
        };
        let _ = self
            .native_run_settled(
                identity,
                resolver,
                target.graph_run_id().clone(),
                delivery_id,
                settled,
                settled_at,
            )
            .await?;
        Ok(())
    }

    pub async fn recover_materialization_receipts(&self) -> Result<(), RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.send_command(OrganizationCommand::RecoverMaterializationReceipts { reply })
            .await
            .map_err(closed)?;
        let plan = reply_rx.await.map_err(|_| closed_error())?;
        let items = plan.teams.into_iter().map(|(team, request, removal)| (team, request, removal, None))
            .chain(plan.runs.into_iter().map(|(team, run)| (team, None, None, Some(run)))).collect();
        let outcomes = foundation::pipeline::map_concurrent(4, items, |(team_id, materialization, removal, run_id)| -> BoxFuture<'_, _> {
            // The pipeline moves this item future through its indexed/unordered stream.
            crate::future::boxed(move || async move {
                let outcome = async {
                    let native_slot = if run_id.is_some() { Some(self.native_operation_slot(false).await?) } else { None };
                    let lock = self.native_team(&team_id);
                    let guard = tokio::select! {
                        biased;
                        _ = self.cancellation.cancelled() => return Ok(()),
                        guard = lock.read_owned() => guard,
                    };
                    let (reply, receiver) = tokio::sync::oneshot::channel();
                    let command = match run_id {
                        Some(run_id) => OrganizationCommand::RecoverRoleSessions {
                            native_slot: native_slot.expect("role recovery slot"),
                            run_id, guard: guard.into(), cancellation: self.cancellation.clone(), reply,
                        },
                        None => OrganizationCommand::RecoverTeamReceipts {
                            team_id, materialization, removal, guard, cancellation: self.cancellation.clone(), reply,
                        },
                    };
                    self.send_command(command).await.map_err(closed)?;
                    receiver.await.map_err(|_| closed_error())
                }.await;
                Ok::<_, foundation::pipeline::PipelineError>(outcome)
            })
        }).await.map_err(|_| closed_error())?;
        for outcome in outcomes { outcome?; }
        Ok(())
    }

    pub(crate) async fn active_run_ids(&self) -> Result<Vec<GraphRunId>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.send_query(OrganizationQuery::ActiveRunIds { reply })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }

    pub(crate) async fn workflow_run_team(
        &self,
        run_id: GraphRunId,
    ) -> Result<Option<TeamId>, RequestAdmissionClosed> {
        let (reply, receiver) = tokio::sync::oneshot::channel();
        self.send_query(OrganizationQuery::WorkflowRunTeam { run_id, reply })
            .await
            .map_err(closed)?;
        receiver.await.map_err(|_| closed_error())
    }

    pub(crate) async fn native_terminal_target(
        &self,
        delivery_id: DeliveryId,
    ) -> Result<Option<NativeTerminalReceiptTarget>, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.send_query(OrganizationQuery::MatchaTerminalTarget { delivery_id, reply })
            .await
            .map_err(closed)?;
        reply_rx.await.map_err(|_| closed_error())
    }
}

fn execute_team_runtime(
    owner: &OrganizationHandle,
    command: TeamRuntimeCommand,
) -> BoxFuture<'_, Option<TeamRuntimeCommandOutcome>> {
    // Select before constructing a future so unrelated operations never share one poll frame.
    match command {
        TeamRuntimeCommand::RoleSessionCreate { team_id, run_id, role_id, idempotency_key, endpoint } => crate::future::boxed(move || async move {
            use crate::application::team_runtime::{RoleSessionCreateError, RoleSessionCreateScope};
            let result = owner.create_role_session(team_id, run_id, role_id, idempotency_key,
                RoleSessionCreateScope::Runtime(endpoint)).await.ok()?;
            Some(TeamRuntimeCommandOutcome::RoleSessionCreate(result.map_err(|error| match error {
                RoleSessionCreateError::Store(error) => super::role_session::store_status(error),
                RoleSessionCreateError::Runtime(status) => status,
            })))
        }),
        TeamRuntimeCommand::Design { .. } => crate::future::boxed(move || async move {
            Some(TeamRuntimeCommandOutcome::Design {
                read: false,
                result: Err(StoreFault::InvalidFacts),
            })
        }),
        TeamRuntimeCommand::PackageValidate { package_root } => crate::future::boxed(move || async move {
            Some(TeamRuntimeCommandOutcome::PackageValidate(
                owner.team_skill_validate(package_root).await.ok()?,
            ))
        }),
        TeamRuntimeCommand::DependencyPlan { package_root, endpoint, source_agent } => crate::future::boxed(move || async move {
            let selection = owner.team_skill_authorize(package_root).await.ok()?;
            Some(TeamRuntimeCommandOutcome::DependencyPlan(match selection {
                Ok(selection) => owner.team_skill_selection_dependency_plan(selection, endpoint, source_agent).await.ok()?,
                Err(TeamSkillSelectionError::InvalidSelection) => TeamSkillDependencyPlanResult::Invalid,
                Err(TeamSkillSelectionError::Unavailable) => TeamSkillDependencyPlanResult::Unavailable,
            }))
        }),
        TeamRuntimeCommand::ProvisionAgents {
            package_root,
            team_id: Some(team_id),
            idempotency_key,
            endpoint,
            source_agent,
            source: TeamRuntimeCreateSource::TeamSkill,
            manual_team: None,
        } => crate::future::boxed(move || async move {
            let selection_id = match owner.team_skill_authorize(package_root).await.ok()? {
                Ok(selection_id) => selection_id,
                Err(TeamSkillSelectionError::InvalidSelection) => {
                    return Some(TeamRuntimeCommandOutcome::ProvisionAgents(
                        TeamMaterializationCommandOutcome::Rejected,
                    ));
                }
                Err(TeamSkillSelectionError::Unavailable) => {
                    return Some(TeamRuntimeCommandOutcome::ProvisionAgents(
                        TeamMaterializationCommandOutcome::Unavailable,
                    ));
                }
            };
            Some(TeamRuntimeCommandOutcome::ProvisionAgents(
                owner
                    .team_skill_materialize(selection_id, endpoint, source_agent, team_id, idempotency_key)
                    .await
                    .ok()?,
            ))
        }),
        TeamRuntimeCommand::ProvisionAgents {
            team_id: Some(team_id),
            idempotency_key,
            source: TeamRuntimeCreateSource::Manual,
            manual_team: Some(manual_team),
            ..
        } => crate::future::boxed(move || async move {
            Some(TeamRuntimeCommandOutcome::ProvisionAgents(
                owner
                    .manual_team_materialize(
                        team_id,
                        manual_team.team_name,
                        manual_team.roles,
                        idempotency_key,
                    )
                    .await
                    .ok()?,
            ))
        }),
        TeamRuntimeCommand::ProvisionAgents { .. } => crate::future::boxed(move || async move {
            Some(TeamRuntimeCommandOutcome::ProvisionAgents(TeamMaterializationCommandOutcome::Rejected))
        }),
        TeamRuntimeCommand::Delete {
            team_id,
            idempotency_key,
            observed_at,
        } => crate::future::boxed(move || async move {
            Some(TeamRuntimeCommandOutcome::Delete(
                owner
                    .team_delete(team_id, idempotency_key, observed_at)
                    .await
                    .ok()?,
            ))
        }),
        TeamRuntimeCommand::RunCreate {
            team_id,
            package_root,
            endpoint,
            source_agent,
            run_id,
            idempotency_key,
            source,
        } => {
            let failed = |status, reason| TeamRuntimeCommandOutcome::RunCreate {
                workspace: None,
                result: Err(status),
                creation_failure: Some(crate::TeamCreationFailure::new(
                    crate::TeamCreationStage::InitializingSessions, reason,
                )),
            };
            match source {
                TeamRuntimeCreateSource::TeamSkill => crate::future::boxed(move || async move {
                    let run_id = run_id.unwrap_or_else(|| {
                        GraphRunId::new(format!("team-run:{}", idempotency_key.as_str()))
                    });
                    let selection_id = match owner.team_skill_authorize(package_root).await.ok()? {
                        Ok(selection_id) => selection_id,
                        Err(TeamSkillSelectionError::InvalidSelection) => {
                            return Some(failed(TeamRuntimeStatus::Rejected, crate::TeamCreationFailureReason::InvalidInput));
                        }
                        Err(TeamSkillSelectionError::Unavailable) => {
                            return Some(failed(TeamRuntimeStatus::Unavailable, crate::TeamCreationFailureReason::Unavailable));
                        }
                    };
                    let team_id = match team_id {
                        Some(team_id) => team_id,
                        None => match owner
                            .team_skill_selection_validate(selection_id.clone())
                            .await
                            .ok()?
                        {
                            TeamSkillPackageValidation::Valid { package } => {
                                match TeamId::try_new(package.name().to_owned()) {
                                    Ok(team_id) => team_id,
                                    Err(_) => return Some(failed(TeamRuntimeStatus::Rejected, crate::TeamCreationFailureReason::InvalidInput)),
                                }
                            }
                            TeamSkillPackageValidation::Invalid => {
                                return Some(failed(TeamRuntimeStatus::Rejected, crate::TeamCreationFailureReason::InvalidInput));
                            }
                            TeamSkillPackageValidation::Unavailable => {
                                return Some(failed(TeamRuntimeStatus::Unavailable, crate::TeamCreationFailureReason::Unavailable));
                            }
                        },
                    };
                    Some(match owner
                        .team_skill_materialize(
                            selection_id,
                            endpoint,
                            source_agent,
                            team_id.clone(),
                            idempotency_key.clone(),
                        )
                        .await
                        .ok()?
                    {
                        TeamMaterializationCommandOutcome::Materialized { .. } => {
                            let (result, creation_failure, workspace) = owner
                                .run_create_from_team_template(team_id, run_id, idempotency_key, now_millis())
                                .await.ok()?;
                            TeamRuntimeCommandOutcome::RunCreate {
                                workspace, result, creation_failure,
                            }
                        }
                        outcome => {
                            let status = team_materialization_status(outcome);
                            let reason = match &status {
                                TeamRuntimeStatus::Rejected => crate::TeamCreationFailureReason::Rejected,
                                TeamRuntimeStatus::Unavailable => crate::TeamCreationFailureReason::Unavailable,
                                TeamRuntimeStatus::OutcomeUnknown => crate::TeamCreationFailureReason::OutcomeUnknown,
                            };
                            failed(status, reason)
                        }
                    })
                }),
                TeamRuntimeCreateSource::Manual => crate::future::boxed(move || async move {
                    let run_id = run_id.unwrap_or_else(|| {
                        GraphRunId::new(format!("team-run:{}", idempotency_key.as_str()))
                    });
                    let Some(team_id) = team_id else {
                        return Some(failed(TeamRuntimeStatus::Rejected, crate::TeamCreationFailureReason::InvalidInput));
                    };
                    let (result, creation_failure, workspace) = owner
                        .run_create_from_team_template(team_id, run_id, idempotency_key, now_millis())
                        .await.ok()?;
                    Some(TeamRuntimeCommandOutcome::RunCreate {
                        workspace, result, creation_failure,
                    })
                }),
            }
        },
        TeamRuntimeCommand::RunList { team_id } => crate::future::boxed(move || async move {
            Some(TeamRuntimeCommandOutcome::RunList(owner.run_list(team_id).await.ok()?))
        }),
        TeamRuntimeCommand::TriggerList { team_id } => crate::future::boxed(move || async move {
            Some(TeamRuntimeCommandOutcome::TriggerList(owner.trigger_list(team_id).await.ok()?))
        }),
        TeamRuntimeCommand::WebhookTriggerFire {
            webhook_path,
            idempotency_key,
            fired_at,
        } => crate::future::boxed(move || async move {
            Some(TeamRuntimeCommandOutcome::WebhookTriggerFire(
                owner
                    .webhook_trigger_fire(webhook_path, idempotency_key, fired_at)
                    .await
                    .ok()?,
            ))
        }),
        TeamRuntimeCommand::RunSnapshot {
            team_id,
            run_id,
            event_cursor,
            event_limit,
            message_cursor,
        } => crate::future::boxed(move || async move {
            Some(match owner
                .team_run_public_snapshot(team_id, run_id, event_cursor, event_limit, message_cursor)
                .await
                .ok()?
            {
                (Some(snapshot), creation_failure, role_sessions) => {
                    TeamRuntimeCommandOutcome::RunSnapshot {
                        snapshot,
                        role_sessions,
                        creation_failure,
                    }
                }
                (None, creation_failure, _) => TeamRuntimeCommandOutcome::RunSnapshotInvalidInput { creation_failure },
            })
        }),
        TeamRuntimeCommand::NodeReviewHistory { team_id, run_id, node_id, query } => crate::future::boxed(move || async move {
            Some(TeamRuntimeCommandOutcome::NodeReviewHistory(
                owner.node_review_history(team_id, run_id, node_id, query).await.ok()?,
            ))
        }),
        TeamRuntimeCommand::GraphSave {
            command,
            definition,
        } => crate::future::boxed(move || async move {
            Some(TeamRuntimeCommandOutcome::GraphSave(owner.graph_save(*command, definition).await.ok()?))
        }),
        TeamRuntimeCommand::GraphPatch { patch } => crate::future::boxed(move || async move {
            Some(TeamRuntimeCommandOutcome::GraphPatch(owner.graph_patch(patch).await.ok()?))
        }),
        TeamRuntimeCommand::GraphContext {
            team_id,
            run_id,
            view,
            node_execution_id,
        } => crate::future::boxed(move || async move {
            let outcome = if let Some(team_id) = team_id {
                match TeamGraphContextQuery::new(team_id, run_id, view, node_execution_id) {
                    Ok(query) => owner
                        .graph_context(query)
                        .await
                        .unwrap_or(TeamGraphContextResult::Unavailable),
                    Err(_) => TeamGraphContextResult::Unavailable,
                }
            } else {
                TeamGraphContextResult::Unavailable
            };
            Some(TeamRuntimeCommandOutcome::GraphContext(outcome))
        }),
        TeamRuntimeCommand::GraphExportYaml { run_id } => crate::future::boxed(move || async move {
            let outcome = owner
                .graph_yaml(run_id)
                .await
                .ok()?
                .ok_or(TeamRuntimeStatus::Unavailable);
            Some(TeamRuntimeCommandOutcome::GraphExportYaml(outcome))
        }),
        TeamRuntimeCommand::GraphImportYaml {
            command,
            definition,
        } => crate::future::boxed(move || async move {
            Some(TeamRuntimeCommandOutcome::GraphImportYaml(
                owner.graph_save(*command, definition).await.ok()?,
            ))
        }),
        TeamRuntimeCommand::TriggerFire { request, fired_at } => crate::future::boxed(move || async move {
            Some(TeamRuntimeCommandOutcome::TriggerFire(
                owner.trigger_fire(request, fired_at).await.ok()?,
            ))
        }),
        TeamRuntimeCommand::RunStart { team_id, run_id, epoch, version } => crate::future::boxed(move || async move {
            Some(TeamRuntimeCommandOutcome::RunStart(owner.run_start(team_id, run_id, epoch, version).await.ok()?))
        }),
        TeamRuntimeCommand::RunReworkContinue { request } => crate::future::boxed(move || async move {
            Some(TeamRuntimeCommandOutcome::RunReworkContinue(owner.continue_rework(request).await.ok()?))
        }),
        TeamRuntimeCommand::NodePromptRetryDue { run_id } => crate::future::boxed(move || async move {
            Some(TeamRuntimeCommandOutcome::NodePromptRetryDue(
                owner.node_prompt_retry_due(run_id).await.ok()?,
            ))
        }),
        TeamRuntimeCommand::NodeEvent {
            run_id,
            node_execution_id,
            event,
            summary,
            role_id,
            requested_action,
            approval_submission,
            idempotency_key,
            terminal_resolution,
            output_port,
        } => crate::future::boxed(move || async move {
            Some(TeamRuntimeCommandOutcome::NodeEvent(
                execute_team_node_event(
                    owner,
                    run_id,
                    node_execution_id,
                    event,
                    summary,
                    role_id,
                    requested_action,
                    approval_submission,
                    idempotency_key,
                    terminal_resolution,
                    output_port,
                )
                .await,
            ))
        }),
        TeamRuntimeCommand::RunDiagnostics { run_id } => crate::future::boxed(move || async move {
            Some(TeamRuntimeCommandOutcome::RunDiagnostics(
                owner.team_run_diagnostics(run_id).await.ok()?,
            ))
        }),
        TeamRuntimeCommand::RunDecisionSubmit {
            run_id,
            decision,
            note,
            idempotency_key,
            resolved_at,
        } => crate::future::boxed(move || async move {
            let command = TeamDecisionCommand::try_new(
                format!("team-decision-{}", idempotency_key.as_str()),
                run_id.as_str().to_owned(),
                "run",
                decision,
                note,
                idempotency_key.as_str().to_owned(),
                resolved_at,
            );
            Some(TeamRuntimeCommandOutcome::RunDecisionSubmit(match command {
                Ok(command) => owner
                    .decision_submit(command)
                    .await
                    .ok()?
                    .map_err(|_| TeamRuntimeStatus::Unavailable),
                Err(_) => Err(TeamRuntimeStatus::Rejected),
            }))
        }),
        TeamRuntimeCommand::Resume { team_id } => crate::future::boxed(move || async move {
            let outcomes = owner.resume(team_id.clone()).await.ok()?;
            let runs = owner.run_list(team_id.clone()).await.ok()?;
            Some(TeamRuntimeCommandOutcome::Resume {
                team_id,
                outcomes,
                runs,
            })
        }),
        TeamRuntimeCommand::ApprovalResolve { command } => crate::future::boxed(move || async move {
            Some(TeamRuntimeCommandOutcome::ApprovalResolve(owner.approval_resolve(command).await.ok()?))
        }),
        TeamRuntimeCommand::RunCancel {
            run_id,
            idempotency_key,
            requested_at,
        } => crate::future::boxed(move || async move {
            Some(TeamRuntimeCommandOutcome::RunCancel(
                owner
                    .run_cancel(run_id, idempotency_key.as_str().to_owned(), requested_at)
                    .await
                    .ok()?,
            ))
        }),
        TeamRuntimeCommand::RunDelete {
            run_id,
            idempotency_key,
            tombstoned_at,
        } => crate::future::boxed(move || async move {
            Some(TeamRuntimeCommandOutcome::RunDelete(
                owner
                    .run_delete_and_purge(run_id, idempotency_key.as_str().to_owned(), tombstoned_at)
                    .await
                    .ok()?,
            ))
        }),
    }
}

async fn execute_team_node_event(
    owner: &OrganizationHandle,
    run_id: GraphRunId,
    node_execution_id: OpaqueId,
    event: OpaqueId,
    summary: String,
    role_id: Option<OpaqueId>,
    requested_action: Option<String>,
    approval_submission: Option<crate::run::approval::ApprovalSubmission>,
    idempotency_key: IdempotencyKey,
    terminal_resolution: Option<TeamNodeTerminalResolution>,
    output_port: Option<String>,
) -> Result<TeamNodeEventCommandOutcome, TeamRuntimeStatus> {
    if matches!(event.as_str(), "complete" | "reject") {
        let Some(terminal) = terminal_resolution else {
            return Err(TeamRuntimeStatus::Rejected);
        };
        return owner
            .node_terminal_resolve(
                run_id,
                node_execution_id,
                event.as_str().to_owned(),
                Some(terminal),
                summary,
                output_port,
                idempotency_key.as_str().to_owned(),
                now_millis(),
            )
            .await
            .map_err(|_| TeamRuntimeStatus::Unavailable)?
            .map(TeamNodeEventCommandOutcome::Terminal)
            .map_err(|_| TeamRuntimeStatus::Unavailable);
    }
    let event = match event.as_str() {
        "progress" => TeamNodeEvent::progress(node_execution_id, role_id),
        "request_input" => TeamNodeEvent::request_input(node_execution_id, role_id),
        "request_approval" => match requested_action.as_deref().and_then(team_approval_action) {
            Some(action) => TeamNodeEvent::request_approval(node_execution_id, role_id, action)
                .with_approval_submission(approval_submission.ok_or(TeamRuntimeStatus::Rejected)?),
            None => return Err(TeamRuntimeStatus::Rejected),
        },
        _ => return Err(TeamRuntimeStatus::Rejected),
    };
    let command_id = bounded_team_node_event_command_id(idempotency_key.as_str())?;
    let event = organization::TeamNodeEventProducer::non_terminal(
        OpaqueId::try_new(run_id.as_str()).map_err(|_| TeamRuntimeStatus::Rejected)?,
        command_id,
        OpaqueId::try_new(idempotency_key.as_str().to_owned())
            .map_err(|_| TeamRuntimeStatus::Rejected)?,
        event,
        now_millis(),
    )
    .map_err(|_| TeamRuntimeStatus::Rejected)?;
    let (command, event) = event.into_parts();
    owner
        .node_event(command, event)
        .await
        .map_err(|_| TeamRuntimeStatus::Unavailable)?
        .map(TeamNodeEventCommandOutcome::NonTerminal)
        .map_err(|_| TeamRuntimeStatus::Unavailable)
}

fn team_approval_action(value: &str) -> Option<organization::ApprovalAction> {
    match value {
        "continue_node" => Some(organization::ApprovalAction::ContinueNode),
        "execute_tool" => Some(organization::ApprovalAction::ExecuteTool),
        "publish_result" => Some(organization::ApprovalAction::PublishResult),
        "external_action" => Some(organization::ApprovalAction::ExternalAction),
        _ => None,
    }
}

fn team_materialization_status(outcome: TeamMaterializationCommandOutcome) -> TeamRuntimeStatus {
    match outcome {
        TeamMaterializationCommandOutcome::Materialized { .. } => TeamRuntimeStatus::OutcomeUnknown,
        TeamMaterializationCommandOutcome::Rejected => TeamRuntimeStatus::Rejected,
        TeamMaterializationCommandOutcome::OutcomeUnknown => TeamRuntimeStatus::OutcomeUnknown,
        TeamMaterializationCommandOutcome::Unavailable => TeamRuntimeStatus::Unavailable,
    }
}

fn bounded_team_node_event_command_id(
    idempotency_key: &str,
) -> Result<OpaqueId, TeamRuntimeStatus> {
    let candidate = format!("team-node-event:{idempotency_key}");
    if let Ok(command_id) = OpaqueId::try_new(candidate) {
        return Ok(command_id);
    }

    use sha2::{Digest, Sha256};
    use std::fmt::Write as _;

    let digest = Sha256::digest(idempotency_key.as_bytes());
    let mut value = String::with_capacity("team-node-event".len() + 65);
    value.push_str("team-node-event");
    value.push(':');
    for byte in digest {
        write!(&mut value, "{byte:02x}").expect("writing to String cannot fail");
    }
    OpaqueId::try_new(value).map_err(|_| TeamRuntimeStatus::Rejected)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .unwrap_or(u64::MAX)
}

fn closed(_error: foundation::execution::OwnerRuntimeSendError) -> RequestAdmissionClosed {
    closed_error()
}

pub(crate) fn closed_error() -> RequestAdmissionClosed {
    RequestAdmissionClosed::new(OrganizationPhase::ShutDown)
}
