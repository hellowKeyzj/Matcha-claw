use super::{
    InstalledSkillCatalog, OpenClawInstalledSkillCatalog, OpenClawSkillOperations,
    OpenClawSkillStatusCatalog, SkillConfigRemoveOutcome, SkillDetail, SkillDetailRequest,
    SkillInstallRequest, SkillMutationOutcome, SkillReadError, SkillStatusCatalog,
    SkillStatusCatalogError, SkillUpdateRequest, SkillUploadBegin, SkillUploadChunk,
    SkillUploadCommit,
};
use crate::{
    agents::{AgentsReadFailure, OpenClawAgents},
    port::OpenClawGateway,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SkillUploadOutcome {
    Progress {
        upload_id: String,
        received_bytes: u64,
        expires_at: u64,
    },
    Commit {
        upload_id: String,
        received_bytes: u64,
        sha256: String,
        expires_at: u64,
    },
    Rejected,
    Unknown,
}

impl OpenClawGateway {
    pub async fn installed_skill_catalog(&self) -> Option<InstalledSkillCatalog> {
        let agent_id = self.default_agent_id().await.ok()?;
        OpenClawInstalledSkillCatalog::for_agent(self.client(), agent_id)
            .ok()?
            .read()
            .await
    }

    pub async fn skill_status_catalog(
        &self,
    ) -> Result<SkillStatusCatalog, SkillStatusCatalogError> {
        OpenClawSkillStatusCatalog::new(self.client()).read().await
    }

    async fn default_agent_id(&self) -> Result<String, AgentsReadFailure> {
        let agents = OpenClawAgents::new(self.client()).list().await?;
        agents
            .agents
            .iter()
            .any(|agent| agent.id == agents.default_id)
            .then_some(agents.default_id)
            .ok_or(AgentsReadFailure::Protocol)
    }

    pub async fn detail_skill(
        &self,
        request: SkillDetailRequest,
    ) -> Result<SkillDetail, SkillReadError> {
        let Ok(operations) = self.default_skill_operations().await else {
            return Err(SkillReadError::Unavailable);
        };
        operations.detail(request).await
    }

    pub async fn install_skill(&self, request: SkillInstallRequest) -> SkillMutationOutcome {
        let Ok(operations) = self.default_skill_operations().await else {
            return SkillMutationOutcome::Unknown;
        };
        operations.install(request).await
    }

    pub async fn update_skill(&self, request: SkillUpdateRequest) -> SkillMutationOutcome {
        let operations = if matches!(request, SkillUpdateRequest::Config { .. }) {
            OpenClawSkillOperations::new(self.client())
        } else {
            let Ok(operations) = self.default_skill_operations().await else {
                return SkillMutationOutcome::Unknown;
            };
            operations
        };
        operations.update(request).await
    }

    pub async fn configure_skill(
        &self,
        request: SkillUpdateRequest,
    ) -> (SkillMutationOutcome, Vec<String>) {
        OpenClawSkillOperations::new(self.client())
            .configure(request)
            .await
    }

    pub async fn remove_skill_config(&self, skill_key: String) -> SkillConfigRemoveOutcome {
        OpenClawSkillOperations::new(self.client())
            .remove_config(skill_key)
            .await
    }

    pub async fn begin_skill_upload(&self, request: SkillUploadBegin) -> SkillUploadOutcome {
        let Ok(operations) = self.default_skill_operations().await else {
            return SkillUploadOutcome::Unknown;
        };
        operations.upload_begin(request).await
    }

    pub async fn chunk_skill_upload(&self, request: SkillUploadChunk) -> SkillUploadOutcome {
        let Ok(operations) = self.default_skill_operations().await else {
            return SkillUploadOutcome::Unknown;
        };
        operations.upload_chunk(request).await
    }

    pub async fn commit_skill_upload(&self, request: SkillUploadCommit) -> SkillUploadOutcome {
        let Ok(operations) = self.default_skill_operations().await else {
            return SkillUploadOutcome::Unknown;
        };
        operations.upload_commit(request).await
    }

    async fn default_skill_operations(&self) -> Result<OpenClawSkillOperations, AgentsReadFailure> {
        let agent_id = self.default_agent_id().await?;
        OpenClawSkillOperations::for_agent(self.client(), agent_id)
            .map_err(|_| AgentsReadFailure::Protocol)
    }
}
