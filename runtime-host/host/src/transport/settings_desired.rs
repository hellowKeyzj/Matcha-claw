use serde_json::Value;

use crate::transport::authorization::CapabilityDecisionVerifier;

pub(crate) mod server;

pub(crate) const ENDPOINT: &str = "/api/settings/desired";
pub(crate) const READ_ENDPOINT: &str = "/api/settings/current";
const SCOPE: &str = "settings:write";
const CAPABILITY: &str = "settings.replace";
const SUBJECT: &str = "settings-desired";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

pub(crate) fn decode(
    value: Value,
    authorization: &str,
    verifier: &mut CapabilityDecisionVerifier,
    now: u64,
) -> Result<(Value, String), DecodeError> {
    let decision = verifier
        .verify(authorization, now, ENDPOINT, SCOPE, CAPABILITY, SUBJECT)
        .map_err(|_| DecodeError::Unauthorized)?;
    valid(&value)
        .then_some((value, decision.correlation().to_owned()))
        .ok_or(DecodeError::Invalid)
}

fn valid(value: &Value) -> bool {
    let Some(body) = value.as_object() else {
        return false;
    };
    if body.len() != 5
        || body.get("id") != Some(&Value::String("settings.desired".into()))
        || body.get("operationId") != Some(&Value::String(CAPABILITY.into()))
    {
        return false;
    }
    let valid_scope = body
        .get("scope")
        .and_then(Value::as_object)
        .is_some_and(|scope| {
            scope.len() == 1 && scope.get("kind") == Some(&Value::String("settings-desired".into()))
        });
    let valid_target = body
        .get("target")
        .and_then(Value::as_object)
        .is_some_and(|target| {
            target.len() == 1 && target.get("kind") == Some(&Value::String("settings".into()))
        });
    let Some(input) = body.get("input").and_then(Value::as_object) else {
        return false;
    };
    let Some(proxy) = input.get("proxy").and_then(Value::as_object) else {
        return false;
    };
    valid_scope
        && valid_target
        && input.len() == 4
        && matches!(
            input.get("browserMode").and_then(Value::as_str),
            Some("native" | "relay" | "off")
        )
        && input.get("launchAtStartup").is_some_and(Value::is_boolean)
        && input.get("gatewayAutoStart").is_some_and(Value::is_boolean)
        && proxy.len() == 4
        && proxy.get("enabled").is_some_and(Value::is_boolean)
        && safe_text(proxy.get("server"), 2048)
        && safe_text(proxy.get("bypassRules"), 4096)
        && proxy.get("credentialReference") == Some(&Value::Null)
        && proxy
            .get("server")
            .and_then(Value::as_str)
            .is_none_or(|server| !server.contains('@'))
}

fn safe_text(value: Option<&Value>, maximum: usize) -> bool {
    value.and_then(Value::as_str).is_some_and(|text| {
        text.len() <= maximum && !text.contains('\0') && !text.contains(['\r', '\n'])
    })
}
