use platform::{
    state_dir::CanonicalStateDir,
    trace::{identifier_hash, session_trace},
};
use serde_json::json;
use std::{fmt, sync::Arc, time::Instant};

use organization::{
    ManagedAgentReference, MaterializationOperationOutcome, MaterializationReceipt,
    NativeWorkspaceReceipt, RoleMaterializationAgent, RoleMaterializationOwnership,
    RoleMaterializationReceipt, TeamCreationFailure, TeamCreationFailureReason as FailureReason,
    TeamCreationFile, TeamCreationStage as CreationStage, TeamMaterializationRemoval,
    TeamMaterializationRequest,
    TeamProvisionObserver, TeamProvisionStage, TeamProvisionUpdate,
};

use super::{
    agent::{
        TeamAgent, TeamAgentCreate, TeamAgentUpdate, TeamAgents, TeamConfigAgent,
        TeamConfigSnapshot, TeamOwnedAgentId,
    },
    buddy::TeamBuddyMarker,
    config::{CompensationState, ConfigCompensation, ConfigUndo},
    recovery::{TeamRecoveryOutcome, TeamRecoveryRequest},
    workspace::{ResolvedWorkspace, TeamExternalWorkspaces, TeamWorkspaceProjection},
};
use crate::{
    agents::{AgentsReadFailure, OpenClawAgents},
    gateway::{
        client::{GatewayClient, GatewayClientError},
        delivery::{DispatcherError, MutationDelivery},
        wire::{self, GatewayResponse},
    },
    native_config::config_store::OpenClawConfigStore,
};

pub(crate) struct TeamProvider {
    gateway: Arc<GatewayClient>,
    config: OpenClawConfigStore,
    cancellation: tokio_util::sync::CancellationToken,
}

pub(crate) enum MutationOutcome<T> {
    Applied(T),
    Rejected,
    NotWritten(DispatcherError),
    MayHaveReached(DispatcherError),
    OutcomeUnknown,
}

impl<T: fmt::Debug> fmt::Debug for MutationOutcome<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Applied(_) => formatter.write_str("MutationOutcome::Applied"),
            Self::Rejected => formatter.write_str("MutationOutcome::Rejected"),
            Self::NotWritten(_) => formatter.write_str("MutationOutcome::NotWritten"),
            Self::MayHaveReached(_) => formatter.write_str("MutationOutcome::MayHaveReached"),
            Self::OutcomeUnknown => formatter.write_str("MutationOutcome::OutcomeUnknown"),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ReadFailure {
    Unavailable,
    Rejected,
    Protocol,
    Deadline,
    Authentication,
    Cancelled,
}

impl From<AgentsReadFailure> for ReadFailure {
    fn from(error: AgentsReadFailure) -> Self {
        match error {
            AgentsReadFailure::Unavailable => Self::Unavailable,
            AgentsReadFailure::Deadline => Self::Deadline,
            AgentsReadFailure::Authentication => Self::Authentication,
            AgentsReadFailure::Rejected => Self::Rejected,
            AgentsReadFailure::Protocol => Self::Protocol,
        }
    }
}

impl TeamProvider {
    pub(crate) fn new(gateway: &GatewayClient, state_dir: CanonicalStateDir) -> Self {
        Self {
            gateway: Arc::new(gateway.clone()),
            config: OpenClawConfigStore::new(state_dir),
            cancellation: tokio_util::sync::CancellationToken::new(),
        }
    }

    pub(crate) fn with_cancellation(mut self, cancellation: tokio_util::sync::CancellationToken) -> Self {
        self.cancellation = cancellation;
        self
    }

    pub(crate) async fn list_agents(&self) -> Result<TeamAgents, ReadFailure> {
        let started = platform::trace::enabled().then(Instant::now);
        session_trace("runtime.team.native-list.request", || json!({}));
        let provider = OpenClawAgents::new(Arc::clone(&self.gateway));
        let listed = tokio::select! {
            biased;
            result = provider.list() => result.map_err(ReadFailure::from),
            _ = self.cancellation.cancelled() => Err(ReadFailure::Cancelled),
        };
        listed.map(|agents| {
                TeamAgents::new(
                    agents
                        .agents
                        .into_iter()
                        .map(|agent| TeamAgent::new(agent.id, agent.workspace))
                        .collect(),
                )
            })
            .inspect(|agents| session_trace("runtime.team.native-list.end", || json!({"outcome":"Succeeded","count":agents.as_slice().len(),"elapsedMs":started.map(|started| started.elapsed().as_millis()).unwrap_or_default()})))
            .inspect_err(|failure| session_trace("runtime.team.native-list.end", || json!({"outcome":format!("{failure:?}"),"elapsedMs":started.map(|started| started.elapsed().as_millis()).unwrap_or_default()})))
    }

    pub(crate) async fn recover(
        &self,
        request: TeamRecoveryRequest,
    ) -> Result<TeamRecoveryOutcome, ReadFailure> {
        self.list_agents()
            .await
            .map(|agents| agents.recover(request))
    }

    pub(crate) async fn recover_materialization(
        &self,
        request: TeamMaterializationRequest,
    ) -> MaterializationOperationOutcome {
        self.recover_materialization_observed(request, None).await
    }

