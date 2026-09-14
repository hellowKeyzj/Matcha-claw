use std::{collections::BTreeMap, sync::Arc};

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

use super::*;
use crate::{
    gateway::{
        auth::GatewaySecret,
        client::{GatewayClientMetadata, GatewayEndpoint, test_support::*},
        wire,
    },
    port::SkillUploadOutcome,
};

const SHARED_CONTROL_SCOPES: [&str; 4] = [
    "operator.read",
    "operator.write",
    "operator.admin",
    "operator.approvals",
];
const SHARED_CONTROL_CAPS: [&str; 2] = ["agent-kind", "tool-events"];
const SHARED_CONTROL_EVENTS: [&str; 1] = ["tick"];
const SHARED_CONTROL_METHODS: [&str; 9] = [
    "status",
    "config.get",
    "config.patch",
    "config.apply",
    "plugins.refresh",
    "agents.list",
    SKILLS_STATUS_METHOD,
    "channels.pairing.list",
    wire::SYSTEM_PRESENCE_METHOD,
];
const SKILL_OPERATION_METHODS: [&str; 14] = [
    "status",
    "config.get",
    "config.patch",
    "config.apply",
    "plugins.refresh",
    "agents.list",
    SKILLS_STATUS_METHOD,
    "skills.detail",
    "skills.install",
    "skills.update",
    "skills.upload.begin",
    "skills.upload.chunk",
    "skills.upload.commit",
    wire::SYSTEM_PRESENCE_METHOD,
];
#[test]
fn installed_catalog_projects_only_selectable_normalized_skill_names() {
    let catalog = decode_installed_catalog(GatewayResponse::Success {
        request_id: "skills-status".into(),
        payload: Some(json!({
            "workspaceDir": "private-workspace",
            "skills": [
                {"skillKey": "private-key", "name": " Web ", "eligible": true},
                {"id": "private-id", "name": "writer", "eligible": true, "disabled": false},
                {"name": "blocked", "eligible": true, "blockedByAllowlist": true},
                {"name": "agent-filtered", "eligible": true, "blockedByAgentFilter": true},
                {"name": "missing-env", "eligible": false, "missing": {"env": ["PRIVATE_TOKEN"]}},
                {"name": "disabled", "eligible": true, "disabled": true},
                {"name": "not-eligible"},
                {"name": "web", "eligible": true}
            ]
        })),
    })
    .unwrap();

    assert_eq!(catalog.names(), ["web", "writer"]);
    let debug = format!("{catalog:?}");
    assert!(!debug.contains("private-workspace"));
    assert!(!debug.contains("PRIVATE_TOKEN"));
}

