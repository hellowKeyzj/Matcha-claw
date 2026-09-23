use serde_json::Value;

use crate::port::OpenClawGateway;
use crate::surfaces::security::gateway::{
    SecurityActionEffect, SecurityActionsOperation, SecurityEmergencyEffect,
    SecurityEmergencyOperation, SecurityMonitorEffect, SecurityMonitorOperation,
    SecurityPolicyEffect, SecurityPolicyOperation,
    audit::{SecurityAuditEffect, SecurityAuditOperation, SecurityAuditQuery},
};

impl OpenClawGateway {
    pub async fn run_security_emergency(&self) -> SecurityEmergencyEffect {
        SecurityEmergencyOperation::new(self.client()).run().await
    }

    pub async fn query_security_audit(&self, query: SecurityAuditQuery) -> SecurityAuditEffect {
        SecurityAuditOperation::new(self.client())
            .query(query)
            .await
    }

    pub async fn sync_security_policy(&self, policy: Value) -> SecurityPolicyEffect {
        SecurityPolicyOperation::new(self.client())
            .sync(policy)
            .await
    }

    pub async fn security_operation(
        &self,
        operation_id: &str,
        input: Value,
    ) -> SecurityActionEffect {
        SecurityActionsOperation::new(self.client())
            .run(operation_id, input)
            .await
    }

    pub async fn observe_security_monitor_status(&self) -> SecurityMonitorEffect {
        SecurityMonitorOperation::new(self.client()).observe().await
    }
}
