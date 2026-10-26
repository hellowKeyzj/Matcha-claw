use world_protocol::{
    api::PackageConfigView,
    bindings::{BindingNode, Entrypoint, ImplementationRef, SlotKind},
    failure::FailureStage,
    ids::{Digest, ProviderId},
    package::PackageLimits,
    sources::{self, SourceFailure},
};

use super::SourceError;
use crate::extensions::invocation::InvocationLease;
use crate::extensions::{invocation::NativeProof, package::ArtifactLease};
use std::sync::Arc;

#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) enum Driver {
    Postgres,
    HttpJson,
    Plugin,
}

#[derive(Clone)]
pub(super) enum SourceEndpoint {
    Native(Arc<PreparedSource>),
    Plugin {
        implementation: ImplementationRef,
        provider: ProviderId,
        implementations: Vec<ImplementationRef>,
    },
}

impl SourceEndpoint {
    pub(super) fn from_lease(
        lease: &InvocationLease,
        provider: &world_protocol::ids::NodeId,
    ) -> Result<Self, SourceError> {
        let node = lease.graph().node(provider).map_err(|failure| {
            SourceError::new(SourceFailure::Binding { failure }, FailureStage::Prepare)
        })?;
        let expected = world_protocol::slots::slot_port(SlotKind::Connector).map_err(|cause| {
            SourceError::caused_by(
                SourceFailure::ProtocolViolation,
                FailureStage::Prepare,
                cause,
            )
        })?;
        let mut exports = node.ports.iter().filter(|port| {
            port.direction == world_protocol::bindings::PortDirection::Export
                && port.name == expected.name
        });
        if !lease.closure().nodes.contains(provider)
            || node.slot != SlotKind::Connector
            || !node.implementation.contracts.contains(&expected.contract)
            || exports.next() != Some(&expected)
            || exports.next().is_some()
        {
            return Err(SourceError::new(
                SourceFailure::ProtocolViolation,
                FailureStage::Prepare,
            ));
        }
        if let Some(prepared) = lease.source(provider) {
            return Ok(Self::Native(prepared.clone()));
        }
        if lease.process(provider).is_none() && lease.wasm(provider).is_none() {
            return Err(SourceError::new(
                SourceFailure::ProtocolViolation,
                FailureStage::Prepare,
            ));
        }
        let implementations = lease
            .graph()
            .composition_order(&node.binding_id)
            .map_err(|failure| {
                SourceError::new(SourceFailure::Binding { failure }, FailureStage::Prepare)
            })?
            .iter()
            .map(|id| {
                if !lease.closure().nodes.contains(id) {
                    return Err(SourceError::new(
                        SourceFailure::ProtocolViolation,
                        FailureStage::Prepare,
                    ));
                }
                lease
                    .graph()
                    .node(id)
                    .map(|node| node.implementation.clone())
                    .map_err(|failure| {
                        SourceError::new(SourceFailure::Binding { failure }, FailureStage::Prepare)
                    })
            })
            .collect::<Result<Vec<_>, SourceError>>()?;
        Ok(Self::Plugin {
            implementation: node.implementation.clone(),
            provider: node.provider_id.clone(),
            implementations,
        })
    }

    pub(super) fn implementation(&self) -> &ImplementationRef {
        match self {
            Self::Native(prepared) => prepared.implementation(),
            Self::Plugin { implementation, .. } => implementation,
        }
    }

    pub(super) fn implementations(&self) -> &[ImplementationRef] {
        match self {
            Self::Native(prepared) => std::slice::from_ref(prepared.implementation()),
            Self::Plugin {
                implementations, ..
            } => implementations,
        }
    }

    pub(super) fn provider(&self) -> &ProviderId {
        match self {
            Self::Native(prepared) => &prepared.provider,
            Self::Plugin { provider, .. } => provider,
        }
    }

    pub(super) fn driver(&self) -> Driver {
        match self {
            Self::Native(prepared) => prepared.driver,
            Self::Plugin { .. } => Driver::Plugin,
        }
    }

