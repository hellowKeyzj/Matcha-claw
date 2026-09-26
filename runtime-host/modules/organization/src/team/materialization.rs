use std::{collections::BTreeSet, fmt};

use crate::{
    IdempotencyKey, ManagedAgentReference, MaterializationSource, RoleAgentMaterialization,
    RuntimeEndpointReference, TeamMaterializationIntent, TeamMaterializationRequest,
    package::TeamSkillPackage,
};

use super::{
    LEADER_ROLE_ID, MemberId, RoleAssignment, RoleId, RoleKind, TeamDefinition, TeamId, TeamMember,
    TeamRole,
};

/// The closed Organization facts compiled from either authorized TeamSkill input or a Manual
/// selected-agent team. The definition and request are recorded together so they cannot diverge.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamMaterialization {
    definition: TeamDefinition,
    request: TeamMaterializationRequest,
}

impl TeamMaterialization {
    pub fn definition(&self) -> &TeamDefinition {
        &self.definition
    }

    pub fn request(&self) -> &TeamMaterializationRequest {
        &self.request
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamMaterializationError {
    Invalid,
}

impl fmt::Display for TeamMaterializationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("team materialization facts are invalid")
    }
}

impl std::error::Error for TeamMaterializationError {}

/// Closed selected-agent facts for one Manual Team role. Native workspaces are resolved only by
/// the runtime integration after it confirms the selected agent with its peer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManualTeamRoleBinding {
    role: RoleId,
    member_name: String,
    agent: ManagedAgentReference,
    leader: bool,
    tools: Vec<String>,
}

impl ManualTeamRoleBinding {
    pub fn try_new(
        role: RoleId,
        member_name: impl Into<String>,
        agent: ManagedAgentReference,
        leader: bool,
    ) -> Result<Self, TeamMaterializationError> {
        let member_name = member_name.into();
        if member_name.trim().is_empty() || leader != (role.as_str() == LEADER_ROLE_ID) {
            return Err(TeamMaterializationError::Invalid);
        }
        Ok(Self {
            role,
            member_name,
            agent,
            leader,
            tools: Vec::new(),
        })
    }

    pub fn with_tools(mut self, tools: Vec<String>) -> Self {
        self.tools = tools;
        self
    }
}

/// Compiles package-local role facts without exposing its root or contents beyond this owner.
pub fn compile_team_skill_materialization(
    package: &TeamSkillPackage,
    team_id: TeamId,
    endpoint: RuntimeEndpointReference,
    idempotency_key: IdempotencyKey,
) -> Result<TeamMaterialization, TeamMaterializationError> {
    let leader_role =
        RoleId::try_new(LEADER_ROLE_ID).map_err(|_| TeamMaterializationError::Invalid)?;
    let leader_member = TeamMember::try_new(
        MemberId::try_new("member:leader").map_err(|_| TeamMaterializationError::Invalid)?,
        "Leader",
    )
    .map_err(|_| TeamMaterializationError::Invalid)?;
    let leader = TeamRole::try_new(leader_role.clone(), "Leader", RoleKind::Leader)
        .map_err(|_| TeamMaterializationError::Invalid)?;

    let mut members = vec![leader_member.clone()];
    let mut roles = vec![leader.clone()];
    let mut assignments = vec![RoleAssignment::new(
        leader_member.member_id().clone(),
        leader_role.clone(),
    )];
    let mut agents = vec![
        RoleAgentMaterialization::managed(leader_role, "leader")
            .map_err(|_| TeamMaterializationError::Invalid)?,
    ];

    for package_role in package.roles() {
        let role = RoleId::try_new(package_role.id().to_owned())
            .map_err(|_| TeamMaterializationError::Invalid)?;
        let member = TeamMember::try_new(
            MemberId::try_new(format!("member:{}", package_role.id()))
                .map_err(|_| TeamMaterializationError::Invalid)?,
            package_role.purpose(),
        )
        .map_err(|_| TeamMaterializationError::Invalid)?;
        let team_role = TeamRole::try_new(role.clone(), package_role.purpose(), RoleKind::Member)
            .map_err(|_| TeamMaterializationError::Invalid)?;
        agents.push(
            RoleAgentMaterialization::managed(role.clone(), package_role.id())
                .map_err(|_| TeamMaterializationError::Invalid)?
                .with_tools(package_role.tools().to_vec()),
        );
        assignments.push(RoleAssignment::new(member.member_id().clone(), role));
        members.push(member);
        roles.push(team_role);
    }

    let definition =
        TeamDefinition::try_new(team_id.clone(), package.name(), members, roles, assignments)
            .map_err(|_| TeamMaterializationError::Invalid)?;
    let intent = TeamMaterializationIntent::try_new(
        team_id,
        endpoint,
        MaterializationSource::TeamSkill,
        agents,
    )
    .map_err(|_| TeamMaterializationError::Invalid)?;
    Ok(TeamMaterialization {
        definition,
        request: TeamMaterializationRequest::new(intent, idempotency_key),
    })
}

