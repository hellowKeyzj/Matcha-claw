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

#[derive(Clone, PartialEq)]
pub struct MemberIntroductionRequest {
    pub role_id: RoleId,
    pub system_prompt: &'static str,
    pub prompt: String,
    pub max_output_tokens: Option<u32>,
    pub temperature: Option<f32>,
}

impl fmt::Debug for MemberIntroductionRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MemberIntroductionRequest")
            .field("role_id", &self.role_id)
            .field("system_prompt", &self.system_prompt)
            .field("prompt", &"<redacted>")
            .field("max_output_tokens", &self.max_output_tokens)
            .field("temperature", &self.temperature)
            .finish()
    }
}

pub struct MemberIntroductionOutput {
    pub text: String,
    pub complete: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemberIntroductionError {
    CredentialMissing,
    CredentialUnavailable,
    Unavailable,
    Unsupported,
    InvalidOutput,
    Cancelled,
}

impl fmt::Display for MemberIntroductionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::CredentialMissing => "team member introduction credential missing",
            Self::CredentialUnavailable => "team member introduction credential unavailable",
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
    ) -> OwnedRuntimeFuture<Result<MemberIntroductionOutput, MemberIntroductionError>>;
}
