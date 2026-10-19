use ::board::{BoardFailure, BoardIdentity};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use platform::endpoint::runtime_address::RuntimeEndpoint;
use serde::Deserialize;

use crate::session::protocol::{AgentId, AgentScopedSessionKey, EndpointSessionId};

pub(super) const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub(super) fn validate_identity(
    endpoint: &RuntimeEndpoint,
    identity: &BoardIdentity,
) -> Result<(), BoardFailure> {
    validate_endpoint(endpoint)?;
    if identity.endpoint() != endpoint {
        return Err(BoardFailure::Forbidden);
    }
    let key = AgentScopedSessionKey::try_parse(identity.session_key())
        .map_err(|_| BoardFailure::Invalid)?;
    if key.as_str() != identity.session_key()
        || key.agent_id() != identity.agent_id()
        || identity.session_key().encode_utf16().count() > 512
    {
        return Err(BoardFailure::Invalid);
    }
    Ok(())
}

pub(super) fn validate_endpoint(endpoint: &RuntimeEndpoint) -> Result<(), BoardFailure> {
    if endpoint != &runtime_directory::RuntimeDriverIdentity::open_claw().endpoint() {
        return Err(BoardFailure::Unsupported);
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TicketClaims {
    pub session_key: String,
    pub agent_id: String,
    pub name: String,
    pub revision: u64,
    pub view_generation: String,
    authority_generation: String,
    pub expires_at_ms: u64,
    nonce: String,
    pub plugin_frame: Option<PluginFrame>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PluginFrame {
    pub plugin_kind: String,
    pub scoped_host_url: String,
}

pub(super) fn ticket_claims(
    identity: &BoardIdentity,
    ticket: &str,
) -> Result<TicketClaims, BoardFailure> {
    if ticket.len() > 2_048 {
        return Err(BoardFailure::Invalid);
    }
    let mut parts = ticket.split('.');
    let (Some("v1"), Some(payload), Some(signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(BoardFailure::Invalid);
    };
    let signature = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| BoardFailure::Invalid)?;
    if signature.len() != 32 {
        return Err(BoardFailure::Invalid);
    }
    let payload = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| BoardFailure::Invalid)?;
    let claims: TicketClaims =
        serde_json::from_slice(&payload).map_err(|_| BoardFailure::Invalid)?;
    if claims.session_key.is_empty()
        || claims.session_key.encode_utf16().count() > 512
        || claims.agent_id.len() > 64
        || !is_widget_name(&claims.name)
        || claims.revision == 0
        || claims.revision > MAX_SAFE_INTEGER
        || !is_hex_generation(&claims.view_generation)
        || !is_random_generation(&claims.authority_generation)
        || !is_random_generation(&claims.nonce)
        || claims.expires_at_ms > MAX_SAFE_INTEGER
    {
        return Err(BoardFailure::Invalid);
    }
    if claims.agent_id != identity.agent_id()
        || observer_key(&claims.session_key, &claims.agent_id)? != identity.session_key()
    {
        return Err(BoardFailure::Forbidden);
    }
    // These unsigned claims can only reject a mismatched caller. The original ticket
    // still goes to the selected native Gateway for signature, lifetime and grant checks.
    Ok(claims)
}

pub(super) fn observer_key(session_key: &str, agent_id: &str) -> Result<String, BoardFailure> {
    let key = if matches!(session_key, "global" | "unknown") {
        AgentScopedSessionKey::try_new(
            AgentId::try_new(agent_id).map_err(|_| BoardFailure::Invalid)?,
            EndpointSessionId::try_new(session_key).map_err(|_| BoardFailure::Invalid)?,
        )
    } else {
        AgentScopedSessionKey::try_parse(session_key)
    }
    .map_err(|_| BoardFailure::Invalid)?;
    if key.agent_id() != agent_id {
        return Err(BoardFailure::Forbidden);
    }
    Ok(key.as_str().to_owned())
}

pub(super) fn is_widget_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && (name.as_bytes()[0].is_ascii_lowercase() || name.as_bytes()[0].is_ascii_digit())
        && name.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
        })
}

fn is_hex_generation(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_random_generation(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}
