use std::{io::Write, sync::Arc};

use foundation::execution::OwnedTask;
use tokio::{sync::oneshot, time::Instant};
use world_protocol::{
    bindings::{BindingFailure, PortDirection},
    budget::{BudgetDimension, Usage},
    ids::{AcquisitionId, NodeId},
    slots::{self, SlotFailure, SlotRequest, SlotResponse},
    sources::ContractRef,
    time::Timestamp,
};

use super::{
    AdmissionFailure, BudgetFailure, CallBudget, CurrentFailure, InvocationContext, LeaseFailure,
    ResourceFailure, ResourceKind, TaskResource,
};
use crate::{
    authorization::AuthError,
    extensions::{
        host_calls::{HostCallContext, HostCallFailure, HostCallServices},
        process::{ProcessCall, ProcessError},
        wasm::{ExecutionPolicy, WasmError, WasmInvocation},
    },
    sources::connectors::SourceError,
};

#[derive(Clone)]
pub(crate) struct InvocationServices {
    pub hosts: HostCallServices,
    pub wasm: ExecutionPolicy,
    pub identity_receipt: Option<world_protocol::identity::IdentityReceipt>,
    pub abstraction: Option<Arc<crate::owner::AbstractionExecution>>,
    pub agent_bridge: Option<Arc<crate::owner::AgentBridgeExecution>>,
    pub resolver: Option<Arc<crate::owner::ResolverExecution>>,
    pub context: Option<Arc<crate::learning::investigation::ContextExecution>>,
}

pub(crate) enum DispatchedCall {
    Immediate {
        result: Result<SlotResponse, SlotFailure>,
        usage: Usage,
        host_failures: Vec<HostCallFailure>,
        source_budget: Option<CallBudget>,
    },
    Process {
        call: ProcessCall,
        source_budget: Option<CallBudget>,
    },
}

#[derive(Debug)]
pub(crate) enum InvocationFailure {
    Binding(BindingFailure),
    Schema(world_protocol::schema::SchemaFailure),
    Current(CurrentFailure),
    Host(HostCallFailure),
    Budget(BudgetFailure),
    Lease(LeaseFailure),
    Admission(AdmissionFailure),
    Source(SourceError),
    Owner(Box<crate::owner::Error>),
    Wasm(WasmError),
    Process(Arc<ProcessError>),
    Output(AuthError),
    Resource {
        primary: Option<Box<InvocationFailure>>,
        cleanup: ResourceFailure,
    },
    Join(tokio::sync::oneshot::error::RecvError),
    Meter(serde_json::Error),
    Endpoint(NodeId),
}

impl InvocationFailure {
    pub(crate) fn host_failure(&self) -> world_protocol::process::HostFailure {
        use world_protocol::{
            lifecycle::LifecycleFailure, operation::OperationFailure, process::HostFailure,
        };
        match self {
            Self::Binding(reason) => HostFailure::Binding(reason.clone()),
            Self::Current(error) => error.host_failure(),
            Self::Host(error) => error.details().clone(),
            Self::Budget(error) => HostFailure::BudgetExceeded {
                dimension: error.dimension,
            },
            Self::Lease(error) => error.host_failure(),
            Self::Admission(error) => LeaseFailure::Admission(error.clone()).host_failure(),
            Self::Source(error) => HostFailure::Source(error.failure.clone()),
            Self::Owner(error) => error.operation_failure().map_or(HostFailure::InternalFault, |failure| HostFailure::Operation(failure.details)),
            Self::Wasm(error) => error.host_failure(),
            Self::Process(error) => error.host_failure(),
            Self::Output(AuthError::Denied(reason)) => HostFailure::Authorization(reason.clone()),
            Self::Output(AuthError::Store(error)) => {
                HostFailure::Operation(OperationFailure::Commit(error.reason.clone()))
            }
            Self::Resource { .. } | Self::Join(_) => {
                HostFailure::Operation(OperationFailure::CleanupFailed)
            }
            Self::Endpoint(node_id) => HostFailure::Operation(OperationFailure::Lifecycle(
                LifecycleFailure::DependencyMissing {
                    node_id: node_id.clone(),
                },
            )),
            Self::Meter(error) if error.is_io() => HostFailure::BudgetExceeded {
                dimension: BudgetDimension::Bytes,
            },
            Self::Schema(_) | Self::Meter(_) | Self::Output(AuthError::Codec(_)) => {
                HostFailure::InternalFault
            }
        }
    }
}

