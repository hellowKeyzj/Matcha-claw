use super::*;

record!(world_protocol::definitions::Scope, Scope; world, id, predicate);
record!(world_protocol::definitions::ExtensionDefinition, ExtensionDefinition; name, contract, payload);
record!(world_protocol::definitions::KindRequest, KindRequest; kind, definition, previous, definitions, scopes, operation);
record!(world_protocol::definitions::KindResponse, KindResponse; contract, result);
unit_enum!(world_protocol::definitions::KindVerb, KindVerb; Create, Refine, Deprecate, Split);
impl Wire for world_protocol::definitions::KindOperation {
    type Output = w::KindOperation;
    fn lower(self) -> Result<<Self as Wire>::Output, WasmError> {
        use w::KindOperation as W;
        Ok(match self {
            Self::Validate => W::Validate,
            Self::Lower => W::LowerStandard,
            Self::Index => W::Index,
            Self::Migrate => W::Migrate,
            Self::Reducer { verb } => W::Reducer(w::KindOperationReducer { verb: verb.lower()? }),
            Self::Lifecycle => W::Lifecycle,
        })
    }
    fn lift(value: <Self as Wire>::Output) -> Result<Self, WasmError> {
        use w::KindOperation as W;
        Ok(match value {
            W::Validate => Self::Validate,
            W::LowerStandard => Self::Lower,
            W::Index => Self::Index,
            W::Migrate => Self::Migrate,
            W::Reducer(value) => Self::Reducer { verb: Wire::lift(value.verb)? },
            W::Lifecycle => Self::Lifecycle,
        })
    }
}
tagged!(world_protocol::definitions::KindResult, KindResult; units [Validated, LifecycleChecked]; single []; records [Lowered { body } => KindResultLowered, Indexed { dependencies } => KindResultIndexed, Migrated { definition } => KindResultMigrated, Reduced { definition } => KindResultReduced]);

record!(world_protocol::definitions::Cardinality, Cardinality; minimum, maximum);
record!(world_protocol::definitions::RoleDefinition, RoleDefinition; id, name, target_type, cardinality);
record!(world_protocol::definitions::RelationType, RelationType; name, roles, properties);
variant!(world_protocol::definitions::DefinitionLifecycle, DefinitionLifecycle; units [Available]; tuples []; records [Deprecated { replacements, reason, effective_at } => DefinitionLifecycleDeprecated, Split { replacements, effective_at } => DefinitionLifecycleSplit]);
record!(world_protocol::definitions::Definition<world_protocol::definitions::RelationType>, DefinitionRelationType; reference, scope, valid_time, body, content_digest, dependencies, evidence, previous_ref, lifecycle);
record!(world_protocol::definitions::Definition<world_protocol::sources::SourceBinding>, DefinitionSourceBinding; reference, scope, valid_time, body, content_digest, dependencies, evidence, previous_ref, lifecycle);
record!(world_protocol::definitions::Property, Property; name, domain, value_type, cardinality, nullable, access_labels);
record!(world_protocol::definitions::Definition<world_protocol::definitions::Property>, DefinitionProperty; reference, scope, valid_time, body, content_digest, dependencies, evidence, previous_ref, lifecycle);
record!(world_protocol::definitions::ObjectType, ObjectType; name, identity_rule, properties, interfaces, state_model, source_bindings);
record!(world_protocol::definitions::Facet, Facet; name, attaches_to, applicability, definitions);
record!(world_protocol::definitions::ConceptView, ConceptView; name, inputs, query);
record!(world_protocol::definitions::RuleRoleTemplate, RuleRoleTemplate; role, object);
variant!(world_protocol::definitions::RuleConclusion, RuleConclusion; units []; tuples []; records [Attribute { subject, property, value, polarity } => RuleConclusionAttribute, Relation { relation, relation_type, roles, polarity } => RuleConclusionRelation]);
record!(world_protocol::definitions::Rule, Rule; name, parameters, condition, conclusion, effects);
record!(world_protocol::definitions::Metric, Metric; name, parameters, expression, result_type, unit, grain, window);
record!(world_protocol::definitions::Function, Function; name, parameters, result_type, expression, effects, max_evaluations);
record!(world_protocol::definitions::StateDefinition, StateDefinition; id, name, terminal);
record!(world_protocol::definitions::StateTransition, StateTransition; from, to, guard, source_constraint, action);
record!(world_protocol::definitions::StateModel, StateModel; name, property, states, transitions);
variant!(world_protocol::definitions::DefinitionBody, DefinitionBody; units []; tuples [ObjectType, Property, RelationType, Facet, ConceptView, Rule, Metric, Function, StateModel, ActionContract, Strategy, PolicyBinding, SourceBinding, Extension]; records []);
record!(world_protocol::definitions::Definition<world_protocol::actions::ActionContract>, DefinitionActionContract; reference, scope, valid_time, body, content_digest, dependencies, evidence, previous_ref, lifecycle);
record!(world_protocol::definitions::Definition<world_protocol::definitions::DefinitionBody>, DefinitionDefinitionBody; reference, scope, valid_time, body, content_digest, dependencies, evidence, previous_ref, lifecycle);
unit_enum!(world_protocol::definitions::DefinitionKind, DefinitionKind; ObjectType, Property, RelationType, Facet, ConceptView, Rule, Metric, Function, StateModel, ActionContract, Strategy, PolicyBinding, SourceBinding, Extension);
unit_enum!(world_protocol::definitions::DefinitionFieldReason, DefinitionFieldReason; Empty, Duplicate, InvalidDate, InvalidTimeZone, InvalidCalendar, InvalidPrecision, InvalidScale, NullNotAllowed, TypeMismatch, InvalidCardinality, InvalidInterval, InvalidRole, InvalidState, InvalidTransition, ImpureExpression, IncompleteContract);
variant!(world_protocol::definitions::DefinitionFailure, DefinitionFailure; units [LifecycleConflict, InternalFault]; tuples []; records [Authorization { failure } => DefinitionFailureAuthorization, HeadConflict { definition_id, expected, actual, fields } => DefinitionFailureHeadConflict, MissingReference { reference } => DefinitionFailureMissingReference, RevisionConflict { expected, actual } => DefinitionFailureRevisionConflict, ScopeConflict { definitions } => DefinitionFailureScopeConflict, ValidTimeConflict { definitions } => DefinitionFailureValidTimeConflict, TypeMismatch { field } => DefinitionFailureTypeMismatch, UnitMismatch { field } => DefinitionFailureUnitMismatch, InvalidCardinality { field } => DefinitionFailureInvalidCardinality, DuplicateLocalId { field } => DefinitionFailureDuplicateLocalId, CyclicDependency { definitions } => DefinitionFailureCyclicDependency, UnknownKind { contract_id } => DefinitionFailureUnknownKind, ProviderMissing { contract_id } => DefinitionFailureProviderMissing, WrongKind { reference, expected, actual } => DefinitionFailureWrongKind, CrossWorldReference { reference } => DefinitionFailureCrossWorldReference, DeprecatedReference { reference } => DefinitionFailureDeprecatedReference, ImmutableRevision { reference } => DefinitionFailureImmutableRevision, KindContractIncomplete { contract_id } => DefinitionFailureKindContractIncomplete, InvalidField { field, reason } => DefinitionFailureInvalidField, MissingField { field } => DefinitionFailureMissingField, LimitExceeded { field, maximum } => DefinitionFailureLimitExceeded, Commit { failure } => DefinitionFailureCommit]);
