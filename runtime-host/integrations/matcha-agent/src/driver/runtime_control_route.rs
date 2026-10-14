use std::sync::Arc;

use platform::{call::CallStatus, loopback::Response};
use runtime_directory::{
    RuntimeDriverIdentity,
    call::{RuntimeControlCallDetail, RuntimeControlCallResult, finish_runtime_control_call},
    control_loopback::{
        RuntimeControlLifecyclePort, RuntimeControlOperation, RuntimeControlRequest,
        RuntimeControlRouteFragment, RuntimeControlRouteFuture, lifecycle_error_response,
    },
};
use serde_json::json;
use tokio::time::{Instant, timeout_at};

pub struct MatchaRuntimeControlRoute {
    lifecycle: Arc<dyn RuntimeControlLifecyclePort>,
}

impl MatchaRuntimeControlRoute {
    pub fn new(lifecycle: Arc<dyn RuntimeControlLifecyclePort>) -> Self {
        Self { lifecycle }
    }

    fn handle_impl(
        &self,
        operation: RuntimeControlOperation,
        request: RuntimeControlRequest,
        deadline: Option<Instant>,
    ) -> Option<RuntimeControlRouteFuture> {
        match operation {
            RuntimeControlOperation::LifecycleStatus => {
                Some(lifecycle_status(Arc::clone(&self.lifecycle), request, deadline))
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
            RuntimeControlOperation::LifecycleRepair
            | RuntimeControlOperation::RepairStatus
            | RuntimeControlOperation::Logs
            | RuntimeControlOperation::ControlReady
            | RuntimeControlOperation::GatewayHealth
            | RuntimeControlOperation::GatewayStatus
            | RuntimeControlOperation::ControlUiUrl => None,
        }
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
        self.handle_impl(operation, request, None)
    }

    fn handle_read(
        &self,
        operation: RuntimeControlOperation,
        request: RuntimeControlRequest,
        deadline: Instant,
    ) -> Option<RuntimeControlRouteFuture> {
        self.handle_impl(operation, request, Some(deadline))
    }
}

fn lifecycle_status(
    lifecycle: Arc<dyn RuntimeControlLifecyclePort>,
    request: RuntimeControlRequest,
    deadline: Option<Instant>,
) -> RuntimeControlRouteFuture {
    Box::pin(async move {
        let read = lifecycle.lifecycle_status(request.endpoint.clone());
        let result = match deadline {
            Some(deadline) if Instant::now() >= deadline => Err(()),
            Some(deadline) => timeout_at(deadline, read).await.map_err(|_| ()),
            None => Ok(read.await),
        };
        let result = match result {
            Ok(result) => result,
            Err(()) => {
                let mut detail = RuntimeControlCallDetail::new(&request.endpoint);
                detail.result = Some(RuntimeControlCallResult::Unknown);
                finish_runtime_control_call(request.call, CallStatus::Unknown, &detail).await;
                return Response::error(503, "Runtime Host request deadline exceeded");
            }
        };
        let (status, detail) = RuntimeControlCallDetail::lifecycle_result(
            &request.endpoint,
            RuntimeControlOperation::LifecycleStatus,
            &result,
        );
        finish_runtime_control_call(request.call, status, &detail).await;
        match result {
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
        let Some(call) = request.call else {
            return runtime_directory::control_loopback::unavailable_response();
        };
        match lifecycle
            .admit_lifecycle_start(request.endpoint, call)
            .await
        {
            Ok(receipt) => Response::json(202, json!(receipt)),
            Err(error) => lifecycle_error_response(error),
        }
    })
}

fn lifecycle_stop(
    lifecycle: Arc<dyn RuntimeControlLifecyclePort>,
    request: RuntimeControlRequest,
) -> RuntimeControlRouteFuture {
    Box::pin(async move {
        let Some(call) = request.call else {
            return runtime_directory::control_loopback::unavailable_response();
        };
        match lifecycle.admit_lifecycle_stop(request.endpoint, call).await {
            Ok(receipt) => Response::json(202, json!(receipt)),
            Err(error) => lifecycle_error_response(error),
        }
    })
}

fn lifecycle_restart(
    lifecycle: Arc<dyn RuntimeControlLifecyclePort>,
    request: RuntimeControlRequest,
) -> RuntimeControlRouteFuture {
    Box::pin(async move {
        let Some(call) = request.call else {
            return runtime_directory::control_loopback::unavailable_response();
        };
        match lifecycle
            .admit_lifecycle_restart(request.endpoint, call)
            .await
        {
            Ok(receipt) => Response::json(202, json!(receipt)),
            Err(error) => lifecycle_error_response(error),
        }
    })
}
