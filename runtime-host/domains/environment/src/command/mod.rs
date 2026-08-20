use std::fmt;

use crate::definition::{DesiredDefinition, EnvironmentId, EnvironmentRevision};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EnvironmentCommand {
    Create(CreateEnvironment),
    Replace(ReplaceEnvironment),
    Delete(DeleteEnvironment),
}

impl EnvironmentCommand {
    pub fn create(definition: DesiredDefinition) -> Result<Self, InvalidEnvironmentCommand> {
        CreateEnvironment::try_new(definition).map(Self::Create)
    }

    pub fn replace(
        environment_id: EnvironmentId,
        expected_revision: EnvironmentRevision,
        definition: DesiredDefinition,
    ) -> Result<Self, InvalidEnvironmentCommand> {
        ReplaceEnvironment::try_new(environment_id, expected_revision, definition)
            .map(Self::Replace)
    }

    pub fn delete(environment_id: EnvironmentId, expected_revision: EnvironmentRevision) -> Self {
        Self::Delete(DeleteEnvironment::new(environment_id, expected_revision))
    }

    pub fn environment_id(&self) -> &EnvironmentId {
        match self {
            Self::Create(command) => command.definition().environment_id(),
            Self::Replace(command) => command.environment_id(),
            Self::Delete(command) => command.environment_id(),
        }
    }

    pub fn expected_revision(&self) -> Option<EnvironmentRevision> {
        match self {
            Self::Create(_) => None,
            Self::Replace(command) => Some(command.expected_revision()),
            Self::Delete(command) => Some(command.expected_revision()),
        }
    }

