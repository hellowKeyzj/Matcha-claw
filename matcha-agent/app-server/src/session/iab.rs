use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::watch;
use uuid::Uuid;
use zeroize::Zeroize;

use crate::rpc::{self, Error};

const WAIT_WINDOW: Duration = Duration::from_secs(20);
const DRAIN_WINDOW: Duration = Duration::from_secs(5);

#[derive(Clone, Default)]
pub(crate) struct Owner(Arc<Shared>);

struct Shared {
    state: Mutex<State>,
    changed: watch::Sender<()>,
}

impl Default for Shared {
    fn default() -> Self {
        Self {
            state: Mutex::new(State::default()),
            changed: watch::channel(()).0,
        }
    }
}

#[derive(Default)]
struct State {
    instances: BTreeMap<String, Instance>,
    peers: BTreeMap<String, BTreeMap<String, Invocation>>,
    shutting_down: bool,
}

struct Instance {
    capability: Capability,
    agent_id: String,
    workspace: String,
    admitted: bool,
    revoked: Option<Reason>,
    abandoned: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Capability {
    session_id: String,
    instance_id: String,
    token: String,
}

impl Drop for Capability {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}

struct Invocation {
    instance_id: Option<String>,
    lease_id: Option<String>,
    released: bool,
    waiting: bool,
}

#[derive(Clone, Copy)]
pub(crate) enum Reason {
    Closing,
    Replaced,
    Exit,
    IdentityChanged,
    Shutdown,
}

impl Reason {
    fn as_str(self) -> &'static str {
        match self {
            Self::Closing => "instance_closing",
            Self::Replaced => "instance_replaced",
            Self::Exit => "native_exit",
            Self::IdentityChanged => "native_identity_changed",
            Self::Shutdown => "server_shutdown",
        }
    }
}

pub(crate) struct InstanceGuard {
    owner: Owner,
    instance_id: String,
}

