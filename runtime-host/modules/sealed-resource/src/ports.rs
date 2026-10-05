use std::{path::PathBuf, sync::Arc};

use platform::{
    call::{CallContext, CallRecorder, CallStatus},
    capability::CapabilityDecisionVerifier,
    module::{CapabilityKey, EffectKind, ModuleDescriptor, ModuleId},
    state_dir::CanonicalStateDir,
};
use skills_module::projection::sealed as skill_projection;
use tokio::sync::Mutex;

use crate::{
    api::{
        SealedCloudPackageEntry, SealedCloudPackageMetadata, SealedCloudPackageType,
        SealedPackageAuthorizationKey, SealedPackageAuthorizationKeyring, SealedResourceError,
        SealedResourceRead, now_millis,
    },
    call::{AuthorizationValidity, SealedResourceCallDetail, safe_digest},
    domain::{AgentKey, PackageRelativePath, SkillKey},
    store::{
        SealedAgentCatalogEntry, SealedAgentInstallPlan, SealedAgentPackageExport,
        SealedAgentRuntimeProjection, SealedAgentStore, SealedSkillCatalog,
        SealedSkillCatalogEntry, SealedSkillPackageExport, SealedSkillStore,
    },
};

const MODULE_ID: ModuleId = ModuleId::new("sealed-resource");
const PROVIDES: &[CapabilityKey] = &[
    CapabilityKey::new("sealed-skill-store.read"),
    CapabilityKey::new("sealed-agent-store.read"),
];
const REQUIRES: &[CapabilityKey] = &[];
const ROUTES: &[&str] = &["sealed-resource.loopback"];
const EVENTS: &[&str] = &[];
const EFFECTS: &[EffectKind] = &[
    EffectKind::FilesystemRead,
    EffectKind::FilesystemWrite,
    EffectKind::Route,
];

#[derive(Clone)]
pub struct SealedResourceModule {
    skill_store: Arc<SealedSkillStore>,
    agent_store: Arc<SealedAgentStore>,
    skills: Arc<dyn skills_module::SealedSkillStorePort>,
    agents: Arc<dyn subagents::SealedAgentStorePort>,
    authorization_keyring: Arc<SealedPackageAuthorizationKeyring>,
    call_recorder: Option<CallRecorder>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SealedResourceProvisionError {
    Skills,
    Agents,
}

impl SealedResourceModule {
    fn new(
        skill_store: Arc<SealedSkillStore>,
        agent_store: Arc<SealedAgentStore>,
        runtime_token: Option<Arc<str>>,
        authorization_keyring: Arc<SealedPackageAuthorizationKeyring>,
    ) -> Self {
        Self {
            skill_store: skill_store.clone(),
            agent_store: agent_store.clone(),
            skills: Arc::new(SealedSkillStoreAdapter::new(
                skill_store,
                runtime_token.clone(),
            )),
            agents: Arc::new(SealedAgentStoreAdapter::new(agent_store, runtime_token)),
            authorization_keyring,
            call_recorder: None,
        }
    }

    pub fn with_call_recorder(mut self, recorder: CallRecorder) -> Self {
        self.call_recorder = Some(recorder);
        self
    }

    pub fn openclaw(
        state_dir: CanonicalStateDir,
        agent_runtime: Arc<dyn SealedAgentRuntimeProjection>,
        skill_private_root: PathBuf,
        agent_private_root: PathBuf,
        runtime_token: Option<Arc<str>>,
    ) -> Result<Self, SealedResourceProvisionError> {
        let authorization_keyring = Arc::new(SealedPackageAuthorizationKeyring::new());
        let skill_store = Arc::new(
            SealedSkillStore::openclaw_with_keyring(
                state_dir,
                skill_private_root,
                Arc::clone(&authorization_keyring),
            )
            .map_err(|_| SealedResourceProvisionError::Skills)?,
        );
        let agent_store = Arc::new(
            SealedAgentStore::openclaw_with_keyring(
                agent_runtime,
                agent_private_root,
                Arc::clone(&authorization_keyring),
            )
            .map_err(|_| SealedResourceProvisionError::Agents)?,
        );
        Ok(Self::new(
            skill_store,
            agent_store,
            runtime_token,
            authorization_keyring,
        ))
    }

