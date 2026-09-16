use std::sync::Arc;

use tokio::{
    io::AsyncWriteExt,
    net::{TcpListener, TcpStream},
    sync::Mutex,
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer as _, SigningKey};
use serde_json::{Value, json};

use crate::{
    security::{
        audit::{Item, Outcome, Receipt},
        operation as security_operation,
    },
    transport::common::authorization::CapabilityDecisionVerifier,
};

use super::super::wire::read_request;
use super::super::{OPERATION_SCOPE, OPERATION_SUBJECT};
use super::{
    AUDIT_READ_SUBJECT, DecodeError, OPERATION_ENDPOINT, POLICY_READ_SUBJECT, READ_CAPABILITY,
    READ_ENDPOINT, READ_SCOPE, Response, decode_operation, parse_audit_target, verify_read,
};

fn verification_key() -> String {
    let signing_key = SigningKey::from_bytes(&[7; 32]);
    let mut bytes = vec![
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    bytes.extend_from_slice(signing_key.verifying_key().as_bytes());
    URL_SAFE_NO_PAD.encode(bytes)
}

fn signed_read_decision(
    endpoint: &str,
    capability: &str,
    subject: &str,
    correlation: &str,
) -> String {
    signed_decision(endpoint, READ_SCOPE, capability, subject, correlation)
}

fn signed_decision(
    endpoint: &str,
    scope: &str,
    capability: &str,
    subject: &str,
    correlation: &str,
) -> String {
    let payload = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&json!({
            "version": 1,
            "principal": "security-read-test",
            "endpoint": endpoint,
            "scope": scope,
            "capability": capability,
            "subject": subject,
            "expiresAt": u64::MAX,
            "correlation": correlation,
            "revision": "test",
        }))
        .expect("serialize decision"),
    );
    let signed = format!("capability-decision.v1.{payload}");
    let signature = URL_SAFE_NO_PAD.encode(
        SigningKey::from_bytes(&[7; 32])
            .sign(signed.as_bytes())
            .to_bytes(),
    );
    format!("{signed}.{signature}")
}

fn operation_request(operation_id: &str, scope_kind: &str, target: Value, input: Value) -> Value {
    json!({
        "id": "security.operation",
        "operationId": operation_id,
        "scope": { "kind": scope_kind },
        "target": target,
        "input": input,
    })
}

fn signed_operation_decision(operation_id: &str) -> String {
    signed_decision(
        OPERATION_ENDPOINT,
        OPERATION_SCOPE,
        operation_id,
        OPERATION_SUBJECT,
        &format!("test:operation:{operation_id}"),
    )
}

fn operation_verifier() -> CapabilityDecisionVerifier {
    CapabilityDecisionVerifier::try_new(&verification_key()).expect("verifier")
}

#[test]
fn accepts_all_security_operation_shapes_and_projects_inputs() {
    let cases = [
        ("security.quickAudit", "security-policy", json!({})),
        ("security.checkIntegrity", "security-policy", json!({})),
        ("security.rebaselineIntegrity", "security-policy", json!({})),
        (
            "security.scanSkills",
            "security-policy",
            json!({ "scanPath": "workspace/skills" }),
        ),
        (
            "security.checkAdvisories",
            "security-policy",
            json!({ "feedUrl": null }),
        ),
        (
            "security.previewRemediation",
            "security-remediation",
            json!({}),
        ),
        (
            "security.applyRemediation",
            "security-remediation",
            json!({ "actions": ["harden.integrity.rebaseline"] }),
        ),
        (
            "security.rollbackRemediation",
            "security-remediation",
            json!({ "snapshotId": "snapshot-1" }),
        ),
    ];

    for (operation_id, kind, input) in cases {
        let token = signed_operation_decision(operation_id);
        let mut verifier = operation_verifier();
        let body = operation_request(operation_id, kind, json!({ "kind": kind }), input.clone());
        let result = decode_operation(body, &token, &mut verifier, 0);
        assert_eq!(
            result,
            Ok((
                operation_id.to_owned(),
                format!("test:operation:{operation_id}"),
                input,
            )),
            "{operation_id}"
        );
    }
}

