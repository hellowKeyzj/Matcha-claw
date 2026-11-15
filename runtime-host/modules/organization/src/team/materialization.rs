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
/// selected-agent team. The definition and endpoint requests are recorded together.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamMaterialization {
    definition: TeamDefinition,
    requests: Vec<TeamMaterializationRequest>,
}

impl TeamMaterialization {
    pub fn definition(&self) -> &TeamDefinition {
        &self.definition
    }

    pub fn requests(&self) -> &[TeamMaterializationRequest] {
        &self.requests
    }

    pub fn with_source_agent(mut self, source: Option<ManagedAgentReference>) -> Self {
        for request in &mut self.requests {
            *request = TeamMaterializationRequest::new(
                request.intent().clone().with_source_agent(source.clone()),
                request.idempotency_key().clone(),
            );
        }
        self
    }

    pub(crate) fn with_leader_agents_markdown(
        mut self,
        markdown: impl Into<String>,
    ) -> Result<Self, TeamMaterializationError> {
        let request = self.requests.iter_mut().find(|request| {
            request.intent().agents().iter().any(|agent| agent.role().as_str() == LEADER_ROLE_ID)
        }).ok_or(TeamMaterializationError::Invalid)?;
        let intent = request.intent();
        if intent.source() != MaterializationSource::Manual {
            return Err(TeamMaterializationError::Invalid);
        }
        let markdown = markdown.into();
        let agents = intent
            .agents()
            .iter()
            .map(|agent| {
                if agent.role().as_str() == LEADER_ROLE_ID {
                    agent.clone().with_agents_markdown(markdown.clone())
                } else {
                    agent.clone()
                }
            })
            .collect();
        *request = TeamMaterializationRequest::new(
            TeamMaterializationIntent::try_new(
                intent.team().clone(),
                intent.endpoint().clone(),
                intent.source(),
                agents,
            )
            .map_err(|_| TeamMaterializationError::Invalid)?
            .with_source_agent(intent.source_agent().cloned()),
            request.idempotency_key().clone(),
        );
        Ok(self)
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
    endpoint: RuntimeEndpointReference,
    leader: bool,
    tools: Vec<String>,
}

impl ManualTeamRoleBinding {
    pub fn try_new(
        role: RoleId,
        member_name: impl Into<String>,
        agent: ManagedAgentReference,
        endpoint: RuntimeEndpointReference,
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
            endpoint,
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
        let agent = RoleAgentMaterialization::managed(role.clone(), package_role.id())
            .map_err(|_| TeamMaterializationError::Invalid)?
            .with_tools(package_role.tools().to_vec());
        agents.push(if runtime_directory::endpoint_from_reference(endpoint.as_str()).is_some_and(|endpoint| {
            endpoint.runtime_adapter_id() == runtime_directory::RuntimeDriverIdentity::matcha_agent().runtime_adapter_id()
        }) {
            agent.with_agents_markdown(package_role.agents_markdown()).with_skills(package_role.skills().to_vec())
        } else {
            agent
        });
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
        requests: vec![TeamMaterializationRequest::new(intent, idempotency_key)],
    })
}

