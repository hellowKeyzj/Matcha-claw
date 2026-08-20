use std::{collections::BTreeMap, fmt, time::SystemTime};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProviderResourceProvider {
    Docker,
    Kubernetes,
    Ssh,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProviderResourceKind {
    DockerContainer,
    KubernetesWorkload,
    KubernetesDeployment,
    KubernetesService,
    SshAgentInstallation,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ProviderResourceAssociation {
    DockerContainer {
        name: String,
    },
    KubernetesWorkload {
        namespace: String,
        deployment_name: String,
        service_name: String,
    },
}

impl ProviderResourceAssociation {
    pub(crate) fn docker_container(
        name: impl Into<String>,
    ) -> Result<Self, ProviderResourceFactError> {
        let name = non_empty(name.into(), ProviderResourceFactError::MissingAssociation)?;
        Ok(Self::DockerContainer { name })
    }

    pub(crate) fn kubernetes_workload(
        namespace: impl Into<String>,
        deployment_name: impl Into<String>,
        service_name: impl Into<String>,
    ) -> Result<Self, ProviderResourceFactError> {
        Ok(Self::KubernetesWorkload {
            namespace: non_empty(
                namespace.into(),
                ProviderResourceFactError::MissingAssociation,
            )?,
            deployment_name: non_empty(
                deployment_name.into(),
                ProviderResourceFactError::MissingAssociation,
            )?,
            service_name: non_empty(
                service_name.into(),
                ProviderResourceFactError::MissingAssociation,
            )?,
        })
    }

    pub(crate) fn docker_name(&self) -> Option<&str> {
        match self {
            Self::DockerContainer { name } => Some(name),
            Self::KubernetesWorkload { .. } => None,
        }
    }

    pub(crate) fn kubernetes_workload_names(&self) -> Option<(&str, &str, &str)> {
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
pub(crate) struct ProviderResourceRef {
    provider: ProviderResourceProvider,
    kind: ProviderResourceKind,
    remote_id: String,
    namespace: Option<String>,
    name: Option<String>,
}

impl ProviderResourceRef {
    pub(crate) fn new(
        provider: ProviderResourceProvider,
        kind: ProviderResourceKind,
        remote_id: impl Into<String>,
        namespace: Option<String>,
        name: Option<String>,
    ) -> Result<Self, ProviderResourceFactError> {
        let remote_id = non_empty(
            remote_id.into(),
            ProviderResourceFactError::MissingAuthority,
        )?;
        if namespace
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
            || name.as_deref().is_some_and(|value| value.trim().is_empty())
        {
            return Err(ProviderResourceFactError::InvalidReference);
        }
        Ok(Self {
            provider,
            kind,
            remote_id,
            namespace,
            name,
        })
    }

    pub(crate) fn provider(&self) -> ProviderResourceProvider {
        self.provider
    }

    pub(crate) fn kind(&self) -> ProviderResourceKind {
        self.kind
    }

    pub(crate) fn remote_id(&self) -> &str {
        &self.remote_id
    }

    pub(crate) fn namespace(&self) -> Option<&str> {
        self.namespace.as_deref()
    }

    pub(crate) fn name(&self) -> Option<&str> {
        self.name.as_deref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProviderOwnershipEvidence {
    labels: BTreeMap<String, String>,
}

impl ProviderOwnershipEvidence {
    pub(crate) fn required(
        labels: BTreeMap<String, String>,
    ) -> Result<Self, ProviderResourceFactError> {
        if labels.is_empty()
            || labels
                .iter()
                .any(|(key, value)| key.trim().is_empty() || value.trim().is_empty())
        {
            return Err(ProviderResourceFactError::MissingOwnershipEvidence);
        }
        Ok(Self { labels })
    }

    pub(crate) fn labels(&self) -> &BTreeMap<String, String> {
        &self.labels
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProviderResourceFact {
    provider: ProviderResourceProvider,
    kind: ProviderResourceKind,
    remote_id: String,
    refs: Vec<ProviderResourceRef>,
    ownership: ProviderOwnershipEvidence,
    association: ProviderResourceAssociation,
    display_name: String,
    labels: BTreeMap<String, String>,
    observed_at: SystemTime,
}

impl ProviderResourceFact {
    pub(crate) fn confirmed(
        provider: ProviderResourceProvider,
        kind: ProviderResourceKind,
        remote_id: impl Into<String>,
        refs: Vec<ProviderResourceRef>,
        ownership: ProviderOwnershipEvidence,
        association: ProviderResourceAssociation,
        display_name: impl Into<String>,
        labels: BTreeMap<String, String>,
        observed_at: SystemTime,
    ) -> Result<Self, ProviderResourceFactError> {
        let remote_id = non_empty(
            remote_id.into(),
            ProviderResourceFactError::MissingAuthority,
        )?;
        if refs.is_empty() {
            return Err(ProviderResourceFactError::MissingAssociation);
        }
        if refs
            .iter()
            .any(|reference| reference.provider() != provider)
        {
            return Err(ProviderResourceFactError::InvalidReference);
        }
        let display_name = non_empty(
            display_name.into(),
            ProviderResourceFactError::MissingAssociation,
        )?;
        if labels.is_empty() {
            return Err(ProviderResourceFactError::MissingOwnershipEvidence);
        }
        match (&association, provider, kind) {
            (
                ProviderResourceAssociation::DockerContainer { .. },
                ProviderResourceProvider::Docker,
                ProviderResourceKind::DockerContainer,
            )
            | (
                ProviderResourceAssociation::KubernetesWorkload { .. },
                ProviderResourceProvider::Kubernetes,
                ProviderResourceKind::KubernetesWorkload,
            ) => {}
            _ => return Err(ProviderResourceFactError::AssociationMismatch),
        }
        Ok(Self {
            provider,
            kind,
            remote_id,
            refs,
            ownership,
            association,
            display_name,
            labels,
            observed_at,
        })
    }

    pub(crate) fn provider(&self) -> ProviderResourceProvider {
        self.provider
    }

    pub(crate) fn kind(&self) -> ProviderResourceKind {
        self.kind
    }

    pub(crate) fn remote_id(&self) -> &str {
        &self.remote_id
    }

    pub(crate) fn refs(&self) -> &[ProviderResourceRef] {
        &self.refs
    }

    pub(crate) fn ownership(&self) -> &ProviderOwnershipEvidence {
        &self.ownership
    }

    pub(crate) fn association(&self) -> &ProviderResourceAssociation {
        &self.association
    }

    pub(crate) fn display_name(&self) -> &str {
        &self.display_name
    }

    pub(crate) fn labels(&self) -> &BTreeMap<String, String> {
        &self.labels
    }

    pub(crate) fn observed_at(&self) -> SystemTime {
        self.observed_at
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ProviderResourceReceipt {
    Confirmed(ProviderResourceFact),
    AlreadyAbsent {
        provider: ProviderResourceProvider,
        observed_at: SystemTime,
    },
    NoAuthoritativeResourceIdentity {
        provider: ProviderResourceProvider,
        observed_at: SystemTime,
    },
}

impl ProviderResourceReceipt {
    pub(crate) fn confirmed(&self) -> Option<&ProviderResourceFact> {
        match self {
            Self::Confirmed(fact) => Some(fact),
            Self::AlreadyAbsent { .. } | Self::NoAuthoritativeResourceIdentity { .. } => None,
        }
    }

    pub(crate) fn is_no_fact(&self) -> bool {
        matches!(self, Self::NoAuthoritativeResourceIdentity { .. })
    }

    pub(crate) fn provider(&self) -> ProviderResourceProvider {
        match self {
            Self::Confirmed(fact) => fact.provider(),
            Self::AlreadyAbsent { provider, .. }
            | Self::NoAuthoritativeResourceIdentity { provider, .. } => *provider,
        }
    }

    pub(crate) fn observed_at(&self) -> SystemTime {
        match self {
            Self::Confirmed(fact) => fact.observed_at(),
            Self::AlreadyAbsent { observed_at, .. }
            | Self::NoAuthoritativeResourceIdentity { observed_at, .. } => *observed_at,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProviderResourceFactError {
    MissingAuthority,
    MissingOwnershipEvidence,
    MissingAssociation,
    AssociationMismatch,
    InvalidReference,
}

impl fmt::Display for ProviderResourceFactError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::MissingAuthority => "provider resource has no authoritative remote identity",
            Self::MissingOwnershipEvidence => "provider resource has no ownership evidence",
            Self::MissingAssociation => "provider resource has no provider association",
            Self::AssociationMismatch => "provider resource association does not match provider",
            Self::InvalidReference => "provider resource reference is invalid",
        })
    }
}

impl std::error::Error for ProviderResourceFactError {}

fn non_empty(
    value: String,
    error: ProviderResourceFactError,
) -> Result<String, ProviderResourceFactError> {
    if value.trim().is_empty() {
        Err(error)
    } else {
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confirmed_fact_requires_authority_ownership_and_association() {
        let association = ProviderResourceAssociation::docker_container("container").unwrap();
        let reference = ProviderResourceRef::new(
            ProviderResourceProvider::Docker,
            ProviderResourceKind::DockerContainer,
            "container-id",
            None,
            Some("container".into()),
        )
        .unwrap();
        let ownership = ProviderOwnershipEvidence::required(BTreeMap::from([(
            "managed".into(),
            "true".into(),
        )]))
        .unwrap();
        let fact = ProviderResourceFact::confirmed(
            ProviderResourceProvider::Docker,
            ProviderResourceKind::DockerContainer,
            "container-id",
            vec![reference],
            ownership,
            association,
            "container",
            BTreeMap::from([("managed".into(), "true".into())]),
            SystemTime::UNIX_EPOCH,
        )
        .unwrap();
        assert_eq!(fact.remote_id(), "container-id");
        assert_eq!(fact.refs().len(), 1);
    }

    #[test]
    fn confirmed_fact_rejects_missing_authority() {
        let result = ProviderResourceFact::confirmed(
            ProviderResourceProvider::Docker,
            ProviderResourceKind::DockerContainer,
            "",
            vec![],
            ProviderOwnershipEvidence::required(BTreeMap::from([(
                "managed".into(),
                "true".into(),
            )]))
            .unwrap(),
            ProviderResourceAssociation::docker_container("container").unwrap(),
            "container",
            BTreeMap::from([("managed".into(), "true".into())]),
            SystemTime::UNIX_EPOCH,
        );
        assert_eq!(result, Err(ProviderResourceFactError::MissingAuthority));
    }
}