pub(crate) struct Peer {
    owner: Owner,
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Acquire {
    capability: Capability,
    invocation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Wait {
    lease_id: String,
    invocation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Release {
    invocation_id: String,
    lease_id: Option<String>,
    drained: bool,
}

impl Owner {
    pub(crate) fn register(
        &self,
        agent_id: &str,
        session_id: &str,
        instance_id: &str,
        workspace: &std::path::Path,
    ) -> rpc::Result<InstanceGuard> {
        let workspace = workspace
            .to_str()
            .ok_or_else(|| Error::invalid("IAB workspace requires Unicode"))?;
        let mut state = self.0.state.lock().expect("IAB owner lock");
        if state.shutting_down {
            return Err(revoked());
        }
        for instance in state
            .instances
            .values_mut()
            .filter(|instance| instance.capability.session_id == session_id)
        {
            instance.revoked.get_or_insert(Reason::Replaced);
        }
        self.0.changed.send_replace(());
        if state.instances.iter().any(|(id, instance)| {
            instance.capability.session_id == session_id && !drained(&state, id)
        }) {
            return Err(Error::unavailable(
                "iab_lease_revoked",
                "Previous browser invocations have not drained",
            )
            .with_data(json!({"cleanupComplete": false})));
        }
        state.instances.insert(
            instance_id.to_owned(),
            Instance {
                capability: Capability {
                    session_id: session_id.to_owned(),
                    instance_id: instance_id.to_owned(),
                    token: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
                },
                agent_id: agent_id.to_owned(),
                workspace: workspace.to_owned(),
                admitted: false,
                revoked: None,
                abandoned: false,
            },
        );
        Ok(InstanceGuard {
            owner: self.clone(),
            instance_id: instance_id.to_owned(),
        })
    }

    pub(crate) fn peer(&self) -> Peer {
        let id = Uuid::new_v4().to_string();
        self.0
            .state
            .lock()
            .expect("IAB owner lock")
            .peers
            .insert(id.clone(), BTreeMap::new());
        Peer {
            owner: self.clone(),
            id,
        }
    }

    pub(crate) fn shutdown(&self) {
        let mut state = self.0.state.lock().expect("IAB owner lock");
        state.shutting_down = true;
        for instance in state.instances.values_mut() {
            instance.revoked.get_or_insert(Reason::Shutdown);
        }
        self.0.changed.send_replace(());
    }
}

impl InstanceGuard {
    pub(crate) fn capability(&self) -> Value {
        let state = self.owner.0.state.lock().expect("IAB owner lock");
        let capability = &state.instances[&self.instance_id].capability;
        json!({"sessionId": capability.session_id, "instanceId": capability.instance_id, "token": capability.token})
    }

    pub(crate) fn admit(&self) -> rpc::Result<()> {
        let mut state = self.owner.0.state.lock().expect("IAB owner lock");
        let instance = state
            .instances
            .get_mut(&self.instance_id)
            .ok_or_else(denied)?;
        if instance.revoked.is_some() {
            return Err(revoked());
        }
        instance.admitted = true;
        self.owner.0.changed.send_replace(());
        Ok(())
    }

    pub(crate) fn revoke(&self, reason: Reason) {
        let mut state = self.owner.0.state.lock().expect("IAB owner lock");
        if let Some(instance) = state.instances.get_mut(&self.instance_id) {
            instance.revoked.get_or_insert(reason);
        }
        self.owner.0.changed.send_replace(());
    }

    pub(crate) async fn drain(&self) -> rpc::Result<()> {
        let mut changes = self.owner.0.changed.subscribe();
        let pending = async {
            loop {
                {
                    let state = self.owner.0.state.lock().expect("IAB owner lock");
                    if drained(&state, &self.instance_id) {
                        return true;
                    }
                }
                if changes.changed().await.is_err() {
                    return false;
                }
            }
        };
        if !tokio::time::timeout(DRAIN_WINDOW, pending)
            .await
            .unwrap_or(false)
        {
            return Err(Error::unavailable(
                "iab_lease_revoked",
                "Browser invocation drain could not be confirmed",
            )
            .with_data(json!({"cleanupComplete": false})));
        }
        Ok(())
    }
}

impl Drop for InstanceGuard {
    fn drop(&mut self) {
        self.revoke(Reason::Closing);
        let mut state = self.owner.0.state.lock().expect("IAB owner lock");
        if drained(&state, &self.instance_id) {
            state.instances.remove(&self.instance_id);
        }
    }
}

impl Peer {
    pub(crate) async fn dispatch(&self, method: &str, params: Value) -> rpc::Result {
        match method {
            "iab.lease.acquire" => self.acquire(rpc::params(params)?).await,
            "iab.lease.wait" => self.wait(rpc::params(params)?).await,
            "iab.lease.release" => self.release(rpc::params(params)?),
            _ => Err(Error::method(method)),
        }
    }

    async fn acquire(&self, input: Acquire) -> rpc::Result {
        uuid(&input.invocation_id)?;
        uuid(&input.capability.session_id)?;
        uuid(&input.capability.instance_id)?;
        let mut changes = self.owner.0.changed.subscribe();
        {
            let mut state = self.owner.0.state.lock().expect("IAB owner lock");
            let calls = state.peers.get(&self.id).ok_or_else(peer_mismatch)?;
            if calls.contains_key(&input.invocation_id) {
                return Err(revoked());
            }
            let instance = state
                .instances
                .get(&input.capability.instance_id)
                .ok_or_else(denied)?;
            if !matches_capability(&instance.capability, &input.capability) {
                return Err(denied());
            }
            if instance.revoked.is_some() {
                return Err(revoked());
            }
            state
                .peers
                .get_mut(&self.id)
                .expect("live IAB peer")
                .insert(
                    input.invocation_id.clone(),
                    Invocation {
                        instance_id: Some(input.capability.instance_id.clone()),
                        lease_id: None,
                        released: false,
                        waiting: false,
                    },
                );
        }
        let admitted = async {
            loop {
                {
                    let mut state = self.owner.0.state.lock().expect("IAB owner lock");
                    let calls = state.peers.get(&self.id).ok_or_else(peer_mismatch)?;
                    let call = calls.get(&input.invocation_id).ok_or_else(unknown)?;
                    if call.released {
                        return Err(revoked());
                    }
                    let instance = state
                        .instances
                        .get(&input.capability.instance_id)
                        .ok_or_else(revoked)?;
                    if instance.revoked.is_some() {
                        return Err(revoked());
                    }
                    if instance.admitted {
                        let lease_id = Uuid::new_v4().to_string();
                        let result = json!({
                            "leaseId": lease_id, "invocationId": input.invocation_id,
                            "agentId": instance.agent_id, "sessionId": instance.capability.session_id,
                            "instanceId": instance.capability.instance_id, "workspaceDir": instance.workspace,
                        });
                        state
                            .peers
                            .get_mut(&self.id)
                            .expect("live IAB peer")
                            .get_mut(&input.invocation_id)
                            .expect("registered IAB invocation")
                            .lease_id = Some(lease_id);
                        return Ok(result);
                    }
                }
                changes.changed().await.map_err(|_| peer_mismatch())?;
            }
        };
        tokio::time::timeout(WAIT_WINDOW, admitted)
            .await
            .map_err(|_| {
                Error::unavailable(
                    "iab_native_not_admitted",
                    "Native session initialization was not observed",
                )
            })?
    }

    async fn wait(&self, input: Wait) -> rpc::Result {
        uuid(&input.invocation_id)?;
        uuid(&input.lease_id)?;
        let mut changes = self.owner.0.changed.subscribe();
        {
            let mut state = self.owner.0.state.lock().expect("IAB owner lock");
            let calls = state.peers.get_mut(&self.id).ok_or_else(peer_mismatch)?;
            let call = calls.get_mut(&input.invocation_id).ok_or_else(unknown)?;
            if call.lease_id.as_deref() != Some(&input.lease_id) {
                return Err(peer_mismatch());
            }
            if call.released {
                return Err(revoked());
            }
            if call.waiting {
                return Err(Error::conflict(
                    "iab_lease_wait_conflict",
                    "A browser lease waiter is already active",
                ));
            }
            call.waiting = true;
        }
        let _waiting = WaitGuard {
            owner: self.owner.clone(),
            peer: &self.id,
            invocation: &input.invocation_id,
        };
        let current = || -> rpc::Result<Option<Reason>> {
            let state = self.owner.0.state.lock().expect("IAB owner lock");
            let calls = state.peers.get(&self.id).ok_or_else(peer_mismatch)?;
            let call = calls.get(&input.invocation_id).ok_or_else(unknown)?;
            if call.released {
                return Err(revoked());
            }
            let instance = state
                .instances
                .get(call.instance_id.as_deref().ok_or_else(unknown)?)
                .ok_or_else(revoked)?;
            Ok(instance.revoked)
        };
        let pending = async {
            loop {
                if let Some(reason) = current()? {
                    return Ok::<_, Error>(Some(reason));
                }
                changes.changed().await.map_err(|_| peer_mismatch())?;
            }
        };
        let reason = match tokio::time::timeout(WAIT_WINDOW, pending).await {
            Ok(result) => result?,
            Err(_) => current()?,
        };
        Ok(match reason {
            Some(reason) => json!({"leaseId": input.lease_id, "invocationId": input.invocation_id,
                "state": "revoked", "reason": reason.as_str()}),
            None => {
                json!({"leaseId": input.lease_id, "invocationId": input.invocation_id, "state": "current"})
            }
        })
    }

    fn release(&self, input: Release) -> rpc::Result {
        uuid(&input.invocation_id)?;
        if let Some(lease_id) = &input.lease_id {
            uuid(lease_id)?;
        }
        if !input.drained {
            return Err(Error::invalid(
                "A browser invocation must be drained before release",
            ));
        }
        let mut state = self.owner.0.state.lock().expect("IAB owner lock");
        let calls = state.peers.get_mut(&self.id).ok_or_else(peer_mismatch)?;
        let lease_id = if let Some(call) = calls.get_mut(&input.invocation_id) {
            if input
                .lease_id
                .as_ref()
                .is_some_and(|id| call.lease_id.as_ref() != Some(id))
            {
                return Err(peer_mismatch());
            }
            call.released = true;
            call.lease_id.clone()
        } else {
            if input.lease_id.is_some() {
                return Err(unknown());
            }
            calls.insert(
                input.invocation_id.clone(),
                Invocation {
                    instance_id: None,
                    lease_id: None,
                    released: true,
                    waiting: false,
                },
            );
            None
        };
        self.owner.0.changed.send_replace(());
        Ok(json!({"invocationId": input.invocation_id, "leaseId": lease_id, "released": true}))
    }

    pub(crate) fn close(&self) {
        let mut state = self.owner.0.state.lock().expect("IAB owner lock");
        if let Some(calls) = state.peers.remove(&self.id) {
            for call in calls.values().filter(|call| !call.released) {
                if let Some(instance) = call
                    .instance_id
                    .as_ref()
                    .and_then(|id| state.instances.get_mut(id))
                {
                    instance.abandoned = true;
                    instance.revoked.get_or_insert(Reason::Closing);
                }
            }
        }
        self.owner.0.changed.send_replace(());
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        self.close();
    }
}

struct WaitGuard<'a> {
    owner: Owner,
    peer: &'a str,
    invocation: &'a str,
}

impl Drop for WaitGuard<'_> {
    fn drop(&mut self) {
        let mut state = self.owner.0.state.lock().expect("IAB owner lock");
        if let Some(call) = state
            .peers
            .get_mut(self.peer)
            .and_then(|calls| calls.get_mut(self.invocation))
        {
            call.waiting = false;
        }
    }
}

fn drained(state: &State, instance_id: &str) -> bool {
    !state
        .instances
        .get(instance_id)
        .is_some_and(|instance| instance.abandoned)
        && !state.peers.values().any(|calls| {
            calls
                .values()
                .any(|call| call.instance_id.as_deref() == Some(instance_id) && !call.released)
        })
}

fn matches_capability(expected: &Capability, actual: &Capability) -> bool {
    actual.token.len() == 64
        && actual
            .token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && expected.session_id == actual.session_id
        && expected.instance_id == actual.instance_id
        && expected
            .token
            .bytes()
            .zip(actual.token.bytes())
            .fold(0, |different, (left, right)| different | (left ^ right))
            == 0
}

fn uuid(value: &str) -> rpc::Result<()> {
    if value.len() != 36 || Uuid::parse_str(value).is_err() {
        return Err(Error::invalid(
            "Browser invocation identifiers must be UUIDs",
        ));
    }
    Ok(())
}

fn denied() -> Error {
    Error::unavailable("iab_capability_denied", "Browser capability is unavailable")
}
fn revoked() -> Error {
    Error::unavailable(
        "iab_lease_revoked",
        "Browser invocation is no longer current",
    )
}
fn unknown() -> Error {
    Error::unavailable("iab_lease_unknown", "Browser invocation is unavailable")
}
fn peer_mismatch() -> Error {
    Error::unavailable(
        "iab_lease_peer_mismatch",
        "Browser invocation does not belong to this peer connection",
    )
}
