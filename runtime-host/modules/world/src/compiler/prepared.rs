use world_protocol::{
    api::PackageConfigView,
    bindings::{BindingNode, ImplementationRef, SlotKind},
    compiler::{CompileFailure, CompileRequest, CompilerPassRequest, CompilerPassResult, TypedIr},
    ids::Digest,
    package::PackageLimits,
    slots,
};

use crate::extensions::{
    invocation::{NativePrepareFailure, NativeProof},
    package::ArtifactLease,
};

pub(crate) use world_protocol::slots::COMPILER_REGISTRATION;

pub(crate) struct PreparedCompiler {
    proof: NativeProof,
}

impl PreparedCompiler {
    pub(crate) fn prepare(
        node: &BindingNode,
        config: PackageConfigView,
        artifact: ArtifactLease,
        host_build: &Digest,
    ) -> Result<Self, NativePrepareFailure> {
        let contract = slots::slot_contract(SlotKind::Compiler)
            .map_err(|_| NativePrepareFailure::Entrypoint)?;
        if !node.implementation.contracts.contains(&contract) {
            return Err(NativePrepareFailure::Entrypoint);
        }
        Ok(Self { proof: NativeProof::prepare(
            node, config, artifact, host_build, COMPILER_REGISTRATION, SlotKind::Compiler,
        )? })
    }

    pub fn implementation(&self) -> &ImplementationRef { self.proof.implementation() }
    pub fn config(&self) -> &PackageConfigView { self.proof.config() }
    pub fn limits(&self) -> &PackageLimits { self.proof.limits() }

    /// Preserves the already checked IR; the owning pipeline still performs every postcheck.
    pub(crate) fn compile(&self, request: &CompilerPassRequest) -> Result<CompilerPassResult, CompileFailure> {
        if request.ir.ir_version != super::IR_VERSION
            || !self.implementation().contracts.contains(&request.contract)
            || slots::slot_contract(SlotKind::Compiler).map_err(|_| CompileFailure::InternalFault)? != request.contract {
            return Err(CompileFailure::ArtifactInvalid {
                field: world_protocol::failure::FieldPath(vec!["compilerPass".into(), "contract".into()]),
            });
        }
        Ok(CompilerPassResult {
            ir: request.ir.clone(), observed_dependencies: Vec::new(), diagnostics: Vec::new(),
        })
    }
}

pub(crate) struct PreparedSchema {
    proof: NativeProof,
}

impl PreparedSchema {
    pub(crate) fn prepare(
        node: &BindingNode,
        config: PackageConfigView,
        artifact: ArtifactLease,
        host_build: &Digest,
    ) -> Result<Self, NativePrepareFailure> {
        let contract = slots::slot_contract(SlotKind::Schema)
            .map_err(|_| NativePrepareFailure::Entrypoint)?;
        if !node.implementation.contracts.contains(&contract) {
            return Err(NativePrepareFailure::Entrypoint);
        }
        let proof = NativeProof::prepare(
            node,
            config,
            artifact,
            host_build,
            slots::SCHEMA_REGISTRATION,
            SlotKind::Schema,
        )?;
        Ok(Self { proof })
    }

    pub fn implementation(&self) -> &ImplementationRef {
        self.proof.implementation()
    }
    pub fn config(&self) -> &PackageConfigView {
        self.proof.config()
    }
    pub fn limits(&self) -> &PackageLimits {
        self.proof.limits()
    }
    pub(crate) fn compile(&self, request: &CompileRequest) -> Result<TypedIr, CompileFailure> {
        super::validate_model(request)
    }
}