#[test]
fn status_catalog_projects_only_safe_renderer_fields_and_semantics() {
    let catalog = decode_skill_status_catalog(GatewayResponse::Success {
        request_id: "skills-status".into(),
        payload: Some(json!({
            "workspaceDir": "private-workspace",
            "skills": [
                {
                    "skillKey": "  eligible-skill ",
                    "name": " Eligible ",
                    "description": " Safe description ",
                    "source": "openclaw-bundled",
                    "eligible": true
                },
                {
                    "skillKey": "allowlist-blocked-skill",
                    "name": "Allowlist Blocked",
                    "description": "Blocked description",
                    "eligible": true,
                    "blockedByAllowlist": true
                },
                {
                    "skillKey": "agent-filtered-skill",
                    "name": "Agent Filtered",
                    "description": "Agent filtered description",
                    "eligible": true,
                    "blockedByAgentFilter": true
                },
                {
                    "skillKey": "bundled-ineligible-skill",
                    "name": "Bundled Ineligible",
                    "description": "Bundled ineligible description",
                    "eligible": false,
                    "bundled": true
                },
                {
                    "skillKey": "missing-skill",
                    "name": "Missing",
                    "description": "Missing description",
                    "eligible": false,
                    "missing": {"bins": ["private-bin"], "env": ["PRIVATE_TOKEN"]}
                },
                {
                    "skillKey": "disabled-skill",
                    "name": "Disabled",
                    "description": "Disabled description",
                    "eligible": true,
                    "disabled": true
                }
            ]
        })),
    })
    .unwrap();

    let eligible = catalog
        .entries()
        .iter()
        .find(|entry| entry.key() == "eligible-skill")
        .unwrap();
    assert_eq!(eligible.key(), "eligible-skill");
    assert_eq!(eligible.display_name(), "Eligible");
    assert_eq!(eligible.description(), "Safe description");
    assert!(eligible.enabled());
    assert!(eligible.selectable());
    assert_eq!(eligible.source(), Some(SkillStatusSource::OpenClawBundled));
    assert_eq!(eligible.unavailable_reason(), None);

    assert!(
        catalog
            .entries()
            .iter()
            .all(|entry| entry.key() != "allowlist-blocked-skill"
                && entry.key() != "bundled-ineligible-skill")
    );

    let agent_filtered = catalog
        .entries()
        .iter()
        .find(|entry| entry.key() == "agent-filtered-skill")
        .unwrap();
    assert!(agent_filtered.enabled());
    assert!(agent_filtered.selectable());
    assert_eq!(agent_filtered.unavailable_reason(), None);

    let missing = catalog
        .entries()
        .iter()
        .find(|entry| entry.key() == "missing-skill")
        .unwrap();
    assert!(missing.enabled());
    assert!(!missing.selectable());
    assert_eq!(
        missing.unavailable_reason(),
        Some(SkillStatusUnavailableReason::MissingRequirements)
    );
    assert_eq!(
        missing.missing_requirement_categories(),
        [
            MissingSkillRequirementCategory::Binaries,
            MissingSkillRequirementCategory::Environment
        ]
    );

    let disabled = catalog
        .entries()
        .iter()
        .find(|entry| entry.key() == "disabled-skill")
        .unwrap();
    assert!(!disabled.enabled());
    assert!(!disabled.selectable());
    assert_eq!(
        disabled.unavailable_reason(),
        Some(SkillStatusUnavailableReason::Disabled)
    );

    let rendered = format!("{catalog:?}");
    for private in [
        "private-workspace",
        "private-bin",
        "PRIVATE_TOKEN",
        "private-source",
        "baseDir",
        "filePath",
        "config",
        "version",
        "author",
    ] {
        assert!(!rendered.contains(private), "leaked {private}");
    }
}

#[test]
fn status_catalog_accepts_2026_8_2_fields_without_projecting_private_data() {
    let catalog = decode_skill_status_catalog(GatewayResponse::Success {
        request_id: "skills-status".into(),
        payload: Some(json!({
            "workspaceDir": "private-workspace",
            "skills": [{
                "skillKey": " Excel XLSX ",
                "name": "Safe Skill",
                "description": "Safe description",
                "source": "private-source",
                "bundled": true,
                "filePath": "C:/private/SKILL.md",
                "baseDir": "C:/private",
                "primaryEnv": "PRIVATE_TOKEN",
                "emoji": "📊",
                "homepage": "https://example.invalid",
                "always": false,
                "disabled": false,
                "blockedByAllowlist": false,
                "eligible": true,
                "platformIncompatible": false,
                "modelVisible": true,
                "userInvocable": true,
                "commandVisible": true,
                "requirements": {"env": ["PRIVATE_TOKEN"]},
                "missing": {"config": ["private-config"]},
                "configChecks": [{"path": "apiKey", "satisfied": false, "diagnostic": "raw diagnostic"}],
                "install": [],
                "clawhub": {"author": "private-author", "version": "9.9.9", "slug": "excel-xlsx"},
                "skillCard": {"path": "C:/private/card", "sizeBytes": 9}
            }]
        })),
    })
    .unwrap();

    let entry = &catalog.entries()[0];
    assert_eq!(entry.key(), "Excel XLSX");
    assert_eq!(entry.slug(), Some("excel-xlsx"));
    assert_eq!(entry.display_name(), "Safe Skill");
    assert_eq!(entry.bundled(), Some(true));
    assert_eq!(entry.always(), Some(false));
    assert_eq!(entry.emoji(), Some("📊"));
    assert_eq!(entry.source(), None);
    assert!(!entry.selectable());
    assert_eq!(
        entry.missing_requirement_categories(),
        [MissingSkillRequirementCategory::Configuration]
    );
    let rendered = format!("{catalog:?}");
    for private in [
        "private-workspace",
        "private-source",
        "C:/private",
        "PRIVATE_TOKEN",
        "private-config",
        "raw diagnostic",
        "9.9.9",
        "private-author",
    ] {
        assert!(!rendered.contains(private), "leaked {private}");
    }
}

