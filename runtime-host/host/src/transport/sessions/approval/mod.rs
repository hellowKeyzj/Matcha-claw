use serde::Deserialize;
use serde_json::Value;

use crate::{
    sessions::{
        approval::{
            PendingApprovalsCommand, PendingApprovalsOutcome, SessionApprovalCommand,
            SessionApprovalOutcome,
        },
        endpoint::NativeEndpoint,
    },
    transport::common::authorization::CapabilityDecisionVerifier,
};

pub(crate) mod handler;

const CAPABILITY_ID: &str = "session.approval";
const LIST_OPERATION_ID: &str = "sessions.approvals.list";
const RESPOND_OPERATION_ID: &str = "sessions.approvals.respond";
const LIST_AUTHORIZATION_ENDPOINT: &str = "/api/sessions/approvals/list";
const RESPOND_AUTHORIZATION_ENDPOINT: &str = "/api/sessions/approvals/respond";
const AUTHORIZATION_SCOPE: &str = "sessions:write";
const AUTHORIZATION_SUBJECT: &str = "session-approval";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RequestError {
    Invalid,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PendingApprovalsRequest {
    id: String,
    operation_id: String,
    scope: Scope,
    target: Target,
    input: PendingApprovalsInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionApprovalRequest {
    id: String,
    operation_id: String,
    scope: Scope,
    target: Target,
    input: SessionApprovalInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scope {
    kind: String,
    endpoint: Endpoint,
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    kind: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingApprovalsInput {
    endpoint: Endpoint,
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionApprovalInput {
    endpoint: Endpoint,
    session_id: String,
    approval_id: String,
    option_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Endpoint {
    kind: String,
    runtime_adapter_id: String,
    runtime_instance_id: String,
}

impl Endpoint {
    fn parse(&self) -> Option<NativeEndpoint> {
        NativeEndpoint::parse(
            &self.kind,
            &self.runtime_adapter_id,
            &self.runtime_instance_id,
        )
    }
}

impl PendingApprovalsRequest {
    pub(crate) fn decode(
        value: Value,
        authorization: &str,
        verifier: &mut CapabilityDecisionVerifier,
        now: u64,
    ) -> Result<Self, DecodeError> {
        verifier
            .verify(
                authorization,
                now,
                LIST_AUTHORIZATION_ENDPOINT,
                AUTHORIZATION_SCOPE,
                LIST_OPERATION_ID,
                AUTHORIZATION_SUBJECT,
            )
            .map_err(|_| DecodeError::Unauthorized)?;
        Self::decode_semantics(value).map_err(|_| DecodeError::Invalid)
    }

    fn decode_semantics(value: Value) -> Result<Self, RequestError> {
        let request = serde_json::from_value::<Self>(value).map_err(|_| RequestError::Invalid)?;
        request.validate()?;
        Ok(request)
    }

    fn validate(&self) -> Result<(), RequestError> {
        (self.id == CAPABILITY_ID
            && self.operation_id == LIST_OPERATION_ID
            && self.scope.kind == "session"
            && self.target.kind == "session"
            && self.scope.endpoint == self.input.endpoint
            && self.scope.endpoint.parse().is_some()
            && self.scope.session_id == self.input.session_id)
            .then_some(())
            .ok_or(RequestError::Invalid)
    }

    pub(crate) fn into_command(self) -> Result<PendingApprovalsCommand, RequestError> {
        let endpoint = self.scope.endpoint.parse().ok_or(RequestError::Invalid)?;
        PendingApprovalsCommand::try_new(endpoint, self.input.session_id)
            .map_err(|_| RequestError::Invalid)
    }
}

impl SessionApprovalRequest {
    pub(crate) fn decode(
        value: Value,
        authorization: &str,
        verifier: &mut CapabilityDecisionVerifier,
        now: u64,
    ) -> Result<Self, DecodeError> {
        verifier
            .verify(
                authorization,
                now,
                RESPOND_AUTHORIZATION_ENDPOINT,
                AUTHORIZATION_SCOPE,
                RESPOND_OPERATION_ID,
                AUTHORIZATION_SUBJECT,
            )
            .map_err(|_| DecodeError::Unauthorized)?;
        Self::decode_semantics(value).map_err(|_| DecodeError::Invalid)
    }

    fn decode_semantics(value: Value) -> Result<Self, RequestError> {
        let request = serde_json::from_value::<Self>(value).map_err(|_| RequestError::Invalid)?;
        request.validate()?;
        Ok(request)
    }

    fn validate(&self) -> Result<(), RequestError> {
        (self.id == CAPABILITY_ID
            && self.operation_id == RESPOND_OPERATION_ID
            && self.scope.kind == "session"
            && self.target.kind == "approval"
            && self.scope.endpoint == self.input.endpoint
            && self.scope.endpoint.parse().is_some()
            && self.scope.session_id == self.input.session_id)
            .then_some(())
            .ok_or(RequestError::Invalid)
    }

    pub(crate) fn into_command(self) -> Result<SessionApprovalCommand, RequestError> {
        let endpoint = self.scope.endpoint.parse().ok_or(RequestError::Invalid)?;
        SessionApprovalCommand::try_new(
            endpoint,
            self.input.session_id,
            self.input.approval_id,
            self.input.option_id,
        )
        .map_err(|_| RequestError::Invalid)
    }
}

pub(crate) enum PendingApprovalsDelivery {
    Outcome(PendingApprovalsOutcome),
    Unsupported,
    Unavailable,
}

impl From<PendingApprovalsOutcome> for PendingApprovalsDelivery {
    fn from(outcome: PendingApprovalsOutcome) -> Self {
        match outcome {
            PendingApprovalsOutcome::Unsupported => Self::Unsupported,
            PendingApprovalsOutcome::Unavailable => Self::Unavailable,
            outcome => Self::Outcome(outcome),
        }
    }
}

impl PendingApprovalsDelivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Outcome(_) => 200,
            Self::Unsupported => 422,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Outcome(PendingApprovalsOutcome::Found(approvals)) => {
                serde_json::json!({
                    "approvals": approvals.approvals.iter().map(|approval| {
                        serde_json::json!({
                            "approvalId": &approval.approval_id,
                            "optionIds": &approval.option_ids,
                        })
                    }).collect::<Vec<_>>()
                })
            }
            Self::Outcome(PendingApprovalsOutcome::Rejected) => {
                serde_json::json!({ "outcome": "target_rejected" })
            }
            Self::Outcome(PendingApprovalsOutcome::Unknown) => {
                serde_json::json!({ "outcome": "unknown" })
            }
            Self::Outcome(
                PendingApprovalsOutcome::Unsupported | PendingApprovalsOutcome::Unavailable,
            ) => {
                unreachable!("availability outcomes are split before delivery")
            }
            Self::Unsupported => serde_json::json!({
                "success": false,
                "error": "Session approval endpoint is unsupported",
            }),
            Self::Unavailable => serde_json::json!({
                "success": false,
                "error": "Session approval is unavailable",
            }),
        }
    }
}

pub(crate) enum SessionApprovalDelivery {
    Outcome(SessionApprovalOutcome),
    Unsupported,
    Unavailable,
}

impl From<SessionApprovalOutcome> for SessionApprovalDelivery {
    fn from(outcome: SessionApprovalOutcome) -> Self {
        match outcome {
            SessionApprovalOutcome::Unsupported => Self::Unsupported,
            SessionApprovalOutcome::Unavailable => Self::Unavailable,
            outcome => Self::Outcome(outcome),
        }
    }
}

impl SessionApprovalDelivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Outcome(_) => 200,
            Self::Unsupported => 422,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Outcome(SessionApprovalOutcome::Responded) => {
                serde_json::json!({ "outcome": "responded" })
            }
            Self::Outcome(SessionApprovalOutcome::Rejected) => {
                serde_json::json!({ "outcome": "target_rejected" })
            }
            Self::Outcome(SessionApprovalOutcome::Unknown) => {
                serde_json::json!({ "outcome": "unknown" })
            }
            Self::Outcome(
                SessionApprovalOutcome::Unsupported | SessionApprovalOutcome::Unavailable,
            ) => {
                unreachable!("availability outcomes are split before delivery")
            }
            Self::Unsupported => serde_json::json!({
                "success": false,
                "error": "Session approval endpoint is unsupported",
            }),
            Self::Unavailable => serde_json::json!({
                "success": false,
                "error": "Session approval is unavailable",
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn endpoint(adapter: &str) -> Value {
        json!({
            "kind": "native-runtime",
            "runtimeAdapterId": adapter,
            "runtimeInstanceId": "local",
        })
    }

    fn list_request(adapter: &str) -> Value {
        json!({
            "id": "session.approval",
            "operationId": "sessions.approvals.list",
            "scope": {
                "kind": "session",
                "endpoint": endpoint(adapter),
                "sessionId": "session-1",
            },
            "target": { "kind": "session" },
            "input": {
                "endpoint": endpoint(adapter),
                "sessionId": "session-1",
            },
        })
    }

    fn respond_request(adapter: &str) -> Value {
        json!({
            "id": "session.approval",
            "operationId": "sessions.approvals.respond",
            "scope": {
                "kind": "session",
                "endpoint": endpoint(adapter),
                "sessionId": "session-1",
            },
            "target": { "kind": "approval" },
            "input": {
                "endpoint": endpoint(adapter),
                "sessionId": "session-1",
                "approvalId": "approval-1",
                "optionId": "option-1",
            },
        })
    }

    #[test]
    fn permits_only_matcha_as_the_supported_native_endpoint() {
        let matcha = SessionApprovalRequest::decode_semantics(respond_request("matcha-agent"))
            .unwrap()
            .into_command()
            .unwrap();
        assert!(crate::sessions::approval::endpoint_supports_approval(
            matcha.endpoint
        ));

        let openclaw = SessionApprovalRequest::decode_semantics(respond_request("openclaw"))
            .unwrap()
            .into_command()
            .unwrap();
        assert!(!crate::sessions::approval::endpoint_supports_approval(
            openclaw.endpoint
        ));
    }

    #[test]
    fn rejects_legacy_decision_and_shadow_fields() {
        let mut respond = respond_request("matcha-agent");
        respond["input"]["decision"] = json!("allow-once");
        assert!(SessionApprovalRequest::decode_semantics(respond).is_err());

        let mut list = list_request("matcha-agent");
        list["input"]["sessionIdentity"] = json!({});
        assert!(PendingApprovalsRequest::decode_semantics(list).is_err());
    }

    #[test]
    fn list_delivery_exposes_only_opaque_approval_and_option_identifiers() {
        let delivery = PendingApprovalsDelivery::from(PendingApprovalsOutcome::Found(
            crate::sessions::approval::PendingApprovals {
                approvals: vec![crate::sessions::approval::PendingApproval {
                    approval_id: "approval-1".into(),
                    option_ids: vec!["option-1".into()],
                }],
            },
        ));
        assert_eq!(
            delivery.body(),
            json!({
                "approvals": [{ "approvalId": "approval-1", "optionIds": ["option-1"] }]
            })
        );
    }
}
