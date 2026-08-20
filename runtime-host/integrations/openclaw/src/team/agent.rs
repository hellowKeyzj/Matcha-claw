use std::fmt;

use crate::gateway::wire;

use super::workspace::{ResolvedWorkspace, TeamExternalWorkspaces};

pub(crate) struct TeamAgents {
    agents: Vec<TeamAgent>,
}

impl TeamAgents {
    pub(crate) fn new(agents: Vec<TeamAgent>) -> Self {
        Self { agents }
    }

    pub(crate) fn as_slice(&self) -> &[TeamAgent] {
        &self.agents
    }

    pub(crate) fn resolve_external_workspaces(
        &self,
        requested: Vec<TeamOwnedAgentId>,
    ) -> Result<TeamExternalWorkspaces, TeamInputError> {
        TeamExternalWorkspaces::for_agents(&self.agents, requested)
    }

    pub(crate) fn recover(
        self,
        request: super::recovery::TeamRecoveryRequest,
    ) -> super::recovery::TeamRecoveryOutcome {
        super::recovery::recover_agents(&self.agents, request)
    }
}

pub(crate) struct TeamAgent {
    id: TeamAgentId,
    workspace: Option<ResolvedWorkspace>,
}

impl TeamAgent {
    pub(crate) fn new(id: String, workspace: Option<String>) -> Self {
        Self {
            id: TeamAgentId(id),
            workspace: workspace.and_then(|workspace| ResolvedWorkspace::try_new(workspace).ok()),
        }
    }

    pub(crate) fn id(&self) -> &TeamAgentId {
        &self.id
    }

    pub(crate) fn workspace(&self) -> Option<&ResolvedWorkspace> {
        self.workspace.as_ref()
    }
}

#[derive(Clone, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) struct TeamAgentId(String);

impl TeamAgentId {
    pub(crate) fn new(value: String) -> Self {
        Self(value)
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for TeamAgentId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TeamAgentId")
    }
}

#[derive(Clone, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) struct TeamOwnedAgentId(pub(super) String);

impl TeamOwnedAgentId {
    pub(crate) fn try_new(value: impl Into<String>) -> Result<Self, TeamInputError> {
        let value = value.into();
        (!value.trim().is_empty())
            .then_some(Self(value))
            .ok_or(TeamInputError::Invalid)
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for TeamOwnedAgentId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TeamOwnedAgentId")
    }
}

pub(crate) struct TeamAgentCreate {
    pub(super) name: String,
    pub(super) workspace: ResolvedWorkspace,
}

impl TeamAgentCreate {
    pub(crate) fn try_new(
        name: impl Into<String>,
        workspace: ResolvedWorkspace,
    ) -> Result<Self, TeamInputError> {
        let name = name.into();
        (!name.trim().is_empty())
            .then_some(Self { name, workspace })
            .ok_or(TeamInputError::Invalid)
    }
}

impl fmt::Debug for TeamAgentCreate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TeamAgentCreate([REDACTED])")
    }
}

pub(crate) struct TeamAgentUpdate {
    pub(super) agent_id: TeamOwnedAgentId,
    pub(super) name: String,
    pub(super) workspace: ResolvedWorkspace,
    pub(super) model: Option<String>,
}

impl TeamAgentUpdate {
    pub(crate) fn try_new(
        agent_id: TeamOwnedAgentId,
        name: impl Into<String>,
        workspace: ResolvedWorkspace,
        model: Option<String>,
    ) -> Result<Self, TeamInputError> {
        let name = name.into();
        if name.trim().is_empty()
            || model
                .as_deref()
                .is_some_and(|model| model.trim().is_empty())
        {
            return Err(TeamInputError::Invalid);
        }
        Ok(Self {
            agent_id,
            name,
            workspace,
            model,
        })
    }
}

impl fmt::Debug for TeamAgentUpdate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TeamAgentUpdate([REDACTED])")
    }
}

pub(crate) struct TeamConfigSnapshot(pub(super) wire::team::ConfigSnapshot);

pub(crate) struct TeamConfigAgent {
    agent_id: String,
    name: String,
    workspace: ResolvedWorkspace,
}

impl TeamConfigAgent {
    pub(crate) fn new(
        agent_id: TeamOwnedAgentId,
        name: String,
        workspace: ResolvedWorkspace,
    ) -> Self {
        Self {
            agent_id: agent_id.0,
            name,
            workspace,
        }
    }

    pub(super) fn into_wire(self) -> wire::team::ConfigAgentPatch {
        wire::team::ConfigAgentPatch::new(self.agent_id, self.name, self.workspace.into_inner())
    }
}

impl fmt::Debug for TeamConfigAgent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TeamConfigAgent([REDACTED])")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TeamInputError {
    Invalid,
}
