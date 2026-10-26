use std::sync::Arc;

use world_protocol::{failure::FailureStage, ids::*};
use crate::{
    authorization::AuthorityRoot,
    extensions::lifecycle::{AcceptedTransferSelection, LiveExtensions},
    store::{TransferCut, TransferDraining, WorldStore, WorldTransaction},
};
use super::{Error, checkpoint, tasks::Tasks};

#[derive(Clone)]
pub(crate) struct TransferWorkCheckpoint {
    draining: TransferDraining,
    selection: AcceptedTransferSelection,
    live: Arc<LiveExtensions>,
    tasks: Arc<Tasks>,
    authority: Arc<AuthorityRoot>,
    storage_id: String,
    commit: CommitId,
    input: Digest,
}

impl TransferWorkCheckpoint {
    pub(super) fn new(
        store: &WorldStore, authority: Arc<AuthorityRoot>, draining: TransferDraining,
        selection: AcceptedTransferSelection, live: Arc<LiveExtensions>, tasks: Arc<Tasks>,
    ) -> Result<Self, Error> {
        if draining.cut() != selection.cut() || store.identity_receipt().storage_id() != draining.cut().source_storage_id {
            return Err(Error::internal(FailureStage::Drain));
        }
        let input = crate::definitions::canonical_digest(&("world.transfer.accepted-work.v1", draining.cut()))?;
        let commit = CommitId::try_new(format!("transfer-checkpoint-{}", &input.as_str()[7..]))
            .map_err(|cause| Error::internal(FailureStage::Drain).caused(cause))?;
        Ok(Self { draining, selection, live, tasks, authority,
            storage_id: store.identity_receipt().storage_id().to_owned(), commit, input })
    }

    pub(crate) fn world(&self) -> &WorldRef { &self.cut().world }
    pub(crate) fn cut(&self) -> &TransferCut { self.draining.cut() }
    pub(crate) fn commit_id(&self) -> &CommitId { &self.commit }
    pub(crate) fn input_digest(&self) -> &Digest { &self.input }
    pub(crate) fn storage_id(&self) -> &str { &self.storage_id }
    pub(crate) fn same_root(&self, root: &AuthorityRoot) -> bool { std::ptr::eq(self.authority.as_ref(), root) }
    pub(crate) fn validate(&self) -> bool {
        self.draining.cut() == self.selection.cut() && self.live.validate_accepted_transfer(&self.selection)
    }
}

pub(crate) async fn checkpoint_transfer_work(
    tx: &mut WorldTransaction<'_>, proof: &TransferWorkCheckpoint,
) -> Result<Vec<RunId>, Error> {
    if tx.world() != proof.world() || !proof.validate() { return Err(Error::internal(FailureStage::Drain)); }
    let runs = checkpoint::checkpoint_runs(tx, &proof.tasks, None, None).await?;
    if !proof.validate() { return Err(Error::internal(FailureStage::Drain)); }
    Ok(runs)
}
