use std::{fmt, time::SystemTime};

use super::definition::TeamId;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct TeamRevision(u64);

impl TeamRevision {
    pub fn try_new(value: u64) -> Result<Self, InvalidTeamRevision> {
        if value == 0 {
            return Err(InvalidTeamRevision);
        }
        Ok(Self(value))
    }

    pub const fn initial() -> Self {
        Self(1)
    }

    pub const fn get(self) -> u64 {
        self.0
    }

    pub fn next(self) -> Result<Self, TeamRevisionOverflow> {
        self.0.checked_add(1).map(Self).ok_or(TeamRevisionOverflow)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidTeamRevision;

impl fmt::Display for InvalidTeamRevision {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("team revision must be greater than zero")
    }
}

impl std::error::Error for InvalidTeamRevision {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TeamRevisionOverflow;

impl fmt::Display for TeamRevisionOverflow {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("team revision cannot advance beyond its maximum value")
    }
}

impl std::error::Error for TeamRevisionOverflow {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TeamEvent {
    TeamCreated(TeamCreated),
    TeamReplaced(TeamReplaced),
    TeamRemoved(TeamRemoved),
}

impl TeamEvent {
    pub fn team_id(&self) -> &TeamId {
        match self {
            Self::TeamCreated(event) => event.team_id(),
            Self::TeamReplaced(event) => event.team_id(),
            Self::TeamRemoved(event) => event.team_id(),
        }
    }

    pub fn revision(&self) -> TeamRevision {
        match self {
            Self::TeamCreated(event) => event.revision(),
            Self::TeamReplaced(event) => event.revision(),
            Self::TeamRemoved(event) => event.revision(),
        }
    }

    pub fn occurred_at(&self) -> SystemTime {
        match self {
            Self::TeamCreated(event) => event.occurred_at(),
            Self::TeamReplaced(event) => event.occurred_at(),
            Self::TeamRemoved(event) => event.occurred_at(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamCreated {
    team_id: TeamId,
    revision: TeamRevision,
    occurred_at: SystemTime,
}

impl TeamCreated {
    pub fn try_new(
        team_id: TeamId,
        revision: TeamRevision,
        occurred_at: SystemTime,
    ) -> Result<Self, InvalidTeamCreated> {
        if revision != TeamRevision::initial() {
            return Err(InvalidTeamCreated::InitialRevisionRequired);
        }
        Ok(Self {
            team_id,
            revision,
            occurred_at,
        })
    }

    pub fn team_id(&self) -> &TeamId {
        &self.team_id
    }

    pub const fn revision(&self) -> TeamRevision {
        self.revision
    }

    pub fn occurred_at(&self) -> SystemTime {
        self.occurred_at
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidTeamCreated {
    InitialRevisionRequired,
}

impl fmt::Display for InvalidTeamCreated {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InitialRevisionRequired => {
                formatter.write_str("a created team must start at revision one")
            }
        }
    }
}

impl std::error::Error for InvalidTeamCreated {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamReplaced {
    team_id: TeamId,
    revision: TeamRevision,
    occurred_at: SystemTime,
}

impl TeamReplaced {
    pub fn try_new(
        team_id: TeamId,
        revision: TeamRevision,
        occurred_at: SystemTime,
    ) -> Result<Self, InvalidTeamReplaced> {
        if revision == TeamRevision::initial() {
            return Err(InvalidTeamReplaced::AdvancedRevisionRequired);
        }
        Ok(Self {
            team_id,
            revision,
            occurred_at,
        })
    }

    pub fn team_id(&self) -> &TeamId {
        &self.team_id
    }

    pub const fn revision(&self) -> TeamRevision {
        self.revision
    }

    pub fn occurred_at(&self) -> SystemTime {
        self.occurred_at
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidTeamReplaced {
    AdvancedRevisionRequired,
}

impl fmt::Display for InvalidTeamReplaced {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AdvancedRevisionRequired => {
                formatter.write_str("a replaced team must use an advanced revision")
            }
        }
    }
}

impl std::error::Error for InvalidTeamReplaced {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamRemoved {
    team_id: TeamId,
    revision: TeamRevision,
    occurred_at: SystemTime,
}

impl TeamRemoved {
    pub fn new(team_id: TeamId, revision: TeamRevision, occurred_at: SystemTime) -> Self {
        Self {
            team_id,
            revision,
            occurred_at,
        }
    }

    pub fn team_id(&self) -> &TeamId {
        &self.team_id
    }

    pub const fn revision(&self) -> TeamRevision {
        self.revision
    }

    pub fn occurred_at(&self) -> SystemTime {
        self.occurred_at
    }
}

#[cfg(test)]
mod tests {
    use std::time::UNIX_EPOCH;

    use super::*;

    fn team_id() -> TeamId {
        TeamId::try_new("team:research").unwrap()
    }

    #[test]
    fn revision_oracle_rejects_zero_and_stops_at_the_final_value() {
        assert_eq!(TeamRevision::try_new(0), Err(InvalidTeamRevision));
        assert_eq!(
            TeamRevision::try_new(u64::MAX).unwrap().next(),
            Err(TeamRevisionOverflow)
        );
    }

    #[test]
    fn events_preserve_only_team_identity_revision_and_occurrence_time() {
        let created = TeamCreated::try_new(team_id(), TeamRevision::initial(), UNIX_EPOCH).unwrap();
        let replaced =
            TeamReplaced::try_new(team_id(), TeamRevision::try_new(2).unwrap(), UNIX_EPOCH)
                .unwrap();
        let removed = TeamRemoved::new(team_id(), TeamRevision::initial(), UNIX_EPOCH);

        for (event, revision) in [
            (TeamEvent::TeamCreated(created), TeamRevision::initial()),
            (
                TeamEvent::TeamReplaced(replaced),
                TeamRevision::try_new(2).unwrap(),
            ),
            (TeamEvent::TeamRemoved(removed), TeamRevision::initial()),
        ] {
            assert_eq!(event.team_id().as_str(), "team:research");
            assert_eq!(event.revision(), revision);
            assert_eq!(event.occurred_at(), UNIX_EPOCH);
        }
    }

    #[test]
    fn event_oracle_rejects_impossible_creation_and_replacement_revisions() {
        assert_eq!(
            TeamCreated::try_new(team_id(), TeamRevision::try_new(2).unwrap(), UNIX_EPOCH),
            Err(InvalidTeamCreated::InitialRevisionRequired)
        );
        assert_eq!(
            TeamReplaced::try_new(team_id(), TeamRevision::initial(), UNIX_EPOCH),
            Err(InvalidTeamReplaced::AdvancedRevisionRequired)
        );
    }
}
