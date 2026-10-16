mod hooks;
mod permissions;
mod sandbox;
mod settings;

pub(crate) use sandbox::validate_required_sandbox;

use crate::{config::ConfigStore, rpc, session::Sessions};
use serde_json::Value;

pub async fn dispatch(
    method: &str,
    params: Value,
    config: &ConfigStore,
    sessions: &Sessions,
) -> rpc::Result<Value> {
    match method {
        "permissions.get" => permissions::get(params, config, sessions).await,
        "permissions.set" => permissions::set(params, config, sessions).await,
        "sandbox.status" => sandbox::status(params, config, sessions).await,
        "sandbox.set" => sandbox::set(params, config, sessions).await,
        "hooks.get" => hooks::get(params, config, sessions).await,
        "hooks.set" => hooks::set(params, config, sessions).await,
        _ => Err(rpc::Error::method(method)),
    }
}
