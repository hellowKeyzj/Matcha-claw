use std::sync::Arc;

use foundation::execution::{CommandRoute, LaneRetention, OwnerSpec, QueryRoute};
use serde_json::Value;

use crate::{runtime::directory::RuntimeDriverDirectory, runtime::driver::RuntimeOperationFailure};

use super::{
    SecurityPolicyDeliveryOutcome, SecurityPolicyDeliverySettlement, audit as security_audit,
    command::SecurityCommand, emergency::SecurityEmergencyOutcome, operation as security_operation,
    query::SecurityQuery,
};

#[allow(dead_code)]
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) enum SecurityPartitionKey {
    Global,
}

#[derive(Clone)]
pub(crate) struct SecurityShared {
    runtime_directory: Arc<RuntimeDriverDirectory>,
}

pub(crate) struct SecurityGlobalState {
    policy_delivery: environment::SecurityPolicyDeliveryStore,
    operation_receipts: environment::SecurityOperationReceiptStore,
    serialized_effect: tokio::sync::Mutex<()>,
}

pub(crate) struct SecurityOwnerInput {
    pub(crate) state_dir: std::path::PathBuf,
    pub(crate) runtime_directory: Arc<RuntimeDriverDirectory>,
}

pub(crate) struct SecurityOwner {
    shared: SecurityShared,
    state: SecurityGlobalState,
}

impl SecurityOwner {
    pub(crate) fn new(input: SecurityOwnerInput) -> Result<Self, ()> {
        Ok(Self {
            shared: SecurityShared {
                runtime_directory: input.runtime_directory,
            },
            state: SecurityGlobalState {
                policy_delivery: environment::SecurityPolicyDeliveryStore::open(&input.state_dir)?,
                operation_receipts: environment::SecurityOperationReceiptStore::open(
                    &input.state_dir,
                )?,
                serialized_effect: tokio::sync::Mutex::new(()),
            },
        })
    }