    async fn recover_materialization_observed(
        &self,
        request: TeamMaterializationRequest,
        observer: Option<TeamProvisionObserver>,
    ) -> MaterializationOperationOutcome {
        let started = platform::trace::enabled().then(Instant::now);
        let unknown = async |reason, stage, failure, file| {
            session_trace(
                "runtime.team.recovery.end",
                || json!({"outcome":"OutcomeUnknown","reason":reason,"elapsedMs":started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}),
            );
            report_failure(observer.as_ref(), stage, failure, file).await;
            MaterializationOperationOutcome::OutcomeUnknown
        };
        session_trace(
            "runtime.team.recovery.request",
            || json!({"count":request.intent().agents().len()}),
        );
        session_trace(
            "runtime.team.undo.read.request",
            || json!({"operation":"recovery"}),
        );
        let undo = match ConfigUndo::load(&self.config.state_dir(), request.intent().team()) {
            Ok(Some(undo)) => {
                session_trace(
                    "runtime.team.undo.read.end",
                    || json!({"outcome":"Succeeded","present":true}),
                );
                undo
            }
            Ok(None) => return unknown("undo-missing", CreationStage::ConfiguringTeam, FailureReason::StoreReadFailed, None).await,
            Err(()) => return unknown("undo-read", CreationStage::ConfiguringTeam, FailureReason::StoreReadFailed, None).await,
        };
        if (undo.is_removing() && !undo.is_removed() && !undo.is_compensated()) || !undo.matches_request(&request) {
            return unknown("undo-request-mismatch", CreationStage::ConfiguringTeam, FailureReason::StoreConflict, None).await;
        }
        if (undo.compensation().is_some() || undo.config_not_written() || undo.is_provisioning())
            && !undo.is_compensated() && !undo.is_removed()
        {
            let mut undo = undo;
            if undo.compensation().is_none() {
                let Ok(roles) = undo.roles() else {
                    return unknown("undo-receipt-decode", CreationStage::ConfiguringTeam, FailureReason::StoreInvalid, None).await;
                };
                let created = roles.iter()
                    .filter(|role| role.ownership() == RoleMaterializationOwnership::Managed)
                    .map(|role| TeamOwnedAgentId::try_new(role.agent().as_str()))
                    .collect::<Result<Vec<_>, _>>();
                let Ok(created) = created else {
                    return unknown("undo-agent-decode", CreationStage::ConfiguringTeam, FailureReason::StoreInvalid, None).await;
                };
                if undo.begin_compensation(&self.config.state_dir(), &created, true).is_err() {
                    return unknown("undo-compensation-write", CreationStage::ConfiguringTeam, FailureReason::StoreWriteFailed, None).await;
                }
            }
            return if self.compensate_config_undo(&mut undo).await {
                MaterializationOperationOutcome::Rejected { rejection: undo.rejection() }
            } else {
                MaterializationOperationOutcome::OutcomeUnknown
            };
        }
        if undo.is_compensated() {
            if !undo.compensation_completed() {
                return unknown("cleanup-ack-missing", CreationStage::ConfiguringTeam, FailureReason::OutcomeUnknown, None).await;
            }
            let Ok(roles) = undo.roles() else {
                return unknown("undo-receipt-decode", CreationStage::ConfiguringTeam, FailureReason::StoreInvalid, None).await;
            };
            if let Some(observer) = &observer {
                observer
                    .report(TeamProvisionUpdate::Stage(
                        TeamProvisionStage::VerifyingTeam,
                    ))
                    .await;
            }
            for role in &roles {
                let Some(workspace) = role.native_workspace() else {
                    return unknown("receipt-workspace-missing", CreationStage::VerifyingTeam, FailureReason::WorkspaceMissing, None).await;
                };
                let present = TeamBuddyMarker::new(request.intent().team().clone(), role.role().clone())
                    .has_marker(std::path::Path::new(workspace.as_str()));
                session_trace(
                    "runtime.team.recovery.compensated-marker.end",
                    || json!({"present":present.as_ref().ok(),"reason":if matches!(present, Ok(false)) {"marker-absent"} else {"marker-unresolved"}}),
                );
                if !matches!(present, Ok(false)) {
                    return unknown("compensated-marker-unresolved", CreationStage::VerifyingTeam, if present.is_err() { FailureReason::NativeReadFailed } else { FailureReason::NativeReadbackMismatch }, Some(TeamCreationFile::AgentsMarkdown)).await;
                }
            }
            session_trace(
                "runtime.team.recovery.end",
                || json!({"outcome":"Rejected","reason":"compensated","elapsedMs":started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}),
            );
            return MaterializationOperationOutcome::Rejected { rejection: undo.rejection() };
        }
        let (facts, receipt) = (undo.facts(), undo.receipt());
        session_trace(
            "runtime.team.undo.decode",
            || json!({"factsValid":facts.is_ok(),"receiptValid":receipt.is_ok()}),
        );
        let (Ok(facts), Ok(receipt)) = (facts, receipt) else {
            return unknown("undo-decode", CreationStage::ConfiguringTeam, FailureReason::StoreInvalid, None).await;
        };
        if let Some(observer) = &observer {
            observer
                .report(TeamProvisionUpdate::Stage(
                    TeamProvisionStage::VerifyingTeam,
                ))
                .await;
        }
        let snapshot = match self.config_snapshot().await {
            Ok(snapshot) => snapshot,
            Err(failure) => return unknown("config-read", CreationStage::VerifyingTeam, read_failure_reason(failure), None).await,
        };
        if !snapshot.0.matches_agents(&facts) {
            return unknown("config-mismatch", CreationStage::VerifyingTeam, FailureReason::NativeReadbackMismatch, None).await;
        }
        let recovery_request = TeamRecoveryRequest::try_new(
            receipt.team().as_str(),
            receipt
                .roles()
                .iter()
                .map(|role| {
                    super::recovery::TeamRecoveryRole::try_new(
                        role.role().as_str(),
                        role.agent().as_str(),
                    )
                })
                .collect::<Result<_, _>>()
                .expect("validated receipt roles"),
        )
        .expect("validated receipt");
        let recovered = match self.recover(recovery_request).await {
            Ok(TeamRecoveryOutcome::Recovered(recovered)) => recovered,
            Ok(TeamRecoveryOutcome::Unknown) => return unknown("native-recovery-unknown", CreationStage::VerifyingTeam, FailureReason::NativeReadbackMismatch, None).await,
            Err(failure) => return unknown("native-list", CreationStage::VerifyingTeam, read_failure_reason(failure), None).await,
        };
        for (index, role) in receipt.roles().iter().enumerate() {
            session_trace(
                "runtime.team.recovery.workspace",
                || json!({"index":index,"roleHash":identifier_hash(role.role().as_str()),"agentHash":identifier_hash(role.agent().as_str()),"workspacePresent":role.native_workspace().is_some()}),
            );
            let Some(workspace) = role.native_workspace() else {
                return unknown("receipt-workspace-missing", CreationStage::VerifyingTeam, FailureReason::WorkspaceMissing, None).await;
            };
            if !recovered.roles().iter().any(|native| {
                native.role().as_str() == role.role().as_str()
                    && native.agent().as_str() == role.agent().as_str()
                    && native.workspace().as_str() == workspace.as_str()
            }) {
                session_trace(
                    "runtime.team.recovery.workspace.end",
                    || json!({"index":index,"reason":"native-workspace-mismatch","outcome":"OutcomeUnknown"}),
                );
                return unknown("native-workspace-mismatch", CreationStage::VerifyingTeam, FailureReason::NativeReadbackMismatch, None).await;
            }
            session_trace(
                "runtime.team.recovery.workspace.end",
                || json!({"index":index,"outcome":"Confirmed"}),
            );
        }
        // Durable expected config and all native identities are verified above.
        // Finish only missing markers after an interrupted materialization.
        for (index, role) in receipt.roles().iter().enumerate() {
            let marker_started = platform::trace::enabled().then(Instant::now);
            let role_hash = platform::trace::enabled().then(|| identifier_hash(role.role().as_str()));
            let agent_hash = platform::trace::enabled().then(|| identifier_hash(role.agent().as_str()));
            let workspace = std::path::Path::new(
                role.native_workspace()
                    .expect("verified workspace")
                    .as_str(),
            );
            let marker = TeamBuddyMarker::new(receipt.team().clone(), role.role().clone())
                .with_content(role.agents_markdown().unwrap_or(""));
            session_trace(
                "runtime.team.marker.recover.request",
                || json!({"index":index,"roleHash":role_hash,"agentHash":agent_hash}),
            );
            let recovered = marker.recover(workspace);
            session_trace(
                "runtime.team.marker.recover.end",
                || json!({"index":index,"matched":recovered.as_ref().ok(),"ioKind":recovered.as_ref().err().map(|error| format!("{:?}", error.kind())),"elapsedMs":marker_started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}),
            );
            match recovered {
                Ok(true) => {}
                Ok(false) => {
                    session_trace(
                        "runtime.team.marker.write.request",
                        || json!({"index":index,"roleHash":role_hash,"agentHash":agent_hash}),
                    );
                    let written = marker.write(workspace);
                    session_trace(
                        "runtime.team.marker.write.end",
                        || json!({"index":index,"succeeded":written.is_ok(),"ioKind":written.as_ref().err().map(|error| format!("{:?}", error.kind())),"elapsedMs":marker_started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}),
                    );
                    if written.is_err() {
                        return unknown("marker-write", CreationStage::ConfiguringTeam, FailureReason::NativeWriteFailed, Some(TeamCreationFile::AgentsMarkdown)).await;
                    }
                    session_trace(
                        "runtime.team.marker.readback.request",
                        || json!({"index":index}),
                    );
                    let readback = marker.recover(workspace);
                    session_trace(
                        "runtime.team.marker.readback.end",
                        || json!({"index":index,"matched":readback.as_ref().ok(),"ioKind":readback.as_ref().err().map(|error| format!("{:?}", error.kind())),"elapsedMs":marker_started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}),
                    );
                    if !matches!(readback, Ok(true)) {
                        return unknown("marker-readback", CreationStage::VerifyingTeam, if readback.is_err() { FailureReason::NativeReadFailed } else { FailureReason::NativeReadbackMismatch }, Some(TeamCreationFile::AgentsMarkdown)).await;
                    }
                }
                Err(_) => return unknown("marker-recover", CreationStage::VerifyingTeam, FailureReason::NativeReadFailed, Some(TeamCreationFile::AgentsMarkdown)).await,
            }
        }
        session_trace(
            "runtime.team.recovery.end",
            || json!({"outcome":"Confirmed","elapsedMs":started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}),
        );
        MaterializationOperationOutcome::Confirmed { receipt }
    }

    pub(crate) async fn materialize(
        &self,
        request: TeamMaterializationRequest,
    ) -> MaterializationOperationOutcome {
        self.materialize_observed(request, None).await
    }

    pub(crate) async fn materialize_observed(
        &self,
        request: TeamMaterializationRequest,
        observer: Option<TeamProvisionObserver>,
    ) -> MaterializationOperationOutcome {
        let started = platform::trace::enabled().then(Instant::now);
        session_trace(
            "runtime.team.materialize.request",
            || json!({"count":request.intent().agents().len()}),
        );
        let outcome = async {
            session_trace(
                "runtime.team.undo.read.request",
                || json!({"operation":"materialize"}),
            );
            match ConfigUndo::load(&self.config.state_dir(), request.intent().team()) {
                Ok(Some(_)) => {
                    session_trace(
                        "runtime.team.undo.read.end",
                        || json!({"present":true,"outcome":"Succeeded","reason":"recover-existing"}),
                    );
                    return self
                        .recover_materialization_observed(request, observer)
                        .await;
                }
                Ok(None) => session_trace(
                    "runtime.team.undo.read.end",
                    || json!({"present":false,"outcome":"Succeeded"}),
                ),
                Err(()) => {
                    session_trace(
                        "runtime.team.undo.read.end",
                        || json!({"outcome":"OutcomeUnknown","reason":"undo-read"}),
                    );
                    report_failure(observer.as_ref(), CreationStage::ConfiguringTeam, FailureReason::StoreReadFailed, None).await;
                    return MaterializationOperationOutcome::OutcomeUnknown;
                }
            }
            let workspaces = match self.workspace_projection_for_request(&request) {
                Ok(workspaces) => workspaces,
                Err(WorkspaceProjectionError::Rejected) => {
                    report_failure(observer.as_ref(), CreationStage::ConfiguringTeam, FailureReason::InvalidConfig, None).await;
                    return permanent_rejection();
                }
                Err(WorkspaceProjectionError::Unknown) => {
                    report_failure(observer.as_ref(), CreationStage::ConfiguringTeam, FailureReason::StoreReadFailed, None).await;
                    return MaterializationOperationOutcome::OutcomeUnknown;
                }
            };
            let external_workspaces = match self.external_workspaces_for_request(&request, observer.as_ref()).await {
                Ok(workspaces) => workspaces,
                Err(WorkspaceProjectionError::Rejected) => return permanent_rejection(),
                Err(WorkspaceProjectionError::Unknown) => {
                    return MaterializationOperationOutcome::OutcomeUnknown;
                }
            };
            self.materialize_request(request, workspaces, external_workspaces, observer.as_ref())
                .await
        }
        .await;
        session_trace(
            "runtime.team.materialize.end",
            || json!({"outcome":match &outcome { MaterializationOperationOutcome::Confirmed { .. } => "Confirmed", MaterializationOperationOutcome::Rejected { .. } => "Rejected", _ => "OutcomeUnknown" },"elapsedMs":started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}),
        );
        outcome
    }

