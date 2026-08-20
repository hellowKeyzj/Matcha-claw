use std::{collections::BTreeMap, sync::Arc};

use serde_json::{Map, Value};
use zeroize::{Zeroize, Zeroizing};

use crate::gateway::{
    client::GatewayClient,
    delivery::MutationDelivery,
    wire::{self, GatewayResponse},
};

use super::{
    OperationsReadError, channel_control::ChannelControlOperation, next_request_id, read_gateway,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChannelCatalogEntry {
    id: String,
    label: String,
    detail_label: String,
    system_image: Option<String>,
    configured: bool,
}
impl ChannelCatalogEntry {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn label(&self) -> &str {
        &self.label
    }
    pub fn detail_label(&self) -> &str {
        &self.detail_label
    }
    pub fn system_image(&self) -> Option<&str> {
        self.system_image.as_deref()
    }
    pub const fn configured(&self) -> bool {
        self.configured
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChannelCatalog {
    entries: Vec<ChannelCatalogEntry>,
}
impl ChannelCatalog {
    pub fn entries(&self) -> &[ChannelCatalogEntry] {
        &self.entries
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChannelCatalogEffect {
    Catalog(ChannelCatalog),
    Rejected,
    OutcomeUnknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChannelConfigureForm {
    fields: Vec<ChannelConfigureField>,
}
impl ChannelConfigureForm {
    pub fn fields(&self) -> &[ChannelConfigureField] {
        &self.fields
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChannelConfigureField {
    key: String,
    label: String,
    description: Option<String>,
    kind: ChannelConfigureFieldKind,
    required: bool,
    options: Option<Vec<String>>,
}
impl ChannelConfigureField {
    pub fn key(&self) -> &str {
        &self.key
    }
    pub fn label(&self) -> &str {
        &self.label
    }
    pub fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }
    pub const fn kind(&self) -> ChannelConfigureFieldKind {
        self.kind
    }
    pub const fn required(&self) -> bool {
        self.required
    }
    pub fn options(&self) -> Option<&[String]> {
        self.options.as_deref()
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChannelConfigureFieldKind {
    Text,
    Password,
    Boolean,
    Number,
    Select,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChannelConfigSchemaEffect {
    Form(ChannelConfigureForm),
    Rejected,
    OutcomeUnknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChannelConfigReadProjection {
    values: BTreeMap<String, String>,
}

impl ChannelConfigReadProjection {
    pub fn values(&self) -> &BTreeMap<String, String> {
        &self.values
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChannelConfigReadEffect {
    Values(ChannelConfigReadProjection),
    Rejected,
    OutcomeUnknown,
}

pub struct ChannelConfigOperation {
    gateway: Arc<GatewayClient>,
}
impl ChannelConfigOperation {
    pub fn new(gateway: Arc<GatewayClient>) -> Self {
        Self { gateway }
    }

    pub async fn form(&self, channel: String) -> ChannelConfigSchemaEffect {
        if !valid_identifier(&channel) {
            return ChannelConfigSchemaEffect::Rejected;
        }
        let request = match wire::channel::config_schema_lookup_request(
            next_request_id("channel-config-schema"),
            &channel,
        ) {
            Ok(request) => request,
            Err(_) => return ChannelConfigSchemaEffect::Rejected,
        };
        let response = match read_gateway(&self.gateway, request).await {
            Ok(response) => response,
            Err(OperationsReadError::Rejected) => return ChannelConfigSchemaEffect::Rejected,
            Err(_) => return ChannelConfigSchemaEffect::OutcomeUnknown,
        };
        match wire::channel::decode_channel_form(response, &channel) {
            Ok(fields) => ChannelConfigSchemaEffect::Form(ChannelConfigureForm {
                fields: fields
                    .into_iter()
                    .map(|field| ChannelConfigureField {
                        key: field.key,
                        label: field.label,
                        description: field.description,
                        kind: match field.kind {
                            wire::channel::ChannelFormFieldKind::Text => {
                                ChannelConfigureFieldKind::Text
                            }
                            wire::channel::ChannelFormFieldKind::Password => {
                                ChannelConfigureFieldKind::Password
                            }
                            wire::channel::ChannelFormFieldKind::Boolean => {
                                ChannelConfigureFieldKind::Boolean
                            }
                            wire::channel::ChannelFormFieldKind::Number => {
                                ChannelConfigureFieldKind::Number
                            }
                            wire::channel::ChannelFormFieldKind::Select => {
                                ChannelConfigureFieldKind::Select
                            }
                        },
                        required: field.required,
                        options: field.options,
                    })
                    .collect(),
            }),
            Err(_) => ChannelConfigSchemaEffect::OutcomeUnknown,
        }
    }

    pub async fn catalog(&self) -> ChannelCatalogEffect {
        let request =
            match wire::channel::channels_status_request(next_request_id("channel-catalog")) {
                Ok(request) => request,
                Err(_) => return ChannelCatalogEffect::OutcomeUnknown,
            };
        let response = match read_gateway(&self.gateway, request).await {
            Ok(response) => response,
            Err(OperationsReadError::Rejected) => return ChannelCatalogEffect::Rejected,
            Err(_) => return ChannelCatalogEffect::OutcomeUnknown,
        };
        match wire::channel::decode_channel_catalog(response) {
            Ok(entries) => ChannelCatalogEffect::Catalog(ChannelCatalog {
                entries: entries
                    .into_iter()
                    .map(|entry| ChannelCatalogEntry {
                        id: entry.id,
                        label: entry.label,
                        detail_label: entry.detail_label,
                        system_image: entry.system_image,
                        configured: entry.configured,
                    })
                    .collect(),
            }),
            Err(_) => ChannelCatalogEffect::OutcomeUnknown,
        }
    }

    pub async fn read(
        &self,
        channel: String,
        account_id: Option<String>,
    ) -> ChannelConfigReadEffect {
        if !valid_identifier(&channel)
            || account_id
                .as_deref()
                .is_some_and(|account| !valid_identifier(account))
        {
            return ChannelConfigReadEffect::Rejected;
        }
        let account_id = account_id.unwrap_or_else(|| String::from(DEFAULT_ACCOUNT_ID));
        let schema_request = match wire::channel::config_schema_lookup_request(
            next_request_id("channel-config-read-schema"),
            &channel,
        ) {
            Ok(request) => request,
            Err(_) => return ChannelConfigReadEffect::Rejected,
        };
        let schema_response = match read_gateway(&self.gateway, schema_request).await {
            Ok(response) => response,
            Err(OperationsReadError::Rejected) => return ChannelConfigReadEffect::Rejected,
            Err(_) => return ChannelConfigReadEffect::OutcomeUnknown,
        };
        let fields = match decode_read_fields(schema_response, &channel) {
            Ok(fields) => fields,
            Err(()) => return ChannelConfigReadEffect::OutcomeUnknown,
        };
        let config_request =
            match wire::channel::config_get_request(next_request_id("channel-config-read-get")) {
                Ok(request) => request,
                Err(_) => return ChannelConfigReadEffect::OutcomeUnknown,
            };
        let config_response = match read_gateway(&self.gateway, config_request).await {
            Ok(response) => response,
            Err(OperationsReadError::Rejected) => return ChannelConfigReadEffect::Rejected,
            Err(_) => return ChannelConfigReadEffect::OutcomeUnknown,
        };
        let document = match decode_read_snapshot(config_response) {
            Ok(document) => document,
            Err(ReadSnapshotError::Rejected) => return ChannelConfigReadEffect::Rejected,
            Err(ReadSnapshotError::Unknown) => return ChannelConfigReadEffect::OutcomeUnknown,
        };
        let mut document = document;
        let values = project_read_values(&document, &channel, &account_id, &fields);
        zeroize_value(&mut document);
        match values {
            Ok(values) => ChannelConfigReadEffect::Values(ChannelConfigReadProjection { values }),
            Err(()) => ChannelConfigReadEffect::OutcomeUnknown,
        }
    }

    pub async fn delete_config(&self, channel: String, account_id: String) -> DeleteConfigOutcome {
        if !valid_identifier(&channel) || !valid_identifier(&account_id) {
            return DeleteConfigOutcome::Rejected;
        }
        let preflight = match self.readback(&channel, &account_id).await {
            Ok(readback) => readback,
            Err(outcome) => return outcome,
        };
        if preflight.running {
            match ChannelControlOperation::new(Arc::clone(&self.gateway))
                .disconnect(channel.clone(), account_id.clone())
                .await
            {
                super::channel_control::ChannelControlEffect::Confirmed => {}
                super::channel_control::ChannelControlEffect::Rejected => {
                    return DeleteConfigOutcome::Rejected;
                }
                super::channel_control::ChannelControlEffect::OutcomeUnknown => {
                    return DeleteConfigOutcome::Unknown;
                }
            }
        }
        let get =
            match wire::channel::config_get_request(next_request_id("channel-config-delete-get")) {
                Ok(request) => request,
                Err(_) => return DeleteConfigOutcome::Unknown,
            };
        let snapshot = match read_gateway(&self.gateway, get).await {
            Ok(GatewayResponse::Failure { .. }) => return DeleteConfigOutcome::Rejected,
            Ok(response) => match wire::channel::decode_config_snapshot(response) {
                Ok(snapshot) => snapshot,
                Err(_) => return DeleteConfigOutcome::Unknown,
            },
            Err(_) => return DeleteConfigOutcome::Unknown,
        };
        let mut document: Value = match serde_json::from_slice(&snapshot.document) {
            Ok(document) => document,
            Err(_) => return DeleteConfigOutcome::Unknown,
        };
        let accounts = document
            .get_mut("channels")
            .and_then(Value::as_object_mut)
            .and_then(|channels| channels.get_mut(&channel))
            .and_then(Value::as_object_mut)
            .and_then(|config| config.get_mut("accounts"))
            .and_then(Value::as_object_mut);
        let Some(accounts) = accounts else {
            zeroize_value(&mut document);
            return self.confirm_deleted(&channel, &account_id).await;
        };
        if accounts.remove(&account_id).is_none() {
            zeroize_value(&mut document);
            return self.confirm_deleted(&channel, &account_id).await;
        }
        let raw = match serde_json::to_vec(&document) {
            Ok(raw) if !raw.is_empty() => Zeroizing::new(raw),
            _ => {
                zeroize_value(&mut document);
                return DeleteConfigOutcome::Unknown;
            }
        };
        zeroize_value(&mut document);
        let request = match wire::channel::config_patch_request(
            next_request_id("channel-config-delete-patch"),
            raw,
            snapshot.base_hash,
        ) {
            Ok(request) => request,
            Err(_) => return DeleteConfigOutcome::Unknown,
        };
        match self
            .gateway
            .rpc_encoded_mutation(
                request.request_id().to_owned(),
                match request.encode() {
                    Ok(encoded) => encoded,
                    Err(_) => return DeleteConfigOutcome::Unknown,
                },
            )
            .await
        {
            MutationDelivery::Response(response) => match response {
                GatewayResponse::Failure { .. } => DeleteConfigOutcome::Rejected,
                response => {
                    if wire::channel::decode_config_patch(response).is_err() {
                        return DeleteConfigOutcome::Unknown;
                    }
                    self.confirm_deleted(&channel, &account_id).await
                }
            },
            MutationDelivery::NotWritten(_) | MutationDelivery::MayHaveReached(_) => {
                DeleteConfigOutcome::Unknown
            }
        }
    }

    async fn readback(
        &self,
        channel: &str,
        account_id: &str,
    ) -> Result<wire::channel::ChannelAccountReadback, DeleteConfigOutcome> {
        let request =
            wire::channel::channels_status_request(next_request_id("channel-config-delete-status"))
                .map_err(|_| DeleteConfigOutcome::Unknown)?;
        let response = match read_gateway(&self.gateway, request).await {
            Ok(GatewayResponse::Failure { .. }) => return Err(DeleteConfigOutcome::Rejected),
            Ok(response) => response,
            Err(_) => return Err(DeleteConfigOutcome::Unknown),
        };
        wire::channel::decode_channel_account_readback(response, channel, account_id)
            .map_err(|_| DeleteConfigOutcome::Unknown)
    }
    async fn confirm_deleted(&self, channel: &str, account_id: &str) -> DeleteConfigOutcome {
        match self.readback(channel, account_id).await {
            Ok(readback) if !readback.present || !readback.configured => {
                DeleteConfigOutcome::Confirmed
            }
            Ok(_) | Err(DeleteConfigOutcome::Confirmed) => DeleteConfigOutcome::Unknown,
            Err(outcome) => outcome,
        }
    }

    pub async fn configure(
        &self,
        channel: String,
        account_id: String,
        patch: Map<String, Value>,
    ) -> ChannelConfigMutationOutcome {
        if !valid_identifier(&channel) || !valid_identifier(&account_id) || !valid_patch(&patch) {
            return ChannelConfigMutationOutcome::Rejected;
        }
        let get = match wire::channel::config_get_request(next_request_id("channel-config-get")) {
            Ok(request) => request,
            Err(_) => return ChannelConfigMutationOutcome::Unknown,
        };
        let snapshot = match read_gateway(&self.gateway, get).await {
            Ok(GatewayResponse::Failure { .. }) => return ChannelConfigMutationOutcome::Rejected,
            Ok(response) => match wire::channel::decode_config_snapshot(response) {
                Ok(snapshot) => snapshot,
                Err(_) => return ChannelConfigMutationOutcome::Unknown,
            },
            Err(_) => return ChannelConfigMutationOutcome::Unknown,
        };
        let mut document: Value = match serde_json::from_slice(&snapshot.document) {
            Ok(document) => document,
            Err(_) => return ChannelConfigMutationOutcome::Unknown,
        };
        let accounts = document
            .as_object_mut()
            .and_then(|document| {
                document
                    .entry("channels")
                    .or_insert_with(|| Value::Object(Map::new()))
                    .as_object_mut()
            })
            .and_then(|channels| {
                channels
                    .entry(channel)
                    .or_insert_with(|| Value::Object(Map::new()))
                    .as_object_mut()
            })
            .and_then(|config| {
                config
                    .entry("accounts")
                    .or_insert_with(|| Value::Object(Map::new()))
                    .as_object_mut()
            });
        let Some(accounts) = accounts else {
            zeroize_value(&mut document);
            return ChannelConfigMutationOutcome::Unknown;
        };
        accounts.insert(account_id, Value::Object(patch));
        let raw = match serde_json::to_vec(&document) {
            Ok(raw) if !raw.is_empty() => Zeroizing::new(raw),
            _ => {
                zeroize_value(&mut document);
                return ChannelConfigMutationOutcome::Unknown;
            }
        };
        zeroize_value(&mut document);
        let request = match wire::channel::config_patch_request(
            next_request_id("channel-config-patch"),
            raw,
            snapshot.base_hash,
        ) {
            Ok(request) => request,
            Err(_) => return ChannelConfigMutationOutcome::Unknown,
        };
        match self
            .gateway
            .rpc_encoded_mutation(
                request.request_id().to_owned(),
                match request.encode() {
                    Ok(encoded) => encoded,
                    Err(_) => return ChannelConfigMutationOutcome::Unknown,
                },
            )
            .await
        {
            MutationDelivery::Response(GatewayResponse::Failure { .. }) => {
                ChannelConfigMutationOutcome::Rejected
            }
            MutationDelivery::Response(response) => wire::channel::decode_config_patch(response)
                .map(|_| ChannelConfigMutationOutcome::Confirmed)
                .unwrap_or(ChannelConfigMutationOutcome::Unknown),
            MutationDelivery::NotWritten(_) | MutationDelivery::MayHaveReached(_) => {
                ChannelConfigMutationOutcome::Unknown
            }
        }
    }
}

const DEFAULT_ACCOUNT_ID: &str = "default";
const STRICT_SCHEMA_CHANNEL_ID: &str = "dingtalk";
const TOP_LEVEL_DEFAULT_ACCOUNT_CHANNEL_ID: &str = "feishu";
const TOP_LEVEL_DEFAULT_CREDENTIAL_KEY: &str = "appId";
const MAX_READ_FIELDS: usize = 64;
const MAX_READ_VALUE_BYTES: usize = 131_072;
const MAX_READ_TOTAL_VALUE_BYTES: usize = 262_144;

#[derive(Clone, Copy, Eq, PartialEq)]
enum ScalarKind {
    Text,
    Boolean,
    Number,
}

#[derive(Clone, Copy)]
enum ReadFieldKind {
    Text,
    Boolean,
    Number,
    Select(ScalarKind),
}

enum ReadSnapshotError {
    Rejected,
    Unknown,
}

fn decode_read_snapshot(response: GatewayResponse) -> Result<Value, ReadSnapshotError> {
    let response = match response {
        GatewayResponse::Failure { .. } => return Err(ReadSnapshotError::Rejected),
        response => response,
    };
    let snapshot =
        wire::channel::decode_config_snapshot(response).map_err(|_| ReadSnapshotError::Unknown)?;
    let mut document: Value =
        serde_json::from_slice(&snapshot.document).map_err(|_| ReadSnapshotError::Unknown)?;
    if !document.is_object() {
        zeroize_value(&mut document);
        return Err(ReadSnapshotError::Unknown);
    }
    Ok(document)
}

fn decode_read_fields(
    response: GatewayResponse,
    channel: &str,
) -> Result<BTreeMap<String, ReadFieldKind>, ()> {
    let GatewayResponse::Success {
        payload: Some(Value::Object(payload)),
        ..
    } = response
    else {
        return Err(());
    };
    let expected_path = format!("channels.{channel}");
    if !valid_identifier(channel)
        || payload.get("path").and_then(Value::as_str) != Some(expected_path.as_str())
    {
        return Err(());
    }
    let schema = payload.get("schema").and_then(Value::as_object).ok_or(())?;
    let properties = schema
        .get("properties")
        .and_then(Value::as_object)
        .ok_or(())?;
    let children = payload
        .get("children")
        .and_then(Value::as_array)
        .ok_or(())?;
    if children.len() > MAX_READ_FIELDS {
        return Err(());
    }
    let mut seen = BTreeMap::new();
    let mut fields = BTreeMap::new();
    for child in children {
        let child = child.as_object().ok_or(())?;
        let key = child
            .get("key")
            .and_then(Value::as_str)
            .filter(|key| valid_read_key(key))
            .ok_or(())?;
        if seen.insert(key.to_owned(), ()).is_some()
            || child.get("hasChildren").and_then(Value::as_bool) != Some(false)
        {
            return Err(());
        }
        let property = properties.get(key).and_then(Value::as_object).ok_or(())?;
        let hint = match child.get("hint") {
            None | Some(Value::Null) => None,
            Some(Value::Object(hint)) => Some(hint),
            Some(_) => return Err(()),
        };
        if schema_flag(property, "readOnly")?
            || schema_flag(property, "writeOnly")?
            || hint.is_some_and(|hint| schema_flag(hint, "sensitive").unwrap_or(false))
            || password_format(property)?
            || is_bookkeeping_key(key)
            || is_sensitive_key(key)
        {
            continue;
        }
        let kind = read_field_kind(property)?;
        if let Some(kind) = kind {
            fields.insert(key.to_owned(), kind);
        }
    }
    Ok(fields)
}

fn schema_flag(value: &Map<String, Value>, key: &str) -> Result<bool, ()> {
    match value.get(key) {
        None => Ok(false),
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err(()),
    }
}

fn password_format(property: &Map<String, Value>) -> Result<bool, ()> {
    match property.get("format") {
        None => Ok(false),
        Some(Value::String(format)) => Ok(format.eq_ignore_ascii_case("password")),
        Some(_) => Err(()),
    }
}

fn read_field_kind(property: &Map<String, Value>) -> Result<Option<ReadFieldKind>, ()> {
    let declared = declared_scalar_kind(property)?;
    let enumerated = property.get("enum").map(enum_scalar_kind).transpose()?;
    let constant = property
        .get("const")
        .map(|value| Ok(scalar_kind(value)))
        .transpose()?;
    let selected = match (enumerated, constant) {
        (None, None) => {
            return Ok(declared.map(|kind| match kind {
                ScalarKind::Text => ReadFieldKind::Text,
                ScalarKind::Boolean => ReadFieldKind::Boolean,
                ScalarKind::Number => ReadFieldKind::Number,
            }));
        }
        (Some(Some(kind)), None) | (None, Some(Some(kind))) => kind,
        (Some(Some(left)), Some(Some(right))) if left == right => left,
        (Some(None), _) | (_, Some(None)) | (Some(Some(_)), Some(Some(_))) => return Ok(None),
    };
    if declared.is_some_and(|declared| declared != selected) {
        return Ok(None);
    }
    Ok(Some(ReadFieldKind::Select(selected)))
}

fn declared_scalar_kind(property: &Map<String, Value>) -> Result<Option<ScalarKind>, ()> {
    match property.get("type") {
        None => Ok(None),
        Some(Value::String(kind)) => Ok(match kind.as_str() {
            "string" => Some(ScalarKind::Text),
            "boolean" => Some(ScalarKind::Boolean),
            "number" | "integer" => Some(ScalarKind::Number),
            _ => None,
        }),
        Some(Value::Array(_)) => Ok(None),
        Some(_) => Err(()),
    }
}

fn enum_scalar_kind(value: &Value) -> Result<Option<ScalarKind>, ()> {
    let values = value.as_array().ok_or(())?;
    if values.is_empty() || values.len() > MAX_READ_FIELDS {
        return Err(());
    }
    let Some(kind) = values.first().and_then(scalar_kind) else {
        return Ok(None);
    };
    Ok(values
        .iter()
        .all(|value| scalar_kind(value) == Some(kind))
        .then_some(kind))
}

fn scalar_kind(value: &Value) -> Option<ScalarKind> {
    match value {
        Value::String(_) => Some(ScalarKind::Text),
        Value::Bool(_) => Some(ScalarKind::Boolean),
        Value::Number(_) => Some(ScalarKind::Number),
        Value::Null | Value::Array(_) | Value::Object(_) => None,
    }
}

fn project_read_values(
    document: &Value,
    channel: &str,
    account_id: &str,
    fields: &BTreeMap<String, ReadFieldKind>,
) -> Result<BTreeMap<String, String>, ()> {
    let Some(selected) = select_read_config(document, channel, account_id) else {
        return Ok(BTreeMap::new());
    };
    let mut values = BTreeMap::new();
    let mut total_bytes: usize = 0;
    for (key, kind) in fields {
        let Some(value) = selected
            .get(key)
            .and_then(|value| scalar_string(value, *kind))
        else {
            continue;
        };
        if value.is_empty() {
            continue;
        }
        if value.len() > MAX_READ_VALUE_BYTES {
            return Err(());
        }
        total_bytes = total_bytes.checked_add(value.len()).ok_or(())?;
        if total_bytes > MAX_READ_TOTAL_VALUE_BYTES {
            return Err(());
        }
        values.insert(key.clone(), value);
    }
    Ok(values)
}

fn scalar_string(value: &Value, kind: ReadFieldKind) -> Option<String> {
    let kind = match kind {
        ReadFieldKind::Text => ScalarKind::Text,
        ReadFieldKind::Boolean => ScalarKind::Boolean,
        ReadFieldKind::Number => ScalarKind::Number,
        ReadFieldKind::Select(kind) => kind,
    };
    match (kind, value) {
        (ScalarKind::Text, Value::String(value)) => Some(value.clone()),
        (ScalarKind::Boolean, Value::Bool(value)) => Some(value.to_string()),
        (ScalarKind::Number, Value::Number(value)) => Some(value.to_string()),
        _ => None,
    }
}

fn select_read_config<'a>(
    document: &'a Value,
    channel: &str,
    account_id: &str,
) -> Option<&'a Map<String, Value>> {
    let section = document
        .get("channels")
        .and_then(Value::as_object)
        .and_then(|channels| channels.get(channel))
        .and_then(Value::as_object)?;
    let accounts = section.get("accounts").and_then(Value::as_object);
    if channel == STRICT_SCHEMA_CHANNEL_ID && accounts.is_none() {
        return Some(section);
    }
    if channel == TOP_LEVEL_DEFAULT_ACCOUNT_CHANNEL_ID
        && account_id.eq_ignore_ascii_case(DEFAULT_ACCOUNT_ID)
        && top_level_default_credential_present(section)
    {
        return Some(section);
    }
    let accounts = accounts?;
    accounts.get(account_id).and_then(Value::as_object)
}

fn top_level_default_credential_present(section: &Map<String, Value>) -> bool {
    match section.get(TOP_LEVEL_DEFAULT_CREDENTIAL_KEY) {
        Some(Value::String(value)) => !value.trim().is_empty(),
        Some(Value::Bool(_)) | Some(Value::Number(_)) => true,
        None | Some(Value::Null) | Some(Value::Array(_)) | Some(Value::Object(_)) => false,
    }
}

fn valid_read_key(value: &str) -> bool {
    valid_identifier(value) && !matches!(value, "__proto__" | "prototype" | "constructor")
}

fn is_bookkeeping_key(value: &str) -> bool {
    matches!(
        value,
        "enabled" | "updatedAt" | "accounts" | "defaultAccount"
    )
}

fn is_sensitive_key(value: &str) -> bool {
    let normalized: String = value
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .flat_map(char::to_lowercase)
        .collect();
    [
        "token",
        "secret",
        "password",
        "credential",
        "authorization",
        "accesskey",
        "privatekey",
        "apikey",
        "error",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChannelConfigMutationOutcome {
    Confirmed,
    Rejected,
    Unknown,
}
pub type DeleteConfigOutcome = ChannelConfigMutationOutcome;
fn valid_patch(patch: &Map<String, Value>) -> bool {
    !patch.is_empty() && patch.keys().all(|key| valid_identifier(key))
}
fn zeroize_value(value: &mut Value) {
    match value {
        Value::String(string) => string.zeroize(),
        Value::Array(values) => values.iter_mut().for_each(zeroize_value),
        Value::Object(object) => object.values_mut().for_each(zeroize_value),
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}
fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
        })
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::select_read_config;

    #[test]
    fn account_scoped_read_does_not_fall_back_to_another_account() {
        let document = json!({
            "channels": {
                "discord": {
                    "accounts": {
                        "default": {"label": "default"},
                        "primary": {"label": "primary"}
                    }
                }
            }
        });

        let selected = select_read_config(&document, "discord", "primary")
            .and_then(|account| account.get("label"))
            .and_then(Value::as_str);
        assert_eq!(selected, Some("primary"));
        assert!(select_read_config(&document, "discord", "missing").is_none());
    }
}
