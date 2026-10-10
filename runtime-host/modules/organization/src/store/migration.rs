use std::{
    collections::BTreeMap,
    fmt,
    fs::{self, File, OpenOptions},
    io::{self, Read},
    path::{Component, Path},
};

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{
    StoreFault,
    codec::{MAX_LOG_BYTES, recover_log},
    content::ContentStore,
    records::{decode_all, encode_all},
    sqlite::Database,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    source_header_schema_version: u8,
    source_epoch: u64,
    source_sha256: String,
    committed_prefix_sha256: String,
    committed_bytes: u64,
    ignored_tail_bytes: u64,
    target_epoch: u64,
    record_counts: BTreeMap<String, usize>,
    content_hashes_verified: bool,
}

pub enum MigrationError {
    InvalidPaths,
    SourceNotFile,
    SourceRead(io::ErrorKind),
    OutputExists,
    OutputCreate(io::ErrorKind),
    Store(StoreFault),
    Verification,
}

impl fmt::Display for MigrationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPaths => formatter.write_str(
                "organization migration requires an absolute source and a database in a new offline output directory",
            ),
            Self::SourceNotFile => formatter.write_str("organization migration source is not a regular file"),
            Self::SourceRead(_) => formatter.write_str("organization migration source could not be read"),
            Self::OutputExists => formatter.write_str("organization migration output already exists; nothing was overwritten"),
            Self::OutputCreate(_) => formatter.write_str("organization migration output could not be created"),
            Self::Store(error) => error.fmt(formatter),
            Self::Verification => formatter.write_str("organization migration verification failed"),
        }
    }
}

impl fmt::Debug for MigrationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, formatter)
    }
}

impl std::error::Error for MigrationError {}

impl From<StoreFault> for MigrationError {
    fn from(error: StoreFault) -> Self {
        Self::Store(error)
    }
}

/// Creates a verified offline artifact; never publishes it into a running owner's directory.
/// The original log is retained unchanged, including any incomplete trailing frame.
pub fn migrate_legacy_log(
    source_log: &Path,
    target_db: &Path,
) -> Result<MigrationReport, MigrationError> {
    let output = target_db.parent().ok_or(MigrationError::InvalidPaths)?;
    if !source_log.is_absolute()
        || !target_db.is_absolute()
        || target_db.file_name().is_none()
        || output.parent().is_none()
        || target_db
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(MigrationError::InvalidPaths);
    }
    let mut source = File::open(source_log)
        .map_err(|error| MigrationError::SourceRead(error.kind()))?;
    if !source
        .metadata()
        .map_err(|error| MigrationError::SourceRead(error.kind()))?
        .is_file()
    {
        return Err(MigrationError::SourceNotFile);
    }
    let mut bytes = Vec::new();
    source
        .by_ref()
        .take(MAX_LOG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| MigrationError::SourceRead(error.kind()))?;
    let recovered = recover_log(bytes.as_slice())?;
    let committed_len = usize::try_from(recovered.committed_len)
        .map_err(|_| MigrationError::Verification)?;
    let mut report = MigrationReport {
        source_header_schema_version: bytes[8],
        source_epoch: recovered.epoch,
        source_sha256: format!("{:x}", Sha256::digest(&bytes)),
        committed_prefix_sha256: format!("{:x}", Sha256::digest(&bytes[..committed_len])),
        committed_bytes: recovered.committed_len,
        ignored_tail_bytes: (bytes.len() - committed_len) as u64,
        target_epoch: 0,
        record_counts: BTreeMap::new(),
        content_hashes_verified: false,
    };

    // Exclusive directory creation keeps both the database and immutable bodies away
    // from any existing owner. A failed artifact is retained, never reused or published.
    fs::create_dir(output).map_err(output_error)?;
    let target = OpenOptions::new().write(true).create_new(true).open(target_db)
        .map_err(output_error)?;
    drop(target);
    let contents = ContentStore::new(output.to_path_buf());
    let mut database = Database::open(target_db)?;
    let mut transaction = database.begin()?;
    if transaction.initialized() || transaction.epoch() != 0 || !transaction.read_all()?.is_empty() {
        return Err(MigrationError::Verification);
    }
    let mut records = encode_all(&recovered.facts, &contents)?;
    records.sort_by(|left, right| left.key.cmp(&right.key));
    for record in &records {
        transaction.put(record)?;
        *report.record_counts.entry(format!("{:?}", record.key.kind)).or_default() += 1;
    }
    let mut imported = transaction.read_all()?;
    imported.sort_by(|left, right| left.key.cmp(&right.key));
    if imported != records {
        return Err(MigrationError::Verification);
    }
    // ContentStore::read checks every referenced body's length and SHA-256; decoding
    // also restores domain invariants without performing startup recovery.
    if decode_all(&imported, &contents)? != recovered.facts {
        return Err(MigrationError::Verification);
    }
    transaction.mark_initialized()?;
    report.target_epoch = transaction.commit()?;
    report.content_hashes_verified = true;
    Ok(report)
}

fn output_error(error: io::Error) -> MigrationError {
    if error.kind() == io::ErrorKind::AlreadyExists {
        MigrationError::OutputExists
    } else {
        MigrationError::OutputCreate(error.kind())
    }
}