    pub fn skills_port(&self) -> Arc<dyn skills_module::SealedSkillStorePort> {
        self.skills.clone()
    }

    pub fn agents_port(&self) -> Arc<dyn subagents::SealedAgentStorePort> {
        self.agents.clone()
    }

    pub fn register_authorization_key(
        &self,
        package_sha256: String,
        authorization_key: SealedPackageAuthorizationKey,
        lease_expires_at_ms: u64,
    ) -> Result<(), SealedResourceError> {
        self.authorization_keyring.register_authorization_key(
            package_sha256,
            authorization_key,
            lease_expires_at_ms,
        )
    }

    pub(crate) async fn authorize_package(
        &self,
        package_sha256: String,
        authorization_key: Result<SealedPackageAuthorizationKey, SealedResourceError>,
        lease_expires_at_ms: Result<u64, SealedResourceError>,
    ) -> Result<(), SealedResourceError> {
        let mut detail = SealedResourceCallDetail::default();
        detail.package_sha256 = safe_digest(&package_sha256);
        let call = self.begin_call("authorizePackage", &detail).await?;
        let result = authorization_key.and_then(|key| {
            self.register_authorization_key(package_sha256, key, lease_expires_at_ms?)
        });
        detail.authorization = match result {
            Ok(()) => Some(AuthorizationValidity::Valid),
            Err(SealedResourceError::Rejected | SealedResourceError::RejectedWith(_)) => {
                Some(AuthorizationValidity::Invalid)
            }
            Err(_) => None,
        };
        self.finish_call(call, &mut detail, &result).await;
        result
    }

    pub async fn list_cloud_packages(
        &self,
    ) -> Result<Vec<SealedCloudPackageEntry>, SealedResourceError> {
        let mut detail = SealedResourceCallDetail::default();
        let call = self.begin_call("listCloudPackages", &detail).await?;
        let result = (|| {
            let mut packages = self.skill_store.cloud_packages()?;
            packages.extend(self.agent_store.cloud_packages()?);
            packages.sort_by(|left, right| left.package_sha256.cmp(&right.package_sha256));
            packages.dedup_by(|left, right| left.package_sha256 == right.package_sha256);
            Ok(packages)
        })();
        if let Ok(packages) = &result {
            detail.catalog(packages);
        }
        self.finish_call(call, &mut detail, &result).await;
        result
    }

    pub async fn clear_authorizations(&self) -> Result<(), SealedResourceError> {
        let mut detail = SealedResourceCallDetail::default();
        // Audit failure must not prevent logout from revoking private authorization keys.
        let call = self
            .begin_call("clearAuthorizations", &detail)
            .await
            .ok()
            .flatten();
        let result = self.authorization_keyring.clear();
        if result.is_ok() {
            detail.authorization = Some(AuthorizationValidity::Cleared);
        }
        self.finish_call(call, &mut detail, &result).await;
        result
    }

    pub(crate) async fn reject_call(&self, command: &'static str) {
        let Some(recorder) = &self.call_recorder else {
            return;
        };
        let mut detail = SealedResourceCallDetail::default();
        detail.error = Some(crate::call::CallError::Rejected);
        match recorder.begin(command, &detail).await {
            Ok(call) => {
                if call.finish(CallStatus::Rejected, &detail).await.is_err() {
                    eprintln!(
                        "[sealed-resource:call] phase=finish outcome=audit-unavailable callId={}",
                        call.id().as_str()
                    );
                }
            }
            Err(_) => eprintln!("[sealed-resource:call] phase=begin outcome=audit-unavailable"),
        }
    }

    async fn begin_call(
        &self,
        command: &'static str,
        detail: &SealedResourceCallDetail,
    ) -> Result<Option<CallContext<SealedResourceCallDetail>>, SealedResourceError> {
        let Some(recorder) = &self.call_recorder else {
            return Ok(None);
        };
        let call = recorder.begin(command, detail).await.map_err(|_| {
            eprintln!("[sealed-resource:call] phase=begin outcome=audit-unavailable");
            SealedResourceError::Unknown
        })?;
        if call.running().await.is_err() {
            eprintln!(
                "[sealed-resource:call] phase=running outcome=audit-unavailable callId={}",
                call.id().as_str()
            );
            let mut detail = detail.clone();
            detail.error = Some(crate::call::CallError::AuditUnavailable);
            if call.finish(CallStatus::Unknown, &detail).await.is_err() {
                eprintln!("[sealed-resource:call] phase=finish outcome=audit-unavailable");
            }
            return Err(SealedResourceError::Unknown);
        }
        Ok(Some(call))
    }

