use std::{collections::BTreeSet, fs, path::Path};

use serde_json::Value;
use serde_yaml::Value as YamlValue;

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
        let mut patch = YamlValue::Null;
        patch["name"] = name.into();
        if is_bing(definition) {
            // Pinned searx/settings.yml and the four bing*.py modules support the China host.
            patch["base_url"] = "https://cn.bing.com".into();
        }
        if let Some(engine) = configured {
            // disabled is a default selection, not inactive: explicit per-query engine choices still work.
            patch["disabled"] = (!engine.enabled).into();
            if engine.enabled && definition.get("inactive").and_then(Value::as_bool) == Some(true) {
                patch["inactive"] = false.into();
            }
            if let Some(timeout) = engine.timeout_seconds {
                patch["timeout"] = timeout.into();
            }
            if let Some(weight) = engine.weight {
                patch["weight"] = weight.into();
            }
            for (key, value) in &engine.options {
                patch[key] = value.as_str().ok_or(Error::InvalidConfig)?.into();
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
    let mut settings = YamlValue::Null;
    settings["use_default_settings"] = true.into();
    settings["general"]["debug"] = false.into();
    settings["general"]["enable_metrics"] = false.into();
    settings["search"]["formats"] = vec!["json"].into();
    settings["search"]["default_lang"] = config.language.clone().into();
    settings["search"]["safe_search"] = config.safe_search.into();
    settings["search"]["autocomplete"] = "".into();
    settings["server"]["bind_address"] = "127.0.0.1".into();
    settings["server"]["limiter"] = false.into();
    settings["server"]["public_instance"] = false.into();
    settings["server"]["secret_key"] = secret.into();
    settings["server"]["image_proxy"] = false.into();
    settings["valkey"]["url"] = false.into();
    settings["outgoing"]["request_timeout"] = config.request_timeout_seconds.into();
    settings["outgoing"]["max_request_timeout"] = config.request_timeout_seconds.into();
    settings["engines"] = engines.into();
    if let Some(proxy) = &config.proxy_url {
        settings["outgoing"]["proxies"]["all://"] = proxy.clone().into();
    }
    settings["general"]["instance_name"] = "Matcha Search".into();
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
