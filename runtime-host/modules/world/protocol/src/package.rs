use crate::{
    bindings::{Entrypoint, SlotKind, TrustClass},
    budget::Budget,
    definitions::DefinitionKind,
    ids::*,
    materials::BlobRef,
    sources::ContractRef,
    time::{DurationMs, Timestamp},
    value::{Value, ValueType},
};
use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};

pub const MANIFEST_FORMAT: &str = "matcha.world-package/1";
pub const SIGNATURE_PATH: &str = "signatures/package.sig";
pub const REQUIRES_SANDBOX: &str = "requires_sandbox";
pub fn signature_message(package_digest: &Digest) -> Vec<u8> {
    format!("{MANIFEST_FORMAT}\n{package_digest}").into_bytes()
}

pub fn wit_closure_digest(files: &[PackageFile]) -> Result<Digest, PackageFailure> {
    use sha2::{Digest as _, Sha256};
    let mut files: Vec<_> = files.iter().collect();
    files.sort_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes()));
    let mut hash = Sha256::new();
    hash.update(b"matcha.world-wit-closure/1\n");
    let mut previous: Option<&str> = None;
    for file in files {
        if previous == Some(&file.path) {
            return Err(PackageFailure::DuplicatePath);
        }
        if file.path.is_empty()
            || file.path.starts_with('/')
            || file.path.contains('\\')
            || file
                .path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == ".." || part.contains(':'))
        {
            return Err(PackageFailure::InvalidPath);
        }
        previous = Some(&file.path);
        hash.update((file.path.len() as u64).to_be_bytes());
        hash.update(file.path.as_bytes());
        hash.update(file.size.to_be_bytes());
        let hex = &file.digest.as_str()[7..];
        for pair in hex.as_bytes().chunks_exact(2) {
            let digit = |b: u8| {
                if b.is_ascii_digit() {
                    b - b'0'
                } else {
                    b - b'a' + 10
                }
            };
            hash.update([digit(pair[0]) * 16 + digit(pair[1])]);
        }
    }
    Digest::try_new(format!("sha256:{:x}", hash.finalize()))
        .map_err(|_| PackageFailure::InternalFault)
}
pub fn install_lock_digest(
    packages: &[LockedPackage],
    contracts: &[ContractRef],
    artifacts: &[LockedArtifact],
) -> Result<Digest, PackageFailure> {
    use sha2::{Digest as _, Sha256};
    let mut packages = packages.to_vec();
    let mut contracts = contracts.to_vec();
    let mut artifacts = artifacts.to_vec();
    packages.sort_by(|a, b| {
        (
            &a.identity.publisher,
            &a.identity.id,
            &a.identity.version,
            &a.package_digest,
            &a.transport_digest,
        )
            .cmp(&(
                &b.identity.publisher,
                &b.identity.id,
                &b.identity.version,
                &b.package_digest,
                &b.transport_digest,
            ))
    });
    contracts.sort_by(|a, b| {
        (&a.id, &a.version, &a.schema_digest).cmp(&(&b.id, &b.version, &b.schema_digest))
    });
    artifacts.sort_by(|a, b| {
        (&a.package_digest, &a.artifact_id, &a.target, &a.digest).cmp(&(
            &b.package_digest,
            &b.artifact_id,
            &b.target,
            &b.digest,
        ))
    });
    let bytes = serde_json::to_vec(&(packages, contracts, artifacts))
        .map_err(|_| PackageFailure::InternalFault)?;
    let mut hash = Sha256::new();
    hash.update(b"matcha.world-install-lock/1\n");
    hash.update(bytes);
    Digest::try_new(format!("sha256:{:x}", hash.finalize()))
        .map_err(|_| PackageFailure::InternalFault)
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageManifest {
    pub format: String,
    pub identity: PackageIdentity,
    pub files: Vec<PackageFile>,
    pub artifacts: Vec<PackageArtifact>,
    pub contracts: Vec<PackageContract>,
    pub provides: Vec<ProvidedImplementation>,
    pub requires: Vec<RequiredContract>,
    pub dependencies: Vec<PackageDependency>,
    pub config: ConfigSchema,
    pub state: Vec<StateSchema>,
    pub migrations: Vec<MigrationDeclaration>,
    pub requested_access: Vec<RequestedAccess>,
    pub limits: PackageLimits,
    pub owned_kinds: Vec<KindContract>,
    pub contributions: Vec<Contribution>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageIdentity {
    pub publisher: PublisherId,
    pub id: PackageId,
    pub version: Version,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageFile {
    pub path: String,
    pub media_type: String,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub size: u64,
    pub digest: Digest,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageArtifact {
    pub id: ArtifactId,
    pub runtime: ArtifactRuntime,
    pub kind: ArtifactKind,
    pub target: String,
    pub path: Option<String>,
    pub digest: Digest,
    pub entrypoint: Entrypoint,
    pub abi: AbiContract,
    pub features: Vec<String>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactRuntime {
    Native,
    WasmComponent,
    TrustedProcess,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    Implementation,
    Migration,
    Oracle,
    Resource,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AbiContract {
    pub world: String,
    pub wit_files: Vec<String>,
    pub closure_digest: Digest,
    pub version: Version,
    pub required_features: Vec<String>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageContract {
    pub reference: ContractRef,
    pub wit: BlobRef,
    pub request_schema: BlobRef,
    pub result_schema: BlobRef,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProvidedImplementation {
    pub provider_id: ProviderId,
    pub slot: SlotKind,
    pub artifact_id: ArtifactId,
    pub contracts: Vec<ContractRef>,
    pub trust: TrustClass,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequiredContract {
    pub id: ContractId,
    #[schemars(with = "String")]
    pub version: VersionReq,
    pub request_schema: Digest,
    pub result_schema: Digest,
    pub required: bool,
    pub trusted: bool,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageDependency {
    pub publisher: PublisherId,
    pub id: PackageId,
    #[schemars(with = "String")]
    pub version: VersionReq,
    pub digest: Option<Digest>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Only declared public fields enter runtime configuration; credentials use private ports.
pub struct ConfigSchema {
    pub revision: Revision,
    pub fields: Vec<ConfigField>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigField {
    pub name: String,
    pub value_type: ValueType,
    pub required: bool,
    pub default: Option<Value>,
    pub mutable_at: ConfigMutability,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ConfigMutability {
    Install,
    Activation,
    Invocation,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ConfigFailure {
    UnknownField,
    DuplicateField,
    RequiredField,
    TypeMismatch,
    Immutable,
    SecretField,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateSchema {
    pub namespace: StateNamespaceId,
    pub schema_digest: Digest,
    pub checkpoint_format: CheckpointFormatId,
    pub shared_writer: bool,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationDeclaration {
    pub id: MigrationId,
    pub artifact_id: ArtifactId,
    pub from_schema: Digest,
    pub to_schema: Digest,
    pub checkpoint_from: CheckpointFormatId,
    pub checkpoint_to: CheckpointFormatId,
    pub reversible: bool,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RequestedAccess {
    WorldRead { fields: Vec<DefinitionId> },
    SourceRead { source_id: SourceId },
    Network { origin: String },
    Clock,
    ModelGeneration,
    StateRead { namespace: StateNamespaceId },
    StateWrite { namespace: StateNamespaceId },
    PrivatePort { contract_id: ContractId },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageLimits {
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub memory_bytes: u64,
    #[serde(with = "crate::wire::optional_u64_decimal")]
    #[schemars(with = "Option<String>")]
    pub fuel: Option<u64>,
    pub maximum_instances: u32,
    pub maximum_concurrent_calls: u32,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub maximum_frame_bytes: u64,
    pub call_timeout: DurationMs,
    pub budget: Budget,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KindContract {
    pub name: String,
    pub standard_kind: Option<DefinitionKind>,
    pub schema: ContractRef,
    pub validate: ContractRef,
    pub lower: ContractRef,
    pub index: ContractRef,
    pub migrate: ContractRef,
    pub reducer: ContractRef,
    pub lifecycle: ContractRef,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Contribution {
    FieldTable {
        id: String,
        definition_kind: String,
        fields: Vec<String>,
    },
    ActionForm {
        id: String,
        action: DefinitionId,
    },
    SourceMap {
        id: String,
        contract: ContractRef,
    },
    Report {
        id: String,
        contract: ContractRef,
    },
    Resource {
        id: String,
        path: String,
        media_type: String,
    },
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignatureEnvelope {
    pub publisher: PublisherId,
    pub key_id: String,
    pub algorithm: SignatureAlgorithm,
    pub package_digest: Digest,
    pub signature: Vec<u8>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SignatureAlgorithm {
    Ed25519,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrustPolicy {
    pub revision: Revision,
    pub unsigned_wasm: UnsignedWasmPolicy,
    pub trusted_publishers: Vec<PublisherTrust>,
    pub trusted_process_digests: Vec<Digest>,
    pub trusted_native_digests: Vec<Digest>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum UnsignedWasmPolicy {
    Deny,
    AllowIsolated,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublisherTrust {
    pub publisher: PublisherId,
    pub key_id: String,
    pub public_key: Vec<u8>,
    pub allow_process: bool,
    pub allow_native: bool,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrustEvidence {
    pub policy_revision: Revision,
    pub signature_verified: bool,
    pub publisher: Option<PublisherId>,
    pub key_id: Option<String>,
    pub package_digest: Digest,
    pub decided_at: Timestamp,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallLock {
    pub digest: Digest,
    pub packages: Vec<LockedPackage>,
    pub contracts: Vec<ContractRef>,
    pub artifacts: Vec<LockedArtifact>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LockedPackage {
    pub identity: PackageIdentity,
    pub package_digest: Digest,
    pub transport_digest: Digest,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LockedArtifact {
    pub package_digest: Digest,
    pub artifact_id: ArtifactId,
    pub digest: Digest,
    pub target: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstalledRecord {
    pub world: WorldRef,
    pub install_id: InstallId,
    pub manifest: PackageManifest,
    pub package_digest: Digest,
    pub transport_digest: Digest,
    pub lock: InstallLock,
    pub trust: TrustEvidence,
    pub installed_at: Timestamp,
    pub revision: Revision,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PackageFailure {
    Authorization {
        failure: crate::authorization::AuthorizationFailure,
    },
    ConfigInvalid {
        field: crate::failure::FieldPath,
        reason: ConfigFailure,
    },
    Cancelled,
    InvalidArchive,
    ArchiveLimit,
    UnsupportedCompression,
    EncryptedArchive,
    InvalidPath,
    DuplicatePath,
    CaseCollision,
    LinkEntry,
    ManifestMissing,
    ManifestInvalid {
        field: crate::failure::FieldPath,
    },
    UnsupportedFormat,
    InvalidVersion,
    FileMissing {
        path: String,
    },
    UnlistedFile {
        path: String,
    },
    SizeMismatch {
        path: String,
    },
    DigestMismatch {
        path: String,
    },
    ContractMismatch {
        contract_id: ContractId,
    },
    WitInvalid,
    SchemaInvalid,
    ArtifactInvalid {
        artifact_id: ArtifactId,
    },
    TargetUnavailable {
        artifact_id: ArtifactId,
    },
    DependencyMissing {
        package_id: PackageId,
    },
    DependencyConflict {
        package_id: PackageId,
    },
    DependencyCycle,
    SignatureMissing,
    SignatureInvalid,
    PublisherUntrusted,
    ProcessNotTrusted,
    NativeNotTrusted,
    IoRead,
    IoWrite,
    IoSync,
    InstallConflict,
    RetainedReferences,
    CleanupFailed,
    Commit {
        failure: crate::commit::CommitFailure,
    },
    InternalFault,
}
