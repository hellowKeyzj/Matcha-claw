use crate::protocol::{
    actions::{EffectIntent, SourceReceipt},
    bindings::{Entrypoint, SlotKind, TrustClass},
    budget::Budget,
    ids::*,
    materials::BlobRef,
    native,
    package::*,
    schema,
    slots::*,
    sources::{SourceFailure, SourcePage, SourceReadPlan},
    time::DurationMs,
    value::{Value, ValueType},
    wire,
};
use semver::Version;
use std::{
    collections::BTreeMap,
    io::{Cursor, Write},
};

pub type Error = Box<dyn std::error::Error + Send + Sync>;
const WIT_PATH: &str = "wit/world.wit";
const WIT: &[u8] = include_bytes!("../../protocol/wit/world.wit");

#[derive(Clone, Copy)]
pub enum ComponentKind {
    Connector,
    Identity,
    Schema,
    Resolver,
    Projection,
    Provenance,
    Compiler,
    Policy,
    Action,
    Reconcile,
    Abstraction,
    Oracle,
    Context,
    AgentBridge,
    Storage,
}

#[derive(Clone, Copy)]
pub enum NativeSourceKind {
    Postgres,
    HttpJson,
}

pub struct BuiltPackage {
    pub manifest: PackageManifest,
    pub manifest_bytes: Vec<u8>,
    pub package_digest: Digest,
    files: BTreeMap<String, Vec<u8>>,
}
impl BuiltPackage {
    pub fn signature_message(&self) -> Vec<u8> {
        signature_message(&self.package_digest)
    }
    pub fn archive(&self, signature: Option<&SignatureEnvelope>) -> Result<Vec<u8>, Error> {
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o644);
        archive.start_file("package.json", options)?;
        archive.write_all(&self.manifest_bytes)?;
        for (path, bytes) in &self.files {
            let executable = self.manifest.artifacts.iter().any(|artifact| {
                artifact.runtime == ArtifactRuntime::TrustedProcess
                    && artifact.path.as_ref() == Some(path)
            });
            archive.start_file(
                path,
                if executable {
                    options.unix_permissions(0o755)
                } else {
                    options
                },
            )?;
            archive.write_all(bytes)?;
        }
        if let Some(signature) = signature {
            if signature.package_digest != self.package_digest
                || signature.publisher != self.manifest.identity.publisher
            {
                return Err("signature does not name this exact manifest".into());
            }
            archive.start_file(SIGNATURE_PATH, options)?;
            archive.write_all(&wire::encode(signature, 65_536)?)?;
        }
        Ok(archive.finish()?.into_inner())
    }
    pub fn transport_digest(bytes: &[u8]) -> Result<Digest, Error> {
        Ok(schema::hash(bytes)?)
    }
}

pub fn component(
    kind: ComponentKind,
    version: Version,
    binary: Vec<u8>,
) -> Result<BuiltPackage, Error> {
    let binary = if binary.starts_with(b"\0asm\x01\0\0\0") {
        wit_component::ComponentEncoder::default()
            .module(&binary)?
            .validate(true)
            .encode()?
    } else if binary.starts_with(b"\0asm\x0d\0\x01\0") {
        binary
    } else {
        return Err("artifact is neither a typed core module nor a WebAssembly component".into());
    };
    let (name, slot, contract, request, result) = match kind {
        ComponentKind::Connector => (
            "connector",
            SlotKind::Connector,
            slot_contract(SlotKind::Connector)?,
            schema::bytes::<SourceReadPlan>()?,
            schema::bytes::<SourcePage>()?,
        ),
        ComponentKind::Identity => (
            "identity",
            SlotKind::Identity,
            slot_contract(SlotKind::Identity)?,
            schema::bytes::<crate::protocol::identity::IdentityResolveRequest>()?,
            schema::bytes::<crate::protocol::identity::IdentityProposal>()?,
        ),
        ComponentKind::Schema => (
            "schema",
            SlotKind::Schema,
            slot_contract(SlotKind::Schema)?,
            schema::bytes::<crate::protocol::compiler::CompileRequest>()?,
            schema::bytes::<crate::protocol::compiler::TypedIr>()?,
        ),
        ComponentKind::Resolver => (
            "resolver",
            SlotKind::Resolver,
            slot_contract(SlotKind::Resolver)?,
            schema::bytes::<ResolveQueryRequest>()?,
            schema::bytes::<ResolveQueryResult>()?,
        ),
        ComponentKind::Projection => (
            "projection",
            SlotKind::Projection,
            projection_contract()?,
            schema::bytes::<ProjectionRequest>()?,
            schema::bytes::<ProjectionResult>()?,
        ),
        ComponentKind::Reconcile => (
            "reconcile",
            SlotKind::Reconcile,
            reconcile_contract()?,
            schema::bytes::<ReconcileRequest>()?,
            schema::bytes::<ReconcileResult>()?,
        ),
        ComponentKind::Oracle => (
            "evaluation",
            SlotKind::Evaluation,
            evaluation_contract()?,
            schema::bytes::<OracleRequest>()?,
            schema::bytes::<OracleResult>()?,
        ),
        ComponentKind::Policy => (
            "obligation-policy",
            SlotKind::Policy,
            slot_contract(SlotKind::Policy)?,
            schema::bytes::<PolicyEvaluationRequest>()?,
            schema::bytes::<PolicyEvaluationResult>()?,
        ),
        ComponentKind::Provenance => (
            "provenance",
            SlotKind::Provenance,
            slot_contract(SlotKind::Provenance)?,
            schema::bytes::<crate::protocol::provenance::SupportSnapshot>()?,
            schema::bytes::<crate::protocol::provenance::SupportDeltaProposal>()?,
        ),
        ComponentKind::Compiler => (
            "compiler",
            SlotKind::Compiler,
            slot_contract(SlotKind::Compiler)?,
            schema::bytes::<crate::protocol::compiler::CompilerPassRequest>()?,
            schema::bytes::<crate::protocol::compiler::CompilerPassResult>()?,
        ),
        ComponentKind::Action => (
            "action",
            SlotKind::Action,
            slot_contract(SlotKind::Action)?,
            schema::bytes::<ActionPlanRequest>()?,
            schema::bytes::<ActionPlanResult>()?,
        ),
        ComponentKind::Abstraction => (
            "abstraction",
            SlotKind::Abstraction,
            slot_contract(SlotKind::Abstraction)?,
            schema::bytes::<crate::protocol::abstraction::AbstractionRequest>()?,
            schema::bytes::<crate::protocol::abstraction::AbstractionContract>()?,
        ),
        ComponentKind::Context => (
            "context",
            SlotKind::Context,
            slot_contract(SlotKind::Context)?,
            schema::bytes::<ContextRequest>()?,
            schema::bytes::<ContextResult>()?,
        ),
        ComponentKind::AgentBridge => (
            "agent-bridge",
            SlotKind::AgentBridge,
            slot_contract(SlotKind::AgentBridge)?,
            schema::bytes::<AgentBridgeRequest>()?,
            schema::bytes::<AgentBridgeResult>()?,
        ),
        ComponentKind::Storage => (
            "storage",
            SlotKind::Storage,
            slot_contract(SlotKind::Storage)?,
            schema::bytes::<StorageReadRequest>()?,
            schema::bytes::<StorageReadResult>()?,
        ),
    };
    let wit_component::DecodedWasm::Component(resolve, actual_world) =
        wit_component::decode(&binary)?
    else {
        return Err("artifact does not encode a component world".into());
    };
    let imports = resolve.worlds[actual_world]
        .imports
        .keys()
        .map(|key| resolve.name_world_key(key))
        .collect::<Vec<_>>();
    if imports.iter().any(|name| name.starts_with("wasi:")) {
        return Err(
            format!("ordinary component contains implicit WASI imports: {imports:?}").into(),
        );
    }
    let interface = crate::protocol::component::slot_interface(slot).to_owned();
    if !resolve.worlds[actual_world]
        .exports
        .keys()
        .any(|key| resolve.name_world_key(key) == interface)
    {
        return Err("component does not export the declared typed slot interface".into());
    }
    let world = crate::protocol::component::slot_world(slot).to_owned();
    build(
        name,
        version,
        binary,
        "component.wasm",
        crate::protocol::component::TARGET,
        ArtifactRuntime::WasmComponent,
        slot,
        contract,
        request,
        result,
        Entrypoint::Wasm {
            world: world.clone(),
            interface,
        },
        world,
        vec![ConfigField {
            name: "enabled".into(),
            value_type: ValueType::Boolean,
            required: true,
            default: Some(Value::Boolean { value: true }),
            mutable_at: ConfigMutability::Activation,
        }],
        Vec::new(),
    )
}

