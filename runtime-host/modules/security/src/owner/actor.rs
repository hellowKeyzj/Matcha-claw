use std::sync::Arc;

use foundation::execution::{CommandRoute, LaneRetention, OwnerSpec, QueryRoute};
use serde_json::Value;

use crate::{
    adapters::store::{SecurityOperationReceiptStore, SecurityPolicyDeliveryStore},
    application::{
        call::{Effect, EmergencyEffect, SecurityCallDetail},
        commands::SecurityCommand, queries::SecurityQuery,
    },
    audit as security_audit,
    delivery::{
        Outcome as SecurityPolicyDeliveryOutcome, Settlement as SecurityPolicyDeliverySettlement,
    },
    domain::model::{SecurityPolicyDesired, emergency_lockdown},
    emergency::SecurityEmergencyOutcome,
    operation as security_operation,
    ports::{SecurityRuntimeDirectory, SecurityRuntimeFailure},
};

#[allow(dead_code)]
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum SecurityPartitionKey {
    Global,
}

#[derive(Clone)]
pub struct SecurityShared {
    runtime_directory: Arc<dyn SecurityRuntimeDirectory>,
    operation_receipts: Arc<SecurityOperationReceiptStore>,
}

pub struct SecurityGlobalState {
    policy_delivery: SecurityPolicyDeliveryStore,
    operation_receipts: Arc<SecurityOperationReceiptStore>,
    serialized_effect: tokio::sync::Mutex<()>,
}

pub struct SecurityOwnerInput {
    pub state_dir: std::path::PathBuf,
    pub runtime_directory: Arc<dyn SecurityRuntimeDirectory>,
}

pub struct SecurityOwner {
    shared: SecurityShared,
    state: SecurityGlobalState,
}

impl SecurityOwner {
    pub fn new(input: SecurityOwnerInput) -> Result<Self, ()> {
        let operation_receipts = Arc::new(SecurityOperationReceiptStore::open(&input.state_dir)?);
        Ok(Self {
            shared: SecurityShared {
                runtime_directory: input.runtime_directory,
                operation_receipts: operation_receipts.clone(),
            },
            state: SecurityGlobalState {
                policy_delivery: SecurityPolicyDeliveryStore::open(&input.state_dir)?,
                operation_receipts,
                serialized_effect: tokio::sync::Mutex::new(()),
            },
        })
    }

    pub fn lane_retention() -> LaneRetention {
        LaneRetention::LowFrequency
    }
}

impl SecurityGlobalState {
    async fn current_policy(&self) -> Result<Value, ()> {
        self.policy_delivery.policy()
    }

    async fn apply_saved_policy_projection(&self, shared: &SecurityShared) -> Result<(), ()> {
        let policy = self.policy_delivery.policy()?;
        self.apply_policy_projection(shared, policy)
            .await
            .map_err(|_| ())
    }

    async fn recover_pending(&self, shared: &SecurityShared) {
        self.serialize_effect(async {
            let Ok(Some((revision, desired))) = self.policy_delivery.pending() else {
                return;
            };
            let outcome = self.apply_policy_sync_effect(shared, desired).await;
            let _ = self
                .policy_delivery
                .settle(SecurityPolicyDeliverySettlement { revision, outcome });
        })
        .await;
        let _ = self.operation_receipts.recover_pending();
    }

    async fn replace_policy(
        &self,
        shared: &SecurityShared,
        correlation: String,
        policy: Value,
    ) -> SecurityPolicyDeliverySettlement {
        let desired = match SecurityPolicyDesired::try_from_wire(&policy) {
            Ok(desired) => desired,
            Err(()) => {
                return SecurityPolicyDeliverySettlement {
                    revision: 0,
                    outcome: SecurityPolicyDeliveryOutcome::Unknown,
                };
            }
        };

        self.serialize_effect(async {
            let (revision, prior_outcome) =
                match self.policy_delivery.replace(&correlation, desired) {
                    Ok(result) => result,
                    Err(()) => {
                        return SecurityPolicyDeliverySettlement {
                            revision: 0,
                            outcome: SecurityPolicyDeliveryOutcome::Unknown,
                        };
                    }
                };

            if let Some(outcome) = prior_outcome {
                return SecurityPolicyDeliverySettlement { revision, outcome };
            }

            let outcome = match self.policy_delivery.pending() {
                Ok(Some((pending_revision, pending))) if pending_revision == revision => {
                    self.apply_policy_sync_effect(shared, pending).await
                }
                _ => SecurityPolicyDeliveryOutcome::Unknown,
            };
            let settlement = SecurityPolicyDeliverySettlement { revision, outcome };
            if self.policy_delivery.settle(settlement).is_err() {
                return SecurityPolicyDeliverySettlement { revision, outcome: SecurityPolicyDeliveryOutcome::Unknown };
            }
            settlement
        })
        .await
    }