    async fn finish_call<T>(
        &self,
        call: Option<CallContext<SealedResourceCallDetail>>,
        detail: &mut SealedResourceCallDetail,
        result: &Result<T, SealedResourceError>,
    ) {
        let status = detail.result(result);
        if let Some(call) = call {
            if call.finish(status, detail).await.is_err() {
                eprintln!(
                    "[sealed-resource:call] phase=finish outcome=audit-unavailable callId={}",
                    call.id().as_str()
                );
            }
        }
    }

    pub fn install_skill_package_path_with_cloud_metadata(
        &self,
        package_path: PathBuf,
        metadata: SealedCloudPackageMetadata,
    ) -> Result<SealedSkillCatalogEntry, SealedResourceError> {
        self.skill_store
            .install_package_path_with_cloud_metadata(package_path, metadata)
    }

    pub fn prepare_agent_install_with_cloud_metadata(
        &self,
        package_path: PathBuf,
        metadata: SealedCloudPackageMetadata,
    ) -> Result<SealedAgentInstallPlan, SealedResourceError> {
        self.agent_store
            .prepare_install_with_cloud_metadata(package_path, metadata)
    }

    pub fn install_agent_package_path_with_cloud_metadata(
        &self,
        package_path: PathBuf,
        metadata: SealedCloudPackageMetadata,
    ) -> Result<SealedAgentCatalogEntry, SealedResourceError> {
        self.agent_store
            .install_package_path_with_cloud_metadata(package_path, metadata)
    }

    pub fn descriptor(&self, verifier: Arc<Mutex<CapabilityDecisionVerifier>>) -> ModuleDescriptor {
        ModuleDescriptor::new(
            MODULE_ID,
            PROVIDES,
            REQUIRES,
            EFFECTS,
            ROUTES,
            EVENTS,
            Some(crate::adapters::loopback::descriptor(
                crate::adapters::loopback::Dependencies::new(verifier, self.clone()),
            )),
        )
    }
}

struct SealedSkillStoreAdapter {
    store: Arc<SealedSkillStore>,
    runtime_token: Option<Arc<str>>,
}

impl SealedSkillStoreAdapter {
    fn new(store: Arc<SealedSkillStore>, runtime_token: Option<Arc<str>>) -> Self {
        Self {
            store,
            runtime_token,
        }
    }
}

impl skills_module::SealedSkillStorePort for SealedSkillStoreAdapter {
    fn sealed_catalog(
        &self,
    ) -> Result<skills_module::SealedSkillCatalog, skills_module::SealedSkillError> {
        self.store
            .catalog()
            .map(SealedSkillCatalogProjectionInput::from_catalog)
            .map(skill_projection::project_catalog)
            .map_err(project_skill_error)
    }

    fn export_sealed_skill_package(
        &self,
        skill_key: String,
    ) -> Result<skills_module::SealedSkillCatalogEntry, skills_module::SealedSkillError> {
        let skill_key =
            SkillKey::parse(skill_key).map_err(|_| skill_projection::rejected_error())?;
        self.store
            .export_plain_directory_package(skill_key)
            .map(SealedSkillCatalogEntryProjectionInput)
            .map(skill_projection::project_entry)
            .map_err(project_skill_error)
    }

    fn export_cloud_sealed_skill_package(
        &self,
        skill_key: String,
        cloud_public_key: String,
        cloud_key_id: String,
    ) -> Result<skills_module::SealedSkillPackageExport, skills_module::SealedSkillError> {
        let skill_key =
            SkillKey::parse(skill_key).map_err(|_| skill_projection::rejected_error())?;
        self.store
            .export_cloud_directory_package(skill_key, cloud_public_key, cloud_key_id)
            .map(project_skill_export)
            .map_err(project_skill_error)
    }

