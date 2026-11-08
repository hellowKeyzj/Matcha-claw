use std::{
    collections::BTreeSet,
    path::Path,
    time::{Duration, Instant},
};

use rusqlite::{Connection, ErrorCode, OpenFlags, OptionalExtension, config::DbConfig};
use serde_json::{Value, json};

use super::{configuration::Configuration, file_evidence, io_status, label, version};

const SQL_BUDGET: Duration = Duration::from_secs(5);
const MAX_SQL_INSTRUCTIONS: usize = 100_000;

struct SchemaMetadata {
    role: String,
    agent_id: Option<String>,
    schema_version: i64,
    app_version: Option<String>,
}

impl SchemaMetadata {
    fn summary(&self) -> Value {
        json!({
            "role": label(&self.role),
            "agentId": self.agent_id.as_deref().map(label),
            "schemaVersion": self.schema_version,
            "appVersion": self.app_version.as_deref().and_then(|text| {
                let value = Value::String(text.to_owned());
                version(&value).map(ToOwned::to_owned)
            }),
        })
    }
}

const META_COLUMNS: &[&str] = &[
    "meta_key",
    "role",
    "agent_id",
    "schema_version",
    "app_version",
];
const STATE_TABLES: &[(&str, &[&str])] = &[
    ("schema_meta", META_COLUMNS),
    (
        "config_machine_state",
        &["state_key", "value_json", "updated_at_ms"],
    ),
    ("agent_databases", &["agent_id", "path", "schema_version"]),
];
const AGENT_TABLES: &[(&str, &[&str])] = &[
    ("schema_meta", META_COLUMNS),
    (
        "session_nodes",
        &[
            "session_key",
            "current_session_id",
            "entry_json",
            "updated_at",
        ],
    ),
    (
        "session_windows",
        &["session_id", "session_key", "updated_at"],
    ),
    ("transcript_events", &["session_id", "event_json"]),
];

pub(super) fn inspect(state_dir: &Path, configuration: &Configuration, package: &Value) -> Value {
    let deadline = Instant::now() + SQL_BUDGET;
    let shared = database(
        &state_dir.join("state/openclaw.sqlite"),
        "global",
        None,
        package
            .pointer("/schemaVersions/state")
            .and_then(Value::as_u64),
        deadline,
    );
    let agents = configuration.agents.iter().map(|agent| {
        match &agent.path {
            Some(path) => database(path, "agent", Some(&agent.id), package.pointer("/schemaVersions/agent").and_then(Value::as_u64), deadline),
            None => json!({"expectedAgentId": label(&agent.id), "status": "notInspected", "reason": agent.reason}),
        }
    }).collect::<Vec<_>>();
    json!({
        "shared": shared,
        "configuredAgents": agents,
        "coverage": {
            "openMode": "sqliteReadOnlyWalAwareNotImmutable",
            "busyTimeoutMs": 0,
            "sqlBudget": {
                "maxInstructionsPerDatabase": MAX_SQL_INSTRUCTIONS,
                "sharedElapsedMs": SQL_BUDGET.as_millis(),
                "enforcement": "sqliteProgressCallbackNotFilesystemDeadline"
            },
            "queries": "selectedMetadataAndNamedTableColumnsOnly",
            "schemaShape": "selectedRequiredColumnsNotFullNativeSchema",
            "integrityAndForeignKeys": "notScanned",
            "eventsAndSecrets": "notRead",
            "registryPathsAndCustomSessionStores": "notEnumerated",
            "pluginsQuarantineAndUnconfiguredAgents": "notInspected",
            "extensions": "notLoaded",
            "mutationsAndMigrations": "notPerformed",
            "databaseWrites": false,
            "filesystemWrites": "SQLiteMayCreateOrMaintainWalCoordinationSidecars"
        }
    })
}