    async fn emergency(
        &self,
        shared: &SecurityShared,
        correlation: String,
    ) -> SecurityEmergencyOutcome {
        self.serialize_effect(async {
            let desired = match self.policy_delivery.policy().and_then(emergency_lockdown) {
                Ok(desired) => desired,
                Err(()) => return SecurityEmergencyOutcome::Unavailable,
            };

            let (revision, prior_outcome) =
                match self.policy_delivery.replace(&correlation, desired) {
                    Ok(result) => result,
                    Err(()) => return SecurityEmergencyOutcome::Unavailable,
                };

            if prior_outcome
                .is_some_and(|outcome| outcome != SecurityPolicyDeliveryOutcome::Confirmed)
            {
                return SecurityEmergencyOutcome::OutcomeUnknown;
            }

            let outcome = match self.policy_delivery.pending() {
                Ok(Some((pending_revision, pending))) if pending_revision == revision => {
                    self.apply_policy_restart_effect(shared, pending).await
                }
                Ok(None) if prior_outcome == Some(SecurityPolicyDeliveryOutcome::Confirmed) => {
                    SecurityPolicyDeliveryOutcome::Confirmed
                }
                _ => SecurityPolicyDeliveryOutcome::Unknown,
            };
            if self.policy_delivery.settle(SecurityPolicyDeliverySettlement { revision, outcome }).is_err() {
                return SecurityEmergencyOutcome::OutcomeUnknown;
            }

            if outcome != SecurityPolicyDeliveryOutcome::Confirmed {
                return SecurityEmergencyOutcome::OutcomeUnknown;
            }

            self.run_security_emergency(shared)
                .await
                .unwrap_or(SecurityEmergencyOutcome::OutcomeUnknown)
        })
        .await
    }

    async fn operation(
        &self,
        shared: &SecurityShared,
        correlation: String,
        operation_id: String,
        input: Value,
    ) -> security_operation::Outcome {
        self.serialize_effect(async {
            let prior = match self.operation_receipts.begin(&correlation) {
                Ok(prior) => prior,
                Err(()) => return security_operation::Outcome::Unknown,
            };
            if let Some(outcome) = prior {
                return outcome;
            }

            let outcome = self
                .run_security_operation(shared, operation_id, input)
                .await
                .unwrap_or(security_operation::Outcome::Unavailable);
            if self.operation_receipts.settle(&correlation, outcome.clone()).is_err() {
                return security_operation::Outcome::Unknown;
            }
            outcome
        })
        .await
    }

    async fn apply_policy_sync_effect(
        &self,
        shared: &SecurityShared,
        desired: SecurityPolicyDesired,
    ) -> SecurityPolicyDeliveryOutcome {
        let policy = desired.into_policy();
        match self.apply_policy_projection(shared, policy.clone()).await {
            Ok(()) => {}
            Err(SecurityRuntimeFailure::TargetRejected) => {
                return SecurityPolicyDeliveryOutcome::Rejected;
            }
            Err(_) => return SecurityPolicyDeliveryOutcome::Unknown,
        }
        if !self.restart_security_runtime(shared).await {
            return SecurityPolicyDeliveryOutcome::Unknown;
        }
        self.sync_security_policy(shared, policy)
            .await
            .unwrap_or(SecurityPolicyDeliveryOutcome::Unknown)
    }

