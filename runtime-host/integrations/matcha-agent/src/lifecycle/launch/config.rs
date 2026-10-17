use std::fmt;

use platform::state_dir::{CanonicalStateDir, StateFileReplaceError};
use serde_json::{Value, json};

use super::{APP_SERVER_HOST, APP_SERVER_TOKEN_ENV, LaunchFactoryInput};

const CONFIG_FILE: &str = "matcha-agent.json";
const LOCK_FILE: &str = "matcha-agent.lock";
const CONFIG_BYTES: usize = usize::MAX;

pub(super) fn prepare(
    home: &CanonicalStateDir,
    input: &LaunchFactoryInput,
) -> Result<(), ConfigFailure> {
    let directory = home.open().map_err(|_| FailureKind::HomeUnavailable)?;
    // The Server holds this same persistent lock from before config read until exit.
    // Never unlink it: replacing the inode would split the mutual-exclusion scope.
    let lock = directory
        .lock_regular_file(LOCK_FILE)
        .map_err(|_| FailureKind::LockUnavailable)?;
    let result = patch(&directory, input);
    match (result, lock.unlock()) {
        (Ok(()), Ok(())) => Ok(()),
        (Ok(()), Err(_)) => Err(ConfigFailure {
            primary: None,
            unlock_failed: true,
        }),
        (Err(failure), Ok(())) => Err(failure),
        (Err(mut failure), Err(_)) => {
            failure.unlock_failed = true;
            Err(failure)
        }
    }
}

fn patch(
    directory: &platform::state_dir::StateDirHandle,
    input: &LaunchFactoryInput,
) -> Result<(), ConfigFailure> {
    let stored = directory
        .read_regular_file_bounded(CONFIG_FILE, CONFIG_BYTES)
        .map_err(|_| FailureKind::ReadFailed)?;
    let mut config = match &stored {
        Some(bytes) => {
            serde_json::from_slice::<Value>(bytes).map_err(|_| FailureKind::InvalidConfig)?
        }
        None => json!({}),
    };
    let fields = config.as_object_mut().ok_or(FailureKind::InvalidConfig)?;
    fields.insert(
        "listen".into(),
        format!("{APP_SERVER_HOST}:{}", input.port).into(),
    );
    fields.insert("authTokenEnv".into(), APP_SERVER_TOKEN_ENV.into());
    let cli = fields.entry("cli").or_insert_with(|| json!({}));
    let cli = cli.as_object_mut().ok_or(FailureKind::InvalidConfig)?;
    cli.insert(
        "command".into(),
        serde_json::to_value(&input.cli_executable).map_err(|_| FailureKind::InvalidConfig)?,
    );
    cli.insert("args".into(), json!(input.cli_args));
    // Value mutation preserves every native/unknown field, including cli.env.
    let encoded = serde_json::to_vec_pretty(&config).map_err(|_| FailureKind::InvalidConfig)?;
    if stored.as_deref() == Some(encoded.as_slice()) {
        return Ok(());
    }
    directory
        .replace_regular_file_bounded_detailed(CONFIG_FILE, &encoded, CONFIG_BYTES)
        .map_err(|error| FailureKind::WriteFailed(error).into())
}

#[derive(Clone, Copy, Debug)]
pub(super) struct ConfigFailure {
    primary: Option<FailureKind>,
    unlock_failed: bool,
}

#[derive(Clone, Copy, Debug)]
enum FailureKind {
    HomeUnavailable,
    LockUnavailable,
    ReadFailed,
    InvalidConfig,
    WriteFailed(StateFileReplaceError),
    WorkerUnknown,
}

impl From<FailureKind> for ConfigFailure {
    fn from(primary: FailureKind) -> Self {
        Self {
            primary: Some(primary),
            unlock_failed: false,
        }
    }
}

impl ConfigFailure {
    pub(super) fn worker_unknown() -> Self {
        FailureKind::WorkerUnknown.into()
    }

    pub(super) fn outcome_unknown(self) -> bool {
        self.unlock_failed
            || match self.primary {
                Some(FailureKind::WorkerUnknown) => true,
                Some(FailureKind::WriteFailed(error)) => {
                    error.commit_unknown() || error.cleanup_failed()
                }
                _ => false,
            }
    }
}

impl fmt::Display for ConfigFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self.primary {
            Some(FailureKind::HomeUnavailable) => {
                "server home identity or permissions could not be verified"
            }
            Some(FailureKind::LockUnavailable) => {
                "server home lock unavailable; a live owner may hold this home"
            }
            Some(FailureKind::ReadFailed) => "server configuration could not be read safely",
            Some(FailureKind::InvalidConfig) => {
                "server configuration is not a valid configuration object"
            }
            Some(FailureKind::WriteFailed(error)) if error.commit_unknown() => {
                "server configuration commit durability is unknown"
            }
            Some(FailureKind::WriteFailed(_)) => {
                "server configuration replacement failed before commit"
            }
            Some(FailureKind::WorkerUnknown) => "server configuration worker outcome is unknown",
            None => "server configuration prepared",
        })?;
        if matches!(self.primary, Some(FailureKind::WriteFailed(error)) if error.cleanup_failed()) {
            formatter.write_str("; temporary file cleanup failed")?;
        }
        if self.unlock_failed {
            formatter.write_str("; home lock release failed")?;
        }
        if self.outcome_unknown() {
            formatter.write_str("; inspect before restarting Host")?;
        }
        Ok(())
    }
}
