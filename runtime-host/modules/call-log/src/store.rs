use std::{
    fs::{self, File, OpenOptions},
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use platform::call::{
    CallAppend, CallBegin, CallChanged, CallHistory, CallId, CallLogError, CallPage, CallQuery,
    CallRecord, CallStatus, CallTransition, ErasedCallDetail, MAX_PAGE_SIZE,
};
use rusqlite::{Connection, OptionalExtension, Transaction, params};

pub(crate) struct Store {
    connection: Connection,
    _writer_lock: File,
}

impl Store {
    pub(crate) fn open(state_dir: &Path) -> Result<Self, CallLogError> {
        if !state_dir.is_absolute() {
            return Err(CallLogError::InvalidInput);
        }
        fs::create_dir_all(state_dir).map_err(|_| CallLogError::PersistFailed)?;
        let writer_lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(state_dir.join("call-log.lock"))
            .map_err(|_| CallLogError::PersistFailed)?;
        writer_lock
            .try_lock()
            .map_err(|_| CallLogError::Unavailable)?;
        let connection = Connection::open(state_dir.join("call-log.sqlite"))
            .map_err(|_| CallLogError::PersistFailed)?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(persist_error)?;
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=FULL;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS calls (
               position INTEGER PRIMARY KEY AUTOINCREMENT,
               call_id TEXT NOT NULL UNIQUE,
               module TEXT NOT NULL,
               command TEXT NOT NULL,
               status TEXT NOT NULL,
               start INTEGER NOT NULL,
               end INTEGER,
               revision INTEGER NOT NULL,
               detail TEXT NOT NULL CHECK(length(CAST(detail AS BLOB)) <= 8192)
             );
             CREATE INDEX IF NOT EXISTS calls_module ON calls(module,position DESC);
             CREATE INDEX IF NOT EXISTS calls_status ON calls(status,position DESC);
             CREATE INDEX IF NOT EXISTS calls_module_status ON calls(module,status,position DESC);
             CREATE TABLE IF NOT EXISTS call_changes (
               call_id TEXT NOT NULL REFERENCES calls(call_id),
               revision INTEGER NOT NULL,
               status TEXT NOT NULL,
               at INTEGER NOT NULL,
               detail TEXT NOT NULL CHECK(length(CAST(detail AS BLOB)) <= 8192),
               PRIMARY KEY(call_id,revision)
             );",
            )
            .map_err(persist_error)?;
        let mut store = Self {
            connection,
            _writer_lock: writer_lock,
        };
        store.recover()?;
        Ok(store)
    }

    fn recover(&mut self) -> Result<(), CallLogError> {
        let at = now_millis();
        let transaction = self.connection.transaction().map_err(persist_error)?;
        transaction
            .execute(
                "INSERT INTO call_changes(call_id,revision,status,at,detail)
             SELECT call_id,revision+1,'unknown',MAX(?1,start),detail FROM calls
             WHERE status IN ('received','accepted','running','waiting')",
                params![at],
            )
            .map_err(persist_error)?;
        transaction
            .execute(
                "UPDATE calls SET status='unknown',end=MAX(?1,start),revision=revision+1
             WHERE status IN ('received','accepted','running','waiting')",
                params![at],
            )
            .map_err(persist_error)?;
        transaction.commit().map_err(persist_error)
    }

    pub(crate) fn begin(&mut self, call: CallBegin) -> Result<CallChanged, CallLogError> {
        let mut bytes = [0_u8; 16];
        getrandom::fill(&mut bytes).map_err(|_| CallLogError::Unavailable)?;
        let call_id = CallId::parse(
            &bytes
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>(),
        )?;
        let detail = call.detail.encode()?;
        let at = now_millis();
        let transaction = self.connection.transaction().map_err(persist_error)?;
        transaction
            .execute(
                "INSERT INTO calls(call_id,module,command,status,start,end,revision,detail)
             VALUES(?1,?2,?3,'received',?4,NULL,1,?5)",
                params![call_id.as_str(), call.module, call.command, at, detail],
            )
            .map_err(persist_error)?;
        insert_change(&transaction, &call_id, 1, CallStatus::Received, at, &detail)?;
        transaction.commit().map_err(persist_error)?;
        Ok(CallChanged {
            call_id,
            revision: 1,
        })
    }

    pub(crate) fn append(
        &mut self,
        change: CallAppend,
    ) -> Result<Option<CallChanged>, CallLogError> {
        let transaction = self.connection.transaction().map_err(persist_error)?;
        let previous = transaction
            .query_row(
                "SELECT status,revision,detail,end,start FROM calls WHERE call_id=?1",
                params![change.call_id.as_str()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, u64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<u64>>(3)?,
                        row.get::<_, u64>(4)?,
                    ))
                },
            )
            .optional()
            .map_err(persist_error)?
            .ok_or(CallLogError::NotFound)?;
        let previous_status = decode_status(&previous.0)?;
        let requested_status = change.status.unwrap_or(previous_status);
        // Admission is acknowledged after enqueue; the owner may have already advanced.
        let late_admission = requested_status == CallStatus::Accepted
            && !matches!(previous_status, CallStatus::Received | CallStatus::Accepted);
        if late_admission && transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM call_changes WHERE call_id=?1 AND status='accepted')",
            params![change.call_id.as_str()],
            |row| row.get::<_, bool>(0),
        ).map_err(persist_error)? {
            return Ok(None);
        }
        if previous_status.is_terminal() && requested_status != previous_status && !late_admission {
            return Err(CallLogError::InvalidTransition);
        }
        let status = if late_admission {
            previous_status
        } else {
            requested_status
        };
        if !late_admission && status == CallStatus::Received && previous_status != status {
            return Err(CallLogError::InvalidTransition);
        }
        let detail = if late_admission {
            previous.2.clone()
        } else {
            change
                .detail
                .map(|detail| detail.encode())
                .transpose()?
                .unwrap_or_else(|| previous.2.clone())
        };
        if status == previous_status && detail == previous.2 && !late_admission {
            return Ok(None);
        }
        let revision = previous
            .1
            .checked_add(1)
            .ok_or(CallLogError::PersistFailed)?;
        let at = now_millis().max(previous.4);
        transaction
            .execute(
                "UPDATE calls SET status=?2,end=?3,revision=?4,detail=?5 WHERE call_id=?1",
                params![
                    change.call_id.as_str(),
                    status.as_str(),
                    previous.3.or_else(|| status.is_terminal().then_some(at)),
                    revision,
                    detail
                ],
            )
            .map_err(persist_error)?;
        insert_change(
            &transaction,
            &change.call_id,
            revision,
            requested_status,
            at,
            &detail,
        )?;
        transaction.commit().map_err(persist_error)?;
        Ok(Some(CallChanged {
            call_id: change.call_id,
            revision,
        }))
    }

    pub(crate) fn get(&self, call_id: &CallId) -> Result<CallRecord, CallLogError> {
        let row = self.connection.query_row(
            "SELECT call_id,module,command,status,start,end,revision,detail FROM calls WHERE call_id=?1",
            params![call_id.as_str()], read_record,
        ).optional().map_err(persist_error)?.ok_or(CallLogError::NotFound)?;
        decode_record(row)
    }

    pub(crate) fn list(&self, query: CallQuery) -> Result<CallPage, CallLogError> {
        validate_limit(query.limit)?;
        if query
            .module
            .as_ref()
            .is_some_and(|module| module.is_empty() || module.len() > 128)
        {
            return Err(CallLogError::InvalidInput);
        }
        let before = query
            .before
            .map(|id| {
                self.connection
                    .query_row(
                        "SELECT position FROM calls WHERE call_id=?1",
                        params![id.as_str()],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()
                    .map_err(persist_error)?
                    .ok_or(CallLogError::NotFound)
            })
            .transpose()?;
        let mut sql = String::from(
            "SELECT call_id,module,command,status,start,end,revision,detail FROM calls WHERE 1=1",
        );
        let mut parameters = Vec::<rusqlite::types::Value>::new();
        if let Some(module) = query.module {
            sql.push_str(" AND module=?");
            parameters.push(module.into());
        }
        if let Some(status) = query.status {
            sql.push_str(" AND status=?");
            parameters.push(status.as_str().to_owned().into());
        }
        if let Some(before) = before {
            sql.push_str(" AND position<?");
            parameters.push(before.into());
        }
        sql.push_str(" ORDER BY position DESC LIMIT ?");
        parameters.push(i64::from(query.limit + 1).into());
        let mut statement = self.connection.prepare(&sql).map_err(persist_error)?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(parameters), read_record)
            .map_err(persist_error)?;
        let mut items = rows
            .map(|row| decode_record(row.map_err(persist_error)?))
            .collect::<Result<Vec<_>, _>>()?;
        let next = if items.len() > query.limit as usize {
            items.pop();
            items.last().map(|item| item.call_id.clone())
        } else {
            None
        };
        Ok(CallPage { items, next })
    }

    pub(crate) fn history(
        &self,
        call_id: &CallId,
        after: Option<u64>,
        limit: u32,
    ) -> Result<CallHistory, CallLogError> {
        validate_limit(limit)?;
        if after.is_some_and(|revision| revision > i64::MAX as u64) {
            return Err(CallLogError::InvalidInput);
        }
        if !self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM calls WHERE call_id=?1)",
                params![call_id.as_str()],
                |row| row.get::<_, bool>(0),
            )
            .map_err(persist_error)?
        {
            return Err(CallLogError::NotFound);
        }
        let mut statement = self.connection.prepare(
            "SELECT revision,status,at,detail FROM call_changes WHERE call_id=?1 AND revision>?2 ORDER BY revision LIMIT ?3"
        ).map_err(persist_error)?;
        let rows = statement
            .query_map(
                params![call_id.as_str(), after.unwrap_or(0), limit + 1],
                |row| {
                    Ok((
                        row.get::<_, u64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, u64>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .map_err(persist_error)?;
        let mut items = rows
            .map(|row| {
                let (revision, status, at, detail) = row.map_err(persist_error)?;
                Ok(CallTransition {
                    revision,
                    status: decode_status(&status)?,
                    at,
                    detail: ErasedCallDetail::decode(detail.as_bytes())?,
                })
            })
            .collect::<Result<Vec<_>, CallLogError>>()?;
        let next = if items.len() > limit as usize {
            items.pop();
            items.last().map(|item| item.revision)
        } else {
            None
        };
        Ok(CallHistory { items, next })
    }

    pub(crate) fn close(self) -> Result<(), CallLogError> {
        self.connection
            .close()
            .map_err(|_| CallLogError::PersistFailed)
    }
}

type RecordRow = (
    String,
    String,
    String,
    String,
    u64,
    Option<u64>,
    u64,
    String,
);

fn read_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<RecordRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
    ))
}

