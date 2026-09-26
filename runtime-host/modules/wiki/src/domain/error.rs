use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum WikiFailure {
    OwnerUnavailable,
    Cancelled,
    StateUnavailable { message: String },
    CurrentProjectUnset,
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
