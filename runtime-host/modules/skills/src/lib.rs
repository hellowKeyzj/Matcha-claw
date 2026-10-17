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
pub mod selection;
pub mod status;

use std::{path::PathBuf, sync::Arc};

use platform::{
    call::{CallLogError, CallReceipt, CallRecorder},
    capability::CapabilityDecisionVerifier,
    module::{CapabilityDescriptorProvider, CapabilityKey, EffectKind, ModuleDescriptor, ModuleId},
    endpoint::runtime_address::RuntimeScope,
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

pub use ports::{
    ClawHubSearchPort, ClawHubSearchResult, SealedResourceRead, SealedSkillCatalog,
    SealedSkillCatalogEntry, SealedSkillError, SealedSkillExport, SealedSkillPackageExport,
    SealedSkillStoreFactoryPort, SealedSkillStorePort, SkillRuntimeOps, SkillsPort, SkillsRuntimeDirectory,
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
    sealed_factory: Option<Arc<dyn ports::SealedSkillStoreFactoryPort>>,
    scoped_sealed: Option<Result<Arc<dyn ports::SealedSkillStorePort>, ports::SealedSkillError>>,
    recorder: Option<CallRecorder>,
    operations: Arc<Mutex<operation::Operations>>,
    runtime_scope: Option<RuntimeScope>,
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
            sealed_factory: None,
            scoped_sealed: None,
            recorder: None,
            operations: Arc::new(Mutex::new(operation::Operations::default())),
            runtime_scope: None,
        }
    }

    pub fn with_runtime_scope(mut self, scope: RuntimeScope) -> Self {
        self.scoped_sealed = if selection::is_openclaw_scope(&scope) {
            None
        } else {
            Some(match &scope {
                RuntimeScope::Agent { endpoint, agent_id }
                    if endpoint == &runtime_directory::RuntimeDriverIdentity::matcha_agent().endpoint() => {
                    self.sealed_factory.as_ref()
                        .ok_or(ports::SealedSkillError::Rejected)
                        .and_then(|factory| factory.for_agent(agent_id))
                }
                _ => Err(ports::SealedSkillError::Rejected),
            })
        };
        self.runtime_scope = Some(scope);
        self
    }

    pub fn with_sealed_skill_factory(
        mut self,
        factory: Arc<dyn ports::SealedSkillStoreFactoryPort>,
    ) -> Self {
        self.sealed_factory = Some(factory);
        if let Some(scope) = self.runtime_scope.clone() {
            self = self.with_runtime_scope(scope);
        }
        self
    }

    fn sealed_store(&self) -> Result<&Arc<dyn ports::SealedSkillStorePort>, ports::SealedSkillError> {
        match &self.scoped_sealed {
            Some(Ok(store)) => Ok(store),
            Some(Err(error)) => Err(error.clone()),
            None => Ok(&self.sealed),
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
        effect: operation::Effect,
        operation: F,
    ) -> Result<CallReceipt, CallLogError>
    where
        F: std::future::Future<Output = platform::loopback::Response> + Send + 'static,
    {
        self.submit_cancellable_operation(call, effect, move |_| operation)
            .await
    }

    pub(crate) async fn submit_cancellable_operation<F, U>(
        &self,
        call: operation::RecordedCall,
        effect: operation::Effect,
        operation: F,
    ) -> Result<CallReceipt, CallLogError>
    where
        F: FnOnce(CancellationToken) -> U + Send + 'static,
        U: std::future::Future<Output = platform::loopback::Response> + Send + 'static,
    {
        let admission = call.clone();
        self.operations
            .lock()
            .await
            .submit(call, effect, None, operation)
            .await?;
        admission.accepted().await
    }

    pub(crate) async fn submit_result<F>(
        &self,
        call: operation::RecordedCall,
        effect: operation::Effect,
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
            .submit(call, effect, Some((access, budget)), move |_| async move {
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
        self.install_clawhub_skill_cancellable(command, CancellationToken::new()).await
    }

    pub(crate) async fn install_clawhub_skill_cancellable(
        &self,
        command: install::Command,
        cancellation: CancellationToken,
    ) -> Result<install::Outcome, ()> {
        match &self.runtime_scope {
            Some(scope) => self.skills.install_clawhub_skill_for_scope(scope, command, cancellation).await,
            None => self.skills.install_clawhub_skill_cancellable(command, cancellation).await,
        }
    }

    pub async fn skill_status(&self) -> Result<status::Outcome, ()> {
        let mut outcome = match &self.runtime_scope {
            Some(scope) => self.skills.skill_status_for_scope(scope).await?,
            None => self.skills.skill_status().await?,
        };
        if self.scoped_sealed.is_some() {
            let sealed = self.sealed_catalog().map_err(|_| ())?;
            if let status::Outcome::Available(catalog) = &mut outcome {
                for entry in sealed.entries() {
                    if catalog.entries.iter().any(|ordinary| ordinary.key == entry.skill_key()) {
                        continue;
                    }
                    catalog.entries.push(status::Entry {
                        key: entry.skill_key().into(), slug: None, name: entry.name().into(),
                        description: entry.description().into(), enabled: true, selectable: false,
                        eligible: false, blocked_by_allowlist: false, bundled: None, always: None,
                        emoji: None, source: Some("matcha-sealed".into()), uninstallable: false,
                        base_dir: None, file_path: None, missing_categories: Vec::new(),
                    });
                }
            }
        }
        Ok(outcome)
    }

    pub async fn manage_skills(
        &self,
        command: management::Command,
    ) -> Result<management::Outcome, ()> {
        self.manage_skills_cancellable(command, CancellationToken::new()).await
    }

    pub(crate) async fn manage_skills_cancellable(
        &self,
        command: management::Command,
        cancellation: CancellationToken,
    ) -> Result<management::Outcome, ()> {
        match &self.runtime_scope {
            Some(scope) => self.skills.manage_skills_for_scope(scope, command, cancellation).await,
            None => self.skills.manage_skills_cancellable(command, cancellation).await,
        }
    }

    pub async fn skill_bundles(&self, command: bundle::Command) -> Result<bundle::Outcome, ()> {
        match &self.runtime_scope {
            Some(scope) => self.skills.skill_bundles_for_scope(scope, command).await,
            None => self.skills.skill_bundles(command).await,
        }
    }

    pub async fn search_clawhub(
        &self,
        query: Option<String>,
        limit: u16,
    ) -> Result<Vec<ports::ClawHubSearchResult>, ()> {
        self.clawhub.search(query, limit).await
    }

    pub fn sealed_catalog(&self) -> Result<ports::SealedSkillCatalog, ports::SealedSkillError> {
        self.sealed_store()?.sealed_catalog()
    }

    pub async fn export_sealed_skill_package(
        &self,
        skill_key: String,
    ) -> Result<ports::SealedSkillExport, ports::SealedSkillError> {
        let sealed = Arc::clone(self.sealed_store()?);
        if let Some(scope) = &self.runtime_scope {
            if !selection::is_openclaw_scope(scope) {
                let source = self.skills.skill_source_for_scope(scope, &skill_key).await?;
                let exported_key = skill_key.clone();
                let export = tokio::task::spawn_blocking(move || {
                    sealed.export_sealed_skill_files(exported_key, source.files)
                }).await.map_err(|_| ports::SealedSkillError::Unknown)??;
                let cleanup_failed = export.cleanup_failed()
                    || self.skills.remove_skill_source_for_scope(scope, &skill_key, &source.sha256).await.is_err();
                return Ok(ports::SealedSkillExport::new(export.entry().clone(), cleanup_failed));
            }
        }
        let directory = self.skill_directory(&skill_key).await?;
        let sealed = Arc::clone(self.sealed_store()?);
        tokio::task::spawn_blocking(move || {
            sealed.export_sealed_skill_package(skill_key, directory)
        })
        .await
        .map_err(|_| ports::SealedSkillError::Unknown)?
    }

    pub async fn export_cloud_sealed_skill_package(
        &self,
        skill_key: String,
        cloud_public_key: String,
        cloud_key_id: String,
    ) -> Result<ports::SealedSkillPackageExport, ports::SealedSkillError> {
        let sealed = Arc::clone(self.sealed_store()?);
        if let Some(scope) = &self.runtime_scope {
            if !selection::is_openclaw_scope(scope) {
                if sealed.sealed_catalog()?.entries().iter().any(|entry| entry.skill_key() == skill_key) {
                    return tokio::task::spawn_blocking(move || {
                        sealed.export_installed_cloud_sealed_skill_package(skill_key, cloud_public_key, cloud_key_id)
                    }).await.map_err(|_| ports::SealedSkillError::Unknown)?;
                }
                let source = self.skills.skill_source_for_scope(scope, &skill_key).await?;
                let exported_key = skill_key.clone();
                let export = tokio::task::spawn_blocking(move || {
                    sealed.export_cloud_sealed_skill_files(exported_key, source.files, cloud_public_key, cloud_key_id)
                }).await.map_err(|_| ports::SealedSkillError::Unknown)??;
                let cleanup_failed = export.cleanup_failed()
                    || self.skills.remove_skill_source_for_scope(scope, &skill_key, &source.sha256).await.is_err();
                let key = export.skill_key().to_owned();
                let file_name = export.file_name().to_owned();
                let sha256 = export.package_sha256().to_owned();
                return Ok(ports::SealedSkillPackageExport::new(key, file_name, sha256, export.into_package_bytes(), cleanup_failed));
            }
        }
        let directory = self.skill_directory(&skill_key).await?;
        let sealed = Arc::clone(self.sealed_store()?);
        tokio::task::spawn_blocking(move || {
            sealed.export_cloud_sealed_skill_package(
                skill_key,
                directory,
                cloud_public_key,
                cloud_key_id,
            )
        })
        .await
        .map_err(|_| ports::SealedSkillError::Unknown)?
    }

    async fn skill_directory(&self, skill_key: &str) -> Result<PathBuf, ports::SealedSkillError> {
        let skill_key = skill_key.trim();
        let status::Outcome::Available(catalog) = self
            .skill_status()
            .await
            .map_err(|_| ports::SealedSkillError::Unknown)?
        else {
            return Err(ports::SealedSkillError::Unknown);
        };
        let entry = catalog
            .entries
            .into_iter()
            .find(|entry| entry.key == skill_key)
            .ok_or(ports::SealedSkillError::NotFound)?;
        if entry.bundled == Some(true)
            || matches!(
                entry.source.as_deref(),
                Some("bundled" | "openclaw-bundled" | "matcha-sealed")
            )
        {
            return Err(ports::SealedSkillError::Rejected);
        }
        entry
            .base_dir
            .map(PathBuf::from)
            .ok_or(ports::SealedSkillError::NotFound)
    }

    pub fn install_sealed_skill(
        &self,
        package_path: PathBuf,
        cloud_metadata: Option<ports::CloudPackageMetadata>,
    ) -> Result<ports::SealedSkillCatalogEntry, ports::SealedSkillError> {
        self.sealed_store()?
            .install_sealed_skill(package_path, cloud_metadata)
    }

    pub fn read_sealed_skill_file(
        &self,
        token: &str,
        skill_key: String,
        path: String,
        expected_package_sha256: Option<&str>,
    ) -> Result<ports::SealedResourceRead, ports::SealedSkillError> {
        self.sealed_store()?
            .read_sealed_skill_file(token, skill_key, path, expected_package_sha256)
    }

    pub fn remove_sealed_skill(&self, skill_key: String) -> Result<bool, ports::SealedSkillError> {
        self.sealed_store()?.remove_sealed_skill(skill_key)
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