    async fn apply_policy_restart_effect(
        &self,
        shared: &SecurityShared,
        desired: SecurityPolicyDesired,
    ) -> SecurityPolicyDeliveryOutcome {
        let policy = desired.into_policy();
        match self.apply_policy_projection(shared, policy).await {
            Ok(()) => {}
            Err(SecurityRuntimeFailure::TargetRejected) => {
                return SecurityPolicyDeliveryOutcome::Rejected;
            }
            Err(_) => return SecurityPolicyDeliveryOutcome::Unknown,
        }
        if self.restart_security_runtime(shared).await {
            SecurityPolicyDeliveryOutcome::Confirmed
        } else {
            SecurityPolicyDeliveryOutcome::Unknown
        }
    }

    async fn serialize_effect<T>(&self, operation: impl std::future::Future<Output = T>) -> T {
        let _effect = self.serialized_effect.lock().await;
        operation.await
    }

    async fn apply_policy_projection(
        &self,
        shared: &SecurityShared,
        policy: Value,
    ) -> Result<(), SecurityRuntimeFailure> {
        let security = shared
            .security_ops()
            .ok_or(SecurityRuntimeFailure::Unavailable)?;
        security.apply_security_policy_projection(policy).await
    }

    async fn restart_security_runtime(&self, shared: &SecurityShared) -> bool {
        shared.runtime_directory.restart_security_runtime().await
    }

    async fn sync_security_policy(
        &self,
        shared: &SecurityShared,
        policy: Value,
    ) -> Option<SecurityPolicyDeliveryOutcome> {
        Some(shared.security_ops()?.sync_security_policy(policy).await)
    }

    async fn run_security_emergency(
        &self,
        shared: &SecurityShared,
    ) -> Option<SecurityEmergencyOutcome> {
        Some(shared.security_ops()?.run_security_emergency().await)
    }

    async fn run_security_operation(
        &self,
        shared: &SecurityShared,
        operation_id: String,
        input: Value,
    ) -> Option<security_operation::Outcome> {
        Some(
            shared
                .security_ops()?
                .security_operation(operation_id, input)
                .await,
        )
    }
}

impl SecurityShared {
    fn security_ops(&self) -> Option<&dyn crate::ports::SecurityOps> {
        self.runtime_directory.security_ops()
    }
}

impl OwnerSpec for SecurityOwner {
    type Command = SecurityCommand;
    type Query = SecurityQuery;
    type Key = SecurityPartitionKey;
    type Shared = SecurityShared;
    type GlobalState = SecurityGlobalState;
    type LaneState = ();

    fn split(self) -> (Self::Shared, Self::GlobalState) {
        (self.shared, self.state)
    }

    fn route_command(_command: &Self::Command) -> CommandRoute<Self::Key> {
        CommandRoute::Global
    }

    fn route_query(query: &Self::Query) -> QueryRoute<Self::Key> {
        query.route()
    }

    fn open_lane(_shared: &Self::Shared, _key: &Self::Key) -> Self::LaneState {}

    async fn handle_keyed_command(
        _shared: Self::Shared,
        _key: Self::Key,
        _lane: &mut Self::LaneState,
        _command: Self::Command,
    ) {
    }

