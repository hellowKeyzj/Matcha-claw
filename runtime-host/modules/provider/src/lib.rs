mod adapters;
mod api;
mod application;
mod call;
pub mod capability;
pub mod domain;
pub mod llm_client;
mod owner;
mod persistence;
pub mod ports;
mod projection;

use std::sync::Arc;

use foundation::execution::{OwnedTask, OwnerRuntimeConfig, OwnerRuntimeSystem};
use platform::{
    capability::CapabilityDecisionVerifier,
    module::{CapabilityDescriptorProvider, CapabilityKey, EffectKind, ModuleDescriptor, ModuleId},
};
use tokio::sync::Mutex;

use owner::actor::ProviderOwner;

const MODULE_ID: ModuleId = ModuleId::new("provider");
const PROVIDES: &[CapabilityKey] = &[CapabilityKey::new("providers")];
const REQUIRES: &[CapabilityKey] = &[CapabilityKey::new("runtime.provider")];
const ROUTES: &[&str] = &["provider.loopback"];
const EVENTS: &[&str] = &[];
const EFFECTS: &[EffectKind] = &[EffectKind::OwnerTask, EffectKind::Route];

pub use adapters::account_store::{ProviderAccountStore, ProviderAccountStoreFault};
pub use adapters::cascade::{ProviderCascade, ProviderCascadeFault};
pub use adapters::migration::{
    ProviderLegacyStoreCandidates, ProviderMigrationFault, locate_provider_legacy_store_candidates,
    migrate_provider_legacy_stores,
};
pub use adapters::model_store::{ProviderModelStore, ProviderModelStoreFault};
pub use adapters::routing_store::{ProviderRoutingStore, ProviderRoutingStoreFault};
pub use api::ProviderHandle;
pub use application::receipts::{
    ProviderAccountMutationKind, ProviderAccountView, ProviderAccountsDelivery,
    ProviderCommitOutcome, ProviderModelDiscoverOutcome, ProviderModelDiscoveryView,
    ProviderModelDraft, ProviderModelListOutcome, ProviderModelReferenceView,
    ProviderModelReplaceOutcome, ProviderModelSelectableOutcome, ProviderModelView,
    ProviderNativeConfigurationDiagnosticView, ProviderNativeConfigurationView,
    ProviderPersistedOutcome, ProviderRouteView, ProviderRoutingListOutcome,
    ProviderRoutingReplaceOutcome, ProviderRoutingView, ProviderSessionEndpoint,
    ProviderSessionModelSelection, ProviderSessionModelSelectionOutcome,
    ProviderSessionRuntimeModelsOutcome, SelectableProviderModelView,
};
pub use application::{
    InvalidProviderAccountDraft, ProviderAccountDraft, ProviderTextGenerationModelLimits,
    ProviderTextGenerationModelLimitsOutcome, ProviderTextGenerationModelLimitsRequest,
    ProviderTextGenerationOutcome, ProviderTextGenerationRequest,
};
pub use owner::actor::ProviderOwnerInput;
pub use ports::{
    DiscoveredProviderModel, ProviderAppliedStatus, ProviderConfigOps, ProviderConfigWriteEffect,
    ProviderFuture, ProviderModelDiscoveryOps, ProviderModelDiscoveryPortOutcome,
    ProviderNativeConfigurationCommand, ProviderNativeConfigurationDiagnostic,
    ProviderNativeConfigurationEffect, ProviderNativeConfigurationEvidence, ProviderObservedStatus,
    ProviderPrivateProjectionCommand, ProviderPrivateProjectionEffect,
    ProviderPrivateProjectionOps, ProviderProjectionBuildDiagnostic, ProviderRestartPreparation,
    ProviderRuntimeDirectory, ProviderRuntimeIdentity, ProviderRuntimeIdentityOps, Resolver,
    ResolverConfigurationError, ResolverFailure,
};

#[derive(Clone)]
pub struct ProviderModule {
    handle: ProviderHandle,
}

impl ProviderModule {
    fn new(handle: ProviderHandle) -> Self {
        Self { handle }
    }

    pub fn with_call_recorder(mut self, recorder: platform::call::CallRecorder) -> Self {
        self.handle = self.handle.with_call_recorder(recorder);
        self
    }

    pub fn handle(&self) -> &ProviderHandle {
        &self.handle
    }

    pub fn descriptor(&self, verifier: Arc<Mutex<CapabilityDecisionVerifier>>) -> ModuleDescriptor {
        ModuleDescriptor::with_capabilities(
            MODULE_ID,
            PROVIDES,
            REQUIRES,
            EFFECTS,
            ROUTES,
            EVENTS,
            Some(self.loopback_descriptor(verifier)),
            Some(CapabilityDescriptorProvider::new(
                capability::listed,
                capability::describe,
            )),
        )
    }

    fn loopback_descriptor(
        &self,
        verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    ) -> platform::loopback::ModuleDescriptor {
        adapters::loopback::descriptor(adapters::loopback::Dependencies::new(
            verifier,
            self.handle.clone(),
        ))
    }

    pub async fn configure_private_resolver(&self, resolver: Resolver) -> Result<(), ()> {
        self.handle
            .configure_provider_private_resolver(resolver)
            .await
    }

    pub async fn prepare_private_projection(&self) -> ProviderPrivateProjectionEffect {
        self.handle.prepare_private_projection().await
    }
}

pub fn spawn_owner(
    system: &OwnerRuntimeSystem,
    input: ProviderOwnerInput,
) -> (ProviderModule, OwnedTask<()>) {
    let owner = ProviderOwner::new(input);
    let (handle, task) = system.spawn_owner(
        owner,
        OwnerRuntimeConfig::new(64, ProviderOwner::lane_retention()),
    );
    (ProviderModule::new(ProviderHandle::new(handle)), task)
}

pub use domain::{
    CredentialReference, InvalidCredentialReference, InvalidProviderAccountConfiguration,
    InvalidProviderAccountId, InvalidProviderAccountRevision, InvalidProviderEndpoint,
    InvalidProviderModel, InvalidProviderModelReference, InvalidProviderReference,
    InvalidProviderRoute, InvalidProviderRouting, InvalidProviderRoutingRevision, ProviderAccount,
    ProviderAccountAuthMode, ProviderAccountConfiguration, ProviderAccountConfigurationInput,
    ProviderAccountId, ProviderAccountKind, ProviderAccountRevision, ProviderAccountSelection,
    ProviderApiProtocol, ProviderEndpoint, ProviderMediaApiProtocol, ProviderModel,
    ProviderModelCapability, ProviderModelCatalog, ProviderModelCatalogFault,
    ProviderModelReference, ProviderReference, ProviderRoute, ProviderRouting,
    ProviderRoutingCapability, ProviderRoutingRevision, provider_model_matches_routing_reference,
    provider_model_selection_id, provider_routing_account_ids, provider_routing_is_admissible,
    provider_routing_model_capability,
};
