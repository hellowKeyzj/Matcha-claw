use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::Instant,
};

use serde_json::{Map, Value};
use zeroize::{Zeroize, Zeroizing};

use crate::gateway::{
    client::GatewayClient,
    delivery::MutationDelivery,
    wire::{self, GatewayResponse},
};

use crate::gateway::operation::{
    ReadError as OperationsReadError, next_request_id, read as read_gateway,
};
use platform::state_dir::CanonicalStateDir;

mod credentials;
mod local_schema;
mod mutation;

pub use platform::trace::{
    channel_trace, current_channel_trace, with_channel_trace, with_channel_trace_sync,
};

fn trace_mutation_outcome(phase: &str, started: Instant, outcome: ChannelConfigMutationOutcome) {
    channel_trace(
        phase,
        &format!(
            "outcome={outcome:?} elapsedMs={}",
            started.elapsed().as_millis()
        ),
    );
}

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
    agent_id: Option<String>,
}

impl ChannelConfigReadProjection {
    pub fn values(&self) -> &BTreeMap<String, String> {
        &self.values
    }

    pub fn agent_id(&self) -> Option<&str> {
        self.agent_id.as_deref()
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
    state_dir: Option<CanonicalStateDir>,
    runtime_running: bool,
    openclaw_dir: Option<std::path::PathBuf>,
    schema_executable: Option<std::path::PathBuf>,
    managed_plugin_root: Option<std::path::PathBuf>,
}
impl ChannelConfigOperation {
    pub fn new(
        gateway: Arc<GatewayClient>,
        state_dir: Option<CanonicalStateDir>,
        runtime_running: bool,
    ) -> Self {
        Self {
            gateway,
            state_dir,
            runtime_running,
            openclaw_dir: None,
            schema_executable: None,
            managed_plugin_root: None,
        }
    }

    pub fn with_openclaw_dir(mut self, openclaw_dir: Option<std::path::PathBuf>) -> Self {
        self.openclaw_dir = openclaw_dir;
        self
    }

    pub fn with_channel_schema_source(
        mut self,
        executable: Option<std::path::PathBuf>,
        managed_plugin_root: Option<std::path::PathBuf>,
    ) -> Self {
        self.schema_executable = executable;
        self.managed_plugin_root = managed_plugin_root;
        self
    }

    async fn schema(&self, channel: &str) -> Result<GatewayResponse, OperationsReadError> {
        let started = Instant::now();
        channel_trace(
            "schema.begin",
            &format!(
                "path={}",
                if self.runtime_running {
                    "gateway"
                } else {
                    "local"
                }
            ),
        );
        let result = async {
            if self.runtime_running {
                let request = wire::channel::config_schema_lookup_request(
                    next_request_id("channel-config-schema"),
                    channel,
                )
                .map_err(|_| OperationsReadError::Rejected)?;
                return read_gateway(&self.gateway, request).await;
            }
            let (Some(executable), Some(openclaw_dir), Some(state_dir), Some(managed_root)) = (
                &self.schema_executable,
                &self.openclaw_dir,
                &self.state_dir,
                &self.managed_plugin_root,
            ) else {
                return Err(OperationsReadError::Unavailable);
            };
            let payload = local_schema::read(
                executable,
                openclaw_dir,
                &state_dir.as_path().join("extensions"),
                managed_root,
                channel,
            )
            .await
            .map_err(|_| OperationsReadError::Unavailable)?;
            Ok(GatewayResponse::Success {
                request_id: next_request_id("channel-local-schema"),
                payload: Some(payload),
            })
        }
        .await;
        let outcome = match &result {
            Ok(GatewayResponse::Failure { .. }) | Err(OperationsReadError::Rejected) => "Rejected",
            Ok(_) => "success",
            Err(OperationsReadError::Protocol) => "protocol",
            Err(OperationsReadError::Unavailable) => "unavailable",
        };
        channel_trace(
            "schema.end",
            &format!(
                "outcome={outcome} elapsedMs={}",
                started.elapsed().as_millis()
            ),
        );
        result
    }

