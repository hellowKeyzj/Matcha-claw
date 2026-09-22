use std::{collections::BTreeMap, fmt, time::SystemTime};

use platform::endpoint::EndpointId;

use crate::domain::secret_ref::FleetSecretRef;

const INITIAL_TARGET_REVISION: u64 = 1;

#[derive(Clone, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct TargetId(String);

impl TargetId {
    pub fn try_new(value: impl Into<String>) -> Result<Self, TargetIdError> {
        let value = value.into();
        if value.trim().is_empty() || value.contains('\0') {
            return Err(TargetIdError);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for TargetId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TargetId(<opaque>)")
    }
}

impl fmt::Display for TargetId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl TryFrom<&str> for TargetId {
    type Error = TargetIdError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        Self::try_new(value)
    }
}

impl TryFrom<String> for TargetId {
    type Error = TargetIdError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::try_new(value)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TargetIdError;

impl fmt::Display for TargetIdError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Fleet target ID is invalid")
    }
}

impl std::error::Error for TargetIdError {}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum TargetKind {
    Docker,
    Kubernetes,
    Ssh,
    Custom,
}

#[derive(Clone, Eq, PartialEq)]
pub struct RuntimeAgentEndpointConfig {
    endpoint_url: String,
    token: FleetSecretRef,
}

impl RuntimeAgentEndpointConfig {
    pub fn try_new(
        endpoint_url: impl Into<String>,
        token: FleetSecretRef,
    ) -> Result<Self, FleetTargetConfigError> {
        Ok(Self {
            endpoint_url: valid_text(endpoint_url.into())?,
            token,
        })
    }

    pub fn endpoint_url(&self) -> &str {
        &self.endpoint_url
    }

    pub fn token(&self) -> &FleetSecretRef {
        &self.token
    }
}

impl fmt::Debug for RuntimeAgentEndpointConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RuntimeAgentEndpointConfig")
            .field("endpoint_url", &self.endpoint_url)
            .field("token", &"<redacted>")
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct DockerTargetConfig {
    endpoint: String,
    container_name: String,
    image: String,
    bearer_token: Option<FleetSecretRef>,
    runtime_agent: Option<RuntimeAgentEndpointConfig>,
}

impl DockerTargetConfig {
    pub fn try_new(
        endpoint: impl Into<String>,
        container_name: impl Into<String>,
        image: impl Into<String>,
        bearer_token: Option<FleetSecretRef>,
    ) -> Result<Self, FleetTargetConfigError> {
        Self::try_new_with_runtime_agent(endpoint, container_name, image, bearer_token, None)
    }

    pub fn try_new_with_runtime_agent(
        endpoint: impl Into<String>,
        container_name: impl Into<String>,
        image: impl Into<String>,
        bearer_token: Option<FleetSecretRef>,
        runtime_agent: Option<RuntimeAgentEndpointConfig>,
    ) -> Result<Self, FleetTargetConfigError> {
        Ok(Self {
            endpoint: valid_text(endpoint.into())?,
            container_name: valid_text(container_name.into())?,
            image: valid_text(image.into())?,
            bearer_token,
            runtime_agent,
        })
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub fn container_name(&self) -> &str {
        &self.container_name
    }

    pub fn image(&self) -> &str {
        &self.image
    }

    pub fn bearer_token(&self) -> Option<&FleetSecretRef> {
        self.bearer_token.as_ref()
    }

    pub fn runtime_agent(&self) -> Option<&RuntimeAgentEndpointConfig> {
        self.runtime_agent.as_ref()
    }
}

impl fmt::Debug for DockerTargetConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DockerTargetConfig")
            .field("endpoint", &self.endpoint)
            .field("container_name", &self.container_name)
            .field("image", &self.image)
            .field(
                "bearer_token",
                &self.bearer_token.as_ref().map(|_| "<redacted>"),
            )
            .field("runtime_agent", &self.runtime_agent)
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct KubernetesTargetConfig {
    api_server: String,
    namespace: String,
    deployment_name: String,
    service_name: String,
    image: String,
    bearer_token: FleetSecretRef,
    runtime_agent: Option<RuntimeAgentEndpointConfig>,
}

impl KubernetesTargetConfig {
    pub fn try_new(
        api_server: impl Into<String>,
        namespace: impl Into<String>,
        deployment_name: impl Into<String>,
        service_name: impl Into<String>,
        image: impl Into<String>,
        bearer_token: FleetSecretRef,
    ) -> Result<Self, FleetTargetConfigError> {
        Self::try_new_with_runtime_agent(
            api_server,
            namespace,
            deployment_name,
            service_name,
            image,
            bearer_token,
            None,
        )
    }

