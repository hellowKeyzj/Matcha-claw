use std::collections::BTreeSet;

use futures_util::future::BoxFuture;
use serde::Deserialize;

mod retention;
mod inspection;
pub(crate) use inspection::{merge_inspected_composition, retained_composition_closure_settled, retained_composition_settled};

use world_protocol::{
    authorization::PolicyVerdict,
    bindings::{
        BindingFailure, CompositionFailurePolicy, DataflowProjection, MergePolicy, SlotKind,
    },
    budget::{BudgetDimension, Usage},
    ids::{BindingId, NodeId},
    process::TerminalState,
    slots::{self, SlotFailure, SlotRequest, SlotResponse},
};

use super::{DispatchedCall, InvocationContext, InvocationFailure, InvocationServices, invoke};
use crate::extensions::{
    host_calls::HostCallFailure,
    process::{Delivery, ProcessChunk, ProcessError, ProcessOutcome},
};

#[derive(Debug)]
pub(crate) enum CompositionFailure {
    Invocation(InvocationFailure),
    Slot(SlotFailure),
    UnsupportedWiring { output: NodeId, input: NodeId },
    UnsupportedMerge { slot: SlotKind, policy: MergePolicy },
    MergeConflict { nodes: Vec<NodeId> },
    Incomplete { nodes: Vec<NodeId> },
    Blocked { dependencies: Vec<NodeId> },
    ProcessTerminal(TerminalState),
    ProcessResultMissing,
}

impl CompositionFailure {
    pub(crate) fn host_failure(&self) -> world_protocol::process::HostFailure {
        use world_protocol::process::{HostFailure, ProcessFailure};
        match self {
            Self::Invocation(error) => error.host_failure(),
            Self::Slot(error) => HostFailure::Slot(error.clone()),
            Self::UnsupportedWiring { output, input } => {
                HostFailure::Binding(BindingFailure::SchemaMismatch {
                    consumer: input.clone(),
                    provider: output.clone(),
                })
            }
            Self::UnsupportedMerge { slot, policy } => {
                HostFailure::Binding(BindingFailure::CompositionUnsupportedMerge {
                    slot: *slot,
                    policy: *policy,
                })
            }
            Self::MergeConflict { nodes } => {
                HostFailure::Binding(BindingFailure::CompositionMergeConflict {
                    nodes: nodes.clone(),
                })
            }
            Self::Incomplete { nodes } => {
                HostFailure::Binding(BindingFailure::CompositionIncomplete {
                    nodes: nodes.clone(),
                })
            }
            Self::Blocked { dependencies } => {
                HostFailure::Binding(BindingFailure::CompositionBlocked {
                    dependencies: dependencies.clone(),
                })
            }
            Self::ProcessTerminal(TerminalState::Cancelled) => HostFailure::Cancelled,
            Self::ProcessTerminal(TerminalState::Retained) => {
                HostFailure::Process(ProcessFailure::Retained)
            }
            Self::ProcessTerminal(TerminalState::Completed | TerminalState::Failed)
            | Self::ProcessResultMissing => HostFailure::Process(ProcessFailure::SequenceMismatch),
        }
    }
}

impl std::fmt::Display for CompositionFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("world.composition_failed")
    }
}

impl std::error::Error for CompositionFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Invocation(error) => Some(error),
            _ => None,
        }
    }
}

pub(crate) struct ProcessEvidence {
    pub outcome: Option<ProcessOutcome>,
    pub received_result: Option<std::sync::Arc<world_protocol::process::CallResult>>,
    pub delivery: Delivery,
    pub chunks: Vec<ProcessChunk>,
    pub cleanup: Option<std::sync::Arc<ProcessError>>,
}

impl ProcessEvidence {
    fn observe(&mut self, error: &std::sync::Arc<ProcessError>) {
        match error.as_ref() {
            ProcessError::Call {
                delivery,
                observed,
                received_result,
                cause,
            } => {
                self.observe(cause);
                self.delivery = *delivery;
                if let Some(outcome) = observed {
                    self.outcome = Some(outcome.as_ref().clone());
                }
                if let Some(result) = received_result {
                    self.received_result = Some(result.clone());
                }
            }
            ProcessError::Cleanup { cause, .. } => {
                if self.cleanup.is_none() {
                    self.cleanup = Some(error.clone());
                }
                self.observe(cause);
            }
            _ => {}
        }
    }
}

