use std::sync::{Arc, Mutex};

use foundation::execution::OwnedTask;
use tokio::{sync::oneshot, time::Instant};
use tokio_util::sync::CancellationToken;
use wasm_host::{CallControl, CallState, ExecutionError, FailureKind, Stage, wasmtime};
use world_protocol::{
    bindings::{BindingFailure, PortDirection, SlotKind},
    budget::{Budget, BudgetDimension, Usage},
    ids::AcquisitionId,
    slots::{self, SlotFailure, SlotRequest, SlotResponse},
};

use super::{
    ExecutionPolicy, WasmError,
    host::{self, InvocationHost},
    limits::EffectiveLimits,
};
use crate::{
    extensions::{
        host_calls::{HostCallContext, HostCallFailure},
        invocation::{InvocationContext, ResourceFailure, ResourceKind, ResourceStage, TaskResource},
    },
    store::StoreFuture,
};

pub(crate) struct CallOutcome<T> {
    pub result: T,
    pub usage: Usage,
    pub host_failures: Vec<HostCallFailure>,
}

pub(crate) struct WasmInvocation {
    context: InvocationContext,
    hosts: Arc<HostCallContext>,
    policy: ExecutionPolicy,
}

impl WasmInvocation {
    pub fn new(
        context: InvocationContext,
        hosts: Arc<HostCallContext>,
        policy: ExecutionPolicy,
    ) -> Result<Self, WasmError> {
        if !hosts.matches(&context) || context.lease().wasm(context.node()).is_none() {
            return Err(WasmError::LeaseMismatch);
        }
        Ok(Self {
            context,
            hosts,
            policy,
        })
    }

    pub async fn invoke(
        self,
        mut request: SlotRequest,
    ) -> Result<CallOutcome<Result<SlotResponse, SlotFailure>>, WasmError> {
        let slot = slots::request_slot(&request);
        let expected = slots::request_port(&request).map_err(WasmError::Schema)?;
        let binding = self.context.lease().graph().node(self.context.node())?;
        if binding.slot != slot
            || !binding
                .implementation
                .contracts
                .contains(&expected.contract)
        {
            return Err(BindingFailure::ContractMismatch {
                consumer: self.context.node().clone(),
                provider: self.context.node().clone(),
                contract: expected.contract,
            }
            .into());
        }
        let mut ports = binding
            .ports
            .iter()
            .filter(|port| port.direction == PortDirection::Export && port.name == expected.name);
        if ports.next() != Some(&expected) || ports.next().is_some() {
            return Err(BindingFailure::SchemaMismatch {
                consumer: self.context.node().clone(),
                provider: self.context.node().clone(),
            }
            .into());
        }
        let requested = request_budget(&mut request)
            .cloned()
            .unwrap_or_else(|| self.context.budget().limit());
        let mut limits = self.limits(&requested)?;
        if let Some(budget) = request_budget(&mut request) {
            *budget = limits.budget.clone();
        }
        super::validate::request(&self.context, &request).await?;
        super::meter::charge(self.context.budget(), &request, limits.budget.max_bytes)?;
        let remaining = usize::try_from(self.context.budget().remaining(BudgetDimension::Bytes)?)
            .unwrap_or(usize::MAX);
        limits.store.output_bytes = limits.store.output_bytes.min(remaining);
        limits.store.lift_bytes = limits.store.lift_bytes.min(remaining);
        self.run(slot, limits, request).await
    }

    fn limits(&self, request: &Budget) -> Result<EffectiveLimits, WasmError> {
        let prepared = self
            .context
            .lease()
            .wasm(self.context.node())
            .ok_or(WasmError::LeaseMismatch)?;
        let mut limits = self.policy.intersect(prepared.limits(), request)?;
        let deadline = &self.context.admission().invocation().deadline;
        limits.budget.deadline = Some(
            limits
                .budget
                .deadline
                .as_ref()
                .map_or_else(|| deadline.clone(), |value| value.min(deadline).clone()),
        );
        self.context
            .budget()
            .restrict(&limits.budget, &host::now()?)?;
        limits.budget = self.context.budget().limit();
        limits.store.fuel = limits
            .store
            .fuel
            .min(self.context.budget().remaining(BudgetDimension::Steps)?);
        let bytes = usize::try_from(self.context.budget().remaining(BudgetDimension::Bytes)?)
            .unwrap_or(usize::MAX);
        limits.store.output_bytes = limits.store.output_bytes.min(bytes);
        limits.store.lift_bytes = limits.store.lift_bytes.min(bytes);
        limits.deadline = limits
            .deadline
            .min(self.context.budget().deadline().into_std());
        Ok(limits)
    }

