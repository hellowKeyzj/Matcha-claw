use std::collections::BTreeSet;

use serde_json::{Value, json};

use super::canonical_provider_configuration;

const MEMBERSHIP_PATHS: [(&str, &str, &str); 3] = [
    (
        "/models/providers/custom/media/models/0/capabilities",
        "/providers/custom/media/models/0/capabilities",
        "tts",
    ),
    (
        "/agents/defaults/cliBackends/local/clearEnv",
        "/agentDefaults/cliBackends/local/clearEnv",
        "Z",
    ),
    ("/plugins/allow", "/mediaPluginAllow", "openai"),
];

#[test]
fn model_catalog_order_remains_significant_for_default_selection() {
    let provider_keys = BTreeSet::from(["custom".to_owned()]);
    let document = configuration();
    let expected = canonical_provider_configuration(&document, &provider_keys);
    for pointer in [
        "/models/providers/custom/models",
        "/models/providers/custom/media/models",
    ] {
        let mut reordered = document.clone();
        reordered
            .pointer_mut(pointer)
            .unwrap()
            .as_array_mut()
            .unwrap()
            .reverse();
        assert_ne!(
            canonical_provider_configuration(&reordered, &provider_keys),
            expected,
            "{pointer}"
        );
    }
}

#[test]
fn membership_arrays_ignore_order_but_retain_duplicate_members() {
    let provider_keys = BTreeSet::from(["custom".to_owned()]);
    let document = configuration();
    let expected = canonical_provider_configuration(&document, &provider_keys);
    for (source_pointer, view_pointer, duplicate) in MEMBERSHIP_PATHS {
        let mut reordered = document.clone();
        reordered
            .pointer_mut(source_pointer)
            .unwrap()
            .as_array_mut()
            .unwrap()
            .reverse();
        assert_ne!(
            reordered.pointer(source_pointer),
            document.pointer(source_pointer)
        );
        let actual = canonical_provider_configuration(&reordered, &provider_keys);
        assert_eq!(actual, expected, "{source_pointer}");
        let members = actual.pointer(view_pointer).unwrap().as_array().unwrap();
        assert_eq!(members.len(), 3, "{view_pointer}");
        assert_eq!(
            members
                .iter()
                .filter(|member| member.as_str() == Some(duplicate))
                .count(),
            2,
            "{view_pointer}: duplicate members must be retained"
        );
        reordered
            .pointer_mut(source_pointer)
            .unwrap()
            .as_array_mut()
            .unwrap()
            .pop();
        assert_ne!(
            canonical_provider_configuration(&reordered, &provider_keys),
            expected,
            "{source_pointer}: member removal must remain visible"
        );
    }
}

#[test]
fn malformed_membership_values_are_not_filtered_or_coerced() {
    let provider_keys = BTreeSet::from(["custom".to_owned()]);
    let document = configuration();
    for (source_pointer, view_pointer, _) in MEMBERSHIP_PATHS {
        for malformed in [
            json!(["z", null, "a", "z", {"unexpected": [2, 1]}]),
            json!({"unexpected": [2, 1]}),
            json!(true),
            Value::Null,
        ] {
            let mut observed = document.clone();
            *observed.pointer_mut(source_pointer).unwrap() = malformed.clone();
            let actual = canonical_provider_configuration(&observed, &provider_keys);
            assert_eq!(
                actual.pointer(view_pointer),
                Some(&malformed),
                "{source_pointer}"
            );
        }
    }
}

#[test]
fn missing_added_and_changed_models_remain_distinct() {
    let provider_keys = BTreeSet::from(["custom".to_owned()]);
    let document = configuration();
    let expected = canonical_provider_configuration(&document, &provider_keys);
    for (pointer, changed_field, changed_value, additional_model) in [
        (
            "/models/providers/custom/models",
            "maxTokens",
            json!(8192),
            json!({"id": "additional", "name": "Additional", "input": ["text"]}),
        ),
        (
            "/models/providers/custom/media/models",
            "timeoutMs",
            json!(2000),
            json!({"id": "additional", "capabilities": ["imageGenerate"]}),
        ),
    ] {
        let models = document.pointer(pointer).unwrap().as_array().unwrap();
        let mut missing = models.clone();
        missing.remove(0);
        let mut added = models.clone();
        added.push(additional_model);
        let mut changed = models.clone();
        changed[0][changed_field] = changed_value;
        for (change, replacement) in [("missing", missing), ("added", added), ("changed", changed)]
        {
            let mut observed = document.clone();
            *observed.pointer_mut(pointer).unwrap() = Value::Array(replacement);
            assert_ne!(
                canonical_provider_configuration(&observed, &provider_keys),
                expected,
                "{pointer}: {change}"
            );
        }
    }
}

