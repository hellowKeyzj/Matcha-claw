use platform::endpoint::runtime_address::{RuntimeEndpoint, RuntimeScope};
use serde::Deserialize;
use serde_json::Value;

pub(crate) fn openclaw() -> RuntimeScope {
    RuntimeScope::RuntimeInstance(runtime_directory::RuntimeDriverIdentity::open_claw().endpoint())
}

pub(crate) fn is_openclaw(scope: &RuntimeScope) -> bool {
    scope == &openclaw()
}

pub(crate) fn agent(scope: &RuntimeScope) -> Option<&str> {
    match scope {
        RuntimeScope::Agent { endpoint, agent_id }
            if endpoint == &runtime_directory::RuntimeDriverIdentity::matcha_agent().endpoint() => Some(agent_id),
        _ => None,
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum Binding {
    RuntimeInstance { endpoint: Endpoint },
    Agent { endpoint: Endpoint, #[serde(rename = "agentId")] agent_id: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Endpoint {
    kind: String,
    runtime_adapter_id: String,
    runtime_instance_id: String,
}

pub(crate) fn decode(value: Value) -> Result<RuntimeScope, ()> {
    let binding: Binding = serde_json::from_value(value).map_err(|_| ())?;
    let (endpoint, agent_id) = match binding {
        Binding::RuntimeInstance { endpoint } => (endpoint, None),
        Binding::Agent { endpoint, agent_id } => (endpoint, Some(agent_id)),
    };
    if endpoint.kind != "native-runtime" { return Err(()); }
    let endpoint = RuntimeEndpoint::try_new(endpoint.runtime_adapter_id, endpoint.runtime_instance_id).map_err(|_| ())?;
    match agent_id {
        None if endpoint == runtime_directory::RuntimeDriverIdentity::open_claw().endpoint() => Ok(RuntimeScope::RuntimeInstance(endpoint)),
        Some(agent) if endpoint == runtime_directory::RuntimeDriverIdentity::matcha_agent().endpoint() => RuntimeScope::agent(endpoint, agent).map_err(|_| ()),
        _ => Err(()),
    }
}

pub(crate) fn deserialize_optional<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<RuntimeScope>, D::Error> {
    decode(Value::deserialize(deserializer)?).map(Some)
        .map_err(|_| serde::de::Error::custom("Invalid plugin scope"))
}

pub(crate) fn query(path: &str) -> Result<Option<RuntimeScope>, ()> {
    let mut scope = None;
    if let Some((_, query)) = path.split_once('?') {
        for pair in query.split('&') {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            if percent_decode(key)? != "scope" { continue; }
            if scope.is_some() { return Err(()); }
            scope = Some(decode(serde_json::from_str(&percent_decode(value)?).map_err(|_| ())?)?);
        }
    }
    Ok(scope)
}

fn percent_decode(value: &str) -> Result<String, ()> {
    let mut bytes = Vec::with_capacity(value.len());
    let mut input = value.bytes();
    while let Some(byte) = input.next() {
        bytes.push(match byte {
            b'%' => {
                let high = char::from(input.next().ok_or(())?).to_digit(16).ok_or(())?;
                let low = char::from(input.next().ok_or(())?).to_digit(16).ok_or(())?;
                (high * 16 + low) as u8
            }
            b'+' => b' ',
            byte => byte,
        });
    }
    String::from_utf8(bytes).map_err(|_| ())
}