    async fn run(
        self,
        slot: SlotKind,
        limits: EffectiveLimits,
        request: SlotRequest,
    ) -> Result<CallOutcome<Result<SlotResponse, SlotFailure>>, WasmError> {
        let context = self.context;
        context.budget().check()?;
        let prepared = context
            .lease()
            .wasm(context.node())
            .cloned()
            .ok_or(WasmError::LeaseMismatch)?;
        let binding = context.lease().graph().node(context.node())?;
        if binding.slot != slot || &binding.implementation != prepared.implementation() {
            return Err(WasmError::LeaseMismatch);
        }
        context.check_current().await?;
        let ledger = context
            .lease()
            .ledger(context.node())
            .cloned()
            .ok_or(WasmError::LeaseMismatch)?;
        let task_spec = context
            .lease()
            .resource_spec(context.node(), ResourceKind::TaskJoin)
            .ok_or(WasmError::LeaseMismatch)?;
        let store_spec = context
            .lease()
            .resource_spec(context.node(), ResourceKind::Store)
            .ok_or(WasmError::LeaseMismatch)?;
        let lease_cancel = context
            .lease()
            .cancellation(context.node())
            .cloned()
            .ok_or(WasmError::LeaseMismatch)?;
        let pipeline_cancel = context.pipeline().cancellation();
        let ticket = ledger.begin_acquisition(acquisition(), task_spec)?;
        let permit = match context.lease().try_call(context.node()) {
            Ok(permit) => permit,
            Err(error) => {
                ticket.fail();
                return Err(error.into());
            }
        };
        let store_registration = match ledger.register(store_spec) {
            Ok(registration) => registration,
            Err(error) => {
                ticket.fail();
                return Err(error.into());
            }
        };
        let resource_cancel = ticket.cancellation().clone();
        let store_cancel = store_registration.cancellation().clone();
        let quarantine = ledger.cleanup_control();
        let control = CallControl::new(CancellationToken::new(), limits.deadline);
        let failures = Arc::new(Mutex::new(Vec::new()));
        let diagnostics = failures.clone();
        let budget = context.budget().clone();
        let host = InvocationHost {
            hosts: self.hosts,
            call_id: uuid::Uuid::new_v4(),
            import_sequence: 0,
            context,
            config: prepared.config().clone(),
            control: control.clone(),
            io_timeout: limits.host_io_timeout,
            maximum_bytes: limits.budget.max_bytes,
            io_deadline: limits.deadline.into(),
            store_registration,
            failures,
        };
        let (send, receive) = oneshot::channel();
        let (task, _) = OwnedTask::spawn(move |task_cancel| async move {
            let _permit = permit;
            let engine = prepared.engine.clone();
            let component = prepared.component.clone();
            let work = engine.invoke(
                &component,
                host,
                limits.store,
                control.clone(),
                move |store| {
                    Box::pin(async move {
                        let result = async {
                            store.data().host().recheck().await?;
                            let result = super::invoke::invoke(&prepared, store, request).await?;
                            store.data().host().recheck().await?;
                            store.data().host().context.budget().check()?;
                            Ok::<_, WasmError>(result)
                        }
                        .await;
                        // A failed invocation still consumed fuel; preserve both failures.
                        let charged = store
                            .get_fuel()
                            .map_err(|cause| WasmError::Execution(call(cause)))
                            .and_then(|remaining| {
                                store
                                    .data()
                                    .host()
                                    .context
                                    .budget()
                                    .charge(
                                        BudgetDimension::Steps,
                                        limits.store.fuel.saturating_sub(remaining),
                                    )
                                    .map_err(WasmError::Budget)
                            });
                        match (result, charged) {
                            (Ok(result), Ok(())) => Ok(result),
                            (Err(primary), Ok(())) => Err(host_error(primary)),
                            (Ok(_), Err(failure)) => Err(host_error(failure)),
                            (Err(primary), Err(failure)) => {
                                Err(host_error(WasmError::Accounting {
                                    primary: Box::new(primary),
                                    failure: Box::new(failure),
                                }))
                            }
                        }
                    })
                },
                cleanup,
            );
            tokio::pin!(work);
            let result = tokio::select! {
                biased;
                _ = resource_cancel.cancelled() => { control.cancellation().cancel(); work.await },
                _ = store_cancel.cancelled() => { control.cancellation().cancel(); work.await },
                _ = lease_cancel.cancelled() => { control.cancellation().cancel(); work.await },
                _ = pipeline_cancel.cancelled() => { control.cancellation().cancel(); work.await },
                _ = task_cancel.cancelled() => { control.cancellation().cancel(); work.await },
                _ = quarantine.quarantined() => { control.cancellation().cancel(); work.await },
                result = &mut work => result,
            };
            let checked = if result.as_ref().is_err_and(|error| error.cleanup.is_some()) {
                Err(ResourceFailure::new(
                    ResourceStage::Cleanup,
                    "wasm_host_cleanup",
                    "Wasm host resources have not completed checked cleanup",
                ))
            } else {
                Ok(())
            };
            let host_failures =
                std::mem::take(&mut *diagnostics.lock().expect("world wasm diagnostics poisoned"));
            let result = match result {
                Ok(result) => Ok(CallOutcome {
                    result,
                    usage: budget.usage(),
                    host_failures,
                }),
                Err(error) if host_failures.is_empty() => Err(WasmError::Invocation(error)),
                Err(error) => Err(WasmError::HostFailures {
                    primary: Box::new(WasmError::Invocation(error)),
                    host_failures,
                }),
            };
            let _ = send.send(result);
            checked
        });
        let acquired = ticket.complete(Box::new(TaskResource::new(task, |checked| checked)));
        let mut registration = acquired.registration;
        let _cancel_on_drop = CancelOnDrop(registration.cancellation().clone());
        let result = receive
            .await
            .map_err(WasmError::Join)
            .and_then(|result| result);
        let joined = registration
            .close_checked(Instant::now() + limits.cleanup_timeout)
            .await;
        match (result, joined) {
            (Ok(result), Ok(())) => Ok(result),
            (result, Err(cleanup)) => Err(WasmError::Release {
                primary: result.err().map(Box::new),
                cleanup,
            }),
            (Err(error), Ok(())) => Err(error),
        }
    }
}

