use std::time::SystemTime;

use platform::endpoint::EndpointId;

use crate::topology::{NodeId, RuntimeId};

use super::{CommandId, IdempotencyKey};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandIntent {
    command_id: CommandId,
    idempotency_key: IdempotencyKey,
    target: CommandTarget,
    kind: CommandKind,
    queued_at: SystemTime,
}

impl CommandIntent {
    pub fn new(
        command_id: CommandId,
        idempotency_key: IdempotencyKey,
        target: CommandTarget,
        kind: CommandKind,
        queued_at: SystemTime,
    ) -> Self {
        Self {
            command_id,
            idempotency_key,
            target,
            kind,
            queued_at,
        }
    }

    pub fn command_id(&self) -> &CommandId {
        &self.command_id
    }

    pub fn idempotency_key(&self) -> &IdempotencyKey {
        &self.idempotency_key
    }

    pub fn target(&self) -> &CommandTarget {
        &self.target
    }

    pub const fn kind(&self) -> CommandKind {
        self.kind
    }

    pub const fn queued_at(&self) -> SystemTime {
        self.queued_at
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandTarget {
    Node(NodeId),
    Runtime {
        node_id: NodeId,
        runtime_id: RuntimeId,
    },
    Endpoint {
        node_id: NodeId,
        runtime_id: RuntimeId,
        endpoint_id: EndpointId,
    },
}

impl CommandTarget {
    pub fn node_id(&self) -> &NodeId {
        match self {
            Self::Node(node_id)
            | Self::Runtime { node_id, .. }
            | Self::Endpoint { node_id, .. } => node_id,
        }
    }

    pub fn runtime_id(&self) -> Option<&RuntimeId> {
        match self {
            Self::Node(_) => None,
            Self::Runtime { runtime_id, .. } | Self::Endpoint { runtime_id, .. } => {
                Some(runtime_id)
            }
        }
    }

    pub fn endpoint_id(&self) -> Option<&EndpointId> {
        match self {
            Self::Endpoint { endpoint_id, .. } => Some(endpoint_id),
            Self::Node(_) | Self::Runtime { .. } => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum CommandKind {
    ProbeNode,
    InstallAgent,
    StartRuntime,
    StopRuntime,
    SyncCapabilities,
    UpgradeAgent,
    MountWorkspace,
    ExposePort,
}
