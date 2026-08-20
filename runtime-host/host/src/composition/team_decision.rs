use organization::{
    OrganizationStore, StoreFault,
    run::decision::{TeamDecision, TeamDecisionCommand, TeamDecisionType},
};

/// The narrow Host composition seam for an already-authorized TeamRun/MCP caller.
///
/// Authorization is intentionally outside this facade. The transport integration point is the
/// authorized TeamRun MCP command handler; it should construct this facade from Host's canonical
/// OrganizationStore and pass only the typed request below. This seam does not execute a retry,
/// degraded continuation, abort, graph, or cancellation effect: it records the caller's decision
/// and exposes the durable receipt for a later owner to consume.
pub struct TeamDecisionFacade {
    store: OrganizationStore,
}

impl TeamDecisionFacade {
    /// Constructs the facade after the caller has passed the Host/MCP authorization boundary.
    pub(crate) fn from_authorized_mcp(store: OrganizationStore) -> Self {
        Self { store }
    }

    /// Records one canonical decision command and returns its safe public projection.
    pub fn submit_decision(
        &mut self,
        request: TeamDecisionRequest,
    ) -> Result<TeamDecisionReceiptProjection, TeamDecisionCompositionError> {
        let stage_id = request.stage_id.unwrap_or_else(|| "run".to_owned());
        let command = TeamDecisionCommand::try_new(
            format!("team-decision-{}", request.idempotency_key),
            request.run_id,
            stage_id,
            request.decision,
            request.note,
            request.idempotency_key,
            request.created_at,
        )
        .map_err(|_| TeamDecisionCompositionError::Invalid)?;

        // Check a retained key before the write so a different command cannot masquerade as a
        // replay. The store still owns the durable record/replay decision and refreshes its facts
        // under the writer lock, covering process recovery and concurrent callers.
        if self
            .store
            .decision(command.run_id(), command.idempotency_key())
            .is_some_and(|existing| existing.command() != &command)
        {
            return Err(TeamDecisionCompositionError::Invalid);
        }

        let receipt = self
            .store
            .record_decision(command)
            .map_err(project_store_error)?;
        Ok(project_receipt(receipt.decision(), receipt.is_replay()))
    }

    /// Returns one durable decision for recovery or a consumer read.
    pub fn query_decision(
        &self,
        run_id: &str,
        idempotency_key: &str,
    ) -> Option<TeamDecisionReceiptProjection> {
        self.store
            .decision(run_id, idempotency_key)
            .map(|decision| project_receipt(decision, true))
    }

