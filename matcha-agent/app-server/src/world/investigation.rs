use std::{collections::BTreeMap, fs::OpenOptions, io::Read, path::PathBuf};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::rpc;

const DOMAIN: &[u8] = b"matcha.world.investigation.matcha-agent.v1\n";

/// This verifies producer custody, not World authorization or model-supplied permissions.
pub(crate) fn verify_investigation(params: &Value) -> rpc::Result<()> {
    let Some(envelope) = params.get("worldInvestigation") else {
        return Ok(());
    };
    let producer = envelope.get("producer").ok_or_else(rejected)?;
    let runtime_instance = producer
        .get("runtimeInstance")
        .and_then(Value::as_str)
        .filter(|value| bounded(value))
        .ok_or_else(rejected)?;
    let signature = producer
        .get("mac")
        .and_then(Value::as_str)
        .ok_or_else(rejected)?;
    let signature_bytes = URL_SAFE_NO_PAD.decode(signature).map_err(|_| rejected())?;
    if signature_bytes.len() != 32 || URL_SAFE_NO_PAD.encode(&signature_bytes) != signature {
        return Err(rejected());
    }
    let material = projection()?;
    if material.runtime_instance != runtime_instance {
        return Err(rejected());
    }
    let encoded_key = Zeroizing::new(material.signing_key);
    let key = Zeroizing::new(URL_SAFE_NO_PAD.decode(encoded_key.as_bytes()).map_err(|_| rejected())?);
    if key.len() != 32 || URL_SAFE_NO_PAD.encode(&key) != *encoded_key {
        return Err(rejected());
    }
    let mut payload = params.clone();
    payload["worldInvestigation"]["producer"]
        .as_object_mut()
        .ok_or_else(rejected)?
        .remove("mac");
    let bytes = serde_json::to_vec(&canonical(payload)).map_err(|_| rejected())?;
    let mut mac = Hmac::<Sha256>::new_from_slice(&key).map_err(|_| rejected())?;
    mac.update(DOMAIN);
    mac.update(&bytes);
    mac.verify_slice(&signature_bytes).map_err(|_| rejected())?;
    let issued = envelope.get("issuedAtMs").and_then(Value::as_u64).ok_or_else(rejected)?;
    let expires = envelope.get("expiresAtMs").and_then(Value::as_u64).ok_or_else(rejected)?;
    let now = u64::try_from(chrono::Utc::now().timestamp_millis()).map_err(|_| rejected())?;
    if issued > now || expires <= now || expires <= issued {
        return Err(rejected());
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Projection {
    endpoint: String,
    runtime_instance: String,
    signing_key: String,
}

fn projection() -> rpc::Result<Projection> {
    let location = PathBuf::from(std::env::var_os("MATCHA_WORLD_PROJECTION").ok_or_else(rejected)?);
    if !location.is_absolute() {
        return Err(rejected());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(location).map_err(|_| rejected())?;
    let metadata = file.metadata().map_err(|_| rejected())?;
    if !metadata.is_file() || metadata.len() > 4096 {
        return Err(rejected());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(rejected());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(rejected());
        }
    }
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(4097).read_to_end(&mut bytes).map_err(|_| rejected())?;
    if bytes.len() > 4096 {
        return Err(rejected());
    }
    let material: Projection = serde_json::from_slice(&bytes).map_err(|_| rejected())?;
    let endpoint = reqwest::Url::parse(&material.endpoint).map_err(|_| rejected())?;
    if !bounded(&material.runtime_instance)
        || endpoint.scheme() != "http"
        || endpoint.host_str() != Some("127.0.0.1")
        || endpoint.port().is_none()
        || endpoint.path() != "/api/world/peer"
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
    {
        return Err(rejected());
    }
    Ok(material)
}

fn canonical(value: Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object.into_iter().map(|(key, value)| (key, canonical(value)))
                .collect::<BTreeMap<_, _>>().into_iter().collect(),
        ),
        Value::Array(values) => Value::Array(values.into_iter().map(canonical).collect()),
        value => value,
    }
}

fn bounded(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}

fn rejected() -> rpc::Error {
    rpc::Error::new(-32007, "world_investigation_rejected", "World investigation producer proof was rejected")
        .with_data(json!({"sentness":"notSent"}))
}
