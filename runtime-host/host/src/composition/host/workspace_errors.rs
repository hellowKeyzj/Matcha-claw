use std::fmt;

use super::super::admission::RequestAdmissionClosed;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceReadError {
    AdmissionClosed(RequestAdmissionClosed),
    InvalidPath,
    Unavailable,
    NotFile,
    TooLarge,
    Binary,
}

impl From<crate::runtime::driver::WorkspaceReadFailure> for WorkspaceReadError {
    fn from(value: crate::runtime::driver::WorkspaceReadFailure) -> Self {
        match value {
            crate::runtime::driver::WorkspaceReadFailure::InvalidPath => Self::InvalidPath,
            crate::runtime::driver::WorkspaceReadFailure::Unavailable => Self::Unavailable,
            crate::runtime::driver::WorkspaceReadFailure::NotFile => Self::NotFile,
            crate::runtime::driver::WorkspaceReadFailure::TooLarge => Self::TooLarge,
            crate::runtime::driver::WorkspaceReadFailure::Binary => Self::Binary,
        }
    }
}

impl fmt::Display for WorkspaceReadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AdmissionClosed(error) => error.fmt(formatter),
            Self::InvalidPath => formatter.write_str("workspace read path is invalid"),
            Self::Unavailable => formatter.write_str("workspace read is unavailable"),
            Self::NotFile => formatter.write_str("workspace read target is not a file"),
            Self::TooLarge => formatter.write_str("workspace read target exceeds the limit"),
            Self::Binary => formatter.write_str("workspace read target is binary"),
        }
    }
}

impl std::error::Error for WorkspaceReadError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceMediaError {
    AdmissionClosed(RequestAdmissionClosed),
    InvalidPath,
    InvalidReference,
    Unavailable,
    NotFile,
    TooLarge,
}

impl From<crate::runtime::driver::WorkspaceMediaFailure> for WorkspaceMediaError {
    fn from(value: crate::runtime::driver::WorkspaceMediaFailure) -> Self {
        match value {
            crate::runtime::driver::WorkspaceMediaFailure::InvalidPath => Self::InvalidPath,
            crate::runtime::driver::WorkspaceMediaFailure::InvalidReference => {
                Self::InvalidReference
            }
            crate::runtime::driver::WorkspaceMediaFailure::Unavailable => Self::Unavailable,
            crate::runtime::driver::WorkspaceMediaFailure::NotFile => Self::NotFile,
            crate::runtime::driver::WorkspaceMediaFailure::TooLarge => Self::TooLarge,
        }
    }
}

impl fmt::Display for WorkspaceMediaError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AdmissionClosed(error) => error.fmt(formatter),
            Self::InvalidPath => formatter.write_str("workspace media path is invalid"),
            Self::InvalidReference => formatter.write_str("workspace media reference is invalid"),
            Self::Unavailable => formatter.write_str("workspace media is unavailable"),
            Self::NotFile => formatter.write_str("workspace media target is not a file"),
            Self::TooLarge => formatter.write_str("workspace media target exceeds the limit"),
        }
    }
}

impl std::error::Error for WorkspaceMediaError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceBinaryError {
    AdmissionClosed(RequestAdmissionClosed),
    InvalidPath,
    Unavailable,
    NotFile,
    TooLarge,
}

impl From<crate::runtime::driver::WorkspaceBinaryFailure> for WorkspaceBinaryError {
    fn from(value: crate::runtime::driver::WorkspaceBinaryFailure) -> Self {
        match value {
            crate::runtime::driver::WorkspaceBinaryFailure::InvalidPath => Self::InvalidPath,
            crate::runtime::driver::WorkspaceBinaryFailure::Unavailable => Self::Unavailable,
            crate::runtime::driver::WorkspaceBinaryFailure::NotFile => Self::NotFile,
            crate::runtime::driver::WorkspaceBinaryFailure::TooLarge => Self::TooLarge,
        }
    }
}

