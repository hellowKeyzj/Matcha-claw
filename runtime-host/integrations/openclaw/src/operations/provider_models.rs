use std::sync::{Arc, atomic::Ordering};

use crate::gateway::{client::GatewayClient, wire::models};

pub use models::Model;

pub struct ProviderModelCatalog {
    gateway: Arc<GatewayClient>,
}

impl ProviderModelCatalog {
    pub fn new(gateway: Arc<GatewayClient>) -> Self {
        Self { gateway }
    }

    pub async fn discover(&self, provider: &str) -> Result<Vec<Model>, ()> {
        let request = models::list_request(format!(
            "provider-models-{}",
            super::NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
        ))
        .map_err(|_| ())?;
        let response = self.gateway.rpc_query(request).await.map_err(|_| ())?;
        let models = models::decode_list(response).ok_or(())?;
        Ok(models
            .into_iter()
            .filter(|model| model.provider == provider)
            .collect())
    }
}
