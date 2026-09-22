use std::{collections::BTreeMap, fmt, time::SystemTime};

use crate::domain::{command::CommandId, secret_ref::FleetSecretRef};

fn contains_public_secret(config: &BTreeMap<String, String>) -> bool {
    config.keys().any(|key| {
        let key = key.to_ascii_lowercase();
        [
            "secret",
            "token",
            "password",
            "api_key",
            "apikey",
            "private_key",
            "credential",
        ]
        .iter()
        .any(|marker| key.contains(marker))
    })
}

macro_rules! id_type {
    ($name:ident, $invalid:ident, $label:literal) => {
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
        pub struct $name(String);
        impl $name {
            pub fn try_new(value: impl Into<String>) -> Result<Self, $invalid> {
                let value = value.into();
                if value.trim().is_empty() || value.len() > 128 || value.as_bytes().contains(&0) {
                    return Err($invalid);
                }
                Ok(Self(value))
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        pub struct $invalid;
        impl fmt::Display for $invalid {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(concat!($label, " is invalid"))
            }
        }
        impl std::error::Error for $invalid {}
    };
}
id_type!(ConnectionId, InvalidConnectionId, "connection ID");

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectionKind {
    SshHost,
    Container,
    Vm,
    KubernetesPod,
    Custom,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConnectionState {
    Registered,
    Probing {
        command_id: CommandId,
    },
    Ready {
        observed_at: SystemTime,
    },
    Unhealthy {
        observed_at: Option<SystemTime>,
        message: String,
    },
    Deleted {
        deleted_at: SystemTime,
    },
    Failed {
        message: String,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectionAssociation {
    None,
    Present,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProbeOutcome {
    Ready,
    Unhealthy,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectionMutation {
    Inserted,
    Updated,
    Unchanged,
    Deleted,
    ProbeStarted,
    ProbeCompleted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectionMutationError {
    NotFound,
    AlreadyDeleted,
    AssociatedRecords,
    AssociationCheckFailed,
    InvalidTransition,
    StaleCommand,
    BackdatedTransition,
    InvalidRecord,
}

impl fmt::Display for ConnectionMutationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::NotFound => "connection not found",
            Self::AlreadyDeleted => "connection is deleted",
            Self::AssociatedRecords => "connection has associated records",
            Self::AssociationCheckFailed => "connection association check failed",
            Self::InvalidTransition => "invalid connection state transition",
            Self::StaleCommand => "connection probe command is stale",
            Self::BackdatedTransition => "connection transition is backdated",
            Self::InvalidRecord => "connection record is invalid",
        })
    }
}

impl std::error::Error for ConnectionMutationError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConnectionRecord {
    id: ConnectionId,
    kind: ConnectionKind,
    display_name: String,
    endpoint: Option<String>,
    labels: Vec<String>,
    enabled: bool,
    public_config: BTreeMap<String, String>,
    secret_refs: BTreeMap<String, FleetSecretRef>,
    state: ConnectionState,
    created_at: SystemTime,
    updated_at: SystemTime,
}

impl ConnectionRecord {
    pub fn register(
        id: ConnectionId,
        kind: ConnectionKind,
        display_name: String,
        endpoint: Option<String>,
        labels: Vec<String>,
        enabled: bool,
        public_config: BTreeMap<String, String>,
        secret_refs: BTreeMap<String, FleetSecretRef>,
        now: SystemTime,
    ) -> Result<Self, ConnectionRestoreError> {
        if display_name.trim().is_empty() || contains_public_secret(&public_config) {
            return Err(ConnectionRestoreError::InvalidRecord);
        }
        Ok(Self {
            id,
            kind,
            display_name,
            endpoint,
            labels,
            enabled,
            public_config,
            secret_refs,
            state: ConnectionState::Registered,
            created_at: now,
            updated_at: now,
        })
    }

    pub fn new(
        id: ConnectionId,
        kind: ConnectionKind,
        display_name: String,
        now: SystemTime,
    ) -> Self {
        Self::register(
            id,
            kind,
            display_name,
            None,
            Vec::new(),
            true,
            BTreeMap::new(),
            BTreeMap::new(),
            now,
        )
        .expect("ConnectionRecord::new requires a non-empty display name")
    }
    pub fn restore(
        id: ConnectionId,
        kind: ConnectionKind,
        display_name: String,
        endpoint: Option<String>,
        labels: Vec<String>,
        enabled: bool,
        public_config: BTreeMap<String, String>,
        secret_refs: BTreeMap<String, FleetSecretRef>,
        state: ConnectionState,
        created_at: SystemTime,
        updated_at: SystemTime,
    ) -> Result<Self, ConnectionRestoreError> {
        if display_name.trim().is_empty()
            || created_at > updated_at
            || contains_public_secret(&public_config)
        {
            return Err(ConnectionRestoreError::InvalidRecord);
        }
        Ok(Self {
            id,
            kind,
            display_name,
            endpoint,
            labels,
            enabled,
            public_config,
            secret_refs,
            state,
            created_at,
            updated_at,
        })
    }
    pub fn id(&self) -> &ConnectionId {
        &self.id
    }
    pub fn kind(&self) -> ConnectionKind {
        self.kind
    }
    pub fn display_name(&self) -> &str {
        &self.display_name
    }
    pub fn endpoint(&self) -> Option<&str> {
        self.endpoint.as_deref()
    }
    pub fn labels(&self) -> &[String] {
        &self.labels
    }
    pub fn enabled(&self) -> bool {
        self.enabled
    }
    pub fn public_config(&self) -> &BTreeMap<String, String> {
        &self.public_config
    }
    pub fn secret_refs(&self) -> &BTreeMap<String, FleetSecretRef> {
        &self.secret_refs
    }
    pub fn state(&self) -> &ConnectionState {
        &self.state
    }
    pub fn created_at(&self) -> SystemTime {
        self.created_at
    }
    pub fn updated_at(&self) -> SystemTime {
        self.updated_at
    }

    fn replace_from(
        &mut self,
        incoming: Self,
        now: SystemTime,
    ) -> Result<ConnectionMutation, ConnectionMutationError> {
        if !incoming.is_valid() {
            return Err(ConnectionMutationError::InvalidRecord);
        }
        if self.state_is_deleted() {
            return Err(ConnectionMutationError::AlreadyDeleted);
        }
        if now < self.updated_at || incoming.created_at() > now {
            return Err(ConnectionMutationError::BackdatedTransition);
        }
        let changed = self.kind != incoming.kind
            || self.display_name != incoming.display_name
            || self.endpoint != incoming.endpoint
            || self.labels != incoming.labels
            || self.enabled != incoming.enabled
            || self.public_config != incoming.public_config
            || self.secret_refs != incoming.secret_refs;
        if changed {
            self.kind = incoming.kind;
            self.display_name = incoming.display_name;
            self.endpoint = incoming.endpoint;
            self.labels = incoming.labels;
            self.enabled = incoming.enabled;
            self.public_config = incoming.public_config;
            self.secret_refs = incoming.secret_refs;
            self.updated_at = now;
            Ok(ConnectionMutation::Updated)
        } else {
            Ok(ConnectionMutation::Unchanged)
        }
    }

    fn is_valid(&self) -> bool {
        !self.display_name.trim().is_empty()
            && self.created_at <= self.updated_at
            && !contains_public_secret(&self.public_config)
    }

    fn state_is_deleted(&self) -> bool {
        matches!(self.state, ConnectionState::Deleted { .. })
    }

    fn begin_probe(
        &mut self,
        command_id: CommandId,
        now: SystemTime,
    ) -> Result<ConnectionMutation, ConnectionMutationError> {
        if self.state_is_deleted() {
            return Err(ConnectionMutationError::AlreadyDeleted);
        }
        if now < self.updated_at {
            return Err(ConnectionMutationError::BackdatedTransition);
        }
        if matches!(&self.state, ConnectionState::Probing { command_id: current } if current == &command_id)
        {
            return Ok(ConnectionMutation::Unchanged);
        }
        self.state = ConnectionState::Probing { command_id };
        self.updated_at = now;
        Ok(ConnectionMutation::ProbeStarted)
    }

    fn complete_probe(
        &mut self,
        command_id: &CommandId,
        outcome: ProbeOutcome,
        observed_at: SystemTime,
        message: Option<String>,
    ) -> Result<ConnectionMutation, ConnectionMutationError> {
        if observed_at < self.updated_at {
            return Err(ConnectionMutationError::BackdatedTransition);
        }
        let ConnectionState::Probing {
            command_id: current,
        } = &self.state
        else {
            return Err(ConnectionMutationError::InvalidTransition);
        };
        if current != command_id {
            return Err(ConnectionMutationError::StaleCommand);
        }
        self.state = match outcome {
            ProbeOutcome::Ready => ConnectionState::Ready { observed_at },
            ProbeOutcome::Unhealthy => ConnectionState::Unhealthy {
                observed_at: Some(observed_at),
                message: message.unwrap_or_else(|| "connection probe failed".into()),
            },
        };
        self.updated_at = observed_at;
        Ok(ConnectionMutation::ProbeCompleted)
    }

    fn delete(&mut self, now: SystemTime) -> Result<ConnectionMutation, ConnectionMutationError> {
        if self.state_is_deleted() {
            return Ok(ConnectionMutation::Unchanged);
        }
        if now < self.updated_at {
            return Err(ConnectionMutationError::BackdatedTransition);
        }
        self.state = ConnectionState::Deleted { deleted_at: now };
        self.updated_at = now;
        Ok(ConnectionMutation::Deleted)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectionRestoreError {
    InvalidRecord,
    DuplicateId,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ConnectionStore {
    records: BTreeMap<ConnectionId, ConnectionRecord>,
}
impl ConnectionStore {
    pub fn restore(
        records: impl IntoIterator<Item = ConnectionRecord>,
    ) -> Result<Self, ConnectionRestoreError> {
        let mut result = Self::default();
        for record in records {
            if result.records.insert(record.id.clone(), record).is_some() {
                return Err(ConnectionRestoreError::DuplicateId);
            }
        }
        Ok(result)
    }
    pub fn records(&self) -> impl Iterator<Item = &ConnectionRecord> {
        self.records.values()
    }
    pub fn record(&self, id: &ConnectionId) -> Option<&ConnectionRecord> {
        self.records.get(id)
    }

    /// Insert a new connection or update its mutable registration fields.
    ///
    /// The incoming record's lifecycle state is intentionally ignored for an existing
    /// connection: probe state is owned by the lifecycle methods below and cannot be
    /// overwritten by a registration upsert.
    pub fn upsert(
        &mut self,
        record: ConnectionRecord,
        now: SystemTime,
    ) -> Result<ConnectionMutation, ConnectionMutationError> {
        if let Some(existing) = self.records.get_mut(record.id()) {
            existing.replace_from(record, now)
        } else {
            if !record.is_valid() {
                return Err(ConnectionMutationError::InvalidRecord);
            }
            if record.created_at() > now || record.updated_at() > now {
                return Err(ConnectionMutationError::BackdatedTransition);
            }
            self.records.insert(record.id.clone(), record);
            Ok(ConnectionMutation::Inserted)
        }
    }

    /// Tombstone a connection only after an authoritative association check.
    ///
    /// Any checker error fails closed; callers must not turn an unavailable
    /// association lookup into a destructive delete.
    pub fn delete_if_unassociated<E>(
        &mut self,
        id: &ConnectionId,
        now: SystemTime,
        association_check: impl FnOnce(&ConnectionId) -> Result<bool, E>,
    ) -> Result<ConnectionMutation, ConnectionMutationError> {
        let Some(current) = self.records.get(id) else {
            return Err(ConnectionMutationError::NotFound);
        };
        if current.state_is_deleted() {
            return Ok(ConnectionMutation::Unchanged);
        }
        let associated =
            association_check(id).map_err(|_| ConnectionMutationError::AssociationCheckFailed)?;
        if associated {
            return Err(ConnectionMutationError::AssociatedRecords);
        }
        self.records
            .get_mut(id)
            .expect("connection presence was checked above")
            .delete(now)
    }

    pub fn begin_probe(
        &mut self,
        id: &ConnectionId,
        command_id: CommandId,
        now: SystemTime,
    ) -> Result<ConnectionMutation, ConnectionMutationError> {
        self.records
            .get_mut(id)
            .ok_or(ConnectionMutationError::NotFound)?
            .begin_probe(command_id, now)
    }

    pub fn complete_probe(
        &mut self,
        id: &ConnectionId,
        command_id: &CommandId,
        outcome: ProbeOutcome,
        observed_at: SystemTime,
        message: Option<String>,
    ) -> Result<ConnectionMutation, ConnectionMutationError> {
        self.records
            .get_mut(id)
            .ok_or(ConnectionMutationError::NotFound)?
            .complete_probe(command_id, outcome, observed_at, message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(id: &str, now: SystemTime) -> ConnectionRecord {
        ConnectionRecord::new(
            ConnectionId::try_new(id).unwrap(),
            ConnectionKind::SshHost,
            "SSH".into(),
            now,
        )
    }

    #[test]
    fn register_retains_configuration_and_rejects_empty_display_name() {
        let now = SystemTime::UNIX_EPOCH;
        let id = ConnectionId::try_new("conn-a").unwrap();
        let secret = FleetSecretRef::parse("remote-fleet://credentials/key").unwrap();
        let mut public_config = BTreeMap::new();
        public_config.insert("host".into(), "example.test".into());
        let mut secret_refs = BTreeMap::new();
        secret_refs.insert("key".into(), secret);

        let record = ConnectionRecord::register(
            id,
            ConnectionKind::SshHost,
            "SSH".into(),
            Some("ssh://example.test".into()),
            vec!["production".into()],
            false,
            public_config.clone(),
            secret_refs.clone(),
            now,
        )
        .unwrap();
        assert_eq!(record.endpoint(), Some("ssh://example.test"));
        assert_eq!(record.labels(), &["production"]);
        assert!(!record.enabled());
        assert_eq!(record.public_config(), &public_config);
        assert_eq!(record.secret_refs(), &secret_refs);
        assert_eq!(record.state(), &ConnectionState::Registered);

        assert_eq!(
            ConnectionRecord::register(
                ConnectionId::try_new("conn-b").unwrap(),
                ConnectionKind::SshHost,
                "  ".into(),
                None,
                Vec::new(),
                true,
                BTreeMap::new(),
                BTreeMap::new(),
                now,
            ),
            Err(ConnectionRestoreError::InvalidRecord)
        );
    }

    #[test]
    fn upsert_preserves_lifecycle_and_secret_references() {
        let now = SystemTime::UNIX_EPOCH;
        let id = ConnectionId::try_new("conn-a").unwrap();
        let command = CommandId::try_new("probe-a").unwrap();
        let secret = FleetSecretRef::parse("remote-fleet://credentials/key").unwrap();
        let mut original = record("conn-a", now);
        original.secret_refs.insert("key".into(), secret);
        let mut store = ConnectionStore::restore([original]).unwrap();
        store.begin_probe(&id, command.clone(), now).unwrap();

        let mut replacement = record("conn-a", now);
        replacement.display_name = "SSH replacement".into();
        replacement.secret_refs.insert(
            "key".into(),
            FleetSecretRef::parse("remote-fleet://credentials/replacement").unwrap(),
        );
        assert_eq!(
            store.upsert(replacement, now).unwrap(),
            ConnectionMutation::Updated
        );
        let stored = store.record(&id).unwrap();
        assert_eq!(
            stored.state(),
            &ConnectionState::Probing {
                command_id: command
            }
        );
        assert_eq!(stored.secret_refs().len(), 1);
        assert!(!format!("{:?}", stored).contains("credentials/replacement"));
    }

    #[test]
    fn deletion_fails_closed_for_associations_and_checker_errors() {
        let now = SystemTime::UNIX_EPOCH;
        let id = ConnectionId::try_new("conn-a").unwrap();
        let mut store = ConnectionStore::restore([record("conn-a", now)]).unwrap();
        assert_eq!(
            store.delete_if_unassociated(&id, now, |_| Ok::<_, ()>(true)),
            Err(ConnectionMutationError::AssociatedRecords)
        );
        assert_eq!(
            store.delete_if_unassociated(&id, now, |_| Err::<bool, _>(())),
            Err(ConnectionMutationError::AssociationCheckFailed)
        );
        assert_eq!(
            store.record(&id).unwrap().state(),
            &ConnectionState::Registered
        );
        assert_eq!(
            store
                .delete_if_unassociated(&id, now, |_| Ok::<_, ()>(false))
                .unwrap(),
            ConnectionMutation::Deleted
        );
        assert!(matches!(
            store.record(&id).unwrap().state(),
            ConnectionState::Deleted { .. }
        ));
    }

    #[test]
    fn probe_completion_requires_the_current_command_and_monotonic_time() {
        let now = SystemTime::UNIX_EPOCH;
        let id = ConnectionId::try_new("conn-a").unwrap();
        let command = CommandId::try_new("probe-a").unwrap();
        let mut store = ConnectionStore::restore([record("conn-a", now)]).unwrap();
        store.begin_probe(&id, command.clone(), now).unwrap();
        assert_eq!(
            store.complete_probe(
                &id,
                &CommandId::try_new("probe-b").unwrap(),
                ProbeOutcome::Ready,
                now,
                None,
            ),
            Err(ConnectionMutationError::StaleCommand)
        );
        assert_eq!(
            store
                .complete_probe(&id, &command, ProbeOutcome::Ready, now, None)
                .unwrap(),
            ConnectionMutation::ProbeCompleted
        );
        assert_eq!(
            store.record(&id).unwrap().state(),
            &ConnectionState::Ready { observed_at: now }
        );
    }

    #[test]
    fn typed_identity_and_state_are_restorable_without_secret_plaintext() {
        let id = ConnectionId::try_new("conn-a").unwrap();
        let now = SystemTime::UNIX_EPOCH;
        let secret = FleetSecretRef::parse("remote-fleet://credentials/key").unwrap();
        let mut refs = BTreeMap::new();
        refs.insert("key".into(), secret);
        let record = ConnectionRecord::restore(
            id.clone(),
            ConnectionKind::SshHost,
            "SSH".into(),
            None,
            vec![],
            true,
            BTreeMap::new(),
            refs,
            ConnectionState::Ready { observed_at: now },
            now,
            now,
        )
        .unwrap();
        assert_eq!(
            ConnectionStore::restore([record])
                .unwrap()
                .record(&id)
                .unwrap()
                .state(),
            &ConnectionState::Ready { observed_at: now }
        );
        assert!(!format!("{:?}", ConnectionStore::default()).contains("credentials"));
    }
}
