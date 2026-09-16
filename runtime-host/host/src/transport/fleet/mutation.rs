use std::{
    collections::BTreeMap,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};

use crate::fleet::handle::FleetHandle;
use crate::fleet::owner::ManagedResourceRegistrationRequest;
use fleet::command::{CommandId, CommandIntent, CommandKind, CommandTarget, IdempotencyKey};
use fleet::connection::{ConnectionId, ConnectionKind, ConnectionRecord};
use fleet::environment::{
    CleanupPolicy, EnvironmentId, EnvironmentKind, EnvironmentRecord, ManagedResourceId,
    ManagedResourceKind, ManagedResourceProvider, Ownership,
};
use fleet::outbox::{DispatchAttempt, DispatchId, DispatchIntent};
use fleet::target::{
    CustomTargetConfig, DockerTargetConfig, FleetTargetConfig, FleetTargetSelector,
    KubernetesTargetConfig, SshAuthentication, SshTargetConfig, TargetId, TargetKind,
};
use fleet::topology::{
    AgentObservation, EndpointHealth, EndpointObservation, NodeHealth, NodeId, NodeObservation,
    ObservationFreshness, ObservationMetadata, ObservationSource, RuntimeId, RuntimeKind,
    RuntimeObservation, RuntimeState,
};
use platform::capability::{
    CapabilityAvailability, CapabilityId, CapabilityScope, SupportedCapability,
};
use platform::endpoint::{EndpointId, NativeAgentId};

use super::dto::{
    AgentUpsertPayload, CapabilitySyncPayload, CommandFailurePayload, CommandIdPayload,
    CommandPhasePayload, CommandSubmitPayload, CommandTargetPayload, ConnectionUpsertPayload,
    EndpointUpsertPayload, EnvironmentRegisterPayload, Input, NodeCommandSubmitPayload,
    NodeUpsertPayload, Operation, ResourceRegisterPayload, RuntimeUpsertPayload,
    TargetConfigPayload, TargetPutPayload,
};
use super::projection::{Delivery, delivery_outcome_json, selector_target_json, target_kind_name};
use super::terminal;

