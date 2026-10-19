mod adapters;
mod api;
mod application;
pub mod capability;
pub mod model;
mod owner;
pub mod ports;
mod validation;

use std::sync::Arc;

use foundation::execution::{LaneRetention, OwnedTask, OwnerRuntimeConfig, OwnerRuntimeSystem};
use platform::{
    capability::CapabilityDecisionVerifier,
    module::{CapabilityDescriptorProvider, CapabilityKey, EffectKind, ModuleDescriptor, ModuleId},
};
use tokio::sync::Mutex;

pub use api::{
    BoardEventSink, BoardEventSubscription, BoardSubscription, BoardSubscriptionFailure,
};
pub use model::*;
pub use owner::BoardOwnerInput;
pub use ports::{
    BoardFuture, BoardOps, BoardRequestAdmission, BoardRequestAdmissionClosed,
    BoardRuntimeDirectory,
};

pub const EXECUTE_PATH: &str = "/api/board/execute";
pub const AUTHORIZATION_SCOPE: &str = "board.runtime";

const PROVIDES: &[CapabilityKey] = &[CapabilityKey::new("board.runtime")];
const REQUIRES: &[CapabilityKey] = &[CapabilityKey::new("runtime.board")];
const EFFECTS: &[EffectKind] = &[
    EffectKind::OwnerTask,
    EffectKind::Route,
    EffectKind::EventSubscription,
];

#[derive(Clone)]
pub struct BoardModule {
    handle: api::BoardHandle,
}

impl BoardModule {
    pub async fn execute(
        &self,
        identity: BoardIdentity,
        operation: BoardOperation,
    ) -> Result<BoardResult, BoardFailure> {
        self.handle.execute(identity, operation).await
    }

    pub async fn subscribe(
        &self,
        identity: BoardIdentity,
    ) -> Result<BoardSubscription, BoardFailure> {
        self.handle.subscribe(identity).await
    }

    pub fn event_sink(&self) -> BoardEventSink {
        self.handle.event_sink()
    }

    pub fn subscribe_events(&self) -> Result<BoardEventSubscription, BoardFailure> {
        self.handle.subscribe_events()
    }

    /// Reject new requests, finish accepted identity lanes, then close all subscription resources.
    pub async fn close(&self) -> Result<(), BoardFailure> {
        self.handle.close().await
    }

    pub fn descriptor(&self, verifier: Arc<Mutex<CapabilityDecisionVerifier>>) -> ModuleDescriptor {
        ModuleDescriptor::with_capabilities(
            ModuleId::new("board"),
            PROVIDES,
            REQUIRES,
            EFFECTS,
            &["board.loopback"],
            &["openclaw-board-events"],
            Some(adapters::loopback::descriptor(
                verifier,
                self.handle.clone(),
            )),
            Some(CapabilityDescriptorProvider::new(
                capability::listed,
                capability::describe,
            )),
        )
    }
}

pub fn spawn_owner(
    system: &OwnerRuntimeSystem,
    input: BoardOwnerInput,
) -> (BoardModule, OwnedTask<()>) {
    let lifecycle = api::BoardLifecycle::new();
    let owner = owner::BoardOwner::new(input, lifecycle.clone());
    let (handle, task) =
        system.spawn_owner(owner, OwnerRuntimeConfig::new(64, LaneRetention::Immediate));
    (
        BoardModule {
            handle: api::BoardHandle::new(handle, lifecycle),
        },
        task,
    )
}
