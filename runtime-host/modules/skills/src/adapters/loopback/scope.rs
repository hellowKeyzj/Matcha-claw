use platform::{endpoint::runtime_address::{RuntimeEndpoint, RuntimeScope}, loopback::Request};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Binding {
    kind: String,
    endpoint: Endpoint,
    agent_id: Option<String>,
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
    if binding.endpoint.kind != "native-runtime" {
        return Err(());
    }
    let endpoint = RuntimeEndpoint::try_new(binding.endpoint.runtime_adapter_id, binding.endpoint.runtime_instance_id).map_err(|_| ())?;
    match (binding.kind.as_str(), binding.agent_id) {
        ("runtime-instance", None) if endpoint == runtime_directory::RuntimeDriverIdentity::open_claw().endpoint() => Ok(RuntimeScope::RuntimeInstance(endpoint)),
        ("agent", Some(agent)) if endpoint == runtime_directory::RuntimeDriverIdentity::matcha_agent().endpoint() => RuntimeScope::agent(endpoint, agent).map_err(|_| ()),
        _ => Err(()),
    }
}

pub(super) fn bind(request: &mut Request, handle: crate::SkillsModule) -> Result<crate::SkillsModule, ()> {
    let path = super::pathname(request.path());
    if path.starts_with(super::sealed_resource::READ_ENDPOINT_PREFIX) || matches!(path, super::clawhub_search::ENDPOINT | super::result::ENDPOINT | super::result::PRIVATE_ENDPOINT) {
        return Ok(handle);
    }
    let scope = if request.method() == "GET" {
        let mut scope = None;
        if let Some((_, query)) = request.path().split_once('?') {
            for pair in query.split('&') {
                if let Some(("scope", value)) = pair.split_once('=') {
                    if scope.is_some() {
                        return Err(());
                    }
                    scope = Some(serde_json::from_str(&percent_decode(value)?).map_err(|_| ())?);
                }
            }
        }
        scope
    } else {
        let mut value: Value = serde_json::from_slice(&request.body).map_err(|_| ())?;
        let scope = value.get("scope").cloned();
        if scope.is_some() && path != super::management::CAPABILITY_EXECUTE_ENDPOINT {
            value.as_object_mut().ok_or(())?.remove("scope");
            request.body = serde_json::to_vec(&value).map_err(|_| ())?;
        }
        scope
    };
    match scope {
        Some(scope) => Ok(handle.with_runtime_scope(decode(scope)?)),
        None => Ok(handle),
    }
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
