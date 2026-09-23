use std::time::{SystemTime, UNIX_EPOCH};

use platform::module::{
    CapabilityKey, EffectKind, ModuleDescriptor, ModuleId, PrivateControlCatalogSnapshot,
    PrivateControlDescriptor, PrivateControlProvider,
};
use serde_json::{Map, Value, json};

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
const INVALID_INPUT_MESSAGE: &str = "Runtime Host command input is invalid.";
const HOST_HEALTH_DESCRIPTOR: PrivateControlDescriptor =
    PrivateControlDescriptor::new(HOST_HEALTH, false);
const HOST_RUNTIME_SNAPSHOT_DESCRIPTOR: PrivateControlDescriptor =
    PrivateControlDescriptor::new(HOST_RUNTIME_SNAPSHOT, false);
const COMMANDS: &[PrivateControlDescriptor] =
    &[HOST_HEALTH_DESCRIPTOR, HOST_RUNTIME_SNAPSHOT_DESCRIPTOR];

#[derive(Clone)]
pub(crate) struct PrivateControlRegistry {
    snapshot: PrivateControlCatalogSnapshot,
}

impl PrivateControlRegistry {
    pub(crate) fn from_snapshot(snapshot: PrivateControlCatalogSnapshot) -> Self {
        Self { snapshot }
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
            _ => invalid_input(),
        }
    }
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
            vec![("host.health", false), ("host.runtime.snapshot", false)]
        );
    }
}