impl std::fmt::Display for InvocationFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("world.invocation_failed")
    }
}

impl std::error::Error for InvocationFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Current(CurrentFailure::Authorization(error)) | Self::Output(error) => {
                Some(error)
            }
            Self::Current(CurrentFailure::Store(error)) => Some(error),
            Self::Current(CurrentFailure::Package(error)) => Some(error),
            Self::Host(error) => Some(error),
            Self::Source(error) => Some(error),
            Self::Owner(error) => Some(error.as_ref()),
            Self::Wasm(error) => Some(error),
            Self::Process(error) => Some(error.as_ref()),
            Self::Schema(error) => Some(error),
            Self::Join(error) => Some(error),
            Self::Meter(error) => Some(error),
            Self::Resource {
                primary: Some(error),
                ..
            } => Some(error.as_ref()),
            _ => None,
        }
    }
}

/// One typed dispatch against the exact leased endpoint, never a latest lookup.
pub(crate) fn invoke(
    context: InvocationContext,
    request: SlotRequest,
    contract: ContractRef,
    services: InvocationServices,
) -> futures_util::future::BoxFuture<'static, Result<DispatchedCall, InvocationFailure>> {
    Box::pin(async move {
        let binding = context
            .lease()
            .graph()
            .node(context.node())
            .map_err(InvocationFailure::Binding)?;
        let expected = slots::request_port(&request).map_err(InvocationFailure::Schema)?;
        if binding.slot != slots::request_slot(&request)
            || expected.contract != contract
            || !binding.implementation.contracts.contains(&contract)
        {
            return Err(InvocationFailure::Binding(
                BindingFailure::ContractMismatch {
                    consumer: context.node().clone(),
                    provider: context.node().clone(),
                    contract,
                },
            ));
        }
        let mut ports = binding
            .ports
            .iter()
            .filter(|port| port.direction == PortDirection::Export && port.name == expected.name);
        if ports.next() != Some(&expected) || ports.next().is_some() {
            return Err(InvocationFailure::Binding(BindingFailure::SchemaMismatch {
                consumer: context.node().clone(),
                provider: context.node().clone(),
            }));
        }
        context
            .check_current()
            .await
            .map_err(InvocationFailure::Current)?;
        let limits = context
            .lease()
            .limits(context.node())
            .ok_or_else(|| InvocationFailure::Endpoint(context.node().clone()))?;
        let mut cap = limits.budget.clone();
        cap.max_wall_time = cap.max_wall_time.min(limits.call_timeout);
        cap.deadline = Some(cap.deadline.as_ref().map_or_else(
            || context.admission().invocation().deadline.clone(),
            |deadline| {
                deadline
                    .min(&context.admission().invocation().deadline)
                    .clone()
            },
        ));
        let now = Timestamp::try_new(chrono::Utc::now().to_rfc3339())
            .map_err(|_| InvocationFailure::Endpoint(context.node().clone()))?;
        let scoped = context
            .budget()
            .scoped(&cap, &now)
            .map_err(InvocationFailure::Budget)?;
        let context = context.with_budget(scoped);
        let host_services = services
            .hosts
            .for_context(&context)
            .map_err(InvocationFailure::Host)?;
        let hosts = Arc::new(
            HostCallContext::new(context.clone(), host_services.clone())
                .map_err(InvocationFailure::Host)?,
        );
        let source_read =
            slots::request_slot(&request) == world_protocol::bindings::SlotKind::Connector;
        let source_budget =
            matches!(&request, SlotRequest::Connector(_)).then(|| context.budget().clone());
        if let Some(client) = context.lease().process(context.node()) {
            if source_read {
                context
                    .budget()
                    .charge(BudgetDimension::SourceReads, 1)
                    .map_err(InvocationFailure::Budget)?;
            }
            return client
                .call(
                    &context,
                    hosts,
                    request,
                    contract,
                    context.budget().deadline(),
                )
                .await
                .map(|call| DispatchedCall::Process {
                    call,
                    source_budget,
                })
                .map_err(InvocationFailure::Process);
        }
        if context.lease().wasm(context.node()).is_some() {
            if source_read {
                context
                    .budget()
                    .charge(BudgetDimension::SourceReads, 1)
                    .map_err(InvocationFailure::Budget)?;
            }
            let outcome = WasmInvocation::new(context, hosts, services.wasm)
                .map_err(InvocationFailure::Wasm)?
                .invoke(request)
                .await
                .map_err(InvocationFailure::Wasm)?;
            return Ok(DispatchedCall::Immediate {
                result: outcome.result,
                usage: outcome.usage,
                host_failures: outcome.host_failures,
                source_budget: None,
            });
        }
        match request {
            SlotRequest::Connector(plan) if context.lease().source(context.node()).is_some() => {
                let source = host_services
                    .source
                    .filter(|source| source.matches_invocation(context.lease(), context.node()))
                    .ok_or_else(|| InvocationFailure::Endpoint(context.node().clone()))?;
                let result = source
                    .read(
                        plan,
                        context.admission(),
                        context.pipeline(),
                        context.pipeline().cancellation(),
                        context.budget().deadline(),
                        context.budget().clone(),
                    )
                    .await
                    .map_err(InvocationFailure::Source)?;
                return Ok(DispatchedCall::Immediate {
                    result: Ok(SlotResponse::Connector(result)),
                    usage: context.budget().usage(),
                    host_failures: Vec::new(),
                    source_budget: None,
                });
            }
            SlotRequest::Identity(_) if context.lease().identity(context.node()).is_some()
                && services.identity_receipt.is_some() => {}
            SlotRequest::Schema(_) if context.lease().schema(context.node()).is_some() => {}
            SlotRequest::Compiler(_) if context.lease().compiler(context.node()).is_some() => {}
            SlotRequest::Policy(_) if context.lease().policy(context.node()).is_some() => {}
            SlotRequest::Provenance(_) if context.lease().provenance(context.node()).is_some() => {}
            SlotRequest::Action(_) if context.lease().action(context.node()).is_some() => {}
            SlotRequest::Evaluation(_) if context.lease().evaluation(context.node()).is_some() => {}
            SlotRequest::Projection(_) if context.lease().projection(context.node()).is_some() => {}
            SlotRequest::Reconcile(_) if context.lease().reconcile(context.node()).is_some() => {}
            SlotRequest::Abstraction(_) if context.lease().abstraction(context.node()).is_some()
                && services.abstraction.is_some() => {}
            SlotRequest::AgentBridge(_) if context.lease().agent_bridge(context.node()).is_some()
                && services.agent_bridge.is_some() => {}
            SlotRequest::Storage(_) if context.lease().storage(context.node()).is_some() => {}
            SlotRequest::Resolver(_) if context.lease().resolver(context.node()).is_some()
                && services.resolver.is_some() => {}
            SlotRequest::Context(_) if context.lease().context(context.node()).is_some()
                && services.context.is_some() => {}
            _ => return Err(InvocationFailure::Endpoint(context.node().clone())),
        }
        native(context, request, services).await
    })
}

