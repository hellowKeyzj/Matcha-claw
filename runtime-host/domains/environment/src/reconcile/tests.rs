use std::time::SystemTime;

use crate::definition::{
    BrowserMode, ChannelAccountId, ChannelDirectMessagePolicy, ChannelOperationalDesired,
    ChannelReference, ConnectorReference, DesiredConfiguration, DesiredDefinition, EnvironmentId,
    EnvironmentRevision, ProviderReference, SecurityPreset,
};
use crate::ports::{
    ChannelObservation, ChannelRuntimeStatus, ConnectorObservation, ConnectorObservationSource,
    ConnectorStatus, EnvironmentObservation, ObservationFreshness, OperationalObservation,
    RuntimeObservationScope, SecurityObservation, SecurityRuntimeStatus,
};
use crate::store::{AppliedEvidence, EnvironmentFacts};

use super::*;

fn desired(revision: u64, connectors: &[&str]) -> DesiredDefinition {
    desired_with_operational(revision, connectors, Vec::new())
}

fn desired_with_operational(
    revision: u64,
    connectors: &[&str],
    operational_channels: Vec<ChannelOperationalDesired>,
) -> DesiredDefinition {
    DesiredDefinition::new(
        EnvironmentId::try_new("environment:primary").unwrap(),
        EnvironmentRevision::try_new(revision).unwrap(),
        ProviderReference::try_new("anthropic").unwrap(),
        DesiredConfiguration::try_new(
            connectors
                .iter()
                .map(|connector| ConnectorReference::try_new(*connector).unwrap())
                .collect(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            SecurityPreset::Relaxed,
            BrowserMode::Relay,
            operational_channels,
        )
        .unwrap(),
    )
}

fn channel_desired() -> ChannelOperationalDesired {
    ChannelOperationalDesired::new(
        ChannelReference::try_new("discord").unwrap(),
        ChannelAccountId::try_new("primary").unwrap(),
        true,
        ChannelDirectMessagePolicy::Pairing,
    )
}

fn scope() -> RuntimeObservationScope {
    RuntimeObservationScope::try_new("runtime:primary").unwrap()
}

fn observation(
    revision: u64,
    connectors: &[(&str, ConnectorStatus)],
    freshness: ObservationFreshness,
) -> EnvironmentObservation {
    EnvironmentObservation::new(
        EnvironmentId::try_new("environment:primary").unwrap(),
        scope(),
        EnvironmentRevision::try_new(revision).unwrap(),
        ConnectorObservationSource::Runtime,
        SystemTime::UNIX_EPOCH,
        freshness,
        connectors
            .iter()
            .map(|(connector_id, status)| {
                ConnectorObservation::new(*connector_id, *status).unwrap()
            })
            .collect(),
    )
    .unwrap()
}

fn plan(
    facts: &EnvironmentFacts,
    observations: &[EnvironmentObservation],
) -> EnvironmentReconciliationPlan {
    let scope = scope();
    EnvironmentReconciliationOracle.evaluate(EnvironmentReconciliationInput::new(
        facts,
        &scope,
        observations,
        &[],
    ))
}

fn facts(desired: &DesiredDefinition, applied_revision: Option<u64>) -> EnvironmentFacts {
    EnvironmentFacts::new(
        desired.clone(),
        applied_revision
            .map(|revision| AppliedEvidence::new(EnvironmentRevision::try_new(revision).unwrap())),
    )
}

fn operational_observation(
    revision: u64,
    freshness: ObservationFreshness,
    security: Option<SecurityObservation>,
    channels: Vec<ChannelObservation>,
) -> OperationalObservation {
    OperationalObservation::new(
        EnvironmentId::try_new("environment:primary").unwrap(),
        scope(),
        EnvironmentRevision::try_new(revision).unwrap(),
        SystemTime::UNIX_EPOCH,
        freshness,
        security,
        channels,
    )
    .unwrap()
}

fn operational_plan(
    facts: &EnvironmentFacts,
    observations: &[EnvironmentObservation],
    operational_observations: &[OperationalObservation],
) -> EnvironmentReconciliationPlan {
    let scope = scope();
    EnvironmentReconciliationOracle.evaluate(EnvironmentReconciliationInput::new(
        facts,
        &scope,
        observations,
        operational_observations,
    ))
}

#[test]
fn reconciliation_requires_matching_durable_apply_evidence_before_using_observations() {
    let desired = desired(7, &["connector:calendar"]);
    let observations = [observation(
        7,
        &[("connector:calendar", ConnectorStatus::Connected)],
        ObservationFreshness::Current,
    )];

    for applied_revision in [None, Some(6), Some(8)] {
        let environment_facts = facts(&desired, applied_revision);
        let plan = plan(&environment_facts, &observations);

        assert_eq!(
            plan.state(),
            EnvironmentReconciliationState::ProjectionRequired
        );
        assert_eq!(
            plan.actions(),
            [EnvironmentReconciliationAction::ApplyDesiredRevision {
                revision: desired.revision(),
            }]
        );
        assert!(plan.drift().is_empty());
    }
}

#[test]
fn reconciliation_does_not_converge_without_observation_coverage_even_when_no_connectors_are_desired()
 {
    let desired = desired(7, &[]);
    let environment_facts = facts(&desired, Some(7));

    let plan = plan(&environment_facts, &[]);

    assert_eq!(
        plan.state(),
        EnvironmentReconciliationState::ObservationsRequired
    );
    assert_eq!(
        plan.actions(),
        [EnvironmentReconciliationAction::ObserveConnectors { scope: scope() }]
    );
    assert!(plan.drift().is_empty());
}

#[test]
fn reconciliation_does_not_converge_from_current_connector_status_without_applied_revision_coverage()
 {
    let desired = desired(7, &["connector:calendar"]);
    let environment_facts = facts(&desired, Some(7));
    let observations = [observation(
        6,
        &[("connector:calendar", ConnectorStatus::Connected)],
        ObservationFreshness::Current,
    )];

    let plan = plan(&environment_facts, &observations);

    assert_eq!(
        plan.state(),
        EnvironmentReconciliationState::ObservationsRequired
    );
    assert_eq!(
        plan.actions(),
        [EnvironmentReconciliationAction::ObserveConnectors { scope: scope() }]
    );
    assert!(plan.drift().is_empty());
}

#[test]
fn reconciliation_does_not_converge_from_another_runtime_observation_scope() {
    let desired = desired(7, &["connector:calendar"]);
    let foreign_scope = RuntimeObservationScope::try_new("runtime:secondary").unwrap();
    let target_scope = RuntimeObservationScope::try_new("runtime:primary").unwrap();
    let observations = [EnvironmentObservation::new(
        EnvironmentId::try_new("environment:primary").unwrap(),
        foreign_scope,
        desired.revision(),
        ConnectorObservationSource::Runtime,
        SystemTime::UNIX_EPOCH,
        ObservationFreshness::Current,
        vec![ConnectorObservation::new("connector:calendar", ConnectorStatus::Connected).unwrap()],
    )
    .unwrap()];
    let environment_facts = facts(&desired, Some(7));

    let plan = EnvironmentReconciliationOracle.evaluate(EnvironmentReconciliationInput::new(
        &environment_facts,
        &target_scope,
        &observations,
        &[],
    ));

    assert_eq!(
        plan.state(),
        EnvironmentReconciliationState::ObservationsRequired
    );
    assert_eq!(
        plan.actions(),
        [EnvironmentReconciliationAction::ObserveConnectors {
            scope: target_scope,
        }]
    );
    assert!(plan.drift().is_empty());
}

#[test]
fn reconciliation_requests_observations_for_stale_unknown_incomplete_or_ambiguous_snapshot() {
    let desired = desired(7, &["connector:calendar"]);
    let foreign_environment = EnvironmentObservation::new(
        EnvironmentId::try_new("environment:secondary").unwrap(),
        scope(),
        desired.revision(),
        ConnectorObservationSource::Runtime,
        SystemTime::UNIX_EPOCH,
        ObservationFreshness::Current,
        vec![ConnectorObservation::new("connector:calendar", ConnectorStatus::Connected).unwrap()],
    )
    .unwrap();
    let cases = [
        Vec::new(),
        vec![observation(
            7,
            &[("connector:calendar", ConnectorStatus::Connected)],
            ObservationFreshness::Stale,
        )],
        vec![observation(
            7,
            &[("connector:calendar", ConnectorStatus::Connected)],
            ObservationFreshness::Unknown,
        )],
        vec![observation(
            7,
            &[("connector:calendar", ConnectorStatus::Unknown)],
            ObservationFreshness::Current,
        )],
        vec![foreign_environment],
        vec![
            observation(
                7,
                &[("connector:calendar", ConnectorStatus::Connected)],
                ObservationFreshness::Current,
            ),
            observation(
                7,
                &[("connector:calendar", ConnectorStatus::Disconnected)],
                ObservationFreshness::Current,
            ),
        ],
    ];

    for observations in cases {
        let environment_facts = facts(&desired, Some(7));
        let plan = plan(&environment_facts, &observations);

        assert_eq!(
            plan.state(),
            EnvironmentReconciliationState::ObservationsRequired
        );
        assert_eq!(
            plan.actions(),
            [EnvironmentReconciliationAction::ObserveConnectors { scope: scope() }]
        );
        assert!(plan.drift().is_empty());
    }
}

#[test]
fn reconciliation_reapplies_desired_revision_for_current_recoverable_drift() {
    let desired = desired(7, &["connector:calendar", "connector:docs"]);
    let observations = [observation(
        7,
        &[
            ("connector:calendar", ConnectorStatus::Disconnected),
            ("connector:docs", ConnectorStatus::Pending),
        ],
        ObservationFreshness::Current,
    )];

    let environment_facts = facts(&desired, Some(7));
    let plan = plan(&environment_facts, &observations);

    assert_eq!(plan.state(), EnvironmentReconciliationState::Drifted);
    assert_eq!(
        plan.actions(),
        [EnvironmentReconciliationAction::ApplyDesiredRevision {
            revision: desired.revision(),
        }]
    );
    assert_eq!(
        plan.drift(),
        [
            (
                "connector:calendar".to_owned(),
                ConnectorDrift::Disconnected
            ),
            ("connector:docs".to_owned(), ConnectorDrift::Pending),
        ]
    );
}

#[test]
fn reconciliation_blocks_unsupported_or_disabled_connectors_without_reapplying() {
    let desired = desired(7, &["connector:calendar", "connector:docs"]);
    let observations = [observation(
        7,
        &[
            ("connector:calendar", ConnectorStatus::Unsupported),
            ("connector:docs", ConnectorStatus::Disabled),
        ],
        ObservationFreshness::Current,
    )];

    let environment_facts = facts(&desired, Some(7));
    let plan = plan(&environment_facts, &observations);

    assert_eq!(plan.state(), EnvironmentReconciliationState::Blocked);
    assert!(plan.actions().is_empty());
    assert_eq!(
        plan.drift(),
        [
            ("connector:calendar".to_owned(), ConnectorDrift::Unsupported),
            ("connector:docs".to_owned(), ConnectorDrift::Disabled),
        ]
    );
}

#[test]
fn reconciliation_plan_is_deterministic_across_snapshot_connector_order() {
    let desired = desired(7, &["connector:calendar", "connector:docs"]);
    let ordered = [observation(
        7,
        &[
            ("connector:calendar", ConnectorStatus::Disconnected),
            ("connector:docs", ConnectorStatus::Unsupported),
        ],
        ObservationFreshness::Current,
    )];
    let reversed = [observation(
        7,
        &[
            ("connector:docs", ConnectorStatus::Unsupported),
            ("connector:calendar", ConnectorStatus::Disconnected),
        ],
        ObservationFreshness::Current,
    )];
    let environment_facts = facts(&desired, Some(7));

    assert_eq!(
        plan(&environment_facts, &ordered),
        plan(&environment_facts, &reversed)
    );
}

#[test]
fn reconciliation_confirms_connector_plane_only_after_one_current_complete_snapshot_for_the_applied_revision()
 {
    let desired = desired(7, &["connector:calendar", "connector:docs"]);
    let observations = [observation(
        7,
        &[
            ("connector:calendar", ConnectorStatus::Connected),
            ("connector:docs", ConnectorStatus::Connected),
        ],
        ObservationFreshness::Current,
    )];

    let environment_facts = facts(&desired, Some(7));
    let plan = plan(&environment_facts, &observations);

    assert_eq!(
        plan.state(),
        EnvironmentReconciliationState::ObservationsRequired
    );
    assert_eq!(
        plan.actions(),
        [EnvironmentReconciliationAction::ObserveOperational { scope: scope() }]
    );
    assert!(plan.drift().is_empty());
    assert!(plan.operational_drift().is_empty());
}

#[test]
fn reconciliation_requires_current_security_monitor_and_live_channel_observations() {
    let channel = channel_desired();
    let desired = desired_with_operational(7, &[], vec![channel.clone()]);
    let environment_facts = facts(&desired, Some(7));
    let connectors = [observation(7, &[], ObservationFreshness::Current)];

    let missing = operational_plan(&environment_facts, &connectors, &[]);
    assert_eq!(
        missing.actions(),
        [EnvironmentReconciliationAction::ObserveOperational { scope: scope() }]
    );

    let incomplete = operational_plan(
        &environment_facts,
        &connectors,
        &[operational_observation(
            7,
            ObservationFreshness::Current,
            Some(SecurityObservation::new(
                SecurityPreset::Relaxed,
                SecurityRuntimeStatus::Healthy,
            )),
            vec![ChannelObservation::new(
                channel.clone(),
                ChannelRuntimeStatus::Unknown,
            )],
        )],
    );
    assert_eq!(
        incomplete.state(),
        EnvironmentReconciliationState::ObservationsRequired
    );
    assert_eq!(
        incomplete.actions(),
        [EnvironmentReconciliationAction::ObserveOperational { scope: scope() }]
    );
    assert_eq!(
        incomplete.operational_drift(),
        [OperationalDrift::ChannelUnknown(channel)]
    );
}

#[test]
fn reconciliation_reapplies_only_for_observed_operational_drift() {
    let channel = channel_desired();
    let desired = desired_with_operational(7, &[], vec![channel.clone()]);
    let environment_facts = facts(&desired, Some(7));
    let connectors = [observation(7, &[], ObservationFreshness::Current)];
    let plan = operational_plan(
        &environment_facts,
        &connectors,
        &[operational_observation(
            7,
            ObservationFreshness::Current,
            Some(SecurityObservation::new(
                SecurityPreset::Relaxed,
                SecurityRuntimeStatus::Unhealthy,
            )),
            vec![ChannelObservation::new(
                channel.clone(),
                ChannelRuntimeStatus::Disconnected,
            )],
        )],
    );

    assert_eq!(plan.state(), EnvironmentReconciliationState::Drifted);
    assert_eq!(
        plan.actions(),
        [EnvironmentReconciliationAction::ApplyDesiredRevision {
            revision: desired.revision(),
        }]
    );
    assert_eq!(
        plan.operational_drift(),
        [
            OperationalDrift::SecurityUnhealthy,
            OperationalDrift::ChannelDisconnected(channel),
        ]
    );
}

#[test]
fn reconciliation_orders_operational_channel_drift_by_canonical_desired_identity() {
    let discord = ChannelOperationalDesired::new(
        ChannelReference::try_new("discord").unwrap(),
        ChannelAccountId::try_new("zeta").unwrap(),
        true,
        ChannelDirectMessagePolicy::Pairing,
    );
    let whatsapp = ChannelOperationalDesired::new(
        ChannelReference::try_new("whatsapp").unwrap(),
        ChannelAccountId::try_new("alpha").unwrap(),
        true,
        ChannelDirectMessagePolicy::Open,
    );
    let desired = desired_with_operational(7, &[], vec![whatsapp.clone(), discord.clone()]);
    let environment_facts = facts(&desired, Some(7));
    let connectors = [observation(7, &[], ObservationFreshness::Current)];
    let plan = operational_plan(
        &environment_facts,
        &connectors,
        &[operational_observation(
            7,
            ObservationFreshness::Current,
            Some(SecurityObservation::new(
                SecurityPreset::Relaxed,
                SecurityRuntimeStatus::Healthy,
            )),
            vec![
                ChannelObservation::new(whatsapp.clone(), ChannelRuntimeStatus::Disconnected),
                ChannelObservation::new(discord.clone(), ChannelRuntimeStatus::Disconnected),
            ],
        )],
    );

    assert_eq!(plan.state(), EnvironmentReconciliationState::Drifted);
    assert_eq!(
        plan.operational_drift(),
        [
            OperationalDrift::ChannelDisconnected(discord),
            OperationalDrift::ChannelDisconnected(whatsapp),
        ]
    );
}

#[test]
fn reconciliation_requires_a_matching_current_operational_observation() {
    let desired = desired(7, &[]);
    let environment_facts = facts(&desired, Some(7));
    let connectors = [observation(7, &[], ObservationFreshness::Current)];
    let stale = operational_observation(
        7,
        ObservationFreshness::Stale,
        Some(SecurityObservation::new(
            SecurityPreset::Relaxed,
            SecurityRuntimeStatus::Healthy,
        )),
        Vec::new(),
    );

    let plan = operational_plan(&environment_facts, &connectors, &[stale]);
    assert_eq!(
        plan.state(),
        EnvironmentReconciliationState::ObservationsRequired
    );
    assert_eq!(
        plan.actions(),
        [EnvironmentReconciliationAction::ObserveOperational { scope: scope() }]
    );
}

#[test]
fn reconciliation_confirms_operational_plane_only_from_matching_live_observations() {
    let desired = desired(7, &[]);
    let environment_facts = facts(&desired, Some(7));
    let connectors = [observation(7, &[], ObservationFreshness::Current)];
    let operational = operational_observation(
        7,
        ObservationFreshness::Current,
        Some(SecurityObservation::new(
            SecurityPreset::Relaxed,
            SecurityRuntimeStatus::Healthy,
        )),
        Vec::new(),
    );

    let plan = operational_plan(&environment_facts, &connectors, &[operational]);
    assert_eq!(
        plan.state(),
        EnvironmentReconciliationState::OperationalConverged
    );
    assert!(plan.actions().is_empty());
    assert!(plan.drift().is_empty());
    assert!(plan.operational_drift().is_empty());
}