pub(crate) struct CompositionNode {
    pub node: NodeId,
    pub result: Result<SlotResponse, CompositionFailure>,
    proposal: Option<SlotResponse>,
    pub host_failures: Vec<HostCallFailure>,
    pub process: Option<ProcessEvidence>,
}

pub(crate) struct CompositionOutcome {
    pub binding: BindingId,
    pub result: Result<SlotResponse, CompositionFailure>,
    pub nodes: Vec<CompositionNode>,
    pub usage: Usage,
}

impl CompositionOutcome {
    /// Retains typed observations without serializing private errors or consuming custody.
    pub(crate) fn retained(&self) -> impl serde::Serialize + '_ {
        use world_protocol::{
            failure::Failure,
            process::{CallResult, HostFailure},
        };
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Outcome<'a> {
            binding: &'a BindingId,
            result: Result<&'a SlotResponse, HostFailure>,
            nodes: Vec<Node<'a>>,
            usage: &'a Usage,
        }
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Node<'a> {
            node: &'a NodeId,
            result: Result<&'a SlotResponse, HostFailure>,
            #[serde(skip_serializing_if = "Option::is_none")]
            proposal: Option<&'a SlotResponse>,
            host_failures: Vec<Failure<HostFailure>>,
            process: Option<Process<'a>>,
        }
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Process<'a> {
            outcome: Option<Observed<'a>>,
            received_result: Option<&'a CallResult>,
            delivery: &'static str,
            chunks: Vec<Chunk<'a>>,
            cleanup: Option<HostFailure>,
        }
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Observed<'a> {
            result: Option<&'a CallResult>,
            terminal: TerminalState,
            delivery: &'static str,
            usage: &'a Usage,
            host_failure: Option<Failure<HostFailure>>,
        }
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Chunk<'a> {
            stream_id: &'a world_protocol::ids::StreamId,
            content_schema: &'a world_protocol::ids::Digest,
            sequence: world_protocol::ids::Sequence,
            bytes: &'a [u8],
        }
        fn delivery(value: Delivery) -> &'static str {
            match value {
                Delivery::NotDispatched => "not_dispatched",
                Delivery::Attempted => "attempted",
                Delivery::Accepted => "accepted",
                Delivery::Terminal => "terminal",
            }
        }
        Outcome {
            binding: &self.binding,
            result: self
                .result
                .as_ref()
                .map_err(CompositionFailure::host_failure),
            nodes: self
                .nodes
                .iter()
                .map(|node| Node {
                    node: &node.node,
                    result: node
                        .result
                        .as_ref()
                        .map_err(CompositionFailure::host_failure),
                    proposal: node.proposal.as_ref(),
                    host_failures: node
                        .host_failures
                        .iter()
                        .map(HostCallFailure::safe_failure)
                        .collect(),
                    process: node.process.as_ref().map(|process| Process {
                        outcome: process.outcome.as_ref().map(|outcome| Observed {
                            result: outcome.result.as_ref(),
                            terminal: outcome.terminal,
                            delivery: delivery(outcome.delivery),
                            usage: &outcome.usage,
                            host_failure: outcome
                                .host_failure
                                .as_ref()
                                .map(|error| error.safe_failure()),
                        }),
                        received_result: process.received_result.as_deref(),
                        delivery: delivery(process.delivery),
                        chunks: process
                            .chunks
                            .iter()
                            .map(|chunk| Chunk {
                                stream_id: &chunk.stream_id,
                                content_schema: &chunk.content_schema,
                                sequence: chunk.sequence,
                                bytes: &chunk.bytes,
                            })
                            .collect(),
                        cleanup: process.cleanup.as_ref().map(|error| error.host_failure()),
                    }),
                })
                .collect(),
            usage: &self.usage,
        }
    }
}