#[test]
fn installed_catalog_accepts_2026_8_2_fields_without_projecting_private_data() {
    let catalog = decode_installed_catalog(GatewayResponse::Success {
        request_id: "skills-status".into(),
        payload: Some(json!({
            "workspaceDir": "private-workspace",
            "skills": [{
                "skillKey": "safe-skill",
                "name": "Safe Skill",
                "source": "private-source",
                "filePath": "C:/private/SKILL.md",
                "baseDir": "C:/private",
                "primaryEnv": "PRIVATE_TOKEN",
                "eligible": true,
                "disabled": false,
                "requirements": {"env": ["PRIVATE_TOKEN"]},
                "missing": {},
                "configChecks": [{"diagnostic": "raw diagnostic"}],
                "install": {"source": "clawhub", "version": "9.9.9"},
                "clawhub": {"author": "private-author", "version": "9.9.9"}
            }]
        })),
    })
    .unwrap();

    assert_eq!(catalog.names(), ["safe skill"]);
    let rendered = format!("{catalog:?}");
    for private in [
        "private-workspace",
        "private-source",
        "C:/private",
        "PRIVATE_TOKEN",
        "raw diagnostic",
        "9.9.9",
        "private-author",
    ] {
        assert!(!rendered.contains(private), "leaked {private}");
    }
}

#[test]
fn status_catalog_rejects_non_status_wire_payloads() {
    for payload in [json!({}), json!({"skills": {}})] {
        assert!(
            decode_skill_status_catalog(GatewayResponse::Success {
                request_id: "skills-status".into(),
                payload: Some(payload),
            })
            .is_err()
        );
    }
}

#[test]
fn status_catalog_preserves_raw_keys_and_skips_bad_entries() {
    let catalog = decode_skill_status_catalog(GatewayResponse::Success {
        request_id: "skills-status".into(),
        payload: Some(json!({
            "skills": [
                {"skillKey": " Excel XLSX ", "name": "Excel", "eligible": true},
                {"skillKey": "vendor/foo", "name": "Slash", "eligible": true},
                {"skillKey": "vendor\\foo", "name": "Backslash", "eligible": true},
                {"name": "missing-key"},
                {"skillKey": " "},
                {"skillKey": "bad\0key"},
                {"skillKey": "bad-field", "eligible": "yes"},
                {"skillKey": "bad-missing", "missing": {"env": "TOKEN"}}
            ]
        })),
    })
    .unwrap();

    assert_eq!(
        catalog
            .entries()
            .iter()
            .map(|entry| entry.key())
            .collect::<Vec<_>>(),
        ["Excel XLSX", "vendor/foo", "vendor\\foo"]
    );
}

#[tokio::test(flavor = "current_thread")]
async fn status_catalog_uses_the_dedicated_read_scope_and_method() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let catalog = OpenClawSkillStatusCatalog::new(test_client(&listener, identity.fingerprint()));
    let acceptor = identity.acceptor();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_status_hello(&mut socket).await;
        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], SKILLS_STATUS_METHOD);
        assert_eq!(request["params"], json!({}));
        let request_id = request["id"].as_str().unwrap();
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": request_id, "ok": true,
                "payload": {"skills": []}
            }),
        )
        .await;
        socket.close(None).await.unwrap();
    });

    assert_eq!(catalog.read().await.unwrap().entries(), []);
    server.await.unwrap();
}