#[test]
fn rejects_operation_shape_authorization_and_bounded_input_violations() {
    let operation_id = "security.scanSkills";
    let token = signed_operation_decision(operation_id);
    let mut verifier = operation_verifier();
    let mut body = operation_request(
        operation_id,
        "security-policy",
        json!({ "kind": "security-policy" }),
        json!({ "scanPath": "workspace/skills" }),
    );
    body.as_object_mut()
        .expect("object")
        .insert("extra".into(), json!(true));
    assert_eq!(
        decode_operation(body, &token, &mut verifier, 0),
        Err(DecodeError::Invalid)
    );

    let mut verifier = operation_verifier();
    let wrong_scope = operation_request(
        operation_id,
        "security-remediation",
        json!({ "kind": "security-remediation" }),
        json!({}),
    );
    assert_eq!(
        decode_operation(wrong_scope, &token, &mut verifier, 0),
        Err(DecodeError::Invalid)
    );

    let mut verifier = operation_verifier();
    let invalid_input = operation_request(
        operation_id,
        "security-policy",
        json!({ "kind": "security-policy" }),
        json!({ "scanPath": "\u{0000}" }),
    );
    assert_eq!(
        decode_operation(invalid_input, &token, &mut verifier, 0),
        Err(DecodeError::Invalid)
    );

    let mut verifier = operation_verifier();
    let wrong_capability = signed_decision(
        OPERATION_ENDPOINT,
        OPERATION_SCOPE,
        "security.checkIntegrity",
        OPERATION_SUBJECT,
        "test:wrong-operation-capability",
    );
    let valid_body = operation_request(
        operation_id,
        "security-policy",
        json!({ "kind": "security-policy" }),
        json!({}),
    );
    assert_eq!(
        decode_operation(valid_body, &wrong_capability, &mut verifier, 0),
        Err(DecodeError::Unauthorized)
    );
}

#[test]
fn projects_operation_effect_statuses() {
    let applied = Response::from_security_operation(security_operation::Outcome::from_native(
        openclaw::operations::SecurityActionEffect::Applied(json!({
            "backend": "security-core",
            "created": 1,
            "files": ["baseline.json"]
        })),
    ));
    assert_eq!(applied.status, 200);
    assert_eq!(
        applied.body,
        json!({
            "backend": "security-core",
            "created": 1,
            "files": ["baseline.json"]
        })
    );

    let rejected = Response::from_security_operation(security_operation::Outcome::Rejected);
    assert_eq!(rejected.status, 422);
    assert_eq!(rejected.body["success"], false);

    let unavailable = Response::from_security_operation(security_operation::Outcome::Unavailable);
    assert_eq!(unavailable.status, 503);

    let unknown = Response::from_security_operation(security_operation::Outcome::Unknown);
    assert_eq!(unknown.status, 503);
    assert_eq!(
        unknown.body,
        json!({"success": false, "error": "Security operation is unavailable"})
    );
    let path_body = json!({
        "backend": "security-core",
        "created": 1,
        "files": ["C:\\private\\baseline.json"]
    });
    assert_eq!(
        security_operation::Outcome::from_native(
            openclaw::operations::SecurityActionEffect::Applied(path_body.clone()),
        ),
        security_operation::Outcome::Confirmed(path_body)
    );
    let evidence_body = json!({
        "backend": "security-core",
        "created": 1,
        "files": ["baseline.json"],
        "evidence": "secret"
    });
    assert_eq!(
        security_operation::Outcome::from_native(
            openclaw::operations::SecurityActionEffect::Applied(evidence_body.clone()),
        ),
        security_operation::Outcome::Confirmed(evidence_body)
    );
}

#[tokio::test]
async fn rejects_missing_and_wrong_security_read_authorization() {
    let verifier = Arc::new(Mutex::new(
        CapabilityDecisionVerifier::try_new(&verification_key()).expect("verifier"),
    ));
    assert!(!verify_read(&verifier, None, READ_ENDPOINT, POLICY_READ_SUBJECT,).await);

    let wrong_capability = signed_read_decision(
        READ_ENDPOINT,
        "security.replace",
        POLICY_READ_SUBJECT,
        "test:wrong-capability",
    );
    let wrong_header = format!("Bearer {wrong_capability}");
    assert!(
        !verify_read(
            &verifier,
            Some(&wrong_header),
            READ_ENDPOINT,
            POLICY_READ_SUBJECT,
        )
        .await
    );
}

#[tokio::test]
async fn accepts_valid_policy_and_audit_security_read_authorization() {
    let verifier = Arc::new(Mutex::new(
        CapabilityDecisionVerifier::try_new(&verification_key()).expect("verifier"),
    ));
    let policy = signed_read_decision(
        READ_ENDPOINT,
        READ_CAPABILITY,
        POLICY_READ_SUBJECT,
        "test:policy-read",
    );
    let policy_header = format!("Bearer {policy}");
    assert!(
        verify_read(
            &verifier,
            Some(&policy_header),
            READ_ENDPOINT,
            POLICY_READ_SUBJECT,
        )
        .await
    );

    let audit = signed_read_decision(
        super::AUDIT_ENDPOINT,
        READ_CAPABILITY,
        AUDIT_READ_SUBJECT,
        "test:audit-read",
    );
    let audit_header = format!("Bearer {audit}");
    assert!(
        verify_read(
            &verifier,
            Some(&audit_header),
            super::AUDIT_ENDPOINT,
            AUDIT_READ_SUBJECT,
        )
        .await
    );
}