/// Every member uses the already acquired exact lease and its shared accounting.
/// A failed or conflicting composition retains every completed provider's evidence.
pub(crate) fn invoke_composition(
    context: InvocationContext,
    request: SlotRequest,
    services: InvocationServices,
) -> BoxFuture<'static, Result<CompositionOutcome, CompositionFailure>> {
    invoke_composition_checked(
        context,
        request,
        services,
        |_, request| Ok(request),
        |_, _, _| Ok(None),
    )
}

/// Owner checks run before a proposal becomes input to any downstream member.
pub(crate) fn invoke_composition_checked<'a, P, C>(
    context: InvocationContext,
    request: SlotRequest,
    services: InvocationServices,
    mut prepare: P,
    mut check: C,
) -> BoxFuture<'a, Result<CompositionOutcome, CompositionFailure>>
where
    P: FnMut(&NodeId, SlotRequest) -> Result<SlotRequest, CompositionFailure> + Send + 'a,
    C: FnMut(
            &NodeId,
            &SlotRequest,
            &SlotResponse,
        ) -> Result<Option<SlotResponse>, CompositionFailure>
        + Send
        + 'a,
{
    Box::pin(async move {
        let graph = context.lease().graph();
        let selected = graph.node(context.node()).map_err(binding_failure)?;
        let composition = graph
            .composition(&selected.binding_id)
            .map_err(binding_failure)?;
        let order = graph
            .composition_order(&selected.binding_id)
            .map_err(binding_failure)?;
        let contract = slots::request_contract(&request)
            .map_err(|error| CompositionFailure::Invocation(InvocationFailure::Schema(error)))?;
        for node in &order {
            context.with_node(node.clone()).map_err(current_failure)?;
            if graph.node(node).map_err(binding_failure)?.slot != slots::request_slot(&request) {
                return Err(binding_failure(BindingFailure::InvalidComposition {
                    binding_id: selected.binding_id.clone(),
                }));
            }
        }
        let mut nodes: Vec<CompositionNode> = Vec::with_capacity(order.len());
        let mut stopped = Vec::new();
        for node in order {
            if !stopped.is_empty() {
                nodes.push(CompositionNode {
                    node,
                    result: Err(CompositionFailure::Blocked {
                        dependencies: stopped.clone(),
                    }),
                    proposal: None,
                    host_failures: Vec::new(),
                    process: None,
                });
                continue;
            }
            let child = match context.with_node(node.clone()) {
                Ok(child) => child,
                Err(error) => {
                    stopped.push(node.clone());
                    nodes.push(CompositionNode {
                        node,
                        result: Err(current_failure(error)),
                        proposal: None,
                        host_failures: Vec::new(),
                        process: None,
                    });
                    continue;
                }
            };
            let outcome = match wired_request(composition, &node, &request, &nodes)
                .and_then(|request| prepare(&node, request))
            {
                Ok(prepared) => {
                    let mut outcome = match invoke(
                        child.clone(),
                        prepared.clone(),
                        contract.clone(),
                        services.clone(),
                    )
                    .await
                    {
                        Ok(call) => settle(&child, call).await,
                        Err(error) => failed(node.clone(), error),
                    };
                    outcome.result = match outcome.result {
                        Ok(proposal) => match check(&node, &prepared, &proposal) {
                            Ok(Some(checked)) => {
                                outcome.proposal = Some(proposal);
                                Ok(checked)
                            }
                            Ok(None) => Ok(proposal),
                            Err(error) => {
                                outcome.proposal = Some(proposal);
                                Err(error)
                            }
                        },
                        Err(error) => Err(error),
                    };
                    outcome
                }
                Err(error) => CompositionNode {
                    node: node.clone(),
                    result: Err(error),
                    proposal: None,
                    host_failures: Vec::new(),
                    process: None,
                },
            };
            if outcome.result.is_err() && composition.failure == CompositionFailurePolicy::FailClosed {
                stopped.push(node);
            }
            nodes.push(outcome);
        }
        let mut result = merge_complete(composition, &request, &nodes);
        if result.is_ok() {
            for node in &nodes {
                let child = match context.with_node(node.node.clone()) {
                    Ok(child) => child,
                    Err(error) => {
                        result = Err(current_failure(error));
                        break;
                    }
                };
                if let Err(error) = child.check_current().await {
                    result = Err(current_failure(error));
                    break;
                }
            }
            if result.is_ok() {
                if let Err(error) = context.check_output(1).await {
                    result = Err(CompositionFailure::Invocation(InvocationFailure::Output(
                        error,
                    )));
                }
            }
        }
        if let Err(error) = context.budget().check() {
            if result.is_ok() {
                result = Err(CompositionFailure::Invocation(InvocationFailure::Budget(
                    error,
                )));
            }
        }
        Ok(CompositionOutcome {
            binding: selected.binding_id.clone(),
            result,
            nodes,
            usage: context.budget().usage(),
        })
    })
}

