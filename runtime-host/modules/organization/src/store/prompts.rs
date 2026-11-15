use std::collections::BTreeMap;

use super::{OrganizationStore, StoreFault};
use crate::prompts::{PromptValidationError, TeamPromptSettings, validate_values};

#[derive(Debug)]
pub enum TeamPromptSettingsError {
    Invalid(PromptValidationError),
    Conflict,
    Store(StoreFault),
    Unavailable,
}

impl OrganizationStore {
    pub(crate) fn save_team_prompts(
        &mut self,
        expected_revision: u64,
        values: BTreeMap<String, String>,
    ) -> Result<TeamPromptSettings, TeamPromptSettingsError> {
        validate_values(&values).map_err(TeamPromptSettingsError::Invalid)?;
        self.transact(|facts| {
            if facts.team_prompts().revision != expected_revision {
                return Ok(Err(TeamPromptSettingsError::Conflict));
            }
            let revision = expected_revision
                .checked_add(1)
                .filter(|revision| *revision <= 9_007_199_254_740_991)
                .ok_or(StoreFault::EpochOverflow)?;
            let settings = TeamPromptSettings { revision, values };
            facts.replace_team_prompts(settings.clone());
            Ok(Ok(settings))
        })
        .map_err(TeamPromptSettingsError::Store)?
    }
}
