use super::*;

unit_enum!(world_protocol::provenance::WatchPurpose, WatchPurpose; Membership, NotExists, Aggregate, TopK, TimeWindow, MissingField);
unit_enum!(world_protocol::provenance::WatchCoverage, WatchCoverage; CompleteAuthorizedRange, Partial, Gap);
record!(world_protocol::provenance::QueryWatch, QueryWatch; world, id, scope, selector, predicate_digest, purpose, window, generation, coverage, query, arguments, datasets, partitions, visibility_digest, policy_epoch, grant_epoch, next_boundary);
record!(world_protocol::provenance::SupportSnapshot, SupportSnapshot; assertions, evidence, supports, watches);
record!(world_protocol::provenance::SupportDeltaProposal, SupportDeltaProposal; upserts, invalidate, affected_watches, observed_dependencies);
record!(world_protocol::provenance::ExplanationGraph, ExplanationGraph; conclusion, revision, supports, visible_evidence);
unit_enum!(world_protocol::provenance::ProvenanceDependency, ProvenanceDependency; RuleEvaluationProof, ClosedWorldQueryProof, FieldCoverageProof, QueryReceipt, CurrentAuthorization);
unit_enum!(world_protocol::provenance::ProvenanceLimit, ProvenanceLimit; ComponentNodes, AlternativeSupports, ProposalItems, QueryNodes, WatchPartitions);
variant!(world_protocol::provenance::ProvenanceFailure, ProvenanceFailure; units [Cancelled, CleanupFailed, MissingPremise, CrossScope, InvalidInterval, IncompleteNegativeRange, InternalFault]; tuples []; records [DependencyMissing { dependency } => ProvenanceFailureDependencyMissing, LimitExceeded { resource, limit } => ProvenanceFailureLimitExceeded, Dirty { watches } => ProvenanceFailureDirty, UnclosedRange { watch_id } => ProvenanceFailureUnclosedRange, CyclicSupport { assertions } => ProvenanceFailureCyclicSupport, BasisChanged { watch_id, expected, actual } => ProvenanceFailureBasisChanged, Commit { failure } => ProvenanceFailureCommit]);
