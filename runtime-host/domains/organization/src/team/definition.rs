use std::fmt;

use super::{
    member::{MemberId, TeamMember},
    role::{RoleAssignment, RoleId, RoleKind, TeamRole},
};

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct TeamId(String);

impl TeamId {
    /// Creates an Organization Team identity.
    ///
    /// # Errors
    ///
    /// Returns [`InvalidTeamId`] when `value` is empty or contains only whitespace.
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidTeamId> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(InvalidTeamId);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidTeamId;

impl fmt::Display for InvalidTeamId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("team ID must not be empty")
    }
}

impl std::error::Error for InvalidTeamId {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamDefinition {
    team_id: TeamId,
    name: String,
    members: Vec<TeamMember>,
    roles: Vec<TeamRole>,
    assignments: Vec<RoleAssignment>,
}

impl TeamDefinition {
    /// Creates a reusable Organization Team definition.
    ///
    /// # Errors
    ///
    /// Returns [`InvalidTeamDefinition`] when the Team relationship graph is invalid.
    pub fn try_new(
        team_id: TeamId,
        name: impl Into<String>,
        members: Vec<TeamMember>,
        roles: Vec<TeamRole>,
        assignments: Vec<RoleAssignment>,
    ) -> Result<Self, InvalidTeamDefinition> {
        let name = name.into();
        if name.trim().is_empty() {
            return Err(InvalidTeamDefinition::EmptyName);
        }
        if members.is_empty() {
            return Err(InvalidTeamDefinition::MissingMembers);
        }
        if duplicate_member_id(&members) {
            return Err(InvalidTeamDefinition::DuplicateMember);
        }
        if duplicate_role_id(&roles) {
            return Err(InvalidTeamDefinition::DuplicateRole);
        }
        if roles
            .iter()
            .filter(|role| role.kind() == RoleKind::Leader)
            .count()
            != 1
        {
            return Err(InvalidTeamDefinition::LeaderRoleCount);
        }
        if roles.len() != members.len() {
            return Err(InvalidTeamDefinition::MemberRoleCount);
        }
        if assignments.len() != members.len() {
            return Err(InvalidTeamDefinition::MemberAssignmentCount);
        }
        if duplicate_assignment_member_id(&assignments) {
            return Err(InvalidTeamDefinition::DuplicateMemberAssignment);
        }
        if duplicate_assignment_role_id(&assignments) {
            return Err(InvalidTeamDefinition::DuplicateRoleAssignment);
        }
        if assignments
            .iter()
            .any(|assignment| !contains_member(&members, assignment.member_id()))
        {
            return Err(InvalidTeamDefinition::UnknownAssignedMember);
        }
        if assignments
            .iter()
            .any(|assignment| !contains_role(&roles, assignment.role_id()))
        {
            return Err(InvalidTeamDefinition::UnknownAssignedRole);
        }

        Ok(Self {
            team_id,
            name,
            members,
            roles,
            assignments,
        })
    }

    pub fn team_id(&self) -> &TeamId {
        &self.team_id
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn members(&self) -> &[TeamMember] {
        &self.members
    }

    pub fn roles(&self) -> &[TeamRole] {
        &self.roles
    }

    pub fn assignments(&self) -> &[RoleAssignment] {
        &self.assignments
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidTeamDefinition {
    EmptyName,
    MissingMembers,
    DuplicateMember,
    DuplicateRole,
    LeaderRoleCount,
    MemberRoleCount,
    MemberAssignmentCount,
    DuplicateMemberAssignment,
    DuplicateRoleAssignment,
    UnknownAssignedMember,
    UnknownAssignedRole,
}

impl fmt::Display for InvalidTeamDefinition {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyName => formatter.write_str("team name must not be empty"),
            Self::MissingMembers => formatter.write_str("team must contain at least one member"),
            Self::DuplicateMember => formatter.write_str("team contains a duplicate member"),
            Self::DuplicateRole => formatter.write_str("team contains a duplicate role"),
            Self::LeaderRoleCount => {
                formatter.write_str("team must contain exactly one leader role")
            }
            Self::MemberRoleCount => formatter.write_str("every team member must have one role"),
            Self::MemberAssignmentCount => {
                formatter.write_str("every team member must have one role assignment")
            }
            Self::DuplicateMemberAssignment => {
                formatter.write_str("team contains a duplicate member assignment")
            }
            Self::DuplicateRoleAssignment => {
                formatter.write_str("team contains a duplicate role assignment")
            }
            Self::UnknownAssignedMember => {
                formatter.write_str("team assignment references an unknown member")
            }
            Self::UnknownAssignedRole => {
                formatter.write_str("team assignment references an unknown role")
            }
        }
    }
}

impl std::error::Error for InvalidTeamDefinition {}

fn duplicate_member_id(members: &[TeamMember]) -> bool {
    members.iter().enumerate().any(|(index, member)| {
        members[..index]
            .iter()
            .any(|other| other.member_id() == member.member_id())
    })
}

fn duplicate_role_id(roles: &[TeamRole]) -> bool {
    roles.iter().enumerate().any(|(index, role)| {
        roles[..index]
            .iter()
            .any(|other| other.role_id() == role.role_id())
    })
}

fn duplicate_assignment_member_id(assignments: &[RoleAssignment]) -> bool {
    assignments.iter().enumerate().any(|(index, assignment)| {
        assignments[..index]
            .iter()
            .any(|other| other.member_id() == assignment.member_id())
    })
}

fn duplicate_assignment_role_id(assignments: &[RoleAssignment]) -> bool {
    assignments.iter().enumerate().any(|(index, assignment)| {
        assignments[..index]
            .iter()
            .any(|other| other.role_id() == assignment.role_id())
    })
}

fn contains_member(members: &[TeamMember], member_id: &MemberId) -> bool {
    members.iter().any(|member| member.member_id() == member_id)
}

fn contains_role(roles: &[TeamRole], role_id: &RoleId) -> bool {
    roles.iter().any(|role| role.role_id() == role_id)
}

#[cfg(test)]
mod tests {
    use super::super::role::LEADER_ROLE_ID;
    use super::*;

