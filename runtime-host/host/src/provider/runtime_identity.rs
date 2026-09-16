use std::collections::BTreeMap;

use environment::{ProviderAccount, ProviderAccountKind};
use openclaw::projection::provider_models::{
    ProviderModelProjectionError, ProviderModelRuntimeIdentity, public_provider_model_identities,
    public_provider_model_identity,
};

pub(crate) struct ProviderRuntimeIdentity {
    inner: ProviderModelRuntimeIdentity,
}

impl ProviderRuntimeIdentity {
    pub(crate) fn provider_key(&self) -> &str {
        self.inner.provider_key()
    }

    pub(crate) fn runtime_model_ref(&self, kind: ProviderAccountKind, model_id: &str) -> String {
        self.inner.runtime_model_ref(kind, model_id)
    }
}

pub(crate) fn provider_runtime_identities(
    accounts: &[ProviderAccount],
) -> Result<BTreeMap<String, ProviderRuntimeIdentity>, ProviderModelProjectionError> {
    public_provider_model_identities(accounts).map(|identities| {
        identities
            .into_iter()
            .map(|(account_id, inner)| (account_id, ProviderRuntimeIdentity { inner }))
            .collect()
    })
}

pub(crate) fn provider_runtime_identity(
    account: &ProviderAccount,
) -> Result<ProviderRuntimeIdentity, ProviderModelProjectionError> {
    public_provider_model_identity(account).map(|inner| ProviderRuntimeIdentity { inner })
}