    async fn materialize_request(
        &self,
        request: TeamMaterializationRequest,
        workspaces: TeamWorkspaceProjection,
        external_workspaces: TeamExternalWorkspaces,
        observer: Option<&TeamProvisionObserver>,
    ) -> MaterializationOperationOutcome {
        let mut config_agents = Vec::new();
        let mut verified_roles = Vec::with_capacity(request.intent().agents().len());
        let mut progress = MaterializationProgress::default();
        for (index, role) in request.intent().agents().iter().enumerate() {
            session_trace(
                "runtime.team.materialize.role.request",
                || json!({"index":index,"roleHash":identifier_hash(role.role().as_str()),"agentHash":match role.agent() { RoleMaterializationAgent::External { agent } => Some(identifier_hash(agent.as_str())), _ => None },"managed":matches!(role.agent(), RoleMaterializationAgent::Managed { .. })}),
            );
            match role.agent() {
                RoleMaterializationAgent::Managed { name } => {
                    let Some(workspace) = workspaces.resolve(role.role()) else {
                        session_trace(
                            "runtime.team.materialize.role.end",
                            || json!({"index":index,"reason":"managed-workspace-missing","outcome":"Rejected"}),
                        );
                        report_failure(observer, CreationStage::ConfiguringTeam, FailureReason::WorkspaceMissing, None).await;
                        return self
                            .fail_materialization(&mut progress, permanent_rejection(), observer)
                            .await;
                    };
                    if progress.created_agents.is_empty() {
                        if let Some(observer) = observer {
                            observer
                                .report(TeamProvisionUpdate::Stage(
                                    TeamProvisionStage::ConfiguringTeam,
                                ))
                                .await;
                        }
                    }
                    let (outcome, created_agent) = self
                        .materialize_managed_agent(&request, role, workspace.clone(), &mut progress, observer)
                        .await;
                    session_trace(
                        "runtime.team.materialize.role.end",
                        || json!({"index":index,"reason":"managed-agent","outcome":match &outcome { MutationOutcome::Applied(_) => "Applied", MutationOutcome::Rejected => "Rejected", MutationOutcome::NotWritten(_) => "NotWritten", MutationOutcome::MayHaveReached(_) | MutationOutcome::OutcomeUnknown => "OutcomeUnknown" },"agentHash":created_agent.as_ref().map(|agent| identifier_hash(agent.as_str()))}),
                    );
                    if let Some(agent_id) = created_agent {
                        progress.created_agents.push(agent_id);
                    }
                    if let MutationOutcome::Applied(agent_id) = &outcome {
                        config_agents.push(TeamConfigAgent::new(
                            agent_id.clone(),
                            name.clone(),
                            workspace.clone(),
                            role.tools(),
                        ));
                    }
                    match outcome {
                        MutationOutcome::Applied(agent_id) => {
                            verified_roles.push(VerifiedRole::managed(
                                role.role().clone(),
                                agent_id,
                                workspace,
                            ));
                        }
                        MutationOutcome::Rejected => {
                            return self
                                .fail_materialization(
                                    &mut progress,
                                    permanent_rejection(),
                                    observer,
                                )
                                .await;
                        }
                        MutationOutcome::NotWritten(_) => {
                            return self
                                .fail_materialization(
                                    &mut progress,
                                    retryable_rejection(),
                                    observer,
                                )
                                .await;
                        }
                        MutationOutcome::MayHaveReached(_) | MutationOutcome::OutcomeUnknown => {
                            return self
                                .fail_materialization(
                                    &mut progress,
                                    MaterializationOperationOutcome::OutcomeUnknown,
                                    observer,
                                )
                                .await;
                        }
                    }
                }
                RoleMaterializationAgent::External { agent } => {
                    let agent_id = TeamOwnedAgentId::try_new(agent.as_str())
                        .expect("validated materialization intent must have an external agent");
                    let Some(workspace) = external_workspaces.resolve(&agent_id) else {
                        session_trace(
                            "runtime.team.materialize.role.end",
                            || json!({"index":index,"reason":"external-workspace-missing","outcome":"Rejected"}),
                        );
                        report_failure(observer, CreationStage::ConfiguringTeam, FailureReason::WorkspaceMissing, None).await;
                        return self
                            .fail_materialization(&mut progress, permanent_rejection(), observer)
                            .await;
                    };
                    session_trace(
                        "runtime.team.materialize.role.end",
                        || json!({"index":index,"outcome":"Resolved","workspacePresent":true}),
                    );
                    config_agents.push(TeamConfigAgent::external(&agent_id, role.tools()));
                    verified_roles.push(VerifiedRole::external(
                        role.role().clone(),
                        agent_id,
                        workspace,
                    ));
                }
            }
        }
        if !config_agents.is_empty() {
            let snapshot = match self.config_snapshot().await {
                Ok(snapshot) => snapshot,
                Err(failure) => {
                    session_trace(
                        "runtime.team.materialize.failed",
                        || json!({"reason":"config-read","outcome":"OutcomeUnknown"}),
                    );
                    report_failure(observer, CreationStage::ConfiguringTeam, read_failure_reason(failure), None).await;
                    return self
                        .fail_materialization(&mut progress, permanent_rejection(), observer)
                        .await;
                }
            };
            let planned_receipt = MaterializationReceipt::try_new(
                request.intent().team().clone(),
                request.intent().endpoint().clone(),
                verified_roles
                    .iter()
                    .zip(request.intent().agents())
                    .map(|(role, requested)| {
                        let receipt = RoleMaterializationReceipt::with_native_workspace(
                            role.role.clone(),
                            ManagedAgentReference::try_new(role.agent_id.as_str())
                                .expect("validated agent"),
                            role.ownership,
                            request.intent().endpoint().clone(),
                            NativeWorkspaceReceipt::try_new(role.workspace.as_str())
                                .expect("validated workspace"),
                        );
                        match requested.agents_markdown() {
                            Some(markdown) => receipt.with_agents_markdown(markdown),
                            None => receipt,
                        }
                    })
                    .collect(),
            )
            .expect("validated materialization roles");
            match self
                .apply_config_agents(
                    snapshot,
                    config_agents,
                    &request,
                    &planned_receipt,
                    &mut progress,
                    observer,
                )
                .await
            {
                MutationOutcome::Applied(()) => {}
                MutationOutcome::Rejected => {
                    session_trace(
                        "runtime.team.materialize.failed",
                        || json!({"reason":"config-apply","outcome":"Rejected"}),
                    );
                    return self
                        .fail_materialization(&mut progress, permanent_rejection(), observer)
                        .await;
                }
                MutationOutcome::NotWritten(_) => {
                    return self
                        .fail_materialization(&mut progress, retryable_rejection(), observer)
                        .await;
                }
                MutationOutcome::MayHaveReached(_) | MutationOutcome::OutcomeUnknown => {
                    session_trace(
                        "runtime.team.materialize.failed",
                        || json!({"reason":"config-apply","outcome":"OutcomeUnknown","undoRetained":true}),
                    );
                    // A late config write may still arrive; retain its durable undo.
                    return MaterializationOperationOutcome::OutcomeUnknown;
                }
            }
        }
        let agents = match self.list_agents().await {
            Ok(agents) => agents,
            Err(failure) => {
                session_trace(
                    "runtime.team.materialize.failed",
                    || json!({"reason":"native-readback-list","outcome":"OutcomeUnknown"}),
                );
                report_failure(observer, CreationStage::VerifyingTeam, read_failure_reason(failure), None).await;
                return self
                    .fail_materialization(&mut progress, permanent_rejection(), observer)
                    .await;
            }
        };
        let mut confirmed_roles = Vec::with_capacity(verified_roles.len());
        for (index, (verified, requested)) in verified_roles
            .into_iter()
            .zip(request.intent().agents())
            .enumerate()
        {
            session_trace(
                "runtime.team.materialize.native-readback.request",
                || json!({"index":index,"roleHash":identifier_hash(verified.role.as_str()),"agentHash":identifier_hash(verified.agent_id.as_str())}),
            );
            let Some(agent) = agents.as_slice().iter().find(|agent| {
                agent.id().as_str() == verified.agent_id.0
                    && agent
                        .workspace()
                        .is_some_and(|workspace| workspace == &verified.workspace)
            }) else {
                session_trace(
                    "runtime.team.materialize.native-readback.end",
                    || json!({"index":index,"reason":"agent-workspace-mismatch","outcome":"OutcomeUnknown"}),
                );
                report_failure(observer, CreationStage::VerifyingTeam, FailureReason::NativeReadbackMismatch, None).await;
                return self
                    .fail_materialization(&mut progress, permanent_rejection(), observer)
                    .await;
            };
            if agents
                .as_slice()
                .iter()
                .filter(|candidate| candidate.id().as_str() == agent.id().as_str())
                .count()
                != 1
            {
                session_trace(
                    "runtime.team.materialize.native-readback.end",
                    || json!({"index":index,"reason":"duplicate-agent","outcome":"OutcomeUnknown"}),
                );
                report_failure(observer, CreationStage::VerifyingTeam, FailureReason::AgentDuplicate, None).await;
                return self
                    .fail_materialization(&mut progress, permanent_rejection(), observer)
                    .await;
            }
            session_trace(
                "runtime.team.materialize.native-readback.end",
                || json!({"index":index,"outcome":"Confirmed","workspacePresent":true}),
            );
            let agent = ManagedAgentReference::try_new(verified.agent_id.0)
                .expect("native readback agent ID must be a valid materialization reference");
            let workspace_receipt =
                NativeWorkspaceReceipt::try_new(verified.workspace.as_str().to_owned())
                    .expect("native readback workspace must be a valid workspace receipt");
            let receipt = RoleMaterializationReceipt::with_native_workspace(
                verified.role,
                agent,
                verified.ownership,
                request.intent().endpoint().clone(),
                workspace_receipt,
            );
            confirmed_roles.push(match requested.agents_markdown() {
                Some(markdown) => receipt.with_agents_markdown(markdown),
                None => receipt,
            });
            progress.markers.push((
                TeamBuddyMarker::new(
                    request.intent().team().clone(),
                    confirmed_roles
                        .last()
                        .expect("role was recorded")
                        .role()
                        .clone(),
                )
                .with_content(requested.agents_markdown().unwrap_or("")),
                verified.workspace,
            ));
        }
        while progress.written_markers < progress.markers.len() {
            let index = progress.written_markers;
            let (marker, workspace) = &progress.markers[index];
            let marker_started = platform::trace::enabled().then(Instant::now);
            session_trace(
                "runtime.team.marker.write.request",
                || json!({"index":index,"roleHash":identifier_hash(confirmed_roles[index].role().as_str()),"agentHash":identifier_hash(confirmed_roles[index].agent().as_str())}),
            );
            let written = marker.write(std::path::Path::new(workspace.as_str()));
            session_trace(
                "runtime.team.marker.write.end",
                || json!({"index":index,"succeeded":written.is_ok(),"ioKind":written.as_ref().err().map(|error| format!("{:?}", error.kind())),"elapsedMs":marker_started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}),
            );
            if written.is_err() {
                session_trace(
                    "runtime.team.materialize.failed",
                    || json!({"index":index,"reason":"marker-write","outcome":"OutcomeUnknown"}),
                );
                report_failure(observer, CreationStage::ConfiguringTeam, FailureReason::NativeWriteFailed, Some(TeamCreationFile::AgentsMarkdown)).await;
                return self
                    .fail_materialization(&mut progress, permanent_rejection(), observer)
                    .await;
            }
            progress.written_markers += 1;
            session_trace(
                "runtime.team.marker.readback.request",
                || json!({"index":index}),
            );
            let readback = marker.recover(std::path::Path::new(workspace.as_str()));
            session_trace(
                "runtime.team.marker.readback.end",
                || json!({"index":index,"matched":readback.as_ref().ok(),"ioKind":readback.as_ref().err().map(|error| format!("{:?}", error.kind())),"elapsedMs":marker_started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}),
            );
            if !matches!(readback, Ok(true)) {
                session_trace(
                    "runtime.team.materialize.failed",
                    || json!({"index":index,"reason":"marker-readback","outcome":"OutcomeUnknown"}),
                );
                report_failure(observer, CreationStage::VerifyingTeam, if readback.is_err() { FailureReason::NativeReadFailed } else { FailureReason::NativeReadbackMismatch }, Some(TeamCreationFile::AgentsMarkdown)).await;
                return self
                    .fail_materialization(&mut progress, permanent_rejection(), observer)
                    .await;
            }
        }
        let receipt = MaterializationReceipt::try_new(
            request.intent().team().clone(),
            request.intent().endpoint().clone(),
            confirmed_roles,
        )
        .expect("every confirmed role must form a native readback receipt");
        MaterializationOperationOutcome::Confirmed { receipt }
    }