fn request_budget(request: &mut SlotRequest) -> Option<&mut Budget> {
    match request {
        SlotRequest::Resolver(value) => Some(&mut value.budget),
        SlotRequest::Projection(value) => Some(&mut value.budget),
        SlotRequest::Reconcile(value) => Some(&mut value.budget),
        SlotRequest::Abstraction(value) => Some(&mut value.budget),
        SlotRequest::Evaluation(value) => Some(&mut value.budget),
        SlotRequest::Context(value) => Some(&mut value.budget),
        _ => None,
    }
}

#[inline(never)]
pub(super) fn account<'a, R: serde::Serialize + Sync>(
    store: &'a mut wasmtime::Store<CallState<InvocationHost>>,
    value: &'a R,
    delivered: u64,
) -> StoreFuture<'a, (), WasmError> {
    Box::pin(async move {
        let host = store.data().host();
        host.context.budget().check()?;
        host.recheck().await?;
        let bytes = super::meter::charge(host.context.budget(), value, host.maximum_bytes)?;
        host.context.check_output(delivered).await?;
        store.data_mut().charge_output(bytes)?;
        Ok(())
    })
}
fn cleanup(state: CallState<InvocationHost>) -> wasm_host::CleanupFuture {
    Box::pin(async move {
        let (host, table) = state.into_parts();
        if !table.is_empty() {
            let failure = ResourceFailure::new(
                ResourceStage::Cleanup,
                "wasm_resources_remaining",
                "unexpected host resources remain in the component table",
            );
            host.store_registration.retain(failure.clone());
            return Err(ExecutionError::with_cause(
                Stage::Cleanup,
                FailureKind::Cleanup,
                wasmtime::Error::new(WasmError::Cleanup(failure)),
            ));
        }
        drop(table);
        host.store_registration.finish();
        Ok(())
    })
}
struct CancelOnDrop(CancellationToken);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
fn acquisition() -> AcquisitionId {
    AcquisitionId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID acquisition")
}
pub(super) fn instantiate(cause: wasmtime::Error) -> ExecutionError {
    ExecutionError::from_wasmtime(Stage::Instantiate, cause)
}
pub(super) fn call(cause: wasmtime::Error) -> ExecutionError {
    ExecutionError::from_wasmtime(Stage::Call, cause)
}
pub(super) fn host_error(error: WasmError) -> ExecutionError {
    match error {
        WasmError::Execution(error) => error,
        error => ExecutionError::with_cause(
            Stage::HostIo,
            FailureKind::HostCall,
            wasmtime::Error::new(error),
        ),
    }
}
