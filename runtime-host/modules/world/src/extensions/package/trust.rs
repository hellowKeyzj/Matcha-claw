use ed25519_dalek::{Signature, VerifyingKey};
use world_protocol::{
    package::{ArtifactRuntime, PackageFailure, TrustEvidence, TrustPolicy, UnsignedWasmPolicy},
    time::Timestamp,
};

use super::{error::PackageError, payload::VerifiedPayload};

impl VerifiedPayload {
    /// Re-run against the current policy at prepare; installation evidence is not a grant.
    pub fn verify_trust(
        &self,
        policy: &TrustPolicy,
        at: Timestamp,
    ) -> Result<TrustEvidence, PackageError> {
        if policy.revision.0 == 0 {
            return Err(PackageError::new(PackageFailure::PublisherUntrusted));
        }
        let signature = self.signatures.first();
        let publisher = if let Some(signature) = signature {
            if self.signatures.len() != 1
                || signature.package_digest != self.package_digest
                || signature.publisher != self.manifest.identity.publisher
            {
                return Err(PackageError::new(PackageFailure::SignatureInvalid));
            }
            let mut keys = policy.trusted_publishers.iter().filter(|key| {
                key.publisher == signature.publisher && key.key_id == signature.key_id
            });
            let trusted = keys
                .next()
                .ok_or_else(|| PackageError::new(PackageFailure::PublisherUntrusted))?;
            if keys.next().is_some() {
                return Err(PackageError::new(PackageFailure::PublisherUntrusted));
            }
            let public: [u8; 32] = trusted
                .public_key
                .as_slice()
                .try_into()
                .map_err(|_| PackageError::new(PackageFailure::SignatureInvalid))?;
            let key = VerifyingKey::from_bytes(&public)
                .map_err(|cause| PackageError::caused(PackageFailure::SignatureInvalid, cause))?;
            let signature_bytes = Signature::from_slice(&signature.signature)
                .map_err(|cause| PackageError::caused(PackageFailure::SignatureInvalid, cause))?;
            let message = world_protocol::package::signature_message(&self.package_digest);
            key.verify_strict(&message, &signature_bytes)
                .map_err(|cause| PackageError::caused(PackageFailure::SignatureInvalid, cause))?;
            Some(trusted)
        } else {
            None
        };
        let process = self
            .manifest
            .artifacts
            .iter()
            .any(|artifact| artifact.runtime == ArtifactRuntime::TrustedProcess);
        let native = self
            .manifest
            .artifacts
            .iter()
            .any(|artifact| artifact.runtime == ArtifactRuntime::Native);
        let wasm = self
            .manifest
            .artifacts
            .iter()
            .any(|artifact| artifact.runtime == ArtifactRuntime::WasmComponent);
        if process
            && !publisher.is_some_and(|key| key.allow_process)
            && !policy
                .trusted_process_digests
                .contains(&self.package_digest)
        {
            return Err(PackageError::new(PackageFailure::ProcessNotTrusted));
        }
        if native
            && !publisher.is_some_and(|key| key.allow_native)
            && !policy.trusted_native_digests.contains(&self.package_digest)
        {
            return Err(PackageError::new(PackageFailure::NativeNotTrusted));
        }
        if wasm && publisher.is_none() && policy.unsigned_wasm == UnsignedWasmPolicy::Deny {
            return Err(PackageError::new(PackageFailure::SignatureMissing));
        }
        Ok(TrustEvidence {
            policy_revision: policy.revision,
            signature_verified: publisher.is_some(),
            publisher: signature.map(|signature| signature.publisher.clone()),
            key_id: signature.map(|signature| signature.key_id.clone()),
            package_digest: self.package_digest.clone(),
            decided_at: at,
        })
    }
}
