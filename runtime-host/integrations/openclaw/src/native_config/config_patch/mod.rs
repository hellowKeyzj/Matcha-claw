use std::{
    ffi::OsString,
    fmt,
    path::{Component, Path, PathBuf},
};

use serde::Serialize;

use platform::state_dir::CanonicalStateDir;

mod endpoint;

use endpoint::normalize_proxy_endpoint;

const ELECTRON_RUN_AS_NODE: &str = "ELECTRON_RUN_AS_NODE";
const OPENCLAW_STATE_DIR: &str = "OPENCLAW_STATE_DIR";
const OPENCLAW_CONFIG_PATH: &str = "OPENCLAW_CONFIG_PATH";
const CANONICAL_CONFIG_FILE: &str = "openclaw.json";
const CANONICAL_ENTRY_FILE: &str = "openclaw.mjs";
const MAX_NATIVE_STDIN_BYTES: usize = 1_048_576;

#[derive(Clone, Eq, PartialEq)]
pub struct TelegramDefaultAccountProxyPatch(Vec<u8>);

impl TelegramDefaultAccountProxyPatch {
    pub fn try_new(proxy: &str) -> Result<Self, TelegramDefaultAccountProxyError> {
        let proxy = normalize_proxy_endpoint(proxy)?;
        let document = TelegramProxyDocument {
            channels: Channels {
                telegram: Telegram {
                    default_account: "default",
                    accounts: TelegramAccounts {
                        default_account: TelegramAccount { proxy: &proxy },
                    },
                },
            },
        };
        let bytes = serde_json::to_vec(&document)
            .map_err(|_| TelegramDefaultAccountProxyError::InvalidProxyEndpoint)?;
        if bytes.len() > MAX_NATIVE_STDIN_BYTES {
            return Err(TelegramDefaultAccountProxyError::PatchTooLarge);
        }
        Ok(Self(bytes))
    }
}

impl fmt::Debug for TelegramDefaultAccountProxyPatch {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str("TelegramDefaultAccountProxyPatch([REDACTED])")
    }
}

#[derive(Serialize)]
struct TelegramProxyDocument<'a> {
    channels: Channels<'a>,
}

#[derive(Serialize)]
struct Channels<'a> {
    telegram: Telegram<'a>,
}

#[derive(Serialize)]
struct Telegram<'a> {
    #[serde(rename = "defaultAccount")]
    default_account: &'static str,
    accounts: TelegramAccounts<'a>,
}

#[derive(Serialize)]
struct TelegramAccounts<'a> {
    #[serde(rename = "default")]
    default_account: TelegramAccount<'a>,
}

#[derive(Serialize)]
struct TelegramAccount<'a> {
    proxy: &'a str,
}

#[derive(Clone, Eq, PartialEq)]
pub struct TelegramDefaultAccountProxyInput {
    electron_image: PathBuf,
    openclaw_dir: PathBuf,
    entry: PathBuf,
    state_dir: CanonicalStateDir,
    patch: TelegramDefaultAccountProxyPatch,
}

