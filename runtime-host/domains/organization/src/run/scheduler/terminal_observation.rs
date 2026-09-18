use crate::run::delivery::{DeliveryId, DeliveryLedgerSnapshot, DeliveryPhaseSnapshot};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalObservationPlan {
    delivery_ids: Vec<DeliveryId>,
}

impl TerminalObservationPlan {
    pub fn delivery_ids(&self) -> &[DeliveryId] {
        &self.delivery_ids
    }
}

pub fn plan_terminal_observations(snapshot: &DeliveryLedgerSnapshot) -> TerminalObservationPlan {
    TerminalObservationPlan {
        delivery_ids: snapshot
            .deliveries()
            .iter()
            .filter(|delivery| {
                matches!(
                    delivery.phase(),
                    DeliveryPhaseSnapshot::Delivered {
                        native_correlation: Some(_),
                        ..
                    }
                )
            })
            .map(|delivery| delivery.facts().delivery_id.clone())
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroU32;

    use super::*;
    use crate::{
        AttemptId, DeliveryClaimSnapshot, DeliveryFailure, DeliveryRequest, DeliverySnapshot,
        EndpointSessionId, ExecutionFence, NativeDeliveryCorrelation, NodeExecutionId, NodeId,
        ports::DeliveryReceiptReference,
        run::delivery::{
            NativeRunReceiptReference, NativeTerminalStatus, TerminalObservationResolution,
            TerminalObservationSnapshot, TerminalObservationSnapshotInput,
        },
    };

    fn correlation() -> NativeDeliveryCorrelation {
        NativeDeliveryCorrelation::new(
            EndpointSessionId::try_new("terminal-session-correlation-canary").unwrap(),
            NativeRunReceiptReference::try_new("terminal-run-correlation-canary").unwrap(),
        )
    }

    fn receipt() -> DeliveryReceiptReference {
        DeliveryReceiptReference::try_new("terminal-delivery-receipt-canary").unwrap()
    }

    fn snapshot(delivery_id: &str, phase: DeliveryPhaseSnapshot) -> DeliverySnapshot {
        DeliverySnapshot::new(
            DeliveryRequest {
                delivery_id: DeliveryId::new(delivery_id).unwrap(),
                team_id: "team-terminal-observation".to_owned(),
                run_id: "run-terminal-observation".to_owned(),
                node_id: "node-terminal-observation".to_owned(),
                node_execution_id: "node-terminal-observation:attempt:1".to_owned(),
                task_id: "task-terminal-observation".to_owned(),
                role_id: "role-terminal-observation".to_owned(),
                session_ref: crate::ROLE_SESSION_REF_INITIAL.to_owned(),
                idempotency_key: format!("terminal-observation:{delivery_id}"),
                message: "private prompt".to_owned(),
                requested_at: 1,
                max_attempts: 2,
            },
            phase,
            0,
            1,
        )
    }

    fn terminal_observation(delivery_id: &str) -> TerminalObservationSnapshot {
        let node_id = NodeId::new("node-terminal-observation");
        let attempt_id = AttemptId::for_node(&node_id, NonZeroU32::MIN);

        TerminalObservationSnapshot::new(TerminalObservationSnapshotInput {
            delivery_id: DeliveryId::new(delivery_id).unwrap(),
            graph_run_id: "run-terminal-observation".to_owned(),
            node_id: node_id.as_str().to_owned(),
            fence: ExecutionFence::new(
                attempt_id.clone(),
                NodeExecutionId::for_attempt(&attempt_id),
            ),
            role_id: "role-terminal-observation".to_owned(),
            correlation: correlation(),
            delivered_receipt: receipt(),
            native_terminal: NativeTerminalStatus::Completed,
            observed_at: 2,
            output: None,
            resolution: TerminalObservationResolution::AwaitingAuthorizedGraphResolution,
        })
    }

    #[test]
    fn plans_only_correlation_bound_deliveries_in_snapshot_order() {
        let snapshot = DeliveryLedgerSnapshot::new(vec![
            snapshot(
                "delivery-z",
                DeliveryPhaseSnapshot::Delivered {
                    receipt: receipt(),
                    native_correlation: Some(correlation()),
                    accepted_at: 1,
                },
            ),
            snapshot("delivery-pending", DeliveryPhaseSnapshot::Pending),
            snapshot(
                "delivery-delivering",
                DeliveryPhaseSnapshot::Delivering(DeliveryClaimSnapshot::new(
                    DeliveryId::new("delivery-delivering").unwrap(),
                    1,
                    1,
                    1,
                )),
            ),
            snapshot(
                "delivery-retry",
                DeliveryPhaseSnapshot::RetryScheduled {
                    retry_at: 2,
                    failure: DeliveryFailure::Unavailable,
                },
            ),
            snapshot(
                "delivery-without-correlation",
                DeliveryPhaseSnapshot::Delivered {
                    receipt: receipt(),
                    native_correlation: None,
                    accepted_at: 1,
                },
            ),
            snapshot(
                "delivery-a",
                DeliveryPhaseSnapshot::Delivered {
                    receipt: receipt(),
                    native_correlation: Some(correlation()),
                    accepted_at: 1,
                },
            ),
            snapshot(
                "delivery-observed",
                DeliveryPhaseSnapshot::TerminalObserved {
                    observation: terminal_observation("delivery-observed"),
                },
            ),
            snapshot(
                "delivery-failed",
                DeliveryPhaseSnapshot::Failed {
                    failed_at: 2,
                    failure: DeliveryFailure::PolicyRejected,
                },
            ),
            snapshot(
                "delivery-unknown",
                DeliveryPhaseSnapshot::OutcomeUnknown { observed_at: 2 },
            ),
            snapshot(
                "delivery-cancelled",
                DeliveryPhaseSnapshot::Cancelled { cancelled_at: 2 },
            ),
        ]);

        let plan = plan_terminal_observations(&snapshot);

        assert_eq!(
            plan.delivery_ids()
                .iter()
                .map(DeliveryId::as_str)
                .collect::<Vec<_>>(),
            ["delivery-z", "delivery-a"],
        );
    }

    #[test]
    fn terminal_observation_plan_does_not_expose_correlation() {
        let snapshot = DeliveryLedgerSnapshot::new(vec![snapshot(
            "delivery-correlation-bound",
            DeliveryPhaseSnapshot::Delivered {
                receipt: receipt(),
                native_correlation: Some(correlation()),
                accepted_at: 1,
            },
        )]);

        let plan = plan_terminal_observations(&snapshot);
        let rendered = format!("{plan:?}");

        assert_eq!(
            plan.delivery_ids()
                .iter()
                .map(DeliveryId::as_str)
                .collect::<Vec<_>>(),
            ["delivery-correlation-bound"],
        );
        for private in [
            "terminal-session-correlation-canary",
            "terminal-run-correlation-canary",
            "terminal-delivery-receipt-canary",
        ] {
            assert!(!rendered.contains(private));
        }
    }
}
