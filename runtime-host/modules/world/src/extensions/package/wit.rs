use std::collections::{BTreeMap, BTreeSet};

use world_protocol::{
    bindings::Entrypoint,
    package::{PackageArtifact, PackageFailure, PackageManifest},
};

use super::error::PackageError;

pub(super) fn validate(
    artifact: &PackageArtifact,
    manifest: &PackageManifest,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<(), PackageError> {
    let bad = || PackageError::new(PackageFailure::WitInvalid);
    let rejected = |reason: &'static str| {
        let error = bad();
        platform::trace::runtime_trace("world.package.wit_rejected", || {
            serde_json::json!({
                "phase": "verify",
                "reason": reason,
                "diagnosticIdHash": platform::trace::identifier_hash(error.diagnostic_id.as_str()),
            })
        });
        error
    };
    if artifact.abi.wit_files.is_empty() || artifact.abi.world.is_empty() {
        return Err(bad());
    }
    let closure: Vec<_> = artifact
        .abi
        .wit_files
        .iter()
        .map(|path| {
            manifest
                .files
                .iter()
                .find(|file| &file.path == path)
                .cloned()
                .ok_or_else(bad)
        })
        .collect::<Result<_, _>>()?;
    if world_protocol::package::wit_closure_digest(&closure).map_err(PackageError::new)?
        != artifact.abi.closure_digest
    {
        return Err(bad());
    }
    let mut paths = BTreeSet::new();
    let mut maps: BTreeMap<&str, wit_parser::SourceMap> = BTreeMap::new();
    let mut total = 0u64;
    for path in &artifact.abi.wit_files {
        if !paths.insert(path) || !path.ends_with(".wit") {
            return Err(bad());
        }
        let bytes = files
            .get(path)
            .ok_or_else(|| PackageError::new(PackageFailure::FileMissing { path: path.clone() }))?;
        total = total
            .checked_add(bytes.len() as u64 + 1)
            .filter(|size| *size <= u32::MAX as u64)
            .ok_or_else(bad)?;
        let text = std::str::from_utf8(bytes)
            .map_err(|cause| PackageError::caused(PackageFailure::WitInvalid, cause))?;
        let parent = path.rsplit_once('/').map_or("", |(parent, _)| parent);
        maps.entry(parent).or_default().push_str(path, text);
    }
    let mut groups = Vec::new();
    for (_, map) in maps {
        groups.push(map.parse().map_err(|_| rejected("source_parse"))?);
    }
    let main = groups.remove(0);
    let mut resolve = wit_parser::Resolve::default();
    resolve
        .features
        .extend(artifact.abi.required_features.iter().cloned());
    resolve
        .push_groups(main, groups)
        .map_err(|_| rejected("package_resolve"))?;
    let world = resolve
        .packages
        .iter()
        .find_map(|(id, package)| {
            package.worlds.iter().find_map(|(name, world)| {
                (resolve.id_of_name(id, name) == artifact.abi.world).then_some(*world)
            })
        })
        .ok_or_else(|| rejected("world_missing"))?;
    if let Entrypoint::Wasm { interface, .. } = &artifact.entrypoint {
        let exports = &resolve.worlds[world].exports;
        if !exports.keys().any(|key| match key {
            wit_parser::WorldKey::Name(name) => name == interface,
            wit_parser::WorldKey::Interface(id) => resolve.id_of(*id).as_ref() == Some(interface),
        }) {
            return Err(rejected("export_missing"));
        }
    }
    // References must name actual payload members; runtime binary probing happens at prepare.
    for contract in manifest.contracts.iter().filter(|contract| {
        artifact.abi.wit_files.iter().any(|path| {
            manifest
                .files
                .iter()
                .any(|file| &file.path == path && file.digest == contract.wit.digest)
        })
    }) {
        super::manifest::blob(manifest, files, &contract.wit)?;
    }
    Ok(())
}
