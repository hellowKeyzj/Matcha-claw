use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use platform::module::{
    CapabilityKey, EffectKind, ModuleDescriptor, ModuleId, PrivateControlCatalogSnapshot,
    PrivateControlDescriptor, PrivateControlProvider,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};

#[path = "../bootstrap/world.rs"]
mod initial_world;

use crate::composition::host::ports::world_storage::DurableWorldStorage;
use initial_world::{EvaluationConfigurationWire, InitialWorldWire};

use crate::{
    RuntimeState,
    composition::PeerHandle,
    control::{CommandOutcome, RejectionCode},
    host_actor::Handle,
};

const MODULE_ID: ModuleId = ModuleId::new("host-system-control");
const PROVIDES: &[CapabilityKey] = &[];
const REQUIRES: &[CapabilityKey] = &[];
const EFFECTS: &[EffectKind] = &[];
const ROUTES: &[&str] = &[];
const EVENTS: &[&str] = &[];
const HOST_HEALTH: &str = "host.health";
const HOST_RUNTIME_SNAPSHOT: &str = "host.runtime.snapshot";
const WORLD_STORAGE_CONNECT: &str = "world.storage.connect";
const WORLD_INITIAL_PREPARE: &str = "world.initial.prepare";
const WORLD_INITIAL_PROVISION: &str = "world.initial.provision";
const WORLD_ACCESS_GRANT: &str = "world.access.grant";
const WORLD_EVALUATION_PREPARE: &str = "world.evaluation.prepare";
const WORLD_EVALUATION_INSTALL: &str = "world.evaluation.install";
const WORLD_EVALUATION_STATUS: &str = "world.evaluation.status";
const WORLD_TRANSFER_PREPARE: &str = "world.storage.transfer.prepare";
const WORLD_TRANSFER: &str = "world.storage.transfer";
const INVALID_INPUT_MESSAGE: &str = "Runtime Host command input is invalid.";
const HOST_HEALTH_DESCRIPTOR: PrivateControlDescriptor =
    PrivateControlDescriptor::new(HOST_HEALTH, false);
const HOST_RUNTIME_SNAPSHOT_DESCRIPTOR: PrivateControlDescriptor =
    PrivateControlDescriptor::new(HOST_RUNTIME_SNAPSHOT, false);
const COMMANDS: &[PrivateControlDescriptor] = &[
    HOST_HEALTH_DESCRIPTOR,
    HOST_RUNTIME_SNAPSHOT_DESCRIPTOR,
    PrivateControlDescriptor::new(WORLD_STORAGE_CONNECT, true),
    PrivateControlDescriptor::new(WORLD_INITIAL_PREPARE, true),
    PrivateControlDescriptor::new(WORLD_INITIAL_PROVISION, true),
    PrivateControlDescriptor::new(WORLD_ACCESS_GRANT, true),
    PrivateControlDescriptor::new(WORLD_EVALUATION_PREPARE, true),
    PrivateControlDescriptor::new(WORLD_EVALUATION_INSTALL, true),
    PrivateControlDescriptor::new(WORLD_EVALUATION_STATUS, true),
    PrivateControlDescriptor::new(WORLD_TRANSFER_PREPARE, true),
    PrivateControlDescriptor::new(WORLD_TRANSFER, true),
];

#[derive(Clone)]
pub(crate) struct PrivateControlRegistry {
    snapshot: PrivateControlCatalogSnapshot,
    world: world::WorldHandle,
    world_authority: Arc<world::AuthorityRoot>,
    world_storage: Result<Arc<DurableWorldStorage>, world::StoreError>,
}

impl PrivateControlRegistry {
    pub(crate) fn from_snapshot(
        snapshot: PrivateControlCatalogSnapshot,
        world: world::WorldHandle,
        world_authority: Arc<world::AuthorityRoot>,
        world_storage: Result<Arc<DurableWorldStorage>, world::StoreError>,
    ) -> Self {
        Self {
            snapshot,
            world,
            world_authority,
            world_storage,
        }
    }