pub(super) async fn handle(owner: &FleetHandle, operation: Operation, input: Input) -> Delivery {
    match operation {
        Operation::TargetPut => match input {
            Input::TargetPut { payload } => match parse_target_put(payload) {
                Ok((id, config)) => owner.put_target(id, config).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|target| json!({"outcome":"targetUpdated","target":{"id":target.id().as_str(),"revision":target.revision(),"kind":target_kind_name(target.kind())}})))),
                Err(()) => Delivery::Mutation(json!({"outcome":"error"})),
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::TargetRemove => match input {
            Input::TargetRemove { payload } => match TargetId::try_new(payload.id) {
                Ok(id) => owner.remove_target(id).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"targetRemoved"})))),
                Err(_) => Delivery::Mutation(json!({"outcome":"error"})),
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::ConnectionUpsert => match input {
            Input::ConnectionUpsert { payload } => match parse_connection(payload) {
                Ok(record) => owner.upsert_connection(record).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"connectionUpdated"})))),
                Err(()) => Delivery::Mutation(json!({"outcome":"error"})),
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::ConnectionRemove => match input {
            Input::ConnectionRemove { payload } => match ConnectionId::try_new(payload.id) {
                Ok(id) => owner.delete_connection(id).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"connectionRemoved"})))),
                Err(_) => Delivery::Mutation(json!({"outcome":"error"})),
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::EnvironmentRegister => match input {
            Input::EnvironmentRegister { payload } => match parse_environment(payload) {
                Ok(record) => owner.register_environment(record).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"environmentRegistered"})))),
                Err(()) => Delivery::Mutation(json!({"outcome":"error"})),
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::ResourceRegister => match input {
            Input::ResourceRegister { payload } => match parse_resource(payload) {
                Ok(request) => owner.register_resource(request).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"resourceRegistered"})))),
                Err(()) => Delivery::Mutation(json!({"outcome":"error"})),
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::NodeUpsert => match input {
            Input::NodeUpsert { payload } => match parse_node(payload) {
                Ok(observation) => owner.upsert_node(observation).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"nodeUpdated"})))),
                Err(()) => Delivery::Mutation(json!({"outcome":"error"})),
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::AgentUpsert => match input {
            Input::AgentUpsert { payload } => match parse_agent(payload) {
                Ok(observation) => owner.upsert_agent(observation).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"agentUpdated"})))),
                Err(()) => Delivery::Mutation(json!({"outcome":"error"})),
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::AgentRevoke => match input {
            Input::AgentRevoke { payload } => match NativeAgentId::try_new(payload.id) {
                Ok(id) => owner.revoke_agent(id).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"agentRevoked"})))),
                Err(_) => Delivery::Mutation(json!({"outcome":"error"})),
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::RuntimeUpsert => match input {
            Input::RuntimeUpsert { payload } => match parse_runtime(payload) {
                Ok(observation) => owner.upsert_runtime(observation).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"runtimeUpdated"})))),
                Err(()) => Delivery::Mutation(json!({"outcome":"error"})),
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::EndpointUpsert => match input {
            Input::EndpointUpsert { payload } => match parse_endpoint(payload) {
                Ok(observation) => owner.upsert_endpoint(observation).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"endpointUpdated"})))),
                Err(()) => Delivery::Mutation(json!({"outcome":"error"})),
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::ConnectionProbeBegin => match input {
            Input::ConnectionProbeBegin { payload } => match (ConnectionId::try_new(payload.id), CommandId::try_new(payload.command_id)) {
                (Ok(id), Ok(command_id)) => owner
                    .run_connection_probe(id, command_id)
                    .await
                    .map_or(Delivery::Unavailable, |result| {
                        mutation_result(result.map(|outcome| match outcome {
                            crate::fleet::lifecycle::FleetConnectionLifecycleOutcome::Ready(_) => json!({"outcome":"probeCompleted","state":"ready"}),
                            crate::fleet::lifecycle::FleetConnectionLifecycleOutcome::Unhealthy(_) => json!({"outcome":"probeCompleted","state":"unhealthy"}),
                            crate::fleet::lifecycle::FleetConnectionLifecycleOutcome::Unknown(_) => json!({"outcome":"probeUnknown","reason":"providerOutcomeUnknown"}),
                            crate::fleet::lifecycle::FleetConnectionLifecycleOutcome::Rejected(_) => json!({"outcome":"probeRejected","reason":"providerRejected"}),
                        }))
                    }),
                _ => Delivery::Mutation(json!({"outcome":"error"})),
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::ConnectionProbeComplete => match input {
            Input::ConnectionProbeComplete { payload } => {
                let outcome = match payload.outcome.as_str() { "ready" => fleet::connection::ProbeOutcome::Ready, "unhealthy" => fleet::connection::ProbeOutcome::Unhealthy, _ => return Delivery::Mutation(json!({"outcome":"error"})) };
                match (ConnectionId::try_new(payload.id), CommandId::try_new(payload.command_id)) {
                    (Ok(id), Ok(command_id)) => owner.complete_connection_probe(id, command_id, outcome, payload.message).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"probeCompleted"})))),
                    _ => Delivery::Mutation(json!({"outcome":"error"})),
                }
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::EnvironmentDeployBegin | Operation::EnvironmentDeployComplete | Operation::EnvironmentDeployFail => {
            match input {
                Input::EnvironmentDeployBegin { payload } => lifecycle_environment_deploy(owner, payload, 0).await,
                Input::EnvironmentDeployComplete { payload } => lifecycle_environment_deploy(owner, payload, 1).await,
                Input::EnvironmentDeployFail { payload } => lifecycle_environment_deploy_fail(owner, payload).await,
                _ => Delivery::Mutation(json!({"outcome":"error"})),
            }
        }
        Operation::EnvironmentDeleteBegin | Operation::EnvironmentDeleteComplete | Operation::EnvironmentDeleteFail => {
            match input {
                Input::EnvironmentDeleteBegin { payload } => lifecycle_environment_delete(owner, payload, 0).await,
                Input::EnvironmentDeleteComplete { payload } => lifecycle_environment_delete(owner, payload, 1).await,
                Input::EnvironmentDeleteFail { payload } => lifecycle_environment_delete_fail(owner, payload).await,
                _ => Delivery::Mutation(json!({"outcome":"error"})),
            }
        }
        Operation::ResourceProvisionBegin | Operation::ResourceProvisionComplete => {
            match input {
                Input::ResourceProvisionBegin { payload } => lifecycle_resource_provision(owner, payload, 0).await,
                Input::ResourceProvisionComplete { payload } => lifecycle_resource_provision(owner, payload, 1).await,
                _ => Delivery::Mutation(json!({"outcome":"error"})),
            }
        }
        Operation::ResourceDeleteBegin | Operation::ResourceDeleteComplete | Operation::ResourceDeleteFail => {
            match input {
                Input::ResourceDeleteBegin { payload } => lifecycle_resource_delete(owner, payload, 0).await,
                Input::ResourceDeleteComplete { payload } => lifecycle_resource_delete(owner, payload, 1).await,
                Input::ResourceDeleteFail { payload } => lifecycle_resource_delete_fail(owner, payload).await,
                _ => Delivery::Mutation(json!({"outcome":"error"})),
            }
        }
        Operation::NodeRetire => match input {
            Input::NodeRetire { payload } => match NodeId::try_new(payload.id) { Ok(id) => owner.retire_node(id).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"nodeRetired"})))), Err(_) => Delivery::Mutation(json!({"outcome":"error"})) },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::RuntimeStartBegin | Operation::RuntimeStartComplete | Operation::RuntimeStopBegin | Operation::RuntimeStopComplete => {
            match input {
                Input::RuntimeStartBegin { payload } => lifecycle_runtime(owner, payload, 0).await,
                Input::RuntimeStartComplete { payload } => lifecycle_runtime(owner, payload, 1).await,
                Input::RuntimeStopBegin { payload } => lifecycle_runtime(owner, payload, 2).await,
                Input::RuntimeStopComplete { payload } => lifecycle_runtime(owner, payload, 3).await,
                _ => Delivery::Mutation(json!({"outcome":"error"})),
            }
        }
        Operation::RuntimeRetire => match input {
            Input::RuntimeRetire { payload } => match RuntimeId::try_new(payload.id) { Ok(id) => owner.retire_runtime(id).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"runtimeRetired"})))), Err(_) => Delivery::Mutation(json!({"outcome":"error"})) },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::EndpointDrain | Operation::EndpointRetire => match input {
            Input::EndpointDrain { payload } => match EndpointId::try_new(payload.id) { Ok(id) => owner.drain_endpoint(id).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"endpointDrained"})))), Err(_) => Delivery::Mutation(json!({"outcome":"error"})) },
            Input::EndpointRetire { payload } => match EndpointId::try_new(payload.id) { Ok(id) => owner.retire_endpoint(id).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"endpointRetired"})))), Err(_) => Delivery::Mutation(json!({"outcome":"error"})) },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::EndpointProbeBegin => match input {
            Input::EndpointProbeBegin { payload } => match (EndpointId::try_new(payload.id), CommandId::try_new(payload.command_id)) { (Ok(id), Ok(command_id)) => owner.begin_endpoint_probe(id, command_id).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"probeStarted"})))), _ => Delivery::Mutation(json!({"outcome":"error"})) },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::CapabilitySyncBegin => match input {
            Input::CapabilitySyncBegin { payload } => match (EndpointId::try_new(payload.id), CommandId::try_new(payload.command_id)) {
                (Ok(id), Ok(command_id)) => owner.begin_capability_sync(id, command_id).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"capabilitySyncStarted"})))),
                _ => Delivery::Mutation(json!({"outcome":"error"})),
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::CapabilitySyncComplete => match input {
            Input::CapabilitySyncComplete { payload } => match (CommandId::try_new(payload.command_id.clone()), EndpointId::try_new(payload.id.clone()), parse_capability_sync(payload)) {
                (Ok(command_id), Ok(id), Ok(sync)) => owner.complete_capability_sync(id, command_id, sync).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"capabilitySyncCompleted"})))),
                _ => Delivery::Mutation(json!({"outcome":"error"})),
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::TerminalOpen => match input {
            Input::TerminalOpen { payload } => terminal::terminal_open_delivery(owner, payload).await,
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::TerminalReconnect => match input {
            Input::TerminalReconnect { payload } => {
                terminal::terminal_reconnect_delivery(owner, payload).await
            }
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::TerminalBeginClose => match input {
            Input::TerminalBeginClose { payload } => {
                terminal::terminal_begin_close_delivery(owner, payload).await
            }
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::TerminalFinishClose => match input {
            Input::TerminalFinishClose { payload } => {
                terminal::terminal_finish_close_delivery(owner, payload).await
            }
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::TerminalClose => match input {
            Input::TerminalClose { payload } => terminal::terminal_close_delivery(owner, payload).await,
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::CommandSubmit => match input {
            Input::CommandSubmit { payload } => {
                let target_id = match TargetId::try_new(payload.selector.target_id.clone()) { Ok(id) => id, Err(_) => return Delivery::Mutation(json!({"outcome":"error"})) };
                let kind = match payload.selector.expected_kind.as_str() { "docker" => TargetKind::Docker, "kubernetes" => TargetKind::Kubernetes, "ssh" => TargetKind::Ssh, "custom" => TargetKind::Custom, _ => return Delivery::Mutation(json!({"outcome":"error"})) };
                let selector = match query_option(owner.target_selector(target_id, payload.selector.revision, kind).await) {
                    QueryOption::Some(selector) => selector,
                    QueryOption::None => return Delivery::Mutation(json!({"outcome":"error"})),
                    QueryOption::Unavailable => return Delivery::Unavailable,
                };
                match parse_submit(payload, selector) {
                    Ok(request) => owner.submit(request).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|outcome| json!({"outcome": match outcome { fleet::FleetSubmitOutcome::Submitted => "submitted", fleet::FleetSubmitOutcome::AlreadySubmitted => "alreadySubmitted" }})))),
                    Err(()) => Delivery::Mutation(json!({"outcome":"error"})),
                }
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::NodeCommandSubmit => match input {
            Input::NodeCommandSubmit { payload } => match parse_node_command_submit(payload) {
                Ok(request) => match owner.node_command_request(request).await {
                    Ok(Ok(resolution)) => {
                        let dispatch_id = resolution.dispatch_id.clone();
                        let target = selector_target_json(&resolution.selector);
                        match owner.submit(resolution.request).await {
                            Ok(Ok(fleet::FleetSubmitOutcome::Submitted)) => owner.begin_dispatch(dispatch_id).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|dispatch| json!({"outcome": match dispatch.outcome { crate::fleet::executor::FleetExecutionOutcome::Completed => "completed", crate::fleet::executor::FleetExecutionOutcome::Rejected => "rejected", crate::fleet::executor::FleetExecutionOutcome::Unknown => "outcomeUnknown", crate::fleet::executor::FleetExecutionOutcome::Accepted => "accepted" }, "dispatchId": dispatch.dispatch_id.as_str(), "attempt": dispatch.attempt.sequence(), "target": target})))),
                            Ok(Ok(fleet::FleetSubmitOutcome::AlreadySubmitted)) => Delivery::Mutation(json!({"outcome":"alreadySubmitted","dispatchId":dispatch_id.as_str(),"target":target})),
                            Ok(Err(_)) => Delivery::Mutation(json!({"outcome":"error"})),
                            Err(_) => Delivery::Unavailable,
                        }
                    }
                    Ok(Err(_)) => Delivery::Mutation(json!({"outcome":"error"})),
                    Err(_) => Delivery::Unavailable,
                },
                Err(()) => Delivery::Mutation(json!({"outcome":"error"})),
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::CommandBegin => match input {
            Input::CommandBegin { payload } => match DispatchId::try_new(payload.dispatch_id) {
                Ok(dispatch) => owner.begin_dispatch(dispatch).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|dispatch| json!({"outcome": match dispatch.outcome { crate::fleet::executor::FleetExecutionOutcome::Completed => "completed", crate::fleet::executor::FleetExecutionOutcome::Rejected => "rejected", crate::fleet::executor::FleetExecutionOutcome::Unknown => "outcomeUnknown", crate::fleet::executor::FleetExecutionOutcome::Accepted => "accepted" },"dispatchId":dispatch.dispatch_id.as_str(),"attempt":dispatch.attempt.sequence()})))),
                Err(_) => Delivery::Mutation(json!({"outcome":"error"})),
            },
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        Operation::CommandAccept | Operation::CommandReject | Operation::CommandUnknown => {
            let (payload, operation) = match input { Input::CommandAccept { payload } => (payload, 0), Input::CommandReject { payload } => (payload, 1), Input::CommandUnknown { payload } => (payload, 2), _ => return Delivery::Mutation(json!({"outcome":"error"})) };
            let dispatch = match DispatchId::try_new(payload.dispatch_id) { Ok(v) => v, Err(_) => return Delivery::Mutation(json!({"outcome":"error"})) };
            let attempt = match DispatchAttempt::try_new(payload.attempt) { Ok(v) => v, Err(_) => return Delivery::Mutation(json!({"outcome":"error"})) };
            let result = match operation { 0 => owner.accept_dispatch(dispatch, attempt).await, 1 => owner.reject_dispatch(dispatch, attempt).await, _ => owner.mark_dispatch_unknown(dispatch, attempt).await };
            result.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|outcome| delivery_outcome_json(outcome, operation))))
        }
        Operation::CommandReplay => match input {
            Input::CommandReplay { payload } => { let command = match CommandId::try_new(payload.command_id) { Ok(v) => v, Err(_) => return Delivery::Mutation(json!({"outcome":"error"})) }; let dispatch = match DispatchId::try_new(payload.dispatch_id) { Ok(v) => v, Err(_) => return Delivery::Mutation(json!({"outcome":"error"})) }; owner.authorize_replay(command, dispatch).await.map_or(Delivery::Unavailable, |result| mutation_result(result.map(|_| json!({"outcome":"replayAuthorized"})))) }
            _ => Delivery::Mutation(json!({"outcome":"error"})),
        },
        _ => Delivery::Mutation(json!({"outcome":"error"})),
    }
}

