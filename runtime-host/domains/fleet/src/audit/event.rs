use std::{collections::BTreeMap, fmt, time::SystemTime};

use super::{FleetAuditValue, redact_fields, redact_text};

pub struct FleetAuditEventInput {
    pub event_name: String,
    pub occurred_at: SystemTime,
    pub message: Option<String>,
    pub metadata: BTreeMap<String, FleetAuditValue>,
    pub relations: FleetAuditRelations,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct FleetAuditRelations {
    actor_id: Option<String>,
    connection_id: Option<String>,
    environment_id: Option<String>,
    managed_resource_id: Option<String>,
    node_id: Option<String>,
    agent_id: Option<String>,
    runtime_id: Option<String>,
    endpoint_id: Option<String>,
    command_id: Option<String>,
}

impl FleetAuditRelations {
    pub fn new(
        actor_id: Option<String>,
        connection_id: Option<String>,
        environment_id: Option<String>,
        managed_resource_id: Option<String>,
        node_id: Option<String>,
        agent_id: Option<String>,
        runtime_id: Option<String>,
        endpoint_id: Option<String>,
        command_id: Option<String>,
    ) -> Option<Self> {
        let values = [
            &actor_id,
            &connection_id,
            &environment_id,
            &managed_resource_id,
            &node_id,
            &agent_id,
            &runtime_id,
            &endpoint_id,
            &command_id,
        ];
        values
            .iter()
            .all(|value| {
                value.as_deref().is_none_or(|value| {
                    !value.trim().is_empty() && value.len() <= 128 && !value.as_bytes().contains(&0)
                })
            })
            .then_some(Self {
                actor_id,
                connection_id,
                environment_id,
                managed_resource_id,
                node_id,
                agent_id,
                runtime_id,
                endpoint_id,
                command_id,
            })
    }

    pub fn actor_id(&self) -> Option<&str> {
        self.actor_id.as_deref()
    }
    pub fn connection_id(&self) -> Option<&str> {
        self.connection_id.as_deref()
    }
    pub fn environment_id(&self) -> Option<&str> {
        self.environment_id.as_deref()
    }
    pub fn managed_resource_id(&self) -> Option<&str> {
        self.managed_resource_id.as_deref()
    }
    pub fn node_id(&self) -> Option<&str> {
        self.node_id.as_deref()
    }
    pub fn agent_id(&self) -> Option<&str> {
        self.agent_id.as_deref()
    }
    pub fn runtime_id(&self) -> Option<&str> {
        self.runtime_id.as_deref()
    }
    pub fn endpoint_id(&self) -> Option<&str> {
        self.endpoint_id.as_deref()
    }
    pub fn command_id(&self) -> Option<&str> {
        self.command_id.as_deref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FleetAuditEvent {
    event_name: String,
    occurred_at: SystemTime,
    message: Option<String>,
    metadata: BTreeMap<String, FleetAuditValue>,
    relations: FleetAuditRelations,
}

impl FleetAuditEvent {
    pub fn new(input: FleetAuditEventInput) -> Result<Self, FleetAuditError> {
        if !is_valid_event_name(&input.event_name) {
            return Err(FleetAuditError::InvalidEventName);
        }

        Ok(Self {
            event_name: input.event_name,
            occurred_at: input.occurred_at,
            message: input.message.as_deref().map(redact_text),
            metadata: redact_fields(&input.metadata),
            relations: input.relations,
        })
    }

    pub fn event_name(&self) -> &str {
        &self.event_name
    }

    pub const fn occurred_at(&self) -> SystemTime {
        self.occurred_at
    }

    pub fn message(&self) -> Option<&str> {
        self.message.as_deref()
    }

    pub fn metadata(&self) -> &BTreeMap<String, FleetAuditValue> {
        &self.metadata
    }

    pub fn relations(&self) -> &FleetAuditRelations {
        &self.relations
    }

    pub fn redacted_for_commit(&self) -> Self {
        Self {
            event_name: self.event_name.clone(),
            occurred_at: self.occurred_at,
            message: self.message.as_deref().map(redact_text),
            metadata: redact_fields(&self.metadata),
            relations: self.relations.clone(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FleetAuditError {
    InvalidEventName,
}

impl fmt::Display for FleetAuditError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Fleet audit event name is invalid")
    }
}

impl std::error::Error for FleetAuditError {}

fn is_valid_event_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    let Some((first, rest)) = bytes.split_first() else {
        return false;
    };

    name.len() <= 128
        && first.is_ascii_alphanumeric()
        && rest
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}