fn database(
    path: &Path,
    expected_role: &str,
    expected_agent: Option<&str>,
    supported: Option<u64>,
    deadline: Instant,
) -> Value {
    let mut evidence = file_evidence(path);
    evidence["expectedRole"] = json!(expected_role);
    evidence["expectedAgentId"] = expected_agent.map(label).unwrap_or(Value::Null);
    evidence["supportedSchemaVersion"] = json!(supported);
    if evidence["status"] != "present" {
        return evidence;
    }
    if Instant::now() >= deadline {
        evidence["status"] = json!("notInspected");
        evidence["reason"] = json!("sqlBudgetExceeded");
        return evidence;
    }
    if let Err(error) = std::fs::File::open(path) {
        evidence["status"] = json!(io_status(&error));
        return evidence;
    }
    match read_database(path, expected_role, expected_agent, supported, deadline) {
        Ok(summary) => {
            evidence
                .as_object_mut()
                .unwrap()
                .extend(summary.as_object().unwrap().clone());
        }
        Err(error) => {
            evidence["status"] = json!(sqlite_status(&error));
            if let rusqlite::Error::SqliteFailure(code, _) = error {
                evidence["sqliteExtendedCode"] = json!(code.extended_code);
            }
        }
    }
    evidence
}

fn read_database(
    path: &Path,
    expected_role: &str,
    expected_agent: Option<&str>,
    supported: Option<u64>,
    deadline: Instant,
) -> rusqlite::Result<Value> {
    // No CREATE/URI flags: a disappeared database cannot become an empty replacement.
    let mut connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let mut instructions = 0;
    connection.progress_handler(
        1000,
        Some(move || {
            instructions += 1000;
            instructions >= MAX_SQL_INSTRUCTIONS || Instant::now() >= deadline
        }),
    );
    connection.busy_timeout(Duration::ZERO)?;
    connection.set_db_config(DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false)?;
    connection.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)?;
    connection.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)?;
    let transaction = connection.transaction()?;
    let user_version: i64 = transaction.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let tables = if expected_role == "global" {
        STATE_TABLES
    } else {
        AGENT_TABLES
    };
    let mut shapes = Vec::new();
    let mut missing_shape = false;
    let mut metadata_readable = false;
    let mut content_readable = false;
    for (table, columns) in tables {
        let shape = table_shape(&transaction, table, columns)?;
        let matched = shape["status"] == "selectedColumnsPresent";
        missing_shape |= !matched;
        if *table == "schema_meta" {
            metadata_readable = matched;
        }
        if *table == "config_machine_state" {
            content_readable = matched;
        }
        shapes.push(shape);
    }
    let metadata = if metadata_readable {
        metadata(&transaction)?
    } else {
        None
    };
    let content = if expected_role == "global" && content_readable {
        content_version(&transaction)?
    } else {
        None
    };
    let mut findings = Vec::new();
    if missing_shape {
        findings.push("selectedRequiredShapeMissingOrUnsupported");
    }
    if metadata.is_none() {
        findings.push("primarySchemaMetadataMissingOrUnreadableShape");
    }
    let mut incompatible = false;
    if let Some(metadata) = &metadata {
        if metadata.role != expected_role {
            findings.push("roleMismatch");
            incompatible = true;
        }
        if let Some(expected_agent) = expected_agent {
            if metadata
                .agent_id
                .as_deref()
                .map(str::trim)
                .map(str::to_ascii_lowercase)
                .as_deref()
                != Some(expected_agent)
            {
                findings.push("agentOwnerMismatchOrNotCanonical");
                incompatible = true;
            }
        }
        if metadata.schema_version != user_version {
            findings.push("publishedVersionMarkersDisagree");
        }
        if metadata.schema_version < 0 {
            findings.push("invalidSchemaMetadataVersion");
        }
    }
    let content_number = content
        .as_ref()
        .and_then(|content| content.get("value"))
        .and_then(Value::as_u64);
    if content
        .as_ref()
        .is_some_and(|content| content["status"] == "invalidMarker")
    {
        findings.push("invalidContentVersionMarker");
    }
    let published = u64::try_from(user_version).ok();
    if published.is_none() {
        findings.push("invalidPublishedSchemaVersion");
    }
    let effective = published.into_iter().chain(content_number).max();
    if let Some(supported) = supported {
        if effective.is_some_and(|actual| actual > supported)
            || metadata
                .as_ref()
                .is_some_and(|meta| i128::from(meta.schema_version) > i128::from(supported))
        {
            findings.push("newerThanInstalledPackageSchema");
            incompatible = true;
        } else if effective.is_some_and(|actual| actual < supported) {
            findings.push("olderThanInstalledPackageSchemaOwnerAssessmentRequired");
        }
    } else {
        findings.push("installedPackageSchemaVersionUnavailable");
    }
    transaction.commit()?;
    Ok(json!({
        "status": if incompatible { "incompatible" } else if findings.is_empty() { "inspected" } else { "needsAssessment" },
        "userVersion": user_version,
        "schemaMeta": metadata.as_ref().map(SchemaMetadata::summary),
        "contentVersion": content,
        "effectiveContentVersion": if expected_role == "global" { effective } else { None },
        "shape": shapes,
        "findings": findings,
        "nativeSchemaValidation": "notPerformed"
    }))
}

