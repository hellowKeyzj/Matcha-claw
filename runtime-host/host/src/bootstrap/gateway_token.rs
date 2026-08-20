use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use openclaw::{gateway::auth::GatewaySecret, lifecycle::state_dir::CanonicalStateDir};
use zeroize::Zeroize;

use super::BootstrapError;

const TOKEN_FILE: &str = "gateway-token.v1";
const TEMPORARY_FILE_PREFIX: &str = ".gateway-token-";
const TEMPORARY_FILE_ATTEMPTS: usize = 4;
const TOKEN_LENGTH: usize = 64;

pub(super) fn load_or_create(
    state_dir: &CanonicalStateDir,
) -> Result<GatewaySecret, BootstrapError> {
    let path = state_dir.as_path().join(TOKEN_FILE);
    match read(&path) {
        Ok(token) => Ok(token),
        Err(ReadError::Missing) => create(&path),
        Err(ReadError::Invalid) => Err(BootstrapError),
    }
}

fn read(path: &Path) -> Result<GatewaySecret, ReadError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(ReadError::Missing);
        }
        Err(_) => return Err(ReadError::Invalid),
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() != TOKEN_LENGTH as u64
    {
        return Err(ReadError::Invalid);
    }

    let mut value = match fs::read_to_string(path) {
        Ok(value) => value,
        Err(_) => return Err(ReadError::Invalid),
    };
    let token = GatewaySecret::new(std::mem::take(&mut value)).map_err(|_| ReadError::Invalid);
    value.zeroize();
    token
}

fn create(path: &Path) -> Result<GatewaySecret, BootstrapError> {
    for _ in 0..TEMPORARY_FILE_ATTEMPTS {
        let mut value = generate()?;
        let temporary = temporary_path(path)?;
        let result = write_new(&temporary, value.as_bytes())
            .and_then(|()| fs::hard_link(&temporary, path))
            .map_err(|error| error.kind());
        let _ = fs::remove_file(&temporary);

        match result {
            Ok(()) => {
                let token =
                    GatewaySecret::new(std::mem::take(&mut value)).map_err(|_| BootstrapError)?;
                value.zeroize();
                return Ok(token);
            }
            Err(std::io::ErrorKind::AlreadyExists) => {
                value.zeroize();
                match read(path) {
                    Ok(token) => return Ok(token),
                    Err(ReadError::Missing) => continue,
                    Err(ReadError::Invalid) => return Err(BootstrapError),
                }
            }
            Err(_) => {
                value.zeroize();
                return Err(BootstrapError);
            }
        }
    }
    Err(BootstrapError)
}

fn write_new(path: &Path, value: &[u8]) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(value)?;
    file.sync_all()
}

fn generate() -> Result<String, BootstrapError> {
    let mut entropy = [0_u8; 48];
    getrandom::fill(&mut entropy).map_err(|_| BootstrapError)?;
    let value = URL_SAFE_NO_PAD.encode(entropy);
    entropy.zeroize();
    (value.len() == TOKEN_LENGTH)
        .then_some(value)
        .ok_or(BootstrapError)
}

fn temporary_path(path: &Path) -> Result<PathBuf, BootstrapError> {
    let mut entropy = [0_u8; 16];
    getrandom::fill(&mut entropy).map_err(|_| BootstrapError)?;
    let mut suffix = String::with_capacity(entropy.len() * 2);
    for byte in entropy {
        use std::fmt::Write as _;
        write!(&mut suffix, "{byte:02x}").expect("writing into a string cannot fail");
    }
    entropy.zeroize();
    Ok(path.with_file_name(format!("{TEMPORARY_FILE_PREFIX}{suffix}")))
}

enum ReadError {
    Missing,
    Invalid,
}

#[cfg(test)]
pub(super) fn path(state_dir: &CanonicalStateDir) -> PathBuf {
    state_dir.as_path().join(TOKEN_FILE)
}
