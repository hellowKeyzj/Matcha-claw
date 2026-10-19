use std::{collections::BTreeSet, fs, path::Path};

use serde_json::{Value, json};

use crate::{Error, ServiceConfig};

const MAX_SETTINGS_BYTES: u64 = 2 * 1024 * 1024;
const BING_MODULES: &[&str] = &["bing", "bing_images", "bing_news", "bing_videos"];

pub(crate) fn validate(resources: &Path, config: &ServiceConfig) -> Result<Vec<Value>, Error> {
    if config.language.is_empty()
        || config.language.len() > 64
        || config.language.chars().any(char::is_control)
        || config.safe_search > 2
        || !(1..=120).contains(&config.request_timeout_seconds)
    {
        return Err(Error::InvalidConfig);
    }
    if let Some(proxy) = &config.proxy_url {
        let url = reqwest::Url::parse(proxy).map_err(|_| Error::InvalidConfig)?;
        if !matches!(url.scheme(), "http" | "https" | "socks5" | "socks5h")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !matches!(url.path(), "" | "/")
        {
            return Err(Error::InvalidConfig);
        }
    }
    let path = resources.join("source/searx/settings.yml");
    if fs::metadata(&path)
        .map_err(|_| Error::ResourcesUnavailable)?
        .len()
        > MAX_SETTINGS_BYTES
    {
        return Err(Error::ResourcesUnavailable);
    }
    let settings: Value =
        serde_yaml::from_slice(&fs::read(path).map_err(|_| Error::ResourcesUnavailable)?)
            .map_err(|_| Error::ResourcesUnavailable)?;
    let engines = settings
        .get("engines")
        .and_then(Value::as_array)
        .ok_or(Error::ResourcesUnavailable)?;
    let mut names = BTreeSet::new();
    for engine in &config.engines {
        let Some(definition) = engines
            .iter()
            .find(|candidate| candidate.get("name").and_then(Value::as_str) == Some(&engine.name))
        else {
            return Err(Error::InvalidConfig);
        };
        if !names.insert(&engine.name)
            || engine
                .timeout_seconds
                .is_some_and(|timeout| !(1..=120).contains(&timeout))
            || engine
                .weight
                .is_some_and(|weight| !weight.is_finite() || weight <= 0.0 || weight > 100.0)
        {
            return Err(Error::InvalidConfig);
        }
        for (key, value) in &engine.options {
            // Only these pinned upstream engines expose this host override; no credentials or arbitrary YAML.
            if key != "base_url"
                || !is_bing(definition)
                || !matches!(
                    value.as_str(),
                    Some("https://cn.bing.com" | "https://www.bing.com")
                )
            {
                return Err(Error::InvalidConfig);
            }
        }
    }
    Ok(engines.clone())
}

pub(crate) fn settings(resources: &Path, config: &ServiceConfig) -> Result<Vec<u8>, Error> {
    let definitions = validate(resources, config)?;
    let mut engines = Vec::new();
    for definition in &definitions {
        let name = definition
            .get("name")
            .and_then(Value::as_str)
            .ok_or(Error::ResourcesUnavailable)?;
        let configured = config.engines.iter().find(|engine| engine.name == name);
        if configured.is_none() && !is_bing(definition) {
            continue;
        }
        let mut patch = json!({ "name": name });
        if is_bing(definition) {
            // Pinned searx/settings.yml and the four bing*.py modules support the China host.
            patch["base_url"] = json!("https://cn.bing.com");
        }
        if let Some(engine) = configured {
            // disabled is a default selection, not inactive: explicit per-query engine choices still work.
            patch["disabled"] = json!(!engine.enabled);
            if engine.enabled && definition.get("inactive").and_then(Value::as_bool) == Some(true) {
                patch["inactive"] = json!(false);
            }
            if let Some(timeout) = engine.timeout_seconds {
                patch["timeout"] = json!(timeout);
            }
            if let Some(weight) = engine.weight {
                patch["weight"] = json!(weight);
            }
            for (key, value) in &engine.options {
                patch[key] = value.clone();
            }
        }
        engines.push(patch);
    }
    let mut secret = [0u8; 32];
    getrandom::fill(&mut secret).map_err(|_| Error::StateUnavailable)?;
    let secret = secret
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let mut settings = json!({
        "use_default_settings": true,
        "general": { "debug": false, "enable_metrics": false },
        "search": { "formats": ["json"], "default_lang": config.language, "safe_search": config.safe_search, "autocomplete": "" },
        "server": { "bind_address": "127.0.0.1", "limiter": false, "public_instance": false, "secret_key": secret, "image_proxy": false },
        "valkey": { "url": false },
        "outgoing": { "request_timeout": config.request_timeout_seconds, "max_request_timeout": config.request_timeout_seconds },
        "engines": engines
    });
    if let Some(proxy) = &config.proxy_url {
        settings["outgoing"]["proxies"] = json!({ "all://": proxy });
    }
    settings["general"]["instance_name"] = json!("Matcha Search");
    serde_yaml::to_string(&settings)
        .map(String::into_bytes)
        .map_err(|_| Error::InvalidConfig)
}

fn is_bing(engine: &Value) -> bool {
    engine
        .get("engine")
        .and_then(Value::as_str)
        .is_some_and(|module| BING_MODULES.contains(&module))
}