/// Rechecks known-success durable observations only; it never recreates live process custody.
/// The caller must first prove the original observation commit and settled terminal step.
pub(crate) fn replay_composition_checked<P, C>(
    graph: &crate::extensions::bindings::BindingGraph,
    root: &NodeId,
    request: SlotRequest,
    observation: &serde_json::Value,
    mut prepare: P,
    mut check: C,
) -> Result<SlotResponse, CompositionFailure>
where
    P: FnMut(&NodeId, SlotRequest) -> Result<SlotRequest, CompositionFailure>,
    C: FnMut(
        &NodeId,
        &SlotRequest,
        &SlotResponse,
    ) -> Result<Option<SlotResponse>, CompositionFailure>,
{
    use world_protocol::{
        bindings::Entrypoint,
        process::{CallResult, HostFailure},
    };

    // This is a historical projection, not a decoder for private errors or live evidence.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Observation {
        binding: BindingId,
        result: Result<SlotResponse, HostFailure>,
        nodes: Vec<Node>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Node {
        node: NodeId,
        result: Result<SlotResponse, HostFailure>,
        proposal: Option<SlotResponse>,
        process: Option<Process>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Process {
        outcome: Option<Observed>,
        received_result: Option<CallResult>,
        delivery: String,
        cleanup: Option<HostFailure>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Observed {
        result: Option<CallResult>,
        terminal: TerminalState,
        delivery: String,
    }

    let selected = graph.node(root).map_err(binding_failure)?;
    let composition = graph
        .composition(&selected.binding_id)
        .map_err(binding_failure)?;
    let order = graph
        .composition_order(&selected.binding_id)
        .map_err(binding_failure)?;
    let invalid = || CompositionFailure::Incomplete {
        nodes: order.clone(),
    };
    let observed: Observation = serde_json::from_value(observation.clone())
        .map_err(|error| CompositionFailure::Invocation(InvocationFailure::Meter(error)))?;
    if observed.binding != selected.binding_id
        || observed.nodes.len() != order.len()
        || observed
            .nodes
            .iter()
            .zip(&order)
            .any(|(node, expected)| &node.node != expected)
        || order.iter().any(|node| {
            graph.node(node).expect("validated composition member").slot
                != slots::request_slot(&request)
        })
    {
        return Err(invalid());
    }
    let retained = observed.result.map_err(|_| invalid())?;
    let mut completed = Vec::with_capacity(order.len());
    for node in observed.nodes {
        let retained = node.result.map_err(|_| invalid())?;
        let has_proposal = node.proposal.is_some();
        let proposal = node.proposal.unwrap_or_else(|| retained.clone());
        let member = graph.node(&node.node).map_err(binding_failure)?;
        match (&member.implementation.entrypoint, node.process) {
            (Entrypoint::Process { .. }, Some(process)) => {
                let outcome = process.outcome.ok_or_else(&invalid)?;
                let result = outcome.result.ok_or_else(&invalid)?;
                if outcome.terminal != TerminalState::Completed
                    || process.delivery != "terminal"
                    || outcome.delivery != "terminal"
                    || process.cleanup.is_some()
                    || result.result.as_ref().ok() != Some(&proposal)
                    || process
                        .received_result
                        .as_ref()
                        .is_some_and(|received| received != &result)
                {
                    return Err(invalid());
                }
            }
            (Entrypoint::Native { .. } | Entrypoint::Wasm { .. }, None) => {}
            _ => return Err(invalid()),
        }
        let prepared = prepare(
            &node.node,
            wired_request(composition, &node.node, &request, &completed)?,
        )?;
        let checked = check(&node.node, &prepared, &proposal)?;
        if checked.is_some() != has_proposal {
            return Err(invalid());
        }
        let checked = checked.unwrap_or(proposal);
        if checked != retained {
            return Err(invalid());
        }
        completed.push(CompositionNode {
            node: node.node,
            result: Ok(checked),
            proposal: None,
            host_failures: Vec::new(),
            process: None,
        });
    }
    let result = merge_complete(composition, &request, &completed)?;
    if result != retained {
        return Err(invalid());
    }
    Ok(result)
}

fn wired_request(
    composition: &world_protocol::bindings::Composition,
    node: &NodeId,
    original: &SlotRequest,
    completed: &[CompositionNode],
) -> Result<SlotRequest, CompositionFailure> {
    let mut request = original.clone();
    for edge in composition
        .wiring
        .iter()
        .filter(|edge| &edge.input_node == node)
    {
        let source = completed
            .iter()
            .find(|node| node.node == edge.output_node)
            .and_then(|node| node.result.as_ref().ok())
            .ok_or_else(|| CompositionFailure::Blocked {
                dependencies: vec![edge.output_node.clone()],
            })?;
        match (edge.projection, source, &mut request) {
            (
                DataflowProjection::CompilerIr,
                SlotResponse::Compiler(source),
                SlotRequest::Compiler(target),
            ) => {
                target.ir = source.ir.clone();
            }
            _ => {
                return Err(CompositionFailure::UnsupportedWiring {
                    output: edge.output_node.clone(),
                    input: edge.input_node.clone(),
                });
            }
        }
    }
    Ok(request)
}

fn binding_failure(error: BindingFailure) -> CompositionFailure {
    CompositionFailure::Invocation(InvocationFailure::Binding(error))
}
fn current_failure(error: super::CurrentFailure) -> CompositionFailure {
    CompositionFailure::Invocation(InvocationFailure::Current(error))
}
fn failed(node: NodeId, error: InvocationFailure) -> CompositionNode {
    CompositionNode {
        node,
        result: Err(CompositionFailure::Invocation(error)),
        proposal: None,
        host_failures: Vec::new(),
        process: None,
    }
}

fn settle(context: &InvocationContext, call: DispatchedCall) -> BoxFuture<'_, CompositionNode> {
    Box::pin(async move {
        let source_budget = match &call {
            DispatchedCall::Immediate { source_budget, .. }
            | DispatchedCall::Process { source_budget, .. } => source_budget.clone(),
        };
        let mut outcome = settle_call(context, call).await;
        let Some(budget) = source_budget else {
            return outcome;
        };
        let received = outcome.process.as_ref().and_then(|process| {
            process
                .outcome
                .as_ref()
                .and_then(|outcome| outcome.result.as_ref())
                .filter(|result| matches!(&result.result, Ok(SlotResponse::Connector(_))))
                .or_else(|| process.received_result.as_deref())
                .and_then(|result| result.result.as_ref().ok())
        });
        let rows = match received.or_else(|| outcome.result.as_ref().ok()) {
            Some(SlotResponse::Connector(page)) => page.rows.len() as u64,
            _ => return outcome,
        };
        if let Err(error) = budget.charge(BudgetDimension::Rows, rows) {
            outcome.host_failures.push(HostCallFailure::new(
                world_protocol::process::HostFailure::BudgetExceeded {
                    dimension: error.dimension,
                },
                world_protocol::failure::FailureStage::Execute,
            ));
            outcome.result = match outcome.result {
                Ok(proposal) => {
                    outcome.proposal = Some(proposal);
                    Err(CompositionFailure::Invocation(InvocationFailure::Budget(
                        error,
                    )))
                }
                Err(primary) => Err(primary),
            };
        }
        outcome
    })
}

fn settle_call(context: &InvocationContext, call: DispatchedCall) -> BoxFuture<'_, CompositionNode> {
    let node = context.node().clone();
    match call {
        DispatchedCall::Immediate {
            result,
            host_failures,
            ..
        } => Box::pin(std::future::ready(CompositionNode {
            node,
            result: result.map_err(CompositionFailure::Slot),
            proposal: None,
            host_failures,
            process: None,
        })),
        DispatchedCall::Process { mut call, .. } => Box::pin(async move {
            let mut chunks = Vec::new();
            let mut bytes = 0_u64;
            let mut failure = None;
            loop {
                match call.next().await {
                    Ok(Some(chunk)) => {
                        let accounting = context.budget().charge(BudgetDimension::Steps, 1);
                        let total = bytes.checked_add(chunk.bytes.len() as u64);
                        if let Err(error) = accounting {
                            failure = Some(InvocationFailure::Budget(error));
                            break;
                        }
                        if total.is_none_or(|total| total > context.budget().limit().max_bytes) {
                            failure = Some(InvocationFailure::Budget(super::BudgetFailure {
                                dimension: BudgetDimension::Bytes,
                            }));
                            break;
                        }
                        bytes = total.expect("checked bounded stream bytes");
                        chunks.push(chunk);
                    }
                    Ok(None) => break,
                    Err(error) => {
                        failure = Some(InvocationFailure::Process(error));
                        break;
                    }
                }
            }
            let delivery = call.delivery();
            if let Some(error) = failure {
                match &error {
                    InvocationFailure::Budget(error) => call.record_failure(std::sync::Arc::new(
                        ProcessError::Budget(error.dimension),
                    )),
                    InvocationFailure::Process(error) => call.record_failure(error.clone()),
                    _ => {}
                }
                let (outcome, cleanup) = match call.cancel(context.budget().deadline()).await {
                    Ok(outcome) => (outcome, None),
                    Err(error) => (None, Some(error)),
                };
                let mut evidence = ProcessEvidence {
                    outcome,
                    received_result: None,
                    delivery,
                    chunks,
                    cleanup,
                };
                if let Some(outcome) = &evidence.outcome {
                    evidence.delivery = outcome.delivery;
                }
                if let InvocationFailure::Process(cause) = &error {
                    evidence.observe(cause);
                }
                if let Some(cleanup) = evidence.cleanup.clone() {
                    evidence.observe(&cleanup);
                }
                return CompositionNode {
                    node,
                    result: Err(CompositionFailure::Invocation(error)),
                    proposal: None,
                    host_failures: Vec::new(),
                    process: Some(evidence),
                };
            }
            match call.finish().await {
                Ok(outcome) => {
                    let result = if outcome.terminal != TerminalState::Completed {
                        match outcome.result.as_ref().map(|result| &result.result) {
                            Some(Err(error)) => {
                                Err(CompositionFailure::Slot(error.details.clone()))
                            }
                            _ => Err(CompositionFailure::ProcessTerminal(outcome.terminal)),
                        }
                    } else {
                        match outcome.result.as_ref().map(|result| &result.result) {
                            Some(Ok(response)) => Ok(response.clone()),
                            Some(Err(error)) => {
                                Err(CompositionFailure::Slot(error.details.clone()))
                            }
                            None => Err(CompositionFailure::ProcessResultMissing),
                        }
                    };
                    CompositionNode {
                        node,
                        result,
                        proposal: None,
                        host_failures: Vec::new(),
                        process: Some(ProcessEvidence {
                            delivery: outcome.delivery,
                            outcome: Some(outcome),
                            received_result: None,
                            chunks,
                            cleanup: None,
                        }),
                    }
                }
                Err(error) => {
                    let mut evidence = ProcessEvidence {
                        outcome: None,
                        received_result: None,
                        delivery,
                        chunks,
                        cleanup: None,
                    };
                    evidence.observe(&error);
                    CompositionNode {
                        node,
                        result: Err(CompositionFailure::Invocation(InvocationFailure::Process(
                            error,
                        ))),
                        proposal: None,
                        host_failures: Vec::new(),
                        process: Some(evidence),
                    }
                }
            }
        }),
    }
}