    pub fn try_new_with_runtime_agent(
        api_server: impl Into<String>,
        namespace: impl Into<String>,
        deployment_name: impl Into<String>,
        service_name: impl Into<String>,
        image: impl Into<String>,
        bearer_token: FleetSecretRef,
        runtime_agent: Option<RuntimeAgentEndpointConfig>,
    ) -> Result<Self, FleetTargetConfigError> {
        Ok(Self {
            api_server: valid_text(api_server.into())?,
            namespace: valid_text(namespace.into())?,
            deployment_name: valid_text(deployment_name.into())?,
            service_name: valid_text(service_name.into())?,
            image: valid_text(image.into())?,
            bearer_token,
            runtime_agent,
        })
    }

    pub fn api_server(&self) -> &str {
        &self.api_server
    }

    pub fn namespace(&self) -> &str {
        &self.namespace
    }

    pub fn deployment_name(&self) -> &str {
        &self.deployment_name
    }

    pub fn service_name(&self) -> &str {
        &self.service_name
    }

    pub fn image(&self) -> &str {
        &self.image
    }

    pub fn bearer_token(&self) -> &FleetSecretRef {
        &self.bearer_token
    }

    pub fn runtime_agent(&self) -> Option<&RuntimeAgentEndpointConfig> {
        self.runtime_agent.as_ref()
    }
}

impl fmt::Debug for KubernetesTargetConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("KubernetesTargetConfig")
            .field("api_server", &self.api_server)
            .field("namespace", &self.namespace)
            .field("deployment_name", &self.deployment_name)
            .field("service_name", &self.service_name)
            .field("image", &self.image)
            .field("bearer_token", &"<redacted>")
            .field("runtime_agent", &self.runtime_agent)
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub enum SshAuthentication {
    PrivateKey(FleetSecretRef),
    Password(FleetSecretRef),
}

impl SshAuthentication {
    pub fn secret_reference(&self) -> &FleetSecretRef {
        match self {
            Self::PrivateKey(reference) | Self::Password(reference) => reference,
        }
    }
}

impl fmt::Debug for SshAuthentication {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::PrivateKey(_) => "SshAuthentication::PrivateKey(<redacted>)",
            Self::Password(_) => "SshAuthentication::Password(<redacted>)",
        })
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct SshTargetConfig {
    host: String,
    port: Option<u16>,
    username: Option<String>,
    authentication: SshAuthentication,
    install_command: String,
    runtime_agent: Option<RuntimeAgentEndpointConfig>,
}

impl SshTargetConfig {
    pub fn try_new(
        host: impl Into<String>,
        port: Option<u16>,
        username: Option<String>,
        authentication: SshAuthentication,
        install_command: impl Into<String>,
    ) -> Result<Self, FleetTargetConfigError> {
        Self::try_new_with_runtime_agent(
            host,
            port,
            username,
            authentication,
            install_command,
            None,
        )
    }

