use std::fmt;

use serde_json::{Map, Value};
use zeroize::Zeroizing;

use crate::gateway::config_patch::{
    encode_request as encode_config_patch_request, request_parts_are_valid,
};

use super::{GatewayResponse, RpcRequest, WireError, rpc_request, valid_string};

pub(crate) const CHANNELS_STATUS_METHOD: &str = "channels.status";
pub(crate) const CHANNELS_START_METHOD: &str = "channels.start";
pub(crate) const CHANNELS_STOP_METHOD: &str = "channels.stop";
pub(crate) const CHANNELS_LOGOUT_METHOD: &str = "channels.logout";
pub(crate) const WEB_LOGIN_START_METHOD: &str = "web.login.start";
pub(crate) const WEB_LOGIN_WAIT_METHOD: &str = "web.login.wait";
pub(crate) const QR_DATA_URL_PREFIX: &str = "data:image/png;base64,";
pub(crate) const MAX_QR_DATA_URL_LENGTH: usize = 16_384;
pub(crate) const CONFIG_GET_METHOD: &str = "config.get";
pub(crate) const CONFIG_SCHEMA_LOOKUP_METHOD: &str = "config.schema.lookup";
const MAX_SCHEMA_FIELDS: usize = 64;
const MAX_SCHEMA_OPTIONS: usize = 64;

pub(crate) fn channels_status_request(request_id: String) -> Result<RpcRequest, WireError> {
    rpc_request(
        request_id,
        CHANNELS_STATUS_METHOD,
        Some(Value::Object(Map::new())),
    )
}

pub(crate) fn channel_runtime_request(
    request_id: String,
    action: crate::surfaces::channels::gateway::login::ChannelRuntimeAction,
    channel: &str,
    account: Option<&str>,
) -> Result<RpcRequest, WireError> {
    let mut params = Map::from_iter([(String::from("channel"), Value::String(channel.into()))]);
    if let Some(account) = account {
        params.insert(String::from("accountId"), Value::String(account.into()));
    }
    rpc_request(request_id, action.method(), Some(Value::Object(params)))
}

pub(crate) fn web_login_start_request(
    request_id: String,
    channel: &str,
    force: bool,
    timeout_ms: Option<u64>,
    verbose: bool,
    account_id: Option<&str>,
) -> Result<RpcRequest, WireError> {
    let mut params = Map::from_iter([
        (String::from("channel"), Value::String(channel.into())),
        (String::from("force"), Value::Bool(force)),
        (String::from("verbose"), Value::Bool(verbose)),
    ]);
    if let Some(timeout_ms) = timeout_ms {
        params.insert(String::from("timeoutMs"), Value::from(timeout_ms));
    }
    if let Some(account_id) = account_id {
        params.insert(String::from("accountId"), Value::String(account_id.into()));
    }
    rpc_request(
        request_id,
        WEB_LOGIN_START_METHOD,
        Some(Value::Object(params)),
    )
}