    fn install_sealed_skill(
        &self,
        package_path: PathBuf,
        cloud_metadata: Option<skills_module::ports::CloudPackageMetadata>,
    ) -> Result<skills_module::SealedSkillCatalogEntry, skills_module::SealedSkillError> {
        match cloud_metadata {
            Some(metadata) => self.store.install_package_path_with_cloud_metadata(
                package_path,
                skill_cloud_metadata(metadata)?,
            ),
            None => self.store.install_package_path(package_path),
        }
        .map(SealedSkillCatalogEntryProjectionInput)
        .map(skill_projection::project_entry)
        .map_err(project_skill_error)
    }

    fn read_sealed_skill_file(
        &self,
        token: &str,
        skill_key: String,
        path: String,
        expected_package_sha256: Option<&str>,
    ) -> Result<skills_module::SealedResourceRead, skills_module::SealedSkillError> {
        if !self
            .runtime_token
            .as_deref()
            .is_some_and(|expected| expected == token)
        {
            return Err(skill_projection::rejected_error());
        }
        let skill_key =
            SkillKey::parse(skill_key).map_err(|_| skill_projection::rejected_error())?;
        let path =
            PackageRelativePath::parse(path).map_err(|_| skill_projection::rejected_error())?;
        let read = self
            .store
            .read_file(skill_key, path)
            .map_err(project_skill_error)?;
        if expected_package_sha256.is_some_and(|expected| expected != read.package_sha256()) {
            return Err(skills_module::SealedSkillError::PackageChanged);
        }
        Ok(skill_projection::project_read(
            SealedResourceReadProjectionInput(read),
        ))
    }

    fn remove_sealed_skill(
        &self,
        skill_key: String,
    ) -> Result<bool, skills_module::SealedSkillError> {
        let skill_key =
            SkillKey::parse(skill_key).map_err(|_| skill_projection::rejected_error())?;
        self.store
            .remove_package(skill_key)
            .map_err(project_skill_error)
    }
}

struct SealedAgentStoreAdapter {
    store: Arc<SealedAgentStore>,
    runtime_token: Option<Arc<str>>,
}

impl SealedAgentStoreAdapter {
    fn new(store: Arc<SealedAgentStore>, runtime_token: Option<Arc<str>>) -> Self {
        Self {
            store,
            runtime_token,
        }
    }
}

impl subagents::SealedAgentStorePort for SealedAgentStoreAdapter {
    fn export_package(
        &self,
        agent_id: String,
        agent_name: String,
    ) -> Result<subagents::PackageExportReceipt, subagents::SealedAgentError> {
        let agent_key =
            AgentKey::parse(agent_id).map_err(|_| subagents::SealedAgentError::Rejected)?;
        self.store
            .export_plain_workspace_package(agent_key, &agent_name)
            .map(project_agent_export)
            .map_err(project_agent_error)
    }

    fn export_cloud_package(
        &self,
        agent_id: String,
        agent_name: String,
        cloud_public_key: String,
        cloud_key_id: String,
    ) -> Result<subagents::PackageExportReceipt, subagents::SealedAgentError> {
        let agent_key =
            AgentKey::parse(agent_id).map_err(|_| subagents::SealedAgentError::Rejected)?;
        self.store
            .export_cloud_workspace_package(agent_key, &agent_name, cloud_public_key, cloud_key_id)
            .map(project_agent_export)
            .map_err(project_agent_error)
    }

    fn prepare_install(
        &self,
        package_path: String,
        cloud_metadata: Option<subagents::CloudPackageMetadata>,
    ) -> Result<subagents::PackageInstallPlan, subagents::SealedAgentError> {
        match cloud_metadata {
            Some(metadata) => self.store.prepare_install_with_cloud_metadata(
                PathBuf::from(package_path),
                agent_cloud_metadata(metadata)?,
            ),
            None => self.store.prepare_install(PathBuf::from(package_path)),
        }
        .map(project_agent_install_plan)
        .map_err(project_agent_error)
    }

