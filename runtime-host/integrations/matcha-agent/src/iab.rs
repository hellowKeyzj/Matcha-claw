use std::{
    collections::{HashMap, hash_map::Entry},
    path::Path,
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Deserializer, Serialize, de::Error as _};
use serde_json::Value;
use uuid::Uuid;
use zeroize::Zeroize;

use crate::client::{Client, Delivery, IabConnection};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capability {
    #[serde(deserialize_with = "uuid")]
    session_id: String,
    #[serde(deserialize_with = "uuid")]
    instance_id: String,
    token: String,
}

impl Drop for Capability {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Acquire {
    capability: Capability,
    #[serde(deserialize_with = "uuid")]
    invocation_id: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Wait {
    #[serde(deserialize_with = "uuid")]
    lease_id: String,
    #[serde(deserialize_with = "uuid")]
    invocation_id: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Release {
    #[serde(deserialize_with = "uuid")]
    invocation_id: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_uuid"
    )]
    lease_id: Option<String>,
    drained: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Acquired {
    #[serde(deserialize_with = "uuid")]
    lease_id: String,
    #[serde(deserialize_with = "uuid")]
    invocation_id: String,
    agent_id: String,
    #[serde(deserialize_with = "uuid")]
    session_id: String,
    #[serde(deserialize_with = "uuid")]
    instance_id: String,
    workspace_dir: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Waited {
    #[serde(deserialize_with = "uuid")]
    lease_id: String,
    #[serde(deserialize_with = "uuid")]
    invocation_id: String,
    state: LeaseState,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<RevocationReason>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum LeaseState {
    Current,
    Revoked,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum RevocationReason {
    InstanceClosing,
    InstanceReplaced,
    NativeExit,
    NativeIdentityChanged,
    ServerShutdown,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Released {
    #[serde(deserialize_with = "uuid")]
    invocation_id: String,
    #[serde(deserialize_with = "nullable_uuid")]
    lease_id: Option<String>,
    released: bool,
}

#[derive(Clone, Copy, Debug)]
pub enum Failure {
    InvalidInput,
    Unavailable,
    AlreadyInvoked,
    LeaseUnknown,
    LeaseRevoked,
    PeerMismatch,
    NativeNotAdmitted,
    CapabilityDenied,
    WaitConflict,
    Protocol,
    Unknown,
}

impl Failure {
    pub const fn kind(self) -> &'static str {
        match self {
            Self::InvalidInput => "invalid_params",
            Self::Unavailable => "iab_peer_unavailable",
            Self::AlreadyInvoked => "iab_invocation_already_used",
            Self::LeaseUnknown => "iab_lease_unknown",
            Self::LeaseRevoked => "iab_lease_revoked",
            Self::PeerMismatch => "iab_lease_peer_mismatch",
            Self::NativeNotAdmitted => "iab_native_not_admitted",
            Self::CapabilityDenied => "iab_capability_denied",
            Self::WaitConflict => "iab_lease_wait_conflict",
            Self::Protocol => "iab_peer_protocol",
            Self::Unknown => "iab_peer_outcome_unknown",
        }
    }
}

#[derive(Clone, Default)]
pub struct Leases {
    invocations: Arc<Mutex<HashMap<Uuid, Invocation>>>,
}

struct Invocation {
    pinned: Option<Pinned>,
    lease_id: Option<String>,
    state: InvocationState,
}

struct Pinned {
    connection: IabConnection,
    cleanup: tokio::task::AbortHandle,
}

impl Drop for Pinned {
    fn drop(&mut self) {
        self.cleanup.abort();
    }
}

#[derive(Clone, Copy)]
enum InvocationState {
    Acquiring,
    Active,
    Releasing,
    Released,
    Cancelled,
    Disconnected,
}

impl Leases {
    pub async fn acquire(&self, client: &Client, input: Acquire) -> Result<Acquired, Failure> {
        if input.capability.token.len() != 64
            || !input
                .capability
                .token
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        {
            return Err(Failure::InvalidInput);
        }
        let id = Uuid::parse_str(&input.invocation_id).map_err(|_| Failure::InvalidInput)?;
        let connection = {
            let mut invocations = self
                .invocations
                .lock()
                .expect("IAB lease registry is not poisoned");
            let Entry::Vacant(entry) = invocations.entry(id) else {
                return Err(Failure::AlreadyInvoked);
            };
            let connection = match client.pin_iab() {
                Ok(connection) => connection,
                Err(error) => {
                    entry.insert(Invocation {
                        pinned: None,
                        lease_id: None,
                        state: InvocationState::Disconnected,
                    });
                    return Err(failure(error));
                }
            };
            let pinned = self.track(id, &connection);
            // UUID receipts survive this connection, but credentials and closed connection resources do not.
            entry.insert(Invocation {
                pinned: Some(pinned),
                lease_id: None,
                state: InvocationState::Acquiring,
            });
            connection
        };
        let response = connection.acquire(encode(&input)?).await.map_err(failure)?;
        let acquired: Acquired = serde_json::from_value(response).map_err(|_| Failure::Protocol)?;
        if acquired.invocation_id != input.invocation_id
            || acquired.session_id != input.capability.session_id
            || acquired.instance_id != input.capability.instance_id
            || !crate::session::model::valid_agent_id(&acquired.agent_id)
            || !Path::new(&acquired.workspace_dir).is_absolute()
        {
            return Err(Failure::Protocol);
        }
        let mut invocations = self
            .invocations
            .lock()
            .expect("IAB lease registry is not poisoned");
        let invocation = current(&mut invocations, &connection, &id)?;
        if !matches!(invocation.state, InvocationState::Acquiring) {
            return Err(Failure::LeaseRevoked);
        }
        invocation.state = InvocationState::Active;
        invocation.lease_id = Some(acquired.lease_id.clone());
        Ok(acquired)
    }

    pub async fn wait(&self, input: Wait) -> Result<Waited, Failure> {
        let id = Uuid::parse_str(&input.invocation_id).map_err(|_| Failure::InvalidInput)?;
        let connection = {
            let invocations = self
                .invocations
                .lock()
                .expect("IAB lease registry is not poisoned");
            let invocation = invocations.get(&id).ok_or(Failure::LeaseUnknown)?;
            if !matches!(invocation.state, InvocationState::Active) {
                return Err(Failure::LeaseRevoked);
            }
            if invocation.lease_id.as_deref() != Some(input.lease_id.as_str()) {
                return Err(Failure::LeaseUnknown);
            }
            invocation
                .pinned
                .as_ref()
                .ok_or(Failure::Unavailable)?
                .connection
                .clone()
        };
        let response = connection.wait(encode(&input)?).await.map_err(failure)?;
        let waited: Waited = serde_json::from_value(response).map_err(|_| Failure::Protocol)?;
        if waited.invocation_id != input.invocation_id
            || waited.lease_id != input.lease_id
            || matches!(waited.state, LeaseState::Current) && waited.reason.is_some()
        {
            return Err(Failure::Protocol);
        }
        let mut invocations = self
            .invocations
            .lock()
            .expect("IAB lease registry is not poisoned");
        let invocation = current(&mut invocations, &connection, &id)?;
        if !matches!(invocation.state, InvocationState::Active) {
            return Err(Failure::LeaseRevoked);
        }
        Ok(waited)
    }

    pub async fn release(&self, client: &Client, input: Release) -> Result<Released, Failure> {
        if !input.drained {
            return Err(Failure::InvalidInput);
        }
        let id = Uuid::parse_str(&input.invocation_id).map_err(|_| Failure::InvalidInput)?;
        let connection = {
            let mut invocations = self
                .invocations
                .lock()
                .expect("IAB lease registry is not poisoned");
            let invocation = match invocations.entry(id) {
                Entry::Vacant(entry) => {
                    if input.lease_id.is_some() {
                        return Err(Failure::LeaseUnknown);
                    }
                    // A live peer and an unused UUID prove no native acquire was sent on any generation.
                    client.pin_iab().map_err(failure)?;
                    entry.insert(Invocation {
                        pinned: None,
                        lease_id: None,
                        state: InvocationState::Cancelled,
                    })
                }
                Entry::Occupied(entry) => entry.into_mut(),
            };
            if matches!(
                invocation.state,
                InvocationState::Cancelled | InvocationState::Released
            ) {
                if input
                    .lease_id
                    .as_ref()
                    .is_some_and(|expected| invocation.lease_id.as_ref() != Some(expected))
                {
                    return Err(Failure::LeaseUnknown);
                }
                return Ok(Released {
                    invocation_id: input.invocation_id,
                    lease_id: invocation.lease_id.clone(),
                    released: true,
                });
            }
            if let (Some(expected), Some(actual)) = (&input.lease_id, &invocation.lease_id)
                && expected != actual
            {
                return Err(Failure::LeaseUnknown);
            }
            let connection = invocation
                .pinned
                .as_ref()
                .ok_or(Failure::Unavailable)?
                .connection
                .clone();
            if !connection.is_connected() {
                return Err(Failure::Unavailable);
            }
            invocation.state = InvocationState::Releasing;
            connection
        };
        let response = connection.release(encode(&input)?).await.map_err(failure)?;
        let released: Released = serde_json::from_value(response).map_err(|_| Failure::Protocol)?;
        if released.invocation_id != input.invocation_id
            || !released.released
            || input
                .lease_id
                .as_ref()
                .is_some_and(|expected| released.lease_id.as_ref() != Some(expected))
        {
            return Err(Failure::Protocol);
        }
        let mut invocations = self
            .invocations
            .lock()
            .expect("IAB lease registry is not poisoned");
        // A valid release acknowledgement remains authoritative if its socket closes immediately after.
        let invocation = invocations.get_mut(&id).ok_or(Failure::LeaseUnknown)?;
        if invocation
            .lease_id
            .as_ref()
            .is_some_and(|expected| released.lease_id.as_ref() != Some(expected))
        {
            return Err(Failure::Protocol);
        }
        invocation.lease_id = released.lease_id.clone();
        invocation.state = InvocationState::Released;
        invocation.pinned.take();
        Ok(released)
    }

    fn track(&self, id: Uuid, connection: &IabConnection) -> Pinned {
        let registry = Arc::downgrade(&self.invocations);
        let closing = connection.clone();
        let cleanup = tokio::spawn(async move {
            closing.closed().await;
            if let Some(registry) = registry.upgrade() {
                let mut invocations = registry.lock().expect("IAB lease registry is not poisoned");
                if let Some(invocation) = invocations.get_mut(&id)
                    && invocation
                        .pinned
                        .as_ref()
                        .is_some_and(|pinned| pinned.connection.same_generation(&closing))
                {
                    invocation.pinned.take();
                    invocation.state = InvocationState::Disconnected;
                }
            }
        });
        Pinned {
            connection: connection.clone(),
            cleanup: cleanup.abort_handle(),
        }
    }
}

fn current<'a>(
    invocations: &'a mut HashMap<Uuid, Invocation>,
    connection: &IabConnection,
    id: &Uuid,
) -> Result<&'a mut Invocation, Failure> {
    let invocation = invocations.get_mut(id).ok_or(Failure::LeaseUnknown)?;
    if !invocation
        .pinned
        .as_ref()
        .is_some_and(|pinned| pinned.connection.same_generation(connection))
        || !connection.is_connected()
    {
        return Err(Failure::Unavailable);
    }
    Ok(invocation)
}

fn encode(value: &impl Serialize) -> Result<Value, Failure> {
    serde_json::to_value(value).map_err(|_| Failure::InvalidInput)
}

fn failure(error: crate::client::Error) -> Failure {
    if error.delivery() == Delivery::Unknown {
        return Failure::Unknown;
    }
    if error.delivery() == Delivery::NotSent {
        return Failure::Unavailable;
    }
    match error.kind() {
        "invalid_params" => Failure::InvalidInput,
        "iab_capability_denied" => Failure::CapabilityDenied,
        "iab_native_not_admitted" => Failure::NativeNotAdmitted,
        "iab_lease_unknown" => Failure::LeaseUnknown,
        "iab_lease_revoked" => Failure::LeaseRevoked,
        "iab_lease_peer_mismatch" => Failure::PeerMismatch,
        "iab_lease_wait_conflict" => Failure::WaitConflict,
        _ => Failure::Protocol,
    }
}

fn uuid<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    if value.len() != 36 {
        return Err(D::Error::custom("invalid IAB UUID"));
    }
    Uuid::parse_str(&value).map_err(|_| D::Error::custom("invalid IAB UUID"))?;
    Ok(value)
}

fn optional_uuid<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    uuid(deserializer).map(Some)
}

fn nullable_uuid<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    let value = Option::<String>::deserialize(deserializer)?;
    if let Some(value) = &value {
        if value.len() != 36 {
            return Err(D::Error::custom("invalid IAB UUID"));
        }
        Uuid::parse_str(value).map_err(|_| D::Error::custom("invalid IAB UUID"))?;
    }
    Ok(value)
}
