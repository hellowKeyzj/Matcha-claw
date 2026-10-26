use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

use crate::{abstraction::PreparedAbstraction, actions::PreparedAction, agent_bridge::PreparedAgentBridge, authorization::PreparedPolicy, compiler::{PreparedCompiler, PreparedSchema}, context::PreparedContext, evaluation::PreparedEvaluation, facts::support::PreparedProvenance, identity::PreparedIdentity, query::{PreparedProjection, PreparedReconcile, PreparedResolver}, sources::connectors::PreparedSource, store::PreparedStorage};
use world_protocol::{
    bindings::{BindingChannel, BindingFailure, ExactClosure},
    ids::{InvocationId, InvocationLeaseId, NodeId, ResourceToken},
    time::Timestamp,
};

use super::{AdmissionFailure, Registration, ResourceKind, ResourceLedger, ResourceSpec};
use crate::extensions::{
    bindings::{BindingGraph, GateAccess, GateFailure},
    lifecycle::Endpoint,
    process::ProcessClient,
    wasm::PreparedWasm,
};

#[derive(Debug)]
pub(crate) enum LeaseFailure {
    Binding(BindingFailure),
    Gate(GateFailure),
    MissingGeneration(NodeId),
    Admission(AdmissionFailure),
    ConcurrentCallLimit(NodeId),
}

impl LeaseFailure {
    pub(crate) fn host_failure(&self) -> world_protocol::process::HostFailure {
        use world_protocol::{
            lifecycle::LifecycleFailure, operation::OperationFailure, process::HostFailure,
        };
        let failure = match self {
            Self::Binding(reason) => return HostFailure::Binding(reason.clone()),
            Self::Gate(reason) => {
                return crate::extensions::bindings::BindingError::Gate(reason.clone())
                    .host_failure();
            }
            Self::MissingGeneration(node_id) => LifecycleFailure::DependencyMissing {
                node_id: node_id.clone(),
            },
            Self::Admission(AdmissionFailure::Closed | AdmissionFailure::ParentUnavailable(_)) => {
                LifecycleFailure::AcquisitionClosed
            }
            Self::Admission(
                AdmissionFailure::StillOpen
                | AdmissionFailure::DuplicateToken(_)
                | AdmissionFailure::DuplicateAcquisition(_)
                | AdmissionFailure::GenerationConflict(_),
            ) => LifecycleFailure::InvalidPersistedState,
            Self::ConcurrentCallLimit(node_id) => LifecycleFailure::ConcurrentCallLimit {
                node_id: node_id.clone(),
            },
        };
        HostFailure::Operation(OperationFailure::Lifecycle(failure))
    }
}

/// Live resource custody, not an authorization grant or a durable run identity.
/// All child calls resolve from this exact graph rather than the current head.
#[must_use = "finish the invocation after execution and all returned resources are registered"]
pub(crate) struct InvocationLease {
    id: InvocationLeaseId,
    invocation: InvocationId,
    graph: Arc<BindingGraph>,
    closure: ExactClosure,
    acquired_at: Timestamp,
    nodes: BTreeMap<NodeId, PinnedNode>,
    registrations: Mutex<Option<Vec<Registration>>>,
}

struct PinnedNode {
    ledger: ResourceLedger,
    token: ResourceToken,
    cancellation: CancellationToken,
    endpoint: Arc<Endpoint>,
    calls: Arc<Semaphore>,
}

