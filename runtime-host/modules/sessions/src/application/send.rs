use serde::Serialize;

use organization::{DeliveryId, EndpointSessionId};

use super::state::SessionSourceBinding;

pub use super::endpoint::NativeEndpoint;

const MAX_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_SESSION_KEY_BYTES: usize = 4096;
const MAX_ENDPOINT_SESSION_ID_BYTES: usize = 4096;
const MAX_RUN_ID_BYTES: usize = 4096;
const MAX_IDEMPOTENCY_KEY_BYTES: usize = 4096;
const MAX_ATTACHMENTS: usize = 16;
const MAX_ATTACHMENT_DECODED_BYTES: usize = 20 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_DECODED_BYTES: usize = 20 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Attachment {
    pub mime_type: String,
    pub file_name: String,
    pub content: String,
}

impl Attachment {
    fn is_valid(&self) -> bool {
        !self.mime_type.is_empty()
            && self.mime_type.len() <= 255
            && !self.mime_type.chars().any(char::is_control)
            && !self.file_name.is_empty()
            && self.file_name.len() <= 255
            && !self.file_name.contains(['/', '\\'])
            && !self.file_name.chars().any(char::is_control)
            && self.content.len() <= canonical_base64_len(MAX_ATTACHMENT_DECODED_BYTES)
            && canonical_base64_decoded_len(&self.content).is_some()
    }

