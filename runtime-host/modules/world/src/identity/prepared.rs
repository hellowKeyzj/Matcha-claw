use world_protocol::{
    api::PackageConfigView,
    bindings::{BindingNode, ImplementationRef, SlotKind},
    identity::{self, IdentityFailure, IdentityProposal, IdentityReceipt, IdentityResolveRequest},
    ids::Digest,
    package::PackageLimits,
};
use crate::extensions::{invocation::NativeProof, package::ArtifactLease};
use super::{IdentityError, SourceIdentity};

pub(crate) struct PreparedIdentity { proof: NativeProof }
impl PreparedIdentity {
    pub(crate) fn prepare(node: &BindingNode, config: PackageConfigView, artifact: ArtifactLease, host_build: &Digest) -> Result<Self, IdentityError> {
        let contract = identity::resolve_contract().map_err(|_| IdentityFailure::InternalFault)?;
        if !node.implementation.contracts.contains(&contract) { return Err(IdentityFailure::InternalFault.into()); }
        let proof = NativeProof::prepare(node, config, artifact, host_build, identity::SOURCE_KEY_REGISTRATION, SlotKind::Identity)
            .map_err(|_| IdentityFailure::InternalFault)?;
        Ok(Self { proof })
    }
    pub fn implementation(&self) -> &ImplementationRef { self.proof.implementation() }
    pub fn config(&self) -> &PackageConfigView { self.proof.config() }
    pub fn limits(&self) -> &PackageLimits { self.proof.limits() }
    pub fn propose(&self, request: &IdentityResolveRequest, receipt: &IdentityReceipt) -> Result<IdentityProposal, IdentityFailure> { super::propose(&SourceIdentity, request, receipt) }
}