    fn member(id: &str, name: &str) -> TeamMember {
        TeamMember::try_new(MemberId::try_new(id).unwrap(), name).unwrap()
    }

    fn role(id: &str, name: &str, kind: RoleKind) -> TeamRole {
        TeamRole::try_new(RoleId::try_new(id).unwrap(), name, kind).unwrap()
    }

    fn valid_definition() -> TeamDefinition {
        let leader = member("member:coordinator", "Coordinator");
        let researcher = member("member:researcher", "Researcher");
        let leader_role = role(LEADER_ROLE_ID, "Coordinator", RoleKind::Leader);
        let researcher_role = role("researcher", "Researcher", RoleKind::Member);
        TeamDefinition::try_new(
            TeamId::try_new("team:research").unwrap(),
            "Research Team",
            vec![leader.clone(), researcher.clone()],
            vec![leader_role.clone(), researcher_role.clone()],
            vec![
                RoleAssignment::new(leader.member_id().clone(), leader_role.role_id().clone()),
                RoleAssignment::new(
                    researcher.member_id().clone(),
                    researcher_role.role_id().clone(),
                ),
            ],
        )
        .unwrap()
    }

    #[test]
    fn definition_preserves_reusable_team_members_roles_and_assignments() {
        let definition = valid_definition();

        assert_eq!(definition.team_id().as_str(), "team:research");
        assert_eq!(definition.name(), "Research Team");
        assert_eq!(definition.members().len(), 2);
        assert_eq!(definition.roles().len(), 2);
        assert_eq!(definition.assignments().len(), 2);
        assert_eq!(definition.roles()[0].kind(), RoleKind::Leader);
    }

    #[test]
    fn definition_rejects_missing_or_duplicate_team_relationships() {
        let leader = member("member:coordinator", "Coordinator");
        let leader_role = role(LEADER_ROLE_ID, "Coordinator", RoleKind::Leader);
        let empty = TeamDefinition::try_new(
            TeamId::try_new("team:research").unwrap(),
            "Research Team",
            Vec::new(),
            vec![leader_role.clone()],
            Vec::new(),
        )
        .unwrap_err();
        let duplicate = TeamDefinition::try_new(
            TeamId::try_new("team:research").unwrap(),
            "Research Team",
            vec![leader.clone(), leader.clone()],
            vec![leader_role.clone()],
            vec![RoleAssignment::new(
                leader.member_id().clone(),
                leader_role.role_id().clone(),
            )],
        )
        .unwrap_err();

        assert_eq!(empty, InvalidTeamDefinition::MissingMembers);
        assert_eq!(duplicate, InvalidTeamDefinition::DuplicateMember);
    }

