mod catalog;
mod plugin_config;

pub use catalog::{
    Endpoint, MediaCatalogError, MediaProviderCatalog, Model, ModelId, Protocol, ProviderKey,
    ProviderModels,
};

use crate::projection::config_store::{
    OpenClawConfigMutation, OpenClawConfigStore, OpenClawConfigUpdate,
};

impl MediaProviderCatalog {
    pub(crate) fn apply(
        &self,
        store: &OpenClawConfigStore,
    ) -> Result<OpenClawConfigUpdate, MediaCatalogError> {
        store
            .update(|document| {
                if self.apply_to_document(document) {
                    OpenClawConfigMutation::changed()
                } else {
                    OpenClawConfigMutation::unchanged()
                }
            })
            .map_err(|_| MediaCatalogError::ConfigPersist)
    }

    pub(crate) fn apply_to_document(
        &self,
        document: &mut crate::projection::config_store::OpenClawConfigDocument,
    ) -> bool {
        plugin_config::apply(self, document)
    }
}

#[cfg(test)]
mod tests;
