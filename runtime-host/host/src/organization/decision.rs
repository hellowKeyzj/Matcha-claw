use organization::{
    OrganizationStore, StoreFault, TeamDecisionCommand,
    run::decision::{TeamDecision, TeamDecisionType},
};

use crate::organization::team_run::TeamRunOwner;

/// Organization-owned TeamRun decision seam for an already-authorized TeamRun/MCP caller.
///
/// Authorization and public DTO parsing stay outside this facade. This seam records the typed
/// Organization decision command and exposes a typed durable receipt projection for later consumers.
pub struct TeamDecisionFacade {
    store: OrganizationStore,
    team_run: TeamRunOwner,
}

impl TeamDecisionFacade {
    /// Constructs the facade after the caller has passed the TeamRun/MCP authorization boundary.
    pub(crate) fn from_authorized_mcp(store: OrganizationStore) -> Self {
        Self {
            store,
            team_run: TeamRunOwner::new(),
        }
    }

    /// Records one canonical decision command and returns its safe typed projection.
    pub fn submit_decision(
        &mut self,
        request: TeamDecisionRequest,
    ) -> Result<TeamDecisionReceiptProjection, TeamDecisionCompositionError> {
        let command = request.0;

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
            .team_run
            .record_decision(&mut self.store, command)
            .map_err(project_store_error)?;
        Ok(TeamDecisionReceiptProjection::from_receipt(
            receipt.decision().clone(),
            receipt.is_replay(),
        ))
    }

    /// Returns one durable decision for recovery or a consumer read.
    pub fn query_decision(
        &self,
        run_id: &str,
        idempotency_key: &str,
    ) -> Option<TeamDecisionReceiptProjection> {
        self.store
            .decision(run_id, idempotency_key)
            .cloned()
            .map(|decision| TeamDecisionReceiptProjection::from_receipt(decision, true))
    }

    /// Returns all durable decisions for a run in ledger order.
    pub fn recover_decisions(&self, run_id: &str) -> Vec<TeamDecisionReceiptProjection> {
        let mut decisions = self
            .store
            .facts()
            .decisions()
            .filter(|decision| decision.run_id() == run_id)
            .cloned()
            .collect::<Vec<_>>();
        decisions.sort_by_key(|decision| decision.sequence());
        decisions
            .into_iter()
            .map(|decision| TeamDecisionReceiptProjection::from_receipt(decision, true))
            .collect()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamDecisionRequest(TeamDecisionCommand);

impl TeamDecisionRequest {
    pub fn try_new(
        run_id: String,
        stage_id: Option<String>,
        decision: TeamDecisionType,
        note: Option<String>,
        idempotency_key: String,
        created_at: u64,
    ) -> Result<Self, TeamDecisionCompositionError> {
        TeamDecisionCommand::try_new(
            format!("team-decision-{idempotency_key}"),
            run_id,
            stage_id.unwrap_or_else(|| "run".to_owned()),
            decision,
            note,
            idempotency_key,
            created_at,
        )
        .map(Self)
        .map_err(|_| TeamDecisionCompositionError::Invalid)
    }

    pub fn from_command(command: TeamDecisionCommand) -> Self {
        Self(command)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamDecisionReceiptProjection {
    decision: TeamDecision,
    replayed: bool,
}

impl TeamDecisionReceiptProjection {
    fn from_receipt(decision: TeamDecision, replayed: bool) -> Self {
        Self { decision, replayed }
    }

    pub fn decision(&self) -> &TeamDecision {
        &self.decision
    }

    pub const fn replayed(&self) -> bool {
        self.replayed
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamDecisionCompositionError {
    Invalid,
    Unavailable,
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
                .submit_decision(
                    TeamDecisionRequest::try_new(
                        "run:one".to_owned(),
                        Some(format!("stage:{index}")),
                        decision,
                        Some(format!("note-{index}")),
                        format!("decision:{index}"),
                        100 + index as u64,
                    )
                    .unwrap(),
                )
                .unwrap();
            assert!(!receipt.replayed());
            assert_eq!(receipt.decision().decision(), decision);
            assert_eq!(
                receipt.decision().decision_id(),
                format!("team-decision-decision:{index}")
            );
            assert_eq!(receipt.decision().sequence(), index as u64 + 1);
        }
        assert_eq!(facade.recover_decisions("run:one").len(), 3);
        drop(facade);
        remove_test_path(&path);
    }

    #[test]
    fn retry_replays_the_original_durable_receipt_and_rejects_conflict() {
        let path = test_path("idempotency");
        let mut facade = facade(&path);
        let request = TeamDecisionRequest::try_new(
            "run:one".to_owned(),
            None,
            TeamDecisionType::Retry,
            Some("try again".to_owned()),
            "decision:one".to_owned(),
            100,
        )
        .unwrap();
        let first = facade.submit_decision(request.clone()).unwrap();
        let replay = facade.submit_decision(request).unwrap();
        assert!(!first.replayed());
        assert!(replay.replayed());
        assert_eq!(replay.decision(), first.decision());
        assert_eq!(replay.decision().created_at(), 100);
        assert_eq!(
            facade.submit_decision(
                TeamDecisionRequest::try_new(
                    "run:one".to_owned(),
                    None,
                    TeamDecisionType::Abort,
                    Some("try again".to_owned()),
                    "decision:one".to_owned(),
                    100,
                )
                .unwrap(),
            ),
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
                .submit_decision(
                    TeamDecisionRequest::try_new(
                        "run:recovered".to_owned(),
                        Some("stage:review".to_owned()),
                        TeamDecisionType::ProceedDegraded,
                        None,
                        "decision:recovered".to_owned(),
                        77,
                    )
                    .unwrap(),
                )
                .unwrap();
        }
        let facade = facade(&path);
        let recovered = facade.recover_decisions("run:recovered");
        assert_eq!(recovered.len(), 1);
        assert_eq!(
            recovered[0].decision().decision(),
            TeamDecisionType::ProceedDegraded
        );
        assert!(recovered[0].replayed());
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
