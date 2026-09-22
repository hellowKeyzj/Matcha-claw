use std::fmt;

use super::{
    definition::{TeamDefinition, TeamId},
    event::TeamRevision,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TeamCommand {
    Create(CreateTeam),
    Replace(ReplaceTeam),
    Remove(RemoveTeam),
}

impl TeamCommand {
    pub fn team_id(&self) -> &TeamId {
        match self {
            Self::Create(command) => command.definition().team_id(),
            Self::Replace(command) => command.team_id(),
            Self::Remove(command) => command.team_id(),
        }
    }

    pub fn expected_revision(&self) -> Option<TeamRevision> {
        match self {
            Self::Create(_) => None,
            Self::Replace(command) => Some(command.expected_revision()),
            Self::Remove(command) => Some(command.expected_revision()),
        }
    }

    pub fn definition(&self) -> Option<&TeamDefinition> {
        match self {
            Self::Create(command) => Some(command.definition()),
            Self::Replace(command) => Some(command.definition()),
            Self::Remove(_) => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreateTeam {
    definition: TeamDefinition,
}

impl CreateTeam {
    pub fn new(definition: TeamDefinition) -> Self {
        Self { definition }
    }

    pub fn definition(&self) -> &TeamDefinition {
        &self.definition
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReplaceTeam {
    team_id: TeamId,
    expected_revision: TeamRevision,
    definition: TeamDefinition,
}

impl ReplaceTeam {
    pub fn try_new(
        team_id: TeamId,
        expected_revision: TeamRevision,
        definition: TeamDefinition,
    ) -> Result<Self, InvalidReplaceTeam> {
        if definition.team_id() != &team_id {
            return Err(InvalidReplaceTeam::DefinitionIdentityMismatch);
        }
        if expected_revision.next().is_err() {
            return Err(InvalidReplaceTeam::RevisionCannotAdvance);
        }
        Ok(Self {
            team_id,
            expected_revision,
            definition,
        })
    }

    pub fn team_id(&self) -> &TeamId {
        &self.team_id
    }

    pub const fn expected_revision(&self) -> TeamRevision {
        self.expected_revision
    }

    pub fn definition(&self) -> &TeamDefinition {
        &self.definition
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidReplaceTeam {
    DefinitionIdentityMismatch,
    RevisionCannotAdvance,
}

impl fmt::Display for InvalidReplaceTeam {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DefinitionIdentityMismatch => formatter
                .write_str("a replacement team definition must retain the target team identity"),
            Self::RevisionCannotAdvance => {
                formatter.write_str("a replacement team revision must be able to advance")
            }
        }
    }
}

impl std::error::Error for InvalidReplaceTeam {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoveTeam {
    team_id: TeamId,
    expected_revision: TeamRevision,
}

impl RemoveTeam {
    pub fn new(team_id: TeamId, expected_revision: TeamRevision) -> Self {
        Self {
            team_id,
            expected_revision,
        }
    }

    pub fn team_id(&self) -> &TeamId {
        &self.team_id
    }

    pub const fn expected_revision(&self) -> TeamRevision {
        self.expected_revision
    }
}

#[cfg(test)]
mod tests {
    use super::super::{
        member::{MemberId, TeamMember},
        role::{LEADER_ROLE_ID, RoleAssignment, RoleId, RoleKind, TeamRole},
    };
    use super::*;

    fn definition(team_id: &str) -> TeamDefinition {
        let leader = TeamMember::try_new(
            MemberId::try_new("member:coordinator").unwrap(),
            "Coordinator",
        )
        .unwrap();
        let leader_role = TeamRole::try_new(
            RoleId::try_new(LEADER_ROLE_ID).unwrap(),
            "Coordinator",
            RoleKind::Leader,
        )
        .unwrap();
        TeamDefinition::try_new(
            TeamId::try_new(team_id).unwrap(),
            "Research Team",
            vec![leader.clone()],
            vec![leader_role.clone()],
            vec![RoleAssignment::new(
                leader.member_id().clone(),
                leader_role.role_id().clone(),
            )],
        )
        .unwrap()
    }

    #[test]
    fn command_oracle_keeps_team_changes_versioned_and_scoped_to_one_identity() {
        let create = TeamCommand::Create(CreateTeam::new(definition("team:research")));
        let replace = TeamCommand::Replace(
            ReplaceTeam::try_new(
                TeamId::try_new("team:research").unwrap(),
                TeamRevision::initial(),
                definition("team:research"),
            )
            .unwrap(),
        );
        let remove = TeamCommand::Remove(RemoveTeam::new(
            TeamId::try_new("team:research").unwrap(),
            TeamRevision::try_new(2).unwrap(),
        ));

        for command in [&create, &replace, &remove] {
            assert_eq!(command.team_id().as_str(), "team:research");
        }
        assert_eq!(create.expected_revision(), None);
        assert_eq!(replace.expected_revision(), Some(TeamRevision::initial()));
        assert_eq!(
            remove.expected_revision(),
            Some(TeamRevision::try_new(2).unwrap())
        );
        assert_eq!(
            create.definition().unwrap().team_id().as_str(),
            "team:research"
        );
        assert_eq!(
            replace.definition().unwrap().team_id().as_str(),
            "team:research"
        );
        assert_eq!(remove.definition(), None);
    }

    #[test]
    fn replacement_oracle_rejects_a_definition_for_another_team() {
        let error = ReplaceTeam::try_new(
            TeamId::try_new("team:research").unwrap(),
            TeamRevision::initial(),
            definition("team:design"),
        )
        .unwrap_err();

        assert_eq!(error, InvalidReplaceTeam::DefinitionIdentityMismatch);
        assert_eq!(
            error.to_string(),
            "a replacement team definition must retain the target team identity"
        );
    }

    #[test]
    fn replacement_oracle_rejects_a_revision_that_cannot_advance() {
        let error = ReplaceTeam::try_new(
            TeamId::try_new("team:research").unwrap(),
            TeamRevision::try_new(u64::MAX).unwrap(),
            definition("team:research"),
        )
        .unwrap_err();

        assert_eq!(error, InvalidReplaceTeam::RevisionCannotAdvance);
        assert_eq!(
            error.to_string(),
            "a replacement team revision must be able to advance"
        );
    }
}
