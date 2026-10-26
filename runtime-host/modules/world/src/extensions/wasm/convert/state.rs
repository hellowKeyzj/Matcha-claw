use super::*;

record!(world_protocol::state::StateEpoch, StateEpoch; world, namespace, root, writer_domain, writer_epoch, schema, checkpoint_format);
record!(world_protocol::state::StateMigration, StateMigration; id, expected, target_schema, target_checkpoint_format, contract, shadow_root, reversible);
record!(world_protocol::state::StateMigrationInput, StateMigrationInput; migration, checkpoint);
record!(world_protocol::state::StateMigrationOutput, StateMigrationOutput; schema, checkpoint_format, checkpoint);

variant!(world_protocol::state::StateFailure, StateFailure; units [KeyInvalid, SizeLimit, CheckpointBarrierUnsatisfied, ReaderNotStopped, WriterNotStopped, AckNotStopped, ShadowValidationFailed, Fenced, InternalFault]; tuples []; records [RevisionConflict { expected, actual } => StateFailureRevisionConflict, RootConflict { expected, actual } => StateFailureRootConflict, NamespaceMissing { namespace } => StateFailureNamespaceMissing, EpochStale { expected, actual } => StateFailureEpochStale, SchemaMismatch { expected, actual } => StateFailureSchemaMismatch, CheckpointIncompatible { format } => StateFailureCheckpointIncompatible, MigrationUnavailable { migration_id } => StateFailureMigrationUnavailable, MigrationFailed { migration_id } => StateFailureMigrationFailed, Commit { failure } => StateFailureCommit]);
