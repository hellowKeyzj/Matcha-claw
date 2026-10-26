use world_protocol::{
    api::PackageConfigView,
    bindings::{BindingNode, Entrypoint, ImplementationRef, SlotKind, TrustClass},
    ids::Digest,
    package::{ArtifactRuntime, PackageLimits},
};

use crate::extensions::package::ArtifactLease;

#[derive(Debug)]
pub(crate) enum NativePrepareFailure {
    Artifact,
    Configuration,
    Entrypoint,
    HostBuild,
}

/// Exact common native preparation proof. A domain factory still validates its
/// own registered implementation, slot contract and typed behavior.
pub(crate) struct NativeProof {
    implementation: ImplementationRef,
    config: PackageConfigView,
    artifact: ArtifactLease,
}

impl NativeProof {
    pub fn prepare(
        node: &BindingNode,
        config: PackageConfigView,
        artifact: ArtifactLease,
        host_build: &Digest,
        registration: &str,
        slot: SlotKind,
    ) -> Result<Self, NativePrepareFailure> {
        let implementation = &node.implementation;
        let Entrypoint::Native {
            registration: declared,
            host_build: declared_build,
        } = &implementation.entrypoint
        else {
            return Err(NativePrepareFailure::Entrypoint);
        };
        if node.slot != slot
            || declared != registration
            || !matches!(
                node.trust,
                TrustClass::TrustedNative | TrustClass::PrivateRoot
            )
        {
            return Err(NativePrepareFailure::Entrypoint);
        }
        if declared_build != host_build || implementation.artifact_digest != *host_build {
            return Err(NativePrepareFailure::HostBuild);
        }
        if artifact.package_digest() != &implementation.package_digest
            || artifact.artifact.runtime != ArtifactRuntime::Native
            || artifact.artifact.id != implementation.artifact_id
            || artifact.artifact.digest != implementation.artifact_digest
            || artifact.artifact.entrypoint != implementation.entrypoint
        {
            return Err(NativePrepareFailure::Artifact);
        }
        if config.install_id != implementation.install_id
            || config.digest != implementation.config_digest
        {
            return Err(NativePrepareFailure::Configuration);
        }
        if world_protocol::api::package_config_digest(&config.fields)
            .map_err(|_| NativePrepareFailure::Configuration)?
            != config.digest
        {
            return Err(NativePrepareFailure::Configuration);
        }
        Ok(Self {
            implementation: implementation.clone(),
            config,
            artifact,
        })
    }

    pub fn implementation(&self) -> &ImplementationRef {
        &self.implementation
    }
    pub fn config(&self) -> &PackageConfigView {
        &self.config
    }
    pub fn limits(&self) -> &PackageLimits {
        self.artifact.package_limits()
    }
}
