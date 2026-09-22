use std::fmt;

use crate as fleet;
use getrandom::fill as random_fill;

use fleet::{
    environment::{
        CleanupPolicy, EnvironmentId, ManagedResourceId, ManagedResourceKind,
        ManagedResourceProvider, ManagedResourceState, Ownership,
    },
    store::FleetFacts,
};

use super::provider_resource::{
    ProviderResourceFact, ProviderResourceKind, ProviderResourceProvider,
};

/// Explicit authority for the identity that may be used when a provider fact is
/// materialized. The ID is always supplied by the owner; this producer never
/// derives one from provider, command, target, or display data.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ManagedResourceAllocationAuthority {
    Existing {
        id: ManagedResourceId,
        connection_id: fleet::connection::ConnectionId,
        environment_id: EnvironmentId,
        ownership: Ownership,
        cleanup_policy: CleanupPolicy,
    },
    New {
        id: ManagedResourceId,
        connection_id: fleet::connection::ConnectionId,
        environment_id: EnvironmentId,
        ownership: Ownership,
        cleanup_policy: CleanupPolicy,
    },
}

impl ManagedResourceAllocationAuthority {
    pub(crate) fn existing(
        id: ManagedResourceId,
        connection_id: fleet::connection::ConnectionId,
        environment_id: EnvironmentId,
        ownership: Ownership,
        cleanup_policy: CleanupPolicy,
    ) -> Self {
        Self::Existing {
            id,
            connection_id,
            environment_id,
            ownership,
            cleanup_policy,
        }
    }

    pub(crate) fn allocate(
        id: ManagedResourceId,
        connection_id: fleet::connection::ConnectionId,
        environment_id: EnvironmentId,
        ownership: Ownership,
        cleanup_policy: CleanupPolicy,
    ) -> Self {
        Self::New {
            id,
            connection_id,
            environment_id,
            ownership,
            cleanup_policy,
        }
    }

    fn id(&self) -> &ManagedResourceId {
        match self {
            Self::Existing { id, .. } | Self::New { id, .. } => id,
        }
    }

    fn connection_id(&self) -> &fleet::connection::ConnectionId {
        match self {
            Self::Existing { connection_id, .. } | Self::New { connection_id, .. } => connection_id,
        }
    }

    fn environment_id(&self) -> &EnvironmentId {
        match self {
            Self::Existing { environment_id, .. } | Self::New { environment_id, .. } => {
                environment_id
            }
        }
    }

    fn ownership(&self) -> Ownership {
        match self {
            Self::Existing { ownership, .. } | Self::New { ownership, .. } => *ownership,
        }
    }

    fn cleanup_policy(&self) -> CleanupPolicy {
        match self {
            Self::Existing { cleanup_policy, .. } | Self::New { cleanup_policy, .. } => {
                *cleanup_policy
            }
        }
    }

    fn is_existing(&self) -> bool {
        matches!(self, Self::Existing { .. })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ManagedResourceIdentityResolution {
    Reused(ManagedResourceId),
    Allocated(ManagedResourceId),
}

impl ManagedResourceIdentityResolution {
    pub(crate) fn id(&self) -> &ManagedResourceId {
        match self {
            Self::Reused(id) | Self::Allocated(id) => id,
        }
    }

    pub(crate) fn reused(&self) -> bool {
        matches!(self, Self::Reused(_))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ManagedResourceIdentityError {
    UnsupportedProviderFact,
    IdentityUnavailable,
    IdentityCollision,
    AmbiguousPersistedReceipt,
    DeletedPersistedReceipt,
    MissingPersistedIdentity,
    ConflictingIdentityAuthority,
    ConflictingResourceAssociation,
    AllocatedIdentityAlreadyExists,
}

impl fmt::Display for ManagedResourceIdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::UnsupportedProviderFact => {
                "provider fact cannot be materialized as a managed resource"
            }
            Self::IdentityUnavailable => "managed resource identity entropy is unavailable",
            Self::IdentityCollision => "managed resource identity allocation collided",
            Self::AmbiguousPersistedReceipt => {
                "provider receipt matches multiple persisted managed resources"
            }
            Self::DeletedPersistedReceipt => {
                "provider receipt matches a deleted managed resource tombstone"
            }
            Self::MissingPersistedIdentity => "existing managed resource identity is not persisted",
            Self::ConflictingIdentityAuthority => {
                "managed resource identity authority conflicts with persisted facts"
            }
            Self::ConflictingResourceAssociation => {
                "managed resource association conflicts with persisted facts"
            }
            Self::AllocatedIdentityAlreadyExists => {
                "new managed resource identity is already persisted"
            }
        })
    }
}

