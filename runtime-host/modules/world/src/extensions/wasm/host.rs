use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use futures_util::future::BoxFuture;
use tokio::time::Instant;
use wasm_host::{
    CallControl, CallState, Engine, ExecutionError, Stage,
    wasmtime::{self, component::Linker},
};
use world_protocol::{
    api::PackageConfigView,
    failure::Failure,
    process::{HostFailure, HostRequest, HostResponse},
    time::Timestamp,
};

use super::{WasmError, bindings, convert::Wire};
use crate::{
    authorization::AuthError,
    extensions::{
        host_calls::{HostCallContext, HostCallFailure},
        invocation::{CurrentFailure, InvocationContext, Registration},
    },
};

pub(super) struct InvocationHost {
    pub hosts: Arc<HostCallContext>,
    pub context: InvocationContext,
    pub config: PackageConfigView,
    pub control: CallControl,
    pub io_timeout: Duration,
    pub maximum_bytes: u64,
    pub io_deadline: Instant,
    pub store_registration: Registration,
    pub failures: Arc<Mutex<Vec<HostCallFailure>>>,
    pub call_id: uuid::Uuid,
    pub import_sequence: u64,
}

impl InvocationHost {
    pub async fn recheck(&self) -> Result<(), CurrentFailure> {
        self.context.check_current().await
    }

    pub fn io_deadline(&self) -> Instant {
        (Instant::now() + self.io_timeout)
            .min(self.io_deadline)
            .min(self.context.budget().deadline())
    }
}

pub(super) fn linker(engine: &Engine) -> Result<Linker<CallState<InvocationHost>>, WasmError> {
    let mut linker = Linker::new(engine.raw_engine());
    bindings::projection::ProjectionPlugin::add_to_linker::<_, wasmtime::component::HasSelf<_>>(
        &mut linker,
        |state| state,
    )
    .map_err(|cause| ExecutionError::from_wasmtime(Stage::Link, cause))?;
    Ok(linker)
}

impl bindings::types::Host for CallState<InvocationHost> {}

impl bindings::config::Host for CallState<InvocationHost> {
    async fn read(
        &mut self,
    ) -> wasmtime::Result<Result<bindings::types::PackageConfig, bindings::types::ConfigReadFailure>>
    {
        self.control
            .check_guest(Stage::HostIo)
            .map_err(wasmtime::Error::new)?;
        self.host()
            .recheck()
            .await
            .map_err(|cause| wasmtime::Error::new(WasmError::Current(cause)))?;
        let config = self.host().config.clone();
        let bytes = super::meter::charge(
            self.host().context.budget(),
            &config,
            self.host().maximum_bytes,
        )
        .map_err(wasmtime::Error::new)?;
        self.host()
            .context
            .check_output(1)
            .await
            .map_err(|cause| wasmtime::Error::new(WasmError::Authorization(cause)))?;
        self.host()
            .recheck()
            .await
            .map_err(|cause| wasmtime::Error::new(WasmError::Current(cause)))?;
        self.control
            .check_guest(Stage::HostIo)
            .map_err(wasmtime::Error::new)?;
        self.charge_output(bytes).map_err(wasmtime::Error::new)?;
        Ok(Ok(config.lower().map_err(wasmtime::Error::new)?))
    }
}

// Generated imports retain only this handle, not the host-I/O future's concrete state.
#[inline(never)]
fn execute(
    state: &mut CallState<InvocationHost>,
    request: HostRequest,
) -> BoxFuture<'_, wasmtime::Result<Result<HostResponse, Failure<HostFailure>>>> {
    Box::pin(async move {
        state
            .control
            .check_guest(Stage::HostIo)
            .map_err(wasmtime::Error::new)?;
        let host = state.host_mut();
        host.import_sequence = host.import_sequence.checked_add(1).ok_or_else(|| {
            wasmtime::Error::new(WasmError::InvalidData {
                field: "host_call.sequence",
            })
        })?;
        let call_key = format!("wasm-{}-{}", host.call_id, host.import_sequence);
        let host = state.host();
        let control = host.control.clone();
        let deadline = host.io_deadline();
        let result = control
            .host_io(deadline.into_std(), |cancel| async move {
                Ok(
                    match host
                        .hosts
                        .execute(request, &call_key, cancel, deadline)
                        .await
                    {
                        Ok(response) => Ok(response),
                        Err(error) => {
                            let failure = error.safe_failure();
                            // Retain the original error before cancellation or a later check can trap.
                            host.failures
                                .lock()
                                .expect("world wasm diagnostics poisoned")
                                .push(error);
                            Err(failure)
                        }
                    },
                )
            })
            .await
            .map_err(wasmtime::Error::new)?;
        state
            .host()
            .recheck()
            .await
            .map_err(|cause| wasmtime::Error::new(WasmError::Current(cause)))?;
        let bytes =
            super::meter::bytes(&result, state.host().maximum_bytes).map_err(wasmtime::Error::new)?;
        state.charge_output(bytes).map_err(wasmtime::Error::new)?;
        Ok(result)
    })
}