    async fn materialize_managed_agent(
        &self,
        request: &TeamMaterializationRequest,
        role: &organization::RoleAgentMaterialization,
        workspace: ResolvedWorkspace,
        progress: &mut MaterializationProgress,
        observer: Option<&TeamProvisionObserver>,
    ) -> (MutationOutcome<TeamOwnedAgentId>, Option<TeamOwnedAgentId>) {
        let RoleMaterializationAgent::Managed { name } = role.agent() else {
            return (MutationOutcome::Rejected, None);
        };
        let state_dir = self.config.state_dir();
        if let Some(undo) = progress.config_restore.as_mut() {
            if undo.provisioning_effects(&state_dir, false).is_err() {
                report_failure(observer, CreationStage::ConfiguringTeam, FailureReason::StoreWriteFailed, None).await;
                return (MutationOutcome::OutcomeUnknown, None);
            }
        }
        let requested = TeamAgentCreate::try_new(name.clone(), workspace.clone())
            .expect("validated managed agent materialization must create a valid request");
        let agent_id = match self.create_agent(requested).await {
            MutationOutcome::Applied(agent_id) => agent_id,
            outcome => {
                if matches!(outcome, MutationOutcome::Rejected | MutationOutcome::NotWritten(_)) {
                    if let Some(undo) = progress.config_restore.as_mut() {
                        if (matches!(outcome, MutationOutcome::NotWritten(_))
                            && undo.record_retryable_rejection(&state_dir).is_err())
                            || undo.provisioning_effects(&state_dir, true).is_err()
                        {
                            report_failure(observer, CreationStage::ConfiguringTeam, mutation_failure_reason(&outcome), None).await;
                            return (MutationOutcome::OutcomeUnknown, None);
                        }
                    }
                }
                report_failure(observer, CreationStage::ConfiguringTeam, mutation_failure_reason(&outcome), None).await;
                return (outcome, None);
            }
        };
        let undo = progress.config_restore.get_or_insert_with(|| ConfigUndo::provisioning(request));
        if undo.record_created(&state_dir, role, &agent_id, &workspace).is_err() {
            report_failure(observer, CreationStage::ConfiguringTeam, FailureReason::StoreWriteFailed, None).await;
            return (MutationOutcome::Rejected, Some(agent_id));
        }
        if undo.provisioning_effects(&state_dir, false).is_err() {
            report_failure(observer, CreationStage::ConfiguringTeam, FailureReason::StoreWriteFailed, None).await;
            return (MutationOutcome::Rejected, Some(agent_id));
        }
        let outcome = self
            .update_agent(
                TeamAgentUpdate::try_new(agent_id.clone(), name.clone(), workspace, None)
                    .expect("validated managed agent update must be valid"),
            )
            .await;
        if matches!(outcome, MutationOutcome::NotWritten(_))
            && undo.record_retryable_rejection(&state_dir).is_err()
        {
            report_failure(observer, CreationStage::ConfiguringTeam, mutation_failure_reason(&outcome), None).await;
            return (MutationOutcome::OutcomeUnknown, Some(agent_id));
        }
        if matches!(outcome, MutationOutcome::Applied(()) | MutationOutcome::Rejected | MutationOutcome::NotWritten(_))
            && undo.provisioning_effects(&state_dir, true).is_err()
        {
            report_failure(observer, CreationStage::ConfiguringTeam, if matches!(outcome, MutationOutcome::Applied(())) { FailureReason::StoreWriteFailed } else { mutation_failure_reason(&outcome) }, None).await;
            return (MutationOutcome::OutcomeUnknown, Some(agent_id));
        }
        if !matches!(outcome, MutationOutcome::Applied(())) {
            report_failure(observer, CreationStage::ConfiguringTeam, mutation_failure_reason(&outcome), None).await;
        }
        match outcome {
            MutationOutcome::Applied(()) => {
                (MutationOutcome::Applied(agent_id.clone()), Some(agent_id))
            }
            MutationOutcome::Rejected => (MutationOutcome::Rejected, Some(agent_id)),
            MutationOutcome::NotWritten(error) => (MutationOutcome::NotWritten(error), Some(agent_id)),
            MutationOutcome::MayHaveReached(error) => (MutationOutcome::MayHaveReached(error), Some(agent_id)),
            MutationOutcome::OutcomeUnknown => (MutationOutcome::OutcomeUnknown, Some(agent_id)),
        }
    }

    async fn fail_materialization(
        &self,
        progress: &mut MaterializationProgress,
        outcome: MaterializationOperationOutcome,
        observer: Option<&TeamProvisionObserver>,
    ) -> MaterializationOperationOutcome {
        let effects_known = matches!(outcome, MaterializationOperationOutcome::Rejected { .. });
        if let Some(observer) = observer {
            observer
                .report(TeamProvisionUpdate::Stage(TeamProvisionStage::RollingBack))
                .await;
        }
        let compensated = progress.compensate(self, effects_known).await;
        session_trace(
            "runtime.team.materialize.rollback.end",
            || json!({"outcome":if compensated {"Rejected"} else {"OutcomeUnknown"},"reason":if !effects_known {"native-effect-unresolved"} else if compensated {"rollback-confirmed"} else {"rollback-unresolved"}}),
        );
        if compensated {
            outcome
        } else {
            MaterializationOperationOutcome::OutcomeUnknown
        }
    }

    pub(crate) async fn remove_unconfirmed(
        &self,
        request: TeamMaterializationRequest,
    ) -> MaterializationOperationOutcome {
        let started = platform::trace::enabled().then(Instant::now);
        let unknown = |reason| {
            session_trace(
                "runtime.team.unconfirmed-remove.end",
                || json!({"outcome":"OutcomeUnknown","reason":reason,"elapsedMs":started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}),
            );
            MaterializationOperationOutcome::OutcomeUnknown
        };
        session_trace("runtime.team.unconfirmed-remove.request", || json!({}));
        let undo = match ConfigUndo::load(&self.config.state_dir(), request.intent().team()) {
            Ok(Some(undo)) => undo,
            Ok(None) => return unknown("undo-missing"),
            Err(()) => return unknown("undo-read"),
        };
        if (undo.is_removing() && !undo.is_removed() && !undo.is_compensated()) || !undo.matches_request(&request) {
            return unknown("undo-request-mismatch");
        }
        let Ok(receipt) = undo.receipt() else {
            return unknown("undo-receipt-decode");
        };
        if !undo.is_compensated() && !undo.is_removed() {
            return unknown("active-ownership-unproven");
        }
        if !undo.removal_completed() && !undo.compensation_completed() {
            return unknown("cleanup-ack-missing");
        }
        // Terminal undo proves config/agent cleanup. Do not restore or delete an
        // agent which a newer Team may now use; only this Team's markers remain ours.
        for (index, role) in receipt.roles().iter().enumerate().rev() {
            let Some(workspace) = role.native_workspace() else {
                return unknown("receipt-workspace-missing");
            };
            let workspace = std::path::Path::new(workspace.as_str());
            let marker = TeamBuddyMarker::new(receipt.team().clone(), role.role().clone());
            let removed = marker.remove(workspace);
            session_trace(
                "runtime.team.unconfirmed-remove.marker.end",
                || json!({"index":index,"succeeded":removed.is_ok(),"reason":if removed.is_ok() {"marker-removed"} else {"marker-remove"},"ioKind":removed.as_ref().err().map(|error| format!("{:?}", error.kind()))}),
            );
            if removed.is_err() {
                return unknown("marker-remove");
            }
            let present = marker.has_marker(workspace);
            session_trace(
                "runtime.team.unconfirmed-remove.marker-readback.end",
                || json!({"index":index,"present":present.as_ref().ok(),"reason":if matches!(present, Ok(false)) {"marker-absent"} else {"marker-unresolved"}}),
            );
            if !matches!(present, Ok(false)) {
                return unknown("marker-readback");
            }
        }
        if undo.finish_removal(&self.config.state_dir()).is_err() {
            return unknown("undo-finish-removal");
        }
        session_trace(
            "runtime.team.unconfirmed-remove.end",
            || json!({"outcome":"Confirmed","reason":"cleanup-confirmed","elapsedMs":started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}),
        );
        MaterializationOperationOutcome::Confirmed { receipt }
    }