#[test]
fn installed_catalog_rejects_non_status_payloads() {
    assert!(
        decode_installed_catalog(GatewayResponse::Success {
            request_id: "skills-status".into(),
            payload: Some(json!({"skills": {}})),
        })
        .is_err()
    );
}

#[test]
fn installed_catalog_requires_an_explicit_selectable_name() {
    let catalog = decode_installed_catalog(GatewayResponse::Success {
        request_id: "skills-status".into(),
        payload: Some(json!({
            "workspaceDir": "private-workspace",
            "skills": [
                {"skillKey": "only-key", "eligible": true},
                {"skillKey": "not-selectable", "name": "Not selectable", "eligible": false},
                {"skillKey": "also-disabled", "name": "Also disabled", "eligible": true, "disabled": true},
                {"skillKey": "selectable", "name": " Selectable ", "eligible": true}
            ]
        })),
    })
    .unwrap();

    assert_eq!(catalog.names(), ["selectable"]);
    let debug = format!("{catalog:?}");
    assert!(!debug.contains("private-workspace"));
    assert!(!debug.contains("only-key"));
}

#[test]
fn skill_request_context_redacts_debug_and_rejects_invalid_identity() {
    let context = SkillRequestContext::new(Some(" agent-1 ".to_owned())).unwrap();
    let rendered = format!("{context:?}");
    assert!(rendered.contains("[REDACTED]"));
    assert!(!rendered.contains("agent-1"));
    assert!(SkillRequestContext::new(Some(" ".to_owned())).is_err());
}

#[test]
fn skill_update_request_preserves_openclaw_raw_skill_key() {
    let SkillUpdateRequest::Config {
        skill_key, enabled, ..
    } = SkillUpdateRequest::config(" Excel XLSX ".to_owned(), Some(false), None, None).unwrap()
    else {
        panic!("expected config request");
    };

    assert_eq!(skill_key, "Excel XLSX");
    assert_eq!(enabled, Some(false));
}

#[test]
fn skill_update_request_debug_redacts_secret_values() {
    let mut env = BTreeMap::new();
    env.insert("PRIVATE_TOKEN".to_owned(), "secret-env-value".to_owned());
    let request = SkillUpdateRequest::config(
        "safe-skill".to_owned(),
        Some(true),
        Some("secret-api-value".to_owned()),
        Some(env),
    )
    .unwrap();
    let rendered = format!("{request:?}");
    assert!(rendered.contains("[REDACTED]"));
    assert!(!rendered.contains("secret-api-value"));
    assert!(!rendered.contains("secret-env-value"));
    assert!(!rendered.contains("PRIVATE_TOKEN"));
}

