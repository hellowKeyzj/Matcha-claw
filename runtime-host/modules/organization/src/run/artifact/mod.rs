mod ledger;
mod model;
mod projection;

pub use ledger::{ArtifactLedger, ArtifactRecordOutcome, RestoreArtifactLedgerError};
pub use model::{
    ArtifactEvidenceProvenance, ArtifactId, ArtifactIdError, ArtifactKindError, ArtifactRecord,
    ArtifactRecordError, CompletionMetadata, GraphCompletionArtifactReceipt,
};
pub use projection::{
    AssertArtifactExists, DownstreamInputContext, DownstreamInputContextInput,
    PublicArtifactProjection, build_graph_completion_artifact, build_graph_delivery_input_context,
    project_public_artifact,
};

#[cfg(test)]
mod tests;
