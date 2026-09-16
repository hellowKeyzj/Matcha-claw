use std::{
    env,
    path::{Path, PathBuf},
};

const PROVIDER_ACCOUNTS_ENV: &str = "MATCHACLAW_RUNTIME_HOST_PROVIDER_STORE_FILE";
const PROVIDER_MODELS_ENV: &str = "MATCHACLAW_RUNTIME_HOST_PROVIDER_MODELS_STORE_FILE";
const PROVIDER_ROUTING_ENV: &str = "MATCHACLAW_RUNTIME_HOST_CAPABILITY_ROUTING_STORE_FILE";

const PROVIDER_ACCOUNTS_FILE: &str = "matchaclaw-provider-accounts.json";
const PROVIDER_MODELS_FILE: &str = "matchaclaw-provider-models.json";
const PROVIDER_ROUTING_FILE: &str = "matchaclaw-capability-routing.json";

pub(crate) struct ProviderLegacyStoreCandidates {
    pub(crate) accounts: Vec<PathBuf>,
    pub(crate) models: Vec<PathBuf>,
    pub(crate) routing: Vec<PathBuf>,
}

pub(crate) fn locate_provider_legacy_store_candidates(
    default_root: &Path,
) -> ProviderLegacyStoreCandidates {
    let legacy_root = legacy_runtime_host_data_dir();
    ProviderLegacyStoreCandidates {
        accounts: legacy_store_candidates(
            PROVIDER_ACCOUNTS_ENV,
            default_root,
            PROVIDER_ACCOUNTS_FILE,
            legacy_root.as_deref(),
        ),
        models: legacy_store_candidates(
            PROVIDER_MODELS_ENV,
            default_root,
            PROVIDER_MODELS_FILE,
            legacy_root.as_deref(),
        ),
        routing: legacy_store_candidates(
            PROVIDER_ROUTING_ENV,
            default_root,
            PROVIDER_ROUTING_FILE,
            legacy_root.as_deref(),
        ),
    }
}

fn legacy_store_candidates(
    env_name: &str,
    default_root: &Path,
    file_name: &str,
    legacy_root: Option<&Path>,
) -> Vec<PathBuf> {
    let mut sources = Vec::new();
    if let Ok(source) = env::var(env_name) {
        push_unique(&mut sources, PathBuf::from(source.trim()));
    }
    push_unique(&mut sources, default_root.join(file_name));
    if let Some(legacy_root) = legacy_root {
        push_unique(&mut sources, legacy_root.join(file_name));
    }
    sources
}

fn legacy_runtime_host_data_dir() -> Option<PathBuf> {
    if let Ok(root) = env::var("OPENCLAW_CONFIG_DIR") {
        let root = root.trim();
        if !root.is_empty() {
            return Some(PathBuf::from(root));
        }
    }
    home_dir().map(|home| home.join(".openclaw"))
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .or_else(|| env::var_os("USERPROFILE").filter(|value| !value.is_empty()))
        .map(PathBuf::from)
}

fn push_unique(sources: &mut Vec<PathBuf>, source: PathBuf) {
    if !source.as_os_str().is_empty() && !sources.iter().any(|candidate| candidate == &source) {
        sources.push(source);
    }
}