    pub(crate) async fn recover_removal(
        &self,
        removal: TeamMaterializationRemoval,
    ) -> MaterializationOperationOutcome {
        let receipt = removal.receipt();
        let undo = match ConfigUndo::load(&self.config.state_dir(), receipt.team()) {
            Ok(Some(undo)) if undo.matches_receipt(receipt) => undo,
            _ => return MaterializationOperationOutcome::OutcomeUnknown,
        };
        if !undo.removal_completed() && !undo.compensation_completed() {
            return MaterializationOperationOutcome::OutcomeUnknown;
        }
        if !undo.is_removed() && !undo.is_compensated() {
            if undo.has_external_roles() {
                let (Ok(snapshot), Ok(facts)) = (self.config_snapshot().await, undo.facts()) else {
                    return MaterializationOperationOutcome::OutcomeUnknown;
                };
                let absent = receipt.roles().iter()
                    .filter(|role| role.ownership() == RoleMaterializationOwnership::Managed)
                    .map(|role| role.agent().as_str())
                    .collect::<Vec<_>>();
                if !snapshot.0.matches_compensation(&facts, &absent, true)
                    || !matches!(snapshot.0.prepare_external_restore(facts), Ok(wire::team::ConfigRestorePreparation::Restored))
                {
                    return MaterializationOperationOutcome::OutcomeUnknown;
                }
            }
        }
        let Ok(agents) = self.list_agents().await else {
            return MaterializationOperationOutcome::OutcomeUnknown;
        };
        for role in receipt.roles() {
            let Some(workspace) = role.native_workspace() else {
                return MaterializationOperationOutcome::OutcomeUnknown;
            };
            if role.ownership() == RoleMaterializationOwnership::Managed
                && agents.as_slice().iter().any(|agent| agent.id().as_str() == role.agent().as_str())
            {
                return MaterializationOperationOutcome::OutcomeUnknown;
            }
            if !matches!(TeamBuddyMarker::new(receipt.team().clone(), role.role().clone())
                .has_marker(std::path::Path::new(workspace.as_str())), Ok(false))
            {
                return MaterializationOperationOutcome::OutcomeUnknown;
            }
        }
        if undo.finish_removal(&self.config.state_dir()).is_err() {
            return MaterializationOperationOutcome::OutcomeUnknown;
        }
        MaterializationOperationOutcome::Confirmed { receipt: receipt.clone() }
    }

    pub(crate) async fn remove(
        &self,
        removal: TeamMaterializationRemoval,
    ) -> MaterializationOperationOutcome {
        self.remove_request(removal).await
    }

    async fn remove_request(
        &self,
        removal: TeamMaterializationRemoval,
    ) -> MaterializationOperationOutcome {
        let state_dir = self.config.state_dir();
        let mut undo = match ConfigUndo::load(&state_dir, removal.receipt().team()) {
            Ok(Some(undo)) if undo.matches_receipt(removal.receipt()) => undo,
            Ok(None) => match ConfigUndo::for_removal(removal.receipt()) {
                Ok(undo) => undo,
                Err(()) => return MaterializationOperationOutcome::OutcomeUnknown,
            },
            _ => return MaterializationOperationOutcome::OutcomeUnknown,
        };
        if undo.is_removed() {
            return if undo.removal_completed() || undo.compensation_completed() {
                MaterializationOperationOutcome::Confirmed { receipt: removal.receipt().clone() }
            } else {
                MaterializationOperationOutcome::OutcomeUnknown
            };
        }
        if undo.is_compensated() && !undo.compensation_completed() {
            return MaterializationOperationOutcome::OutcomeUnknown;
        }
        if !undo.is_compensated() {
            if undo.begin_removal(&state_dir).is_err()
                || !matches!(self.restore_config(&undo).await, MutationOutcome::Applied(()))
            {
                return MaterializationOperationOutcome::OutcomeUnknown;
            }
        }
        for role in removal.receipt().roles().iter().rev() {
            let Some(workspace) = role.native_workspace() else {
                return MaterializationOperationOutcome::OutcomeUnknown;
            };
            if TeamBuddyMarker::new(removal.receipt().team().clone(), role.role().clone())
                .remove(std::path::Path::new(workspace.as_str()))
                .is_err()
            {
                return MaterializationOperationOutcome::OutcomeUnknown;
            }
            if role.ownership() == RoleMaterializationOwnership::Managed && !undo.is_compensated() {
                match undo.removal_agent(role.agent().as_str()) {
                    Some(CompensationState::Deleted) => continue,
                    Some(CompensationState::Pending) => {}
                    Some(CompensationState::InFlight) | None => return MaterializationOperationOutcome::OutcomeUnknown,
                }
                if undo.record_removal_agent(&state_dir, role.agent().as_str(), CompensationState::InFlight).is_err() {
                    return MaterializationOperationOutcome::OutcomeUnknown;
                }
                let agent = TeamOwnedAgentId::try_new(role.agent().as_str())
                    .expect("validated materialization receipt must have a managed agent");
                match self.delete_agent(agent).await {
                    MutationOutcome::Applied(()) => {
                        if undo.record_removal_agent(&state_dir, role.agent().as_str(), CompensationState::Deleted).is_err() {
                            return MaterializationOperationOutcome::OutcomeUnknown;
                        }
                    }
                    MutationOutcome::NotWritten(_) => {
                        let _ = undo.record_removal_agent(&state_dir, role.agent().as_str(), CompensationState::Pending);
                        return MaterializationOperationOutcome::OutcomeUnknown;
                    }
                    MutationOutcome::Rejected | MutationOutcome::MayHaveReached(_) | MutationOutcome::OutcomeUnknown => {
                        return MaterializationOperationOutcome::OutcomeUnknown;
                    }
                }
            }
        }
        if undo.finish_removal(&state_dir).is_err() {
            return MaterializationOperationOutcome::OutcomeUnknown;
        }
        MaterializationOperationOutcome::Confirmed {
            receipt: removal.receipt().clone(),
        }
    }

    async fn external_workspaces_for_request(
        &self,
        request: &TeamMaterializationRequest,
        observer: Option<&TeamProvisionObserver>,
    ) -> Result<TeamExternalWorkspaces, WorkspaceProjectionError> {
        let requested = request
            .intent()
            .agents()
            .iter()
            .filter_map(|role| match role.agent() {
                RoleMaterializationAgent::External { agent } => Some(
                    TeamOwnedAgentId::try_new(agent.as_str())
                        .expect("validated materialization intent must have an external agent"),
                ),
                RoleMaterializationAgent::Managed { .. } => None,
            })
            .collect::<Vec<_>>();
        if requested.is_empty() {
            return Ok(TeamAgents::new(Vec::new())
                .resolve_external_workspaces(Vec::new())
                .expect("an empty external agent request is valid"));
        }
        session_trace(
            "runtime.team.external-workspaces.request",
            || json!({"count":requested.len()}),
        );
        let agents = match self.list_agents().await {
            Ok(agents) => agents,
            Err(failure) => {
                session_trace(
                    "runtime.team.external-workspaces.end",
                    || json!({"reason":"native-list","outcome":"OutcomeUnknown"}),
                );
                report_failure(observer, CreationStage::ConfiguringTeam, read_failure_reason(failure), None).await;
                return Err(WorkspaceProjectionError::Unknown);
            }
        };
        match agents.resolve_external_workspaces(requested) {
            Ok(workspaces) => {
                session_trace(
                    "runtime.team.external-workspaces.end",
                    || json!({"outcome":"Resolved"}),
                );
                Ok(workspaces)
            }
            Err(reason) => {
                session_trace(
                    "runtime.team.external-workspaces.end",
                    || json!({"reason":"native-workspace-invalid","outcome":"Rejected"}),
                );
                report_failure(observer, CreationStage::ConfiguringTeam, reason, None).await;
                Err(WorkspaceProjectionError::Rejected)
            }
        }
    }

    fn workspace_projection_for_request(
        &self,
        request: &TeamMaterializationRequest,
    ) -> Result<TeamWorkspaceProjection, WorkspaceProjectionError> {
        let started = platform::trace::enabled().then(Instant::now);
        session_trace("runtime.team.config-read.request", || json!({}));
        let canonical_config = self
            .config
            .read()
            .inspect(|_| session_trace("runtime.team.config-read.end", || json!({"outcome":"Succeeded","elapsedMs":started.map(|started| started.elapsed().as_millis()).unwrap_or_default()})))
            .map_err(|_| {
                session_trace("runtime.team.config-read.end", || json!({"reason":"config-store-read","outcome":"OutcomeUnknown","elapsedMs":started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}));
                WorkspaceProjectionError::Unknown
            })?;
        let _ = canonical_config.get("agents");
        TeamWorkspaceProjection::for_request(self.config.state_dir_path(), request).map_err(|_| {
            session_trace(
                "runtime.team.workspace-projection.end",
                || json!({"reason":"workspace-projection","outcome":"Rejected"}),
            );
            WorkspaceProjectionError::Rejected
        })
    }

