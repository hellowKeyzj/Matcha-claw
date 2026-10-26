use std::{future::Future, pin::Pin};

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tokio_postgres::{Row, types::ToSql};
use world_protocol::{
    commit::{CommitFailure, CommitReceipt, CommittedRevision, WriteFence},
    failure::FailureStage,
    ids::{
        CommitId, Digest, EventId, Generation, ResourceRef, WatchId, WorldRef, WriterDomain,
        WriterEpoch,
    },
    time::Timestamp,
};

use super::StoreError;

pub(crate) type StoreFuture<'a, T, E = StoreError> =
    Pin<Box<dyn Future<Output = Result<T, E>> + Send + 'a>>;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct WatchBasis {
    pub watch_id: WatchId,
    pub generation: Generation,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct CommitRequest {
    pub world: WorldRef,
    pub commit_id: CommitId,
    pub input_digest: Digest,
    pub storage_epoch: WriterEpoch,
    pub fences: Vec<WriteFence>,
    pub watch_basis: Vec<WatchBasis>,
}

pub(crate) struct PreparedBatch {
    pub(super) request: CommitRequest,
    pub(super) provision_storage: Option<String>,
    pub(super) exclusive_domains: Vec<WriterDomain>,
    pub(super) exclusive_storage: bool,
    pub(super) world_mutation: Option<super::CommittedWorldMutation>,
    pub(super) receipt_access: bool,
    pub(super) recovery_pin_release: Option<super::pin_release::RecoveryPinRelease>,
    pub(super) accepted_work: Option<super::accepted_work::AcceptedWork>,
    pub(super) failed_work: Option<super::failed_work::FailedWork>,
    pub(super) transfer_checkpoint: Option<super::transfer_admission::TransferCheckpoint>,
    pub(super) evaluation_report: Option<super::evaluation_settlement::EvaluationReport>,
}

impl PreparedBatch {
    pub(crate) fn receipt_access(mut self) -> Result<Self, StoreError> {
        if self.provision_storage.is_some()
            || self.world_mutation.is_some()
            || self
                .request
                .fences
                .iter()
                .any(|fence| !matches!(fence.domain.as_str(), "operation" | "authorization"))
        {
            return Err(StoreError::new(
                CommitFailure::InvalidBatch,
                FailureStage::Prepare,
            ));
        }
        self.receipt_access = true;
        Ok(self)
    }

    pub(crate) fn resume_world_mutation(
        mut self,
        intent: &super::CommittedWorldMutation,
    ) -> Result<Self, StoreError> {
        if self.provision_storage.is_some()
            || self.request.world != *intent.world()
            || self.request.commit_id == *intent.commit_id()
            || self.request.fences.iter().any(|fence| {
                if self.request.commit_id == *intent.final_commit_id() {
                    !matches!(
                        fence.domain.as_str(),
                        "operation"
                            | "content"
                            | "packages"
                            | "bindings"
                            | "releases"
                            | "authorization"
                    )
                } else {
                    !matches!(fence.domain.as_str(), "operation" | "authorization")
                }
            })
        {
            return Err(StoreError::new(
                CommitFailure::InvalidBatch,
                FailureStage::Prepare,
            ));
        }
        self.exclusive_storage = true;
        self.world_mutation = Some(intent.clone());
        Ok(self)
    }

    pub(crate) fn exclusive_storage(mut self) -> Result<Self, StoreError> {
        if self.provision_storage.is_some() {
            return Err(StoreError::new(
                CommitFailure::InvalidBatch,
                FailureStage::Prepare,
            ));
        }
        self.exclusive_storage = true;
        Ok(self)
    }

    pub(crate) fn exclusive_fences(mut self, domains: &[WriterDomain]) -> Result<Self, StoreError> {
        if self.provision_storage.is_some()
            || domains.iter().any(|domain| {
                !self
                    .request
                    .fences
                    .iter()
                    .any(|fence| &fence.domain == domain)
            })
        {
            return Err(StoreError::new(
                CommitFailure::InvalidBatch,
                FailureStage::Prepare,
            ));
        }
        self.exclusive_domains.extend_from_slice(domains);
        self.exclusive_domains.sort_unstable();
        self.exclusive_domains.dedup();
        Ok(self)
    }
}

