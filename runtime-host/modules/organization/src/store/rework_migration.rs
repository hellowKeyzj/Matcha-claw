use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Component, Path},
    time::Duration,
};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{EdgeAction, NodeKind};

use super::{
    StoreFault,
    content::ContentStore,
    records::{decode_all, encode_all},
    schema::{RecordKey, RecordKind, StoredRecord},
    sqlite::Database,
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReworkMigrationLimits {
    pub default_max_reworks: u32,
    pub overrides: Vec<ReworkLimitOverride>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReworkLimitOverride {
    pub run_id: String,
    pub source_node_id: String,
    pub source_port: String,
    pub max_reworks: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReworkNodeMigration {
    pub run_id: String,
    pub source_node_id: String,
    pub old_max_attempts: u32,
    pub rework_limits: BTreeMap<String, u32>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReworkMigrationPreview {
    pub source_schema_version: u8,
    pub source_epoch: u64,
    pub source_records_sha256: String,
    pub limits: ReworkMigrationLimits,
    pub nodes: Vec<ReworkNodeMigration>,
    pub legacy_attempts: u64,
    pub reconstructed_counters: u64,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReworkMigrationReport {
    pub preview: ReworkMigrationPreview,
    pub target_epoch: u64,
    pub record_counts: BTreeMap<String, usize>,
    pub content_hashes_verified: bool,
}

#[derive(Debug)]
pub enum ReworkMigrationError {
    InvalidPaths,
    UnsupportedSourceSchema(u8),
    InvalidLimits,
    SourceRead,
    SourceChanged,
    OutputExists,
    OutputCreate(io::ErrorKind),
    Store(StoreFault),
    Verification,
}

impl fmt::Display for ReworkMigrationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidPaths => {
                "rework migration requires absolute paths and a new offline output directory"
            }
            Self::UnsupportedSourceSchema(_) => {
                "rework migration requires organization SQLite schema 1"
            }
            Self::InvalidLimits => {
                "rework migration limits contain an unknown, duplicate or invalid source port"
            }
            Self::SourceRead => "rework migration source could not be read",
            Self::SourceChanged => {
                "rework migration confirmation does not match the current source and preview"
            }
            Self::OutputExists => "rework migration output exists; nothing was overwritten",
            Self::OutputCreate(_) => "rework migration output could not be created",
            Self::Store(error) => return error.fmt(formatter),
            Self::Verification => "rework migration verification failed",
        })
    }
}

impl std::error::Error for ReworkMigrationError {}

impl From<StoreFault> for ReworkMigrationError {
    fn from(error: StoreFault) -> Self {
        Self::Store(error)
    }
}

#[derive(Serialize)]
struct SourceRecord {
    kind: String,
    scope: String,
    id: String,
    team_id: Option<String>,
    run_id: Option<String>,
    payload: Option<Vec<u8>>,
    epoch: u64,
}

struct PreparedMigration {
    preview: ReworkMigrationPreview,
    original: Vec<SourceRecord>,
    records: Vec<StoredRecord>,
}

/// Reads a stable, read-only snapshot. No owner startup or recovery effects run.
pub fn preview_rework_migration(
    source_db: &Path,
    limits: &ReworkMigrationLimits,
) -> Result<ReworkMigrationPreview, ReworkMigrationError> {
    Ok(prepare(source_db, limits)?.preview)
}

/// The caller must explicitly confirm a previously displayed preview. Only a new
/// offline artifact is created; source records and historical command bytes stay intact.
pub fn migrate_rework_budgets(
    source_db: &Path,
    target_db: &Path,
    confirmation: &ReworkMigrationPreview,
) -> Result<ReworkMigrationReport, ReworkMigrationError> {
    validate_path(target_db)?;
    let output = target_db
        .parent()
        .filter(|path| path.parent().is_some())
        .ok_or(ReworkMigrationError::InvalidPaths)?;
    if source_db == target_db || output.exists() {
        return Err(ReworkMigrationError::OutputExists);
    }
    let prepared = prepare(source_db, &confirmation.limits)?;
    if &prepared.preview != confirmation {
        return Err(ReworkMigrationError::SourceChanged);
    }
    let source_contents = ContentStore::new(
        source_db
            .parent()
            .ok_or(ReworkMigrationError::InvalidPaths)?
            .to_owned(),
    );
    let facts = decode_all(&prepared.records, &source_contents)?;
    fs::create_dir(output).map_err(output_error)?;
    drop(
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target_db)
            .map_err(output_error)?,
    );
    let contents = ContentStore::new(output.to_owned());
    // Reuse the real record encoders to copy every referenced immutable body.
    // The canonical records below retain the exact original audit payloads.
    encode_all(&facts, &contents)?;
    let mut database = Database::open(target_db)?;
    let mut transaction = database.begin()?;
    if transaction.initialized() || transaction.epoch() != 0 || !transaction.read_all()?.is_empty()
    {
        return Err(ReworkMigrationError::Verification);
    }
    let mut record_counts = BTreeMap::new();
    for record in &prepared.records {
        transaction.put(record)?;
        *record_counts
            .entry(record.key.kind.as_str().to_owned())
            .or_default() += 1;
    }
    let mut restored = transaction.read_all()?;
    restored.sort_by(|left, right| left.key.cmp(&right.key));
    if restored != prepared.records || decode_all(&restored, &contents)? != facts {
        return Err(ReworkMigrationError::Verification);
    }
    write_json(
        &output.join("rework-migration-source-records.json"),
        &prepared.original,
    )?;
    transaction.mark_initialized()?;
    let target_epoch = transaction.commit()?;
    let report = ReworkMigrationReport {
        preview: prepared.preview,
        target_epoch,
        record_counts,
        content_hashes_verified: true,
    };
    write_json(&output.join("rework-migration-report.json"), &report)?;
    Ok(report)
}

