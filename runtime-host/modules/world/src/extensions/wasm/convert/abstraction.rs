use super::*;

unit_enum!(world_protocol::abstraction::Assurance, Assurance; Heuristic, Tested, Guarded, Verified);
record!(world_protocol::abstraction::AbstractionRequest, AbstractionRequest; world, task, definitions, assurance, budget);
unit_enum!(world_protocol::abstraction::SlotRole, SlotRole; Input, Output, Object, Relation, Action, State);
record!(world_protocol::abstraction::AbstractionSlot, AbstractionSlot; id, value_type, role, cardinality);
variant!(world_protocol::abstraction::BindingTarget, BindingTarget; units []; tuples []; records [Object { id } => BindingTargetObject, Relation { id } => BindingTargetRelation, Property { definition } => BindingTargetProperty, Action { definition } => BindingTargetAction, State { reference } => BindingTargetState, Expression { expression } => BindingTargetExpression]);
record!(world_protocol::abstraction::ConcreteBinding, ConcreteBinding; slot_id, parameter_id, target, transform, inverse_transform, inverse_scope, guard, dependencies, evidence);
record!(world_protocol::abstraction::BindingMap, BindingMap; bindings);
variant!(world_protocol::abstraction::Fallback, Fallback; units [Stop]; tuples []; records [ExpandConcrete { concrete_strategy } => FallbackExpandConcrete, RequestEvidence { evidence } => FallbackRequestEvidence]);
record!(world_protocol::abstraction::AbstractionContract, AbstractionContract; world, id, revision, candidate_id, branch, strategy, task_id, task_revision, base_release, scope, applicable_actions, original_definitions, forward_plan, preserved_invariants, parameters, slots, binding_map, guard, assurance, assumptions, evaluation_ids, fallback, read_dependencies);
record!(world_protocol::abstraction::WorldView, WorldView; world, task_id, task_revision, scope, goal, hard_constraints, allowed_effects, stop_conditions, labels, rows, objects, relations, definitions, actions, abstractions, read_receipts, truncation, untrusted_material);
variant!(world_protocol::abstraction::AbstractionFailure, AbstractionFailure; units [GuardFalse, GuardUnknown, EvidenceMissing, BasisChanged, BudgetExceeded, Cancelled, InternalFault]; tuples []; records [SlotUnbound { slot_id } => AbstractionFailureSlotUnbound, DuplicateBinding { slot_id } => AbstractionFailureDuplicateBinding, TypeMismatch { slot_id } => AbstractionFailureTypeMismatch, AssuranceUnsupported { requested } => AbstractionFailureAssuranceUnsupported]);
unit_enum!(world_protocol::abstraction::ContextFailure, ContextFailure; InvalidTask, BudgetExceeded, QueryUnavailable, AuthorizationDenied, BasisChanged, Cancelled, InternalFault);
