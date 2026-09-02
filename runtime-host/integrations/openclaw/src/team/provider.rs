use std::fmt;

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
    recovery::{self, TeamRecoveryOutcome, TeamRecoveryRequest},
    workspace::{ResolvedWorkspace, TeamExternalWorkspaces, TeamWorkspaceProjection},
};
use crate::{
    gateway::{
        client::{GatewayClient, GatewayClientError},
        delivery::MutationDelivery,
        wire::{self, GatewayResponse},
    },
    lifecycle::state_dir::CanonicalStateDir,
    projection::config_store::OpenClawConfigStore,
};

pub(crate) struct TeamProvider<'gateway> {
    gateway: &'gateway GatewayClient,
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

impl<'gateway> TeamProvider<'gateway> {
    pub(crate) fn new(gateway: &'gateway GatewayClient, state_dir: CanonicalStateDir) -> Self {
        Self {
            gateway,
            config: OpenClawConfigStore::new(state_dir),
        }
    }

    pub(crate) async fn list_agents(&self) -> Result<TeamAgents, ReadFailure> {
        let request = wire::team::agents_list_request(next_request_id("agents-list"))
            .map_err(|_| ReadFailure::Protocol)?;
        match self.gateway.rpc_query(request).await {
            Ok(GatewayResponse::Failure { .. }) => Err(ReadFailure::Rejected),
            Ok(response) => wire::team::decode_agents_list(response)
                .map(|agents| {
                    TeamAgents::new(
                        agents
                            .agents
                            .into_iter()
                            .map(|agent| TeamAgent::new(agent.agent_id, agent.workspace))
                            .collect(),
                    )
                })
                .map_err(|_| ReadFailure::Protocol),
            Err(error) => Err(map_read_connection_failure(error)),
        }
    }

    pub(crate) async fn recover(
        &self,
        request: TeamRecoveryRequest,
    ) -> Result<TeamRecoveryOutcome, ReadFailure> {
        self.list_agents()
            .await
            .map(|agents| recovery::recover_agents(agents.as_slice(), request))
    }

    /// Rebuilds a receipt only from a native `agents.list` readback. The durable
    /// intent supplies role identity and ownership; private workspace paths remain
    /// integration-local evidence and never leave it.
    pub(crate) async fn recover_materialization(
        &self,
        request: TeamMaterializationRequest,
    ) -> MaterializationOperationOutcome {
        if request
            .intent()
            .agents()
            .iter()
            .any(|role| matches!(role.agent(), RoleMaterializationAgent::Managed { .. }))
        {
            // A durable managed-agent intent records a requested name, not the
            // provider-assigned native ID. Do not guess that identity from list
            // output; keep it ambiguous until a provider-owned recovery receipt exists.
            return MaterializationOperationOutcome::OutcomeUnknown;
        }
        let Some(recovery_request) = recovery_request(&request) else {
            return MaterializationOperationOutcome::OutcomeUnknown;
        };
        let recovery = match self.recover(recovery_request).await {
            Ok(TeamRecoveryOutcome::Recovered(recovery))
                if recovery.team().as_str() == request.intent().team().as_str() =>
            {
                recovery
            }
            Ok(TeamRecoveryOutcome::Recovered(_)) | Ok(TeamRecoveryOutcome::Unknown) | Err(_) => {
                return MaterializationOperationOutcome::OutcomeUnknown;
            }
        };
        let mut roles = Vec::with_capacity(request.intent().agents().len());
        for requested in request.intent().agents() {
            let Some(recovered) = recovery
                .roles()
                .iter()
                .find(|recovered| recovered.role().as_str() == requested.role().as_str())
            else {
                return MaterializationOperationOutcome::OutcomeUnknown;
            };
            if recovered.agent().as_str().is_empty() {
                return MaterializationOperationOutcome::OutcomeUnknown;
            }
            let ownership = match requested.agent() {
                RoleMaterializationAgent::Managed { .. } => {
                    return MaterializationOperationOutcome::OutcomeUnknown;
                }
                RoleMaterializationAgent::External { agent } => {
                    if recovered.agent().as_str() != agent.as_str() {
                        return MaterializationOperationOutcome::OutcomeUnknown;
                    }
                    RoleMaterializationOwnership::External
                }
            };
            if !matches!(
                TeamBuddyMarker::new(request.intent().team().clone(), requested.role().clone(),)
                    .recover(std::path::Path::new(recovered.workspace().as_str())),
                Ok(true)
            ) {
                return MaterializationOperationOutcome::OutcomeUnknown;
            }
            let agent = ManagedAgentReference::try_new(recovered.agent().as_str().to_owned())
                .expect("native recovery agent ID must be a valid materialization reference");
            let workspace =
                NativeWorkspaceReceipt::try_new(recovered.workspace().as_str().to_owned())
                    .expect("native recovery workspace must be a valid workspace receipt");
            roles.push(RoleMaterializationReceipt::with_native_workspace(
                requested.role().clone(),
                agent,
                ownership,
                request.intent().endpoint().clone(),
                workspace,
            ));
        }
        let receipt = MaterializationReceipt::try_new(
            request.intent().team().clone(),
            request.intent().endpoint().clone(),
            roles,
        )
        .expect("complete native recovery facts must form a receipt");
        MaterializationOperationOutcome::Confirmed { receipt }
    }