fn prepare(
    source_db: &Path,
    limits: &ReworkMigrationLimits,
) -> Result<PreparedMigration, ReworkMigrationError> {
    validate_path(source_db)?;
    if !fs::metadata(source_db)
        .map_err(|_| ReworkMigrationError::SourceRead)?
        .is_file()
    {
        return Err(ReworkMigrationError::SourceRead);
    }
    let mut connection = Connection::open_with_flags(source_db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| ReworkMigrationError::SourceRead)?;
    connection
        .busy_timeout(Duration::from_millis(500))
        .map_err(|_| ReworkMigrationError::SourceRead)?;
    let transaction = connection
        .transaction()
        .map_err(|_| ReworkMigrationError::SourceRead)?;
    let version: u8 = transaction
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|_| ReworkMigrationError::SourceRead)?;
    if version != 1 {
        return Err(ReworkMigrationError::UnsupportedSourceSchema(version));
    }
    let (epoch, initialized): (u64, bool) = transaction
        .query_row(
            "SELECT epoch,initialized FROM organization_meta WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| ReworkMigrationError::SourceRead)?;
    if !initialized {
        return Err(StoreFault::MigrationRequired.into());
    }
    let mut original = Vec::new();
    {
        let mut statement = transaction.prepare(
            "SELECT kind,scope,id,team_id,run_id,payload,epoch FROM records ORDER BY kind,scope,id",
        ).map_err(|_| ReworkMigrationError::SourceRead)?;
        let mut rows = statement
            .query([])
            .map_err(|_| ReworkMigrationError::SourceRead)?;
        while let Some(row) = rows.next().map_err(|_| ReworkMigrationError::SourceRead)? {
            original.push(SourceRecord {
                kind: row.get(0).map_err(|_| ReworkMigrationError::SourceRead)?,
                scope: row.get(1).map_err(|_| ReworkMigrationError::SourceRead)?,
                id: row.get(2).map_err(|_| ReworkMigrationError::SourceRead)?,
                team_id: row.get(3).map_err(|_| ReworkMigrationError::SourceRead)?,
                run_id: row.get(4).map_err(|_| ReworkMigrationError::SourceRead)?,
                payload: row.get(5).map_err(|_| ReworkMigrationError::SourceRead)?,
                epoch: row.get(6).map_err(|_| ReworkMigrationError::SourceRead)?,
            });
        }
    }
    transaction
        .commit()
        .map_err(|_| ReworkMigrationError::SourceRead)?;
    let source_records_sha256 = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&(version, epoch, initialized, &original))
                .map_err(|_| ReworkMigrationError::Verification)?,
        )
    );
    let mut records = original
        .iter()
        .filter_map(|record| {
            record.payload.as_ref().map(|payload| {
                Ok(StoredRecord {
                    key: RecordKey {
                        kind: RecordKind::parse(&record.kind)?,
                        scope: record.scope.clone(),
                        id: record.id.clone(),
                    },
                    team_id: record.team_id.clone(),
                    run_id: record.run_id.clone(),
                    payload: payload.clone(),
                })
            })
        })
        .collect::<Result<Vec<_>, StoreFault>>()?;
    let mut overrides = BTreeMap::new();
    for limit in &limits.overrides {
        if overrides
            .insert(
                (
                    limit.run_id.clone(),
                    limit.source_node_id.clone(),
                    limit.source_port.clone(),
                ),
                limit.max_reworks,
            )
            .is_some()
        {
            return Err(ReworkMigrationError::InvalidLimits);
        }
    }
    let mut nodes = Vec::new();
    let mut legacy_attempts = 0;
    let mut sources = BTreeSet::new();
    let mut counts = BTreeMap::<String, BTreeMap<(String, String), u32>>::new();
    for record in &mut records {
        if !matches!(
            record.key.kind,
            RecordKind::GraphDefinition | RecordKind::Attempt
        ) {
            continue;
        }
        let mut value: Value =
            serde_json::from_slice(&record.payload).map_err(|_| StoreFault::CorruptRecord)?;
        if record.key.kind == RecordKind::GraphDefinition {
            for node in value
                .get_mut("nodes")
                .and_then(Value::as_array_mut)
                .ok_or(StoreFault::InvalidFacts)?
            {
                let id = node
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or(StoreFault::InvalidFacts)?
                    .to_owned();
                let max = node
                    .as_object_mut()
                    .ok_or(StoreFault::InvalidFacts)?
                    .remove("max_attempts")
                    .and_then(|max| max.as_u64())
                    .and_then(|max| u32::try_from(max).ok())
                    .filter(|max| *max > 0)
                    .ok_or(StoreFault::InvalidFacts)?;
                if node.get("rework_limits").is_some() {
                    return Err(StoreFault::InvalidFacts.into());
                }
                let kind =
                    configuration_kind(node.get("configuration").ok_or(StoreFault::InvalidFacts)?)?;
                let rework_limits = kind
                    .source_ports()
                    .iter()
                    .filter(|port| kind.accepts_edge_action(port.as_str(), EdgeAction::Rework))
                    .map(|port| {
                        let port = port.as_str().to_owned();
                        let max = overrides
                            .remove(&(record.key.scope.clone(), id.clone(), port.clone()))
                            .unwrap_or(limits.default_max_reworks);
                        (port, max)
                    })
                    .collect::<BTreeMap<_, _>>();
                node["rework_limits"] = json!(rework_limits);
                nodes.push(ReworkNodeMigration {
                    run_id: record.key.scope.clone(),
                    source_node_id: id,
                    old_max_attempts: max,
                    rework_limits,
                });
            }
        } else {
            if value.get("batch_id").is_some() {
                return Err(StoreFault::InvalidFacts.into());
            }
            value["batch_id"] = json!(1);
            legacy_attempts += 1;
            for input in value
                .get("inputs")
                .and_then(Value::as_array)
                .ok_or(StoreFault::InvalidFacts)?
            {
                if input.get("action").and_then(Value::as_str) != Some("Rework") {
                    continue;
                }
                let source = input
                    .get("source")
                    .and_then(Value::as_str)
                    .ok_or(StoreFault::InvalidFacts)?
                    .to_owned();
                let port = input
                    .get("source_port")
                    .and_then(Value::as_str)
                    .ok_or(StoreFault::InvalidFacts)?
                    .to_owned();
                let fence = input
                    .get("fence")
                    .and_then(Value::as_array)
                    .filter(|fence| fence.len() == 2)
                    .ok_or(StoreFault::InvalidFacts)?;
                let attempt = fence[0]
                    .as_str()
                    .ok_or(StoreFault::InvalidFacts)?
                    .to_owned();
                let execution = fence[1]
                    .as_str()
                    .ok_or(StoreFault::InvalidFacts)?
                    .to_owned();
                if sources.insert((
                    record.key.scope.clone(),
                    source.clone(),
                    port.clone(),
                    attempt,
                    execution,
                )) {
                    let used = counts
                        .entry(record.key.scope.clone())
                        .or_default()
                        .entry((source, port))
                        .or_default();
                    *used = used.checked_add(1).ok_or(StoreFault::InvalidFacts)?;
                }
            }
        }
        record.payload = serde_json::to_vec(&value).map_err(|_| StoreFault::InvalidFacts)?;
    }
    if !overrides.is_empty() {
        return Err(ReworkMigrationError::InvalidLimits);
    }
    let reconstructed_counters = counts.values().map(|counters| counters.len() as u64).sum();
    for record in records
        .iter_mut()
        .filter(|record| record.key.kind == RecordKind::RunHeader)
    {
        let mut value: Value =
            serde_json::from_slice(&record.payload).map_err(|_| StoreFault::CorruptRecord)?;
        if value.get("execution_control").is_some() {
            return Err(StoreFault::InvalidFacts.into());
        }
        let counters = counts.remove(&record.key.scope).unwrap_or_default().into_iter().map(|((source, port), used)| {
            json!({"batch_id":1,"source_node_id":source,"source_port":port,"used":used})
        }).collect::<Vec<_>>();
        value["execution_control"] =
            json!({"next_batch_id":2,"rework_counts":counters,"blocked_reworks":[]});
        record.payload = serde_json::to_vec(&value).map_err(|_| StoreFault::InvalidFacts)?;
    }
    if !counts.is_empty() {
        return Err(StoreFault::InvalidFacts.into());
    }
    nodes.sort_by(|left, right| {
        (&left.run_id, &left.source_node_id).cmp(&(&right.run_id, &right.source_node_id))
    });
    records.sort_by(|left, right| left.key.cmp(&right.key));
    let contents = ContentStore::new(
        source_db
            .parent()
            .ok_or(ReworkMigrationError::InvalidPaths)?
            .to_owned(),
    );
    decode_all(&records, &contents)?;
    Ok(PreparedMigration {
        preview: ReworkMigrationPreview {
            source_schema_version: version, source_epoch: epoch, source_records_sha256,
            limits: limits.clone(), nodes, legacy_attempts, reconstructed_counters,
            warnings: vec![
                "Old node max_attempts cannot be mapped losslessly; every legal Rework port receives the explicitly confirmed default or override.".to_owned(),
                "All historical attempts use batch 1; the next trigger starts batch 2. Original trigger batch boundaries cannot be recovered.".to_owned(),
                "Used reworks are reconstructed from unique source fence and port receipts. No blocked rework is invented; historical failed status and output are unchanged.".to_owned(),
                "Original command payloads, fingerprints, receipts, legacy max_attempts and deleted-record audit data are retained unchanged in the offline source-record archive.".to_owned(),
            ],
        }, original, records,
    })
}