impl std::error::Error for ManagedResourceIdentityError {}

pub(crate) struct ManagedResourceIdentityProducer;

impl ManagedResourceIdentityProducer {
    pub(crate) fn allocate_opaque_id(
        facts: &FleetFacts,
    ) -> Result<ManagedResourceId, ManagedResourceIdentityError> {
        for _ in 0..8 {
            let mut entropy = [0_u8; 16];
            random_fill(&mut entropy)
                .map_err(|_| ManagedResourceIdentityError::IdentityUnavailable)?;
            let value = format!("managed-resource-{}", hex(&entropy));
            let id = ManagedResourceId::try_new(value)
                .map_err(|_| ManagedResourceIdentityError::IdentityUnavailable)?;
            if facts
                .managed_resources()
                .all(|resource| resource.id() != &id)
            {
                return Ok(id);
            }
        }
        Err(ManagedResourceIdentityError::IdentityCollision)
    }

    /// Resolve the opaque identity for one authoritative provider receipt.
    ///
    /// A persisted `(provider, kind, remote_id)` receipt is reused exactly when
    /// it identifies one resource and agrees with the explicit allocation
    /// authority. A new ID is accepted only through the explicit `New` authority;
    /// no value in `fact` is ever used to construct an ID.
    pub(crate) fn resolve(
        facts: &FleetFacts,
        authority: &ManagedResourceAllocationAuthority,
        fact: &ProviderResourceFact,
    ) -> Result<ManagedResourceIdentityResolution, ManagedResourceIdentityError> {
        let (provider, kind) = domain_kind(fact)?;
        let persisted_matches = facts
            .managed_resources()
            .filter(|resource| {
                resource.provider() == provider
                    && resource.kind() == kind
                    && resource.remote_resource_id() == fact.remote_id()
            })
            .collect::<Vec<_>>();
        let active_matches = persisted_matches
            .iter()
            .filter(|resource| {
                !resource.is_tombstone()
                    && !matches!(resource.state(), ManagedResourceState::Deleted { .. })
            })
            .collect::<Vec<_>>();

        if active_matches.len() > 1 {
            return Err(ManagedResourceIdentityError::AmbiguousPersistedReceipt);
        }
        if persisted_matches.iter().any(|resource| {
            resource.is_tombstone()
                || matches!(resource.state(), ManagedResourceState::Deleted { .. })
        }) {
            return Err(ManagedResourceIdentityError::DeletedPersistedReceipt);
        }

        if let Some(resource) = active_matches.first() {
            if resource.connection_id() != authority.connection_id()
                || resource.environment_id() != authority.environment_id()
            {
                return Err(ManagedResourceIdentityError::ConflictingResourceAssociation);
            }
            if resource.ownership() != authority.ownership()
                || resource.cleanup_policy() != authority.cleanup_policy()
            {
                return Err(ManagedResourceIdentityError::ConflictingResourceAssociation);
            }
            if authority.is_existing() && resource.id() != authority.id() {
                return Err(ManagedResourceIdentityError::ConflictingIdentityAuthority);
            }
            if resource.id() == authority.id() {
                return Ok(ManagedResourceIdentityResolution::Reused(
                    resource.id().clone(),
                ));
            }
            if facts
                .managed_resources()
                .any(|candidate| candidate.id() == authority.id())
            {
                return Err(ManagedResourceIdentityError::ConflictingIdentityAuthority);
            }
            return Ok(ManagedResourceIdentityResolution::Reused(
                resource.id().clone(),
            ));
        }

        if facts
            .managed_resources()
            .any(|resource| resource.id() == authority.id())
        {
            return Err(if authority.is_existing() {
                ManagedResourceIdentityError::ConflictingIdentityAuthority
            } else {
                ManagedResourceIdentityError::AllocatedIdentityAlreadyExists
            });
        }

        if authority.is_existing() {
            return Err(ManagedResourceIdentityError::MissingPersistedIdentity);
        }

        Ok(ManagedResourceIdentityResolution::Allocated(
            authority.id().clone(),
        ))
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut value = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(value, "{byte:02x}");
    }
    value
}

