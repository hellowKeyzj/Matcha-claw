use std::fmt;

use serde::{Deserialize, Serialize};

use crate::protocol::wire::{JsonRpcId, JsonRpcRequest, JsonRpcResponse};

use super::{
    model::{ApprovalId, OptionId, SessionId},
    request::{RequestError, ResponseError, decode_result, request},
};

#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRespondParams {
    session_id: SessionId,
    approval_id: ApprovalId,
    option_id: OptionId,
}

impl ApprovalRespondParams {
    pub fn new(session_id: SessionId, approval_id: ApprovalId, option_id: OptionId) -> Self {
        Self {
            session_id,
            approval_id,
            option_id,
        }
    }
}

impl fmt::Debug for ApprovalRespondParams {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ApprovalRespondParams")
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRecord {
    approval_id: ApprovalId,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<super::model::RunId>,
    option_ids: Vec<OptionId>,
}

impl<'de> Deserialize<'de> for ApprovalRecord {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let approval = NativePendingApproval::deserialize(deserializer)?;
        Ok(Self {
            approval_id: approval.approval_id,
            run_id: approval.run_id,
            option_ids: approval
                .options
                .into_iter()
                .map(|option| option.option_id)
                .collect(),
        })
    }
}

impl ApprovalRecord {
    pub fn approval_id(&self) -> &ApprovalId {
        &self.approval_id
    }

    pub fn run_id(&self) -> Option<&super::model::RunId> {
        self.run_id.as_ref()
    }

    pub fn option_ids(&self) -> &[OptionId] {
        &self.option_ids
    }
}

impl fmt::Debug for ApprovalRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ApprovalRecord")
            .field("option_count", &self.option_ids.len())
            .finish_non_exhaustive()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativePendingApproval {
    approval_id: ApprovalId,
    run_id: Option<super::model::RunId>,
    options: Vec<NativeApprovalOption>,
    #[serde(rename = "status")]
    _status: NativePendingApprovalStatus,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeApprovalOption {
    option_id: OptionId,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum NativePendingApprovalStatus {
    Pending,
}

#[derive(Deserialize)]
#[serde(tag = "resultType", rename_all = "camelCase")]
enum NativeApprovalRespondResult {
    Responded,
    AlreadyResolved,
}

pub(crate) fn approval_respond_request(
    id: JsonRpcId,
    params: ApprovalRespondParams,
) -> Result<JsonRpcRequest, RequestError> {
    request(id, "approval.respond", params)
}

pub(crate) fn decode_approval_respond_result(
    expected_id: &JsonRpcId,
    response: JsonRpcResponse,
) -> Result<(), ResponseError> {
    let _: NativeApprovalRespondResult = decode_result(expected_id, response, "approval.respond")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::protocol::wire::{JsonRpcMessage, decode, encode};

    fn id(value: &str) -> JsonRpcId {
        JsonRpcId::String(value.to_owned())
    }

    #[test]
    fn respond_request_keeps_only_approval_correlation() {
        let request = approval_respond_request(
            id("10"),
            ApprovalRespondParams::new(
                SessionId::try_new("session-1").unwrap(),
                ApprovalId::try_new("approval-1").unwrap(),
                OptionId::try_new("option-1").unwrap(),
            ),
        )
        .unwrap();

        let frame = encode(&JsonRpcMessage::from(request)).unwrap();
        let expected = "{\"jsonrpc\":\"2.0\",\"id\":\"10\",\"method\":\"approval.respond\",\"params\":{\"sessionId\":\"session-1\",\"approvalId\":\"approval-1\",\"optionId\":\"option-1\"}}\n";

        assert!(frame.ends_with('\n'));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&frame).unwrap(),
            serde_json::from_str::<serde_json::Value>(expected).unwrap(),
        );
    }

    #[test]
    fn pending_snapshot_approval_projects_only_opaque_identifiers() {
        let approval: ApprovalRecord = serde_json::from_value(json!({
            "approvalId": "canary-approval-id",
            "sessionId": "canary-session-id",
            "runId": "canary-run-id",
            "workerId": "canary-worker-id",
            "toolCallId": "canary-tool-call-id",
            "toolName": "canary-tool-name",
            "prompt": "canary-prompt",
            "options": [{
                "optionId": "canary-option-id",
                "label": "canary-label",
                "kind": "allow_once"
            }],
            "status": {
                "type": "pending",
                "requestedAt": "canary-requested-at",
                "expiresAt": "canary-expires-at"
            }
        }))
        .unwrap();

        assert_eq!(approval.approval_id().as_str(), "canary-approval-id");
        assert_eq!(approval.option_ids()[0].as_str(), "canary-option-id");
        let rendered = serde_json::to_string(&approval).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&rendered).unwrap(),
            json!({
                "approvalId": "canary-approval-id",
                "optionIds": ["canary-option-id"]
            })
        );
        for canary in [
            "canary-session-id",
            "canary-run-id",
            "canary-worker-id",
            "canary-tool-call-id",
            "canary-tool-name",
            "canary-prompt",
            "canary-label",
            "canary-requested-at",
            "canary-expires-at",
        ] {
            assert!(!rendered.contains(canary));
            assert!(!format!("{approval:?}").contains(canary));
        }
    }

    #[test]
    fn snapshot_rejects_resolved_native_approval() {
        let result = serde_json::from_value::<ApprovalRecord>(json!({
            "approvalId": "approval-1",
            "options": [],
            "status": {
                "type": "approved",
                "resolvedAt": "now",
                "optionId": "allow-once"
            }
        }));

        assert!(result.is_err());
    }

    #[test]
    fn response_never_projects_native_terminal_status() {
        let response = response(
            "10",
            r#"{
                "resultType": "responded",
                "approval": {
                    "approvalId": "canary-approval-id",
                    "status": {"type":"approved","optionId":"canary-option-id"}
                },
                "decision": {"type":"approved","optionId":"canary-option-id"}
            }"#,
        );

        assert_eq!(decode_approval_respond_result(&id("10"), response), Ok(()));
    }

    #[test]
    fn already_resolved_is_a_broker_receipt_without_terminal_projection() {
        let response = response(
            "11",
            r#"{
                "resultType": "alreadyResolved",
                "approval": {"status": {"type":"cancelled","reason":"workerExited"}},
                "status": {"type":"cancelled","reason":"workerExited"},
                "decision": {"type":"cancelled","reason":"workerExited"}
            }"#,
        );

        assert_eq!(decode_approval_respond_result(&id("11"), response), Ok(()));
    }

    #[test]
    fn unknown_broker_result_is_rejected() {
        let response = response("12", r#"{"resultType":"approvalNotFound"}"#);
        assert_eq!(
            decode_approval_respond_result(&id("12"), response),
            Err(ResponseError::InvalidResult {
                method: "approval.respond"
            })
        );
    }

    fn response(id: &str, result: &str) -> JsonRpcResponse {
        let frame = format!(r#"{{"jsonrpc":"2.0","id":"{id}","result":{result}}}"#);
        match decode(&frame).unwrap() {
            JsonRpcMessage::Response(response) => response,
            _ => panic!("expected response"),
        }
    }
}
