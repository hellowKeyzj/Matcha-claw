use std::{future::Future, pin::Pin, time::Instant};

use tokio_util::sync::CancellationToken;
use wasmtime::{
    ResourceLimiter, Store, UpdateDeadline,
    component::{ResourceTable, ResourceTableError},
};

use crate::{Engine, ExecutionError, FailureKind, InvocationError, Resource, Stage};

pub type CallFuture<'a, R> = Pin<Box<dyn Future<Output = Result<R, ExecutionError>> + Send + 'a>>;
pub type CleanupFuture = Pin<Box<dyn Future<Output = Result<(), ExecutionError>> + Send>>;

/// All budgets are installed before the owner can instantiate or call a guest.
#[derive(Clone, Copy, Debug)]
pub struct ExecutionLimits {
    pub fuel: u64,
    pub fuel_yield_interval: u64,
    pub memory_bytes_per_memory: usize,
    pub memories: usize,
    pub table_elements_per_table: usize,
    pub tables: usize,
    pub instances: usize,
    pub component_handles: usize,
    pub host_resources: usize,
    /// Wasmtime's per-lift allocation fuel, not the cumulative output budget.
    pub lift_bytes: usize,
    pub output_bytes: usize,
}

#[derive(Clone)]
pub struct CallControl {
    cancellation: CancellationToken,
    guest_deadline: Instant,
}

impl CallControl {
    pub fn new(cancellation: CancellationToken, guest_deadline: Instant) -> Self {
        Self {
            cancellation,
            guest_deadline,
        }
    }

    pub fn cancellation(&self) -> &CancellationToken {
        &self.cancellation
    }

    pub fn deadline(&self) -> Instant {
        self.guest_deadline
    }

    pub fn check_guest(&self, stage: Stage) -> Result<(), ExecutionError> {
        if self.cancellation.is_cancelled() {
            Err(ExecutionError::new(stage, FailureKind::Cancelled))
        } else if Instant::now() >= self.guest_deadline {
            Err(ExecutionError::new(stage, FailureKind::GuestDeadline))
        } else {
            Ok(())
        }
    }

    /// The operation must observe its child token and finish its own I/O/tasks.
    /// A deadline requests cancellation and then awaits actual exit; it does not
    /// drop a running future and pretend that an external effect did not occur.
    pub async fn host_io<R, F, U>(
        &self,
        deadline: Instant,
        operation: F,
    ) -> Result<R, ExecutionError>
    where
        F: FnOnce(CancellationToken) -> U,
        U: Future<Output = wasmtime::Result<R>>,
    {
        if self.cancellation.is_cancelled() {
            return Err(ExecutionError::new(
                Stage::HostIo,
                FailureKind::HostIoCancelled,
            ));
        }
        if Instant::now() >= deadline {
            return Err(ExecutionError::new(
                Stage::HostIo,
                FailureKind::HostIoDeadline,
            ));
        }
        let cancellation = self.cancellation.child_token();
        let work = operation(cancellation.clone());
        tokio::pin!(work);
        tokio::select! {
            biased;
            result = &mut work => return result.map_err(|cause| {
                ExecutionError::from_wasmtime(Stage::HostIo, cause)
            }),
            _ = self.cancellation.cancelled() => {},
            _ = tokio::time::sleep_until(deadline.into()) => {},
        };
        cancellation.cancel();
        // The producer owns the outcome: cancellation cannot undo a committed result.
        work.await
            .map_err(|cause| ExecutionError::from_wasmtime(Stage::HostIo, cause))
    }
}

pub struct CallState<T> {
    host: Option<T>,
    pub table: ResourceTable,
    pub control: CallControl,
    limiter: Limiter,
    output_limit: usize,
    output_used: usize,
}

impl<T> CallState<T> {
    fn new(host: Option<T>, limits: ExecutionLimits, control: CallControl) -> Self {
        let mut table = ResourceTable::new();
        table.set_max_capacity(limits.host_resources);
        Self {
            host,
            table,
            control,
            limiter: Limiter { limits },
            output_limit: limits.output_bytes,
            output_used: 0,
        }
    }

    pub fn host(&self) -> &T {
        self.host
            .as_ref()
            .expect("host installed before owner access")
    }

    pub fn host_mut(&mut self) -> &mut T {
        self.host
            .as_mut()
            .expect("host installed before owner access")
    }

    pub fn into_parts(self) -> (T, ResourceTable) {
        (
            self.host.expect("host installed before owner access"),
            self.table,
        )
    }

    pub fn charge_output(&mut self, bytes: usize) -> Result<(), ExecutionError> {
        let requested = self.output_used.saturating_add(bytes);
        if bytes > self.output_limit - self.output_used {
            return Err(exceeded(
                Stage::Call,
                Resource::OutputBytes,
                self.output_limit,
                requested,
            ));
        }
        self.output_used = requested;
        Ok(())
    }

    pub fn resource_error(&self, cause: ResourceTableError) -> ExecutionError {
        let kind = match cause {
            ResourceTableError::Full => FailureKind::ResourceExceeded {
                resource: Resource::HostResources,
                limit: self.limiter.limits.host_resources,
                requested: self.limiter.limits.host_resources.saturating_add(1),
            },
            _ => FailureKind::HostCall,
        };
        ExecutionError::with_cause(Stage::HostIo, kind, wasmtime::Error::new(cause))
    }
}

