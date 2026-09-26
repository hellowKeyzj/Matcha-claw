use platform::state_dir::CanonicalStateDir;
use std::{fmt, sync::Arc};

use organization::{
    ManagedAgentReference, MaterializationOperationOutcome, MaterializationReceipt,
    NativeWorkspaceReceipt, RoleMaterializationAgent, RoleMaterializationOwnership,
    RoleMaterializationReceipt, TeamMaterializationRemoval, TeamMaterializationRequest,
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
        let Ok(Some(undo)) = ConfigUndo::load(&self.config.state_dir(), request.intent().team())
        else {
            return MaterializationOperationOutcome::OutcomeUnknown;
        };
        if !undo.matches_request(&request) {
            return MaterializationOperationOutcome::OutcomeUnknown;
        }
        let (Ok(facts), Ok(receipt)) = (undo.facts(), undo.receipt()) else {
            return MaterializationOperationOutcome::OutcomeUnknown;
        };
        let Ok(snapshot) = self.config_snapshot().await else {
            return MaterializationOperationOutcome::OutcomeUnknown;
        };
        if !snapshot.0.matches_agents(&facts) {
            return MaterializationOperationOutcome::OutcomeUnknown;
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
        let Ok(TeamRecoveryOutcome::Recovered(recovered)) = self.recover(recovery_request).await
        else {
            return MaterializationOperationOutcome::OutcomeUnknown;
        };
        for role in receipt.roles() {
            let Some(workspace) = role.native_workspace() else {
                return MaterializationOperationOutcome::OutcomeUnknown;
            };
            if !recovered.roles().iter().any(|native| {
                native.role().as_str() == role.role().as_str()
                    && native.agent().as_str() == role.agent().as_str()
                    && native.workspace().as_str() == workspace.as_str()
            }) {
                return MaterializationOperationOutcome::OutcomeUnknown;
            }
        }
        // Durable expected config and all native identities are verified above.
        // Finish only missing markers after an interrupted materialization.
        for role in receipt.roles() {
            let workspace = std::path::Path::new(
                role.native_workspace()
                    .expect("verified workspace")
                    .as_str(),
            );
            let marker = TeamBuddyMarker::new(receipt.team().clone(), role.role().clone());
            match marker.recover(workspace) {
                Ok(true) => {}
                Ok(false) => {
                    if marker.write(workspace).is_err()
                        || !matches!(marker.recover(workspace), Ok(true))
                    {
                        return MaterializationOperationOutcome::OutcomeUnknown;
                    }
                }
                Err(_) => return MaterializationOperationOutcome::OutcomeUnknown,
            }
        }
        MaterializationOperationOutcome::Confirmed { receipt }
    }

    pub(crate) async fn materialize(
        &self,
        request: TeamMaterializationRequest,
    ) -> MaterializationOperationOutcome {
        match ConfigUndo::load(&self.config.state_dir(), request.intent().team()) {
            Ok(Some(_)) => return self.recover_materialization(request).await,
            Ok(None) => {}
            Err(()) => return MaterializationOperationOutcome::OutcomeUnknown,
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
        self.materialize_request(request, workspaces, external_workspaces)
            .await
    }

    async fn materialize_request(
        &self,
        request: TeamMaterializationRequest,
        workspaces: TeamWorkspaceProjection,
        external_workspaces: TeamExternalWorkspaces,
    ) -> MaterializationOperationOutcome {
        let mut config_agents = Vec::new();
        let mut verified_roles = Vec::with_capacity(request.intent().agents().len());
        let mut progress = MaterializationProgress::default();
        for role in request.intent().agents() {
            match role.agent() {
                RoleMaterializationAgent::Managed { name } => {
                    let Some(workspace) = workspaces.resolve(role.role()) else {
                        return self
                            .fail_materialization(&mut progress, permanent_rejection())
                            .await;
                    };
                    let (outcome, created_agent) = self
                        .materialize_managed_agent(name.clone(), workspace.clone())
                        .await;
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
                                .fail_materialization(&mut progress, permanent_rejection())
                                .await;
                        }
                        MutationOutcome::OutcomeUnknown => {
                            return self
                                .fail_materialization(
                                    &mut progress,
                                    MaterializationOperationOutcome::OutcomeUnknown,
                                )
                                .await;
                        }
                    }
                }
                RoleMaterializationAgent::External { agent } => {
                    let agent_id = TeamOwnedAgentId::try_new(agent.as_str())
                        .expect("validated materialization intent must have an external agent");
                    let Some(workspace) = external_workspaces.resolve(&agent_id) else {
                        return self
                            .fail_materialization(&mut progress, permanent_rejection())
                            .await;
                    };
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
                    return self
                        .fail_materialization(
                            &mut progress,
                            MaterializationOperationOutcome::OutcomeUnknown,
                        )
                        .await;
                }
            };
            let planned_receipt = MaterializationReceipt::try_new(
                request.intent().team().clone(),
                request.intent().endpoint().clone(),
                verified_roles
                    .iter()
                    .map(|role| {
                        RoleMaterializationReceipt::with_native_workspace(
                            role.role.clone(),
                            ManagedAgentReference::try_new(role.agent_id.as_str())
                                .expect("validated agent"),
                            role.ownership,
                            request.intent().endpoint().clone(),
                            NativeWorkspaceReceipt::try_new(role.workspace.as_str())
                                .expect("validated workspace"),
                        )
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
                )
                .await
            {
                MutationOutcome::Applied(()) => {}
                MutationOutcome::Rejected => {
                    return self
                        .fail_materialization(&mut progress, permanent_rejection())
                        .await;
                }
                MutationOutcome::OutcomeUnknown => {
                    // A late config write may still arrive; retain its durable undo.
                    return MaterializationOperationOutcome::OutcomeUnknown;
                }
            }
        }
        let agents = match self.list_agents().await {
            Ok(agents) => agents,
            Err(_) => {
                return self
                    .fail_materialization(
                        &mut progress,
                        MaterializationOperationOutcome::OutcomeUnknown,
                    )
                    .await;
            }
        };
        let mut confirmed_roles = Vec::with_capacity(verified_roles.len());
        for verified in verified_roles {
            let Some(agent) = agents.as_slice().iter().find(|agent| {
                agent.id().as_str() == verified.agent_id.0
                    && agent
                        .workspace()
                        .is_some_and(|workspace| workspace == &verified.workspace)
            }) else {
                return self
                    .fail_materialization(
                        &mut progress,
                        MaterializationOperationOutcome::OutcomeUnknown,
                    )
                    .await;
            };
            if agents
                .as_slice()
                .iter()
                .filter(|candidate| candidate.id().as_str() == agent.id().as_str())
                .count()
                != 1
            {
                return self
                    .fail_materialization(
                        &mut progress,
                        MaterializationOperationOutcome::OutcomeUnknown,
                    )
                    .await;
            }
            let agent = ManagedAgentReference::try_new(verified.agent_id.0)
                .expect("native readback agent ID must be a valid materialization reference");
            let workspace_receipt =
                NativeWorkspaceReceipt::try_new(verified.workspace.as_str().to_owned())
                    .expect("native readback workspace must be a valid workspace receipt");
            confirmed_roles.push(RoleMaterializationReceipt::with_native_workspace(
                verified.role,
                agent,
                verified.ownership,
                request.intent().endpoint().clone(),
                workspace_receipt,
            ));
            progress.markers.push((
                TeamBuddyMarker::new(
                    request.intent().team().clone(),
                    confirmed_roles
                        .last()
                        .expect("role was recorded")
                        .role()
                        .clone(),
                ),
                verified.workspace,
            ));
        }
        while progress.written_markers < progress.markers.len() {
            let index = progress.written_markers;
            let (marker, workspace) = &progress.markers[index];
            if marker
                .write(std::path::Path::new(workspace.as_str()))
                .is_err()
            {
                return self
                    .fail_materialization(
                        &mut progress,
                        MaterializationOperationOutcome::OutcomeUnknown,
                    )
                    .await;
            }
            progress.written_markers += 1;
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
    ) -> MaterializationOperationOutcome {
        if progress.compensate(self).await {
            outcome
        } else {
            MaterializationOperationOutcome::OutcomeUnknown
        }
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
        self.list_agents()
            .await
            .map_err(|_| WorkspaceProjectionError::Unknown)?
            .resolve_external_workspaces(requested)
            .map_err(|_| WorkspaceProjectionError::Rejected)
    }

    fn workspace_projection_for_request(
        &self,
        request: &TeamMaterializationRequest,
    ) -> Result<TeamWorkspaceProjection, WorkspaceProjectionError> {
        let canonical_config = self
            .config
            .read()
            .map_err(|_| WorkspaceProjectionError::Unknown)?;
        let _ = canonical_config.get("agents");
        TeamWorkspaceProjection::for_request(self.config.state_dir_path(), request)
            .map_err(|_| WorkspaceProjectionError::Rejected)
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
        let request = wire::team::config_get_request(next_request_id("config-get"))
            .map_err(|_| ReadFailure::Protocol)?;
        match self.gateway.rpc_query(request).await {
            Ok(GatewayResponse::Failure { .. }) => Err(ReadFailure::Rejected),
            Ok(response) => wire::team::decode_config_get(response)
                .map(TeamConfigSnapshot)
                .map_err(|_| ReadFailure::Protocol),
            Err(error) => Err(map_read_connection_failure(error)),
        }
    }

    async fn apply_config_agents(
        &self,
        snapshot: TeamConfigSnapshot,
        agents: Vec<TeamConfigAgent>,
        request: &TeamMaterializationRequest,
        receipt: &MaterializationReceipt,
        progress: &mut MaterializationProgress,
    ) -> MutationOutcome<()> {
        let patch = match snapshot
            .0
            .patch_agents(agents.into_iter().map(TeamConfigAgent::into_wire).collect())
        {
            Ok(patch) => patch,
            Err(_) => return MutationOutcome::Rejected,
        };
        let (raw, base_hash, facts) = patch.into_parts();
        let undo = match ConfigUndo::prepare(request, receipt, &facts) {
            Ok(undo) => undo,
            Err(()) => return MutationOutcome::Rejected,
        };
        if undo.persist(&self.config.state_dir()).is_err() {
            return MutationOutcome::OutcomeUnknown;
        }
        progress.config_restore = Some(undo);
        let request =
            match wire::team::config_set_request(next_request_id("config-set"), raw, base_hash) {
                Ok(request) => request,
                Err(_) => return MutationOutcome::Rejected,
            };
        match self
            .write_config_request(wire::team::ConfigRestoreRequest::Set(request))
            .await
        {
            MutationOutcome::Applied(()) => match self.config_snapshot().await {
                Ok(snapshot) if snapshot.0.matches_agents(&facts) => MutationOutcome::Applied(()),
                _ => MutationOutcome::OutcomeUnknown,
            },
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
        let encoded = match request.encode() {
            Ok(encoded) => encoded,
            Err(_) => return MutationOutcome::Rejected,
        };
        let is_set = matches!(&request, wire::team::ConfigRestoreRequest::Set(_));
        map_write_response(
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
        )
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
        let _ = method;
        map_write_response(
            self.gateway.rpc_encoded_mutation(request_id, encoded).await,
            decode,
        )
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
    async fn compensate(&mut self, provider: &TeamProvider) -> bool {
        let mut confirmed = true;
        while self.written_markers > 0 {
            self.written_markers -= 1;
            let (marker, workspace) = &self.markers[self.written_markers];
            if marker
                .remove(std::path::Path::new(workspace.as_str()))
                .is_err()
            {
                confirmed = false;
            }
        }
        if let Some(undo) = &self.config_restore {
            match provider.restore_config(undo, true).await {
                MutationOutcome::Applied(()) => {}
                MutationOutcome::Rejected | MutationOutcome::OutcomeUnknown => {
                    confirmed = false;
                }
            }
        }
        while let Some(agent_id) = self.created_agents.pop() {
            match provider.delete_agent(agent_id).await {
                MutationOutcome::Applied(()) => {}
                MutationOutcome::Rejected | MutationOutcome::OutcomeUnknown => {
                    confirmed = false;
                }
            }
        }
        if confirmed {
            if let Some(undo) = self.config_restore.take() {
                confirmed = undo
                    .finish_compensation(&provider.config.state_dir())
                    .is_ok();
            }
        }
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
        MutationDelivery::Response(GatewayResponse::Failure { .. }) => MutationOutcome::Rejected,
        MutationDelivery::Response(response) => match decode(response) {
            Ok(value) => MutationOutcome::Applied(value),
            Err(_) => MutationOutcome::OutcomeUnknown,
        },
        MutationDelivery::NotWritten(_) => MutationOutcome::Rejected,
        MutationDelivery::MayHaveReached(_) => MutationOutcome::OutcomeUnknown,
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

fn next_request_id(operation: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);
    let sequence = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    format!("team-{operation}-{sequence}")
}

#[cfg(test)]
mod tests;
