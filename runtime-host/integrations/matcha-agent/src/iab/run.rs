use std::collections::hash_map::Entry;
use std::sync::Arc;

use serde::{Deserialize, Deserializer, Serialize};

use super::{Acquired, Failure, Leases, Pinned, RevocationReason, encode, failure, uuid};
use crate::client::IabConnection;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunWait {
    #[serde(deserialize_with = "uuid")]
    session_id: String,
    #[serde(deserialize_with = "uuid")]
    instance_id: String,
    #[serde(deserialize_with = "uuid")]
    run_id: String,
    wait: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunRelease {
    #[serde(deserialize_with = "uuid")]
    session_id: String,
    #[serde(deserialize_with = "uuid")]
    instance_id: String,
    #[serde(deserialize_with = "uuid")]
    run_id: String,
    drained: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunWaited {
    #[serde(deserialize_with = "uuid")]
    session_id: String,
    #[serde(deserialize_with = "uuid")]
    instance_id: String,
    #[serde(deserialize_with = "uuid")]
    run_id: String,
    state: RunState,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    status: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    reason: Option<RevocationReason>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum RunState {
    Current,
    Terminal,
    Revoked,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunReleased {
    #[serde(deserialize_with = "uuid")]
    session_id: String,
    #[serde(deserialize_with = "uuid")]
    instance_id: String,
    #[serde(deserialize_with = "uuid")]
    run_id: String,
    released: bool,
}

#[derive(Clone, Hash, Eq, PartialEq)]
pub(super) struct RunKey {
    session_id: String,
    instance_id: String,
    run_id: String,
}

pub(super) enum Run {
    Pinned(Pinned),
    Released,
    Disconnected,
}

impl Leases {
    pub(super) fn register_run(
        &self,
        acquired: &Acquired,
        connection: &IabConnection,
    ) -> Result<(), Failure> {
        let key = RunKey {
            session_id: acquired.session_id.clone(),
            instance_id: acquired.instance_id.clone(),
            run_id: acquired.run_id.clone(),
        };
        let mut runs = self.runs.lock().expect("IAB run registry is not poisoned");
        match runs.entry(key.clone()) {
            Entry::Occupied(entry) => {
                if !pinned(entry.get())?.same_generation(connection) {
                    return Err(Failure::PeerMismatch);
                }
            }
            Entry::Vacant(entry) => {
                if !connection.is_connected() {
                    return Err(Failure::Unavailable);
                }
                entry.insert(Run::Pinned(self.track_run(key, connection)));
            }
        }
        Ok(())
    }

    pub async fn run_wait(&self, input: RunWait) -> Result<RunWaited, Failure> {
        let key = RunKey {
            session_id: input.session_id.clone(),
            instance_id: input.instance_id.clone(),
            run_id: input.run_id.clone(),
        };
        let connection = {
            let runs = self.runs.lock().expect("IAB run registry is not poisoned");
            pinned(runs.get(&key).ok_or(Failure::LeaseUnknown)?)?.clone()
        };
        let response = connection
            .run_wait(encode(&input)?)
            .await
            .map_err(failure)?;
        let waited: RunWaited = serde_json::from_value(response).map_err(|_| Failure::Protocol)?;
        if waited.session_id != input.session_id
            || waited.instance_id != input.instance_id
            || waited.run_id != input.run_id
            || !match waited.state {
                RunState::Current => waited.status.is_none() && waited.reason.is_none(),
                RunState::Terminal => waited.reason.is_none(),
                RunState::Revoked => waited.status.is_none() && waited.reason.is_some(),
            }
        {
            return Err(Failure::Protocol);
        }
        let runs = self.runs.lock().expect("IAB run registry is not poisoned");
        if !pinned(runs.get(&key).ok_or(Failure::LeaseUnknown)?)?.same_generation(&connection) {
            return Err(Failure::PeerMismatch);
        }
        Ok(waited)
    }

    pub async fn run_release(&self, input: RunRelease) -> Result<RunReleased, Failure> {
        if !input.drained {
            return Err(Failure::InvalidInput);
        }
        let key = RunKey {
            session_id: input.session_id.clone(),
            instance_id: input.instance_id.clone(),
            run_id: input.run_id.clone(),
        };
        let connection = {
            let runs = self.runs.lock().expect("IAB run registry is not poisoned");
            let run = runs.get(&key).ok_or(Failure::LeaseUnknown)?;
            if matches!(run, Run::Released) {
                return Ok(RunReleased {
                    session_id: input.session_id,
                    instance_id: input.instance_id,
                    run_id: input.run_id,
                    released: true,
                });
            }
            pinned(run)?.clone()
        };
        let response = connection
            .run_release(encode(&input)?)
            .await
            .map_err(failure)?;
        let released: RunReleased =
            serde_json::from_value(response).map_err(|_| Failure::Protocol)?;
        if released.session_id != input.session_id
            || released.instance_id != input.instance_id
            || released.run_id != input.run_id
            || !released.released
        {
            return Err(Failure::Protocol);
        }
        let mut runs = self.runs.lock().expect("IAB run registry is not poisoned");
        let run = runs.get_mut(&key).ok_or(Failure::LeaseUnknown)?;
        if let Run::Pinned(pinned) = run
            && !pinned.connection.same_generation(&connection)
        {
            return Err(Failure::PeerMismatch);
        }
        // A validated native acknowledgement wins an immediately following socket close.
        *run = Run::Released;
        Ok(released)
    }

    fn track_run(&self, key: RunKey, connection: &IabConnection) -> Pinned {
        let registry = Arc::downgrade(&self.runs);
        let closing = connection.clone();
        let cleanup = tokio::spawn(async move {
            closing.closed().await;
            if let Some(registry) = registry.upgrade() {
                let mut runs = registry.lock().expect("IAB run registry is not poisoned");
                if let Some(run) = runs.get_mut(&key)
                    && matches!(run, Run::Pinned(pinned) if pinned.connection.same_generation(&closing))
                {
                    *run = Run::Disconnected;
                }
            }
        });
        Pinned {
            connection: connection.clone(),
            cleanup: cleanup.abort_handle(),
        }
    }
}

fn pinned(run: &Run) -> Result<&IabConnection, Failure> {
    match run {
        Run::Pinned(pinned) if pinned.connection.is_connected() => Ok(&pinned.connection),
        Run::Released => Err(Failure::LeaseRevoked),
        Run::Pinned(_) | Run::Disconnected => Err(Failure::Unavailable),
    }
}

fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}
