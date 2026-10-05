use platform::{
    state_dir::CanonicalStateDir,
    trace::{identifier_hash, session_trace},
};
use serde_json::json;
use std::{fmt, sync::Arc, time::Instant};

use organization::{
    ManagedAgentReference, MaterializationOperationOutcome, MaterializationReceipt,
    NativeWorkspaceReceipt, RoleMaterializationAgent, RoleMaterializationOwnership,
    RoleMaterializationReceipt, TeamMaterializationRemoval, TeamMaterializationRequest,
    TeamProvisionObserver, TeamProvisionStage, TeamProvisionUpdate,
};

use super::{
    agent::{
        TeamAgent, TeamAgentCreate, TeamAgentUpdate, TeamAgents, TeamConfigAgent,
        TeamConfigSnapshot, TeamOwnedAgentId,
    },
    buddy::TeamBuddyMarker,
    config::ConfigUndo,
    recovery::{TeamRecoveryOutcome, TeamRecoveryRequest},
    workspace::{ResolvedWorkspace, TeamExternalWorkspaces, TeamWorkspaceProjection},
};
use crate::{
    agents::{AgentsReadFailure, OpenClawAgents},
    gateway::{
        client::{GatewayClient, GatewayClientError},
        delivery::MutationDelivery,
        wire::{self, GatewayResponse},
    },
    native_config::config_store::OpenClawConfigStore,
};

pub(crate) struct TeamProvider {
    gateway: Arc<GatewayClient>,
    config: OpenClawConfigStore,
}

pub(crate) enum MutationOutcome<T> {
    Applied(T),
    Rejected,
    OutcomeUnknown,
}

impl<T: fmt::Debug> fmt::Debug for MutationOutcome<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Applied(_) => formatter.write_str("MutationOutcome::Applied"),
            Self::Rejected => formatter.write_str("MutationOutcome::Rejected"),
            Self::OutcomeUnknown => formatter.write_str("MutationOutcome::OutcomeUnknown"),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ReadFailure {
    Unavailable,
    Rejected,
    Protocol,
}

impl From<AgentsReadFailure> for ReadFailure {
    fn from(error: AgentsReadFailure) -> Self {
        match error {
            AgentsReadFailure::Unavailable => Self::Unavailable,
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
        }
    }