impl InvocationLease {
    /// The caller selects the graph/ledgers inside this same gate closure. This
    /// method preflights the complete closure and registers all nodes or none.
    pub fn acquire(
        access: &GateAccess<'_>,
        graph: Arc<BindingGraph>,
        channels: &[BindingChannel],
        root: &NodeId,
        endpoints: &BTreeMap<NodeId, (ResourceLedger, Arc<Endpoint>, Arc<Semaphore>)>,
        invocation: InvocationId,
        acquired_at: Timestamp,
    ) -> Result<Self, LeaseFailure> {
        access
            .require_lock_open(&graph.lock().world, &graph.lock().id)
            .map_err(LeaseFailure::Gate)?;
        let closure = graph
            .exact_closure(root, channels)
            .map_err(LeaseFailure::Binding)?;
        access
            .require_open(
                &graph.lock().world,
                &closure.affected_heads,
                &closure.affected_domains,
            )
            .map_err(LeaseFailure::Gate)?;
        let mut selected = Vec::with_capacity(closure.nodes.len());
        for node in &closure.nodes {
            let (ledger, _, _) = endpoints
                .get(node)
                .ok_or_else(|| LeaseFailure::MissingGeneration(node.clone()))?;
            selected.push((
                ledger.clone(),
                ResourceSpec {
                    token: ResourceToken::try_new(uuid::Uuid::new_v4().to_string())
                        .expect("UUID resource token"),
                    kind: ResourceKind::Invocation,
                    parent: None,
                    invocation: Some(invocation.clone()),
                },
            ));
        }
        let registrations =
            ResourceLedger::register_batch(&selected).map_err(LeaseFailure::Admission)?;
        let nodes = closure
            .nodes
            .iter()
            .cloned()
            .zip(selected.into_iter().zip(&registrations))
            .map(|(id, ((ledger, _), registration))| {
                let endpoint = endpoints[&id].1.clone();
                let calls = endpoints[&id].2.clone();
                (
                    id,
                    PinnedNode {
                        ledger,
                        token: registration.token().clone(),
                        cancellation: registration.cancellation().clone(),
                        endpoint,
                        calls,
                    },
                )
            })
            .collect();
        Ok(Self {
            id: InvocationLeaseId::try_new(uuid::Uuid::new_v4().to_string())
                .expect("UUID lease identifier"),
            invocation,
            graph,
            closure,
            acquired_at,
            nodes,
            registrations: Mutex::new(Some(registrations)),
        })
    }

    pub fn id(&self) -> &InvocationLeaseId {
        &self.id
    }
    pub fn invocation(&self) -> &InvocationId {
        &self.invocation
    }
    pub fn graph(&self) -> &Arc<BindingGraph> {
        &self.graph
    }
    pub fn closure(&self) -> &ExactClosure {
        &self.closure
    }
    pub fn acquired_at(&self) -> &Timestamp {
        &self.acquired_at
    }

    pub fn ledger(&self, node: &NodeId) -> Option<&ResourceLedger> {
        self.nodes.get(node).map(|node| &node.ledger)
    }

    pub fn cancellation(&self, node: &NodeId) -> Option<&CancellationToken> {
        self.nodes.get(node).map(|node| &node.cancellation)
    }

    pub fn resource_spec(&self, node: &NodeId, kind: ResourceKind) -> Option<ResourceSpec> {
        self.nodes.get(node).map(|node| ResourceSpec {
            token: ResourceToken::try_new(uuid::Uuid::new_v4().to_string())
                .expect("UUID resource token"),
            kind,
            parent: Some(node.token.clone()),
            invocation: Some(self.invocation.clone()),
        })
    }

    pub fn wasm(&self, node: &NodeId) -> Option<&Arc<PreparedWasm>> {
        match self.nodes.get(node)?.endpoint.as_ref() {
            Endpoint::Wasm(prepared) => Some(prepared),
            _ => None,
        }
    }

    pub fn process(&self, node: &NodeId) -> Option<&ProcessClient> {
        match self.nodes.get(node)?.endpoint.as_ref() {
            Endpoint::Process(client) => Some(client),
            _ => None,
        }
    }

    pub fn identity(&self, node: &NodeId) -> Option<&Arc<PreparedIdentity>> {
        match self.nodes.get(node)?.endpoint.as_ref() {
            Endpoint::Identity(prepared) => Some(prepared),
            _ => None,
        }
    }

    pub fn source(&self, node: &NodeId) -> Option<&Arc<PreparedSource>> {
        match self.nodes.get(node)?.endpoint.as_ref() {
            Endpoint::Source(prepared) => Some(prepared),
            _ => None,
        }
    }

    pub fn schema(&self, node: &NodeId) -> Option<&Arc<PreparedSchema>> {
        match self.nodes.get(node)?.endpoint.as_ref() {
            Endpoint::Schema(prepared) => Some(prepared),
            _ => None,
        }
    }

    pub fn compiler(&self, node: &NodeId) -> Option<&Arc<PreparedCompiler>> {
        match self.nodes.get(node)?.endpoint.as_ref() {
            Endpoint::Compiler(prepared) => Some(prepared),
            _ => None,
        }
    }

    pub fn policy(&self, node: &NodeId) -> Option<&Arc<PreparedPolicy>> {
        match self.nodes.get(node)?.endpoint.as_ref() {
            Endpoint::Policy(prepared) => Some(prepared),
            _ => None,
        }
    }

