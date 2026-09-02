use serde_json::{Value, json};

use super::*;

const SECRET_CANARY: &str = "synthetic-provider-projection-secret-canary";

fn provider(value: &str) -> ProviderKey {
    ProviderKey::try_new(value.into()).expect("valid provider key")
}

fn endpoint(value: &str) -> ProviderEndpoint {
    ProviderEndpoint::try_new(value.into()).expect("valid endpoint")
}

fn document(value: Value) -> OpenClawConfigDocument {
    OpenClawConfigDocument::from_value(value).expect("valid config")
}

#[test]
fn replaces_legacy_provider_entries_without_erasing_the_current_provider_fields() {
    let mut document = document(json!({
        "models": {
            "providers": {
                "openai": {
                    "baseUrl": "https://legacy.example.com/v1",
                    "api": "openai-completions",
                    "models": [{ "id": "gpt-5.6", "name": "GPT 5.6" }],
                    "customProviderField": true
                },
                "openai-codex": {
                    "models": [{ "id": "legacy", "name": "Legacy" }]
                }
            }
        }
    }));
    let projection = ProviderProjection::new(
        provider("openai"),
        endpoint("https://api.openai.com/v1"),
        ProviderProtocol::OpenAiResponses,
        None,
        [provider("openai-codex")],
    );

    assert!(projection.apply_to_document(&mut document));

    assert_eq!(
        document.get("models"),
        Some(&json!({
            "providers": {
                "openai": {
                    "baseUrl": "https://api.openai.com/v1",
                    "api": "openai-responses",
                    "models": [{ "id": "gpt-5.6", "name": "GPT 5.6" }],
                    "customProviderField": true,
                    "agentRuntime": { "id": "pi" }
                }
            }
        }))
    );
}

#[test]
fn pins_openai_provider_when_agent_runtime_id_is_empty() {
    let mut document = document(json!({
        "models": {
            "providers": {
                "openai": { "agentRuntime": { "id": "" } }
            }
        }
    }));
    let projection = ProviderProjection::new(
        provider("openai"),
        endpoint("https://api.openai.com/v1"),
        ProviderProtocol::OpenAiResponses,
        None,
        [],
    );

    assert!(projection.apply_to_document(&mut document));
    let value = document.as_value();

    assert_eq!(
        value.pointer("/models/providers/openai/agentRuntime"),
        Some(&json!({ "id": "pi" }))
    );
}

#[test]
fn pins_openai_provider_when_agent_runtime_object_is_empty() {
    let mut document = document(json!({
        "models": {
            "providers": {
                "openai": { "agentRuntime": {} }
            }
        }
    }));
    let projection = ProviderProjection::new(
        provider("openai"),
        endpoint("https://api.openai.com/v1"),
        ProviderProtocol::OpenAiChatGptResponses,
        None,
        [],
    );

    assert!(projection.apply_to_document(&mut document));
    let value = document.as_value();

    assert_eq!(
        value.pointer("/models/providers/openai/agentRuntime"),
        Some(&json!({ "id": "pi" }))
    );
    assert_eq!(
        value.pointer("/models/providers/openai/baseUrl"),
        Some(&json!(OPENAI_CODEX_OAUTH_BASE_URL))
    );
}

#[test]
fn preserves_user_supplied_openai_agent_runtime_id() {
    let mut document = document(json!({
        "models": {
            "providers": {
                "openai": { "agentRuntime": { "id": "custom-runtime" } }
            }
        }
    }));
    let projection = ProviderProjection::new(
        provider("openai"),
        endpoint("https://api.openai.com/v1"),
        ProviderProtocol::OpenAiChatGptResponses,
        None,
        [],
    );

    assert!(projection.apply_to_document(&mut document));
    let value = document.as_value();

    assert_eq!(
        value.pointer("/models/providers/openai/agentRuntime"),
        Some(&json!({ "id": "custom-runtime" }))
    );
}