#[tokio::test(flavor = "current_thread")]
async fn skill_operations_accept_2026_9_3_receipts_and_send_schema_params() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let identity = TestTlsIdentity::generate();
    let operations = OpenClawSkillOperations::for_agent(
        test_client(&listener, identity.fingerprint()),
        "agent-1".to_owned(),
    )
    .unwrap();
    let acceptor = identity.acceptor();
    let upload_sha = "a".repeat(64);
    let server_sha = upload_sha.clone();
    let server = tokio::spawn(async move {
        let mut socket = accept_websocket(&listener, &acceptor).await;
        serve_hello_with_methods(&mut socket, &SKILL_OPERATION_METHODS).await;

        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "skills.detail");
        assert_eq!(request["params"], json!({"slug": "safe-skill"}));
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": request["id"].as_str().unwrap(), "ok": true,
                "payload": {
                    "skill": {
                        "slug": "safe-skill",
                        "displayName": "Safe Skill",
                        "summary": "summary",
                        "tags": {"category": "productivity"},
                        "createdAt": 10,
                        "updatedAt": 20,
                        "source": "private-source",
                        "filePath": "C:/private/SKILL.md",
                        "config": {"apiKey": "secret-api-value"}
                    },
                    "latestVersion": {"version": "1.2.3", "createdAt": 11, "changelog": "changes", "path": "C:/private/version"},
                    "metadata": {"os": ["windows"], "systems": ["node"], "env": ["PRIVATE_TOKEN"]},
                    "owner": {"handle": "owner", "displayName": "Owner", "image": "https://example.invalid/avatar", "authorEmail": "private@example.invalid"},
                    "diagnostics": {"raw": "raw diagnostic"}
                }
            }),
        )
        .await;

        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "skills.install");
        assert_eq!(
            request["params"],
            json!({"source": "upload", "uploadId": "upload-1", "slug": "safe-skill", "agentId": "agent-1"})
        );
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": request["id"].as_str().unwrap(), "ok": true,
                "payload": {"ok": true, "message": "Installed", "stdout": "secret stdout", "stderr": "secret stderr", "details": {"env": "PRIVATE_TOKEN"}}
            }),
        )
        .await;

        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "skills.update");
        assert_eq!(
            request["params"],
            json!({"skillKey": "safe-skill", "enabled": true, "apiKey": "secret-api-value", "env": {"PRIVATE_TOKEN": "secret-env-value"}})
        );
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": request["id"].as_str().unwrap(), "ok": true,
                "payload": {"ok": true, "details": {"rawDiagnostics": "secret diagnostics"}, "version": "9.9.9"}
            }),
        )
        .await;

        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "skills.update");
        assert_eq!(
            request["params"],
            json!({"source": "clawhub", "slug": "safe-skill", "agentId": "agent-1"})
        );
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": request["id"].as_str().unwrap(), "ok": true,
                "payload": {"ok": true, "slug": "safe-skill", "version": "9.9.9"}
            }),
        )
        .await;

        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "config.get");
        assert_eq!(request["params"], json!({}));
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": request["id"].as_str().unwrap(), "ok": true,
                "payload": {
                    "path": "C:/private/openclaw.json",
                    "exists": true,
                    "raw": "{\"skills\":{\"entries\":{\"safe-skill\":{\"enabled\":true,\"apiKey\":\"secret-api-value\"},\"other\":{\"enabled\":true}}},\"models\":{}}",
                    "valid": true,
                    "sourceConfig": {"skills": {"entries": {"safe-skill": {"enabled": true, "apiKey": "secret-api-value"}, "other": {"enabled": true}}}, "models": {}},
                    "config": {"skills": {"entries": {"safe-skill": {"enabled": true, "apiKey": "[REDACTED]"}, "other": {"enabled": true}}}, "models": {}},
                    "hash": "base-hash-canary",
                    "issues": [],
                    "warnings": [],
                    "legacyIssues": []
                }
            }),
        )
        .await;

        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "config.patch");
        assert_eq!(request["params"]["baseHash"], "base-hash-canary");
        assert!(request["params"].get("agentId").is_none());
        assert!(request["params"].get("sessionKey").is_none());
        let raw = request["params"]["raw"].as_str().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(raw).unwrap(),
            json!({"skills": {"entries": {"safe-skill": null}}})
        );
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": request["id"].as_str().unwrap(), "ok": true,
                "payload": {"ok": true}
            }),
        )
        .await;

        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "skills.upload.begin");
        assert_eq!(
            request["params"],
            json!({"kind": "skill-archive", "slug": "safe-skill", "sizeBytes": 3, "sha256": server_sha})
        );
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": request["id"].as_str().unwrap(), "ok": true,
                "payload": {"uploadId": "upload-1", "receivedBytes": 0, "expiresAt": 100, "env": "PRIVATE_TOKEN"}
            }),
        )
        .await;

        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "skills.upload.chunk");
        assert_eq!(
            request["params"],
            json!({"uploadId": "upload-1", "offset": 0, "dataBase64": "YWJj"})
        );
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": request["id"].as_str().unwrap(), "ok": true,
                "payload": {"uploadId": "upload-1", "receivedBytes": 3, "expiresAt": 100, "diagnostics": "raw diagnostic"}
            }),
        )
        .await;

        let request = read_json(&mut socket).await;
        assert_eq!(request["method"], "skills.upload.commit");
        assert_eq!(
            request["params"],
            json!({"uploadId": "upload-1", "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"})
        );
        send_json(
            &mut socket,
            json!({
                "type": "res", "id": request["id"].as_str().unwrap(), "ok": true,
                "payload": {"uploadId": "upload-1", "receivedBytes": 3, "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "expiresAt": 100, "path": "C:/private/upload"}
            }),
        )
        .await;
        socket.close(None).await.unwrap();
    });

    let detail = operations
        .detail(SkillDetailRequest::try_new("safe-skill".to_owned()).unwrap())
        .await
        .unwrap();
    assert_eq!(detail.skill().unwrap().display_name(), "Safe Skill");
    let detail_debug = format!("{detail:?}");
    assert!(!detail_debug.contains("private-source"));
    assert!(!detail_debug.contains("secret-api-value"));
    assert_eq!(
        operations
            .install(
                SkillInstallRequest::upload(
                    "upload-1".to_owned(),
                    "safe-skill".to_owned(),
                    None,
                    None,
                )
                .unwrap()
            )
            .await,
        SkillMutationOutcome::Accepted
    );
    let mut env = BTreeMap::new();
    env.insert("PRIVATE_TOKEN".to_owned(), "secret-env-value".to_owned());
    assert_eq!(
        operations
            .update(
                SkillUpdateRequest::config(
                    "safe-skill".to_owned(),
                    Some(true),
                    Some("secret-api-value".to_owned()),
                    Some(env),
                )
                .unwrap()
            )
            .await,
        SkillMutationOutcome::Accepted
    );
    assert_eq!(
        operations
            .update(SkillUpdateRequest::clawhub(Some("safe-skill".to_owned()), false).unwrap())
            .await,
        SkillMutationOutcome::Accepted
    );
    assert_eq!(
        operations.remove_config("safe-skill".to_owned()).await,
        SkillConfigRemoveOutcome::Removed
    );
    assert_eq!(
        operations
            .upload_begin(
                SkillUploadBegin::try_new(
                    "safe-skill".to_owned(),
                    3,
                    Some(upload_sha),
                    None,
                    None,
                )
                .unwrap()
            )
            .await,
        SkillUploadOutcome::Progress {
            upload_id: "upload-1".to_owned(),
            received_bytes: 0,
            expires_at: 100,
        }
    );
    assert_eq!(
        operations
            .upload_chunk(
                SkillUploadChunk::try_new("upload-1".to_owned(), 0, b"abc".to_vec()).unwrap()
            )
            .await,
        SkillUploadOutcome::Progress {
            upload_id: "upload-1".to_owned(),
            received_bytes: 3,
            expires_at: 100,
        }
    );
    assert_eq!(
        operations
            .upload_commit(
                SkillUploadCommit::try_new(
                    "upload-1".to_owned(),
                    Some(
                        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                            .to_owned()
                    ),
                )
                .unwrap()
            )
            .await,
        SkillUploadOutcome::Commit {
            upload_id: "upload-1".to_owned(),
            received_bytes: 3,
            sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
            expires_at: 100,
        }
    );
    server.await.unwrap();
}