pub fn schema_kind(
    version: Version,
    binary: Vec<u8>,
    kind: KindContract,
    request_schema: &[u8],
    result_schema: &[u8],
) -> Result<BuiltPackage, Error> {
    if kind.name.is_empty() || kind.standard_kind.is_some() {
        return Err("open kind requires its own non-standard name".into());
    }
    let methods = [&kind.validate, &kind.lower, &kind.index, &kind.migrate, &kind.reducer, &kind.lifecycle];
    let mut references = std::collections::BTreeSet::new();
    for reference in std::iter::once(&kind.schema).chain(methods) {
        Version::parse(&reference.version)?;
        if !references.insert((&reference.id, &reference.version)) {
            return Err("kind contracts must have seven distinct exact declarations".into());
        }
    }
    for reference in methods { kind_port(reference)?; }
    let mut package = component(ComponentKind::Schema, version, binary)?;
    let files = [
        ("schemas/kind-schema-request.json", schema_blob(wire::decode(request_schema, 16_777_216)?)?),
        ("schemas/kind-schema-result.json", schema_blob(wire::decode(result_schema, 16_777_216)?)?),
        ("schemas/kind-request.json", schema::bytes::<crate::protocol::definitions::KindRequest>()?),
        ("schemas/kind-result.json", schema::bytes::<crate::protocol::definitions::KindResponse>()?),
        ("schemas/kind-method.json", schema::bytes::<schema::MethodSchema<crate::protocol::definitions::KindRequest, crate::protocol::definitions::KindResponse, crate::protocol::compiler::CompileFailure>>()?),
    ];
    for (path, bytes) in files {
        package.manifest.files.push(PackageFile { path: path.into(), size: bytes.len() as u64,
            digest: schema::hash(&bytes)?, media_type: "application/schema+json".into() });
        package.files.insert(path.into(), bytes);
    }
    let blob = |path: &str| -> Result<BlobRef, Error> {
        let file = package.manifest.files.iter().find(|file| file.path == path).ok_or("kind schema member missing")?;
        Ok(BlobRef { digest: file.digest.clone(), byte_size: file.size })
    };
    for (reference, request, result) in std::iter::once((&kind.schema, "schemas/kind-schema-request.json", "schemas/kind-schema-result.json"))
        .chain(methods.into_iter().map(|reference| (reference, "schemas/kind-request.json", "schemas/kind-result.json"))) {
        if package.manifest.contracts.iter().any(|declaration| declaration.reference.id == reference.id
            && declaration.reference.version == reference.version) {
            return Err("kind contract collides with the standard Schema contract".into());
        }
        package.manifest.contracts.push(PackageContract { reference: reference.clone(), wit: blob(WIT_PATH)?,
            request_schema: blob(request)?, result_schema: blob(result)? });
        package.manifest.provides[0].contracts.push(reference.clone());
    }
    schema_kind_ports(&package.manifest, &kind)?;
    package.manifest.owned_kinds.push(kind);
    package.manifest_bytes = wire::encode(&package.manifest, 1_048_576)?;
    package.package_digest = schema::hash(&package.manifest_bytes)?;
    Ok(package)
}

pub fn schema_kind_ports(
    manifest: &PackageManifest,
    kind: &KindContract,
) -> Result<Vec<crate::protocol::bindings::MethodPort>, Error> {
    let declaration = manifest.contracts.iter().find(|declaration| declaration.reference == kind.schema)
        .ok_or("kind payload schema declaration missing")?;
    let mut ports = vec![kind_schema_port(declaration)];
    for reference in [&kind.validate, &kind.lower, &kind.index, &kind.migrate, &kind.reducer, &kind.lifecycle] {
        if !manifest.contracts.iter().any(|declaration| &declaration.reference == reference) {
            return Err("kind method declaration missing".into());
        }
        ports.push(kind_port(reference)?);
    }
    Ok(ports)
}

