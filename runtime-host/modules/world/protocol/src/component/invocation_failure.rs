use super::source_failure::{
    FailureValue, ReleaseFailureLeaf, SourceFailureArena, SourceFailureNode,
};
use super::{ComponentFailure, room, take};
use crate::ids::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "failure",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HostFailureNode {
    Process(crate::process::ProcessFailure),
    Operation(u32),
    Input(crate::failure::InputFailure),
    Authorization(crate::authorization::AuthorizationFailure),
    Binding(crate::bindings::BindingFailure),
    Source(u32),
    Slot(u32),
    Query(u32),
    Generation(crate::generation::GenerationFailure),
    State(crate::state::StateFailure),
    BudgetExceeded {
        dimension: crate::budget::BudgetDimension,
    },
    Cancelled,
    InternalFault,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "failure",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum OperationFailureNode {
    DetailsWithheld,
    NotConfigured,
    NotFound,
    RevisionConflict,
    Input(crate::failure::InputFailure),
    Authorization(crate::authorization::AuthorizationFailure),
    Upload(crate::api::UploadFailure),
    Material(crate::materials::MaterialFailure),
    Source(u32),
    Mapping(crate::sources::MappingFailure),
    Query(u32),
    Slot(u32),
    Identity(crate::identity::IdentityFailure),
    Fact(crate::facts::FactFailure),
    Definition(crate::definitions::DefinitionFailure),
    Release(u32),
    Compile(crate::compiler::CompileFailure),
    Learning(crate::learning::LearningFailure),
    Generation(crate::generation::GenerationFailure),
    BudgetExceeded {
        dimension: crate::budget::BudgetDimension,
    },
    Evaluation(crate::evaluation::EvaluationFailure),
    EvaluationSummary(crate::evaluation::EvaluationSummaryFailure),
    Action(u32),
    Package(crate::package::PackageFailure),
    Binding(crate::bindings::BindingFailure),
    State(crate::state::StateFailure),
    Lifecycle(crate::lifecycle::LifecycleFailure),
    Process(crate::process::ProcessFailure),
    Commit(crate::commit::CommitFailure),
    Cancelled,
    CleanupFailed,
    InternalFault,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "failure",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SlotFailureNode {
    Connector(u32),
    Identity(crate::identity::IdentityFailure),
    Schema(crate::compiler::CompileFailure),
    Resolver(u32),
    Projection(crate::slots::ProjectionFailure),
    Provenance(crate::provenance::ProvenanceFailure),
    Compiler(crate::compiler::CompileFailure),
    Policy(crate::authorization::AuthorizationFailure),
    Action(u32),
    Reconcile(crate::slots::ReconcileFailure),
    Abstraction(crate::abstraction::AbstractionFailure),
    Evaluation(crate::slots::OracleFailure),
    Context(crate::abstraction::ContextFailure),
    AgentBridge(crate::slots::BridgeFailure),
    Storage(crate::commit::CommitFailure),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "failure",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum QueryFailureNode {
    Expression {
        failure: crate::expression::ExpressionFailure,
    },
    Authorization {
        failure: crate::authorization::AuthorizationFailure,
    },
    Compile {
        failure: crate::compiler::CompileFailure,
    },
    InvalidQuery {
        field: crate::failure::FieldPath,
    },
    Source {
        source_id: SourceId,
        failure: u32,
    },
    GuaranteeUnsatisfied {
        mode: crate::query::ReadMode,
        source_id: Option<SourceId>,
    },
    ProjectionLag {
        source_id: SourceId,
        actual: crate::time::DurationMs,
        maximum: crate::time::DurationMs,
    },
    Gap {
        source_id: SourceId,
    },
    Dirty {
        watches: Vec<WatchId>,
    },
    HistoryUnavailable {
        source_id: SourceId,
    },
    BudgetExceeded {
        limit: crate::query::TruncationReason,
    },
    CursorInvalid,
    BasisChanged,
    Cancelled,
    InternalFault,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "failure",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ActionFailureNode {
    ContractMissing {
        reference: DefinitionRef,
    },
    Input {
        failure: crate::failure::InputFailure,
    },
    Compilation {
        failure: crate::compiler::CompileFailure,
    },
    Evaluation {
        failure: u32,
    },
    Definition {
        failure: crate::definitions::DefinitionFailure,
    },
    PreconditionFalse {
        index: u32,
    },
    PreconditionUnknown {
        index: u32,
        value: crate::expression::TruthValue,
    },
    Authorization {
        failure: crate::authorization::AuthorizationFailure,
    },
    ProposalExpired,
    ProposalDigestMismatch,
    IdempotencyConflict,
    Source {
        failure: u32,
    },
    ConditionalWriteConflict,
    EffectIndeterminate {
        intent_id: EffectIntentId,
    },
    VerificationFailed {
        verification_id: VerificationId,
    },
    VerificationUnavailable,
    CompensationFailed,
    Commit {
        failure: crate::commit::CommitFailure,
    },
    BudgetExceeded {
        dimension: crate::budget::BudgetDimension,
    },
    CancelledBeforeEffect,
    CancelledAfterEffect,
    CleanupFailed,
    InternalFault,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ReleaseFailureNode {
    Leaf {
        failure: ReleaseFailureLeaf,
    },
    Backfill {
        release_id: ReleaseId,
        partition: String,
        failure: u32,
    },
}

macro_rules! indexed_failure {
    ($node:ident, $original:path, $case:ident;
        units [$($unit:ident);*];
        tuples [$($tuple:ident($typ:ty));*];
        records [$($record:ident { $($field:ident),* });*];
        indexed_tuples [$($indexed:ident => $child:ident, $getter:ident);*];
        indexed_records [$($irecord:ident { $($ifield:ident),* } $index:ident => $ichild:ident, $igetter:ident);*];
    ) => {
        impl $node {
            pub(super) fn push(failure: &$original, nodes: &mut Vec<SourceFailureNode>, depth: usize) -> Result<u32, ComponentFailure> {
                use $original as Original;
                room(nodes.len(), depth)?;
                let failure = match failure {
                    $(Original::$unit => Self::$unit,)*
                    $(Original::$tuple(value) => Self::$tuple(value.clone()),)*
                    $(Original::$record { $($field),* } => Self::$record { $($field: $field.clone()),* },)*
                    $(Original::$indexed(value) => Self::$indexed($child::push(value, nodes, depth + 1)?),)*
                    $(Original::$irecord { $($ifield,)* $index } => Self::$irecord { $($ifield: $ifield.clone(),)* $index: $ichild::push($index, nodes, depth + 1)? },)*
                };
                room(nodes.len(), depth)?;
                let index = nodes.len() as u32;
                nodes.push(SourceFailureNode::$case { failure });
                Ok(index)
            }
            pub(super) fn children(&self) -> Vec<u32> {
                match self {
                    $(Self::$unit => Vec::new(),)*
                    $(Self::$tuple(_) => Vec::new(),)*
                    $(Self::$record { .. } => Vec::new(),)*
                    $(Self::$indexed(value) => vec![*value],)*
                    $(Self::$irecord { $index, .. } => vec![*$index],)*
                }
            }
            pub(super) fn into_failure(self, values: &mut [Option<FailureValue>]) -> Result<$original, ComponentFailure> {
                use $original as Original;
                Ok(match self {
                    $(Self::$unit => Original::$unit,)*
                    $(Self::$tuple(value) => Original::$tuple(value),)*
                    $(Self::$record { $($field),* } => Original::$record { $($field),* },)*
                    $(Self::$indexed(value) => Original::$indexed(take(values, value)?.$getter(value)?),)*
                    $(Self::$irecord { $($ifield,)* $index } => Original::$irecord { $($ifield,)* $index: take(values, $index)?.$igetter($index)? },)*
                })
            }
        }
    };
}

indexed_failure! { HostFailureNode, crate::process::HostFailure, Host;
    units [Cancelled; InternalFault];
    tuples [Process(crate::process::ProcessFailure); Input(crate::failure::InputFailure); Authorization(crate::authorization::AuthorizationFailure); Binding(crate::bindings::BindingFailure); Generation(crate::generation::GenerationFailure); State(crate::state::StateFailure)];
    records [BudgetExceeded { dimension }];
    indexed_tuples [Operation => OperationFailureNode, operation; Source => SourceFailureArena, source; Slot => SlotFailureNode, slot; Query => QueryFailureNode, query];
    indexed_records [];
}

indexed_failure! { OperationFailureNode, crate::operation::OperationFailure, Operation;
    units [DetailsWithheld; NotConfigured; NotFound; RevisionConflict; Cancelled; CleanupFailed; InternalFault];
    tuples [Input(crate::failure::InputFailure); Authorization(crate::authorization::AuthorizationFailure); Upload(crate::api::UploadFailure); Material(crate::materials::MaterialFailure); Mapping(crate::sources::MappingFailure); Identity(crate::identity::IdentityFailure); Fact(crate::facts::FactFailure); Definition(crate::definitions::DefinitionFailure); Compile(crate::compiler::CompileFailure); Learning(crate::learning::LearningFailure); Generation(crate::generation::GenerationFailure); Evaluation(crate::evaluation::EvaluationFailure); EvaluationSummary(crate::evaluation::EvaluationSummaryFailure); Package(crate::package::PackageFailure); Binding(crate::bindings::BindingFailure); State(crate::state::StateFailure); Lifecycle(crate::lifecycle::LifecycleFailure); Process(crate::process::ProcessFailure); Commit(crate::commit::CommitFailure)];
    records [BudgetExceeded { dimension }];
    indexed_tuples [Source => SourceFailureArena, source; Query => QueryFailureNode, query; Slot => SlotFailureNode, slot; Release => ReleaseFailureNode, release; Action => ActionFailureNode, action];
    indexed_records [];
}

indexed_failure! { SlotFailureNode, crate::slots::SlotFailure, Slot;
    units [];
    tuples [Identity(crate::identity::IdentityFailure); Schema(crate::sources::MappingFailure); Projection(crate::slots::ProjectionFailure); Provenance(crate::provenance::ProvenanceFailure); Compiler(crate::compiler::CompileFailure); Policy(crate::authorization::AuthorizationFailure); Reconcile(crate::slots::ReconcileFailure); Abstraction(crate::abstraction::AbstractionFailure); Evaluation(crate::slots::OracleFailure); Context(crate::abstraction::ContextFailure); AgentBridge(crate::slots::BridgeFailure); Storage(crate::commit::CommitFailure)];
    records [];
    indexed_tuples [Connector => SourceFailureArena, source; Resolver => QueryFailureNode, query; Action => ActionFailureNode, action];
    indexed_records [];
}

indexed_failure! { QueryFailureNode, crate::query::QueryFailure, Query;
    units [CursorInvalid; BasisChanged; Cancelled; InternalFault];
    tuples [];
    records [Expression { failure }; Authorization { failure }; Compile { failure }; InvalidQuery { field }; GuaranteeUnsatisfied { mode, source_id }; ProjectionLag { source_id, actual, maximum }; Gap { source_id }; Dirty { watches }; HistoryUnavailable { source_id }; BudgetExceeded { limit }];
    indexed_tuples [];
    indexed_records [Source { source_id } failure => SourceFailureArena, source];
}

indexed_failure! { ActionFailureNode, crate::actions::ActionFailure, Action;
    units [ProposalExpired; ProposalDigestMismatch; IdempotencyConflict; ConditionalWriteConflict; VerificationUnavailable; CompensationFailed; CancelledBeforeEffect; CancelledAfterEffect; CleanupFailed; InternalFault];
    tuples [];
    records [ContractMissing { reference }; Input { failure }; Compilation { failure }; Definition { failure }; PreconditionFalse { index }; PreconditionUnknown { index, value }; Authorization { failure }; EffectIndeterminate { intent_id }; VerificationFailed { verification_id }; Commit { failure }; BudgetExceeded { dimension }];
    indexed_tuples [];
    indexed_records [Evaluation {  } failure => QueryFailureNode, query; Source {  } failure => SourceFailureArena, source];
}

impl ReleaseFailureNode {
    pub(super) fn push(
        failure: &crate::releases::ReleaseFailure,
        nodes: &mut Vec<SourceFailureNode>,
        depth: usize,
    ) -> Result<u32, ComponentFailure> {
        use crate::releases::ReleaseFailure;
        room(nodes.len(), depth)?;
        let failure = match failure {
            ReleaseFailure::BackfillFailed {
                release_id,
                partition,
                failure,
            } => Self::Backfill {
                release_id: release_id.clone(),
                partition: partition.clone(),
                failure: SourceFailureArena::push(failure, nodes, depth + 1)?,
            },
            _ => Self::Leaf {
                failure: ReleaseFailureLeaf::from_failure(failure.clone())?,
            },
        };
        room(nodes.len(), depth)?;
        let index = nodes.len() as u32;
        nodes.push(SourceFailureNode::Release { failure });
        Ok(index)
    }
    pub(super) fn children(&self) -> Vec<u32> {
        match self {
            Self::Leaf { .. } => Vec::new(),
            Self::Backfill { failure, .. } => vec![*failure],
        }
    }
    pub(super) fn into_failure(
        self,
        values: &mut [Option<FailureValue>],
    ) -> Result<crate::releases::ReleaseFailure, ComponentFailure> {
        Ok(match self {
            Self::Leaf { failure } => failure.into_failure(),
            Self::Backfill {
                release_id,
                partition,
                failure,
            } => crate::releases::ReleaseFailure::BackfillFailed {
                release_id,
                partition,
                failure: take(values, failure)?.source(failure)?,
            },
        })
    }
}
