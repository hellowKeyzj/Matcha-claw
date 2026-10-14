use std::sync::Arc;

use foundation::execution::{ObservationSink, ServiceHandle};
use tokio::sync::{mpsc, watch};

use crate::{TeamActivityExecutor, ports::TeamRunAdmission};

use super::OrganizationHandle;

const TEAM_RUN_MAINTENANCE_CAPACITY: usize = 8;

#[derive(Clone)]
pub struct TeamRunCoordinatorInput {
    pub admission: Arc<dyn TeamRunAdmission>,
    pub organization: OrganizationHandle,
    pub activity_executor: Arc<dyn TeamActivityExecutor>,
    pub observation: ObservationSink,
}

#[derive(Clone)]
pub struct TeamRunCoordinatorHandle {
    requests: mpsc::Sender<TeamRunCoordinatorRequest>,
}

pub(crate) struct TeamRunCoordinator {
    service: ServiceHandle<super::supervisor::TeamRunSupervisor>,
    retained: Option<super::supervisor::TeamRunSupervisor>,
    input: TeamRunCoordinatorInput,
    join_failed: bool,
}

pub(super) enum TeamRunCoordinatorRequest {
    RecoverMaterializationReceipts,
}

impl TeamRunCoordinatorHandle {
    pub async fn recover_materialization_receipts(&self) {
        let _ = self
            .requests
            .send(TeamRunCoordinatorRequest::RecoverMaterializationReceipts)
            .await;
    }
}

impl TeamRunCoordinator {
    pub fn spawn<T: Send + Sync + 'static>(
        input: TeamRunCoordinatorInput,
        admission_changes: watch::Receiver<T>,
    ) -> (Self, TeamRunCoordinatorHandle) {
        let (requests, receiver) = mpsc::channel(TEAM_RUN_MAINTENANCE_CAPACITY);
        let handle = TeamRunCoordinatorHandle { requests };
        let recovery_input = input.clone();
        let (service, _) = ServiceHandle::spawn(move |cancellation| async move {
            super::supervisor::run(input, admission_changes, receiver, cancellation).await
        });
        (Self { service, retained: None, input: recovery_input, join_failed: false }, handle)
    }

    pub fn cancel(&self) {
        self.service.cancel();
    }

    pub async fn join(&mut self) -> Result<(), crate::api::OrganizationShutdownError> {
        if self.join_failed {
            return Err(crate::api::OrganizationShutdownError::Join);
        }
        if let Some(retained) = &mut self.retained {
            retained.retry_settlements(&self.input).await;
        } else {
            match self.service.join().await {
                Ok(supervisor) => self.retained = Some(supervisor),
                Err(_) => {
                    self.join_failed = true;
                    return Err(crate::api::OrganizationShutdownError::Join);
                }
            }
        }
        Ok(())
    }

    pub(crate) fn has_pending_settlements(&self) -> bool {
        self.retained.as_ref().is_some_and(super::supervisor::TeamRunSupervisor::has_pending_settlements)
    }
}
