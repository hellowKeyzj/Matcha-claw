use std::sync::Arc;

use foundation::execution::{ObservationSink, ServiceHandle};
use tokio::sync::{mpsc, watch};

use crate::TeamActivityExecutor;

use super::OrganizationHandle;

const TEAM_RUN_MAINTENANCE_CAPACITY: usize = 8;

pub trait TeamRunAdmission: Send + Sync {
    fn is_admitted(&self) -> bool;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AdmissionState {
    Changed,
}

#[derive(Clone)]
pub struct TeamRunCoordinatorInput {
    pub admission: Arc<dyn TeamRunAdmission>,
    pub organization: OrganizationHandle,
    pub activity_executor: Arc<dyn TeamActivityExecutor>,
    pub admission_changes: watch::Receiver<AdmissionState>,
    pub observation: ObservationSink,
}

#[derive(Clone)]
pub struct TeamRunCoordinatorHandle {
    requests: mpsc::Sender<TeamRunCoordinatorRequest>,
}

pub struct TeamRunCoordinator {
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
    pub fn spawn(input: TeamRunCoordinatorInput) -> (Self, TeamRunCoordinatorHandle) {
        let (requests, receiver) = mpsc::channel(TEAM_RUN_MAINTENANCE_CAPACITY);
        let handle = TeamRunCoordinatorHandle { requests };
        let (service, _) = ServiceHandle::spawn(move |cancellation| async move {
            super::supervisor::run(input, receiver, cancellation).await;
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
