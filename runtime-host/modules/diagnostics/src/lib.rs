mod adapters;
mod api;
mod application;
mod archive;
mod domain;
mod flight_recorder;
mod owner;
pub mod ports;

use std::sync::Arc;

use foundation::execution::{ObservationSink, OwnedTask, OwnerRuntimeConfig, OwnerRuntimeSystem};
use platform::{
    call::{CallReceipt, CallRecorder},
    capability::CapabilityDecisionVerifier,
    module::{CapabilityKey, EffectKind, ModuleDescriptor, ModuleId},
};
use tokio::sync::Mutex;

use api::DiagnosticsHandle;
use owner::actor::DiagnosticsOwner;

const MODULE_ID: ModuleId = ModuleId::new("diagnostics");
const PROVIDES: &[CapabilityKey] = &[CapabilityKey::new("diagnostics")];
const REQUIRES: &[CapabilityKey] = &[
    CapabilityKey::new("runtime.diagnostics"),
    CapabilityKey::new("host.observation"),
];
const ROUTES: &[&str] = &["diagnostics.loopback"];
const EVENTS: &[&str] = &["openclaw-runtime", "openclaw-readiness", "matcha-lifecycle"];
const EFFECTS: &[EffectKind] = &[
    EffectKind::OwnerTask,
    EffectKind::Route,
    EffectKind::EventSubscription,
];

pub use archive::{
    DiagnosticsArchiveAdmission, DiagnosticsArchiveError, DiagnosticsArchiveProducer,
    DiagnosticsArchiveReceipt, DiagnosticsArchiveRoot, DiagnosticsArchiveTerminal,
};
pub use domain::model::{
    self, HostLifecycle, HostState, RuntimeFailure, RuntimeLifecycle, RuntimeStartupDiagnostic,
    RuntimeStartupDiagnostics, RuntimeState, RuntimeStateProjection, project_failure,
    project_lifecycle,
};
pub(crate) use flight_recorder::RuntimeObservationSnapshot;
pub use flight_recorder::{
    RuntimeFlightRecorder, RuntimeObservationConfig, RuntimeObservationMode,
};
pub use owner::actor::DiagnosticsOwnerInput;
pub use ports::{
    DiagnosticsArchiveCancellation, DiagnosticsArchiveCancellationGuard, DiagnosticsArchivePort,
    DiagnosticsFuture, DiagnosticsRequestAdmission, DiagnosticsRequestAdmissionClosed,
};

#[derive(Clone)]
pub struct DiagnosticsModule {
    handle: DiagnosticsHandle,
}

impl DiagnosticsModule {
    fn new(handle: DiagnosticsHandle) -> Self {
        Self { handle }
    }

    pub fn with_call_recorder(mut self, recorder: CallRecorder) -> Self {
        self.handle = self.handle.with_call_recorder(recorder);
        self
    }

    pub async fn admit_archive(
        &self,
        cancellation: DiagnosticsArchiveCancellation,
    ) -> Result<CallReceipt, DiagnosticsArchiveError> {
        self.handle.admit_archive(cancellation).await
    }

    pub async fn collect_archive(
        &self,
        cancellation: DiagnosticsArchiveCancellation,
    ) -> Result<DiagnosticsArchiveReceipt, DiagnosticsArchiveError> {
        self.handle.collect_archive(cancellation).await
    }

    pub async fn download_archive(
        &self,
        archive_id: String,
    ) -> Result<Vec<u8>, DiagnosticsArchiveError> {
        self.handle.download_archive(archive_id).await
    }

    pub fn descriptor(
        &self,
        verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
        observation: ObservationSink,
    ) -> ModuleDescriptor {
        ModuleDescriptor::new(
            MODULE_ID,
            PROVIDES,
            REQUIRES,
            EFFECTS,
            ROUTES,
            EVENTS,
            Some(self.loopback_descriptor(verifier, observation)),
        )
    }

    fn loopback_descriptor(
        &self,
        verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
        observation: ObservationSink,
    ) -> platform::loopback::ModuleDescriptor {
        adapters::loopback::descriptor(adapters::loopback::Dependencies::new(
            verifier,
            self.handle.clone().with_observation(observation.clone()),
            observation,
        ))
    }
}

pub fn spawn_owner(
    system: &OwnerRuntimeSystem,
    input: DiagnosticsOwnerInput,
) -> (DiagnosticsModule, OwnedTask<()>) {
    let owner = DiagnosticsOwner::new(input);
    let (handle, task) = system.spawn_owner(
        owner,
        OwnerRuntimeConfig::new(16, DiagnosticsOwner::lane_retention()),
    );
    (DiagnosticsModule::new(DiagnosticsHandle::new(handle)), task)
}
