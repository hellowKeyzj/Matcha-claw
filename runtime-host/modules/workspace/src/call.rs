use platform::call::{CallContext, CallDetail, CallLogError, CallStatus};
use serde::Serialize;

use crate::domain::model::{
    WorkspaceBinaryFailure, WorkspaceListFailure, WorkspaceMediaFailure, WorkspaceReadFailure,
    WorkspaceStatFailure, WorkspaceWriteFailure,
};

#[derive(Clone, Copy, Serialize)]
pub(crate) enum Operation {
    #[serde(rename = "files.readText")]
    ReadText,
    #[serde(rename = "files.readBinary")]
    ReadBinary,
    #[serde(rename = "files.stat")]
    StatFile,
    #[serde(rename = "files.listDir")]
    ListDirectory,
    #[serde(rename = "files.writeText")]
    WriteText,
    #[serde(rename = "media.prepare")]
    PrepareMedia,
    #[serde(rename = "media.resolve")]
    ResolveMedia,
    #[serde(rename = "media.thumbnail")]
    ThumbnailMedia,
    #[serde(rename = "media.thumbnails")]
    ThumbnailsMedia,
    #[serde(rename = "media.stagePaths")]
    StagePathsMedia,
    #[serde(rename = "media.stageBuffer")]
    StageBufferMedia,
}

impl Operation {
    pub(crate) const fn command(self) -> &'static str {
        match self {
            Self::ReadText => "files.readText",
            Self::ReadBinary => "files.readBinary",
            Self::StatFile => "files.stat",
            Self::ListDirectory => "files.listDir",
            Self::WriteText => "files.writeText",
            Self::PrepareMedia => "media.prepare",
            Self::ResolveMedia => "media.resolve",
            Self::ThumbnailMedia => "media.thumbnail",
            Self::ThumbnailsMedia => "media.thumbnails",
            Self::StagePathsMedia => "media.stagePaths",
            Self::StageBufferMedia => "media.stageBuffer",
        }
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Outcome {
    Completed,
    InvalidPath,
    InvalidReference,
    Unavailable,
    NotFile,
    NotDirectory,
    TooLarge,
    Binary,
    OutcomeUnknown,
}

impl Outcome {
    const fn status(self) -> CallStatus {
        match self {
            Self::Completed => CallStatus::Succeeded,
            Self::Unavailable => CallStatus::Failed,
            Self::OutcomeUnknown => CallStatus::Unknown,
            _ => CallStatus::Rejected,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Detail {
    pub operation: Operation,
    pub item_count: usize,
    pub outcome: Option<Outcome>,
}

impl CallDetail for Detail {
    const MODULE: &'static str = "workspace";
}

pub(crate) struct RecordedCall {
    pub context: CallContext<Detail>,
    pub detail: Detail,
}

impl RecordedCall {
    pub(crate) async fn finish(&mut self, status: CallStatus, outcome: Outcome) {
        self.detail.outcome = Some(outcome);
        if let Err(error) = self.context.finish(status, &self.detail).await {
            diagnose("finish", error);
        }
    }

    pub(crate) async fn execute<T, E: Copy + Into<Outcome>>(
        mut self,
        unavailable: E,
        effect: impl FnOnce() -> Result<T, E>,
    ) -> Result<T, E> {
        // The original owner queue owns admission and execution, not the HTTP waiter.
        if let Err(error) = self.context.accepted().await {
            diagnose("accepted", error);
            self.finish(CallStatus::Failed, Outcome::Unavailable).await;
            return Err(unavailable);
        }
        if let Err(error) = self.context.running().await {
            diagnose("running", error);
            self.finish(CallStatus::Failed, Outcome::Unavailable).await;
            return Err(unavailable);
        }
        let result = effect();
        let outcome = match &result {
            Ok(_) => Outcome::Completed,
            Err(error) => (*error).into(),
        };
        self.finish(outcome.status(), outcome).await;
        result
    }
}

pub(crate) fn diagnose(stage: &'static str, error: CallLogError) {
    eprintln!("[workspace-call] stage={stage} error={error}");
}

impl From<WorkspaceReadFailure> for Outcome {
    fn from(error: WorkspaceReadFailure) -> Self {
        match error {
            WorkspaceReadFailure::InvalidPath => Self::InvalidPath,
            WorkspaceReadFailure::Unavailable => Self::Unavailable,
            WorkspaceReadFailure::NotFile => Self::NotFile,
            WorkspaceReadFailure::TooLarge => Self::TooLarge,
            WorkspaceReadFailure::Binary => Self::Binary,
        }
    }
}

impl From<WorkspaceBinaryFailure> for Outcome {
    fn from(error: WorkspaceBinaryFailure) -> Self {
        match error {
            WorkspaceBinaryFailure::InvalidPath => Self::InvalidPath,
            WorkspaceBinaryFailure::Unavailable => Self::Unavailable,
            WorkspaceBinaryFailure::NotFile => Self::NotFile,
            WorkspaceBinaryFailure::TooLarge => Self::TooLarge,
        }
    }
}

impl From<WorkspaceStatFailure> for Outcome {
    fn from(error: WorkspaceStatFailure) -> Self {
        match error {
            WorkspaceStatFailure::InvalidPath => Self::InvalidPath,
            WorkspaceStatFailure::Unavailable => Self::Unavailable,
        }
    }
}

impl From<WorkspaceListFailure> for Outcome {
    fn from(error: WorkspaceListFailure) -> Self {
        match error {
            WorkspaceListFailure::InvalidPath => Self::InvalidPath,
            WorkspaceListFailure::Unavailable => Self::Unavailable,
            WorkspaceListFailure::NotDirectory => Self::NotDirectory,
        }
    }
}

impl From<WorkspaceWriteFailure> for Outcome {
    fn from(error: WorkspaceWriteFailure) -> Self {
        match error {
            WorkspaceWriteFailure::InvalidPath => Self::InvalidPath,
            WorkspaceWriteFailure::Unavailable => Self::Unavailable,
            WorkspaceWriteFailure::NotFile => Self::NotFile,
            WorkspaceWriteFailure::TooLarge => Self::TooLarge,
            WorkspaceWriteFailure::OutcomeUnknown => Self::OutcomeUnknown,
        }
    }
}

impl From<WorkspaceMediaFailure> for Outcome {
    fn from(error: WorkspaceMediaFailure) -> Self {
        match error {
            WorkspaceMediaFailure::InvalidPath => Self::InvalidPath,
            WorkspaceMediaFailure::InvalidReference => Self::InvalidReference,
            WorkspaceMediaFailure::Unavailable => Self::Unavailable,
            WorkspaceMediaFailure::NotFile => Self::NotFile,
            WorkspaceMediaFailure::TooLarge => Self::TooLarge,
        }
    }
}