    pub fn definition(&self) -> Option<&DesiredDefinition> {
        match self {
            Self::Create(command) => Some(command.definition()),
            Self::Replace(command) => Some(command.definition()),
            Self::Delete(_) => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreateEnvironment {
    definition: DesiredDefinition,
}

impl CreateEnvironment {
    pub fn try_new(definition: DesiredDefinition) -> Result<Self, InvalidEnvironmentCommand> {
        if definition.revision().get() != 1 {
            return Err(InvalidEnvironmentCommand::InitialRevisionRequired);
        }
        Ok(Self { definition })
    }

    pub fn definition(&self) -> &DesiredDefinition {
        &self.definition
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidEnvironmentCommand {
    InitialRevisionRequired,
    DefinitionIdentityMismatch,
    RevisionMustFollowExpected,
}

impl fmt::Display for InvalidEnvironmentCommand {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InitialRevisionRequired => {
                formatter.write_str("a new environment definition must start at revision one")
            }
            Self::DefinitionIdentityMismatch => formatter
                .write_str("a replacement environment definition must retain the target identity"),
            Self::RevisionMustFollowExpected => formatter
                .write_str("a replacement environment definition must use the next revision"),
        }
    }
}

impl std::error::Error for InvalidEnvironmentCommand {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReplaceEnvironment {
    environment_id: EnvironmentId,
    expected_revision: EnvironmentRevision,
    definition: DesiredDefinition,
}

impl ReplaceEnvironment {
    pub fn try_new(
        environment_id: EnvironmentId,
        expected_revision: EnvironmentRevision,
        definition: DesiredDefinition,
    ) -> Result<Self, InvalidEnvironmentCommand> {
        if definition.environment_id() != &environment_id {
            return Err(InvalidEnvironmentCommand::DefinitionIdentityMismatch);
        }
        if expected_revision.next().ok() != Some(definition.revision()) {
            return Err(InvalidEnvironmentCommand::RevisionMustFollowExpected);
        }
        Ok(Self {
            environment_id,
            expected_revision,
            definition,
        })
    }

    pub fn environment_id(&self) -> &EnvironmentId {
        &self.environment_id
    }

    pub const fn expected_revision(&self) -> EnvironmentRevision {
        self.expected_revision
    }

    pub fn definition(&self) -> &DesiredDefinition {
        &self.definition
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeleteEnvironment {
    environment_id: EnvironmentId,
    expected_revision: EnvironmentRevision,
}

impl DeleteEnvironment {
    pub fn new(environment_id: EnvironmentId, expected_revision: EnvironmentRevision) -> Self {
        Self {
            environment_id,
            expected_revision,
        }
    }

    pub fn environment_id(&self) -> &EnvironmentId {
        &self.environment_id
    }

    pub const fn expected_revision(&self) -> EnvironmentRevision {
        self.expected_revision
    }
}

#[cfg(test)]
mod tests {
    use crate::definition::{
        BrowserMode, ChannelReference, ConnectorReference, CredentialReference,
        DesiredConfiguration, ExtensionReference, PolicyReference, ProviderReference,
        SecurityPreset, ToolchainReference,
    };

    use super::*;

    fn definition(environment_id: &str, revision: u64) -> DesiredDefinition {
        DesiredDefinition::new(
            EnvironmentId::try_new(environment_id).unwrap(),
            EnvironmentRevision::try_new(revision).unwrap(),
            ProviderReference::try_new("anthropic").unwrap(),
            DesiredConfiguration::try_new(
                vec![ConnectorReference::try_new("slack").unwrap()],
                vec![ExtensionReference::try_new("browser-relay").unwrap()],
                vec![ChannelReference::try_new("discord").unwrap()],
                vec![CredentialReference::try_new("credential:v1:anthropic").unwrap()],
                vec![PolicyReference::try_new("security:balanced").unwrap()],
                vec![ToolchainReference::try_new("bun:1").unwrap()],
                SecurityPreset::Relaxed,
                BrowserMode::Relay,
                Vec::new(),
            )
            .unwrap(),
        )
    }

    #[test]
    fn command_oracle_keeps_environment_changes_versioned_and_scoped_to_one_identity() {
        let create = EnvironmentCommand::create(definition("environment:primary", 1)).unwrap();
        let replace = EnvironmentCommand::replace(
            EnvironmentId::try_new("environment:primary").unwrap(),
            EnvironmentRevision::try_new(1).unwrap(),
            definition("environment:primary", 2),
        )
        .unwrap();
        let delete = EnvironmentCommand::delete(
            EnvironmentId::try_new("environment:primary").unwrap(),
            EnvironmentRevision::try_new(2).unwrap(),
        );

        for command in [&create, &replace, &delete] {
            assert_eq!(command.environment_id().as_str(), "environment:primary");
        }
        assert_eq!(create.expected_revision(), None);
        assert_eq!(replace.expected_revision().unwrap().get(), 1);
        assert_eq!(delete.expected_revision().unwrap().get(), 2);
        assert_eq!(create.definition().unwrap().revision().get(), 1);
        assert_eq!(replace.definition().unwrap().revision().get(), 2);
        assert_eq!(delete.definition(), None);
    }

    #[test]
    fn create_oracle_rejects_a_non_initial_definition_without_exposing_references() {
        let error =
            EnvironmentCommand::create(definition("environment:contains-secret", 2)).unwrap_err();

        assert_eq!(error, InvalidEnvironmentCommand::InitialRevisionRequired);
        assert_eq!(
            error.to_string(),
            "a new environment definition must start at revision one"
        );
        assert_eq!(format!("{error:?}"), "InitialRevisionRequired");
    }

    #[test]
    fn replacement_oracle_rejects_a_definition_for_another_environment() {
        let error = EnvironmentCommand::replace(
            EnvironmentId::try_new("environment:primary").unwrap(),
            EnvironmentRevision::try_new(1).unwrap(),
            definition("environment:secondary", 2),
        )
        .unwrap_err();

        assert_eq!(error, InvalidEnvironmentCommand::DefinitionIdentityMismatch);
        assert_eq!(
            error.to_string(),
            "a replacement environment definition must retain the target identity"
        );
    }

    #[test]
    fn replacement_oracle_rejects_a_revision_that_does_not_advance_exactly_once() {
        for revision in [1, 2, 4] {
            let error = EnvironmentCommand::replace(
                EnvironmentId::try_new("environment:primary").unwrap(),
                EnvironmentRevision::try_new(2).unwrap(),
                definition("environment:primary", revision),
            )
            .unwrap_err();

            assert_eq!(error, InvalidEnvironmentCommand::RevisionMustFollowExpected);
        }
    }

    #[test]
    fn replacement_oracle_rejects_a_revision_that_cannot_advance() {
        let error = EnvironmentCommand::replace(
            EnvironmentId::try_new("environment:primary").unwrap(),
            EnvironmentRevision::try_new(u64::MAX).unwrap(),
            definition("environment:primary", u64::MAX),
        )
        .unwrap_err();

        assert_eq!(error, InvalidEnvironmentCommand::RevisionMustFollowExpected);
        assert_eq!(
            error.to_string(),
            "a replacement environment definition must use the next revision"
        );
    }
}
