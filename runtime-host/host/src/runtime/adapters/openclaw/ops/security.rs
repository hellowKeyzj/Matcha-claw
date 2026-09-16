use super::*;

impl SecurityOps for OpenClawInstance {
    fn apply_security_policy_projection<'a>(
        &'a self,
        policy: Value,
    ) -> SessionFuture<'a, Result<(), crate::runtime::driver::RuntimeOperationFailure>> {
        Box::pin(async move {
            let runtime = policy
                .get("runtime")
                .and_then(Value::as_object)
                .ok_or(crate::runtime::driver::RuntimeOperationFailure::TargetRejected)?;
            openclaw::projection::security::apply_normalized(self.state_dir.clone(), runtime)
                .map(|_| ())
                .map_err(|_| crate::runtime::driver::RuntimeOperationFailure::Unknown)
        })
    }

    fn sync_security_policy<'a>(
        &'a self,
        policy: Value,
    ) -> SessionFuture<'a, openclaw::operations::SecurityPolicyEffect> {
        Box::pin(async move { self.gateway.lock().await.sync_security_policy(policy).await })
    }

    fn run_security_emergency<'a>(
        &'a self,
    ) -> SessionFuture<'a, openclaw::operations::SecurityEmergencyEffect> {
        Box::pin(async move { self.gateway.lock().await.run_security_emergency().await })
    }

    fn query_security_audit<'a>(
        &'a self,
        query: openclaw::operations::security_audit::SecurityAuditQuery,
    ) -> SessionFuture<'a, openclaw::operations::security_audit::SecurityAuditEffect> {
        Box::pin(async move { self.gateway.lock().await.query_security_audit(query).await })
    }

    fn security_operation<'a>(
        &'a self,
        operation_id: String,
        input: Value,
    ) -> SessionFuture<'a, openclaw::operations::SecurityActionEffect> {
        Box::pin(async move {
            self.gateway
                .lock()
                .await
                .security_operation(&operation_id, input)
                .await
        })
    }
}