    pub fn try_new_with_runtime_agent(
        host: impl Into<String>,
        port: Option<u16>,
        username: Option<String>,
        authentication: SshAuthentication,
        install_command: impl Into<String>,
        runtime_agent: Option<RuntimeAgentEndpointConfig>,
    ) -> Result<Self, FleetTargetConfigError> {
        if port == Some(0) {
            return Err(FleetTargetConfigError::InvalidPort);
        }
        let username = username
            .map(valid_text)
            .transpose()?
            .map(Some)
            .unwrap_or(None);
        Ok(Self {
            host: valid_text(host.into())?,
            port,
            username,
            authentication,
            install_command: valid_text(install_command.into())?,
            runtime_agent,
        })
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn port(&self) -> Option<u16> {
        self.port
    }

    pub fn username(&self) -> Option<&str> {
        self.username.as_deref()
    }

    pub fn authentication(&self) -> &SshAuthentication {
        &self.authentication
    }

    pub fn install_command(&self) -> &str {
        &self.install_command
    }

    pub fn runtime_agent(&self) -> Option<&RuntimeAgentEndpointConfig> {
        self.runtime_agent.as_ref()
    }
}

impl fmt::Debug for SshTargetConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SshTargetConfig")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("authentication", &self.authentication)
            .field("install_command", &self.install_command)
            .field("runtime_agent", &self.runtime_agent)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CustomTerminalTransport {
    Websocket,
}

#[derive(Clone, Eq, PartialEq)]
pub struct CustomTerminalConfig {
    transport: CustomTerminalTransport,
    endpoint: String,
    protocol_version: String,
    credential_ref_name: Option<String>,
}

impl CustomTerminalConfig {
    pub fn try_new(
        transport: CustomTerminalTransport,
        endpoint: impl Into<String>,
        protocol_version: impl Into<String>,
        credential_ref_name: Option<String>,
    ) -> Result<Self, FleetTargetConfigError> {
        let credential_ref_name = credential_ref_name
            .map(valid_text)
            .transpose()?
            .map(Some)
            .unwrap_or(None);
        Ok(Self {
            transport,
            endpoint: valid_text(endpoint.into())?,
            protocol_version: valid_text(protocol_version.into())?,
            credential_ref_name,
        })
    }

    pub fn transport(&self) -> CustomTerminalTransport {
        self.transport
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub fn protocol_version(&self) -> &str {
        &self.protocol_version
    }

    pub fn credential_ref_name(&self) -> Option<&str> {
        self.credential_ref_name.as_deref()
    }
}

impl fmt::Debug for CustomTerminalConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CustomTerminalConfig")
            .field("transport", &self.transport)
            .field("endpoint", &self.endpoint)
            .field("protocol_version", &self.protocol_version)
            .field("credential_ref_name", &self.credential_ref_name)
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct CustomTargetConfig {
    endpoint: String,
    credential: Option<FleetSecretRef>,
    terminal: Option<CustomTerminalConfig>,
    runtime_agent: Option<RuntimeAgentEndpointConfig>,
}

impl CustomTargetConfig {
    pub fn try_new(
        endpoint: impl Into<String>,
        credential: Option<FleetSecretRef>,
    ) -> Result<Self, FleetTargetConfigError> {
        Self::try_new_with_terminal_and_runtime_agent(endpoint, credential, None, None)
    }