#[test]
fn migrates_legacy_openai_codex_response_protocols() {
    let mut document = document(json!({
        "models": {
            "providers": {
                "openai-codex": {
                    "api": "openai-codex-responses",
                    "baseUrl": "https://api.openai.com/v1"
                },
                "custom": { "api": "openai-codex-responses" },
                "openai": { "api": "openai-responses", "agentRuntime": { "id": "pi" } }
            }
        }
    }));

    assert!(migrate_legacy_openai_codex_runtime(&mut document));
    assert_eq!(
        document.get("models"),
        Some(&json!({
            "providers": {
                "custom": { "api": "openai-chatgpt-responses" },
                "openai": {
                    "api": "openai-chatgpt-responses",
                    "baseUrl": OPENAI_CODEX_OAUTH_BASE_URL,
                    "agentRuntime": { "id": "pi" }
                }
            }
        }))
    );
    assert!(!migrate_legacy_openai_codex_runtime(&mut document));
}

#[test]
fn migrates_legacy_openai_codex_model_references() {
    let mut document = document(json!({
        "agents": {
            "defaults": {
                "model": {
                    "primary": "openai-codex/gpt-5.6",
                    "fallbacks": ["anthropic/claude", "openai-codex/gpt-4.1"]
                },
                "models": {
                    "openai-codex/gpt-5.6": { "alias": "old" },
                    "anthropic/claude": { "alias": "keep" }
                }
            },
            "list": [{
                "model": "openai-codex/gpt-5.6",
                "models": {
                    "openai-codex/gpt-5.6": { "agentRuntime": { "id": "pi" } }
                }
            }]
        }
    }));

    assert!(migrate_legacy_openai_codex_runtime(&mut document));
    assert_eq!(
        document.get("agents"),
        Some(&json!({
            "defaults": {
                "model": {
                    "primary": "openai/gpt-5.6",
                    "fallbacks": ["anthropic/claude", "openai/gpt-4.1"]
                },
                "models": {
                    "openai/gpt-5.6": { "alias": "old" },
                    "anthropic/claude": { "alias": "keep" }
                }
            },
            "list": [{
                "model": "openai/gpt-5.6",
                "models": {
                    "openai/gpt-5.6": { "agentRuntime": { "id": "pi" } }
                }
            }]
        }))
    );
}

#[test]
fn projects_moonshot_search_endpoint_without_an_inline_key() {
    let mut document = document(json!({
        "tools": {
            "web": {
                "search": {
                    "kimi": { "region": "legacy" }
                }
            }
        }
    }));
    let projection = ProviderProjection::new(
        provider("moonshot-global"),
        endpoint("https://api.moonshot.ai/v1"),
        ProviderProtocol::OpenAiCompletions,
        None,
        [],
    );

    assert!(projection.apply_to_document(&mut document));

    assert_eq!(
        document.get("tools"),
        Some(&json!({
            "web": {
                "search": {
                    "kimi": {
                        "baseUrl": "https://api.moonshot.ai/v1",
                        "region": "legacy"
                    }
                }
            }
        }))
    );
}

#[test]
fn rejects_secret_bearing_endpoint_without_exposure() {
    let secret_endpoint = format!("https://user:{SECRET_CANARY}@api.example.com/v1");
    let endpoint_error =
        ProviderEndpoint::try_new(secret_endpoint.clone()).expect_err("reject endpoint");

    assert_eq!(endpoint_error, ProviderProjectionError::InvalidEndpoint);
    assert!(!format!("{endpoint_error:?} {endpoint_error}").contains(SECRET_CANARY));
}

#[test]
fn debug_output_redacts_provider_projection_configuration() {
    let projection = ProviderProjection::new(
        provider("openrouter"),
        endpoint("https://openrouter.ai/api/v1"),
        ProviderProtocol::OpenAiResponses,
        None,
        [],
    );

    let rendered = format!("{projection:?}");

    assert_eq!(rendered, "ProviderProjection([REDACTED])");
    assert!(!rendered.contains("OPENROUTER_API_KEY"));
    assert!(!rendered.contains("matchaclaw.local"));
}
