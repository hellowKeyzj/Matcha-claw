use super::*;
use crate::{
    gateway::config_patch::{destructive_array_replace_paths, merge_patch},
    native_config::config_store::{
        OpenClawConfigDocument, OpenClawConfigMutation, OpenClawConfigStore,
    },
};

struct ConfigConflict;

impl ChannelConfigOperation {
    pub(super) async fn mutate_config(
        &self,
        mut mutate: impl FnMut(
            &mut Value,
        ) -> Result<
            Option<ConfigMutationReadbackTarget>,
            ChannelConfigMutationOutcome,
        >,
    ) -> ChannelConfigMutationOutcome {
        let started = Instant::now();
        channel_trace(
            "mutation.begin",
            &format!(
                "path={}",
                if self.runtime_running {
                    "gateway"
                } else {
                    "local"
                }
            ),
        );
        let outcome = async {
            if !self.runtime_running {
                let Some(state_dir) = &self.state_dir else {
                    return ChannelConfigMutationOutcome::Unknown;
                };
                let mut preflight_outcome = None;
                let native_started = Instant::now();
                channel_trace("native.update.begin", "path=local");
                let result =
                    OpenClawConfigStore::new(state_dir.clone()).update_private_document(|stored| {
                        channel_trace(
                            "native.read.end",
                            &format!(
                                "outcome=success elapsedMs={}",
                                native_started.elapsed().as_millis()
                            ),
                        );
                        let mut document = stored.as_value();
                        if let Err(outcome) = mutate(&mut document) {
                            zeroize_value(&mut document);
                            preflight_outcome = Some(outcome);
                            return OpenClawConfigMutation::unchanged();
                        }
                        let mut previous = stored.as_value();
                        let unchanged = document == previous;
                        zeroize_value(&mut previous);
                        if unchanged {
                            channel_trace("mutation.noop", "path=local reason=unchanged");
                            zeroize_value(&mut document);
                            return OpenClawConfigMutation::unchanged();
                        }
                        *stored = OpenClawConfigDocument::from_value(document)
                            .expect("channel mutation preserves document object");
                        channel_trace("native.write.begin", "path=local");
                        OpenClawConfigMutation::changed()
                    });
                match &result {
                    Ok(update) => channel_trace(
                        "native.update.end",
                        &format!(
                            "changed={} elapsedMs={}",
                            update.changed,
                            native_started.elapsed().as_millis()
                        ),
                    ),
                    // This closed enum contains no native paths, payloads or raw errors.
                    Err(error) => channel_trace(
                        "native.update.end",
                        &format!(
                            "code={error:?} elapsedMs={}",
                            native_started.elapsed().as_millis()
                        ),
                    ),
                }
                if let Some(outcome) = preflight_outcome {
                    return outcome;
                }
                return match result {
                    Ok(update) if update.changed => ChannelConfigMutationOutcome::Confirmed,
                    Ok(_) => ChannelConfigMutationOutcome::Noop,
                    Err(_) => ChannelConfigMutationOutcome::Unknown,
                };
            }
            for attempt in 0..3 {
                channel_trace(
                    "config.get.begin",
                    &format!("path=gateway attempt={}", attempt + 1),
                );
                let get_started = Instant::now();
                let request = match wire::channel::config_get_request(next_request_id(
                    "channel-config-get",
                )) {
                    Ok(request) => request,
                    Err(_) => return ChannelConfigMutationOutcome::Unknown,
                };
                let response = read_gateway(&self.gateway, request).await;
                let result_code = match &response {
                    Ok(GatewayResponse::Failure { .. }) | Err(OperationsReadError::Rejected) => {
                        "Rejected"
                    }
                    Ok(_) => "response",
                    Err(OperationsReadError::Protocol) => "protocol",
                    Err(OperationsReadError::Unavailable) => "unavailable",
                };
                channel_trace(
                    "config.get.end",
                    &format!(
                        "outcome={result_code} elapsedMs={}",
                        get_started.elapsed().as_millis()
                    ),
                );
                let snapshot = match response {
                    Ok(GatewayResponse::Failure { .. }) => {
                        return ChannelConfigMutationOutcome::Rejected;
                    }
                    Ok(response) => match wire::channel::decode_config_snapshot(response) {
                        Ok(snapshot) => snapshot,
                        Err(_) => return ChannelConfigMutationOutcome::Unknown,
                    },
                    Err(_) => return ChannelConfigMutationOutcome::Unknown,
                };
                let mut document: Value = match serde_json::from_slice(&snapshot.source_document) {
                    Ok(document) => document,
                    Err(_) => return ChannelConfigMutationOutcome::Unknown,
                };
                let mut previous = document.clone();
                let preflight = mutate(&mut document);
                let unchanged = document == previous;
                let readback = match preflight {
                    Ok(readback) => readback,
                    Err(outcome) => {
                        zeroize_value(&mut previous);
                        zeroize_value(&mut document);
                        return outcome;
                    }
                };
                if unchanged {
                    channel_trace("mutation.noop", "path=gateway reason=unchanged");
                    zeroize_value(&mut previous);
                    zeroize_value(&mut document);
                    return ChannelConfigMutationOutcome::Noop;
                }
                let outcome = self
                    .commit_config(
                        &previous,
                        &document,
                        snapshot.base_hash.as_ref().map(|hash| hash.as_slice()),
                        readback.as_ref(),
                    )
                    .await;
                zeroize_value(&mut previous);
                zeroize_value(&mut document);
                match outcome {
                    Ok(outcome) => return outcome,
                    Err(ConfigConflict) => {
                        channel_trace(
                            "config.cas.conflict",
                            &format!("attempt={} retry={}", attempt + 1, attempt < 2),
                        );
                        continue;
                    }
                }
            }
            channel_trace("config.cas.exhausted", "attempts=3 outcome=Rejected");
            ChannelConfigMutationOutcome::Rejected
        }
        .await;
        trace_mutation_outcome("mutation.end", started, outcome);
        outcome
    }

