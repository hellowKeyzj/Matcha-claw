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
    service: ServiceHandle<()>,
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
        let (service, _) = ServiceHandle::spawn(move |cancellation| async move {
            super::supervisor::run(input, admission_changes, receiver, cancellation).await;
        });
        (Self { service }, handle)
    }

    pub fn cancel(&self) {
        self.service.cancel();
    }

    pub async fn join(&mut self) -> Result<(), tokio::task::JoinError> {
        self.service.join().await
    }
}
