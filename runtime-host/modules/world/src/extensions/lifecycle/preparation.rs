use std::{sync::Arc, time::Duration};

use foundation::{execution::OwnedTask, process::ProcessContainment};
use platform::state_dir::CanonicalStateDir;
use tokio::{sync::oneshot, time::Instant};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    api::PackageConfigView,
    bindings::{BindingNode, Entrypoint, SlotKind},
    ids::{AcquisitionId, ActivationLockId, CommitId, ResourceToken, WorldRef},
    lifecycle::LifecycleFailure,
    time::Timestamp,
};

use super::{LifecycleError, LiveExtensions, PreparedGraph, PreparedNode, RecoveryInventory};
use crate::{
    abstraction::PreparedAbstraction,
    actions::PreparedAction,
    agent_bridge::PreparedAgentBridge,
    authorization::PreparedPolicy,
    facts::support::PreparedProvenance,
    extensions::{
        bindings::{BindingGraph, PublicationGate},
        invocation::{DrainOutcome, ResourceKind, ResourceLedger, ResourceSpec, TaskResource},
        package::Inventory,
        process::{self, ProcessLaunch},
        wasm::{ExecutionPolicy, PreparedWasm},
    },
    compiler::{PreparedCompiler, PreparedSchema},
    context::PreparedContext,
    evaluation::PreparedEvaluation,
    identity::PreparedIdentity,
    query::{PreparedProjection, PreparedReconcile, PreparedResolver},
    sources::connectors::PreparedSource,
    store::PreparedStorage,
};

/// Trusted composition inputs; package authority is read from PostgreSQL at preparation time.
#[derive(Clone)]
pub struct PreparationPorts {
    engine: Arc<wasm_host::EngineResources>,
    artifact_limit: usize,
    containment: ProcessContainment,
    process_directory: CanonicalStateDir,
    execution_policy: ExecutionPolicy,
}

impl PreparationPorts {
    pub fn new(
        engine_limits: wasm_host::EngineLimits,
        epoch_interval: Duration,
        artifact_limit: usize,
        containment: ProcessContainment,
        process_directory: CanonicalStateDir,
        execution_limits: wasm_host::ExecutionLimits,
        host_io_timeout: Duration,
        cleanup_timeout: Duration,
    ) -> Self {
        Self {
            engine: Arc::new(wasm_host::EngineResources::new(engine_limits, epoch_interval)),
            artifact_limit,
            containment,
            process_directory,
            execution_policy: ExecutionPolicy {
                limits: execution_limits,
                host_io_timeout,
                cleanup_timeout,
            },
        }
    }

    pub(crate) fn engine_resources(&self) -> Arc<wasm_host::EngineResources> {
        self.engine.clone()
    }

    pub async fn shutdown(&self) -> Result<(), tokio::task::JoinError> {
        self.engine.shutdown().await
    }

    pub(crate) fn artifact_limit(&self) -> usize {
        self.artifact_limit
    }

    pub(crate) fn execution_policy(&self) -> ExecutionPolicy {
        self.execution_policy.clone()
    }

    pub(super) fn containment(&self) -> ProcessContainment { self.containment.clone() }
    pub(super) fn process_directory(&self) -> &CanonicalStateDir { &self.process_directory }
}

