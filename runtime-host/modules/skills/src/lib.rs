mod adapters;
pub mod bundle;
pub mod call;
pub mod capability;
pub mod control;
pub mod install;
pub mod management;
mod operation;
pub mod ports;
pub mod projection;
mod result;
pub mod status;

use std::{path::PathBuf, sync::Arc};

use platform::{
    call::{CallLogError, CallReceipt, CallRecorder},
    capability::CapabilityDecisionVerifier,
    module::{CapabilityDescriptorProvider, CapabilityKey, EffectKind, ModuleDescriptor, ModuleId},
};
use tokio::sync::Mutex;

pub use ports::{
    ClawHubSearchPort, ClawHubSearchResult, SealedResourceRead, SealedSkillCatalog,
    SealedSkillCatalogEntry, SealedSkillError, SealedSkillPackageExport, SealedSkillStorePort,
    SkillRuntimeOps, SkillsPort,
};

const MODULE_ID: ModuleId = ModuleId::new("skills");
const PROVIDES: &[CapabilityKey] = &[CapabilityKey::new("skills")];
const REQUIRES: &[CapabilityKey] = &[
    CapabilityKey::new("runtime.skills"),
    CapabilityKey::new("external.clawhub"),
    CapabilityKey::new("sealed-skill-store.read"),
];
const ROUTES: &[&str] = &["skills.loopback"];
const EVENTS: &[&str] = &[];
const EFFECTS: &[EffectKind] = &[
    EffectKind::OwnerTask,
    EffectKind::Route,
    EffectKind::FilesystemRead,
    EffectKind::FilesystemWrite,
    EffectKind::RuntimeOperation,
];

#[derive(Clone)]
pub struct SkillsModule {
    skills: Arc<dyn ports::SkillsPort>,
    clawhub: Arc<dyn ports::ClawHubSearchPort>,
    sealed: Arc<dyn ports::SealedSkillStorePort>,
    recorder: Option<CallRecorder>,
    operations: Arc<Mutex<operation::Operations>>,
}

impl SkillsModule {
    pub fn new(
        skills: Arc<dyn ports::SkillsPort>,
        clawhub: Arc<dyn ports::ClawHubSearchPort>,
        sealed: Arc<dyn ports::SealedSkillStorePort>,
    ) -> Self {
        Self {
            skills,
            clawhub,
            sealed,
            recorder: None,
            operations: Arc::new(Mutex::new(operation::Operations::default())),
        }
    }

    pub fn with_call_recorder(mut self, recorder: CallRecorder) -> Self {
        self.recorder = Some(recorder);
        self
    }

    pub async fn stop_operations(&self) {
        self.operations.lock().await.stop().await;
    }

    pub(crate) async fn submit_operation<F>(
        &self,
        call: operation::RecordedCall,
        operation: F,
    ) -> Result<CallReceipt, CallLogError>
    where
        F: std::future::Future<Output = platform::loopback::Response> + Send + 'static,
    {
        let admission = call.clone();
        self.operations
            .lock()
            .await
            .submit(call, None, operation)
            .await?;
        admission.accepted().await
    }

    pub(crate) async fn submit_result<F>(
        &self,
        call: operation::RecordedCall,
        access: result::ResultAccess,
        budget: usize,
        operation: F,
    ) -> Result<CallReceipt, CallLogError>
    where
        F: std::future::Future<Output = Result<result::SkillResult, platform::loopback::Response>>
            + Send
            + 'static,
    {
        let admission = call.clone();
        let mut operations = self.operations.lock().await;
        let results = operations.results.clone();
        let call_id = admission.context.id().clone();
        operations
            .submit(call, Some((access, budget)), async move {
                match operation.await {
                    Ok(result) => {
                        let response = result.response();
                        results.complete(&call_id, result).await;
                        response
                    }
                    Err(response) => {
                        results.remove(&call_id).await;
                        response
                    }
                }
            })
            .await?;
        drop(operations);
        admission.accepted().await
    }

    pub async fn install_clawhub_skill(
        &self,
        command: install::Command,
    ) -> Result<install::Outcome, ()> {
        self.skills.install_clawhub_skill(command).await
    }

    pub async fn skill_status(&self) -> Result<status::Outcome, ()> {
        self.skills.skill_status().await
    }

    pub async fn manage_skills(
        &self,
        command: management::Command,
    ) -> Result<management::Outcome, ()> {
        self.skills.manage_skills(command).await
    }

    pub async fn skill_bundles(&self, command: bundle::Command) -> Result<bundle::Outcome, ()> {
        self.skills.skill_bundles(command).await
    }

    pub async fn search_clawhub(
        &self,
        query: Option<String>,
        limit: u16,
    ) -> Result<Vec<ports::ClawHubSearchResult>, ()> {
        self.clawhub.search(query, limit).await
    }

    pub fn sealed_catalog(&self) -> Result<ports::SealedSkillCatalog, ports::SealedSkillError> {
        self.sealed.sealed_catalog()
    }

    pub fn export_sealed_skill_package(
        &self,
        skill_key: String,
    ) -> Result<ports::SealedSkillCatalogEntry, ports::SealedSkillError> {
        self.sealed.export_sealed_skill_package(skill_key)
    }

    pub fn export_cloud_sealed_skill_package(
        &self,
        skill_key: String,
        cloud_public_key: String,
        cloud_key_id: String,
    ) -> Result<ports::SealedSkillPackageExport, ports::SealedSkillError> {
        self.sealed
            .export_cloud_sealed_skill_package(skill_key, cloud_public_key, cloud_key_id)
    }

    pub fn install_sealed_skill(
        &self,
        package_path: PathBuf,
        cloud_metadata: Option<ports::CloudPackageMetadata>,
    ) -> Result<ports::SealedSkillCatalogEntry, ports::SealedSkillError> {
        self.sealed
            .install_sealed_skill(package_path, cloud_metadata)
    }

    pub fn read_sealed_skill_file(
        &self,
        token: &str,
        skill_key: String,
        path: String,
        expected_package_sha256: Option<&str>,
    ) -> Result<ports::SealedResourceRead, ports::SealedSkillError> {
        self.sealed
            .read_sealed_skill_file(token, skill_key, path, expected_package_sha256)
    }

    pub fn remove_sealed_skill(&self, skill_key: String) -> Result<bool, ports::SealedSkillError> {
        self.sealed.remove_sealed_skill(skill_key)
    }

    pub fn descriptor(&self, verifier: Arc<Mutex<CapabilityDecisionVerifier>>) -> ModuleDescriptor {
        ModuleDescriptor::with_capabilities(
            MODULE_ID,
            PROVIDES,
            REQUIRES,
            EFFECTS,
            ROUTES,
            EVENTS,
            Some(adapters::loopback::descriptor(
                adapters::loopback::Dependencies::new(verifier, self.clone()),
            )),
            Some(CapabilityDescriptorProvider::new(
                capability::listed,
                capability::describe,
            )),
        )
    }
}
