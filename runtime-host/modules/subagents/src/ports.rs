use std::{future::Future, pin::Pin};

use crate::domain::model::{
    CloudPackageMetadata, Command, NativeEndpoint, Outcome, PackageExportReceipt,
    PackageInstallPlan, PackageInstallReceipt,
};

pub type SubagentFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait SubagentRequestAdmission: Send + Sync {
    fn admit_subagent_request(&self) -> Result<(), SubagentRequestAdmissionClosed>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SubagentRequestAdmissionClosed;

pub trait SubagentRuntimeDirectory: Send + Sync {
    fn subagent_ops(&self, endpoint: NativeEndpoint) -> Option<&dyn SubagentOps>;
}

pub trait SubagentOps: Send + Sync {
    fn subagents<'a>(&'a self, command: Command) -> SubagentFuture<'a, Outcome>;
    fn subagent_runtime_ready(&self) -> bool;
}

pub trait SealedAgentStorePort: Send + Sync {
    fn export_package(
        &self,
        agent_id: String,
        agent_name: String,
    ) -> Result<PackageExportReceipt, SealedAgentError>;
    fn export_cloud_package(
        &self,
        agent_id: String,
        agent_name: String,
        cloud_public_key: String,
        cloud_key_id: String,
    ) -> Result<PackageExportReceipt, SealedAgentError>;
    fn prepare_install(
        &self,
        package_path: String,
        cloud_metadata: Option<CloudPackageMetadata>,
    ) -> Result<PackageInstallPlan, SealedAgentError>;
    fn install_prepared_package(
        &self,
        package_path: String,
        cloud_metadata: Option<CloudPackageMetadata>,
    ) -> Result<PackageInstallReceipt, SealedAgentError>;
    fn remove_package(&self, agent_id: String) -> Result<bool, SealedAgentError>;
    fn agents_using_sealed_source(&self, agent_ids: &[String]) -> Result<Vec<String>, SealedAgentError>;
    fn read_file(
        &self,
        token: &str,
        agent_id: String,
        path: String,
    ) -> Result<SealedAgentRead, SealedAgentError>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SealedAgentRead {
    content: Vec<u8>,
    metering_binding: Option<String>,
}

impl SealedAgentRead {
    pub fn new(content: Vec<u8>, metering_binding: Option<String>) -> Self {
        Self {
            content,
            metering_binding,
        }
    }

    pub fn content(&self) -> &[u8] {
        &self.content
    }

    pub fn metering_binding(&self) -> Option<&str> {
        self.metering_binding.as_deref()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SealedAgentError {
    AlreadyExists,
    NotFound,
    Rejected,
    Unknown,
}