    pub fn try_new_with_terminal_and_runtime_agent(
        endpoint: impl Into<String>,
        credential: Option<FleetSecretRef>,
        terminal: Option<CustomTerminalConfig>,
        runtime_agent: Option<RuntimeAgentEndpointConfig>,
    ) -> Result<Self, FleetTargetConfigError> {
        Ok(Self {
            endpoint: valid_text(endpoint.into())?,
            credential,
            terminal,
            runtime_agent,
        })
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub fn credential(&self) -> Option<&FleetSecretRef> {
        self.credential.as_ref()
    }

    pub fn terminal(&self) -> Option<&CustomTerminalConfig> {
        self.terminal.as_ref()
    }

    pub fn runtime_agent(&self) -> Option<&RuntimeAgentEndpointConfig> {
        self.runtime_agent.as_ref()
    }
}

impl fmt::Debug for CustomTargetConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CustomTargetConfig")
            .field("endpoint", &self.endpoint)
            .field(
                "credential",
                &self.credential.as_ref().map(|_| "<redacted>"),
            )
            .field("terminal", &self.terminal)
            .field("runtime_agent", &self.runtime_agent)
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub enum FleetTargetConfig {
    Docker(DockerTargetConfig),
    Kubernetes(KubernetesTargetConfig),
    Ssh(SshTargetConfig),
    Custom(CustomTargetConfig),
}

impl FleetTargetConfig {
    pub fn kind(&self) -> TargetKind {
        match self {
            Self::Docker(_) => TargetKind::Docker,
            Self::Kubernetes(_) => TargetKind::Kubernetes,
            Self::Ssh(_) => TargetKind::Ssh,
            Self::Custom(_) => TargetKind::Custom,
        }
    }

    pub fn secret_references(&self) -> Vec<&FleetSecretRef> {
        let mut references = Vec::new();
        match self {
            Self::Docker(config) => {
                if let Some(reference) = config.bearer_token() {
                    references.push(reference);
                }
                if let Some(runtime_agent) = config.runtime_agent() {
                    references.push(runtime_agent.token());
                }
            }
            Self::Kubernetes(config) => {
                references.push(config.bearer_token());
                if let Some(runtime_agent) = config.runtime_agent() {
                    references.push(runtime_agent.token());
                }
            }
            Self::Ssh(config) => {
                references.push(config.authentication().secret_reference());
                if let Some(runtime_agent) = config.runtime_agent() {
                    references.push(runtime_agent.token());
                }
            }
            Self::Custom(config) => {
                if let Some(reference) = config.credential() {
                    references.push(reference);
                }
                if let Some(runtime_agent) = config.runtime_agent() {
                    references.push(runtime_agent.token());
                }
            }
        }
        references
    }
}

impl fmt::Debug for FleetTargetConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("FleetTargetConfig(<redacted>)")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FleetTargetConfigError {
    EmptyValue,
    ContainsNul,
    InvalidPort,
}

impl fmt::Display for FleetTargetConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::EmptyValue => "Fleet target configuration contains an empty value",
            Self::ContainsNul => "Fleet target configuration contains an invalid NUL character",
            Self::InvalidPort => "Fleet SSH port must be non-zero",
        })
    }
}

impl std::error::Error for FleetTargetConfigError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TargetSnapshot {
    id: TargetId,
    revision: u64,
    kind: TargetKind,
}

impl TargetSnapshot {
    pub fn new(id: TargetId, revision: u64, kind: TargetKind) -> Self {
        Self { id, revision, kind }
    }

    pub fn id(&self) -> &TargetId {
        &self.id
    }

    pub const fn revision(&self) -> u64 {
        self.revision
    }

    pub const fn kind(&self) -> TargetKind {
        self.kind
    }

