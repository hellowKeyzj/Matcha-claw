use foundation::execution::{OwnedTask, OwnerRuntimeConfig, OwnerRuntimeSystem};
use serde_json::Value;

use crate::{
    application::{
        commands::{SecurityCommand, SecurityOwnerUnavailable},
        queries::SecurityQuery,
    },
    audit as security_audit,
    delivery::Settlement as SecurityPolicyDeliverySettlement,
    emergency::SecurityEmergencyOutcome,
    operation as security_operation,
    owner::{SecurityOwner, SecurityOwnerInput},
};

#[derive(Clone)]
pub struct SecurityModule {
    pub(crate) handle: SecurityHandle,
}

impl SecurityModule {
    pub(crate) fn new(handle: SecurityHandle) -> Self {
        Self { handle }
    }

    pub async fn apply_saved_policy_projection(&self) -> Result<(), SecurityOwnerUnavailable> {
        self.handle.apply_saved_policy_projection().await
    }

    pub async fn recover_pending(&self) -> Result<(), SecurityOwnerUnavailable> {
        self.handle.recover_pending().await
    }
}

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

    pub(crate) async fn current_policy(&self) -> Result<Value, SecurityOwnerUnavailable> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner
            .send_query(SecurityQuery::CurrentPolicy { reply })
            .await
            .map_err(|_| SecurityOwnerUnavailable)?;
        reply_rx
            .await
            .map_err(|_| SecurityOwnerUnavailable)?
            .map_err(|_| SecurityOwnerUnavailable)
    }

    pub(crate) async fn apply_saved_policy_projection(
        &self,
    ) -> Result<(), SecurityOwnerUnavailable> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner
            .send_command(SecurityCommand::ApplySavedPolicyProjection { reply })
            .await
            .map_err(|_| SecurityOwnerUnavailable)?;
        reply_rx
            .await
            .map_err(|_| SecurityOwnerUnavailable)?
            .map_err(|_| SecurityOwnerUnavailable)
    }

    pub(crate) async fn replace_policy(
        &self,
        correlation: String,
        policy: Value,
    ) -> Result<SecurityPolicyDeliverySettlement, SecurityOwnerUnavailable> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner
            .send_command(SecurityCommand::ReplacePolicy {
                correlation,
                policy,
                reply,
            })
            .await
            .map_err(|_| SecurityOwnerUnavailable)?;
        reply_rx.await.map_err(|_| SecurityOwnerUnavailable)
    }

    pub(crate) async fn recover_pending(&self) -> Result<(), SecurityOwnerUnavailable> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner
            .send_command(SecurityCommand::RecoverPending { reply })
            .await
            .map_err(|_| SecurityOwnerUnavailable)?;
        reply_rx.await.map_err(|_| SecurityOwnerUnavailable)
    }

    pub(crate) async fn emergency(
        &self,
        correlation: String,
    ) -> Result<SecurityEmergencyOutcome, SecurityOwnerUnavailable> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner
            .send_command(SecurityCommand::Emergency { correlation, reply })
            .await
            .map_err(|_| SecurityOwnerUnavailable)?;
        reply_rx.await.map_err(|_| SecurityOwnerUnavailable)
    }

    pub(crate) async fn audit(
        &self,
        query: security_audit::Query,
    ) -> Result<security_audit::Outcome, SecurityOwnerUnavailable> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner
            .send_query(SecurityQuery::Audit { query, reply })
            .await
            .map_err(|_| SecurityOwnerUnavailable)?;
        reply_rx.await.map_err(|_| SecurityOwnerUnavailable)
    }

    pub(crate) async fn operation(
        &self,
        correlation: String,
        operation_id: String,
        input: Value,
    ) -> Result<security_operation::Outcome, SecurityOwnerUnavailable> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner
            .send_command(SecurityCommand::Operation {
                correlation,
                operation_id,
                input,
                reply,
            })
            .await
            .map_err(|_| SecurityOwnerUnavailable)?;
        reply_rx.await.map_err(|_| SecurityOwnerUnavailable)
    }
}

pub fn spawn_owner(
    system: &OwnerRuntimeSystem,
    input: SecurityOwnerInput,
) -> Result<(SecurityModule, OwnedTask<()>), ()> {
    let owner = SecurityOwner::new(input)?;
    let (handle, task) = system.spawn_owner(
        owner,
        OwnerRuntimeConfig::new(64, SecurityOwner::lane_retention()),
    );
    Ok((SecurityModule::new(SecurityHandle::new(handle)), task))
}