    pub fn provenance(&self, node: &NodeId) -> Option<&Arc<PreparedProvenance>> {
        match self.nodes.get(node)?.endpoint.as_ref() {
            Endpoint::Provenance(prepared) => Some(prepared),
            _ => None,
        }
    }

    pub fn action(&self, node: &NodeId) -> Option<&Arc<PreparedAction>> {
        match self.nodes.get(node)?.endpoint.as_ref() {
            Endpoint::Action(prepared) => Some(prepared),
            _ => None,
        }
    }

    pub fn evaluation(&self, node: &NodeId) -> Option<&Arc<PreparedEvaluation>> {
        match self.nodes.get(node)?.endpoint.as_ref() {
            Endpoint::Evaluation(prepared) => Some(prepared),
            _ => None,
        }
    }

    pub fn projection(&self, node: &NodeId) -> Option<&Arc<PreparedProjection>> {
        match self.nodes.get(node)?.endpoint.as_ref() {
            Endpoint::Projection(prepared) => Some(prepared),
            _ => None,
        }
    }

    pub fn reconcile(&self, node: &NodeId) -> Option<&Arc<PreparedReconcile>> {
        match self.nodes.get(node)?.endpoint.as_ref() {
            Endpoint::Reconcile(prepared) => Some(prepared),
            _ => None,
        }
    }

    pub fn abstraction(&self, node: &NodeId) -> Option<&Arc<PreparedAbstraction>> {
        match self.nodes.get(node)?.endpoint.as_ref() {
            Endpoint::Abstraction(prepared) => Some(prepared),
            _ => None,
        }
    }

    pub fn agent_bridge(&self, node: &NodeId) -> Option<&Arc<PreparedAgentBridge>> {
        match self.nodes.get(node)?.endpoint.as_ref() {
            Endpoint::AgentBridge(prepared) => Some(prepared),
            _ => None,
        }
    }

    pub fn storage(&self, node: &NodeId) -> Option<&Arc<PreparedStorage>> {
        match self.nodes.get(node)?.endpoint.as_ref() {
            Endpoint::Storage(prepared) => Some(prepared),
            _ => None,
        }
    }

    pub fn resolver(&self, node: &NodeId) -> Option<&Arc<PreparedResolver>> {
        match self.nodes.get(node)?.endpoint.as_ref() {
            Endpoint::Resolver(prepared) => Some(prepared),
            _ => None,
        }
    }

    pub fn context(&self, node: &NodeId) -> Option<&Arc<PreparedContext>> {
        match self.nodes.get(node)?.endpoint.as_ref() {
            Endpoint::Context(prepared) => Some(prepared),
            _ => None,
        }
    }

    pub fn limits(&self, node: &NodeId) -> Option<&world_protocol::package::PackageLimits> {
        self.nodes.get(node).map(|node| node.endpoint.limits())
    }

    /// The adapter keeps this permit in its checked resource until actual execution
    /// and cleanup finish. Dropping only the call future must not release it.
    pub fn try_call(&self, node: &NodeId) -> Result<OwnedSemaphorePermit, LeaseFailure> {
        let pinned = self
            .nodes
            .get(node)
            .ok_or_else(|| LeaseFailure::MissingGeneration(node.clone()))?;
        if pinned.cancellation.is_cancelled() {
            return Err(LeaseFailure::Admission(AdmissionFailure::Closed));
        }
        pinned
            .calls
            .clone()
            .try_acquire_owned()
            .map_err(|_| LeaseFailure::ConcurrentCallLimit(node.clone()))
    }

    /// Select an already pinned provider edge. Never consult inventory/latest.
    pub fn provider(&self, consumer: &NodeId, port: &str) -> Option<&NodeId> {
        self.closure
            .edges
            .iter()
            .find(|edge| &edge.consumer == consumer && edge.consumer_port == port)
            .map(|edge| &edge.provider)
    }

    /// Pending stream/body/I/O/child resources keep their invocation entry alive.
    /// Dropping a lease instead leaves an explicit uncompleted entry, never success.
    pub fn finish(&self) {
        let registrations = self
            .registrations
            .lock()
            .expect("world invocation custody poisoned")
            .take();
        if let Some(registrations) = registrations {
            for registration in registrations {
                registration.finish();
            }
        }
    }
}