    async fn commit_config(
        &self,
        current: &Value,
        document: &Value,
        base_hash: Option<&[u8]>,
        readback: Option<&ConfigMutationReadbackTarget>,
    ) -> Result<ChannelConfigMutationOutcome, ConfigConflict> {
        if base_hash.is_some_and(|base_hash| std::str::from_utf8(base_hash).is_err()) {
            return Ok(ChannelConfigMutationOutcome::Unknown);
        }
        let encoded = if let Some(base_hash) = base_hash {
            let mut patch = merge_patch(current, document);
            let replace_paths = destructive_array_replace_paths(current, document);
            let raw = match serde_json::to_string(&patch) {
                Ok(raw) => Zeroizing::new(raw.into_bytes()),
                Err(_) => return Ok(ChannelConfigMutationOutcome::Unknown),
            };
            zeroize_value(&mut patch);
            let request = match wire::channel::config_patch_request(
                next_request_id("channel-config-patch"),
                raw,
                Zeroizing::new(base_hash.to_vec()),
                replace_paths,
            ) {
                Ok(request) => request,
                Err(_) => return Ok(ChannelConfigMutationOutcome::Unknown),
            };
            let request_id = request.request_id().to_owned();
            match request.encode() {
                Ok(encoded) => (request_id, encoded, "config.patch"),
                Err(_) => return Ok(ChannelConfigMutationOutcome::Unknown),
            }
        } else {
            let raw = match serde_json::to_string(document) {
                Ok(raw) => raw,
                Err(_) => return Ok(ChannelConfigMutationOutcome::Unknown),
            };
            let document = match wire::team::ConfigDocument::new(raw) {
                Ok(document) => document,
                Err(_) => return Ok(ChannelConfigMutationOutcome::Unknown),
            };
            let request = match wire::team::config_set_request(
                next_request_id("channel-config-set"),
                document,
                None,
            ) {
                Ok(request) => request,
                Err(_) => return Ok(ChannelConfigMutationOutcome::Unknown),
            };
            let request_id = request.request_id().to_owned();
            match request.encode() {
                Ok(encoded) => (request_id, encoded, "config.set"),
                Err(_) => return Ok(ChannelConfigMutationOutcome::Unknown),
            }
        };
        let (request_id, encoded, method) = encoded;
        let started = Instant::now();
        channel_trace(&format!("{method}.begin"), "path=gateway");
        let delivery = self.gateway.rpc_encoded_mutation(request_id, encoded).await;
        let delivery_code = match &delivery {
            MutationDelivery::Response(GatewayResponse::Failure { .. }) => "Rejected",
            MutationDelivery::Response(_) => "response",
            MutationDelivery::NotWritten(_) => "NotWritten",
            MutationDelivery::MayHaveReached(_) => "MayHaveReached",
        };
        channel_trace(
            &format!("{method}.end"),
            &format!(
                "delivery={delivery_code} elapsedMs={}",
                started.elapsed().as_millis()
            ),
        );
        Ok(match delivery {
            MutationDelivery::Response(GatewayResponse::Failure { error, .. }) => {
                if method == "config.patch" && wire::channel::is_config_conflict(&error) {
                    return Err(ConfigConflict);
                }
                if method == "config.patch" && wire::channel::is_config_restart_required(&error) {
                    return Ok(ChannelConfigMutationOutcome::RestartRequired);
                }
                ChannelConfigMutationOutcome::Rejected
            }
            MutationDelivery::Response(response) => {
                if method == "config.patch" {
                    match wire::channel::decode_channel_config_patch(response) {
                        Ok(wire::channel::ChannelConfigPatchOutcome::Written) => {
                            ChannelConfigMutationOutcome::Confirmed
                        }
                        Ok(wire::channel::ChannelConfigPatchOutcome::Noop) => {
                            ChannelConfigMutationOutcome::Noop
                        }
                        Ok(wire::channel::ChannelConfigPatchOutcome::RestartRequired) => {
                            ChannelConfigMutationOutcome::RestartRequired
                        }
                        Err(_) => ChannelConfigMutationOutcome::Unknown,
                    }
                } else {
                    match wire::team::decode_config_set(response) {
                        Ok(_) => ChannelConfigMutationOutcome::Confirmed,
                        Err(_) => ChannelConfigMutationOutcome::Unknown,
                    }
                }
            }
            MutationDelivery::NotWritten(error) => {
                channel_trace(&format!("{method}.not_written"), &format!("code={error:?}"));
                ChannelConfigMutationOutcome::Unknown
            }
            MutationDelivery::MayHaveReached(error) => {
                channel_trace(
                    &format!("{method}.may_have_reached"),
                    &format!("code={error:?}"),
                );
                let Some(readback) = readback else {
                    return Ok(ChannelConfigMutationOutcome::Unknown);
                };
                let Ok(request) =
                    wire::channel::config_get_request(next_request_id("channel-config-readback"))
                else {
                    return Ok(ChannelConfigMutationOutcome::Unknown);
                };
                let read_started = Instant::now();
                channel_trace("config.readback.begin", "path=gateway");
                let response = read_gateway(&self.gateway, request).await;
                channel_trace(
                    "config.readback.end",
                    &format!(
                        "path=gateway responseReceived={} elapsedMs={}",
                        response.is_ok(),
                        read_started.elapsed().as_millis()
                    ),
                );
                let Ok(response) = response else {
                    return Ok(ChannelConfigMutationOutcome::Unknown);
                };
                let Ok(mut persisted) = decode_read_snapshot(response) else {
                    channel_trace("config.readback.decode", "outcome=failed");
                    return Ok(ChannelConfigMutationOutcome::Unknown);
                };
                let matches = readback.matches(&persisted);
                zeroize_value(&mut persisted);
                channel_trace(
                    "config.readback.compare",
                    &format!("path=gateway matches={matches}"),
                );
                if matches {
                    ChannelConfigMutationOutcome::Confirmed
                } else {
                    ChannelConfigMutationOutcome::Unknown
                }
            }
        })
    }
}

