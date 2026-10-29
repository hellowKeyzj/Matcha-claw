use std::collections::{BTreeMap, BTreeSet};

use world_protocol::{
    bindings::{Entrypoint, TrustClass},
    failure::FieldPath,
    materials::BlobRef,
    package::{
        ArtifactKind, ArtifactRuntime, Contribution, MANIFEST_FORMAT, PackageFailure,
        PackageManifest,
    },
    sources::ContractRef,
};

use super::{error::PackageError, payload::digest};

pub(super) fn invalid(field: &str) -> PackageFailure {
    PackageFailure::ManifestInvalid {
        field: FieldPath(field.split('.').map(str::to_owned).collect()),
    }
}

pub(super) fn validate(
    manifest: &PackageManifest,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<(), PackageError> {
    let fail = |field: &str| PackageError::new(invalid(field));
    if manifest.format != MANIFEST_FORMAT {
        return Err(PackageError::new(PackageFailure::UnsupportedFormat));
    }
    for file in &manifest.files {
        if file.media_type.is_empty()
            || !file.media_type.contains('/')
            || file.media_type.chars().any(char::is_control)
        {
            return Err(fail("files.mediaType"));
        }
    }
    let mut artifacts = BTreeMap::new();
    for artifact in &manifest.artifacts {
        let bad = || {
            PackageError::new(PackageFailure::ArtifactInvalid {
                artifact_id: artifact.id.clone(),
            })
        };
        if artifacts.insert(&artifact.id, artifact).is_some() || artifact.target.is_empty() {
            return Err(bad());
        }
        if artifact.runtime != ArtifactRuntime::Native {
            let path = artifact.path.as_ref().ok_or_else(bad)?;
            let bytes = files.get(path).ok_or_else(|| {
                PackageError::new(PackageFailure::FileMissing { path: path.clone() })
            })?;
            if digest(bytes) != artifact.digest {
                return Err(PackageError::new(PackageFailure::DigestMismatch {
                    path: path.clone(),
                }));
            }
        }
        match (&artifact.runtime, &artifact.entrypoint) {
            (ArtifactRuntime::WasmComponent, Entrypoint::Wasm { world, interface }) => {
                if world != &artifact.abi.world
                    || interface.is_empty()
                    || !files[artifact.path.as_ref().ok_or_else(bad)?]
                        .starts_with(b"\0asm\x0d\0\x01\0")
                {
                    return Err(bad());
                }
            }
            (
                ArtifactRuntime::TrustedProcess,
                Entrypoint::Process {
                    executable,
                    protocol,
                },
            ) => {
                if Some(executable) != artifact.path.as_ref() {
                    return Err(bad());
                }
                require_contract(manifest, protocol)?;
            }
            // Historical packages remain readable; preparation checks the current descriptor.
            (
                ArtifactRuntime::Native,
                Entrypoint::Builtin { registration, revision },
            ) if !registration.trim().is_empty()
                && revision.0 > 0
                && artifact.path.is_none() => {}
            (
                ArtifactRuntime::Native,
                Entrypoint::Native {
                    registration,
                    host_build,
                },
            ) if !registration.is_empty()
                && artifact.path.is_none()
                && &artifact.digest == host_build => {}
            _ => return Err(bad()),
        }
        let features: BTreeSet<_> = artifact.features.iter().collect();
        if features.len() != artifact.features.len()
            || artifact.features.iter().any(|feature| feature.is_empty())
            || artifact
                .abi
                .required_features
                .iter()
                .any(|feature| !features.contains(feature))
        {
            return Err(bad());
        }
        super::wit::validate(artifact, manifest, files)?;
    }
    let mut contracts = BTreeSet::new();
    for contract in &manifest.contracts {
        if semver::Version::parse(&contract.reference.version).is_err() {
            return Err(PackageError::new(PackageFailure::InvalidVersion));
        }
        if !contracts.insert((&contract.reference.id, &contract.reference.version)) {
            return Err(PackageError::new(PackageFailure::ContractMismatch {
                contract_id: contract.reference.id.clone(),
            }));
        }
        blob(manifest, files, &contract.wit)?;
        for schema in [&contract.request_schema, &contract.result_schema] {
            let bytes = blob(manifest, files, schema)?;
            let value: serde_json::Value = serde_json::from_slice(bytes)
                .map_err(|cause| PackageError::caused(PackageFailure::SchemaInvalid, cause))?;
            if !value.is_object() && !value.is_boolean() {
                return Err(PackageError::new(PackageFailure::SchemaInvalid));
            }
        }
    }
    let mut providers = BTreeSet::new();
    for provider in &manifest.provides {
        if !providers.insert((&provider.provider_id, provider.slot)) {
            return Err(fail("provides.providerId"));
        }
        let artifact = artifacts.get(&provider.artifact_id).ok_or_else(|| {
            PackageError::new(PackageFailure::ArtifactInvalid {
                artifact_id: provider.artifact_id.clone(),
            })
        })?;
        if artifact.kind != ArtifactKind::Implementation || provider.contracts.is_empty() {
            return Err(fail("provides"));
        }
        if !matches!(
            (artifact.runtime, provider.trust),
            (ArtifactRuntime::WasmComponent, TrustClass::OrdinaryGuest)
                | (
                    ArtifactRuntime::TrustedProcess,
                    TrustClass::TrustedProcess | TrustClass::PrivateRoot
                )
                | (
                    ArtifactRuntime::Native,
                    TrustClass::TrustedNative | TrustClass::PrivateRoot
                )
        ) {
            return Err(fail("provides.trust"));
        }
        let mut exact = BTreeSet::new();
        for reference in &provider.contracts {
            if !exact.insert((&reference.id, &reference.version)) {
                return Err(fail("provides.contracts"));
            }
            require_contract(manifest, reference)?;
        }
    }
    let mut required = BTreeSet::new();
    for requirement in &manifest.requires {
        if !required.insert(&requirement.id) {
            return Err(fail("requires"));
        }
    }
    let mut dependencies = BTreeSet::new();
    for dependency in &manifest.dependencies {
        if !dependencies.insert((&dependency.publisher, &dependency.id)) {
            return Err(fail("dependencies"));
        }
        if dependency.publisher == manifest.identity.publisher
            && dependency.id == manifest.identity.id
        {
            return Err(PackageError::new(PackageFailure::DependencyCycle));
        }
    }
    let mut fields = BTreeSet::new();
    for field in &manifest.config.fields {
        if field.name.is_empty() || !fields.insert(&field.name) {
            return Err(fail("config.fields"));
        }
        crate::definitions::validate_value_type(&field.value_type)
            .map_err(|_| fail("config.fields.valueType"))?;
        if let Some(default) = &field.default {
            crate::definitions::validate_value(&field.value_type, false, default)
                .map_err(|_| fail("config.fields.default"))?;
        }
    }
    let mut state = BTreeSet::new();
    for schema in &manifest.state {
        if !state.insert(&schema.namespace)
            || !manifest
                .files
                .iter()
                .any(|file| file.digest == schema.schema_digest)
        {
            return Err(fail("state"));
        }
    }
    let mut migrations = BTreeSet::new();
    for migration in &manifest.migrations {
        if !migrations.insert(&migration.id)
            || migration.from_schema == migration.to_schema
            || !manifest
                .files
                .iter()
                .any(|file| file.digest == migration.from_schema)
            || !manifest
                .files
                .iter()
                .any(|file| file.digest == migration.to_schema)
            || !artifacts
                .get(&migration.artifact_id)
                .is_some_and(|artifact| artifact.kind == ArtifactKind::Migration)
        {
            return Err(fail("migrations"));
        }
    }
    let limits = &manifest.limits;
    if limits.memory_bytes == 0
        || limits.maximum_instances == 0
        || limits.maximum_concurrent_calls == 0
        || limits.maximum_frame_bytes == 0
        || limits.call_timeout.0 == 0
        || limits.fuel == Some(0)
    {
        return Err(fail("limits"));
    }
    let mut kinds = BTreeSet::new();
    for kind in &manifest.owned_kinds {
        if kind.name.is_empty() || !kinds.insert(&kind.name) {
            return Err(fail("ownedKinds"));
        }
        for contract in [
            &kind.schema,
            &kind.validate,
            &kind.lower,
            &kind.index,
            &kind.migrate,
            &kind.reducer,
            &kind.lifecycle,
        ] {
            require_contract(manifest, contract)?;
        }
    }
    let mut contributions = BTreeSet::new();
    for contribution in &manifest.contributions {
        let id = match contribution {
            Contribution::FieldTable {
                id,
                definition_kind,
                fields,
            } => {
                if definition_kind.is_empty() || fields.iter().any(String::is_empty) {
                    return Err(fail("contributions"));
                }
                id
            }
            Contribution::ActionForm { id, .. } => id,
            Contribution::SourceMap { id, contract } | Contribution::Report { id, contract } => {
                require_contract(manifest, contract)?;
                id
            }
            Contribution::Resource {
                id,
                path,
                media_type,
            } => {
                if !manifest
                    .files
                    .iter()
                    .any(|file| &file.path == path && &file.media_type == media_type)
                {
                    return Err(fail("contributions.resource"));
                }
                id
            }
        };
        if id.is_empty() || !contributions.insert(id) {
            return Err(fail("contributions.id"));
        }
    }
    Ok(())
}

fn require_contract(
    manifest: &PackageManifest,
    reference: &ContractRef,
) -> Result<(), PackageError> {
    if manifest
        .contracts
        .iter()
        .any(|contract| &contract.reference == reference)
    {
        return Ok(());
    }
    Err(PackageError::new(PackageFailure::ContractMismatch {
        contract_id: reference.id.clone(),
    }))
}

pub(super) fn blob<'a>(
    manifest: &PackageManifest,
    files: &'a BTreeMap<String, Vec<u8>>,
    blob: &BlobRef,
) -> Result<&'a [u8], PackageError> {
    let mut matches = manifest
        .files
        .iter()
        .filter(|file| file.digest == blob.digest);
    let file = matches
        .next()
        .filter(|file| file.size == blob.byte_size)
        .ok_or_else(|| PackageError::new(PackageFailure::SchemaInvalid))?;
    if matches.next().is_some() {
        return Err(PackageError::new(PackageFailure::SchemaInvalid));
    }
    files.get(&file.path).map(Vec::as_slice).ok_or_else(|| {
        PackageError::new(PackageFailure::FileMissing {
            path: file.path.clone(),
        })
    })
}