pub(crate) fn web_login_wait_request(
    request_id: String,
    channel: &str,
    timeout_ms: Option<u64>,
    account_id: Option<&str>,
    session_key: Option<&str>,
    current_qr_data_url: Option<&str>,
) -> Result<RpcRequest, WireError> {
    let mut params = Map::from_iter([(String::from("channel"), Value::String(channel.into()))]);
    if let Some(timeout_ms) = timeout_ms {
        params.insert(String::from("timeoutMs"), Value::from(timeout_ms));
    }
    if let Some(account_id) = account_id {
        params.insert(String::from("accountId"), Value::String(account_id.into()));
    }
    if let Some(session_key) = session_key {
        params.insert(
            String::from("sessionKey"),
            Value::String(session_key.into()),
        );
    }
    if let Some(current_qr_data_url) = current_qr_data_url {
        params.insert(
            String::from("currentQrDataUrl"),
            Value::String(current_qr_data_url.into()),
        );
    }
    rpc_request(
        request_id,
        WEB_LOGIN_WAIT_METHOD,
        Some(Value::Object(params)),
    )
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct NativeLoginProgress {
    pub(crate) status: crate::surfaces::channels::gateway::login::LoginProgressStatus,
    pub(crate) account_id: Option<String>,
    pub(crate) session_key: Option<String>,
    pub(crate) qr_data_url: Option<String>,
}

pub(crate) fn decode_channel_runtime_confirmation(
    response: GatewayResponse,
    action: crate::surfaces::channels::gateway::login::ChannelRuntimeAction,
    expected_channel: &str,
) -> Result<(String, Option<String>), WireError> {
    let GatewayResponse::Success {
        payload: Some(Value::Object(payload)),
        ..
    } = response
    else {
        return Err(WireError::InvalidChannelRuntime);
    };
    if payload.get("channel").and_then(Value::as_str) != Some(expected_channel) {
        return Err(WireError::InvalidChannelRuntime);
    }
    let account = payload
        .get("accountId")
        .and_then(Value::as_str)
        .filter(|value| valid_string(value))
        .map(str::to_owned)
        .ok_or(WireError::InvalidChannelRuntime)?;
    match action {
        crate::surfaces::channels::gateway::login::ChannelRuntimeAction::Start
        | crate::surfaces::channels::gateway::login::ChannelRuntimeAction::Stop => {
            let expected_field = match action {
                crate::surfaces::channels::gateway::login::ChannelRuntimeAction::Start => "started",
                crate::surfaces::channels::gateway::login::ChannelRuntimeAction::Stop => "stopped",
                crate::surfaces::channels::gateway::login::ChannelRuntimeAction::Logout => {
                    unreachable!()
                }
            };
            if payload.get(expected_field).and_then(Value::as_bool) != Some(true) {
                return Err(WireError::InvalidChannelRuntime);
            }
        }
        crate::surfaces::channels::gateway::login::ChannelRuntimeAction::Logout => {
            if payload.get("cleared").and_then(Value::as_bool) != Some(true) {
                return Err(WireError::InvalidChannelRuntime);
            }
        }
    }
    Ok((expected_channel.to_owned(), Some(account)))
}

pub(crate) fn decode_login_progress(
    response: GatewayResponse,
    account_id: Option<&str>,
) -> Result<NativeLoginProgress, WireError> {
    let GatewayResponse::Success {
        payload: Some(Value::Object(payload)),
        ..
    } = response
    else {
        return Err(WireError::InvalidLoginProgress);
    };
    let connected = payload.get("connected").and_then(Value::as_bool);
    let qr_data_url = optional_valid_qr(&payload, "qrDataUrl")?;
    let status = match connected {
        Some(true) => crate::surfaces::channels::gateway::login::LoginProgressStatus::Connected,
        Some(false) if qr_data_url.is_some() => {
            crate::surfaces::channels::gateway::login::LoginProgressStatus::Qr
        }
        Some(false) => crate::surfaces::channels::gateway::login::LoginProgressStatus::Pending,
        None if qr_data_url.is_some() => {
            crate::surfaces::channels::gateway::login::LoginProgressStatus::Qr
        }
        None => crate::surfaces::channels::gateway::login::LoginProgressStatus::Unknown,
    };
    let account_id = payload
        .get("accountId")
        .and_then(Value::as_str)
        .filter(|value| valid_string(value))
        .map(str::to_owned)
        .or_else(|| account_id.map(str::to_owned));
    let session_key = payload
        .get("sessionKey")
        .and_then(Value::as_str)
        .filter(|value| valid_string(value))
        .map(str::to_owned);
    Ok(NativeLoginProgress {
        status,
        account_id,
        session_key,
        qr_data_url,
    })
}

fn optional_valid_string(
    payload: &Map<String, Value>,
    field: &str,
) -> Result<Option<String>, WireError> {
    match payload.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if valid_string(value) => Ok(Some(value.to_owned())),
        _ => Err(WireError::InvalidLoginProgress),
    }
}

fn optional_valid_qr(
    payload: &Map<String, Value>,
    field: &str,
) -> Result<Option<String>, WireError> {
    let Some(value) = optional_valid_string(payload, field)? else {
        return Ok(None);
    };
    if value.starts_with(QR_DATA_URL_PREFIX) {
        return if value.len() <= MAX_QR_DATA_URL_LENGTH {
            Ok(Some(value))
        } else {
            Err(WireError::InvalidLoginProgress)
        };
    }
    Err(WireError::InvalidLoginProgress)
}