    #[test]
    fn definition_requires_exactly_one_leader_and_one_known_role_for_every_member() {
        let leader = member("member:coordinator", "Coordinator");
        let researcher = member("member:researcher", "Researcher");
        let leader_role = role(LEADER_ROLE_ID, "Coordinator", RoleKind::Leader);
        let researcher_role = role("researcher", "Researcher", RoleKind::Member);
        let missing_leader = TeamDefinition::try_new(
            TeamId::try_new("team:research").unwrap(),
            "Research Team",
            vec![leader.clone()],
            vec![role("researcher", "Researcher", RoleKind::Member)],
            vec![RoleAssignment::new(
                leader.member_id().clone(),
                RoleId::try_new("researcher").unwrap(),
            )],
        )
        .unwrap_err();
        let unassigned_role = TeamDefinition::try_new(
            TeamId::try_new("team:research").unwrap(),
            "Research Team",
            vec![leader.clone()],
            vec![leader_role.clone(), researcher_role.clone()],
            vec![RoleAssignment::new(
                leader.member_id().clone(),
                leader_role.role_id().clone(),
            )],
        )
        .unwrap_err();
        let missing_assignment = TeamDefinition::try_new(
            TeamId::try_new("team:research").unwrap(),
            "Research Team",
            vec![leader.clone(), researcher.clone()],
            vec![leader_role.clone(), researcher_role.clone()],
            vec![RoleAssignment::new(
                leader.member_id().clone(),
                leader_role.role_id().clone(),
            )],
        )
        .unwrap_err();
        let unknown_role = TeamDefinition::try_new(
            TeamId::try_new("team:research").unwrap(),
            "Research Team",
            vec![leader.clone(), researcher.clone()],
            vec![leader_role.clone(), researcher_role],
            vec![
                RoleAssignment::new(leader.member_id().clone(), leader_role.role_id().clone()),
                RoleAssignment::new(
                    researcher.member_id().clone(),
                    RoleId::try_new("writer").unwrap(),
                ),
            ],
        )
        .unwrap_err();

        assert_eq!(missing_leader, InvalidTeamDefinition::LeaderRoleCount);
        assert_eq!(unassigned_role, InvalidTeamDefinition::MemberRoleCount);
        assert_eq!(
            missing_assignment,
            InvalidTeamDefinition::MemberAssignmentCount
        );
        assert_eq!(unknown_role, InvalidTeamDefinition::UnknownAssignedRole);
    }

    #[test]
    fn manual_team_source_oracle_keeps_the_leader_assignment_unique_and_closed() {
        let leader = member("member:coordinator", "Coordinator");
        let researcher = member("member:researcher", "Researcher");
        let leader_role = role(LEADER_ROLE_ID, "Coordinator", RoleKind::Leader);
        let researcher_role = role("researcher", "Researcher", RoleKind::Member);
        let definition = TeamDefinition::try_new(
            TeamId::try_new("team:research").unwrap(),
            "Research Team",
            vec![leader.clone(), researcher.clone()],
            vec![leader_role.clone(), researcher_role.clone()],
            vec![
                RoleAssignment::new(leader.member_id().clone(), leader_role.role_id().clone()),
                RoleAssignment::new(
                    researcher.member_id().clone(),
                    researcher_role.role_id().clone(),
                ),
            ],
        )
        .unwrap();
        let duplicate_leader_assignment = TeamDefinition::try_new(
            TeamId::try_new("team:research").unwrap(),
            "Research Team",
            vec![leader.clone(), researcher.clone()],
            vec![leader_role.clone(), researcher_role],
            vec![
                RoleAssignment::new(leader.member_id().clone(), leader_role.role_id().clone()),
                RoleAssignment::new(
                    researcher.member_id().clone(),
                    leader_role.role_id().clone(),
                ),
            ],
        )
        .unwrap_err();

        let leader_assignment = definition
            .assignments()
            .iter()
            .find(|assignment| assignment.role_id() == leader_role.role_id())
            .unwrap();
        assert_eq!(leader_assignment.member_id(), leader.member_id());
        assert_eq!(
            duplicate_leader_assignment,
            InvalidTeamDefinition::DuplicateRoleAssignment
        );
    }

    #[test]
    fn identifiers_and_names_reject_blank_values_without_exposing_input() {
        let id_error = TeamId::try_new(" \t\n").unwrap_err();
        let name_error = TeamDefinition::try_new(
            TeamId::try_new("team:research").unwrap(),
            "\u{2003}",
            Vec::new(),
            Vec::new(),
            Vec::new(),
        )
        .unwrap_err();

        assert_eq!(id_error, InvalidTeamId);
        assert_eq!(id_error.to_string(), "team ID must not be empty");
        assert_eq!(name_error, InvalidTeamDefinition::EmptyName);
        assert_eq!(name_error.to_string(), "team name must not be empty");
    }
}
