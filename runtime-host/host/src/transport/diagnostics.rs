use base64::Engine as _;
use serde_json::Value;

use crate::{
    diagnostics::{
        DiagnosticsArchiveCancellation, DiagnosticsArchiveError, DiagnosticsArchiveReceipt,
    },
    transport::authorization::CapabilityDecisionVerifier,
};

pub(crate) mod server;

const AUTHORIZATION_ENDPOINT: &str = "/api/diagnostics/archive";
pub(crate) const DOWNLOAD_ENDPOINT: &str = "/api/diagnostics/archive/download";
const AUTHORIZATION_SCOPE: &str = "diagnostics:write";
const DOWNLOAD_SCOPE: &str = "diagnostics:read";
const AUTHORIZATION_CAPABILITY: &str = "diagnostics.archive";
const DOWNLOAD_CAPABILITY: &str = "diagnostics.archive.download";
const AUTHORIZATION_SUBJECT: &str = "host-diagnostics";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RequestError {
    Invalid,
}

pub(crate) fn authorize(
    value: Value,
    authorization: &str,
    verifier: &mut CapabilityDecisionVerifier,
    now: u64,
) -> Result<(), RequestError> {
    authorize_for(
        value,
        authorization,
        verifier,
        now,
        AUTHORIZATION_ENDPOINT,
        AUTHORIZATION_SCOPE,
        AUTHORIZATION_CAPABILITY,
    )
}

pub(crate) fn authorize_download(
    value: Value,
    authorization: &str,
    verifier: &mut CapabilityDecisionVerifier,
    now: u64,
) -> Result<String, RequestError> {
    let object = value.as_object().ok_or(RequestError::Invalid)?;
    if object.len() != 1 {
        return Err(RequestError::Invalid);
    }
    let archive_id = object
        .get("archiveId")
        .and_then(Value::as_str)
        .filter(|value| opaque_archive_id(value))
        .ok_or(RequestError::Invalid)?
        .to_owned();
    authorize_for(
        value,
        authorization,
        verifier,
        now,
        DOWNLOAD_ENDPOINT,
        DOWNLOAD_SCOPE,
        DOWNLOAD_CAPABILITY,
    )?;
    Ok(archive_id)
}

fn authorize_for(
    value: Value,
    authorization: &str,
    verifier: &mut CapabilityDecisionVerifier,
    now: u64,
    endpoint: &str,
    scope: &str,
    capability: &str,
) -> Result<(), RequestError> {
    verifier
        .verify(
            authorization,
            now,
            endpoint,
            scope,
            capability,
            AUTHORIZATION_SUBJECT,
        )
        .map_err(|_| RequestError::Invalid)?;
    if endpoint == AUTHORIZATION_ENDPOINT {
        (value == serde_json::json!({}))
            .then_some(())
            .ok_or(RequestError::Invalid)
    } else {
        Ok(())
    }
}

fn opaque_archive_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum DiagnosticsArchiveDelivery {
    Ok(DiagnosticsArchiveReceipt),
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum DiagnosticsArchiveDownload {
    Ok { archive_id: String, data: String },
    NotFound,
    Unavailable,
}

impl DiagnosticsArchiveDownload {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Ok { .. } => 200,
            Self::NotFound => 404,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Ok { archive_id, data } => serde_json::json!({
                "archiveId": archive_id,
                "data": data,
            }),
            Self::NotFound => serde_json::json!({
                "success": false,
                "error": "Diagnostics archive was not found",
            }),
            Self::Unavailable => serde_json::json!({
                "success": false,
                "error": "Diagnostics archive is unavailable",
            }),
        }
    }
}

impl DiagnosticsArchiveDelivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Ok(_) => 200,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Ok(receipt) => serde_json::to_value(receipt)
                .expect("Diagnostics archive public receipt is serializable"),
            Self::Unavailable => serde_json::json!({
                "success": false,
                "error": "Diagnostics archive is unavailable",
            }),
        }
    }
}

pub(crate) async fn collect(
    owner: &crate::owner::Handle,
    cancellation: DiagnosticsArchiveCancellation,
) -> DiagnosticsArchiveDelivery {
    match owner.collect_diagnostics(cancellation).await {
        Ok(Ok(receipt)) => receipt_delivery(receipt),
        Ok(Err(_)) | Err(_) => DiagnosticsArchiveDelivery::Unavailable,
    }
}

pub(crate) async fn download(
    owner: &crate::owner::Handle,
    archive_id: String,
) -> DiagnosticsArchiveDownload {
    match owner.download_diagnostics(archive_id.clone()).await {
        Ok(Ok(Ok(bytes))) => DiagnosticsArchiveDownload::Ok {
            archive_id,
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
        },
        Ok(Ok(Err(DiagnosticsArchiveError::ArchiveNotFound))) => {
            DiagnosticsArchiveDownload::NotFound
        }
        Ok(Ok(Err(_))) | Ok(Err(_)) | Err(_) => DiagnosticsArchiveDownload::Unavailable,
    }
}

fn receipt_delivery(receipt: DiagnosticsArchiveReceipt) -> DiagnosticsArchiveDelivery {
    (receipt.terminal() == crate::diagnostics::DiagnosticsArchiveTerminal::Completed
        && receipt.has_opaque_archive_id()
        && receipt.entries() > 0
        && receipt.bytes() > 0)
        .then_some(receipt)
        .map(DiagnosticsArchiveDelivery::Ok)
        .unwrap_or(DiagnosticsArchiveDelivery::Unavailable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_is_fixed_and_redacted() {
        let delivery = DiagnosticsArchiveDelivery::Unavailable;
        assert_eq!(delivery.status_code(), 503);
        assert_eq!(
            delivery.body(),
            serde_json::json!({
                "success": false,
                "error": "Diagnostics archive is unavailable",
            })
        );
    }

    #[test]
    fn failed_receipts_are_unavailable() {
        assert_eq!(
            receipt_delivery(DiagnosticsArchiveReceipt::failed()),
            DiagnosticsArchiveDelivery::Unavailable
        );
    }
}
