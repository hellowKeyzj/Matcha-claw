use super::{
    ActionFailureNode, ComponentFailure, HostFailureNode, OperationFailureNode, QueryFailureNode,
    ReleaseFailureNode, SlotFailureNode, room, take, validate,
};
use crate::{
    failure::FieldPath,
    ids::*,
    releases::{MergeConflict, ReleaseFailure, ReleaseHead},
    sources::{
        GapReason, MappingFailure, SourceCapability, SourceCredentialReason, SourceFailure,
        SourcePlanReason,
    },
    time::DurationMs,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceFailureArena {
    pub nodes: Vec<SourceFailureNode>,
    pub root: u32,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SourceFailureNode {
    Leaf {
        failure: SourceFailureLeaf,
    },
    Cleanup {
        primary: Option<u32>,
        code: String,
    },
    ReleaseBackfill {
        release_id: ReleaseId,
        partition: String,
        failure: u32,
    },
    PluginInvocation {
        failure: u32,
    },
    Host {
        failure: HostFailureNode,
    },
    Operation {
        failure: OperationFailureNode,
    },
    Slot {
        failure: SlotFailureNode,
    },
    Query {
        failure: QueryFailureNode,
    },
    Action {
        failure: ActionFailureNode,
    },
    Release {
        failure: ReleaseFailureNode,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SourceFailureLeaf {
    Authorization {
        failure: crate::authorization::AuthorizationFailure,
    },
    Commit {
        failure: crate::commit::CommitFailure,
    },
    Binding {
        failure: crate::bindings::BindingFailure,
    },
    Compile {
        failure: crate::compiler::CompileFailure,
    },
    Mapping {
        failure: MappingFailure,
    },
    Release {
        failure: ReleaseFailureLeaf,
    },
    Lifecycle {
        failure: crate::lifecycle::LifecycleFailure,
    },
    Package {
        failure: crate::package::PackageFailure,
    },
    ConcurrentCallLimit,
    BudgetExceeded {
        dimension: crate::budget::BudgetDimension,
    },
    InvalidPlan {
        field: crate::failure::FieldPath,
        reason: SourcePlanReason,
    },
    ConnectionMissing {
        connection_id: ConnectionId,
    },
    RevisionConflict {
        expected: Revision,
        actual: Revision,
    },
    SqlState {
        code: String,
    },
    ResponseInvalid {
        field: crate::failure::FieldPath,
    },
    ResponseLimit,
    EffectIndeterminate {
        intent_id: EffectIntentId,
    },
    Credential {
        reason: SourceCredentialReason,
    },
    Authentication,
    PermissionDenied,
    Connection,
    ConnectTimeout,
    ReadTimeout,
    RateLimited {
        retry_after: Option<DurationMs>,
    },
    ServiceUnavailable,
    UnsupportedField {
        field: String,
    },
    HistoryUnavailable,
    CapabilityMissing {
        capability: SourceCapability,
    },
    SchemaDrift {
        expected: Digest,
        actual: Digest,
    },
    CheckpointIncompatible {
        format: CheckpointFormatId,
    },
    PositionExpired,
    PositionIncomparable,
    IncompleteTransaction,
    ReaderNotStopped,
    AckChannelNotStopped,
    EpochStale {
        expected: PartitionEpoch,
        actual: PartitionEpoch,
    },
    Gap {
        reason: GapReason,
    },
    ProtocolViolation,
    UpstreamUnrecognized {
        safe_code: String,
    },
    Cancelled,
    InternalFault,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ReleaseFailureLeaf {
    BranchMissing {
        branch_id: BranchId,
    },
    ReleaseMissing {
        release_id: ReleaseId,
    },
    BranchConflict {
        branch_id: BranchId,
        expected: Revision,
        actual: Revision,
        fields: Vec<FieldPath>,
    },
    HeadConflict {
        channel: ChannelId,
        expected: Option<ReleaseHead>,
        actual: Option<ReleaseHead>,
    },
    MergeConflicts {
        conflicts: Vec<MergeConflict>,
    },
    BasisChanged {
        resources: Vec<ResourceRef>,
    },
    EvaluationRequired {
        suites: Vec<SuiteId>,
    },
    BackfillNotReady {
        release_id: ReleaseId,
        partitions: Vec<String>,
    },
    InvalidBranch {
        field: FieldPath,
    },
    InvalidArtifact {
        field: FieldPath,
    },
    EvaluationMissing {
        evaluation_id: EvaluationId,
    },
    EvaluationRejected {
        evaluation_id: EvaluationId,
    },
    Authorization {
        failure: crate::authorization::AuthorizationFailure,
    },
    Compile {
        failure: crate::compiler::CompileFailure,
    },
    Commit {
        failure: crate::commit::CommitFailure,
    },
    Cancelled,
    InternalFault,
}
pub(super) enum FailureValue {
    Source(SourceFailure),
    Host(crate::process::HostFailure),
    Operation(crate::operation::OperationFailure),
    Slot(crate::slots::SlotFailure),
    Query(crate::query::QueryFailure),
    Action(crate::actions::ActionFailure),
    Release(ReleaseFailure),
}
macro_rules! failure_values {
    ($($method:ident => $case:ident($typ:ty)),+ $(,)?) => {
        impl FailureValue {
            $(pub(super) fn $method(self, node: u32) -> Result<$typ, ComponentFailure> {
                match self {
                    Self::$case(value) => Ok(value),
                    _ => Err(ComponentFailure::NonCanonicalTree { node }),
                }
            })+
        }
    };
}
failure_values! {
    source => Source(SourceFailure),
    host => Host(crate::process::HostFailure),
    operation => Operation(crate::operation::OperationFailure),
    slot => Slot(crate::slots::SlotFailure),
    query => Query(crate::query::QueryFailure),
    action => Action(crate::actions::ActionFailure),
    release => Release(ReleaseFailure),
}
macro_rules! failure_roots {
    ($($from:ident, $into:ident, $node:ident, $original:path, $getter:ident);+ $(;)?) => {
        impl SourceFailureArena {
            $(pub fn $from(failure: &$original) -> Result<Self, ComponentFailure> {
                let mut nodes = Vec::new();
                let root = $node::push(failure, &mut nodes, 1)?;
                Ok(Self { nodes, root })
            }
            pub fn $into(self) -> Result<$original, ComponentFailure> {
                let root = self.root;
                self.rebuild()?.$getter(root)
            })+
        }
    };
}
failure_roots! {
    from_host_failure, into_host_failure, HostFailureNode, crate::process::HostFailure, host;
    from_operation_failure, into_operation_failure, OperationFailureNode, crate::operation::OperationFailure, operation;
    from_slot_failure, into_slot_failure, SlotFailureNode, crate::slots::SlotFailure, slot;
    from_query_failure, into_query_failure, QueryFailureNode, crate::query::QueryFailure, query;
    from_action_failure, into_action_failure, ActionFailureNode, crate::actions::ActionFailure, action;
    from_release_failure, into_release_failure, ReleaseFailureNode, ReleaseFailure, release;
}
impl SourceFailureArena {
    pub(super) fn push(
        failure: &SourceFailure,
        nodes: &mut Vec<SourceFailureNode>,
        depth: usize,
    ) -> Result<u32, ComponentFailure> {
        room(nodes.len(), depth)?;
        let node = match failure {
            SourceFailure::Cleanup { primary, code } => SourceFailureNode::Cleanup {
                primary: primary
                    .as_ref()
                    .map(|failure| Self::push(failure, nodes, depth + 1))
                    .transpose()?,
                code: code.clone(),
            },
            SourceFailure::PluginInvocation { failure } => SourceFailureNode::PluginInvocation {
                failure: HostFailureNode::push(failure, nodes, depth + 1)?,
            },
            SourceFailure::Release { failure } => match failure.as_ref() {
                ReleaseFailure::BackfillFailed {
                    release_id,
                    partition,
                    failure,
                } => SourceFailureNode::ReleaseBackfill {
                    release_id: release_id.clone(),
                    partition: partition.clone(),
                    failure: Self::push(failure, nodes, depth + 1)?,
                },
                _ => SourceFailureNode::Leaf {
                    failure: SourceFailureLeaf::from_leaf(SourceFailure::Release {
                        failure: failure.clone(),
                    })?,
                },
            },
            _ => SourceFailureNode::Leaf {
                failure: SourceFailureLeaf::from_leaf(failure.clone())?,
            },
        };
        room(nodes.len(), depth)?;
        let index = nodes.len() as u32;
        nodes.push(node);
        Ok(index)
    }
    pub fn from_failure(failure: &SourceFailure) -> Result<Self, ComponentFailure> {
        let mut nodes = Vec::new();
        let root = Self::push(failure, &mut nodes, 1)?;
        Ok(Self { nodes, root })
    }
    pub fn into_failure(self) -> Result<SourceFailure, ComponentFailure> {
        let root = self.root;
        self.rebuild()?.source(root)
    }
    fn rebuild(self) -> Result<FailureValue, ComponentFailure> {
        validate(&self.nodes, self.root, |node| match node {
            SourceFailureNode::Leaf { .. } => Vec::new(),
            SourceFailureNode::Cleanup { primary, .. } => primary.iter().copied().collect(),
            SourceFailureNode::ReleaseBackfill { failure, .. }
            | SourceFailureNode::PluginInvocation { failure } => vec![*failure],
            SourceFailureNode::Host { failure } => failure.children(),
            SourceFailureNode::Operation { failure } => failure.children(),
            SourceFailureNode::Slot { failure } => failure.children(),
            SourceFailureNode::Query { failure } => failure.children(),
            SourceFailureNode::Action { failure } => failure.children(),
            SourceFailureNode::Release { failure } => failure.children(),
        })?;
        let mut values: Vec<Option<FailureValue>> = Vec::with_capacity(self.nodes.len());
        for node in self.nodes {
            let failure = match node {
                SourceFailureNode::Leaf { failure } => FailureValue::Source(failure.into_failure()),
                SourceFailureNode::Cleanup { primary, code } => {
                    FailureValue::Source(SourceFailure::Cleanup {
                        primary: primary
                            .map(|child| take(&mut values, child)?.source(child).map(Box::new))
                            .transpose()?,
                        code,
                    })
                }
                SourceFailureNode::ReleaseBackfill {
                    release_id,
                    partition,
                    failure,
                } => FailureValue::Source(SourceFailure::Release {
                    failure: Box::new(ReleaseFailure::BackfillFailed {
                        release_id,
                        partition,
                        failure: take(&mut values, failure)?.source(failure)?,
                    }),
                }),
                SourceFailureNode::PluginInvocation { failure } => {
                    FailureValue::Source(SourceFailure::PluginInvocation {
                        failure: Box::new(take(&mut values, failure)?.host(failure)?),
                    })
                }
                SourceFailureNode::Host { failure } => {
                    FailureValue::Host(failure.into_failure(&mut values)?)
                }
                SourceFailureNode::Operation { failure } => {
                    FailureValue::Operation(failure.into_failure(&mut values)?)
                }
                SourceFailureNode::Slot { failure } => {
                    FailureValue::Slot(failure.into_failure(&mut values)?)
                }
                SourceFailureNode::Query { failure } => {
                    FailureValue::Query(failure.into_failure(&mut values)?)
                }
                SourceFailureNode::Action { failure } => {
                    FailureValue::Action(failure.into_failure(&mut values)?)
                }
                SourceFailureNode::Release { failure } => {
                    FailureValue::Release(failure.into_failure(&mut values)?)
                }
            };
            values.push(Some(failure));
        }
        take(&mut values, self.root)
    }
}
impl SourceFailureLeaf {
    fn from_leaf(failure: SourceFailure) -> Result<Self, ComponentFailure> {
        Ok(match failure {
            SourceFailure::Authorization { failure } => Self::Authorization { failure },
            SourceFailure::Commit { failure } => Self::Commit { failure },
            SourceFailure::Binding { failure } => Self::Binding { failure },
            SourceFailure::Compile { failure } => Self::Compile { failure },
            SourceFailure::Mapping { failure } => Self::Mapping { failure },
            SourceFailure::Release { failure } => Self::Release {
                failure: ReleaseFailureLeaf::from_failure(*failure)?,
            },
            SourceFailure::Lifecycle { failure } => Self::Lifecycle { failure },
            SourceFailure::Package { failure } => Self::Package { failure },
            SourceFailure::ConcurrentCallLimit => Self::ConcurrentCallLimit,
            SourceFailure::BudgetExceeded { dimension } => Self::BudgetExceeded { dimension },
            SourceFailure::InvalidPlan { field, reason } => Self::InvalidPlan { field, reason },
            SourceFailure::ConnectionMissing { connection_id } => {
                Self::ConnectionMissing { connection_id }
            }
            SourceFailure::RevisionConflict { expected, actual } => {
                Self::RevisionConflict { expected, actual }
            }
            SourceFailure::SqlState { code } => Self::SqlState { code },
            SourceFailure::ResponseInvalid { field } => Self::ResponseInvalid { field },
            SourceFailure::ResponseLimit => Self::ResponseLimit,
            SourceFailure::EffectIndeterminate { intent_id } => {
                Self::EffectIndeterminate { intent_id }
            }
            SourceFailure::Credential { reason } => Self::Credential { reason },
            SourceFailure::Authentication => Self::Authentication,
            SourceFailure::PermissionDenied => Self::PermissionDenied,
            SourceFailure::Connection => Self::Connection,
            SourceFailure::ConnectTimeout => Self::ConnectTimeout,
            SourceFailure::ReadTimeout => Self::ReadTimeout,
            SourceFailure::RateLimited { retry_after } => Self::RateLimited { retry_after },
            SourceFailure::ServiceUnavailable => Self::ServiceUnavailable,
            SourceFailure::UnsupportedField { field } => Self::UnsupportedField { field },
            SourceFailure::HistoryUnavailable => Self::HistoryUnavailable,
            SourceFailure::CapabilityMissing { capability } => {
                Self::CapabilityMissing { capability }
            }
            SourceFailure::SchemaDrift { expected, actual } => {
                Self::SchemaDrift { expected, actual }
            }
            SourceFailure::CheckpointIncompatible { format } => {
                Self::CheckpointIncompatible { format }
            }
            SourceFailure::PositionExpired => Self::PositionExpired,
            SourceFailure::PositionIncomparable => Self::PositionIncomparable,
            SourceFailure::IncompleteTransaction => Self::IncompleteTransaction,
            SourceFailure::ReaderNotStopped => Self::ReaderNotStopped,
            SourceFailure::AckChannelNotStopped => Self::AckChannelNotStopped,
            SourceFailure::EpochStale { expected, actual } => Self::EpochStale { expected, actual },
            SourceFailure::Gap { reason } => Self::Gap { reason },
            SourceFailure::ProtocolViolation => Self::ProtocolViolation,
            SourceFailure::UpstreamUnrecognized { safe_code } => {
                Self::UpstreamUnrecognized { safe_code }
            }
            SourceFailure::Cancelled => Self::Cancelled,
            SourceFailure::InternalFault => Self::InternalFault,
            SourceFailure::Cleanup { .. } | SourceFailure::PluginInvocation { .. } => {
                return Err(ComponentFailure::NonCanonicalTree { node: 0 });
            }
        })
    }
    pub fn into_failure(self) -> SourceFailure {
        match self {
            Self::Authorization { failure } => SourceFailure::Authorization { failure },
            Self::Commit { failure } => SourceFailure::Commit { failure },
            Self::Binding { failure } => SourceFailure::Binding { failure },
            Self::Compile { failure } => SourceFailure::Compile { failure },
            Self::Mapping { failure } => SourceFailure::Mapping { failure },
            Self::Release { failure } => SourceFailure::Release {
                failure: Box::new(failure.into_failure()),
            },
            Self::Lifecycle { failure } => SourceFailure::Lifecycle { failure },
            Self::Package { failure } => SourceFailure::Package { failure },
            Self::ConcurrentCallLimit => SourceFailure::ConcurrentCallLimit,
            Self::BudgetExceeded { dimension } => SourceFailure::BudgetExceeded { dimension },
            Self::InvalidPlan { field, reason } => SourceFailure::InvalidPlan { field, reason },
            Self::ConnectionMissing { connection_id } => {
                SourceFailure::ConnectionMissing { connection_id }
            }
            Self::RevisionConflict { expected, actual } => {
                SourceFailure::RevisionConflict { expected, actual }
            }
            Self::SqlState { code } => SourceFailure::SqlState { code },
            Self::ResponseInvalid { field } => SourceFailure::ResponseInvalid { field },
            Self::ResponseLimit => SourceFailure::ResponseLimit,
            Self::EffectIndeterminate { intent_id } => {
                SourceFailure::EffectIndeterminate { intent_id }
            }
            Self::Credential { reason } => SourceFailure::Credential { reason },
            Self::Authentication => SourceFailure::Authentication,
            Self::PermissionDenied => SourceFailure::PermissionDenied,
            Self::Connection => SourceFailure::Connection,
            Self::ConnectTimeout => SourceFailure::ConnectTimeout,
            Self::ReadTimeout => SourceFailure::ReadTimeout,
            Self::RateLimited { retry_after } => SourceFailure::RateLimited { retry_after },
            Self::ServiceUnavailable => SourceFailure::ServiceUnavailable,
            Self::UnsupportedField { field } => SourceFailure::UnsupportedField { field },
            Self::HistoryUnavailable => SourceFailure::HistoryUnavailable,
            Self::CapabilityMissing { capability } => {
                SourceFailure::CapabilityMissing { capability }
            }
            Self::SchemaDrift { expected, actual } => {
                SourceFailure::SchemaDrift { expected, actual }
            }
            Self::CheckpointIncompatible { format } => {
                SourceFailure::CheckpointIncompatible { format }
            }
            Self::PositionExpired => SourceFailure::PositionExpired,
            Self::PositionIncomparable => SourceFailure::PositionIncomparable,
            Self::IncompleteTransaction => SourceFailure::IncompleteTransaction,
            Self::ReaderNotStopped => SourceFailure::ReaderNotStopped,
            Self::AckChannelNotStopped => SourceFailure::AckChannelNotStopped,
            Self::EpochStale { expected, actual } => SourceFailure::EpochStale { expected, actual },
            Self::Gap { reason } => SourceFailure::Gap { reason },
            Self::ProtocolViolation => SourceFailure::ProtocolViolation,
            Self::UpstreamUnrecognized { safe_code } => {
                SourceFailure::UpstreamUnrecognized { safe_code }
            }
            Self::Cancelled => SourceFailure::Cancelled,
            Self::InternalFault => SourceFailure::InternalFault,
        }
    }
}
impl ReleaseFailureLeaf {
    pub(super) fn from_failure(failure: ReleaseFailure) -> Result<Self, ComponentFailure> {
        Ok(match failure {
            ReleaseFailure::BranchMissing { branch_id } => Self::BranchMissing { branch_id },
            ReleaseFailure::ReleaseMissing { release_id } => Self::ReleaseMissing { release_id },
            ReleaseFailure::BranchConflict {
                branch_id,
                expected,
                actual,
                fields,
            } => Self::BranchConflict {
                branch_id,
                expected,
                actual,
                fields,
            },
            ReleaseFailure::HeadConflict {
                channel,
                expected,
                actual,
            } => Self::HeadConflict {
                channel,
                expected,
                actual,
            },
            ReleaseFailure::MergeConflicts { conflicts } => Self::MergeConflicts { conflicts },
            ReleaseFailure::BasisChanged { resources } => Self::BasisChanged { resources },
            ReleaseFailure::EvaluationRequired { suites } => Self::EvaluationRequired { suites },
            ReleaseFailure::BackfillNotReady {
                release_id,
                partitions,
            } => Self::BackfillNotReady {
                release_id,
                partitions,
            },
            ReleaseFailure::InvalidBranch { field } => Self::InvalidBranch { field },
            ReleaseFailure::InvalidArtifact { field } => Self::InvalidArtifact { field },
            ReleaseFailure::EvaluationMissing { evaluation_id } => {
                Self::EvaluationMissing { evaluation_id }
            }
            ReleaseFailure::EvaluationRejected { evaluation_id } => {
                Self::EvaluationRejected { evaluation_id }
            }
            ReleaseFailure::Authorization { failure } => Self::Authorization { failure },
            ReleaseFailure::Compile { failure } => Self::Compile { failure },
            ReleaseFailure::Commit { failure } => Self::Commit { failure },
            ReleaseFailure::Cancelled => Self::Cancelled,
            ReleaseFailure::InternalFault => Self::InternalFault,
            ReleaseFailure::BackfillFailed { .. } => {
                return Err(ComponentFailure::NonCanonicalTree { node: 0 });
            }
        })
    }
    pub fn into_failure(self) -> ReleaseFailure {
        match self {
            Self::BranchMissing { branch_id } => ReleaseFailure::BranchMissing { branch_id },
            Self::ReleaseMissing { release_id } => ReleaseFailure::ReleaseMissing { release_id },
            Self::BranchConflict {
                branch_id,
                expected,
                actual,
                fields,
            } => ReleaseFailure::BranchConflict {
                branch_id,
                expected,
                actual,
                fields,
            },
            Self::HeadConflict {
                channel,
                expected,
                actual,
            } => ReleaseFailure::HeadConflict {
                channel,
                expected,
                actual,
            },
            Self::MergeConflicts { conflicts } => ReleaseFailure::MergeConflicts { conflicts },
            Self::BasisChanged { resources } => ReleaseFailure::BasisChanged { resources },
            Self::EvaluationRequired { suites } => ReleaseFailure::EvaluationRequired { suites },
            Self::BackfillNotReady {
                release_id,
                partitions,
            } => ReleaseFailure::BackfillNotReady {
                release_id,
                partitions,
            },
            Self::InvalidBranch { field } => ReleaseFailure::InvalidBranch { field },
            Self::InvalidArtifact { field } => ReleaseFailure::InvalidArtifact { field },
            Self::EvaluationMissing { evaluation_id } => {
                ReleaseFailure::EvaluationMissing { evaluation_id }
            }
            Self::EvaluationRejected { evaluation_id } => {
                ReleaseFailure::EvaluationRejected { evaluation_id }
            }
            Self::Authorization { failure } => ReleaseFailure::Authorization { failure },
            Self::Compile { failure } => ReleaseFailure::Compile { failure },
            Self::Commit { failure } => ReleaseFailure::Commit { failure },
            Self::Cancelled => ReleaseFailure::Cancelled,
            Self::InternalFault => ReleaseFailure::InternalFault,
        }
    }
}
