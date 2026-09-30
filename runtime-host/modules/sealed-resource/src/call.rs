use platform::call::{CallDetail, CallStatus};
use serde::Serialize;

use crate::{SealedCloudPackageEntry, SealedCloudPackageType, SealedResourceError};

/// Installed package facts do not assert a valid lease, native enablement or run success.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedResourceCallDetail {
    pub package_sha256: Option<String>,
    pub authorization: Option<AuthorizationValidity>,
    pub package_count: Option<usize>,
    pub packages: Vec<PackageIdentity>,
    pub error: Option<CallError>,
}

impl CallDetail for SealedResourceCallDetail {
    const MODULE: &'static str = "sealed-resource";
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageIdentity {
    package_type: SealedCloudPackageType,
    package_version_id: Option<String>,
    package_sha256: String,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthorizationValidity {
    Valid,
    Invalid,
    Cleared,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CallError {
    AlreadyExists,
    NotFound,
    Rejected,
    OutcomeUnknown,
    AuditUnavailable,
}

impl SealedResourceCallDetail {
    pub(crate) fn catalog(&mut self, packages: &[SealedCloudPackageEntry]) {
        self.package_count = Some(packages.len());
        // Bound the audit summary, not the canonical catalog response.
        self.packages = packages
            .iter()
            .take(8)
            .filter_map(|package| {
                Some(PackageIdentity {
                    package_type: package.package_type,
                    package_version_id: safe_identity(&package.package_version_id),
                    package_sha256: safe_digest(&package.package_sha256)?,
                })
            })
            .collect();
    }

    pub(crate) fn result<T>(&mut self, result: &Result<T, SealedResourceError>) -> CallStatus {
        match result {
            Ok(_) => CallStatus::Succeeded,
            Err(error) => {
                self.error = Some(match error {
                    SealedResourceError::AlreadyExists => CallError::AlreadyExists,
                    SealedResourceError::NotFound => CallError::NotFound,
                    SealedResourceError::Rejected | SealedResourceError::RejectedWith(_) => {
                        CallError::Rejected
                    }
                    SealedResourceError::Unknown => CallError::OutcomeUnknown,
                });
                match error {
                    SealedResourceError::Unknown => CallStatus::Unknown,
                    SealedResourceError::Rejected | SealedResourceError::RejectedWith(_) => {
                        CallStatus::Rejected
                    }
                    _ => CallStatus::Failed,
                }
            }
        }
    }
}

pub(crate) fn safe_digest(value: &str) -> Option<String> {
    (value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| value.to_owned())
}

fn safe_identity(value: &str) -> Option<String> {
    (!value.is_empty()
        && value.len() <= 256
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_')
        }))
    .then(|| value.to_owned())
}
