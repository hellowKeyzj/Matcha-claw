use std::{collections::BTreeSet, fmt, future::Future};

use crate::{RoleId, TeamId};

use super::{IdempotencyKey, ManagedAgentReference, RuntimeEndpointReference};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MaterializationSource {
    Manual,
    TeamSkill,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RoleMaterializationAgent {
    Managed { name: String },
    External { agent: ManagedAgentReference },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoleAgentMaterialization {
    role: RoleId,
    agent: RoleMaterializationAgent,
    tools: Vec<String>,
}

impl RoleAgentMaterialization {
    pub fn managed(
        role: RoleId,
        name: impl Into<String>,
    ) -> Result<Self, InvalidRoleAgentMaterialization> {
        let name = name.into();
        if name.trim().is_empty() {
            return Err(InvalidRoleAgentMaterialization::BlankAgentName);
        }
        Ok(Self {
            role,
            agent: RoleMaterializationAgent::Managed { name },
            tools: Vec::new(),
        })
    }

    pub fn external(role: RoleId, agent: ManagedAgentReference) -> Self {
        Self {
            role,
            agent: RoleMaterializationAgent::External { agent },
            tools: Vec::new(),
        }
    }

    pub fn role(&self) -> &RoleId {
        &self.role
    }

    pub fn agent(&self) -> &RoleMaterializationAgent {
        &self.agent
    }

    pub fn tools(&self) -> &[String] {
        &self.tools
    }

    pub fn with_tools(mut self, mut tools: Vec<String>) -> Self {
        let mut seen = BTreeSet::new();
        tools.retain(|tool| seen.insert(tool.clone()));
        self.tools = tools;
        self
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InvalidRoleAgentMaterialization {
    BlankAgentName,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamMaterializationIntent {
    team: TeamId,
    endpoint: RuntimeEndpointReference,
    source: MaterializationSource,
    agents: Vec<RoleAgentMaterialization>,
}

impl TeamMaterializationIntent {
    pub fn try_new(
        team: TeamId,
        endpoint: RuntimeEndpointReference,
        source: MaterializationSource,
        agents: Vec<RoleAgentMaterialization>,
    ) -> Result<Self, InvalidTeamMaterializationIntent> {
        if agents.is_empty() {
            return Err(InvalidTeamMaterializationIntent::EmptyAgents);
        }

        let mut roles = BTreeSet::new();
        if agents
            .iter()
            .any(|agent| !roles.insert(agent.role().as_str()))
        {
            return Err(InvalidTeamMaterializationIntent::DuplicateRole);
        }

        Ok(Self {
            team,
            endpoint,
            source,
            agents,
        })
    }

    pub fn team(&self) -> &TeamId {
        &self.team
    }

    pub fn endpoint(&self) -> &RuntimeEndpointReference {
        &self.endpoint
    }

    pub fn source(&self) -> MaterializationSource {
        self.source
    }

    pub fn agents(&self) -> &[RoleAgentMaterialization] {
        &self.agents
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InvalidTeamMaterializationIntent {
    EmptyAgents,
    DuplicateRole,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RoleMaterializationOwnership {
    Managed,
    External,
}

#[derive(Clone, Eq, PartialEq)]
pub struct NativeWorkspaceReceipt {
    workspace: String,
}

impl NativeWorkspaceReceipt {
    pub fn try_new(workspace: impl Into<String>) -> Result<Self, InvalidNativeWorkspaceReceipt> {
        let workspace = workspace.into();
        if workspace.trim().is_empty() {
            return Err(InvalidNativeWorkspaceReceipt::BlankWorkspace);
        }
        Ok(Self { workspace })
    }

    pub fn as_str(&self) -> &str {
        &self.workspace
    }
}

impl fmt::Debug for NativeWorkspaceReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeWorkspaceReceipt")
            .field("workspace", &"<redacted>")
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InvalidNativeWorkspaceReceipt {
    BlankWorkspace,
}

#[derive(Clone, Eq, PartialEq)]
pub struct RoleMaterializationReceipt {
    role: RoleId,
    agent: ManagedAgentReference,
    ownership: RoleMaterializationOwnership,
    endpoint: RuntimeEndpointReference,
    native_workspace: Option<NativeWorkspaceReceipt>,
}

impl fmt::Debug for RoleMaterializationReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RoleMaterializationReceipt")
            .field("role", &self.role)
            .field("agent", &self.agent)
            .field("ownership", &self.ownership)
            .field("endpoint", &self.endpoint)
            .field(
                "native_workspace",
                &self.native_workspace.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

impl RoleMaterializationReceipt {
    pub fn new(
        role: RoleId,
        agent: ManagedAgentReference,
        endpoint: RuntimeEndpointReference,
    ) -> Self {
        Self::with_ownership(role, agent, RoleMaterializationOwnership::Managed, endpoint)
    }

    pub fn with_ownership(
        role: RoleId,
        agent: ManagedAgentReference,
        ownership: RoleMaterializationOwnership,
        endpoint: RuntimeEndpointReference,
    ) -> Self {
        Self {
            role,
            agent,
            ownership,
            endpoint,
            native_workspace: None,
        }
    }

    pub fn with_native_workspace(
        role: RoleId,
        agent: ManagedAgentReference,
        ownership: RoleMaterializationOwnership,
        endpoint: RuntimeEndpointReference,
        native_workspace: NativeWorkspaceReceipt,
    ) -> Self {
        Self {
            role,
            agent,
            ownership,
            endpoint,
            native_workspace: Some(native_workspace),
        }
    }

    pub fn role(&self) -> &RoleId {
        &self.role
    }

    pub fn agent(&self) -> &ManagedAgentReference {
        &self.agent
    }

    pub fn ownership(&self) -> RoleMaterializationOwnership {
        self.ownership
    }

    pub fn endpoint(&self) -> &RuntimeEndpointReference {
        &self.endpoint
    }

    pub fn native_workspace(&self) -> Option<&NativeWorkspaceReceipt> {
        self.native_workspace.as_ref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaterializationReceipt {
    team: TeamId,
    endpoint: RuntimeEndpointReference,
    roles: Vec<RoleMaterializationReceipt>,
}

impl MaterializationReceipt {
    pub fn try_new(
        team: TeamId,
        endpoint: RuntimeEndpointReference,
        roles: Vec<RoleMaterializationReceipt>,
    ) -> Result<Self, InvalidMaterializationReceipt> {
        if roles.is_empty() {
            return Err(InvalidMaterializationReceipt::EmptyRoles);
        }

        let mut role_ids = BTreeSet::new();
        let mut agents = BTreeSet::new();
        for role in &roles {
            if role.endpoint() != &endpoint {
                return Err(InvalidMaterializationReceipt::RoleEndpointMismatch);
            }
            if !role_ids.insert(role.role().as_str()) {
                return Err(InvalidMaterializationReceipt::DuplicateRole);
            }
            if !agents.insert(role.agent().as_str()) {
                return Err(InvalidMaterializationReceipt::DuplicateAgent);
            }
        }

        Ok(Self {
            team,
            endpoint,
            roles,
        })
    }

    pub fn team(&self) -> &TeamId {
        &self.team
    }

    pub fn endpoint(&self) -> &RuntimeEndpointReference {
        &self.endpoint
    }

    pub fn roles(&self) -> &[RoleMaterializationReceipt] {
        &self.roles
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InvalidMaterializationReceipt {
    EmptyRoles,
    RoleEndpointMismatch,
    DuplicateRole,
    DuplicateAgent,
}

/// A durable intent already recorded by the Domain before external delivery begins.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamMaterializationRequest {
    intent: TeamMaterializationIntent,
    idempotency_key: IdempotencyKey,
}

impl TeamMaterializationRequest {
    pub fn new(intent: TeamMaterializationIntent, idempotency_key: IdempotencyKey) -> Self {
        Self {
            intent,
            idempotency_key,
        }
    }

    pub fn intent(&self) -> &TeamMaterializationIntent {
        &self.intent
    }

    pub fn idempotency_key(&self) -> &IdempotencyKey {
        &self.idempotency_key
    }
}

/// A removal intent for facts that were previously confirmed materialized.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamMaterializationRemoval {
    receipt: MaterializationReceipt,
    idempotency_key: IdempotencyKey,
}

impl TeamMaterializationRemoval {
    pub fn new(receipt: MaterializationReceipt, idempotency_key: IdempotencyKey) -> Self {
        Self {
            receipt,
            idempotency_key,
        }
    }

    pub fn receipt(&self) -> &MaterializationReceipt {
        &self.receipt
    }

    pub fn idempotency_key(&self) -> &IdempotencyKey {
        &self.idempotency_key
    }
}

/// A correlation receipt for provider acceptance, not materialized external facts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaterializationOperationReceipt {
    idempotency_key: IdempotencyKey,
}

impl MaterializationOperationReceipt {
    pub fn new(idempotency_key: IdempotencyKey) -> Self {
        Self { idempotency_key }
    }

    pub fn idempotency_key(&self) -> &IdempotencyKey {
        &self.idempotency_key
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MaterializationRejection {
    Permanent,
    Retryable,
}

/// The only provider-delivery outcomes available to the Domain.
///
/// `Confirmed` carries exact provider facts established by matching successful
/// mutations. `Accepted` confirms only receipt of a request and must not be
/// promoted to a materialization receipt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MaterializationOperationOutcome {
    Confirmed {
        receipt: MaterializationReceipt,
    },
    Accepted {
        receipt: MaterializationOperationReceipt,
    },
    Rejected {
        rejection: MaterializationRejection,
    },
    OutcomeUnknown,
}

/// Asynchronously delivers already-durable materialization intents.
///
/// Implementations must return `OutcomeUnknown` when timeout, connection close,
/// or invalid provider replies leave the remote effect ambiguous.
pub trait TeamMaterializationPort {
    type Error;

    fn materialize(
        &mut self,
        request: TeamMaterializationRequest,
    ) -> impl Future<Output = Result<MaterializationOperationOutcome, Self::Error>> + Send;

    fn remove(
        &mut self,
        removal: TeamMaterializationRemoval,
    ) -> impl Future<Output = Result<MaterializationOperationOutcome, Self::Error>> + Send;
}