    pub(crate) async fn create_agent(
        &self,
        input: TeamAgentCreate,
    ) -> MutationOutcome<TeamOwnedAgentId> {
        let TeamAgentCreate { name, workspace } = input;
        let expected_name = name.clone();
        let expected_workspace = workspace.as_str().to_owned();
        let request = match wire::team::agents_create_request(
            next_request_id("agents-create"),
            name,
            workspace.into_inner(),
        ) {
            Ok(request) => request,
            Err(_) => return MutationOutcome::Rejected,
        };
        self.write_request(request, move |response| {
            wire::team::decode_agents_create(response).and_then(|created| {
                (created.name == expected_name && created.workspace == expected_workspace)
                    .then_some(TeamOwnedAgentId(created.agent_id))
                    .ok_or(wire::WireError::InvalidAgentsCreate)
            })
        })
        .await
    }

    pub(crate) async fn update_agent(&self, input: TeamAgentUpdate) -> MutationOutcome<()> {
        let TeamAgentUpdate {
            agent_id,
            name,
            workspace,
            model,
        } = input;
        let expected_agent_id = agent_id.0.clone();
        let request = match wire::team::agents_update_request(
            next_request_id("agents-update"),
            agent_id.0,
            name,
            workspace.into_inner(),
            model,
        ) {
            Ok(request) => request,
            Err(_) => return MutationOutcome::Rejected,
        };
        self.write_request(request, move |response| {
            wire::team::decode_agents_update(response).and_then(|updated| {
                (updated.agent_id == expected_agent_id)
                    .then_some(())
                    .ok_or(wire::WireError::InvalidAgentsUpdate)
            })
        })
        .await
    }

    pub(crate) async fn delete_agent(&self, agent_id: TeamOwnedAgentId) -> MutationOutcome<()> {
        let expected_agent_id = agent_id.0.clone();
        let request =
            match wire::team::agents_delete_request(next_request_id("agents-delete"), agent_id.0) {
                Ok(request) => request,
                Err(_) => return MutationOutcome::Rejected,
            };
        let request_id = request.request_id().to_owned();
        let encoded = match request.encode() {
            Ok(encoded) => encoded,
            Err(_) => return MutationOutcome::Rejected,
        };
        match self.gateway.rpc_encoded_mutation_cancellable(request_id, encoded, &self.cancellation).await {
            MutationDelivery::Response(GatewayResponse::Failure { .. }) => MutationOutcome::Rejected,
            MutationDelivery::Response(response) => match wire::team::decode_agents_delete(response) {
                Ok(deleted) if deleted.agent_id == expected_agent_id => MutationOutcome::Applied(()),
                Ok(_) | Err(_) => MutationOutcome::OutcomeUnknown,
            },
            MutationDelivery::NotWritten(error) => MutationOutcome::NotWritten(error),
            MutationDelivery::MayHaveReached(error) => MutationOutcome::MayHaveReached(error),
        }
    }

    pub(crate) async fn config_snapshot(&self) -> Result<TeamConfigSnapshot, ReadFailure> {
        let started = platform::trace::enabled().then(Instant::now);
        session_trace("runtime.team.config-get.request", || json!({}));
        let request = wire::team::config_get_request(next_request_id("config-get"))
            .map_err(|_| {
                session_trace("runtime.team.config-get.end", || json!({"reason":"request-shape","outcome":"Protocol","elapsedMs":started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}));
                ReadFailure::Protocol
            })?;
        let cancellation = tokio_util::sync::CancellationToken::new();
        let response = self.gateway.rpc_query_cancellable(request, &cancellation);
        tokio::pin!(response);
        let response = tokio::select! {
            biased;
            result = &mut response => result.map_err(map_read_connection_failure),
            _ = self.cancellation.cancelled() => {
                cancellation.cancel();
                response.await.map_err(|error| match error {
                    GatewayClientError::ConnectionClosed => ReadFailure::Cancelled,
                    error => map_read_connection_failure(error),
                })
            }
        };
        let result = match response {
            Ok(GatewayResponse::Failure { .. }) => {
                session_trace(
                    "runtime.team.config-get.rpc-end",
                    || json!({"reason":"target-rejected","outcome":"Rejected"}),
                );
                Err(ReadFailure::Rejected)
            }
            Ok(response) => wire::team::decode_config_get(response)
                .map(TeamConfigSnapshot)
                .map_err(|_| {
                    session_trace(
                        "runtime.team.config-get.rpc-end",
                        || json!({"reason":"decode","outcome":"Protocol"}),
                    );
                    ReadFailure::Protocol
                }),
            Err(failure) => {
                session_trace(
                    "runtime.team.config-get.rpc-end",
                    || json!({"reason":"transport","outcome":format!("{failure:?}")}),
                );
                Err(failure)
            }
        };
        session_trace(
            "runtime.team.config-get.end",
            || json!({"outcome":result.as_ref().map_or_else(|failure| format!("{failure:?}"), |_| "Succeeded".to_owned()),"elapsedMs":started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}),
        );
        result
    }

    async fn apply_config_agents(
        &self,
        snapshot: TeamConfigSnapshot,
        agents: Vec<TeamConfigAgent>,
        request: &TeamMaterializationRequest,
        receipt: &MaterializationReceipt,
        progress: &mut MaterializationProgress,
        observer: Option<&TeamProvisionObserver>,
    ) -> MutationOutcome<()> {
        let patch = match snapshot
            .0
            .patch_agents(agents.into_iter().map(TeamConfigAgent::into_wire).collect())
        {
            Ok(patch) => patch,
            Err(_) => {
                session_trace(
                    "runtime.team.config-apply.end",
                    || json!({"reason":"patch-agents","outcome":"Rejected"}),
                );
                report_failure(observer, CreationStage::ConfiguringTeam, FailureReason::InvalidConfig, None).await;
                return MutationOutcome::Rejected;
            }
        };
        let (raw, base_hash, facts) = patch.into_parts();
        let undo = match ConfigUndo::prepare(request, receipt, &facts) {
            Ok(undo) => undo,
            Err(()) => {
                session_trace(
                    "runtime.team.undo.prepare.end",
                    || json!({"reason":"undo-prepare","outcome":"Rejected"}),
                );
                report_failure(observer, CreationStage::ConfiguringTeam, FailureReason::StoreInvalid, None).await;
                return MutationOutcome::Rejected;
            }
        };
        let started = platform::trace::enabled().then(Instant::now);
        session_trace(
            "runtime.team.undo.write.request",
            || json!({"operation":"prepare"}),
        );
        let persisted = undo.persist(&self.config.state_dir());
        session_trace(
            "runtime.team.undo.write.end",
            || json!({"operation":"prepare","succeeded":persisted.is_ok(),"elapsedMs":started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}),
        );
        progress.config_restore = Some(undo);
        if persisted.is_err() {
            report_failure(observer, CreationStage::ConfiguringTeam, FailureReason::StoreWriteFailed, None).await;
            return MutationOutcome::Rejected;
        }
        let request =
            match wire::team::config_set_request(next_request_id("config-set"), raw, base_hash) {
                Ok(request) => request,
                Err(_) => {
                    session_trace(
                        "runtime.team.config-apply.end",
                        || json!({"reason":"config-set-shape","outcome":"Rejected"}),
                    );
                    report_failure(observer, CreationStage::ConfiguringTeam, FailureReason::InvalidConfig, None).await;
                    return MutationOutcome::Rejected;
                }
            };
        if progress.created_agents.is_empty() {
            if let Some(observer) = observer {
                observer
                    .report(TeamProvisionUpdate::Stage(
                        TeamProvisionStage::ConfiguringTeam,
                    ))
                    .await;
            }
        }
        if progress
            .config_restore
            .as_mut()
            .expect("prepared undo")
            .config_may_have_reached(&self.config.state_dir())
            .is_err()
        {
            report_failure(observer, CreationStage::ConfiguringTeam, FailureReason::StoreWriteFailed, None).await;
            return MutationOutcome::Rejected;
        }
        match self
            .write_config_request(wire::team::ConfigRestoreRequest::Set(request))
            .await
        {
            MutationOutcome::Applied(()) => {
                if let Some(observer) = observer {
                    observer
                        .report(TeamProvisionUpdate::Stage(
                            TeamProvisionStage::VerifyingTeam,
                        ))
                        .await;
                }
                match self.config_snapshot().await {
                    Ok(snapshot) if snapshot.0.matches_agents(&facts) => {
                        session_trace(
                            "runtime.team.config-apply.end",
                            || json!({"reason":"readback","outcome":"Applied"}),
                        );
                        MutationOutcome::Applied(())
                    }
                    Ok(_) => {
                        session_trace(
                            "runtime.team.config-apply.end",
                            || json!({"reason":"readback-mismatch","outcome":"OutcomeUnknown"}),
                        );
                        report_failure(observer, CreationStage::VerifyingTeam, FailureReason::NativeReadbackMismatch, None).await;
                        MutationOutcome::OutcomeUnknown
                    }
                    Err(failure) => {
                        session_trace(
                            "runtime.team.config-apply.end",
                            || json!({"reason":"readback-unavailable","outcome":"OutcomeUnknown"}),
                        );
                        report_failure(observer, CreationStage::VerifyingTeam, read_failure_reason(failure), None).await;
                        MutationOutcome::OutcomeUnknown
                    }
                }
            }
            outcome => {
                if matches!(outcome, MutationOutcome::Rejected | MutationOutcome::NotWritten(_)) {
                    if progress
                        .config_restore
                        .as_mut()
                        .expect("prepared undo")
                        .config_rejected(&self.config.state_dir(), matches!(outcome, MutationOutcome::NotWritten(_)))
                        .is_err()
                    {
                        report_failure(observer, CreationStage::ConfiguringTeam, mutation_failure_reason(&outcome), None).await;
                        return MutationOutcome::OutcomeUnknown;
                    }
                }
                report_failure(observer, CreationStage::ConfiguringTeam, mutation_failure_reason(&outcome), None).await;
                outcome
            }
        }
    }

