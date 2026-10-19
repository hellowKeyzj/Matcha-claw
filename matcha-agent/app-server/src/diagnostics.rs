use crate::{config, persistence::Database, rpc};
use rusqlite::{params, params_from_iter};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::{
    io::{self, Write},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
// bridge/debugUtils.ts uses a 2000-character diagnostic preview. Here the bound is
// UTF-8 bytes of projected JSON, never a prefix of untrusted text or an identity.
const MAX_CONTEXT_BYTES: usize = 2000;
const MAX_LABEL_BYTES: usize = 96;
const MAX_ID_BYTES: usize = 256;

#[derive(Clone)]
pub struct Diagnostics {
    database: Database,
    write_failures: Arc<AtomicU64>,
}

impl Diagnostics {
    pub async fn open(paths: &config::Paths) -> rpc::Result<Self> {
        // This connection serializes diagnostics only, not other owners' work.
        let database = Database::open(&paths.database()).await?;
        database
            .call(|connection| {
                connection
                    .execute_batch(
                        "CREATE TABLE IF NOT EXISTS diagnostics_records (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            at_ms INTEGER NOT NULL,
                            owner TEXT NOT NULL,
                            operation TEXT NOT NULL,
                            kind TEXT NOT NULL,
                            agent_id TEXT,
                            session_id TEXT,
                            run_id TEXT,
                            instance_id TEXT,
                            native_request_id TEXT,
                            context TEXT NOT NULL
                        );
                        CREATE INDEX IF NOT EXISTS diagnostics_owner
                            ON diagnostics_records(owner, id);
                        CREATE INDEX IF NOT EXISTS diagnostics_operation
                            ON diagnostics_records(operation, id);
                        CREATE INDEX IF NOT EXISTS diagnostics_agent
                            ON diagnostics_records(agent_id, id);
                        CREATE INDEX IF NOT EXISTS diagnostics_session
                            ON diagnostics_records(session_id, id);
                        CREATE INDEX IF NOT EXISTS diagnostics_run
                            ON diagnostics_records(run_id, id);
                        CREATE INDEX IF NOT EXISTS diagnostics_instance
                            ON diagnostics_records(instance_id, native_request_id, id);",
                    )
                    .map_err(|error| storage_error("diagnostics_schema", error))?;
                Ok(())
            })
            .await?;
        Ok(Self {
            database,
            write_failures: Arc::new(AtomicU64::new(0)),
        })
    }

    /// Labels are producer-owned, stable classifications, never third-party
    /// messages/type names or data. Context is independently projected below.
    /// Callers must handle Err separately from their business result, not use `?`
    /// to turn an already successful action into a failed action.
    pub async fn record(
        &self,
        owner: &str,
        operation: &str,
        kind: &str,
        context: Value,
    ) -> rpc::Result<()> {
        if ![owner, operation, kind].into_iter().all(valid_label) {
            return Err(rpc::Error::invalid(
                "Diagnostic labels must be stable ASCII classifications of at most 96 bytes",
            ));
        }
        let context = project_context(context);
        // Keep exact indexed associations even when the bounded preview cannot
        // contain them; in particular, config does not cap valid agent ID length.
        let [agent_id, session_id, run_id, instance_id, native_request_id] = [
            "agentId",
            "sessionId",
            "runId",
            "instanceId",
            "nativeRequestId",
        ]
        .map(|field| {
            context
                .get(field)
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
        let encoded = limit_context(context).to_string();
        let owner = owner.to_owned();
        let operation = operation.to_owned();
        let kind = kind.to_owned();
        let at_ms = i64::try_from(rpc::now_ms())
            .map_err(|_| rpc::Error::internal("diagnostics_timestamp_range"))?;
        let result = self
            .database
            .call(move |connection| {
                connection
                    .execute(
                        "INSERT INTO diagnostics_records
                            (at_ms, owner, operation, kind, agent_id, session_id,
                             run_id, instance_id, native_request_id, context)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                        params![
                            at_ms,
                            owner,
                            operation,
                            kind,
                            agent_id,
                            session_id,
                            run_id,
                            instance_id,
                            native_request_id,
                            encoded,
                        ],
                    )
                    .map_err(|error| storage_error("diagnostics_write", error))?;
                Ok(())
            })
            .await;
        if result.is_err() {
            self.write_failures.fetch_add(1, Ordering::Relaxed);
            // No recursive record(), source Display, or panic if stderr is closed.
            // Err remains the authoritative failure report if this fallback fails.
            let _ = writeln!(
                io::stderr().lock(),
                "[diagnostics] record persistence failed; diagnostic evidence may be missing"
            );
        }
        result
    }

    pub async fn prune(&self, before_ms: u64) -> rpc::Result<Value> {
        let before_ms = i64::try_from(before_ms)
            .map_err(|_| rpc::Error::invalid("beforeMs exceeds SQLite's integer range"))?;
        self.database
            .call(move |connection| {
                let deleted = connection
                    .execute(
                        "DELETE FROM diagnostics_records WHERE at_ms < ?1",
                        params![before_ms],
                    )
                    .map_err(|error| storage_error("diagnostics_prune", error))?;
                Ok(json!({ "deleted": deleted }))
            })
            .await
    }

    pub async fn retention_status(&self) -> rpc::Result<Value> {
        self.database
            .call(|connection| {
                let (count, oldest_at_ms, newest_at_ms) = connection
                    .query_row(
                        "SELECT COUNT(*), MIN(at_ms), MAX(at_ms) FROM diagnostics_records",
                        [],
                        |row| {
                            Ok((
                                row.get::<_, i64>(0)?,
                                row.get::<_, Option<i64>>(1)?,
                                row.get::<_, Option<i64>>(2)?,
                            ))
                        },
                    )
                    .map_err(|error| storage_error("diagnostics_retention_status", error))?;
                Ok(json!({
                    "count": count,
                    "oldestAtMs": oldest_at_ms,
                    "newestAtMs": newest_at_ms,
                }))
            })
            .await
    }

    /// Management-only: gateway authentication grants instance-wide visibility.
    /// Filters are retrieval criteria, NOT authorization or proof of ownership.
    /// No retention/deletion policy or business resource quota is imposed here.
    pub async fn dispatch(&self, method: &str, params: Value) -> rpc::Result<Value> {
        if method != "diagnostics.query" {
            return Err(rpc::Error::method(method));
        }
        let query: Query = rpc::params(params)?;
        let after_id = i64::try_from(query.after_id)
            .map_err(|_| rpc::Error::invalid("afterId exceeds SQLite's integer range"))?;
        let limit = i64::try_from(query.limit)
            .ok()
            .filter(|limit| *limit > 0)
            .ok_or_else(|| rpc::Error::invalid("limit must be a positive SQLite integer"))?;
        if query.native_request_id.is_some() && query.instance_id.is_none() {
            return Err(rpc::Error::invalid(
                "nativeRequestId requires its instanceId scope",
            ));
        }
        let mut sql = String::from(
            "SELECT id, at_ms, owner, operation, kind, context
             FROM diagnostics_records WHERE id > ?",
        );
        let mut bindings = vec![rusqlite::types::Value::Integer(after_id)];
        for (column, field, value) in [
            ("owner", "owner", query.owner),
            ("operation", "operation", query.operation),
            ("kind", "kind", query.kind),
            ("agent_id", "agentId", query.agent_id),
            ("session_id", "sessionId", query.session_id),
            ("run_id", "runId", query.run_id),
            ("instance_id", "instanceId", query.instance_id),
            (
                "native_request_id",
                "nativeRequestId",
                query.native_request_id,
            ),
        ] {
            if let Some(value) = value {
                let value = if matches!(field, "owner" | "operation" | "kind") {
                    valid_label(&value).then_some(value)
                } else {
                    project_id(field, &value)
                }
                .ok_or_else(|| rpc::Error::invalid("A diagnostic filter has an invalid format"))?;
                // column is from the closed list above; values are always bound.
                sql.push_str(" AND ");
                sql.push_str(column);
                sql.push_str(" = ?");
                bindings.push(value.into());
            }
        }
        sql.push_str(" ORDER BY id ASC LIMIT ?");
        bindings.push(limit.into());
        let mut response = self
            .database
            .call(move |connection| {
                let mut statement = connection
                    .prepare(&sql)
                    .map_err(|error| storage_error("diagnostics_query", error))?;
                let rows = statement
                    .query_map(params_from_iter(bindings), |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, String>(5)?,
                        ))
                    })
                    .map_err(|error| storage_error("diagnostics_query", error))?;
                let mut items = Vec::new();
                let mut next_after_id = after_id;
                for row in rows {
                    let (id, at_ms, owner, operation, kind, encoded) =
                        row.map_err(|error| storage_error("diagnostics_query", error))?;
                    let context = serde_json::from_str(&encoded).map_err(|_| {
                        rpc::Error::new(
                            -32005,
                            "diagnostics_decode",
                            "A diagnostic record cannot be decoded; inspect the diagnostic store",
                        )
                    })?;
                    if ![owner.as_str(), operation.as_str(), kind.as_str()]
                        .into_iter()
                        .all(valid_label)
                    {
                        return Err(rpc::Error::new(
                            -32005,
                            "diagnostics_decode",
                            "A diagnostic record has invalid classification fields",
                        ));
                    }
                    items.push(json!({
                        "id": id,
                        "atMs": at_ms,
                        "owner": owner,
                        "operation": operation,
                        "kind": kind,
                        "context": limit_context(project_context(context)),
                    }));
                    next_after_id = id;
                }
                Ok(json!({ "items": items, "nextAfterId": next_after_id }))
            })
            .await?;
        response["writeFailuresSinceOpen"] = self.write_failures.load(Ordering::Relaxed).into();
        Ok(response)
    }
}