enum QueryOption<T> {
    Some(T),
    None,
    Unavailable,
}

fn query_option<T>(
    result: Result<Result<Option<T>, fleet::FleetDeliveryError>, crate::RequestAdmissionClosed>,
) -> QueryOption<T> {
    match result {
        Ok(Ok(Some(value))) => QueryOption::Some(value),
        Ok(Ok(None)) => QueryOption::None,
        Ok(Err(_)) | Err(_) => QueryOption::Unavailable,
    }
}

async fn lifecycle_environment_deploy(
    owner: &FleetHandle,
    payload: CommandPhasePayload,
    step: u8,
) -> Delivery {
    let (id, command_id, phase) = match (
        EnvironmentId::try_new(payload.id),
        CommandId::try_new(payload.command_id),
        fleet::effect::PhaseKey::try_new(payload.phase),
    ) {
        (Ok(id), Ok(command_id), Ok(phase)) => (id, command_id, phase),
        _ => return Delivery::Mutation(json!({"outcome":"error"})),
    };
    let result = match step {
        0 => owner.run_environment_deployment(id, command_id, phase).await.map(|result| result.map(|outcome| json!({"outcome": match outcome { crate::fleet::lifecycle::FleetLifecycleOutcome::Completed | crate::fleet::lifecycle::FleetLifecycleOutcome::AlreadyAbsent => "deploymentCompleted", crate::fleet::lifecycle::FleetLifecycleOutcome::Rejected(_) => "deploymentFailed", crate::fleet::lifecycle::FleetLifecycleOutcome::Unknown(_) => "deploymentUnknown" }}))),
        _ => owner.complete_environment_deployment(id, command_id, phase).await.map(|result| result.map(|_| json!({"outcome":"deploymentCompleted"}))),
    };
    result.map_or(Delivery::Unavailable, |result| {
        result.map_or(Delivery::Mutation(json!({"outcome":"error"})), |value| {
            Delivery::Mutation(value)
        })
    })
}

