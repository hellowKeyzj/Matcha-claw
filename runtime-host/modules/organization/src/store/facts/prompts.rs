use super::OrganizationFacts;
use crate::prompts::TeamPromptSettings;

impl OrganizationFacts {
    pub(crate) fn team_prompts(&self) -> &TeamPromptSettings {
        &self.team_prompts
    }

    pub(in crate::store) fn replace_team_prompts(&mut self, settings: TeamPromptSettings) {
        if self.journal.active && self.journal.team_prompts.is_none() {
            self.journal.team_prompts = Some(self.team_prompts.clone());
        }
        self.team_prompts = settings;
    }
}