#[test]
fn detail_projection_preserves_nested_renderer_safe_fields() {
    let detail = super::operations::decode_detail(serde_json::json!({
        "skill": {
            "slug": "safe-skill",
            "displayName": "Safe Skill",
            "summary": "summary",
            "tags": {"category": "productivity"},
            "createdAt": 10,
            "updatedAt": 20
        },
        "latestVersion": {"version": "1.2.3", "createdAt": 11, "changelog": "changes"},
        "metadata": {"os": ["windows"], "systems": ["node"]},
        "owner": {"handle": "owner", "displayName": "Owner", "image": "https://example.invalid/avatar"}
    })).unwrap();
    let skill = detail.skill().unwrap();
    assert_eq!(skill.slug(), "safe-skill");
    assert_eq!(
        skill.tags().get("category").map(String::as_str),
        Some("productivity")
    );
    assert_eq!(skill.created_at(), 10);
    assert_eq!(skill.updated_at(), 20);
    let version = detail.latest_version().unwrap();
    assert_eq!(version.version(), "1.2.3");
    assert_eq!(version.created_at(), 11);
    assert_eq!(version.changelog(), Some("changes"));
    assert_eq!(
        detail.metadata().unwrap().os(),
        Some(["windows".to_owned()].as_slice())
    );
    assert_eq!(detail.owner().unwrap().handle(), Some("owner"));
}