#[tokio::test]
async fn accepts_bodyless_policy_reads_without_content_headers() {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind listener");
    let port = listener.local_addr().expect("listener address").port();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.expect("accept connection");
        let request = read_request(&mut stream).await.expect("read request");
        (
            request.method,
            request.path,
            request.authorization,
            request.trace_id,
            request.body,
        )
    });

    let mut client = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect client");
    client
        .write_all(b"GET /api/security/policy/current HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
        .await
        .expect("write request");
    drop(client);

    let (method, path, authorization, trace_id, body) = server.await.expect("server task");
    assert_eq!(method, "GET");
    assert_eq!(path, "/api/security/policy/current");
    assert_eq!(authorization, None);
    assert_eq!(trace_id, None);
    assert!(body.is_empty());
}

#[test]
fn accepts_bounded_audit_queries_and_rejects_arbitrary_query_fields() {
    assert_eq!(
        parse_audit_target("/api/security/audit"),
        Ok(Some(crate::security::audit::Query::new(1, 20).unwrap()))
    );
    assert_eq!(
        parse_audit_target("/api/security/audit?page=2&pageSize=8"),
        Ok(Some(crate::security::audit::Query::new(2, 8).unwrap()))
    );
    assert_eq!(
        parse_audit_target("/api/security/audit?page=1&token=secret"),
        Err(())
    );
    assert_eq!(
        parse_audit_target("/api/security/audit?page=1&page=2"),
        Err(())
    );
    assert_eq!(parse_audit_target("/api/security/audit?page=0"), Err(()));
    assert_eq!(
        parse_audit_target("/api/security/audit?pageSize=201"),
        Err(())
    );
}

#[test]
fn policy_response_preserves_full_policy_contract() {
    let policy = json!({
        "preset": "relaxed",
        "securityPolicyVersion": 2,
        "runtime": {
            "autoHarden": true,
            "monitors": { "credentials": true, "memory": true, "cost": false },
            "auditOnGatewayStart": false,
            "runtimeGuardEnabled": true,
            "enablePromptInjectionGuard": true,
            "blockDestructive": true,
            "blockSecrets": true,
            "allowPathPrefixes": ["C:/workspace"],
            "allowDomains": ["example.test"],
            "auditEgressAllowlist": ["api.anthropic.com"],
            "auditDailyCostLimitUsd": 5.0,
            "auditFailureMode": null,
            "promptInjectionPatterns": [],
            "allowlist": { "tools": ["read"], "sessions": [] },
            "logging": { "logDetections": true },
            "destructive": {
                "action": "warn",
                "severityActions": { "critical": "block", "high": "warn", "medium": "confirm", "low": "warn" },
                "categories": {
                    "fileDelete": true,
                    "gitDestructive": true,
                    "sqlDestructive": true,
                    "systemDestructive": true,
                    "processKill": true,
                    "networkDestructive": true,
                    "privilegeEscalation": true
                }
            },
            "secrets": {
                "action": "redact",
                "severityActions": { "critical": "block", "high": "block", "medium": "redact", "low": "warn" }
            },
            "destructivePatterns": [],
            "secretPatterns": []
        }
    });
    let response = Response::policy(policy.clone());
    assert_eq!(response.status, 200);
    assert_eq!(response.body, policy);
}

#[test]
fn omits_absent_rule_ids_from_public_audit_projection() {
    let response = Response::from_audit(Outcome::Observed(Receipt {
        page: 1,
        page_size: 20,
        total: 1,
        items: vec![Item {
            ts: 42,
            tool_name: "exec".into(),
            risk: "low".into(),
            action: "audit".into(),
            decision: "observe".into(),
            rule_id: None,
        }],
    }));
    assert_eq!(response.status, 200);
    assert!(response.body["items"][0].get("ruleId").is_none());
}

#[tokio::test]
async fn rejects_policy_reads_with_a_body() {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind listener");
    let port = listener.local_addr().expect("listener address").port();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.expect("accept connection");
        read_request(&mut stream).await.is_err()
    });

    let mut client = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect client");
    client
        .write_all(b"GET /api/security/policy/current HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\n\r\n{}")
        .await
        .expect("write request");
    drop(client);

    assert!(server.await.expect("server task"));
}
