use tokio::{sync::oneshot, time::Instant};

use super::{
    ResourceClient, ResourceEpoch, ResourceFailure, ResourceShutdown, SharedTerminalEvidence,
};

pub(super) type EvidenceReply = oneshot::Sender<Result<SharedTerminalEvidence, ResourceFailure>>;
pub(super) type ShutdownReply = oneshot::Sender<Result<ResourceShutdown, ResourceFailure>>;

pub(super) enum Request {
    Begin,
    WaitDrained {
        expected: ResourceEpoch,
        deadline: Instant,
        reply: EvidenceReply,
    },
    Kill {
        expected: ResourceEpoch,
        reply: EvidenceReply,
    },
    Shutdown {
        expected: Option<ResourceEpoch>,
        reply: ShutdownReply,
    },
}

impl ResourceClient {
    pub(crate) async fn begin(&self) -> Result<(), ResourceFailure> {
        self.requests
            .send(Request::Begin)
            .await
            .map_err(|_| ResourceFailure::OwnerStopped)
    }

    pub(crate) async fn wait_drained(
        &self,
        expected: ResourceEpoch,
        deadline: Instant,
    ) -> Result<SharedTerminalEvidence, ResourceFailure> {
        let (reply, receiver) = oneshot::channel();
        self.requests
            .send(Request::WaitDrained {
                expected,
                deadline,
                reply,
            })
            .await
            .map_err(|_| ResourceFailure::OwnerStopped)?;
        receiver.await.unwrap_or(Err(ResourceFailure::OwnerStopped))
    }

    pub(crate) async fn kill(
        &self,
        expected: ResourceEpoch,
    ) -> Result<SharedTerminalEvidence, ResourceFailure> {
        let (reply, receiver) = oneshot::channel();
        self.requests
            .send(Request::Kill { expected, reply })
            .await
            .map_err(|_| ResourceFailure::OwnerStopped)?;
        receiver.await.unwrap_or(Err(ResourceFailure::OwnerStopped))
    }

    pub(crate) async fn shutdown(
        &self,
        expected: Option<ResourceEpoch>,
    ) -> Result<ResourceShutdown, ResourceFailure> {
        let (reply, receiver) = oneshot::channel();
        self.requests
            .send(Request::Shutdown { expected, reply })
            .await
            .map_err(|_| ResourceFailure::OwnerStopped)?;
        receiver.await.unwrap_or(Err(ResourceFailure::OwnerStopped))
    }
}