    pub async fn form(&self, channel: String) -> ChannelConfigSchemaEffect {
        if !valid_identifier(&channel) {
            return ChannelConfigSchemaEffect::Rejected;
        }
        let response = match self.schema(&channel).await {
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
        let started = Instant::now();
        channel_trace(
            "config.read.begin",
            &format!(
                "runtimeRunning={} accountPresent={}",
                self.runtime_running,
                account_id.is_some()
            ),
        );
        let outcome = async {
            if !valid_identifier(&channel)
                || account_id
                    .as_deref()
                    .is_some_and(|account| !valid_identifier(account))
            {
                return ChannelConfigReadEffect::Rejected;
            }
            let account_id = account_id.unwrap_or_else(|| String::from(DEFAULT_ACCOUNT_ID));
            let schema_response = match self.schema(&channel).await {
                Ok(response) => response,
                Err(OperationsReadError::Rejected) => return ChannelConfigReadEffect::Rejected,
                Err(_) => return ChannelConfigReadEffect::OutcomeUnknown,
            };
            let fields = match decode_read_fields(schema_response, &channel) {
                Ok(fields) => fields,
                Err(()) => return ChannelConfigReadEffect::OutcomeUnknown,
            };
            let mut document = if self.runtime_running {
                let config_request = match wire::channel::config_get_request(next_request_id(
                    "channel-config-read-get",
                )) {
                    Ok(request) => request,
                    Err(_) => return ChannelConfigReadEffect::OutcomeUnknown,
                };
                let read_started = Instant::now();
                channel_trace("config.get.begin", "path=gateway purpose=public_read");
                let response = read_gateway(&self.gateway, config_request).await;
                channel_trace(
                    "config.get.end",
                    &format!(
                        "path=gateway responseReceived={} elapsedMs={}",
                        response.is_ok(),
                        read_started.elapsed().as_millis()
                    ),
                );
                let config_response = match response {
                    Ok(response) => response,
                    Err(OperationsReadError::Rejected) => return ChannelConfigReadEffect::Rejected,
                    Err(_) => return ChannelConfigReadEffect::OutcomeUnknown,
                };
                match decode_read_snapshot(config_response) {
                    Ok(document) => document,
                    Err(ReadSnapshotError::Rejected) => return ChannelConfigReadEffect::Rejected,
                    Err(ReadSnapshotError::Unknown) => {
                        return ChannelConfigReadEffect::OutcomeUnknown;
                    }
                }
            } else {
                let Some(state_dir) = &self.state_dir else {
                    return ChannelConfigReadEffect::OutcomeUnknown;
                };
                let read_started = Instant::now();
                channel_trace("native.read.begin", "path=local purpose=public_read");
                let result =
                    crate::native_config::config_store::OpenClawConfigStore::new(state_dir.clone())
                        .read_private();
                match result {
                    Ok(document) => {
                        channel_trace(
                            "native.read.end",
                            &format!(
                                "outcome=success elapsedMs={}",
                                read_started.elapsed().as_millis()
                            ),
                        );
                        document.as_value()
                    }
                    Err(error) => {
                        channel_trace(
                            "native.read.end",
                            &format!(
                                "code={error:?} elapsedMs={}",
                                read_started.elapsed().as_millis()
                            ),
                        );
                        return ChannelConfigReadEffect::OutcomeUnknown;
                    }
                }
            };
            let values = project_read_values(&document, &channel, &account_id, &fields);
            let agent_id = project_account_binding(&document, &channel, &account_id);
            zeroize_value(&mut document);
            match values {
                Ok(values) => {
                    ChannelConfigReadEffect::Values(ChannelConfigReadProjection { values, agent_id })
                }
                Err(()) => ChannelConfigReadEffect::OutcomeUnknown,
            }
        }
        .await;
        let code = match &outcome {
            ChannelConfigReadEffect::Values(_) => "success",
            ChannelConfigReadEffect::Rejected => "Rejected",
            ChannelConfigReadEffect::OutcomeUnknown => "Unknown",
        };
        channel_trace(
            "config.read.end",
            &format!("outcome={code} elapsedMs={}", started.elapsed().as_millis()),
        );
        outcome
    }

    pub async fn delete_config(
        &self,
        channel: String,
        account_id: Option<String>,
    ) -> DeleteConfigOutcome {
        let started = Instant::now();
        channel_trace(
            "delete.begin",
            &format!(
                "runtimeRunning={} accountPresent={}",
                self.runtime_running,
                account_id.is_some()
            ),
        );
        let outcome = async {
            let channel = if channel == "wechat" {
                "openclaw-weixin".to_owned()
            } else {
                channel
            };
            if !valid_identifier(&channel)
                || account_id
                    .as_deref()
                    .is_some_and(|id| !valid_identifier(id))
            {
                channel_trace("delete.validate", "outcome=Rejected reason=invalid_input");
                return DeleteConfigOutcome::Rejected;
            }
            channel_trace("delete.validate", "outcome=valid");
            let account_id = if channel == "openclaw-weixin" {
                match account_id {
                    Some(id) => match super::weixin_login::normalize_account_id(&id) {
                        Some(id) => Some(id),
                        None => return DeleteConfigOutcome::Rejected,
                    },
                    None => None,
                }
            } else {
                account_id
            };
            let Some(state_dir) = &self.state_dir else {
                return DeleteConfigOutcome::Unknown;
            };
            let remove_channel = if channel == "openclaw-weixin" {
                match credentials::is_last_weixin_account(state_dir, account_id.as_deref()) {
                    Ok(last) => last,
                    Err(()) => return DeleteConfigOutcome::Unknown,
                }
            } else {
                account_id.is_none()
            };
            let mut cleanup = None;
            let outcome = self
                .mutate_config(|document| {
                    cleanup = Some(
                        credentials::plan(
                            state_dir,
                            document,
                            &channel,
                            account_id.as_deref(),
                            self.openclaw_dir.as_deref(),
                        )
                        .map_err(|()| DeleteConfigOutcome::Rejected)?,
                    );
                    let readback = delete_config_readback(
                        document,
                        &channel,
                        account_id.as_deref(),
                        remove_channel,
                    );
                    mutation::delete(document, &channel, account_id.as_deref(), remove_channel);
                    Ok(readback.map(ConfigMutationReadbackTarget::Delete))
                })
                .await;
            if !matches!(
                outcome,
                DeleteConfigOutcome::Confirmed | DeleteConfigOutcome::Noop
            ) {
                return outcome;
            }
            let Some(cleanup) = cleanup else {
                return DeleteConfigOutcome::Unknown;
            };
            let state_dir = state_dir.clone();
            let trace_id = current_channel_trace();
            channel_trace("cleanup.dispatch", "execution=spawn_blocking");
            match tokio::task::spawn_blocking(move || {
                with_channel_trace_sync(trace_id, || {
                    cleanup.execute(&state_dir, &channel, account_id.as_deref())
                })
            })
            .await
            {
                Ok(Ok(())) => DeleteConfigOutcome::Confirmed,
                Ok(Err(())) => DeleteConfigOutcome::Unknown,
                Err(_) => {
                    channel_trace("cleanup.join", "outcome=failed code=join_error");
                    DeleteConfigOutcome::Unknown
                }
            }
        }
        .await;
        trace_mutation_outcome("delete.end", started, outcome);
        outcome
    }

    pub async fn configure(
        &self,
        channel: String,
        account_id: String,
        patch: Map<String, Value>,
        plugin_id: Option<String>,
        agent_id: Option<String>,
    ) -> ChannelConfigMutationOutcome {
        self.configure_account(channel, account_id, patch, plugin_id, agent_id)
            .await
    }

    pub async fn finalize_login(
        &self,
        channel: String,
        account_id: String,
        patch: Map<String, Value>,
        plugin_id: Option<String>,
        agent_id: Option<String>,
    ) -> ChannelConfigMutationOutcome {
        self.configure_account(channel, account_id, patch, plugin_id, agent_id)
            .await
    }

    async fn configure_account(
        &self,
        channel: String,
        account_id: String,
        patch: Map<String, Value>,
        plugin_id: Option<String>,
        agent_id: Option<String>,
    ) -> ChannelConfigMutationOutcome {
        let started = Instant::now();
        channel_trace(
            "configure.begin",
            &format!(
                "runtimeRunning={} accountPresent={} fieldCount={} pluginPresent={} agentPresent={}",
                self.runtime_running,
                !account_id.is_empty(),
                patch.len(),
                plugin_id.is_some(),
                agent_id.is_some()
            ),
        );
        if !valid_identifier(&channel)
            || !valid_identifier(&account_id)
            || (patch.is_empty() && agent_id.is_none())
            || !valid_patch(&patch)
            || plugin_id
                .as_deref()
                .is_some_and(|id| canonical_plugin_id(id).is_none())
            || agent_id.as_deref().is_some_and(|id| !valid_identifier(id))
        {
            channel_trace(
                "configure.validate",
                "outcome=Rejected reason=invalid_input",
            );
            trace_mutation_outcome(
                "configure.end",
                started,
                ChannelConfigMutationOutcome::Rejected,
            );
            return ChannelConfigMutationOutcome::Rejected;
        }
        channel_trace("configure.validate", "outcome=valid");
        let mut target_account = Value::Object(patch);
        let outcome = self
            .mutate_config(|document| {
                Ok(Some(ConfigMutationReadbackTarget::Configure(
                    mutation::configure(
                        document,
                        &channel,
                        &account_id,
                        &target_account,
                        plugin_id.as_deref(),
                        agent_id.as_deref(),
                    ),
                )))
            })
            .await;
        zeroize_value(&mut target_account);
        trace_mutation_outcome("configure.end", started, outcome);
        outcome
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

struct DeleteConfigPlan {
    readback: Option<DeleteConfigReadbackTarget>,
}

struct ConfigureConfigReadbackTarget {
    channel: String,
    account: String,
    account_config: Value,
    binding: AccountBindingReadback,
    plugin: Option<String>,
}

#[derive(Clone, Eq, PartialEq)]
enum AccountBindingReadback {
    Account(String),
    Wildcard(String),
    Absent,
}

struct DeleteConfigReadbackTarget {
    channel_id: String,
    channel: ExpectedConfigValue,
    plugins: Option<ExpectedConfigValue>,
}

enum ConfigMutationReadbackTarget {
    Configure(ConfigureConfigReadbackTarget),
    Delete(DeleteConfigReadbackTarget),
}

enum ExpectedConfigValue {
    Absent,
    Present(Value),
}

impl ConfigMutationReadbackTarget {
    fn matches(&self, document: &Value) -> bool {
        match self {
            Self::Configure(target) => target.matches(document),
            Self::Delete(target) => target.matches(document),
        }
    }
}

impl ConfigureConfigReadbackTarget {
    fn matches(&self, document: &Value) -> bool {
        let account = select_channel_config(document, &self.channel)
            .and_then(|channel| channel.get("accounts"))
            .and_then(Value::as_object)
            .and_then(|accounts| accounts.get(&self.account))
            .and_then(Value::as_object);
        expected_config_fields_match(account, &self.account_config)
            && account_binding_matches(document, &self.channel, &self.account, &self.binding)
            && self
                .plugin
                .as_deref()
                .is_none_or(|plugin| plugin_enabled(document, plugin))
    }
}

impl DeleteConfigReadbackTarget {
    fn matches(&self, document: &Value) -> bool {
        let channel = document
            .get("channels")
            .and_then(Value::as_object)
            .and_then(|channels| channels.get(&self.channel_id));
        expected_config_value_matches(channel, &self.channel)
            && self.plugins.as_ref().is_none_or(|plugins| {
                expected_config_value_matches(document.get("plugins"), plugins)
            })
    }
}

impl Drop for ConfigureConfigReadbackTarget {
    fn drop(&mut self) {
        zeroize_value(&mut self.account_config);
    }
}

impl Drop for DeleteConfigReadbackTarget {
    fn drop(&mut self) {
        zeroize_expected_config_value(&mut self.channel);
        if let Some(plugins) = &mut self.plugins {
            zeroize_expected_config_value(plugins);
        }
    }
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

fn configure_config_readback(
    document: &Value,
    channel: &str,
    account: &str,
    plugin: Option<&str>,
) -> ConfigureConfigReadbackTarget {
    let account_config = select_channel_config(document, channel)
        .and_then(|channel| channel.get("accounts"))
        .and_then(Value::as_object)
        .and_then(|accounts| accounts.get(account))
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    ConfigureConfigReadbackTarget {
        channel: channel.to_owned(),
        account: account.to_owned(),
        account_config,
        binding: account_binding_readback(document, channel, account),
        plugin: plugin.and_then(canonical_plugin_id).map(str::to_owned),
    }
}

fn delete_config_readback(
    document: &Value,
    channel: &str,
    account: Option<&str>,
    remove_channel: bool,
) -> Option<DeleteConfigReadbackTarget> {
    if remove_channel || account.is_none() {
        return delete_last_account_config_plan(document, channel).readback;
    }
    if channel == "openclaw-weixin" {
        let channel_config = select_channel_config(document, channel)?;
        let mut target = channel_config.clone();
        if let Some(accounts) = target.get_mut("accounts").and_then(Value::as_object_mut) {
            if let Some(mut removed) = account.and_then(|account| accounts.remove(account)) {
                zeroize_value(&mut removed);
            }
        }
        return Some(DeleteConfigReadbackTarget {
            channel_id: channel.to_owned(),
            channel: ExpectedConfigValue::Present(Value::Object(target)),
            plugins: None,
        });
    }
    account
        .and_then(|account| account_config_delete_plan(document, channel, account))?
        .readback
}

fn expected_config_value_matches(observed: Option<&Value>, expected: &ExpectedConfigValue) -> bool {
    match expected {
        ExpectedConfigValue::Absent => observed.is_none(),
        ExpectedConfigValue::Present(expected) => observed == Some(expected),
    }
}

fn expected_config_fields_match(observed: Option<&Map<String, Value>>, expected: &Value) -> bool {
    let Some(observed) = observed else {
        return false;
    };
    let Some(expected) = expected.as_object() else {
        return false;
    };
    expected
        .iter()
        .all(|(key, value)| observed.get(key) == Some(value))
}

fn account_binding_readback(
    document: &Value,
    channel: &str,
    account: &str,
) -> AccountBindingReadback {
    let bindings = document
        .get("bindings")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    if let Some(agent) = bindings.iter().rev().find_map(|binding| {
        mutation::is_simple_binding(binding, channel, Some(account))
            .then(|| binding.get("agentId").and_then(Value::as_str))
            .flatten()
    }) {
        return AccountBindingReadback::Account(agent.to_owned());
    }
    if let Some(agent) = bindings.iter().rev().find_map(|binding| {
        mutation::is_wildcard_account_binding(binding, channel)
            .then(|| binding.get("agentId").and_then(Value::as_str))
            .flatten()
    }) {
        return AccountBindingReadback::Wildcard(agent.to_owned());
    }
    AccountBindingReadback::Absent
}

fn account_binding_matches(
    document: &Value,
    channel: &str,
    account: &str,
    target: &AccountBindingReadback,
) -> bool {
    let bindings = document
        .get("bindings")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    match target {
        AccountBindingReadback::Account(agent) => bindings.iter().any(|binding| {
            mutation::is_simple_binding(binding, channel, Some(account))
                && binding.get("agentId").and_then(Value::as_str) == Some(agent.as_str())
        }),
        AccountBindingReadback::Wildcard(agent) => bindings.iter().any(|binding| {
            mutation::is_wildcard_account_binding(binding, channel)
                && binding.get("agentId").and_then(Value::as_str) == Some(agent.as_str())
        }),
        AccountBindingReadback::Absent => {
            !mutation::has_account_binding(bindings, channel, account)
                && !mutation::has_wildcard_account_binding(bindings, channel)
        }
    }
}

fn plugin_enabled(document: &Value, plugin: &str) -> bool {
    let Some(plugin) = canonical_plugin_id(plugin) else {
        return false;
    };
    let plugins = object(document.get("plugins"));
    strings(plugins.get("allow")).contains(plugin)
        && !strings(plugins.get("deny")).contains(plugin)
        && plugins
            .get("entries")
            .and_then(Value::as_object)
            .and_then(|entries| entries.get(plugin))
            .and_then(Value::as_object)
            .and_then(|entry| entry.get("enabled"))
            .and_then(Value::as_bool)
            == Some(true)
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
    let properties = match schema.get("properties") {
        None => None,
        Some(Value::Object(properties)) => Some(properties),
        Some(_) => return Err(()),
    };
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
        let key = child.get("key").and_then(Value::as_str).ok_or(())?;
        if key == "*" {
            continue;
        }
        if !valid_read_key(key) || seen.insert(key.to_owned(), ()).is_some() {
            return Err(());
        }
        let has_children = child
            .get("hasChildren")
            .and_then(Value::as_bool)
            .ok_or(())?;
        if has_children {
            continue;
        }
        let hint = match child.get("hint") {
            None | Some(Value::Null) => None,
            Some(Value::Object(hint)) => Some(hint),
            Some(_) => return Err(()),
        };
        if hint.is_some_and(|hint| schema_flag(hint, "sensitive").unwrap_or(false))
            || is_bookkeeping_key(key)
            || is_sensitive_key(key)
        {
            continue;
        }
        let property = match properties.and_then(|properties| properties.get(key)) {
            None => None,
            Some(Value::Object(property)) => Some(property),
            Some(_) => return Err(()),
        };
        let kind = if let Some(property) = property {
            if schema_flag(property, "readOnly")?
                || schema_flag(property, "writeOnly")?
                || password_format(property)?
            {
                continue;
            }
            read_field_kind(property)?
        } else {
            read_field_kind_from_child(child)?
        };
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
    read_field_kind_from_parts(
        declared_scalar_kind(property)?,
        property.get("enum").map(enum_scalar_kind).transpose()?,
        property
            .get("const")
            .map(|value| Ok(scalar_kind(value)))
            .transpose()?,
    )
}

fn read_field_kind_from_child(child: &Map<String, Value>) -> Result<Option<ReadFieldKind>, ()> {
    read_field_kind_from_parts(declared_scalar_kind(child)?, None, None)
}

fn read_field_kind_from_parts(
    declared: Option<ScalarKind>,
    enumerated: Option<Option<ScalarKind>>,
    constant: Option<Option<ScalarKind>>,
) -> Result<Option<ReadFieldKind>, ()> {
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

fn project_account_binding(document: &Value, channel: &str, account: &str) -> Option<String> {
    let bindings = document.get("bindings")?.as_array()?;
    let mut agent_id = None;
    for binding in bindings {
        if binding
            .get("type")
            .is_some_and(|kind| kind.as_str() != Some("route"))
            || !mutation::is_simple_binding(binding, channel, Some(account))
        {
            continue;
        }
        let candidate = binding.get("agentId")?.as_str()?;
        if !valid_identifier(candidate) || agent_id.is_some_and(|agent| agent != candidate) {
            return None;
        }
        agent_id = Some(candidate);
    }
    agent_id.map(str::to_owned)
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
        "encryptkey",
        "apikey",
        "error",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChannelConfigMutationOutcome {
    Confirmed,
    Noop,
    RestartRequired,
    Rejected,
    Unknown,
}
pub type DeleteConfigOutcome = ChannelConfigMutationOutcome;

fn account_configure_plugin_target(document: &Value, plugin_id: &str) -> Value {
    let empty_current = Value::Object(Map::new());
    plugin_enable_target(document.get("plugins").unwrap_or(&empty_current), plugin_id)
}

fn account_config_delete_plan(
    document: &Value,
    channel: &str,
    account_id: &str,
) -> Option<DeleteConfigPlan> {
    let channel_config = select_channel_config(document, channel)?;
    let accounts = match channel_config.get("accounts").and_then(Value::as_object) {
        Some(accounts) if !accounts.is_empty() => accounts,
        _ if account_id == DEFAULT_ACCOUNT_ID => {
            return Some(delete_last_account_config_plan(document, channel));
        }
        _ => return None,
    };
    accounts.get(account_id)?;
    let mut remaining_accounts = accounts.clone();
    remaining_accounts.remove(account_id);
    if remaining_accounts.is_empty() {
        return Some(delete_last_account_config_plan(document, channel));
    }

    let replacement_default = channel_config
        .get("defaultAccount")
        .and_then(Value::as_str)
        .filter(|default_account| !remaining_accounts.contains_key(*default_account))
        .and_then(|_| remaining_accounts.keys().next().cloned());
    let mut target_channel = channel_config.clone();
    insert_zeroizing(
        &mut target_channel,
        "accounts".into(),
        Value::Object(remaining_accounts),
    );
    if let Some(default_account) = replacement_default {
        insert_zeroizing(
            &mut target_channel,
            "defaultAccount".into(),
            Value::String(default_account),
        );
    }

    Some(DeleteConfigPlan {
        readback: Some(DeleteConfigReadbackTarget {
            channel_id: channel.to_owned(),
            channel: ExpectedConfigValue::Present(Value::Object(target_channel)),
            plugins: None,
        }),
    })
}

fn delete_last_account_config_plan(document: &Value, channel: &str) -> DeleteConfigPlan {
    let mut readback_plugins = None;
    if let Some(plugin_id) = managed_channel_plugin_id(channel) {
        let empty_plugins = Value::Object(Map::new());
        let current_plugins = document.get("plugins").unwrap_or(&empty_plugins);
        let target_plugins = plugin_delete_target(current_plugins, plugin_id);
        readback_plugins = Some(if target_plugins.as_object().is_some_and(Map::is_empty) {
            ExpectedConfigValue::Absent
        } else {
            ExpectedConfigValue::Present(target_plugins)
        });
    }
    DeleteConfigPlan {
        readback: Some(DeleteConfigReadbackTarget {
            channel_id: channel.to_owned(),
            channel: ExpectedConfigValue::Absent,
            plugins: readback_plugins,
        }),
    }
}

fn select_channel_config<'a>(document: &'a Value, channel: &str) -> Option<&'a Map<String, Value>> {
    document
        .get("channels")
        .and_then(Value::as_object)
        .and_then(|channels| channels.get(channel))
        .and_then(Value::as_object)
}

fn plugin_delete_target(current_plugins: &Value, plugin_id: &str) -> Value {
    let current = object(Some(current_plugins));
    let Some(plugin_id) = canonical_plugin_id(plugin_id) else {
        return Value::Object(current);
    };
    let mut target = current.clone();
    remove_plugin_id_list_item(&mut target, "allow", plugin_id);
    remove_plugin_id_list_item(&mut target, "deny", plugin_id);
    remove_plugin_entry(&mut target, plugin_id);
    if plugin_id == "openclaw-lark" {
        remove_plugin_id_list_item(&mut target, "allow", "feishu-openclaw-plugin");
        remove_plugin_id_list_item(&mut target, "deny", "feishu-openclaw-plugin");
        remove_plugin_entry(&mut target, "feishu-openclaw-plugin");
    }
    if plugin_id == "wecom" {
        remove_plugin_id_list_item(&mut target, "allow", "wecom-openclaw-plugin");
        remove_plugin_id_list_item(&mut target, "deny", "wecom-openclaw-plugin");
        remove_plugin_entry(&mut target, "wecom-openclaw-plugin");
    }
    if plugin_id == "openclaw-qqbot" {
        remove_plugin_id_list_item(&mut target, "allow", "qqbot");
        remove_plugin_id_list_item(&mut target, "deny", "qqbot");
        remove_plugin_entry(&mut target, "qqbot");
    }
    remove_empty_object(&mut target, "entries");
    Value::Object(target)
}

fn remove_plugin_id_list_item(target: &mut Map<String, Value>, key: &str, plugin_id: &str) {
    let Some(Value::Array(current)) = target.get(key) else {
        return;
    };
    let next = current
        .iter()
        .filter(|value| {
            value
                .as_str()
                .is_none_or(|value| canonical_plugin_id(value) != Some(plugin_id))
        })
        .cloned()
        .collect::<Vec<_>>();
    if next.len() == current.len() {
        return;
    }
    if next.is_empty() {
        if let Some(mut removed) = target.remove(key) {
            zeroize_value(&mut removed);
        }
        return;
    }
    insert_zeroizing(target, key.into(), Value::Array(next));
}

fn remove_plugin_entry(target: &mut Map<String, Value>, plugin_id: &str) {
    let Some(Value::Object(entries)) = target.get_mut("entries") else {
        return;
    };
    if let Some(mut removed) = entries.remove(plugin_id) {
        zeroize_value(&mut removed);
    }
}

fn remove_empty_object(target: &mut Map<String, Value>, key: &str) {
    if target
        .get(key)
        .and_then(Value::as_object)
        .is_some_and(Map::is_empty)
    {
        if let Some(mut removed) = target.remove(key) {
            zeroize_value(&mut removed);
        }
    }
}

fn plugin_enable_target(current_plugins: &Value, plugin_id: &str) -> Value {
    let current = object(Some(current_plugins));
    let Some(plugin_id) = canonical_plugin_id(plugin_id) else {
        return Value::Object(current);
    };
    let mut allow = canonicalize_plugin_ids(strings(current.get("allow")));
    let mut deny = canonicalize_plugin_ids(strings(current.get("deny")));
    let existing_entries = object(current.get("entries"));
    let mut entries = canonicalize_plugin_entries(existing_entries.clone());

    allow.insert(plugin_id.to_owned());
    deny.remove(plugin_id);
    let mut entry = object(entries.get(plugin_id));
    insert_zeroizing(&mut entry, "enabled".into(), Value::Bool(true));
    insert_zeroizing(&mut entries, plugin_id.to_owned(), Value::Object(entry));
    if plugin_id == "openclaw-lark" {
        let mut legacy_entry = object(existing_entries.get("feishu-openclaw-plugin"));
        insert_zeroizing(&mut legacy_entry, "enabled".into(), Value::Bool(false));
        insert_zeroizing(
            &mut entries,
            "feishu-openclaw-plugin".into(),
            Value::Object(legacy_entry),
        );
    }
    let mut existing_entries = Value::Object(existing_entries);
    zeroize_value(&mut existing_entries);

    let allow = Value::Array(allow.into_iter().map(Value::String).collect());
    let deny = Value::Array(deny.into_iter().map(Value::String).collect());
    let mut entries = Value::Object(entries);
    if current.get("allow") == Some(&allow)
        && current.get("deny") == Some(&deny)
        && current.get("entries") == Some(&entries)
    {
        zeroize_value(&mut entries);
        return Value::Object(current);
    }

    let mut target = current;
    insert_zeroizing(&mut target, "allow".into(), allow);
    insert_zeroizing(&mut target, "deny".into(), deny);
    insert_zeroizing(&mut target, "entries".into(), entries);
    Value::Object(target)
}

fn canonicalize_plugin_ids(ids: BTreeSet<String>) -> BTreeSet<String> {
    ids.into_iter()
        .filter_map(|id| canonical_plugin_id(&id).map(ToOwned::to_owned))
        .collect()
}

fn canonicalize_plugin_entries(entries: Map<String, Value>) -> Map<String, Value> {
    let mut result = Map::new();
    for (id, value) in entries {
        let canonical = canonical_plugin_id(&id).unwrap_or(&id).to_owned();
        if canonical == id || !result.contains_key(&canonical) {
            result.insert(canonical, value);
        }
    }
    result
}

fn canonical_plugin_id(id: &str) -> Option<&str> {
    if id.is_empty() || id.len() > 128 || id.chars().any(char::is_whitespace) {
        return None;
    }
    Some(match id {
        "feishu-openclaw-plugin" => "openclaw-lark",
        "wecom-openclaw-plugin" => "wecom",
        "qqbot" => "openclaw-qqbot",
        id => id,
    })
}

fn managed_channel_plugin_id(channel: &str) -> Option<&'static str> {
    match channel {
        "dingtalk" => Some("dingtalk"),
        "feishu" => Some("openclaw-lark"),
        "wecom" => Some("wecom"),
        "qqbot" => Some("openclaw-qqbot"),
        "wechat" | "openclaw-weixin" => Some("openclaw-weixin"),
        "discord" => Some("discord"),
        "whatsapp" => Some("whatsapp"),
        _ => None,
    }
}

fn object(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn strings(value: Option<&Value>) -> BTreeSet<String> {
    value
        .and_then(Value::as_array)
        .map(|array| array.iter().filter_map(string).collect())
        .unwrap_or_default()
}

fn string(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn insert_zeroizing(target: &mut Map<String, Value>, key: String, value: Value) {
    if let Some(mut previous) = target.insert(key, value) {
        zeroize_value(&mut previous);
    }
}

fn valid_patch(patch: &Map<String, Value>) -> bool {
    patch.keys().all(|key| valid_identifier(key))
}
fn zeroize_value(value: &mut Value) {
    match value {
        Value::String(string) => string.zeroize(),
        Value::Array(values) => values.iter_mut().for_each(zeroize_value),
        Value::Object(object) => object.values_mut().for_each(zeroize_value),
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn zeroize_expected_config_value(value: &mut ExpectedConfigValue) {
    if let ExpectedConfigValue::Present(value) = value {
        zeroize_value(value);
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
    use std::{sync::Arc, time::Duration};

    use futures_util::{SinkExt, StreamExt};
    use serde_json::{Map, Value, json};
    use tokio::{net::TcpListener, time::timeout};
    use tokio_tungstenite::tungstenite::Message;

    use super::{
        ChannelConfigMutationOutcome, ChannelConfigOperation, decode_read_fields, mutation,
        select_read_config,
    };
    use crate::gateway::{
        auth::GatewaySecret,
        client::{
            GatewayClient, GatewayClientMetadata, GatewayEndpoint,
            test_support::{TestSocket, TestTlsIdentity, accept_websocket},
        },
        wire::GatewayResponse,
    };

    #[tokio::test(flavor = "current_thread")]
    async fn configure_accepts_may_have_reached_when_readback_matches_target() {
        let outcome = run_configure_may_have_reached_readback(json!({
            "channels": {
                "telegram": {
                    "accounts": {
                        "primary": {"label": "Primary", "mode": "poll", "concurrent": true}
                    }
                }
            },
            "bindings":[{"agentId":"main","match":{"channel":"telegram","accountId":"primary"}}]
        }))
        .await;

        assert_eq!(outcome, ChannelConfigMutationOutcome::Confirmed);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let client = test_client(&listener, identity.fingerprint());
        let acceptor = identity.acceptor();
        let server = tokio::spawn(async move {
            let mut socket = accept_websocket(&listener, &acceptor).await;
            serve_hello(&mut socket).await;
            for attempt in 0..3 {
                let get = read_json(&mut socket).await;
                assert_eq!(get["method"], "config.get");
                let hash = format!("conflict-{attempt}");
                send_json(
                    &mut socket,
                    json!({"type":"res","id":get["id"],"ok":true,
                    "payload":config_snapshot(json!({}), &hash)}),
                )
                .await;
                let patch = read_json(&mut socket).await;
                assert_eq!(patch["method"], "config.patch");
                assert_eq!(patch["params"]["baseHash"], hash);
                send_json(&mut socket, json!({"type":"res","id":patch["id"],"ok":false,
                    "error":{"code":"INVALID_REQUEST","message":"config changed since last load; re-run config.get and retry"}})).await;
            }
            assert_no_config_patch(&mut socket).await;
        });
        assert_eq!(
            ChannelConfigOperation::new(Arc::new(client), None, true)
                .configure(
                    "telegram".into(),
                    "primary".into(),
                    Map::from_iter([("label".into(), json!("Primary"))]),
                    None,
                    None
                )
                .await,
            ChannelConfigMutationOutcome::Rejected
        );
        server.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn configure_keeps_may_have_reached_unknown_when_readback_mismatches_target() {
        let outcome = run_configure_may_have_reached_readback(json!({
            "channels": {
                "telegram": {
                    "accounts": {
                        "primary": {"label": "Other", "mode": "poll"}
                    }
                }
            },
            "bindings":[{"agentId":"main","match":{"channel":"telegram","accountId":"primary"}}]
        }))
        .await;

        assert_eq!(outcome, ChannelConfigMutationOutcome::Unknown);
    }

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

    #[test]
    fn read_fields_accept_empty_schema_without_public_fields() {
        let fields = decode_read_fields(
            GatewayResponse::Success {
                request_id: "schema".into(),
                payload: Some(json!({
                    "path": "channels.openclaw-weixin",
                    "schema": {"type": "object", "additionalProperties": true},
                    "children": []
                })),
            },
            "openclaw-weixin",
        )
        .expect("empty public schema is a valid lookup response");

        assert!(fields.is_empty());
    }

    #[test]
    fn read_fields_accept_gateway_lookup_with_stripped_properties() {
        let fields = decode_read_fields(
            GatewayResponse::Success {
                request_id: "schema".into(),
                payload: Some(json!({
                    "path": "channels.telegram",
                    "schema": {"type": "object"},
                    "children": [
                        {"key": "token", "type": "string", "required": true, "hasChildren": false},
                        {"key": "label", "type": "string", "required": false, "hasChildren": false},
                        {"key": "enabled", "type": "boolean", "required": false, "hasChildren": false}
                    ]
                })),
            },
            "telegram",
        )
        .expect("OpenClaw lookup may strip root properties");

        assert_eq!(fields.len(), 1);
        assert!(fields.contains_key("label"));
    }

    #[test]
    fn read_fields_skip_wildcard_and_nested_schema_children() {
        let fields = decode_read_fields(
            GatewayResponse::Success {
                request_id: "schema".into(),
                payload: Some(json!({
                    "path": "channels.telegram",
                    "schema": {
                        "type": "object",
                        "properties": {
                            "token": {"type": "string", "writeOnly": true},
                            "label": {"type": "string"},
                            "accounts": {"type": "object", "additionalProperties": {"type": "object"}}
                        },
                        "additionalProperties": {"type": "string"}
                    },
                    "children": [
                        {"key": "token", "hasChildren": false},
                        {"key": "label", "hasChildren": false},
                        {"key": "accounts", "hasChildren": true},
                        {"key": "*", "type": "string", "hasChildren": false}
                    ]
                })),
            },
            "telegram",
        )
        .expect("nested and wildcard descriptors are valid but not public fields");

        assert_eq!(fields.len(), 1);
        assert!(fields.contains_key("label"));
    }

    #[test]
    fn delete_config_patch_removes_non_last_account_and_repairs_default() {
        let mut document = json!({
            "channels": {
                "telegram": {
                    "enabled": true,
                    "defaultAccount": "primary",
                    "accounts": {
                        "primary": {"token": "secret"},
                        "other": {"token": "keep"}
                    }
                },
                "discord": {"accounts": {"primary": {"token": "keep"}}}
            },
            "plugins": {
                "allow": ["dingtalk"],
                "entries": {"dingtalk": {"enabled": true}}
            }
        });

        mutation::delete(&mut document, "telegram", Some("primary"), false);

        assert!(
            document["channels"]["telegram"]["accounts"]
                .get("primary")
                .is_none()
        );
        assert_eq!(document["channels"]["telegram"]["defaultAccount"], "other");
        assert_eq!(
            document["channels"]["telegram"]["accounts"]["other"]["token"],
            "keep"
        );
        assert_eq!(
            document["channels"]["discord"]["accounts"]["primary"]["token"],
            "keep"
        );
        assert_eq!(document["plugins"]["allow"], json!(["dingtalk"]));
    }

    #[test]
    fn delete_config_patch_removes_last_account_channel_and_managed_plugin() {
        let mut document = json!({
            "channels": {
                "feishu": {
                    "enabled": true,
                    "defaultAccount": "primary",
                    "appId": "mirror",
                    "accounts": {
                        "primary": {"appSecret": "secret", "scopes": ["a", "b"]}
                    }
                },
                "wecom": {"accounts": {"primary": {"corpId": "keep"}}}
            },
            "plugins": {
                "enabled": true,
                "allow": ["openclaw-lark", "wecom", "feishu-openclaw-plugin"],
                "deny": ["openclaw-lark", "blocked", "feishu-openclaw-plugin"],
                "load": {"paths": ["/keep"]},
                "entries": {
                    "openclaw-lark": {"enabled": true, "config": {"keep": false}},
                    "feishu-openclaw-plugin": {"enabled": false},
                    "wecom": {"enabled": true}
                }
            }
        });

        mutation::delete(&mut document, "feishu", Some("primary"), false);

        assert!(document["channels"].get("feishu").is_none());
        assert_eq!(document["plugins"]["allow"], json!(["wecom"]));
        assert_eq!(document["plugins"]["deny"], json!(["blocked"]));
        assert_eq!(
            document["plugins"]["entries"],
            json!({"wecom":{"enabled":true}})
        );
        assert_eq!(document["plugins"]["load"], json!({"paths":["/keep"]}));
        assert_eq!(
            document["channels"]["wecom"]["accounts"]["primary"]["corpId"],
            "keep"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn delete_config_patch_uses_plugin_manifest_channel_binding() {
        let mut document = json!({
            "channels": {
                "whatsapp": {"accounts": {"primary": {"phone": "secret"}}},
                "discord": {"accounts": {"primary": {"token": "keep"}}}
            },
            "plugins": {
                "allow": ["whatsapp", "discord"],
                "entries": {
                    "whatsapp": {"enabled": true},
                    "discord": {"enabled": true}
                }
            }
        });

        mutation::delete(&mut document, "whatsapp", Some("primary"), false);

        assert!(document["channels"].get("whatsapp").is_none());
        assert_eq!(document["plugins"]["allow"], json!(["discord"]));
        assert_eq!(
            document["plugins"]["entries"],
            json!({"discord":{"enabled":true}})
        );
        assert_eq!(
            document["channels"]["discord"]["accounts"]["primary"]["token"],
            "keep"
        );

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let root = std::env::temp_dir().join(crate::gateway::operation::next_request_id(
            "channel-delete-auth",
        ));
        let state_dir = CanonicalStateDir::provision(&root).unwrap();
        let custom = root.join("credentials/whatsapp/custom");
        std::fs::create_dir_all(&custom).unwrap();
        std::fs::write(custom.join("creds.json"), b"{}").unwrap();
        std::fs::write(
            root.join("openclaw.json"),
            json!({
                "channels":{"whatsapp":{"accounts":{"primary":{"authDir":custom}}}}
            })
            .to_string(),
        )
        .unwrap();
        let operation = ChannelConfigOperation::new(
            Arc::new(test_client(&listener, identity.fingerprint())),
            Some(state_dir),
            false,
        );
        assert_eq!(
            operation
                .delete_config("whatsapp".into(), Some("primary".into()))
                .await,
            ChannelConfigMutationOutcome::Confirmed
        );
        assert!(!custom.exists());
        let persisted: Value =
            serde_json::from_slice(&std::fs::read(root.join("openclaw.json")).unwrap()).unwrap();
        assert!(persisted["channels"].get("whatsapp").is_none());

        for auth_dir in [
            custom.clone(),
            root.join("outside"),
            root.join("credentials/whatsapp"),
        ] {
            std::fs::create_dir_all(&auth_dir).unwrap();
            let document = json!({"channels":{"whatsapp":{"accounts":{
                "primary":{"authDir":auth_dir},"other":{"authDir":auth_dir}
            }}}});
            std::fs::write(root.join("openclaw.json"), document.to_string()).unwrap();
            assert_eq!(
                operation
                    .delete_config("whatsapp".into(), Some("primary".into()))
                    .await,
                ChannelConfigMutationOutcome::Rejected
            );
            let persisted: Value =
                serde_json::from_slice(&std::fs::read(root.join("openclaw.json")).unwrap())
                    .unwrap();
            assert_eq!(persisted, document);
            assert!(auth_dir.exists());
        }
        let operation = operation.with_openclaw_dir(Some(root.clone()));
        std::fs::write(
            root.join("openclaw.json"),
            json!({"channels":{"whatsapp":{"accounts":{
                "primary":{"authDir":"credentials/whatsapp/custom"}
            }}}})
            .to_string(),
        )
        .unwrap();
        assert_eq!(
            operation
                .delete_config("whatsapp".into(), Some("primary".into()))
                .await,
            ChannelConfigMutationOutcome::Confirmed
        );
        assert!(!custom.exists());
        for name in ["creds.json", "session-example.json", "provider-oauth.json"] {
            std::fs::write(root.join("credentials").join(name), b"{}").unwrap();
        }
        std::fs::write(
            root.join("openclaw.json"),
            json!({"channels":{"whatsapp":{}}}).to_string(),
        )
        .unwrap();
        assert_eq!(
            operation.delete_config("whatsapp".into(), None).await,
            ChannelConfigMutationOutcome::Confirmed
        );
        assert!(!root.join("credentials/creds.json").exists());
        assert!(!root.join("credentials/session-example.json").exists());
        assert!(root.join("credentials/provider-oauth.json").exists());

        let plugin = root.join("extensions/telegram");
        std::fs::create_dir_all(&plugin).unwrap();
        std::fs::write(plugin.join("openclaw.plugin.json"), json!({
            "id":"telegram","channels":["telegram"],"channelConfigs":{"telegram":{"schema":{
                "type":"object","properties":{"label":{"type":"string"},"botToken":{"type":"string"},"encryptKey":{"type":"string"}}
            }}}
        }).to_string()).unwrap();
        std::fs::write(
            root.join("openclaw.json"),
            json!({"channels":{"telegram":{"accounts":{"primary":{
                "label":"Saved","botToken":"private","encryptKey":"private-encryption"
            }}}}})
            .to_string(),
        )
        .unwrap();
        let operation = operation
            .with_channel_schema_source(Some(root.join("unused-node")), Some(root.join("managed")));
        assert!(matches!(
            operation.form("telegram".into()).await,
            super::ChannelConfigSchemaEffect::Form(_)
        ));
        let super::ChannelConfigReadEffect::Values(values) = operation
            .read("telegram".into(), Some("primary".into()))
            .await
        else {
            panic!("offline native schema read failed");
        };
        assert_eq!(
            values.values(),
            &std::collections::BTreeMap::from([("label".into(), "Saved".into())])
        );
        let plugin = root.join("extensions/wecom");
        std::fs::create_dir_all(&plugin).unwrap();
        std::fs::write(
            plugin.join("openclaw.plugin.json"),
            json!({"id":"wecom","channels":["wecom"]}).to_string(),
        )
        .unwrap();
        std::fs::write(
            root.join("openclaw.json"),
            json!({"channels":{"wecom":{"accounts":{"primary":{
                "botId":"Saved bot","secret":"private"
            }}}}})
            .to_string(),
        )
        .unwrap();
        let super::ChannelConfigSchemaEffect::Form(form) = operation.form("wecom".into()).await
        else {
            panic!("verified WeCom product form unavailable");
        };
        assert_eq!(form.fields().len(), 2);
        let super::ChannelConfigReadEffect::Values(values) =
            operation.read("wecom".into(), Some("primary".into())).await
        else {
            panic!("WeCom configuration read unavailable");
        };
        assert_eq!(
            values.values(),
            &std::collections::BTreeMap::from([("botId".into(), "Saved bot".into())])
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn delete_config_patch_removes_empty_plugins_object_for_last_managed_account() {
        let mut document = json!({
            "channels": {
                "dingtalk": {"accounts": {"primary": {"token": "secret"}}},
                "telegram": {"accounts": {"primary": {"token": "keep"}}}
            },
            "plugins": {
                "allow": ["dingtalk"],
                "deny": ["dingtalk"],
                "entries": {"dingtalk": {"enabled": true}}
            }
        });

        mutation::delete(&mut document, "dingtalk", Some("primary"), false);

        assert!(document["channels"].get("dingtalk").is_none());
        assert!(document.get("plugins").is_none());
        assert_eq!(
            document["channels"]["telegram"]["accounts"]["primary"]["token"],
            "keep"
        );
    }

    #[test]
    fn configure_patch_preserves_unsubmitted_account_fields() {
        let mut document = json!({
            "channels": {
                "telegram": {
                    "accounts": {
                        "primary": {"token": "old", "mode": "poll", "stale": "remove"}
                    }
                }
            }
        });
        let target = json!({"token": "new", "mode": "poll"})
            .as_object()
            .unwrap()
            .clone();

        mutation::configure(
            &mut document,
            "telegram",
            "primary",
            &Value::Object(target),
            None,
            None,
        );

        assert_eq!(
            document,
            json!({
                "channels":{"telegram":{"accounts":{"primary":{"token":"new","mode":"poll","stale":"remove"}}}},
                "bindings":[{"agentId":"main","match":{"channel":"telegram","accountId":"primary"}}]
            })
        );
    }

    #[test]
    fn configure_patch_marks_destructive_account_array_paths() {
        let mut document = json!({
            "channels": {
                "telegram": {
                    "accounts": {
                        "primary": {"allow": ["a", "b"], "token": "same", "label": "old", "optional": "old", "nested": {"old": true}}
                    }
                }
            }
        });
        let target = json!({"allow": ["a"], "token": "same", "label": "", "optional": null, "nested": {"new": true}})
            .as_object()
            .unwrap()
            .clone();

        mutation::configure(
            &mut document,
            "telegram",
            "primary",
            &Value::Object(target),
            None,
            None,
        );

        assert_eq!(
            document,
            json!({
                "channels":{"telegram":{"accounts":{"primary":{"allow":["a"],"token":"same","label":"","optional":null,"nested":{"new":true}}}}},
                "bindings":[{"agentId":"main","match":{"channel":"telegram","accountId":"primary"}}]
            })
        );
    }

    #[test]
    fn first_feishu_configure_patch_enables_plugin_and_account() {
        let mut document = json!({});
        let target = json!({"appId": "id", "appSecret": "secret"})
            .as_object()
            .unwrap()
            .clone();

        mutation::configure(
            &mut document,
            "feishu",
            "primary",
            &Value::Object(target),
            Some("openclaw-lark"),
            None,
        );

        assert_eq!(
            document,
            json!({
                "channels": {"feishu": {"accounts": {"primary": {"appId": "id", "appSecret": "secret"}}}},
                "plugins": {
                    "allow": ["openclaw-lark"],
                    "deny": [],
                    "entries": {
                        "openclaw-lark": {"enabled": true},
                        "feishu-openclaw-plugin": {"enabled": false}
                    }
                },
                "bindings":[{"agentId":"main","match":{"channel":"feishu","accountId":"primary"}}]
            })
        );
    }

    #[test]
    fn configure_patch_reuses_existing_plugin_enable_config_without_duplicates() {
        let mut document = json!({
            "plugins": {
                "allow": ["custom-plugin", "openclaw-lark"],
                "deny": ["openclaw-lark", "wecom"],
                "entries": {
                    "openclaw-lark": {"enabled": true, "config": {"keep": true}},
                    "custom-plugin": {"enabled": true}
                }
            },
            "channels": {
                "feishu": {
                    "accounts": {
                        "primary": {"appId": "old"}
                    }
                }
            }
        });
        let target = json!({"appId": "new"}).as_object().unwrap().clone();

        mutation::configure(
            &mut document,
            "feishu",
            "primary",
            &Value::Object(target),
            Some("openclaw-lark"),
            None,
        );

        assert_eq!(
            document,
            json!({
                "channels": {"feishu": {"accounts": {"primary": {"appId": "new"}}}},
                "plugins": {
                    "allow": ["custom-plugin", "openclaw-lark"],
                    "deny": ["wecom"],
                    "entries": {"feishu-openclaw-plugin": {"enabled": false}, "openclaw-lark": {"enabled": true, "config": {"keep": true}}, "custom-plugin": {"enabled": true}}
                },
                "bindings":[{"agentId":"main","match":{"channel":"feishu","accountId":"primary"}}]
            })
        );
    }

    #[test]
    fn telegram_configure_patch_does_not_enable_plugin() {
        let mut document = json!({});
        let target = json!({"token": "secret"}).as_object().unwrap().clone();

        mutation::configure(
            &mut document,
            "telegram",
            "primary",
            &Value::Object(target),
            None,
            None,
        );

        assert_eq!(
            document,
            json!({
                "channels":{"telegram":{"accounts":{"primary":{"token":"secret"}}}},
                "bindings":[{"agentId":"main","match":{"channel":"telegram","accountId":"primary"}}]
            })
        );
        assert!(document.get("plugins").is_none());
    }

    #[test]
    fn configure_defaults_named_account_binding_to_main() {
        let mut document = json!({});
        let target = json!({"token": "secret"}).as_object().unwrap().clone();

        mutation::configure(
            &mut document,
            "openclaw-weixin",
            "wx-account",
            &Value::Object(target),
            None,
            None,
        );

        assert_eq!(
            document["bindings"],
            json!([{"agentId":"main","match":{"channel":"openclaw-weixin","accountId":"wx-account"}}])
        );
    }

    #[test]
    fn configure_preserves_explicit_account_binding_agent() {
        let mut document = json!({
            "bindings": [
                {"agentId":"custom","match":{"channel":"openclaw-weixin","accountId":"wx-account"}}
            ]
        });
        let target = json!({"token": "secret"}).as_object().unwrap().clone();

        mutation::configure(
            &mut document,
            "openclaw-weixin",
            "wx-account",
            &Value::Object(target),
            None,
            None,
        );

        assert_eq!(
            document["bindings"],
            json!([{"agentId":"custom","match":{"channel":"openclaw-weixin","accountId":"wx-account"}}])
        );
    }

    #[test]
    fn configure_preserves_wildcard_account_binding() {
        let mut document = json!({
            "bindings": [
                {"agentId":"custom","match":{"channel":"openclaw-weixin","accountId":"*"}}
            ]
        });
        let target = json!({"token": "secret"}).as_object().unwrap().clone();

        mutation::configure(
            &mut document,
            "openclaw-weixin",
            "wx-account",
            &Value::Object(target),
            None,
            None,
        );

        assert_eq!(
            document["bindings"],
            json!([{"agentId":"custom","match":{"channel":"openclaw-weixin","accountId":"*"}}])
        );
    }

    #[test]
    fn configure_explicit_agent_overrides_account_wildcard_and_default_binding() {
        let mut document = json!({
            "channels": {
                "openclaw-weixin": {
                    "accounts": {
                        "wx-account": {"token": "old"}
                    }
                }
            },
            "bindings": [
                {"agentId":"main","match":{"channel":"openclaw-weixin","accountId":"wx-account"}},
                {"agentId":"wildcard-old","match":{"channel":"openclaw-weixin","accountId":"*"}},
                {"agentId":"default-old","match":{"channel":"openclaw-weixin","accountId":"default"}}
            ]
        });
        let target = json!({"token": "secret"}).as_object().unwrap().clone();

        mutation::configure(
            &mut document,
            "openclaw-weixin",
            "wx-account",
            &Value::Object(target),
            None,
            Some("custom"),
        );

        assert_eq!(
            document["bindings"],
            json!([
                {"agentId":"wildcard-old","match":{"channel":"openclaw-weixin","accountId":"*"}},
                {"agentId":"default-old","match":{"channel":"openclaw-weixin","accountId":"default"}},
                {"agentId":"custom","match":{"channel":"openclaw-weixin","accountId":"wx-account"}}
            ])
        );
        assert_eq!(
            document["channels"]["openclaw-weixin"]["accounts"]["wx-account"],
            json!({"token":"secret"})
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn configure_accepts_empty_patch_when_agent_id_is_present() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let client = test_client(&listener, identity.fingerprint());
        let acceptor = identity.acceptor();
        let server = tokio::spawn(async move {
            let mut socket = accept_websocket(&listener, &acceptor).await;
            serve_hello(&mut socket).await;
            let get = read_json(&mut socket).await;
            assert_eq!(get["method"], "config.get");
            send_json(
                &mut socket,
                json!({
                    "type": "res", "id": get["id"], "ok": true,
                    "payload": config_snapshot(json!({
                        "channels": {"openclaw-weixin": {"accounts": {"wx-account": {"token": "keep"}}}},
                        "bindings": [{"agentId":"main","match":{"channel":"openclaw-weixin","accountId":"wx-account"}}]
                    }), "hash-1")
                }),
            )
            .await;
            let patch = read_json(&mut socket).await;
            assert_eq!(patch["method"], "config.patch");
            assert_eq!(patch["params"]["baseHash"], "hash-1");
            let raw: Value =
                serde_json::from_str(patch["params"]["raw"].as_str().unwrap()).unwrap();
            assert!(
                raw["channels"]["openclaw-weixin"]["accounts"]["wx-account"]
                    .get("agentId")
                    .is_none()
            );
            assert_eq!(
                raw["bindings"],
                json!([{"agentId":"support","match":{"channel":"openclaw-weixin","accountId":"wx-account"}}])
            );
            send_json(
                &mut socket,
                json!({"type":"res","id":patch["id"],"ok":true,"payload":{"ok":true}}),
            )
            .await;
        });

        let outcome = ChannelConfigOperation::new(Arc::new(client), None, true)
            .configure(
                "openclaw-weixin".into(),
                "wx-account".into(),
                Map::new(),
                None,
                Some("support".into()),
            )
            .await;

        assert_eq!(outcome, ChannelConfigMutationOutcome::Confirmed);
        server.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn configure_running_mutates_source_config_not_runtime_overlay() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let client = test_client(&listener, identity.fingerprint());
        let acceptor = identity.acceptor();
        let server = tokio::spawn(async move {
            let mut socket = accept_websocket(&listener, &acceptor).await;
            serve_hello(&mut socket).await;
            let get = read_json(&mut socket).await;
            assert_eq!(get["method"], "config.get");
            send_json(
                &mut socket,
                json!({
                    "type": "res", "id": get["id"], "ok": true,
                    "payload": config_snapshot_with_runtime(
                        json!({
                            "channels": {"telegram": {"accounts": {"primary": {"token": "secret"}}}},
                            "bindings": [{"agentId":"main","match":{"channel":"telegram","accountId":"primary"}}]
                        }),
                        json!({
                            "channels": {"telegram": {"accounts": {"primary": {"token": "secret", "runtimeOnly": true}}}},
                            "bindings": [{"agentId":"main","match":{"channel":"telegram","accountId":"primary"}}],
                            "runtimeOnlyRoot": true
                        }),
                        "hash-1"
                    )
                }),
            )
            .await;
            let patch = read_json(&mut socket).await;
            assert_eq!(patch["method"], "config.patch");
            assert_eq!(patch["params"]["baseHash"], "hash-1");
            let raw: Value =
                serde_json::from_str(patch["params"]["raw"].as_str().unwrap()).unwrap();
            assert_eq!(
                raw,
                json!({"channels":{"telegram":{"accounts":{"primary":{"label":"Primary"}}}}})
            );
            send_json(
                &mut socket,
                json!({"type":"res","id":patch["id"],"ok":true,"payload":{"ok":true}}),
            )
            .await;
        });

        let outcome = ChannelConfigOperation::new(Arc::new(client), None, true)
            .configure(
                "telegram".into(),
                "primary".into(),
                Map::from_iter([("label".into(), json!("Primary"))]),
                None,
                None,
            )
            .await;

        assert_eq!(outcome, ChannelConfigMutationOutcome::Confirmed);
        server.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn configure_maps_patch_requires_restart_receipts() {
        for patch_receipt in [
            json!({"type":"res","id":"patch","ok":true,"payload":{"ok":true,"stats":{"requiresRestart":true}}}),
            json!({"type":"res","id":"patch","ok":false,"error":{"code":"UNAVAILABLE","message":"restart-pending"}}),
            json!({"type":"res","id":"patch","ok":false,"error":{"code":"UNAVAILABLE","message":"applied-restart-required"}}),
        ] {
            assert_eq!(
                run_configure_patch_receipt(patch_receipt).await,
                ChannelConfigMutationOutcome::RestartRequired
            );
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn configure_rejects_empty_patch_without_agent_id() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let client = test_client(&listener, identity.fingerprint());

        let outcome = ChannelConfigOperation::new(Arc::new(client), None, true)
            .configure(
                "openclaw-weixin".into(),
                "wx-account".into(),
                Map::new(),
                None,
                None,
            )
            .await;

        assert_eq!(outcome, ChannelConfigMutationOutcome::Rejected);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn configure_rejects_invalid_agent_id() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let client = test_client(&listener, identity.fingerprint());

        let outcome = ChannelConfigOperation::new(Arc::new(client), None, true)
            .configure(
                "telegram".into(),
                "primary".into(),
                Map::from_iter([("label".into(), json!("Primary"))]),
                None,
                Some("bad id".into()),
            )
            .await;

        assert_eq!(outcome, ChannelConfigMutationOutcome::Rejected);
    }

    async fn run_configure_patch_receipt(mut patch_receipt: Value) -> ChannelConfigMutationOutcome {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let client = test_client(&listener, identity.fingerprint());
        let acceptor = identity.acceptor();
        let server = tokio::spawn(async move {
            let mut socket = accept_websocket(&listener, &acceptor).await;
            serve_hello(&mut socket).await;
            let get = read_json(&mut socket).await;
            assert_eq!(get["method"], "config.get");
            send_json(
                &mut socket,
                json!({
                    "type": "res", "id": get["id"], "ok": true,
                    "payload": config_snapshot(json!({}), "hash-1")
                }),
            )
            .await;
            let patch = read_json(&mut socket).await;
            assert_eq!(patch["method"], "config.patch");
            assert_eq!(patch["params"]["baseHash"], "hash-1");
            patch_receipt["id"] = patch["id"].clone();
            send_json(&mut socket, patch_receipt).await;
        });
        let outcome = ChannelConfigOperation::new(Arc::new(client), None, true)
            .configure(
                "telegram".into(),
                "primary".into(),
                Map::from_iter([("label".into(), json!("Primary"))]),
                None,
                None,
            )
            .await;
        server.await.unwrap();
        outcome
    }

    async fn run_configure_may_have_reached_readback(
        readback: Value,
    ) -> ChannelConfigMutationOutcome {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let identity = TestTlsIdentity::generate();
        let client = test_client(&listener, identity.fingerprint());
        let acceptor = identity.acceptor();
        let server = tokio::spawn(async move {
            let mut first = accept_websocket(&listener, &acceptor).await;
            serve_hello(&mut first).await;
            let get = read_json(&mut first).await;
            assert_eq!(get["method"], "config.get");
            send_json(
                &mut first,
                json!({
                    "type": "res", "id": get["id"], "ok": true,
                    "payload": config_snapshot(json!({}), "hash-1")
                }),
            )
            .await;
            let conflicted = read_json(&mut first).await;
            assert_eq!(conflicted["method"], "config.patch");
            assert_eq!(conflicted["params"]["baseHash"], "hash-1");
            send_json(
                &mut first,
                json!({
                    "type":"res", "id":conflicted["id"], "ok":false,
                    "error":{"code":"INVALID_REQUEST","message":"config changed since last load; re-run config.get and retry"}
                }),
            )
            .await;
            let refreshed = read_json(&mut first).await;
            assert_eq!(refreshed["method"], "config.get");
            send_json(
                &mut first,
                json!({
                    "type":"res", "id":refreshed["id"], "ok":true,
                    "payload":config_snapshot(json!({
                        "channels":{"telegram":{"accounts":{"primary":{"label":"Concurrent","mode":"poll","concurrent":true}}}},
                        "bindings":[{"agentId":"main","match":{"channel":"telegram","accountId":"primary"}}]
                    }), "hash-refreshed")
                }),
            )
            .await;
            let patch = read_json(&mut first).await;
            assert_eq!(patch["method"], "config.patch");
            assert_eq!(patch["params"]["baseHash"], "hash-refreshed");
            let raw: Value =
                serde_json::from_str(patch["params"]["raw"].as_str().unwrap()).unwrap();
            assert_eq!(
                raw,
                json!({"channels":{"telegram":{"accounts":{"primary":{"label":"Primary"}}}}})
            );
            first.close(None).await.unwrap();

            let mut second = accept_websocket(&listener, &acceptor).await;
            serve_hello(&mut second).await;
            let get = read_json(&mut second).await;
            assert_eq!(get["method"], "config.get");
            send_json(
                &mut second,
                json!({
                    "type": "res", "id": get["id"], "ok": true,
                    "payload": config_snapshot(readback, "hash-2")
                }),
            )
            .await;
            assert_no_config_patch(&mut second).await;
        });
        let patch = Map::from_iter([
            ("label".into(), Value::String("Primary".into())),
            ("mode".into(), Value::String("poll".into())),
        ]);
        let outcome = ChannelConfigOperation::new(Arc::new(client), None, true)
            .configure("telegram".into(), "primary".into(), patch, None, None)
            .await;
        server.await.unwrap();
        outcome
    }

    fn test_client(
        listener: &TcpListener,
        certificate_fingerprint: platform::listener_identity::CertificateFingerprint,
    ) -> GatewayClient {
        GatewayClient::new(
            GatewayEndpoint::try_new(listener.local_addr().unwrap()).unwrap(),
            certificate_fingerprint,
            Arc::new(GatewaySecret::new("fake-gateway-token".into()).unwrap()),
            GatewayClientMetadata::try_new("1.2.3".into(), "windows".into()).unwrap(),
        )
    }

    async fn serve_hello(socket: &mut TestSocket) {
        send_json(
            socket,
            json!({
                "type": "event", "event": "connect.challenge",
                "payload": {"nonce": "fake-nonce", "ts": 42}
            }),
        )
        .await;
        let connect = read_json(socket).await;
        assert_eq!(connect["method"], "connect");
        send_json(
            socket,
            json!({
                "type": "res", "id": connect["id"], "ok": true,
                "payload": {
                    "type": "hello-ok", "protocol": 4,
                    "server": {"version": crate::gateway::wire::OPENCLAW_GATEWAY_VERSION, "connId": "fixture"},
                    "features": {
                        "methods": [
                            "status",
                            "config.get",
                            "config.patch",
                            "config.set",
                            "config.apply",
                            "plugins.refresh",
                            "agents.list",
                            "skills.status",
                            "channels.pairing.list",
                            "sessions.describe",
                            crate::gateway::wire::SYSTEM_PRESENCE_METHOD
                        ],
                        "events": ["tick"]
                    },
                    "snapshot": {
                        "presence": [], "health": {"ok": true},
                        "stateVersion": {"presence": 1, "health": 1}, "uptimeMs": 1
                    },
                    "auth": {
                        "role": "operator",
                        "scopes": ["operator.read", "operator.write", "operator.admin", "operator.approvals"]
                    },
                    "policy": {
                        "maxPayload": 26214400, "maxBufferedBytes": 52428800,
                        "tickIntervalMs": 15000
                    }
                }
            }),
        )
        .await;
    }

    fn config_snapshot(config: Value, hash: &str) -> Value {
        config_snapshot_with_runtime(config.clone(), config, hash)
    }

    fn config_snapshot_with_runtime(source: Value, runtime: Value, hash: &str) -> Value {
        json!({
            "path": "openclaw.json",
            "exists": true,
            "raw": source.to_string(),
            "parsed": source.clone(),
            "sourceConfig": source,
            "resolved": runtime.clone(),
            "valid": true,
            "runtimeConfig": runtime.clone(),
            "config": runtime,
            "hash": hash,
            "issues": [],
            "warnings": [],
            "legacyIssues": []
        })
    }

    async fn assert_no_config_patch(socket: &mut TestSocket) {
        match timeout(Duration::from_millis(50), socket.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                let value: Value = serde_json::from_str(text.as_str()).unwrap();
                assert_ne!(value["method"], "config.patch");
            }
            Ok(_) | Err(_) => {}
        }
    }

    async fn read_json(socket: &mut TestSocket) -> Value {
        let Message::Text(text) = socket.next().await.unwrap().unwrap() else {
            panic!("expected text frame");
        };
        serde_json::from_str(text.as_str()).unwrap()
    }

    async fn send_json(socket: &mut TestSocket, value: Value) {
        socket
            .send(Message::Text(value.to_string().into()))
            .await
            .unwrap();
    }
}
