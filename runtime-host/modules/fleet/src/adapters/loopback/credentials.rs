use serde::Deserialize;
use serde_json::{Value, json};

use crate::application::credentials::{
    FleetCredentialName, FleetCredentialPlaintext, FleetCredentialVaultError,
    FleetCredentialWriteOutcome, FleetCredentialWriteRequest,
};
use crate::owner::handle::FleetHandle;

use super::Response;

pub(super) const PATH: &str = "/api/fleet/credentials/write";
pub(super) const SCOPE: &str = "fleet:credentials:write";
pub(super) const CAPABILITY: &str = "fleet.credentials.write";
pub(super) const SUBJECT: &str = "fleet.credentials";

const COMMAND_FAILED_MESSAGE: &str = "Runtime Host command failed.";
const OPERATION_CONFLICT_MESSAGE: &str =
    "Fleet credential operation conflicts with an existing receipt.";
const MAX_OPERATION_ID_BYTES: usize = 128;
const MAX_CREDENTIAL_ID_BYTES: usize = 128;
const MAX_CREDENTIAL_VALUE_BYTES: usize = 256 * 1024;
const MAX_TIMESTAMP_BYTES: usize = 64;
pub(super) const MAX_REQUEST_BYTES: usize = MAX_CREDENTIAL_VALUE_BYTES + 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CredentialWriteRequest {
    operation_id: String,
    credential_id: String,
    credential_name: String,
    plaintext_value: String,
}

pub(super) async fn handle(owner: &FleetHandle, value: Value) -> Response {
    let command = match serde_json::from_value::<CredentialWriteRequest>(value) {
        Ok(command)
            if is_valid_segment(&command.operation_id, MAX_OPERATION_ID_BYTES)
                && is_valid_segment(&command.credential_id, MAX_CREDENTIAL_ID_BYTES)
                && is_valid_plaintext(&command.plaintext_value) =>
        {
            command
        }
        _ => return Response::bad_request(),
    };
    let Some(credential_name) = credential_name(&command.credential_name) else {
        return Response::bad_request();
    };

    let written_at = chrono::Utc::now().to_rfc3339();
    if !is_valid_written_at(&written_at) {
        return Response::fixed(503, COMMAND_FAILED_MESSAGE);
    }
    let plaintext = match FleetCredentialPlaintext::new(command.plaintext_value) {
        Ok(plaintext) => plaintext,
        Err(_) => return Response::bad_request(),
    };
    let request = FleetCredentialWriteRequest {
        operation_id: command.operation_id,
        credential_id: command.credential_id,
        credential_name,
        plaintext,
        written_at,
    };

    match owner.write_credential(request).await {
        Ok(Ok(FleetCredentialWriteOutcome::Written(receipt))) => Response {
            status: 200,
            body: json!({
                "credentialRef": receipt.credential_ref.as_str(),
                "operationId": receipt.operation_id,
                "credentialName": receipt.credential_name.as_str(),
                "writtenAt": receipt.written_at,
            }),
        },
        Ok(Ok(FleetCredentialWriteOutcome::OperationConflict)) => {
            Response::fixed(409, OPERATION_CONFLICT_MESSAGE)
        }
        Ok(Err(FleetCredentialVaultError::InvalidInput)) => Response::bad_request(),
        Ok(Err(
            FleetCredentialVaultError::Storage
            | FleetCredentialVaultError::CorruptState
            | FleetCredentialVaultError::Crypto,
        ))
        | Err(_) => Response::fixed(503, COMMAND_FAILED_MESSAGE),
    }
}

fn credential_name(value: &str) -> Option<FleetCredentialName> {
    match value {
        "sshPassword" => Some(FleetCredentialName::SshPassword),
        "sshPrivateKey" => Some(FleetCredentialName::SshPrivateKey),
        "dockerBearerToken" => Some(FleetCredentialName::DockerBearerToken),
        "kubeBearerToken" => Some(FleetCredentialName::KubeBearerToken),
        _ => None,
    }
}

fn is_valid_plaintext(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= MAX_CREDENTIAL_VALUE_BYTES
}

fn is_valid_written_at(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_TIMESTAMP_BYTES
        && value
            .parse::<chrono::DateTime<chrono::FixedOffset>>()
            .is_ok()
}

fn is_valid_segment(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}