async fn lifecycle_environment_deploy_fail(
    owner: &FleetHandle,
    payload: CommandFailurePayload,
) -> Delivery {
    let (id, command_id, phase) = match (
        EnvironmentId::try_new(payload.id),
        CommandId::try_new(payload.command_id),
        fleet::effect::PhaseKey::try_new(payload.phase),
    ) {
        (Ok(id), Ok(command_id), Ok(phase)) => (id, command_id, phase),
        _ => return Delivery::Mutation(json!({"outcome":"error"})),
    };
    owner
        .fail_environment_deployment(id, command_id, phase, payload.message)
        .await
        .map_or(Delivery::Unavailable, |result| {
            mutation_result(result.map(|_| json!({"outcome":"deploymentFailed"})))
        })
}

async fn lifecycle_environment_delete(
    owner: &FleetHandle,
    payload: CommandPhasePayload,
    step: u8,
) -> Delivery {
    let (id, command_id, phase) = match (
        EnvironmentId::try_new(payload.id),
        CommandId::try_new(payload.command_id),
        fleet::effect::PhaseKey::try_new(payload.phase),
    ) {
        (Ok(id), Ok(command_id), Ok(phase)) => (id, command_id, phase),
        _ => return Delivery::Mutation(json!({"outcome":"error"})),
    };
    let result = match step {
        0 => owner
            .run_environment_deletion(id, command_id, phase)
            .await
            .map(|result| {
                result.map(|outcome| {
                    json!({"outcome": match outcome {
                        crate::fleet::lifecycle::FleetLifecycleOutcome::Completed
                        | crate::fleet::lifecycle::FleetLifecycleOutcome::AlreadyAbsent => "deletionCompleted",
                        crate::fleet::lifecycle::FleetLifecycleOutcome::Rejected(_) => "deletionFailed",
                        crate::fleet::lifecycle::FleetLifecycleOutcome::Unknown(_) => "deletionUnknown",
                    }})
                })
            }),
        _ => owner
            .complete_environment_deletion(id, command_id, phase)
            .await
            .map(|result| result.map(|_| json!({"outcome":"deletionCompleted"}))),
    };
    result.map_or(Delivery::Unavailable, mutation_result)
}