    fn install_prepared_package(
        &self,
        package_path: String,
        cloud_metadata: Option<subagents::CloudPackageMetadata>,
    ) -> Result<subagents::PackageInstallReceipt, subagents::SealedAgentError> {
        match cloud_metadata {
            Some(metadata) => self.store.install_package_path_with_cloud_metadata(
                PathBuf::from(package_path),
                agent_cloud_metadata(metadata)?,
            ),
            None => self.store.install_package_path(PathBuf::from(package_path)),
        }
        .map(|entry| subagents::PackageInstallReceipt::new(entry.agent_key().as_str().to_owned()))
        .map_err(project_agent_error)
    }

    fn remove_package(&self, agent_id: String) -> Result<bool, subagents::SealedAgentError> {
        let agent_key =
            AgentKey::parse(agent_id).map_err(|_| subagents::SealedAgentError::Rejected)?;
        self.store
            .remove_package(agent_key)
            .map_err(project_agent_error)
    }

    fn agents_using_sealed_source(
        &self,
        agent_ids: &[String],
    ) -> Result<Vec<String>, subagents::SealedAgentError> {
        let agent_keys = agent_ids
            .iter()
            .filter_map(|agent_id| AgentKey::parse(agent_id.clone()).ok())
            .collect::<Vec<_>>();
        self.store
            .agents_using_sealed_source(&agent_keys)
            .map(|sealed| {
                sealed
                    .into_iter()
                    .map(|agent_key| agent_key.as_str().to_owned())
                    .collect()
            })
            .map_err(project_agent_error)
    }

    fn read_file(
        &self,
        token: &str,
        agent_id: String,
        path: String,
    ) -> Result<subagents::SealedAgentRead, subagents::SealedAgentError> {
        if !self
            .runtime_token
            .as_deref()
            .is_some_and(|expected| expected == token)
        {
            return Err(subagents::SealedAgentError::Rejected);
        }
        let agent_key =
            AgentKey::parse(agent_id).map_err(|_| subagents::SealedAgentError::Rejected)?;
        let path =
            PackageRelativePath::parse(path).map_err(|_| subagents::SealedAgentError::Rejected)?;
        self.store
            .read_file(agent_key, path)
            .map(|read| {
                subagents::SealedAgentRead::new(
                    read.content().to_vec(),
                    read.metering_binding()
                        .map(|binding| binding.as_str().to_owned()),
                )
            })
            .map_err(project_agent_error)
    }
}

struct SealedSkillCatalogProjectionInput {
    entries: Vec<SealedSkillCatalogEntryProjectionInput>,
}

impl SealedSkillCatalogProjectionInput {
    fn from_catalog(catalog: SealedSkillCatalog) -> Self {
        Self {
            entries: catalog
                .entries()
                .iter()
                .cloned()
                .map(SealedSkillCatalogEntryProjectionInput)
                .collect(),
        }
    }
}

impl skill_projection::SealedCatalogProjection for SealedSkillCatalogProjectionInput {
    type Entry = SealedSkillCatalogEntryProjectionInput;

    fn entries(&self) -> &[Self::Entry] {
        &self.entries
    }
}

struct SealedSkillCatalogEntryProjectionInput(SealedSkillCatalogEntry);

impl skill_projection::SealedEntryProjection for SealedSkillCatalogEntryProjectionInput {
    fn skill_key(&self) -> &str {
        self.0.skill_key().as_str()
    }

    fn name(&self) -> &str {
        self.0.descriptor().name()
    }

    fn description(&self) -> &str {
        self.0.descriptor().description()
    }

    fn runtime_target(&self) -> &'static str {
        self.0.runtime_target().as_str()
    }
}

struct SealedResourceReadProjectionInput(SealedResourceRead);

impl skill_projection::SealedReadProjection for SealedResourceReadProjectionInput {
    fn content(&self) -> &[u8] {
        self.0.content()
    }

    fn metering_binding(&self) -> Option<&str> {
        self.0.metering_binding().map(|binding| binding.as_str())
    }

    fn package_sha256(&self) -> &str {
        self.0.package_sha256()
    }
}

struct SealedResourceErrorProjectionInput(SealedResourceError);

impl skill_projection::SealedErrorProjection for SealedResourceErrorProjectionInput {
    fn sealed_error_kind(&self) -> skill_projection::SealedErrorKind {
        match self.0 {
            SealedResourceError::AlreadyExists => skill_projection::SealedErrorKind::AlreadyExists,
            SealedResourceError::NotFound => skill_projection::SealedErrorKind::NotFound,
            SealedResourceError::Rejected | SealedResourceError::RejectedWith(_) => {
                skill_projection::SealedErrorKind::Rejected
            }
            SealedResourceError::Unknown => skill_projection::SealedErrorKind::Unknown,
        }
    }
}