fn merge_complete(
    composition: &world_protocol::bindings::Composition,
    request: &SlotRequest,
    nodes: &[CompositionNode],
) -> Result<SlotResponse, CompositionFailure> {
    let incomplete: Vec<_> = nodes
        .iter()
        .filter(|node| node.result.is_err())
        .map(|node| node.node.clone())
        .collect();
    let mut result = if incomplete.is_empty() {
        merge(composition, request, nodes)
    } else {
        Err(CompositionFailure::Incomplete { nodes: incomplete })
    };
    if let Ok(SlotResponse::Compiler(result)) = &mut result {
        result.observed_dependencies.clear();
        result.diagnostics.clear();
        for node in nodes {
            if let Ok(SlotResponse::Compiler(value)) = &node.result {
                result
                    .observed_dependencies
                    .extend(value.observed_dependencies.iter().cloned());
                result.diagnostics.extend(value.diagnostics.iter().cloned());
            }
        }
    }
    result
}

fn merge(
    composition: &world_protocol::bindings::Composition,
    request: &SlotRequest,
    nodes: &[CompositionNode],
) -> Result<SlotResponse, CompositionFailure> {
    let policy = composition.merge;
    let values: Vec<_> = nodes
        .iter()
        .filter(|node| {
            !composition
                .wiring
                .iter()
                .any(|edge| edge.output_node == node.node)
        })
        .map(|node| node.result.as_ref().expect("successful composition member"))
        .collect();
    let conflict = || CompositionFailure::MergeConflict {
        nodes: nodes.iter().map(|node| node.node.clone()).collect(),
    };
    let unsupported = || CompositionFailure::UnsupportedMerge {
        slot: slots::request_slot(request),
        policy,
    };
    if let SlotRequest::Policy(request) = request {
        return merge_policy(request, &values);
    }
    let oracle_measurements = if matches!(request, SlotRequest::Evaluation(_)) {
        let evaluations = values
            .iter()
            .filter_map(|value| match value {
                SlotResponse::Evaluation(value) => Some(value),
                _ => None,
            })
            .collect::<Vec<_>>();
        Some((
            merge_oracle_measurement(
                evaluations
                    .iter()
                    .map(|value| (value.evidence_satisfied, value.evidence_required)),
            )
            .map_err(|_| conflict())?,
            merge_oracle_measurement(
                evaluations
                    .iter()
                    .map(|value| (value.conflicts_detected, value.conflicts_present)),
            )
            .map_err(|_| conflict())?,
        ))
    } else {
        None
    };
    match policy {
        MergePolicy::None if values.len() == 1 => {
            Ok((*values.last().expect("nonempty validated composition")).clone())
        }
        MergePolicy::RequireEqual | MergePolicy::ExplicitConflict => {
            let first = values[0];
            if values.iter().skip(1).all(|value| *value == first) {
                Ok((*first).clone())
            } else {
                Err(conflict())
            }
        }
        MergePolicy::OrderedConcatenation | MergePolicy::DisjointFields => {
            let mut result = (*values[0]).clone();
            let mut fields = BTreeSet::new();
            if policy == MergePolicy::DisjointFields {
                let SlotResponse::Projection(projection) = &result else {
                    return Err(unsupported());
                };
                for cell in &projection.cells {
                    if !fields.insert((cell.subject.clone(), cell.field.property.id.clone())) {
                        return Err(conflict());
                    }
                }
            }
            for value in values.into_iter().skip(1) {
                match (&mut result, value) {
                    (SlotResponse::Projection(target), SlotResponse::Projection(source)) => {
                        if policy == MergePolicy::DisjointFields {
                            for cell in &source.cells {
                                if !fields
                                    .insert((cell.subject.clone(), cell.field.property.id.clone()))
                                {
                                    return Err(conflict());
                                }
                            }
                        }
                        target.cells.extend(source.cells.iter().cloned());
                        target
                            .dependencies
                            .extend(source.dependencies.iter().cloned());
                        target
                            .diagnostics
                            .extend(source.diagnostics.iter().cloned());
                    }
                    (SlotResponse::Reconcile(target), SlotResponse::Reconcile(source))
                        if policy == MergePolicy::OrderedConcatenation =>
                    {
                        target.selected.extend(source.selected.iter().cloned());
                        target.conflicts.extend(source.conflicts.iter().cloned());
                        target
                            .observations
                            .extend(source.observations.iter().cloned());
                        target
                            .dependencies
                            .extend(source.dependencies.iter().cloned());
                    }
                    (SlotResponse::Evaluation(target), SlotResponse::Evaluation(source))
                        if policy == MergePolicy::OrderedConcatenation =>
                    {
                        let (evidence, conflicts) = oracle_measurements.ok_or_else(conflict)?;
                        (target.evidence_satisfied, target.evidence_required) = evidence;
                        (target.conflicts_detected, target.conflicts_present) = conflicts;
                        target.passed &= source.passed;
                        target.evidence.extend(source.evidence.iter().cloned());
                        target
                            .diagnostics
                            .extend(source.diagnostics.iter().cloned());
                    }
                    (SlotResponse::Storage(target), SlotResponse::Storage(source))
                        if policy == MergePolicy::OrderedConcatenation =>
                    {
                        target.assertions.extend(source.assertions.iter().cloned());
                        target
                            .definitions
                            .extend(source.definitions.iter().cloned());
                        target.evidence.extend(source.evidence.iter().cloned());
                        target.revisions.extend(source.revisions.iter().cloned());
                    }
                    (SlotResponse::Compiler(target), SlotResponse::Compiler(source))
                        if policy == MergePolicy::OrderedConcatenation =>
                    {
                        if target.ir != source.ir {
                            return Err(conflict());
                        }
                        target
                            .observed_dependencies
                            .extend(source.observed_dependencies.iter().cloned());
                        target
                            .diagnostics
                            .extend(source.diagnostics.iter().cloned());
                    }
                    _ => return Err(unsupported()),
                }
            }
            Ok(result)
        }
        _ => Err(unsupported()),
    }
}

