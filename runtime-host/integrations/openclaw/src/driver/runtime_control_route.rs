use std::sync::Arc;

use platform::{call::CallStatus, loopback::Response};
use runtime_directory::{
    RuntimeControlFailure, RuntimeControlOps, RuntimeControlReadiness, RuntimeDriverIdentity,
    RuntimeGatewayHealth, RuntimeGatewayStatus, RuntimeLogSnapshot,
    call::{RuntimeControlCallDetail, RuntimeControlCallResult, finish_runtime_control_call},
    control_loopback::{
        RuntimeControlLifecyclePort, RuntimeControlOperation, RuntimeControlRequest,
        RuntimeControlRouteFragment, RuntimeControlRouteFuture, lifecycle_error_response,
        runtime_control_error_response,
    },
};
use serde_json::{Value, json};

use crate::driver::OpenClawDriver;

pub struct OpenClawRuntimeControlRoute {
    driver: Arc<OpenClawDriver>,
    lifecycle: Arc<dyn RuntimeControlLifecyclePort>,
}

impl OpenClawRuntimeControlRoute {
    pub fn new(
        driver: Arc<OpenClawDriver>,
        lifecycle: Arc<dyn RuntimeControlLifecyclePort>,
    ) -> Self {
        Self { driver, lifecycle }
    }
}

impl RuntimeControlRouteFragment for OpenClawRuntimeControlRoute {
    fn endpoint(&self) -> platform::endpoint::runtime_address::RuntimeEndpoint {
        RuntimeDriverIdentity::open_claw().endpoint()
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
            RuntimeControlOperation::Logs => Some(logs(Arc::clone(&self.driver), request)),
            RuntimeControlOperation::ControlReady => {
                Some(control_ready(Arc::clone(&self.driver), request))
            }
            RuntimeControlOperation::GatewayHealth => {
                Some(gateway_health(Arc::clone(&self.driver), request))
            }
            RuntimeControlOperation::GatewayStatus => {
                Some(gateway_status(Arc::clone(&self.driver), request))
            }
            RuntimeControlOperation::ControlUiUrl => {
                Some(control_ui_url(Arc::clone(&self.driver), request))
            }
        }
    }
}

