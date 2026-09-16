use std::time::SystemTime;

use crate::fleet::handle::FleetHandle;

use super::dto::{Input, Operation, Request};
use super::projection::Delivery;
use super::{authorization, mutation, terminal};

enum QueryValue<T> {
    Value(T),
    Unavailable,
}

fn query_value<T>(
    result: Result<Result<T, fleet::FleetDeliveryError>, crate::RequestAdmissionClosed>,
) -> QueryValue<T> {
    match result {
        Ok(Ok(value)) => QueryValue::Value(value),
        Ok(Err(_)) | Err(_) => QueryValue::Unavailable,
    }
}

fn query_delivery<T>(
    result: Result<Result<T, fleet::FleetDeliveryError>, crate::RequestAdmissionClosed>,
    ok: impl FnOnce(T) -> Delivery,
) -> Delivery {
    match query_value(result) {
        QueryValue::Value(value) => ok(value),
        QueryValue::Unavailable => Delivery::Unavailable,
    }
}

pub(crate) async fn read(owner: &FleetHandle, request: Request) -> Delivery {
    let operation = request.operation;
    if authorization::is_mutation_operation(operation) {
        return mutation::handle(owner, operation, request.input).await;
    }
    match operation {
        Operation::TerminalList => terminal::terminal_list_delivery(owner).await,
        Operation::SelectorPreview => match request.input {
            Input::SelectorPreview { payload } => {
                let constraints = match fleet::query::SelectorConstraints::try_new(
                    payload.endpoint_ids,
                    payload.node_ids,
                    payload.runtime_ids,
                    payload.labels,
                    payload.operation_ids,
                ) {
                    Ok(constraints) => constraints,
                    Err(_) => return Delivery::Invalid,
                };
                query_delivery(
                    owner.selector_preview(constraints, SystemTime::now()).await,
                    Delivery::SelectorPreview,
                )
            }
            _ => Delivery::Unavailable,
        },
        Operation::TargetsList => query_delivery(owner.target_summaries().await, Delivery::Targets),
        Operation::TopologyGet => {
            query_delivery(owner.topology_summary().await, Delivery::Topology)
        }
        Operation::SnapshotGet => {
            query_delivery(owner.snapshot(SystemTime::now()).await, Delivery::Snapshot)
        }
        Operation::ConnectionsList
        | Operation::CapabilitiesList
        | Operation::EnvironmentsList
        | Operation::ResourcesList
        | Operation::CommandsList
        | Operation::AuditList
        | Operation::LeasesList
        | Operation::MetricsGet => {
            let snapshot = match query_value(owner.query_snapshot(SystemTime::now()).await) {
                QueryValue::Value(snapshot) => snapshot,
                QueryValue::Unavailable => return Delivery::Unavailable,
            };
            match operation {
                Operation::ConnectionsList => {
                    Delivery::Connections(snapshot.connections().to_vec())
                }
                Operation::CapabilitiesList => {
                    Delivery::Capabilities(snapshot.capabilities().to_vec())
                }
                Operation::EnvironmentsList => {
                    Delivery::Environments(snapshot.environments().to_vec())
                }
                Operation::ResourcesList => Delivery::Resources(snapshot.resources().to_vec()),
                Operation::CommandsList => Delivery::Commands(snapshot.commands().to_vec()),
                Operation::AuditList => Delivery::Audit(snapshot.audit().to_vec()),
                Operation::LeasesList => Delivery::Leases(snapshot.leases().to_vec()),
                Operation::MetricsGet => Delivery::Metrics(snapshot),
                _ => unreachable!(),
            }
        }
        _ => Delivery::Unavailable,
    }
}
