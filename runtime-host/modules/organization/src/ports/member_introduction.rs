use std::fmt;

use foundation::pipeline::PipelineError;
use runtime_directory::OwnedRuntimeFuture;
use tokio_util::sync::CancellationToken;

use crate::RoleId;

/// Read-only native member source material, never a second profile store.
#[derive(Clone, Default, Eq, PartialEq)]
pub struct MemberProfile {
    pub description: Option<String>,
    pub agents_markdown: Option<String>,
    pub soul_markdown: Option<String>,
}

impl fmt::Debug for MemberProfile {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MemberProfile")
            .field(
                "description",
                &self.description.as_ref().map(|_| "<redacted>"),
            )
            .field(
                "agents_markdown",
                &self.agents_markdown.as_ref().map(|_| "<redacted>"),
            )
            .field(
                "soul_markdown",
                &self.soul_markdown.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemberIntroductionRequest {
    pub name: String,
    pub role_id: RoleId,
    pub profile: MemberProfile,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MemberIntroductionError {
    Unavailable,
    Unsupported,
    InvalidOutput,
    Cancelled,
}

impl fmt::Display for MemberIntroductionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Unavailable => "team member introduction unavailable",
            Self::Unsupported => "team member introduction unsupported",
            Self::InvalidOutput => "team member introduction output invalid",
            Self::Cancelled => "team member introduction cancelled",
        })
    }
}

impl std::error::Error for MemberIntroductionError {}

impl From<PipelineError> for MemberIntroductionError {
    fn from(error: PipelineError) -> Self {
        match error {
            PipelineError::Cancelled => Self::Cancelled,
            _ => Self::Unavailable,
        }
    }
}

pub trait TeamMemberIntroductions: Send + Sync {
    /// Generates Chinese introduction prose only; the caller renders names, role IDs and Markdown.
    fn generate(
        &self,
        request: MemberIntroductionRequest,
        cancellation: CancellationToken,
    ) -> OwnedRuntimeFuture<Result<String, MemberIntroductionError>>;
}