    pub(crate) async fn materialize(
        &self,
        request: TeamMaterializationRequest,
    ) -> MaterializationOperationOutcome {
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
            match self.apply_config_agents(snapshot, config_agents).await {
                MutationOutcome::Applied(restore_facts) => {
                    progress.config_restore = Some(restore_facts);
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
        progress.config_restore = None;
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
    ) -> MutationOutcome<wire::team::ConfigRestoreFacts> {
        let patch = match snapshot
            .0
            .patch_agents(agents.into_iter().map(TeamConfigAgent::into_wire).collect())
        {
            Ok(patch) => patch,
            Err(_) => return MutationOutcome::Rejected,
        };
        let (raw, base_hash, restore_facts) = patch.into_parts();
        let request =
            match wire::team::config_set_request(next_request_id("config-set"), raw, base_hash) {
                Ok(request) => request,
                Err(_) => return MutationOutcome::Rejected,
            };
        match self.write_config_request(request).await {
            MutationOutcome::Applied(()) => MutationOutcome::Applied(restore_facts),
            MutationOutcome::Rejected => MutationOutcome::Rejected,
            MutationOutcome::OutcomeUnknown => MutationOutcome::OutcomeUnknown,
        }
    }

    async fn restore_config(&self, facts: wire::team::ConfigRestoreFacts) -> MutationOutcome<()> {
        let snapshot = match self.config_snapshot().await {
            Ok(snapshot) => snapshot,
            Err(_) => return MutationOutcome::OutcomeUnknown,
        };
        let (request, fenced) = match snapshot.0.prepare_restore(facts) {
            Ok(wire::team::ConfigRestorePreparation::Ready { request, fenced }) => {
                (request, fenced)
            }
            Ok(wire::team::ConfigRestorePreparation::Fenced) => {
                return MutationOutcome::OutcomeUnknown;
            }
            Err(_) => return MutationOutcome::OutcomeUnknown,
        };
        match self.write_config_request(request).await {
            MutationOutcome::Applied(()) if !fenced => MutationOutcome::Applied(()),
            MutationOutcome::Applied(())
            | MutationOutcome::Rejected
            | MutationOutcome::OutcomeUnknown => MutationOutcome::OutcomeUnknown,
        }
    }

    async fn write_config_request(
        &self,
        request: wire::team::ConfigSetRequest,
    ) -> MutationOutcome<()> {
        match self
            .gateway
            .rpc_encoded_mutation(
                request.request_id().to_owned(),
                match request.encode() {
                    Ok(encoded) => encoded,
                    Err(_) => return MutationOutcome::Rejected,
                },
            )
            .await
        {
            MutationDelivery::Response(GatewayResponse::Failure { .. }) => {
                MutationOutcome::Rejected
            }
            MutationDelivery::Response(response) => match wire::team::decode_config_set(response) {
                Ok(_) => MutationOutcome::Applied(()),
                Err(_) => MutationOutcome::OutcomeUnknown,
            },
            MutationDelivery::NotWritten(_) => MutationOutcome::Rejected,
            MutationDelivery::MayHaveReached(_) => MutationOutcome::OutcomeUnknown,
        }
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
    config_restore: Option<wire::team::ConfigRestoreFacts>,
    markers: Vec<(TeamBuddyMarker, ResolvedWorkspace)>,
    written_markers: usize,
}

impl MaterializationProgress {
    async fn compensate(&mut self, provider: &TeamProvider<'_>) -> bool {
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
        if let Some(facts) = self.config_restore.take() {
            match provider.restore_config(facts).await {
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

fn recovery_request(request: &TeamMaterializationRequest) -> Option<TeamRecoveryRequest> {
    let roles = request
        .intent()
        .agents()
        .iter()
        .map(|role| match role.agent() {
            RoleMaterializationAgent::External { agent } => {
                recovery::TeamRecoveryRole::try_new(role.role().as_str(), agent.as_str()).ok()
            }
            RoleMaterializationAgent::Managed { .. } => None,
        })
        .collect::<Option<Vec<_>>>()?;
    TeamRecoveryRequest::try_new(request.intent().team().as_str(), roles).ok()
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

impl fmt::Debug for TeamProvider<'_> {
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