impl TelegramDefaultAccountProxyInput {
    pub fn try_into_spec(
        self,
    ) -> Result<TelegramDefaultAccountProxySpec, TelegramDefaultAccountProxyError> {
        validate_input(&self)?;
        self.state_dir
            .open()
            .map_err(|_| TelegramDefaultAccountProxyError::InvalidInput)?;
        let config_path = self.state_dir.as_path().join(CANONICAL_CONFIG_FILE);
        let spec = TelegramDefaultAccountProxySpec {
            executable: self.electron_image,
            working_directory: self.openclaw_dir,
            arguments: [
                self.entry.into_os_string(),
                "config".into(),
                "patch".into(),
                "--stdin".into(),
            ],
            environment: [
                (ELECTRON_RUN_AS_NODE.into(), "1".into()),
                (
                    OPENCLAW_STATE_DIR.into(),
                    self.state_dir.as_path().as_os_str().to_owned(),
                ),
                (OPENCLAW_CONFIG_PATH.into(), config_path.into_os_string()),
            ],
            state_dir: self.state_dir,
            stdin: self.patch,
        };
        spec.validate()?;
        Ok(spec)
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct TelegramDefaultAccountProxySpec {
    executable: PathBuf,
    working_directory: PathBuf,
    arguments: [OsString; 4],
    environment: [(OsString, OsString); 3],
    state_dir: CanonicalStateDir,
    stdin: TelegramDefaultAccountProxyPatch,
}

impl TelegramDefaultAccountProxySpec {
    fn validate(&self) -> Result<(), TelegramDefaultAccountProxyError> {
        if !valid_absolute_path(&self.executable)
            || !valid_absolute_path(&self.working_directory)
            || !valid_absolute_path(Path::new(&self.arguments[0]))
            || self.arguments[1..]
                != [
                    OsString::from("config"),
                    OsString::from("patch"),
                    OsString::from("--stdin"),
                ]
            || self.environment[0] != (ELECTRON_RUN_AS_NODE.into(), "1".into())
            || self.environment[1]
                != (
                    OPENCLAW_STATE_DIR.into(),
                    self.state_dir.as_path().as_os_str().to_owned(),
                )
            || self.environment[2]
                != (
                    OPENCLAW_CONFIG_PATH.into(),
                    self.state_dir
                        .as_path()
                        .join(CANONICAL_CONFIG_FILE)
                        .into_os_string(),
                )
            || self.stdin.0.is_empty()
            || self.stdin.0.len() > MAX_NATIVE_STDIN_BYTES
        {
            return Err(TelegramDefaultAccountProxyError::InvalidInput);
        }
        Ok(())
    }
}

impl fmt::Debug for TelegramDefaultAccountProxySpec {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str("TelegramDefaultAccountProxySpec([REDACTED])")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TelegramDefaultAccountProxyError {
    InvalidInput,
    InvalidProxyEndpoint,
    PatchTooLarge,
}

impl fmt::Display for TelegramDefaultAccountProxyError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInput => output.write_str("OpenClaw Telegram proxy input is invalid"),
            Self::InvalidProxyEndpoint => {
                output.write_str("OpenClaw Telegram proxy endpoint is invalid")
            }
            Self::PatchTooLarge => output.write_str("OpenClaw Telegram proxy patch is too large"),
        }
    }
}

impl std::error::Error for TelegramDefaultAccountProxyError {}

fn validate_input(
    input: &TelegramDefaultAccountProxyInput,
) -> Result<(), TelegramDefaultAccountProxyError> {
    let config_path = input.state_dir.as_path().join(CANONICAL_CONFIG_FILE);
    if !valid_absolute_path(&input.electron_image)
        || !valid_absolute_path(&input.openclaw_dir)
        || input.entry != input.openclaw_dir.join(CANONICAL_ENTRY_FILE)
        || !valid_absolute_path(&input.entry)
        || !valid_absolute_path(&config_path)
    {
        return Err(TelegramDefaultAccountProxyError::InvalidInput);
    }
    Ok(())
}

fn valid_absolute_path(path: &Path) -> bool {
    path.is_absolute()
        && path
            .components()
            .all(|component| !matches!(component, Component::CurDir | Component::ParentDir))
        && no_curdir_component(path)
}

#[cfg(unix)]
fn no_curdir_component(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;

    path.as_os_str()
        .as_bytes()
        .split(|byte| *byte == b'/')
        .all(|component| component != b".")
}

#[cfg(windows)]
fn no_curdir_component(path: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;

    let units = path.as_os_str().encode_wide().collect::<Vec<_>>();
    units
        .split(|unit| *unit == u16::from(b'/') || *unit == u16::from(b'\\'))
        .all(|component| component != [u16::from(b'.')])
}

#[cfg(test)]
mod tests;
