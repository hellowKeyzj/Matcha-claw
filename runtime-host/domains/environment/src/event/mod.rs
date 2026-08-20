use std::{fmt, time::SystemTime};

use crate::definition::{EnvironmentId, EnvironmentRevision};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EnvironmentEvent {
    DefinitionCreated(DefinitionCreated),
    DefinitionReplaced(DefinitionReplaced),
    DefinitionRemoved(DefinitionRemoved),
    DesiredRevisionApplied(DesiredRevisionApplied),
}

impl EnvironmentEvent {
    pub fn environment_id(&self) -> &EnvironmentId {
        match self {
            Self::DefinitionCreated(event) => event.environment_id(),
            Self::DefinitionReplaced(event) => event.environment_id(),
            Self::DefinitionRemoved(event) => event.environment_id(),
            Self::DesiredRevisionApplied(event) => event.environment_id(),
        }
    }

    pub const fn revision(&self) -> EnvironmentRevision {
        match self {
            Self::DefinitionCreated(event) => event.revision(),
            Self::DefinitionReplaced(event) => event.revision(),
            Self::DefinitionRemoved(event) => event.revision(),
            Self::DesiredRevisionApplied(event) => event.revision(),
        }
    }

    pub fn occurred_at(&self) -> SystemTime {
        match self {
            Self::DefinitionCreated(event) => event.occurred_at(),
            Self::DefinitionReplaced(event) => event.occurred_at(),
            Self::DefinitionRemoved(event) => event.occurred_at(),
            Self::DesiredRevisionApplied(event) => event.occurred_at(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DefinitionCreated {
    environment_id: EnvironmentId,
    revision: EnvironmentRevision,
    occurred_at: SystemTime,
}

impl DefinitionCreated {
    pub fn try_new(
        environment_id: EnvironmentId,
        revision: EnvironmentRevision,
        occurred_at: SystemTime,
    ) -> Result<Self, InvalidDefinitionCreated> {
        if revision.get() != 1 {
            return Err(InvalidDefinitionCreated::InitialRevisionRequired);
        }
        Ok(Self {
            environment_id,
            revision,
            occurred_at,
        })
    }

    pub fn environment_id(&self) -> &EnvironmentId {
        &self.environment_id
    }

    pub const fn revision(&self) -> EnvironmentRevision {
        self.revision
    }

    pub fn occurred_at(&self) -> SystemTime {
        self.occurred_at
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidDefinitionCreated {
    InitialRevisionRequired,
}

impl fmt::Display for InvalidDefinitionCreated {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a created environment definition must start at revision one")
    }
}

impl std::error::Error for InvalidDefinitionCreated {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DefinitionReplaced {
    environment_id: EnvironmentId,
    revision: EnvironmentRevision,
    occurred_at: SystemTime,
}

impl DefinitionReplaced {
    pub fn try_new(
        environment_id: EnvironmentId,
        revision: EnvironmentRevision,
        occurred_at: SystemTime,
    ) -> Result<Self, InvalidDefinitionReplaced> {
        if revision.get() == 1 {
            return Err(InvalidDefinitionReplaced::AdvancedRevisionRequired);
        }
        Ok(Self {
            environment_id,
            revision,
            occurred_at,
        })
    }

    pub fn environment_id(&self) -> &EnvironmentId {
        &self.environment_id
    }

    pub const fn revision(&self) -> EnvironmentRevision {
        self.revision
    }

    pub fn occurred_at(&self) -> SystemTime {
        self.occurred_at
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidDefinitionReplaced {
    AdvancedRevisionRequired,
}

impl fmt::Display for InvalidDefinitionReplaced {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a replaced environment definition must use an advanced revision")
    }
}

impl std::error::Error for InvalidDefinitionReplaced {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DefinitionRemoved {
    environment_id: EnvironmentId,
    revision: EnvironmentRevision,
    occurred_at: SystemTime,
}

impl DefinitionRemoved {
    pub fn new(
        environment_id: EnvironmentId,
        revision: EnvironmentRevision,
        occurred_at: SystemTime,
    ) -> Self {
        Self {
            environment_id,
            revision,
            occurred_at,
        }
    }

    pub fn environment_id(&self) -> &EnvironmentId {
        &self.environment_id
    }

    pub const fn revision(&self) -> EnvironmentRevision {
        self.revision
    }

    pub fn occurred_at(&self) -> SystemTime {
        self.occurred_at
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DesiredRevisionApplied {
    environment_id: EnvironmentId,
    revision: EnvironmentRevision,
    occurred_at: SystemTime,
}

impl DesiredRevisionApplied {
    pub fn new(
        environment_id: EnvironmentId,
        revision: EnvironmentRevision,
        occurred_at: SystemTime,
    ) -> Self {
        Self {
            environment_id,
            revision,
            occurred_at,
        }
    }

    pub fn environment_id(&self) -> &EnvironmentId {
        &self.environment_id
    }

    pub const fn revision(&self) -> EnvironmentRevision {
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

    fn environment_id() -> EnvironmentId {
        EnvironmentId::try_new("environment:primary").unwrap()
    }

    #[test]
    fn events_preserve_only_environment_identity_revision_and_occurrence_time() {
        let created = DefinitionCreated::try_new(
            environment_id(),
            EnvironmentRevision::try_new(1).unwrap(),
            UNIX_EPOCH,
        )
        .unwrap();
        let replaced = DefinitionReplaced::try_new(
            environment_id(),
            EnvironmentRevision::try_new(2).unwrap(),
            UNIX_EPOCH,
        )
        .unwrap();
        let removed = DefinitionRemoved::new(
            environment_id(),
            EnvironmentRevision::try_new(2).unwrap(),
            UNIX_EPOCH,
        );
        let applied = DesiredRevisionApplied::new(
            environment_id(),
            EnvironmentRevision::try_new(2).unwrap(),
            UNIX_EPOCH,
        );

        for (event, revision) in [
            (EnvironmentEvent::DefinitionCreated(created), 1),
            (EnvironmentEvent::DefinitionReplaced(replaced), 2),
            (EnvironmentEvent::DefinitionRemoved(removed), 2),
            (EnvironmentEvent::DesiredRevisionApplied(applied), 2),
        ] {
            assert_eq!(event.environment_id().as_str(), "environment:primary");
            assert_eq!(event.revision().get(), revision);
            assert_eq!(event.occurred_at(), UNIX_EPOCH);
        }
    }

    #[test]
    fn event_oracle_rejects_impossible_creation_and_replacement_revisions() {
        assert_eq!(
            DefinitionCreated::try_new(
                environment_id(),
                EnvironmentRevision::try_new(2).unwrap(),
                UNIX_EPOCH,
            ),
            Err(InvalidDefinitionCreated::InitialRevisionRequired)
        );
        assert_eq!(
            DefinitionReplaced::try_new(
                environment_id(),
                EnvironmentRevision::try_new(1).unwrap(),
                UNIX_EPOCH,
            ),
            Err(InvalidDefinitionReplaced::AdvancedRevisionRequired)
        );
    }

    #[test]
    fn event_debug_does_not_expose_definition_secret_references() {
        let event = EnvironmentEvent::DesiredRevisionApplied(DesiredRevisionApplied::new(
            environment_id(),
            EnvironmentRevision::try_new(7).unwrap(),
            UNIX_EPOCH,
        ));

        let rendered = format!("{event:?}");
        assert!(!rendered.contains("credential:v1:private-canary"));
    }
}