fn lifecycle_status(
    lifecycle: Arc<dyn RuntimeControlLifecyclePort>,
    request: RuntimeControlRequest,
) -> RuntimeControlRouteFuture {
    Box::pin(async move {
        let result = lifecycle.lifecycle_status(request.endpoint.clone()).await;
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

async fn finish_read<T>(
    request: RuntimeControlRequest,
    result: &Result<T, RuntimeControlFailure>,
    mut detail: RuntimeControlCallDetail,
) {
    let (status, outcome) = match result {
        Ok(_) => (CallStatus::Succeeded, RuntimeControlCallResult::Succeeded),
        Err(RuntimeControlFailure::Unsupported) => {
            (CallStatus::Rejected, RuntimeControlCallResult::Unsupported)
        }
        Err(RuntimeControlFailure::Unavailable) => {
            (CallStatus::Failed, RuntimeControlCallResult::Unavailable)
        }
        Err(RuntimeControlFailure::Unknown) => {
            (CallStatus::Unknown, RuntimeControlCallResult::Unknown)
        }
    };
    detail.result = Some(outcome);
    finish_runtime_control_call(request.call, status, &detail).await;
}

fn logs(driver: Arc<OpenClawDriver>, request: RuntimeControlRequest) -> RuntimeControlRouteFuture {
    Box::pin(async move {
        let result = RuntimeControlOps::logs(driver.as_ref(), request.cursor).await;
        let mut detail = RuntimeControlCallDetail::new(&request.endpoint);
        detail.count = result.as_ref().ok().map(|logs| logs.entries.len());
        finish_read(request, &result, detail).await;
        match result {
            Ok(logs) => Response::json(200, project_logs(logs)),
            Err(error) => runtime_control_error_response(error),
        }
    })
}

fn control_ready(
    driver: Arc<OpenClawDriver>,
    request: RuntimeControlRequest,
) -> RuntimeControlRouteFuture {
    Box::pin(async move {
        let result = RuntimeControlOps::control_readiness(driver.as_ref()).await;
        let mut detail = RuntimeControlCallDetail::new(&request.endpoint);
        detail.ready = result
            .as_ref()
            .ok()
            .map(|ready| *ready == RuntimeControlReadiness::Ready);
        finish_read(request, &result, detail).await;
        match result {
            Ok(readiness) => Response::json(200, project_control_readiness(readiness)),
            Err(error) => runtime_control_error_response(error),
        }
    })
}

fn gateway_health(
    driver: Arc<OpenClawDriver>,
    request: RuntimeControlRequest,
) -> RuntimeControlRouteFuture {
    Box::pin(async move {
        let result =
            RuntimeControlOps::gateway_health(driver.as_ref(), request.probe.unwrap_or(false))
                .await;
        let mut detail = RuntimeControlCallDetail::new(&request.endpoint);
        detail.healthy = result.as_ref().ok().map(|health| health.ok);
        finish_read(request, &result, detail).await;
        match result {
            Ok(health) => Response::json(200, project_gateway_health(health)),
            Err(error) => runtime_control_error_response(error),
        }
    })
}

fn gateway_status(
    driver: Arc<OpenClawDriver>,
    request: RuntimeControlRequest,
) -> RuntimeControlRouteFuture {
    Box::pin(async move {
        let result = RuntimeControlOps::gateway_status(
            driver.as_ref(),
            request.include_channel_summary.unwrap_or(true),
        )
        .await;
        let mut detail = RuntimeControlCallDetail::new(&request.endpoint);
        detail.count = result.as_ref().ok().map(|status| status.session_count);
        finish_read(request, &result, detail).await;
        match result {
            Ok(status) => Response::json(200, project_gateway_status(status)),
            Err(error) => runtime_control_error_response(error),
        }
    })
}

fn control_ui_url(
    driver: Arc<OpenClawDriver>,
    request: RuntimeControlRequest,
) -> RuntimeControlRouteFuture {
    Box::pin(async move {
        let result = RuntimeControlOps::control_ui_url(driver.as_ref()).await;
        let detail = RuntimeControlCallDetail::new(&request.endpoint);
        finish_read(request, &result, detail).await;
        match result {
            Ok(url) => Response::json(200, json!({ "result": { "url": url } })),
            Err(error) => runtime_control_error_response(error),
        }
    })
}

fn project_logs(logs: RuntimeLogSnapshot) -> Value {
    let entries = logs
        .entries
        .into_iter()
        .map(|entry| json!({ "source": entry.source, "line": entry.line }))
        .collect::<Vec<_>>();
    json!({
        "result": {
            "entries": entries,
            "cursor": logs.cursor,
            "reset": logs.reset,
            "truncated": logs.truncated,
            "lifecycleTailEvicted": logs.lifecycle_tail_evicted,
        }
    })
}

fn project_control_readiness(readiness: RuntimeControlReadiness) -> Value {
    match readiness {
        RuntimeControlReadiness::Ready => json!({
            "ready": true,
            "phase": "ready",
            "retryable": false,
        }),
        RuntimeControlReadiness::Starting => json!({
            "ready": false,
            "phase": "starting",
            "retryable": true,
        }),
        RuntimeControlReadiness::Unavailable => json!({
            "ready": false,
            "phase": "unavailable",
            "retryable": false,
        }),
    }
}

fn project_gateway_health(health: RuntimeGatewayHealth) -> Value {
    json!({
        "result": {
            "ok": health.ok,
            "timestampMs": health.timestamp_ms,
            "durationMs": health.duration_ms,
            "channelCount": health.channel_count,
            "agentCount": health.agent_count,
            "sessionCount": health.session_count,
        }
    })
}

fn project_gateway_status(status: RuntimeGatewayStatus) -> Value {
    json!({
        "result": {
            "sessionCount": status.session_count,
            "channelCount": status.channel_count,
            "heartbeatEnabled": status.heartbeat_enabled,
        }
    })
}
