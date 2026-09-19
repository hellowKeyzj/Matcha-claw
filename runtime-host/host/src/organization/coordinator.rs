use std::sync::Arc;

use foundation::execution::{ObservationSink, ServiceHandle};
use tokio::sync::mpsc;

use crate::{composition::HostAdmission, runtime::directory::RuntimeDriverDirectory};

use super::OrganizationHandle;

const TEAM_RUN_MAINTENANCE_CAPACITY: usize = 8;

#[derive(Clone)]
pub(crate) struct TeamRunCoordinatorInput {
    pub(crate) admission: Arc<HostAdmission>,
    pub(crate) organization: OrganizationHandle,
    pub(crate) session: crate::sessions::SessionHandle,
    pub(crate) runtime_directory: Arc<RuntimeDriverDirectory>,
    pub(crate) admission_changes: tokio::sync::watch::Receiver<crate::composition::AdmissionState>,
    pub(crate) observation: ObservationSink,
}

#[derive(Clone)]
pub(crate) struct TeamRunCoordinatorHandle {
    requests: mpsc::Sender<TeamRunCoordinatorRequest>,
}

pub(crate) struct TeamRunCoordinator {
    service: ServiceHandle<()>,
}

pub(super) enum TeamRunCoordinatorRequest {
    RecoverMaterializationReceipts,
}

impl TeamRunCoordinatorHandle {
    pub(crate) async fn recover_materialization_receipts(&self) {
        let _ = self
            .requests
            .send(TeamRunCoordinatorRequest::RecoverMaterializationReceipts)
            .await;
    }
}

impl TeamRunCoordinator {
    pub(crate) fn spawn(input: TeamRunCoordinatorInput) -> (Self, TeamRunCoordinatorHandle) {
        let (requests, receiver) = mpsc::channel(TEAM_RUN_MAINTENANCE_CAPACITY);
        let handle = TeamRunCoordinatorHandle { requests };
        let (service, _) = ServiceHandle::spawn(move |cancellation| async move {
            super::supervisor::run(input, receiver, cancellation).await;
        });
        (Self { service }, handle)
    }

    pub(crate) fn cancel(&self) {
        self.service.cancel();
    }

    pub(crate) async fn join(&mut self) -> Result<(), tokio::task::JoinError> {
        self.service.join().await
    }
}
