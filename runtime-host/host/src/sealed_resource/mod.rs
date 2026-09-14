mod agent_package;
mod agent_store;
mod descriptor;
mod identity;
mod package;
mod path;
mod store;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};

pub use agent_package::{
    SealAgentPackageReceipt, SealedAgentFile, SealedAgentFileRequest, SealedAgentPackage,
};
pub use agent_store::{
    RuntimeLocalAgentRoot, SealedAgentCatalog, SealedAgentCatalogEntry, SealedAgentPackageExport,
    SealedAgentStore,
};
pub use descriptor::SealedSkillDescriptor;
pub use identity::{AgentKey, SkillKey};
pub use package::{
    SealSkillPackageReceipt, SealedSkillFile, SealedSkillFileRequest, SealedSkillPackage,
};
pub use path::PackageRelativePath;
pub use store::{
    RuntimeLocalSkillRoot, SealedSkillCatalog, SealedSkillCatalogEntry, SealedSkillStore,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SealedResourceRead {
    content: Vec<u8>,
    metering_binding: Option<SealedResourceMeteringBinding>,
}

impl SealedResourceRead {
    pub(crate) fn new(
        content: Vec<u8>,
        metering_binding: Option<SealedResourceMeteringBinding>,
    ) -> Self {
        Self {
            content,
            metering_binding,
        }
    }

    pub fn content(&self) -> &[u8] {
        &self.content
    }

    pub fn metering_binding(&self) -> Option<&SealedResourceMeteringBinding> {
        self.metering_binding.as_ref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SealedResourceMeteringBinding(String);

impl SealedResourceMeteringBinding {
    pub(crate) fn openclaw(
        kind: SealedResourceMeteringKind,
        key: &str,
        package_sha256: &str,
        usage: SealedResourceMeteringUse,
    ) -> Result<Self, SealedResourceError> {
        let payload = SealedResourceMeteringPayload {
            v: 1,
            kind,
            runtime: "openclaw",
            package_sha256,
            key,
            usage,
        };
        serde_json::to_vec(&payload)
            .map(|bytes| Self(format!("m1.{}", URL_SAFE_NO_PAD.encode(bytes))))
            .map_err(|_| SealedResourceError::Unknown)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SealedResourceMeteringKind {
    Agent,
    Skill,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SealedResourceMeteringUse {
    Session,
    Turn,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SealedResourceMeteringPayload<'a> {
    v: u8,
    kind: SealedResourceMeteringKind,
    runtime: &'a str,
    package_sha256: &'a str,
    key: &'a str,
    #[serde(rename = "use")]
    usage: SealedResourceMeteringUse,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum RuntimeSkillTarget {
    #[serde(rename = "openclaw")]
    OpenClaw,
}

impl RuntimeSkillTarget {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenClaw => "openclaw",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum RuntimeAgentTarget {
    #[serde(rename = "openclaw")]
    OpenClaw,
}

impl RuntimeAgentTarget {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenClaw => "openclaw",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SealedResourceError {
    AlreadyExists,
    NotFound,
    Rejected,
    Unknown,
}