pub(super) fn configure(
    document: &mut Value,
    channel: &str,
    account: &str,
    target: &Value,
    plugin: Option<&str>,
    agent: Option<&str>,
) -> ConfigureConfigReadbackTarget {
    let plugins = plugin.map(|id| account_configure_plugin_target(document, id));
    if !document.get("channels").is_some_and(Value::is_object) {
        document["channels"] = serde_json::json!({});
    }
    if !document["channels"]
        .get(channel)
        .is_some_and(Value::is_object)
    {
        document["channels"][channel] = serde_json::json!({});
    }
    if !document["channels"][channel]
        .get("accounts")
        .is_some_and(Value::is_object)
    {
        document["channels"][channel]["accounts"] = serde_json::json!({});
    }
    let account_config = &mut document["channels"][channel]["accounts"][account];
    if !account_config.is_object() {
        *account_config = serde_json::json!({});
    }
    let account_config = account_config.as_object_mut().unwrap();
    for (key, value) in target.as_object().expect("validated account patch") {
        insert_zeroizing(account_config, key.clone(), value.clone());
    }
    if let Some(plugins) = plugins {
        document["plugins"] = plugins;
    }
    ensure_binding(document, channel, account, agent);
    configure_config_readback(document, channel, account, plugin)
}

pub(super) fn delete(
    document: &mut Value,
    channel: &str,
    account: Option<&str>,
    remove_channel: bool,
) {
    let plan = if remove_channel || account.is_none() {
        Some(delete_last_account_config_plan(document, channel))
    } else if channel == "openclaw-weixin" {
        if let Some(accounts) = document
            .get_mut("channels")
            .and_then(|channels| channels.get_mut(channel))
            .and_then(|section| section.get_mut("accounts"))
            .and_then(Value::as_object_mut)
        {
            if let Some(mut removed) = account.and_then(|account| accounts.remove(account)) {
                zeroize_value(&mut removed);
            }
        }
        None
    } else {
        account.and_then(|account| account_config_delete_plan(document, channel, account))
    };
    if let Some(plan) = plan {
        if let Some(target) = &plan.readback {
            if let Some(channels) = document.get_mut("channels").and_then(Value::as_object_mut) {
                match &target.channel {
                    ExpectedConfigValue::Absent => {
                        if let Some(mut removed) = channels.remove(channel) {
                            zeroize_value(&mut removed);
                        }
                    }
                    ExpectedConfigValue::Present(value) => {
                        insert_zeroizing(channels, channel.into(), value.clone());
                    }
                }
            }
            if let Some(plugins) = &target.plugins {
                match plugins {
                    ExpectedConfigValue::Absent => {
                        if let Some(mut removed) =
                            document.as_object_mut().unwrap().remove("plugins")
                        {
                            zeroize_value(&mut removed);
                        }
                    }
                    ExpectedConfigValue::Present(value) => {
                        document["plugins"] = value.clone();
                    }
                }
            }
        }
    }
    let account = if select_channel_config(document, channel).is_none() {
        None
    } else {
        account
    };
    if let Some(bindings) = document.get_mut("bindings").and_then(Value::as_array_mut) {
        bindings.retain(|binding| {
            let Some(matched) = binding.get("match") else {
                return true;
            };
            matched.get("channel").and_then(Value::as_str) != Some(channel)
                || account.is_some_and(|account| {
                    matched.get("accountId").and_then(Value::as_str) != Some(account)
                })
        });
        if bindings.is_empty() {
            document.as_object_mut().unwrap().remove("bindings");
        }
    }
}