impl fmt::Display for WorkspaceBinaryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AdmissionClosed(error) => error.fmt(formatter),
            Self::InvalidPath => formatter.write_str("workspace binary path is invalid"),
            Self::Unavailable => formatter.write_str("workspace binary is unavailable"),
            Self::NotFile => formatter.write_str("workspace binary target is not a file"),
            Self::TooLarge => formatter.write_str("workspace binary target exceeds the limit"),
        }
    }
}

impl std::error::Error for WorkspaceBinaryError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceStatError {
    AdmissionClosed(RequestAdmissionClosed),
    InvalidPath,
    Unavailable,
}

impl From<crate::runtime::driver::WorkspaceStatFailure> for WorkspaceStatError {
    fn from(value: crate::runtime::driver::WorkspaceStatFailure) -> Self {
        match value {
            crate::runtime::driver::WorkspaceStatFailure::InvalidPath => Self::InvalidPath,
            crate::runtime::driver::WorkspaceStatFailure::Unavailable => Self::Unavailable,
        }
    }
}

impl fmt::Display for WorkspaceStatError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AdmissionClosed(error) => error.fmt(formatter),
            Self::InvalidPath => formatter.write_str("workspace stat path is invalid"),
            Self::Unavailable => formatter.write_str("workspace stat is unavailable"),
        }
    }
}

impl std::error::Error for WorkspaceStatError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceListError {
    AdmissionClosed(RequestAdmissionClosed),
    InvalidPath,
    Unavailable,
    NotDirectory,
}

impl From<crate::runtime::driver::WorkspaceListFailure> for WorkspaceListError {
    fn from(value: crate::runtime::driver::WorkspaceListFailure) -> Self {
        match value {
            crate::runtime::driver::WorkspaceListFailure::InvalidPath => Self::InvalidPath,
            crate::runtime::driver::WorkspaceListFailure::Unavailable => Self::Unavailable,
            crate::runtime::driver::WorkspaceListFailure::NotDirectory => Self::NotDirectory,
        }
    }
}

impl fmt::Display for WorkspaceListError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AdmissionClosed(error) => error.fmt(formatter),
            Self::InvalidPath => formatter.write_str("workspace directory path is invalid"),
            Self::Unavailable => formatter.write_str("workspace directory is unavailable"),
            Self::NotDirectory => {
                formatter.write_str("workspace directory target is not a directory")
            }
        }
    }
}

impl std::error::Error for WorkspaceListError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceWriteError {
    AdmissionClosed(RequestAdmissionClosed),
    InvalidPath,
    Unavailable,
    NotFile,
    TooLarge,
    OutcomeUnknown,
}

impl From<crate::runtime::driver::WorkspaceWriteFailure> for WorkspaceWriteError {
    fn from(value: crate::runtime::driver::WorkspaceWriteFailure) -> Self {
        match value {
            crate::runtime::driver::WorkspaceWriteFailure::InvalidPath => Self::InvalidPath,
            crate::runtime::driver::WorkspaceWriteFailure::Unavailable => Self::Unavailable,
            crate::runtime::driver::WorkspaceWriteFailure::NotFile => Self::NotFile,
            crate::runtime::driver::WorkspaceWriteFailure::TooLarge => Self::TooLarge,
            crate::runtime::driver::WorkspaceWriteFailure::OutcomeUnknown => Self::OutcomeUnknown,
        }
    }
}

impl fmt::Display for WorkspaceWriteError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AdmissionClosed(error) => error.fmt(formatter),
            Self::InvalidPath => formatter.write_str("workspace write path is invalid"),
            Self::Unavailable => formatter.write_str("workspace write is unavailable"),
            Self::NotFile => formatter.write_str("workspace write target is not a file"),
            Self::TooLarge => formatter.write_str("workspace write content exceeds the limit"),
            Self::OutcomeUnknown => formatter.write_str("workspace write outcome is unknown"),
        }
    }
}

impl std::error::Error for WorkspaceWriteError {}
