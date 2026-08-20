use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use super::{WorkspaceProjectionError, identity};

static NEXT_TEMPORARY_FILE: AtomicU64 = AtomicU64::new(1);

#[derive(Deserialize, Default)]
struct WorkspaceStateDocument {
    #[serde(rename = "bootstrapSeededAt")]
    bootstrap_seeded_at: Option<String>,
    #[serde(rename = "setupCompletedAt")]
    setup_completed_at: Option<String>,
    #[serde(rename = "onboardingCompletedAt")]
    onboarding_completed_at: Option<String>,
}

#[derive(Serialize)]
struct WorkspaceStateOutput<'a> {
    version: u8,
    #[serde(rename = "bootstrapSeededAt", skip_serializing_if = "Option::is_none")]
    bootstrap_seeded_at: &'a Option<String>,
    #[serde(rename = "setupCompletedAt", skip_serializing_if = "Option::is_none")]
    setup_completed_at: &'a Option<String>,
}

pub(super) struct WorkspaceState {
    pub(super) bootstrap_seeded: bool,
    pub(super) setup_completed: bool,
    bootstrap_seeded_at: Option<String>,
    setup_completed_at: Option<String>,
    requires_canonical_write: bool,
}

impl WorkspaceState {
    fn empty() -> Self {
        Self {
            bootstrap_seeded: false,
            setup_completed: false,
            bootstrap_seeded_at: None,
            setup_completed_at: None,
            requires_canonical_write: false,
        }
    }

    fn from_document(document: WorkspaceStateDocument) -> Self {
        let bootstrap_seeded_at = marker(document.bootstrap_seeded_at);
        let setup_completed_at = marker(document.setup_completed_at);
        let onboarding_completed_at = marker(document.onboarding_completed_at);
        let requires_canonical_write =
            setup_completed_at.is_none() && onboarding_completed_at.is_some();
        let setup_completed_at = setup_completed_at.or(onboarding_completed_at);
        Self {
            bootstrap_seeded: bootstrap_seeded_at.is_some(),
            setup_completed: setup_completed_at.is_some(),
            bootstrap_seeded_at,
            setup_completed_at,
            requires_canonical_write,
        }
    }

    pub(super) fn completed(&self) -> bool {
        self.setup_completed
    }

    pub(super) fn seed_now(&mut self) -> Result<(), WorkspaceProjectionError> {
        self.bootstrap_seeded = true;
        self.bootstrap_seeded_at = Some(iso_timestamp_now()?);
        Ok(())
    }

    pub(super) fn complete_now(&mut self) -> Result<(), WorkspaceProjectionError> {
        self.setup_completed = true;
        self.setup_completed_at = Some(iso_timestamp_now()?);
        Ok(())
    }

    pub(super) fn requires_canonical_write(&self) -> bool {
        self.requires_canonical_write
    }
}

pub(super) fn read_state(path: &Path) -> Result<WorkspaceState, WorkspaceProjectionError> {
    let raw = match identity::read_regular(path) {
        Ok(Some(raw)) => raw,
        Ok(None) => return Ok(WorkspaceState::empty()),
        Err(_) => return Err(WorkspaceProjectionError::StateUnavailable),
    };
    serde_json::from_str::<WorkspaceStateDocument>(&raw)
        .map(WorkspaceState::from_document)
        .map_err(|_| WorkspaceProjectionError::StateUnavailable)
}

pub(super) fn write_state(
    path: &Path,
    state: &WorkspaceState,
) -> Result<(), WorkspaceProjectionError> {
    let parent = path
        .parent()
        .ok_or(WorkspaceProjectionError::StateUnavailable)?;
    identity::ensure_directory(parent).map_err(|_| WorkspaceProjectionError::StateUnavailable)?;
    let mut content = serde_json::to_vec_pretty(&WorkspaceStateOutput {
        version: 1,
        bootstrap_seeded_at: &state.bootstrap_seeded_at,
        setup_completed_at: &state.setup_completed_at,
    })
    .map_err(|_| WorkspaceProjectionError::StateUnavailable)?;
    content.push(b'\n');
    replace_file(path, &content)
}

fn replace_file(path: &Path, content: &[u8]) -> Result<(), WorkspaceProjectionError> {
    let temporary = temporary_path(path)?;
    let result = (|| {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| WorkspaceProjectionError::StateUnavailable)?;
        output
            .write_all(content)
            .map_err(|_| WorkspaceProjectionError::StateUnavailable)?;
        output
            .sync_all()
            .map_err(|_| WorkspaceProjectionError::StateUnavailable)?;
        drop(output);
        replace_temporary(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(unix)]
fn replace_temporary(temporary: &Path, path: &Path) -> Result<(), WorkspaceProjectionError> {
    fs::rename(temporary, path).map_err(|_| WorkspaceProjectionError::StateUnavailable)
}

#[cfg(windows)]
fn replace_temporary(temporary: &Path, path: &Path) -> Result<(), WorkspaceProjectionError> {
    use std::{
        os::windows::ffi::OsStrExt,
        ptr::{null, null_mut},
    };
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    if !path.exists() {
        return fs::rename(temporary, path).map_err(|_| WorkspaceProjectionError::StateUnavailable);
    }
    let replaced: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    let replacement: Vec<u16> = temporary.as_os_str().encode_wide().chain([0]).collect();
    if unsafe {
        ReplaceFileW(
            replaced.as_ptr(),
            replacement.as_ptr(),
            null(),
            0,
            null_mut(),
            null_mut(),
        )
    } == 0
    {
        return Err(WorkspaceProjectionError::StateUnavailable);
    }
    Ok(())
}

fn temporary_path(path: &Path) -> Result<PathBuf, WorkspaceProjectionError> {
    let parent = path
        .parent()
        .ok_or(WorkspaceProjectionError::StateUnavailable)?;
    let sequence = NEXT_TEMPORARY_FILE.fetch_add(1, Ordering::Relaxed);
    Ok(parent.join(format!(
        ".workspace-state.{:x}.{sequence:x}.tmp",
        std::process::id()
    )))
}

fn marker(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.trim().is_empty())
}

fn iso_timestamp_now() -> Result<String, WorkspaceProjectionError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| WorkspaceProjectionError::ClockUnavailable)?;
    let seconds = duration.as_secs() as i64;
    let milliseconds = duration.subsec_millis();
    let day_seconds = seconds.rem_euclid(86_400);
    let days = seconds.div_euclid(86_400);
    let (year, month, day) = civil_date(days);
    let hour = day_seconds / 3_600;
    let minute = (day_seconds % 3_600) / 60;
    let second = day_seconds % 60;
    Ok(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milliseconds:03}Z"
    ))
}

fn civil_date(days_since_unix_epoch: i64) -> (i64, i64, i64) {
    let day = days_since_unix_epoch + 719_468;
    let era = if day >= 0 { day } else { day - 146_096 } / 146_097;
    let day_of_era = day - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}
