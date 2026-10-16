mod file;

pub use file::atomic_write;
#[cfg(unix)]
pub use file::atomic_write_at;

use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use rusqlite::{Connection, ErrorCode};
use serde_json::json;

use crate::rpc;

#[derive(Clone)]
pub struct Database {
    connection: Arc<Mutex<Connection>>,
}

impl Database {
    /// The caller owns the parent directory's creation and authorization.
    pub async fn open(path: &Path) -> rpc::Result<Self> {
        let path = path.to_owned();
        tokio::task::spawn_blocking(move || {
            let connection = Connection::open(path).map_err(|error| sqlite_error("open", error))?;
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
                connection: Arc::new(Mutex::new(connection)),
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

    /// Dropping this future does not cancel an already queued blocking operation.
    /// The closure owns transactions and projects its SQL/commit errors without retrying.
    pub async fn call<F, T>(&self, operation: F) -> rpc::Result<T>
    where
        F: FnOnce(&mut Connection) -> rpc::Result<T> + Send + 'static,
        T: Send + 'static,
    {
        let connection = Arc::clone(&self.connection);
        tokio::task::spawn_blocking(move || {
            let mut connection = connection.lock().map_err(|_| {
                rpc::Error::new(
                    -32005,
                    "sqlite_connection_poisoned",
                    "Database connection is unavailable after a panic; reopen the database",
                )
            })?;
            operation(&mut connection)
        })
        .await
        .map_err(|error| {
            if error.is_cancelled() {
                rpc::Error::new(
                    -32005,
                    "sqlite_worker_cancelled",
                    "Database operation was cancelled before its worker started",
                )
                .with_source(error)
            } else {
                rpc::Error::new(
                    -32006,
                    "sqlite_operation_outcome_unknown",
                    "Database worker stopped without a result; inspect persisted state before retrying",
                )
                .with_source(error)
            }
        })?
    }
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
