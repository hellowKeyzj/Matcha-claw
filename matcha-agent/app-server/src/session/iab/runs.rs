use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::{Value, json};

use super::{
    DRAIN_WINDOW, InstanceGuard, Owner, Peer, State, WAIT_WINDOW, peer_mismatch, revoked, uuid,
};
use crate::rpc::{self, Error};

pub(super) struct Run {
    pub(super) message_id: String,
    pub(super) terminal: bool,
    // Authority survives invocation release; only an acknowledged watcher requires page cleanup.
    pub(super) peers: BTreeMap<String, Cleanup>,
}

pub(super) enum Cleanup {
    Unobserved,
    Required,
    Released,
}

impl Run {
    pub(super) fn drained(&self) -> bool {
        self.peers
            .values()
            .all(|cleanup| !matches!(cleanup, Cleanup::Required))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Identity {
    session_id: String,
    instance_id: String,
    run_id: String,
}

impl Identity {
    fn validate(&self) -> rpc::Result<()> {
        uuid(&self.session_id)?;
        uuid(&self.instance_id)?;
        uuid(&self.run_id)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Wait {
    session_id: String,
    instance_id: String,
    run_id: String,
    wait: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Release {
    session_id: String,
    instance_id: String,
    run_id: String,
    drained: bool,
}

impl Owner {
    pub(crate) fn finish_run(&self, session_id: &str, run_id: &str) {
        let mut state = self.0.state.lock().expect("IAB owner lock");
        for instance in state
            .instances
            .values_mut()
            .filter(|instance| instance.capability.session_id == session_id)
        {
            if let Some(run) = instance.runs.get_mut(run_id) {
                run.terminal = true;
            }
        }
        self.0.changed.send_replace(());
    }
}

impl InstanceGuard {
    pub(crate) async fn begin_run(&self, run_id: &str, message_id: &str) -> rpc::Result<()> {
        uuid(run_id)?;
        uuid(message_id)?;
        let mut changes = self.owner.0.changed.subscribe();
        let pending = async {
            loop {
                {
                    let mut state = self.owner.0.state.lock().expect("IAB owner lock");
                    let previous_drained = super::drained(&state, &self.instance_id);
                    let instance = state
                        .instances
                        .get_mut(&self.instance_id)
                        .ok_or_else(revoked)?;
                    if instance.revoked.is_some() || instance.abandoned {
                        return Err(revoked());
                    }
                    let run = instance
                        .runs
                        .entry(run_id.to_owned())
                        .or_insert_with(|| Run {
                            message_id: message_id.to_owned(),
                            terminal: false,
                            peers: BTreeMap::new(),
                        });
                    if run.message_id != message_id || run.terminal {
                        return Err(revoked());
                    }
                    if instance.active_run.as_deref() == Some(run_id) {
                        return Ok(());
                    }
                    if previous_drained
                        && instance
                            .runs
                            .iter()
                            .all(|(id, run)| id == run_id || run.terminal)
                    {
                        instance.active_run = Some(run_id.to_owned());
                        self.owner.0.changed.send_replace(());
                        return Ok(());
                    }
                }
                changes.changed().await.map_err(|_| revoked())?;
            }
        };
        tokio::time::timeout(DRAIN_WINDOW, pending)
            .await
            .map_err(|_| {
                Error::unavailable(
                    "iab_lease_revoked",
                    "Previous browser run cleanup could not be confirmed",
                )
                .with_data(json!({"cleanupComplete": false}))
            })?
    }
}

impl Peer {
    pub(super) async fn wait_run(&self, request: Wait) -> rpc::Result {
        let input = Identity {
            session_id: request.session_id,
            instance_id: request.instance_id,
            run_id: request.run_id,
        };
        input.validate()?;
        let mut changes = self.owner.0.changed.subscribe();
        {
            let mut state = self.owner.0.state.lock().expect("IAB owner lock");
            authorized(&state, &self.id, &input)?;
            if state.instances[&input.instance_id].active_run.as_deref()
                != Some(input.run_id.as_str())
            {
                return Err(revoked());
            }
            let cleanup = state
                .instances
                .get_mut(&input.instance_id)
                .expect("authorized IAB instance")
                .runs
                .get_mut(&input.run_id)
                .expect("authorized IAB run")
                .peers
                .get_mut(&self.id)
                .expect("authorized IAB peer");
            match cleanup {
                Cleanup::Unobserved => *cleanup = Cleanup::Required,
                Cleanup::Required => {}
                Cleanup::Released => return Err(revoked()),
            }
            self.owner.0.changed.send_replace(());
        }
        let current = || -> rpc::Result<Value> {
            let state = self.owner.0.state.lock().expect("IAB owner lock");
            let run = authorized(&state, &self.id, &input)?;
            let mut receipt = json!({
                "sessionId": input.session_id, "instanceId": input.instance_id,
                "runId": input.run_id, "state": "current",
            });
            if let Some(reason) = state.instances[&input.instance_id].revoked {
                receipt["state"] = json!("revoked");
                receipt["reason"] = json!(reason.as_str());
            } else if run.terminal {
                receipt["state"] = json!("terminal");
            }
            Ok(receipt)
        };
        if !request.wait {
            return current();
        }
        let pending = async {
            loop {
                let receipt = current()?;
                if receipt["state"] != "current" {
                    return Ok::<_, Error>(receipt);
                }
                changes.changed().await.map_err(|_| peer_mismatch())?;
            }
        };
        match tokio::time::timeout(WAIT_WINDOW, pending).await {
            Ok(result) => result,
            Err(_) => current(),
        }
    }

    pub(super) fn release_run(&self, input: Release) -> rpc::Result {
        let identity = Identity {
            session_id: input.session_id,
            instance_id: input.instance_id,
            run_id: input.run_id,
        };
        identity.validate()?;
        if !input.drained {
            return Err(Error::invalid(
                "A browser run must be drained before release",
            ));
        }
        let mut state = self.owner.0.state.lock().expect("IAB owner lock");
        let run = authorized(&state, &self.id, &identity)?;
        let instance = &state.instances[&identity.instance_id];
        if !run.terminal && instance.revoked.is_none() {
            return Err(Error::invalid(
                "A browser run must have stopped before release",
            ));
        }
        if instance.abandoned
            || state.peers.values().any(|calls| {
                calls.values().any(|call| {
                    call.instance_id.as_deref() == Some(identity.instance_id.as_str())
                        && call.run_id.as_deref() == Some(identity.run_id.as_str())
                        && !call.released
                })
            })
        {
            return Err(Error::unavailable(
                "iab_lease_revoked",
                "Browser run invocations have not drained",
            )
            .with_data(json!({"cleanupComplete": false})));
        }
        *state
            .instances
            .get_mut(&identity.instance_id)
            .expect("authorized IAB instance")
            .runs
            .get_mut(&identity.run_id)
            .expect("authorized IAB run")
            .peers
            .get_mut(&self.id)
            .expect("authorized IAB peer") = Cleanup::Released;
        self.owner.0.changed.send_replace(());
        Ok(json!({
            "sessionId": identity.session_id, "instanceId": identity.instance_id,
            "runId": identity.run_id, "released": true,
        }))
    }
}

fn authorized<'a>(state: &'a State, peer: &str, input: &Identity) -> rpc::Result<&'a Run> {
    if !state.peers.contains_key(peer) {
        return Err(peer_mismatch());
    }
    let instance = state
        .instances
        .get(&input.instance_id)
        .filter(|instance| instance.capability.session_id == input.session_id)
        .ok_or_else(peer_mismatch)?;
    instance
        .runs
        .get(&input.run_id)
        .filter(|run| run.peers.contains_key(peer))
        .ok_or_else(peer_mismatch)
}