    /// Returns all durable decisions for a run in ledger order.
    pub fn recover_decisions(&self, run_id: &str) -> Vec<TeamDecisionReceiptProjection> {
        let mut decisions = self
            .store
            .facts()
            .decisions()
            .filter(|decision| decision.run_id() == run_id)
            .collect::<Vec<_>>();
        decisions.sort_by_key(|decision| decision.sequence());
        decisions
            .into_iter()
            .map(|decision| project_receipt(decision, true))
            .collect()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamDecisionRequest {
    pub run_id: String,
    pub stage_id: Option<String>,
    pub decision: TeamDecisionType,
    pub note: Option<String>,
    pub idempotency_key: String,
    pub created_at: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamDecisionReceiptProjection {
    pub run_id: String,
    pub decision_id: String,
    pub stage_id: String,
    pub decision: TeamDecisionType,
    pub created_at: u64,
    pub sequence: u64,
    pub replayed: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamDecisionCompositionError {
    Invalid,
    Unavailable,
}

fn project_receipt(decision: &TeamDecision, replayed: bool) -> TeamDecisionReceiptProjection {
    TeamDecisionReceiptProjection {
        run_id: decision.run_id().to_owned(),
        decision_id: decision.decision_id().to_owned(),
        stage_id: decision.stage_id().to_owned(),
        decision: decision.decision(),
        created_at: decision.created_at(),
        sequence: decision.sequence(),
        replayed,
    }
}

fn project_store_error(error: StoreFault) -> TeamDecisionCompositionError {
    match error {
        StoreFault::InvalidFacts => TeamDecisionCompositionError::Invalid,
        _ => TeamDecisionCompositionError::Unavailable,
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    use super::*;

    static NEXT_TEST_PATH: AtomicU64 = AtomicU64::new(1);

    #[test]
    fn authorized_internal_seam_records_exact_receipt_and_maps_all_decisions() {
        let path = test_path("record");
        let mut facade = facade(&path);
        for (index, decision) in [
            TeamDecisionType::Retry,
            TeamDecisionType::ProceedDegraded,
            TeamDecisionType::Abort,
        ]
        .into_iter()
        .enumerate()
        {
            let receipt = facade
                .submit_decision(TeamDecisionRequest {
                    run_id: "run:one".to_owned(),
                    stage_id: Some(format!("stage:{index}")),
                    decision,
                    note: Some(format!("note-{index}")),
                    idempotency_key: format!("decision:{index}"),
                    created_at: 100 + index as u64,
                })
                .unwrap();
            assert!(!receipt.replayed);
            assert_eq!(receipt.decision, decision);
            assert_eq!(
                receipt.decision_id,
                format!("team-decision-decision:{index}")
            );
            assert_eq!(receipt.sequence, index as u64 + 1);
        }
        assert_eq!(facade.recover_decisions("run:one").len(), 3);
        drop(facade);
        remove_test_path(&path);
    }

    #[test]
    fn retry_replays_the_original_durable_receipt_and_rejects_conflict() {
        let path = test_path("idempotency");
        let mut facade = facade(&path);
        let request = TeamDecisionRequest {
            run_id: "run:one".to_owned(),
            stage_id: None,
            decision: TeamDecisionType::Retry,
            note: Some("try again".to_owned()),
            idempotency_key: "decision:one".to_owned(),
            created_at: 100,
        };
        let first = facade.submit_decision(request.clone()).unwrap();
        let replay = facade.submit_decision(request).unwrap();
        assert!(!first.replayed);
        assert!(replay.replayed);
        assert_eq!(
            replay,
            TeamDecisionReceiptProjection {
                replayed: true,
                ..first.clone()
            }
        );
        assert_eq!(replay.created_at, 100);
        assert_eq!(
            facade.submit_decision(TeamDecisionRequest {
                decision: TeamDecisionType::Abort,
                ..TeamDecisionRequest {
                    run_id: "run:one".to_owned(),
                    stage_id: None,
                    decision: TeamDecisionType::Retry,
                    note: Some("try again".to_owned()),
                    idempotency_key: "decision:one".to_owned(),
                    created_at: 100,
                }
            },),
            Err(TeamDecisionCompositionError::Invalid)
        );
        drop(facade);
        remove_test_path(&path);
    }

    #[test]
    fn recovery_query_reads_decisions_after_store_reopen_without_effects() {
        let path = test_path("recovery");
        {
            let mut facade = facade(&path);
            facade
                .submit_decision(TeamDecisionRequest {
                    run_id: "run:recovered".to_owned(),
                    stage_id: Some("stage:review".to_owned()),
                    decision: TeamDecisionType::ProceedDegraded,
                    note: None,
                    idempotency_key: "decision:recovered".to_owned(),
                    created_at: 77,
                })
                .unwrap();
        }
        let facade = facade(&path);
        let recovered = facade.recover_decisions("run:recovered");
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].decision, TeamDecisionType::ProceedDegraded);
        assert!(recovered[0].replayed);
        assert_eq!(facade.query_decision("run:missing", "decision:none"), None);
        drop(facade);
        remove_test_path(&path);
    }

    fn facade(path: &PathBuf) -> TeamDecisionFacade {
        TeamDecisionFacade::from_authorized_mcp(OrganizationStore::open(path).unwrap())
    }

    fn test_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "matcha-team-decision-{name}-{}-{}.log",
            std::process::id(),
            NEXT_TEST_PATH.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn remove_test_path(path: &PathBuf) {
        let _ = fs::remove_file(path);
        let _ = fs::remove_file(format!("{}.lock", path.display()));
    }
}