    pub(crate) fn lane_retention() -> LaneRetention {
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
            let outcome = self.apply_policy_sync_effect(shared, desired.into()).await;
            let _ = self.policy_delivery.settle(revision, outcome.into());
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
        let desired = match environment::SecurityPolicyDesired::try_from_wire(&policy) {
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
                match self.policy_delivery.replace(&correlation, desired.into()) {
                    Ok(result) => result,
                    Err(()) => {
                        return SecurityPolicyDeliverySettlement {
                            revision: 0,
                            outcome: SecurityPolicyDeliveryOutcome::Unknown,
                        };
                    }
                };

            if let Some(outcome) = prior_outcome {
                return SecurityPolicyDeliverySettlement {
                    revision,
                    outcome: outcome.into(),
                };
            }

            let outcome = match self.policy_delivery.pending() {
                Ok(Some((pending_revision, pending))) if pending_revision == revision => {
                    self.apply_policy_sync_effect(shared, pending.into()).await
                }
                _ => SecurityPolicyDeliveryOutcome::Unknown,
            };
            let _ = self.policy_delivery.settle(revision, outcome.into());
            SecurityPolicyDeliverySettlement { revision, outcome }
        })
        .await
    }

    async fn emergency(
        &self,
        shared: &SecurityShared,
        correlation: String,
    ) -> SecurityEmergencyOutcome {
        self.serialize_effect(async {
            let desired = match self
                .policy_delivery
                .policy()
                .and_then(environment::security_policy_emergency_lockdown)
            {
                Ok(desired) => desired,
                Err(()) => return SecurityEmergencyOutcome::Unavailable,
            };

            let (revision, prior_outcome) =
                match self.policy_delivery.replace(&correlation, desired.into()) {
                    Ok(result) => result,
                    Err(()) => return SecurityEmergencyOutcome::Unavailable,
                };

            if prior_outcome.is_some_and(|outcome| {
                outcome != environment::SecurityPolicyDeliveryOutcome::Confirmed
            }) {
                return SecurityEmergencyOutcome::OutcomeUnknown;
            }

            let outcome = match self.policy_delivery.pending() {
                Ok(Some((pending_revision, pending))) if pending_revision == revision => {
                    self.apply_policy_restart_effect(shared, pending.into())
                        .await
                }
                Ok(None)
                    if prior_outcome
                        == Some(environment::SecurityPolicyDeliveryOutcome::Confirmed) =>
                {
                    SecurityPolicyDeliveryOutcome::Confirmed
                }
                _ => SecurityPolicyDeliveryOutcome::Unknown,
            };
            let _ = self.policy_delivery.settle(revision, outcome.into());

            if outcome != SecurityPolicyDeliveryOutcome::Confirmed {
                return SecurityEmergencyOutcome::OutcomeUnknown;
            }

            match self.run_security_emergency(shared).await {
                Some(openclaw::operations::SecurityEmergencyEffect::Applied(_)) => {
                    SecurityEmergencyOutcome::Applied
                }
                Some(openclaw::operations::SecurityEmergencyEffect::RuntimeRejected) => {
                    SecurityEmergencyOutcome::Rejected
                }
                Some(openclaw::operations::SecurityEmergencyEffect::OutcomeUnknown) | None => {
                    SecurityEmergencyOutcome::OutcomeUnknown
                }
            }
        })
        .await
    }

    async fn audit(
        &self,
        shared: &SecurityShared,
        query: security_audit::Query,
    ) -> security_audit::Outcome {
        let Some(native_query) = openclaw::operations::security_audit::SecurityAuditQuery::new(
            query.page,
            query.page_size,
        ) else {
            return security_audit::Outcome::Rejected;
        };
        match self.query_security_audit(shared, native_query).await {
            Some(openclaw::operations::security_audit::SecurityAuditEffect::Observed(receipt)) => {
                security_audit::Outcome::Observed(security_audit::Receipt {
                    page: receipt.page(),
                    page_size: receipt.page_size(),
                    total: receipt.total(),
                    items: receipt
                        .items()
                        .iter()
                        .map(|item| security_audit::Item {
                            ts: item.ts(),
                            tool_name: item.tool_name().to_string(),
                            risk: item.risk().to_string(),
                            action: item.action().to_string(),
                            decision: item.decision().to_string(),
                            rule_id: item.rule_id().map(String::from),
                        })
                        .collect(),
                })
            }
            Some(openclaw::operations::security_audit::SecurityAuditEffect::RuntimeRejected) => {
                security_audit::Outcome::Rejected
            }
            Some(openclaw::operations::security_audit::SecurityAuditEffect::Unavailable) | None => {
                security_audit::Outcome::Unavailable
            }
            Some(openclaw::operations::security_audit::SecurityAuditEffect::OutcomeUnknown) => {
                security_audit::Outcome::Unknown
            }
        }
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
                return outcome.into();
            }

            let effect = self
                .run_security_operation(shared, operation_id, input)
                .await
                .unwrap_or(openclaw::operations::SecurityActionEffect::Unavailable);
            let outcome = security_operation::Outcome::from_native(effect);
            let _ = self
                .operation_receipts
                .settle(&correlation, outcome.clone().into());
            outcome
        })
        .await
    }

    async fn apply_policy_sync_effect(
        &self,
        shared: &SecurityShared,
        desired: environment::SecurityPolicyDesired,
    ) -> SecurityPolicyDeliveryOutcome {
        let policy = desired.into_policy();
        match self.apply_policy_projection(shared, policy.clone()).await {
            Ok(()) => {}
            Err(RuntimeOperationFailure::TargetRejected) => {
                return SecurityPolicyDeliveryOutcome::Rejected;
            }
            Err(_) => return SecurityPolicyDeliveryOutcome::Unknown,
        }
        if !self.restart_security_runtime(shared).await {
            return SecurityPolicyDeliveryOutcome::Unknown;
        }
        match self.sync_security_policy(shared, policy).await {
            Some(openclaw::operations::SecurityPolicyEffect::Applied(_)) => {
                SecurityPolicyDeliveryOutcome::Confirmed
            }
            Some(openclaw::operations::SecurityPolicyEffect::RuntimeRejected) => {
                SecurityPolicyDeliveryOutcome::Rejected
            }
            Some(
                openclaw::operations::SecurityPolicyEffect::Unavailable
                | openclaw::operations::SecurityPolicyEffect::OutcomeUnknown,
            )
            | None => SecurityPolicyDeliveryOutcome::Unknown,
        }
    }

    async fn apply_policy_restart_effect(
        &self,
        shared: &SecurityShared,
        desired: environment::SecurityPolicyDesired,
    ) -> SecurityPolicyDeliveryOutcome {
        let policy = desired.into_policy();
        match self.apply_policy_projection(shared, policy).await {
            Ok(()) => {}
            Err(RuntimeOperationFailure::TargetRejected) => {
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
    ) -> Result<(), RuntimeOperationFailure> {
        let driver = shared
            .security_driver()
            .ok_or(RuntimeOperationFailure::Unavailable)?;
        let security = driver
            .security_ops()
            .ok_or(RuntimeOperationFailure::Unsupported)?;
        security.apply_security_policy_projection(policy).await
    }

    async fn restart_security_runtime(&self, shared: &SecurityShared) -> bool {
        let Some(driver) = shared.security_driver() else {
            return false;
        };
        let Some(lifecycle) = driver.lifecycle_ops() else {
            return false;
        };
        lifecycle.restart().await.is_ok()
    }

    async fn sync_security_policy(
        &self,
        shared: &SecurityShared,
        policy: Value,
    ) -> Option<openclaw::operations::SecurityPolicyEffect> {
        let driver = shared.security_driver()?;
        let security = driver.security_ops()?;
        Some(security.sync_security_policy(policy).await)
    }

    async fn run_security_emergency(
        &self,
        shared: &SecurityShared,
    ) -> Option<openclaw::operations::SecurityEmergencyEffect> {
        let driver = shared.security_driver()?;
        let security = driver.security_ops()?;
        Some(security.run_security_emergency().await)
    }

    async fn query_security_audit(
        &self,
        shared: &SecurityShared,
        query: openclaw::operations::security_audit::SecurityAuditQuery,
    ) -> Option<openclaw::operations::security_audit::SecurityAuditEffect> {
        let driver = shared.security_driver()?;
        let security = driver.security_ops()?;
        Some(security.query_security_audit(query).await)
    }

    async fn run_security_operation(
        &self,
        shared: &SecurityShared,
        operation_id: String,
        input: Value,
    ) -> Option<openclaw::operations::SecurityActionEffect> {
        let driver = shared.security_driver()?;
        let security = driver.security_ops()?;
        Some(security.security_operation(operation_id, input).await)
    }
}

impl SecurityShared {
    fn security_driver(&self) -> Option<Arc<dyn crate::runtime::driver::RuntimeDriver>> {
        self.runtime_directory.security_driver()
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
            SecurityCommand::ReplacePolicy {
                correlation,
                policy,
                reply,
            } => {
                let _ = reply.send(state.replace_policy(&shared, correlation, policy).await);
            }
            SecurityCommand::RecoverPending { reply } => {
                state.recover_pending(&shared).await;
                let _ = reply.send(());
            }
            SecurityCommand::Emergency { correlation, reply } => {
                let _ = reply.send(state.emergency(&shared, correlation).await);
            }
            SecurityCommand::Operation {
                correlation,
                operation_id,
                input,
                reply,
            } => {
                let _ = reply.send(
                    state
                        .operation(&shared, correlation, operation_id, input)
                        .await,
                );
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
    let Some(global) = global else {
        match query {
            SecurityQuery::CurrentPolicy { reply } => {
                let _ = reply.send(Err(()));
            }
            SecurityQuery::Audit { reply, .. } => {
                let _ = reply.send(security_audit::Outcome::Unavailable);
            }
        }
        return;
    };

    match query {
        SecurityQuery::CurrentPolicy { reply } => {
            let _ = reply.send(global.current_policy().await);
        }
        SecurityQuery::Audit { query, reply } => {
            let _ = reply.send(global.audit(&shared, query).await);
        }
    }
}
