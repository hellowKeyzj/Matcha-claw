use std::fmt;

use super::agent::{TeamAgent, TeamAgentId, TeamInputError};
use super::workspace::ResolvedWorkspace;

#[derive(Clone, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) struct TeamRecoveryTeamId(String);

impl TeamRecoveryTeamId {
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for TeamRecoveryTeamId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TeamRecoveryTeamId")
    }
}

#[derive(Clone, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) struct TeamRecoveryRoleId(String);

impl TeamRecoveryRoleId {
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for TeamRecoveryRoleId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TeamRecoveryRoleId")
    }
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct TeamRecoveryRole {
    role: TeamRecoveryRoleId,
    agent: TeamAgentId,
}

impl TeamRecoveryRole {
    pub(crate) fn try_new(
        role: impl Into<String>,
        agent: impl Into<String>,
    ) -> Result<Self, TeamInputError> {
        let role = role.into();
        let agent = agent.into();
        if role.trim().is_empty() || agent.trim().is_empty() {
            return Err(TeamInputError::Invalid);
        }
        Ok(Self {
            role: TeamRecoveryRoleId(role),
            agent: TeamAgentId::new(agent),
        })
    }
}

impl fmt::Debug for TeamRecoveryRole {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TeamRecoveryRole")
    }
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct TeamRecoveryRequest {
    team: TeamRecoveryTeamId,
    roles: Vec<TeamRecoveryRole>,
}

impl TeamRecoveryRequest {
    pub(crate) fn try_new(
        team: impl Into<String>,
        roles: Vec<TeamRecoveryRole>,
    ) -> Result<Self, TeamInputError> {
        let team = team.into();
        if team.trim().is_empty() || roles.is_empty() {
            return Err(TeamInputError::Invalid);
        }
        let mut role_ids = std::collections::BTreeSet::new();
        let mut agent_ids = std::collections::BTreeSet::new();
        if roles.iter().any(|role| {
            !role_ids.insert(role.role.as_str()) || !agent_ids.insert(role.agent.as_str())
        }) {
            return Err(TeamInputError::Invalid);
        }
        Ok(Self {
            team: TeamRecoveryTeamId(team),
            roles,
        })
    }
}

impl fmt::Debug for TeamRecoveryRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TeamRecoveryRequest")
    }
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct RecoveredTeamRole {
    role: TeamRecoveryRoleId,
    agent: TeamAgentId,
    workspace: ResolvedWorkspace,
}

impl RecoveredTeamRole {
    pub(crate) fn role(&self) -> &TeamRecoveryRoleId {
        &self.role
    }

    pub(crate) fn agent(&self) -> &TeamAgentId {
        &self.agent
    }

    pub(crate) fn workspace(&self) -> &ResolvedWorkspace {
        &self.workspace
    }
}

impl fmt::Debug for RecoveredTeamRole {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RecoveredTeamRole")
    }
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct RecoveredTeamFacts {
    team: TeamRecoveryTeamId,
    roles: Vec<RecoveredTeamRole>,
}

impl RecoveredTeamFacts {
    pub(crate) fn team(&self) -> &TeamRecoveryTeamId {
        &self.team
    }

    pub(crate) fn roles(&self) -> &[RecoveredTeamRole] {
        &self.roles
    }
}

impl fmt::Debug for RecoveredTeamFacts {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RecoveredTeamFacts")
    }
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) enum TeamRecoveryOutcome {
    Recovered(RecoveredTeamFacts),
    Unknown,
}

impl fmt::Debug for TeamRecoveryOutcome {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Recovered(_) => formatter.write_str("TeamRecoveryOutcome::Recovered"),
            Self::Unknown => formatter.write_str("TeamRecoveryOutcome::Unknown"),
        }
    }
}

pub(crate) fn recover_agents(
    agents: &[TeamAgent],
    request: TeamRecoveryRequest,
) -> TeamRecoveryOutcome {
    let mut agent_ids = std::collections::BTreeSet::new();
    let mut workspaces = std::collections::BTreeSet::new();
    for agent in agents {
        let Some(workspace) = agent.workspace() else {
            return TeamRecoveryOutcome::Unknown;
        };
        if !agent_ids.insert(agent.id().as_str()) || !workspaces.insert(workspace.as_str()) {
            return TeamRecoveryOutcome::Unknown;
        }
    }

    let mut recovered_roles = Vec::with_capacity(request.roles.len());
    for requested in request.roles {
        let mut matching = agents.iter().filter(|agent| agent.id() == &requested.agent);
        let Some(agent) = matching.next() else {
            return TeamRecoveryOutcome::Unknown;
        };
        if matching.next().is_some() {
            return TeamRecoveryOutcome::Unknown;
        }
        let Some(workspace) = agent.workspace().cloned() else {
            return TeamRecoveryOutcome::Unknown;
        };
        recovered_roles.push(RecoveredTeamRole {
            role: requested.role,
            agent: requested.agent,
            workspace,
        });
    }
    TeamRecoveryOutcome::Recovered(RecoveredTeamFacts {
        team: request.team,
        roles: recovered_roles,
    })
}