/// Exact-match AND filters; ascending durable ID cursor, not timestamp order.
/// A page defaults to 100 rows; callers may choose any positive SQLite limit.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Query {
    #[serde(default)]
    after_id: u64,
    #[serde(default = "default_limit")]
    limit: u64,
    owner: Option<String>,
    operation: Option<String>,
    kind: Option<String>,
    agent_id: Option<String>,
    session_id: Option<String>,
    run_id: Option<String>,
    instance_id: Option<String>,
    native_request_id: Option<String>,
}

fn default_limit() -> u64 {
    100
}

fn valid_label(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_LABEL_BYTES
        && value.as_bytes()[0].is_ascii_alphabetic()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

fn project_id(field: &str, value: &str) -> Option<String> {
    if field == "agentId" {
        // Agent IDs are the configured logical identity, not a display name,
        // provider identifier, arbitrary native string, path or credential.
        config::validate_id(value).ok().map(|()| value.to_owned())
    } else {
        // Protocol IDs are opaque strings, not necessarily UUIDs. Preserve their
        // exact spelling; never normalize or truncate them into collisions.
        (!value.is_empty() && value.len() <= MAX_ID_BYTES && !value.chars().any(char::is_control))
            .then(|| value.to_owned())
    }
}

/// Positive schema only. Never inspect/serialize rejected values, echo rejected
/// key names, read credentials, or classify/redact secrets by text patterns.
/// Specific reasons live in the producer's stable `kind`, not a free-text error.
fn project_context(context: Value) -> Value {
    let Value::Object(input) = context else {
        return json!({ "redacted": true });
    };
    let mut output = Map::new();
    let mut redacted = false;
    let mut truncated = false;
    for (field, value) in input {
        if value.is_null() {
            continue;
        }
        let projected = match field.as_str() {
            "agentId"
            | "sessionId"
            | "runId"
            | "instanceId"
            | "nativeRequestId"
            | "messageId"
            | "traceId"
            | "operationId"
            | "causedByOperationId" => {
                if let Some(value) = value.as_str() {
                    truncated |= field != "agentId" && value.len() > MAX_ID_BYTES;
                }
                value
                    .as_str()
                    .and_then(|value| project_id(&field, value))
                    .map(Value::String)
            }
            "requestId" => {
                if let Some(value) = value.as_str() {
                    truncated |= value.len() > MAX_ID_BYTES;
                }
                if value.as_i64().is_some() || value.as_u64().is_some() {
                    Some(value.clone())
                } else {
                    value
                        .as_str()
                        .and_then(|value| project_id("requestId", value))
                        .map(Value::String)
                }
            }
            "causeKind" | "stage" => value
                .as_str()
                .filter(|label| valid_label(label))
                .map(|label| Value::String(label.to_owned())),
            "ioKind" => value.as_str().and_then(|kind| {
                matches!(
                    kind,
                    "NotFound"
                        | "PermissionDenied"
                        | "ConnectionRefused"
                        | "ConnectionReset"
                        | "HostUnreachable"
                        | "NetworkUnreachable"
                        | "ConnectionAborted"
                        | "NotConnected"
                        | "AddrInUse"
                        | "AddrNotAvailable"
                        | "NetworkDown"
                        | "BrokenPipe"
                        | "AlreadyExists"
                        | "WouldBlock"
                        | "NotADirectory"
                        | "IsADirectory"
                        | "DirectoryNotEmpty"
                        | "ReadOnlyFilesystem"
                        | "FilesystemLoop"
                        | "StaleNetworkFileHandle"
                        | "InvalidInput"
                        | "InvalidData"
                        | "TimedOut"
                        | "WriteZero"
                        | "StorageFull"
                        | "NotSeekable"
                        | "QuotaExceeded"
                        | "FileTooLarge"
                        | "ResourceBusy"
                        | "ExecutableFileBusy"
                        | "Deadlock"
                        | "CrossesDevices"
                        | "TooManyLinks"
                        | "InvalidFilename"
                        | "ArgumentListTooLong"
                        | "Interrupted"
                        | "Unsupported"
                        | "UnexpectedEof"
                        | "OutOfMemory"
                        | "InProgress"
                        | "Other"
                        | "Uncategorized"
                )
                .then(|| Value::String(kind.to_owned()))
            }),
            "delivery" => value.as_str().and_then(|delivery| {
                matches!(delivery, "notSent" | "sent" | "responseReceived" | "unknown")
                    .then(|| Value::String(delivery.to_owned()))
            }),
            "phase" => value.as_str().and_then(|phase| {
                matches!(
                    phase,
                    "validation"
                        | "prepare"
                        | "projection"
                        | "spawn"
                        | "initialize"
                        | "read"
                        | "write"
                        | "decode"
                        | "send"
                        | "receive"
                        | "execute"
                        | "wait"
                        | "persist"
                        | "commit"
                        | "query"
                        | "replay"
                        | "control"
                        | "respond"
                        | "cancel"
                        | "close"
                        | "cleanup"
                        | "shutdown"
                        | "authenticate"
                        | "dispatch"
                )
                .then(|| Value::String(phase.to_owned()))
            }),
            "stream" => value.as_str().and_then(|stream| {
                matches!(stream, "stdin" | "stdout" | "stderr")
                    .then(|| Value::String(stream.to_owned()))
            }),
            "elapsedMs" | "bytes" | "count" => value.as_u64().map(Value::from),
            "pid" => value
                .as_u64()
                .filter(|pid| *pid <= u64::from(u32::MAX))
                .map(Value::from),
            "exitCode" | "signal" | "osError" | "sqliteCode" | "rpcCode" | "causeCode"
            | "osCode" => value.as_i64().map(Value::from),
            "stderrObserved" | "stdoutObserved" | "applied" | "partial" | "outcomeUnknown"
            | "cleanupComplete" => value.as_bool().map(Value::Bool),
            "redacted" => {
                redacted |= value.as_bool().unwrap_or(true);
                continue;
            }
            "truncated" => {
                truncated |= value.as_bool().unwrap_or(true);
                continue;
            }
            // Includes prompt/tool input/output/thinking/stdout/stderr/env/argv,
            // token/auth, URLs/paths, error/source/backtrace and all raw bodies.
            _ => None,
        };
        if let Some(value) = projected {
            output.insert(field, value);
        } else {
            redacted = true;
        }
    }
    // A native request identity is meaningful only within its CLI instance.
    if !output.contains_key("instanceId") && output.remove("nativeRequestId").is_some() {
        redacted = true;
    }
    if redacted {
        output.insert("redacted".into(), true.into());
    }
    if truncated {
        output.insert("truncated".into(), true.into());
    }
    Value::Object(output)
}

fn limit_context(context: Value) -> Value {
    if context.to_string().len() > MAX_CONTEXT_BYTES {
        // Fail closed even if a later schema extension exceeds the byte budget.
        // There is deliberately no raw-string or prefix fallback.
        json!({ "redacted": true, "truncated": true })
    } else {
        context
    }
}

fn storage_error(kind: &'static str, error: rusqlite::Error) -> rpc::Error {
    let response = rpc::Error::new(
        -32005,
        kind,
        "Diagnostic storage failed; check storage availability and query again",
    );
    let response = match &error {
        rusqlite::Error::SqliteFailure(error, _) => {
            response.with_data(json!({ "sqliteCode": error.extended_code }))
        }
        _ => response,
    };
    response.with_source(error)
}
