use std::{future::Future, pin::Pin};

use platform::endpoint::runtime_address::RuntimeEndpoint;

use crate::model::{BoardFailure, BoardIdentity, BoardOperation, BoardResult};

pub type BoardFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Implemented by the peer integration. Native storage, revisions, grants and view tickets stay native.
pub trait BoardOps: Send + Sync {
    fn execute<'a>(
        &'a self,
        identity: BoardIdentity,
        operation: BoardOperation,
    ) -> BoardFuture<'a, Result<BoardResult, BoardFailure>>;
}

pub trait BoardRuntimeDirectory: Send + Sync {
    fn lookup(&self, endpoint: &RuntimeEndpoint) -> Option<&dyn BoardOps>;
}

pub trait BoardRequestAdmission: Send + Sync {
    fn admit_board_request(&self) -> Result<(), BoardRequestAdmissionClosed>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BoardRequestAdmissionClosed;
