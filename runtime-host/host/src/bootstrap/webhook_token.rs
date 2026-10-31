use std::{io::Read, path::Path};

#[cfg(test)]
use std::path::PathBuf;

use organization::WebhookToken;
use platform::state_dir::{CanonicalStateDir, StateDirHandle};
use zeroize::Zeroizing;

use super::BootstrapError;

const TOKEN_FILE: &str = "team-webhook-token.v1";
const CREATE_ATTEMPTS: usize = 4;

pub(super) fn load_or_create(state_dir: &Path) -> Result<WebhookToken, BootstrapError> {
    let state_dir = CanonicalStateDir::open_existing(state_dir)
        .and_then(|directory| directory.open())
        .map_err(|_| BootstrapError)?;
    load_or_create_token(
        &state_dir,
        TOKEN_FILE,
        token_length(),
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
    Parsed { value: Zeroizing<String>, token: T },
    Unparsed(Zeroizing<String>),
}

pub(super) fn load_or_create_token<T>(
    state_dir: &StateDirHandle,
    name: &str,
    token_length: usize,
    parse: impl Fn(&mut String) -> Result<T, BootstrapError> + Copy,
    generate: impl Fn() -> Result<GeneratedToken<T>, BootstrapError>,
) -> Result<T, BootstrapError> {
    match read_token(state_dir, name, token_length, parse) {
        Ok(token) => Ok(token),
        Err(ReadError::Missing) => create_token(state_dir, name, token_length, parse, generate),
        Err(ReadError::Invalid) => Err(BootstrapError),
    }
}

fn read_token<T>(
    state_dir: &StateDirHandle,
    name: &str,
    token_length: usize,
    parse: impl Fn(&mut String) -> Result<T, BootstrapError>,
) -> Result<T, ReadError> {
    let mut file = state_dir
        .open_private_regular_file_readonly(name)
        .map_err(|_| ReadError::Invalid)?
        .ok_or(ReadError::Missing)?;
    if file.metadata().map_err(|_| ReadError::Invalid)?.len() != token_length as u64 {
        return Err(ReadError::Invalid);
    }

    let mut bytes = Zeroizing::new(vec![0_u8; token_length + 1]);
    file.read_exact(&mut bytes[..token_length])
        .map_err(|_| ReadError::Invalid)?;
    if file
        .read(&mut bytes[token_length..])
        .map_err(|_| ReadError::Invalid)?
        != 0
    {
        return Err(ReadError::Invalid);
    }
    let value = std::str::from_utf8(&bytes[..token_length]).map_err(|_| ReadError::Invalid)?;
    let mut value = Zeroizing::new(value.to_owned());
    parse(&mut value).map_err(|_| ReadError::Invalid)
}

fn create_token<T>(
    state_dir: &StateDirHandle,
    name: &str,
    token_length: usize,
    parse: impl Fn(&mut String) -> Result<T, BootstrapError> + Copy,
    generate: impl Fn() -> Result<GeneratedToken<T>, BootstrapError>,
) -> Result<T, BootstrapError> {
    for _ in 0..CREATE_ATTEMPTS {
        let generated = generate()?;
        let (mut value, token) = match generated {
            GeneratedToken::Parsed { value, token } => (value, Some(token)),
            GeneratedToken::Unparsed(value) => (value, None),
        };
        if state_dir
            .create_new_regular_file_bounded(name, value.as_bytes(), token_length)
            .map_err(|_| BootstrapError)?
        {
            return match token {
                Some(token) => Ok(token),
                None => parse(&mut value),
            };
        }
        drop(value);
        drop(token);
        match read_token(state_dir, name, token_length, parse) {
            Ok(token) => return Ok(token),
            Err(ReadError::Missing) => continue,
            Err(ReadError::Invalid) => return Err(BootstrapError),
        }
    }
    Err(BootstrapError)
}

fn generate() -> Result<Zeroizing<String>, BootstrapError> {
    let mut entropy = Zeroizing::new([0_u8; 32]);
    getrandom::fill(&mut *entropy).map_err(|_| BootstrapError)?;
    let mut value = Zeroizing::new(String::with_capacity(token_length()));
    value.push_str("mctwh_");
    for byte in entropy.iter() {
        use std::fmt::Write as _;
        write!(&mut *value, "{byte:02x}").expect("writing into a string cannot fail");
    }
    Ok(value)
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
