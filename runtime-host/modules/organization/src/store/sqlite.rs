use std::{fs, io, path::Path, time::Duration};

use rusqlite::{Connection, Error, ErrorCode, OpenFlags, Row, Transaction, TransactionBehavior, params};

use super::{
    StoreFault,
    schema::{self, RecordChange, RecordKey, RecordKind, StoredRecord},
};

pub(crate) struct Database {
    connection: Connection,
}

pub(crate) struct WriteTransaction<'connection> {
    transaction: Transaction<'connection>,
    epoch: u64,
    initialized: bool,
    changed: bool,
}

impl Database {
    pub(crate) fn open(path: &Path) -> Result<Self, StoreFault> {
        Self::open_with_initialization(path, false)
    }

    pub(crate) fn open_new(path: &Path) -> Result<Self, StoreFault> {
        Self::open_with_initialization(path, true)
    }

    fn open_with_initialization(path: &Path, initialize: bool) -> Result<Self, StoreFault> {
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent).map_err(|error| StoreFault::Commit(error.kind()))?;
        }
        let mut connection = Connection::open(path).map_err(read_error)?;
        connection
            .busy_timeout(Duration::from_millis(500))
            .map_err(read_error)?;
        connection
            .execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
            .map_err(write_error)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(write_error)?;
        let version: u8 = transaction
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(read_error)?;
        if version != 0 && version != schema::VERSION {
            return Err(StoreFault::UnsupportedSchemaVersion(version));
        }
        if version == 0 {
            transaction
                .execute_batch(schema::CREATE)
                .map_err(write_error)?;
            transaction
                .pragma_update(None, "user_version", schema::VERSION)
                .map_err(write_error)?;
        }
        if initialize {
            let (epoch, initialized) = metadata(&transaction)?;
            let mut transaction = WriteTransaction {
                transaction,
                epoch,
                initialized,
                changed: false,
            };
            transaction.mark_initialized()?;
            transaction.commit()?;
        } else {
            transaction.commit().map_err(commit_error)?;
        }
        Ok(Self { connection })
    }

    pub(crate) fn read_record(path: &Path, key: &RecordKey) -> Result<Option<StoredRecord>, StoreFault> {
        let mut connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(read_error)?;
        connection.busy_timeout(Duration::from_millis(500)).map_err(read_error)?;
        let transaction = connection.transaction().map_err(read_error)?;
        let version: u8 = transaction
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(read_error)?;
        if version != schema::VERSION {
            return Err(StoreFault::UnsupportedSchemaVersion(version));
        }
        if !metadata(&transaction)?.1 {
            return Err(StoreFault::MigrationRequired);
        }
        let record = {
            let mut statement = transaction.prepare_cached(
                "SELECT kind,scope,id,team_id,run_id,payload FROM records
                 WHERE kind=?1 AND scope=?2 AND id=?3 AND payload IS NOT NULL",
            ).map_err(read_error)?;
            let mut rows = statement.query(params![key.kind.as_str(), key.scope, key.id])
                .map_err(read_error)?;
            rows.next().map_err(read_error)?.map(read_change).transpose()?
        };
        transaction.commit().map_err(read_error)?;
        match record {
            Some(RecordChange::Put(record)) => Ok(Some(record)),
            None => Ok(None),
            Some(RecordChange::Delete(_)) => Err(StoreFault::CorruptRecord),
        }
    }

    pub(crate) fn initialized(&self) -> Result<bool, StoreFault> {
        metadata(&self.connection).map(|(_, initialized)| initialized)
    }

    pub(crate) fn read_all(&mut self) -> Result<(u64, Vec<StoredRecord>), StoreFault> {
        let transaction = self.connection.transaction().map_err(read_error)?;
        let (epoch, _) = metadata(&transaction)?;
        let records = read_all(&transaction)?;
        transaction.commit().map_err(read_error)?;
        Ok((epoch, records))
    }

    pub(crate) fn read_since(
        &mut self,
        epoch: u64,
    ) -> Result<(u64, Vec<RecordChange>), StoreFault> {
        let transaction = self.connection.transaction().map_err(read_error)?;
        let (current, _) = metadata(&transaction)?;
        let changes = read_since(&transaction, epoch, current)?;
        transaction.commit().map_err(read_error)?;
        Ok((current, changes))
    }

    pub(crate) fn begin(&mut self) -> Result<WriteTransaction<'_>, StoreFault> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(write_error)?;
        let (epoch, initialized) = metadata(&transaction)?;
        Ok(WriteTransaction {
            transaction,
            epoch,
            initialized,
            changed: false,
        })
    }
}

