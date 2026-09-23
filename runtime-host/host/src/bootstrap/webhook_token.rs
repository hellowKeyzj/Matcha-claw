use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use organization::adapters::loopback::trigger::WebhookToken;
use zeroize::Zeroize;

use super::BootstrapError;

const TOKEN_FILE: &str = "team-webhook-token.v1";
const TEMPORARY_FILE_PREFIX: &str = ".team-webhook-token-";
const TEMPORARY_FILE_ATTEMPTS: usize = 4;

pub(super) fn load_or_create(state_dir: &Path) -> Result<WebhookToken, BootstrapError> {
    let path = state_dir.join(TOKEN_FILE);
    load_or_create_token(
        &path,
        token_length(),
        TEMPORARY_FILE_PREFIX,
        parse,
        generate_token,
    )
}

fn parse(value: &mut String) -> Result<WebhookToken, BootstrapError> {
    WebhookToken::try_new(value.as_str()).ok_or(BootstrapError)
}

fn generate_token() -> Result<GeneratedToken<WebhookToken>, BootstrapError> {
    let mut value = generate()?;
    let token = parse(&mut value)?;
    Ok(GeneratedToken::Parsed { value, token })
}

pub(super) enum GeneratedToken<T> {
    Parsed { value: String, token: T },
    Unparsed(String),
}

pub(super) fn load_or_create_token<T>(
    path: &Path,
    token_length: usize,
    temporary_file_prefix: &str,
    parse: impl Fn(&mut String) -> Result<T, BootstrapError> + Copy,
    generate: impl Fn() -> Result<GeneratedToken<T>, BootstrapError>,
) -> Result<T, BootstrapError> {
    match read_token(path, token_length, parse) {
        Ok(token) => Ok(token),
        Err(ReadError::Missing) => {
            create_token(path, token_length, temporary_file_prefix, parse, generate)
        }
        Err(ReadError::Invalid) => Err(BootstrapError),
    }
}

fn read_token<T>(
    path: &Path,
    token_length: usize,
    parse: impl Fn(&mut String) -> Result<T, BootstrapError>,
) -> Result<T, ReadError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(ReadError::Missing);
        }
        Err(_) => return Err(ReadError::Invalid),
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() != token_length as u64
    {
        return Err(ReadError::Invalid);
    }

    let mut value = match fs::read_to_string(path) {
        Ok(value) => value,
        Err(_) => return Err(ReadError::Invalid),
    };
    let token = parse(&mut value).map_err(|_| ReadError::Invalid);
    value.zeroize();
    token
}

fn create_token<T>(
    path: &Path,
    token_length: usize,
    temporary_file_prefix: &str,
    parse: impl Fn(&mut String) -> Result<T, BootstrapError> + Copy,
    generate: impl Fn() -> Result<GeneratedToken<T>, BootstrapError>,
) -> Result<T, BootstrapError> {
    for _ in 0..TEMPORARY_FILE_ATTEMPTS {
        let generated = generate()?;
        let (mut value, token) = match generated {
            GeneratedToken::Parsed { value, token } => (value, Some(token)),
            GeneratedToken::Unparsed(value) => (value, None),
        };
        let temporary = temporary_path(path, temporary_file_prefix)?;
        let result = write_new(&temporary, value.as_bytes())
            .and_then(|()| fs::hard_link(&temporary, path))
            .map_err(|error| error.kind());
        let _ = fs::remove_file(&temporary);

        match result {
            Ok(()) => {
                let token = match token {
                    Some(token) => Ok(token),
                    None => parse(&mut value),
                };
                value.zeroize();
                return token;
            }
            Err(std::io::ErrorKind::AlreadyExists) => {
                value.zeroize();
                match read_token(path, token_length, parse) {
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
    let mut entropy = [0_u8; 32];
    getrandom::fill(&mut entropy).map_err(|_| BootstrapError)?;
    let mut value = String::with_capacity(token_length());
    value.push_str("mctwh_");
    for byte in entropy {
        use std::fmt::Write as _;
        write!(&mut value, "{byte:02x}").expect("writing into a string cannot fail");
    }
    entropy.zeroize();
    Ok(value)
}

fn temporary_path(path: &Path, temporary_file_prefix: &str) -> Result<PathBuf, BootstrapError> {
    let mut entropy = [0_u8; 16];
    getrandom::fill(&mut entropy).map_err(|_| BootstrapError)?;
    let mut suffix = String::with_capacity(entropy.len() * 2);
    for byte in entropy {
        use std::fmt::Write as _;
        write!(&mut suffix, "{byte:02x}").expect("writing into a string cannot fail");
    }
    entropy.zeroize();
    Ok(path.with_file_name(format!("{temporary_file_prefix}{suffix}")))
}

fn token_length() -> usize {
    6 + 32 * 2
}

enum ReadError {
    Missing,
    Invalid,
}

#[cfg(test)]
pub(super) fn path(state_dir: &Path) -> PathBuf {
    state_dir.join(TOKEN_FILE)
}
