use std::{collections::BTreeMap, fmt, time::SystemTime};

use crate::{
    command::CommandId, connection::ConnectionId, effect::PhaseKey, secret_ref::FleetSecretRef,
};

fn normalize_labels(labels: Vec<String>) -> Vec<String> {
    let mut labels = labels
        .into_iter()
        .map(|label| label.trim().to_owned())
        .filter(|label| !label.is_empty())
        .collect::<Vec<_>>();
    labels.sort();
    labels.dedup();
    labels
}

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
id_type!(EnvironmentId, InvalidEnvironmentId, "environment ID");
id_type!(
    ManagedResourceId,
    InvalidManagedResourceId,
    "managed resource ID"
);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EnvironmentKind {
    SshWorkdir,
    DockerContainer,
    KubernetesWorkload,
    VmWorkdir,
    Custom,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EnvironmentState {
    Registered,
    Deploying {
        command_id: CommandId,
        phase: PhaseKey,
    },
    Ready {
        ready_at: SystemTime,
    },
    Deleting {
        command_id: CommandId,
        phase: PhaseKey,
    },
    Deleted {
        deleted_at: SystemTime,
    },
    Orphaned {
        message: Option<String>,
    },
    Failed {
        message: String,
    },
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ManagedResourceProvider {
    Docker,
    Kubernetes,
    Ssh,
    Vm,
    Custom,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ManagedResourceKind {
    DockerContainer,
    KubernetesWorkload,
    KubernetesDeployment,
    KubernetesService,
    KubernetesSecret,
    SshAgentInstallation,
    VmAgentInstallation,
    Custom,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Ownership {
    MatchaManaged,
    Unverified,
    External,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CleanupPolicy {
    DeleteOnEnvironmentDelete,
    UninstallAgentOnly,
    Orphan,
    None,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ManagedResourceLifecycleContext {
    NotApplicable,
    Unavailable,
    SourceBacked {
        ownership: Ownership,
        cleanup_policy: CleanupPolicy,
    },
}

impl ManagedResourceLifecycleContext {
    pub const fn ownership(self) -> Option<Ownership> {
        match self {
            Self::SourceBacked { ownership, .. } => Some(ownership),
            Self::NotApplicable | Self::Unavailable => None,
        }
    }

    pub const fn cleanup_policy(self) -> Option<CleanupPolicy> {
        match self {
            Self::SourceBacked { cleanup_policy, .. } => Some(cleanup_policy),
            Self::NotApplicable | Self::Unavailable => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ManagedResourceState {
    Observed,
    Provisioning {
        command_id: CommandId,
        phase: PhaseKey,
    },
    Ready {
        observed_at: SystemTime,
    },
    Deleting {
        command_id: CommandId,
        phase: PhaseKey,
    },
    Deleted {
        deleted_at: SystemTime,
    },
    Conflict {
        message: String,
    },
    Failed {
        message: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EnvironmentRecord {
    id: EnvironmentId,
    connection_id: ConnectionId,
    display_name: String,
    kind: EnvironmentKind,
    labels: Vec<String>,
    enabled: bool,
    public_config: BTreeMap<String, String>,
    secret_refs: BTreeMap<String, FleetSecretRef>,
    state: EnvironmentState,
    managed_resource_ids: Vec<ManagedResourceId>,
    created_at: SystemTime,
    updated_at: SystemTime,
}
impl EnvironmentRecord {
    pub fn register(
        id: EnvironmentId,
        connection_id: ConnectionId,
        display_name: String,
        kind: EnvironmentKind,
        labels: Vec<String>,
        enabled: bool,
        public_config: BTreeMap<String, String>,
        secret_refs: BTreeMap<String, FleetSecretRef>,
        now: SystemTime,
    ) -> Result<Self, EnvironmentRestoreError> {
        let record = Self {
            id,
            connection_id,
            display_name,
            kind,
            labels: normalize_labels(labels),
            enabled,
            public_config,
            secret_refs,
            state: EnvironmentState::Registered,
            managed_resource_ids: Vec::new(),
            created_at: now,
            updated_at: now,
        };
        if record.is_valid() {
            Ok(record)
        } else {
            Err(EnvironmentRestoreError::InvalidRecord)
        }
    }

    pub fn new(
        id: EnvironmentId,
        connection_id: ConnectionId,
        display_name: String,
        kind: EnvironmentKind,
        now: SystemTime,
    ) -> Self {
        Self::register(
            id,
            connection_id,
            display_name,
            kind,
            Vec::new(),
            true,
            BTreeMap::new(),
            BTreeMap::new(),
            now,
        )
        .expect("EnvironmentRecord::new requires a valid registration")
    }

    pub fn restore(
        id: EnvironmentId,
        connection_id: ConnectionId,
        display_name: String,
        kind: EnvironmentKind,
        labels: Vec<String>,
        enabled: bool,
        public_config: BTreeMap<String, String>,
        secret_refs: BTreeMap<String, FleetSecretRef>,
        state: EnvironmentState,
        managed_resource_ids: Vec<ManagedResourceId>,
        created_at: SystemTime,
        updated_at: SystemTime,
    ) -> Result<Self, EnvironmentRestoreError> {
        if display_name.trim().is_empty()
            || created_at > updated_at
            || managed_resource_ids.windows(2).any(|w| w[0] == w[1])
            || contains_public_secret(&public_config)
        {
            return Err(EnvironmentRestoreError::InvalidRecord);
        }
        Ok(Self {
            id,
            connection_id,
            display_name,
            kind,
            labels,
            enabled,
            public_config,
            secret_refs,
            state,
            managed_resource_ids,
            created_at,
            updated_at,
        })
    }
    pub fn id(&self) -> &EnvironmentId {
        &self.id
    }
    pub fn connection_id(&self) -> &ConnectionId {
        &self.connection_id
    }
    pub fn display_name(&self) -> &str {
        &self.display_name
    }
    pub fn kind(&self) -> EnvironmentKind {
        self.kind
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
    pub fn state(&self) -> &EnvironmentState {
        &self.state
    }
    pub fn managed_resource_ids(&self) -> &[ManagedResourceId] {
        &self.managed_resource_ids
    }
    pub fn created_at(&self) -> SystemTime {
        self.created_at
    }
    pub fn updated_at(&self) -> SystemTime {
        self.updated_at
    }

    fn replace_registration(
        &mut self,
        incoming: Self,
        now: SystemTime,
    ) -> Result<EnvironmentMutation, EnvironmentMutationError> {
        if !incoming.is_valid() {
            return Err(EnvironmentMutationError::InvalidRecord);
        }
        if self.connection_id != incoming.connection_id {
            return Err(EnvironmentMutationError::InvalidRecord);
        }
        if matches!(self.state, EnvironmentState::Deleted { .. }) {
            return Err(EnvironmentMutationError::AlreadyDeleted);
        }
        if now < self.updated_at || incoming.created_at > now || incoming.updated_at > now {
            return Err(EnvironmentMutationError::BackdatedTransition);
        }
        let changed = self.display_name != incoming.display_name
            || self.kind != incoming.kind
            || self.labels != incoming.labels
            || self.enabled != incoming.enabled
            || self.public_config != incoming.public_config
            || self.secret_refs != incoming.secret_refs
            || self.managed_resource_ids != incoming.managed_resource_ids;
        if !changed {
            return Ok(EnvironmentMutation::Unchanged);
        }
        self.display_name = incoming.display_name;
        self.kind = incoming.kind;
        self.labels = incoming.labels;
        self.enabled = incoming.enabled;
        self.public_config = incoming.public_config;
        self.secret_refs = incoming.secret_refs;
        self.managed_resource_ids = incoming.managed_resource_ids;
        self.updated_at = now;
        Ok(EnvironmentMutation::Updated)
    }

    fn is_valid(&self) -> bool {
        !self.display_name.trim().is_empty()
            && self.created_at <= self.updated_at
            && !self.managed_resource_ids.windows(2).any(|w| w[0] == w[1])
            && !contains_public_secret(&self.public_config)
    }

    fn begin_deploy(
        &mut self,
        command_id: CommandId,
        phase: PhaseKey,
        now: SystemTime,
    ) -> Result<EnvironmentMutation, EnvironmentMutationError> {
        if now < self.updated_at {
            return Err(EnvironmentMutationError::BackdatedTransition);
        }
        if matches!(&self.state, EnvironmentState::Deploying { command_id: current, phase: current_phase } if current == &command_id && current_phase == &phase)
        {
            return Ok(EnvironmentMutation::Unchanged);
        }
        if !matches!(
            self.state,
            EnvironmentState::Registered | EnvironmentState::Failed { .. }
        ) {
            return Err(EnvironmentMutationError::InvalidTransition);
        }
        self.state = EnvironmentState::Deploying { command_id, phase };
        self.updated_at = now;
        Ok(EnvironmentMutation::DeploymentStarted)
    }

    fn finish_deploy(
        &mut self,
        command_id: &CommandId,
        phase: &PhaseKey,
        ready_at: SystemTime,
    ) -> Result<EnvironmentMutation, EnvironmentMutationError> {
        if ready_at < self.updated_at {
            return Err(EnvironmentMutationError::BackdatedTransition);
        }
        let EnvironmentState::Deploying {
            command_id: current,
            phase: current_phase,
        } = &self.state
        else {
            return Err(EnvironmentMutationError::InvalidTransition);
        };
        if current != command_id || current_phase != phase {
            return Err(EnvironmentMutationError::StaleCommand);
        }
        self.state = EnvironmentState::Ready { ready_at };
        self.updated_at = ready_at;
        Ok(EnvironmentMutation::DeploymentCompleted)
    }

    fn fail_deploy(
        &mut self,
        command_id: &CommandId,
        phase: &PhaseKey,
        message: String,
        failed_at: SystemTime,
    ) -> Result<EnvironmentMutation, EnvironmentMutationError> {
        if failed_at < self.updated_at {
            return Err(EnvironmentMutationError::BackdatedTransition);
        }
        let EnvironmentState::Deploying {
            command_id: current,
            phase: current_phase,
        } = &self.state
        else {
            return Err(EnvironmentMutationError::InvalidTransition);
        };
        if current != command_id || current_phase != phase {
            return Err(EnvironmentMutationError::StaleCommand);
        }
        if message.trim().is_empty() {
            return Err(EnvironmentMutationError::InvalidRecord);
        }
        self.state = EnvironmentState::Failed { message };
        self.updated_at = failed_at;
        Ok(EnvironmentMutation::Failed)
    }

    fn begin_delete(
        &mut self,
        command_id: CommandId,
        phase: PhaseKey,
        now: SystemTime,
    ) -> Result<EnvironmentMutation, EnvironmentMutationError> {
        if now < self.updated_at {
            return Err(EnvironmentMutationError::BackdatedTransition);
        }
        if matches!(&self.state, EnvironmentState::Deleting { command_id: current, phase: current_phase } if current == &command_id && current_phase == &phase)
        {
            return Ok(EnvironmentMutation::Unchanged);
        }
        if matches!(self.state, EnvironmentState::Deleted { .. }) {
            return Err(EnvironmentMutationError::AlreadyDeleted);
        }
        if matches!(self.state, EnvironmentState::Deploying { .. }) {
            return Err(EnvironmentMutationError::InvalidTransition);
        }
        self.state = EnvironmentState::Deleting { command_id, phase };
        self.updated_at = now;
        Ok(EnvironmentMutation::DeletionStarted)
    }

    fn finish_delete(
        &mut self,
        command_id: &CommandId,
        phase: &PhaseKey,
        deleted_at: SystemTime,
    ) -> Result<EnvironmentMutation, EnvironmentMutationError> {
        if deleted_at < self.updated_at {
            return Err(EnvironmentMutationError::BackdatedTransition);
        }
        let EnvironmentState::Deleting {
            command_id: current,
            phase: current_phase,
        } = &self.state
        else {
            return Err(EnvironmentMutationError::InvalidTransition);
        };
        if current != command_id || current_phase != phase {
            return Err(EnvironmentMutationError::StaleCommand);
        }
        self.state = EnvironmentState::Deleted { deleted_at };
        self.updated_at = deleted_at;
        Ok(EnvironmentMutation::DeletionCompleted)
    }

    fn fail_delete(
        &mut self,
        command_id: &CommandId,
        phase: &PhaseKey,
        message: String,
        failed_at: SystemTime,
    ) -> Result<EnvironmentMutation, EnvironmentMutationError> {
        if failed_at < self.updated_at {
            return Err(EnvironmentMutationError::BackdatedTransition);
        }
        let EnvironmentState::Deleting {
            command_id: current,
            phase: current_phase,
        } = &self.state
        else {
            return Err(EnvironmentMutationError::InvalidTransition);
        };
        if current != command_id || current_phase != phase {
            return Err(EnvironmentMutationError::StaleCommand);
        }
        if message.trim().is_empty() {
            return Err(EnvironmentMutationError::InvalidRecord);
        }
        self.state = EnvironmentState::Failed { message };
        self.updated_at = failed_at;
        Ok(EnvironmentMutation::Failed)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EnvironmentRestoreError {
    InvalidRecord,
    DuplicateId,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EnvironmentMutation {
    Inserted,
    Updated,
    Unchanged,
    DeploymentStarted,
    DeploymentCompleted,
    DeletionStarted,
    DeletionCompleted,
    Failed,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct EnvironmentCleanupPlan {
    delete: Vec<ManagedResourceId>,
    skipped: Vec<(ManagedResourceId, CleanupSkipReason)>,
}

impl EnvironmentCleanupPlan {
    pub fn delete(&self) -> &[ManagedResourceId] {
        &self.delete
    }

    pub fn skipped(&self) -> &[(ManagedResourceId, CleanupSkipReason)] {
        &self.skipped
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CleanupSkipReason {
    AlreadyDeleted,
    NotMatchaOwned,
    PolicyPreservesResource,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ManagedResourceMutation {
    Inserted,
    ObservedRefreshed,
    ProvisioningStarted,
    ProvisioningCompleted,
    DeletionStarted,
    DeletionCompleted,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EnvironmentMutationError {
    NotFound,
    AlreadyDeleted,
    InvalidTransition,
    StaleCommand,
    BackdatedTransition,
    ResourceNotFound,
    ResourceEnvironmentMismatch,
    ResourceConnectionMismatch,
    ConflictingResourceIdentity,
    CleanupNotPermitted,
    InvalidRecord,
    DuplicateId,
}

impl fmt::Display for EnvironmentMutationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::NotFound => "environment or managed resource not found",
            Self::AlreadyDeleted => "environment is deleted",
            Self::InvalidTransition => "environment lifecycle transition is not allowed",
            Self::StaleCommand => "environment lifecycle command is stale",
            Self::BackdatedTransition => "environment lifecycle transition is backdated",
            Self::ResourceNotFound => "managed resource not found",
            Self::ResourceEnvironmentMismatch => "managed resource belongs to another environment",
            Self::ResourceConnectionMismatch => "managed resource belongs to another connection",
            Self::ConflictingResourceIdentity => {
                "managed resource identity conflicts with persisted facts"
            }
            Self::CleanupNotPermitted => "managed resource cleanup is not permitted",
            Self::InvalidRecord => "environment record is invalid",
            Self::DuplicateId => "environment or managed resource ID already exists",
        })
    }
}

impl std::error::Error for EnvironmentMutationError {}
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct EnvironmentStore {
    environments: BTreeMap<EnvironmentId, EnvironmentRecord>,
    managed_resources: BTreeMap<ManagedResourceId, ManagedResourceRecord>,
}
impl EnvironmentStore {
    pub fn restore(
        environments: impl IntoIterator<Item = EnvironmentRecord>,
        resources: impl IntoIterator<Item = ManagedResourceRecord>,
    ) -> Result<Self, EnvironmentRestoreError> {
        let mut s = Self::default();
        for e in environments {
            if s.environments.insert(e.id.clone(), e).is_some() {
                return Err(EnvironmentRestoreError::DuplicateId);
            }
        }
        for r in resources {
            if s.managed_resources.insert(r.id.clone(), r).is_some() {
                return Err(EnvironmentRestoreError::DuplicateId);
            }
        }
        Ok(s)
    }
    pub fn environments(&self) -> impl Iterator<Item = &EnvironmentRecord> {
        self.environments.values()
    }
    pub fn managed_resources(&self) -> impl Iterator<Item = &ManagedResourceRecord> {
        self.managed_resources.values()
    }
    pub fn environment(&self, id: &EnvironmentId) -> Option<&EnvironmentRecord> {
        self.environments.get(id)
    }

    pub fn managed_resource(&self, id: &ManagedResourceId) -> Option<&ManagedResourceRecord> {
        self.managed_resources.get(id)
    }

    pub fn managed_resource_lifecycle_context(
        &self,
        id: Option<&ManagedResourceId>,
    ) -> ManagedResourceLifecycleContext {
        let Some(id) = id else {
            return ManagedResourceLifecycleContext::NotApplicable;
        };
        self.managed_resources
            .get(id)
            .map(|resource| ManagedResourceLifecycleContext::SourceBacked {
                ownership: resource.ownership(),
                cleanup_policy: resource.cleanup_policy(),
            })
            .unwrap_or(ManagedResourceLifecycleContext::Unavailable)
    }

    pub fn register_environment(
        &mut self,
        record: EnvironmentRecord,
        now: SystemTime,
    ) -> Result<EnvironmentMutation, EnvironmentMutationError> {
        if let Some(existing) = self.environments.get_mut(record.id()) {
            return existing.replace_registration(record, now);
        }
        if !record.is_valid() || record.created_at() > now || record.updated_at() > now {
            return Err(EnvironmentMutationError::InvalidRecord);
        }
        self.environments.insert(record.id.clone(), record);
        Ok(EnvironmentMutation::Inserted)
    }

    pub fn start_deployment(
        &mut self,
        id: &EnvironmentId,
        command_id: CommandId,
        phase: PhaseKey,
        now: SystemTime,
    ) -> Result<EnvironmentMutation, EnvironmentMutationError> {
        self.environments
            .get_mut(id)
            .ok_or(EnvironmentMutationError::NotFound)?
            .begin_deploy(command_id, phase, now)
    }

    pub fn complete_deployment(
        &mut self,
        id: &EnvironmentId,
        command_id: &CommandId,
        phase: &PhaseKey,
        ready_at: SystemTime,
    ) -> Result<EnvironmentMutation, EnvironmentMutationError> {
        self.environments
            .get_mut(id)
            .ok_or(EnvironmentMutationError::NotFound)?
            .finish_deploy(command_id, phase, ready_at)
    }

    pub fn fail_deployment(
        &mut self,
        id: &EnvironmentId,
        command_id: &CommandId,
        phase: &PhaseKey,
        message: String,
        failed_at: SystemTime,
    ) -> Result<EnvironmentMutation, EnvironmentMutationError> {
        self.environments
            .get_mut(id)
            .ok_or(EnvironmentMutationError::NotFound)?
            .fail_deploy(command_id, phase, message, failed_at)
    }

    pub fn start_deletion(
        &mut self,
        id: &EnvironmentId,
        command_id: CommandId,
        phase: PhaseKey,
        now: SystemTime,
    ) -> Result<EnvironmentMutation, EnvironmentMutationError> {
        self.environments
            .get_mut(id)
            .ok_or(EnvironmentMutationError::NotFound)?
            .begin_delete(command_id, phase, now)
    }

    pub fn complete_deletion(
        &mut self,
        id: &EnvironmentId,
        command_id: &CommandId,
        phase: &PhaseKey,
        deleted_at: SystemTime,
    ) -> Result<EnvironmentMutation, EnvironmentMutationError> {
        self.environments
            .get_mut(id)
            .ok_or(EnvironmentMutationError::NotFound)?
            .finish_delete(command_id, phase, deleted_at)
    }

    pub fn fail_deletion(
        &mut self,
        id: &EnvironmentId,
        command_id: &CommandId,
        phase: &PhaseKey,
        message: String,
        failed_at: SystemTime,
    ) -> Result<EnvironmentMutation, EnvironmentMutationError> {
        self.environments
            .get_mut(id)
            .ok_or(EnvironmentMutationError::NotFound)?
            .fail_delete(command_id, phase, message, failed_at)
    }

    pub fn register_managed_resource(
        &mut self,
        resource: ManagedResourceRecord,
    ) -> Result<ManagedResourceMutation, EnvironmentMutationError> {
        if self.environments.get(resource.environment_id()).is_none() {
            return Err(EnvironmentMutationError::NotFound);
        }
        if self.managed_resources.contains_key(resource.id()) {
            return Err(EnvironmentMutationError::DuplicateId);
        }
        if resource.is_tombstone() {
            return Err(EnvironmentMutationError::InvalidRecord);
        }
        let environment = self
            .environments
            .get_mut(resource.environment_id())
            .expect("environment presence was checked above");
        if environment.connection_id() != resource.connection_id() {
            return Err(EnvironmentMutationError::ResourceConnectionMismatch);
        }
        if !environment.managed_resource_ids.contains(resource.id()) {
            environment.managed_resource_ids.push(resource.id().clone());
            environment.managed_resource_ids.sort();
        }
        self.managed_resources.insert(resource.id.clone(), resource);
        Ok(ManagedResourceMutation::Inserted)
    }

    pub fn refresh_observed_managed_resource(
        &mut self,
        id: &ManagedResourceId,
        connection_id: &ConnectionId,
        environment_id: &EnvironmentId,
        metadata: ManagedResourceMetadata,
        observed_at: SystemTime,
    ) -> Result<ManagedResourceMutation, EnvironmentMutationError> {
        let resource = self
            .managed_resources
            .get(id)
            .ok_or(EnvironmentMutationError::ResourceNotFound)?;
        if resource.connection_id() != connection_id {
            return Err(EnvironmentMutationError::ResourceConnectionMismatch);
        }
        if resource.environment_id() != environment_id {
            return Err(EnvironmentMutationError::ResourceEnvironmentMismatch);
        }
        let environment = self
            .environments
            .get(environment_id)
            .ok_or(EnvironmentMutationError::NotFound)?;
        if environment.connection_id() != connection_id {
            return Err(EnvironmentMutationError::ResourceConnectionMismatch);
        }
        self.resource_mut(id)?
            .refresh_metadata(metadata, observed_at)
    }

    pub fn start_resource_provisioning(
        &mut self,
        id: &ManagedResourceId,
        command_id: CommandId,
        phase: PhaseKey,
        now: SystemTime,
    ) -> Result<ManagedResourceMutation, EnvironmentMutationError> {
        let resource = self.resource_mut(id)?;
        if now < resource.updated_at {
            return Err(EnvironmentMutationError::BackdatedTransition);
        }
        if matches!(&resource.state, ManagedResourceState::Provisioning { command_id: current, phase: current_phase } if current == &command_id && current_phase == &phase)
        {
            return Ok(ManagedResourceMutation::ProvisioningStarted);
        }
        if !matches!(
            resource.state,
            ManagedResourceState::Observed | ManagedResourceState::Failed { .. }
        ) {
            return Err(EnvironmentMutationError::InvalidTransition);
        }
        resource.state = ManagedResourceState::Provisioning { command_id, phase };
        resource.updated_at = now;
        Ok(ManagedResourceMutation::ProvisioningStarted)
    }

    pub fn fail_resource_provisioning(
        &mut self,
        id: &ManagedResourceId,
        command_id: &CommandId,
        phase: &PhaseKey,
        message: String,
        failed_at: SystemTime,
    ) -> Result<ManagedResourceMutation, EnvironmentMutationError> {
        let resource = self.resource_mut(id)?;
        if failed_at < resource.updated_at {
            return Err(EnvironmentMutationError::BackdatedTransition);
        }
        let ManagedResourceState::Provisioning {
            command_id: current,
            phase: current_phase,
        } = &resource.state
        else {
            return Err(EnvironmentMutationError::InvalidTransition);
        };
        if current != command_id || current_phase != phase {
            return Err(EnvironmentMutationError::StaleCommand);
        }
        if message.trim().is_empty() {
            return Err(EnvironmentMutationError::InvalidRecord);
        }
        resource.state = ManagedResourceState::Failed { message };
        resource.updated_at = failed_at;
        Ok(ManagedResourceMutation::Failed)
    }

    pub fn complete_resource_provisioning(
        &mut self,
        id: &ManagedResourceId,
        command_id: &CommandId,
        phase: &PhaseKey,
        observed_at: SystemTime,
    ) -> Result<ManagedResourceMutation, EnvironmentMutationError> {
        let resource = self.resource_mut(id)?;
        if observed_at < resource.updated_at {
            return Err(EnvironmentMutationError::BackdatedTransition);
        }
        let ManagedResourceState::Provisioning {
            command_id: current,
            phase: current_phase,
        } = &resource.state
        else {
            return Err(EnvironmentMutationError::InvalidTransition);
        };
        if current != command_id || current_phase != phase {
            return Err(EnvironmentMutationError::StaleCommand);
        }
        resource.state = ManagedResourceState::Ready { observed_at };
        resource.updated_at = observed_at;
        Ok(ManagedResourceMutation::ProvisioningCompleted)
    }

    pub fn materialize_resource_provisioning(
        &mut self,
        id: &ManagedResourceId,
        command_id: &CommandId,
        phase: &PhaseKey,
        metadata: ManagedResourceMetadata,
        observed_at: SystemTime,
    ) -> Result<ManagedResourceMutation, EnvironmentMutationError> {
        let (provider, kind) = {
            let resource = self
                .managed_resources
                .get(id)
                .ok_or(EnvironmentMutationError::ResourceNotFound)?;
            (resource.provider(), resource.kind())
        };
        if !metadata.validate_for(provider, kind) {
            return Err(EnvironmentMutationError::InvalidRecord);
        }
        let resource = self.resource_mut(id)?;
        if observed_at < resource.updated_at {
            return Err(EnvironmentMutationError::BackdatedTransition);
        }
        let ManagedResourceState::Provisioning {
            command_id: current,
            phase: current_phase,
        } = &resource.state
        else {
            return Err(EnvironmentMutationError::InvalidTransition);
        };
        if current != command_id || current_phase != phase {
            return Err(EnvironmentMutationError::StaleCommand);
        }
        resource.metadata = Some(metadata);
        resource.state = ManagedResourceState::Ready { observed_at };
        resource.updated_at = observed_at;
        Ok(ManagedResourceMutation::ProvisioningCompleted)
    }

    pub fn cleanup_plan(
        &self,
        environment_id: &EnvironmentId,
    ) -> Result<EnvironmentCleanupPlan, EnvironmentMutationError> {
        let environment = self
            .environments
            .get(environment_id)
            .ok_or(EnvironmentMutationError::NotFound)?;
        let mut plan = EnvironmentCleanupPlan::default();
        for id in &environment.managed_resource_ids {
            let resource = self
                .managed_resources
                .get(id)
                .ok_or(EnvironmentMutationError::ResourceNotFound)?;
            if resource.environment_id() != environment_id {
                return Err(EnvironmentMutationError::ResourceEnvironmentMismatch);
            }
            if resource.connection_id() != environment.connection_id() {
                return Err(EnvironmentMutationError::ResourceConnectionMismatch);
            }
            if resource.is_tombstone() {
                plan.skipped
                    .push((id.clone(), CleanupSkipReason::AlreadyDeleted));
            } else if resource.ownership() != Ownership::MatchaManaged {
                plan.skipped
                    .push((id.clone(), CleanupSkipReason::NotMatchaOwned));
            } else if resource.cleanup_policy() != CleanupPolicy::DeleteOnEnvironmentDelete {
                plan.skipped
                    .push((id.clone(), CleanupSkipReason::PolicyPreservesResource));
            } else {
                plan.delete.push(id.clone());
            }
        }
        Ok(plan)
    }

    pub fn cleanup_resource_ids(
        &self,
        environment_id: &EnvironmentId,
    ) -> Result<Vec<ManagedResourceId>, EnvironmentMutationError> {
        Ok(self.cleanup_plan(environment_id)?.delete)
    }

    pub fn start_resource_deletion(
        &mut self,
        id: &ManagedResourceId,
        command_id: CommandId,
        phase: PhaseKey,
        now: SystemTime,
    ) -> Result<ManagedResourceMutation, EnvironmentMutationError> {
        let resource = self.resource_mut(id)?;
        if resource.ownership() != Ownership::MatchaManaged
            || resource.cleanup_policy() != CleanupPolicy::DeleteOnEnvironmentDelete
        {
            return Err(EnvironmentMutationError::CleanupNotPermitted);
        }
        if now < resource.updated_at {
            return Err(EnvironmentMutationError::BackdatedTransition);
        }
        if matches!(&resource.state, ManagedResourceState::Deleting { command_id: current, phase: current_phase } if current == &command_id && current_phase == &phase)
        {
            return Ok(ManagedResourceMutation::DeletionStarted);
        }
        if !matches!(
            resource.state,
            ManagedResourceState::Observed
                | ManagedResourceState::Ready { .. }
                | ManagedResourceState::Failed { .. }
        ) {
            return Err(EnvironmentMutationError::InvalidTransition);
        }
        resource.state = ManagedResourceState::Deleting { command_id, phase };
        resource.updated_at = now;
        Ok(ManagedResourceMutation::DeletionStarted)
    }

    pub fn complete_resource_deletion(
        &mut self,
        id: &ManagedResourceId,
        command_id: &CommandId,
        phase: &PhaseKey,
        deleted_at: SystemTime,
    ) -> Result<ManagedResourceMutation, EnvironmentMutationError> {
        let resource = self.resource_mut(id)?;
        if deleted_at < resource.updated_at {
            return Err(EnvironmentMutationError::BackdatedTransition);
        }
        let ManagedResourceState::Deleting {
            command_id: current,
            phase: current_phase,
        } = &resource.state
        else {
            return Err(EnvironmentMutationError::InvalidTransition);
        };
        if current != command_id || current_phase != phase {
            return Err(EnvironmentMutationError::StaleCommand);
        }
        resource.state = ManagedResourceState::Deleted { deleted_at };
        resource.tombstone = true;
        resource.updated_at = deleted_at;
        Ok(ManagedResourceMutation::DeletionCompleted)
    }

    pub fn fail_resource_deletion(
        &mut self,
        id: &ManagedResourceId,
        command_id: &CommandId,
        phase: &PhaseKey,
        message: String,
        failed_at: SystemTime,
    ) -> Result<ManagedResourceMutation, EnvironmentMutationError> {
        let resource = self.resource_mut(id)?;
        if failed_at < resource.updated_at {
            return Err(EnvironmentMutationError::BackdatedTransition);
        }
        let ManagedResourceState::Deleting {
            command_id: current,
            phase: current_phase,
        } = &resource.state
        else {
            return Err(EnvironmentMutationError::InvalidTransition);
        };
        if current != command_id || current_phase != phase {
            return Err(EnvironmentMutationError::StaleCommand);
        }
        if message.trim().is_empty() {
            return Err(EnvironmentMutationError::InvalidRecord);
        }
        resource.state = ManagedResourceState::Failed { message };
        resource.updated_at = failed_at;
        Ok(ManagedResourceMutation::Failed)
    }

    fn resource_mut(
        &mut self,
        id: &ManagedResourceId,
    ) -> Result<&mut ManagedResourceRecord, EnvironmentMutationError> {
        self.managed_resources
            .get_mut(id)
            .ok_or(EnvironmentMutationError::ResourceNotFound)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagedResourceRef {
    provider: ManagedResourceProvider,
    kind: ManagedResourceKind,
    remote_resource_id: String,
    namespace: Option<String>,
    name: Option<String>,
}

impl ManagedResourceRef {
    pub fn try_new(
        provider: ManagedResourceProvider,
        kind: ManagedResourceKind,
        remote_resource_id: impl Into<String>,
        namespace: Option<String>,
        name: Option<String>,
    ) -> Result<Self, EnvironmentRestoreError> {
        let remote_resource_id = remote_resource_id.into();
        if remote_resource_id.trim().is_empty()
            || namespace
                .as_deref()
                .is_some_and(|value| value.trim().is_empty())
            || name.as_deref().is_some_and(|value| value.trim().is_empty())
        {
            return Err(EnvironmentRestoreError::InvalidRecord);
        }
        Ok(Self {
            provider,
            kind,
            remote_resource_id,
            namespace,
            name,
        })
    }

    pub fn provider(&self) -> ManagedResourceProvider {
        self.provider
    }

    pub fn kind(&self) -> ManagedResourceKind {
        self.kind
    }

    pub fn remote_resource_id(&self) -> &str {
        &self.remote_resource_id
    }

    pub fn namespace(&self) -> Option<&str> {
        self.namespace.as_deref()
    }

    pub fn name(&self) -> Option<&str> {
        self.name.as_deref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ManagedResourceAssociation {
    DockerContainer {
        name: String,
    },
    KubernetesWorkload {
        namespace: String,
        deployment_name: String,
        service_name: String,
    },
}

impl ManagedResourceAssociation {
    pub fn docker_container(name: impl Into<String>) -> Result<Self, EnvironmentRestoreError> {
        let name = name.into();
        if name.trim().is_empty() {
            return Err(EnvironmentRestoreError::InvalidRecord);
        }
        Ok(Self::DockerContainer { name })
    }

    pub fn kubernetes_workload(
        namespace: impl Into<String>,
        deployment_name: impl Into<String>,
        service_name: impl Into<String>,
    ) -> Result<Self, EnvironmentRestoreError> {
        let namespace = namespace.into();
        let deployment_name = deployment_name.into();
        let service_name = service_name.into();
        if namespace.trim().is_empty()
            || deployment_name.trim().is_empty()
            || service_name.trim().is_empty()
        {
            return Err(EnvironmentRestoreError::InvalidRecord);
        }
        Ok(Self::KubernetesWorkload {
            namespace,
            deployment_name,
            service_name,
        })
    }

    pub fn docker_name(&self) -> Option<&str> {
        match self {
            Self::DockerContainer { name } => Some(name),
            Self::KubernetesWorkload { .. } => None,
        }
    }

    pub fn kubernetes_workload_names(&self) -> Option<(&str, &str, &str)> {
        match self {
            Self::DockerContainer { .. } => None,
            Self::KubernetesWorkload {
                namespace,
                deployment_name,
                service_name,
            } => Some((namespace, deployment_name, service_name)),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagedResourceMetadata {
    display_name: String,
    labels: BTreeMap<String, String>,
    remote_refs: Vec<ManagedResourceRef>,
    ownership_evidence: BTreeMap<String, String>,
    association: ManagedResourceAssociation,
    observed_at: SystemTime,
}

impl ManagedResourceMetadata {
    pub fn try_new(
        display_name: impl Into<String>,
        labels: BTreeMap<String, String>,
        remote_refs: Vec<ManagedResourceRef>,
        ownership_evidence: BTreeMap<String, String>,
        association: ManagedResourceAssociation,
        observed_at: SystemTime,
    ) -> Result<Self, EnvironmentRestoreError> {
        let display_name = display_name.into();
        if display_name.trim().is_empty()
            || labels.is_empty()
            || ownership_evidence.is_empty()
            || remote_refs.is_empty()
            || !valid_string_map(&labels)
            || !valid_string_map(&ownership_evidence)
        {
            return Err(EnvironmentRestoreError::InvalidRecord);
        }
        Ok(Self {
            display_name,
            labels,
            remote_refs,
            ownership_evidence,
            association,
            observed_at,
        })
    }

    fn validate_for(&self, provider: ManagedResourceProvider, kind: ManagedResourceKind) -> bool {
        let association_matches = matches!(
            (&self.association, provider, kind),
            (
                ManagedResourceAssociation::DockerContainer { .. },
                ManagedResourceProvider::Docker,
                ManagedResourceKind::DockerContainer,
            ) | (
                ManagedResourceAssociation::KubernetesWorkload { .. },
                ManagedResourceProvider::Kubernetes,
                ManagedResourceKind::KubernetesWorkload,
            )
        );
        association_matches
            && self
                .remote_refs
                .iter()
                .all(|reference| reference.provider() == provider)
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    pub fn labels(&self) -> &BTreeMap<String, String> {
        &self.labels
    }

    pub fn remote_refs(&self) -> &[ManagedResourceRef] {
        &self.remote_refs
    }

    pub fn ownership_evidence(&self) -> &BTreeMap<String, String> {
        &self.ownership_evidence
    }

    pub fn association(&self) -> &ManagedResourceAssociation {
        &self.association
    }

    pub fn observed_at(&self) -> SystemTime {
        self.observed_at
    }
}

fn valid_string_map(values: &BTreeMap<String, String>) -> bool {
    values
        .iter()
        .all(|(key, value)| !key.trim().is_empty() && !value.trim().is_empty())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagedResourceRecord {
    id: ManagedResourceId,
    connection_id: ConnectionId,
    environment_id: EnvironmentId,
    provider: ManagedResourceProvider,
    kind: ManagedResourceKind,
    remote_resource_id: String,
    metadata: Option<ManagedResourceMetadata>,
    ownership: Ownership,
    cleanup_policy: CleanupPolicy,
    state: ManagedResourceState,
    tombstone: bool,
    created_at: SystemTime,
    updated_at: SystemTime,
}
impl ManagedResourceRecord {
    pub fn new(
        id: ManagedResourceId,
        connection_id: ConnectionId,
        environment_id: EnvironmentId,
        provider: ManagedResourceProvider,
        kind: ManagedResourceKind,
        remote_resource_id: String,
        ownership: Ownership,
        cleanup_policy: CleanupPolicy,
        now: SystemTime,
    ) -> Self {
        Self {
            id,
            connection_id,
            environment_id,
            provider,
            kind,
            remote_resource_id,
            metadata: None,
            ownership,
            cleanup_policy,
            state: ManagedResourceState::Observed,
            tombstone: false,
            created_at: now,
            updated_at: now,
        }
    }

    pub fn with_metadata_ready(
        id: ManagedResourceId,
        connection_id: ConnectionId,
        environment_id: EnvironmentId,
        provider: ManagedResourceProvider,
        kind: ManagedResourceKind,
        remote_resource_id: String,
        ownership: Ownership,
        cleanup_policy: CleanupPolicy,
        metadata: ManagedResourceMetadata,
        created_at: SystemTime,
        observed_at: SystemTime,
    ) -> Result<Self, EnvironmentRestoreError> {
        if !metadata.validate_for(provider, kind)
            || remote_resource_id.trim().is_empty()
            || created_at > observed_at
        {
            return Err(EnvironmentRestoreError::InvalidRecord);
        }
        Ok(Self {
            id,
            connection_id,
            environment_id,
            provider,
            kind,
            remote_resource_id,
            metadata: Some(metadata),
            ownership,
            cleanup_policy,
            state: ManagedResourceState::Ready { observed_at },
            tombstone: false,
            created_at,
            updated_at: observed_at,
        })
    }

    pub fn with_metadata_observed(
        id: ManagedResourceId,
        connection_id: ConnectionId,
        environment_id: EnvironmentId,
        provider: ManagedResourceProvider,
        kind: ManagedResourceKind,
        remote_resource_id: String,
        ownership: Ownership,
        cleanup_policy: CleanupPolicy,
        metadata: ManagedResourceMetadata,
        created_at: SystemTime,
        observed_at: SystemTime,
    ) -> Result<Self, EnvironmentRestoreError> {
        if !metadata.validate_for(provider, kind)
            || remote_resource_id.trim().is_empty()
            || created_at > observed_at
        {
            return Err(EnvironmentRestoreError::InvalidRecord);
        }
        Ok(Self {
            id,
            connection_id,
            environment_id,
            provider,
            kind,
            remote_resource_id,
            metadata: Some(metadata),
            ownership,
            cleanup_policy,
            state: ManagedResourceState::Observed,
            tombstone: false,
            created_at,
            updated_at: observed_at,
        })
    }

    pub fn restore(
        id: ManagedResourceId,
        connection_id: ConnectionId,
        environment_id: EnvironmentId,
        provider: ManagedResourceProvider,
        kind: ManagedResourceKind,
        remote_resource_id: String,
        ownership: Ownership,
        cleanup_policy: CleanupPolicy,
        state: ManagedResourceState,
        tombstone: bool,
        created_at: SystemTime,
        updated_at: SystemTime,
    ) -> Result<Self, EnvironmentRestoreError> {
        Self::restore_with_metadata(
            id,
            connection_id,
            environment_id,
            provider,
            kind,
            remote_resource_id,
            ownership,
            cleanup_policy,
            state,
            tombstone,
            created_at,
            updated_at,
            None,
        )
    }

    pub fn restore_with_metadata(
        id: ManagedResourceId,
        connection_id: ConnectionId,
        environment_id: EnvironmentId,
        provider: ManagedResourceProvider,
        kind: ManagedResourceKind,
        remote_resource_id: String,
        ownership: Ownership,
        cleanup_policy: CleanupPolicy,
        state: ManagedResourceState,
        tombstone: bool,
        created_at: SystemTime,
        updated_at: SystemTime,
        metadata: Option<ManagedResourceMetadata>,
    ) -> Result<Self, EnvironmentRestoreError> {
        if remote_resource_id.trim().is_empty()
            || created_at > updated_at
            || (tombstone && !matches!(state, ManagedResourceState::Deleted { .. }))
            || metadata
                .as_ref()
                .is_some_and(|value| !value.validate_for(provider, kind))
        {
            return Err(EnvironmentRestoreError::InvalidRecord);
        }
        Ok(Self {
            id,
            connection_id,
            environment_id,
            provider,
            kind,
            remote_resource_id,
            metadata,
            ownership,
            cleanup_policy,
            state,
            tombstone,
            created_at,
            updated_at,
        })
    }
    pub fn id(&self) -> &ManagedResourceId {
        &self.id
    }
    pub fn connection_id(&self) -> &ConnectionId {
        &self.connection_id
    }
    pub fn environment_id(&self) -> &EnvironmentId {
        &self.environment_id
    }
    pub fn provider(&self) -> ManagedResourceProvider {
        self.provider
    }
    pub fn kind(&self) -> ManagedResourceKind {
        self.kind
    }
    pub fn remote_resource_id(&self) -> &str {
        &self.remote_resource_id
    }
    pub fn metadata(&self) -> Option<&ManagedResourceMetadata> {
        self.metadata.as_ref()
    }

    fn refresh_metadata(
        &mut self,
        metadata: ManagedResourceMetadata,
        observed_at: SystemTime,
    ) -> Result<ManagedResourceMutation, EnvironmentMutationError> {
        if !metadata.validate_for(self.provider, self.kind) {
            return Err(EnvironmentMutationError::InvalidRecord);
        }
        if self.tombstone || matches!(self.state, ManagedResourceState::Deleted { .. }) {
            return Err(EnvironmentMutationError::AlreadyDeleted);
        }
        if observed_at < self.updated_at {
            return Err(EnvironmentMutationError::BackdatedTransition);
        }
        self.metadata = Some(metadata);
        self.updated_at = observed_at;
        Ok(ManagedResourceMutation::ObservedRefreshed)
    }

    pub fn ownership(&self) -> Ownership {
        self.ownership
    }
    pub fn cleanup_policy(&self) -> CleanupPolicy {
        self.cleanup_policy
    }
    pub fn state(&self) -> &ManagedResourceState {
        &self.state
    }
    pub fn is_tombstone(&self) -> bool {
        self.tombstone
    }
    pub fn created_at(&self) -> SystemTime {
        self.created_at
    }
    pub fn updated_at(&self) -> SystemTime {
        self.updated_at
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tombstone_and_command_refs_restore_atomically() {
        let now = SystemTime::UNIX_EPOCH;
        let c = ConnectionId::try_new("c").unwrap();
        let e = EnvironmentId::try_new("e").unwrap();
        let r = ManagedResourceRecord::restore(
            ManagedResourceId::try_new("r").unwrap(),
            c.clone(),
            e.clone(),
            ManagedResourceProvider::Ssh,
            ManagedResourceKind::SshAgentInstallation,
            "remote-r".into(),
            Ownership::MatchaManaged,
            CleanupPolicy::Orphan,
            ManagedResourceState::Deleted { deleted_at: now },
            true,
            now,
            now,
        )
        .unwrap();
        let env = EnvironmentRecord::restore(
            e,
            c,
            "env".into(),
            EnvironmentKind::SshWorkdir,
            vec![],
            true,
            BTreeMap::new(),
            BTreeMap::new(),
            EnvironmentState::Deleting {
                command_id: CommandId::try_new("cmd").unwrap(),
                phase: PhaseKey::try_new("delete").unwrap(),
            },
            vec![r.id().clone()],
            now,
            now,
        )
        .unwrap();
        assert_eq!(
            EnvironmentStore::restore([env], [r])
                .unwrap()
                .managed_resources()
                .count(),
            1
        );
    }

    fn environment(now: SystemTime) -> EnvironmentRecord {
        EnvironmentRecord::restore(
            EnvironmentId::try_new("env").unwrap(),
            ConnectionId::try_new("connection").unwrap(),
            "Environment".into(),
            EnvironmentKind::SshWorkdir,
            vec![],
            true,
            BTreeMap::new(),
            BTreeMap::new(),
            EnvironmentState::Registered,
            vec![],
            now,
            now,
        )
        .unwrap()
    }

    fn managed_resource(
        id: &str,
        ownership: Ownership,
        cleanup_policy: CleanupPolicy,
    ) -> ManagedResourceRecord {
        let now = SystemTime::UNIX_EPOCH;
        ManagedResourceRecord::restore(
            ManagedResourceId::try_new(id).unwrap(),
            ConnectionId::try_new("connection").unwrap(),
            EnvironmentId::try_new("env").unwrap(),
            ManagedResourceProvider::Ssh,
            ManagedResourceKind::SshAgentInstallation,
            "remote-resource".into(),
            ownership,
            cleanup_policy,
            ManagedResourceState::Ready { observed_at: now },
            false,
            now,
            now,
        )
        .unwrap()
    }

    #[test]
    fn lifecycle_requires_current_command_and_monotonic_time() {
        let now = SystemTime::UNIX_EPOCH;
        let command = CommandId::try_new("deploy").unwrap();
        let phase = PhaseKey::try_new("deploy").unwrap();
        let id = EnvironmentId::try_new("env").unwrap();
        let mut store = EnvironmentStore::restore([environment(now)], []).unwrap();
        assert_eq!(
            store.start_deployment(&id, command.clone(), phase.clone(), now),
            Ok(EnvironmentMutation::DeploymentStarted)
        );
        assert_eq!(
            store.complete_deployment(&id, &CommandId::try_new("other").unwrap(), &phase, now,),
            Err(EnvironmentMutationError::StaleCommand)
        );
        assert_eq!(
            store.complete_deployment(&id, &command, &phase, now),
            Ok(EnvironmentMutation::DeploymentCompleted)
        );
        assert_eq!(
            store.environment(&id).unwrap().state(),
            &EnvironmentState::Ready { ready_at: now }
        );
    }

    #[test]
    fn managed_resource_lifecycle_context_preserves_missing_and_not_applicable() {
        let now = SystemTime::UNIX_EPOCH;
        let environment = environment(now);
        let managed = managed_resource(
            "managed",
            Ownership::MatchaManaged,
            CleanupPolicy::DeleteOnEnvironmentDelete,
        );
        let managed_id = managed.id().clone();
        let missing_id = ManagedResourceId::try_new("missing").unwrap();
        let store = EnvironmentStore::restore([environment], [managed]).unwrap();

        assert_eq!(
            store.managed_resource_lifecycle_context(None),
            ManagedResourceLifecycleContext::NotApplicable
        );
        assert_eq!(
            store.managed_resource_lifecycle_context(Some(&missing_id)),
            ManagedResourceLifecycleContext::Unavailable
        );
        assert_eq!(
            store.managed_resource_lifecycle_context(Some(&managed_id)),
            ManagedResourceLifecycleContext::SourceBacked {
                ownership: Ownership::MatchaManaged,
                cleanup_policy: CleanupPolicy::DeleteOnEnvironmentDelete,
            }
        );
    }

    #[test]
    fn cleanup_plan_excludes_external_unverified_and_non_delete_resources() {
        let now = SystemTime::UNIX_EPOCH;
        let environment = environment(now);
        let mut managed = managed_resource(
            "resource",
            Ownership::MatchaManaged,
            CleanupPolicy::DeleteOnEnvironmentDelete,
        );
        let cleanup_id = managed.id().clone();
        let external = ManagedResourceRecord::restore(
            ManagedResourceId::try_new("external").unwrap(),
            managed.connection_id().clone(),
            managed.environment_id().clone(),
            managed.provider(),
            managed.kind(),
            "remote-external".into(),
            Ownership::External,
            CleanupPolicy::DeleteOnEnvironmentDelete,
            ManagedResourceState::Ready { observed_at: now },
            false,
            now,
            now,
        )
        .unwrap();
        let non_delete = ManagedResourceRecord::restore(
            ManagedResourceId::try_new("non-delete").unwrap(),
            managed.connection_id().clone(),
            managed.environment_id().clone(),
            managed.provider(),
            managed.kind(),
            "remote-non-delete".into(),
            Ownership::MatchaManaged,
            CleanupPolicy::Orphan,
            ManagedResourceState::Ready { observed_at: now },
            false,
            now,
            now,
        )
        .unwrap();
        let non_delete_id = non_delete.id().clone();
        managed.updated_at = now;
        let mut store =
            EnvironmentStore::restore([environment], [managed, external.clone(), non_delete])
                .unwrap();
        let id = EnvironmentId::try_new("env").unwrap();
        store
            .environments
            .get_mut(&id)
            .unwrap()
            .managed_resource_ids = vec![
            cleanup_id.clone(),
            non_delete_id,
            ManagedResourceId::try_new("external").unwrap(),
        ];
        assert_eq!(
            store.cleanup_resource_ids(&id).unwrap(),
            vec![cleanup_id.clone()]
        );
        assert_eq!(
            store.start_resource_deletion(
                &cleanup_id,
                CommandId::try_new("delete").unwrap(),
                PhaseKey::try_new("cleanup").unwrap(),
                now
            ),
            Ok(ManagedResourceMutation::DeletionStarted)
        );
    }

    #[test]
    fn registration_normalizes_labels_and_retains_public_config_and_secret_refs() {
        let now = SystemTime::UNIX_EPOCH;
        let secret = FleetSecretRef::parse("remote-fleet://credentials/ssh/key").unwrap();
        let mut public_config = BTreeMap::new();
        public_config.insert("host".into(), "example.test".into());
        let mut secret_refs = BTreeMap::new();
        secret_refs.insert("privateKey".into(), secret.clone());
        let record = EnvironmentRecord::register(
            EnvironmentId::try_new("environment").unwrap(),
            ConnectionId::try_new("connection").unwrap(),
            "Remote environment".into(),
            EnvironmentKind::SshWorkdir,
            vec![" prod ".into(), "prod".into(), "fleet".into()],
            false,
            public_config.clone(),
            secret_refs.clone(),
            now,
        )
        .unwrap();
        assert_eq!(record.labels(), &["fleet", "prod"]);
        assert!(!record.enabled());
        assert_eq!(record.public_config(), &public_config);
        assert_eq!(record.secret_refs(), &secret_refs);
        assert!(!format!("{record:?}").contains("remote-fleet://credentials/ssh/key"));
    }

    #[test]
    fn cleanup_plan_exposes_domain_policy_decisions_without_dispatching_them() {
        let now = SystemTime::UNIX_EPOCH;
        let environment = environment(now);
        let managed = managed_resource(
            "managed",
            Ownership::MatchaManaged,
            CleanupPolicy::DeleteOnEnvironmentDelete,
        );
        let external = managed_resource(
            "external",
            Ownership::External,
            CleanupPolicy::DeleteOnEnvironmentDelete,
        );
        let mut store = EnvironmentStore::restore([environment], [managed, external]).unwrap();
        store
            .environments
            .get_mut(&EnvironmentId::try_new("env").unwrap())
            .unwrap()
            .managed_resource_ids = vec![
            ManagedResourceId::try_new("managed").unwrap(),
            ManagedResourceId::try_new("external").unwrap(),
        ];
        let plan = store
            .cleanup_plan(&EnvironmentId::try_new("env").unwrap())
            .unwrap();
        assert_eq!(
            plan.delete(),
            &[ManagedResourceId::try_new("managed").unwrap()]
        );
        assert_eq!(plan.skipped().len(), 1);
        assert_eq!(plan.skipped()[0].1, CleanupSkipReason::NotMatchaOwned);
    }

    #[test]
    fn public_config_rejects_plaintext_secret_keys_on_registration() {
        let now = SystemTime::UNIX_EPOCH;
        let mut record = environment(now);
        record
            .public_config
            .insert("api_token".into(), "secret".into());
        let mut store = EnvironmentStore::default();
        assert_eq!(
            store.register_environment(record, now),
            Err(EnvironmentMutationError::InvalidRecord)
        );
    }
}
