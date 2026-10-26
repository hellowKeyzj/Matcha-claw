use super::*;

record!(world_protocol::releases::ReleaseHead, ReleaseHead; world, channel, generation, revision, release_id);
record!(world_protocol::releases::MergeConflict, MergeConflict; definition_id, fields);
impl Wire for world_protocol::releases::ReleaseFailure {
    type Output = w::ReleaseFailure;
    fn lower(self) -> Result<Self::Output, WasmError> {
        component::SourceFailureArena::from_release_failure(&self)?.lower()
    }
    fn lift(value: Self::Output) -> Result<Self, WasmError> {
        Ok(component::SourceFailureArena::lift(value)?.into_release_failure()?)
    }
}

variant!(component::ReleaseFailureLeaf, ReleaseFailureLeaf; units [Cancelled, InternalFault]; tuples []; records [BranchMissing { branch_id } => ReleaseFailureLeafBranchMissing, ReleaseMissing { release_id } => ReleaseFailureLeafReleaseMissing, BranchConflict { branch_id, expected, actual, fields } => ReleaseFailureLeafBranchConflict, HeadConflict { channel, expected, actual } => ReleaseFailureLeafHeadConflict, MergeConflicts { conflicts } => ReleaseFailureLeafMergeConflicts, BasisChanged { resources } => ReleaseFailureLeafBasisChanged, EvaluationRequired { suites } => ReleaseFailureLeafEvaluationRequired, BackfillNotReady { release_id, partitions } => ReleaseFailureLeafBackfillNotReady, InvalidBranch { field } => ReleaseFailureLeafInvalidBranch, InvalidArtifact { field } => ReleaseFailureLeafInvalidArtifact, EvaluationMissing { evaluation_id } => ReleaseFailureLeafEvaluationMissing, EvaluationRejected { evaluation_id } => ReleaseFailureLeafEvaluationRejected, Authorization { failure } => ReleaseFailureLeafAuthorization, Compile { failure } => ReleaseFailureLeafCompile, Commit { failure } => ReleaseFailureLeafCommit]);

variant!(component::ReleaseFailureNode, ReleaseFailureNode; units []; tuples []; records [Leaf { failure } => ReleaseFailureNodeLeaf, Backfill { release_id, partition, failure } => ReleaseFailureNodeBackfill]);

record!(world_protocol::releases::BranchRef, BranchRef; world, id, revision);