fn native(
    context: InvocationContext,
    request: SlotRequest,
    services: InvocationServices,
) -> futures_util::future::BoxFuture<'static, Result<DispatchedCall, InvocationFailure>> {
    // Resolver queries dispatch nested calls; erase this recursive future's type, not its custody.
    Box::pin(async move {
        let ledger = context
            .lease()
            .ledger(context.node())
            .expect("checked identity endpoint");
        let spec = context
            .lease()
            .resource_spec(context.node(), ResourceKind::TaskJoin)
            .expect("checked identity endpoint");
        let ticket = ledger
            .begin_acquisition(
                AcquisitionId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID acquisition"),
                spec,
            )
            .map_err(InvocationFailure::Admission)?;
        let permit = match context.lease().try_call(context.node()) {
            Ok(permit) => permit,
            Err(error) => {
                ticket.fail();
                return Err(InvocationFailure::Lease(error));
            }
        };
        let cleanup_deadline = context.budget().deadline();
        let (send, receive) = oneshot::channel();
        let (task, _) = OwnedTask::spawn(move |cancel| Box::pin(async move {
            let result = async {
                if cancel.is_cancelled() || context.pipeline().is_cancelled() {
                    return Err(InvocationFailure::Admission(AdmissionFailure::Closed));
                }
                context
                    .check_current()
                    .await
                    .map_err(InvocationFailure::Current)?;
                context
                    .budget()
                    .charge(BudgetDimension::Steps, 1)
                    .map_err(InvocationFailure::Budget)?;
                let result = match request {
                    SlotRequest::Identity(request) => context.lease().identity(context.node())
                        .expect("checked identity endpoint").propose(&request,
                            services.identity_receipt.as_ref().expect("checked identity receipt"))
                        .map(SlotResponse::Identity).map_err(SlotFailure::Identity),
                    SlotRequest::Schema(request) => context.lease().schema(context.node())
                        .expect("checked schema endpoint").compile(&request)
                        .map(SlotResponse::Schema).map_err(SlotFailure::Schema),
                    SlotRequest::Compiler(request) => context.lease().compiler(context.node())
                        .expect("checked compiler endpoint").compile(&request)
                        .map(SlotResponse::Compiler).map_err(SlotFailure::Compiler),
                    SlotRequest::Provenance(request) => context.lease().provenance(context.node())
                        .expect("checked provenance endpoint").recompute(&request)
                        .map(SlotResponse::Provenance).map_err(SlotFailure::Provenance),
                    SlotRequest::Action(request) => context.lease().action(context.node())
                        .expect("checked action endpoint").plan(&request)
                        .map(SlotResponse::Action).map_err(SlotFailure::Action),
                    SlotRequest::Evaluation(request) => context.lease().evaluation(context.node())
                        .expect("checked evaluation endpoint").evaluate(&context, &request, cancel.clone(),
                            context.budget().deadline()).await?
                        .map(SlotResponse::Evaluation).map_err(SlotFailure::Evaluation),
                    SlotRequest::Projection(request) => context.lease().projection(context.node())
                        .expect("checked projection endpoint").project(&request, context.budget(), &cancel)
                        .map(SlotResponse::Projection).map_err(SlotFailure::Projection),
                    SlotRequest::Reconcile(request) => context.lease().reconcile(context.node())
                        .expect("checked reconcile endpoint").reconcile(&request, context.budget(), &cancel)
                        .map(SlotResponse::Reconcile).map_err(SlotFailure::Reconcile),
                    SlotRequest::Policy(request) => match context.lease().policy(context.node())
                        .expect("checked policy endpoint").evaluate(&context, &request).await {
                            Ok(result) => Ok(SlotResponse::Policy(result)),
                            Err(CurrentFailure::Authorization(AuthError::Denied(reason))) => Err(SlotFailure::Policy(reason)),
                            Err(error) => return Err(InvocationFailure::Current(error)),
                        },
                    SlotRequest::Abstraction(request) => context.lease().abstraction(context.node())
                        .expect("checked abstraction endpoint").abstract_plan(&context, &request,
                            services.abstraction.as_deref().expect("checked abstraction service"), cancel.clone(),
                            context.budget().deadline()).await
                        .map(SlotResponse::Abstraction)
                        .map_err(|error| InvocationFailure::Owner(Box::new(error)))
                        .map(Ok)?,
                    SlotRequest::AgentBridge(request) => context.lease().agent_bridge(context.node())
                        .expect("checked agent bridge endpoint").dispatch(&context, &request,
                            services.agent_bridge.as_deref().expect("checked agent bridge service"), cancel.clone(),
                            context.budget().deadline()).await
                        .map(SlotResponse::AgentBridge)
                        .map_err(|error| InvocationFailure::Owner(Box::new(error)))
                        .map(Ok)?,
                    SlotRequest::Storage(request) => context.lease().storage(context.node())
                        .expect("checked storage endpoint").read(&context, &request).await
                        .map(SlotResponse::Storage)
                        .map_err(|error| InvocationFailure::Owner(Box::new(error)))
                        .map(Ok)?,
                    SlotRequest::Resolver(request) => context.lease().resolver(context.node())
                        .expect("checked resolver endpoint").resolve(&context, &request,
                            services.resolver.as_deref().expect("checked resolver service"), cancel.clone(),
                            context.budget().deadline()).await
                        .map(SlotResponse::Resolver)
                        .map_err(|error| InvocationFailure::Owner(Box::new(error)))
                        .map(Ok)?,
                    SlotRequest::Context(request) => context.lease().context(context.node())
                        .expect("checked context endpoint").build(&context, &request,
                            services.context.as_deref().expect("checked context service"), cancel.clone(),
                            context.budget().deadline()).await
                        .map(SlotResponse::Context)
                        .map_err(|error| InvocationFailure::Owner(Box::new(error)))
                        .map(Ok)?,
                    _ => return Err(InvocationFailure::Endpoint(context.node().clone())),
                };
                context
                    .check_current()
                    .await
                    .map_err(InvocationFailure::Current)?;
                let mut counter = OutputCounter {
                    bytes: 0,
                    maximum: context.budget().limit().max_bytes,
                };
                serde_json::to_writer(&mut counter, &result).map_err(InvocationFailure::Meter)?;
                context
                    .budget()
                    .charge(BudgetDimension::Bytes, counter.bytes)
                    .map_err(InvocationFailure::Budget)?;
                context
                    .check_output(u64::from(result.is_ok()))
                    .await
                    .map_err(InvocationFailure::Output)?;
                context
                    .budget()
                    .check()
                    .map_err(InvocationFailure::Budget)?;
                Ok(DispatchedCall::Immediate {
                    result,
                    usage: context.budget().usage(),
                    host_failures: Vec::new(),
                    source_budget: None,
                })
            }
            .await;
            let _ = send.send(result);
        }));
        let acquired = ticket.complete(Box::new(
            TaskResource::new(task, |_| Ok(())).with_permit(permit),
        ));
        let mut registration = acquired.registration;
        let _cancel = CancelOnDrop(registration.cancellation().clone());
        let result = receive
            .await
            .map_err(InvocationFailure::Join)
            .and_then(|result| result);
        match registration
            .close_checked(cleanup_deadline.max(Instant::now()))
            .await
        {
            Ok(()) => result,
            Err(cleanup) => Err(InvocationFailure::Resource {
                primary: result.err().map(Box::new),
                cleanup,
            }),
        }
    })
}

struct CancelOnDrop(tokio_util::sync::CancellationToken);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
struct OutputCounter {
    bytes: u64,
    maximum: u64,
}
impl Write for OutputCounter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.bytes = self
            .bytes
            .checked_add(bytes.len() as u64)
            .filter(|total| *total <= self.maximum)
            .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::FileTooLarge))?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