pub(crate) fn config_schema_lookup_request(
    request_id: String,
    channel: &str,
) -> Result<RpcRequest, WireError> {
    if !valid_schema_identifier(channel) {
        return Err(WireError::InvalidChannelConfigSchema);
    }
    rpc_request(
        request_id,
        CONFIG_SCHEMA_LOOKUP_METHOD,
        Some(serde_json::json!({ "path": format!("channels.{channel}") })),
    )
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ChannelFormField {
    pub(crate) key: String,
    pub(crate) label: String,
    pub(crate) description: Option<String>,
    pub(crate) kind: ChannelFormFieldKind,
    pub(crate) required: bool,
    pub(crate) options: Option<Vec<String>>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ChannelFormFieldKind {
    Text,
    Password,
    Boolean,
    Number,
    Select,
}

pub(crate) fn decode_channel_form(
    response: GatewayResponse,
    channel: &str,
) -> Result<Vec<ChannelFormField>, WireError> {
    let GatewayResponse::Success {
        payload: Some(Value::Object(payload)),
        ..
    } = response
    else {
        return Err(WireError::InvalidChannelConfigSchema);
    };
    if !valid_schema_identifier(channel)
        || payload.get("path").and_then(Value::as_str)
            != Some(format!("channels.{channel}").as_str())
    {
        return Err(WireError::InvalidChannelConfigSchema);
    }
    let schema = payload
        .get("schema")
        .and_then(Value::as_object)
        .ok_or(WireError::InvalidChannelConfigSchema)?;
    let properties = schema
        .get("properties")
        .and_then(Value::as_object)
        .ok_or(WireError::InvalidChannelConfigSchema)?;
    let required = schema
        .get("required")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let children = payload
        .get("children")
        .and_then(Value::as_array)
        .ok_or(WireError::InvalidChannelConfigSchema)?;
    if children.is_empty() || children.len() > MAX_SCHEMA_FIELDS {
        return Err(WireError::InvalidChannelConfigSchema);
    }
    let mut fields = Vec::with_capacity(children.len());
    for child in children {
        let child = child
            .as_object()
            .ok_or(WireError::InvalidChannelConfigSchema)?;
        let key = child
            .get("key")
            .and_then(Value::as_str)
            .filter(|value| valid_schema_identifier(value))
            .ok_or(WireError::InvalidChannelConfigSchema)?;
        if child.get("hasChildren").and_then(Value::as_bool) != Some(false) {
            return Err(WireError::InvalidChannelConfigSchema);
        }
        let property = properties
            .get(key)
            .and_then(Value::as_object)
            .ok_or(WireError::InvalidChannelConfigSchema)?;
        if property.get("readOnly").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let sensitive = property.get("writeOnly").and_then(Value::as_bool) == Some(true)
            || child
                .get("hint")
                .and_then(Value::as_object)
                .and_then(|hint| hint.get("sensitive"))
                .and_then(Value::as_bool)
                == Some(true);
        let kind = if property.get("enum").is_some() || property.get("const").is_some() {
            ChannelFormFieldKind::Select
        } else {
            match property.get("type").and_then(Value::as_str) {
                Some("string") if sensitive => ChannelFormFieldKind::Password,
                Some("string") => ChannelFormFieldKind::Text,
                Some("boolean") => ChannelFormFieldKind::Boolean,
                Some("number") | Some("integer") => ChannelFormFieldKind::Number,
                _ => return Err(WireError::InvalidChannelConfigSchema),
            }
        };
        let hint = child.get("hint").and_then(Value::as_object);
        let label = hint
            .and_then(|hint| hint.get("label"))
            .and_then(Value::as_str)
            .filter(|value| valid_string(value))
            .or_else(|| {
                property
                    .get("title")
                    .and_then(Value::as_str)
                    .filter(|value| valid_string(value))
            })
            .unwrap_or(key)
            .to_owned();
        let description = hint
            .and_then(|hint| hint.get("help"))
            .and_then(Value::as_str)
            .filter(|value| valid_string(value))
            .or_else(|| {
                property
                    .get("description")
                    .and_then(Value::as_str)
                    .filter(|value| valid_string(value))
            })
            .map(str::to_owned);
        let options = form_options(property)?;
        fields.push(ChannelFormField {
            key: key.to_owned(),
            label,
            description,
            kind,
            required: required.iter().any(|field| field.as_str() == Some(key)),
            options,
        });
    }
    if fields.is_empty() || fields.len() > MAX_SCHEMA_FIELDS {
        return Err(WireError::InvalidChannelConfigSchema);
    }
    Ok(fields)
}

fn form_options(property: &Map<String, Value>) -> Result<Option<Vec<String>>, WireError> {
    let Some(values) = property.get("enum").or_else(|| property.get("const")) else {
        return Ok(None);
    };
    let values = values
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(std::slice::from_ref(values));
    if values.is_empty() {
        return Err(WireError::InvalidChannelConfigSchema);
    }
    if values.len() > MAX_SCHEMA_OPTIONS {
        return Err(WireError::InvalidChannelConfigSchema);
    }
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|value| valid_string(value))
                .map(str::to_owned)
                .ok_or(WireError::InvalidChannelConfigSchema)
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

fn valid_schema_identifier(value: &str) -> bool {
    valid_string(value)
        && value.len() <= 128
        && !value.contains("__proto__")
        && !value.contains("prototype")
        && !value.contains("constructor")
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
        })
}

pub(crate) fn config_get_request(request_id: String) -> Result<RpcRequest, WireError> {
    rpc_request(
        request_id,
        CONFIG_GET_METHOD,
        Some(Value::Object(Map::new())),
    )
}

pub(crate) struct ChannelConfigPatchRequest {
    request_id: String,
    raw: Zeroizing<Vec<u8>>,
    base_hash: Zeroizing<Vec<u8>>,
    replace_paths: Vec<String>,
}

impl ChannelConfigPatchRequest {
    pub(crate) fn request_id(&self) -> &str {
        &self.request_id
    }

    pub(crate) fn encode(&self) -> Result<String, WireError> {
        encode_config_patch_request(
            &self.request_id,
            std::str::from_utf8(&self.raw).map_err(|_| WireError::EncodeRequest)?,
            Some(std::str::from_utf8(&self.base_hash).map_err(|_| WireError::EncodeRequest)?),
            &self.replace_paths,
        )
        .map_err(|_| WireError::EncodeRequest)
    }
}

impl fmt::Debug for ChannelConfigPatchRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ChannelConfigPatchRequest")
            .field("replace_paths", &self.replace_paths.len())
            .finish()
    }
}

pub(crate) struct ChannelConfigSnapshot {
    pub(crate) source_document: Zeroizing<Vec<u8>>,
    pub(crate) document: Zeroizing<Vec<u8>>,
    pub(crate) base_hash: Option<Zeroizing<Vec<u8>>>,
}