impl WriteTransaction<'_> {
    pub(crate) fn epoch(&self) -> u64 {
        self.epoch
    }

    pub(crate) fn initialized(&self) -> bool {
        self.initialized
    }

    pub(crate) fn read_all(&self) -> Result<Vec<StoredRecord>, StoreFault> {
        read_all(&self.transaction)
    }

    pub(crate) fn read_since(&self, epoch: u64) -> Result<(u64, Vec<RecordChange>), StoreFault> {
        let current = if self.changed {
            self.next_epoch()?
        } else {
            self.epoch
        };
        Ok((current, read_since(&self.transaction, epoch, current)?))
    }

    pub(crate) fn put(&mut self, record: &StoredRecord) -> Result<(), StoreFault> {
        let next_epoch = self.next_epoch()?;
        let changed = self
            .transaction
            .execute(
                "INSERT INTO records(kind,scope,id,team_id,run_id,payload,epoch)
             VALUES(?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(kind,scope,id) DO UPDATE SET
               team_id=excluded.team_id,run_id=excluded.run_id,
               payload=excluded.payload,epoch=excluded.epoch
             WHERE records.team_id IS NOT excluded.team_id
                OR records.run_id IS NOT excluded.run_id
                OR records.payload IS NOT excluded.payload",
                params![
                    record.key.kind.as_str(),
                    record.key.scope,
                    record.key.id,
                    record.team_id,
                    record.run_id,
                    record.payload,
                    next_epoch,
                ],
            )
            .map_err(write_error)?;
        self.changed |= changed != 0;
        Ok(())
    }

    pub(crate) fn delete(&mut self, key: &RecordKey) -> Result<(), StoreFault> {
        let next_epoch = self.next_epoch()?;
        // Keep only the latest deletion so older handles can invalidate their record.
        let changed = self
            .transaction
            .execute(
                "UPDATE records SET payload=NULL,epoch=?4
             WHERE kind=?1 AND scope=?2 AND id=?3 AND payload IS NOT NULL",
                params![key.kind.as_str(), key.scope, key.id, next_epoch],
            )
            .map_err(write_error)?;
        self.changed |= changed != 0;
        Ok(())
    }

    pub(crate) fn mark_initialized(&mut self) -> Result<(), StoreFault> {
        if !self.initialized {
            self.transaction
                .execute(
                    "UPDATE organization_meta SET initialized=1 WHERE singleton=1",
                    [],
                )
                .map_err(write_error)?;
            self.initialized = true;
            self.changed = true;
        }
        Ok(())
    }

    pub(crate) fn commit(self) -> Result<u64, StoreFault> {
        let epoch = if self.changed {
            self.next_epoch()?
        } else {
            self.epoch
        };
        if self.changed {
            self.transaction
                .execute(
                    "UPDATE organization_meta SET epoch=?1 WHERE singleton=1",
                    params![epoch],
                )
                .map_err(write_error)?;
        }
        self.transaction.commit().map_err(commit_error)?;
        Ok(epoch)
    }

    fn next_epoch(&self) -> Result<u64, StoreFault> {
        self.epoch
            .checked_add(1)
            .filter(|epoch| *epoch <= i64::MAX as u64)
            .ok_or(StoreFault::EpochOverflow)
    }
}

fn metadata(connection: &Connection) -> Result<(u64, bool), StoreFault> {
    connection
        .query_row(
            "SELECT epoch,initialized FROM organization_meta WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(read_error)
}

fn read_all(connection: &Connection) -> Result<Vec<StoredRecord>, StoreFault> {
    let mut statement = connection
        .prepare_cached(
            "SELECT kind,scope,id,team_id,run_id,payload FROM records
         WHERE payload IS NOT NULL ORDER BY kind,scope,id",
        )
        .map_err(read_error)?;
    let mut rows = statement.query([]).map_err(read_error)?;
    let mut records = Vec::new();
    while let Some(row) = rows.next().map_err(read_error)? {
        let RecordChange::Put(record) = read_change(row)? else {
            return Err(StoreFault::CorruptRecord);
        };
        records.push(record);
    }
    Ok(records)
}

fn read_since(
    connection: &Connection,
    epoch: u64,
    current: u64,
) -> Result<Vec<RecordChange>, StoreFault> {
    if epoch > current {
        return Err(StoreFault::RecoveryRequired);
    }
    if epoch == current {
        return Ok(Vec::new());
    }
    let mut statement = connection
        .prepare_cached(
            "SELECT kind,scope,id,team_id,run_id,payload FROM records
         WHERE epoch>?1 ORDER BY epoch,kind,scope,id",
        )
        .map_err(read_error)?;
    let mut rows = statement.query(params![epoch]).map_err(read_error)?;
    let mut changes = Vec::new();
    while let Some(row) = rows.next().map_err(read_error)? {
        changes.push(read_change(row)?);
    }
    Ok(changes)
}

fn read_change(row: &Row<'_>) -> Result<RecordChange, StoreFault> {
    let kind: String = row.get(0).map_err(read_error)?;
    let key = RecordKey {
        kind: RecordKind::parse(&kind)?,
        scope: row.get(1).map_err(read_error)?,
        id: row.get(2).map_err(read_error)?,
    };
    let payload: Option<Vec<u8>> = row.get(5).map_err(read_error)?;
    Ok(match payload {
        Some(payload) => RecordChange::Put(StoredRecord {
            key,
            team_id: row.get(3).map_err(read_error)?,
            run_id: row.get(4).map_err(read_error)?,
            payload,
        }),
        None => RecordChange::Delete(key),
    })
}

fn busy(error: &Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
    )
}

fn corrupt(error: &Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase)
    ) || matches!(
        error,
        Error::InvalidColumnType(..)
            | Error::IntegralValueOutOfRange(..)
            | Error::QueryReturnedNoRows
    )
}

fn read_error(error: Error) -> StoreFault {
    if busy(&error) {
        StoreFault::WriterBusy
    } else if corrupt(&error) {
        StoreFault::CorruptRecord
    } else {
        StoreFault::Read(io::ErrorKind::Other)
    }
}

fn write_error(error: Error) -> StoreFault {
    if busy(&error) {
        StoreFault::WriterBusy
    } else if corrupt(&error) {
        StoreFault::CorruptRecord
    } else {
        StoreFault::Commit(io::ErrorKind::Other)
    }
}

fn commit_error(error: Error) -> StoreFault {
    if busy(&error) {
        StoreFault::WriterBusy
    } else {
        StoreFault::CommitOutcomeUnknown(io::ErrorKind::Other)
    }
}