    async fn handle_global_command(
        shared: Self::Shared,
        state: &mut Self::GlobalState,
        command: Self::Command,
    ) {
        match command {
            SecurityCommand::ApplySavedPolicyProjection { reply } => {
                let _ = reply.send(state.apply_saved_policy_projection(&shared).await);
            }
            SecurityCommand::ReplacePolicy { correlation, policy, call } => {
                if call.running().await.is_err() {
                    call.finish(&call.detail, Effect::Unknown).await;
                    return;
                }
                let settlement = state.replace_policy(&shared, correlation.clone(), policy).await;
                let effect = match settlement.outcome {
                    SecurityPolicyDeliveryOutcome::Confirmed => Effect::Confirmed,
                    SecurityPolicyDeliveryOutcome::Rejected => Effect::Rejected,
                    SecurityPolicyDeliveryOutcome::Unknown => Effect::Unknown,
                };
                call.finish(&SecurityCallDetail::PolicyReplace {
                    correlation, revision: Some(settlement.revision), effect: Some(effect),
                }, effect).await;
            }
            SecurityCommand::RecoverPending { reply } => {
                state.recover_pending(&shared).await;
                let _ = reply.send(());
            }
            SecurityCommand::Emergency { correlation, call } => {
                if call.running().await.is_err() {
                    call.finish(&call.detail, Effect::Unknown).await;
                    return;
                }
                let outcome = match state.emergency(&shared, correlation.clone()).await {
                    SecurityEmergencyOutcome::Applied => EmergencyEffect::Applied,
                    SecurityEmergencyOutcome::Rejected => EmergencyEffect::TargetRejected,
                    SecurityEmergencyOutcome::OutcomeUnknown => EmergencyEffect::OutcomeUnknown,
                    SecurityEmergencyOutcome::Unavailable => EmergencyEffect::Unavailable,
                };
                call.finish(&SecurityCallDetail::Emergency {
                    correlation, outcome: Some(outcome),
                }, outcome.effect()).await;
            }
            SecurityCommand::Operation {
                correlation,
                operation_id,
                input,
                call,
            } => {
                if call.running().await.is_err() {
                    call.finish(&call.detail, Effect::Unknown).await;
                    return;
                }
                let outcome = state.operation(&shared, correlation, operation_id, input).await;
                let effect = match &outcome {
                    security_operation::Outcome::Confirmed(_) => Effect::Confirmed,
                    security_operation::Outcome::Rejected => Effect::Rejected,
                    security_operation::Outcome::Unavailable => Effect::Unavailable,
                    security_operation::Outcome::Unknown => Effect::Unknown,
                };
                let mut detail = call.detail.clone();
                if let SecurityCallDetail::Operation { outcome, .. } = &mut detail {
                    *outcome = Some(effect);
                }
                call.finish(&detail, effect).await;
            }
        }
    }

    async fn handle_direct_query(shared: Self::Shared, query: Self::Query) {
        handle_security_query(shared, None, query).await;
    }

    async fn handle_keyed_query(
        shared: Self::Shared,
        _key: Self::Key,
        _lane: &mut Self::LaneState,
        query: Self::Query,
    ) {
        handle_security_query(shared, None, query).await;
    }

    async fn handle_global_query(
        shared: Self::Shared,
        global: &mut Self::GlobalState,
        query: Self::Query,
    ) {
        handle_security_query(shared, Some(global), query).await;
    }

    async fn handle_exclusive_query(
        shared: Self::Shared,
        global: &mut Self::GlobalState,
        query: Self::Query,
    ) {
        handle_security_query(shared, Some(global), query).await;
    }
}

async fn handle_security_query(
    shared: SecurityShared,
    global: Option<&SecurityGlobalState>,
    query: SecurityQuery,
) {
    match query {
        SecurityQuery::CurrentPolicy { reply, context } => {
            let result = match global {
                Some(global) if context.running().await.is_ok() => global.current_policy().await,
                _ => Err(()),
            };
            let effect = if result.is_ok() { Effect::Confirmed } else { Effect::Unavailable };
            let _ = context.finish(effect.status(), &SecurityCallDetail::PolicyRead).await;
            let _ = reply.send(result);
        }
        SecurityQuery::Audit { query, reply, context } => {
            let outcome = if context.running().await.is_err() {
                security_audit::Outcome::Unknown
            } else if let Some(security) = shared.security_ops() {
                security.query_security_audit(query).await
            } else {
                security_audit::Outcome::Unavailable
            };
            let (effect, total) = match &outcome {
                security_audit::Outcome::Observed(receipt) => (Effect::Confirmed, Some(receipt.total)),
                security_audit::Outcome::Rejected => (Effect::Rejected, None),
                security_audit::Outcome::Unavailable => (Effect::Unavailable, None),
                security_audit::Outcome::Unknown => (Effect::Unknown, None),
            };
            let _ = context.finish(effect.status(), &SecurityCallDetail::Audit {
                page: query.page, page_size: query.page_size, total, outcome: Some(effect),
            }).await;
            let _ = reply.send(outcome);
        }
        SecurityQuery::OperationReceipt { correlation, reply, context } => {
            let result = if context.running().await.is_ok() {
                shared.operation_receipts.receipt(&correlation)
            } else { Err(()) };
            let effect = if result.is_ok() { Effect::Confirmed } else { Effect::Unavailable };
            let _ = context.finish(effect.status(), &SecurityCallDetail::OperationReceipt { correlation }).await;
            let _ = reply.send(result);
        }
    }
}