impl CommitRequest {
    /// Structural preparation only. Domain validation and current authorization run in transact.
    pub fn prepare(mut self) -> Result<PreparedBatch, StoreError> {
        let invalid = || StoreError::new(CommitFailure::InvalidBatch, FailureStage::Validate);
        if self.fences.is_empty()
            || self.fences.len() > 128
            || self.watch_basis.len() > 4096
            || self.storage_epoch.0 == 0
            || self.storage_epoch.0 > i64::MAX as u64
        {
            return Err(invalid());
        }
        self.fences
            .sort_unstable_by(|left, right| left.domain.cmp(&right.domain));
        self.watch_basis
            .sort_unstable_by(|left, right| left.watch_id.cmp(&right.watch_id));
        if self.fences.iter().any(|fence| {
            fence.world != self.world || fence.epoch.0 == 0 || fence.epoch.0 > i64::MAX as u64
        }) || self
            .fences
            .windows(2)
            .any(|pair| pair[0].domain == pair[1].domain)
            || self
                .watch_basis
                .iter()
                .any(|basis| basis.generation.0 > i64::MAX as u64)
            || self
                .watch_basis
                .windows(2)
                .any(|pair| pair[0].watch_id == pair[1].watch_id)
        {
            return Err(invalid());
        }
        Ok(PreparedBatch {
            request: self,
            provision_storage: None,
            exclusive_domains: Vec::new(),
            exclusive_storage: false,
            world_mutation: None,
            receipt_access: false,
            recovery_pin_release: None,
            accepted_work: None,
            failed_work: None,
            transfer_checkpoint: None,
            evaluation_report: None,
        })
    }

    /// First-world provisioning uses the same receipt/CAS/COMMIT mechanism, never a second writer.
    pub(crate) fn prepare_provision(
        self,
        _authority: &crate::authorization::AuthorityRoot,
        storage_id: String,
    ) -> Result<PreparedBatch, StoreError> {
        if storage_id.is_empty()
            || storage_id.len() > 256
            || storage_id.chars().any(char::is_control)
            || self.storage_epoch != WriterEpoch(1)
            || !self.watch_basis.is_empty()
            || self
                .fences
                .iter()
                .any(|fence| fence.epoch != WriterEpoch(1))
            || !self
                .fences
                .iter()
                .any(|fence| fence.domain.as_str() == "operation")
        {
            return Err(StoreError::new(
                CommitFailure::InvalidBatch,
                FailureStage::Prepare,
            ));
        }
        let mut prepared = self.prepare()?;
        prepared.provision_storage = Some(storage_id);
        Ok(prepared)
    }
}

#[derive(Debug)]
pub(crate) enum TransactionError<E> {
    /// The unique receipt reservation proved no earlier transaction with this identity committed.
    NotCommitted {
        error: E,
        cleanup: Option<StoreError>,
    },
    /// Do not release publication gates or retry with a fresh identity.
    Indeterminate(StoreError),
}

pub(crate) struct Committed<T> {
    pub value: T,
    pub receipt: CommitReceipt,
    pub replayed: bool,
}

pub(crate) struct OutboxEvent {
    pub event_id: EventId,
    pub aggregate_kind: String,
    pub aggregate_id: String,
    pub aggregate_revision: u64,
    pub event_kind: String,
    pub payload: serde_json::Value,
    pub causation_id: Option<EventId>,
    pub origin: String,
}

