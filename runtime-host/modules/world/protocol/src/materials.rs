use crate::{ids::*, sources::RetentionPolicy, time::Timestamp};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlobRef {
    pub digest: Digest,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub byte_size: u64,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccessPolicyRef {
    pub policy_id: PolicyId,
    pub revision: Revision,
    pub labels: Vec<String>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaterialDraftRef {
    pub world: WorldRef,
    pub run_id: RunId,
    pub step_id: StepId,
    pub revision: Revision,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaterialCompileSelection {
    pub activation_lock_id: ActivationLockId,
    pub candidates: Vec<CandidateCompileSelection>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CandidateCompileSelection {
    pub candidate_id: CandidateId,
    pub external_contracts: Vec<crate::compiler::ExternalContractSelection>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaterialDraft {
    pub reference: MaterialDraftRef,
    pub base_release: ReleaseId,
    pub scope: ScopeId,
    pub source_versions: Vec<SourceVersionRef>,
    pub parse_artifacts: Vec<ParseArtifactId>,
    pub batch: CandidateBatch,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceVersionRef {
    pub world: WorldRef,
    pub source_id: SourceId,
    pub version_id: SourceVersionId,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceVersion {
    pub reference: SourceVersionRef,
    pub blob: BlobRef,
    pub media_type: String,
    pub captured_at: Timestamp,
    pub supersedes: Option<SourceVersionRef>,
    pub origin_family: OriginFamilyId,
    pub lineage: Vec<SourceLineage>,
    pub access: AccessPolicyRef,
    pub retention: RetentionPolicy,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SourceLineage {
    SourceVersion {
        reference: SourceVersionRef,
    },
    WikiSource {
        project_id: String,
        source_id: String,
        version: String,
    },
    WikiPage {
        project_id: String,
        page_id: String,
        version: String,
        source_versions: Vec<String>,
    },
    Generated {
        run_id: RunId,
        inputs: Vec<SourceVersionRef>,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParseArtifact {
    pub world: WorldRef,
    pub id: ParseArtifactId,
    pub source_version: SourceVersionRef,
    pub parse_run: RunId,
    pub parser_fingerprint: Digest,
    pub options_digest: Digest,
    pub dependency_fingerprints: Vec<Digest>,
    pub manifest: BlobRef,
    pub blocks: Vec<DocumentBlock>,
    pub tables: Vec<DocumentTable>,
    pub assets: Vec<DocumentAsset>,
    pub source_map: Vec<SourceMapEntry>,
    pub coverage: Vec<CoverageEntry>,
    pub metadata: std::collections::BTreeMap<String, String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentBlock {
    pub id: BlockId,
    pub parent: Option<BlockId>,
    pub kind: BlockKind,
    pub text: String,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum BlockKind {
    Paragraph,
    Heading { level: u8 },
    ListItem,
    Quote,
    Code { language: Option<String> },
    Rule,
    Table { table_id: BlockId },
    Note,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentTable {
    pub id: BlockId,
    pub name: Option<String>,
    pub header_rows: u32,
    pub cells: Vec<TableCell>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableCell {
    pub row: u32,
    pub column: u32,
    pub row_span: u32,
    pub column_span: u32,
    pub raw: Option<String>,
    pub value: DocumentCellValue,
    pub formula: Option<String>,
    pub precision: ValuePrecision,
}
/// Original document values preserve lexemes and approximation, independently of admitted World values.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DocumentCellValue {
    Missing,
    Null,
    Text(String),
    Boolean(bool),
    Integer(String),
    Decimal(String),
    Float(f64),
    DateTime { serial: f64, display: String },
    DateTimeIso(String),
    DurationIso(String),
    Error(String),
    Covered { row: u32, column: u32 },
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ValuePrecision {
    Exact,
    Approximate,
    Unavailable,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentAsset {
    pub id: ContentId,
    pub blob: BlobRef,
    pub media_type: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub source_digest: Option<Digest>,
    pub source_anchor: Option<SourceAnchor>,
    pub derived_from: Vec<ContentId>,
    pub derivation: Option<ArtifactId>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceMapEntry {
    pub target: DocumentTarget,
    pub anchor: SourceAnchor,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
/// Block start/end are half-open UTF-8 byte offsets; cell row/column are 1-based.
pub enum DocumentTarget {
    Block {
        block_id: BlockId,
        start: u32,
        end: u32,
    },
    Cell {
        table_id: BlockId,
        row: u32,
        column: u32,
    },
    Asset {
        asset_id: ContentId,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
/// Text/HTML offsets are half-open UTF-8 byte offsets. PDF pages and sheet rows/columns are 1-based.
/// HTML node_path is a document-rooted 1-based child-index path, not XPath; text offsets refer to decoded DOM text nodes.
/// Missing PDF coordinates stay None; a page anchor must never invent a bounding box.
pub enum SourceAnchor {
    Text {
        #[serde(with = "crate::wire::u64_decimal")]
        #[schemars(with = "String")]
        start: u64,
        #[serde(with = "crate::wire::u64_decimal")]
        #[schemars(with = "String")]
        end: u64,
    },
    Pdf {
        page: u32,
        bbox: Option<BoundingBox>,
    },
    Html {
        node_path: Option<String>,
        #[serde(with = "crate::wire::u64_decimal")]
        #[schemars(with = "String")]
        text_start: u64,
        #[serde(with = "crate::wire::u64_decimal")]
        #[schemars(with = "String")]
        text_end: u64,
    },
    Sheet {
        sheet: String,
        row: u32,
        column: u32,
    },
    PackagePart {
        part: String,
        element: Option<String>,
    },
    Media {
        #[serde(with = "crate::wire::optional_u64_decimal")]
        #[schemars(with = "Option<String>")]
        start_ms: Option<u64>,
        #[serde(with = "crate::wire::optional_u64_decimal")]
        #[schemars(with = "Option<String>")]
        end_ms: Option<u64>,
    },
    Record {
        namespace: String,
        native_key: String,
        fields: Vec<String>,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// PDF user-space points (1/72 inch), bottom-left origin before page rendering rotation.
pub struct BoundingBox {
    pub left: f64,
    pub bottom: f64,
    pub right: f64,
    pub top: f64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoverageEntry {
    pub anchor: Option<SourceAnchor>,
    pub status: CoverageStatus,
    pub reason: Option<CoverageReason>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CoverageStatus {
    Processed,
    Missing,
    Failed,
    Truncated,
    Fallback,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CoverageReason {
    Parsed,
    OcrUnavailable,
    TranscriptionUnavailable,
    PageMissing,
    TimingUnavailable,
    LocationUnavailable,
    PrecisionUnavailable,
    RawValueUnavailable,
    BinaryFloatPrecision,
    FormulaUnavailable,
    AssetExtractionDisabled,
    AssetFiltered,
    AssetDecodeFailed,
    AssetEncodeFailed,
    ImageLimit {
        #[serde(with = "crate::wire::u64_decimal")]
        #[schemars(with = "String")]
        limit: u64,
    },
    TextUnavailable,
    ChapterUnavailable,
    ParserRecovery {
        parser: String,
        failure: Option<ParseFailureKind>,
    },
    UpstreamRecoveryNotReported,
    LossyTextDecoding,
    SheetReadFailed,
    UnsupportedElement,
    ResourceLimit,
    CorruptElement,
    FallbackParser,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ParseFailureKind {
    Unsupported,
    Corrupt,
    Encrypted,
    ParserUnavailable,
    ResourceLimit,
    Cancelled,
    Internal,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentChunk {
    pub id: BlockId,
    pub source_version: SourceVersionRef,
    pub parse_artifact_id: ParseArtifactId,
    pub primary_targets: Vec<DocumentTarget>,
    pub context_targets: Vec<DocumentTarget>,
    pub anchors: Vec<SourceAnchor>,
    #[serde(with = "crate::wire::u64_decimal")]
    #[schemars(with = "String")]
    pub token_estimate: u64,
}
/// A half-open UTF-8 slice of an immutable parse block; text is exactly the selected bytes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentTextSlice {
    pub block_id: BlockId,
    pub start: u32,
    pub end: u32,
    pub text: String,
    pub kind: BlockKind,
    pub parent: Option<BlockId>,
}
/// Only selected chunk content is present; source locations retain the immutable artifact offsets.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentChunkContent {
    pub chunk: DocumentChunk,
    pub blocks: Vec<DocumentTextSlice>,
    pub tables: Vec<DocumentTable>,
    pub assets: Vec<DocumentAsset>,
    pub source_map: Vec<SourceMapEntry>,
    pub coverage: Vec<CoverageEntry>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SemanticExtractRequest {
    pub world: WorldRef,
    pub base_release: ReleaseId,
    pub content: DocumentChunkContent,
    pub definitions: Vec<crate::definitions::Definition<crate::definitions::DefinitionBody>>,
    pub scope: crate::definitions::Scope,
    pub budget: crate::budget::Budget,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CandidateBatch {
    pub candidates: Vec<crate::learning::Candidate>,
    pub observations: Vec<crate::facts::ObservationDraft>,
    pub evidence: Vec<crate::facts::Evidence>,
    pub coverage: Vec<CoverageEntry>,
    pub read_needs: Vec<ReadNeed>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadNeed {
    pub source_version: SourceVersionRef,
    pub parse_artifact_id: ParseArtifactId,
    pub targets: Vec<DocumentTarget>,
    pub reason: ReadNeedReason,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReadNeedReason {
    ContextMissing,
    IdentityAmbiguous,
    TemporalContextMissing,
    ValueContextMissing,
}
pub fn semantic_extract_contract()
-> Result<crate::sources::ContractRef, crate::schema::SchemaFailure> {
    crate::schema::method::<SemanticExtractRequest, CandidateBatch, MaterialFailure>(
        "semantic.extract",
    )
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MaterialFailure {
    VersionContentUnavailable { reference: SourceVersionRef },
    InputInvalid,
    ReadFailed,
    WriteFailed,
    SyncFailed,
    PublishFailed,
    ContentNotFound,
    RetainedReferences,
    CleanupFailed,
    UnsupportedFormat,
    CorruptContent,
    EncryptedContent,
    ParserUnavailable,
    SizeLimit,
    OcrUnavailable,
    TranscriptionUnavailable,
    IncompleteLocation,
    SourceVersionMissing { reference: SourceVersionRef },
    DigestMismatch,
    Deleted,
    RetentionDenied,
    Cancelled,
    InternalFault,
}
