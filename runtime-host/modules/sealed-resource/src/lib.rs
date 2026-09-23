mod api;
mod descriptor;
pub mod domain;
mod package;
mod ports;
mod store;

pub use api::{
    SealedAgentCatalog, SealedAgentCatalogEntry, SealedAgentPackageExport, SealedAgentStore,
    SealedAgentTarget, SealedResourceError, SealedResourceMeteringBinding, SealedResourceRead,
    SealedSkillCatalog, SealedSkillCatalogEntry, SealedSkillDescriptor, SealedSkillStore,
    SealedSkillTarget,
};
pub use domain::{AgentKey, PackageRelativePath, SkillKey};
pub use ports::{SealedResourceModule, SealedResourceProvisionError};
pub use store::SealedAgentRuntimeProjection;
