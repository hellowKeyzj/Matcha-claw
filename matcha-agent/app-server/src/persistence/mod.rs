mod file;

pub use file::atomic_write;
#[cfg(unix)]
pub use file::atomic_write_at;

use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use rusqlite::{Connection, ErrorCode, OpenFlags};
use serde_json::json;
use tokio::sync::Semaphore;

use crate::rpc;

#[derive(Clone)]
pub struct Database {
    connections: Arc<Connections>,
}

struct Connections {
    path: PathBuf,
    writer: Mutex<Option<Connection>>,
    readers: Mutex<Vec<Connection>>,
    write: Arc<Semaphore>,
    read: Arc<Semaphore>,
}

impl Database {
    /// The caller owns the parent directory's creation and authorization.
    pub async fn open(path: &Path) -> rpc::Result<Self> {
        let path = path.to_owned();
        tokio::task::spawn_blocking(move || {
            let connection =
                Connection::open(&path).map_err(|error| sqlite_error("open", error))?;
            // Match rusqlite's current default; SQLite itself waits for BUSY locks.
            // LOCKED/BUSY_SNAPSHOT are not a reason to replay an arbitrary closure.
            connection
                .busy_timeout(Duration::from_secs(5))
                .map_err(|error| sqlite_error("busy_timeout", error))?;
            let journal: String = connection
                .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))
                .map_err(|error| sqlite_error("journal_mode", error))?;
            if !journal.eq_ignore_ascii_case("wal") {
                return Err(rpc::Error::new(
                    -32005,
                    "sqlite_wal_unavailable",
                    "Database did not enter WAL mode; use storage that supports WAL",
                ));
            }
            connection
                .pragma_update(None, "synchronous", "FULL")
                .map_err(|error| sqlite_error("synchronous", error))?;
            connection
                .pragma_update(None, "foreign_keys", true)
                .map_err(|error| sqlite_error("foreign_keys", error))?;
            Ok(Self {
                connections: Arc::new(Connections {
                    path,
                    writer: Mutex::new(Some(connection)),
                    readers: Mutex::new(Vec::with_capacity(2)),
                    write: Arc::new(Semaphore::new(1)),
                    read: Arc::new(Semaphore::new(2)),
                }),
            })
        })
        .await
        .map_err(|error| {
            rpc::Error::new(
                -32005,
                "sqlite_open_worker",
                "Database initialization could not finish",
            )
            .with_source(error)
        })?
    }

    /// Dropping this future does not cancel an accepted operation, including admission waits.
    /// The closure owns transactions and projects its SQL/commit errors without retrying.
    pub async fn call<F, T>(&self, operation: F) -> rpc::Result<T>
    where
        F: FnOnce(&mut Connection) -> rpc::Result<T> + Send + 'static,
        T: Send + 'static,
    {
        let connections = Arc::clone(&self.connections);
        tokio::spawn(async move {
            let permit = Arc::clone(&connections.write)
                .acquire_owned()
                .await
                .map_err(|_| connection_poisoned())?;
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                let mut writer = connections
                    .writer
                    .lock()
                    .map_err(|_| connection_poisoned())?;
                let connection = writer.as_mut().ok_or_else(connection_poisoned)?;
                let result = operation(connection);
                if !connection.is_autocommit() {
                    // Never lend a transaction, including a failed rollback, to the next caller.
                    writer.take();
                    return result.and(Err(connection_poisoned()));
                }
                result
            })
            .await
            .map_err(worker_error)?
        })
        .await
        // Losing admission's task cannot prove that its blocking operation never started.
        .map_err(outcome_unknown)?
    }

    /// Only independent reads belong here; read-modify-write operations must use call.
    /// Each closure owns its read transaction. No snapshot is retained between requests.
    pub async fn read<F, T>(&self, operation: F) -> rpc::Result<T>
    where
        F: FnOnce(&mut Connection) -> rpc::Result<T> + Send + 'static,
        T: Send + 'static,
    {
        let connections = Arc::clone(&self.connections);
        let permit = Arc::clone(&connections.read)
            .acquire_owned()
            .await
            .map_err(|_| connection_poisoned())?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let idle = connections
                .readers
                .lock()
                .map_err(|_| connection_poisoned())?
                .pop();
            let mut connection = match idle {
                Some(connection) => connection,
                None => open_reader(&connections.path)?,
            };
            // A panic drops this connection instead of returning it to the idle pool.
            let result = operation(&mut connection);
            if !connection.is_autocommit() {
                return result.and(Err(connection_poisoned()));
            }
            connections
                .readers
                .lock()
                .map_err(|_| connection_poisoned())?
                .push(connection);
            result
        })
        .await
        .map_err(worker_error)?
    }
}

fn open_reader(path: &Path) -> rpc::Result<Connection> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| sqlite_error("read_open", error))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| sqlite_error("busy_timeout", error))?;
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(|error| sqlite_error("synchronous", error))?;
    connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(|error| sqlite_error("foreign_keys", error))?;
    connection
        .pragma_update(None, "query_only", true)
        .map_err(|error| sqlite_error("query_only", error))?;
    Ok(connection)
}

fn connection_poisoned() -> rpc::Error {
    rpc::Error::new(
        -32005,
        "sqlite_connection_poisoned",
        "Database connection is unavailable after a panic or unfinished transaction; reopen the database",
    )
}

fn worker_error(error: tokio::task::JoinError) -> rpc::Error {
    if error.is_cancelled() {
        rpc::Error::new(
            -32005,
            "sqlite_worker_cancelled",
            "Database operation was cancelled before its worker started",
        )
        .with_source(error)
    } else {
        outcome_unknown(error)
    }
}

fn outcome_unknown(error: tokio::task::JoinError) -> rpc::Error {
    rpc::Error::new(
        -32006,
        "sqlite_operation_outcome_unknown",
        "Database worker stopped without a result; inspect persisted state before retrying",
    )
    .with_source(error)
}

fn sqlite_error(stage: &'static str, source: rusqlite::Error) -> rpc::Error {
    let kind = match source.sqlite_error_code() {
        Some(ErrorCode::DatabaseBusy) => "sqlite_busy",
        Some(ErrorCode::DatabaseLocked) => "sqlite_locked",
        Some(ErrorCode::ReadOnly) => "sqlite_read_only",
        Some(ErrorCode::PermissionDenied | ErrorCode::AuthorizationForStatementDenied) => {
            "sqlite_permission_denied"
        }
        Some(ErrorCode::DatabaseCorrupt) => "sqlite_corrupt",
        Some(ErrorCode::NotADatabase) => "sqlite_not_database",
        Some(ErrorCode::DiskFull) => "sqlite_disk_full",
        Some(ErrorCode::SystemIoFailure) => "sqlite_io",
        Some(ErrorCode::CannotOpen) => "sqlite_cannot_open",
        Some(ErrorCode::OutOfMemory) => "sqlite_out_of_memory",
        _ => "sqlite_initialization",
    };
    rpc::Error::new(
        -32005,
        kind,
        "Database initialization failed; inspect the storage reason before retrying",
    )
    .with_data(json!({
        "stage": stage,
        "sqliteCode": source.sqlite_error().map(|error| error.extended_code),
    }))
    .with_source(source)
}