    pub(crate) async fn execute(
        &self,
        owner: &Handle,
        peer: &PeerHandle,
        command: crate::control::wire::Command,
    ) -> CommandOutcome {
        let Some(descriptor) = self.snapshot.find(command.name()) else {
            return invalid_input();
        };
        if descriptor.accepts_input() != command.input().is_some() {
            return invalid_input();
        }
        match descriptor.name() {
            HOST_HEALTH => host_health(owner),
            HOST_RUNTIME_SNAPSHOT => runtime_snapshot(owner, peer).await,
            WORLD_STORAGE_CONNECT => {
                let Some(input) = command.input().and_then(|input| serde_json::from_value::<StorageConnect>(input.0.clone()).ok()) else {
                    return invalid_input();
                };
                let result = async {
                    let configuration = crate::composition::host::ports::postgres::inspection(input.connection_string.clone())?;
                    match self.world.inspect_storage(&self.world_authority, configuration).await? {
                        Some(storage_id) => {
                            let storage = self.world_storage.as_ref().map_err(Clone::clone)?;
                            storage.stage_existing(&self.world_authority,
                                crate::WorldPostgresConfig::new(storage_id.clone(), input.connection_string))?;
                            let worlds = self.world.open_storage(&self.world_authority, storage_id.clone()).await?;
                            Ok::<_, world::Error>(json!({ "kind": "existing", "storageId": storage_id, "worlds": worlds }))
                        }
                        None => {
                            let storage_id = uuid::Uuid::new_v4().to_string();
                            let configuration = InitialWorldWire::desktop(storage_id.clone());
                            Ok(json!({ "kind": "fresh", "storageId": storage_id, "safeSummary": configuration.safe_summary(), "configuration": configuration }))
                        }
                    }
                }.await;
                world_outcome(result)
            }
            WORLD_INITIAL_PREPARE => {
                let Some(input) = command.input().and_then(|input| {
                    serde_json::from_value::<InitialWorldPrepare>(input.0.clone()).ok()
                }) else {
                    return invalid_input();
                };
                let Some(prepared) = prepare_initial_world(input) else {
                    return invalid_input();
                };
                CommandOutcome::succeeded(json!({ "success": true, "data": prepared }))
            }
            WORLD_INITIAL_PROVISION => {
                let Some(input) = command.input().and_then(|input| {
                    serde_json::from_value::<InitialWorldProvision>(input.0.clone()).ok()
                }) else {
                    return invalid_input();
                };
                if input.configuration.storage_id() != input.storage.storage_id
                    || DurableWorldStorage::validate_storage_id(&input.storage.storage_id).is_err()
                {
                    return invalid_input();
                }
                let Ok(provision) = input.configuration.into_provision() else {
                    return invalid_input();
                };
                let result = async {
                    let storage = self.world_storage.as_ref().map_err(Clone::clone)?;
                    storage.stage(
                        &self.world_authority,
                        crate::WorldPostgresConfig::new(
                            input.storage.storage_id,
                            input.storage.connection_string,
                        ),
                    )?;
                    self.world.provision(&self.world_authority, provision).await
                }
                .await;
                world_outcome(result)
            }
            WORLD_ACCESS_GRANT => {
                let Some(input) = command.input().and_then(|input| {
                    serde_json::from_value::<world::GrantRequest>(input.0.clone()).ok()
                }) else {
                    return invalid_input();
                };
                world_outcome(self.world.grant_access(&self.world_authority, input).await)
            }
            WORLD_EVALUATION_PREPARE => {
                let Some(input) = command.input().and_then(|input| {
                    serde_json::from_value::<EvaluationPrepare>(input.0.clone()).ok()
                }) else {
                    return invalid_input();
                };
                let Some(prepared) = prepare_evaluation(input, &self.world_authority) else {
                    return invalid_input();
                };
                CommandOutcome::succeeded(json!({ "success": true, "data": prepared }))
            }
            WORLD_EVALUATION_INSTALL => {
                let Some(input) = command.input().and_then(|input| {
                    serde_json::from_value::<EvaluationConfigurationWire>(input.0.clone()).ok()
                }) else {
                    return invalid_input();
                };
                let Ok(input) = input.into_install() else {
                    return invalid_input();
                };
                world_outcome(
                    self.world
                        .install_evaluation(&self.world_authority, input)
                        .await,
                )
            }
            WORLD_EVALUATION_STATUS => {
                let Some(input) = command.input().and_then(|input| {
                    serde_json::from_value::<EvaluationStatusInput>(input.0.clone()).ok()
                }) else {
                    return invalid_input();
                };
                world_outcome(
                    self.world
                        .evaluation_status(&self.world_authority, input.world)
                        .await,
                )
            }
            WORLD_TRANSFER_PREPARE => {
                let Some(input) = command.input().and_then(|input| {
                    serde_json::from_value::<world::StorageTransferPrepare>(input.0.clone()).ok()
                }) else {
                    return invalid_input();
                };
                world_outcome(
                    self.world
                        .prepare_storage_transfer(&self.world_authority, input)
                        .await,
                )
            }
            WORLD_TRANSFER => {
                let Some(input) = command.input().and_then(|input| {
                    serde_json::from_value::<world::StorageTransferRequest>(input.0.clone()).ok()
                }) else {
                    return invalid_input();
                };
                world_outcome(
                    self.world
                        .transfer_storage(&self.world_authority, input)
                        .await,
                )
            }
            _ => invalid_input(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StorageConnect {
    connection_string: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InitialWorldPrepare {
    storage_id: String,
    configuration: Map<String, Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InitialWorldProvision {
    storage: InitialWorldStorage,
    configuration: InitialWorldWire,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InitialWorldStorage {
    storage_id: String,
    connection_string: String,
}

fn prepare_initial_world(input: InitialWorldPrepare) -> Option<Value> {
    DurableWorldStorage::validate_storage_id(&input.storage_id).ok()?;
    let mut configuration = input.configuration;
    if configuration.contains_key("storageId") {
        return None;
    }
    configuration.insert("storageId".into(), Value::String(input.storage_id));
    let wire: InitialWorldWire = serde_json::from_value(Value::Object(configuration)).ok()?;
    let safe_summary = wire.safe_summary();
    let configuration = serde_json::to_value(&wire).ok()?;
    wire.into_provision().ok()?;
    Some(json!({ "configuration": configuration, "safeSummary": safe_summary }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EvaluationPrepare {
    world: world_protocol::ids::WorldRef,
    configuration: Map<String, Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EvaluationStatusInput {
    world: world_protocol::ids::WorldRef,
}

fn prepare_evaluation(input: EvaluationPrepare, root: &Arc<world::AuthorityRoot>) -> Option<Value> {
    let configuration = Value::Object(input.configuration);
    let wire: EvaluationConfigurationWire = serde_json::from_value(configuration.clone()).ok()?;
    if wire.world() != &input.world {
        return None;
    }
    let safe_summary = wire.safe_summary();
    let installation = wire.into_install().ok()?;
    // Pure configuration validation, not a durable availability or authorization check.
    root.evaluation_authority(input.world, &installation.evaluation)
        .ok()?;
    Some(json!({ "configuration": configuration, "safeSummary": safe_summary }))
}

pub(crate) fn descriptor() -> ModuleDescriptor {
    ModuleDescriptor::with_private_control(
        MODULE_ID,
        PROVIDES,
        REQUIRES,
        EFFECTS,
        ROUTES,
        EVENTS,
        None,
        Some(PrivateControlProvider::new(COMMANDS)),
    )
}

fn invalid_input() -> CommandOutcome {
    CommandOutcome::rejected(RejectionCode::InvalidInput, INVALID_INPUT_MESSAGE)
}

fn world_outcome<T: serde::Serialize>(result: Result<T, world::Error>) -> CommandOutcome {
    match result {
        Ok(data) => CommandOutcome::succeeded(json!({ "success": true, "data": data })),
        Err(error) => {
            use world_protocol::{
                api::ApiFailure, commit::CommitFailure, operation::OperationFailure,
            };
            let failure = error.safe_failure();
            let result = json!({ "success": false, "error": failure });
            if matches!(
                failure.details,
                ApiFailure::Operation(OperationFailure::Commit(
                    CommitFailure::CommitIndeterminate { .. }
                        | CommitFailure::TransferIndeterminate { .. }
                ))
            ) {
                CommandOutcome::unknown(result)
            } else {
                CommandOutcome::succeeded(result)
            }
        }
    }
}

fn host_health(owner: &Handle) -> CommandOutcome {
    let state = owner.state();
    let safe_matcha = runtime_state_json(state.matcha());
    let safe_open_claw = runtime_state_json(state.open_claw());
    CommandOutcome::succeeded(json!({
        "state": {
            "ok": state.ok(),
            "lifecycle": state.lifecycle(),
            "matcha": safe_matcha,
            "openClaw": safe_open_claw,
        },
        "health": {
            "ok": state.ok(),
            "lifecycle": state.lifecycle(),
            "matcha": safe_matcha,
            "openClaw": safe_open_claw,
        },
    }))
}

async fn runtime_snapshot(owner: &Handle, peer: &PeerHandle) -> CommandOutcome {
    let observed_at_ms = observed_at_ms();
    let state = owner.state();
    let gateway = peer.open_claw_gateway_snapshot().await;
    let control = peer.open_claw_control_snapshot().await;
    let safe_matcha = runtime_state_json(state.matcha());
    let safe_open_claw = runtime_state_json(state.open_claw());
    CommandOutcome::succeeded(json!({
        "state": {
            "ok": state.ok(),
            "lifecycle": state.lifecycle(),
            "matcha": safe_matcha,
            "openClaw": safe_open_claw,
        },
        "health": {
            "ok": state.ok(),
            "lifecycle": state.lifecycle(),
            "matcha": safe_matcha,
            "openClaw": safe_open_claw,
        },
        "gateway": gateway,
        "control": control,
        "observedAtMs": observed_at_ms,
    }))
}

fn runtime_state_json(state: &RuntimeState) -> Value {
    Value::Object(runtime_state_object(state))
}

fn runtime_state_object(state: &RuntimeState) -> Map<String, Value> {
    let mut result = Map::new();
    result.insert("lifecycle".into(), json!(state.lifecycle()));
    if let Some(failure) = state.failure() {
        result.insert("failure".into(), json!(failure));
    }
    if let Some(diagnostic) = state.startup_diagnostic() {
        result.insert("startupDiagnostic".into(), json!(diagnostic));
    }
    result
}

fn observed_at_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_private_control_descriptor_advertises_host_commands() {
        let descriptor = descriptor();
        let provider = descriptor
            .private_control()
            .expect("system private control provider");
        assert_eq!(
            provider
                .descriptors()
                .iter()
                .map(|descriptor| (descriptor.name(), descriptor.accepts_input()))
                .collect::<Vec<_>>(),
            vec![
                ("host.health", false),
                ("host.runtime.snapshot", false),
                ("world.initial.prepare", true),
                ("world.initial.provision", true),
                ("world.storage.transfer.prepare", true),
                ("world.storage.transfer", true),
            ]
        );
    }
}