pub fn oracle_process(
    version: Version,
    target: &str,
    binary: Vec<u8>,
) -> Result<BuiltPackage, Error> {
    if binary.is_empty() || target.is_empty() {
        return Err("oracle process requires an actual executable and target".into());
    }
    let contract = evaluation_contract()?;
    let path = if target.contains("windows") {
        "oracle.exe"
    } else {
        "oracle"
    };
    build(
        "field-oracle",
        version,
        binary,
        path,
        target,
        ArtifactRuntime::TrustedProcess,
        SlotKind::Evaluation,
        contract.clone(),
        schema::bytes::<OracleRequest>()?,
        schema::bytes::<OracleResult>()?,
        Entrypoint::Process {
            executable: path.into(),
            protocol: contract,
        },
        crate::protocol::component::slot_world(SlotKind::Evaluation).into(),
        vec![ConfigField {
            name: "enabled".into(),
            value_type: ValueType::Boolean,
            required: true,
            default: Some(Value::Boolean { value: true }),
            mutable_at: ConfigMutability::Activation,
        }],
        Vec::new(),
    )
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct MaterialsSchema {
    format: String,
    contract: crate::protocol::sources::ContractRef,
    method: serde_json::Value,
    request: serde_json::Value,
    result: serde_json::Value,
}

pub fn materials(
    version: Version,
    target: &str,
    host_executable: Vec<u8>,
    native_files: BTreeMap<String, Vec<u8>>,
    schema_bundle: &[u8],
) -> Result<BuiltPackage, Error> {
    if host_executable.is_empty() || target.is_empty() {
        return Err("materials requires an actual host executable and target".into());
    }
    let bundle: MaterialsSchema = wire::decode(schema_bundle, 16_777_216)?;
    let method = schema_blob(bundle.method)?;
    if bundle.format != "matcha.world-materials-api/1"
        || bundle.contract.id.as_str() != "world.materials.v1"
        || bundle.contract.version != "1.0.0"
        || bundle.contract.schema_digest != schema::hash(&method)? {
        return Err("materials schema bundle does not name its exact canonical method".into());
    }
    let path = if target.contains("windows") { "bin/runtime-host.exe" } else { "bin/runtime-host" };
    let mut files = BTreeMap::from([
        (WIT_PATH.into(), WIT.to_vec()),
        (path.into(), host_executable),
        ("schemas/request.json".into(), schema_blob(bundle.request)?),
        ("schemas/result.json".into(), schema_blob(bundle.result)?),
        ("schemas/method.json".into(), method),
    ]);
    for (path, bytes) in native_files {
        if !path.starts_with("native/") || path.contains('\\')
            || path.split('/').any(|part| part.is_empty() || matches!(part, "." | "..") || part.contains(':')) {
            return Err("materials native member must preserve its relative path under native/".into());
        }
        files.insert(path, bytes);
    }
    finish(
        "world-materials", version, files, Some(path), target, ArtifactRuntime::TrustedProcess, None,
        vec![ContractFiles { reference: bundle.contract.clone(), request: "schemas/request.json", result: "schemas/result.json" }],
        Entrypoint::Process { executable: path.into(), protocol: bundle.contract },
        "matcha:world/materials-worker@1.0.0".into(), Vec::new(), Vec::new(),
    )
}

fn schema_blob(value: serde_json::Value) -> Result<Vec<u8>, Error> {
    if !value.is_object() && !value.is_boolean() {
        return Err("schema must be a JSON object or boolean".into());
    }
    Ok(wire::encode(&schemars::Schema::try_from(value)?, 16_777_216)?)
}

pub fn source(
    version: Version,
    target: &str,
    binary: Vec<u8>,
    source_schema: &[u8],
    snapshot: &[u8],
) -> Result<BuiltPackage, Error> {
    let source_schema: crate::protocol::sources::PluginResource =
        wire::decode(source_schema, 524_288)?;
    let snapshot: SourcePage = wire::decode(snapshot, 524_288)?;
    let snapshot = crate::source::prepare_snapshot(&source_schema, snapshot)
        .map_err(|failure| format!("recorded snapshot rejected: {failure:?}"))?;
    let requested_access = vec![RequestedAccess::SourceRead {
        source_id: snapshot.basis.source_id.clone(),
    }];
    let snapshot = String::from_utf8(wire::encode(&snapshot, 524_288)?)?;
    let source_schema = String::from_utf8(wire::encode(&source_schema, 524_288)?)?;
    let fields = vec![
        ConfigField {
            name: "schema".into(),
            value_type: ValueType::Text {
                max_length: 524_288,
            },
            required: true,
            default: Some(Value::Text {
                value: source_schema,
            }),
            mutable_at: ConfigMutability::Install,
        },
        ConfigField {
            name: "snapshot".into(),
            value_type: ValueType::Text {
                max_length: 524_288,
            },
            required: true,
            default: Some(Value::Text { value: snapshot }),
            mutable_at: ConfigMutability::Install,
        },
    ];
    let config_fields = fields
        .iter()
        .map(|field| crate::protocol::api::ConfigValue {
            name: field.name.clone(),
            value: field.default.clone().expect("source defaults"),
        })
        .collect::<Vec<_>>();
    let config = crate::protocol::api::PackageConfigView {
        install_id: InstallId::try_new("source-package-check")?,
        revision: Revision(1),
        digest: crate::protocol::api::package_config_digest(&config_fields)?,
        fields: config_fields,
    };
    crate::source::RecordedSource::from_config(&config)
        .map_err(|failure| format!("recorded snapshot rejected: {failure:?}"))?;
    let contract = crate::protocol::sources::read_contract()?;
    let path = if target.contains("windows") {
        "source.exe"
    } else {
        "source"
    };
    build(
        "recorded-source",
        version,
        binary,
        path,
        target,
        ArtifactRuntime::TrustedProcess,
        SlotKind::Connector,
        contract.clone(),
        schema::bytes::<SourceReadPlan>()?,
        schema::bytes::<SourcePage>()?,
        Entrypoint::Process {
            executable: path.into(),
            protocol: contract,
        },
        crate::protocol::component::slot_world(SlotKind::Connector).into(),
        fields,
        requested_access,
    )
}

pub fn native_identity(
    version: Version,
    target: &str,
) -> Result<BuiltPackage, Error> {
    if target.is_empty() {
        return Err("native identity requires a target".into());
    }
    use crate::protocol::identity::{IdentityFailure, IdentityProposal, IdentityResolveRequest};
    finish(
        "source-key-identity",
        version,
        BTreeMap::from([
            (WIT_PATH.into(), WIT.to_vec()),
            (
                "schemas/request.json".into(),
                schema::bytes::<IdentityResolveRequest>()?,
            ),
            (
                "schemas/result.json".into(),
                schema::bytes::<IdentityProposal>()?,
            ),
            (
                "schemas/method.json".into(),
                schema::bytes::<
                    schema::MethodSchema<IdentityResolveRequest, IdentityProposal, IdentityFailure>,
                >()?,
            ),
        ]),
        None,
        target,
        ArtifactRuntime::Native,
        Some(SlotKind::Identity),
        vec![ContractFiles {
            reference: crate::protocol::identity::resolve_contract()?,
            request: "schemas/request.json",
            result: "schemas/result.json",
        }],
        builtin_entrypoint(crate::protocol::identity::SOURCE_KEY_REGISTRATION)?,
        crate::protocol::component::slot_world(SlotKind::Identity).into(),
        Vec::new(),
        Vec::new(),
    )
}

pub fn native_schema(
    version: Version,
    target: &str,
) -> Result<BuiltPackage, Error> {
    if target.is_empty() {
        return Err("native schema requires a target".into());
    }
    use crate::protocol::compiler::{CompileFailure, CompileRequest, TypedIr};
    finish(
        "definition-schema",
        version,
        BTreeMap::from([
            (WIT_PATH.into(), WIT.to_vec()),
            (
                "schemas/request.json".into(),
                schema::bytes::<CompileRequest>()?,
            ),
            ("schemas/result.json".into(), schema::bytes::<TypedIr>()?),
            (
                "schemas/method.json".into(),
                schema::bytes::<schema::MethodSchema<CompileRequest, TypedIr, CompileFailure>>()?,
            ),
        ]),
        None,
        target,
        ArtifactRuntime::Native,
        Some(SlotKind::Schema),
        vec![ContractFiles {
            reference: slot_contract(SlotKind::Schema)?,
            request: "schemas/request.json",
            result: "schemas/result.json",
        }],
        builtin_entrypoint(SCHEMA_REGISTRATION)?,
        crate::protocol::component::slot_world(SlotKind::Schema).into(),
        Vec::new(),
        Vec::new(),
    )
}

pub fn native_compiler(
    version: Version,
    target: &str,
) -> Result<BuiltPackage, Error> {
    if target.is_empty() {
        return Err("native compiler requires a target".into());
    }
    use crate::protocol::compiler::{CompileFailure, CompilerPassRequest, CompilerPassResult};
    finish(
        "checked-ir-compiler",
        version,
        BTreeMap::from([
            (WIT_PATH.into(), WIT.to_vec()),
            ("schemas/request.json".into(), schema::bytes::<CompilerPassRequest>()?),
            ("schemas/result.json".into(), schema::bytes::<CompilerPassResult>()?),
            (
                "schemas/method.json".into(),
                schema::bytes::<schema::MethodSchema<CompilerPassRequest, CompilerPassResult, CompileFailure>>()?,
            ),
        ]),
        None,
        target,
        ArtifactRuntime::Native,
        Some(SlotKind::Compiler),
        vec![ContractFiles {
            reference: slot_contract(SlotKind::Compiler)?,
            request: "schemas/request.json",
            result: "schemas/result.json",
        }],
        builtin_entrypoint(COMPILER_REGISTRATION)?,
        crate::protocol::component::slot_world(SlotKind::Compiler).into(),
        Vec::new(),
        Vec::new(),
    )
}

pub fn native_policy(
    version: Version,
    target: &str,
) -> Result<BuiltPackage, Error> {
    if target.is_empty() {
        return Err("native policy requires a target".into());
    }
    finish(
        "current-policy",
        version,
        BTreeMap::from([
            (WIT_PATH.into(), WIT.to_vec()),
            ("schemas/request.json".into(), schema::bytes::<PolicyEvaluationRequest>()?),
            ("schemas/result.json".into(), schema::bytes::<PolicyEvaluationResult>()?),
            (
                "schemas/method.json".into(),
                schema::bytes::<schema::MethodSchema<PolicyEvaluationRequest, PolicyEvaluationResult, crate::protocol::authorization::AuthorizationFailure>>()?,
            ),
        ]),
        None,
        target,
        ArtifactRuntime::Native,
        Some(SlotKind::Policy),
        vec![ContractFiles {
            reference: slot_contract(SlotKind::Policy)?,
            request: "schemas/request.json",
            result: "schemas/result.json",
        }],
        builtin_entrypoint(POLICY_REGISTRATION)?,
        crate::protocol::component::slot_world(SlotKind::Policy).into(),
        Vec::new(),
        Vec::new(),
    )
}

pub fn native_provenance(
    version: Version,
    target: &str,
) -> Result<BuiltPackage, Error> {
    if target.is_empty() {
        return Err("native provenance requires a target".into());
    }
    use crate::protocol::provenance::{ProvenanceFailure, SupportDeltaProposal, SupportSnapshot};
    finish(
        "support-provenance", version,
        BTreeMap::from([
            (WIT_PATH.into(), WIT.to_vec()),
            ("schemas/request.json".into(), schema::bytes::<SupportSnapshot>()?),
            ("schemas/result.json".into(), schema::bytes::<SupportDeltaProposal>()?),
            ("schemas/method.json".into(), schema::bytes::<schema::MethodSchema<SupportSnapshot, SupportDeltaProposal, ProvenanceFailure>>()?),
        ]),
        None, target, ArtifactRuntime::Native, Some(SlotKind::Provenance),
        vec![ContractFiles { reference: slot_contract(SlotKind::Provenance)?, request: "schemas/request.json", result: "schemas/result.json" }],
        builtin_entrypoint(PROVENANCE_REGISTRATION)?,
        crate::protocol::component::slot_world(SlotKind::Provenance).into(), Vec::new(), Vec::new(),
    )
}

pub fn native_action(
    version: Version,
    target: &str,
) -> Result<BuiltPackage, Error> {
    if target.is_empty() {
        return Err("native action requires a target".into());
    }
    finish(
        "plan-action", version,
        BTreeMap::from([
            (WIT_PATH.into(), WIT.to_vec()),
            ("schemas/request.json".into(), schema::bytes::<ActionPlanRequest>()?),
            ("schemas/result.json".into(), schema::bytes::<ActionPlanResult>()?),
            ("schemas/method.json".into(), schema::bytes::<schema::MethodSchema<ActionPlanRequest, ActionPlanResult, crate::protocol::actions::ActionFailure>>()?),
        ]),
        None, target, ArtifactRuntime::Native, Some(SlotKind::Action),
        vec![ContractFiles { reference: slot_contract(SlotKind::Action)?, request: "schemas/request.json", result: "schemas/result.json" }],
        builtin_entrypoint(ACTION_REGISTRATION)?,
        crate::protocol::component::slot_world(SlotKind::Action).into(), Vec::new(), Vec::new(),
    )
}

pub fn native_evaluation(
    version: Version,
    target: &str,
) -> Result<BuiltPackage, Error> {
    if target.is_empty() {
        return Err("native evaluation requires a target".into());
    }
    finish(
        "field-oracle", version,
        BTreeMap::from([
            (WIT_PATH.into(), WIT.to_vec()),
            ("schemas/request.json".into(), schema::bytes::<OracleRequest>()?),
            ("schemas/result.json".into(), schema::bytes::<OracleResult>()?),
            ("schemas/method.json".into(), schema::bytes::<schema::MethodSchema<OracleRequest, OracleResult, OracleFailure>>()?),
        ]),
        None, target, ArtifactRuntime::Native, Some(SlotKind::Evaluation),
        vec![ContractFiles { reference: evaluation_contract()?, request: "schemas/request.json", result: "schemas/result.json" }],
        builtin_entrypoint(EVALUATION_REGISTRATION)?,
        crate::protocol::component::slot_world(SlotKind::Evaluation).into(),
        vec![ConfigField {
            name: "enabled".into(), value_type: ValueType::Boolean, required: true,
            default: Some(Value::Boolean { value: true }), mutable_at: ConfigMutability::Activation,
        }],
        Vec::new(),
    )
}

pub fn native_projection(
    version: Version, target: &str,
) -> Result<BuiltPackage, Error> {
    if target.is_empty() {
        return Err("native projection requires a target".into());
    }
    finish(
        "assertion-projection", version,
        BTreeMap::from([
            (WIT_PATH.into(), WIT.to_vec()),
            ("schemas/request.json".into(), schema::bytes::<ProjectionRequest>()?),
            ("schemas/result.json".into(), schema::bytes::<ProjectionResult>()?),
            ("schemas/method.json".into(), schema::bytes::<schema::MethodSchema<ProjectionRequest, ProjectionResult, ProjectionFailure>>()?),
        ]),
        None, target, ArtifactRuntime::Native, Some(SlotKind::Projection),
        vec![ContractFiles { reference: projection_contract()?, request: "schemas/request.json", result: "schemas/result.json" }],
        builtin_entrypoint(PROJECTION_REGISTRATION)?,
        crate::protocol::component::slot_world(SlotKind::Projection).into(), Vec::new(), Vec::new(),
    )
}

pub fn native_reconcile(
    version: Version, target: &str,
) -> Result<BuiltPackage, Error> {
    if target.is_empty() {
        return Err("native reconcile requires a target".into());
    }
    finish(
        "assertion-reconcile", version,
        BTreeMap::from([
            (WIT_PATH.into(), WIT.to_vec()),
            ("schemas/request.json".into(), schema::bytes::<ReconcileRequest>()?),
            ("schemas/result.json".into(), schema::bytes::<ReconcileResult>()?),
            ("schemas/method.json".into(), schema::bytes::<schema::MethodSchema<ReconcileRequest, ReconcileResult, ReconcileFailure>>()?),
        ]),
        None, target, ArtifactRuntime::Native, Some(SlotKind::Reconcile),
        vec![ContractFiles { reference: reconcile_contract()?, request: "schemas/request.json", result: "schemas/result.json" }],
        builtin_entrypoint(RECONCILE_REGISTRATION)?,
        crate::protocol::component::slot_world(SlotKind::Reconcile).into(), Vec::new(), Vec::new(),
    )
}

pub fn native_abstraction(
    version: Version, target: &str,
) -> Result<BuiltPackage, Error> {
    if target.is_empty() {
        return Err("native abstraction requires a target".into());
    }
    use crate::protocol::abstraction::{AbstractionContract, AbstractionFailure, AbstractionRequest};
    finish(
        "contract-abstraction", version,
        BTreeMap::from([
            (WIT_PATH.into(), WIT.to_vec()),
            ("schemas/request.json".into(), schema::bytes::<AbstractionRequest>()?),
            ("schemas/result.json".into(), schema::bytes::<AbstractionContract>()?),
            ("schemas/method.json".into(), schema::bytes::<schema::MethodSchema<AbstractionRequest, AbstractionContract, AbstractionFailure>>()?),
        ]),
        None, target, ArtifactRuntime::Native, Some(SlotKind::Abstraction),
        vec![ContractFiles { reference: slot_contract(SlotKind::Abstraction)?, request: "schemas/request.json", result: "schemas/result.json" }],
        builtin_entrypoint(ABSTRACTION_REGISTRATION)?,
        crate::protocol::component::slot_world(SlotKind::Abstraction).into(), Vec::new(), Vec::new(),
    )
}

pub fn native_agent_bridge(
    version: Version, target: &str,
) -> Result<BuiltPackage, Error> {
    if target.is_empty() {
        return Err("native agent bridge requires a target".into());
    }
    finish(
        "query-bridge", version,
        BTreeMap::from([
            (WIT_PATH.into(), WIT.to_vec()),
            ("schemas/request.json".into(), schema::bytes::<AgentBridgeRequest>()?),
            ("schemas/result.json".into(), schema::bytes::<AgentBridgeResult>()?),
            ("schemas/method.json".into(), schema::bytes::<schema::MethodSchema<AgentBridgeRequest, AgentBridgeResult, BridgeFailure>>()?),
        ]),
        None, target, ArtifactRuntime::Native, Some(SlotKind::AgentBridge),
        vec![ContractFiles { reference: slot_contract(SlotKind::AgentBridge)?, request: "schemas/request.json", result: "schemas/result.json" }],
        builtin_entrypoint(AGENT_BRIDGE_REGISTRATION)?,
        crate::protocol::component::slot_world(SlotKind::AgentBridge).into(), Vec::new(), Vec::new(),
    )
}

pub fn native_storage(
    version: Version, target: &str,
) -> Result<BuiltPackage, Error> {
    if target.is_empty() {
        return Err("native storage requires a target".into());
    }
    finish(
        "postgres-storage", version,
        BTreeMap::from([
            (WIT_PATH.into(), WIT.to_vec()),
            ("schemas/request.json".into(), schema::bytes::<StorageReadRequest>()?),
            ("schemas/result.json".into(), schema::bytes::<StorageReadResult>()?),
            ("schemas/method.json".into(), schema::bytes::<schema::MethodSchema<StorageReadRequest, StorageReadResult, crate::protocol::commit::CommitFailure>>()?),
        ]),
        None, target, ArtifactRuntime::Native, Some(SlotKind::Storage),
        vec![ContractFiles { reference: slot_contract(SlotKind::Storage)?, request: "schemas/request.json", result: "schemas/result.json" }],
        builtin_entrypoint(STORAGE_REGISTRATION)?,
        crate::protocol::component::slot_world(SlotKind::Storage).into(), Vec::new(), Vec::new(),
    )
}

pub fn native_resolver(
    version: Version,
    target: &str,
) -> Result<BuiltPackage, Error> {
    if target.is_empty() {
        return Err("native resolver requires a target".into());
    }
    finish(
        "query-resolver",
        version,
        BTreeMap::from([
            (WIT_PATH.into(), WIT.to_vec()),
            (
                "schemas/request.json".into(),
                schema::bytes::<ResolveQueryRequest>()?,
            ),
            (
                "schemas/result.json".into(),
                schema::bytes::<ResolveQueryResult>()?,
            ),
            (
                "schemas/method.json".into(),
                schema::bytes::<schema::MethodSchema<
                    ResolveQueryRequest,
                    ResolveQueryResult,
                    crate::protocol::query::QueryFailure,
                >>()?,
            ),
        ]),
        None,
        target,
        ArtifactRuntime::Native,
        Some(SlotKind::Resolver),
        vec![ContractFiles {
            reference: slot_contract(SlotKind::Resolver)?,
            request: "schemas/request.json",
            result: "schemas/result.json",
        }],
        builtin_entrypoint(RESOLVER_REGISTRATION)?,
        crate::protocol::component::slot_world(SlotKind::Resolver).into(),
        Vec::new(),
        Vec::new(),
    )
}

pub fn native_context(
    version: Version,
    target: &str,
) -> Result<BuiltPackage, Error> {
    if target.is_empty() {
        return Err("native context requires a target".into());
    }
    finish(
        "world-view-context",
        version,
        BTreeMap::from([
            (WIT_PATH.into(), WIT.to_vec()),
            (
                "schemas/request.json".into(),
                schema::bytes::<ContextRequest>()?,
            ),
            (
                "schemas/result.json".into(),
                schema::bytes::<ContextResult>()?,
            ),
            (
                "schemas/method.json".into(),
                schema::bytes::<schema::MethodSchema<
                    ContextRequest,
                    ContextResult,
                    crate::protocol::abstraction::ContextFailure,
                >>()?,
            ),
        ]),
        None,
        target,
        ArtifactRuntime::Native,
        Some(SlotKind::Context),
        vec![ContractFiles {
            reference: slot_contract(SlotKind::Context)?,
            request: "schemas/request.json",
            result: "schemas/result.json",
        }],
        builtin_entrypoint(CONTEXT_REGISTRATION)?,
        crate::protocol::component::slot_world(SlotKind::Context).into(),
        Vec::new(),
        Vec::new(),
    )
}

pub fn native_source(
    kind: NativeSourceKind,
    version: Version,
    target: &str,
    requested_access: &[RequestedAccess],
) -> Result<BuiltPackage, Error> {
    if target.is_empty() {
        return Err("native source requires a target".into());
    }
    if !requested_access
        .iter()
        .any(|access| matches!(access, RequestedAccess::SourceRead { .. }))
        || !requested_access.iter().any(
            |access| matches!(access, RequestedAccess::Network { origin } if !origin.is_empty()),
        )
        || requested_access.iter().any(|access| match access {
            RequestedAccess::SourceRead { .. } => false,
            RequestedAccess::Network { origin } => origin.is_empty(),
            _ => true,
        })
        || requested_access
            .iter()
            .enumerate()
            .any(|(index, access)| requested_access[..index].contains(access))
    {
        return Err(
            "native source requires explicit, unique SourceRead and canonical Network declarations"
                .into(),
        );
    }
    let (name, registration) = match kind {
        NativeSourceKind::Postgres => ("postgres", crate::protocol::sources::POSTGRES_REGISTRATION),
        NativeSourceKind::HttpJson => (
            "http-json",
            crate::protocol::sources::HTTP_JSON_REGISTRATION,
        ),
    };
    let mut files = BTreeMap::from([
        (WIT_PATH.into(), WIT.to_vec()),
        (
            "schemas/request.json".into(),
            schema::bytes::<SourceReadPlan>()?,
        ),
        ("schemas/result.json".into(), schema::bytes::<SourcePage>()?),
        (
            "schemas/method.json".into(),
            schema::bytes::<schema::MethodSchema<SourceReadPlan, SourcePage, SourceFailure>>()?,
        ),
    ]);
    let mut contracts = vec![ContractFiles {
        reference: crate::protocol::sources::read_contract()?,
        request: "schemas/request.json",
        result: "schemas/result.json",
    }];
    if matches!(kind, NativeSourceKind::Postgres) {
        files.insert(
            "schemas/effect-request.json".into(),
            schema::bytes::<EffectIntent>()?,
        );
        files.insert(
            "schemas/effect-result.json".into(),
            schema::bytes::<SourceReceipt>()?,
        );
        files.insert(
            "schemas/effect-method.json".into(),
            schema::bytes::<schema::MethodSchema<EffectIntent, SourceReceipt, SourceFailure>>()?,
        );
        for reference in [
            crate::protocol::sources::write_contract()?,
            crate::protocol::sources::inspect_contract()?,
        ] {
            contracts.push(ContractFiles {
                reference,
                request: "schemas/effect-request.json",
                result: "schemas/effect-result.json",
            });
        }
    }
    finish(
        name,
        version,
        files,
        None,
        target,
        ArtifactRuntime::Native,
        Some(SlotKind::Connector),
        contracts,
        builtin_entrypoint(registration)?,
        crate::protocol::component::slot_world(SlotKind::Connector).into(),
        Vec::new(),
        requested_access.to_vec(),
    )
}

fn builtin_entrypoint(registration: &str) -> Result<Entrypoint, Error> {
    Ok(native::implementation(registration)
        .ok_or("unknown built-in implementation registration")?
        .entrypoint())
}

struct ContractFiles {
    reference: crate::protocol::sources::ContractRef,
    request: &'static str,
    result: &'static str,
}

#[allow(clippy::too_many_arguments)]
fn build(
    name: &str,
    version: Version,
    binary: Vec<u8>,
    path: &str,
    target: &str,
    runtime: ArtifactRuntime,
    slot: SlotKind,
    contract: crate::protocol::sources::ContractRef,
    request: Vec<u8>,
    result: Vec<u8>,
    entrypoint: Entrypoint,
    world: String,
    config: Vec<ConfigField>,
    requested_access: Vec<RequestedAccess>,
) -> Result<BuiltPackage, Error> {
    let mut files: BTreeMap<String, Vec<u8>> = BTreeMap::from([
        (WIT_PATH.into(), WIT.to_vec()),
        (path.into(), binary),
        ("schemas/request.json".into(), request),
        ("schemas/result.json".into(), result),
    ]);
    // The method schema includes its typed domain failure, unlike the two individual port schemas.
    let method_schema = match slot {
        SlotKind::Projection => schema::bytes::<
            schema::MethodSchema<ProjectionRequest, ProjectionResult, ProjectionFailure>,
        >()?,
        SlotKind::Reconcile => schema::bytes::<
            schema::MethodSchema<ReconcileRequest, ReconcileResult, ReconcileFailure>,
        >()?,
        SlotKind::Evaluation => {
            schema::bytes::<schema::MethodSchema<OracleRequest, OracleResult, OracleFailure>>()?
        }
        SlotKind::Connector => {
            schema::bytes::<schema::MethodSchema<SourceReadPlan, SourcePage, SourceFailure>>()?
        }
        SlotKind::Policy => schema::bytes::<
            schema::MethodSchema<
                PolicyEvaluationRequest,
                PolicyEvaluationResult,
                crate::protocol::authorization::AuthorizationFailure,
            >,
        >()?,
        SlotKind::Identity => schema::bytes::<
            schema::MethodSchema<
                crate::protocol::identity::IdentityResolveRequest,
                crate::protocol::identity::IdentityProposal,
                crate::protocol::identity::IdentityFailure,
            >,
        >()?,
        SlotKind::Schema => schema::bytes::<
            schema::MethodSchema<
                crate::protocol::compiler::CompileRequest,
                crate::protocol::compiler::TypedIr,
                crate::protocol::compiler::CompileFailure,
            >,
        >()?,
        SlotKind::Resolver => schema::bytes::<
            schema::MethodSchema<
                ResolveQueryRequest,
                ResolveQueryResult,
                crate::protocol::query::QueryFailure,
            >,
        >()?,
        SlotKind::Provenance => schema::bytes::<
            schema::MethodSchema<
                crate::protocol::provenance::SupportSnapshot,
                crate::protocol::provenance::SupportDeltaProposal,
                crate::protocol::provenance::ProvenanceFailure,
            >,
        >()?,
        SlotKind::Compiler => schema::bytes::<
            schema::MethodSchema<
                crate::protocol::compiler::CompilerPassRequest,
                crate::protocol::compiler::CompilerPassResult,
                crate::protocol::compiler::CompileFailure,
            >,
        >()?,
        SlotKind::Action => schema::bytes::<
            schema::MethodSchema<
                ActionPlanRequest,
                ActionPlanResult,
                crate::protocol::actions::ActionFailure,
            >,
        >()?,
        SlotKind::Abstraction => schema::bytes::<
            schema::MethodSchema<
                crate::protocol::abstraction::AbstractionRequest,
                crate::protocol::abstraction::AbstractionContract,
                crate::protocol::abstraction::AbstractionFailure,
            >,
        >()?,
        SlotKind::Context => schema::bytes::<
            schema::MethodSchema<
                ContextRequest,
                ContextResult,
                crate::protocol::abstraction::ContextFailure,
            >,
        >()?,
        SlotKind::AgentBridge => schema::bytes::<
            schema::MethodSchema<AgentBridgeRequest, AgentBridgeResult, BridgeFailure>,
        >()?,
        SlotKind::Storage => schema::bytes::<
            schema::MethodSchema<
                StorageReadRequest,
                StorageReadResult,
                crate::protocol::commit::CommitFailure,
            >,
        >()?,
    };
    files.insert("schemas/method.json".into(), method_schema);
    let mut contracts = vec![ContractFiles {
        reference: contract,
        request: "schemas/request.json",
        result: "schemas/result.json",
    }];
    if slot == SlotKind::Connector {
        use crate::protocol::sources::{SchemaObservation, SourceSchemaRequest};
        files.insert(
            "schemas/discover-request.json".into(),
            schema::bytes::<SourceSchemaRequest>()?,
        );
        files.insert(
            "schemas/discover-result.json".into(),
            schema::bytes::<SchemaObservation>()?,
        );
        files.insert(
            "schemas/discover-method.json".into(),
            schema::bytes::<
                schema::MethodSchema<SourceSchemaRequest, SchemaObservation, SourceFailure>,
            >()?,
        );
        contracts.push(ContractFiles {
            reference: crate::protocol::sources::discover_contract()?,
            request: "schemas/discover-request.json",
            result: "schemas/discover-result.json",
        });
    }
    finish(
        name,
        version,
        files,
        Some(path),
        target,
        runtime,
        Some(slot),
        contracts,
        entrypoint,
        world,
        config,
        requested_access,
    )
}

#[allow(clippy::too_many_arguments)]
fn finish(
    name: &str,
    version: Version,
    files: BTreeMap<String, Vec<u8>>,
    path: Option<&str>,
    target: &str,
    runtime: ArtifactRuntime,
    slot: Option<SlotKind>,
    contracts: Vec<ContractFiles>,
    entrypoint: Entrypoint,
    world: String,
    config: Vec<ConfigField>,
    requested_access: Vec<RequestedAccess>,
) -> Result<BuiltPackage, Error> {
    let declared: Vec<_> = files
        .iter()
        .map(|(path, bytes)| {
            Ok(PackageFile {
                path: path.clone(),
                size: bytes.len() as u64,
                digest: schema::hash(bytes)?,
                media_type: if path.ends_with(".wit") {
                    "text/plain"
                } else if path.ends_with(".json") {
                    "application/schema+json"
                } else if path.ends_with(".wasm") {
                    "application/wasm"
                } else {
                    "application/octet-stream"
                }
                .into(),
            })
        })
        .collect::<Result<_, Error>>()?;
    let blob = |path: &str| -> Result<BlobRef, Error> {
        let file = declared
            .iter()
            .find(|file| file.path == path)
            .ok_or("package member missing")?;
        Ok(BlobRef {
            digest: file.digest.clone(),
            byte_size: file.size,
        })
    };
    let artifact_id = ArtifactId::try_new(name)?;
    let artifact = PackageArtifact {
        id: artifact_id.clone(),
        runtime,
        kind: ArtifactKind::Implementation,
        target: target.into(),
        path: path.map(str::to_owned),
        digest: match &entrypoint {
            Entrypoint::Builtin { registration, .. } => {
                let implementation = native::implementation(registration)
                    .ok_or("unknown built-in implementation registration")?;
                if runtime != ArtifactRuntime::Native
                    || path.is_some()
                    || slot != Some(implementation.slot)
                    || entrypoint != implementation.entrypoint()
                {
                    return Err("built-in artifact does not match its implementation descriptor".into());
                }
                implementation.digest()?
            }
            Entrypoint::Native { .. } => {
                return Err("legacy Native entrypoints cannot be generated; use a built-in descriptor".into());
            }
            _ if runtime == ArtifactRuntime::Native => {
                return Err("native artifacts require a built-in implementation descriptor".into());
            }
            _ => blob(path.ok_or("non-native artifact path missing")?)?.digest,
        },
        entrypoint,
        abi: AbiContract {
            world,
            wit_files: vec![WIT_PATH.into()],
            closure_digest: wit_closure_digest(
                &declared
                    .iter()
                    .filter(|file| file.path == WIT_PATH)
                    .cloned()
                    .collect::<Vec<_>>(),
            )
            .map_err(|failure| format!("WIT closure: {failure:?}"))?,
            version: Version::new(1, 0, 0),
            required_features: Vec::new(),
        },
        features: Vec::new(),
    };
    let references = contracts
        .iter()
        .map(|contract| contract.reference.clone())
        .collect();
    let contracts = contracts
        .into_iter()
        .map(|contract| {
            Ok(PackageContract {
                reference: contract.reference,
                wit: blob(WIT_PATH)?,
                request_schema: blob(contract.request)?,
                result_schema: blob(contract.result)?,
            })
        })
        .collect::<Result<_, Error>>()?;
    let native = runtime == ArtifactRuntime::Native;
    let manifest = PackageManifest {
        format: MANIFEST_FORMAT.into(),
        identity: PackageIdentity {
            publisher: PublisherId::try_new(if slot.is_some() { "matcha-offline" } else { "matcha" })?,
            id: PackageId::try_new(if slot.is_some() {
                format!("{}-{name}", if native { "native" } else { "recorded" })
            } else {
                name.to_owned()
            })?,
            version,
        },
        artifacts: vec![artifact],
        contracts,
        provides: slot.map(|slot| -> Result<_, Error> { Ok(ProvidedImplementation {
            provider_id: ProviderId::try_new(format!(
                "{}.{name}",
                if native { "source" } else { "offline" }
            ))?,
            slot,
            artifact_id,
            contracts: references,
            trust: match runtime {
                ArtifactRuntime::TrustedProcess => TrustClass::TrustedProcess,
                ArtifactRuntime::Native => TrustClass::TrustedNative,
                ArtifactRuntime::WasmComponent => TrustClass::OrdinaryGuest,
            },
        }) }).transpose()?.into_iter().collect(),
        files: declared,
        requires: Vec::new(),
        dependencies: Vec::new(),
        config: ConfigSchema {
            revision: Revision(1),
            fields: config,
        },
        state: Vec::new(),
        migrations: Vec::new(),
        requested_access,
        owned_kinds: Vec::new(),
        contributions: Vec::new(),
        limits: PackageLimits {
            memory_bytes: 67_108_864,
            fuel: (runtime == ArtifactRuntime::WasmComponent).then_some(20_000_000),
            maximum_instances: 1,
            maximum_concurrent_calls: 1,
            maximum_frame_bytes: 1_048_576,
            call_timeout: DurationMs(5000),
            budget: Budget {
                max_wall_time: DurationMs(5000),
                max_steps: 1_000_000,
                max_source_reads: if slot == Some(SlotKind::Connector) { 1 } else { 0 },
                max_rows: 4096,
                max_bytes: 1_048_576,
                max_model_calls: 0,
                max_input_tokens: 0,
                max_output_tokens: 0,
                max_cost: None,
                deadline: None,
            },
        },
    };
    let manifest_bytes = wire::encode(&manifest, 1_048_576)?;
    let package_digest = schema::hash(&manifest_bytes)?;
    Ok(BuiltPackage {
        manifest,
        manifest_bytes,
        package_digest,
        files,
    })
}
