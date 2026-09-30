mod adapters;
mod api;
mod application;
pub mod call;
pub mod capability;
pub mod domain;
pub mod events;
mod owner;
pub mod ports;

pub mod abort {
    pub use crate::application::abort::*;
}
pub mod approval {
    pub use crate::application::approval::*;
}
pub mod command {
    pub use crate::application::commands::*;
}
pub mod create {
    pub use crate::application::create::*;
}
pub mod delete {
    pub use crate::application::delete::*;
}
pub mod endpoint {
    pub use crate::domain::endpoint::*;
}
pub mod model_selection {
    pub use crate::application::model_selection::*;
}
pub mod session_catalog {
    pub use crate::application::session_catalog::*;
}
pub mod session_history {
    pub use crate::application::session_history::*;
}
pub mod query {
    pub use crate::application::queries::*;
}
pub mod rename {
    pub use crate::application::rename::*;
}
pub mod runtime_error {
    pub use crate::application::runtime_error::*;
}
pub mod send {
    pub use crate::application::send::*;
}
pub mod send_hook {
    pub use crate::application::send_hook::*;
}
pub mod session_permission {
    pub use crate::application::session_permission::*;
}
pub mod state {
    pub use crate::domain::model::*;
}
pub mod terminal_hook {
    pub use crate::application::terminal_hook::*;
}
pub mod timeline {
    pub use crate::application::timeline::*;
}

use foundation::execution::{OwnedTask, OwnerRuntimeConfig, OwnerRuntimeSystem};
use platform::{
    capability::CapabilityDecisionVerifier,
    module::{CapabilityDescriptorProvider, CapabilityKey, EffectKind, ModuleDescriptor, ModuleId},
};
use tokio::sync::Mutex;

use std::sync::Arc;

use owner::actor::SessionOwner;

const MODULE_ID: ModuleId = ModuleId::new("sessions");
const PROVIDES: &[CapabilityKey] = &[
    CapabilityKey::new("sessions"),
    CapabilityKey::new("session.prompt"),
    CapabilityKey::new("session.management"),
    CapabilityKey::new("session.approval"),
    CapabilityKey::new("session.modelSelection"),
];
const REQUIRES: &[CapabilityKey] = &[
    CapabilityKey::new("runtime.sessions"),
    CapabilityKey::new("providers"),
];
const ROUTES: &[&str] = &["sessions.loopback", "sessions.events"];
const EVENTS: &[&str] = &["openclaw-session-ingress", "matcha-session-ingress"];
const EFFECTS: &[EffectKind] = &[
    EffectKind::OwnerTask,
    EffectKind::Route,
    EffectKind::EventSubscription,
];

pub use adapters::loopback::{
    SessionEventsAction, SessionEventsStream, events_head_plan, handle_events, trace,
};
pub use api::SessionHandle;
pub use events::SessionDeltaSource;
pub use owner::actor::{SessionOwnerInput, SessionSnapshot};
pub use ports::{
    LifecycleOps, RuntimeDriver, RuntimeDriverIdentity, RuntimeOperationFailure, SessionFuture,
    SessionOpenOps, SessionOps, SessionOwnershipQuery, SessionOwnershipReader,
    SessionRuntimeDirectory,
};
pub use runtime_error::{RequestAdmissionClosed, RuntimeSessionError};
pub use send_hook::{
    PreparedSessionSend, SessionSendHook, SessionSendHookFuture, SessionSendHookPrepared,
    SessionSendHookSet, SessionSendHookState,
};
pub use terminal_hook::{SessionRunTerminalSnapshot, SessionTerminalHook};

#[derive(Clone)]
pub struct SessionModule {
    handle: SessionHandle,
}

impl SessionModule {
    fn new(handle: SessionHandle) -> Self {
        Self { handle }
    }

    pub fn with_call_recorder(mut self, recorder: platform::call::CallRecorder) -> Self {
        self.handle = self.handle.with_call_recorder(recorder);
        self
    }

    pub fn handle(&self) -> &SessionHandle {
        &self.handle
    }

    pub fn descriptor(
        &self,
        verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
        send_hooks: SessionSendHookSet,
        session_delta_source: SessionDeltaSource,
    ) -> ModuleDescriptor {
        ModuleDescriptor::with_capabilities(
            MODULE_ID,
            PROVIDES,
            REQUIRES,
            EFFECTS,
            ROUTES,
            EVENTS,
            Some(self.loopback_descriptor(verifier, send_hooks, session_delta_source)),
            Some(CapabilityDescriptorProvider::new(
                capability::listed,
                capability::describe,
            )),
        )
    }

    fn loopback_descriptor(
        &self,
        verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
        send_hooks: SessionSendHookSet,
        session_delta_source: SessionDeltaSource,
    ) -> platform::loopback::ModuleDescriptor {
        adapters::loopback::descriptor(adapters::loopback::Dependencies::new(
            verifier,
            self.handle.clone(),
            send_hooks,
            session_delta_source,
        ))
    }
}

pub fn spawn_owner(
    system: &OwnerRuntimeSystem,
    input: SessionOwnerInput,
) -> (SessionModule, OwnedTask<()>) {
    let runtime_directory = Arc::clone(&input.runtime_directory);
    let (owner, _snapshot) = SessionOwner::new(
        input.runtime_directory,
        input.ownership_reader,
        input.provider_handle,
        input.session_delta,
        input.terminal_hook,
    );
    let (handle, task) = system.spawn_owner(
        owner,
        OwnerRuntimeConfig::new(64, SessionOwner::lane_retention()),
    );
    (
        SessionModule::new(SessionHandle::new(handle, runtime_directory)),
        task,
    )
}