pub(super) fn is_simple_binding(binding: &Value, channel: &str, account: Option<&str>) -> bool {
    let Some(matched) = binding.get("match").and_then(Value::as_object) else {
        return false;
    };
    binding.get("agentId").and_then(Value::as_str).is_some()
        && matched.get("channel").and_then(Value::as_str) == Some(channel)
        && matched
            .keys()
            .all(|key| matches!(key.as_str(), "channel" | "accountId"))
        && matched
            .get("accountId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            == account
}

fn upsert(bindings: &mut Vec<Value>, channel: &str, account: &str, agent: &str) {
    let matching = bindings
        .iter()
        .filter(|binding| is_simple_binding(binding, channel, Some(account)))
        .collect::<Vec<_>>();
    if matching.len() == 1 && matching[0].get("agentId").and_then(Value::as_str) == Some(agent) {
        return;
    }
    bindings.retain(|binding| !is_simple_binding(binding, channel, Some(account)));
    bindings
        .push(serde_json::json!({"agentId":agent,"match":{"channel":channel,"accountId":account}}));
}

pub(super) fn has_account_binding(bindings: &[Value], channel: &str, account: &str) -> bool {
    bindings
        .iter()
        .any(|binding| is_simple_binding(binding, channel, Some(account)))
}

pub(super) fn is_wildcard_account_binding(binding: &Value, channel: &str) -> bool {
    let Some(matched) = binding.get("match").and_then(Value::as_object) else {
        return false;
    };
    binding.get("agentId").and_then(Value::as_str).is_some()
        && matched.get("channel").and_then(Value::as_str) == Some(channel)
        && matched.get("accountId").and_then(Value::as_str) == Some("*")
        && matched
            .keys()
            .all(|key| matches!(key.as_str(), "channel" | "accountId"))
}

pub(super) fn has_wildcard_account_binding(bindings: &[Value], channel: &str) -> bool {
    bindings
        .iter()
        .any(|binding| is_wildcard_account_binding(binding, channel))
}

fn channel_binding_agent(bindings: &[Value], channel: &str) -> Option<String> {
    bindings
        .iter()
        .rev()
        .find(|binding| is_simple_binding(binding, channel, None))
        .and_then(|binding| binding.get("agentId"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn ensure_binding(document: &mut Value, channel: &str, account: &str, agent: Option<&str>) {
    channel_trace("binding.prepare", "outcome=begin persisted=false");
    let mut bindings = document
        .get("bindings")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    if let Some(owner) = channel_binding_agent(&bindings, channel) {
        upsert(&mut bindings, channel, DEFAULT_ACCOUNT_ID, &owner);
        bindings.retain(|binding| !is_simple_binding(binding, channel, None));
    }
    if let Some(agent) = agent {
        upsert(&mut bindings, channel, account, agent);
    } else if !has_account_binding(&bindings, channel, account)
        && !has_wildcard_account_binding(&bindings, channel)
    {
        upsert(&mut bindings, channel, account, "main");
    }
    channel_trace(
        "binding.prepare",
        &format!(
            "outcome=prepared bindingCount={} persisted=false",
            bindings.len()
        ),
    );
    document["bindings"] = Value::Array(bindings);
}