/// Compiles explicitly selected existing agents into a Manual Team request without accepting
/// workspace paths. The integration resolves each selected agent's native workspace.
pub fn compile_manual_team_materialization(
    team_id: TeamId,
    team_name: impl Into<String>,
    endpoint: RuntimeEndpointReference,
    roles: Vec<ManualTeamRoleBinding>,
    idempotency_key: IdempotencyKey,
) -> Result<TeamMaterialization, TeamMaterializationError> {
    if roles.is_empty() || roles.iter().filter(|role| role.leader).count() != 1 {
        return Err(TeamMaterializationError::Invalid);
    }
    let mut role_ids = BTreeSet::new();
    let mut agent_ids = BTreeSet::new();
    if roles.iter().any(|binding| {
        !role_ids.insert(binding.role.as_str()) || !agent_ids.insert(binding.agent.as_str())
    }) {
        return Err(TeamMaterializationError::Invalid);
    }

    let mut members = Vec::with_capacity(roles.len());
    let mut team_roles = Vec::with_capacity(roles.len());
    let mut assignments = Vec::with_capacity(roles.len());
    let mut agents = Vec::with_capacity(roles.len());
    for binding in roles {
        let member_id = MemberId::try_new(format!("member:{}", binding.role.as_str()))
            .map_err(|_| TeamMaterializationError::Invalid)?;
        let member = TeamMember::try_new(member_id, binding.member_name.clone())
            .map_err(|_| TeamMaterializationError::Invalid)?;
        let kind = if binding.leader {
            RoleKind::Leader
        } else {
            RoleKind::Member
        };
        let team_role = TeamRole::try_new(binding.role.clone(), binding.member_name, kind)
            .map_err(|_| TeamMaterializationError::Invalid)?;
        assignments.push(RoleAssignment::new(
            member.member_id().clone(),
            binding.role.clone(),
        ));
        agents.push(
            RoleAgentMaterialization::external(binding.role, binding.agent)
                .with_tools(binding.tools),
        );
        members.push(member);
        team_roles.push(team_role);
    }

    let definition =
        TeamDefinition::try_new(team_id.clone(), team_name, members, team_roles, assignments)
            .map_err(|_| TeamMaterializationError::Invalid)?;
    let intent = TeamMaterializationIntent::try_new(
        team_id,
        endpoint,
        MaterializationSource::Manual,
        agents,
    )
    .map_err(|_| TeamMaterializationError::Invalid)?;
    Ok(TeamMaterialization {
        definition,
        request: TeamMaterializationRequest::new(intent, idempotency_key),
    })
}

#[cfg(test)]
mod tests {
    use crate::{IdempotencyKey, ManagedAgentReference, PackageRole, RuntimeEndpointReference};

    use super::*;