fn table_shape(connection: &Connection, table: &str, required: &[&str]) -> rusqlite::Result<Value> {
    let definition = connection
        .query_row(
            "SELECT type, substr(sql, 1, 32) FROM sqlite_schema WHERE name = ?1 LIMIT 1",
            [table],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()?;
    let Some((kind, sql)) = definition else {
        return Ok(json!({"table": table, "status": "missingTable", "missingColumns": required}));
    };
    // Metadata names must not turn into views or extension-backed virtual table queries.
    if kind != "table"
        || !sql.as_deref().is_some_and(|sql| {
            sql.trim_start()
                .to_ascii_uppercase()
                .starts_with("CREATE TABLE")
        })
    {
        return Ok(json!({"table": table, "status": "unsupportedTableKind"}));
    }
    let mut statement =
        connection.prepare("SELECT substr(name, 1, 257) FROM pragma_table_info(?1) LIMIT 129")?;
    let columns = statement
        .query_map([table], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<BTreeSet<_>>>()?;
    let missing = required
        .iter()
        .filter(|column| !columns.contains(**column))
        .copied()
        .collect::<Vec<_>>();
    Ok(json!({
        "table": table,
        "status": if columns.len() > 128 { "columnLimitReached" } else if missing.is_empty() { "selectedColumnsPresent" } else { "missingColumns" },
        "missingColumns": missing,
        "checkedColumns": required
    }))
}

fn metadata(connection: &Connection) -> rusqlite::Result<Option<SchemaMetadata>> {
    connection.query_row(
        "SELECT substr(role, 1, 257), substr(agent_id, 1, 257), schema_version, substr(app_version, 1, 129) FROM schema_meta WHERE meta_key = 'primary' LIMIT 1",
        [], |row| {
            Ok(SchemaMetadata {
                role: row.get(0)?,
                agent_id: row.get(1)?,
                schema_version: row.get(2)?,
                app_version: row.get(3)?,
            })
        },
    ).optional()
}

fn content_version(connection: &Connection) -> rusqlite::Result<Option<Value>> {
    let marker = connection.query_row(
        "SELECT substr(value_json, 1, 129) FROM config_machine_state WHERE state_key = 'state.schema.contentVersion' LIMIT 1",
        [], |row| row.get::<_, String>(0),
    ).optional()?;
    Ok(marker.map(|marker| {
        match serde_json::from_str::<Value>(&marker)
            .ok()
            .and_then(|value| value.as_u64())
            .filter(|value| *value <= 9_007_199_254_740_991)
        {
            Some(value) => json!({"status": "present", "value": value}),
            None => json!({"status": "invalidMarker"}),
        }
    }))
}

fn sqlite_status(error: &rusqlite::Error) -> &'static str {
    match error {
        rusqlite::Error::SqliteFailure(code, _) => match code.code {
            ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => "locked",
            ErrorCode::OperationInterrupted => "sqlBudgetExceeded",
            ErrorCode::PermissionDenied
            | ErrorCode::AuthorizationForStatementDenied
            | ErrorCode::ReadOnly => "permissionDenied",
            ErrorCode::CannotOpen => "cannotOpen",
            ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase => "corruptOrNotDatabase",
            ErrorCode::SchemaChanged => "schemaChanged",
            ErrorCode::SystemIoFailure => "ioError",
            _ => "sqliteError",
        },
        rusqlite::Error::InvalidColumnType(..) | rusqlite::Error::IntegralValueOutOfRange(..) => {
            "incompatibleMetadataShape"
        }
        _ => "sqliteError",
    }
}
