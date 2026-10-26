//! In-memory format parsing. Callers own source custody, blocking execution, cancellation/join,
//! caches and all output writes. No document content can grant filesystem or network access.

mod archive;
mod assets;
mod ebook;
mod office;
mod office_markdown;
mod pdf;
mod pdf_library;
mod spreadsheet;
mod text;

use std::collections::BTreeMap;
use std::error::Error;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

pub use pdf::{set_exact_pdfium, set_resource_dir_hint};

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ParseOptions {
    pub extract_assets: bool,
    pub images: ImageOptions,
}

impl Default for ParseOptions {
    fn default() -> Self {
        Self {
            extract_assets: true,
            images: ImageOptions::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ImageOptions {
    pub min_width: u32,
    pub min_height: u32,
    pub max_images: usize,
    pub skip_full_page_images: bool,
    pub full_page_coverage_ratio: f32,
    pub full_page_min_text_chars: usize,
}

impl Default for ImageOptions {
    fn default() -> Self {
        Self {
            min_width: 100,
            min_height: 100,
            max_images: 500,
            skip_full_page_images: true,
            full_page_coverage_ratio: 0.90,
            full_page_min_text_chars: 80,
        }
    }
}

pub struct ParseRequest<'a> {
    pub bytes: &'a [u8],
    pub extension: &'a str,
    pub display_name: Option<&'a str>,
    pub options: &'a ParseOptions,
    /// Cooperative checks never preempt a native call. The caller must retain and join its worker.
    pub cancellation: Option<&'a AtomicBool>,
}

impl ParseRequest<'_> {
    pub(crate) fn check_cancelled(&self) -> Result<(), ParseFailure> {
        if self
            .cancellation
            .is_some_and(|flag| flag.load(Ordering::Acquire))
        {
            Err(ParseFailure::new(FailureKind::Cancelled))
        } else {
            Ok(())
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Document {
    pub blocks: Vec<Block>,
    pub tables: Vec<Table>,
    pub assets: Vec<Asset>,
    pub source_map: Vec<SourceMapEntry>,
    pub coverage: Coverage,
    /// SHA-256 of native parser dependencies actually resolved by the loader, without local paths.
    #[serde(default)]
    pub dependency_fingerprints: Vec<String>,
    /// Presentation only. Typed consumers must use tables/source_map, not parse this Markdown.
    pub markdown: String,
    pub metadata: BTreeMap<String, String>,
    /// Private diagnostics are never serialized; Error::source retains parser causes.
    #[serde(skip)]
    pub diagnostics: Vec<ParseFailure>,
}

impl Document {
    pub(crate) fn push_block(
        &mut self,
        parent: Option<u32>,
        kind: BlockKind,
        text: String,
        anchor: Option<Anchor>,
    ) -> u32 {
        let id = self.blocks.len() as u32;
        if let Some(anchor) = anchor {
            self.source_map.push(SourceMapEntry {
                target: Target::Block {
                    block_id: id,
                    start: 0,
                    end: text.len() as u64,
                },
                anchor,
            });
        }
        self.blocks.push(Block {
            id,
            parent,
            kind,
            text,
        });
        id
    }

    pub(crate) fn coverage(
        &mut self,
        anchor: Option<Anchor>,
        status: CoverageStatus,
        reason: CoverageReason,
    ) {
        self.coverage.entries.push(CoverageEntry {
            anchor,
            status,
            reason,
        });
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Block {
    pub id: u32,
    pub parent: Option<u32>,
    pub kind: BlockKind,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum BlockKind {
    Paragraph,
    Heading { level: u8 },
    ListItem,
    Quote,
    Code { language: Option<String> },
    Rule,
    Table { table_id: u32 },
    Note,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Table {
    pub id: u32,
    pub name: Option<String>,
    pub header_rows: u32,
    pub cells: Vec<Cell>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Cell {
    /// One-based source row and column; not a zero-based index into cells.
    pub row: u32,
    pub column: u32,
    pub row_span: u32,
    pub column_span: u32,
    /// Exact source lexeme when exposed by the original format, never reconstructed from a float.
    pub raw: Option<String>,
    pub value: CellValue,
    /// Source formula; value is its existing cached result. No formula is evaluated here.
    pub formula: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum CellValue {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Asset {
    pub id: u32,
    pub media_type: String,
    pub bytes: Vec<u8>,
    pub sha256: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// None for source bytes; Some for a decoded/re-encoded rendition.
    pub derived_from: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceMapEntry {
    pub target: Target,
    pub anchor: Anchor,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Target {
    /// UTF-8 half-open offsets in Block.text, never original-file offsets.
    Block {
        block_id: u32,
        start: u64,
        end: u64,
    },
    Cell {
        table_id: u32,
        row: u32,
        column: u32,
    },
    Asset {
        asset_id: u32,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Anchor {
    /// Half-open byte offsets in the original input snapshot.
    Text { start: u64, end: u64 },
    Pdf {
        page: u32,
        bbox: Option<BoundingBox>,
    },
    /// UTF-8 offsets in the identified DOM node's decoded text, NOT source bytes.
    /// node_path is a slash-separated sequence of one-based child indices from the DOM document.
    Html {
        node_path: Option<String>,
        text_start: u64,
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
    /// None means timing unavailable; no invented zero-length time range.
    Media {
        start_ms: Option<u64>,
        end_ms: Option<u64>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundingBox {
    /// PDF user-space points, origin at bottom-left; coordinates before page render rotation.
    pub left: f32,
    pub bottom: f32,
    pub right: f32,
    pub top: f32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Coverage {
    pub entries: Vec<CoverageEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoverageEntry {
    pub anchor: Option<Anchor>,
    pub status: CoverageStatus,
    pub reason: CoverageReason,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum CoverageStatus {
    Processed,
    Missing,
    Failed,
    Truncated,
    Fallback,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum CoverageReason {
    Parsed,
    OcrUnavailable,
    TranscriptionUnavailable,
    TimingUnavailable,
    LocationUnavailable,
    RawValueUnavailable,
    BinaryFloatPrecision,
    FormulaUnavailable,
    AssetExtractionDisabled,
    AssetFiltered,
    AssetDecodeFailed,
    AssetEncodeFailed,
    ImageLimit {
        limit: usize,
    },
    TextUnavailable,
    ChapterUnavailable,
    ParserRecovery {
        parser: String,
        failure: Option<FailureKind>,
    },
    UpstreamRecoveryNotReported,
    LossyTextDecoding,
    SheetReadFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub enum FailureKind {
    Unsupported,
    Corrupt,
    Encrypted,
    ParserUnavailable,
    ResourceLimit,
    Cancelled,
    Internal,
}

#[derive(Clone)]
pub struct ParseFailure {
    pub kind: FailureKind,
    pub limit: Option<&'static str>,
    cause: Option<std::sync::Arc<dyn Error + Send + Sync>>,
}

impl ParseFailure {
    pub(crate) fn new(kind: FailureKind) -> Self {
        Self {
            kind,
            limit: None,
            cause: None,
        }
    }
    pub(crate) fn caused(kind: FailureKind, cause: impl Error + Send + Sync + 'static) -> Self {
        Self {
            kind,
            limit: None,
            cause: Some(std::sync::Arc::new(cause)),
        }
    }
    pub(crate) fn limit(limit: &'static str) -> Self {
        Self {
            kind: FailureKind::ResourceLimit,
            limit: Some(limit),
            cause: None,
        }
    }
}

impl fmt::Display for ParseFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self.kind {
            FailureKind::Unsupported => "Document format is not supported",
            FailureKind::Corrupt => "Document content is invalid or damaged",
            FailureKind::Encrypted => "Encrypted documents are not supported",
            FailureKind::ParserUnavailable => "Required document parser is unavailable",
            FailureKind::ResourceLimit => "Document exceeds a parsing safety limit",
            FailureKind::Cancelled => "Document parsing was cancelled",
            FailureKind::Internal => "Document parser failed internally",
        })
    }
}

impl fmt::Debug for ParseFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ParseFailure")
            .field("kind", &self.kind)
            .field("limit", &self.limit)
            .finish_non_exhaustive()
    }
}

impl Error for ParseFailure {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.cause
            .as_deref()
            .map(|cause| cause as &(dyn Error + 'static))
    }
}

/// Parse the authorized immutable bytes. Partial output is returned with explicit coverage gaps.
/// This function does not start background work, write files, follow URLs, perform OCR or transcribe.
pub fn parse(request: ParseRequest<'_>) -> Result<Document, ParseFailure> {
    request.check_cancelled()?;
    if request.bytes.len() > 100 * 1024 * 1024 {
        return Err(ParseFailure::limit("input_bytes"));
    }
    let extension = request
        .extension
        .trim_start_matches('.')
        .to_ascii_lowercase();
    let mut document = match extension.as_str() {
        "pdf" => pdf::parse(&request),
        "xls" | "xlsx" | "xlsm" | "xlsb" | "ods" => spreadsheet::parse(&request, &extension),
        "doc" | "docx" | "docm" | "ppt" | "pps" | "pot" | "pptx" | "pptm" | "ppsx" | "ppsm"
        | "odt" | "odp" | "rtf" => office::parse(&request, &extension),
        "epub" | "mobi" => ebook::parse(&request, &extension),
        "html" | "htm" | "xhtml" => text::html(&request),
        "csv" | "tsv" => text::delimited(&request, extension == "tsv"),
        "json" => text::json(&request),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "tiff" | "tif" | "avif"
        | "heic" | "heif" | "svg" => text::image(&request, &extension),
        "mp4" | "webm" | "mov" | "avi" | "mkv" | "flv" | "wmv" | "m4v" | "mp3" | "wav" | "ogg"
        | "flac" | "aac" | "m4a" | "wma" => text::media(&request, &extension),
        "pages" | "numbers" | "key" => Err(ParseFailure::new(FailureKind::Unsupported)),
        _ => text::plain(&request, extension == "org"),
    }?;
    request.check_cancelled()?;
    document.metadata.insert(
        "parser".into(),
        format!("document-parser/{}", env!("CARGO_PKG_VERSION")),
    );
    Ok(document)
}

/// Extract original Office package assets without requiring document text to be readable.
pub fn parse_office_assets(request: ParseRequest<'_>) -> Result<Document, ParseFailure> {
    request.check_cancelled()?;
    if request.bytes.len() > 100 * 1024 * 1024 {
        return Err(ParseFailure::limit("input_bytes"));
    }
    let output = assets::office(&request)?;
    request.check_cancelled()?;
    Ok(output)
}

pub(crate) fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}