    pub(super) fn native(&self) -> Result<&Arc<PreparedSource>, SourceError> {
        match self {
            Self::Native(prepared) => Ok(prepared),
            Self::Plugin { .. } => Err(SourceError::new(
                SourceFailure::CapabilityMissing {
                    capability: sources::SourceCapability::ConditionalWrite,
                },
                FailureStage::Prepare,
            )),
        }
    }
}

pub(crate) struct PreparedSource {
    proof: NativeProof,
    pub(super) driver: Driver,
    pub(super) provider: ProviderId,
}

impl PreparedSource {
    pub(crate) fn prepare(
        node: &BindingNode,
        config: PackageConfigView,
        artifact: ArtifactLease,
        host_build: &Digest,
    ) -> Result<Self, SourceError> {
        let reject = || SourceError::new(SourceFailure::ProtocolViolation, FailureStage::Prepare);
        let Entrypoint::Native { registration, .. } = &node.implementation.entrypoint else {
            return Err(reject());
        };
        let driver = match registration.as_str() {
            sources::POSTGRES_REGISTRATION => Driver::Postgres,
            sources::HTTP_JSON_REGISTRATION => Driver::HttpJson,
            _ => return Err(reject()),
        };
        let contract = sources::read_contract().map_err(|cause| {
            SourceError::caused_by(SourceFailure::InternalFault, FailureStage::Prepare, cause)
        })?;
        if !node.implementation.contracts.contains(&contract) {
            return Err(reject());
        }
        for (id, expected) in [
            ("source.write", sources::write_contract()),
            ("source.inspect", sources::inspect_contract()),
        ] {
            let expected = expected.map_err(|cause| {
                SourceError::caused_by(SourceFailure::InternalFault, FailureStage::Prepare, cause)
            })?;
            if node
                .implementation
                .contracts
                .iter()
                .any(|contract| contract.id.as_str() == id)
                && (driver != Driver::Postgres
                    || !node.implementation.contracts.contains(&expected))
            {
                return Err(SourceError::invalid(
                    "contracts",
                    sources::SourcePlanReason::CapabilityNotDeclared,
                ));
            }
        }
        let proof = NativeProof::prepare(
            node,
            config,
            artifact,
            host_build,
            registration,
            SlotKind::Connector,
        )
        .map_err(|cause| {
            use crate::extensions::invocation::NativePrepareFailure;
            let failure = match cause {
                NativePrepareFailure::Artifact | NativePrepareFailure::HostBuild => {
                    world_protocol::lifecycle::LifecycleFailure::PrepareFailed {
                        node_id: node.id.clone(),
                    }
                }
                NativePrepareFailure::Configuration => {
                    world_protocol::lifecycle::LifecycleFailure::MissingConfiguration {
                        install_id: node.implementation.install_id.clone(),
                    }
                }
                NativePrepareFailure::Entrypoint => {
                    world_protocol::lifecycle::LifecycleFailure::PrepareFailed {
                        node_id: node.id.clone(),
                    }
                }
            };
            SourceError::caused_by(
                SourceFailure::Lifecycle { failure },
                FailureStage::Prepare,
                NativeCause(cause),
            )
        })?;
        Ok(Self {
            proof,
            driver,
            provider: node.provider_id.clone(),
        })
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
}

impl SourceError {
    pub(crate) fn native_prepare_reason(&self) -> Option<&'static str> {
        let cause = std::error::Error::source(self)?.downcast_ref::<NativeCause>()?;
        Some(match cause.0 {
            crate::extensions::invocation::NativePrepareFailure::Artifact => "artifact",
            crate::extensions::invocation::NativePrepareFailure::Configuration => "configuration",
            crate::extensions::invocation::NativePrepareFailure::Entrypoint => "entrypoint",
            crate::extensions::invocation::NativePrepareFailure::HostBuild => "host_build",
        })
    }
}

#[derive(Debug)]
struct NativeCause(crate::extensions::invocation::NativePrepareFailure);
impl std::fmt::Display for NativeCause {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "world.source_native_prepare_failed: {:?}", self.0)
    }
}
impl std::error::Error for NativeCause {}