    pub fn selector(&self) -> FleetTargetSelector {
        FleetTargetSelector::new(self.id.clone(), self.revision, self.kind)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FleetTargetSelector {
    id: TargetId,
    revision: u64,
    expected_kind: TargetKind,
}

impl FleetTargetSelector {
    pub fn new(id: TargetId, revision: u64, expected_kind: TargetKind) -> Self {
        Self {
            id,
            revision,
            expected_kind,
        }
    }

    pub fn id(&self) -> &TargetId {
        &self.id
    }

    pub const fn revision(&self) -> u64 {
        self.revision
    }

    pub const fn expected_kind(&self) -> TargetKind {
        self.expected_kind
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TargetEndpointBinding {
    target_id: TargetId,
    endpoint_id: EndpointId,
    target_revision: u64,
    observed_at: SystemTime,
}

impl TargetEndpointBinding {
    pub fn try_new(
        target_id: TargetId,
        endpoint_id: EndpointId,
        target_revision: u64,
        observed_at: SystemTime,
    ) -> Result<Self, FleetTargetBindingError> {
        if target_revision == 0 {
            return Err(FleetTargetBindingError::InvalidRevision);
        }
        if observed_at < SystemTime::UNIX_EPOCH {
            return Err(FleetTargetBindingError::InvalidObservedAt);
        }
        Ok(Self {
            target_id,
            endpoint_id,
            target_revision,
            observed_at,
        })
    }

    pub fn target_id(&self) -> &TargetId {
        &self.target_id
    }

    pub fn endpoint_id(&self) -> &EndpointId {
        &self.endpoint_id
    }

    pub const fn target_revision(&self) -> u64 {
        self.target_revision
    }

    pub const fn observed_at(&self) -> SystemTime {
        self.observed_at
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FleetTargetBindingError {
    InvalidRevision,
    InvalidObservedAt,
    TargetNotFound,
    RevisionMismatch,
    DuplicateTarget,
}

impl fmt::Display for FleetTargetBindingError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidRevision => "Fleet target binding revision is invalid",
            Self::InvalidObservedAt => "Fleet target binding observation time is invalid",
            Self::TargetNotFound => "Fleet target binding refers to an unknown target",
            Self::RevisionMismatch => "Fleet target binding revision does not match the target",
            Self::DuplicateTarget => "Fleet target binding contains a duplicate target",
        })
    }
}

impl std::error::Error for FleetTargetBindingError {}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct FleetTargetStore {
    records: BTreeMap<TargetId, (u64, FleetTargetConfig)>,
    bindings: BTreeMap<TargetId, TargetEndpointBinding>,
}

impl FleetTargetStore {
    pub fn restore(
        targets: Vec<(TargetId, u64, FleetTargetConfig)>,
        bindings: Vec<TargetEndpointBinding>,
    ) -> Result<Self, FleetTargetBindingError> {
        let mut store = Self::default();
        for (id, revision, config) in targets {
            if revision == 0 || store.records.insert(id, (revision, config)).is_some() {
                return Err(FleetTargetBindingError::DuplicateTarget);
            }
        }
        for binding in bindings {
            let Some((revision, _)) = store.records.get(binding.target_id()) else {
                return Err(FleetTargetBindingError::TargetNotFound);
            };
            if *revision != binding.target_revision()
                || store
                    .bindings
                    .insert(binding.target_id().clone(), binding)
                    .is_some()
            {
                return Err(FleetTargetBindingError::RevisionMismatch);
            }
        }
        Ok(store)
    }

    pub fn put(
        &mut self,
        id: TargetId,
        config: FleetTargetConfig,
    ) -> Result<TargetSnapshot, FleetTargetBindingError> {
        let revision = self
            .records
            .get(&id)
            .map_or(INITIAL_TARGET_REVISION, |(revision, _)| {
                revision.saturating_add(1)
            });
        if revision == 0 {
            return Err(FleetTargetBindingError::InvalidRevision);
        }
        self.records.insert(id.clone(), (revision, config));
        self.bindings.remove(&id);
        let (_, config) = self
            .records
            .get(&id)
            .expect("target inserted before snapshot construction");
        Ok(TargetSnapshot::new(id, revision, config.kind()))
    }

    pub fn remove(&mut self, id: &TargetId) -> bool {
        let removed = self.records.remove(id).is_some();
        self.bindings.remove(id);
        removed
    }

    pub fn snapshot(&self, id: &TargetId) -> Option<TargetSnapshot> {
        self.records
            .get(id)
            .map(|(revision, config)| TargetSnapshot::new(id.clone(), *revision, config.kind()))
    }

    pub fn configuration(&self, id: &TargetId) -> Option<&FleetTargetConfig> {
        self.records.get(id).map(|(_, config)| config)
    }

    pub fn records(&self) -> impl Iterator<Item = (&TargetId, u64, &FleetTargetConfig)> {
        self.records
            .iter()
            .map(|(id, (revision, config))| (id, *revision, config))
    }

    pub fn bind(&mut self, binding: TargetEndpointBinding) -> Result<(), FleetTargetBindingError> {
        let Some((revision, _)) = self.records.get(binding.target_id()) else {
            return Err(FleetTargetBindingError::TargetNotFound);
        };
        if *revision != binding.target_revision() {
            return Err(FleetTargetBindingError::RevisionMismatch);
        }
        self.bindings.insert(binding.target_id().clone(), binding);
        Ok(())
    }

    pub fn binding(&self, id: &TargetId) -> Option<&TargetEndpointBinding> {
        self.bindings.get(id)
    }

    pub fn bindings(&self) -> impl Iterator<Item = &TargetEndpointBinding> {
        self.bindings.values()
    }
}

fn valid_text(value: String) -> Result<String, FleetTargetConfigError> {
    if value.trim().is_empty() {
        return Err(FleetTargetConfigError::EmptyValue);
    }
    if value.contains('\0') {
        return Err(FleetTargetConfigError::ContainsNul);
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use platform::endpoint::EndpointId;

    fn secret(name: &str) -> FleetSecretRef {
        FleetSecretRef::parse(format!("remote-fleet://credentials/{name}").as_str()).unwrap()
    }

    #[test]
    fn target_identity_and_revision_are_fenced() {
        let id = TargetId::try_new("target-a").unwrap();
        let config = FleetTargetConfig::Docker(
            DockerTargetConfig::try_new(
                "https://docker.example.test",
                "runtime-agent",
                "runtime-agent:stable",
                None,
            )
            .unwrap(),
        );
        let mut store = FleetTargetStore::default();
        let first = store.put(id.clone(), config.clone()).unwrap();
        assert_eq!(first.revision(), 1);
        assert_eq!(first.kind(), TargetKind::Docker);
        let binding = TargetEndpointBinding::try_new(
            id.clone(),
            EndpointId::try_new("endpoint-a").unwrap(),
            1,
            SystemTime::UNIX_EPOCH,
        )
        .unwrap();
        store.bind(binding).unwrap();
        let second = store.put(id.clone(), config).unwrap();
        assert_eq!(second.revision(), 2);
        assert!(store.binding(&id).is_none());
        assert_eq!(second.selector().expected_kind(), TargetKind::Docker);
    }

    #[test]
    fn secrets_remain_references_and_config_debug_is_redacted() {
        let bearer = secret("docker-token");
        let runtime = RuntimeAgentEndpointConfig::try_new(
            "https://agent.example.test/dispatch",
            secret("agent-token"),
        )
        .unwrap();
        let config = FleetTargetConfig::Docker(
            DockerTargetConfig::try_new_with_runtime_agent(
                "https://docker.example.test",
                "runtime-agent",
                "runtime-agent:stable",
                Some(bearer.clone()),
                Some(runtime),
            )
            .unwrap(),
        );
        assert_eq!(format!("{config:?}"), "FleetTargetConfig(<redacted>)");
        assert_eq!(
            config.secret_references(),
            vec![&bearer, &secret("agent-token")]
        );
    }

    #[test]
    fn target_binding_rejects_zero_revision_and_unknown_targets() {
        assert_eq!(
            TargetEndpointBinding::try_new(
                TargetId::try_new("target-a").unwrap(),
                EndpointId::try_new("endpoint-a").unwrap(),
                0,
                SystemTime::UNIX_EPOCH,
            )
            .unwrap_err(),
            FleetTargetBindingError::InvalidRevision
        );
        let mut store = FleetTargetStore::default();
        let binding = TargetEndpointBinding::try_new(
            TargetId::try_new("target-a").unwrap(),
            EndpointId::try_new("endpoint-a").unwrap(),
            1,
            SystemTime::UNIX_EPOCH,
        )
        .unwrap();
        assert_eq!(
            store.bind(binding).unwrap_err(),
            FleetTargetBindingError::TargetNotFound
        );
    }
}