    pub(crate) async fn list_agents(&self) -> Result<TeamAgents, ReadFailure> {
        let started = Instant::now();
        session_trace("runtime.team.native-list.request", json!({}));
        OpenClawAgents::new(Arc::clone(&self.gateway))
            .list()
            .await
            .map(|agents| {
                TeamAgents::new(
                    agents
                        .agents
                        .into_iter()
                        .map(|agent| TeamAgent::new(agent.id, agent.workspace))
                        .collect(),
                )
            })
            .map_err(ReadFailure::from)
            .inspect(|agents| session_trace("runtime.team.native-list.end", json!({"outcome":"Succeeded","count":agents.as_slice().len(),"elapsedMs":started.elapsed().as_millis()})))
            .inspect_err(|failure| session_trace("runtime.team.native-list.end", json!({"outcome":format!("{failure:?}"),"elapsedMs":started.elapsed().as_millis()})))
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
        let started = Instant::now();
        let unknown = |reason| {
            session_trace(
                "runtime.team.recovery.end",
                json!({"outcome":"OutcomeUnknown","reason":reason,"elapsedMs":started.elapsed().as_millis()}),
            );
            MaterializationOperationOutcome::OutcomeUnknown
        };
        session_trace(
            "runtime.team.recovery.request",
            json!({"count":request.intent().agents().len()}),
        );
        session_trace(
            "runtime.team.undo.read.request",
            json!({"operation":"recovery"}),
        );
        let undo = match ConfigUndo::load(&self.config.state_dir(), request.intent().team()) {
            Ok(Some(undo)) => {
                session_trace(
                    "runtime.team.undo.read.end",
                    json!({"outcome":"Succeeded","present":true}),
                );
                undo
            }
            Ok(None) => return unknown("undo-missing"),
            Err(()) => return unknown("undo-read"),
        };
        if !undo.matches_request(&request) {
            return unknown("undo-request-mismatch");
        }
        if undo.is_compensated() {
            let Ok(receipt) = undo.receipt() else {
                return unknown("undo-receipt-decode");
            };
            if let Some(observer) = &observer {
                observer
                    .report(TeamProvisionUpdate::Stage(
                        TeamProvisionStage::VerifyingTeam,
                    ))
                    .await;
            }
            for role in receipt.roles() {
                let Some(workspace) = role.native_workspace() else {
                    return unknown("receipt-workspace-missing");
                };
                let present = TeamBuddyMarker::new(receipt.team().clone(), role.role().clone())
                    .has_marker(std::path::Path::new(workspace.as_str()));
                session_trace(
                    "runtime.team.recovery.compensated-marker.end",
                    json!({"present":present.as_ref().ok(),"reason":if matches!(present, Ok(false)) {"marker-absent"} else {"marker-unresolved"}}),
                );
                if !matches!(present, Ok(false)) {
                    return unknown("compensated-marker-unresolved");
                }
            }
            session_trace(
                "runtime.team.recovery.end",
                json!({"outcome":"Rejected","reason":"compensated","elapsedMs":started.elapsed().as_millis()}),
            );
            return permanent_rejection();
        }
        let (facts, receipt) = (undo.facts(), undo.receipt());
        session_trace(
            "runtime.team.undo.decode",
            json!({"factsValid":facts.is_ok(),"receiptValid":receipt.is_ok()}),
        );
        let (Ok(facts), Ok(receipt)) = (facts, receipt) else {
            return unknown("undo-decode");
        };
        if let Some(observer) = &observer {
            observer
                .report(TeamProvisionUpdate::Stage(
                    TeamProvisionStage::VerifyingTeam,
                ))
                .await;
        }
        let Ok(snapshot) = self.config_snapshot().await else {
            return unknown("config-read");
        };
        if !snapshot.0.matches_agents(&facts) {
            return unknown("config-mismatch");
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
            Ok(TeamRecoveryOutcome::Unknown) => return unknown("native-recovery-unknown"),
            Err(_) => return unknown("native-list"),
        };
        for (index, role) in receipt.roles().iter().enumerate() {
            session_trace(
                "runtime.team.recovery.workspace",
                json!({"index":index,"roleHash":identifier_hash(role.role().as_str()),"agentHash":identifier_hash(role.agent().as_str()),"workspacePresent":role.native_workspace().is_some()}),
            );
            let Some(workspace) = role.native_workspace() else {
                return unknown("receipt-workspace-missing");
            };
            if !recovered.roles().iter().any(|native| {
                native.role().as_str() == role.role().as_str()
                    && native.agent().as_str() == role.agent().as_str()
                    && native.workspace().as_str() == workspace.as_str()
            }) {
                session_trace(
                    "runtime.team.recovery.workspace.end",
                    json!({"index":index,"reason":"native-workspace-mismatch","outcome":"OutcomeUnknown"}),
                );
                return unknown("native-workspace-mismatch");
            }
            session_trace(
                "runtime.team.recovery.workspace.end",
                json!({"index":index,"outcome":"Confirmed"}),
            );
        }
        // Durable expected config and all native identities are verified above.
        // Finish only missing markers after an interrupted materialization.
        for (index, role) in receipt.roles().iter().enumerate() {
            let marker_started = Instant::now();
            let role_hash = identifier_hash(role.role().as_str());
            let agent_hash = identifier_hash(role.agent().as_str());
            let workspace = std::path::Path::new(
                role.native_workspace()
                    .expect("verified workspace")
                    .as_str(),
            );
            let marker = TeamBuddyMarker::new(receipt.team().clone(), role.role().clone())
                .with_content(role.agents_markdown().unwrap_or(""));
            session_trace(
                "runtime.team.marker.recover.request",
                json!({"index":index,"roleHash":role_hash,"agentHash":agent_hash}),
            );
            let recovered = marker.recover(workspace);
            session_trace(
                "runtime.team.marker.recover.end",
                json!({"index":index,"matched":recovered.as_ref().ok(),"ioKind":recovered.as_ref().err().map(|error| format!("{:?}", error.kind())),"elapsedMs":marker_started.elapsed().as_millis()}),
            );
            match recovered {
                Ok(true) => {}
                Ok(false) => {
                    session_trace(
                        "runtime.team.marker.write.request",
                        json!({"index":index,"roleHash":role_hash,"agentHash":agent_hash}),
                    );
                    let written = marker.write(workspace);
                    session_trace(
                        "runtime.team.marker.write.end",
                        json!({"index":index,"succeeded":written.is_ok(),"ioKind":written.as_ref().err().map(|error| format!("{:?}", error.kind())),"elapsedMs":marker_started.elapsed().as_millis()}),
                    );
                    if written.is_err() {
                        return unknown("marker-write");
                    }
                    session_trace(
                        "runtime.team.marker.readback.request",
                        json!({"index":index}),
                    );
                    let readback = marker.recover(workspace);
                    session_trace(
                        "runtime.team.marker.readback.end",
                        json!({"index":index,"matched":readback.as_ref().ok(),"ioKind":readback.as_ref().err().map(|error| format!("{:?}", error.kind())),"elapsedMs":marker_started.elapsed().as_millis()}),
                    );
                    if !matches!(readback, Ok(true)) {
                        return unknown("marker-readback");
                    }
                }
                Err(_) => return unknown("marker-recover"),
            }
        }
        session_trace(
            "runtime.team.recovery.end",
            json!({"outcome":"Confirmed","elapsedMs":started.elapsed().as_millis()}),
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
        let started = Instant::now();
        session_trace(
            "runtime.team.materialize.request",
            json!({"count":request.intent().agents().len()}),
        );
        let outcome = async {
            session_trace(
                "runtime.team.undo.read.request",
                json!({"operation":"materialize"}),
            );
            match ConfigUndo::load(&self.config.state_dir(), request.intent().team()) {
                Ok(Some(_)) => {
                    session_trace(
                        "runtime.team.undo.read.end",
                        json!({"present":true,"outcome":"Succeeded","reason":"recover-existing"}),
                    );
                    return self
                        .recover_materialization_observed(request, observer)
                        .await;
                }
                Ok(None) => session_trace(
                    "runtime.team.undo.read.end",
                    json!({"present":false,"outcome":"Succeeded"}),
                ),
                Err(()) => {
                    session_trace(
                        "runtime.team.undo.read.end",
                        json!({"outcome":"OutcomeUnknown","reason":"undo-read"}),
                    );
                    return MaterializationOperationOutcome::OutcomeUnknown;
                }
            }
            let workspaces = match self.workspace_projection_for_request(&request) {
                Ok(workspaces) => workspaces,
                Err(WorkspaceProjectionError::Rejected) => return permanent_rejection(),
                Err(WorkspaceProjectionError::Unknown) => {
                    return MaterializationOperationOutcome::OutcomeUnknown;
                }
            };
            let external_workspaces = match self.external_workspaces_for_request(&request).await {
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
            json!({"outcome":match &outcome { MaterializationOperationOutcome::Confirmed { .. } => "Confirmed", MaterializationOperationOutcome::Rejected { .. } => "Rejected", _ => "OutcomeUnknown" },"elapsedMs":started.elapsed().as_millis()}),
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
                json!({"index":index,"roleHash":identifier_hash(role.role().as_str()),"agentHash":match role.agent() { RoleMaterializationAgent::External { agent } => Some(identifier_hash(agent.as_str())), _ => None },"managed":matches!(role.agent(), RoleMaterializationAgent::Managed { .. })}),
            );
            match role.agent() {
                RoleMaterializationAgent::Managed { name } => {
                    let Some(workspace) = workspaces.resolve(role.role()) else {
                        session_trace(
                            "runtime.team.materialize.role.end",
                            json!({"index":index,"reason":"managed-workspace-missing","outcome":"Rejected"}),
                        );
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
                        .materialize_managed_agent(name.clone(), workspace.clone())
                        .await;
                    session_trace(
                        "runtime.team.materialize.role.end",
                        json!({"index":index,"reason":"managed-agent","outcome":match &outcome { MutationOutcome::Applied(_) => "Applied", MutationOutcome::Rejected => "Rejected", MutationOutcome::OutcomeUnknown => "OutcomeUnknown" },"agentHash":created_agent.as_ref().map(|agent| identifier_hash(agent.as_str()))}),
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
                        MutationOutcome::OutcomeUnknown => {
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
                            json!({"index":index,"reason":"external-workspace-missing","outcome":"Rejected"}),
                        );
                        return self
                            .fail_materialization(&mut progress, permanent_rejection(), observer)
                            .await;
                    };
                    session_trace(
                        "runtime.team.materialize.role.end",
                        json!({"index":index,"outcome":"Resolved","workspacePresent":true}),
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
                Err(_) => {
                    session_trace(
                        "runtime.team.materialize.failed",
                        json!({"reason":"config-read","outcome":"OutcomeUnknown"}),
                    );
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
                        json!({"reason":"config-apply","outcome":"Rejected"}),
                    );
                    return self
                        .fail_materialization(&mut progress, permanent_rejection(), observer)
                        .await;
                }
                MutationOutcome::OutcomeUnknown => {
                    session_trace(
                        "runtime.team.materialize.failed",
                        json!({"reason":"config-apply","outcome":"OutcomeUnknown","undoRetained":true}),
                    );
                    // A late config write may still arrive; retain its durable undo.
                    return MaterializationOperationOutcome::OutcomeUnknown;
                }
            }
        }
        let agents = match self.list_agents().await {
            Ok(agents) => agents,
            Err(_) => {
                session_trace(
                    "runtime.team.materialize.failed",
                    json!({"reason":"native-readback-list","outcome":"OutcomeUnknown"}),
                );
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
                json!({"index":index,"roleHash":identifier_hash(verified.role.as_str()),"agentHash":identifier_hash(verified.agent_id.as_str())}),
            );
            let Some(agent) = agents.as_slice().iter().find(|agent| {
                agent.id().as_str() == verified.agent_id.0
                    && agent
                        .workspace()
                        .is_some_and(|workspace| workspace == &verified.workspace)
            }) else {
                session_trace(
                    "runtime.team.materialize.native-readback.end",
                    json!({"index":index,"reason":"agent-workspace-mismatch","outcome":"OutcomeUnknown"}),
                );
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
                    json!({"index":index,"reason":"duplicate-agent","outcome":"OutcomeUnknown"}),
                );
                return self
                    .fail_materialization(&mut progress, permanent_rejection(), observer)
                    .await;
            }
            session_trace(
                "runtime.team.materialize.native-readback.end",
                json!({"index":index,"outcome":"Confirmed","workspacePresent":true}),
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
            let marker_started = Instant::now();
            session_trace(
                "runtime.team.marker.write.request",
                json!({"index":index,"roleHash":identifier_hash(confirmed_roles[index].role().as_str()),"agentHash":identifier_hash(confirmed_roles[index].agent().as_str())}),
            );
            let written = marker.write(std::path::Path::new(workspace.as_str()));
            session_trace(
                "runtime.team.marker.write.end",
                json!({"index":index,"succeeded":written.is_ok(),"ioKind":written.as_ref().err().map(|error| format!("{:?}", error.kind())),"elapsedMs":marker_started.elapsed().as_millis()}),
            );
            if written.is_err() {
                session_trace(
                    "runtime.team.materialize.failed",
                    json!({"index":index,"reason":"marker-write","outcome":"OutcomeUnknown"}),
                );
                return self
                    .fail_materialization(&mut progress, permanent_rejection(), observer)
                    .await;
            }
            progress.written_markers += 1;
            session_trace(
                "runtime.team.marker.readback.request",
                json!({"index":index}),
            );
            let readback = marker.recover(std::path::Path::new(workspace.as_str()));
            session_trace(
                "runtime.team.marker.readback.end",
                json!({"index":index,"matched":readback.as_ref().ok(),"ioKind":readback.as_ref().err().map(|error| format!("{:?}", error.kind())),"elapsedMs":marker_started.elapsed().as_millis()}),
            );
            if !matches!(readback, Ok(true)) {
                session_trace(
                    "runtime.team.materialize.failed",
                    json!({"index":index,"reason":"marker-readback","outcome":"OutcomeUnknown"}),
                );
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
        name: String,
        workspace: ResolvedWorkspace,
    ) -> (MutationOutcome<TeamOwnedAgentId>, Option<TeamOwnedAgentId>) {
        let requested = TeamAgentCreate::try_new(name.clone(), workspace.clone())
            .expect("validated managed agent materialization must create a valid request");
        let agent_id = match self.create_agent(requested).await {
            MutationOutcome::Applied(agent_id) => agent_id,
            MutationOutcome::Rejected => return (MutationOutcome::Rejected, None),
            MutationOutcome::OutcomeUnknown => {
                return (MutationOutcome::OutcomeUnknown, None);
            }
        };
        let outcome = self
            .update_agent(
                TeamAgentUpdate::try_new(agent_id.clone(), name, workspace, None)
                    .expect("validated managed agent update must be valid"),
            )
            .await;
        match outcome {
            MutationOutcome::Applied(()) => {
                (MutationOutcome::Applied(agent_id.clone()), Some(agent_id))
            }
            MutationOutcome::Rejected => (MutationOutcome::Rejected, Some(agent_id)),
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
            json!({"outcome":if compensated {"Rejected"} else {"OutcomeUnknown"},"reason":if !effects_known {"native-effect-unresolved"} else if compensated {"rollback-confirmed"} else {"rollback-unresolved"}}),
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
        let started = Instant::now();
        let unknown = |reason| {
            session_trace(
                "runtime.team.unconfirmed-remove.end",
                json!({"outcome":"OutcomeUnknown","reason":reason,"elapsedMs":started.elapsed().as_millis()}),
            );
            MaterializationOperationOutcome::OutcomeUnknown
        };
        session_trace("runtime.team.unconfirmed-remove.request", json!({}));
        let undo = match ConfigUndo::load(&self.config.state_dir(), request.intent().team()) {
            Ok(Some(undo)) => undo,
            Ok(None) => return unknown("undo-missing"),
            Err(()) => return unknown("undo-read"),
        };
        if !undo.matches_request(&request) {
            return unknown("undo-request-mismatch");
        }
        let Ok(receipt) = undo.receipt() else {
            return unknown("undo-receipt-decode");
        };
        if !undo.is_compensated() && !undo.is_removed() {
            return unknown("active-ownership-unproven");
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
                json!({"index":index,"succeeded":removed.is_ok(),"reason":if removed.is_ok() {"marker-removed"} else {"marker-remove"},"ioKind":removed.as_ref().err().map(|error| format!("{:?}", error.kind()))}),
            );
            if removed.is_err() {
                return unknown("marker-remove");
            }
            let present = marker.has_marker(workspace);
            session_trace(
                "runtime.team.unconfirmed-remove.marker-readback.end",
                json!({"index":index,"present":present.as_ref().ok(),"reason":if matches!(present, Ok(false)) {"marker-absent"} else {"marker-unresolved"}}),
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
            json!({"outcome":"Confirmed","reason":"cleanup-confirmed","elapsedMs":started.elapsed().as_millis()}),
        );
        MaterializationOperationOutcome::Confirmed { receipt }
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
        let undo = match ConfigUndo::load(&self.config.state_dir(), removal.receipt().team()) {
            Ok(Some(undo)) if undo.matches_receipt(removal.receipt()) => Some(undo),
            Ok(None)
                if removal
                    .receipt()
                    .roles()
                    .iter()
                    .all(|role| role.ownership() == RoleMaterializationOwnership::Managed) =>
            {
                None
            }
            _ => return MaterializationOperationOutcome::OutcomeUnknown,
        };
        if let Some(undo) = &undo {
            if undo.is_removed() {
                return MaterializationOperationOutcome::Confirmed {
                    receipt: removal.receipt().clone(),
                };
            }
            if !matches!(
                self.restore_config(undo, false).await,
                MutationOutcome::Applied(())
            ) {
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
            if role.ownership() == RoleMaterializationOwnership::Managed {
                let agent = TeamOwnedAgentId::try_new(role.agent().as_str())
                    .expect("validated materialization receipt must have a managed agent");
                match self.delete_agent(agent).await {
                    MutationOutcome::Applied(()) => {}
                    MutationOutcome::Rejected | MutationOutcome::OutcomeUnknown => {
                        return MaterializationOperationOutcome::OutcomeUnknown;
                    }
                }
            }
        }
        if undo.is_some_and(|undo| undo.finish_removal(&self.config.state_dir()).is_err()) {
            return MaterializationOperationOutcome::OutcomeUnknown;
        }
        MaterializationOperationOutcome::Confirmed {
            receipt: removal.receipt().clone(),
        }
    }

    async fn external_workspaces_for_request(
        &self,
        request: &TeamMaterializationRequest,
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
            json!({"count":requested.len()}),
        );
        self.list_agents()
            .await
            .map_err(|_| {
                session_trace(
                    "runtime.team.external-workspaces.end",
                    json!({"reason":"native-list","outcome":"OutcomeUnknown"}),
                );
                WorkspaceProjectionError::Unknown
            })?
            .resolve_external_workspaces(requested)
            .inspect(|_| {
                session_trace(
                    "runtime.team.external-workspaces.end",
                    json!({"outcome":"Resolved"}),
                )
            })
            .map_err(|_| {
                session_trace(
                    "runtime.team.external-workspaces.end",
                    json!({"reason":"native-workspace-invalid","outcome":"Rejected"}),
                );
                WorkspaceProjectionError::Rejected
            })
    }

    fn workspace_projection_for_request(
        &self,
        request: &TeamMaterializationRequest,
    ) -> Result<TeamWorkspaceProjection, WorkspaceProjectionError> {
        let started = Instant::now();
        session_trace("runtime.team.config-read.request", json!({}));
        let canonical_config = self
            .config
            .read()
            .inspect(|_| session_trace("runtime.team.config-read.end", json!({"outcome":"Succeeded","elapsedMs":started.elapsed().as_millis()})))
            .map_err(|_| {
                session_trace("runtime.team.config-read.end", json!({"reason":"config-store-read","outcome":"OutcomeUnknown","elapsedMs":started.elapsed().as_millis()}));
                WorkspaceProjectionError::Unknown
            })?;
        let _ = canonical_config.get("agents");
        TeamWorkspaceProjection::for_request(self.config.state_dir_path(), request).map_err(|_| {
            session_trace(
                "runtime.team.workspace-projection.end",
                json!({"reason":"workspace-projection","outcome":"Rejected"}),
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
        match self.gateway.rpc_encoded_mutation(request_id, encoded).await {
            MutationDelivery::Response(GatewayResponse::Failure { error, .. })
                if is_agent_not_found_error(error.code()) =>
            {
                MutationOutcome::Applied(())
            }
            MutationDelivery::Response(GatewayResponse::Failure { .. }) => {
                MutationOutcome::Rejected
            }
            MutationDelivery::Response(response) => {
                match wire::team::decode_agents_delete(response) {
                    Ok(deleted) if deleted.agent_id == expected_agent_id => {
                        MutationOutcome::Applied(())
                    }
                    Ok(_) | Err(_) => MutationOutcome::OutcomeUnknown,
                }
            }
            MutationDelivery::NotWritten(_) => MutationOutcome::Rejected,
            MutationDelivery::MayHaveReached(_) => MutationOutcome::OutcomeUnknown,
        }
    }

    pub(crate) async fn config_snapshot(&self) -> Result<TeamConfigSnapshot, ReadFailure> {
        let started = Instant::now();
        session_trace("runtime.team.config-get.request", json!({}));
        let request = wire::team::config_get_request(next_request_id("config-get"))
            .map_err(|_| {
                session_trace("runtime.team.config-get.end", json!({"reason":"request-shape","outcome":"Protocol","elapsedMs":started.elapsed().as_millis()}));
                ReadFailure::Protocol
            })?;
        let result = match self.gateway.rpc_query(request).await {
            Ok(GatewayResponse::Failure { .. }) => {
                session_trace(
                    "runtime.team.config-get.rpc-end",
                    json!({"reason":"target-rejected","outcome":"Rejected"}),
                );
                Err(ReadFailure::Rejected)
            }
            Ok(response) => wire::team::decode_config_get(response)
                .map(TeamConfigSnapshot)
                .map_err(|_| {
                    session_trace(
                        "runtime.team.config-get.rpc-end",
                        json!({"reason":"decode","outcome":"Protocol"}),
                    );
                    ReadFailure::Protocol
                }),
            Err(error) => {
                let failure = map_read_connection_failure(error);
                session_trace(
                    "runtime.team.config-get.rpc-end",
                    json!({"reason":"transport","outcome":format!("{failure:?}")}),
                );
                Err(failure)
            }
        };
        session_trace(
            "runtime.team.config-get.end",
            json!({"outcome":result.as_ref().map_or_else(|failure| format!("{failure:?}"), |_| "Succeeded".to_owned()),"elapsedMs":started.elapsed().as_millis()}),
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
                    json!({"reason":"patch-agents","outcome":"Rejected"}),
                );
                return MutationOutcome::Rejected;
            }
        };
        let (raw, base_hash, facts) = patch.into_parts();
        let undo = match ConfigUndo::prepare(request, receipt, &facts) {
            Ok(undo) => undo,
            Err(()) => {
                session_trace(
                    "runtime.team.undo.prepare.end",
                    json!({"reason":"undo-prepare","outcome":"Rejected"}),
                );
                return MutationOutcome::Rejected;
            }
        };
        let started = Instant::now();
        session_trace(
            "runtime.team.undo.write.request",
            json!({"operation":"prepare"}),
        );
        let persisted = undo.persist(&self.config.state_dir());
        session_trace(
            "runtime.team.undo.write.end",
            json!({"operation":"prepare","succeeded":persisted.is_ok(),"elapsedMs":started.elapsed().as_millis()}),
        );
        if persisted.is_err() {
            return MutationOutcome::OutcomeUnknown;
        }
        progress.config_restore = Some(undo);
        let request =
            match wire::team::config_set_request(next_request_id("config-set"), raw, base_hash) {
                Ok(request) => request,
                Err(_) => {
                    session_trace(
                        "runtime.team.config-apply.end",
                        json!({"reason":"config-set-shape","outcome":"Rejected"}),
                    );
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
                            json!({"reason":"readback","outcome":"Applied"}),
                        );
                        MutationOutcome::Applied(())
                    }
                    Ok(_) => {
                        session_trace(
                            "runtime.team.config-apply.end",
                            json!({"reason":"readback-mismatch","outcome":"OutcomeUnknown"}),
                        );
                        MutationOutcome::OutcomeUnknown
                    }
                    Err(_) => {
                        session_trace(
                            "runtime.team.config-apply.end",
                            json!({"reason":"readback-unavailable","outcome":"OutcomeUnknown"}),
                        );
                        MutationOutcome::OutcomeUnknown
                    }
                }
            }
            outcome => outcome,
        }
    }

    async fn restore_config(&self, undo: &ConfigUndo, compensate: bool) -> MutationOutcome<()> {
        if !undo.has_external_roles() {
            return MutationOutcome::Applied(());
        }
        // At most one full replacement and one removal patch; each uses a fresh hash.
        // A final read proves restoration even when the previous write outcome was lost.
        for step in 0..=2 {
            let (Ok(snapshot), Ok(facts)) = (self.config_snapshot().await, undo.facts()) else {
                return MutationOutcome::OutcomeUnknown;
            };
            let prepared = if compensate {
                snapshot.0.prepare_restore(facts)
            } else {
                snapshot.0.prepare_external_restore(facts)
            };
            match prepared {
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

    async fn write_config_request(
        &self,
        request: wire::team::ConfigRestoreRequest,
    ) -> MutationOutcome<()> {
        let started = Instant::now();
        let is_set = matches!(&request, wire::team::ConfigRestoreRequest::Set(_));
        session_trace("runtime.team.config-write.request", json!({"set":is_set}));
        let encoded = match request.encode() {
            Ok(encoded) => encoded,
            Err(_) => {
                session_trace(
                    "runtime.team.config-write.end",
                    json!({"reason":"encode","outcome":"Rejected"}),
                );
                return MutationOutcome::Rejected;
            }
        };
        let outcome = map_write_response(
            self.gateway
                .rpc_encoded_mutation(request.request_id().to_owned(), encoded)
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
            json!({"outcome":match &outcome { MutationOutcome::Applied(_) => "Applied", MutationOutcome::Rejected => "Rejected", MutationOutcome::OutcomeUnknown => "OutcomeUnknown" },"elapsedMs":started.elapsed().as_millis()}),
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
        let started = Instant::now();
        let operation = match method {
            "agents.create" => "create",
            "agents.update" => "update",
            _ => "mutation",
        };
        session_trace(
            "runtime.team.agent-write.request",
            json!({"operation":operation}),
        );
        let outcome = map_write_response(
            self.gateway.rpc_encoded_mutation(request_id, encoded).await,
            decode,
        );
        session_trace(
            "runtime.team.agent-write.end",
            json!({"operation":operation,"outcome":match &outcome { MutationOutcome::Applied(_) => "Applied", MutationOutcome::Rejected => "Rejected", MutationOutcome::OutcomeUnknown => "OutcomeUnknown" },"elapsedMs":started.elapsed().as_millis()}),
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
        let started = Instant::now();
        session_trace(
            "runtime.team.compensate.request",
            json!({"markers":self.written_markers,"createdAgents":self.created_agents.len(),"configRestore":self.config_restore.is_some()}),
        );
        let mut confirmed = effects_known;
        while self.written_markers > 0 {
            self.written_markers -= 1;
            let (marker, workspace) = &self.markers[self.written_markers];
            let removed = marker.remove(std::path::Path::new(workspace.as_str()));
            session_trace(
                "runtime.team.compensate.marker.end",
                json!({"index":self.written_markers,"succeeded":removed.is_ok(),"ioKind":removed.as_ref().err().map(|error| format!("{:?}", error.kind()))}),
            );
            if removed.is_err() {
                confirmed = false;
            } else {
                let present = marker.has_marker(std::path::Path::new(workspace.as_str()));
                session_trace(
                    "runtime.team.compensate.marker-readback.end",
                    json!({"index":self.written_markers,"present":present.as_ref().ok(),"reason":if matches!(present, Ok(false)) {"marker-absent"} else {"marker-unresolved"}}),
                );
                if !matches!(present, Ok(false)) {
                    confirmed = false;
                }
            }
        }
        if let Some(undo) = &self.config_restore {
            let outcome = provider.restore_config(undo, true).await;
            session_trace(
                "runtime.team.compensate.config.end",
                json!({"outcome":match &outcome { MutationOutcome::Applied(_) => "Applied", MutationOutcome::Rejected => "Rejected", MutationOutcome::OutcomeUnknown => "OutcomeUnknown" }}),
            );
            match outcome {
                MutationOutcome::Applied(()) => {}
                MutationOutcome::Rejected | MutationOutcome::OutcomeUnknown => {
                    confirmed = false;
                }
            }
        }
        while let Some(agent_id) = self.created_agents.pop() {
            let agent_hash = identifier_hash(agent_id.as_str());
            let outcome = provider.delete_agent(agent_id).await;
            session_trace(
                "runtime.team.compensate.agent.end",
                json!({"agentHash":agent_hash,"outcome":match &outcome { MutationOutcome::Applied(_) => "Applied", MutationOutcome::Rejected => "Rejected", MutationOutcome::OutcomeUnknown => "OutcomeUnknown" }}),
            );
            match outcome {
                MutationOutcome::Applied(()) => {}
                MutationOutcome::Rejected | MutationOutcome::OutcomeUnknown => {
                    confirmed = false;
                }
            }
        }
        if confirmed {
            if let Some(undo) = self.config_restore.take() {
                session_trace(
                    "runtime.team.undo.write.request",
                    json!({"operation":"compensate"}),
                );
                confirmed = undo
                    .finish_compensation(&provider.config.state_dir())
                    .is_ok();
                session_trace(
                    "runtime.team.undo.write.end",
                    json!({"operation":"compensate","succeeded":confirmed}),
                );
            }
        }
        session_trace(
            "runtime.team.compensate.end",
            json!({"confirmed":confirmed,"reason":if !effects_known {"native-effect-unresolved"} else if confirmed {"rollback-confirmed"} else {"rollback-unresolved"},"elapsedMs":started.elapsed().as_millis()}),
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

fn permanent_rejection() -> MaterializationOperationOutcome {
    MaterializationOperationOutcome::Rejected {
        rejection: organization::MaterializationRejection::Permanent,
    }
}

fn is_agent_not_found_error(code: &str) -> bool {
    matches!(
        code,
        "NOT_FOUND" | "AGENT_NOT_FOUND" | "not_found" | "agent_not_found"
    )
}

fn map_write_response<T>(
    response: MutationDelivery,
    decode: impl FnOnce(GatewayResponse) -> Result<T, wire::WireError>,
) -> MutationOutcome<T> {
    match response {
        MutationDelivery::Response(GatewayResponse::Failure { .. }) => {
            session_trace(
                "runtime.team.mutation.end",
                json!({"reason":"target-rejected","outcome":"Rejected"}),
            );
            MutationOutcome::Rejected
        }
        MutationDelivery::Response(response) => match decode(response) {
            Ok(value) => {
                session_trace(
                    "runtime.team.mutation.end",
                    json!({"reason":"decoded","outcome":"Applied"}),
                );
                MutationOutcome::Applied(value)
            }
            Err(_) => {
                session_trace(
                    "runtime.team.mutation.end",
                    json!({"reason":"decode","outcome":"OutcomeUnknown"}),
                );
                MutationOutcome::OutcomeUnknown
            }
        },
        MutationDelivery::NotWritten(_) => {
            session_trace(
                "runtime.team.mutation.end",
                json!({"reason":"not-written","outcome":"Rejected"}),
            );
            MutationOutcome::Rejected
        }
        MutationDelivery::MayHaveReached(_) => {
            session_trace(
                "runtime.team.mutation.end",
                json!({"reason":"may-have-reached","outcome":"OutcomeUnknown"}),
            );
            MutationOutcome::OutcomeUnknown
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
