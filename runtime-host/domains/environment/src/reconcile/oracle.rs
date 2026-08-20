use crate::ports::{ChannelRuntimeStatus, ConnectorStatus, SecurityRuntimeStatus};

use super::{
    ConnectorDrift, EnvironmentReconciliationAction, EnvironmentReconciliationInput,
    EnvironmentReconciliationPlan, EnvironmentReconciliationState, OperationalDrift,
};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct EnvironmentReconciliationOracle;

impl EnvironmentReconciliationOracle {
    pub fn evaluate(
        self,
        input: EnvironmentReconciliationInput<'_>,
    ) -> EnvironmentReconciliationPlan {
        if !input.has_current_applied_evidence() {
            return EnvironmentReconciliationPlan::new(
                EnvironmentReconciliationState::ProjectionRequired,
                vec![EnvironmentReconciliationAction::ApplyDesiredRevision {
                    revision: input.desired().revision(),
                }],
                Vec::new(),
                Vec::new(),
            );
        }

        if !input.has_complete_current_observation() {
            return EnvironmentReconciliationPlan::new(
                EnvironmentReconciliationState::ObservationsRequired,
                vec![EnvironmentReconciliationAction::ObserveConnectors {
                    scope: input.scope().clone(),
                }],
                Vec::new(),
                Vec::new(),
            );
        }

        let mut drift = Vec::new();
        let mut blocked = false;
        for connector in input.desired().connectors() {
            match input
                .current_status(connector.as_str())
                .expect("complete current observations must include every desired connector")
            {
                ConnectorStatus::Connected => {}
                ConnectorStatus::Disconnected => {
                    drift.push((connector.as_str().to_owned(), ConnectorDrift::Disconnected));
                }
                ConnectorStatus::Pending => {
                    drift.push((connector.as_str().to_owned(), ConnectorDrift::Pending));
                }
                ConnectorStatus::Unsupported => {
                    drift.push((connector.as_str().to_owned(), ConnectorDrift::Unsupported));
                    blocked = true;
                }
                ConnectorStatus::Disabled => {
                    drift.push((connector.as_str().to_owned(), ConnectorDrift::Disabled));
                    blocked = true;
                }
                ConnectorStatus::Unknown => {
                    unreachable!("complete observations must not contain unknown connector states")
                }
            }
        }

        if blocked {
            return EnvironmentReconciliationPlan::new(
                EnvironmentReconciliationState::Blocked,
                Vec::new(),
                drift,
                Vec::new(),
            );
        }
        if !drift.is_empty() {
            return EnvironmentReconciliationPlan::new(
                EnvironmentReconciliationState::Drifted,
                vec![EnvironmentReconciliationAction::ApplyDesiredRevision {
                    revision: input.desired().revision(),
                }],
                drift,
                Vec::new(),
            );
        }

        let operational = evaluate_operational(input);
        if operational.observations_required {
            return EnvironmentReconciliationPlan::new(
                EnvironmentReconciliationState::ObservationsRequired,
                vec![EnvironmentReconciliationAction::ObserveOperational {
                    scope: input.scope().clone(),
                }],
                Vec::new(),
                operational.drift,
            );
        }
        if !operational.drift.is_empty() {
            return EnvironmentReconciliationPlan::new(
                EnvironmentReconciliationState::Drifted,
                vec![EnvironmentReconciliationAction::ApplyDesiredRevision {
                    revision: input.desired().revision(),
                }],
                Vec::new(),
                operational.drift,
            );
        }

        EnvironmentReconciliationPlan::new(
            EnvironmentReconciliationState::OperationalConverged,
            Vec::new(),
            Vec::new(),
            Vec::new(),
        )
    }
}

struct OperationalEvaluation {
    observations_required: bool,
    drift: Vec<OperationalDrift>,
}

fn evaluate_operational(input: EnvironmentReconciliationInput<'_>) -> OperationalEvaluation {
    if input.current_operational_observation().is_none() {
        return OperationalEvaluation {
            observations_required: true,
            drift: Vec::new(),
        };
    }

    let mut observations_required = false;
    let mut drift = Vec::new();
    match input.security_observation() {
        Some(security) if security.status() == SecurityRuntimeStatus::Healthy => {}
        Some(_) => drift.push(OperationalDrift::SecurityUnhealthy),
        None => {
            observations_required = true;
            drift.push(OperationalDrift::SecurityUnavailable);
        }
    }

    for desired in input
        .desired()
        .operational_channels()
        .iter()
        .filter(|desired| desired.enabled())
    {
        match input.channel_status(desired) {
            Some(ChannelRuntimeStatus::Connected) => {}
            Some(ChannelRuntimeStatus::Disconnected) => {
                drift.push(OperationalDrift::ChannelDisconnected(desired.clone()));
            }
            Some(ChannelRuntimeStatus::Unknown) | None => {
                observations_required = true;
                drift.push(OperationalDrift::ChannelUnknown(desired.clone()));
            }
        }
    }

    OperationalEvaluation {
        observations_required,
        drift,
    }
}