pub(crate) struct WorldTransaction<'a> {
    pub(super) transaction: tokio_postgres::Transaction<'a>,
    pub(super) world: WorldRef,
    pub(super) token: std::sync::Arc<()>,
    pub(super) storage_id: String,
    pub(super) commit_id: CommitId,
    pub(super) fences: Vec<WriteFence>,
    pub(super) provisioning: bool,
    pub(super) exclusive_storage: bool,
    pub(super) world_mutation: Option<super::CommittedWorldMutation>,
    pub(super) receipt_access: bool,
    pub(super) recovery_pin_release: Option<super::pin_release::RecoveryPinRelease>,
    pub(super) accepted_work: Option<super::accepted_work::AcceptedWork>,
    pub(super) failed_work: Option<super::failed_work::FailedWork>,
    pub(super) transfer_checkpoint: Option<super::transfer_admission::TransferCheckpoint>,
    pub(super) evaluation_report: Option<super::evaluation_settlement::EvaluationReport>,
    pub(super) exclusive_domains: Vec<WriterDomain>,
    pub(super) revisions: Vec<CommittedRevision>,
    pub(super) outbox_ids: Vec<EventId>,
}

impl WorldTransaction<'_> {
    pub fn world(&self) -> &WorldRef {
        &self.world
    }
    pub fn commit_id(&self) -> &CommitId {
        &self.commit_id
    }
    pub(crate) fn transaction_token(&self) -> std::sync::Arc<()> {
        self.token.clone()
    }
    pub fn fences(&self) -> &[WriteFence] {
        &self.fences
    }
    pub(crate) fn require_world_mutation_operation(
        &self,
        operation: &world_protocol::ids::OperationId,
    ) -> Result<(), StoreError> {
        if self
            .world_mutation
            .as_ref()
            .is_some_and(|intent| &intent.operation().operation_id != operation)
        {
            return Err(StoreError::new(
                CommitFailure::InvalidBatch,
                FailureStage::Admission,
            ));
        }
        Ok(())
    }
    pub fn primary_fence(&self) -> &WriteFence {
        &self.fences[0]
    }
    pub fn require_provision(&self) -> Result<(), StoreError> {
        if self.provisioning {
            return Ok(());
        }
        Err(StoreError::new(
            CommitFailure::InvalidBatch,
            FailureStage::Admission,
        ))
    }
    pub fn require_domain(&self, domain: &WriterDomain) -> Result<(), StoreError> {
        if self.fences.iter().any(|fence| &fence.domain == domain) {
            return Ok(());
        }
        Err(StoreError::new(
            CommitFailure::InvalidBatch,
            FailureStage::Admission,
        ))
    }
    pub fn require_exclusive_storage(&self) -> Result<(), StoreError> {
        if self.exclusive_storage {
            return Ok(());
        }
        Err(StoreError::new(
            CommitFailure::InvalidBatch,
            FailureStage::Admission,
        ))
    }
    pub fn require_exclusive_domain(&self, domain: &WriterDomain) -> Result<(), StoreError> {
        if self.exclusive_domains.contains(domain) {
            return Ok(());
        }
        Err(StoreError::new(
            CommitFailure::InvalidBatch,
            FailureStage::Admission,
        ))
    }
    pub async fn now(&self) -> Result<Timestamp, StoreError> {
        database_now(&self.transaction).await
    }

    // Only built-in domain reducers call static parameterized SQL. No guest hostcall exposes this.
    pub async fn execute(
        &self,
        statement: &'static str,
        parameters: &[&(dyn ToSql + Sync)],
    ) -> Result<u64, StoreError> {
        if self.receipt_access
            && !matches!(
                statement,
                "INSERT INTO world_commit_receipt(tenant_id,world_id,commit_id,input_digest) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING"
                    | "UPDATE world_commit_receipt SET receipt=$4,result=$5,committed_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND commit_id=$3"
                    | "INSERT INTO world_auth_replay(tenant_id,world_id,issuer,request_id,input_digest,expires_at) VALUES($1,$2,$3,$4,$5,$6::text::timestamptz) ON CONFLICT DO NOTHING"
                    | "INSERT INTO world_auth_decision(tenant_id,world_id,decision_id,invocation_id,actor_id,impact_digest,decision) VALUES($1,$2,$3,$4,$5,$6,$7)"
            )
        {
            return Err(StoreError::new(
                CommitFailure::Closed,
                FailureStage::Admission,
            ));
        }
        if self.recovery_pin_release.is_some()
            && !matches!(
                statement,
                "INSERT INTO world_commit_receipt(tenant_id,world_id,commit_id,input_digest) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING"
                    | "UPDATE world_commit_receipt SET receipt=$4,result=$5,committed_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND commit_id=$3"
                    | "UPDATE world_blob_pin SET released_at=COALESCE(released_at,clock_timestamp()) WHERE tenant_id=$1 AND world_id=$2 AND digest=$3 AND pin_id=$4 AND generation=$5 AND owner_id=$6 AND kind=$7"
            )
        {
            return Err(StoreError::new(
                CommitFailure::Closed,
                FailureStage::Admission,
            ));
        }
        if self.accepted_work.is_some() && !super::accepted_work::allows(statement) {
            return Err(StoreError::new(
                CommitFailure::Closed,
                FailureStage::Admission,
            ));
        }
        if self.failed_work.is_some() && !super::failed_work::allows(statement) {
            return Err(StoreError::new(
                CommitFailure::Closed,
                FailureStage::Admission,
            ));
        }
        if self.transfer_checkpoint.is_some() && !super::transfer_admission::allows(statement) {
            return Err(StoreError::new(
                CommitFailure::Closed,
                FailureStage::Admission,
            ));
        }
        if self.evaluation_report.is_some() && !super::evaluation_settlement::allows(statement) {
            return Err(StoreError::new(
                CommitFailure::Closed,
                FailureStage::Admission,
            ));
        }
        self.transaction
            .execute(statement, parameters)
            .await
            .map_err(|error| StoreError::database(error, FailureStage::Commit))
    }

    pub async fn query(
        &self,
        statement: &'static str,
        parameters: &[&(dyn ToSql + Sync)],
    ) -> Result<Vec<Row>, StoreError> {
        self.transaction
            .query(statement, parameters)
            .await
            .map_err(|error| StoreError::database(error, FailureStage::Read))
    }

    pub async fn query_opt(
        &self,
        statement: &'static str,
        parameters: &[&(dyn ToSql + Sync)],
    ) -> Result<Option<Row>, StoreError> {
        self.transaction
            .query_opt(statement, parameters)
            .await
            .map_err(|error| StoreError::database(error, FailureStage::Read))
    }

    pub fn record_revision(&mut self, revision: CommittedRevision) -> Result<(), StoreError> {
        if revision.revision.0 > i64::MAX as u64 {
            return Err(StoreError::new(
                CommitFailure::InvalidBatch,
                FailureStage::Validate,
            ));
        }
        if let Some(recorded) = self
            .revisions
            .iter_mut()
            .find(|recorded| recorded.resource == revision.resource)
        {
            if revision.revision < recorded.revision {
                return Err(StoreError::new(
                    CommitFailure::InvalidBatch,
                    FailureStage::Validate,
                ));
            }
            *recorded = revision;
        } else {
            self.revisions.push(revision);
        }
        Ok(())
    }

    pub async fn emit(&mut self, event: OutboxEvent) -> Result<(), StoreError> {
        let revision = i64::try_from(event.aggregate_revision)
            .map_err(|_| StoreError::new(CommitFailure::InvalidBatch, FailureStage::Validate))?;
        if event.aggregate_kind.is_empty()
            || event.aggregate_id.is_empty()
            || event.event_kind.is_empty()
            || event.origin.is_empty()
            || self.outbox_ids.contains(&event.event_id)
            || serde_json::to_vec(&event.payload).map_or(true, |bytes| bytes.len() > 1_048_576)
        {
            return Err(StoreError::new(
                CommitFailure::InvalidBatch,
                FailureStage::Validate,
            ));
        }
        self.execute(
            "INSERT INTO world_outbox(tenant_id,world_id,event_id,aggregate_kind,aggregate_id,aggregate_revision,event_kind,payload,causation_id,origin) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
            &[&self.world.tenant_id.as_str(), &self.world.world_id.as_str(), &event.event_id.as_str(),
              &event.aggregate_kind, &event.aggregate_id, &revision, &event.event_kind, &event.payload,
              &event.causation_id.as_ref().map(EventId::as_str), &event.origin],
        ).await?;
        self.outbox_ids.push(event.event_id);
        Ok(())
    }

    pub fn require_changed(&self, changed: u64, resource: ResourceRef) -> Result<(), StoreError> {
        if changed == 1 {
            return Ok(());
        }
        Err(StoreError::new(
            CommitFailure::ReadDependencyChanged { resource },
            FailureStage::Validate,
        ))
    }
}

