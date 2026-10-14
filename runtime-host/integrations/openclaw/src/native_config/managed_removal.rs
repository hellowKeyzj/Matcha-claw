use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    path::Path,
};

use super::{ManagedMarker, parse_managed_marker};

#[cfg(unix)]
#[path = "managed_removal/posix.rs"]
mod platform;
#[cfg(windows)]
#[path = "managed_removal/windows.rs"]
mod platform;

pub(super) struct MarkerCustody {
    directory: platform::DirectoryCustody,
    marker: File,
    retained: Option<File>,
}

impl MarkerCustody {
    pub(super) fn open(extensions: &Path, id: &str, removing: bool) -> io::Result<Option<Self>> {
        let Some(directory) = platform::DirectoryCustody::open(extensions, id, removing)? else {
            return Ok(None);
        };
        let retained = directory.open_retained()?;
        let marker = match directory.open_marker()? {
            Some(marker) => marker,
            None => {
                let Some(retained) = retained.as_ref() else {
                    return Ok(None);
                };
                if read_marker(retained.try_clone()?, id)?.is_none() {
                    return Ok(None);
                }
                directory.restore_marker(retained)?;
                directory.open_marker()?.ok_or_else(marker_changed)?
            }
        };
        if read_marker(marker.try_clone()?, id)?.is_none() {
            return Ok(None);
        }
        if let Some(retained) = retained.as_ref() {
            if read_marker(retained.try_clone()?, id)?.is_none()
                || !platform::same_file(&marker, retained)?
            {
                return Err(marker_changed());
            }
        }
        Ok(Some(Self { directory, marker, retained }))
    }

    pub(super) fn finish_removal(mut self, target: &Path) -> io::Result<()> {
        if self.retained.is_none() {
            // A failed hard link leaves the canonical marker and its permissions intact.
            self.directory.retain_marker(&self.marker)?;
            let retained = self.directory.open_retained()?.ok_or_else(marker_changed)?;
            if !platform::same_file(&self.marker, &retained)? {
                return Err(marker_changed());
            }
            self.retained = Some(retained);
        }
        let retained = self.retained.as_ref().expect("retained marker acquired");
        // Leave the retained inode available even if unlink itself fails.
        self.directory.remove_marker(&self.marker)?;
        if let Err(primary) = self.directory.remove_target(target) {
            if let Err(recovery) = self.directory.restore_marker(retained) {
                return Err(recovery_failure(primary, recovery));
            }
            if let Err(recovery) = self.directory.remove_retained(retained) {
                return Err(recovery_failure(primary, recovery));
            }
            return Err(primary);
        }
        self.directory.remove_retained(retained)
    }
}

fn read_marker(mut file: File, id: &str) -> io::Result<Option<ManagedMarker>> {
    if !file.metadata()?.is_file() {
        return Ok(None);
    }
    file.seek(SeekFrom::Start(0))?;
    let mut contents = String::new();
    file.read_to_string(&mut contents)?;
    Ok(parse_managed_marker(&contents, id))
}

fn marker_changed() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "managed marker identity changed")
}

#[derive(Debug)]
struct MarkerRecoveryFailure {
    primary: io::Error,
    recovery: io::Error,
}

impl std::fmt::Display for MarkerRecoveryFailure {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(output, "managed plugin removal failed ({:?}); marker recovery failed ({:?})", self.primary.kind(), self.recovery.kind())
    }
}

impl std::error::Error for MarkerRecoveryFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.primary)
    }
}

fn recovery_failure(primary: io::Error, recovery: io::Error) -> io::Error {
    io::Error::new(primary.kind(), MarkerRecoveryFailure { primary, recovery })
}
