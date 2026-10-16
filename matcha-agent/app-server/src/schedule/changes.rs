use std::{path::Path, sync::OnceLock};

use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use serde_json::json;
use tokio::sync::watch;

use crate::rpc::{self, Error};

use super::store::{Store, storage};

static CHANGED: OnceLock<watch::Sender<()>> = OnceLock::new();

fn sender() -> &'static watch::Sender<()> {
    CHANGED.get_or_init(|| watch::channel(()).0)
}

pub(super) fn committed() {
    sender().send_replace(());
}

pub(super) fn append(transaction: &rusqlite::Transaction<'_>, receipt_id: &str) -> rpc::Result<()> {
    transaction.execute(
        "INSERT INTO schedule_receipt_changes(receipt_id,schedule_id,status,run_id) SELECT receipt_id,schedule_id,status,run_id FROM schedule_receipts WHERE receipt_id=?1",
        [receipt_id],
    ).map_err(storage)?;
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptChange {
    pub seq: u64,
    pub receipt_id: String,
    pub schedule_id: String,
    pub status: String,
    pub run_id: Option<String>,
}

#[derive(Clone)]
pub struct Changes(Store);

impl Changes {
    pub async fn open(path: &Path) -> rpc::Result<Self> {
        Ok(Self(Store::open(path).await?))
    }

    /// Register before reading durable state; the watch is only a coalescing wake-up.
    pub fn watch(&self) -> watch::Receiver<()> {
        sender().subscribe()
    }

    pub async fn latest(&self) -> rpc::Result<u64> {
        self.0.0.call(|connection| latest(connection)).await
    }

    /// Exclusive cursor. A zero-sized page still validates the next durable sequence.
    pub async fn replay(&self, after_seq: u64, limit: usize) -> rpc::Result<Vec<ReceiptChange>> {
        let limit = i64::try_from(limit)
            .map_err(|_| Error::invalid("limit exceeds the database integer range"))?;
        self.0.0.call(move |connection| {
            let transaction = connection.transaction().map_err(storage)?;
            let latest = latest(&transaction)?;
            if after_seq > latest {
                return Err(Error::conflict(
                    "schedule_cursor_ahead",
                    "Schedule receipt cursor is ahead of durable storage",
                ).with_data(json!({"cursor":after_seq,"latestSeq":latest})));
            }
            let next: Option<u64> = transaction.query_row(
                "SELECT seq FROM schedule_receipt_changes WHERE seq>?1 ORDER BY seq LIMIT 1",
                [after_seq], |row| row.get(0),
            ).optional().map_err(storage)?;
            if after_seq < latest && after_seq.checked_add(1) != next {
                return Err(sequence_gap(after_seq + 1, next, latest));
            }
            let mut query = transaction.prepare(
                "SELECT seq,receipt_id,schedule_id,status,run_id FROM schedule_receipt_changes WHERE seq>?1 ORDER BY seq LIMIT ?2",
            ).map_err(storage)?;
            let changes = query.query_map(params![after_seq, limit], |row| Ok(ReceiptChange {
                seq: row.get(0)?, receipt_id: row.get(1)?, schedule_id: row.get(2)?,
                status: row.get(3)?, run_id: row.get(4)?,
            })).map_err(storage)?.collect::<rusqlite::Result<Vec<_>>>().map_err(storage)?;
            let mut cursor = after_seq;
            for change in &changes {
                if cursor.checked_add(1) != Some(change.seq) {
                    return Err(sequence_gap(cursor + 1, Some(change.seq), latest));
                }
                cursor = change.seq;
            }
            if limit > 0 && changes.len() < limit as usize && cursor < latest {
                return Err(sequence_gap(cursor + 1, None, latest));
            }
            Ok(changes)
        }).await
    }
}

fn latest(connection: &rusqlite::Connection) -> rpc::Result<u64> {
    let (head, tail): (u64, u64) = connection.query_row(
        "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='schedule_receipt_changes'),0),COALESCE(MAX(seq),0) FROM schedule_receipt_changes",
        [], |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(storage)?;
    if head != tail {
        return Err(sequence_gap(head, Some(tail), head));
    }
    Ok(head)
}

fn sequence_gap(expected: u64, actual: Option<u64>, latest: u64) -> Error {
    Error::new(
        -32005,
        "schedule_sequence_gap",
        "Durable schedule receipt sequence has a gap",
    )
    .with_data(json!({"expectedSeq":expected,"actualSeq":actual,"latestSeq":latest}))
}
