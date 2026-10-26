use ed25519_dalek::{Signature, VerifyingKey};
use std::{fs, path::PathBuf};
use world_plugin_sdk::{
    package::{self, BuiltPackage, ComponentKind, Error, NativeSourceKind},
    protocol::{package::SignatureEnvelope, wire},
};

fn main() {
    if let Err(error) = run() {
        eprintln!("world-pack: {error}");
        let mut cause = error.source();
        while let Some(error) = cause {
            eprintln!("  caused by: {error}");
            cause = error.source();
        }
        std::process::exit(1);
    }
}
fn run() -> Result<(), Error> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let usage = "usage: world-pack <connector|identity|schema|resolver|projection|provenance|compiler|policy|action|reconcile|abstraction|oracle|context|agent-bridge|storage> <version> <component.wasm> <output.worldpkg> | schema-kind <version> <component.wasm> <kind.json> <payload-request-schema.json> <payload-result-schema.json> <output.worldpkg> | materials <version> <host-executable> <target> <native-directory> <schema.json> <output.worldpkg> | oracle-process <version> <binary> <target> <output.worldpkg> | source <version> <binary> <target> <schema.json> <snapshot.json> <output.worldpkg> | <native-source-key-identity|native-definition-schema|native-checked-ir-compiler|native-current-policy|native-support-provenance|native-plan-action|native-field-oracle|native-assertion-projection|native-assertion-reconcile|native-contract-abstraction|native-query-bridge|native-postgres-storage|native-query-resolver|native-world-view-context> <version> <host-executable> <target> <output.worldpkg> | <native-postgres|native-http-json> <version> <host-executable> <target> <access.json> <output.worldpkg>\nEach form optionally accepts trailing --signature <envelope.json> --public-key <public-key.json> (either order); public-key.json must be a JSON array of exactly 32 bytes.";
    let tail = args
        .iter()
        .position(|arg| arg.starts_with("--"))
        .unwrap_or(args.len());
    let (args, flags) = args.split_at(tail);
    let signing_paths = match flags {
        [] => None,
        [flag, signature, key_flag, public_key]
            if flag == "--signature" && key_flag == "--public-key" =>
        {
            Some((signature, public_key))
        }
        [key_flag, public_key, flag, signature]
            if key_flag == "--public-key" && flag == "--signature" =>
        {
            Some((signature, public_key))
        }
        _ => return Err(usage.into()),
    };
    if signing_paths.is_some_and(|(signature, public_key)| {
        signature.starts_with("--") || public_key.starts_with("--")
    }) {
        return Err(usage.into());
    }
    let kind = args.first().ok_or(usage)?;
    let package = if kind == "source" && args.len() == 7 {
        package::source(
            args[1].parse()?,
            &args[3],
            bounded_read(&args[2], 1_073_741_824)?,
            &bounded_read(&args[4], 524_288)?,
            &bounded_read(&args[5], 524_288)?,
        )?
    } else if kind == "schema-kind" && args.len() == 7 {
        package::schema_kind(
            args[1].parse()?, bounded_read(&args[2], 67_108_864)?,
            world_plugin_sdk::protocol::wire::decode(&bounded_read(&args[3], 65_536)?, 65_536)?,
            &bounded_read(&args[4], 16_777_216)?, &bounded_read(&args[5], 16_777_216)?,
        )?
    } else if kind == "materials" && args.len() == 7 {
        let host = bounded_read(&args[2], 1_073_741_824)?;
        let mut native = std::collections::BTreeMap::new();
        read_native_directory(std::path::Path::new(&args[4]), "native", &mut native, &mut 0)?;
        package::materials(
            args[1].parse()?, &args[3], host, native,
            &bounded_read(&args[5], 16_777_216)?,
        )?
    } else if kind == "oracle-process" && args.len() == 5 {
        package::oracle_process(
            args[1].parse()?,
            &args[3],
            bounded_read(&args[2], 1_073_741_824)?,
        )?
    } else if matches!(
        kind.as_str(),
        "native-source-key-identity"
            | "native-definition-schema"
            | "native-checked-ir-compiler"
            | "native-current-policy"
            | "native-support-provenance"
            | "native-plan-action"
            | "native-field-oracle"
            | "native-assertion-projection"
            | "native-assertion-reconcile"
            | "native-contract-abstraction"
            | "native-query-bridge"
            | "native-postgres-storage"
            | "native-query-resolver"
            | "native-world-view-context"
    ) && args.len() == 5 {
        let version = args[1].parse()?;
        let host = bounded_read(&args[2], 1_073_741_824)?;
        match kind.as_str() {
            "native-source-key-identity" => package::native_identity(version, &args[3], &host)?,
            "native-definition-schema" => package::native_schema(version, &args[3], &host)?,
            "native-checked-ir-compiler" => package::native_compiler(version, &args[3], &host)?,
            "native-current-policy" => package::native_policy(version, &args[3], &host)?,
            "native-support-provenance" => package::native_provenance(version, &args[3], &host)?,
            "native-plan-action" => package::native_action(version, &args[3], &host)?,
            "native-field-oracle" => package::native_evaluation(version, &args[3], &host)?,
            "native-assertion-projection" => package::native_projection(version, &args[3], &host)?,
            "native-assertion-reconcile" => package::native_reconcile(version, &args[3], &host)?,
            "native-contract-abstraction" => package::native_abstraction(version, &args[3], &host)?,
            "native-query-bridge" => package::native_agent_bridge(version, &args[3], &host)?,
            "native-postgres-storage" => package::native_storage(version, &args[3], &host)?,
            "native-query-resolver" => package::native_resolver(version, &args[3], &host)?,
            _ => package::native_context(version, &args[3], &host)?,
        }
    } else if matches!(kind.as_str(), "native-postgres" | "native-http-json") && args.len() == 6 {
        let access: Vec<world_plugin_sdk::protocol::package::RequestedAccess> =
            world_plugin_sdk::protocol::wire::decode(&bounded_read(&args[4], 65_536)?, 65_536)?;
        package::native_source(
            if kind == "native-postgres" {
                NativeSourceKind::Postgres
            } else {
                NativeSourceKind::HttpJson
            },
            args[1].parse()?,
            &args[3],
            &bounded_read(&args[2], 1_073_741_824)?,
            &access,
        )?
    } else if args.len() == 4 {
        let kind = match kind.as_str() {
            "connector" => ComponentKind::Connector,
            "identity" => ComponentKind::Identity,
            "schema" => ComponentKind::Schema,
            "resolver" => ComponentKind::Resolver,
            "projection" => ComponentKind::Projection,
            "provenance" => ComponentKind::Provenance,
            "compiler" => ComponentKind::Compiler,
            "policy" => ComponentKind::Policy,
            "action" => ComponentKind::Action,
            "reconcile" => ComponentKind::Reconcile,
            "abstraction" => ComponentKind::Abstraction,
            "oracle" => ComponentKind::Oracle,
            "context" => ComponentKind::Context,
            "agent-bridge" => ComponentKind::AgentBridge,
            "storage" => ComponentKind::Storage,
            _ => return Err(usage.into()),
        };
        package::component(kind, args[1].parse()?, bounded_read(&args[2], 67_108_864)?)?
    } else {
        return Err(usage.into());
    };
    let output = PathBuf::from(args.last().ok_or(usage)?);
    let signature = if let Some((signature_path, public_key_path)) = signing_paths {
        let signature: SignatureEnvelope =
            wire::decode(&bounded_read(signature_path, 65_536)?, 65_536)?;
        if signature.publisher != package.manifest.identity.publisher
            || signature.package_digest != package.package_digest
        {
            return Err("signature does not name this exact manifest".into());
        }
        let public_key: [u8; 32] = wire::decode(&bounded_read(public_key_path, 1_024)?, 1_024)?;
        let key = VerifyingKey::from_bytes(&public_key)?;
        let signature_bytes = Signature::from_slice(&signature.signature)?;
        key.verify_strict(&package.signature_message(), &signature_bytes)?;
        Some(signature)
    } else {
        None
    };
    let bytes = package.archive(signature.as_ref())?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output)?;
    use std::io::Write;
    file.write_all(&bytes)?;
    file.sync_all()?;
    println!(
        "package={} transport={} output={}",
        package.package_digest,
        BuiltPackage::transport_digest(&bytes)?,
        output.display()
    );
    Ok(())
}
fn read_native_directory(
    directory: &std::path::Path,
    relative: &str,
    files: &mut std::collections::BTreeMap<String, Vec<u8>>,
    total: &mut u64,
) -> Result<(), Error> {
    let metadata = fs::symlink_metadata(directory)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() || relative.split('/').count() > 64 {
        return Err("native closure requires real bounded directories, not links".into());
    }
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name().into_string().map_err(|_| "native member name is not UTF-8")?;
        let relative = format!("{relative}/{name}");
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink() {
            return Err("native closure cannot include symbolic links".into());
        }
        if metadata.is_dir() {
            read_native_directory(&entry.path(), &relative, files, total)?;
        } else if metadata.is_file() {
            let path = entry.path();
            let bytes = bounded_read(path.to_str().ok_or("native path is not UTF-8")?, 1_073_741_824)?;
            *total = total.checked_add(bytes.len() as u64).filter(|total| *total <= 1_073_741_824)
                .ok_or("native closure exceeds package producer limit")?;
            if files.len() >= 4096 || files.insert(relative, bytes).is_some() {
                return Err("native closure has too many or duplicate members".into());
            }
        } else {
            return Err("native closure contains a non-regular member".into());
        }
    }
    Ok(())
}

fn bounded_read(path: &str, maximum: u64) -> Result<Vec<u8>, Error> {
    use std::io::Read;
    let file = fs::File::open(path)?;
    let mut bytes = Vec::new();
    file.take(maximum + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > maximum {
        return Err("input exceeds package producer limit".into());
    }
    Ok(bytes)
}
