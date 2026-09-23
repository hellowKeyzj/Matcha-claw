use ::security::ports::SecurityOps;
use serde_json::Value;

use crate::driver::OpenClawDriver;

impl SecurityOps for OpenClawDriver {
    fn apply_security_policy_projection<'a>(
        &'a self,
        policy: Value,
    ) -> ::security::ports::SecurityFuture<'a, Result<(), ::security::ports::SecurityRuntimeFailure>>
    {
        Box::pin(async move {
            crate::surfaces::security::apply_policy_projection(self.state_dir.clone(), policy)
        })
    }

    fn sync_security_policy<'a>(
        &'a self,
        policy: Value,
    ) -> ::security::ports::SecurityFuture<'a, ::security::delivery::Outcome> {
        Box::pin(async move {
            let gateway = self.gateway.lock().await;
            crate::surfaces::security::sync_policy(&gateway, policy).await
        })
    }

    fn run_security_emergency<'a>(
        &'a self,
    ) -> ::security::ports::SecurityFuture<'a, ::security::emergency::SecurityEmergencyOutcome>
    {
        Box::pin(async move {
            let gateway = self.gateway.lock().await;
            crate::surfaces::security::run_emergency(&gateway).await
        })
    }

    fn query_security_audit<'a>(
        &'a self,
        query: ::security::audit::Query,
    ) -> ::security::ports::SecurityFuture<'a, ::security::audit::Outcome> {
        Box::pin(async move {
            let gateway = self.gateway.lock().await;
            crate::surfaces::security::query_audit(&gateway, query).await
        })
    }

    fn security_operation<'a>(
        &'a self,
        operation_id: String,
        input: Value,
    ) -> ::security::ports::SecurityFuture<'a, ::security::operation::Outcome> {
        Box::pin(async move {
            let gateway = self.gateway.lock().await;
            crate::surfaces::security::run_operation(&gateway, operation_id, input).await
        })
    }
}
