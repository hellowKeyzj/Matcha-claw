use foundation::execution::CommandRoute;
use tokio::sync::{OwnedSemaphorePermit, oneshot};

use crate::{
    api::{BoardDelivery, BoardSubscription},
    model::{BoardFailure, BoardIdentity, BoardOperation, BoardResult},
};

pub(crate) enum BoardOwnerCommand {
    Execute {
        identity: BoardIdentity,
        operation: BoardOperation,
        reply: oneshot::Sender<Result<BoardResult, BoardFailure>>,
    },
    Subscribe {
        identity: BoardIdentity,
        permit: OwnedSemaphorePermit,
        reply: oneshot::Sender<Result<BoardSubscription, BoardFailure>>,
    },
    Publish(BoardDelivery),
    Close {
        reply: oneshot::Sender<()>,
    },
}

impl BoardOwnerCommand {
    pub(crate) fn route(&self) -> CommandRoute<BoardIdentity> {
        match self {
            Self::Execute { identity, .. } | Self::Subscribe { identity, .. } => {
                CommandRoute::Keyed(identity.clone())
            }
            Self::Publish(delivery) => CommandRoute::Keyed(delivery.event.identity().clone()),
            Self::Close { .. } => CommandRoute::Shutdown,
        }
    }
}