    fn decoded_bytes(&self) -> usize {
        canonical_base64_decoded_len(&self.content).unwrap_or(usize::MAX)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionDeliveryContext {
    pub delivery_id: DeliveryId,
    pub endpoint_session_id: EndpointSessionId,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionSendCommand {
    pub endpoint: NativeEndpoint,
    pub session_key: String,
    /// Peer-native session binding. OpenClaw sends use `session_key`; Matcha sends use
    /// this native handle when it is present.
    pub endpoint_session_id: Option<String>,
    pub route_key: String,
    pub message: String,
    pub run_id: Option<String>,
    pub idempotency_key: Option<String>,
    /// Upper-layer delivery hint; it is never projected into native wire or outcome selection.
    pub deliver: Option<bool>,
    pub attachments: Vec<Attachment>,
    /// Host-private transport correlation; it is never serialized or projected to a peer.
    pub trace_id: Option<String>,
    pub system_provenance_receipt: Option<String>,
    pub source_binding: SessionSourceBinding,
    pub delivery_context: Option<SessionDeliveryContext>,
}

impl SessionSendCommand {
    pub fn try_new(
        endpoint: NativeEndpoint,
        session_key: String,
        endpoint_session_id: Option<String>,
        route_key: String,
        message: String,
        run_id: Option<String>,
        idempotency_key: Option<String>,
        deliver: Option<bool>,
        attachments: Vec<Attachment>,
        trace_id: Option<String>,
    ) -> Result<Self, InvalidCommand> {
        if !valid_bounded_text(&session_key, MAX_SESSION_KEY_BYTES)
            || !valid_optional_identity(
                endpoint_session_id.as_deref(),
                MAX_ENDPOINT_SESSION_ID_BYTES,
            )
            || !valid_bounded_text(&route_key, MAX_SESSION_KEY_BYTES)
            || message.len() > MAX_MESSAGE_BYTES
            || !valid_optional_identity(run_id.as_deref(), MAX_RUN_ID_BYTES)
            || !valid_optional_identity(idempotency_key.as_deref(), MAX_IDEMPOTENCY_KEY_BYTES)
            || attachments.len() > MAX_ATTACHMENTS
            || attachments.iter().any(|attachment| !attachment.is_valid())
            || attachments
                .iter()
                .map(Attachment::decoded_bytes)
                .sum::<usize>()
                > MAX_TOTAL_ATTACHMENT_DECODED_BYTES
        {
            return Err(InvalidCommand);
        }
        Ok(Self {
            endpoint,
            session_key,
            endpoint_session_id,
            route_key,
            message,
            run_id,
            idempotency_key,
            deliver,
            attachments,
            trace_id,
            system_provenance_receipt: None,
            source_binding: SessionSourceBinding::ordinary(),
            delivery_context: None,
        })
    }

    pub fn requested_run_id(&self) -> Option<&str> {
        self.run_id.as_deref()
    }

    pub fn request_run_identity(&self) -> Option<&str> {
        self.run_id.as_deref().or(self.idempotency_key.as_deref())
    }

    pub fn trace_id(&self) -> Option<&str> {
        self.trace_id.as_deref()
    }

    pub fn with_endpoint_session_id(mut self, session_id: String) -> Result<Self, InvalidCommand> {
        if !valid_bounded_text(&session_id, MAX_ENDPOINT_SESSION_ID_BYTES) {
            return Err(InvalidCommand);
        }
        self.endpoint_session_id = Some(session_id);
        Ok(self)
    }

    pub fn with_system_provenance_receipt(
        mut self,
        receipt: String,
    ) -> Result<Self, InvalidCommand> {
        if receipt.is_empty() || receipt.len() > MAX_MESSAGE_BYTES {
            return Err(InvalidCommand);
        }
        self.system_provenance_receipt = Some(receipt);
        Ok(self)
    }

    pub fn with_source_binding(mut self, binding: SessionSourceBinding) -> Self {
        self.source_binding = binding;
        self
    }

    pub fn with_delivery_context(mut self, context: SessionDeliveryContext) -> Self {
        self.delivery_context = Some(context);
        self
    }

    pub fn with_resolved_run_id(mut self, run_id: String) -> Result<Self, InvalidCommand> {
        if !valid_bounded_text(&run_id, MAX_RUN_ID_BYTES) {
            return Err(InvalidCommand);
        }
        self.run_id = Some(run_id);
        self.idempotency_key = None;
        Ok(self)
    }
}

fn valid_bounded_text(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn valid_optional_identity(value: Option<&str>, max_bytes: usize) -> bool {
    value.is_none_or(|value| valid_bounded_text(value, max_bytes))
}

const fn canonical_base64_len(decoded_bytes: usize) -> usize {
    decoded_bytes.div_ceil(3) * 4
}

fn canonical_base64_decoded_len(value: &str) -> Option<usize> {
    let bytes = value.as_bytes();
    if bytes.is_empty() || !bytes.len().is_multiple_of(4) {
        return None;
    }
    let padding = bytes.iter().rev().take_while(|byte| **byte == b'=').count();
    if padding > 2
        || bytes[..bytes.len() - padding]
            .iter()
            .any(|byte| base64_value(*byte).is_none())
    {
        return None;
    }
    if bytes[bytes.len() - padding..]
        .iter()
        .any(|byte| *byte != b'=')
    {
        return None;
    }
    let last = bytes.len() - padding - 1;
    match padding {
        0 => {}
        1 if base64_value(bytes[last])? & 0b11 != 0 => return None,
        2 if base64_value(bytes[last])? & 0b1111 != 0 => return None,
        _ => {}
    }
    Some(bytes.len() / 4 * 3 - padding)
}

fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidCommand;

/// Stable identity available only after a native Matcha run receipt is returned.
///
/// This is the owner-local outcome projected by the `sessions.send` response
/// transport; its serialized shape is part of that response contract.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(
    tag = "outcome",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SessionSendOutcome {
    Queued {
        run_id: String,
    },
    Succeeded {
        run_id: String,
        status: SessionSendStatus,
    },
    #[serde(rename = "target_rejected")]
    Rejected,
    Unknown,
    Unsupported,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionSendStatus {
    Started,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{NativeEndpoint, SessionSendCommand, SessionSendOutcome};

    fn command(endpoint: NativeEndpoint) -> SessionSendCommand {
        SessionSendCommand::try_new(
            endpoint,
            "session-1".into(),
            Some("endpoint-session-1".into()),
            "renderer-route:test".into(),
            "hello".into(),
            Some("requested-run".into()),
            None,
            Some(true),
            Vec::new(),
            None,
        )
        .unwrap()
    }

    #[test]
    fn request_run_identity_uses_idempotency_key_when_run_id_is_absent() {
        let command = SessionSendCommand::try_new(
            NativeEndpoint::MatchaAgentLocal,
            "session-1".into(),
            Some("endpoint-session-1".into()),
            "renderer-route:test".into(),
            "hello".into(),
            None,
            Some("idempotency-1".into()),
            Some(true),
            Vec::new(),
            None,
        )
        .unwrap();

        assert_eq!(command.requested_run_id(), None);
        assert_eq!(command.request_run_identity(), Some("idempotency-1"));
    }

    #[test]
    fn serializes_host_local_queue_admission_with_camel_case_run_id() {
        assert_eq!(
            serde_json::to_value(SessionSendOutcome::Queued {
                run_id: "run-1".into(),
            })
            .unwrap(),
            json!({ "outcome": "queued", "runId": "run-1" })
        );
    }

    #[test]
    fn serializes_public_success_with_camel_case_run_id() {
        assert_eq!(
            serde_json::to_value(SessionSendOutcome::Succeeded {
                run_id: "run-1".into(),
                status: super::SessionSendStatus::Started,
            })
            .unwrap(),
            json!({ "outcome": "succeeded", "runId": "run-1", "status": "started" })
        );
    }

    #[test]
    fn serializes_public_rejection_as_target_rejected() {
        assert_eq!(
            serde_json::to_value(SessionSendOutcome::Rejected).unwrap(),
            json!({ "outcome": "target_rejected" })
        );
    }
}
