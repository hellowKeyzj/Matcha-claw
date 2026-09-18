use std::sync::Arc;

use tokio::sync::Mutex;

use crate::{
    facade::PluginsHandle,
    transport::{common::authorization::CapabilityDecisionVerifier, skills::plugins},
};

use super::handler::{Request, Response, now_millis};

pub(super) async fn handle_catalog(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    plugins: PluginsHandle,
) -> Response {
    match plugins::catalog(&request.headers, verifier, plugins, now_millis()).await {
        Ok(body) => Response { status: 200, body },
        Err(plugins::RequestError::Invalid) => {
            Response::fixed(503, "Plugin catalog is unavailable")
        }
        Err(plugins::RequestError::Unauthorized) => {
            Response::fixed(401, "Plugin authorization is invalid")
        }
    }
}

pub(super) async fn handle_runtime(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    plugins: PluginsHandle,
) -> Response {
    match plugins::runtime(&request.headers, verifier, plugins, now_millis()).await {
        Ok(body) => Response { status: 200, body },
        Err(plugins::RequestError::Invalid) => {
            Response::fixed(503, "Plugin runtime is unavailable")
        }
        Err(plugins::RequestError::Unauthorized) => {
            Response::fixed(401, "Plugin authorization is invalid")
        }
    }
}

pub(super) async fn handle_configuration(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    plugins: PluginsHandle,
) -> Response {
    match plugins::configuration(
        &request.headers,
        &request.body,
        verifier,
        plugins,
        now_millis(),
    )
    .await
    {
        Ok(body) => Response { status: 200, body },
        Err(plugins::RequestError::Invalid) => {
            Response::fixed(400, "Plugin configuration request is invalid")
        }
        Err(plugins::RequestError::Unauthorized) => {
            Response::fixed(401, "Plugin authorization is invalid")
        }
    }
}

pub(super) async fn handle_operation(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    plugins: PluginsHandle,
) -> Response {
    match plugins::operation(
        &request.headers,
        &request.body,
        verifier,
        plugins,
        now_millis(),
    )
    .await
    {
        Ok(body) => Response { status: 200, body },
        Err(plugins::RequestError::Invalid) => {
            Response::fixed(400, "Plugin operation request is invalid")
        }
        Err(plugins::RequestError::Unauthorized) => {
            Response::fixed(401, "Plugin authorization is invalid")
        }
    }
}