fn merge_oracle_measurement(
    pairs: impl Iterator<Item = (Option<u64>, Option<u64>)>,
) -> Result<(Option<u64>, Option<u64>), ()> {
    let mut measured = None;
    let mut missing = false;
    for pair in pairs {
        match pair {
            (None, None) => missing = true,
            (Some(numerator), Some(denominator)) if numerator <= denominator => {
                if measured.is_some_and(|previous| previous != pair) {
                    return Err(());
                }
                measured = Some(pair);
            }
            _ => return Err(()),
        }
    }
    Ok(if missing {
        (None, None)
    } else {
        measured.unwrap_or((None, None))
    })
}

fn merge_policy(
    request: &slots::PolicyEvaluationRequest,
    values: &[&SlotResponse],
) -> Result<SlotResponse, CompositionFailure> {
    let mut result = slots::PolicyEvaluationResult {
        verdict: PolicyVerdict::Allow,
        obligations: Vec::new(),
        policies: Vec::new(),
    };
    for value in values {
        let SlotResponse::Policy(value) = value else {
            return Err(CompositionFailure::UnsupportedMerge {
                slot: SlotKind::Policy,
                policy: MergePolicy::MandatoryAndDenyOverrides,
            });
        };
        result.verdict = match (result.verdict, value.verdict) {
            (PolicyVerdict::Deny, _) | (_, PolicyVerdict::Deny) => PolicyVerdict::Deny,
            (PolicyVerdict::NeedsApproval, _) | (_, PolicyVerdict::NeedsApproval) => {
                PolicyVerdict::NeedsApproval
            }
            _ => PolicyVerdict::Allow,
        };
        for obligation in &value.obligations {
            if !result.obligations.contains(obligation) {
                result.obligations.push(obligation.clone());
            }
        }
        for policy in &value.policies {
            if !result.policies.contains(policy) {
                result.policies.push(policy.clone());
            }
        }
    }
    for policy in &request.policies {
        if !result.policies.contains(policy) {
            return Err(CompositionFailure::Slot(SlotFailure::Policy(
                world_protocol::authorization::AuthorizationFailure::RequiredPolicyUnavailable {
                    policy_id: policy.policy_id.clone(),
                },
            )));
        }
        for obligation in &policy.obligations {
            if !result.obligations.contains(obligation) {
                result.obligations.push(obligation.clone());
            }
        }
    }
    Ok(SlotResponse::Policy(result))
}
