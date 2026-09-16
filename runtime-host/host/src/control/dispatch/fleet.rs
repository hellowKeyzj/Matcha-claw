use serde::Deserialize;
use serde_json::json;

use crate::fleet::handle::FleetHandle;

use super::{
    CommandInput, CommandOutcome, CommandResult, RejectionCode, decode, internal_error,
    invalid_input,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FleetCredentialWriteCommand {
    operation_id: String,
    credential_id: String,
    credential_name: String,
    plaintext_value: String,
}

pub(super) async fn fleet_credentials_write(
    fleet: &FleetHandle,
    input: CommandInput,
) -> CommandOutcome {
    let request: FleetCredentialWriteCommand = match decode::<FleetCredentialWriteCommand>(input) {
        Ok(request)
            if !request.operation_id.trim().is_empty()
                && !request.credential_id.trim().is_empty() =>
        {
            request
        }
        _ => return invalid_input(),
    };
    let name = match request.credential_name.as_str() {
        "sshPassword" => crate::fleet::credentials::FleetCredentialName::SshPassword,
        "sshPrivateKey" => crate::fleet::credentials::FleetCredentialName::SshPrivateKey,
        "dockerBearerToken" => crate::fleet::credentials::FleetCredentialName::DockerBearerToken,
        "kubeBearerToken" => crate::fleet::credentials::FleetCredentialName::KubeBearerToken,
        _ => return invalid_input(),
    };
    let plaintext =
        match crate::fleet::credentials::FleetCredentialPlaintext::new(request.plaintext_value) {
            Ok(value) => value,
            Err(_) => return invalid_input(),
        };
    let write = crate::fleet::credentials::FleetCredentialWriteRequest {
        operation_id: request.operation_id,
        credential_id: request.credential_id,
        credential_name: name,
        plaintext,
        written_at: chrono::Utc::now().to_rfc3339(),
    };
    match fleet.write_credential(write).await {
        Ok(Ok(crate::fleet::credentials::FleetCredentialWriteOutcome::Written(receipt))) => {
            CommandOutcome::succeeded(CommandResult::private(
                json!({"credentialRef": receipt.credential_ref.as_str(), "operationId": receipt.operation_id, "credentialName": receipt.credential_name.as_str(), "writtenAt": receipt.written_at}),
            ))
        }
        Ok(Ok(crate::fleet::credentials::FleetCredentialWriteOutcome::OperationConflict)) => {
            CommandOutcome::rejected(
                RejectionCode::Failed,
                "Fleet credential operation conflicts with an existing receipt.",
            )
        }
        Ok(Err(_)) | Err(_) => internal_error(),
    }
}