async fn lifecycle_environment_delete_fail(
    owner: &FleetHandle,
    payload: CommandFailurePayload,
) -> Delivery {
    let (id, command_id, phase) = match (
        EnvironmentId::try_new(payload.id),
        CommandId::try_new(payload.command_id),
        fleet::effect::PhaseKey::try_new(payload.phase),
    ) {
        (Ok(id), Ok(command_id), Ok(phase)) => (id, command_id, phase),
        _ => return Delivery::Mutation(json!({"outcome":"error"})),
    };
    owner
        .fail_environment_deletion(id, command_id, phase, payload.message)
        .await
        .map_or(Delivery::Unavailable, |result| {
            mutation_result(result.map(|_| json!({"outcome":"deletionFailed"})))
        })
}

async fn lifecycle_resource_provision(
    owner: &FleetHandle,
    payload: CommandPhasePayload,
    step: u8,
) -> Delivery {
    let (id, command_id, phase) = match (
        ManagedResourceId::try_new(payload.id),
        CommandId::try_new(payload.command_id),
        fleet::effect::PhaseKey::try_new(payload.phase),
    ) {
        (Ok(id), Ok(command_id), Ok(phase)) => (id, command_id, phase),
        _ => return Delivery::Mutation(json!({"outcome":"error"})),
    };
    let result = match step {
        0 => owner.run_resource_provisioning(id, command_id, phase).await.map(|result| result.map(|outcome| json!({"outcome": match outcome { crate::fleet::lifecycle::FleetLifecycleOutcome::Completed | crate::fleet::lifecycle::FleetLifecycleOutcome::AlreadyAbsent => "provisioningCompleted", crate::fleet::lifecycle::FleetLifecycleOutcome::Rejected(_) => "provisioningFailed", crate::fleet::lifecycle::FleetLifecycleOutcome::Unknown(_) => "provisioningUnknown" }}))),
        _ => owner.complete_resource_provisioning(id, command_id, phase).await.map(|result| result.map(|_| json!({"outcome":"provisioningCompleted"}))),
    };
    result.map_or(Delivery::Unavailable, mutation_result)
}

async fn lifecycle_resource_delete(
    owner: &FleetHandle,
    payload: CommandPhasePayload,
    step: u8,
) -> Delivery {
    let (id, command_id, phase) = match (
        ManagedResourceId::try_new(payload.id),
        CommandId::try_new(payload.command_id),
        fleet::effect::PhaseKey::try_new(payload.phase),
    ) {
        (Ok(id), Ok(command_id), Ok(phase)) => (id, command_id, phase),
        _ => return Delivery::Mutation(json!({"outcome":"error"})),
    };
    let result = match step {
        0 => owner.run_resource_deletion(id, command_id, phase).await.map(|result| result.map(|outcome| json!({"outcome": match outcome { crate::fleet::lifecycle::FleetLifecycleOutcome::Completed | crate::fleet::lifecycle::FleetLifecycleOutcome::AlreadyAbsent => "deletionCompleted", crate::fleet::lifecycle::FleetLifecycleOutcome::Rejected(_) => "deletionFailed", crate::fleet::lifecycle::FleetLifecycleOutcome::Unknown(_) => "deletionUnknown" }}))),
        _ => owner.complete_resource_deletion(id, command_id, phase).await.map(|result| result.map(|_| json!({"outcome":"deletionCompleted"}))),
    };
    result.map_or(Delivery::Unavailable, mutation_result)
}

async fn lifecycle_resource_delete_fail(
    owner: &FleetHandle,
    payload: CommandFailurePayload,
) -> Delivery {
    let (id, command_id, phase) = match (
        ManagedResourceId::try_new(payload.id),
        CommandId::try_new(payload.command_id),
        fleet::effect::PhaseKey::try_new(payload.phase),
    ) {
        (Ok(id), Ok(command_id), Ok(phase)) => (id, command_id, phase),
        _ => return Delivery::Mutation(json!({"outcome":"error"})),
    };
    owner
        .fail_resource_deletion(id, command_id, phase, payload.message)
        .await
        .map_or(Delivery::Unavailable, |result| {
            mutation_result(result.map(|_| json!({"outcome":"deletionFailed"})))
        })
}

async fn lifecycle_runtime(owner: &FleetHandle, payload: CommandIdPayload, step: u8) -> Delivery {
    let (id, command_id) = match (
        RuntimeId::try_new(payload.id),
        CommandId::try_new(payload.command_id),
    ) {
        (Ok(id), Ok(command_id)) => (id, command_id),
        _ => return Delivery::Mutation(json!({"outcome":"error"})),
    };
    let result = match step {
        0 => owner.begin_runtime_start(id, command_id).await,
        1 => owner.complete_runtime_start(id, command_id).await,
        2 => owner.begin_runtime_stop(id, command_id).await,
        _ => owner.complete_runtime_stop(id, command_id).await,
    };
    result.map_or(Delivery::Unavailable, |result| {
        mutation_result(result.map(|_| json!({"outcome":"runtimeLifecycleUpdated"})))
    })
}