fn configuration_kind(configuration: &Value) -> Result<NodeKind, StoreFault> {
    let name = match configuration {
        Value::String(name) => name.as_str(),
        Value::Object(fields) if fields.len() == 1 => {
            let (name, body) = fields.iter().next().ok_or(StoreFault::InvalidFacts)?;
            if name == "Control" {
                body.as_str().ok_or(StoreFault::InvalidFacts)?
            } else {
                name.as_str()
            }
        }
        _ => return Err(StoreFault::InvalidFacts),
    };
    Ok(match name {
        "Start" => NodeKind::Start,
        "Work" => NodeKind::Work,
        "Review" => NodeKind::Review,
        "HumanDecision" => NodeKind::HumanDecision,
        "ScriptReview" => NodeKind::ScriptReview,
        "Join" => NodeKind::Join,
        "End" => NodeKind::End,
        _ => return Err(StoreFault::InvalidFacts),
    })
}

fn validate_path(path: &Path) -> Result<(), ReworkMigrationError> {
    if !path.is_absolute()
        || path.file_name().is_none()
        || path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(ReworkMigrationError::InvalidPaths);
    }
    Ok(())
}

fn output_error(error: io::Error) -> ReworkMigrationError {
    if error.kind() == io::ErrorKind::AlreadyExists {
        ReworkMigrationError::OutputExists
    } else {
        ReworkMigrationError::OutputCreate(error.kind())
    }
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), ReworkMigrationError> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| ReworkMigrationError::Verification)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(output_error)?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(output_error)
}
