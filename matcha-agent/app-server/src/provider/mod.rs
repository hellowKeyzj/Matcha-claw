mod auth;
mod config;
mod models;
mod projection;

pub use config::{ProviderConfig, ProviderKind, SELECTOR_ENVS, managed_env_names};
pub use projection::PrivateProjection;
pub(crate) use projection::configured_sources;

use crate::{config::ConfigStore, rpc, session::Sessions};
use serde_json::Value;

pub async fn dispatch(
    method: &str,
    params: Value,
    config: &ConfigStore,
    sessions: &Sessions,
) -> rpc::Result {
    match method {
        "providers.project" => projection::project(params, config, sessions).await,
        "providers.list" | "providers.get" | "providers.set" | "providers.remove" => {
            config::dispatch(method, params, config, sessions).await
        }
        "models.list" => models::list(params, sessions).await,
        "auth.status" | "auth.login" | "auth.logout" => {
            auth::dispatch(method, params, config, sessions).await
        }
        _ => Err(rpc::Error::method(method)),
    }
}
