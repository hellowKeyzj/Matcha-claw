use runtime_directory::{
    RuntimeControlLifecycleError, RuntimeControlLifecycleStatus,
    control_loopback::{RuntimeControlLifecycleFuture, RuntimeControlLifecyclePort},
};

use super::{PeerHandle, status::runtime_control_status};

impl openclaw::gateway::loopback::OpenClawGatewayCapabilityPort for PeerHandle {
    fn browser_request(
        &self,
        request: openclaw::gateway::request::OpenClawBrowserGatewayRequest,
        call: Option<openclaw::gateway::loopback::GatewayCallContext>,
    ) -> openclaw::gateway::loopback::OpenClawGatewayCapabilityFuture<
        Result<openclaw::port::OpenClawGatewayRequestOutcome, ()>,
    > {
        let peer = self.clone();
        Box::pin(async move {
            peer.open_claw_browser_request(request, call)
                .await
                .map_err(|_| ())
        })
    }

    fn mcp_app_request(
        &self,
        request: openclaw::gateway::request::OpenClawMcpAppGatewayRequest,
        call: Option<openclaw::gateway::loopback::GatewayCallContext>,
    ) -> openclaw::gateway::loopback::OpenClawGatewayCapabilityFuture<
        Result<openclaw::port::OpenClawGatewayRequestOutcome, ()>,
    > {
        let peer = self.clone();
        Box::pin(async move {
            peer.open_claw_mcp_app_request(request, call)
                .await
                .map_err(|_| ())
        })
    }

    fn question_list(
        &self,
        request: openclaw::gateway::request::OpenClawQuestionListGatewayRequest,
    ) -> openclaw::gateway::loopback::OpenClawGatewayCapabilityFuture<
        Result<openclaw::port::OpenClawGatewayRequestOutcome, ()>,
    > {
        let peer = self.clone();
        Box::pin(async move { peer.open_claw_question_list(request).await.map_err(|_| ()) })
    }

    fn question_resolve(
        &self,
        request: openclaw::gateway::request::OpenClawQuestionResolveGatewayRequest,
        call: Option<openclaw::gateway::loopback::GatewayCallContext>,
    ) -> openclaw::gateway::loopback::OpenClawGatewayCapabilityFuture<
        Result<openclaw::port::OpenClawGatewayRequestOutcome, ()>,
    > {
        let peer = self.clone();
        Box::pin(async move {
            peer.open_claw_question_resolve(request, call)
                .await
                .map_err(|_| ())
        })
    }
}

impl RuntimeControlLifecyclePort for PeerHandle {
    fn repair_status<'a>(
        &'a self,
        endpoint: platform::endpoint::runtime_address::RuntimeEndpoint,
    ) -> RuntimeControlLifecycleFuture<'a, Result<runtime_directory::RuntimeRepairSnapshot, RuntimeControlLifecycleError>> {
        Box::pin(async move {
            if endpoint != runtime_directory::RuntimeDriverIdentity::open_claw().endpoint() {
                return Err(RuntimeControlLifecycleError::Unsupported);
            }
            self.runtime_repair_status().await.map_err(|_| RuntimeControlLifecycleError::Unavailable)
        })
    }

    fn admit_lifecycle_repair<'a>(
        &'a self,
        endpoint: platform::endpoint::runtime_address::RuntimeEndpoint,
        call: runtime_directory::call::RuntimeControlCallContext,
    ) -> RuntimeControlLifecycleFuture<'a, Result<platform::call::CallReceipt, RuntimeControlLifecycleError>> {
        Box::pin(self.admit_runtime_repair(endpoint, call))
    }

    fn lifecycle_status<'a>(
        &'a self,
        endpoint: platform::endpoint::runtime_address::RuntimeEndpoint,
    ) -> RuntimeControlLifecycleFuture<
        'a,
        Result<RuntimeControlLifecycleStatus, RuntimeControlLifecycleError>,
    > {
        Box::pin(async move {
            let state = self
                .state()
                .await
                .map_err(|_| RuntimeControlLifecycleError::Unavailable)?;
            if endpoint == runtime_directory::RuntimeDriverIdentity::open_claw().endpoint() {
                return Ok(runtime_control_status(state.open_claw()));
            }
            if endpoint == runtime_directory::RuntimeDriverIdentity::matcha_agent().endpoint() {
                return Ok(runtime_control_status(state.matcha()));
            }
            Err(RuntimeControlLifecycleError::Unsupported)
        })
    }

    fn admit_lifecycle_start<'a>(
        &'a self,
        endpoint: platform::endpoint::runtime_address::RuntimeEndpoint,
        call: runtime_directory::call::RuntimeControlCallContext,
    ) -> RuntimeControlLifecycleFuture<
        'a,
        Result<platform::call::CallReceipt, RuntimeControlLifecycleError>,
    > {
        Box::pin(self.admit_runtime_start(endpoint, call))
    }

    fn admit_lifecycle_stop<'a>(
        &'a self,
        endpoint: platform::endpoint::runtime_address::RuntimeEndpoint,
        call: runtime_directory::call::RuntimeControlCallContext,
    ) -> RuntimeControlLifecycleFuture<
        'a,
        Result<platform::call::CallReceipt, RuntimeControlLifecycleError>,
    > {
        Box::pin(self.admit_runtime_stop(endpoint, call))
    }

    fn admit_lifecycle_restart<'a>(
        &'a self,
        endpoint: platform::endpoint::runtime_address::RuntimeEndpoint,
        call: runtime_directory::call::RuntimeControlCallContext,
    ) -> RuntimeControlLifecycleFuture<
        'a,
        Result<platform::call::CallReceipt, RuntimeControlLifecycleError>,
    > {
        Box::pin(self.admit_runtime_restart(endpoint, call))
    }
}
