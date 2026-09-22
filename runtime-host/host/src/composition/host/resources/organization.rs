use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use organization::package::TeamSkillSelectionResolver;

use crate::composition::host::ConstructionError;

pub(in crate::composition::host) struct OrganizationOwnerProvision {
    store: organization::OrganizationStore,
    team_skill_selections: TeamSkillSelectionResolver,
}

impl OrganizationOwnerProvision {
    pub(in crate::composition::host) fn into_owner_input(
        self,
        runtime_directory: Arc<dyn organization::OrganizationRuntimeDirectory>,
    ) -> organization::OrganizationOwnerInput {
        organization::OrganizationOwnerInput {
            store: self.store,
            runtime_directory,
            team_skill_selections: self.team_skill_selections,
        }
    }
}

pub(in crate::composition::host) fn provision_organization_owner(
    store: organization::OrganizationStore,
    state_dir: &Path,
) -> Result<OrganizationOwnerProvision, ConstructionError> {
    let team_skill_selections =
        TeamSkillSelectionResolver::open(team_skill_selection_registry(state_dir))
            .map_err(|_| ConstructionError::TeamSkillSelection)?;
    Ok(OrganizationOwnerProvision {
        store,
        team_skill_selections,
    })
}

fn team_skill_selection_registry(state_dir: &Path) -> PathBuf {
    state_dir.join("team-skill-selections.v1.json")
}