    async fn restore_config(&self, undo: &ConfigUndo) -> MutationOutcome<()> {
        if !undo.has_external_roles() {
            return MutationOutcome::Applied(());
        }
        // At most one full replacement and one removal patch; each uses a fresh hash.
        // A final read proves restoration even when the previous write outcome was lost.
        for step in 0..=2 {
            let (Ok(snapshot), Ok(facts)) = (self.config_snapshot().await, undo.facts()) else {
                return MutationOutcome::OutcomeUnknown;
            };
            match snapshot.0.prepare_external_restore(facts) {
                Ok(wire::team::ConfigRestorePreparation::Restored) => {
                    return MutationOutcome::Applied(());
                }
                Ok(wire::team::ConfigRestorePreparation::Ready { request, .. }) if step < 2 => {
                    if !matches!(
                        self.write_config_request(request).await,
                        MutationOutcome::Applied(())
                    ) {
                        return MutationOutcome::OutcomeUnknown;
                    }
                }
                Ok(
                    wire::team::ConfigRestorePreparation::Ready { .. }
                    | wire::team::ConfigRestorePreparation::Fenced,
                )
                | Err(_) => return MutationOutcome::OutcomeUnknown,
            }
        }
        MutationOutcome::OutcomeUnknown
    }

    async fn compensation_readback(
        &self,
        undo: &ConfigUndo,
    ) -> Result<Vec<String>, ()> {
        let compensation = undo.compensation().ok_or(())?;
        let roles = undo.roles()?;
        let managed = roles.iter().filter(|role| {
            role.ownership() == RoleMaterializationOwnership::Managed
        });
        if managed.clone().count() != compensation.agents.len()
            || managed.clone().any(|role| {
                compensation.agents.iter().filter(|resource| {
                    resource.agent == role.agent().as_str()
                }).count() != 1
            })
        {
            return Err(());
        }
        let native = self.list_agents().await.map_err(|_| ())?;
        let agents = native.as_slice();
        let mut ids = std::collections::BTreeSet::new();
        for agent in agents {
            if !ids.insert(agent.id().as_str()) {
                return Err(());
            }
        }
        let mut absent = Vec::new();
        for role in &roles {
            let resource = compensation.agents.iter().find(|resource| {
                resource.agent == role.agent().as_str()
            });
            match agents.iter().find(|agent| agent.id().as_str() == role.agent().as_str()) {
                Some(agent) => {
                    if resource.is_some_and(|resource| resource.state == CompensationState::Deleted)
                        || agent.workspace().map(ResolvedWorkspace::as_str)
                            != role.native_workspace().map(NativeWorkspaceReceipt::as_str)
                    {
                        return Err(());
                    }
                    let workspace = role.native_workspace().ok_or(())?;
                    let workspace = std::path::Path::new(workspace.as_str());
                    let marker = TeamBuddyMarker::new(undo.team()?, role.role().clone())
                        .with_content(role.agents_markdown().unwrap_or(""));
                    if matches!(marker.has_marker(workspace), Ok(true))
                        && !matches!(marker.recover(workspace), Ok(true))
                    {
                        return Err(());
                    }
                }
                None if resource.is_some() => absent.push(role.agent().as_str().to_owned()),
                None => return Err(()),
            }
        }
        let snapshot = self.config_snapshot().await.map_err(|_| ())?;
        let facts = undo.facts()?;
        if !snapshot.0.matches_compensation(
            &facts,
            &absent.iter().map(String::as_str).collect::<Vec<_>>(),
            compensation.config_applied,
        ) {
            return Err(());
        }
        if compensation.config == ConfigCompensation::Restored
            && compensation.config_applied && undo.has_external_roles()
            && !matches!(snapshot.0.prepare_restore(facts), Ok(wire::team::ConfigRestorePreparation::Restored))
        {
            return Err(());
        }
        Ok(absent)
    }

    async fn restore_compensation_config(&self, undo: &mut ConfigUndo) -> bool {
        let state_dir = self.config.state_dir();
        for step in 0..=2 {
            let (Ok(snapshot), Ok(facts)) = (self.config_snapshot().await, undo.facts()) else {
                return false;
            };
            match snapshot.0.prepare_restore(facts) {
                Ok(wire::team::ConfigRestorePreparation::Restored) => {
                    return undo.record_config_compensation(&state_dir, ConfigCompensation::Restored).is_ok();
                }
                Ok(wire::team::ConfigRestorePreparation::Ready { request })
                    if step < 2 && undo.compensation().is_some_and(|compensation| compensation.config == ConfigCompensation::Pending) =>
                {
                    if undo.record_config_compensation(&state_dir, ConfigCompensation::InFlight).is_err() {
                        return false;
                    }
                    match self.write_config_request(request).await {
                        MutationOutcome::Applied(()) | MutationOutcome::Rejected | MutationOutcome::NotWritten(_) => {
                            if undo.record_config_compensation(&state_dir, ConfigCompensation::Pending).is_err() {
                                return false;
                            }
                        }
                        MutationOutcome::MayHaveReached(_) | MutationOutcome::OutcomeUnknown => return false,
                    }
                }
                _ => return false,
            }
        }
        false
    }

    async fn compensate_config_undo(&self, undo: &mut ConfigUndo) -> bool {
        let state_dir = self.config.state_dir();
        if undo.persist(&state_dir).is_err() {
            return false;
        }
        if undo.is_provisioning() {
            let Ok(snapshot) = self.config_snapshot().await else {
                return false;
            };
            if undo.capture_created_config(&state_dir, &snapshot.0).is_err() {
                return false;
            }
        }
        if self.compensation_readback(undo).await.is_err() {
            return false;
        }
        let Some(compensation) = undo.compensation() else {
            return false;
        };
        let mut confirmed = compensation.effects_known;
        if compensation.config != ConfigCompensation::Restored
            && !self.restore_compensation_config(undo).await
        {
            confirmed = false;
        }
        let pending = undo.compensation().expect("validated compensation").agents.iter().rev()
            .map(|resource| (resource.agent.clone(), resource.state, resource.delete_acknowledged))
            .collect::<Vec<_>>();
        for (agent, state, acknowledged) in pending {
            match state {
                CompensationState::Deleted if acknowledged => continue,
                CompensationState::Deleted | CompensationState::InFlight => {
                    confirmed = false;
                    continue;
                }
                CompensationState::Pending => {}
            }
            let Ok(absent) = self.compensation_readback(undo).await else {
                return false;
            };
            if absent.iter().any(|absent| absent == &agent) {
                confirmed = false;
                continue;
            }
            if undo.record_compensation_agent(&state_dir, &agent, CompensationState::InFlight).is_err() {
                return false;
            }
            match self.delete_agent(TeamOwnedAgentId::try_new(&agent).expect("validated agent")).await {
                MutationOutcome::Applied(()) => {
                    if undo.record_compensation_agent(&state_dir, &agent, CompensationState::Deleted).is_err() {
                        return false;
                    }
                }
                MutationOutcome::NotWritten(_) => {
                    if undo.record_compensation_agent(&state_dir, &agent, CompensationState::Pending).is_err() {
                        return false;
                    }
                    confirmed = false;
                }
                MutationOutcome::Rejected | MutationOutcome::MayHaveReached(_) | MutationOutcome::OutcomeUnknown => {
                    confirmed = false;
                }
            }
            if self.compensation_readback(undo).await.is_err() {
                return false;
            }
        }
        if !confirmed || self.compensation_readback(undo).await.is_err() {
            return false;
        }
        let (Ok(roles), Ok(team)) = (undo.roles(), undo.team()) else {
            return false;
        };
        for role in roles.iter().rev() {
            let Some(workspace) = role.native_workspace() else {
                return false;
            };
            let workspace = std::path::Path::new(workspace.as_str());
            let marker = TeamBuddyMarker::new(team.clone(), role.role().clone())
                .with_content(role.agents_markdown().unwrap_or(""));
            if !matches!(marker.has_marker(workspace), Ok(false)) {
                if !matches!(marker.recover(workspace), Ok(true)) || marker.remove(workspace).is_err() {
                    return false;
                }
            }
            if !matches!(marker.has_marker(workspace), Ok(false)) {
                return false;
            }
        }
        undo.finish_compensation(&state_dir).is_ok()
    }

