use std::{ffi::OsString, path::PathBuf};

use foundation::process::{
    ChildDescriptor, ExecutionSource, LaunchAttempt, LaunchAttemptCleanupFailure,
    LaunchAttemptFuture, LaunchAttemptGuard, LaunchAttemptMaterializer,
    LaunchMaterializationFailure, LaunchSpec, StdioMode, StdioSpec, supervision::LaunchFailure,
};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    api::PackageConfigView,
    bindings::{BindingNode, Entrypoint, ImplementationRef, TrustClass},
    package::ArtifactRuntime,
};

use super::error::ProcessError;
use crate::extensions::package::ArtifactLease;

/// Host-private launch inputs; neither argv nor environment are projected into public diagnostics.
/// This is containment, not an OS sandbox. An explicit sandbox request is never downgraded.
pub(crate) struct ProcessLaunch {
    pub working_directory: PathBuf,
    pub arguments: Vec<OsString>,
    pub environment: Vec<(OsString, OsString)>,
    pub private_descriptor: Option<ChildDescriptor>,
    pub require_sandbox: bool,
    pub artifact_limit: usize,
}

pub(super) struct Materializer {
    attempt: Option<LaunchAttempt>,
}

struct ArtifactGuard {
    artifact: Option<ArtifactLease>,
}

impl LaunchAttemptGuard for ArtifactGuard {
    fn cleanup(&mut self) -> Result<(), LaunchAttemptCleanupFailure> {
        self.artifact = None;
        Ok(())
    }
}

impl LaunchAttemptMaterializer for Materializer {
    fn materialize(&mut self) -> LaunchAttemptFuture {
        let attempt = self.attempt.take();
        Box::pin(async move {
            attempt.ok_or_else(|| {
                LaunchMaterializationFailure::new(LaunchFailure::ArtifactUnavailable)
            })
        })
    }
}

impl Materializer {
    pub(super) fn prepare(
        node: &BindingNode,
        config: &PackageConfigView,
        artifact: ArtifactLease,
        launch: ProcessLaunch,
        cancellation: &CancellationToken,
    ) -> Result<Self, ProcessError> {
        if node.trust != TrustClass::TrustedProcess { return Err(ProcessError::UnsupportedEntrypoint); }
        Self::prepare_exact(&node.implementation, config, artifact, launch, cancellation)
    }

    pub(super) fn prepare_materials(
        implementation: &ImplementationRef,
        config: &PackageConfigView,
        artifact: ArtifactLease,
        launch: ProcessLaunch,
        cancellation: &CancellationToken,
    ) -> Result<Self, ProcessError> {
        if implementation.contracts != vec![crate::materials::material_contract().map_err(|_| ProcessError::UnsupportedEntrypoint)?]
            || launch.arguments != [std::ffi::OsString::from("world-materials")]
            || !launch.environment.is_empty() || launch.private_descriptor.is_some() {
            return Err(ProcessError::ArtifactMismatch);
        }
        Self::prepare_exact(implementation, config, artifact, launch, cancellation)
    }

    fn prepare_exact(
        implementation: &ImplementationRef,
        config: &PackageConfigView,
        artifact: ArtifactLease,
        launch: ProcessLaunch,
        cancellation: &CancellationToken,
    ) -> Result<Self, ProcessError> {
        if launch.require_sandbox
            || artifact
                .artifact
                .features
                .iter()
                .any(|feature| feature == world_protocol::package::REQUIRES_SANDBOX)
        {
            return Err(ProcessError::SandboxUnavailable);
        }
        let declared = &artifact.artifact;
        if artifact.package_digest() != &implementation.package_digest
            || declared.id != implementation.artifact_id
            || declared.digest != implementation.artifact_digest
            || declared.entrypoint != implementation.entrypoint
            || declared.runtime != ArtifactRuntime::TrustedProcess
            || declared.target != native_target()
            || !declared.abi.required_features.is_empty()
        {
            return Err(ProcessError::ArtifactMismatch);
        }
        let Entrypoint::Process { protocol, .. } = &implementation.entrypoint else {
            return Err(ProcessError::UnsupportedEntrypoint);
        };
        if !implementation.contracts.contains(protocol) {
            return Err(ProcessError::UnsupportedEntrypoint);
        }
        if config.install_id != implementation.install_id
            || config.digest != implementation.config_digest
        {
            return Err(ProcessError::ConfigurationMismatch);
        }
        if world_protocol::api::package_config_digest(&config.fields)
            .map_err(|_| ProcessError::ConfigurationMismatch)?
            != config.digest
        {
            return Err(ProcessError::ConfigurationMismatch);
        }
        let image = artifact.open_binary(launch.artifact_limit, cancellation)?;
        #[cfg(windows)]
        let source =
            ExecutionSource::from_windows_pin(image).map_err(|_| ProcessError::InvalidLaunch)?;
        #[cfg(target_os = "linux")]
        let source = ExecutionSource::from_linux_executable(image.into())
            .map_err(|_| ProcessError::InvalidLaunch)?;
        #[cfg(not(any(windows, target_os = "linux")))]
        {
            let _ = image;
            return Err(ProcessError::UnsupportedEntrypoint);
        }
        #[cfg(any(windows, target_os = "linux"))]
        {
            let spec = LaunchSpec::try_new(
                artifact
                    .path()
                    .ok_or(ProcessError::ArtifactMismatch)?
                    .to_path_buf(),
                launch.working_directory,
                launch.arguments,
                launch.environment,
                StdioSpec::new(StdioMode::Piped, StdioMode::Piped, StdioMode::Piped),
            )
            .map_err(|_| ProcessError::InvalidLaunch)?;
            let guard = ArtifactGuard {
                artifact: Some(artifact),
            };
            let attempt = match launch.private_descriptor {
                Some(descriptor) => LaunchAttempt::with_child_descriptor_and_execution_source(
                    spec, guard, descriptor, source,
                ),
                None => LaunchAttempt::with_execution_source(spec, guard, source),
            };
            Ok(Self {
                attempt: Some(attempt),
            })
        }
    }
}

pub(crate) fn native_target() -> &'static str {
    #[cfg(all(windows, target_arch = "x86_64"))]
    {
        "x86_64-pc-windows-msvc"
    }
    #[cfg(all(windows, target_arch = "aarch64"))]
    {
        "aarch64-pc-windows-msvc"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "x86_64-unknown-linux-gnu"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "aarch64-unknown-linux-gnu"
    }
    #[cfg(not(any(
        all(windows, any(target_arch = "x86_64", target_arch = "aarch64")),
        all(
            target_os = "linux",
            any(target_arch = "x86_64", target_arch = "aarch64")
        )
    )))]
    {
        "unsupported"
    }
}
