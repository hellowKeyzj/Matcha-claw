use crate::definition::{ChannelOperationalDesired, DesiredDefinition, EnvironmentRevision};
use crate::ports::{
    ChannelRuntimeStatus, ConnectorStatus, EnvironmentObservation, ObservationFreshness,
    OperationalObservation, RuntimeObservationScope, SecurityObservation,
};
use crate::store::EnvironmentFacts;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EnvironmentReconciliationState {
    ProjectionRequired,
    ObservationsRequired,
    ConnectorsConverged,
    OperationalConverged,
    Drifted,
    Blocked,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectorDrift {
    Disconnected,
    Pending,
    Unsupported,
    Disabled,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OperationalDrift {
    SecurityUnavailable,
    SecurityUnhealthy,
    ChannelDisconnected(ChannelOperationalDesired),
    ChannelUnknown(ChannelOperationalDesired),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EnvironmentReconciliationAction {
    ApplyDesiredRevision { revision: EnvironmentRevision },
    ObserveConnectors { scope: RuntimeObservationScope },
    ObserveOperational { scope: RuntimeObservationScope },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EnvironmentReconciliationPlan {
    state: EnvironmentReconciliationState,
    actions: Vec<EnvironmentReconciliationAction>,
    drift: Vec<(String, ConnectorDrift)>,
    operational_drift: Vec<OperationalDrift>,
}

impl EnvironmentReconciliationPlan {
    pub(super) fn new(
        state: EnvironmentReconciliationState,
        actions: Vec<EnvironmentReconciliationAction>,
        drift: Vec<(String, ConnectorDrift)>,
        operational_drift: Vec<OperationalDrift>,
    ) -> Self {
        Self {
            state,
            actions,
            drift,
            operational_drift,
        }
    }

    pub const fn state(&self) -> EnvironmentReconciliationState {
        self.state
    }

    pub fn actions(&self) -> &[EnvironmentReconciliationAction] {
        &self.actions
    }

    pub fn drift(&self) -> &[(String, ConnectorDrift)] {
        &self.drift
    }

    pub fn operational_drift(&self) -> &[OperationalDrift] {
        &self.operational_drift
    }
}

#[derive(Clone, Copy, Debug)]
pub struct EnvironmentReconciliationInput<'a> {
    facts: &'a EnvironmentFacts,
    scope: &'a RuntimeObservationScope,
    observations: &'a [EnvironmentObservation],
    operational_observations: &'a [OperationalObservation],
}

impl<'a> EnvironmentReconciliationInput<'a> {
    pub const fn new(
        facts: &'a EnvironmentFacts,
        scope: &'a RuntimeObservationScope,
        observations: &'a [EnvironmentObservation],
        operational_observations: &'a [OperationalObservation],
    ) -> Self {
        Self {
            facts,
            scope,
            observations,
            operational_observations,
        }
    }

    pub const fn desired(self) -> &'a DesiredDefinition {
        self.facts.desired()
    }

    pub const fn scope(self) -> &'a RuntimeObservationScope {
        self.scope
    }

    pub const fn observations(self) -> &'a [EnvironmentObservation] {
        self.observations
    }

    pub fn has_current_applied_evidence(self) -> bool {
        self.facts.has_current_applied_evidence()
    }

    pub fn has_complete_current_observation(self) -> bool {
        self.current_observation().is_some_and(|observation| {
            self.desired().connectors().iter().all(|connector| {
                observation
                    .connector_status(connector.as_str())
                    .is_some_and(|status| status != ConnectorStatus::Unknown)
            })
        })
    }

    pub fn current_status(self, connector_id: &str) -> Option<ConnectorStatus> {
        self.current_observation()
            .and_then(|observation| observation.connector_status(connector_id))
            .filter(|status| *status != ConnectorStatus::Unknown)
    }

    pub fn current_operational_observation(self) -> Option<&'a OperationalObservation> {
        let mut matching = self.operational_observations.iter().filter(|observation| {
            observation.environment_id() == self.desired().environment_id()
                && observation.scope() == self.scope()
                && observation.applied_revision() == self.desired().revision()
                && observation.freshness() == ObservationFreshness::Current
        });
        let observation = matching.next()?;
        matching.next().is_none().then_some(observation)
    }

    pub fn security_observation(self) -> Option<SecurityObservation> {
        self.current_operational_observation()
            .and_then(OperationalObservation::security)
            .filter(|security| security.preset() == self.desired().security_preset())
    }

    pub fn channel_status(
        self,
        desired: &ChannelOperationalDesired,
    ) -> Option<ChannelRuntimeStatus> {
        self.current_operational_observation()
            .and_then(|observation| observation.channel_status(desired))
    }

    fn current_observation(self) -> Option<&'a EnvironmentObservation> {
        let mut matching = self.observations.iter().filter(|observation| {
            observation.environment_id() == self.desired().environment_id()
                && observation.scope() == self.scope()
                && observation.applied_revision() == self.desired().revision()
                && observation.freshness() == ObservationFreshness::Current
        });
        let observation = matching.next()?;
        matching.next().is_none().then_some(observation)
    }
}