#[test]
fn detail_slug_requests_reject_path_fragments() {
    for slug in [
        "skill/escape",
        "skill\\\\escape",
        "skill..escape",
        "/skill",
        "skill/",
    ] {
        assert!(SkillDetailRequest::try_new(slug.to_owned()).is_err());
    }
}

fn test_client(
    listener: &TcpListener,
    certificate_fingerprint: platform::listener_identity::CertificateFingerprint,
) -> Arc<GatewayClient> {
    Arc::new(GatewayClient::new(
        GatewayEndpoint::try_new(listener.local_addr().unwrap()).unwrap(),
        certificate_fingerprint,
        Arc::new(GatewaySecret::new("fake-gateway-token".into()).unwrap()),
        GatewayClientMetadata::try_new("1.2.3".into(), "windows".into()).unwrap(),
    ))
}

async fn serve_status_hello(socket: &mut TestSocket) {
    serve_hello_with_methods(socket, &SHARED_CONTROL_METHODS).await;
}

async fn serve_hello_with_methods(socket: &mut TestSocket, methods: &[&str]) {
    serve_hello_with_methods_and_version(socket, methods, wire::OPENCLAW_GATEWAY_VERSION).await;
}

async fn serve_hello_with_methods_and_version(
    socket: &mut TestSocket,
    methods: &[&str],
    version: &str,
) {
    send_json(
        socket,
        json!({
            "type": "event", "event": "connect.challenge",
            "payload": {"nonce": "fake-nonce", "ts": 42}
        }),
    )
    .await;
    let connect = read_json(socket).await;
    assert_eq!(connect["method"], "connect");
    assert_eq!(connect["params"]["scopes"], json!(SHARED_CONTROL_SCOPES));
    assert_eq!(connect["params"]["caps"], json!(SHARED_CONTROL_CAPS));
    let request_id = connect["id"].as_str().unwrap();
    send_json(
        socket,
        json!({
            "type": "res", "id": request_id, "ok": true,
            "payload": {
                "type": "hello-ok", "protocol": 4,
                "server": {"version": version, "connId": "fixture"},
                "features": {"methods": methods, "events": SHARED_CONTROL_EVENTS},
                "snapshot": {
                    "presence": [], "health": {"ok": true},
                    "stateVersion": {"presence": 1, "health": 1}, "uptimeMs": 1
                },
                "auth": {"role": "operator", "scopes": SHARED_CONTROL_SCOPES},
                "policy": {
                    "maxPayload": 26214400, "maxBufferedBytes": 52428800,
                    "tickIntervalMs": 15000
                }
            }
        }),
    )
    .await;
}

async fn read_json(socket: &mut TestSocket) -> Value {
    let Message::Text(text) = socket.next().await.unwrap().unwrap() else {
        panic!("expected text frame");
    };
    serde_json::from_str(text.as_str()).unwrap()
}

async fn send_json(socket: &mut TestSocket, value: Value) {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}
