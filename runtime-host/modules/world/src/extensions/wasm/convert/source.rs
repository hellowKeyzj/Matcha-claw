use super::*;

record!(materials::BoundingBox, BoundingBox; left, bottom, right, top);
tagged!(materials::SourceAnchor, SourceAnchor; units []; single []; records [
    Text { start, end } => TextAnchor, Pdf { page, bbox } => PdfAnchor,
    Html { node_path, text_start, text_end } => HtmlAnchor,
    Sheet { sheet, row, column } => SheetAnchor, PackagePart { part, element } => PartAnchor,
    Media { start_ms, end_ms } => MediaAnchor, Record { namespace, native_key, fields } => RecordAnchor
]);
unit_enum!(sources::RecordError, RecordError; InvalidNumber, InvalidDate, InvalidFormula, PrecisionLost, UnsupportedValue, PermissionDenied);
tagged!(sources::RecordCell, RecordCell; units [Missing]; single [Known { value }, Error { code }]; records []);
record!(sources::FormulaValue, FormulaValue; expression, cached, cache_current);
record!(sources::SourceField, SourceField; id, name, value, raw_lexeme, formula, locator);
record!(sources::SourceRow, SourceRow; native_key, incarnation, fields);
record!(sources::SourcePage, SourcePage; rows, basis, continuation, complete);
record!(sources::SourceReadPlan, SourceReadRequest; binding, resource, row_symbol, fields, predicate, order, limit, continuation, as_of);
record!(sources::SourceOrder, SourceOrder; field, descending);
unit_enum!(expression::UnaryOperator, UnaryOperator; Not, Negate);
unit_enum!(expression::BinaryOperator, BinaryOperator; Equal, NotEqual, Less, LessOrEqual, Greater, GreaterOrEqual, Add, Subtract, Multiply, Divide, Contains);
unit_enum!(expression::AggregateOperator, AggregateOperator; Count, Sum, Minimum, Maximum, Average, Any, All);
tagged!(expression::TimeWindow, TimeWindow; units []; single [Fixed { interval }]; records [Sliding { width, timestamp_property } => SlidingWindow]);
impl Wire for expression::ExpressionIr {
    type Output = w::Expression;
    fn lower(self) -> Result<Self::Output, WasmError> {
        component::ExpressionArena::from_expression(&self)?.lower()
    }
    fn lift(value: Self::Output) -> Result<Self, WasmError> {
        Ok(component::ExpressionArena::lift(value)?.into_expression()?)
    }
}
record!(component::ExpressionArena, Expression; nodes, root);
impl Wire for component::ExpressionNode {
    type Output = w::ExpressionNode;
    fn lower(self) -> Result<Self::Output, WasmError> {
        use component::ExpressionNode as D;
        use w::ExpressionNode as W;
        Ok(match self {
            D::Literal { value } => W::Literal(value.lower()?),
            D::Parameter { id } => W::Parameter(id.lower()?),
            D::Field { subject, property } => W::Field(w::FieldExpression {
                subject: subject.lower()?,
                property: property.lower()?,
            }),
            D::Role { relation, role } => W::Role(w::RoleExpression {
                relation: relation.lower()?,
                role: role.lower()?,
            }),
            D::Unary { operator, operand } => W::Unary(w::UnaryExpression {
                operator: operator.lower()?,
                operand,
            }),
            D::Binary {
                operator,
                left,
                right,
            } => W::Binary(w::BinaryExpression {
                operator: operator.lower()?,
                left,
                right,
            }),
            D::All { terms } => W::All(terms),
            D::Any { terms } => W::Any(terms),
            D::If {
                condition,
                then_value,
                else_value,
            } => W::Conditional(w::ConditionalExpression {
                condition,
                then_value,
                else_value,
            }),
            D::Call {
                function,
                arguments,
            } => W::Call(w::CallExpression {
                function: function.lower()?,
                arguments,
            }),
            D::Aggregate {
                operator,
                collection,
                expression,
                window,
            } => W::Aggregate(w::AggregateExpression {
                operator: operator.lower()?,
                collection: collection.lower()?,
                expression,
                window: window.lower()?,
            }),
            D::IsNull { operand } => W::IsNull(operand),
            D::IsKnown { operand } => W::IsKnown(operand),
        })
    }
    fn lift(value: Self::Output) -> Result<Self, WasmError> {
        use component::ExpressionNode as D;
        use w::ExpressionNode as W;
        Ok(match value {
            W::Literal(value) => D::Literal {
                value: Wire::lift(value)?,
            },
            W::Parameter(id) => D::Parameter {
                id: Wire::lift(id)?,
            },
            W::Field(value) => D::Field {
                subject: Wire::lift(value.subject)?,
                property: Wire::lift(value.property)?,
            },
            W::Role(value) => D::Role {
                relation: Wire::lift(value.relation)?,
                role: Wire::lift(value.role)?,
            },
            W::Unary(value) => D::Unary {
                operator: Wire::lift(value.operator)?,
                operand: value.operand,
            },
            W::Binary(value) => D::Binary {
                operator: Wire::lift(value.operator)?,
                left: value.left,
                right: value.right,
            },
            W::All(terms) => D::All { terms },
            W::Any(terms) => D::Any { terms },
            W::Conditional(value) => D::If {
                condition: value.condition,
                then_value: value.then_value,
                else_value: value.else_value,
            },
            W::Call(value) => D::Call {
                function: Wire::lift(value.function)?,
                arguments: value.arguments,
            },
            W::Aggregate(value) => D::Aggregate {
                operator: Wire::lift(value.operator)?,
                collection: Wire::lift(value.collection)?,
                expression: value.expression,
                window: Wire::lift(value.window)?,
            },
            W::IsNull(operand) => D::IsNull { operand },
            W::IsKnown(operand) => D::IsKnown { operand },
        })
    }
}
tagged!(ResourceRef, ResourceRef; units []; single [Object { id }, Relation { id }, Definition { id }, Assertion { id }, Evidence { id }, Support { id }, Watch { id }, Head { channel }, State { id }, Binding { id }, Operation { id }, Source { id }, Package { id }, ChangeSet { id }, Branch { id }, Task { id }, Case { id }, TestCase { id }, Suite { id }, Evaluation { id }]; records []);
tagged!(auth::AuthorizationFailure, AuthorizationFailure;
    units [InvalidPrincipal, InvalidDelegation, InsufficientScope, Revoked, AudienceMismatch, RequestDigestMismatch, DeadlineExpired, Replay, ApprovalMissing, ApprovalExpired, ApprovalDigestMismatch, ObligationUnsatisfied, InternalFault];
    single [RequiredPolicyUnavailable { policy_id }, PolicyContractMismatch { contract_id }];
    records [EpochChanged { policy_epoch, grant_epoch } => EpochChanged]
);
unit_enum!(commit::InstallationFailure, InstallationFailure; UnsupportedVersion, ExtensionUnavailable, PermissionDenied, SchemaMismatch, StorageIdentityMismatch);
unit_enum!(commit::ConstraintCode, ConstraintCode; DatabaseConstraint, IdentityAlias, ImmutableRevision, IdempotencyPayload, SupportCycle, HeadGeneration, StateEpoch, ForeignReference, ScopeOverlap);
tagged!(commit::CommitFailure, CommitFailure;
    units [NotConfigured, Closed, Connection, PoolTimeout, StatementTimeout, SerializationConflict, Deadlock, RollbackFailed, InvalidBatch, RolledBack, InternalFault];
    single [Installation { reason }, CommitIdPayloadConflict { commit_id }, ReadDependencyChanged { resource }, ConstraintConflict { constraint }, CommitIndeterminate { commit_id }, TransferIndeterminate { transfer_id }];
    records [RevisionConflict { resource, expected, actual } => ResourceRevisionConflict, Fenced { expected, actual } => RevisionConflict]
);
unit_enum!(sources::SourcePlanReason, SourcePlanReason; Empty, UnknownResource, UnknownField, FieldNotReadable, FieldNotWritable, InvalidKey, InvalidIdentifier, InvalidEndpoint, UnsupportedPredicate, UnsupportedOrdering, UnsupportedHistory, UnsupportedLimit, InvalidValue, CapabilityNotDeclared);
unit_enum!(sources::SourceCapability, SourceCapability; SchemaDiscovery, Snapshot, History, ChangeStream, ConditionalWrite, Idempotency, InspectEffect, Filter, Sort, Aggregate);
impl Wire for sources::SourceFailure {
    type Output = w::SourceFailure;
    fn lower(self) -> Result<Self::Output, WasmError> {
        component::SourceFailureArena::from_failure(&self)?.lower()
    }
    fn lift(value: Self::Output) -> Result<Self, WasmError> {
        Ok(component::SourceFailureArena::lift(value)?.into_failure()?)
    }
}
record!(component::SourceFailureArena, SourceFailure; nodes, root);
tagged!(component::SourceFailureNode, SourceFailureNode; units []; single [Leaf { failure }, PluginInvocation { failure }, Host { failure }, Operation { failure }, Slot { failure }, Query { failure }, Action { failure }, Release { failure }]; records [Cleanup { primary, code } => SourceCleanup, ReleaseBackfill { release_id, partition, failure } => SourceReleaseBackfill]);
unit_enum!(budget::BudgetDimension, BudgetDimension; WallTime, Steps, SourceReads, Rows, Bytes, ModelCalls, InputTokens, OutputTokens, Cost, Deadline);
tagged!(component::SourceFailureLeaf, SourceFailureLeaf;
    units [ConcurrentCallLimit, ResponseLimit, Authentication, PermissionDenied, Connection, ConnectTimeout, ReadTimeout, ServiceUnavailable, HistoryUnavailable, PositionExpired, PositionIncomparable, IncompleteTransaction, ReaderNotStopped, AckChannelNotStopped, ProtocolViolation, Cancelled, InternalFault];
    single [Authorization { failure }, Commit { failure }, Binding { failure }, Compile { failure }, Mapping { failure }, Release { failure }, Lifecycle { failure }, Package { failure }, BudgetExceeded { dimension }, ConnectionMissing { connection_id }, SqlState { code }, ResponseInvalid { field }, EffectIndeterminate { intent_id }, Credential { reason }, RateLimited { retry_after }, UnsupportedField { field }, CapabilityMissing { capability }, CheckpointIncompatible { format }, Gap { reason }, UpstreamUnrecognized { safe_code }];
    records [InvalidPlan { field, reason } => InvalidPlan, RevisionConflict { expected, actual } => RevisionConflict, SchemaDrift { expected, actual } => DigestMismatch, EpochStale { expected, actual } => RevisionConflict]
);
unit_enum!(sources::SourceCredentialReason, SourceCredentialReason; Missing, ResolverUnavailable, ResolverAuthentication, DecryptFailed, Invalid, StoreUnavailable);
record!(sources::ContractRef, ContractRef; id, version, schema_digest);
tagged!(world_protocol::bindings::BindingFailure, BindingFailure;
    units [HeadInvalid, LockIdentityConflict, InvalidRoots, DigestMismatch, InternalFault]; single [];
    records [
        LockRetiring { activation_lock_id } => BindingFailureLockRetiring,
        RetainedReferences { activation_lock_id } => BindingFailureRetainedReferences,
        MissingActivationLock { activation_lock_id } => BindingFailureMissingActivationLock,
        PackageUnavailable { node_id, install_id } => BindingFailurePackageUnavailable,
        Quarantined { node_id } => BindingFailureQuarantined,
        ConfigurationChanged { node_id } => BindingFailureConfigurationChanged,
        DuplicatePort { node_id, port } => BindingFailureDuplicatePort,
        AmbiguousProvider { consumer, port, providers } => BindingFailureAmbiguousProvider,
        InvalidChannels { binding_id } => BindingFailureInvalidChannels,
        DuplicateNode { node_id } => BindingFailureDuplicateNode,
        MissingNode { node_id } => BindingFailureMissingNode,
        MissingRequiredProvider { consumer, contract } => BindingFailureMissingRequiredProvider,
        MissingPort { node_id, port } => BindingFailureMissingPort,
        ContractMismatch { consumer, provider, contract } => BindingFailureContractMismatch,
        SchemaMismatch { consumer, provider } => BindingFailureSchemaMismatch,
        DependencyCycle { nodes } => BindingFailureDependencyCycle,
        DataflowCycle { nodes } => BindingFailureDataflowCycle,
        InvalidComposition { binding_id } => BindingFailureInvalidComposition,
        CompositionUnsupportedMerge { slot, policy } => BindingFailureCompositionUnsupportedMerge,
        CompositionMergeConflict { nodes } => BindingFailureCompositionMergeConflict,
        CompositionIncomplete { nodes } => BindingFailureCompositionIncomplete,
        CompositionBlocked { dependencies } => BindingFailureCompositionBlocked,
        MergePolicyRequired { binding_id } => BindingFailureMergePolicyRequired,
        TrustBoundary { node_id } => BindingFailureTrustBoundary,
        StateConflict { node_id } => BindingFailureStateConflict,
        HeadConflict { expected, actual } => BindingFailureHeadConflict,
        PublicationConflict { reason } => BindingFailurePublicationConflict,
        Commit { failure } => BindingFailureCommit
    ]
);
