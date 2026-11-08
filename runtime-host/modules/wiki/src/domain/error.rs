use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum WikiFailure {
    OwnerUnavailable,
    Cancelled,
    StateUnavailable { message: String },
    CurrentProjectUnset,
    RequestKeyConflict,
    ProjectNotFound { project_id: String },
    InvalidInput { field: String, message: String },
    InvalidPath { path: String },
    PathOutsideProject { path: String },
    NotFound { path: String },
    IsDirectory { path: String },
    NotText { path: String },
    Io { path: String, message: String },
    IndexUnavailable { backend: String, reason: String },
}

impl std::fmt::Display for WikiFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::OwnerUnavailable => formatter.write_str("Wiki owner is unavailable"),
            Self::Cancelled => formatter.write_str("Wiki source import was cancelled"),
            Self::StateUnavailable { message } => formatter.write_str(message),
            Self::CurrentProjectUnset => formatter.write_str("Current wiki project is not set"),
            Self::RequestKeyConflict => formatter.write_str("Artifact request key already identifies different content"),
            Self::ProjectNotFound { project_id } => {
                write!(formatter, "Wiki project not found: {project_id}")
            }
            Self::InvalidInput { field, message } => write!(formatter, "Invalid {field}: {message}"),
            Self::InvalidPath { path } => write!(formatter, "Invalid wiki path: {path}"),
            Self::PathOutsideProject { path } => write!(formatter, "Wiki path is outside project: {path}"),
            Self::NotFound { path } => write!(formatter, "Wiki path not found: {path}"),
            Self::IsDirectory { path } => write!(formatter, "Wiki path is a directory: {path}"),
            Self::NotText { path } => write!(formatter, "Wiki file is not text: {path}"),
            Self::Io { path, message } => write!(formatter, "Wiki file error at {path}: {message}"),
            Self::IndexUnavailable { backend, reason } => {
                write!(formatter, "Wiki index backend {backend} is unavailable: {reason}")
            }
        }
    }
}

impl WikiFailure {
    pub fn state(message: impl Into<String>) -> Self {
        Self::StateUnavailable {
            message: message.into(),
        }
    }

    pub const fn cancelled() -> Self {
        Self::Cancelled
    }

    pub const fn is_cancelled(&self) -> bool {
        matches!(self, Self::Cancelled)
    }

    pub fn invalid_input(field: impl Into<String>, message: impl Into<String>) -> Self {
        Self::InvalidInput {
            field: field.into(),
            message: message.into(),
        }
    }

    pub fn invalid_path(path: impl Into<String>) -> Self {
        Self::InvalidPath { path: path.into() }
    }

    pub fn not_found(path: impl Into<String>) -> Self {
        Self::NotFound { path: path.into() }
    }

    pub fn io(path: impl Into<String>, error: std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            message: error.to_string(),
        }
    }
}