/// Compiles selected existing agents into one request per endpoint without accepting
/// workspace paths. The integration resolves each selected agent's native workspace.
pub fn compile_manual_team_materialization(
    team_id: TeamId,
    team_name: impl Into<String>,
    roles: Vec<ManualTeamRoleBinding>,
    idempotency_key: IdempotencyKey,
) -> Result<TeamMaterialization, TeamMaterializationError> {
    if roles.is_empty() || roles.iter().filter(|role| role.leader).count() != 1 {
        return Err(TeamMaterializationError::Invalid);
    }
    let mut role_ids = BTreeSet::new();
    let mut agent_ids = BTreeSet::new();
    if roles.iter().any(|binding| {
        !role_ids.insert(binding.role.as_str())
            || !agent_ids.insert((binding.endpoint.as_str(), binding.agent.as_str()))
    }) {
        return Err(TeamMaterializationError::Invalid);
    }

    let mut members = Vec::with_capacity(roles.len());
    let mut team_roles = Vec::with_capacity(roles.len());
    let mut assignments = Vec::with_capacity(roles.len());
    let mut groups: Vec<(RuntimeEndpointReference, Vec<RoleAgentMaterialization>)> = Vec::new();
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
        let agent = RoleAgentMaterialization::external(binding.role, binding.agent)
            .with_tools(binding.tools);
        if let Some((_, agents)) = groups.iter_mut().find(|(endpoint, _)| endpoint == &binding.endpoint) {
            agents.push(agent);
        } else {
            groups.push((binding.endpoint, vec![agent]));
        }
        members.push(member);
        team_roles.push(team_role);
    }

    let definition =
        TeamDefinition::try_new(team_id.clone(), team_name, members, team_roles, assignments)
            .map_err(|_| TeamMaterializationError::Invalid)?;
    let grouped = groups.len() > 1;
    let requests = groups.into_iter().map(|(endpoint, agents)| {
        let key = if grouped {
            endpoint_idempotency_key(&idempotency_key, &endpoint)
        } else {
            idempotency_key.clone()
        };
        let intent = TeamMaterializationIntent::try_new(
            team_id.clone(), endpoint, MaterializationSource::Manual, agents,
        ).map_err(|_| TeamMaterializationError::Invalid)?;
        Ok(TeamMaterializationRequest::new(intent, key))
    }).collect::<Result<Vec<_>, TeamMaterializationError>>()?;
    Ok(TeamMaterialization { definition, requests })
}

pub(crate) fn endpoint_idempotency_key(
    key: &IdempotencyKey,
    endpoint: &RuntimeEndpointReference,
) -> IdempotencyKey {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    digest.update(b"team-materialization-endpoint-v1");
    for part in [key.as_str(), endpoint.as_str()] {
        digest.update((part.len() as u64).to_be_bytes());
        digest.update(part.as_bytes());
    }
    IdempotencyKey::try_new(format!("team-group:{:x}", digest.finalize()))
        .expect("a SHA-256 group key is a nonblank native-safe reference")
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
            materialization.requests()[0].intent().source(),
            MaterializationSource::TeamSkill
        );
        assert_eq!(materialization.requests()[0].intent().agents().len(), 3);
        assert_eq!(
            materialization.requests()[0].intent().agents()[1]
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
            vec![
                ManualTeamRoleBinding::try_new(
                    RoleId::try_new("leader").unwrap(),
                    "Lead",
                    ManagedAgentReference::try_new("existing-lead").unwrap(),
                    RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap(),
                    true,
                )
                .unwrap(),
                ManualTeamRoleBinding::try_new(
                    RoleId::try_new("reviewer").unwrap(),
                    "Reviewer",
                    ManagedAgentReference::try_new("existing-reviewer").unwrap(),
                    RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap(),
                    false,
                )
                .unwrap(),
            ],
            IdempotencyKey::try_new("materialize:manual").unwrap(),
        )
        .unwrap();

        assert_eq!(materialization.definition().roles().len(), 2);
        assert_eq!(
            materialization.requests()[0].intent().source(),
            MaterializationSource::Manual
        );
        assert!(
            materialization
                .requests()[0]
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
                RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap(),
                true,
            )
            .unwrap()
        };
        assert_eq!(
            compile_manual_team_materialization(
                TeamId::try_new("team:manual").unwrap(),
                "Selected Team",
                vec![],
                IdempotencyKey::try_new("materialize:manual").unwrap(),
            ),
            Err(TeamMaterializationError::Invalid)
        );
        assert_eq!(
            compile_manual_team_materialization(
                TeamId::try_new("team:manual").unwrap(),
                "Selected Team",
                vec![
                    leader(),
                    ManualTeamRoleBinding::try_new(
                        RoleId::try_new("reviewer").unwrap(),
                        "Reviewer",
                        ManagedAgentReference::try_new("existing-agent").unwrap(),
                        RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap(),
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