fn project_skill_error(error: SealedResourceError) -> skills_module::SealedSkillError {
    match error.rejection_detail() {
        Some(detail) => {
            skills_module::SealedSkillError::rejected_with(detail.reason(), detail.message())
        }
        None => skill_projection::project_error(SealedResourceErrorProjectionInput(error)),
    }
}

fn project_skill_export(
    export: SealedSkillPackageExport,
) -> skills_module::SealedSkillPackageExport {
    skills_module::SealedSkillPackageExport::new(
        export.entry().skill_key().as_str().to_owned(),
        export.file_name().to_owned(),
        export.package_sha256().to_owned(),
        export.into_package_bytes(),
    )
}

fn skill_cloud_metadata(
    metadata: skills_module::ports::CloudPackageMetadata,
) -> Result<SealedCloudPackageMetadata, skills_module::SealedSkillError> {
    let package_sha256 = metadata
        .package_sha256()
        .ok_or_else(skill_projection::rejected_error)?
        .to_owned();
    let file_name = metadata
        .file_name()
        .ok_or_else(skill_projection::rejected_error)?
        .to_owned();
    SealedCloudPackageMetadata::new(
        metadata.package_version_id().to_owned(),
        cloud_package_type(metadata.package_type(), SealedCloudPackageType::Skill)
            .map_err(project_skill_error)?,
        package_sha256,
        file_name,
        now_millis(),
    )
    .map_err(project_skill_error)
}

fn agent_cloud_metadata(
    metadata: subagents::CloudPackageMetadata,
) -> Result<SealedCloudPackageMetadata, subagents::SealedAgentError> {
    let package_sha256 = metadata
        .package_sha256()
        .ok_or(subagents::SealedAgentError::Rejected)?
        .to_owned();
    let file_name = metadata
        .file_name()
        .ok_or(subagents::SealedAgentError::Rejected)?
        .to_owned();
    SealedCloudPackageMetadata::new(
        metadata.package_version_id().to_owned(),
        cloud_package_type(metadata.package_type(), SealedCloudPackageType::Agent)
            .map_err(project_agent_error)?,
        package_sha256,
        file_name,
        now_millis(),
    )
    .map_err(project_agent_error)
}

fn cloud_package_type(
    value: &str,
    expected: SealedCloudPackageType,
) -> Result<SealedCloudPackageType, SealedResourceError> {
    match (value, expected) {
        ("skill", SealedCloudPackageType::Skill) => Ok(SealedCloudPackageType::Skill),
        ("agent", SealedCloudPackageType::Agent) => Ok(SealedCloudPackageType::Agent),
        _ => Err(SealedResourceError::Rejected),
    }
}

fn project_agent_export(receipt: SealedAgentPackageExport) -> subagents::PackageExportReceipt {
    let exported_at_ms = receipt.exported_at_ms();
    subagents::PackageExportReceipt::new(
        receipt.agent_key().as_str().to_owned(),
        receipt.file_name().to_owned(),
        receipt.package_sha256().to_owned(),
        receipt.into_package_bytes(),
        exported_at_ms,
    )
}

fn project_agent_install_plan(plan: SealedAgentInstallPlan) -> subagents::PackageInstallPlan {
    subagents::PackageInstallPlan::new(
        plan.agent_key().as_str().to_owned(),
        plan.workspace().to_string_lossy().into_owned(),
        plan.workspace_preexisted(),
    )
}

fn project_agent_error(error: SealedResourceError) -> subagents::SealedAgentError {
    match error {
        SealedResourceError::AlreadyExists => subagents::SealedAgentError::AlreadyExists,
        SealedResourceError::NotFound => subagents::SealedAgentError::NotFound,
        SealedResourceError::Rejected | SealedResourceError::RejectedWith(_) => {
            subagents::SealedAgentError::Rejected
        }
        SealedResourceError::Unknown => subagents::SealedAgentError::Unknown,
    }
}