#[test]
fn fallbacks_cli_arguments_and_unknown_arrays_remain_ordered() {
    let provider_keys = BTreeSet::from(["custom".to_owned()]);
    let document = configuration();
    let expected = canonical_provider_configuration(&document, &provider_keys);
    for pointer in [
        "/agents/defaults/model/fallbacks",
        "/agents/defaults/mediaModels/image/fallbacks",
        "/agents/defaults/cliBackends/local/args",
        "/agents/defaults/cliBackends/local/extension/clearEnv",
        "/models/providers/custom/models/0/input",
        "/models/providers/custom/localService/args",
        "/models/providers/custom/extension/input",
        "/models/providers/custom/media/extension/capabilities",
        "/models/providers/custom/media/extension/models",
    ] {
        let mut observed = document.clone();
        observed
            .pointer_mut(pointer)
            .unwrap()
            .as_array_mut()
            .unwrap()
            .reverse();
        assert_ne!(
            canonical_provider_configuration(&observed, &provider_keys),
            expected,
            "{pointer}"
        );
    }
}

#[test]
fn retained_unknown_fields_still_participate_in_comparison() {
    let provider_keys = BTreeSet::from(["custom".to_owned()]);
    let document = configuration();
    let expected = canonical_provider_configuration(&document, &provider_keys);
    for (source_pointer, view_pointer) in [
        (
            "/models/providers/custom/extension/mode",
            "/providers/custom/extension/mode",
        ),
        (
            "/models/providers/custom/media/extension/mode",
            "/providers/custom/media/extension/mode",
        ),
        (
            "/agents/defaults/cliBackends/local/extension/mode",
            "/agentDefaults/cliBackends/local/extension/mode",
        ),
    ] {
        assert_eq!(expected.pointer(view_pointer), Some(&json!("before")));
        let mut observed = document.clone();
        *observed.pointer_mut(source_pointer).unwrap() = json!("after");
        assert_ne!(
            canonical_provider_configuration(&observed, &provider_keys),
            expected,
            "{source_pointer}"
        );
    }
}

#[test]
fn duplicate_and_malformed_model_elements_are_retained() {
    let provider_keys = BTreeSet::from(["custom".to_owned()]);
    let models = json!([
        {"id": "same", "name": "First"},
        {"id": "same", "name": "Second"},
        {"id": "same", "name": "First"},
        {"name": "No identifier"},
        {"id": 7, "name": "Invalid identifier"},
        {}, null, "unexpected", 42, ["nested"]
    ]);
    let document = json!({"models": {"providers": {"custom": {
        "models": models,
        "media": {"api": "openai", "models": models}
    }}}});
    let compared = canonical_provider_configuration(&document, &provider_keys);
    for pointer in ["/providers/custom/models", "/providers/custom/media/models"] {
        assert_eq!(compared.pointer(pointer), Some(&models), "{pointer}");
    }
}

#[test]
fn comparison_leaves_input_unchanged_and_normalization_is_idempotent() {
    let provider_keys = BTreeSet::from(["custom".to_owned()]);
    let document = configuration();
    let original = document.clone();
    let compared = canonical_provider_configuration(&document, &provider_keys);
    assert_eq!(document, original);

    // The comparison view is not a native document; restore its selected paths.
    let mut normalized = document.clone();
    normalized["models"]["providers"] = compared["providers"].clone();
    normalized["agents"]["defaults"] = compared["agentDefaults"].clone();
    normalized["plugins"]["allow"] = compared["mediaPluginAllow"].clone();
    assert_eq!(
        canonical_provider_configuration(&normalized, &provider_keys),
        compared
    );
}

fn configuration() -> Value {
    json!({
        "models": {"providers": {"custom": {
            "models": [
                {"id": "zeta", "name": "Zeta", "input": ["text", "image", "image"], "maxTokens": 4096},
                {"id": "alpha", "name": "Alpha", "input": ["image"]}
            ],
            "media": {
                "api": "openai",
                "models": [
                    {"id": "zeta-image", "capabilities": ["tts", "tts", "imageGenerate"], "timeoutMs": 1000},
                    {"id": "alpha-image", "capabilities": ["imageGenerate"]}
                ],
                "extension": {"mode": "before", "capabilities": ["tts", "imageGenerate"], "models": [{"id": "z"}, {"id": "a"}]}
            },
            "extension": {"mode": "before", "input": ["z", "a"]},
            "localService": {"command": "model-server", "args": ["--port", "8080"]}
        }}},
        "agents": {"defaults": {
            "model": {"primary": "custom/zeta", "fallbacks": ["custom/alpha", "custom/beta"]},
            "mediaModels": {"image": {"primary": "custom/zeta-image", "fallbacks": ["custom/alpha-image", "custom/beta-image"]}},
            "cliBackends": {"local": {
                "command": "model-cli", "args": ["--model", "alpha"], "clearEnv": ["Z", "Z", "A"],
                "extension": {"mode": "before", "clearEnv": ["Z", "A"]}
            }}
        }},
        "plugins": {"allow": ["openai", "openai", "google"]}
    })
}
