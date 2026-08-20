use std::fmt;

use serde_json::{Map, Value};
use zeroize::Zeroizing;

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
pub(crate) const CONFIG_PATCH_METHOD: &str = "config.patch";
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
    action: crate::operations::channel_login::ChannelRuntimeAction,
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
    pub(crate) status: crate::operations::channel_login::LoginProgressStatus,
    pub(crate) account_id: Option<String>,
    pub(crate) session_key: Option<String>,
    pub(crate) qr_data_url: Option<String>,
}

pub(crate) fn decode_channel_runtime_confirmation(
    response: GatewayResponse,
    action: crate::operations::channel_login::ChannelRuntimeAction,
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
        crate::operations::channel_login::ChannelRuntimeAction::Start
        | crate::operations::channel_login::ChannelRuntimeAction::Stop => {
            let expected_field = match action {
                crate::operations::channel_login::ChannelRuntimeAction::Start => "started",
                crate::operations::channel_login::ChannelRuntimeAction::Stop => "stopped",
                crate::operations::channel_login::ChannelRuntimeAction::Logout => unreachable!(),
            };
            if payload.len() != 3
                || payload.get(expected_field).and_then(Value::as_bool) != Some(true)
            {
                return Err(WireError::InvalidChannelRuntime);
            }
        }
        crate::operations::channel_login::ChannelRuntimeAction::Logout => {
            if payload.get("cleared").and_then(Value::as_bool) != Some(true) {
                return Err(WireError::InvalidChannelRuntime);
            }
            if payload.len() < 3 {
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
        Some(true) => crate::operations::channel_login::LoginProgressStatus::Connected,
        Some(false) if qr_data_url.is_some() => {
            crate::operations::channel_login::LoginProgressStatus::Qr
        }
        Some(false) => crate::operations::channel_login::LoginProgressStatus::Pending,
        None if qr_data_url.is_some() => crate::operations::channel_login::LoginProgressStatus::Qr,
        None => crate::operations::channel_login::LoginProgressStatus::Unknown,
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
    let value = optional_valid_string(payload, field)?;
    if value.as_deref().is_some_and(|value| {
        !value.starts_with(QR_DATA_URL_PREFIX) || value.len() > MAX_QR_DATA_URL_LENGTH
    }) {
        return Err(WireError::InvalidLoginProgress);
    }
    Ok(value)
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
}

impl ChannelConfigPatchRequest {
    pub(crate) fn request_id(&self) -> &str {
        &self.request_id
    }

    pub(crate) fn encode(&self) -> Result<String, WireError> {
        let raw = std::str::from_utf8(&self.raw).map_err(|_| WireError::EncodeRequest)?;
        let base_hash =
            std::str::from_utf8(&self.base_hash).map_err(|_| WireError::EncodeRequest)?;
        serde_json::to_string(&serde_json::json!({
            "type": "req",
            "id": self.request_id,
            "method": CONFIG_PATCH_METHOD,
            "params": { "raw": raw, "baseHash": base_hash }
        }))
        .map_err(|_| WireError::EncodeRequest)
    }
}

impl fmt::Debug for ChannelConfigPatchRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ChannelConfigPatchRequest([REDACTED])")
    }
}

