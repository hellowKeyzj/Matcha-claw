use std::path::{Path, PathBuf};

use openclaw::lifecycle::state_dir::CanonicalStateDir;
use provider_module::{
    ProviderCascade, locate_provider_legacy_store_candidates, migrate_provider_legacy_stores,
};

use crate::composition::host::ConstructionError;

struct ProviderStorePaths {
    accounts: PathBuf,
    models: PathBuf,
    routing: PathBuf,
    cascade: PathBuf,
}

impl ProviderStorePaths {
    fn from_root(root: &Path) -> Self {
        Self {
            accounts: root.join("matchaclaw-provider-accounts.json"),
            models: root.join("matchaclaw-provider-models.json"),
            routing: root.join("matchaclaw-capability-routing.json"),
            cascade: root.join("provider-cascade.v1.json"),
        }
    }
}

pub(in crate::composition::host) fn provision_provider_cascade(
    diagnostics_state_root: &CanonicalStateDir,
) -> Result<ProviderCascade, ConstructionError> {
    let provider_store_root = diagnostics_state_root.as_path();
    let paths = ProviderStorePaths::from_root(provider_store_root);
    let legacy_candidates = locate_provider_legacy_store_candidates(provider_store_root);
    migrate_provider_legacy_stores(
        &paths.accounts,
        &paths.models,
        &paths.routing,
        (
            legacy_candidates.accounts,
            legacy_candidates.models,
            legacy_candidates.routing,
        ),
    )
    .map_err(|_| ConstructionError::ProviderMigration)?;
    ProviderCascade::open(paths.accounts, paths.models, paths.routing, paths.cascade)
        .map_err(|_| ConstructionError::ProviderAccounts)
}
