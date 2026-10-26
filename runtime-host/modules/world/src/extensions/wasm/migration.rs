use tokio_util::sync::CancellationToken;
use wasm_host::{
    CallControl, CallState, Engine, ExecutionError, FailureKind, Stage,
    wasmtime::component::{Component, Linker},
};
use world_protocol::{
    api::PackageConfigView,
    bindings::{Entrypoint, ImplementationRef},
    component,
    package::ArtifactKind,
    state::{StateFailure, StateMigrationInput, StateMigrationOutput},
};

use super::{
    ExecutionPolicy, WasmError, bindings::state_migration::StateMigrationPluginPre, convert::Wire,
};
use crate::extensions::package::ArtifactLease;

/// Pure checkpoint transformation. The migration owner retains its drain proof,
/// package/content pins, concurrency permit and checked task resource across this call.
pub(crate) struct PreparedStateMigration {
    engine: Engine,
    component: Component,
    pre: StateMigrationPluginPre<CallState<()>>,
    implementation: ImplementationRef,
    _artifact: ArtifactLease,
}

impl PreparedStateMigration {
    pub fn prepare(
        engine: Engine,
        implementation: ImplementationRef,
        config: PackageConfigView,
        artifact: ArtifactLease,
        artifact_limit: usize,
        cancellation: &CancellationToken,
    ) -> Result<Self, WasmError> {
        let contract = world_protocol::state::migration_contract().map_err(WasmError::Schema)?;
        if artifact.artifact.kind != ArtifactKind::Migration
            || !implementation.contracts.contains(&contract)
            || !matches!(&implementation.entrypoint, Entrypoint::Wasm { world, interface }
                if world == component::STATE_MIGRATION_WORLD && interface == component::STATE_MIGRATION_INTERFACE)
        {
            return Err(WasmError::EntrypointUnsupported);
        }
        let component = super::prepared::compile(
            &engine,
            &implementation,
            &config,
            &artifact,
            artifact_limit,
            cancellation,
        )?;
        // No ordinary imports, WASI, private ports or config lookup during migration.
        let linker = Linker::new(engine.raw_engine());
        let pre = StateMigrationPluginPre::new(engine.link(&linker, &component)?)
            .map_err(|cause| ExecutionError::from_wasmtime(Stage::Link, cause))?;
        if cancellation.is_cancelled() {
            return Err(WasmError::Cancelled);
        }
        Ok(Self {
            engine,
            component,
            pre,
            implementation,
            _artifact: artifact,
        })
    }

    pub fn implementation(&self) -> &ImplementationRef {
        &self.implementation
    }

    pub async fn migrate(
        &self,
        input: StateMigrationInput,
        policy: ExecutionPolicy,
        control: CallControl,
    ) -> Result<Result<StateMigrationOutput, StateFailure>, WasmError> {
        let contract = world_protocol::state::migration_contract().map_err(WasmError::Schema)?;
        if input.migration.contract != contract {
            return Err(WasmError::ArtifactMismatch);
        }
        let mut limits = policy.intersect(
            self._artifact.package_limits(),
            &self._artifact.package_limits().budget,
        )?;
        let input_bytes = super::meter::bytes(&input, limits.budget.max_bytes)?;
        limits.store.output_bytes = limits.store.output_bytes.saturating_sub(input_bytes);
        limits.store.lift_bytes = limits.store.lift_bytes.min(limits.store.output_bytes);
        let deadline = limits.deadline.min(control.deadline());
        let control = CallControl::new(control.cancellation().clone(), deadline);
        let target_schema = input.migration.target_schema.clone();
        let target_format = input.migration.target_checkpoint_format.clone();
        let wire = input.lower()?;
        let pre = self.pre.clone();
        let maximum = limits.store.output_bytes as u64;
        self.engine
            .invoke(
                &self.component,
                (),
                limits.store,
                control,
                move |store| {
                    Box::pin(async move {
                        let instance = pre
                            .instantiate_async(&mut *store)
                            .await
                            .map_err(super::call::instantiate)?;
                        let result = instance
                            .matcha_world_state_migration()
                            .call_migrate(&mut *store, &wire)
                            .await
                            .map_err(super::call::call)?;
                        let result: Result<StateMigrationOutput, StateFailure> =
                            Wire::lift(result).map_err(super::call::host_error)?;
                        if result.as_ref().is_ok_and(|output| {
                            output.schema != target_schema
                                || output.checkpoint_format != target_format
                        }) {
                            return Err(super::call::host_error(WasmError::InvalidData {
                                field: "state_migration.output",
                            }));
                        }
                        let bytes = super::meter::bytes(&result, maximum)
                            .map_err(super::call::host_error)?;
                        store.data_mut().charge_output(bytes)?;
                        Ok(result)
                    })
                },
                |state| {
                    Box::pin(async move {
                        let (_, table) = state.into_parts();
                        if !table.is_empty() {
                            return Err(ExecutionError::new(Stage::Cleanup, FailureKind::Cleanup));
                        }
                        Ok(())
                    })
                },
            )
            .await
            .map_err(WasmError::Invocation)
    }
}