pub(crate) fn decode_config_snapshot(
    response: GatewayResponse,
) -> Result<ChannelConfigSnapshot, WireError> {
    let payload = match response {
        GatewayResponse::Success {
            payload: Some(Value::Object(payload)),
            ..
        } => payload,
        _ => return Err(WireError::InvalidChannelConfigPatch),
    };
    let hash = match payload.get("hash") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if valid_string(value) => Some(value.as_bytes().to_vec()),
        _ => return Err(WireError::InvalidChannelConfigPatch),
    };
    let raw = match payload.get("raw") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if valid_string(value) => Some(value),
        _ => return Err(WireError::InvalidChannelConfigPatch),
    };
    let fallback = || {
        let document =
            serde_json::from_str::<Value>(raw.ok_or(WireError::InvalidChannelConfigPatch)?)
                .map_err(|_| WireError::InvalidChannelConfigPatch)?;
        if document.is_object() {
            Ok(document)
        } else {
            Err(WireError::InvalidChannelConfigPatch)
        }
    };
    let source_document = match payload.get("sourceConfig") {
        Some(document) if document.is_object() => document.clone(),
        Some(_) => return Err(WireError::InvalidChannelConfigPatch),
        None => fallback()?,
    };
    let document = match payload.get("config") {
        Some(document) if document.is_object() => document.clone(),
        Some(_) => return Err(WireError::InvalidChannelConfigPatch),
        None => fallback()?,
    };
    Ok(ChannelConfigSnapshot {
        source_document: Zeroizing::new(
            serde_json::to_vec(&source_document)
                .map_err(|_| WireError::InvalidChannelConfigPatch)?,
        ),
        document: Zeroizing::new(
            serde_json::to_vec(&document).map_err(|_| WireError::InvalidChannelConfigPatch)?,
        ),
        base_hash: hash.map(Zeroizing::new),
    })
}

pub(crate) fn decode_config_document(
    response: GatewayResponse,
) -> Result<Zeroizing<Vec<u8>>, WireError> {
    let payload = match response {
        GatewayResponse::Success {
            payload: Some(Value::Object(payload)),
            ..
        } => payload,
        _ => return Err(WireError::InvalidChannelConfigPatch),
    };
    let document = payload
        .get("config")
        .filter(|value| value.is_object())
        .ok_or(WireError::InvalidChannelConfigPatch)?;
    Ok(Zeroizing::new(
        serde_json::to_vec(document).map_err(|_| WireError::InvalidChannelConfigPatch)?,
    ))
}

pub(crate) fn config_patch_request(
    request_id: String,
    raw: Zeroizing<Vec<u8>>,
    base_hash: Zeroizing<Vec<u8>>,
    replace_paths: Vec<String>,
) -> Result<ChannelConfigPatchRequest, WireError> {
    if !request_parts_are_valid(
        &request_id,
        raw.as_slice(),
        Some(base_hash.as_slice()),
        &replace_paths,
    ) {
        return Err(WireError::InvalidChannelConfigPatch);
    }
    Ok(ChannelConfigPatchRequest {
        request_id,
        raw,
        base_hash,
        replace_paths,
    })
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ChannelMeta {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) detail_label: String,
    pub(crate) system_image: Option<String>,
    pub(crate) configured: bool,
}

pub(crate) fn decode_channel_catalog(
    response: GatewayResponse,
) -> Result<Vec<ChannelMeta>, WireError> {
    let payload = match response {
        GatewayResponse::Success {
            payload: Some(Value::Object(payload)),
            ..
        } => payload,
        GatewayResponse::Failure { .. } | GatewayResponse::Success { .. } => {
            return Err(WireError::InvalidChannelCatalog);
        }
    };
    let metas = payload
        .get("channelMeta")
        .and_then(Value::as_array)
        .ok_or(WireError::InvalidChannelCatalog)?;
    let channels = match payload.get("channels") {
        None | Some(Value::Null) => None,
        Some(Value::Object(channels)) => Some(channels),
        Some(_) => return Err(WireError::InvalidChannelCatalog),
    };

    let mut seen = std::collections::BTreeSet::new();
    metas
        .iter()
        .map(|meta| {
            let meta = meta.as_object().ok_or(WireError::InvalidChannelCatalog)?;
            let id = required_string(meta, "id")?;
            let label = required_string(meta, "label")?;
            let detail_label = required_string(meta, "detailLabel")?;
            let system_image = match meta.get("systemImage") {
                None => None,
                Some(Value::String(value)) if valid_string(value) => Some(value.clone()),
                _ => return Err(WireError::InvalidChannelCatalog),
            };
            if !seen.insert(id.clone()) {
                return Err(WireError::InvalidChannelCatalog);
            }
            let configured = match channels.and_then(|channels| channels.get(&id)) {
                None | Some(Value::Null) => false,
                Some(Value::Object(summary)) => match summary.get("configured") {
                    None | Some(Value::Null) => false,
                    Some(value) => value.as_bool().ok_or(WireError::InvalidChannelCatalog)?,
                },
                Some(_) => return Err(WireError::InvalidChannelCatalog),
            };
            Ok(ChannelMeta {
                id,
                label,
                detail_label,
                system_image,
                configured,
            })
        })
        .collect()
}