fn mutation_result(result: Result<Value, fleet::FleetDeliveryError>) -> Delivery {
    Delivery::Mutation(result.unwrap_or_else(|_| json!({"outcome":"error"})))
}

fn parse_connection(payload: ConnectionUpsertPayload) -> Result<ConnectionRecord, ()> {
    let id = ConnectionId::try_new(payload.id).map_err(|_| ())?;
    let kind = match payload.kind.as_str() {
        "sshHost" => ConnectionKind::SshHost,
        "container" => ConnectionKind::Container,
        "vm" => ConnectionKind::Vm,
        "kubernetesPod" => ConnectionKind::KubernetesPod,
        "custom" => ConnectionKind::Custom,
        _ => return Err(()),
    };
    let secret_refs = payload
        .secret_refs
        .into_iter()
        .map(|(name, value)| {
            fleet::FleetSecretRef::parse(&value)
                .map(|reference| (name, reference))
                .map_err(|_| ())
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    ConnectionRecord::register(
        id,
        kind,
        payload.display_name,
        payload.endpoint,
        payload.labels,
        payload.enabled,
        payload.public_config,
        secret_refs,
        SystemTime::now(),
    )
    .map_err(|_| ())
}

fn parse_environment(payload: EnvironmentRegisterPayload) -> Result<EnvironmentRecord, ()> {
    let id = EnvironmentId::try_new(payload.id).map_err(|_| ())?;
    let connection_id = ConnectionId::try_new(payload.connection_id).map_err(|_| ())?;
    let kind = match payload.kind.as_str() {
        "sshWorkdir" => EnvironmentKind::SshWorkdir,
        "dockerContainer" => EnvironmentKind::DockerContainer,
        "kubernetesWorkload" => EnvironmentKind::KubernetesWorkload,
        "vmWorkdir" => EnvironmentKind::VmWorkdir,
        "custom" => EnvironmentKind::Custom,
        _ => return Err(()),
    };
    let secret_refs = payload
        .secret_refs
        .into_iter()
        .map(|(name, value)| {
            fleet::FleetSecretRef::parse(&value)
                .map(|reference| (name, reference))
                .map_err(|_| ())
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    EnvironmentRecord::register(
        id,
        connection_id,
        payload.display_name,
        kind,
        payload.labels,
        payload.enabled,
        payload.public_config,
        secret_refs,
        SystemTime::now(),
    )
    .map_err(|_| ())
}

fn parse_resource(
    payload: ResourceRegisterPayload,
) -> Result<ManagedResourceRegistrationRequest, ()> {
    let requested_id = payload.id;
    ManagedResourceId::try_new(requested_id.clone()).map_err(|_| ())?;
    let connection_id = ConnectionId::try_new(payload.connection_id).map_err(|_| ())?;
    let environment_id = EnvironmentId::try_new(payload.environment_id).map_err(|_| ())?;
    let provider = match payload.provider.as_str() {
        "docker" => ManagedResourceProvider::Docker,
        "kubernetes" => ManagedResourceProvider::Kubernetes,
        "ssh" => ManagedResourceProvider::Ssh,
        "vm" => ManagedResourceProvider::Vm,
        "custom" => ManagedResourceProvider::Custom,
        _ => return Err(()),
    };
    let kind = match payload.kind.as_str() {
        "dockerContainer" => ManagedResourceKind::DockerContainer,
        "kubernetesWorkload" => ManagedResourceKind::KubernetesWorkload,
        "kubernetesDeployment" => ManagedResourceKind::KubernetesDeployment,
        "kubernetesService" => ManagedResourceKind::KubernetesService,
        "kubernetesSecret" => ManagedResourceKind::KubernetesSecret,
        "sshAgentInstallation" => ManagedResourceKind::SshAgentInstallation,
        "vmAgentInstallation" => ManagedResourceKind::VmAgentInstallation,
        "custom" => ManagedResourceKind::Custom,
        _ => return Err(()),
    };
    let ownership = match payload.ownership.as_str() {
        "matchaManaged" => Ownership::MatchaManaged,
        "unverified" => Ownership::Unverified,
        "external" => Ownership::External,
        _ => return Err(()),
    };
    let cleanup_policy = match payload.cleanup_policy.as_str() {
        "deleteOnEnvironmentDelete" => CleanupPolicy::DeleteOnEnvironmentDelete,
        "uninstallAgentOnly" => CleanupPolicy::UninstallAgentOnly,
        "orphan" => CleanupPolicy::Orphan,
        "none" => CleanupPolicy::None,
        _ => return Err(()),
    };
    Ok(ManagedResourceRegistrationRequest {
        requested_id,
        connection_id,
        environment_id,
        provider,
        kind,
        remote_resource_id: payload.remote_resource_id,
        ownership,
        cleanup_policy,
    })
}

fn parse_capability_sync(
    payload: CapabilitySyncPayload,
) -> Result<fleet::topology::CapabilitySync, ()> {
    let metadata = ObservationMetadata::new(
        match payload.metadata.source.as_str() {
            "discovery" => ObservationSource::Discovery,
            "healthProbe" => ObservationSource::HealthProbe,
            "runtimeAgent" => ObservationSource::RuntimeAgent,
            _ => return Err(()),
        },
        parse_timestamp(&payload.metadata.observed_at).ok_or(())?,
        match payload.metadata.freshness.as_str() {
            "current" => ObservationFreshness::Current,
            "stale" => ObservationFreshness::Stale,
            "unknown" => ObservationFreshness::Unknown,
            "pruned" => ObservationFreshness::Pruned,
            _ => return Err(()),
        },
    );
    let mut capabilities = Vec::with_capacity(payload.capabilities.len());
    let mut availability = Vec::with_capacity(payload.capabilities.len());
    for item in payload.capabilities {
        let id = CapabilityId::try_new(item.id).map_err(|_| ())?;
        let scope = match item.scope.as_str() {
            "endpoint" => CapabilityScope::Endpoint,
            "agent" => CapabilityScope::Agent,
            "session" => CapabilityScope::Session,
            _ => return Err(()),
        };
        capabilities.push(SupportedCapability::new(id, scope));
        availability.push(match item.availability.as_str() {
            "available" => CapabilityAvailability::Available,
            "unavailable" => CapabilityAvailability::Unavailable,
            "unknown" => CapabilityAvailability::Unknown,
            _ => return Err(()),
        });
    }
    Ok(fleet::topology::CapabilitySync {
        capabilities,
        availability,
        metadata,
    })
}

fn parse_timestamp(value: &str) -> Option<SystemTime> {
    let millis = value.strip_prefix("unix:")?.parse::<u64>().ok()?;
    Some(UNIX_EPOCH + std::time::Duration::from_millis(millis))
}

fn observation_metadata() -> ObservationMetadata {
    ObservationMetadata::new(
        ObservationSource::HealthProbe,
        SystemTime::now(),
        ObservationFreshness::Current,
    )
}

fn parse_topology_association(
    connection_id: Option<String>,
    environment_id: Option<String>,
    managed_resource_id: Option<String>,
) -> Result<fleet::topology::TopologyAssociation, ()> {
    Ok(fleet::topology::TopologyAssociation::new(
        connection_id
            .map(ConnectionId::try_new)
            .transpose()
            .map_err(|_| ())?,
        environment_id
            .map(EnvironmentId::try_new)
            .transpose()
            .map_err(|_| ())?,
        managed_resource_id
            .map(ManagedResourceId::try_new)
            .transpose()
            .map_err(|_| ())?,
    ))
}

fn parse_node(payload: NodeUpsertPayload) -> Result<NodeObservation, ()> {
    let association = parse_topology_association(
        payload.connection_id,
        payload.environment_id,
        payload.managed_resource_id,
    )?;
    let id = NodeId::try_new(payload.id).map_err(|_| ())?;
    let health = match payload.health.as_str() {
        "unknown" => NodeHealth::Unknown,
        "online" => NodeHealth::Online {
            last_seen_at: SystemTime::now(),
        },
        "offline" => NodeHealth::Offline {
            last_seen_at: Some(SystemTime::now()),
        },
        "disabled" => NodeHealth::Disabled,
        "error" => NodeHealth::Error,
        _ => return Err(()),
    };
    Ok(NodeObservation::with_association(
        id,
        association,
        health,
        observation_metadata(),
    ))
}

fn parse_agent(payload: AgentUpsertPayload) -> Result<AgentObservation, ()> {
    let association = parse_topology_association(
        payload.connection_id,
        payload.environment_id,
        payload.managed_resource_id,
    )?;
    let id = NativeAgentId::try_new(payload.id).map_err(|_| ())?;
    let node_id = NodeId::try_new(payload.node_id).map_err(|_| ())?;
    Ok(AgentObservation::with_association(
        id,
        node_id,
        association,
        observation_metadata(),
    ))
}

fn parse_runtime(payload: RuntimeUpsertPayload) -> Result<RuntimeObservation, ()> {
    let association = parse_topology_association(
        payload.connection_id,
        payload.environment_id,
        payload.managed_resource_id,
    )?;
    let id = RuntimeId::try_new(payload.id).map_err(|_| ())?;
    let node_id = NodeId::try_new(payload.node_id).map_err(|_| ())?;
    let agent_id = payload
        .agent_id
        .map(|value| NativeAgentId::try_new(value).map_err(|_| ()))
        .transpose()?;
    let kind = match payload.kind.as_str() {
        "openClaw" => RuntimeKind::OpenClaw,
        "matchaAgent" => RuntimeKind::MatchaAgent,
        "plugin" => RuntimeKind::Plugin,
        _ => return Err(()),
    };
    let state = match payload.state.as_str() {
        "discovered" => RuntimeState::Discovered,
        "running" => RuntimeState::Running {
            started_at: SystemTime::now(),
        },
        "stopped" => RuntimeState::Stopped {
            stopped_at: Some(SystemTime::now()),
        },
        "degraded" => RuntimeState::Degraded,
        "retired" => RuntimeState::Retired {
            retired_at: SystemTime::now(),
        },
        _ => return Err(()),
    };
    Ok(RuntimeObservation::with_association(
        id,
        node_id,
        agent_id,
        association,
        kind,
        state,
        observation_metadata(),
    ))
}

fn parse_endpoint(payload: EndpointUpsertPayload) -> Result<EndpointObservation, ()> {
    let association = parse_topology_association(
        payload.connection_id,
        payload.environment_id,
        payload.managed_resource_id,
    )?;
    let id = EndpointId::try_new(payload.id).map_err(|_| ())?;
    let node_id = NodeId::try_new(payload.node_id).map_err(|_| ())?;
    let runtime_id = RuntimeId::try_new(payload.runtime_id).map_err(|_| ())?;
    let health = match payload.health.as_str() {
        "unknown" => EndpointHealth::Unknown,
        "ready" => EndpointHealth::Ready,
        "busy" => EndpointHealth::Busy,
        "draining" => EndpointHealth::Draining,
        "unhealthy" => EndpointHealth::Unhealthy,
        "retired" => EndpointHealth::Retired,
        _ => return Err(()),
    };
    Ok(EndpointObservation::with_association(
        id,
        node_id,
        runtime_id,
        association,
        health,
        Vec::new(),
        Vec::new(),
        observation_metadata(),
    ))
}

fn parse_secret(value: Option<String>) -> Result<Option<fleet::FleetSecretRef>, ()> {
    value
        .map(|value| fleet::FleetSecretRef::parse(&value).map_err(|_| ()))
        .transpose()
}

fn parse_target_put(payload: TargetPutPayload) -> Result<(TargetId, FleetTargetConfig), ()> {
    let id = TargetId::try_new(payload.id).map_err(|_| ())?;
    let config = match payload.target {
        TargetConfigPayload::Docker {
            endpoint,
            container_name,
            image,
            secret_ref,
        } => FleetTargetConfig::Docker(
            DockerTargetConfig::try_new(endpoint, container_name, image, parse_secret(secret_ref)?)
                .map_err(|_| ())?,
        ),
        TargetConfigPayload::Kubernetes {
            api_server,
            namespace,
            deployment_name,
            service_name,
            image,
            secret_ref,
        } => FleetTargetConfig::Kubernetes(
            KubernetesTargetConfig::try_new(
                api_server,
                namespace,
                deployment_name,
                service_name,
                image,
                fleet::FleetSecretRef::parse(&secret_ref).map_err(|_| ())?,
            )
            .map_err(|_| ())?,
        ),
        TargetConfigPayload::Ssh {
            host,
            port,
            username,
            auth_kind,
            secret_ref,
            install_command,
        } => {
            let secret = fleet::FleetSecretRef::parse(&secret_ref).map_err(|_| ())?;
            let authentication = match auth_kind.as_str() {
                "privateKey" => SshAuthentication::PrivateKey(secret),
                "password" => SshAuthentication::Password(secret),
                _ => return Err(()),
            };
            FleetTargetConfig::Ssh(
                SshTargetConfig::try_new(host, port, username, authentication, install_command)
                    .map_err(|_| ())?,
            )
        }
        TargetConfigPayload::Custom {
            endpoint,
            secret_ref,
        } => FleetTargetConfig::Custom(
            CustomTargetConfig::try_new(endpoint, parse_secret(secret_ref)?).map_err(|_| ())?,
        ),
    };
    Ok((id, config))
}

fn parse_node_command_submit(
    payload: NodeCommandSubmitPayload,
) -> Result<crate::fleet::owner::FleetNodeCommandRequest, ()> {
    let kind = match payload.kind.as_str() {
        "probeNode" => CommandKind::ProbeNode,
        "installAgent" => CommandKind::InstallAgent,
        _ => return Err(()),
    };
    Ok(crate::fleet::owner::FleetNodeCommandRequest {
        node_id: NodeId::try_new(payload.node_id).map_err(|_| ())?,
        command_id: CommandId::try_new(payload.command_id).map_err(|_| ())?,
        idempotency_key: IdempotencyKey::try_new(payload.idempotency_key).map_err(|_| ())?,
        dispatch_id: DispatchId::try_new(payload.dispatch_id).map_err(|_| ())?,
        kind,
    })
}

fn parse_submit(
    payload: CommandSubmitPayload,
    selector: FleetTargetSelector,
) -> Result<fleet::FleetDeliveryRequest, ()> {
    let command_id = CommandId::try_new(payload.command_id).map_err(|_| ())?;
    let key = IdempotencyKey::try_new(payload.idempotency_key).map_err(|_| ())?;
    let target = match payload.target {
        CommandTargetPayload::Node { node_id } => {
            CommandTarget::Node(fleet::topology::NodeId::try_new(node_id).map_err(|_| ())?)
        }
        CommandTargetPayload::Runtime {
            node_id,
            runtime_id,
        } => CommandTarget::Runtime {
            node_id: fleet::topology::NodeId::try_new(node_id).map_err(|_| ())?,
            runtime_id: fleet::topology::RuntimeId::try_new(runtime_id).map_err(|_| ())?,
        },
        CommandTargetPayload::Endpoint {
            node_id,
            runtime_id,
            endpoint_id,
        } => CommandTarget::Endpoint {
            node_id: fleet::topology::NodeId::try_new(node_id).map_err(|_| ())?,
            runtime_id: fleet::topology::RuntimeId::try_new(runtime_id).map_err(|_| ())?,
            endpoint_id: EndpointId::try_new(endpoint_id).map_err(|_| ())?,
        },
    };
    let kind = match payload.kind.as_str() {
        "probeNode" => CommandKind::ProbeNode,
        "installAgent" => CommandKind::InstallAgent,
        "startRuntime" => CommandKind::StartRuntime,
        "stopRuntime" => CommandKind::StopRuntime,
        "syncCapabilities" => CommandKind::SyncCapabilities,
        "upgradeAgent" => CommandKind::UpgradeAgent,
        "mountWorkspace" => CommandKind::MountWorkspace,
        "exposePort" => CommandKind::ExposePort,
        _ => return Err(()),
    };
    let agent = NativeAgentId::try_new(payload.agent_id).map_err(|_| ())?;
    let dispatch_id = DispatchId::try_new(payload.dispatch_id).map_err(|_| ())?;
    let command = CommandIntent::new(command_id.clone(), key, target, kind, SystemTime::now());
    let dispatch = DispatchIntent::for_target(dispatch_id, command_id, agent, selector);
    fleet::FleetDeliveryRequest::try_new(command, dispatch).map_err(|_| ())
}
