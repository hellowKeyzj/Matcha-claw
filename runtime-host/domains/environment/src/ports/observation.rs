use std::{fmt, future::Future, pin::Pin, time::SystemTime};

use crate::definition::{
    ChannelOperationalDesired, EnvironmentId, EnvironmentRevision, SecurityPreset,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ObservationFreshness {
    Current,
    Stale,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectorStatus {
    Connected,
    Disconnected,
    Pending,
    Unsupported,
    Disabled,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectorObservationSource {
    Runtime,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SecurityRuntimeStatus {
    Healthy,
    Unhealthy,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChannelRuntimeStatus {
    Connected,
    Disconnected,
    Unknown,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct RuntimeObservationScope(String);

impl RuntimeObservationScope {
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidRuntimeObservationScope> {
        let value = value.into();
        if value.trim().is_empty() || value.chars().any(char::is_control) {
            return Err(InvalidRuntimeObservationScope);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidRuntimeObservationScope;

impl fmt::Display for InvalidRuntimeObservationScope {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("runtime observation scope must not be empty")
    }
}

impl std::error::Error for InvalidRuntimeObservationScope {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SecurityObservation {
    preset: SecurityPreset,
    status: SecurityRuntimeStatus,
}

impl SecurityObservation {
    pub const fn new(preset: SecurityPreset, status: SecurityRuntimeStatus) -> Self {
        Self { preset, status }
    }

    pub const fn preset(self) -> SecurityPreset {
        self.preset
    }

    pub const fn status(self) -> SecurityRuntimeStatus {
        self.status
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChannelObservation {
    desired: ChannelOperationalDesired,
    status: ChannelRuntimeStatus,
}

impl ChannelObservation {
    pub fn new(desired: ChannelOperationalDesired, status: ChannelRuntimeStatus) -> Self {
        Self { desired, status }
    }

    pub fn desired(&self) -> &ChannelOperationalDesired {
        &self.desired
    }

    pub const fn status(&self) -> ChannelRuntimeStatus {
        self.status
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationalObservation {
    environment_id: EnvironmentId,
    scope: RuntimeObservationScope,
    applied_revision: EnvironmentRevision,
    observed_at: SystemTime,
    freshness: ObservationFreshness,
    security: Option<SecurityObservation>,
    channels: Vec<ChannelObservation>,
}

impl OperationalObservation {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        environment_id: EnvironmentId,
        scope: RuntimeObservationScope,
        applied_revision: EnvironmentRevision,
        observed_at: SystemTime,
        freshness: ObservationFreshness,
        security: Option<SecurityObservation>,
        channels: Vec<ChannelObservation>,
    ) -> Result<Self, InvalidOperationalObservation> {
        if channels.iter().enumerate().any(|(index, channel)| {
            channels[..index].iter().any(|prior| {
                prior.desired.channel() == channel.desired.channel()
                    && prior.desired.account() == channel.desired.account()
            })
        }) {
            return Err(InvalidOperationalObservation::DuplicateChannel);
        }
        Ok(Self {
            environment_id,
            scope,
            applied_revision,
            observed_at,
            freshness,
            security,
            channels,
        })
    }

    pub fn environment_id(&self) -> &EnvironmentId {
        &self.environment_id
    }

    pub fn scope(&self) -> &RuntimeObservationScope {
        &self.scope
    }

    pub const fn applied_revision(&self) -> EnvironmentRevision {
        self.applied_revision
    }

    pub const fn observed_at(&self) -> SystemTime {
        self.observed_at
    }

    pub const fn freshness(&self) -> ObservationFreshness {
        self.freshness
    }

    pub const fn security(&self) -> Option<SecurityObservation> {
        self.security
    }

    pub fn channel_status(
        &self,
        desired: &ChannelOperationalDesired,
    ) -> Option<ChannelRuntimeStatus> {
        self.channels
            .iter()
            .find(|channel| channel.desired == *desired)
            .map(ChannelObservation::status)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidOperationalObservation {
    DuplicateChannel,
}

impl fmt::Display for InvalidOperationalObservation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("operational observation requires distinct channel accounts")
    }
}

impl std::error::Error for InvalidOperationalObservation {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConnectorObservation {
    connector_id: String,
    status: ConnectorStatus,
}

impl ConnectorObservation {
    pub fn new(
        connector_id: impl Into<String>,
        status: ConnectorStatus,
    ) -> Result<Self, InvalidConnectorObservation> {
        let connector_id = connector_id.into();
        if connector_id.trim().is_empty() {
            return Err(InvalidConnectorObservation);
        }
        Ok(Self {
            connector_id,
            status,
        })
    }

    pub fn connector_id(&self) -> &str {
        &self.connector_id
    }

    pub const fn status(&self) -> ConnectorStatus {
        self.status
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EnvironmentObservation {
    environment_id: EnvironmentId,
    scope: RuntimeObservationScope,
    applied_revision: EnvironmentRevision,
    source: ConnectorObservationSource,
    observed_at: SystemTime,
    freshness: ObservationFreshness,
    connectors: Vec<ConnectorObservation>,
}

impl EnvironmentObservation {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        environment_id: EnvironmentId,
        scope: RuntimeObservationScope,
        applied_revision: EnvironmentRevision,
        source: ConnectorObservationSource,
        observed_at: SystemTime,
        freshness: ObservationFreshness,
        connectors: Vec<ConnectorObservation>,
    ) -> Result<Self, InvalidEnvironmentObservation> {
        if connectors.iter().enumerate().any(|(index, observation)| {
            connectors[..index]
                .iter()
                .any(|prior| prior.connector_id == observation.connector_id)
        }) {
            return Err(InvalidEnvironmentObservation::DuplicateConnector);
        }
        Ok(Self {
            environment_id,
            scope,
            applied_revision,
            source,
            observed_at,
            freshness,
            connectors,
        })
    }

    pub fn environment_id(&self) -> &EnvironmentId {
        &self.environment_id
    }

    pub fn scope(&self) -> &RuntimeObservationScope {
        &self.scope
    }

    pub const fn applied_revision(&self) -> EnvironmentRevision {
        self.applied_revision
    }

    pub const fn source(&self) -> ConnectorObservationSource {
        self.source
    }

    pub const fn observed_at(&self) -> SystemTime {
        self.observed_at
    }

    pub const fn freshness(&self) -> ObservationFreshness {
        self.freshness
    }

    pub fn connectors(&self) -> &[ConnectorObservation] {
        &self.connectors
    }

    pub fn connector_status(&self, connector_id: &str) -> Option<ConnectorStatus> {
        self.connectors
            .iter()
            .find(|observation| observation.connector_id == connector_id)
            .map(ConnectorObservation::status)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidConnectorObservation;

impl fmt::Display for InvalidConnectorObservation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("connector observation requires a connector identity")
    }
}

impl std::error::Error for InvalidConnectorObservation {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidEnvironmentObservation {
    DuplicateConnector,
}

impl fmt::Display for InvalidEnvironmentObservation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("environment observation requires distinct connector identities")
    }
}

impl std::error::Error for InvalidEnvironmentObservation {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EnvironmentObservationFault {
    Unavailable,
    Rejected,
    OutcomeUnknown,
}

impl fmt::Display for EnvironmentObservationFault {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Unavailable => "environment observation target is unavailable",
            Self::Rejected => "environment observation was rejected",
            Self::OutcomeUnknown => "environment observation outcome is unknown",
        })
    }
}

impl std::error::Error for EnvironmentObservationFault {}

pub trait EnvironmentObservationPort: Send + Sync {
    fn observe_operational<'a>(
        &'a self,
        environment_id: &'a EnvironmentId,
        applied_revision: EnvironmentRevision,
        scope: &'a RuntimeObservationScope,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<OperationalObservation, EnvironmentObservationFault>>
                + Send
                + 'a,
        >,
    >;

    fn observe_connectors<'a>(
        &'a self,
        environment_id: &'a EnvironmentId,
        applied_revision: EnvironmentRevision,
        scope: &'a RuntimeObservationScope,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<EnvironmentObservation, EnvironmentObservationFault>>
                + Send
                + 'a,
        >,
    >;
}

#[cfg(test)]
mod tests {
    use std::time::SystemTime;

    use crate::definition::{EnvironmentId, EnvironmentRevision};

    use super::*;

    #[test]
    fn observation_snapshot_binds_runtime_statuses_to_one_scope_and_applied_revision() {
        let environment_id = EnvironmentId::try_new("environment:primary").unwrap();
        let revision = EnvironmentRevision::try_new(7).unwrap();
        let observed_at = SystemTime::UNIX_EPOCH;
        let scope = RuntimeObservationScope::try_new("runtime:primary").unwrap();
        let observation = EnvironmentObservation::new(
            environment_id.clone(),
            scope.clone(),
            revision,
            ConnectorObservationSource::Runtime,
            observed_at,
            ObservationFreshness::Stale,
            vec![
                ConnectorObservation::new("connector:calendar", ConnectorStatus::Pending).unwrap(),
            ],
        )
        .unwrap();

        assert_eq!(observation.environment_id(), &environment_id);
        assert_eq!(observation.scope(), &scope);
        assert_eq!(observation.applied_revision(), revision);
        assert_eq!(observation.source(), ConnectorObservationSource::Runtime);
        assert_eq!(observation.observed_at(), observed_at);
        assert_eq!(observation.freshness(), ObservationFreshness::Stale);
        assert_eq!(
            observation.connector_status("connector:calendar"),
            Some(ConnectorStatus::Pending)
        );
    }

    #[test]
    fn observation_snapshot_rejects_duplicate_connector_identities() {
        let error = EnvironmentObservation::new(
            EnvironmentId::try_new("environment:primary").unwrap(),
            RuntimeObservationScope::try_new("runtime:primary").unwrap(),
            EnvironmentRevision::try_new(7).unwrap(),
            ConnectorObservationSource::Runtime,
            SystemTime::UNIX_EPOCH,
            ObservationFreshness::Current,
            vec![
                ConnectorObservation::new("connector:calendar", ConnectorStatus::Connected)
                    .unwrap(),
                ConnectorObservation::new("connector:calendar", ConnectorStatus::Disconnected)
                    .unwrap(),
            ],
        )
        .unwrap_err();

        assert_eq!(error, InvalidEnvironmentObservation::DuplicateConnector);
        assert_eq!(
            error.to_string(),
            "environment observation requires distinct connector identities"
        );
    }

    #[test]
    fn connector_observation_rejects_empty_identity_without_echoing_input() {
        let error = ConnectorObservation::new("\t", ConnectorStatus::Unknown).unwrap_err();

        assert_eq!(error, InvalidConnectorObservation);
        assert_eq!(
            error.to_string(),
            "connector observation requires a connector identity"
        );
    }

    #[test]
    fn runtime_observation_scope_rejects_empty_identity_without_echoing_input() {
        for value in [" \t\n", "runtime:\nsecondary"] {
            let error = RuntimeObservationScope::try_new(value).unwrap_err();

            assert_eq!(error, InvalidRuntimeObservationScope);
            assert_eq!(
                error.to_string(),
                "runtime observation scope must not be empty"
            );
            assert_eq!(format!("{error:?}"), "InvalidRuntimeObservationScope");
        }
    }

    #[test]
    fn observation_faults_do_not_claim_apply_success() {
        assert_eq!(
            EnvironmentObservationFault::OutcomeUnknown.to_string(),
            "environment observation outcome is unknown"
        );
    }
}