pub(crate) fn is_config_conflict(error: &super::GatewayError) -> bool {
    // OpenClaw reports config conflicts as INVALID_REQUEST, not a dedicated conflict code.
    error.code == "INVALID_REQUEST"
        && error.message == "config changed since last load; re-run config.get and retry"
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ConfigPatchOutcome {
    Written,
    Noop,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ChannelConfigPatchOutcome {
    Written,
    Noop,
    RestartRequired,
}

pub(crate) fn is_config_restart_required(error: &super::GatewayError) -> bool {
    error.code == "UNAVAILABLE"
        && (error.message.contains("restart-pending")
            || error.message.contains("applied-restart-required"))
}

pub(crate) fn decode_config_patch(
    response: GatewayResponse,
) -> Result<ConfigPatchOutcome, WireError> {
    match decode_channel_config_patch(response)? {
        ChannelConfigPatchOutcome::Written | ChannelConfigPatchOutcome::RestartRequired => {
            Ok(ConfigPatchOutcome::Written)
        }
        ChannelConfigPatchOutcome::Noop => Ok(ConfigPatchOutcome::Noop),
    }
}

pub(crate) fn decode_channel_config_patch(
    response: GatewayResponse,
) -> Result<ChannelConfigPatchOutcome, WireError> {
    match response {
        GatewayResponse::Success { payload: None, .. } => Ok(ChannelConfigPatchOutcome::Written),
        GatewayResponse::Success {
            payload: Some(Value::Object(payload)),
            ..
        } if payload.get("ok").and_then(Value::as_bool) == Some(true) => {
            if payload.get("noop").and_then(Value::as_bool) == Some(true) {
                Ok(ChannelConfigPatchOutcome::Noop)
            } else if config_patch_requires_restart(&payload) {
                Ok(ChannelConfigPatchOutcome::RestartRequired)
            } else {
                Ok(ChannelConfigPatchOutcome::Written)
            }
        }
        GatewayResponse::Failure { error, .. } if is_config_restart_required(&error) => {
            Ok(ChannelConfigPatchOutcome::RestartRequired)
        }
        GatewayResponse::Failure { .. } | GatewayResponse::Success { .. } => {
            Err(WireError::InvalidChannelConfigPatch)
        }
    }
}

fn config_patch_requires_restart(payload: &Map<String, Value>) -> bool {
    payload.get("stats").is_some_and(stats_requires_restart)
        || payload
            .get("sentinel")
            .and_then(|sentinel| sentinel.get("payload"))
            .and_then(|payload| payload.get("stats"))
            .is_some_and(stats_requires_restart)
}

fn stats_requires_restart(stats: &Value) -> bool {
    stats
        .get("requiresRestart")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn required_string(payload: &Map<String, Value>, field: &str) -> Result<String, WireError> {
    payload
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| valid_string(value))
        .map(str::to_owned)
        .ok_or(WireError::InvalidChannelCatalog)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::gateway::config_patch::MAX_REPLACE_PATHS;

    fn response(payload: Value) -> GatewayResponse {
        GatewayResponse::Success {
            request_id: "request".into(),
            payload: Some(payload),
        }
    }

    #[test]
    fn catalog_uses_summary_configured_and_projects_meta() {
        let catalog = decode_channel_catalog(response(json!({
            "partial": false,
            "warnings": [],
            "eventLoop": {"running": true},
            "channelMeta": [{"id":"telegram","label":"Telegram","detailLabel":"Bot API","systemImage":"paperplane"}],
            "channels": {"telegram": {"configured": true, "token":"not-projected"}},
            "channelAccounts": {"telegram": [{"secret":"not-projected"}]}
        })))
        .unwrap();
        assert_eq!(catalog[0].id, "telegram");
        assert!(catalog[0].configured);
        assert!(!format!("{catalog:?}").contains("not-projected"));
    }

    #[test]
    fn catalog_defaults_unreported_configured_to_false() {
        let catalog = decode_channel_catalog(response(json!({
            "partial": true,
            "warnings": ["native warning not projected"],
            "eventLoop": {"running": false},
            "channelMeta": [{"id":"telegram","label":"Telegram","detailLabel":"Bot API"}]
        })))
        .unwrap();
        assert_eq!(catalog[0].id, "telegram");
        assert!(!catalog[0].configured);
        assert!(!format!("{catalog:?}").contains("native warning"));
    }

    #[test]
    fn source_backed_schema_form_preserves_sensitive_fields_and_skips_read_only() {
        let fields = decode_channel_form(
            response(json!({
                "path": "channels.telegram",
                "reloadKind": "restart",
                "hint": {"label": "Telegram"},
                "hintPath": "channels.telegram",
                "schema": {
                    "properties": {
                        "token": {"type": "string", "writeOnly": true, "reloadKind": "restart"},
                        "mode": {"type": "string", "enum": ["poll", "webhook"], "hintPath": "channels.telegram.mode"},
                        "enabled": {"type": "boolean"},
                        "readback": {"type": "string", "readOnly": true}
                    },
                    "required": ["token", "mode"]
                },
                "children": [
                    {"key": "token", "hasChildren": false, "hint": {"label": "Token", "hintPath": "channels.telegram.token"}, "reloadKind": "restart"},
                    {"key": "mode", "hasChildren": false, "hintPath": "channels.telegram.mode"},
                    {"key": "enabled", "hasChildren": false},
                    {"key": "readback", "hasChildren": false}
                ]
            })),
            "telegram",
        )
        .expect("source-backed channel schema");
        assert_eq!(fields.len(), 3);
        assert_eq!(fields[0].kind, ChannelFormFieldKind::Password);
        assert!(fields[0].required);
        assert_eq!(fields[1].kind, ChannelFormFieldKind::Select);
        assert_eq!(
            fields[1].options.as_deref(),
            Some(&["poll".into(), "webhook".into()][..])
        );
        assert_eq!(fields[2].kind, ChannelFormFieldKind::Boolean);
    }

    #[test]
    fn schema_form_rejects_wrong_path_or_nested_descriptors() {
        let wrong_path = response(json!({
            "path": "channels.discord",
            "schema": {"properties": {"token": {"type": "string"}}},
            "children": [{"key": "token", "hasChildren": false}]
        }));
        assert!(decode_channel_form(wrong_path, "telegram").is_err());

        let nested = response(json!({
            "path": "channels.telegram",
            "schema": {"properties": {"token": {"type": "string"}}},
            "children": [{"key": "token", "hasChildren": true}]
        }));
        assert!(decode_channel_form(nested, "telegram").is_err());
    }

    #[test]
    fn config_document_uses_public_config_without_requiring_raw_or_hash() {
        let document = decode_config_document(response(json!({
            "path": "openclaw.json",
            "exists": true,
            "raw": null,
            "valid": false,
            "config": {"channels": {"telegram": {"accounts": {"primary": {}}}}},
            "issues": [{"path": "meta", "message": "invalid"}]
        })))
        .unwrap();
        let document: Value = serde_json::from_slice(&document).unwrap();
        assert_eq!(
            document["channels"]["telegram"]["accounts"]["primary"],
            json!({})
        );
    }

    #[test]
    fn config_snapshot_uses_config_object_and_optional_hash() {
        let snapshot = decode_config_snapshot(response(json!({
            "path": "openclaw.json",
            "exists": true,
            "raw": null,
            "valid": true,
            "sourceConfig": {"channels": {"telegram": {"accounts": {"source": {}}}}},
            "config": {"channels": {"telegram": {}}}
        })))
        .unwrap();
        let source: Value = serde_json::from_slice(&snapshot.source_document).unwrap();
        let document: Value = serde_json::from_slice(&snapshot.document).unwrap();
        assert_eq!(
            source,
            json!({"channels": {"telegram": {"accounts": {"source": {}}}}})
        );
        assert_eq!(document, json!({"channels": {"telegram": {}}}));
        assert!(snapshot.base_hash.is_none());

        let snapshot = decode_config_snapshot(response(json!({
            "raw": "{}",
            "hash": "hash-1",
            "sourceConfig": {},
            "config": {"channels": {"telegram": {}}}
        })))
        .unwrap();
        let source: Value = serde_json::from_slice(&snapshot.source_document).unwrap();
        let document: Value = serde_json::from_slice(&snapshot.document).unwrap();
        assert_eq!(source, json!({}));
        assert_eq!(document, json!({"channels": {"telegram": {}}}));
        assert_eq!(
            snapshot.base_hash.as_ref().map(|hash| hash.as_slice()),
            Some(&b"hash-1"[..])
        );
    }

    #[test]
    fn config_snapshot_accepts_legacy_raw_when_config_is_absent() {
        let snapshot =
            decode_config_snapshot(response(json!({"raw": "{}", "hash": "hash-1"}))).unwrap();
        let document: Value = serde_json::from_slice(&snapshot.document).unwrap();
        assert_eq!(document, json!({}));
        assert_eq!(
            snapshot.base_hash.as_ref().map(|hash| hash.as_slice()),
            Some(&b"hash-1"[..])
        );

        assert!(decode_config_snapshot(response(json!({"raw": null, "hash": "hash-1"}))).is_err());
    }

    #[test]
    fn patch_request_has_native_shape_without_debug_secrets() {
        let request = config_patch_request(
            "patch-1".into(),
            Zeroizing::new(
                br#"{"channels":{"telegram":{"accounts":{"a":{"token":"canary"}}}}}"#.to_vec(),
            ),
            Zeroizing::new(b"hash-canary".to_vec()),
            Vec::new(),
        )
        .unwrap();
        let debug = format!("{request:?}");
        assert!(!debug.contains("patch-1"));
        assert!(!debug.contains("canary"));
        assert!(!debug.contains("hash-canary"));
        assert!(!debug.contains("replace-path-canary"));
        assert!(debug.contains("replace_paths: 0"));
        let encoded: Value = serde_json::from_str(&request.encode().unwrap()).unwrap();
        assert_eq!(encoded["method"], "config.patch");
        assert!(encoded["params"].get("replacePaths").is_none());
        let raw: Value = serde_json::from_str(encoded["params"]["raw"].as_str().unwrap()).unwrap();
        assert_eq!(
            raw["channels"]["telegram"]["accounts"]["a"]["token"],
            "canary"
        );

        let request = config_patch_request(
            "patch-2".into(),
            Zeroizing::new(br#"{"channels":{"telegram":{"accounts":{"a":{}}}}}"#.to_vec()),
            Zeroizing::new(b"hash-2".to_vec()),
            vec![
                "channels.telegram.accounts.a".into(),
                "channels.slack".into(),
            ],
        )
        .unwrap();
        let debug = format!("{request:?}");
        assert!(!debug.contains("patch-2"));
        assert!(!debug.contains("channels.telegram"));
        assert!(!debug.contains("channels.slack"));
        assert!(!debug.contains("hash-2"));
        assert!(debug.contains("replace_paths: 2"));
        let encoded: Value = serde_json::from_str(&request.encode().unwrap()).unwrap();
        assert_eq!(
            encoded["params"],
            json!({
                "raw": "{\"channels\":{\"telegram\":{\"accounts\":{\"a\":{}}}}}",
                "baseHash": "hash-2",
                "replacePaths": ["channels.telegram.accounts.a", "channels.slack"]
            })
        );

        assert!(
            config_patch_request(
                "patch-3".into(),
                Zeroizing::new(b"{}".to_vec()),
                Zeroizing::new(b"hash-3".to_vec()),
                vec![String::new()],
            )
            .is_err()
        );
        assert!(
            config_patch_request(
                "patch-4".into(),
                Zeroizing::new(b"{}".to_vec()),
                Zeroizing::new(b"hash-4".to_vec()),
                vec!["path".into(); MAX_REPLACE_PATHS + 1],
            )
            .is_err()
        );
    }

    #[test]
    fn patch_confirmation_is_strict() {
        for (code, message, conflict) in [
            (
                "INVALID_REQUEST",
                "config changed since last load; re-run config.get and retry",
                true,
            ),
            (
                "INVALID_REQUEST",
                "config base hash required; re-run config.get and retry",
                false,
            ),
            (
                "INVALID_REQUEST",
                "config base hash unavailable; re-run config.get and retry",
                false,
            ),
            (
                "INVALID_REQUEST",
                "config path changed since last load",
                false,
            ),
            (
                "INVALID_REQUEST",
                "active config environment changed while preparing write; re-run config.get and retry",
                false,
            ),
            ("INVALID_REQUEST", "invalid config", false),
            (
                "UNAVAILABLE",
                "config changed since last load; re-run config.get and retry",
                false,
            ),
        ] {
            let frame = json!({
                "type": "res", "id": "cas", "ok": false,
                "error": {"code": code, "message": message}
            });
            let GatewayResponse::Failure { error, .. } =
                super::super::decode_response(&frame.to_string(), "cas")
                    .unwrap()
                    .unwrap()
            else {
                panic!("expected native failure");
            };
            assert_eq!(is_config_conflict(&error), conflict);
        }
        assert_eq!(
            decode_config_patch(GatewayResponse::Success {
                request_id: "id".into(),
                payload: None,
            }),
            Ok(ConfigPatchOutcome::Written)
        );
        assert_eq!(
            decode_config_patch(response(json!({"ok": true, "noop": true}))),
            Ok(ConfigPatchOutcome::Noop)
        );
        for payload in [
            json!({"ok": true, "stats": {"requiresRestart": true}}),
            json!({"ok": true, "sentinel": {"payload": {"stats": {"requiresRestart": true}}}}),
        ] {
            assert_eq!(
                decode_channel_config_patch(response(payload)),
                Ok(ChannelConfigPatchOutcome::RestartRequired)
            );
        }
        assert_eq!(
            decode_config_patch(response(json!({"ok": true}))),
            Ok(ConfigPatchOutcome::Written)
        );
        for message in ["restart-pending", "applied-restart-required"] {
            let frame = json!({
                "type": "res", "id": "restart", "ok": false,
                "error": {"code": "UNAVAILABLE", "message": message}
            });
            let response = super::super::decode_response(&frame.to_string(), "restart")
                .unwrap()
                .unwrap();
            assert_eq!(
                decode_channel_config_patch(response),
                Ok(ChannelConfigPatchOutcome::RestartRequired)
            );
        }
        assert!(decode_config_patch(response(json!({"ok": false}))).is_err());
        assert!(decode_config_patch(response(json!(true))).is_err());
    }

    #[test]
    fn channel_runtime_requests_preserve_optional_default_account_semantics() {
        let request = channel_runtime_request(
            "runtime".into(),
            crate::surfaces::channels::gateway::login::ChannelRuntimeAction::Start,
            "whatsapp",
            None,
        )
        .unwrap();
        let encoded: Value = serde_json::from_str(&request.encode().unwrap()).unwrap();
        assert_eq!(encoded["method"], CHANNELS_START_METHOD);
        assert_eq!(encoded["params"], json!({"channel": "whatsapp"}));
    }

    #[test]
    fn channel_runtime_confirmation_projects_native_start_stop_and_logout() {
        for (action, payload) in [
            (
                crate::surfaces::channels::gateway::login::ChannelRuntimeAction::Start,
                json!({"channel":"whatsapp","accountId":"primary","started":true,"nativeExtra":"ignored"}),
            ),
            (
                crate::surfaces::channels::gateway::login::ChannelRuntimeAction::Stop,
                json!({"channel":"whatsapp","accountId":"primary","stopped":true,"nativeExtra":"ignored"}),
            ),
            (
                crate::surfaces::channels::gateway::login::ChannelRuntimeAction::Logout,
                json!({"channel":"whatsapp","accountId":"primary","cleared":true,"provider": "private"}),
            ),
        ] {
            let confirmation =
                decode_channel_runtime_confirmation(response(payload), action, "whatsapp").unwrap();
            assert_eq!(confirmation, ("whatsapp".into(), Some("primary".into())));
        }
        assert!(
            decode_channel_runtime_confirmation(
                response(json!({"channel":"whatsapp","accountId":"primary","started":true})),
                crate::surfaces::channels::gateway::login::ChannelRuntimeAction::Stop,
                "whatsapp",
            )
            .is_err()
        );
    }

    #[test]
    fn web_login_requests_preserve_channel_and_session_key() {
        let start = web_login_start_request(
            "start-1".into(),
            "openclaw-weixin",
            true,
            Some(5_000),
            false,
            Some("primary"),
        )
        .unwrap();
        let start: Value = serde_json::from_str(&start.encode().unwrap()).unwrap();
        assert_eq!(
            start["params"],
            json!({
                "channel": "openclaw-weixin",
                "force": true,
                "timeoutMs": 5_000,
                "verbose": false,
                "accountId": "primary"
            })
        );

        let wait = web_login_wait_request(
            "wait-1".into(),
            "openclaw-weixin",
            Some(5_000),
            Some("primary"),
            Some("native-session"),
            Some("data:image/png;base64,qr-canary"),
        )
        .unwrap();
        let wait: Value = serde_json::from_str(&wait.encode().unwrap()).unwrap();
        assert_eq!(
            wait["params"],
            json!({
                "channel": "openclaw-weixin",
                "timeoutMs": 5_000,
                "accountId": "primary",
                "sessionKey": "native-session",
                "currentQrDataUrl": "data:image/png;base64,qr-canary"
            })
        );
    }

    #[test]
    fn login_progress_projects_only_bounded_data_url_and_never_message() {
        let progress = decode_login_progress(
            response(json!({
                "message": "private native message",
                "sessionKey": "native-random-weixin-value",
                "connected": false,
                "qrDataUrl": "data:image/png;base64,qr-canary"
            })),
            Some("primary"),
        )
        .unwrap();
        assert_eq!(
            progress.status,
            crate::surfaces::channels::gateway::login::LoginProgressStatus::Qr
        );
        assert_eq!(progress.account_id.as_deref(), Some("primary"));
        assert_eq!(
            progress.qr_data_url.as_deref(),
            Some("data:image/png;base64,qr-canary")
        );
        assert!(!format!("{progress:?}").contains("private native message"));

        let connected = decode_login_progress(
            response(json!({
                "message": "connected native message",
                "sessionKey": "native-random-weixin-value",
                "connected": true,
                "accountId": "primary",
                "token": "private-token"
            })),
            Some("wechat-main"),
        )
        .unwrap();
        assert_eq!(
            connected.status,
            crate::surfaces::channels::gateway::login::LoginProgressStatus::Connected
        );
        assert_eq!(connected.account_id.as_deref(), Some("primary"));
        assert!(connected.qr_data_url.is_none());
        assert!(!format!("{connected:?}").contains("connected native message"));
        assert!(!format!("{connected:?}").contains("private-token"));

        for payload in [
            json!({"alreadyConnected": true, "token": "private-token"}),
            json!({"status": "binded_redirect", "token": "private-token"}),
        ] {
            let progress = decode_login_progress(response(payload), Some("wechat-main")).unwrap();
            assert_eq!(
                progress.status,
                crate::surfaces::channels::gateway::login::LoginProgressStatus::Unknown
            );
            assert!(progress.qr_data_url.is_none());
            assert!(!format!("{progress:?}").contains("private-token"));
        }

        assert!(
            decode_login_progress(
                response(json!({
                    "message": "private native message",
                    "connected": false,
                    "qrDataUrl": "https://weixin.qq.com/x/weixin-login-canary"
                })),
                Some("primary"),
            )
            .is_err()
        );
        assert!(
            decode_login_progress(
                response(json!({
                    "message": "private native message",
                    "connected": false,
                    "qrDataUrl": "data:image/svg+xml;base64,bad"
                })),
                Some("primary"),
            )
            .is_err()
        );
        assert!(decode_login_progress(
            response(json!({
                "connected": false,
                "qrDataUrl": format!("{QR_DATA_URL_PREFIX}{}", "x".repeat(MAX_QR_DATA_URL_LENGTH))
            })),
            Some("primary"),
        )
        .is_err());
    }
}
