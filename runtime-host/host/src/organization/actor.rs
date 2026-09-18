use std::{
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use foundation::execution::{CommandRoute, LaneRetention, OwnerSpec, QueryRoute};
use organization::{
    ActivityId, BeginCancellationOutcome, CreateGraphRunOutcome, DeliveryId, GraphRunId,
    GraphRunLifecycleState, IdempotencyKey, MaterializationRecordOutcome, NativeDeletionEvidence,
    NativeTerminalReceiptTarget, NativeTerminalStatus, OrganizationStore, RoleAbortOutcome,
    RuntimeEndpointReference, StoreFault, TeamId,
    package::{
        TeamSkillDependencyCatalog, TeamSkillDependencyPlanResult, TeamSkillPackageValidation,
        TeamSkillSelectionError, TeamSkillSelectionId, TeamSkillSelectionResolver,
    },
    run::scheduler::{
        NodePromptRetryDueInvalidReason, NodePromptRetryDueQuery, NodePromptRetryDueQueryOutcome,
    },
};

use crate::{
    runtime::directory::RuntimeDriverDirectory,
    runtime::driver::{
        OwnedRuntimeFuture, RuntimeDriver, RuntimeDriverIdentity, RuntimeOperationFailure,
    },
};

use super::{
    OrganizationCommand, OrganizationQuery,
    team_run::{
        ManualTeamCreateOutcome, ManualTeamMaterializationInput, RuntimeReceiptOutcome,
        TeamDeleteOutcome, TeamMaterializationCommandOutcome, TeamRunActivityError,
        TeamRunActivityOutcome, TeamRunActivityStart, TeamRunActivityTarget, TeamRunOwner,
        TeamTriggerFireResolution, install_prepared_runtime_receipt, prepare_runtime_receipt,
        settle_public_cancellation,
    },
    team_runtime::TeamRuntimeStatus,
};

pub(crate) struct OrganizationOwnerInput {
    pub store: OrganizationStore,
    pub runtime_directory: Arc<RuntimeDriverDirectory>,
    pub team_skill_selections: TeamSkillSelectionResolver,
}

#[derive(Clone)]
pub(crate) struct OrganizationShared {
    runtime_directory: Arc<RuntimeDriverDirectory>,
    store_path: PathBuf,
}

pub(crate) struct OrganizationGlobalState {
    store: OrganizationStore,
    team_run: TeamRunOwner,
    team_skill_selections: TeamSkillSelectionResolver,
}

pub(crate) struct OrganizationRunLane {
    store_path: PathBuf,
    team_run: TeamRunOwner,
}

struct TeamSkillRuntime {
    driver: Arc<dyn RuntimeDriver>,
}

pub(crate) struct OrganizationOwner {
    shared: OrganizationShared,
    global: OrganizationGlobalState,
}

impl OrganizationOwner {
    pub fn new(input: OrganizationOwnerInput) -> Self {
        let store_path = input.store.path().to_owned();
        Self {
            shared: OrganizationShared {
                runtime_directory: input.runtime_directory,
                store_path: store_path.clone(),
            },
            global: OrganizationGlobalState {
                store: input.store,
                team_run: TeamRunOwner::new(),
                team_skill_selections: input.team_skill_selections,
            },
        }
    }

    pub(crate) const fn lane_retention() -> LaneRetention {
        LaneRetention::LowFrequency
    }
}

impl OrganizationShared {
    fn team_driver_for_endpoint(
        &self,
        endpoint: &RuntimeEndpointReference,
    ) -> Result<Arc<dyn RuntimeDriver>, RuntimeOperationFailure> {
        self.runtime_directory
            .all_drivers()
            .find(|driver| driver.identity().runtime_endpoint_reference() == endpoint.as_str())
            .ok_or(RuntimeOperationFailure::Unsupported)
    }

    fn team_driver_for_bindings(
        &self,
        bindings: &[organization::RoleSessionReceipt],
    ) -> Result<Arc<dyn RuntimeDriver>, RuntimeOperationFailure> {
        let first = bindings
            .first()
            .ok_or(RuntimeOperationFailure::Unsupported)?;
        if !bindings
            .iter()
            .all(|binding| binding.endpoint() == first.endpoint())
        {
            return Err(RuntimeOperationFailure::TargetRejected);
        }
        self.team_driver_for_endpoint(first.endpoint())
    }

    fn team_materialize(
        &self,
        request: organization::TeamMaterializationRequest,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        let driver = match self.team_driver_for_endpoint(request.intent().endpoint()) {
            Ok(driver) => driver,
            Err(RuntimeOperationFailure::TargetRejected) => {
                return Box::pin(async {
                    organization::MaterializationOperationOutcome::Rejected {
                        rejection: organization::MaterializationRejection::Permanent,
                    }
                });
            }
            Err(_) => {
                return Box::pin(async {
                    organization::MaterializationOperationOutcome::OutcomeUnknown
                });
            }
        };
        match driver.team_ops() {
            Some(ops) => ops.materialize_team(request),
            None => {
                Box::pin(async { organization::MaterializationOperationOutcome::OutcomeUnknown })
            }
        }
    }

    fn team_remove(
        &self,
        removal: organization::TeamMaterializationRemoval,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        let driver = match self.team_driver_for_endpoint(removal.receipt().endpoint()) {
            Ok(driver) => driver,
            Err(RuntimeOperationFailure::TargetRejected) => {
                return Box::pin(async {
                    organization::MaterializationOperationOutcome::Rejected {
                        rejection: organization::MaterializationRejection::Permanent,
                    }
                });
            }
            Err(_) => {
                return Box::pin(async {
                    organization::MaterializationOperationOutcome::OutcomeUnknown
                });
            }
        };
        match driver.team_ops() {
            Some(ops) => ops.remove_team(removal),
            None => {
                Box::pin(async { organization::MaterializationOperationOutcome::OutcomeUnknown })
            }
        }
    }

    fn team_confirm_receipt(
        &self,
        receipt: organization::RunRuntimeReceipt,
    ) -> OwnedRuntimeFuture<RuntimeReceiptOutcome> {
        let driver = match self.team_driver_for_bindings(receipt.bindings()) {
            Ok(driver) => driver,
            Err(RuntimeOperationFailure::TargetRejected) => {
                return Box::pin(async { RuntimeReceiptOutcome::Rejected });
            }
            Err(_) => return Box::pin(async { RuntimeReceiptOutcome::OutcomeUnknown }),
        };
        match driver.team_ops() {
            Some(ops) => ops.confirm_team_run_receipt(receipt),
            None => Box::pin(async { RuntimeReceiptOutcome::OutcomeUnknown }),
        }
    }

    fn team_abort_role_sessions(
        &self,
        bindings: Vec<organization::RoleSessionReceipt>,
    ) -> OwnedRuntimeFuture<RoleAbortOutcome> {
        let driver = match self.team_driver_for_bindings(&bindings) {
            Ok(driver) => driver,
            Err(_) => return Box::pin(async { RoleAbortOutcome::OutcomeUnknown }),
        };
        match driver.team_ops() {
            Some(ops) => ops.abort_role_sessions(bindings),
            None => Box::pin(async { RoleAbortOutcome::OutcomeUnknown }),
        }
    }

    fn team_delete_role_sessions(
        &self,
        run_id: GraphRunId,
        bindings: Vec<organization::RoleSessionReceipt>,
        abort_first: bool,
    ) -> OwnedRuntimeFuture<NativeDeletionEvidence> {
        let driver = match self.team_driver_for_bindings(&bindings) {
            Ok(driver) => driver,
            Err(_) => return Box::pin(async { NativeDeletionEvidence::OutcomeUnknown }),
        };
        match driver.team_ops() {
            Some(ops) => ops.delete_role_sessions(run_id, bindings, abort_first),
            None => Box::pin(async { NativeDeletionEvidence::OutcomeUnknown }),
        }
    }

    fn team_skill_runtime(&self) -> Option<TeamSkillRuntime> {
        self.runtime_directory
            .lookup(&RuntimeDriverIdentity::open_claw().endpoint())
            .map(|driver| TeamSkillRuntime { driver })
    }
}

impl TeamSkillRuntime {
    fn endpoint(&self) -> RuntimeEndpointReference {
        RuntimeEndpointReference::try_new(self.driver.identity().runtime_endpoint_reference())
            .expect("team skill runtime endpoint must be a valid Organization endpoint reference")
    }

    async fn installed_skill_names(&self) -> Option<Vec<String>> {
        let ops = self.driver.skill_ops()?;
        ops.installed_skill_catalog()
            .await
            .map(|catalog| catalog.names().iter().cloned().collect())
    }
}

impl OrganizationGlobalState {
    fn refresh(&mut self) -> Result<(), StoreFault> {
        self.store.refresh()
    }

    fn team_skill_validate(&self, package_root: PathBuf) -> TeamSkillPackageValidation {
        organization::package::validate_team_skill_package(package_root)
    }

    fn team_skill_dependency_plan(&self, package_root: PathBuf) -> TeamSkillDependencyPlanResult {
        organization::package::plan_team_skill_dependencies(package_root)
    }

    fn authorize_team_skill_selection(
        &mut self,
        package_root: PathBuf,
    ) -> Result<TeamSkillSelectionId, TeamSkillSelectionError> {
        self.team_skill_selections.authorize(package_root)
    }

    fn validate_team_skill_selection(
        &self,
        selection_id: TeamSkillSelectionId,
    ) -> TeamSkillPackageValidation {
        self.team_skill_selections.validate(&selection_id)
    }

    async fn plan_team_skill_dependencies(
        &self,
        shared: &OrganizationShared,
        selection_id: TeamSkillSelectionId,
    ) -> TeamSkillDependencyPlanResult {
        let Some(runtime) = shared.team_skill_runtime() else {
            return TeamSkillDependencyPlanResult::Unavailable;
        };
        let installed_names = match runtime.installed_skill_names().await {
            Some(names) => names,
            None => return TeamSkillDependencyPlanResult::Unavailable,
        };
        let catalog = TeamSkillDependencyCatalog::from_installed_names(installed_names);
        self.team_skill_selections
            .dependency_plan(&selection_id, &catalog)
    }

    async fn materialize_team_skill_selection(
        &mut self,
        shared: &OrganizationShared,
        selection_id: TeamSkillSelectionId,
        team_id: TeamId,
        idempotency_key: IdempotencyKey,
    ) -> TeamMaterializationCommandOutcome {
        let Some(runtime) = shared.team_skill_runtime() else {
            return TeamMaterializationCommandOutcome::Unavailable;
        };
        let installed_names = match runtime.installed_skill_names().await {
            Some(names) => names,
            None => return TeamMaterializationCommandOutcome::Unavailable,
        };
        match self.team_skill_selections.dependency_plan(
            &selection_id,
            &TeamSkillDependencyCatalog::from_installed_names(installed_names),
        ) {
            TeamSkillDependencyPlanResult::Available { plan } if plan.can_proceed() => {}
            TeamSkillDependencyPlanResult::Available { .. }
            | TeamSkillDependencyPlanResult::Invalid => {
                return TeamMaterializationCommandOutcome::Rejected;
            }
            TeamSkillDependencyPlanResult::Unavailable => {
                return TeamMaterializationCommandOutcome::Unavailable;
            }
        }
        let endpoint = runtime.endpoint();
        let materialization =
            match self
                .team_skill_selections
                .with_package(&selection_id, |package| {
                    organization::compile_team_skill_materialization(
                        package,
                        team_id,
                        endpoint,
                        idempotency_key,
                    )
                }) {
                Ok(Ok(materialization)) => materialization,
                Ok(Err(_)) | Err(TeamSkillSelectionError::InvalidSelection) => {
                    return TeamMaterializationCommandOutcome::Rejected;
                }
                Err(TeamSkillSelectionError::Unavailable) => {
                    return TeamMaterializationCommandOutcome::Unavailable;
                }
            };
        let team = materialization.definition().team_id().clone();
        let managed_agent_count = materialization.request().intent().agents().len();
        let request = match self.begin_team_materialization(materialization) {
            Ok((_, request)) => request,
            Err(outcome) => return outcome,
        };
        let outcome = shared.team_materialize(request).await;
        self.settle_team_materialization_outcome(&team, managed_agent_count, outcome)
    }

    fn begin_team_materialization(
        &mut self,
        materialization: organization::TeamMaterialization,
    ) -> Result<(TeamId, organization::TeamMaterializationRequest), TeamMaterializationCommandOutcome>
    {
        let team = materialization.definition().team_id().clone();
        let request = materialization.request().clone();
        match self.store.create_team_materialization(materialization) {
            Ok(MaterializationRecordOutcome::Recorded) => Ok((team, request)),
            Ok(MaterializationRecordOutcome::Replayed) => {
                Err(TeamMaterializationCommandOutcome::OutcomeUnknown)
            }
            Err(_) => Err(TeamMaterializationCommandOutcome::Unavailable),
        }
    }

    fn settle_team_materialization_outcome(
        &mut self,
        team: &TeamId,
        managed_agent_count: usize,
        outcome: organization::MaterializationOperationOutcome,
    ) -> TeamMaterializationCommandOutcome {
        self.store
            .record_team_materialization_outcome(team, outcome.clone())
            .map_or(
                TeamMaterializationCommandOutcome::Unavailable,
                |_| match outcome {
                    organization::MaterializationOperationOutcome::Confirmed { .. } => {
                        TeamMaterializationCommandOutcome::Materialized {
                            team_id: team.clone(),
                            managed_agent_count,
                        }
                    }
                    organization::MaterializationOperationOutcome::Rejected { .. } => {
                        TeamMaterializationCommandOutcome::Rejected
                    }
                    organization::MaterializationOperationOutcome::Accepted { .. }
                    | organization::MaterializationOperationOutcome::OutcomeUnknown => {
                        TeamMaterializationCommandOutcome::OutcomeUnknown
                    }
                },
            )
    }

    async fn manual_team_materialize(
        &mut self,
        shared: &OrganizationShared,
        team_id: TeamId,
        team_name: String,
        endpoint: RuntimeEndpointReference,
        roles: Vec<organization::ManualTeamRoleBinding>,
        idempotency_key: IdempotencyKey,
    ) -> TeamMaterializationCommandOutcome {
        let materialization = match organization::compile_manual_team_materialization(
            team_id,
            team_name,
            endpoint,
            roles,
            idempotency_key,
        ) {
            Ok(materialization) => materialization,
            Err(_) => return TeamMaterializationCommandOutcome::Rejected,
        };
        let team_id = materialization.definition().team_id().clone();
        let managed_agent_count = materialization.request().intent().agents().len();
        let request = match self.begin_team_materialization(materialization) {
            Ok((_, request)) => request,
            Err(outcome) => return outcome,
        };
        let outcome = shared.team_materialize(request).await;
        self.settle_team_materialization_outcome(&team_id, managed_agent_count, outcome)
    }

    async fn manual_team_create(
        &mut self,
        shared: &OrganizationShared,
        input: ManualTeamMaterializationInput,
    ) -> ManualTeamCreateOutcome {
        let ManualTeamMaterializationInput {
            team_id,
            team_name,
            endpoint,
            roles,
            materialization_idempotency_key,
            run,
            run_idempotency_key,
        } = input;
        let materialization = match organization::compile_manual_team_materialization(
            team_id,
            team_name,
            endpoint,
            roles,
            materialization_idempotency_key,
        ) {
            Ok(materialization) => materialization,
            Err(_) => return ManualTeamCreateOutcome::Rejected,
        };
        let team_id = materialization.definition().team_id().clone();
        let request = match self.begin_team_materialization(materialization) {
            Ok((_, request)) => request,
            Err(TeamMaterializationCommandOutcome::Rejected) => {
                return ManualTeamCreateOutcome::Rejected;
            }
            Err(TeamMaterializationCommandOutcome::OutcomeUnknown) => {
                return ManualTeamCreateOutcome::OutcomeUnknown;
            }
            Err(TeamMaterializationCommandOutcome::Unavailable) => {
                return ManualTeamCreateOutcome::Unavailable;
            }
            Err(TeamMaterializationCommandOutcome::Materialized { .. }) => {
                return ManualTeamCreateOutcome::OutcomeUnknown;
            }
        };
        let outcome = shared.team_materialize(request).await;
        if self
            .store
            .record_team_materialization_outcome(&team_id, outcome.clone())
            .is_err()
        {
            return ManualTeamCreateOutcome::Unavailable;
        }
        if !matches!(
            outcome,
            organization::MaterializationOperationOutcome::Confirmed { .. }
        ) {
            return manual_materialization_outcome(outcome);
        }
        let run_id = run.run_id().clone();
        let created = match self
            .team_run
            .create(&mut self.store, run, &run_idempotency_key)
        {
            Ok(created) => created,
            Err(_) => return ManualTeamCreateOutcome::Unavailable,
        };
        if matches!(created, CreateGraphRunOutcome::ConflictingIdempotency) {
            return ManualTeamCreateOutcome::Unavailable;
        }
        let receipt = match prepare_runtime_receipt(&self.store, &team_id, &run_id) {
            Ok(receipt) => receipt,
            Err(outcome) => return manual_runtime_receipt_outcome(outcome),
        };
        let outcome = shared.team_confirm_receipt(receipt.clone()).await;
        match outcome {
            RuntimeReceiptOutcome::Installed => {
                install_prepared_runtime_receipt(&mut self.store, receipt)
                    .map_or(ManualTeamCreateOutcome::Unavailable, |_| {
                        ManualTeamCreateOutcome::Created(created)
                    })
            }
            outcome => manual_runtime_receipt_outcome(outcome),
        }
    }

    async fn run_create_from_team_template(
        &mut self,
        shared: &OrganizationShared,
        team_id: TeamId,
        run_id: GraphRunId,
        idempotency_key: IdempotencyKey,
        created_at: u64,
    ) -> Result<CreateGraphRunOutcome, TeamRuntimeStatus> {
        let run = self
            .team_run
            .run_from_team_template(
                &self.store,
                &team_id,
                run_id.clone(),
                idempotency_key.as_str(),
                created_at,
            )
            .map_err(|_| TeamRuntimeStatus::Rejected)?;
        let created = self
            .team_run
            .create(&mut self.store, run, idempotency_key.as_str())
            .map_err(|_| TeamRuntimeStatus::Unavailable)?;
        if matches!(created, CreateGraphRunOutcome::ConflictingIdempotency) {
            return Err(TeamRuntimeStatus::Unavailable);
        }
        let receipt = prepare_runtime_receipt(&self.store, &team_id, &run_id)
            .map_err(runtime_receipt_status)?;
        let outcome = shared.team_confirm_receipt(receipt.clone()).await;
        match outcome {
            RuntimeReceiptOutcome::Installed => {
                install_prepared_runtime_receipt(&mut self.store, receipt)
                    .map_err(|_| TeamRuntimeStatus::Unavailable)?;
                Ok(created)
            }
            RuntimeReceiptOutcome::Rejected => Err(TeamRuntimeStatus::Rejected),
            RuntimeReceiptOutcome::OutcomeUnknown => Err(TeamRuntimeStatus::OutcomeUnknown),
            RuntimeReceiptOutcome::Unavailable => Err(TeamRuntimeStatus::Unavailable),
        }
    }

    async fn run_cancel(
        &mut self,
        shared: &OrganizationShared,
        run_id: GraphRunId,
        idempotency_key: String,
        requested_at: u64,
    ) -> Result<BeginCancellationOutcome, StoreFault> {
        let plan = match self.team_run.begin_cancellation(
            &mut self.store,
            &run_id,
            &idempotency_key,
            requested_at,
        )? {
            BeginCancellationOutcome::Started(plan) | BeginCancellationOutcome::Replayed(plan) => {
                plan
            }
            outcome => return Ok(outcome),
        };
        let outcome = shared
            .team_abort_role_sessions(plan.bindings().to_vec())
            .await;
        settle_public_cancellation(
            &mut self.store,
            &self.team_run,
            &run_id,
            &idempotency_key,
            outcome,
            requested_at,
        )
    }

    async fn run_delete_and_purge(
        &mut self,
        shared: &OrganizationShared,
        run_id: GraphRunId,
        idempotency_key: String,
        observed_at: u64,
    ) -> Result<organization::GraphRunPurgeOutcome, StoreFault> {
        let (bindings, abort_first) = match self.team_run.begin_cancellation(
            &mut self.store,
            &run_id,
            &idempotency_key,
            observed_at,
        ) {
            Ok(BeginCancellationOutcome::Started(plan)) => (plan.bindings().to_vec(), true),
            Ok(BeginCancellationOutcome::Replayed(_))
            | Ok(BeginCancellationOutcome::OutcomeUnknown) => {
                return self.complete_team_run_delete_native_evidence(
                    run_id,
                    &idempotency_key,
                    NativeDeletionEvidence::OutcomeUnknown,
                    observed_at,
                );
            }
            Ok(BeginCancellationOutcome::AlreadyCancelled)
            | Ok(BeginCancellationOutcome::Tombstoned) => (self.team_run_bindings(&run_id), false),
            Err(error) => return Err(error),
        };
        let outcome = shared
            .team_delete_role_sessions(run_id.clone(), bindings, abort_first)
            .await;
        self.complete_team_run_delete_native_evidence(
            run_id,
            &idempotency_key,
            outcome,
            observed_at,
        )
    }

    async fn team_delete(
        &mut self,
        shared: &OrganizationShared,
        team_id: TeamId,
        idempotency_key: IdempotencyKey,
        observed_at: u64,
    ) -> Result<TeamDeleteOutcome, StoreFault> {
        for run_id in self.team_run_ids_for_team(&team_id) {
            match self.team_run.begin_cancellation(
                &mut self.store,
                &run_id,
                idempotency_key.as_str(),
                observed_at,
            ) {
                Ok(BeginCancellationOutcome::Started(plan)) => {
                    let outcome = shared
                        .team_delete_role_sessions(run_id.clone(), plan.bindings().to_vec(), true)
                        .await;
                    match self.complete_team_run_delete_native_evidence(
                        run_id,
                        idempotency_key.as_str(),
                        outcome,
                        observed_at,
                    )? {
                        organization::GraphRunPurgeOutcome::Purged
                        | organization::GraphRunPurgeOutcome::Replayed => {}
                        _ => return Ok(TeamDeleteOutcome::OutcomeUnknown),
                    }
                }
                Ok(BeginCancellationOutcome::AlreadyCancelled) => {
                    let outcome = shared
                        .team_delete_role_sessions(
                            run_id.clone(),
                            self.team_run_bindings(&run_id),
                            false,
                        )
                        .await;
                    match self.complete_cancelled_team_run_delete_native_evidence(
                        run_id,
                        idempotency_key.as_str(),
                        outcome,
                        observed_at,
                    )? {
                        organization::GraphRunPurgeOutcome::Purged
                        | organization::GraphRunPurgeOutcome::Replayed => {}
                        _ => return Ok(TeamDeleteOutcome::OutcomeUnknown),
                    }
                }
                Ok(BeginCancellationOutcome::Tombstoned) => {
                    let outcome = shared
                        .team_delete_role_sessions(
                            run_id.clone(),
                            self.team_run_bindings(&run_id),
                            false,
                        )
                        .await;
                    match self.purge_tombstoned_team_run_delete_native_evidence(
                        run_id,
                        idempotency_key.as_str(),
                        outcome,
                    )? {
                        organization::GraphRunPurgeOutcome::Purged
                        | organization::GraphRunPurgeOutcome::Replayed => {}
                        _ => return Ok(TeamDeleteOutcome::OutcomeUnknown),
                    }
                }
                Ok(BeginCancellationOutcome::Replayed(plan)) => {
                    let outcome = shared
                        .team_delete_role_sessions(run_id.clone(), plan.bindings().to_vec(), true)
                        .await;
                    match self.complete_team_run_delete_native_evidence(
                        run_id,
                        idempotency_key.as_str(),
                        outcome,
                        observed_at,
                    )? {
                        organization::GraphRunPurgeOutcome::Purged
                        | organization::GraphRunPurgeOutcome::Replayed => {}
                        _ => return Ok(TeamDeleteOutcome::OutcomeUnknown),
                    }
                }
                Ok(BeginCancellationOutcome::OutcomeUnknown) => {
                    if !self.team_run_outcome_unknown_matches(&run_id, idempotency_key.as_str()) {
                        return Ok(TeamDeleteOutcome::OutcomeUnknown);
                    }
                    let outcome = shared
                        .team_delete_role_sessions(
                            run_id.clone(),
                            self.team_run_bindings(&run_id),
                            true,
                        )
                        .await;
                    match self.complete_team_run_delete_native_evidence(
                        run_id,
                        idempotency_key.as_str(),
                        outcome,
                        observed_at,
                    )? {
                        organization::GraphRunPurgeOutcome::Purged
                        | organization::GraphRunPurgeOutcome::Replayed => {}
                        _ => return Ok(TeamDeleteOutcome::OutcomeUnknown),
                    }
                }
                Err(error) => return Err(error),
            }
        }
        let Some(removal) = self.begin_team_delete_removal(&team_id, idempotency_key.as_str())?
        else {
            return Ok(self.team_delete_without_pending_cleanup(&team_id));
        };
        let outcome = shared.team_remove(removal).await;
        self.complete_team_delete_removal(&team_id, Some(outcome))
    }

    fn team_run_ids_for_team(&self, team_id: &TeamId) -> Vec<GraphRunId> {
        self.store
            .facts()
            .runs()
            .filter(|run| run.team() == team_id)
            .map(|run| run.run_id().clone())
            .collect()
    }

    fn begin_team_delete_removal(
        &mut self,
        team_id: &TeamId,
        idempotency_key: &str,
    ) -> Result<Option<organization::TeamMaterializationRemoval>, StoreFault> {
        if self.store.facts().team(team_id).is_none() {
            return Ok(None);
        }
        let cleanup_key = IdempotencyKey::try_new(idempotency_key.to_owned())
            .map_err(|_| StoreFault::InvalidFacts)?;
        self.store.tombstone_team(team_id, cleanup_key)?;
        Ok(self.store.team_materialization_removal(team_id))
    }

    fn team_delete_without_pending_cleanup(&self, team_id: &TeamId) -> TeamDeleteOutcome {
        if self.store.team_materialization_cleanup_confirmed(team_id)
            || self.store.facts().materialization(team_id).is_none()
        {
            TeamDeleteOutcome::Deleted
        } else {
            TeamDeleteOutcome::OutcomeUnknown
        }
    }

    fn complete_team_delete_removal(
        &mut self,
        team_id: &TeamId,
        outcome: Option<organization::MaterializationOperationOutcome>,
    ) -> Result<TeamDeleteOutcome, StoreFault> {
        if self.store.team_materialization_cleanup_confirmed(team_id) {
            return Ok(TeamDeleteOutcome::Deleted);
        }
        let Some(outcome) = outcome else {
            return Ok(self.team_delete_without_pending_cleanup(team_id));
        };
        self.store
            .record_team_materialization_cleanup_outcome(team_id, outcome.clone())?;
        Ok(match outcome {
            organization::MaterializationOperationOutcome::Confirmed { .. } => {
                TeamDeleteOutcome::Deleted
            }
            organization::MaterializationOperationOutcome::Accepted { .. }
            | organization::MaterializationOperationOutcome::Rejected { .. }
            | organization::MaterializationOperationOutcome::OutcomeUnknown => {
                TeamDeleteOutcome::OutcomeUnknown
            }
        })
    }

    fn complete_team_run_delete_native_evidence(
        &mut self,
        run_id: GraphRunId,
        idempotency_key: &str,
        native: NativeDeletionEvidence,
        observed_at: u64,
    ) -> Result<organization::GraphRunPurgeOutcome, StoreFault> {
        if matches!(native, NativeDeletionEvidence::Confirmed(_)) {
            match self.team_run.settle_cancellation(
                &mut self.store,
                &run_id,
                idempotency_key,
                RoleAbortOutcome::Confirmed,
                observed_at,
            )? {
                organization::SettleCancellationOutcome::Cancelled
                | organization::SettleCancellationOutcome::Replayed
                | organization::SettleCancellationOutcome::Tombstoned => {}
                organization::SettleCancellationOutcome::OutcomeUnknown => {
                    return Ok(organization::GraphRunPurgeOutcome::OutcomeUnknown(
                        organization::GraphRunPurgeUnknown::NativeDeletionOutcomeUnknown,
                    ));
                }
            }
            return self.purge_cancelled_team_run_delete_native_evidence(
                run_id,
                idempotency_key,
                native,
                observed_at,
            );
        }
        let _ = self.team_run.settle_cancellation(
            &mut self.store,
            &run_id,
            idempotency_key,
            RoleAbortOutcome::OutcomeUnknown,
            observed_at,
        )?;
        self.team_run.purge(
            &mut self.store,
            organization::TeamRunPurgeRequest::new(run_id, idempotency_key.to_owned(), native),
        )
    }

    fn complete_cancelled_team_run_delete_native_evidence(
        &mut self,
        run_id: GraphRunId,
        idempotency_key: &str,
        native: NativeDeletionEvidence,
        observed_at: u64,
    ) -> Result<organization::GraphRunPurgeOutcome, StoreFault> {
        if matches!(native, NativeDeletionEvidence::Confirmed(_)) {
            return self.purge_cancelled_team_run_delete_native_evidence(
                run_id,
                idempotency_key,
                native,
                observed_at,
            );
        }
        self.team_run.purge(
            &mut self.store,
            organization::TeamRunPurgeRequest::new(run_id, idempotency_key.to_owned(), native),
        )
    }

    fn purge_cancelled_team_run_delete_native_evidence(
        &mut self,
        run_id: GraphRunId,
        idempotency_key: &str,
        native: NativeDeletionEvidence,
        observed_at: u64,
    ) -> Result<organization::GraphRunPurgeOutcome, StoreFault> {
        match self
            .team_run
            .tombstone(&mut self.store, &run_id, idempotency_key, observed_at)?
        {
            organization::TombstoneOutcome::Tombstoned
            | organization::TombstoneOutcome::Replayed => {}
            organization::TombstoneOutcome::CancellationRequired(_)
            | organization::TombstoneOutcome::OutcomeUnknown => {
                return Ok(organization::GraphRunPurgeOutcome::OutcomeUnknown(
                    organization::GraphRunPurgeUnknown::NativeDeletionOutcomeUnknown,
                ));
            }
        }
        self.purge_tombstoned_team_run_delete_native_evidence(run_id, idempotency_key, native)
    }

    fn purge_tombstoned_team_run_delete_native_evidence(
        &mut self,
        run_id: GraphRunId,
        idempotency_key: &str,
        native: NativeDeletionEvidence,
    ) -> Result<organization::GraphRunPurgeOutcome, StoreFault> {
        self.team_run.purge(
            &mut self.store,
            organization::TeamRunPurgeRequest::new(run_id, idempotency_key.to_owned(), native),
        )
    }

    fn team_run_bindings(&self, run_id: &GraphRunId) -> Vec<organization::RoleSessionReceipt> {
        self.store
            .facts()
            .run(run_id)
            .and_then(|run| run.runtime())
            .map(|runtime| runtime.bindings().to_vec())
            .unwrap_or_default()
    }

    fn team_run_outcome_unknown_matches(&self, run_id: &GraphRunId, idempotency_key: &str) -> bool {
        self.store.facts().run(run_id).is_some_and(|run| {
            matches!(
                run.lifecycle().state(),
                GraphRunLifecycleState::OutcomeUnknown {
                    idempotency_key: existing,
                    ..
                } if existing == idempotency_key
            )
        })
    }

    fn active_run_ids(&self) -> Vec<GraphRunId> {
        self.store
            .facts()
            .runs()
            .filter(|run| matches!(run.lifecycle().state(), GraphRunLifecycleState::Active))
            .map(|run| run.run_id().clone())
            .collect()
    }

    fn pending_run_activity_ids(&self, run_id: &GraphRunId, now: u64) -> Vec<ActivityId> {
        super::run_scheduler::pending_run_activity_ids(&self.store, run_id, now)
    }

    fn activity_target(&self, activity_id: &ActivityId) -> Option<TeamRunActivityTarget> {
        super::run_scheduler::activity_target(&self.store, activity_id)
    }

    fn claim_activity(
        &mut self,
        activity_id: ActivityId,
        claimed_at: u64,
    ) -> Result<TeamRunActivityStart, TeamRunActivityError> {
        self.team_run
            .claim_agent_activity(&mut self.store, activity_id, claimed_at)
    }

    fn settle_activity(
        &mut self,
        claim: organization::ActivityClaim,
        outcome: crate::runtime::driver::ActivityExecutionOutcome,
    ) -> Result<TeamRunActivityOutcome, TeamRunActivityError> {
        self.team_run
            .settle_agent_activity_dispatch(&mut self.store, claim, outcome)
    }

    fn native_terminal_target(
        &self,
        delivery_id: &DeliveryId,
    ) -> Option<NativeTerminalReceiptTarget> {
        self.team_run
            .native_terminal_target(&self.store, delivery_id)
    }

    async fn recover_materialization_receipts(&mut self, shared: &OrganizationShared) {
        for team_id in self.store.materialization_receipt_recovery_teams() {
            if self.store.facts().materialization(&team_id).is_some() {
                continue;
            }
            let Some(request) = self.store.team_materialization_recovery_request(&team_id) else {
                continue;
            };
            let Ok(driver) = shared.team_driver_for_endpoint(request.intent().endpoint()) else {
                continue;
            };
            let Some(ops) = driver.team_ops() else {
                continue;
            };
            let outcome = ops.recover_team_materialization(request).await;
            let organization::MaterializationOperationOutcome::Confirmed { receipt } = outcome
            else {
                continue;
            };
            let _ = self.store.confirm_team_materialization(receipt);
        }
    }
}

impl OrganizationRunLane {
    fn new(store_path: PathBuf) -> Self {
        Self {
            store_path,
            team_run: TeamRunOwner::new(),
        }
    }

    fn open_store(&self) -> Result<OrganizationStore, StoreFault> {
        OrganizationStore::open_live(&self.store_path)
    }
}

impl OwnerSpec for OrganizationOwner {
    type Command = OrganizationCommand;
    type Query = OrganizationQuery;
    type Key = GraphRunId;
    type Shared = OrganizationShared;
    type GlobalState = OrganizationGlobalState;
    type LaneState = OrganizationRunLane;

    fn split(self) -> (Self::Shared, Self::GlobalState) {
        (self.shared, self.global)
    }

    fn route_command(command: &Self::Command) -> CommandRoute<Self::Key> {
        match command {
            OrganizationCommand::RunCreate { run_id, .. }
            | OrganizationCommand::RunCreateFromTeamTemplate { run_id, .. }
            | OrganizationCommand::RunCancel { run_id, .. }
            | OrganizationCommand::RunDelete { run_id, .. }
            | OrganizationCommand::RunStartProposalSet { run_id, .. }
            | OrganizationCommand::RunStartConfirm { run_id, .. }
            | OrganizationCommand::RunStartContinue { run_id, .. }
            | OrganizationCommand::NodeTerminalResolve { run_id, .. }
            | OrganizationCommand::TaskBoardMutate { run_id, .. }
            | OrganizationCommand::ScheduleReadyNodes { run_id, .. }
            | OrganizationCommand::ClaimActivity { run_id, .. }
            | OrganizationCommand::SettleActivity { run_id, .. }
            | OrganizationCommand::NativeRunSettled { run_id, .. } => {
                CommandRoute::Keyed(run_id.clone())
            }
            OrganizationCommand::TriggerFire { request, .. } => {
                CommandRoute::Keyed(GraphRunId::new(request.run_id.clone()))
            }
            OrganizationCommand::GraphSave { command, .. }
            | OrganizationCommand::NodeEvent { command, .. } => {
                CommandRoute::Keyed(GraphRunId::new(command.run_id().as_str()))
            }
            OrganizationCommand::GraphPatch { patch, .. } => {
                CommandRoute::Keyed(patch.run_id.clone())
            }
            OrganizationCommand::RoleMessageSubmit { admission, .. } => {
                CommandRoute::Keyed(admission.run_id().clone())
            }
            OrganizationCommand::RoleMessageSubmitForRun { run_id, .. } => {
                CommandRoute::Keyed(run_id.clone())
            }
            OrganizationCommand::ApprovalResolve { command, .. } => {
                CommandRoute::Keyed(command.run_id().clone())
            }
            OrganizationCommand::DecisionSubmit { command, .. } => {
                CommandRoute::Keyed(GraphRunId::new(command.run_id()))
            }
            OrganizationCommand::TeamDelete { .. }
            | OrganizationCommand::RunDeleteAndPurge { .. }
            | OrganizationCommand::RunPurge { .. }
            | OrganizationCommand::NodePromptSettled { .. }
            | OrganizationCommand::RecoverMaterializationReceipts { .. } => CommandRoute::Exclusive,
            OrganizationCommand::TeamSkillAuthorize { .. }
            | OrganizationCommand::TeamSkillMaterialize { .. }
            | OrganizationCommand::ManualTeamMaterialize { .. }
            | OrganizationCommand::ManualTeamCreate { .. }
            | OrganizationCommand::WebhookTriggerFire { .. } => CommandRoute::Global,
        }
    }

    fn route_query(query: &Self::Query) -> QueryRoute<Self::Key> {
        match query {
            OrganizationQuery::RunSnapshot { query, .. } => QueryRoute::Keyed(query.run().clone()),
            OrganizationQuery::TeamRunPublicProjection { run_id, .. }
            | OrganizationQuery::TeamRunPublicSnapshot { run_id, .. }
            | OrganizationQuery::TeamRunDiagnostics { run_id, .. }
            | OrganizationQuery::GraphDefinition { run_id, .. }
            | OrganizationQuery::GraphYaml { run_id, .. }
            | OrganizationQuery::TaskBoardRead { run_id, .. }
            | OrganizationQuery::PendingApprovals { run_id, .. }
            | OrganizationQuery::NodePromptRetryDue { run_id, .. } => {
                QueryRoute::Keyed(run_id.clone())
            }
            OrganizationQuery::GraphContext { query, .. } => QueryRoute::Keyed(query.run().clone()),
            OrganizationQuery::TeamSkillValidate { .. }
            | OrganizationQuery::TeamSkillDependencyPlan { .. }
            | OrganizationQuery::TeamSkillSelectionValidate { .. }
            | OrganizationQuery::TeamSkillSelectionDependencyPlan { .. }
            | OrganizationQuery::RunList { .. }
            | OrganizationQuery::RoleSessions { .. }
            | OrganizationQuery::StartGateSessionBinding { .. }
            | OrganizationQuery::TriggerList { .. }
            | OrganizationQuery::Resume { .. }
            | OrganizationQuery::PendingRunActivityIds { .. }
            | OrganizationQuery::TerminalObservationDeliveries { .. }
            | OrganizationQuery::ActiveRunIds { .. }
            | OrganizationQuery::ActivityTarget { .. }
            | OrganizationQuery::MatchaTerminalTarget { .. } => QueryRoute::Global,
        }
    }

    fn open_lane(shared: &Self::Shared, _key: &Self::Key) -> Self::LaneState {
        OrganizationRunLane::new(shared.store_path.clone())
    }

    async fn handle_keyed_command(
        shared: Self::Shared,
        _key: Self::Key,
        state: &mut Self::LaneState,
        command: Self::Command,
    ) {
        match command {
            OrganizationCommand::RunCreate {
                team_id,
                run_id,
                idempotency_key,
                workflow_plan,
                source_identity,
                template_revision,
                created_at,
                reply,
            } => {
                let outcome = match state.open_store() {
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
                let _ = reply.send(outcome);
            }
            OrganizationCommand::RunCreateFromTeamTemplate {
                team_id,
                run_id,
                idempotency_key,
                created_at,
                reply,
            } => {
                let outcome = match state.open_store() {
                    Ok(mut store) => {
                        let run = state
                            .team_run
                            .run_from_team_template(
                                &store,
                                &team_id,
                                run_id.clone(),
                                idempotency_key.as_str(),
                                created_at,
                            )
                            .map_err(|_| TeamRuntimeStatus::Rejected);
                        match run {
                            Ok(run) => {
                                let created = state
                                    .team_run
                                    .create(&mut store, run, idempotency_key.as_str())
                                    .map_err(|_| TeamRuntimeStatus::Unavailable);
                                match created {
                                    Ok(created) => {
                                        if matches!(
                                            created,
                                            CreateGraphRunOutcome::ConflictingIdempotency
                                        ) {
                                            Err(TeamRuntimeStatus::Unavailable)
                                        } else {
                                            match prepare_runtime_receipt(&store, &team_id, &run_id)
                                                .map_err(runtime_receipt_status)
                                            {
                                                Ok(receipt) => match shared
                                                    .team_confirm_receipt(receipt.clone())
                                                    .await
                                                {
                                                    RuntimeReceiptOutcome::Installed => {
                                                        install_prepared_runtime_receipt(
                                                            &mut store, receipt,
                                                        )
                                                        .map_err(|_| TeamRuntimeStatus::Unavailable)
                                                        .map(|_| created)
                                                    }
                                                    RuntimeReceiptOutcome::Rejected => {
                                                        Err(TeamRuntimeStatus::Rejected)
                                                    }
                                                    RuntimeReceiptOutcome::OutcomeUnknown => {
                                                        Err(TeamRuntimeStatus::OutcomeUnknown)
                                                    }
                                                    RuntimeReceiptOutcome::Unavailable => {
                                                        Err(TeamRuntimeStatus::Unavailable)
                                                    }
                                                },
                                                Err(error) => Err(error),
                                            }
                                        }
                                    }
                                    Err(error) => Err(error),
                                }
                            }
                            Err(error) => Err(error),
                        }
                    }
                    Err(_) => Err(TeamRuntimeStatus::Unavailable),
                };
                let _ = reply.send(outcome);
            }
            OrganizationCommand::RunCancel {
                run_id,
                idempotency_key,
                requested_at,
                reply,
            } => {
                let outcome = match state.open_store() {
                    Ok(mut store) => {
                        let plan = match state.team_run.begin_cancellation(
                            &mut store,
                            &run_id,
                            &idempotency_key,
                            requested_at,
                        ) {
                            Ok(BeginCancellationOutcome::Started(plan))
                            | Ok(BeginCancellationOutcome::Replayed(plan)) => plan,
                            Ok(outcome) => {
                                let _ = reply.send(Ok(outcome));
                                return;
                            }
                            Err(error) => {
                                let _ = reply.send(Err(error));
                                return;
                            }
                        };
                        let outcome = shared
                            .team_abort_role_sessions(plan.bindings().to_vec())
                            .await;
                        settle_public_cancellation(
                            &mut store,
                            &state.team_run,
                            &run_id,
                            &idempotency_key,
                            outcome,
                            requested_at,
                        )
                    }
                    Err(error) => Err(error),
                };
                let _ = reply.send(outcome);
            }
            OrganizationCommand::RunDelete {
                run_id,
                idempotency_key,
                tombstoned_at,
                reply,
            } => {
                let outcome = state.open_store().and_then(|mut store| {
                    state
                        .team_run
                        .tombstone(&mut store, &run_id, &idempotency_key, tombstoned_at)
                });
                let _ = reply.send(outcome);
            }
            OrganizationCommand::RunStartProposalSet {
                run_id,
                proposal_id,
                summary,
                source_delivery_id,
                reply,
            } => {
                let outcome = state.open_store().and_then(|mut store| {
                    store.set_run_start_proposal(&run_id, proposal_id, summary, source_delivery_id)
                });
                let _ = reply.send(outcome);
            }
            OrganizationCommand::RunStartConfirm {
                run_id,
                proposal_id,
                reply,
            } => {
                let outcome = state
                    .open_store()
                    .and_then(|mut store| store.confirm_run_start(&run_id, &proposal_id));
                let _ = reply.send(outcome);
            }
            OrganizationCommand::RunStartContinue {
                run_id,
                proposal_id,
                reply,
            } => {
                let outcome = state
                    .open_store()
                    .and_then(|mut store| store.continue_run_discussion(&run_id, &proposal_id));
                let _ = reply.send(outcome);
            }
            OrganizationCommand::TriggerFire {
                request,
                fired_at,
                reply,
            } => {
                let outcome = state.open_store().and_then(|mut store| {
                    state.team_run.fire_trigger(&mut store, request, fired_at)
                });
                let _ = reply.send(outcome);
            }
            OrganizationCommand::GraphSave {
                command,
                definition,
                reply,
            } => {
                let outcome = state.open_store().and_then(|mut store| {
                    state
                        .team_run
                        .replace_graph(&mut store, command, definition)
                });
                let _ = reply.send(outcome);
            }
            OrganizationCommand::GraphPatch { patch, reply } => {
                let outcome = state
                    .open_store()
                    .and_then(|mut store| state.team_run.apply_graph_patch(&mut store, patch));
                let _ = reply.send(outcome);
            }
            OrganizationCommand::RoleMessageSubmit { admission, reply } => {
                let outcome = state
                    .open_store()
                    .and_then(|mut store| state.team_run.admit_role_chat(&mut store, admission));
                let _ = reply.send(outcome);
            }
            OrganizationCommand::RoleMessageSubmitForRun {
                run_id,
                role_id,
                message,
                idempotency_key,
                requested_at,
                reply,
            } => {
                let outcome = state.open_store().and_then(|mut store| {
                    let Some(team) = store.facts().run(&run_id).map(|run| run.team().clone())
                    else {
                        return Ok(organization::RoleChatAdmissionOutcome::Rejected(
                            organization::RoleChatRejection::RunUnavailable,
                        ));
                    };
                    organization::RoleChatAdmission::new(
                        team,
                        run_id,
                        role_id,
                        message,
                        idempotency_key,
                        requested_at,
                    )
                    .map_err(|_| StoreFault::InvalidFacts)
                    .and_then(|admission| state.team_run.admit_role_chat(&mut store, admission))
                });
                let _ = reply.send(outcome);
            }
            OrganizationCommand::NodeEvent {
                command,
                event,
                reply,
            } => {
                let outcome = state.open_store().and_then(|mut store| {
                    state.team_run.record_node_event(&mut store, command, event)
                });
                let _ = reply.send(outcome);
            }
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
            } => {
                let outcome = state.open_store().and_then(|mut store| {
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
                let _ = reply.send(outcome);
            }
            OrganizationCommand::ApprovalResolve { command, reply } => {
                let outcome = state.open_store().and_then(|mut store| {
                    state.team_run.resolve_human_decision(&mut store, command)
                });
                let _ = reply.send(outcome);
            }
            OrganizationCommand::DecisionSubmit { command, reply } => {
                let outcome = state
                    .open_store()
                    .and_then(|mut store| state.team_run.record_decision(&mut store, command));
                let _ = reply.send(outcome);
            }
            OrganizationCommand::TaskBoardMutate {
                team_id,
                run_id,
                operation,
                reply,
            } => {
                let outcome = state.open_store().and_then(|mut store| {
                    super::task_board::mutate(&mut store, team_id, run_id, operation)
                });
                let _ = reply.send(outcome);
            }
            OrganizationCommand::ScheduleReadyNodes { run_id, now, reply } => {
                let outcome = state.open_store().and_then(|mut store| {
                    super::run_scheduler::schedule_ready_nodes(
                        &state.team_run,
                        &mut store,
                        run_id,
                        now,
                    )
                });
                let _ = reply.send(outcome);
            }
            OrganizationCommand::ClaimActivity {
                run_id,
                activity_id,
                claimed_at,
                reply,
            } => {
                let outcome = state
                    .open_store()
                    .map_err(TeamRunActivityError::Store)
                    .and_then(|mut store| {
                        if !super::run_scheduler::activity_belongs_to(&store, &run_id, &activity_id)
                        {
                            return Err(TeamRunActivityError::SessionMismatch);
                        }
                        state
                            .team_run
                            .claim_agent_activity(&mut store, activity_id, claimed_at)
                    });
                let _ = reply.send(outcome);
            }
            OrganizationCommand::SettleActivity {
                run_id,
                claim,
                outcome,
                reply,
            } => {
                let outcome = state
                    .open_store()
                    .map_err(TeamRunActivityError::Store)
                    .and_then(|mut store| {
                        if !super::run_scheduler::activity_belongs_to(
                            &store,
                            &run_id,
                            claim.activity_id(),
                        ) {
                            return Err(TeamRunActivityError::SessionMismatch);
                        }
                        state
                            .team_run
                            .settle_agent_activity_dispatch(&mut store, claim, outcome)
                    });
                let _ = reply.send(outcome);
            }
            OrganizationCommand::NativeRunSettled {
                run_id,
                delivery_id,
                settled,
                settled_at,
                reply,
            } => {
                let outcome = state.open_store().and_then(|mut store| {
                    let Some(target) = state.team_run.native_terminal_target(&store, &delivery_id)
                    else {
                        return Err(StoreFault::InvalidFacts);
                    };
                    if target.graph_run_id() != &run_id {
                        return Err(StoreFault::InvalidFacts);
                    }
                    let native_terminal = settled.status;
                    state.team_run.observe_native_terminal(
                        &mut store,
                        target,
                        native_terminal,
                        settled_at,
                    )?;
                    super::team_run::resolve_native_settled_output(
                        &mut store,
                        &state.team_run,
                        &run_id,
                        &delivery_id,
                        settled,
                        settled_at,
                    )
                });
                let _ = reply.send(outcome);
            }
            OrganizationCommand::TeamSkillAuthorize { .. }
            | OrganizationCommand::TeamSkillMaterialize { .. }
            | OrganizationCommand::ManualTeamMaterialize { .. }
            | OrganizationCommand::ManualTeamCreate { .. }
            | OrganizationCommand::TeamDelete { .. }
            | OrganizationCommand::RunDeleteAndPurge { .. }
            | OrganizationCommand::RunPurge { .. }
            | OrganizationCommand::WebhookTriggerFire { .. }
            | OrganizationCommand::NodePromptSettled { .. }
            | OrganizationCommand::RecoverMaterializationReceipts { .. } => {
                unreachable!("organization command routed to wrong run lane")
            }
        }
    }

    async fn handle_global_command(
        shared: Self::Shared,
        state: &mut Self::GlobalState,
        command: Self::Command,
    ) {
        match command {
            OrganizationCommand::TeamSkillAuthorize {
                package_root,
                reply,
            } => {
                let _ = reply.send(state.authorize_team_skill_selection(package_root));
            }
            OrganizationCommand::TeamSkillMaterialize {
                selection_id,
                team_id,
                idempotency_key,
                reply,
            } => {
                if state.refresh().is_err() {
                    let _ = reply.send(TeamMaterializationCommandOutcome::Unavailable);
                    return;
                }
                let outcome = state
                    .materialize_team_skill_selection(
                        &shared,
                        selection_id,
                        team_id,
                        idempotency_key,
                    )
                    .await;
                let _ = reply.send(outcome);
            }
            OrganizationCommand::ManualTeamMaterialize {
                team_id,
                team_name,
                endpoint,
                roles,
                idempotency_key,
                reply,
            } => {
                if state.refresh().is_err() {
                    let _ = reply.send(TeamMaterializationCommandOutcome::Unavailable);
                    return;
                }
                let outcome = state
                    .manual_team_materialize(
                        &shared,
                        team_id,
                        team_name,
                        endpoint,
                        roles,
                        idempotency_key,
                    )
                    .await;
                let _ = reply.send(outcome);
            }
            OrganizationCommand::ManualTeamCreate {
                team_id,
                team_name,
                endpoint,
                roles,
                materialization_idempotency_key,
                run,
                run_idempotency_key,
                reply,
            } => {
                if state.refresh().is_err() {
                    let _ = reply.send(ManualTeamCreateOutcome::Unavailable);
                    return;
                }
                let outcome = state
                    .manual_team_create(
                        &shared,
                        ManualTeamMaterializationInput {
                            team_id,
                            team_name,
                            endpoint,
                            roles,
                            materialization_idempotency_key,
                            run,
                            run_idempotency_key,
                        },
                    )
                    .await;
                let _ = reply.send(outcome);
            }
            OrganizationCommand::TeamDelete {
                team_id,
                idempotency_key,
                observed_at,
                reply,
            } => {
                let outcome = match state.refresh() {
                    Ok(()) => {
                        state
                            .team_delete(&shared, team_id, idempotency_key, observed_at)
                            .await
                    }
                    Err(error) => Err(error),
                };
                let _ = reply.send(outcome);
            }
            OrganizationCommand::RunDeleteAndPurge {
                run_id,
                idempotency_key,
                observed_at,
                reply,
            } => {
                let outcome = match state.refresh() {
                    Ok(()) => {
                        state
                            .run_delete_and_purge(&shared, run_id, idempotency_key, observed_at)
                            .await
                    }
                    Err(error) => Err(error),
                };
                let _ = reply.send(outcome);
            }
            OrganizationCommand::RunPurge { request, reply } => {
                let outcome = state
                    .refresh()
                    .and_then(|_| state.team_run.purge(&mut state.store, request));
                let _ = reply.send(outcome);
            }
            OrganizationCommand::WebhookTriggerFire {
                webhook_path,
                idempotency_key,
                fired_at,
                reply,
            } => {
                if state.refresh().is_err() {
                    let _ = reply.send(Err(TeamRuntimeStatus::Unavailable));
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
                let _ = reply.send(outcome);
            }
            OrganizationCommand::RecoverMaterializationReceipts { reply } => {
                if state.refresh().is_ok() {
                    state.recover_materialization_receipts(&shared).await;
                }
                let _ = reply.send(());
            }
            OrganizationCommand::NodePromptSettled {
                session_key,
                prompt_run_id,
                phase,
                settled_at,
                reply,
            } => {
                let native_phase = match phase {
                    super::team_runtime::TeamRuntimePromptPhase::Final => {
                        NativeTerminalStatus::Completed
                    }
                    super::team_runtime::TeamRuntimePromptPhase::Error => {
                        NativeTerminalStatus::Failed
                    }
                    super::team_runtime::TeamRuntimePromptPhase::Aborted => {
                        NativeTerminalStatus::Cancelled
                    }
                };
                let outcome = match state.refresh() {
                    Ok(()) => state
                        .team_run
                        .settle_node_prompt(
                            &mut state.store,
                            &session_key,
                            &prompt_run_id,
                            native_phase,
                            settled_at,
                        )
                        .map_err(node_prompt_settled_status),
                    Err(_) => Err(TeamRuntimeStatus::Unavailable),
                };
                let _ = reply.send(outcome);
            }
            OrganizationCommand::RunCreate { .. }
            | OrganizationCommand::RunCreateFromTeamTemplate { .. }
            | OrganizationCommand::RunCancel { .. }
            | OrganizationCommand::RunDelete { .. }
            | OrganizationCommand::RunStartProposalSet { .. }
            | OrganizationCommand::RunStartConfirm { .. }
            | OrganizationCommand::RunStartContinue { .. }
            | OrganizationCommand::TriggerFire { .. }
            | OrganizationCommand::GraphSave { .. }
            | OrganizationCommand::GraphPatch { .. }
            | OrganizationCommand::RoleMessageSubmit { .. }
            | OrganizationCommand::RoleMessageSubmitForRun { .. }
            | OrganizationCommand::NodeEvent { .. }
            | OrganizationCommand::NodeTerminalResolve { .. }
            | OrganizationCommand::ApprovalResolve { .. }
            | OrganizationCommand::DecisionSubmit { .. }
            | OrganizationCommand::TaskBoardMutate { .. }
            | OrganizationCommand::ScheduleReadyNodes { .. }
            | OrganizationCommand::ClaimActivity { .. }
            | OrganizationCommand::SettleActivity { .. }
            | OrganizationCommand::NativeRunSettled { .. } => {
                unreachable!("organization command routed to global lane")
            }
        }
    }

    async fn handle_direct_query(_shared: Self::Shared, _query: Self::Query) {}

    async fn handle_keyed_query(
        _shared: Self::Shared,
        _key: Self::Key,
        state: &mut Self::LaneState,
        query: Self::Query,
    ) {
        match query {
            OrganizationQuery::RunSnapshot { query, reply } => {
                let outcome = state
                    .open_store()
                    .map_or(organization::TeamRunQueryOutcome::Unavailable, |store| {
                        state.team_run.query(&store, &query)
                    });
                let _ = reply.send(outcome);
            }
            OrganizationQuery::TeamRunPublicProjection {
                team_id,
                run_id,
                reply,
            } => {
                let outcome = state.open_store().map_or(
                    organization::run::public_projection::TeamPublicQueryOutcome::Unavailable,
                    |store| super::projection::team_public_projection(&store, &team_id, &run_id),
                );
                let _ = reply.send(outcome);
            }
            OrganizationQuery::TeamRunPublicSnapshot {
                team_id,
                run_id,
                event_cursor,
                event_limit,
                reply,
            } => {
                let outcome = state.open_store().ok().and_then(|store| {
                    super::projection::team_run_public_snapshot(
                        &store,
                        team_id,
                        run_id,
                        event_cursor,
                        event_limit,
                    )
                });
                let _ = reply.send(outcome);
            }
            OrganizationQuery::TeamRunDiagnostics { run_id, reply } => {
                let outcome = state.open_store().map_or(
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
                let _ = reply.send(outcome);
            }
            OrganizationQuery::GraphContext { query, reply } => {
                let outcome = state
                    .open_store()
                    .map_or(organization::TeamGraphContextResult::Unavailable, |store| {
                        state.team_run.graph_context(&store, &query)
                    });
                let _ = reply.send(outcome);
            }
            OrganizationQuery::GraphDefinition {
                team_id,
                run_id,
                reply,
            } => {
                let outcome = state
                    .open_store()
                    .ok()
                    .and_then(|store| state.team_run.graph_definition(&store, &team_id, &run_id));
                let _ = reply.send(outcome);
            }
            OrganizationQuery::GraphYaml { run_id, reply } => {
                let outcome = state.open_store().ok().and_then(|store| {
                    store
                        .facts()
                        .run(&run_id)
                        .map(|run| organization::export_yaml(run.graph().definition()))
                });
                let _ = reply.send(outcome);
            }
            OrganizationQuery::TaskBoardRead {
                team_id,
                run_id,
                reply,
            } => {
                let outcome = state.open_store().map_or_else(
                    |_| organization::run::task_board::TaskBoardFacts::default(),
                    |store| store.task_board().scoped(&team_id, &run_id),
                );
                let _ = reply.send(outcome);
            }
            OrganizationQuery::PendingApprovals {
                team_id,
                run_id,
                reply,
            } => {
                let outcome = state.open_store().map_or(
                    organization::run::TeamPendingApprovalsQueryOutcome::Unavailable,
                    |store| {
                        state
                            .team_run
                            .query_pending_approvals(&store, &team_id, &run_id)
                    },
                );
                let _ = reply.send(outcome);
            }
            OrganizationQuery::NodePromptRetryDue { run_id, reply } => {
                let query = NodePromptRetryDueQuery::new(run_id, now_millis());
                let outcome = query.map_or(
                    NodePromptRetryDueQueryOutcome::Invalid(
                        NodePromptRetryDueInvalidReason::InvalidFacts,
                    ),
                    |query| {
                        state.open_store().map_or(
                            NodePromptRetryDueQueryOutcome::Invalid(
                                NodePromptRetryDueInvalidReason::InvalidFacts,
                            ),
                            |store| state.team_run.retry_due(&store, &query),
                        )
                    },
                );
                let _ = reply.send(outcome);
            }
            OrganizationQuery::TeamSkillValidate { .. }
            | OrganizationQuery::TeamSkillDependencyPlan { .. }
            | OrganizationQuery::TeamSkillSelectionValidate { .. }
            | OrganizationQuery::TeamSkillSelectionDependencyPlan { .. }
            | OrganizationQuery::RunList { .. }
            | OrganizationQuery::RoleSessions { .. }
            | OrganizationQuery::StartGateSessionBinding { .. }
            | OrganizationQuery::TriggerList { .. }
            | OrganizationQuery::Resume { .. }
            | OrganizationQuery::PendingRunActivityIds { .. }
            | OrganizationQuery::TerminalObservationDeliveries { .. }
            | OrganizationQuery::ActiveRunIds { .. }
            | OrganizationQuery::ActivityTarget { .. }
            | OrganizationQuery::MatchaTerminalTarget { .. } => {
                unreachable!("global organization query routed to run lane")
            }
        }
    }

    async fn handle_global_query(
        shared: Self::Shared,
        state: &mut Self::GlobalState,
        query: Self::Query,
    ) {
        match query {
            OrganizationQuery::TeamSkillValidate {
                package_root,
                reply,
            } => {
                let _ = reply.send(state.team_skill_validate(package_root));
            }
            OrganizationQuery::TeamSkillDependencyPlan {
                package_root,
                reply,
            } => {
                let _ = reply.send(state.team_skill_dependency_plan(package_root));
            }
            OrganizationQuery::TeamSkillSelectionValidate {
                selection_id,
                reply,
            } => {
                let _ = reply.send(state.validate_team_skill_selection(selection_id));
            }
            OrganizationQuery::TeamSkillSelectionDependencyPlan {
                selection_id,
                reply,
            } => {
                let outcome = state
                    .plan_team_skill_dependencies(&shared, selection_id)
                    .await;
                let _ = reply.send(outcome);
            }
            OrganizationQuery::RunList { team_id, reply } => {
                let outcome = match state.refresh() {
                    Ok(()) => state.team_run.list(&state.store, &team_id),
                    Err(_) => vec![organization::TeamRunQueryOutcome::Unavailable],
                };
                let _ = reply.send(outcome);
            }
            OrganizationQuery::RoleSessions { team_id, reply } => {
                let outcome = match state.refresh() {
                    Ok(()) => state.team_run.query_role_sessions(&state.store, &team_id),
                    Err(_) => organization::TeamRoleSessionQueryOutcome::Unavailable,
                };
                let _ = reply.send(outcome);
            }
            OrganizationQuery::StartGateSessionBinding { lookup, reply } => {
                let outcome = match state.refresh() {
                    Ok(()) => {
                        super::start_gate_control::resolve_binding(state.store.facts(), &lookup)
                    }
                    Err(_) => None,
                };
                let _ = reply.send(outcome);
            }
            OrganizationQuery::TriggerList { team_id, reply } => {
                let outcome = match state.refresh() {
                    Ok(()) => state
                        .team_run
                        .armed_triggers(&state.store, team_id.as_ref()),
                    Err(_) => Vec::new(),
                };
                let _ = reply.send(outcome);
            }
            OrganizationQuery::Resume { team_id, reply } => {
                let outcome = match state.refresh() {
                    Ok(()) => state.team_run.resume(&state.store, &team_id),
                    Err(_) => Vec::new(),
                };
                let _ = reply.send(outcome);
            }
            OrganizationQuery::PendingRunActivityIds { run_id, now, reply } => {
                let outcome = match state.refresh() {
                    Ok(()) => state.pending_run_activity_ids(&run_id, now),
                    Err(_) => Vec::new(),
                };
                let _ = reply.send(outcome);
            }
            OrganizationQuery::TerminalObservationDeliveries { reply } => {
                let outcome = match state.refresh() {
                    Ok(()) => state.team_run.terminal_observation_deliveries(&state.store),
                    Err(_) => Vec::new(),
                };
                let _ = reply.send(outcome);
            }
            OrganizationQuery::ActiveRunIds { reply } => {
                let outcome = match state.refresh() {
                    Ok(()) => state.active_run_ids(),
                    Err(_) => Vec::new(),
                };
                let _ = reply.send(outcome);
            }
            OrganizationQuery::ActivityTarget { activity_id, reply } => {
                let outcome = match state.refresh() {
                    Ok(()) => state.activity_target(&activity_id),
                    Err(_) => None,
                };
                let _ = reply.send(outcome);
            }
            OrganizationQuery::MatchaTerminalTarget { delivery_id, reply } => {
                let outcome = match state.refresh() {
                    Ok(()) => state.native_terminal_target(&delivery_id),
                    Err(_) => None,
                };
                let _ = reply.send(outcome);
            }
            OrganizationQuery::RunSnapshot { .. }
            | OrganizationQuery::TeamRunPublicProjection { .. }
            | OrganizationQuery::TeamRunPublicSnapshot { .. }
            | OrganizationQuery::TeamRunDiagnostics { .. }
            | OrganizationQuery::GraphContext { .. }
            | OrganizationQuery::GraphDefinition { .. }
            | OrganizationQuery::GraphYaml { .. }
            | OrganizationQuery::TaskBoardRead { .. }
            | OrganizationQuery::PendingApprovals { .. }
            | OrganizationQuery::NodePromptRetryDue { .. } => {
                unreachable!("run-local organization query routed to global lane")
            }
        }
    }

    async fn handle_exclusive_query(
        _shared: Self::Shared,
        _state: &mut Self::GlobalState,
        _query: Self::Query,
    ) {
    }
}

fn manual_materialization_outcome(
    outcome: organization::MaterializationOperationOutcome,
) -> ManualTeamCreateOutcome {
    match outcome {
        organization::MaterializationOperationOutcome::Confirmed { .. } => {
            ManualTeamCreateOutcome::OutcomeUnknown
        }
        organization::MaterializationOperationOutcome::Rejected { .. } => {
            ManualTeamCreateOutcome::Rejected
        }
        organization::MaterializationOperationOutcome::Accepted { .. }
        | organization::MaterializationOperationOutcome::OutcomeUnknown => {
            ManualTeamCreateOutcome::OutcomeUnknown
        }
    }
}

fn manual_runtime_receipt_outcome(outcome: RuntimeReceiptOutcome) -> ManualTeamCreateOutcome {
    match outcome {
        RuntimeReceiptOutcome::Installed => ManualTeamCreateOutcome::OutcomeUnknown,
        RuntimeReceiptOutcome::Rejected => ManualTeamCreateOutcome::Rejected,
        RuntimeReceiptOutcome::OutcomeUnknown => ManualTeamCreateOutcome::OutcomeUnknown,
        RuntimeReceiptOutcome::Unavailable => ManualTeamCreateOutcome::Unavailable,
    }
}

fn node_prompt_settled_status(error: StoreFault) -> TeamRuntimeStatus {
    match error {
        StoreFault::InvalidFacts | StoreFault::TerminalObservation(_) => {
            TeamRuntimeStatus::Rejected
        }
        StoreFault::CommitOutcomeUnknown(_) => TeamRuntimeStatus::OutcomeUnknown,
        _ => TeamRuntimeStatus::Unavailable,
    }
}

fn runtime_receipt_status(outcome: RuntimeReceiptOutcome) -> TeamRuntimeStatus {
    match outcome {
        RuntimeReceiptOutcome::Installed => TeamRuntimeStatus::OutcomeUnknown,
        RuntimeReceiptOutcome::Rejected => TeamRuntimeStatus::Rejected,
        RuntimeReceiptOutcome::OutcomeUnknown => TeamRuntimeStatus::OutcomeUnknown,
        RuntimeReceiptOutcome::Unavailable => TeamRuntimeStatus::Unavailable,
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
mod tests {
    use super::*;
    use crate::organization::run_scheduler::schedule_ready_nodes;
    use std::{
        fs,
        num::NonZeroU32,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
    };

    use crate::runtime::driver::{RuntimeCapabilitySurface, SkillOps, TeamOps};

    use organization::{
        ActivityFailure, ActivityPhase, DeliveryLedgerSnapshot, EdgeAction, EdgeDefinition, EdgeId,
        ExecutorPolicy, GraphDefinition, GraphEvent, GraphRunFacts, GraphState,
        ManagedAgentReference, MaterializationReceipt, MemberId, NodeDefinition, NodeId,
        OrganizationFacts, RoleAssignment, RoleId, RoleKind, RoleMaterializationReceipt,
        RoleSessionReceipt, RoleSessionRef, RunRuntimeReceipt, RuntimeEndpointReference,
        TeamDefinition, TeamFacts, TeamMember, TeamRevision, TeamRole, WorkAssignment, reduce,
    };

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
            &TeamRunOwner::new(),
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
                &TeamRunOwner::new(),
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
            &TeamRunOwner::new(),
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
            &TeamRunOwner::new(),
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
            &TeamRunOwner::new(),
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
            &TeamRunOwner::new(),
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

        let first = schedule_ready_nodes(&TeamRunOwner::new(), &mut store, run_one, 3).unwrap();
        let second = schedule_ready_nodes(&TeamRunOwner::new(), &mut store, run_two, 4).unwrap();

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
            &TeamRunOwner::new(),
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
            &TeamRunOwner::new(),
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
        let mut state = organization_state(store_without_team_materialization().1);
        state.team_skill_selections = TeamSkillSelectionResolver::open(selections).unwrap();
        let selection_id = state.team_skill_selections.authorize(&root).unwrap();
        let driver = Arc::new(FixedTeamDriver::new(
            organization::MaterializationOperationOutcome::OutcomeUnknown,
        ));
        let shared = organization_shared(driver.clone());

        assert_eq!(
            state
                .materialize_team_skill_selection(
                    &shared,
                    selection_id,
                    team_id(),
                    idempotency_key("team-skill:materialize"),
                )
                .await,
            TeamMaterializationCommandOutcome::Rejected,
        );
        assert_eq!(driver.materialize_count(), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn team_delete_repeated_after_cleanup_unknown_remains_unknown_without_failed_store_fault()
    {
        let (_temp_dir, store) =
            store_with_team_materialization(openclaw_materialization_receipt());
        let driver = Arc::new(FixedTeamDriver::new(
            organization::MaterializationOperationOutcome::OutcomeUnknown,
        ));
        let shared = organization_shared(driver.clone());
        let mut state = organization_state(store);

        assert_eq!(
            state
                .team_delete(
                    &shared,
                    team_id(),
                    idempotency_key("team-delete:team:one"),
                    1
                )
                .await,
            Ok(TeamDeleteOutcome::OutcomeUnknown)
        );
        assert_eq!(
            state
                .team_delete(
                    &shared,
                    team_id(),
                    idempotency_key("team-delete:team:one"),
                    2
                )
                .await,
            Ok(TeamDeleteOutcome::OutcomeUnknown)
        );
        assert_eq!(driver.remove_count(), 1);
    }

    #[tokio::test]
    async fn team_delete_tombstones_cancelled_run_before_materialization_cleanup() {
        let receipt = openclaw_materialization_receipt();
        let (_temp_dir, mut store) =
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
        let shared = organization_shared(driver.clone());
        let mut state = organization_state(store);

        assert_eq!(
            state
                .team_delete(
                    &shared,
                    team_id(),
                    idempotency_key("team-delete:team:one"),
                    3
                )
                .await,
            Ok(TeamDeleteOutcome::Deleted)
        );
        assert_eq!(driver.delete_count(), 1);
        assert_eq!(driver.remove_count(), 1);
        assert!(
            state
                .store
                .facts()
                .run(&GraphRunId::new("run:one"))
                .is_none()
        );
    }

    #[tokio::test]
    async fn team_delete_recovers_same_key_unknown_run_before_materialization_cleanup() {
        let receipt = openclaw_materialization_receipt();
        let (_temp_dir, mut store) =
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
        let shared = organization_shared(driver.clone());
        let mut state = organization_state(store);

        assert_eq!(
            state
                .team_delete(
                    &shared,
                    team_id(),
                    idempotency_key("team-delete:team:one"),
                    3
                )
                .await,
            Ok(TeamDeleteOutcome::Deleted)
        );
        assert_eq!(driver.delete_count(), 1);
        assert_eq!(driver.remove_count(), 1);
        assert!(
            state
                .store
                .facts()
                .run(&GraphRunId::new("run:one"))
                .is_none()
        );
    }

    #[tokio::test]
    async fn team_delete_confirmed_cleanup_replays_deleted_without_second_native_remove() {
        let receipt = openclaw_materialization_receipt();
        let (_temp_dir, store) = store_with_team_materialization(receipt.clone());
        let driver = Arc::new(FixedTeamDriver::new(
            organization::MaterializationOperationOutcome::Confirmed { receipt },
        ));
        let shared = organization_shared(driver.clone());
        let mut state = organization_state(store);

        assert_eq!(
            state
                .team_delete(
                    &shared,
                    team_id(),
                    idempotency_key("team-delete:team:one"),
                    1
                )
                .await,
            Ok(TeamDeleteOutcome::Deleted)
        );
        assert_eq!(
            state
                .team_delete(
                    &shared,
                    team_id(),
                    idempotency_key("team-delete:team:one"),
                    2
                )
                .await,
            Ok(TeamDeleteOutcome::Deleted)
        );
        assert_eq!(driver.remove_count(), 1);
    }

    #[tokio::test]
    async fn team_delete_without_materialization_tombstones_without_native_remove() {
        let (_temp_dir, store) = store_without_team_materialization();
        let driver = Arc::new(FixedTeamDriver::new(
            organization::MaterializationOperationOutcome::OutcomeUnknown,
        ));
        let shared = organization_shared(driver.clone());
        let mut state = organization_state(store);

        assert_eq!(
            state
                .team_delete(
                    &shared,
                    team_id(),
                    idempotency_key("team-delete:team:one"),
                    1
                )
                .await,
            Ok(TeamDeleteOutcome::Deleted)
        );
        assert!(state.store.facts().team(&team_id()).unwrap().tombstoned());
        assert_eq!(driver.remove_count(), 0);
    }

    #[tokio::test]
    async fn team_delete_unknown_local_team_deletes_without_native_remove() {
        let temp_dir = tempfile::tempdir().unwrap();
        let store =
            OrganizationStore::open(temp_dir.path().join("organization-facts.log")).unwrap();
        let driver = Arc::new(FixedTeamDriver::new(
            organization::MaterializationOperationOutcome::OutcomeUnknown,
        ));
        let shared = organization_shared(driver.clone());
        let mut state = organization_state(store);

        assert_eq!(
            state
                .team_delete(
                    &shared,
                    team_id(),
                    idempotency_key("team-delete:team:one"),
                    1
                )
                .await,
            Ok(TeamDeleteOutcome::Deleted)
        );
        assert_eq!(driver.remove_count(), 0);
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
                None,
            ),
        )
    }

    fn store_with_graph(graph: GraphState) -> (tempfile::TempDir, OrganizationStore) {
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

    fn organization_state(store: OrganizationStore) -> OrganizationGlobalState {
        let selections = tempfile::tempdir()
            .unwrap()
            .path()
            .join("team-skill-selections.json");
        OrganizationGlobalState {
            store,
            team_run: TeamRunOwner::new(),
            team_skill_selections: TeamSkillSelectionResolver::open(selections).unwrap(),
        }
    }

    fn organization_shared(driver: Arc<FixedTeamDriver>) -> OrganizationShared {
        let mut runtime_directory = RuntimeDriverDirectory::new();
        runtime_directory.register(driver);
        OrganizationShared {
            runtime_directory: Arc::new(runtime_directory),
            store_path: PathBuf::new(),
        }
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
                .map(|(graph, runtime)| {
                    GraphRunFacts::new(team_id(), TeamRevision::initial(), graph, Some(runtime))
                        .unwrap()
                })
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
                .map(|(graph, runtime)| {
                    GraphRunFacts::new(team_id(), TeamRevision::initial(), graph, Some(runtime))
                        .unwrap()
                })
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

    impl RuntimeDriver for FixedTeamDriver {
        fn identity(&self) -> RuntimeDriverIdentity {
            RuntimeDriverIdentity::open_claw()
        }

        fn capability_surface(&self) -> RuntimeCapabilitySurface {
            RuntimeCapabilitySurface::open_claw()
        }

        fn team_ops(&self) -> Option<&dyn TeamOps> {
            Some(self)
        }

        fn skill_ops(&self) -> Option<&dyn SkillOps> {
            Some(self)
        }
    }

    impl SkillOps for FixedTeamDriver {
        fn installed_skill_catalog(
            &self,
        ) -> OwnedRuntimeFuture<Option<openclaw::skill::InstalledSkillCatalog>> {
            Box::pin(async { Some(openclaw::skill::InstalledSkillCatalog::default()) })
        }

        fn install_clawhub_skill<'a>(
            &'a self,
            _command: crate::skills::install::Command,
        ) -> crate::runtime::driver::SessionFuture<'a, crate::skills::install::Outcome> {
            Box::pin(async { crate::skills::install::Outcome::Unknown })
        }

        fn skill_status<'a>(
            &'a self,
        ) -> crate::runtime::driver::SessionFuture<'a, crate::skills::status::Outcome> {
            Box::pin(async { crate::skills::status::Outcome::Unavailable })
        }

        fn manage_skills<'a>(
            &'a self,
            _command: crate::skills::management::Command,
        ) -> crate::runtime::driver::SessionFuture<'a, crate::skills::management::Outcome> {
            Box::pin(async { crate::skills::management::Outcome::Unavailable })
        }

        fn skill_bundles<'a>(
            &'a self,
            _command: crate::skills::bundle::Command,
        ) -> crate::runtime::driver::SessionFuture<'a, crate::skills::bundle::Outcome> {
            Box::pin(async { crate::skills::bundle::Outcome::Unknown })
        }
    }

    impl TeamOps for FixedTeamDriver {
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

        fn deliver_prompt(
            &self,
            _request: organization::PromptDeliveryRequest,
        ) -> OwnedRuntimeFuture<organization::PromptDeliveryOutcome> {
            Box::pin(async { organization::PromptDeliveryOutcome::OutcomeUnknown })
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
