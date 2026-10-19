use std::{convert::Infallible, sync::Arc, time::Duration};

use foundation::execution::{CommandRoute, OwnerSpec, QueryRoute};
use tokio::time::timeout;

use crate::{
    api::{BoardLifecycle, BoardSubscription},
    application::BoardOwnerCommand,
    model::*,
    ports::{BoardRequestAdmission, BoardRuntimeDirectory},
};

const OPERATION_DEADLINE: Duration = Duration::from_secs(30);

pub struct BoardOwnerInput {
    pub admission: Arc<dyn BoardRequestAdmission>,
    pub runtime_directory: Arc<dyn BoardRuntimeDirectory>,
}

#[derive(Clone)]
pub(crate) struct BoardShared {
    admission: Arc<dyn BoardRequestAdmission>,
    runtime_directory: Arc<dyn BoardRuntimeDirectory>,
    lifecycle: BoardLifecycle,
}

pub(crate) struct BoardOwner {
    shared: BoardShared,
}

impl BoardOwner {
    pub(crate) fn new(input: BoardOwnerInput, lifecycle: BoardLifecycle) -> Self {
        Self {
            shared: BoardShared {
                admission: input.admission,
                runtime_directory: input.runtime_directory,
                lifecycle,
            },
        }
    }
}

impl OwnerSpec for BoardOwner {
    type Command = BoardOwnerCommand;
    type Query = Infallible;
    type Key = BoardIdentity;
    type Shared = BoardShared;
    type GlobalState = ();
    type LaneState = ();

    fn split(self) -> (Self::Shared, Self::GlobalState) {
        (self.shared, ())
    }
    fn route_command(command: &Self::Command) -> CommandRoute<Self::Key> {
        command.route()
    }
    fn route_query(query: &Self::Query) -> QueryRoute<Self::Key> {
        match *query {}
    }
    fn open_lane(_shared: &Self::Shared, _key: &Self::Key) -> Self::LaneState {}

    async fn handle_keyed_command(
        shared: Self::Shared,
        _key: Self::Key,
        _lane: &mut Self::LaneState,
        command: Self::Command,
    ) {
        match command {
            BoardOwnerCommand::Execute {
                identity,
                operation,
                reply,
            } => {
                if !reply.is_closed() {
                    let _ = reply.send(execute(&shared, identity, operation).await);
                }
            }
            BoardOwnerCommand::Subscribe {
                identity,
                permit,
                reply,
            } => {
                let subscription = if shared.admission.admit_board_request().is_err() {
                    Err(BoardFailure::Unavailable)
                } else if shared
                    .runtime_directory
                    .lookup(identity.endpoint())
                    .is_none()
                {
                    Err(BoardFailure::Unsupported)
                } else {
                    Ok(BoardSubscription::new(
                        identity,
                        shared.lifecycle.events.subscribe(),
                        &shared.lifecycle,
                        permit,
                    ))
                };
                let _ = reply.send(subscription);
            }
            BoardOwnerCommand::Publish(delivery) => {
                if delivery.generation == *shared.lifecycle.resync.borrow() {
                    let _ = shared.lifecycle.events.send(delivery);
                }
            }
            BoardOwnerCommand::Close { .. } => unreachable!(),
        }
    }

    async fn handle_global_command(
        shared: Self::Shared,
        _global: &mut Self::GlobalState,
        command: Self::Command,
    ) {
        let BoardOwnerCommand::Close { reply } = command else {
            unreachable!()
        };
        shared.lifecycle.finish();
        let _ = reply.send(());
    }
    async fn handle_direct_query(_shared: Self::Shared, query: Self::Query) {
        match query {}
    }
    async fn handle_keyed_query(
        _shared: Self::Shared,
        _key: Self::Key,
        _lane: &mut Self::LaneState,
        query: Self::Query,
    ) {
        match query {}
    }
    async fn handle_global_query(
        _shared: Self::Shared,
        _global: &mut Self::GlobalState,
        query: Self::Query,
    ) {
        match query {}
    }
    async fn handle_exclusive_query(
        _shared: Self::Shared,
        _global: &mut Self::GlobalState,
        query: Self::Query,
    ) {
        match query {}
    }
    async fn shutdown(
        shared: Self::Shared,
        _global: &mut Self::GlobalState,
        _lanes: Vec<(Self::Key, Self::LaneState)>,
    ) {
        shared.lifecycle.finish();
    }
}

async fn execute(
    shared: &BoardShared,
    identity: BoardIdentity,
    operation: BoardOperation,
) -> Result<BoardResult, BoardFailure> {
    shared
        .admission
        .admit_board_request()
        .map_err(|_| BoardFailure::Unavailable)?;
    let ops = shared
        .runtime_directory
        .lookup(identity.endpoint())
        .ok_or(BoardFailure::Unsupported)?;
    let method = operation.method();
    let result = timeout(OPERATION_DEADLINE, ops.execute(identity, operation))
        .await
        .map_err(|_| BoardFailure::Unknown)??;
    if !result.matches_method(method) {
        return Err(BoardFailure::Unknown);
    }
    crate::validation::result(&result)?;
    Ok(result)
}