    async fn write_config_request(
        &self,
        request: wire::team::ConfigRestoreRequest,
    ) -> MutationOutcome<()> {
        let started = platform::trace::enabled().then(Instant::now);
        let is_set = matches!(&request, wire::team::ConfigRestoreRequest::Set(_));
        session_trace("runtime.team.config-write.request", || json!({"set":is_set}));
        let encoded = match request.encode() {
            Ok(encoded) => encoded,
            Err(_) => {
                session_trace(
                    "runtime.team.config-write.end",
                    || json!({"reason":"encode","outcome":"Rejected"}),
                );
                return MutationOutcome::Rejected;
            }
        };
        let outcome = map_write_response(
            self.gateway
                .rpc_encoded_mutation_cancellable(request.request_id().to_owned(), encoded, &self.cancellation)
                .await,
            |response| {
                if is_set {
                    wire::team::decode_config_set(response).map(|_| ())
                } else {
                    wire::team::decode_config_patch(response).map(|_| ())
                }
            },
        );
        session_trace(
            "runtime.team.config-write.end",
            || json!({"outcome":match &outcome { MutationOutcome::Applied(_) => "Applied", MutationOutcome::Rejected => "Rejected", MutationOutcome::NotWritten(_) => "NotWritten", MutationOutcome::MayHaveReached(_) | MutationOutcome::OutcomeUnknown => "OutcomeUnknown" },"elapsedMs":started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}),
        );
        outcome
    }

    async fn write_request<T>(
        &self,
        request: wire::RpcRequest,
        decode: impl FnOnce(GatewayResponse) -> Result<T, wire::WireError>,
    ) -> MutationOutcome<T> {
        let method = request.method();
        let request_id = request.request_id().to_owned();
        let encoded = match request.encode() {
            Ok(encoded) => encoded,
            Err(_) => return MutationOutcome::Rejected,
        };
        self.write_encoded(encoded, request_id, method, decode)
            .await
    }

    async fn write_encoded<T>(
        &self,
        encoded: String,
        request_id: String,
        method: &str,
        decode: impl FnOnce(GatewayResponse) -> Result<T, wire::WireError>,
    ) -> MutationOutcome<T> {
        let started = platform::trace::enabled().then(Instant::now);
        let operation = match method {
            "agents.create" => "create",
            "agents.update" => "update",
            _ => "mutation",
        };
        session_trace(
            "runtime.team.agent-write.request",
            || json!({"operation":operation}),
        );
        let outcome = map_write_response(
            self.gateway.rpc_encoded_mutation_cancellable(request_id, encoded, &self.cancellation).await,
            decode,
        );
        session_trace(
            "runtime.team.agent-write.end",
            || json!({"operation":operation,"outcome":match &outcome { MutationOutcome::Applied(_) => "Applied", MutationOutcome::Rejected => "Rejected", MutationOutcome::NotWritten(_) => "NotWritten", MutationOutcome::MayHaveReached(_) | MutationOutcome::OutcomeUnknown => "OutcomeUnknown" },"elapsedMs":started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}),
        );
        outcome
    }

    #[cfg(test)]
    async fn write_encoded_with_test_deadline<T>(
        &self,
        encoded: String,
        request_id: String,
        method: &str,
        rpc_deadline: std::time::Duration,
        decode: impl FnOnce(GatewayResponse) -> Result<T, wire::WireError>,
    ) -> MutationOutcome<T> {
        let _ = method;
        map_write_response(
            self.gateway
                .rpc_encoded_mutation_with_deadline(request_id, encoded, rpc_deadline)
                .await,
            decode,
        )
    }
}

#[derive(Default)]
struct MaterializationProgress {
    created_agents: Vec<TeamOwnedAgentId>,
    config_restore: Option<ConfigUndo>,
    markers: Vec<(TeamBuddyMarker, ResolvedWorkspace)>,
    written_markers: usize,
}

impl MaterializationProgress {
    async fn compensate(&mut self, provider: &TeamProvider, effects_known: bool) -> bool {
        let started = platform::trace::enabled().then(Instant::now);
        session_trace(
            "runtime.team.compensate.request",
            || json!({"markers":self.written_markers,"createdAgents":self.created_agents.len(),"configRestore":self.config_restore.is_some()}),
        );
        if let Some(mut undo) = self.config_restore.take() {
            if undo.begin_compensation(
                &provider.config.state_dir(),
                &self.created_agents,
                effects_known,
            ).is_err() {
                self.config_restore = Some(undo);
                return false;
            }
            let confirmed = provider.compensate_config_undo(&mut undo).await;
            if confirmed {
                self.created_agents.clear();
                self.written_markers = 0;
            } else {
                self.config_restore = Some(undo);
            }
            return confirmed;
        }
        let confirmed = effects_known && self.created_agents.is_empty() && self.written_markers == 0;
        session_trace(
            "runtime.team.compensate.end",
            || json!({"confirmed":confirmed,"reason":if !effects_known {"native-effect-unresolved"} else if confirmed {"rollback-confirmed"} else {"rollback-unresolved"},"elapsedMs":started.map(|started| started.elapsed().as_millis()).unwrap_or_default()}),
        );
        confirmed
    }
}

struct VerifiedRole {
    role: organization::RoleId,
    agent_id: TeamOwnedAgentId,
    workspace: ResolvedWorkspace,
    ownership: RoleMaterializationOwnership,
}

impl VerifiedRole {
    fn managed(
        role: organization::RoleId,
        agent_id: TeamOwnedAgentId,
        workspace: ResolvedWorkspace,
    ) -> Self {
        Self {
            role,
            agent_id,
            workspace,
            ownership: RoleMaterializationOwnership::Managed,
        }
    }

    fn external(
        role: organization::RoleId,
        agent_id: TeamOwnedAgentId,
        workspace: ResolvedWorkspace,
    ) -> Self {
        Self {
            role,
            agent_id,
            workspace,
            ownership: RoleMaterializationOwnership::External,
        }
    }
}

impl fmt::Debug for VerifiedRole {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("VerifiedRole([REDACTED])")
    }
}

#[derive(Clone, Copy)]
enum WorkspaceProjectionError {
    Rejected,
    Unknown,
}

async fn report_failure(
    observer: Option<&TeamProvisionObserver>,
    stage: CreationStage,
    reason: FailureReason,
    file: Option<TeamCreationFile>,
) {
    if let Some(observer) = observer {
        let mut failure = TeamCreationFailure::new(stage, reason);
        failure.file = file;
        observer.report(TeamProvisionUpdate::Failure(failure)).await;
    }
}

fn read_failure_reason(failure: ReadFailure) -> FailureReason {
    match failure {
        ReadFailure::Unavailable => FailureReason::RpcUnavailable,
        ReadFailure::Rejected => FailureReason::RpcRejected,
        ReadFailure::Protocol => FailureReason::RpcProtocol,
        ReadFailure::Deadline => FailureReason::RpcDeadline,
        ReadFailure::Authentication => FailureReason::RpcAuthentication,
        ReadFailure::Cancelled => FailureReason::Cancelled,
    }
}

fn permanent_rejection() -> MaterializationOperationOutcome {
    MaterializationOperationOutcome::Rejected {
        rejection: organization::MaterializationRejection::Permanent,
    }
}

fn retryable_rejection() -> MaterializationOperationOutcome {
    MaterializationOperationOutcome::Rejected {
        rejection: organization::MaterializationRejection::Retryable,
    }
}

fn mutation_failure_reason<T>(outcome: &MutationOutcome<T>) -> FailureReason {
    match outcome {
        MutationOutcome::Rejected => FailureReason::Rejected,
        MutationOutcome::NotWritten(error) | MutationOutcome::MayHaveReached(error) => match error {
            DispatcherError::Deadline => FailureReason::RpcDeadline,
            DispatcherError::Protocol => FailureReason::RpcProtocol,
            _ if matches!(outcome, MutationOutcome::NotWritten(_)) => FailureReason::RpcUnavailable,
            _ => FailureReason::OutcomeUnknown,
        },
        MutationOutcome::Applied(_) | MutationOutcome::OutcomeUnknown => FailureReason::OutcomeUnknown,
    }
}

fn map_write_response<T>(
    response: MutationDelivery,
    decode: impl FnOnce(GatewayResponse) -> Result<T, wire::WireError>,
) -> MutationOutcome<T> {
    match response {
        MutationDelivery::Response(GatewayResponse::Failure { .. }) => {
            session_trace(
                "runtime.team.mutation.end",
                || json!({"reason":"target-rejected","outcome":"Rejected"}),
            );
            MutationOutcome::Rejected
        }
        MutationDelivery::Response(response) => match decode(response) {
            Ok(value) => {
                session_trace(
                    "runtime.team.mutation.end",
                    || json!({"reason":"decoded","outcome":"Applied"}),
                );
                MutationOutcome::Applied(value)
            }
            Err(_) => {
                session_trace(
                    "runtime.team.mutation.end",
                    || json!({"reason":"decode","outcome":"OutcomeUnknown"}),
                );
                MutationOutcome::OutcomeUnknown
            }
        },
        MutationDelivery::NotWritten(error) => {
            session_trace(
                "runtime.team.mutation.end",
                || json!({"reason":"not-written","outcome":"NotWritten"}),
            );
            MutationOutcome::NotWritten(error)
        }
        MutationDelivery::MayHaveReached(error) => {
            session_trace(
                "runtime.team.mutation.end",
                || json!({"reason":"may-have-reached","outcome":"OutcomeUnknown"}),
            );
            MutationOutcome::MayHaveReached(error)
        }
    }
}

impl fmt::Debug for TeamProvider {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TeamProvider")
            .finish_non_exhaustive()
    }
}

fn map_read_connection_failure(error: GatewayClientError) -> ReadFailure {
    match error {
        GatewayClientError::Protocol | GatewayClientError::RpcFailed => ReadFailure::Protocol,
        GatewayClientError::RpcDeadline | GatewayClientError::UpgradeDeadline
        | GatewayClientError::ChallengeDeadline | GatewayClientError::ConnectDeadline => ReadFailure::Deadline,
        GatewayClientError::Authentication => ReadFailure::Authentication,
        _ => ReadFailure::Unavailable,
    }
}

pub(super) fn next_request_id(operation: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);
    let sequence = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    format!("team-{operation}-{sequence}")
}

#[cfg(test)]
mod tests;
