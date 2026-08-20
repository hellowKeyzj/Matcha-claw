use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    path::{Component, Path, PathBuf},
};

use organization::{RoleId, TeamId, TeamMaterializationRemoval, TeamMaterializationRequest};

use super::agent::{TeamAgent, TeamInputError, TeamOwnedAgentId};

pub(crate) struct TeamExternalWorkspaces {
    workspaces: BTreeMap<TeamOwnedAgentId, ResolvedWorkspace>,
}

impl TeamExternalWorkspaces {
    pub(crate) fn for_agents(
        agents: &[TeamAgent],
        requested: Vec<TeamOwnedAgentId>,
    ) -> Result<Self, TeamInputError> {
        let mut requested_ids = BTreeSet::new();
        if requested
            .iter()
            .any(|agent| !requested_ids.insert(agent.as_str()))
        {
            return Err(TeamInputError::Invalid);
        }

        let mut resolved = BTreeMap::new();
        let mut workspaces = BTreeSet::<String>::new();
        for agent_id in requested {
            let mut matches = agents
                .iter()
                .filter(|agent| agent.id().as_str() == agent_id.as_str());
            let Some(agent) = matches.next() else {
                return Err(TeamInputError::Invalid);
            };
            if matches.next().is_some() {
                return Err(TeamInputError::Invalid);
            }
            let Some(workspace) = agent.workspace().cloned() else {
                return Err(TeamInputError::Invalid);
            };
            if !workspaces.insert(workspace.as_str().to_owned()) {
                return Err(TeamInputError::Invalid);
            }
            resolved.insert(agent_id, workspace);
        }
        Ok(Self {
            workspaces: resolved,
        })
    }

    pub(crate) fn resolve(&self, agent: &TeamOwnedAgentId) -> Option<ResolvedWorkspace> {
        self.workspaces.get(agent).cloned()
    }
}

impl fmt::Debug for TeamExternalWorkspaces {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TeamExternalWorkspaces([REDACTED])")
    }
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct ResolvedWorkspace(String);

impl ResolvedWorkspace {
    pub(crate) fn try_new(value: impl Into<String>) -> Result<Self, TeamInputError> {
        let value = value.into();
        (!value.trim().is_empty())
            .then_some(Self(value))
            .ok_or(TeamInputError::Invalid)
    }

    pub(super) fn into_inner(self) -> String {
        self.0
    }

    pub(super) fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ResolvedWorkspace {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ResolvedWorkspace([REDACTED])")
    }
}

pub(crate) struct TeamWorkspaceProjection {
    workspaces: BTreeMap<String, ResolvedWorkspace>,
}

impl TeamWorkspaceProjection {
    pub(crate) fn for_request(
        state_dir: &Path,
        request: &TeamMaterializationRequest,
    ) -> Result<Self, TeamInputError> {
        Self::from_roles(
            state_dir,
            request.intent().team(),
            request.intent().agents().iter().filter_map(|role| {
                matches!(
                    role.agent(),
                    organization::RoleMaterializationAgent::Managed { .. }
                )
                .then_some(role.role())
            }),
        )
    }

    pub(crate) fn for_removal(
        state_dir: &Path,
        removal: &TeamMaterializationRemoval,
    ) -> Result<Self, TeamInputError> {
        Self::from_roles(
            state_dir,
            removal.receipt().team(),
            removal
                .receipt()
                .roles()
                .iter()
                .filter(|role| {
                    role.ownership() == organization::RoleMaterializationOwnership::Managed
                })
                .map(|role| role.role()),
        )
    }

    fn from_roles<'a>(
        state_dir: &Path,
        team: &TeamId,
        roles: impl Iterator<Item = &'a RoleId>,
    ) -> Result<Self, TeamInputError> {
        let state_dir = normalize_absolute_path(state_dir)?;
        let root = state_dir
            .join("teambuddy")
            .join(team_workspace_segment(team));
        let mut projected = BTreeMap::new();
        let mut workspaces = BTreeSet::new();
        for role in roles {
            let workspace = root.join(role_workspace_segment(role));
            if projected
                .insert(
                    role.as_str().to_owned(),
                    ResolvedWorkspace::try_new(path_to_utf8(workspace)?)?,
                )
                .is_some()
                || !workspaces.insert(role.as_str())
            {
                return Err(TeamInputError::Invalid);
            }
        }
        Ok(Self {
            workspaces: projected,
        })
    }

    pub(crate) fn resolve(&self, role: &RoleId) -> Option<ResolvedWorkspace> {
        self.workspaces.get(role.as_str()).cloned()
    }
}

impl fmt::Debug for TeamWorkspaceProjection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TeamWorkspaceProjection([REDACTED])")
    }
}

fn normalize_absolute_path(path: &Path) -> Result<PathBuf, TeamInputError> {
    if !path.is_absolute() {
        return Err(TeamInputError::Invalid);
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::Normal(component) => normalized.push(component),
            Component::CurDir | Component::ParentDir => return Err(TeamInputError::Invalid),
        }
    }
    (!normalized.as_os_str().is_empty())
        .then_some(normalized)
        .ok_or(TeamInputError::Invalid)
}

fn path_to_utf8(path: PathBuf) -> Result<String, TeamInputError> {
    path.into_os_string()
        .into_string()
        .map_err(|_| TeamInputError::Invalid)
}

fn team_workspace_segment(team: &TeamId) -> String {
    stable_workspace_segment("team", team.as_str())
}

fn role_workspace_segment(role: &RoleId) -> String {
    stable_workspace_segment("role", role.as_str())
}

fn stable_workspace_segment(prefix: &str, value: &str) -> String {
    const OFFSET_BASIS: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x100000001b3;

    let hash = value.as_bytes().iter().fold(OFFSET_BASIS, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(PRIME)
    });
    format!("{prefix}-{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use organization::{
        IdempotencyKey, MaterializationSource, RoleAgentMaterialization, RuntimeEndpointReference,
        TeamMaterializationIntent,
    };

    #[test]
    fn private_projection_scopes_stable_team_and_role_ids_without_path_leaks() {
        let root = std::env::temp_dir().join("matchaclaw-team-private-projection");
        let team = TeamId::try_new("team:one").unwrap();
        let role = RoleId::try_new("reviewer").unwrap();
        let request = TeamMaterializationRequest::new(
            TeamMaterializationIntent::try_new(
                team.clone(),
                RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap(),
                MaterializationSource::TeamSkill,
                vec![RoleAgentMaterialization::managed(role.clone(), "reviewer").unwrap()],
            )
            .unwrap(),
            IdempotencyKey::try_new("materialize:one").unwrap(),
        );
        let projection = TeamWorkspaceProjection::for_request(&root, &request).unwrap();
        let workspace = projection.resolve(&role).unwrap();

        assert!(workspace.as_str().contains("teambuddy"));
        assert!(!workspace.as_str().contains("team:one"));
        assert!(!workspace.as_str().contains("reviewer"));
        assert!(!format!("{projection:?}").contains("matchaclaw-team-private-projection"));
        assert!(!format!("{workspace:?}").contains("matchaclaw-team-private-projection"));
    }
}
