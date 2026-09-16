#[allow(dead_code)]
mod agent_package;
#[allow(dead_code)]
mod agent_store;
mod descriptor;
#[allow(dead_code)]
mod identity;
#[allow(dead_code)]
mod package;
mod path;
#[allow(dead_code)]
mod store;

use std::fmt;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Serialize;

pub(crate) use agent_store::{SealedAgentCatalogEntry, SealedAgentPackageExport, SealedAgentStore};
pub(crate) use descriptor::SealedSkillDescriptor;
pub(crate) use identity::{AgentKey, SkillKey};
pub(crate) use path::PackageRelativePath;
pub(crate) use store::{SealedSkillCatalog, SealedSkillCatalogEntry, SealedSkillStore};

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct SealedResourceRead {
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

impl fmt::Debug for SealedResourceRead {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SealedResourceRead")
            .field(
                "content",
                &format_args!("[REDACTED:{} bytes]", self.content.len()),
            )
            .field("metering_binding", &self.metering_binding)
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SealedResourceMeteringBinding(String);

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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SealedSkillTarget {
    OpenClaw,
}

impl SealedSkillTarget {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::OpenClaw => "openclaw",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SealedAgentTarget {
    OpenClaw,
}

impl SealedAgentTarget {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::OpenClaw => "openclaw",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SealedResourceError {
    AlreadyExists,
    NotFound,
    Rejected,
    Unknown,
}