pub(crate) struct WorldSnapshot<'a> {
    pub(super) transaction: tokio_postgres::Transaction<'a>,
    pub(super) world: WorldRef,
}

impl WorldSnapshot<'_> {
    pub fn world(&self) -> &WorldRef {
        &self.world
    }
    pub async fn now(&self) -> Result<Timestamp, StoreError> {
        database_now(&self.transaction).await
    }
    pub async fn query(
        &self,
        statement: &'static str,
        parameters: &[&(dyn ToSql + Sync)],
    ) -> Result<Vec<Row>, StoreError> {
        self.transaction
            .query(statement, parameters)
            .await
            .map_err(|error| StoreError::database(error, FailureStage::Read))
    }
    pub async fn query_opt(
        &self,
        statement: &'static str,
        parameters: &[&(dyn ToSql + Sync)],
    ) -> Result<Option<Row>, StoreError> {
        self.transaction
            .query_opt(statement, parameters)
            .await
            .map_err(|error| StoreError::database(error, FailureStage::Read))
    }
}

async fn database_now(
    transaction: &tokio_postgres::Transaction<'_>,
) -> Result<Timestamp, StoreError> {
    let row = transaction.query_one("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS at", &[])
        .await.map_err(|error| StoreError::database(error, FailureStage::Read))?;
    Timestamp::try_new(row.get::<_, String>("at")).map_err(|error| {
        StoreError::caused_by(CommitFailure::InternalFault, FailureStage::Read, error)
    })
}

