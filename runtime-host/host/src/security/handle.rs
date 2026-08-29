use serde_json::Value;

use crate::{
    composition::{HostPhase, RequestAdmissionClosed},
    security_audit, security_delivery,
    security_emergency::SecurityEmergencyOutcome,
    security_operation,
};

use super::{command::SecurityCommand, query::SecurityQuery};

#[derive(Clone)]
pub(crate) struct SecurityHandle {
    owner: foundation::execution::OwnerRuntimeHandle<SecurityCommand, SecurityQuery>,
}

impl SecurityHandle {
    pub(crate) fn new(
        owner: foundation::execution::OwnerRuntimeHandle<SecurityCommand, SecurityQuery>,
    ) -> Self {
        Self { owner }
    }

    pub(crate) async fn current_policy(&self) -> Result<Value, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner
            .send_query(SecurityQuery::CurrentPolicy { reply })
            .await
            .map_err(|_| owner_closed())?;
        reply_rx
            .await
            .map_err(|_| owner_closed())?
            .map_err(|_| owner_closed())
    }

    pub(crate) async fn apply_saved_policy_projection(&self) -> Result<(), RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner
            .send_command(SecurityCommand::ApplySavedPolicyProjection { reply })
            .await
            .map_err(|_| owner_closed())?;
        reply_rx
            .await
            .map_err(|_| owner_closed())?
            .map_err(|_| owner_closed())
    }

    pub(crate) async fn replace_policy(
        &self,
        correlation: String,
        policy: Value,
    ) -> Result<security_delivery::Settlement, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner
            .send_command(SecurityCommand::ReplacePolicy {
                correlation,
                policy,
                reply,
            })
            .await
            .map_err(|_| owner_closed())?;
        reply_rx.await.map_err(|_| owner_closed())
    }

    pub(crate) async fn recover_pending(&self) -> Result<(), RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner
            .send_command(SecurityCommand::RecoverPending { reply })
            .await
            .map_err(|_| owner_closed())?;
        reply_rx.await.map_err(|_| owner_closed())
    }

    pub(crate) async fn emergency(
        &self,
        correlation: String,
    ) -> Result<SecurityEmergencyOutcome, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner
            .send_command(SecurityCommand::Emergency { correlation, reply })
            .await
            .map_err(|_| owner_closed())?;
        reply_rx.await.map_err(|_| owner_closed())
    }

    pub(crate) async fn audit(
        &self,
        query: security_audit::Query,
    ) -> Result<security_audit::Outcome, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner
            .send_query(SecurityQuery::Audit { query, reply })
            .await
            .map_err(|_| owner_closed())?;
        reply_rx.await.map_err(|_| owner_closed())
    }

    pub(crate) async fn operation(
        &self,
        correlation: String,
        operation_id: String,
        input: Value,
    ) -> Result<security_operation::Outcome, RequestAdmissionClosed> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner
            .send_command(SecurityCommand::Operation {
                correlation,
                operation_id,
                input,
                reply,
            })
            .await
            .map_err(|_| owner_closed())?;
        reply_rx.await.map_err(|_| owner_closed())
    }
}

fn owner_closed() -> RequestAdmissionClosed {
    RequestAdmissionClosed::new(HostPhase::ShutDown)
}
