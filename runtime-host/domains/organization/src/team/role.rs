use std::fmt;

use super::member::MemberId;

pub const LEADER_ROLE_ID: &str = "leader";

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct RoleId(String);

impl RoleId {
    /// Creates an Organization Team role identity.
    ///
    /// # Errors
    ///
    /// Returns [`InvalidRoleId`] when `value` is empty or contains only whitespace.
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidRoleId> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(InvalidRoleId);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidRoleId;

impl fmt::Display for InvalidRoleId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("role ID must not be empty")
    }
}

impl std::error::Error for InvalidRoleId {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RoleKind {
    Leader,
    Member,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamRole {
    role_id: RoleId,
    name: String,
    kind: RoleKind,
}

impl TeamRole {
    /// Creates a reusable Team role without binding it to a Runtime agent.
    ///
    /// # Errors
    ///
    /// Returns [`InvalidTeamRole`] when `name` is empty or the leader identity
    /// does not agree with `kind`.
    pub fn try_new(
        role_id: RoleId,
        name: impl Into<String>,
        kind: RoleKind,
    ) -> Result<Self, InvalidTeamRole> {
        let name = name.into();
        if name.trim().is_empty() {
            return Err(InvalidTeamRole::EmptyName);
        }
        match (role_id.as_str() == LEADER_ROLE_ID, kind) {
            (true, RoleKind::Member) => return Err(InvalidTeamRole::LeaderRoleIdReserved),
            (false, RoleKind::Leader) => return Err(InvalidTeamRole::LeaderRoleIdRequired),
            _ => {}
        }
        Ok(Self {
            role_id,
            name,
            kind,
        })
    }

    pub fn role_id(&self) -> &RoleId {
        &self.role_id
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn kind(&self) -> RoleKind {
        self.kind
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidTeamRole {
    EmptyName,
    LeaderRoleIdRequired,
    LeaderRoleIdReserved,
}

impl fmt::Display for InvalidTeamRole {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyName => formatter.write_str("team role name must not be empty"),
            Self::LeaderRoleIdRequired => {
                formatter.write_str("leader role must use the reserved leader ID")
            }
            Self::LeaderRoleIdReserved => {
                formatter.write_str("the reserved leader ID requires a leader role")
            }
        }
    }
}

impl std::error::Error for InvalidTeamRole {}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct RoleAssignment {
    member_id: MemberId,
    role_id: RoleId,
}

impl RoleAssignment {
    pub fn new(member_id: MemberId, role_id: RoleId) -> Self {
        Self { member_id, role_id }
    }

    pub fn member_id(&self) -> &MemberId {
        &self.member_id
    }

    pub fn role_id(&self) -> &RoleId {
        &self.role_id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_and_assignments_describe_organization_relationships_without_runtime_binding() {
        let leader = TeamRole::try_new(
            RoleId::try_new(LEADER_ROLE_ID).unwrap(),
            "Coordinator",
            RoleKind::Leader,
        )
        .unwrap();
        let assignment = RoleAssignment::new(
            MemberId::try_new("member:coordinator").unwrap(),
            leader.role_id().clone(),
        );

        assert_eq!(leader.role_id().as_str(), LEADER_ROLE_ID);
        assert_eq!(leader.name(), "Coordinator");
        assert_eq!(leader.kind(), RoleKind::Leader);
        assert_eq!(assignment.member_id().as_str(), "member:coordinator");
        assert_eq!(assignment.role_id(), leader.role_id());
    }

    #[test]
    fn roles_reject_invalid_names_and_leader_identity_mismatches_without_exposing_input() {
        let empty_id = RoleId::try_new(" \t\n").unwrap_err();
        let empty_name = TeamRole::try_new(
            RoleId::try_new("researcher").unwrap(),
            "\u{2003}",
            RoleKind::Member,
        )
        .unwrap_err();
        let leader_identity = TeamRole::try_new(
            RoleId::try_new("researcher").unwrap(),
            "Researcher",
            RoleKind::Leader,
        )
        .unwrap_err();
        let reserved_identity = TeamRole::try_new(
            RoleId::try_new(LEADER_ROLE_ID).unwrap(),
            "Coordinator",
            RoleKind::Member,
        )
        .unwrap_err();

        assert_eq!(empty_id, InvalidRoleId);
        assert_eq!(empty_id.to_string(), "role ID must not be empty");
        assert_eq!(empty_name, InvalidTeamRole::EmptyName);
        assert_eq!(empty_name.to_string(), "team role name must not be empty");
        assert_eq!(leader_identity, InvalidTeamRole::LeaderRoleIdRequired);
        assert_eq!(reserved_identity, InvalidTeamRole::LeaderRoleIdReserved);
    }
}