pub(super) fn decode_committed<T: DeserializeOwned>(
    row: &Row,
    digest: &Digest,
    commit_id: &CommitId,
    world: &WorldRef,
) -> Result<Committed<T>, StoreError> {
    let recorded_digest: String = row
        .try_get("input_digest")
        .map_err(|error| StoreError::database(error, FailureStage::Recover))?;
    if recorded_digest != digest.as_str() {
        return Err(StoreError::new(
            CommitFailure::CommitIdPayloadConflict {
                commit_id: commit_id.clone(),
            },
            FailureStage::Recover,
        ));
    }
    let receipt: Option<serde_json::Value> = row
        .try_get("receipt")
        .map_err(|error| StoreError::database(error, FailureStage::Recover))?;
    let result: Option<serde_json::Value> = row
        .try_get("result")
        .map_err(|error| StoreError::database(error, FailureStage::Recover))?;
    let (Some(receipt), Some(result)) = (receipt, result) else {
        return Err(StoreError::new(
            CommitFailure::CommitIndeterminate {
                commit_id: commit_id.clone(),
            },
            FailureStage::Recover,
        ));
    };
    let receipt: CommitReceipt = serde_json::from_value(receipt).map_err(|error| {
        StoreError::caused_by(CommitFailure::InternalFault, FailureStage::Recover, error)
    })?;
    if receipt.commit_id != *commit_id || receipt.world != *world || receipt.fence.world != *world {
        return Err(StoreError::new(
            CommitFailure::InternalFault,
            FailureStage::Recover,
        ));
    }
    Ok(Committed {
        value: serde_json::from_value(result).map_err(|error| {
            StoreError::caused_by(CommitFailure::InternalFault, FailureStage::Recover, error)
        })?,
        receipt,
        replayed: true,
    })
}

pub(super) fn encode_result<T: Serialize>(value: &T) -> Result<serde_json::Value, StoreError> {
    let result = serde_json::to_value(value).map_err(|error| {
        StoreError::caused_by(CommitFailure::InvalidBatch, FailureStage::Validate, error)
    })?;
    if serde_json::to_vec(&result).map_or(true, |bytes| bytes.len() > 4_194_304) {
        return Err(StoreError::new(
            CommitFailure::InvalidBatch,
            FailureStage::Validate,
        ));
    }
    Ok(result)
}
