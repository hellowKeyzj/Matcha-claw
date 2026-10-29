use world_protocol::{
    api::PackageConfigView,
    bindings::{BindingNode, ImplementationRef, SlotKind},
    identity::{self, IdentityFailure, IdentityProposal, IdentityReceipt, IdentityResolveRequest},
    package::PackageLimits,
};
use crate::extensions::{invocation::{NativePrepareFailure, NativeProof}, package::ArtifactLease};
use super::SourceIdentity;

pub(crate) struct PreparedIdentity { proof: NativeProof }
impl PreparedIdentity {
    pub(crate) fn prepare(node: &BindingNode, config: PackageConfigView, artifact: ArtifactLease) -> Result<Self, NativePrepareFailure> {
        let contract = identity::resolve_contract().map_err(|_| NativePrepareFailure::Entrypoint)?;
        if !node.implementation.contracts.contains(&contract) { return Err(NativePrepareFailure::Entrypoint); }
        let proof = NativeProof::prepare(node, config, artifact, identity::SOURCE_KEY_REGISTRATION, SlotKind::Identity)?;
        Ok(Self { proof })
    }
    pub fn implementation(&self) -> &ImplementationRef { self.proof.implementation() }
    pub fn config(&self) -> &PackageConfigView { self.proof.config() }
    pub fn limits(&self) -> &PackageLimits { self.proof.limits() }
    pub fn propose(&self, request: &IdentityResolveRequest, receipt: &IdentityReceipt) -> Result<IdentityProposal, IdentityFailure> { super::propose(&SourceIdentity, request, receipt) }
}
