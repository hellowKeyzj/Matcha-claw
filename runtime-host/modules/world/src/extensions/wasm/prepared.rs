use std::time::Instant;

use tokio_util::sync::CancellationToken;
use wasm_host::{CallState, Engine, ExecutionError, Stage, wasmtime::component::Component};
use world_protocol::{
    api::PackageConfigView,
    bindings::{Entrypoint, ImplementationRef, SlotKind},
    component,
    ids::Digest,
    package::{ArtifactRuntime, PackageLimits},
};

use super::{WasmError, bindings, host::InvocationHost};
use crate::extensions::package::ArtifactLease;

pub(crate) struct PreparedWasm {
    pub(super) engine: Engine,
    pub(super) component: Component,
    pub(super) endpoint: Endpoint,
    implementation: ImplementationRef,
    config: PackageConfigView,
    _artifact: ArtifactLease,
}

macro_rules! endpoints {
    ($($slot:ident => $module:ident::$pre:ident),+ $(,)?) => {
        pub(super) enum Endpoint {
            $($slot(bindings::$module::$pre<CallState<InvocationHost>>)),+
        }
        impl Endpoint {
            fn prepare(
                pre: wasm_host::wasmtime::component::InstancePre<CallState<InvocationHost>>,
                slot: SlotKind,
            ) -> Result<Self, WasmError> {
                Ok(match slot {
                    $(SlotKind::$slot => Self::$slot(bindings::$module::$pre::new(pre)
                        .map_err(|cause| ExecutionError::from_wasmtime(Stage::Link, cause))?)),+
                })
            }
            fn select(world: &str, interface: &str) -> Result<SlotKind, WasmError> {
                $ (if world == component::slot_world(SlotKind::$slot)
                    && interface == component::slot_interface(SlotKind::$slot) {
                    return Ok(SlotKind::$slot);
                })+
                Err(WasmError::EntrypointUnsupported)
            }
        }
    };
}
endpoints! {
    Connector => connector::ConnectorPluginPre,
    Identity => identity::IdentityPluginPre,
    Schema => schema::SchemaPluginPre,
    Resolver => resolver::ResolverPluginPre,
    Projection => projection::ProjectionPluginPre,
    Provenance => provenance::ProvenancePluginPre,
    Compiler => compiler::CompilerPluginPre,
    Policy => policy::PolicyPluginPre,
    Action => action::ActionPluginPre,
    Reconcile => reconcile::ReconcilePluginPre,
    Abstraction => abstraction::AbstractionPluginPre,
    Evaluation => evaluation::EvaluationPluginPre,
    Context => context::ContextPluginPre,
    AgentBridge => agent_bridge::AgentBridgePluginPre,
    Storage => storage::StoragePluginPre,
}

impl PreparedWasm {
    pub fn prepare(
        engine: Engine,
        implementation: ImplementationRef,
        config: PackageConfigView,
        artifact: ArtifactLease,
        artifact_limit: usize,
        cancellation: &CancellationToken,
    ) -> Result<Self, WasmError> {
        if cancellation.is_cancelled() {
            return Err(WasmError::Cancelled);
        }
        let Entrypoint::Wasm { world, interface } = &implementation.entrypoint else {
            return Err(WasmError::EntrypointUnsupported);
        };
        // Decide the one exact ABI before expensive compilation; no name aliases.
        let slot = Endpoint::select(world, interface)?;
        let component = compile(
            &engine,
            &implementation,
            &config,
            &artifact,
            artifact_limit,
            cancellation,
        )?;
        let started = Instant::now();
        let endpoint = (|| {
            let linker = super::host::linker(&engine)?;
            let pre = engine.link(&linker, &component)?;
            Endpoint::prepare(pre, slot)
        })();
        trace_preparation(
            &implementation.artifact_digest,
            "link",
            started,
            endpoint.is_ok(),
        );
        let endpoint = endpoint?;
        if cancellation.is_cancelled() {
            return Err(WasmError::Cancelled);
        }
        Ok(Self {
            engine,
            component,
            endpoint,
            implementation,
            config,
            _artifact: artifact,
        })
    }

    pub fn implementation(&self) -> &ImplementationRef {
        &self.implementation
    }
    pub fn config(&self) -> &PackageConfigView {
        &self.config
    }
    pub fn limits(&self) -> &PackageLimits {
        self._artifact.package_limits()
    }
}

pub(super) fn compile(
    engine: &Engine,
    implementation: &ImplementationRef,
    config: &PackageConfigView,
    artifact: &ArtifactLease,
    artifact_limit: usize,
    cancellation: &CancellationToken,
) -> Result<Component, WasmError> {
    if cancellation.is_cancelled() {
        return Err(WasmError::Cancelled);
    }
    let declared = &artifact.artifact;
    if artifact.package_digest() != &implementation.package_digest
        || declared.id != implementation.artifact_id
        || declared.digest != implementation.artifact_digest
        || declared.entrypoint != implementation.entrypoint
        || declared.runtime != ArtifactRuntime::WasmComponent
        || declared.target != component::TARGET
    {
        return Err(WasmError::ArtifactMismatch);
    }
    if config.install_id != implementation.install_id
        || config.digest != implementation.config_digest
        || world_protocol::api::package_config_digest(&config.fields).map_err(WasmError::Schema)?
            != config.digest
    {
        return Err(WasmError::ConfigurationMismatch);
    }
    let Entrypoint::Wasm { world, .. } = &implementation.entrypoint else {
        return Err(WasmError::EntrypointUnsupported);
    };
    if declared.abi.world != *world || !declared.abi.required_features.is_empty() {
        return Err(WasmError::EntrypointUnsupported);
    }
    let started = Instant::now();
    let bytes = artifact.read_bytes(artifact_limit, cancellation);
    trace_preparation(
        &implementation.artifact_digest,
        "load",
        started,
        bytes.is_ok(),
    );
    let bytes = bytes?;
    let started = Instant::now();
    let component = engine.compile(&bytes, sha256(&implementation.artifact_digest));
    trace_preparation(
        &implementation.artifact_digest,
        "compile",
        started,
        component.is_ok(),
    );
    let component = component?;
    if cancellation.is_cancelled() {
        return Err(WasmError::Cancelled);
    }
    Ok(component)
}

fn trace_preparation(artifact: &Digest, phase: &'static str, started: Instant, succeeded: bool) {
    platform::trace::runtime_trace("world.wasm.prepare", || {
        serde_json::json!({
            "artifactHash": platform::trace::identifier_hash(artifact.as_str()),
            "phase": phase,
            "elapsedMs": started.elapsed().as_millis() as u64,
            "outcome": if succeeded { "ok" } else { "error" },
        })
    });
}

fn sha256(digest: &Digest) -> [u8; 32] {
    let mut bytes = [0; 32];
    for (output, pair) in bytes
        .iter_mut()
        .zip(digest.as_str().as_bytes()[7..].chunks_exact(2))
    {
        let digit = |b: u8| {
            if b.is_ascii_digit() {
                b - b'0'
            } else {
                b - b'a' + 10
            }
        };
        *output = digit(pair[0]) * 16 + digit(pair[1]);
    }
    bytes
}
