use platform::call::{CallContext, CallDetail, CallStatus};
use serde::Serialize;

/// References to Fleet facts, never provider input, output, credentials or terminal bytes.
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FleetCallDetail {
    pub(crate) target_id: Option<String>,
    pub(crate) entity_id: Option<String>,
    pub(crate) command_id: Option<String>,
    pub(crate) dispatch_id: Option<String>,
    pub(crate) attempt: Option<u64>,
    pub(crate) outcome: Option<&'static str>,
}

impl CallDetail for FleetCallDetail {
    const MODULE: &'static str = "fleet";
}

#[derive(Clone)]
pub(crate) struct FleetCall {
    pub(crate) context: CallContext<FleetCallDetail>,
    pub(crate) detail: FleetCallDetail,
    pub(crate) command: &'static str,
    pub(crate) started: std::sync::Arc<std::sync::atomic::AtomicBool>,
    pub(crate) admitted: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

pub(crate) type PendingCalls = std::sync::Arc<
    tokio::sync::Mutex<std::collections::BTreeMap<(crate::command::CommandId, u64), FleetCall>>,
>;

impl FleetCall {
    pub(crate) async fn accepted(&self) -> Result<(), ()> {
        self.context
            .accepted()
            .await
            .map(|_| ())
            .map_err(|_| audit_failure())
    }

    pub(crate) async fn running(&self) -> Result<(), ()> {
        if self.started.load(std::sync::atomic::Ordering::Acquire) {
            return Ok(());
        }
        let result = async {
            self.context.accepted().await?;
            self.context.running().await
        }
        .await;
        if result.is_err() {
            audit_failure();
            self.outcome("unavailable", CallStatus::Unknown).await;
            return Err(());
        }
        self.started
            .store(true, std::sync::atomic::Ordering::Release);
        Ok(())
    }

    pub(crate) async fn outcome(&self, outcome: &'static str, status: CallStatus) {
        let mut detail = self.detail.clone();
        detail.outcome = Some(outcome);
        let result = if status.is_terminal() {
            self.context.finish(status, &detail).await
        } else {
            match self.context.update(&detail).await {
                Ok(()) => self.context.waiting().await,
                Err(error) => Err(error),
            }
        };
        if result.is_err() {
            audit_failure();
        }
    }

    pub(crate) async fn dispatch(
        &mut self,
        result: &Result<crate::owner::actor::FleetDispatchResult, crate::FleetDeliveryError>,
    ) {
        use crate::application::executor::FleetExecutionOutcome;
        match result {
            Ok(result) => {
                self.detail.dispatch_id = Some(result.dispatch_id.as_str().to_owned());
                self.detail.attempt = Some(result.attempt.sequence());
                match result.outcome {
                    FleetExecutionOutcome::Completed => {
                        self.outcome("completed", CallStatus::Succeeded).await
                    }
                    FleetExecutionOutcome::Rejected => {
                        self.outcome("rejected", CallStatus::Rejected).await
                    }
                    FleetExecutionOutcome::Unknown => {
                        self.outcome("outcomeUnknown", CallStatus::Unknown).await
                    }
                    FleetExecutionOutcome::Accepted => {
                        self.outcome("remoteAccepted", CallStatus::Waiting).await
                    }
                }
            }
            Err(_) => self.outcome("rejected", CallStatus::Rejected).await,
        }
    }

    pub(crate) async fn command_state(&self, state: &crate::command::CommandState) -> bool {
        use crate::command::CommandState;
        let (outcome, status) = match state {
            CommandState::Succeeded { .. } => ("completed", CallStatus::Succeeded),
            CommandState::Failed { .. } => ("failed", CallStatus::Failed),
            CommandState::Cancelled { .. } => ("cancelled", CallStatus::Failed),
            CommandState::TimedOut { .. } => ("timedOut", CallStatus::Failed),
            CommandState::OutcomeUnknown { .. } => ("outcomeUnknown", CallStatus::Unknown),
            CommandState::Queued { .. } | CommandState::Running { .. } => return false,
        };
        self.outcome(outcome, status).await;
        true
    }

    pub(crate) async fn lifecycle(
        &self,
        result: &Result<crate::owner::lifecycle::FleetLifecycleOutcome, crate::FleetDeliveryError>,
    ) {
        use crate::owner::lifecycle::FleetLifecycleOutcome;
        match result {
            Ok(FleetLifecycleOutcome::Completed) => {
                self.outcome("completed", CallStatus::Succeeded).await
            }
            Ok(FleetLifecycleOutcome::AlreadyAbsent) => {
                if matches!(
                    self.command,
                    "fleet.environments.deploy.begin" | "fleet.resources.provision.begin"
                ) {
                    self.outcome("failed", CallStatus::Failed).await;
                } else {
                    self.outcome("completed", CallStatus::Succeeded).await;
                }
            }
            Ok(FleetLifecycleOutcome::Unknown(_)) => {
                self.outcome("outcomeUnknown", CallStatus::Unknown).await
            }
            Ok(FleetLifecycleOutcome::Rejected(_)) | Err(_) => {
                self.outcome("rejected", CallStatus::Rejected).await
            }
        }
    }

    pub(crate) async fn probe(
        &self,
        result: &Result<
            crate::owner::lifecycle::FleetConnectionLifecycleOutcome,
            crate::FleetDeliveryError,
        >,
    ) {
        use crate::owner::lifecycle::FleetConnectionLifecycleOutcome;
        match result {
            Ok(FleetConnectionLifecycleOutcome::Ready(_)) => {
                self.outcome("ready", CallStatus::Succeeded).await
            }
            Ok(FleetConnectionLifecycleOutcome::Unhealthy(_)) => {
                self.outcome("unhealthy", CallStatus::Failed).await
            }
            Ok(FleetConnectionLifecycleOutcome::Unknown(_)) => {
                self.outcome("outcomeUnknown", CallStatus::Unknown).await
            }
            Ok(FleetConnectionLifecycleOutcome::Rejected(_)) | Err(_) => {
                self.outcome("rejected", CallStatus::Rejected).await
            }
        }
    }

    pub(crate) async fn resource_registration(
        &self,
        result: &Result<crate::environment::ManagedResourceMutation, crate::FleetDeliveryError>,
    ) {
        match result {
            Err(crate::FleetDeliveryError::DeliveryOutcomeUnknown)
            | Err(crate::FleetDeliveryError::Store(
                crate::store::StoreFault::CommitOutcomeUnknown(_),
            )) => self.outcome("outcomeUnknown", CallStatus::Unknown).await,
            _ => self.finish(result).await,
        }
    }

    pub(crate) async fn finish<T, E>(&self, result: &Result<T, E>) {
        let mut detail = self.detail.clone();
        detail.outcome = Some(if result.is_ok() {
            "completed"
        } else {
            "rejected"
        });
        let status = if result.is_ok() {
            CallStatus::Succeeded
        } else {
            CallStatus::Rejected
        };
        if self.context.finish(status, &detail).await.is_err() {
            audit_failure();
        }
    }
}

fn audit_failure() {
    eprintln!("Fleet call audit persistence failed");
}
