use platform::capability::CapabilityDecisionVerifier;

use super::DecodeError;
use super::dto::Operation;

pub(super) const AUTHORIZATION_ENDPOINT: &str = "/api/fleet";
pub(super) const AUTHORIZATION_SCOPE: &str = "fleet:read";
pub(super) const MUTATION_AUTHORIZATION_SCOPE: &str = "fleet:write";
pub(super) const AUTHORIZATION_SUBJECT: &str = "fleet";

pub(super) fn verify(
    operation: Operation,
    operation_name: &str,
    authorization: &str,
    verifier: &mut CapabilityDecisionVerifier,
    now: u64,
) -> Result<(), DecodeError> {
    verifier
        .verify(
            authorization,
            now,
            AUTHORIZATION_ENDPOINT,
            scope_for_operation(operation),
            operation_name,
            AUTHORIZATION_SUBJECT,
        )
        .map(|_| ())
        .map_err(|_| DecodeError::Unauthorized)
}

pub(super) fn scope_for_operation(operation: Operation) -> &'static str {
    if is_mutation_operation(operation) {
        MUTATION_AUTHORIZATION_SCOPE
    } else {
        AUTHORIZATION_SCOPE
    }
}

pub(super) fn is_mutation_operation(operation: Operation) -> bool {
    matches!(
        operation,
        Operation::TargetPut
            | Operation::TargetRemove
            | Operation::CommandSubmit
            | Operation::NodeCommandSubmit
            | Operation::CommandBegin
            | Operation::CommandAccept
            | Operation::CommandReject
            | Operation::CommandUnknown
            | Operation::CommandReplay
            | Operation::ConnectionUpsert
            | Operation::ConnectionRemove
            | Operation::EnvironmentRegister
            | Operation::ResourceRegister
            | Operation::NodeUpsert
            | Operation::AgentUpsert
            | Operation::AgentRevoke
            | Operation::RuntimeUpsert
            | Operation::EndpointUpsert
            | Operation::ConnectionProbeBegin
            | Operation::ConnectionProbeComplete
            | Operation::EnvironmentDeployBegin
            | Operation::EnvironmentDeployComplete
            | Operation::EnvironmentDeployFail
            | Operation::EnvironmentDeleteBegin
            | Operation::EnvironmentDeleteComplete
            | Operation::EnvironmentDeleteFail
            | Operation::ResourceProvisionBegin
            | Operation::ResourceProvisionComplete
            | Operation::ResourceDeleteBegin
            | Operation::ResourceDeleteComplete
            | Operation::ResourceDeleteFail
            | Operation::NodeRetire
            | Operation::RuntimeStartBegin
            | Operation::RuntimeStartComplete
            | Operation::RuntimeStopBegin
            | Operation::RuntimeStopComplete
            | Operation::RuntimeRetire
            | Operation::EndpointDrain
            | Operation::EndpointRetire
            | Operation::EndpointProbeBegin
            | Operation::CapabilitySyncBegin
            | Operation::CapabilitySyncComplete
            | Operation::TerminalOpen
            | Operation::TerminalReconnect
            | Operation::TerminalBeginClose
            | Operation::TerminalFinishClose
            | Operation::TerminalClose
    )
}
