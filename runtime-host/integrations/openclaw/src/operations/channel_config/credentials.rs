use super::{CanonicalStateDir, channel_trace};
use rusqlite::{Connection, OpenFlags, TransactionBehavior};
use serde_json::Value;
use std::time::Instant;
use std::{path::Path, time::Duration};

mod whatsapp;

pub(super) struct CleanupPlan {
    whatsapp: Option<whatsapp::Cleanup>,
}

pub(super) fn plan(
    state_dir: &CanonicalStateDir,
    document: &Value,
    channel: &str,
    account: Option<&str>,
    native_working_directory: Option<&Path>,
) -> Result<CleanupPlan, ()> {
    let started = Instant::now();
    channel_trace(
        "cleanup.plan.begin",
        &format!("accountPresent={}", account.is_some()),
    );
    let result = (|| {
        let whatsapp = if channel == "whatsapp" {
            Some(whatsapp::plan(
                state_dir,
                document,
                account,
                native_working_directory,
            )?)
        } else {
            None
        };
        Ok(CleanupPlan { whatsapp })
    })();
    channel_trace(
        "cleanup.plan.end",
        &format!(
            "planned={} elapsedMs={}",
            result.is_ok(),
            started.elapsed().as_millis()
        ),
    );
    result
}

impl CleanupPlan {
    pub(super) fn execute(
        self,
        state_dir: &CanonicalStateDir,
        channel: &str,
        account: Option<&str>,
    ) -> Result<(), ()> {
        let started = Instant::now();
        channel_trace(
            "cleanup.execute.begin",
            &format!("accountPresent={}", account.is_some()),
        );
        let result = (|| {
            if let Some(whatsapp) = self.whatsapp {
                whatsapp.execute(state_dir)?;
            }
            clear_pairing(state_dir, channel, account)?;
            if channel == "openclaw-weixin" {
                let files_started = Instant::now();
                channel_trace("cleanup.weixin_files.begin", "storage=native_account_files");
                let result = super::super::weixin_login::clear_account_state(state_dir, account);
                channel_trace(
                    "cleanup.weixin_files.end",
                    &format!(
                        "success={} elapsedMs={}",
                        result.is_ok(),
                        files_started.elapsed().as_millis()
                    ),
                );
                result?;
            }
            Ok(())
        })();
        channel_trace(
            "cleanup.execute.end",
            &format!(
                "success={} elapsedMs={}",
                result.is_ok(),
                started.elapsed().as_millis()
            ),
        );
        result
    }
}

pub(super) fn is_last_weixin_account(
    state_dir: &CanonicalStateDir,
    account: Option<&str>,
) -> Result<bool, ()> {
    let started = Instant::now();
    channel_trace(
        "delete.account_index.begin",
        &format!("accountPresent={}", account.is_some()),
    );
    let result = (|| {
        let Some(account) = account else {
            return Ok(true);
        };
        let bytes = state_dir
            .read_nested_regular_file_bounded(
                &["openclaw-weixin".into(), "accounts.json".into()],
                1_048_576,
            )
            .map_err(|_| ())?;
        let Some(bytes) = bytes else {
            return Ok(true);
        };
        let accounts: Vec<String> = serde_json::from_slice(&bytes).map_err(|_| ())?;
        Ok(accounts.iter().all(|id| {
            super::super::weixin_login::normalize_account_id(id).as_deref() == Some(account)
        }))
    })();
    match &result {
        Ok(last) => channel_trace(
            "delete.account_index.end",
            &format!(
                "lastAccount={last} elapsedMs={}",
                started.elapsed().as_millis()
            ),
        ),
        Err(()) => channel_trace(
            "delete.account_index.end",
            &format!(
                "code=index_read_failed elapsedMs={}",
                started.elapsed().as_millis()
            ),
        ),
    }
    result
}

fn clear_pairing(
    state_dir: &CanonicalStateDir,
    channel: &str,
    account: Option<&str>,
) -> Result<(), ()> {
    let started = Instant::now();
    channel_trace("cleanup.sqlite.begin", "storage=native_pairing");
    let result = (|| {
        let path = state_dir.as_path().join("state").join("openclaw.sqlite");
        if !path.try_exists().map_err(|error| {
            channel_trace(
                "cleanup.sqlite.exists",
                &format!("ioKind={:?}", error.kind()),
            );
        })? {
            channel_trace("cleanup.sqlite.noop", "reason=store_absent");
            return Ok(());
        }
        let mut connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| {
            channel_trace("cleanup.sqlite.open", "code=sqlite_error");
        })?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|_| {
                channel_trace("cleanup.sqlite.timeout_setup", "code=sqlite_error");
            })?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| {
                channel_trace("cleanup.sqlite.transaction", "code=sqlite_error");
            })?;
        let channel = channel.to_ascii_lowercase().replace("..", "_");
        let account = account.map(str::to_ascii_lowercase);
        for table in ["channel_pairing_allow_entries", "channel_pairing_requests"] {
            let exists: bool = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                    [table],
                    |row| row.get(0),
                )
                .map_err(|_| {
                    channel_trace("cleanup.sqlite.table_lookup", "code=sqlite_error");
                })?;
            if !exists {
                channel_trace("cleanup.sqlite.noop", "reason=table_absent");
                continue;
            }
            let query = format!(
                "DELETE FROM {table} WHERE channel_key=?1 AND (?2 IS NULL OR account_id=?2)"
            );
            let removed = transaction
                .execute(&query, rusqlite::params![channel, account])
                .map_err(|_| {
                    channel_trace("cleanup.sqlite.delete", "outcome=failed code=sqlite_error");
                })?;
            channel_trace("cleanup.sqlite.delete", &format!("removedCount={removed}"));
        }
        transaction.commit().map_err(|_| {
            channel_trace("cleanup.sqlite.commit", "outcome=failed code=sqlite_error");
        })
    })();
    channel_trace(
        "cleanup.sqlite.end",
        &format!(
            "success={} elapsedMs={}",
            result.is_ok(),
            started.elapsed().as_millis()
        ),
    );
    result
}