fn decode_record(row: RecordRow) -> Result<CallRecord, CallLogError> {
    Ok(CallRecord {
        call_id: CallId::parse(&row.0)?,
        module: row.1,
        command: row.2,
        status: decode_status(&row.3)?,
        start: row.4,
        end: row.5,
        revision: row.6,
        detail: ErasedCallDetail::decode(row.7.as_bytes())?,
    })
}

fn decode_status(status: &str) -> Result<CallStatus, CallLogError> {
    match status {
        "received" => Ok(CallStatus::Received),
        "accepted" => Ok(CallStatus::Accepted),
        "running" => Ok(CallStatus::Running),
        "waiting" => Ok(CallStatus::Waiting),
        "succeeded" => Ok(CallStatus::Succeeded),
        "failed" => Ok(CallStatus::Failed),
        "rejected" => Ok(CallStatus::Rejected),
        "unknown" => Ok(CallStatus::Unknown),
        _ => Err(CallLogError::PersistFailed),
    }
}

fn insert_change(
    transaction: &Transaction<'_>,
    call_id: &CallId,
    revision: u64,
    status: CallStatus,
    at: u64,
    detail: &str,
) -> Result<(), CallLogError> {
    transaction
        .execute(
            "INSERT INTO call_changes(call_id,revision,status,at,detail) VALUES(?1,?2,?3,?4,?5)",
            params![call_id.as_str(), revision, status.as_str(), at, detail],
        )
        .map_err(persist_error)?;
    Ok(())
}

fn validate_limit(limit: u32) -> Result<(), CallLogError> {
    if limit == 0 || limit > MAX_PAGE_SIZE {
        Err(CallLogError::InvalidInput)
    } else {
        Ok(())
    }
}

fn persist_error(_: rusqlite::Error) -> CallLogError {
    CallLogError::PersistFailed
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(9_007_199_254_740_991) as u64
}