pub(crate) struct ChannelConfigSnapshot {
    pub(crate) document: Zeroizing<Vec<u8>>,
    pub(crate) base_hash: Zeroizing<Vec<u8>>,
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
    let raw = payload
        .get("raw")
        .and_then(Value::as_str)
        .filter(|value| valid_string(value))
        .ok_or(WireError::InvalidChannelConfigPatch)?;
    let hash = payload
        .get("hash")
        .and_then(Value::as_str)
        .filter(|value| valid_string(value))
        .ok_or(WireError::InvalidChannelConfigPatch)?;
    let document =
        serde_json::from_str::<Value>(raw).map_err(|_| WireError::InvalidChannelConfigPatch)?;
    if !document.is_object() {
        return Err(WireError::InvalidChannelConfigPatch);
    }
    Ok(ChannelConfigSnapshot {
        document: Zeroizing::new(
            serde_json::to_vec(&document).map_err(|_| WireError::InvalidChannelConfigPatch)?,
        ),
        base_hash: Zeroizing::new(hash.as_bytes().to_vec()),
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ChannelAccountReadback {
    pub(crate) present: bool,
    pub(crate) configured: bool,
    pub(crate) running: bool,
}

pub(crate) fn decode_channel_account_readback(
    response: GatewayResponse,
    channel: &str,
    account_id: &str,
) -> Result<ChannelAccountReadback, WireError> {
    let payload = match response {
        GatewayResponse::Success {
            payload: Some(Value::Object(payload)),
            ..
        } => payload,
        _ => return Err(WireError::InvalidChannelConfigPatch),
    };
    if payload.get("partial").and_then(Value::as_bool) == Some(true)
        || payload.get("warnings").is_some()
    {
        return Err(WireError::InvalidChannelConfigPatch);
    }
    let channels = payload
        .get("channelAccounts")
        .and_then(Value::as_object)
        .ok_or(WireError::InvalidChannelConfigPatch)?;
    let Some(accounts) = channels.get(channel) else {
        return Ok(ChannelAccountReadback {
            present: false,
            configured: false,
            running: false,
        });
    };
    let accounts = accounts
        .as_array()
        .ok_or(WireError::InvalidChannelConfigPatch)?;
    let mut found = None;
    for account in accounts {
        let account = account
            .as_object()
            .ok_or(WireError::InvalidChannelConfigPatch)?;
        let id = account
            .get("accountId")
            .and_then(Value::as_str)
            .filter(|value| valid_string(value))
            .ok_or(WireError::InvalidChannelConfigPatch)?;
        if id != account_id {
            continue;
        }
        if found.is_some() {
            return Err(WireError::InvalidChannelConfigPatch);
        }
        let configured = account
            .get("configured")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        found = Some(ChannelAccountReadback {
            present: true,
            configured,
            running: account
                .get("running")
                .and_then(Value::as_bool)
                .or_else(|| account.get("connected").and_then(Value::as_bool))
                .unwrap_or(false),
        });
    }
    Ok(found.unwrap_or(ChannelAccountReadback {
        present: false,
        configured: false,
        running: false,
    }))
}

pub(crate) fn config_patch_request(
    request_id: String,
    raw: Zeroizing<Vec<u8>>,
    base_hash: Zeroizing<Vec<u8>>,
) -> Result<ChannelConfigPatchRequest, WireError> {
    if !valid_string(&request_id) || raw.is_empty() || base_hash.is_empty() {
        return Err(WireError::InvalidChannelConfigPatch);
    }
    Ok(ChannelConfigPatchRequest {
        request_id,
        raw,
        base_hash,
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
    let channels = payload
        .get("channels")
        .and_then(Value::as_object)
        .ok_or(WireError::InvalidChannelCatalog)?;

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
            let summary = channels
                .get(&id)
                .and_then(Value::as_object)
                .ok_or(WireError::InvalidChannelCatalog)?;
            let configured = summary
                .get("configured")
                .and_then(Value::as_bool)
                .ok_or(WireError::InvalidChannelCatalog)?;
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

pub(crate) fn decode_config_base_hash(
    response: GatewayResponse,
) -> Result<Zeroizing<Vec<u8>>, WireError> {
    Ok(decode_config_snapshot(response)?.base_hash)
}

pub(crate) fn decode_config_patch(response: GatewayResponse) -> Result<(), WireError> {
    match response {
        GatewayResponse::Success { payload: None, .. } => Ok(()),
        GatewayResponse::Success {
            payload: Some(Value::Object(payload)),
            ..
        } if payload.get("ok").and_then(Value::as_bool) == Some(true) => Ok(()),
        GatewayResponse::Failure { .. } | GatewayResponse::Success { .. } => {
            Err(WireError::InvalidChannelConfigPatch)
        }
    }
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

    fn response(payload: Value) -> GatewayResponse {
        GatewayResponse::Success {
            request_id: "request".into(),
            payload: Some(payload),
        }
    }

    #[test]
    fn catalog_uses_summary_configured_and_projects_meta() {
        let catalog = decode_channel_catalog(response(json!({
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
    fn catalog_rejects_missing_configured_summary() {
        assert!(
            decode_channel_catalog(response(json!({
                "channelMeta": [{"id":"telegram","label":"Telegram","detailLabel":"Bot API"}],
                "channels": {"telegram": {}}
            })))
            .is_err()
        );
    }

    #[test]
    fn source_backed_schema_form_preserves_sensitive_fields_and_skips_read_only() {
        let fields = decode_channel_form(
            response(json!({
                "path": "channels.telegram",
                "schema": {
                    "properties": {
                        "token": {"type": "string", "writeOnly": true},
                        "mode": {"type": "string", "enum": ["poll", "webhook"]},
                        "enabled": {"type": "boolean"},
                        "readback": {"type": "string", "readOnly": true}
                    },
                    "required": ["token", "mode"]
                },
                "children": [
                    {"key": "token", "hasChildren": false, "hint": {"label": "Token"}},
                    {"key": "mode", "hasChildren": false},
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
    fn patch_request_has_native_shape_without_debug_secrets() {
        let request = config_patch_request(
            "patch-1".into(),
            Zeroizing::new(
                br#"{"channels":{"telegram":{"accounts":{"a":{"token":"canary"}}}}}"#.to_vec(),
            ),
            Zeroizing::new(b"hash-canary".to_vec()),
        )
        .unwrap();
        assert!(!format!("{request:?}").contains("canary"));
        let encoded: Value = serde_json::from_str(&request.encode().unwrap()).unwrap();
        assert_eq!(encoded["method"], CONFIG_PATCH_METHOD);
        let raw: Value = serde_json::from_str(encoded["params"]["raw"].as_str().unwrap()).unwrap();
        assert_eq!(
            raw["channels"]["telegram"]["accounts"]["a"]["token"],
            "canary"
        );
    }

    #[test]
    fn patch_confirmation_is_strict() {
        assert!(
            decode_config_patch(GatewayResponse::Success {
                request_id: "id".into(),
                payload: None,
            })
            .is_ok()
        );
        assert!(decode_config_patch(response(json!({"ok": true, "noop": true}))).is_ok());
        assert!(decode_config_patch(response(json!({"ok": false}))).is_err());
        assert!(decode_config_patch(response(json!(true))).is_err());
    }

    #[test]
    fn channel_runtime_requests_preserve_optional_default_account_semantics() {
        let request = channel_runtime_request(
            "runtime".into(),
            crate::operations::channel_login::ChannelRuntimeAction::Start,
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
                crate::operations::channel_login::ChannelRuntimeAction::Start,
                json!({"channel":"whatsapp","accountId":"primary","started":true}),
            ),
            (
                crate::operations::channel_login::ChannelRuntimeAction::Stop,
                json!({"channel":"whatsapp","accountId":"primary","stopped":true}),
            ),
            (
                crate::operations::channel_login::ChannelRuntimeAction::Logout,
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
                crate::operations::channel_login::ChannelRuntimeAction::Stop,
                "whatsapp",
            )
            .is_err()
        );
    }

    #[test]
    fn login_wait_request_uses_only_shared_schema_fields() {
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
        assert_eq!(start["params"]["channel"], "openclaw-weixin");

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
    fn login_progress_projects_only_bounded_qr_and_never_message() {
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
            crate::operations::channel_login::LoginProgressStatus::Qr
        );
        assert_eq!(progress.account_id.as_deref(), Some("primary"));
        assert_eq!(
            progress.qr_data_url.as_deref(),
            Some("data:image/png;base64,qr-canary")
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
        assert!(!format!("{progress:?}").contains("private native message"));
    }
}
