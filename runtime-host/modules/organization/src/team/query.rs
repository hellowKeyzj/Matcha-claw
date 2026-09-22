use std::fmt;

use super::{
    definition::{TeamDefinition, TeamId},
    event::TeamRevision,
};

pub const MAX_TEAM_PAGE_SIZE: usize = 100;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TeamQuery {
    Get(TeamId),
    List(ListTeams),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ListTeams {
    after: Option<TeamId>,
    page_size: TeamPageSize,
}

impl ListTeams {
    pub fn new(after: Option<TeamId>, page_size: TeamPageSize) -> Self {
        Self { after, page_size }
    }

    pub fn after(&self) -> Option<&TeamId> {
        self.after.as_ref()
    }

    pub const fn page_size(&self) -> TeamPageSize {
        self.page_size
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TeamPageSize(usize);

impl TeamPageSize {
    pub fn try_new(value: usize) -> Result<Self, InvalidTeamPageSize> {
        if value == 0 {
            return Err(InvalidTeamPageSize::Zero);
        }
        if value > MAX_TEAM_PAGE_SIZE {
            return Err(InvalidTeamPageSize::ExceedsMaximum);
        }
        Ok(Self(value))
    }

    pub const fn get(self) -> usize {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidTeamPageSize {
    Zero,
    ExceedsMaximum,
}

impl fmt::Display for InvalidTeamPageSize {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Zero => formatter.write_str("team page size must be greater than zero"),
            Self::ExceedsMaximum => formatter.write_str("team page size exceeds the maximum"),
        }
    }
}

impl std::error::Error for InvalidTeamPageSize {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamProjection {
    definition: TeamDefinition,
    revision: TeamRevision,
}

impl TeamProjection {
    pub fn new(definition: TeamDefinition, revision: TeamRevision) -> Self {
        Self {
            definition,
            revision,
        }
    }

    pub fn team_id(&self) -> &TeamId {
        self.definition.team_id()
    }

    pub fn definition(&self) -> &TeamDefinition {
        &self.definition
    }

    pub const fn revision(&self) -> TeamRevision {
        self.revision
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamListPage {
    teams: Vec<TeamProjection>,
    next_after: Option<TeamId>,
}

impl TeamListPage {
    pub fn try_new(
        teams: Vec<TeamProjection>,
        after: Option<&TeamId>,
        next_after: Option<TeamId>,
        page_size: TeamPageSize,
    ) -> Result<Self, InvalidTeamListPage> {
        if teams.len() > page_size.get() {
            return Err(InvalidTeamListPage::ExceedsPageSize);
        }
        if teams
            .windows(2)
            .any(|pair| pair[0].team_id().as_str() >= pair[1].team_id().as_str())
        {
            return Err(InvalidTeamListPage::UnstableOrder);
        }
        if let Some(after) = after
            && teams
                .first()
                .map(TeamProjection::team_id)
                .is_some_and(|team_id| team_id.as_str() <= after.as_str())
        {
            return Err(InvalidTeamListPage::CursorMustAdvance);
        }
        if let Some(next_after) = &next_after
            && teams.last().map(TeamProjection::team_id) != Some(next_after)
        {
            return Err(InvalidTeamListPage::CursorMustMatchLastTeam);
        }
        Ok(Self { teams, next_after })
    }

    pub fn teams(&self) -> &[TeamProjection] {
        &self.teams
    }

    pub fn next_after(&self) -> Option<&TeamId> {
        self.next_after.as_ref()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidTeamListPage {
    ExceedsPageSize,
    UnstableOrder,
    CursorMustAdvance,
    CursorMustMatchLastTeam,
}

impl fmt::Display for InvalidTeamListPage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ExceedsPageSize => {
                formatter.write_str("team list page exceeds its requested size")
            }
            Self::UnstableOrder => {
                formatter.write_str("team list page must be ordered by team identity")
            }
            Self::CursorMustAdvance => {
                formatter.write_str("team list page must start after its requested cursor")
            }
            Self::CursorMustMatchLastTeam => {
                formatter.write_str("team list page cursor must match its last team")
            }
        }
    }
}

impl std::error::Error for InvalidTeamListPage {}

#[cfg(test)]
mod tests {
    use super::super::{
        member::{MemberId, TeamMember},
        role::{LEADER_ROLE_ID, RoleAssignment, RoleId, RoleKind, TeamRole},
    };
    use super::*;

    fn projection(team_id: &str, revision: u64) -> TeamProjection {
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
        TeamProjection::new(
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
            .unwrap(),
            TeamRevision::try_new(revision).unwrap(),
        )
    }

    #[test]
    fn list_query_requires_a_bounded_positive_page_size() {
        assert_eq!(TeamPageSize::try_new(0), Err(InvalidTeamPageSize::Zero));
        assert_eq!(
            TeamPageSize::try_new(MAX_TEAM_PAGE_SIZE + 1),
            Err(InvalidTeamPageSize::ExceedsMaximum)
        );
        assert_eq!(
            TeamPageSize::try_new(MAX_TEAM_PAGE_SIZE).unwrap().get(),
            MAX_TEAM_PAGE_SIZE
        );
    }

    #[test]
    fn list_page_oracle_preserves_stable_order_bounded_results_and_cursor() {
        let page_size = TeamPageSize::try_new(2).unwrap();
        let first = projection("team:design", 1);
        let second = projection("team:research", 3);
        let page = TeamListPage::try_new(
            vec![first, second],
            None,
            Some(TeamId::try_new("team:research").unwrap()),
            page_size,
        )
        .unwrap();

        assert_eq!(page.teams().len(), 2);
        assert_eq!(page.teams()[1].revision().get(), 3);
        assert_eq!(page.next_after().unwrap().as_str(), "team:research");
    }

    #[test]
    fn list_page_oracle_rejects_unstable_or_unbounded_projections() {
        let page_size = TeamPageSize::try_new(1).unwrap();
        let after = TeamId::try_new("team:design").unwrap();
        let unstable = TeamListPage::try_new(
            vec![projection("team:research", 1), projection("team:design", 1)],
            None,
            None,
            TeamPageSize::try_new(2).unwrap(),
        );
        let unbounded = TeamListPage::try_new(
            vec![projection("team:design", 1), projection("team:research", 1)],
            None,
            None,
            page_size,
        );
        let repeated_cursor = TeamListPage::try_new(
            vec![projection("team:design", 1)],
            Some(&after),
            None,
            page_size,
        );
        let invalid_next_after = TeamListPage::try_new(
            vec![projection("team:design", 1)],
            None,
            Some(TeamId::try_new("team:research").unwrap()),
            page_size,
        );

        assert_eq!(unstable, Err(InvalidTeamListPage::UnstableOrder));
        assert_eq!(unbounded, Err(InvalidTeamListPage::ExceedsPageSize));
        assert_eq!(repeated_cursor, Err(InvalidTeamListPage::CursorMustAdvance));
        assert_eq!(
            invalid_next_after,
            Err(InvalidTeamListPage::CursorMustMatchLastTeam)
        );
    }
}
