use std::sync::Arc;

use platform::loopback::Response;
use runtime_directory::{
    RuntimeDriverIdentity,
    control_loopback::{
        RuntimeControlLifecyclePort, RuntimeControlOperation, RuntimeControlRequest,
        RuntimeControlRouteFragment, RuntimeControlRouteFuture, lifecycle_error_response,
    },
};
use serde_json::json;

pub struct MatchaRuntimeControlRoute {
    lifecycle: Arc<dyn RuntimeControlLifecyclePort>,
}

impl MatchaRuntimeControlRoute {
    pub fn new(lifecycle: Arc<dyn RuntimeControlLifecyclePort>) -> Self {
        Self { lifecycle }
    }
}

impl RuntimeControlRouteFragment for MatchaRuntimeControlRoute {
    fn endpoint(&self) -> platform::endpoint::runtime_address::RuntimeEndpoint {
        RuntimeDriverIdentity::matcha_agent().endpoint()
    }

    fn handle(
        &self,
        operation: RuntimeControlOperation,
        request: RuntimeControlRequest,
    ) -> Option<RuntimeControlRouteFuture> {
        match operation {
            RuntimeControlOperation::LifecycleStatus => {
                Some(lifecycle_status(Arc::clone(&self.lifecycle), request))
            }
            RuntimeControlOperation::LifecycleStart => {
                Some(lifecycle_start(Arc::clone(&self.lifecycle), request))
            }
            RuntimeControlOperation::LifecycleStop => {
                Some(lifecycle_stop(Arc::clone(&self.lifecycle), request))
            }
            RuntimeControlOperation::LifecycleRestart => {
                Some(lifecycle_restart(Arc::clone(&self.lifecycle), request))
            }
            RuntimeControlOperation::Logs
            | RuntimeControlOperation::ControlReady
            | RuntimeControlOperation::GatewayHealth
            | RuntimeControlOperation::GatewayStatus
            | RuntimeControlOperation::ControlUiUrl => None,
        }
    }
}

fn lifecycle_status(
    lifecycle: Arc<dyn RuntimeControlLifecyclePort>,
    request: RuntimeControlRequest,
) -> RuntimeControlRouteFuture {
    Box::pin(async move {
        match lifecycle.lifecycle_status(request.endpoint).await {
            Ok(status) => Response::json(200, json!({ "result": status })),
            Err(error) => lifecycle_error_response(error),
        }
    })
}

fn lifecycle_start(
    lifecycle: Arc<dyn RuntimeControlLifecyclePort>,
    request: RuntimeControlRequest,
) -> RuntimeControlRouteFuture {
    Box::pin(async move {
        match lifecycle.lifecycle_start(request.endpoint).await {
            Ok(status) => Response::json(200, json!({ "result": status })),
            Err(error) => lifecycle_error_response(error),
        }
    })
}

fn lifecycle_stop(
    lifecycle: Arc<dyn RuntimeControlLifecyclePort>,
    request: RuntimeControlRequest,
) -> RuntimeControlRouteFuture {
    Box::pin(async move {
        match lifecycle.lifecycle_stop(request.endpoint).await {
            Ok(status) => Response::json(200, json!({ "result": status })),
            Err(error) => lifecycle_error_response(error),
        }
    })
}

fn lifecycle_restart(
    lifecycle: Arc<dyn RuntimeControlLifecyclePort>,
    request: RuntimeControlRequest,
) -> RuntimeControlRouteFuture {
    Box::pin(async move {
        match lifecycle.lifecycle_restart(request.endpoint).await {
            Ok(status) => Response::json(200, json!({ "result": status })),
            Err(error) => lifecycle_error_response(error),
        }
    })
}
