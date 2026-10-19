use ::board::{BoardFailure, BoardFuture, BoardIdentity, BoardOperation, BoardOps, BoardResult};

use crate::{driver::OpenClawDriver, surfaces::board};

impl BoardOps for OpenClawDriver {
    fn execute<'a>(
        &'a self,
        identity: BoardIdentity,
        operation: BoardOperation,
    ) -> BoardFuture<'a, Result<BoardResult, BoardFailure>> {
        Box::pin(async move {
            let endpoint = runtime_directory::RuntimeDriver::endpoint(self);
            board::execute(&self.gateway.client(), &endpoint, identity, operation).await
        })
    }
}