fn mismatch() -> wasmtime::Error {
    wasmtime::Error::new(WasmError::InvalidData {
        field: "host_call.response",
    })
}

impl bindings::source::Host for CallState<InvocationHost> {
    async fn read(
        &mut self,
        request: bindings::types::SourceReadRequest,
    ) -> wasmtime::Result<Result<bindings::types::SourcePage, bindings::types::SourceFailure>> {
        let plan =
            world_protocol::sources::SourceReadPlan::lift(request).map_err(wasmtime::Error::new)?;
        match execute(self, HostRequest::SourceRead(plan)).await? {
            Ok(HostResponse::SourceRead(page)) => {
                Ok(Ok(page.lower().map_err(wasmtime::Error::new)?))
            }
            Err(failure) => match failure.details {
                HostFailure::Source(failure) => {
                    Ok(Err(failure.lower().map_err(wasmtime::Error::new)?))
                }
                _ => Err(wasmtime::Error::new(WasmError::HostCall(failure))),
            },
            _ => Err(mismatch()),
        }
    }
}

macro_rules! ordinary_import {
    ($interface:ident, $method:ident, $request:ty, $domain:path, $variant:ident, $response:ty) => {
        impl bindings::$interface::Host for CallState<InvocationHost> {
            async fn $method(
                &mut self,
                request: $request,
            ) -> wasmtime::Result<Result<$response, bindings::types::FailureHostFailure>> {
                let request = <$domain>::lift(request).map_err(wasmtime::Error::new)?;
                match execute(self, HostRequest::$variant(request)).await? {
                    Ok(HostResponse::$variant(response)) => {
                        Ok(Ok(response.lower().map_err(wasmtime::Error::new)?))
                    }
                    Err(failure) => Ok(Err(failure.lower().map_err(wasmtime::Error::new)?)),
                    _ => Err(mismatch()),
                }
            }
        }
    };
}
ordinary_import!(
    world_read,
    query,
    bindings::types::QueryRequest,
    world_protocol::query::QueryRequest,
    WorldRead,
    bindings::types::QueryPage
);
ordinary_import!(
    model,
    generate,
    bindings::types::GenerationRequest,
    world_protocol::generation::GenerationRequest,
    ModelGenerate,
    bindings::types::GenerationReceipt
);

impl bindings::state::Host for CallState<InvocationHost> {
    async fn read(
        &mut self,
        request: bindings::types::StateRead,
    ) -> wasmtime::Result<
        Result<Option<bindings::types::StateValue>, bindings::types::FailureHostFailure>,
    > {
        let request =
            world_protocol::process::StateRead::lift(request).map_err(wasmtime::Error::new)?;
        match execute(self, HostRequest::StateRead(request)).await? {
            Ok(HostResponse::StateRead(value)) => {
                Ok(Ok(value.lower().map_err(wasmtime::Error::new)?))
            }
            Err(failure) => Ok(Err(failure.lower().map_err(wasmtime::Error::new)?)),
            _ => Err(mismatch()),
        }
    }
    async fn write(
        &mut self,
        request: bindings::types::StateWrite,
    ) -> wasmtime::Result<Result<bindings::types::StateValue, bindings::types::FailureHostFailure>>
    {
        let request =
            world_protocol::process::StateWrite::lift(request).map_err(wasmtime::Error::new)?;
        match execute(self, HostRequest::StateWrite(request)).await? {
            Ok(HostResponse::StateWrite(value)) => {
                Ok(Ok(value.lower().map_err(wasmtime::Error::new)?))
            }
            Err(failure) => Ok(Err(failure.lower().map_err(wasmtime::Error::new)?)),
            _ => Err(mismatch()),
        }
    }
}
impl bindings::clock::Host for CallState<InvocationHost> {
    async fn now(
        &mut self,
    ) -> wasmtime::Result<Result<String, bindings::types::FailureHostFailure>> {
        match execute(self, HostRequest::Clock).await? {
            Ok(HostResponse::Clock(value)) => {
                Ok(Ok(value.lower().map_err(wasmtime::Error::new)?))
            }
            Err(failure) => Ok(Err(failure.lower().map_err(wasmtime::Error::new)?)),
            _ => Err(mismatch()),
        }
    }
}
impl bindings::logging::Host for CallState<InvocationHost> {
    async fn log(
        &mut self,
        record: bindings::types::LogRecord,
    ) -> wasmtime::Result<Result<(), bindings::types::FailureHostFailure>> {
        let record =
            world_protocol::process::LogRecord::lift(record).map_err(wasmtime::Error::new)?;
        match execute(self, HostRequest::Log(record)).await? {
            Ok(HostResponse::Log) => Ok(Ok(())),
            Err(failure) => Ok(Err(failure.lower().map_err(wasmtime::Error::new)?)),
            _ => Err(mismatch()),
        }
    }
}

pub(super) fn now() -> Result<Timestamp, AuthError> {
    Timestamp::try_new(chrono::Utc::now().to_rfc3339())
        .map_err(|_| world_protocol::authorization::AuthorizationFailure::InternalFault.into())
}