#[derive(Clone, Copy)]
pub(super) enum Preparation<'a> {
    Open,
    Reserved(&'a CommitId),
    Recovery(&'a super::RestoreRecovery),
    Transfer(&'a Arc<super::TransferHydration>),
    Restore {
        intent: &'a crate::store::WorldRestoreIntent<'a>,
        drained: &'a super::DrainedWorld,
    },
}

pub(crate) async fn prepare_graph(
    graph: Arc<BindingGraph>,
    channels: Vec<world_protocol::bindings::BindingChannel>,
    recovery: &RecoveryInventory,
    inventory: &Arc<Inventory>,
    live: &LiveExtensions,
    ports: &PreparationPorts,
    cancellation: &CancellationToken,
    deadline: Instant,
) -> Result<PreparedGraph, LifecycleError> {
    prepare(
        graph,
        channels,
        recovery,
        inventory,
        live,
        ports,
        cancellation,
        deadline,
        Preparation::Open,
    )
    .await
}

pub(crate) async fn prepare_graph_reserved(
    graph: Arc<BindingGraph>,
    channels: Vec<world_protocol::bindings::BindingChannel>,
    recovery: &RecoveryInventory,
    inventory: &Arc<Inventory>,
    live: &LiveExtensions,
    ports: &PreparationPorts,
    cancellation: &CancellationToken,
    deadline: Instant,
    commit: &CommitId,
) -> Result<PreparedGraph, LifecycleError> {
    prepare(
        graph,
        channels,
        recovery,
        inventory,
        live,
        ports,
        cancellation,
        deadline,
        Preparation::Reserved(commit),
    )
    .await
}

pub(crate) async fn prepare_graph_for_restore(
    graph: Arc<BindingGraph>,
    channels: Vec<world_protocol::bindings::BindingChannel>,
    recovery: &RecoveryInventory,
    inventory: &Arc<Inventory>,
    live: &LiveExtensions,
    ports: &PreparationPorts,
    cancellation: &CancellationToken,
    deadline: Instant,
    intent: &crate::store::WorldRestoreIntent<'_>,
    drained: &super::DrainedWorld,
) -> Result<PreparedGraph, LifecycleError> {
    prepare(
        graph,
        channels,
        recovery,
        inventory,
        live,
        ports,
        cancellation,
        deadline,
        Preparation::Restore { intent, drained },
    )
    .await
}

pub(crate) async fn prepare_graph_for_restore_recovery(
    graph: Arc<BindingGraph>,
    channels: Vec<world_protocol::bindings::BindingChannel>,
    recovery: &RecoveryInventory,
    inventory: &Arc<Inventory>,
    live: &LiveExtensions,
    ports: &PreparationPorts,
    cancellation: &CancellationToken,
    deadline: Instant,
    proof: &super::RestoreRecovery,
) -> Result<PreparedGraph, LifecycleError> {
    prepare(
        graph,
        channels,
        recovery,
        inventory,
        live,
        ports,
        cancellation,
        deadline,
        Preparation::Recovery(proof),
    )
    .await
}

pub(crate) async fn prepare_graph_for_transfer(
    graph: Arc<BindingGraph>,
    channels: Vec<world_protocol::bindings::BindingChannel>,
    recovery: &RecoveryInventory,
    inventory: &Arc<Inventory>,
    live: &LiveExtensions,
    ports: &PreparationPorts,
    cancellation: &CancellationToken,
    deadline: Instant,
    proof: &Arc<super::TransferHydration>,
) -> Result<PreparedGraph, LifecycleError> {
    prepare(
        graph,
        channels,
        recovery,
        inventory,
        live,
        ports,
        cancellation,
        deadline,
        Preparation::Transfer(proof),
    )
    .await
}

async fn prepare(
    graph: Arc<BindingGraph>,
    channels: Vec<world_protocol::bindings::BindingChannel>,
    recovery: &RecoveryInventory,
    inventory: &Arc<Inventory>,
    live: &LiveExtensions,
    ports: &PreparationPorts,
    cancellation: &CancellationToken,
    deadline: Instant,
    preparation: Preparation<'_>,
) -> Result<PreparedGraph, LifecycleError> {
    let lock = graph.lock().id.clone();
    let mut nodes = Vec::with_capacity(graph.lock().nodes.len());
    let mut guard = PrepareGuard {
        ledgers: Vec::new(),
        gate: live.gate().clone(),
        armed: true,
    };
    let result = async {
        for id in graph.prepare_order() {
            check_preparation(cancellation, deadline)?;
            if let Some(block) = recovery.blocked_node(&graph, id) {
                return Err(LifecycleError::RecoveryBlocked {
                    node: id.clone(),
                    reason: block,
                });
            }
        }
        for id in graph.prepare_order() {
            check_preparation(cancellation, deadline)?;
            let node = graph
                .node(id)
                .map_err(|_| LifecycleError::EndpointMismatch(id.clone()))?;
            trace_preparation(
                &lock,
                Some(node),
                "node_enter",
                None,
                deadline,
                cancellation,
            );
            let config = recovery.installs[&node.implementation.install_id]
                .config
                .clone()
                .ok_or_else(|| {
                    LifecycleError::MissingConfiguration(node.implementation.install_id.clone())
                })?;
            let ledger = live.new_generation_for(&graph, id, &channels, preparation)?;
            guard.ledgers.push(ledger.clone());
            let prepared = prepare_owned(
                node.clone(),
                config,
                graph.lock().world.clone(),
                graph.lock().id.clone(),
                inventory.clone(),
                ports.clone(),
                ledger,
                live.gate().clone(),
                cancellation.clone(),
                deadline,
            )
            .await
            .map_err(|cause| LifecycleError::PrepareNode {
                node: id.clone(),
                cause: Box::new(cause),
            })?;
            trace_preparation(
                &lock,
                Some(node),
                "node_joined",
                None,
                deadline,
                cancellation,
            );
            nodes.push(prepared);
        }
        check_preparation(cancellation, deadline)?;
        live.prepare_for(graph, channels, nodes, preparation)
    }
    .await;
    match result {
        Ok(prepared) => {
            trace_preparation(&lock, None, "graph_ready", None, deadline, cancellation);
            guard.armed = false;
            Ok(prepared)
        }
        Err(cause) => {
            trace_preparation(
                &lock,
                None,
                "before_drain",
                Some(&cause),
                deadline,
                cancellation,
            );
            guard.close();
            let cleanup_deadline = Instant::now() + ports.execution_policy.cleanup_timeout;
            let mut remaining_resources = Vec::new();
            for ledger in &guard.ledgers {
                if !matches!(
                    ledger.drain_until(cleanup_deadline).await,
                    Ok(DrainOutcome::Drained)
                ) {
                    remaining_resources.extend(super::retained_resources(&ledger.snapshot()));
                }
            }
            if remaining_resources.is_empty() {
                trace_preparation(&lock, None, "drained", Some(&cause), deadline, cancellation);
                guard.armed = false;
                Err(cause)
            } else {
                let failure = LifecycleError::Cleanup {
                    cause: Box::new(cause),
                    remaining_resources,
                };
                trace_preparation(
                    &lock,
                    None,
                    "retained",
                    Some(&failure),
                    deadline,
                    cancellation,
                );
                Err(failure)
            }
        }
    }
}

async fn prepare_owned(
    node: BindingNode,
    config: PackageConfigView,
    world: WorldRef,
    lock: ActivationLockId,
    inventory: Arc<Inventory>,
    ports: PreparationPorts,
    ledger: ResourceLedger,
    gate: PublicationGate,
    cancellation: CancellationToken,
    deadline: Instant,
) -> Result<PreparedNode, LifecycleError> {
    let ticket = ledger
        .begin_acquisition(
            AcquisitionId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID acquisition"),
            ResourceSpec {
                token: ResourceToken::try_new(uuid::Uuid::new_v4().to_string())
                    .expect("UUID token"),
                kind: ResourceKind::TaskJoin,
                parent: None,
                invocation: None,
            },
        )
        .map_err(|_| LifecycleError::Contract(LifecycleFailure::AcquisitionClosed))?;
    let resource_cancel = ticket.cancellation().clone();
    let guard = PrepareGuard {
        ledgers: vec![ledger.clone()],
        gate: gate.clone(),
        armed: true,
    };
    let (send, receive) = oneshot::channel();
    let external_cancel = cancellation.clone();
    let (task, _) = OwnedTask::spawn(move |task_cancel| async move {
        let work_cancel = CancellationToken::new();
        let work = prepare_node(
            node.clone(),
            config,
            world,
            lock.clone(),
            &inventory,
            &ports,
            ledger.clone(),
            &work_cancel,
            deadline,
        );
        tokio::pin!(work);
        let result = tokio::select! {
            biased;
            _ = external_cancel.cancelled() => {
                work_cancel.cancel();
                let _ = work.await;
                Err(LifecycleError::Cancelled)
            },
            _ = tokio::time::sleep_until(deadline) => {
                work_cancel.cancel();
                let _ = work.await;
                Err(LifecycleError::Deadline)
            },
            _ = task_cancel.cancelled() => {
                work_cancel.cancel();
                let _ = work.await;
                Err(LifecycleError::Cancelled)
            },
            _ = resource_cancel.cancelled() => {
                work_cancel.cancel();
                let _ = work.await;
                Err(LifecycleError::Cancelled)
            },
            result = &mut work => result.and_then(|prepared| {
                check_preparation(&external_cancel, deadline)?;
                Ok(prepared)
            }),
        };
        trace_preparation(
            &lock,
            Some(&node),
            "adapter_return",
            result.as_ref().err(),
            deadline,
            &work_cancel,
        );
        if send.send(result).is_err() {
            gate.synchronized(|_| ledger.close_admission());
            let _ = ledger.request_cancel();
        }
    });
    let acquired = ticket.complete(Box::new(TaskResource::new(task, |_| Ok(()))));
    let mut registration = acquired.registration;
    let prepared = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(LifecycleError::Cancelled),
        _ = tokio::time::sleep_until(deadline) => return Err(LifecycleError::Deadline),
        result = receive => result
            .map_err(|_| LifecycleError::Contract(LifecycleFailure::InternalFault))??,
    };
    check_preparation(&cancellation, deadline)?;
    let joined = registration.close_checked(deadline).await;
    if joined.is_err() {
        check_preparation(&cancellation, deadline)?;
        return Err(LifecycleError::Contract(LifecycleFailure::Retained {
            stage: world_protocol::lifecycle::LifecycleStage::Join,
            remaining_resources: super::retained_resources(&guard.ledgers[0].snapshot()),
        }));
    }
    check_preparation(&cancellation, deadline)?;
    let mut guard = guard;
    guard.armed = false;
    Ok(prepared)
}

async fn prepare_node(
    node: BindingNode,
    config: PackageConfigView,
    world: WorldRef,
    lock: ActivationLockId,
    inventory: &Inventory,
    ports: &PreparationPorts,
    ledger: ResourceLedger,
    cancellation: &CancellationToken,
    deadline: Instant,
) -> Result<PreparedNode, LifecycleError> {
    check_preparation(cancellation, deadline)?;
    let at = Timestamp::try_new(chrono::Utc::now().to_rfc3339())
        .map_err(|_| LifecycleError::InvalidPersistedState)?;
    let artifact = inventory
        .artifact(&world, &node.implementation, at, cancellation)
        .await
        .map_err(LifecycleError::Package)?;
    check_preparation(cancellation, deadline)?;
    trace_preparation(
        &lock,
        Some(&node),
        "adapter_enter",
        None,
        deadline,
        cancellation,
    );
    match &node.implementation.entrypoint {
        Entrypoint::Wasm { .. } => {
            let engine = ports.engine.clone();
            let implementation = node.implementation.clone();
            let artifact_limit = ports.artifact_limit;
            let cancellation = cancellation.clone();
            // The ledger-owned preparation task keeps this handle until the blocking
            // work really joins; cancelling preparation never detaches compilation.
            let prepared = tokio::task::spawn_blocking(move || {
                if cancellation.is_cancelled() {
                    return Err(crate::extensions::wasm::WasmError::Cancelled);
                }
                let engine = engine.prepare_engine().map_err(crate::extensions::wasm::WasmError::from)?;
                PreparedWasm::prepare(
                    engine,
                    implementation,
                    config,
                    artifact,
                    artifact_limit,
                    &cancellation,
                )
            })
            .await
            .map_err(LifecycleError::PreparationTask)?
            .map_err(LifecycleError::Wasm)?;
            Ok(PreparedNode::wasm(
                node.id.clone(),
                Arc::new(prepared),
                ledger,
            ))
        }
        Entrypoint::Process { .. } => {
            let _directory = ports.process_directory.open().map_err(|_| {
                LifecycleError::Process(Arc::new(process::ProcessError::InvalidLaunch))
            })?;
            let launch = ProcessLaunch {
                working_directory: ports.process_directory.as_path().to_path_buf(),
                arguments: Vec::new(),
                environment: Vec::new(),
                private_descriptor: None,
                require_sandbox: artifact
                    .artifact
                    .features
                    .iter()
                    .any(|feature| feature == world_protocol::package::REQUIRES_SANDBOX),
                artifact_limit: ports.artifact_limit,
            };
            let prepared = process::prepare(
                ports.containment.clone(),
                node.clone(),
                config,
                lock,
                artifact,
                launch,
                ports.execution_policy.host_io_timeout,
                &ledger,
                deadline,
            )
            .await
            .map_err(LifecycleError::Process)?;
            Ok(PreparedNode::process(node.id.clone(), prepared, ledger))
        }
        Entrypoint::Native { .. } => Err(LifecycleError::Native {
            node: node.id.clone(),
            cause: crate::extensions::invocation::NativePrepareFailure::Implementation,
        }),
        Entrypoint::Builtin { .. } => match node.slot {
            SlotKind::Connector => Ok(PreparedNode::source(
                node.id.clone(),
                Arc::new(
                    PreparedSource::prepare(&node, config, artifact)
                        .map_err(LifecycleError::Source)?,
                ),
                ledger,
            )),
            SlotKind::Identity => Ok(PreparedNode::identity(
                node.id.clone(),
                Arc::new(
                    PreparedIdentity::prepare(&node, config, artifact)
                        .map_err(|cause| LifecycleError::Native { node: node.id.clone(), cause })?,
                ),
                ledger,
            )),
            SlotKind::Schema => Ok(PreparedNode::schema(
                node.id.clone(),
                Arc::new(
                    PreparedSchema::prepare(&node, config, artifact)
                        .map_err(|cause| LifecycleError::Native { node: node.id.clone(), cause })?,
                ),
                ledger,
            )),
            SlotKind::Compiler => Ok(PreparedNode::compiler(
                node.id.clone(),
                Arc::new(
                    PreparedCompiler::prepare(&node, config, artifact)
                        .map_err(|cause| LifecycleError::Native { node: node.id.clone(), cause })?,
                ),
                ledger,
            )),
            SlotKind::Policy => Ok(PreparedNode::policy(
                node.id.clone(),
                Arc::new(
                    PreparedPolicy::prepare(&node, config, artifact)
                        .map_err(|cause| LifecycleError::Native { node: node.id.clone(), cause })?,
                ),
                ledger,
            )),
            SlotKind::Provenance => Ok(PreparedNode::provenance(
                node.id.clone(),
                Arc::new(
                    PreparedProvenance::prepare(&node, config, artifact)
                        .map_err(|cause| LifecycleError::Native { node: node.id.clone(), cause })?,
                ),
                ledger,
            )),
            SlotKind::Action => Ok(PreparedNode::action(
                node.id.clone(),
                Arc::new(
                    PreparedAction::prepare(&node, config, artifact)
                        .map_err(|cause| LifecycleError::Native { node: node.id.clone(), cause })?,
                ),
                ledger,
            )),
            SlotKind::Evaluation => Ok(PreparedNode::evaluation(
                node.id.clone(),
                Arc::new(
                    PreparedEvaluation::prepare(&node, config, artifact)
                        .map_err(|cause| LifecycleError::Native { node: node.id.clone(), cause })?,
                ),
                ledger,
            )),
            SlotKind::Projection => Ok(PreparedNode::projection(
                node.id.clone(),
                Arc::new(
                    PreparedProjection::prepare(&node, config, artifact)
                        .map_err(|cause| LifecycleError::Native { node: node.id.clone(), cause })?,
                ),
                ledger,
            )),
            SlotKind::Reconcile => Ok(PreparedNode::reconcile(
                node.id.clone(),
                Arc::new(
                    PreparedReconcile::prepare(&node, config, artifact)
                        .map_err(|cause| LifecycleError::Native { node: node.id.clone(), cause })?,
                ),
                ledger,
            )),
            SlotKind::Abstraction => Ok(PreparedNode::abstraction(
                node.id.clone(),
                Arc::new(
                    PreparedAbstraction::prepare(&node, config, artifact)
                        .map_err(|cause| LifecycleError::Native { node: node.id.clone(), cause })?,
                ),
                ledger,
            )),
            SlotKind::AgentBridge => Ok(PreparedNode::agent_bridge(
                node.id.clone(),
                Arc::new(
                    PreparedAgentBridge::prepare(&node, config, artifact)
                        .map_err(|cause| LifecycleError::Native { node: node.id.clone(), cause })?,
                ),
                ledger,
            )),
            SlotKind::Storage => Ok(PreparedNode::storage(
                node.id.clone(),
                Arc::new(
                    PreparedStorage::prepare(&node, config, artifact)
                        .map_err(|cause| LifecycleError::Native { node: node.id.clone(), cause })?,
                ),
                ledger,
            )),
            SlotKind::Resolver => Ok(PreparedNode::resolver(
                node.id.clone(),
                Arc::new(
                    PreparedResolver::prepare(&node, config, artifact)
                        .map_err(|cause| LifecycleError::Native { node: node.id.clone(), cause })?,
                ),
                ledger,
            )),
            SlotKind::Context => Ok(PreparedNode::context(
                node.id.clone(),
                Arc::new(
                    PreparedContext::prepare(&node, config, artifact)
                        .map_err(|cause| LifecycleError::Native { node: node.id.clone(), cause })?,
                ),
                ledger,
            )),
        },
    }
}

fn check_preparation(
    cancellation: &CancellationToken,
    deadline: Instant,
) -> Result<(), LifecycleError> {
    if cancellation.is_cancelled() {
        return Err(LifecycleError::Cancelled);
    }
    if Instant::now() >= deadline {
        return Err(LifecycleError::Deadline);
    }
    Ok(())
}

fn trace_preparation(
    lock: &ActivationLockId,
    node: Option<&BindingNode>,
    phase: &'static str,
    error: Option<&LifecycleError>,
    deadline: Instant,
    cancellation: &CancellationToken,
) {
    platform::trace::runtime_trace("world.extension.prepare", || {
        let mut original = error;
        let mut failed_node = node.map(|node| &node.id);
        let mut cleanup = false;
        let mut remaining = 0;
        while let Some(error) = original {
            match error {
                LifecycleError::PrepareNode { node, cause } => {
                    failed_node = Some(node);
                    original = Some(cause.as_ref());
                }
                LifecycleError::Cleanup {
                    cause,
                    remaining_resources,
                } => {
                    cleanup = true;
                    remaining += remaining_resources.len();
                    original = Some(cause.as_ref());
                }
                _ => break,
            }
        }
        cleanup |= matches!(original, Some(LifecycleError::Process(error))
            if matches!(error.as_ref(), process::ProcessError::Cleanup { .. }));
        let (kind, reason) = original
            .map(preparation_reason)
            .unwrap_or_else(|| ("none", "none".into()));
        let now = Instant::now();
        serde_json::json!({
            "phase": phase,
            "lockIdHash": platform::trace::identifier_hash(lock.as_str()),
            "nodeIdHash": failed_node.map(|id| platform::trace::identifier_hash(id.as_str())),
            "slot": node.map(|node| node.slot),
            "entrypoint": node.map(|node| match &node.implementation.entrypoint {
                Entrypoint::Native { .. } => "native",
                Entrypoint::Builtin { .. } => "builtin",
                Entrypoint::Wasm { .. } => "wasm",
                Entrypoint::Process { .. } => "process",
            }),
            "outcome": if error.is_some() { "error" } else { "ok" },
            "failureKind": kind,
            "reason": reason,
            "cleanup": cleanup,
            "remainingResourceCount": remaining,
            "cancelled": cancellation.is_cancelled(),
            "deadlineExpired": now >= deadline,
            "remainingMs": deadline.saturating_duration_since(now).as_millis() as u64,
        })
    });
}

fn preparation_reason(error: &LifecycleError) -> (&'static str, String) {
    let (kind, reason) = match error {
        LifecycleError::Cancelled => ("lifecycle", "cancelled"),
        LifecycleError::Deadline => ("lifecycle", "deadline"),
        LifecycleError::PreparationTask(_) => ("lifecycle", "task_join"),
        LifecycleError::Contract(reason) => return ("lifecycle", preparation_tag(reason)),
        LifecycleError::Package(error) => return ("package", preparation_tag(&error.reason)),
        LifecycleError::Source(error) => return ("source", preparation_tag(&error.failure)),
        LifecycleError::Process(error) => {
            let mut original = error.as_ref();
            while let process::ProcessError::Cleanup { cause, .. }
            | process::ProcessError::Call { cause, .. } = original
            {
                original = cause.as_ref();
            }
            let code = original.code();
            ("process", code.strip_prefix("process_").unwrap_or(code))
        }
        LifecycleError::Wasm(error) => {
            use crate::extensions::wasm::WasmError;
            (
                "wasm",
                match error {
                    WasmError::ArtifactMismatch => "artifact_mismatch",
                    WasmError::ConfigurationMismatch => "configuration_mismatch",
                    WasmError::EntrypointUnsupported => "entrypoint_unsupported",
                    WasmError::Cancelled => "cancelled",
                    WasmError::Package(error) => return ("wasm", preparation_tag(&error.reason)),
                    WasmError::Schema(_) => "schema",
                    WasmError::Execution(error) => match error.kind() {
                        wasm_host::FailureKind::DigestMismatch => "digest_mismatch",
                        wasm_host::FailureKind::NotComponentBinary => "not_component_binary",
                        wasm_host::FailureKind::CompileBusy => "compile_busy",
                        wasm_host::FailureKind::Compilation => "compilation",
                        wasm_host::FailureKind::EngineMismatch => "engine_mismatch",
                        wasm_host::FailureKind::Linking => "linking",
                        wasm_host::FailureKind::CachePoisoned => "cache_poisoned",
                        _ => "execution",
                    },
                    _ => "prepare",
                },
            )
        }
        LifecycleError::Native { cause, .. } => ("native", match cause {
            crate::extensions::invocation::NativePrepareFailure::Artifact => "artifact",
            crate::extensions::invocation::NativePrepareFailure::Configuration => "configuration",
            crate::extensions::invocation::NativePrepareFailure::Entrypoint => "entrypoint",
            crate::extensions::invocation::NativePrepareFailure::Implementation => "implementation",
        }),
        LifecycleError::Store(_) => ("store", "prepare"),
        LifecycleError::Binding(_) => ("binding", "prepare"),
        LifecycleError::Gate(_) => ("gate", "authority"),
        LifecycleError::MissingInstall(_) => ("lifecycle", "missing_install"),
        LifecycleError::MissingConfiguration(_) => ("lifecycle", "missing_configuration"),
        LifecycleError::MissingTrust(_) => ("lifecycle", "missing_trust"),
        LifecycleError::InvalidPersistedState => ("lifecycle", "invalid_persisted_state"),
        LifecycleError::EndpointMismatch(_) => ("lifecycle", "endpoint_mismatch"),
        LifecycleError::DuplicateGeneration => ("lifecycle", "duplicate_generation"),
        LifecycleError::AlreadyPrepared => ("lifecycle", "already_prepared"),
        LifecycleError::Retiring => ("lifecycle", "retiring"),
        LifecycleError::RecoveryBlocked { .. } => ("lifecycle", "recovery_blocked"),
        LifecycleError::PrepareNode { cause, .. } | LifecycleError::Cleanup { cause, .. } => {
            return preparation_reason(cause);
        }
    };
    (
        kind,
        if reason.len() < 32 { reason } else { "prepare" }.into(),
    )
}

fn preparation_tag(reason: &impl serde::Serialize) -> String {
    // Only the existing enum discriminator is safe to emit, never its payload.
    serde_json::to_value(reason)
        .ok()
        .and_then(|value| value.get("kind")?.as_str().map(str::to_owned))
        .filter(|tag| tag.len() < 32)
        .unwrap_or_else(|| "prepare".into())
}

struct PrepareGuard {
    ledgers: Vec<ResourceLedger>,
    gate: PublicationGate,
    armed: bool,
}
impl PrepareGuard {
    fn close(&self) {
        self.gate.synchronized(|_| {
            for ledger in &self.ledgers {
                ledger.close_admission();
            }
        });
        for ledger in &self.ledgers {
            let _ = ledger.request_cancel();
        }
    }
}
impl Drop for PrepareGuard {
    fn drop(&mut self) {
        if self.armed {
            self.close();
        }
    }
}
