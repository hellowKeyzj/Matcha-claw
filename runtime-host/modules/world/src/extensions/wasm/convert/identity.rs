use super::*;

record!(world_protocol::identity::SourceKey, SourceKey; world, source_id, namespace, native_key, incarnation, valid_time);
record!(world_protocol::identity::Object, Object; world, id, type_id);
record!(world_protocol::identity::Relation, Relation; world, id, type_id);
variant!(world_protocol::identity::IdentityRecord, IdentityRecord; units []; tuples [Object, Relation]; records []);
record!(world_protocol::identity::IdentitySnapshot, IdentitySnapshot; record, revision);
record!(world_protocol::identity::IdentityCandidate, IdentityCandidate; identity, evidence);
record!(world_protocol::identity::IdentityResolveRequest, IdentityResolveRequest; key, type_ref, candidates, scope, candidates_complete, dependencies);
variant!(world_protocol::identity::IdentityProposal, IdentityProposal; units []; tuples []; records [Same { target, evidence } => IdentityProposalSame, New { type_ref, evidence } => IdentityProposalNew, Ambiguous { candidates, evidence } => IdentityProposalAmbiguous]);
variant!(world_protocol::identity::IdentityFailure, IdentityFailure; units [InvalidMerge, InvalidSplit, CrossWorld, ScopeConflict, InvalidInterval, PermissionDenied, Cancelled, CandidateScopeIncomplete, ImpactSetChanged, InternalFault]; tuples []; records [Ambiguous { candidates } => IdentityFailureAmbiguous, AliasConflict { key } => IdentityFailureAliasConflict, RevisionConflict { expected, actual } => IdentityFailureRevisionConflict, OverlappingIncarnation { source_id } => IdentityFailureOverlappingIncarnation, UnresolvedIdentity { subject } => IdentityFailureUnresolvedIdentity, UnresolvedType { reference } => IdentityFailureUnresolvedType, TypeKindMismatch { reference } => IdentityFailureTypeKindMismatch, BasisChanged { resource } => IdentityFailureBasisChanged, Commit { failure } => IdentityFailureCommit]);
