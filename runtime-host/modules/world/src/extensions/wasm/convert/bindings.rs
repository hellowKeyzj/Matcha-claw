use super::*;

unit_enum!(world_protocol::bindings::SlotKind, SlotKind; Connector, Identity, Schema, Resolver, Projection, Provenance, Compiler, Policy, Action, Reconcile, Abstraction, Evaluation, Context, AgentBridge, Storage);
unit_enum!(world_protocol::bindings::PortDirection, PortDirection; Import, Export);
record!(world_protocol::bindings::MethodPort, MethodPort; name, contract, request_schema, result_schema, direction, required);
record!(world_protocol::bindings::StateBinding, StateBinding; namespace, root, schema, writer_domain, writer_epoch, migration);
unit_enum!(world_protocol::bindings::TrustClass, TrustClass; OrdinaryGuest, TrustedNative, TrustedProcess, PrivateRoot);
record!(world_protocol::bindings::BindingNode, BindingNode; id, provider_id, binding_id, slot, implementation, ports, required, state, trust);
record!(world_protocol::bindings::BindingEdge, BindingEdge; consumer, consumer_port, provider, provider_port, contract, required);
unit_enum!(world_protocol::bindings::CompositionMode, CompositionMode; Single, Ordered, Chain, TypedDag, FanOut);
unit_enum!(world_protocol::bindings::DataflowProjection, DataflowProjection; CompilerIr);
record!(world_protocol::bindings::DataflowEdge, DataflowEdge; projection, output_node, output_port, input_node, input_port, schema_digest);
unit_enum!(world_protocol::bindings::MergePolicy, MergePolicy; None, OrderedConcatenation, DisjointFields, RequireEqual, ExplicitConflict, MandatoryAndDenyOverrides);
unit_enum!(world_protocol::bindings::CompositionFailurePolicy, CompositionFailurePolicy; FailClosed, CollectIndependent);
record!(world_protocol::bindings::Composition, Composition; binding_id, nodes, mode, order, wiring, merge, failure);
record!(world_protocol::bindings::ActivationLock, ActivationLock; world, id, digest, nodes, edges, compositions, roots, trusted_roots);

variant!(world_protocol::bindings::Entrypoint, Entrypoint; units []; tuples []; records [Builtin { registration, revision } => EntrypointBuiltin, Native { registration, host_build } => EntrypointNative, Wasm { world, interface } => EntrypointWasm, Process { executable, protocol } => EntrypointProcess]);
record!(world_protocol::bindings::ImplementationRef, ImplementationRef; install_id, package_digest, artifact_id, artifact_digest, entrypoint, contracts, config_digest, dependency_lock, checkpoint_format);
unit_enum!(world_protocol::bindings::PublicationConflictReason, PublicationConflictReason; EmptyScope, ResolutionMismatch, RollbackUnproven);
