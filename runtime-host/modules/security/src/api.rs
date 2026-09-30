use foundation::execution::{OwnedTask, OwnerRuntimeConfig, OwnerRuntimeSystem};
use platform::call::{CallContext, CallRecorder, CallReceipt, CallStatus};
use serde_json::Value;

use crate::{
    application::{
        call::{Effect, SecurityCall, SecurityCallDetail, SecurityOperation},
        commands::{SecurityCommand, SecurityOwnerUnavailable},
        queries::SecurityQuery,
    },
    audit as security_audit,
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

    pub fn with_call_recorder(mut self, recorder: CallRecorder) -> Self {
        self.handle.recorder = Some(recorder);
        self
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
    recorder: Option<CallRecorder>,
}

impl SecurityHandle {
    pub(crate) fn new(
        owner: foundation::execution::OwnerRuntimeHandle<SecurityCommand, SecurityQuery>,
    ) -> Self {
        Self { owner, recorder: None }
    }

    pub(crate) async fn begin_call(
        &self,
        command: &'static str,
        detail: &SecurityCallDetail,
    ) -> Result<CallContext<SecurityCallDetail>, SecurityOwnerUnavailable> {
        self.recorder.as_ref().ok_or(SecurityOwnerUnavailable)?
            .begin(command, detail).await.map_err(|_| SecurityOwnerUnavailable)
    }

    pub(crate) async fn current_policy(&self) -> Result<Value, SecurityOwnerUnavailable> {
        let detail = SecurityCallDetail::PolicyRead;
        let context = self.begin_call("security.policy.read", &detail).await?;
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        if self.owner.try_send_query(SecurityQuery::CurrentPolicy { reply, context: context.clone() }).is_err() {
            let _ = context.finish(CallStatus::Rejected, &detail).await;
            return Err(SecurityOwnerUnavailable);
        }
        context.accepted().await.map_err(|_| SecurityOwnerUnavailable)?;
        reply_rx.await.map_err(|_| SecurityOwnerUnavailable)?
            .map_err(|_| SecurityOwnerUnavailable)
    }

    pub(crate) async fn apply_saved_policy_projection(&self) -> Result<(), SecurityOwnerUnavailable> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner.send_command(SecurityCommand::ApplySavedPolicyProjection { reply }).await
            .map_err(|_| SecurityOwnerUnavailable)?;
        reply_rx.await.map_err(|_| SecurityOwnerUnavailable)?
            .map_err(|_| SecurityOwnerUnavailable)
    }

    pub(crate) async fn replace_policy(
        &self,
        correlation: String,
        policy: Value,
    ) -> Result<CallReceipt, SecurityOwnerUnavailable> {
        let detail = SecurityCallDetail::PolicyReplace {
            correlation: correlation.clone(), revision: None, effect: None,
        };
        let context = self.begin_call("security.replace", &detail).await?;
        let command = SecurityCommand::ReplacePolicy {
            correlation, policy, call: SecurityCall { context: context.clone(), detail: detail.clone() },
        };
        self.admit(command, &context, &detail).await
    }

    pub(crate) async fn recover_pending(&self) -> Result<(), SecurityOwnerUnavailable> {
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        self.owner.send_command(SecurityCommand::RecoverPending { reply }).await
            .map_err(|_| SecurityOwnerUnavailable)?;
        reply_rx.await.map_err(|_| SecurityOwnerUnavailable)
    }

    pub(crate) async fn emergency(
        &self,
        correlation: String,
    ) -> Result<CallReceipt, SecurityOwnerUnavailable> {
        let detail = SecurityCallDetail::Emergency { correlation: correlation.clone(), outcome: None };
        let context = self.begin_call("security.emergency", &detail).await?;
        let command = SecurityCommand::Emergency {
            correlation, call: SecurityCall { context: context.clone(), detail: detail.clone() },
        };
        self.admit(command, &context, &detail).await
    }

    async fn admit(
        &self,
        command: SecurityCommand,
        context: &CallContext<SecurityCallDetail>,
        detail: &SecurityCallDetail,
    ) -> Result<CallReceipt, SecurityOwnerUnavailable> {
        if self.owner.try_send_command(command).is_err() {
            let _ = context.finish(CallStatus::Rejected, detail).await;
            return Err(SecurityOwnerUnavailable);
        }
        context.accepted().await.map_err(|_| SecurityOwnerUnavailable)
    }

    pub(crate) async fn audit(
        &self,
        query: security_audit::Query,
    ) -> Result<security_audit::Outcome, SecurityOwnerUnavailable> {
        let detail = SecurityCallDetail::Audit {
            page: query.page, page_size: query.page_size, total: None, outcome: None,
        };
        let context = self.begin_call("security.audit.read", &detail).await?;
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        if self.owner.try_send_query(SecurityQuery::Audit {
            query, reply, context: context.clone(),
        }).is_err() {
            let _ = context.finish(CallStatus::Rejected, &detail).await;
            return Err(SecurityOwnerUnavailable);
        }
        context.accepted().await.map_err(|_| SecurityOwnerUnavailable)?;
        reply_rx.await.map_err(|_| SecurityOwnerUnavailable)
    }

    pub(crate) async fn operation(
        &self,
        correlation: String,
        operation_id: String,
        input: Value,
    ) -> Result<CallReceipt, SecurityOwnerUnavailable> {
        let operation = SecurityOperation::parse(&operation_id).ok_or(SecurityOwnerUnavailable)?;
        let detail = SecurityCallDetail::Operation {
            correlation: correlation.clone(), operation, outcome: None,
        };
        let context = self.begin_call(operation.command(), &detail).await?;
        let command = SecurityCommand::Operation {
            correlation, operation_id, input,
            call: SecurityCall { context: context.clone(), detail: detail.clone() },
        };
        self.admit(command, &context, &detail).await
    }

    pub(crate) async fn operation_receipt(
        &self,
        correlation: String,
    ) -> Result<Option<security_operation::Outcome>, SecurityOwnerUnavailable> {
        let detail = SecurityCallDetail::OperationReceipt { correlation: correlation.clone() };
        let context = self.begin_call("security.operation.receipt", &detail).await?;
        let (reply, reply_rx) = tokio::sync::oneshot::channel();
        if self.owner.try_send_query(SecurityQuery::OperationReceipt { correlation, reply, context: context.clone() }).is_err() {
            let _ = context.finish(CallStatus::Rejected, &detail).await;
            return Err(SecurityOwnerUnavailable);
        }
        context.accepted().await.map_err(|_| SecurityOwnerUnavailable)?;
        reply_rx.await.map_err(|_| SecurityOwnerUnavailable)?
            .map_err(|_| SecurityOwnerUnavailable)
    }

    pub(crate) async fn rule_catalog_call(&self) -> Result<(), SecurityOwnerUnavailable> {
        let context = self.begin_call("security.ruleCatalog.read", &SecurityCallDetail::RuleCatalog).await?;
        context.running().await.map_err(|_| SecurityOwnerUnavailable)?;
        context.finish(Effect::Confirmed.status(), &SecurityCallDetail::RuleCatalog).await
            .map_err(|_| SecurityOwnerUnavailable)?;
        Ok(())
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
