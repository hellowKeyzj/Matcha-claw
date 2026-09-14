use std::{
    collections::BTreeMap,
    fs, io,
    path::{Component, Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{Map, Value};

use crate::lifecycle::state_dir::CanonicalStateDir;

const INSTALLED_INDEX_STATE_KEY: &str = "plugins.installedIndex";
const INSTALL_RECORDS: &str = "installRecords";
const MANAGED_MARKER: &str = ".matchaclaw-managed";
const MATCHA_OWNER: &str = "matchaclaw";
const MATCHA_OWNER_FIELD: &str = "matchaOwner";
const MATCHA_CONTENT_SIGNATURE_FIELD: &str = "matchaContentSignature";
const MAX_MARKER_BYTES: u64 = 4096;
const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct InstalledRecordsReconcile {
    pub(crate) status: InstalledRecordsReconcileStatus,
    pub(crate) discovered_records: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum InstalledRecordsReconcileStatus {
    Changed,
    Unchanged,
    Skipped(InstalledRecordsSkipReason),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum InstalledRecordsSkipReason {
    StateDirectoryUnavailable,
    ExtensionsUnavailable,
    DatabaseMissing,
    DatabaseUnavailable,
    InstalledIndexUnavailable,
    InvalidInstalledIndex,
    InvalidInstallRecords,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum InstalledIndexReconcile {
    Changed(Value),
    Unchanged,
    Skipped(InstalledRecordsSkipReason),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct InstalledRecord {
    source_path: String,
    install_path: String,
    version: String,
    content_signature: String,
}

impl InstalledRecord {
    fn from_installed_extension(path: PathBuf, marker: ManagedMarker) -> Self {
        let path = path.to_string_lossy().into_owned();
        Self {
            source_path: path.clone(),
            install_path: path,
            version: marker.version,
            content_signature: marker.content_signature,
        }
    }

    fn to_value(&self, existing: Option<&Value>) -> Value {
        let mut record = existing
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        record.insert("source".to_owned(), Value::String("path".to_owned()));
        record.insert(
            "sourcePath".to_owned(),
            Value::String(self.source_path.clone()),
        );
        record.insert(
            "installPath".to_owned(),
            Value::String(self.install_path.clone()),
        );
        record.insert("version".to_owned(), Value::String(self.version.clone()));
        record.insert(
            MATCHA_OWNER_FIELD.to_owned(),
            Value::String(MATCHA_OWNER.to_owned()),
        );
        record.insert(
            MATCHA_CONTENT_SIGNATURE_FIELD.to_owned(),
            Value::String(self.content_signature.clone()),
        );
        Value::Object(record)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ManagedMarker {
    version: String,
    content_signature: String,
}

pub(crate) fn reconcile(state_dir: &CanonicalStateDir) -> InstalledRecordsReconcile {
    if state_dir.open().is_err() {
        return skipped(InstalledRecordsSkipReason::StateDirectoryUnavailable, 0);
    }
    let records = match discover_managed_extension_records(&state_dir.as_path().join("extensions"))
    {
        Ok(records) => records,
        Err(_) => return skipped(InstalledRecordsSkipReason::ExtensionsUnavailable, 0),
    };
    let discovered_records = records.len();
    let database_path = state_dir.as_path().join("state").join("openclaw.sqlite");
    match reconcile_database(&database_path, &records) {
        Ok(status) => InstalledRecordsReconcile {
            status,
            discovered_records,
        },
        Err(reason) => skipped(reason, discovered_records),
    }
}

pub(crate) fn reconcile_installed_index(
    persisted_value: Option<Value>,
    records: &BTreeMap<String, InstalledRecord>,
) -> InstalledIndexReconcile {
    let mut value = match persisted_value {
        Some(Value::Object(value)) => value,
        Some(_) => {
            return InstalledIndexReconcile::Skipped(
                InstalledRecordsSkipReason::InvalidInstalledIndex,
            );
        }
        None if records.is_empty() => return InstalledIndexReconcile::Unchanged,
        None => Map::new(),
    };

    let mut index = match value.remove("index") {
        Some(Value::Object(index)) => index,
        Some(index) => {
            value.insert("index".to_owned(), index);
            return InstalledIndexReconcile::Skipped(
                InstalledRecordsSkipReason::InvalidInstalledIndex,
            );
        }
        None if records.is_empty() => return InstalledIndexReconcile::Unchanged,
        None => Map::new(),
    };

    let mut install_records = match index.remove(INSTALL_RECORDS) {
        Some(Value::Object(install_records)) => install_records,
        Some(install_records) => {
            index.insert(INSTALL_RECORDS.to_owned(), install_records);
            value.insert("index".to_owned(), Value::Object(index));
            return InstalledIndexReconcile::Skipped(
                InstalledRecordsSkipReason::InvalidInstallRecords,
            );
        }
        None if !index.is_empty() => {
            return InstalledIndexReconcile::Skipped(
                InstalledRecordsSkipReason::InvalidInstallRecords,
            );
        }
        None => Map::new(),
    };
    if !valid_install_records(&install_records) {
        index.insert(INSTALL_RECORDS.to_owned(), Value::Object(install_records));
        value.insert("index".to_owned(), Value::Object(index));
        return InstalledIndexReconcile::Skipped(InstalledRecordsSkipReason::InvalidInstallRecords);
    }
    let previous_install_records = install_records.clone();

    for id in previous_install_records.keys() {
        let Some(existing) = install_records.get(id) else {
            continue;
        };
        if is_matcha_owned_record(existing) && !records.contains_key(id) {
            install_records.remove(id);
        }
    }

    for (id, record) in records {
        let existing = install_records.get(id);
        install_records.insert(id.clone(), record.to_value(existing));
    }

    if install_records == previous_install_records && index.is_empty() {
        return InstalledIndexReconcile::Unchanged;
    }

    let index = Map::from_iter([(INSTALL_RECORDS.to_owned(), Value::Object(install_records))]);
    value.insert("index".to_owned(), Value::Object(index));
    InstalledIndexReconcile::Changed(Value::Object(value))
}

pub(crate) fn discover_managed_extension_records(
    extensions: &Path,
) -> io::Result<BTreeMap<String, InstalledRecord>> {
    let metadata = match fs::symlink_metadata(extensions) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(error),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "OpenClaw extensions root is not a directory",
        ));
    }

    let extensions = extensions.canonicalize()?;
    let mut records = BTreeMap::new();
    for entry in fs::read_dir(&extensions)? {
        let entry = entry?;
        let Some(id) = entry
            .file_name()
            .to_str()
            .filter(|id| valid_plugin_id(id))
            .map(ToOwned::to_owned)
        else {
            continue;
        };
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            continue;
        }
        let path = path.canonicalize()?;
        if !path.starts_with(&extensions) {
            continue;
        }
        if let Some(marker) = read_managed_marker(&path, &id)? {
            records.insert(id, InstalledRecord::from_installed_extension(path, marker));
        }
    }
    Ok(records)
}

fn reconcile_database(
    database_path: &Path,
    records: &BTreeMap<String, InstalledRecord>,
) -> Result<InstalledRecordsReconcileStatus, InstalledRecordsSkipReason> {
    let metadata = match fs::symlink_metadata(database_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(InstalledRecordsSkipReason::DatabaseMissing);
        }
        Err(_) => return Err(InstalledRecordsSkipReason::DatabaseUnavailable),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(InstalledRecordsSkipReason::DatabaseUnavailable);
    }

    let mut connection = Connection::open_with_flags(
        database_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| InstalledRecordsSkipReason::DatabaseUnavailable)?;
    connection
        .busy_timeout(SQLITE_BUSY_TIMEOUT)
        .map_err(|_| InstalledRecordsSkipReason::DatabaseUnavailable)?;
    let transaction = connection
        .transaction()
        .map_err(|_| InstalledRecordsSkipReason::DatabaseUnavailable)?;
    if !has_config_machine_state_table(&transaction)? {
        return Err(InstalledRecordsSkipReason::InstalledIndexUnavailable);
    }
    let persisted_value = read_persisted_value(&transaction)?;
    let current_revision = persisted_revision(persisted_value.as_ref());
    match reconcile_installed_index(persisted_value, records) {
        InstalledIndexReconcile::Changed(value) => {
            write_persisted_value(&transaction, &value, current_revision)?;
            transaction
                .commit()
                .map_err(|_| InstalledRecordsSkipReason::DatabaseUnavailable)?;
            Ok(InstalledRecordsReconcileStatus::Changed)
        }
        InstalledIndexReconcile::Unchanged => Ok(InstalledRecordsReconcileStatus::Unchanged),
        InstalledIndexReconcile::Skipped(reason) => Err(reason),
    }
}

fn has_config_machine_state_table(
    connection: &rusqlite::Transaction<'_>,
) -> Result<bool, InstalledRecordsSkipReason> {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'config_machine_state' LIMIT 1",
            [],
            |_| Ok(()),
        )
        .optional()
        .map(|row| row.is_some())
        .map_err(|_| InstalledRecordsSkipReason::DatabaseUnavailable)
}

fn read_persisted_value(
    connection: &rusqlite::Transaction<'_>,
) -> Result<Option<Value>, InstalledRecordsSkipReason> {
    let value_json = connection
        .query_row(
            "SELECT value_json FROM config_machine_state WHERE state_key = ?1",
            [INSTALLED_INDEX_STATE_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| InstalledRecordsSkipReason::DatabaseUnavailable)?;
    value_json
        .map(|value| {
            serde_json::from_str(&value)
                .map_err(|_| InstalledRecordsSkipReason::InvalidInstalledIndex)
        })
        .transpose()
}

fn write_persisted_value(
    connection: &rusqlite::Transaction<'_>,
    value: &Value,
    current_revision: Option<i64>,
) -> Result<(), InstalledRecordsSkipReason> {
    let revision = next_revision(current_revision);
    let mut value = value.clone();
    if let Some(object) = value.as_object_mut() {
        object.insert("revision".to_owned(), Value::Number(revision.into()));
    }
    let value_json = serde_json::to_string(&value)
        .map_err(|_| InstalledRecordsSkipReason::InvalidInstalledIndex)?;
    connection
        .execute(
            "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) \
             VALUES (?1, ?2, ?3) \
             ON CONFLICT(state_key) DO UPDATE SET \
               value_json = excluded.value_json, \
               updated_at_ms = excluded.updated_at_ms",
            (INSTALLED_INDEX_STATE_KEY, value_json, revision),
        )
        .map(|_| ())
        .map_err(|_| InstalledRecordsSkipReason::DatabaseUnavailable)
}

fn skipped(
    reason: InstalledRecordsSkipReason,
    discovered_records: usize,
) -> InstalledRecordsReconcile {
    InstalledRecordsReconcile {
        status: InstalledRecordsReconcileStatus::Skipped(reason),
        discovered_records,
    }
}

fn persisted_revision(value: Option<&Value>) -> Option<i64> {
    value
        .and_then(Value::as_object)
        .and_then(|object| object.get("revision"))
        .and_then(Value::as_i64)
}

fn next_revision(current: Option<i64>) -> i64 {
    let now = now_millis();
    match current.and_then(|value| value.checked_add(1)) {
        Some(next) if next > now => next,
        _ => now,
    }
}

fn valid_install_records(records: &Map<String, Value>) -> bool {
    records.values().all(valid_install_record)
}

fn valid_install_record(value: &Value) -> bool {
    value
        .as_object()
        .and_then(|record| record.get("source"))
        .and_then(Value::as_str)
        .is_some_and(|source| {
            matches!(
                source,
                "npm" | "archive" | "path" | "clawhub" | "git" | "marketplace"
            )
        })
}

fn is_matcha_owned_record(value: &Value) -> bool {
    let Some(record) = value.as_object() else {
        return false;
    };
    record
        .get(MATCHA_OWNER_FIELD)
        .and_then(Value::as_str)
        .is_some_and(|owner| owner == MATCHA_OWNER)
        && record
            .get(MATCHA_CONTENT_SIGNATURE_FIELD)
            .and_then(Value::as_str)
            .is_some_and(valid_content_signature)
}

fn read_managed_marker(path: &Path, id: &str) -> io::Result<Option<ManagedMarker>> {
    let marker = path.join(MANAGED_MARKER);
    let metadata = match fs::symlink_metadata(&marker) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_MARKER_BYTES
    {
        return Ok(None);
    }
    let contents = fs::read_to_string(marker)?;
    let mut lines = contents.lines();
    let marker_id = lines.next().unwrap_or_default();
    let version = lines.next().unwrap_or_default().trim();
    let content_signature = lines.next().unwrap_or_default().trim();
    if marker_id != id
        || !valid_version(version)
        || !valid_content_signature(content_signature)
        || lines.next().is_some()
    {
        return Ok(None);
    }
    Ok(Some(ManagedMarker {
        version: version.to_owned(),
        content_signature: content_signature.to_owned(),
    }))
}

fn valid_plugin_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id != "."
        && id != ".."
        && !id.contains(['/', '\\'])
        && id.chars().all(|character| !character.is_whitespace())
        && Path::new(id).components().count() == 1
        && Path::new(id)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn valid_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.chars().all(|character| !character.is_control())
}

fn valid_content_signature(value: &str) -> bool {
    let Some(digest) = value.strip_prefix("sha256:") else {
        return false;
    };
    digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    use rusqlite::Connection;
    use serde_json::json;

    use super::*;

    const SIGNATURE: &str =
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "openclaw-installed-records-{}-{}",
                std::process::id(),
                NEXT_ROOT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).expect("create test root");
            Self(path)
        }

        fn extensions(&self) -> PathBuf {
            self.0.join("extensions")
        }

        fn database_path(&self) -> PathBuf {
            self.0.join("state").join("openclaw.sqlite")
        }

        fn write_managed_extension(&self, id: &str, version: &str) -> PathBuf {
            let target = self.extensions().join(id);
            fs::create_dir_all(&target).expect("create extension");
            fs::write(
                target.join(MANAGED_MARKER),
                format!("{id}\n{version}\n{SIGNATURE}\n"),
            )
            .expect("write marker");
            target.canonicalize().expect("canonical extension")
        }

        fn create_state_database(&self) {
            fs::create_dir_all(self.database_path().parent().unwrap()).expect("state dir");
            let connection = Connection::open(self.database_path()).expect("open sqlite");
            connection
                .execute(
                    "CREATE TABLE config_machine_state (state_key TEXT NOT NULL PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL) STRICT",
                    [],
                )
                .expect("create config state");
        }

        fn read_installed_index_value(&self) -> Value {
            let connection = Connection::open(self.database_path()).expect("open sqlite");
            let value_json: String = connection
                .query_row(
                    "SELECT value_json FROM config_machine_state WHERE state_key = ?1",
                    [INSTALLED_INDEX_STATE_KEY],
                    |row| row.get(0),
                )
                .expect("read installed index");
            serde_json::from_str(&value_json).expect("parse installed index")
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn discovers_installed_matcha_managed_records_from_marked_extensions() {
        let root = TestRoot::new();
        let target = root.write_managed_extension("browser-relay", "1.2.3");
        fs::create_dir_all(root.extensions().join("user-owned")).expect("user extension");

        let records = discover_managed_extension_records(&root.extensions()).expect("records");

        assert_eq!(records.len(), 1);
        assert_eq!(
            records.get("browser-relay").expect("record").to_value(None),
            json!({
                "source": "path",
                "sourcePath": target.to_string_lossy(),
                "installPath": target.to_string_lossy(),
                "version": "1.2.3",
                "matchaOwner": "matchaclaw",
                "matchaContentSignature": SIGNATURE,
            })
        );
    }

    #[test]
    fn reconciles_only_matcha_owned_install_records_and_discards_derived_index() {
        let root = TestRoot::new();
        let target = root.write_managed_extension("task-manager", "2.0.0");
        let records = discover_managed_extension_records(&root.extensions()).expect("records");
        let current = json!({
            "revision": 100,
            "index": {
                "generatedAt": 123,
                "plugins": [{ "id": "openclaw-owned" }],
                "installRecords": {
                    "openclaw-owned": {
                        "source": "marketplace",
                        "version": "9.9.9"
                    },
                    "stale-matcha": {
                        "source": "path",
                        "sourcePath": "/missing",
                        "installPath": "/missing",
                        "version": "0.1.0",
                        "matchaOwner": "matchaclaw",
                        "matchaContentSignature": SIGNATURE
                    }
                }
            }
        });

        let InstalledIndexReconcile::Changed(next) =
            reconcile_installed_index(Some(current), &records)
        else {
            panic!("index should change");
        };

        assert_eq!(next["revision"], json!(100));
        assert_eq!(next["index"].as_object().unwrap().len(), 1);
        assert_eq!(
            next["index"]["installRecords"]["openclaw-owned"]["source"],
            "marketplace"
        );
        assert!(
            next["index"]["installRecords"]
                .get("stale-matcha")
                .is_none()
        );
        assert_eq!(
            next["index"]["installRecords"]["task-manager"],
            json!({
                "source": "path",
                "sourcePath": target.to_string_lossy(),
                "installPath": target.to_string_lossy(),
                "version": "2.0.0",
                "matchaOwner": "matchaclaw",
                "matchaContentSignature": SIGNATURE,
            })
        );
    }

    #[test]
    fn preserves_existing_matcha_record_passthrough_fields() {
        let mut records = BTreeMap::new();
        records.insert(
            "browser-relay".to_owned(),
            InstalledRecord {
                source_path: "/extensions/browser-relay".to_owned(),
                install_path: "/extensions/browser-relay".to_owned(),
                version: "1.0.0".to_owned(),
                content_signature: SIGNATURE.to_owned(),
            },
        );
        let current = json!({
            "index": {
                "installRecords": {
                    "browser-relay": {
                        "source": "path",
                        "matchaOwner": "matchaclaw",
                        "matchaContentSignature": SIGNATURE,
                        "acceptedSurfaceHash": "keep"
                    }
                }
            }
        });

        let InstalledIndexReconcile::Changed(next) =
            reconcile_installed_index(Some(current), &records)
        else {
            panic!("index should change");
        };

        assert_eq!(
            next["index"]["installRecords"]["browser-relay"]["acceptedSurfaceHash"],
            "keep"
        );
    }

    #[test]
    fn managed_extension_overwrites_non_matcha_record_with_same_id() {
        let root = TestRoot::new();
        let target = root.write_managed_extension("openclaw-weixin", "2.4.8");
        let records = discover_managed_extension_records(&root.extensions()).expect("records");
        let current = json!({
            "index": {
                "installRecords": {
                    "openclaw-weixin": {
                        "source": "npm",
                        "installPath": "/npm/projects/openclaw-weixin",
                        "version": "2.4.8"
                    }
                }
            }
        });

        let InstalledIndexReconcile::Changed(next) =
            reconcile_installed_index(Some(current), &records)
        else {
            panic!("managed extension should take over the install record");
        };
        assert_eq!(
            next["index"]["installRecords"]["openclaw-weixin"]["source"],
            "path"
        );
        assert_eq!(
            next["index"]["installRecords"]["openclaw-weixin"]["installPath"],
            target.to_string_lossy().as_ref()
        );
        assert_eq!(
            next["index"]["installRecords"]["openclaw-weixin"]["matchaOwner"],
            MATCHA_OWNER
        );
    }

    #[test]
    fn skips_invalid_existing_index_without_generating_partial_index() {
        let mut records = BTreeMap::new();
        records.insert(
            "browser-relay".to_owned(),
            InstalledRecord {
                source_path: "/extensions/browser-relay".to_owned(),
                install_path: "/extensions/browser-relay".to_owned(),
                version: "1.0.0".to_owned(),
                content_signature: SIGNATURE.to_owned(),
            },
        );

        assert_eq!(
            reconcile_installed_index(Some(json!([])), &records),
            InstalledIndexReconcile::Skipped(InstalledRecordsSkipReason::InvalidInstalledIndex)
        );
        assert_eq!(
            reconcile_installed_index(Some(json!({ "index": { "installRecords": [] } })), &records),
            InstalledIndexReconcile::Skipped(InstalledRecordsSkipReason::InvalidInstallRecords)
        );
        assert_eq!(
            reconcile_installed_index(
                Some(json!({ "index": { "installRecords": { "bad": { "source": "bogus" } } } })),
                &records,
            ),
            InstalledIndexReconcile::Skipped(InstalledRecordsSkipReason::InvalidInstallRecords)
        );
    }

    #[test]
    fn missing_index_changes_only_when_matcha_records_exist() {
        let mut records = BTreeMap::new();
        records.insert(
            "browser-relay".to_owned(),
            InstalledRecord {
                source_path: "/extensions/browser-relay".to_owned(),
                install_path: "/extensions/browser-relay".to_owned(),
                version: "1.0.0".to_owned(),
                content_signature: SIGNATURE.to_owned(),
            },
        );

        assert_eq!(
            reconcile_installed_index(None, &BTreeMap::new()),
            InstalledIndexReconcile::Unchanged
        );
        assert_eq!(
            reconcile_installed_index(None, &records),
            InstalledIndexReconcile::Changed(json!({
                "index": {
                    "installRecords": {
                        "browser-relay": {
                            "source": "path",
                            "sourcePath": "/extensions/browser-relay",
                            "installPath": "/extensions/browser-relay",
                            "version": "1.0.0",
                            "matchaOwner": "matchaclaw",
                            "matchaContentSignature": SIGNATURE,
                        }
                    }
                }
            }))
        );
    }

    #[test]
    fn missing_database_returns_skipped_signal() {
        let root = TestRoot::new();
        let state_dir = CanonicalStateDir::provision(&root.0).expect("state dir");

        assert_eq!(
            reconcile(&state_dir),
            InstalledRecordsReconcile {
                status: InstalledRecordsReconcileStatus::Skipped(
                    InstalledRecordsSkipReason::DatabaseMissing
                ),
                discovered_records: 0,
            }
        );
    }

    #[test]
    fn sqlite_reconcile_is_unchanged_after_ledger_is_persisted() {
        let root = TestRoot::new();
        root.create_state_database();
        root.write_managed_extension("browser-relay", "1.0.0");
        let state_dir = CanonicalStateDir::provision(&root.0).expect("state dir");

        let first = reconcile(&state_dir);
        let first_value = root.read_installed_index_value();
        let second = reconcile(&state_dir);
        let second_value = root.read_installed_index_value();

        assert_eq!(first.status, InstalledRecordsReconcileStatus::Changed);
        assert_eq!(second.status, InstalledRecordsReconcileStatus::Unchanged);
        assert_eq!(first_value, second_value);
        assert_eq!(
            second_value["index"]["installRecords"]["browser-relay"]["source"],
            "path"
        );
    }
}