impl Engine {
    fn check_resources(
        &self,
        component: &wasmtime::component::Component,
        limits: ExecutionLimits,
    ) -> Result<(), ExecutionError> {
        if !wasmtime::Engine::same(self.raw_engine(), component.engine()) {
            return Err(ExecutionError::new(
                Stage::Instantiate,
                FailureKind::EngineMismatch,
            ));
        }
        // Imported core modules cannot be summarized by this public API. Their
        // actual allocations still pass through the already-installed limiter.
        if let Some(resources) = component.resources_required() {
            for (resource, limit, requested) in [
                (
                    Resource::Memories,
                    limits.memories,
                    resources.num_memories as usize,
                ),
                (
                    Resource::Tables,
                    limits.tables,
                    resources.num_tables as usize,
                ),
            ] {
                if requested > limit {
                    return Err(exceeded(Stage::Instantiate, resource, limit, requested));
                }
            }
        }
        Ok(())
    }

    /// Await inside the owner's tracked Foundation task. Cancel through the token,
    /// then keep awaiting: dropping this future cannot perform asynchronous join.
    /// `execute` uses exact owner bindings and labels instantiate/call failures.
    /// `cleanup` owns the recovered host state and must cancel/join host resources;
    /// it must never re-enter guest code. It runs on success and every error path.
    pub async fn invoke<T, R, F, C>(
        &self,
        component: &wasmtime::component::Component,
        host: T,
        limits: ExecutionLimits,
        control: CallControl,
        execute: F,
        cleanup: C,
    ) -> Result<R, InvocationError>
    where
        T: Send + 'static,
        R: Send,
        F: for<'a> FnOnce(&'a mut Store<CallState<T>>) -> CallFuture<'a, R>,
        C: FnOnce(CallState<T>) -> CleanupFuture,
    {
        // Keep owner resources outside fallible Store allocation so an allocation
        // error still reaches the same asynchronous cleanup boundary.
        let state = CallState::new(None, limits, control.clone());
        let mut store = match Store::try_new(self.raw_engine(), state) {
            Ok(store) => store,
            Err(cause) => {
                let execution = ExecutionError::from_wasmtime(Stage::Configure, cause);
                let cleanup = cleanup(CallState::new(Some(host), limits, control))
                    .await
                    .err();
                return Err(InvocationError {
                    execution: Some(execution),
                    cleanup,
                });
            }
        };
        store.data_mut().host = Some(host);
        store.limiter(|state| &mut state.limiter);
        let configured = if limits.fuel_yield_interval == 0 {
            Err(ExecutionError::new(
                Stage::Configure,
                FailureKind::InvalidLimit,
            ))
        } else {
            store
                .set_fuel(limits.fuel)
                .and_then(|()| store.fuel_async_yield_interval(Some(limits.fuel_yield_interval)))
                .map_err(|cause| ExecutionError::from_wasmtime(Stage::Configure, cause))
        };
        store.set_hostcall_fuel(limits.lift_bytes);
        store.set_max_component_handles(limits.component_handles);
        store.set_epoch_deadline(1);
        store.epoch_deadline_callback(|store| {
            store
                .data()
                .control
                .check_guest(Stage::Call)
                .map_err(wasmtime::Error::new)?;
            Ok(UpdateDeadline::Yield(1))
        });
        let result = match configured
            .and_then(|()| self.check_resources(component, limits))
            .and_then(|()| control.check_guest(Stage::Instantiate))
        {
            Ok(()) => match execute(&mut store).await {
                Ok(output) => control.check_guest(Stage::Call).map(|()| output),
                Err(error) => Err(error),
            },
            Err(error) => Err(error),
        };
        // into_data destroys the runtime instances; no guest destructor is invoked.
        let cleanup = cleanup(store.into_data()).await.err();
        match (result, cleanup) {
            (Ok(output), None) => Ok(output),
            (result, cleanup) => Err(InvocationError {
                execution: result.err(),
                cleanup,
            }),
        }
    }
}

fn exceeded(stage: Stage, resource: Resource, limit: usize, requested: usize) -> ExecutionError {
    ExecutionError::new(
        stage,
        FailureKind::ResourceExceeded {
            resource,
            limit,
            requested,
        },
    )
}

struct Limiter {
    limits: ExecutionLimits,
}

impl ResourceLimiter for Limiter {
    fn memory_growing(
        &mut self,
        _: usize,
        desired: usize,
        _: Option<usize>,
    ) -> wasmtime::Result<bool> {
        if desired > self.limits.memory_bytes_per_memory {
            return Err(wasmtime::Error::new(exceeded(
                Stage::Instantiate,
                Resource::MemoryBytes,
                self.limits.memory_bytes_per_memory,
                desired,
            )));
        }
        Ok(true)
    }

    fn table_growing(
        &mut self,
        _: usize,
        desired: usize,
        _: Option<usize>,
    ) -> wasmtime::Result<bool> {
        if desired > self.limits.table_elements_per_table {
            return Err(wasmtime::Error::new(exceeded(
                Stage::Instantiate,
                Resource::TableElements,
                self.limits.table_elements_per_table,
                desired,
            )));
        }
        Ok(true)
    }

    fn memory_grow_failed(&mut self, cause: wasmtime::Error) -> wasmtime::Result<()> {
        Err(cause)
    }
    fn table_grow_failed(&mut self, cause: wasmtime::Error) -> wasmtime::Result<()> {
        Err(cause)
    }
    fn instances(&self) -> usize {
        self.limits.instances
    }
    fn memories(&self) -> usize {
        self.limits.memories
    }
    fn tables(&self) -> usize {
        self.limits.tables
    }
}
