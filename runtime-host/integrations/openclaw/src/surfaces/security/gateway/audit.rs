use std::sync::Arc;

use serde_json::{Map, Value, json};

use crate::gateway::{
    client::GatewayClient,
    wire::{self, GatewayResponse},
};

use crate::gateway::operation::{
    ReadError as OperationsReadError, next_request_id, read as read_gateway,
};

const SECURITY_AUDIT_QUERY_METHOD: &str = "security.audit.query";
const MAX_JSON_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_PAGE: u64 = 10_000;
const MAX_PAGE_SIZE: u64 = 200;
const MAX_TOTAL: u64 = 5_000;
const MAX_LABEL_BYTES: usize = 256;

pub struct SecurityAuditOperation {
    gateway: Arc<GatewayClient>,
}

impl SecurityAuditOperation {
    pub fn new(gateway: Arc<GatewayClient>) -> Self {
        Self { gateway }
    }

    pub async fn query(&self, query: SecurityAuditQuery) -> SecurityAuditEffect {
        let request =
            match security_audit_query_request(next_request_id("security-audit-query"), &query) {
                Ok(request) => request,
                Err(_) => return SecurityAuditEffect::OutcomeUnknown,
            };
        let response = match read_gateway(&self.gateway, request).await {
            Ok(response) => response,
            Err(OperationsReadError::Rejected) => return SecurityAuditEffect::RuntimeRejected,
            Err(OperationsReadError::Unavailable) => return SecurityAuditEffect::Unavailable,
            Err(OperationsReadError::Protocol) => return SecurityAuditEffect::OutcomeUnknown,
        };
        match response {
            GatewayResponse::Failure { .. } => SecurityAuditEffect::RuntimeRejected,
            response => match decode_security_audit(response, &query) {
                Ok(receipt) => SecurityAuditEffect::Observed(receipt),
                Err(_) => SecurityAuditEffect::OutcomeUnknown,
            },
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SecurityAuditQuery {
    page: u64,
    page_size: u64,
}

impl SecurityAuditQuery {
    pub fn new(page: u64, page_size: u64) -> Option<Self> {
        (1..=MAX_PAGE)
            .contains(&page)
            .then_some(())
            .and_then(|()| (1..=MAX_PAGE_SIZE).contains(&page_size).then_some(()))
            .map(|()| Self { page, page_size })
    }

    pub const fn page(self) -> u64 {
        self.page
    }

    pub const fn page_size(self) -> u64 {
        self.page_size
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SecurityAuditItem {
    ts: u64,
    tool_name: String,
    risk: String,
    action: String,
    decision: String,
    rule_id: Option<String>,
}

impl SecurityAuditItem {
    pub fn ts(&self) -> u64 {
        self.ts
    }

    pub fn tool_name(&self) -> &str {
        &self.tool_name
    }

    pub fn risk(&self) -> &str {
        &self.risk
    }

    pub fn action(&self) -> &str {
        &self.action
    }

    pub fn decision(&self) -> &str {
        &self.decision
    }

    pub fn rule_id(&self) -> Option<&str> {
        self.rule_id.as_deref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SecurityAuditReceipt {
    page: u64,
    page_size: u64,
    total: u64,
    items: Vec<SecurityAuditItem>,
}

impl SecurityAuditReceipt {
    pub fn page(&self) -> u64 {
        self.page
    }

    pub fn page_size(&self) -> u64 {
        self.page_size
    }

    pub fn total(&self) -> u64 {
        self.total
    }

    pub fn items(&self) -> &[SecurityAuditItem] {
        &self.items
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SecurityAuditEffect {
    Observed(SecurityAuditReceipt),
    RuntimeRejected,
    Unavailable,
    OutcomeUnknown,
}

fn security_audit_query_request(
    request_id: String,
    query: &SecurityAuditQuery,
) -> Result<wire::RpcRequest, wire::WireError> {
    wire::operations_request(
        request_id,
        SECURITY_AUDIT_QUERY_METHOD,
        json!({ "page": query.page, "pageSize": query.page_size }),
    )
}

fn decode_security_audit(
    response: GatewayResponse,
    query: &SecurityAuditQuery,
) -> Result<SecurityAuditReceipt, ()> {
    let payload = success_payload_object(response)?;
    require_exact_fields(&payload, &["page", "pageSize", "total", "items", "backend"])?;
    if payload.get("backend").and_then(Value::as_str) != Some("security-core")
        || required_u64(&payload, "page")? != query.page
        || required_u64(&payload, "pageSize")? != query.page_size
    {
        return Err(());
    }
    let total = required_u64(&payload, "total")?;
    if total > MAX_TOTAL {
        return Err(());
    }
    let raw_items = payload.get("items").and_then(Value::as_array).ok_or(())?;
    if raw_items.len() > query.page_size as usize || raw_items.len() > MAX_PAGE_SIZE as usize {
        return Err(());
    }
    let items = raw_items
        .iter()
        .map(decode_security_audit_item)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(SecurityAuditReceipt {
        page: query.page,
        page_size: query.page_size,
        total,
        items,
    })
}

fn decode_security_audit_item(value: &Value) -> Result<SecurityAuditItem, ()> {
    let item = value.as_object().ok_or(())?;
    let expected = ["ts", "toolName", "risk", "action", "decision", "ruleId"];
    if item.keys().any(|key| !expected.contains(&key.as_str()))
        || item.len() < 5
        || item.len() > 6
        || !item.contains_key("ts")
        || !item.contains_key("toolName")
        || !item.contains_key("risk")
        || !item.contains_key("action")
        || !item.contains_key("decision")
    {
        return Err(());
    }
    let ts = required_u64(item, "ts")?;
    if ts == 0 || ts > MAX_JSON_SAFE_INTEGER {
        return Err(());
    }
    let tool_name = required_label(item, "toolName")?;
    let risk = required_enum(item, "risk", &["critical", "high", "medium", "low", "info"])?;
    let action = required_enum(item, "action", &["audit", "allow", "block"])?;
    let decision = required_label(item, "decision")?;
    let rule_id = match item.get("ruleId") {
        None => None,
        Some(Value::String(value)) => Some(safe_label(value)?),
        Some(_) => return Err(()),
    };
    Ok(SecurityAuditItem {
        ts,
        tool_name,
        risk,
        action,
        decision,
        rule_id,
    })
}

fn success_payload_object(response: GatewayResponse) -> Result<Map<String, Value>, ()> {
    match response {
        GatewayResponse::Success {
            payload: Some(Value::Object(payload)),
            ..
        } => Ok(payload),
        GatewayResponse::Failure { .. } | GatewayResponse::Success { .. } => Err(()),
    }
}

fn require_exact_fields(payload: &Map<String, Value>, expected: &[&str]) -> Result<(), ()> {
    (payload.len() == expected.len()
        && payload
            .keys()
            .all(|field| expected.contains(&field.as_str())))
    .then_some(())
    .ok_or(())
}

fn required_u64(payload: &Map<String, Value>, field: &str) -> Result<u64, ()> {
    payload
        .get(field)
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_JSON_SAFE_INTEGER)
        .ok_or(())
}

fn required_label(payload: &Map<String, Value>, field: &str) -> Result<String, ()> {
    let value = payload.get(field).and_then(Value::as_str).ok_or(())?;
    safe_label(value)
}

fn required_enum(
    payload: &Map<String, Value>,
    field: &str,
    allowed: &[&str],
) -> Result<String, ()> {
    let value = payload.get(field).and_then(Value::as_str).ok_or(())?;
    if allowed.contains(&value) {
        Ok(value.to_owned())
    } else {
        Err(())
    }
}

fn safe_label(value: &str) -> Result<String, ()> {
    if value.is_empty()
        || value.len() > MAX_LABEL_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Err(());
    }
    Ok(value.to_owned())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn accepts_only_the_safe_audit_projection() {
        let query = SecurityAuditQuery::new(1, 20).unwrap();
        let response = GatewayResponse::Success {
            request_id: "test".into(),
            payload: Some(json!({
                "page": 1,
                "pageSize": 20,
                "total": 1,
                "backend": "security-core",
                "items": [{
                    "ts": 42,
                    "toolName": "exec",
                    "risk": "high",
                    "action": "block",
                    "decision": "deny",
                    "ruleId": "shell-delete"
                }]
            })),
        };
        let receipt = decode_security_audit(response, &query).unwrap();
        assert_eq!(receipt.items()[0].tool_name(), "exec");
        assert_eq!(receipt.items()[0].rule_id(), Some("shell-delete"));
    }

    #[test]
    fn rejects_private_fields_and_path_like_values() {
        let query = SecurityAuditQuery::new(1, 20).unwrap();
        for item in [
            json!({
                "ts": 42,
                "toolName": "C:\\private\\secret",
                "risk": "high",
                "action": "block",
                "decision": "deny"
            }),
            json!({
                "ts": 42,
                "toolName": "exec",
                "risk": "high",
                "action": "block",
                "decision": "deny",
                "detail": "private-canary"
            }),
            json!({
                "ts": 42,
                "toolName": "exec",
                "risk": "high",
                "action": "block",
                "decision": "deny",
                "agentId": "private-canary"
            }),
        ] {
            let response = GatewayResponse::Success {
                request_id: "test".into(),
                payload: Some(json!({
                    "page": 1,
                    "pageSize": 20,
                    "total": 1,
                    "backend": "security-core",
                    "items": [item]
                })),
            };
            assert!(decode_security_audit(response, &query).is_err());
        }
    }
}