fn domain_kind(
    fact: &ProviderResourceFact,
) -> Result<(ManagedResourceProvider, ManagedResourceKind), ManagedResourceIdentityError> {
    match (fact.provider(), fact.kind()) {
        (ProviderResourceProvider::Docker, ProviderResourceKind::DockerContainer) => Ok((
            ManagedResourceProvider::Docker,
            ManagedResourceKind::DockerContainer,
        )),
        (ProviderResourceProvider::Kubernetes, ProviderResourceKind::KubernetesWorkload) => Ok((
            ManagedResourceProvider::Kubernetes,
            ManagedResourceKind::KubernetesWorkload,
        )),
        _ => Err(ManagedResourceIdentityError::UnsupportedProviderFact),
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, time::UNIX_EPOCH};

    use fleet::{
        environment::{EnvironmentKind, EnvironmentRecord, ManagedResourceRecord},
        store::FleetFactsRestoreInput,
    };

    use super::*;
    use crate::application::provider_resource::{
        ProviderOwnershipEvidence, ProviderResourceAssociation, ProviderResourceRef,
    };

    fn ids() -> (fleet::connection::ConnectionId, EnvironmentId) {
        (
            fleet::connection::ConnectionId::try_new("connection-1").unwrap(),
            EnvironmentId::try_new("environment-1").unwrap(),
        )
    }

    fn fact(remote_id: &str) -> ProviderResourceFact {
        let ownership = ProviderOwnershipEvidence::required(BTreeMap::from([(
            "com.matchaclaw.remote-fleet.managed".into(),
            "true".into(),
        )]))
        .unwrap();
        let association = ProviderResourceAssociation::docker_container("configured-name").unwrap();
        let reference = ProviderResourceRef::new(
            ProviderResourceProvider::Docker,
            ProviderResourceKind::DockerContainer,
            remote_id,
            None,
            Some("configured-name".into()),
        )
        .unwrap();
        ProviderResourceFact::confirmed(
            ProviderResourceProvider::Docker,
            ProviderResourceKind::DockerContainer,
            remote_id,
            vec![reference],
            ownership,
            association,
            "Docker container configured-name",
            BTreeMap::from([("com.matchaclaw.remote-fleet.managed".into(), "true".into())]),
            UNIX_EPOCH,
        )
        .unwrap()
    }

    fn authority(id: &str, existing: bool) -> ManagedResourceAllocationAuthority {
        let (connection_id, environment_id) = ids();
        let id = ManagedResourceId::try_new(id).unwrap();
        if existing {
            ManagedResourceAllocationAuthority::existing(
                id,
                connection_id,
                environment_id,
                Ownership::MatchaManaged,
                CleanupPolicy::DeleteOnEnvironmentDelete,
            )
        } else {
            ManagedResourceAllocationAuthority::allocate(
                id,
                connection_id,
                environment_id,
                Ownership::MatchaManaged,
                CleanupPolicy::DeleteOnEnvironmentDelete,
            )
        }
    }

    fn facts_with_resource(id: &str, remote_id: &str) -> FleetFacts {
        let now = UNIX_EPOCH;
        let (connection_id, environment_id) = ids();
        let environment = EnvironmentRecord::new(
            environment_id.clone(),
            connection_id.clone(),
            "environment".into(),
            EnvironmentKind::DockerContainer,
            now,
        );
        let resource = ManagedResourceRecord::new(
            ManagedResourceId::try_new(id).unwrap(),
            connection_id,
            environment_id,
            ManagedResourceProvider::Docker,
            ManagedResourceKind::DockerContainer,
            remote_id.into(),
            Ownership::MatchaManaged,
            CleanupPolicy::DeleteOnEnvironmentDelete,
            now,
        );
        FleetFacts::restore(FleetFactsRestoreInput {
            commands: Vec::new(),
            dispatches: Vec::new(),
            secret_references: Vec::new(),
            audit_entries: Vec::new(),
            topology: fleet::topology::FleetTopologyFacts::default(),
            enrollments: Vec::new(),
            ingress_credentials: Vec::new(),
            targets: Vec::new(),
            connections: Vec::new(),
            environments: vec![environment],
            managed_resources: vec![resource],
            effects: Vec::new(),
            runtime_agents: Vec::new(),
            runtime_agent_reachability: Vec::new(),
            leases: Vec::new(),
            bindings: Vec::new(),
        })
        .unwrap()
    }

    fn facts_with_deleted_resource(id: &str, remote_id: &str) -> FleetFacts {
        let now = UNIX_EPOCH;
        let (connection_id, environment_id) = ids();
        let environment = EnvironmentRecord::new(
            environment_id.clone(),
            connection_id.clone(),
            "environment".into(),
            EnvironmentKind::DockerContainer,
            now,
        );
        let resource = ManagedResourceRecord::restore(
            ManagedResourceId::try_new(id).unwrap(),
            connection_id,
            environment_id,
            ManagedResourceProvider::Docker,
            ManagedResourceKind::DockerContainer,
            remote_id.into(),
            Ownership::MatchaManaged,
            CleanupPolicy::DeleteOnEnvironmentDelete,
            ManagedResourceState::Deleted { deleted_at: now },
            true,
            now,
            now,
        )
        .unwrap();
        FleetFacts::restore(FleetFactsRestoreInput {
            commands: Vec::new(),
            dispatches: Vec::new(),
            secret_references: Vec::new(),
            audit_entries: Vec::new(),
            topology: fleet::topology::FleetTopologyFacts::default(),
            enrollments: Vec::new(),
            ingress_credentials: Vec::new(),
            targets: Vec::new(),
            connections: Vec::new(),
            environments: vec![environment],
            managed_resources: vec![resource],
            effects: Vec::new(),
            runtime_agents: Vec::new(),
            runtime_agent_reachability: Vec::new(),
            leases: Vec::new(),
            bindings: Vec::new(),
        })
        .unwrap()
    }

    #[test]
    fn identity_is_taken_from_explicit_authority_not_provider_names() {
        let facts = FleetFacts::default();
        let authority = authority("opaque-authority", false);
        let resolved =
            ManagedResourceIdentityProducer::resolve(&facts, &authority, &fact("remote-id"))
                .unwrap();

        assert_eq!(resolved.id().as_str(), "opaque-authority");
        assert!(!resolved.id().as_str().contains("remote-id"));
        assert!(!resolved.reused());
    }

    #[test]
    fn repeated_provider_receipt_reuses_persisted_identity() {
        let facts = facts_with_resource("persisted-id", "remote-id");
        let resolved = ManagedResourceIdentityProducer::resolve(
            &facts,
            &authority("retry-generated-id", false),
            &fact("remote-id"),
        )
        .unwrap();

        assert_eq!(
            resolved,
            ManagedResourceIdentityResolution::Reused(
                ManagedResourceId::try_new("persisted-id").unwrap()
            )
        );
    }

    #[test]
    fn persisted_tombstone_cannot_be_reused_or_reallocated() {
        let facts = facts_with_deleted_resource("deleted-id", "remote-id");
        let result = ManagedResourceIdentityProducer::resolve(
            &facts,
            &authority("new-id", false),
            &fact("remote-id"),
        );

        assert_eq!(
            result,
            Err(ManagedResourceIdentityError::DeletedPersistedReceipt)
        );
    }

    #[test]
    fn conflicting_persisted_identity_is_rejected() {
        let facts = facts_with_resource("persisted-id", "remote-id");
        let result = ManagedResourceIdentityProducer::resolve(
            &facts,
            &authority("different-id", true),
            &fact("remote-id"),
        );

        assert_eq!(
            result,
            Err(ManagedResourceIdentityError::ConflictingIdentityAuthority)
        );
    }

    #[test]
    fn existing_authority_without_persisted_fact_fails_closed() {
        let result = ManagedResourceIdentityProducer::resolve(
            &FleetFacts::default(),
            &authority("missing-id", true),
            &fact("remote-id"),
        );

        assert_eq!(
            result,
            Err(ManagedResourceIdentityError::MissingPersistedIdentity)
        );
    }
}
