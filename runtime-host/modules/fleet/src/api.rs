use std::{collections::BTreeMap, path::PathBuf, sync::Arc};

use foundation::execution::LaneRetention;
use tokio::sync::Mutex;

use crate::owner::{actor::PendingDispatch, handle::FleetHandle};

#[derive(Clone)]
pub struct FleetModule {
    handle: FleetHandle,
    startup_dispatches: Arc<Mutex<Vec<PendingDispatch>>>,
}

impl FleetModule {
    pub(crate) fn new(handle: FleetHandle, startup_dispatches: Vec<PendingDispatch>) -> Self {
        Self {
            handle,
            startup_dispatches: Arc::new(Mutex::new(startup_dispatches)),
        }
    }

    pub fn handle(&self) -> &FleetHandle {
        &self.handle
    }

    pub async fn begin_startup_dispatches(&self) {
        let pending = {
            let mut guard = self.startup_dispatches.lock().await;
            std::mem::take(&mut *guard)
        };
        for dispatch in pending {
            let _ = self.handle.begin_pending_dispatch(dispatch).await;
        }
    }
}

pub struct FleetOwnerInput {
    pub facts_path: PathBuf,
    pub private_root: PathBuf,
    pub docker_ownership: BTreeMap<String, String>,
    pub ssh_host_keys: BTreeMap<crate::TargetId, russh::keys::PublicKey>,
    pub mailbox_capacity: usize,
    pub lane_retention: LaneRetention,
}

impl FleetOwnerInput {
    pub fn new(
        facts_path: PathBuf,
        private_root: PathBuf,
        docker_ownership: BTreeMap<String, String>,
        ssh_host_keys: BTreeMap<crate::TargetId, russh::keys::PublicKey>,
        mailbox_capacity: usize,
        lane_retention: LaneRetention,
    ) -> Self {
        Self {
            facts_path,
            private_root,
            docker_ownership,
            ssh_host_keys,
            mailbox_capacity,
            lane_retention,
        }
    }
}