    fn package() -> TeamSkillPackage {
        TeamSkillPackage::try_new(crate::TeamSkillPackageInput {
            name: "Research Team".to_owned(),
            version: "1.0.0".to_owned(),
            description: "Research".to_owned(),
            skill_markdown: "private skill content".to_owned(),
            workflow_markdown: "private workflow content".to_owned(),
            bind_markdown: None,
            roles: vec![
                PackageRole::try_new("researcher", "Researcher", vec![], vec![], "private role")
                    .unwrap(),
                PackageRole::try_new("reviewer", "Reviewer", vec![], vec![], "private role")
                    .unwrap(),
            ],
            dependencies: vec![],
        })
        .unwrap()
    }
    #[test]
    fn package_compilation_creates_closed_team_and_managed_role_intents() {
        let materialization = compile_team_skill_materialization(
            &package(),
            TeamId::try_new("team:research").unwrap(),
            RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap(),
            IdempotencyKey::try_new("materialize:research").unwrap(),
        )
        .unwrap();

        assert_eq!(materialization.definition().name(), "Research Team");
        assert_eq!(materialization.definition().members().len(), 3);
        assert_eq!(materialization.definition().roles().len(), 3);
        assert_eq!(
            materialization.request().intent().source(),
            MaterializationSource::TeamSkill
        );
        assert_eq!(materialization.request().intent().agents().len(), 3);
        assert_eq!(
            materialization.request().intent().agents()[1]
                .role()
                .as_str(),
            "researcher"
        );
    }

    #[test]
    fn manual_compilation_keeps_native_workspace_private_and_closes_selected_agents() {
        let materialization = compile_manual_team_materialization(
            TeamId::try_new("team:manual").unwrap(),
            "Selected Team",
            RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap(),
            vec![
                ManualTeamRoleBinding::try_new(
                    RoleId::try_new("leader").unwrap(),
                    "Lead",
                    ManagedAgentReference::try_new("existing-lead").unwrap(),
                    true,
                )
                .unwrap(),
                ManualTeamRoleBinding::try_new(
                    RoleId::try_new("reviewer").unwrap(),
                    "Reviewer",
                    ManagedAgentReference::try_new("existing-reviewer").unwrap(),
                    false,
                )
                .unwrap(),
            ],
            IdempotencyKey::try_new("materialize:manual").unwrap(),
        )
        .unwrap();

        assert_eq!(materialization.definition().roles().len(), 2);
        assert_eq!(
            materialization.request().intent().source(),
            MaterializationSource::Manual
        );
        assert!(
            materialization
                .request()
                .intent()
                .agents()
                .iter()
                .all(|role| matches!(
                    role.agent(),
                    crate::RoleMaterializationAgent::External { .. }
                ))
        );
        assert!(!format!("{materialization:?}").contains("private-workspace-canary"));
    }

    #[test]
    fn manual_compilation_requires_exactly_one_leader_and_distinct_agents() {
        let leader = || {
            ManualTeamRoleBinding::try_new(
                RoleId::try_new("leader").unwrap(),
                "Lead",
                ManagedAgentReference::try_new("existing-agent").unwrap(),
                true,
            )
            .unwrap()
        };
        assert_eq!(
            compile_manual_team_materialization(
                TeamId::try_new("team:manual").unwrap(),
                "Selected Team",
                RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap(),
                vec![],
                IdempotencyKey::try_new("materialize:manual").unwrap(),
            ),
            Err(TeamMaterializationError::Invalid)
        );
        assert_eq!(
            compile_manual_team_materialization(
                TeamId::try_new("team:manual").unwrap(),
                "Selected Team",
                RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap(),
                vec![
                    leader(),
                    ManualTeamRoleBinding::try_new(
                        RoleId::try_new("reviewer").unwrap(),
                        "Reviewer",
                        ManagedAgentReference::try_new("existing-agent").unwrap(),
                        false,
                    )
                    .unwrap(),
                ],
                IdempotencyKey::try_new("materialize:manual:duplicate").unwrap(),
            ),
            Err(TeamMaterializationError::Invalid)
        );
    }
}
