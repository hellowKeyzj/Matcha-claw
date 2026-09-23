use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::native_config;
use platform::state_dir::CanonicalStateDir;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    Default,
    FullAccess,
}

impl Mode {
    pub fn read(state_dir: CanonicalStateDir) -> Result<Self, Error> {
        native_config::tool_permission::Mode::read(state_dir)
            .map(Self::from)
            .map_err(Error::from)
    }

    pub fn apply(self, state_dir: CanonicalStateDir) -> Result<Effect, Error> {
        native_config::tool_permission::Mode::from(self)
            .apply(state_dir)
            .map(Effect::from)
            .map_err(Error::from)
    }

    pub const fn as_public_token(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::FullAccess => "fullAccess",
        }
    }

    pub const fn as_str(self) -> &'static str {
        self.as_public_token()
    }

    fn from_public_token(token: &str) -> Option<Self> {
        match token {
            "default" => Some(Self::Default),
            "fullAccess" => Some(Self::FullAccess),
            _ => None,
        }
    }
}

pub fn read_mode_token(state_dir: CanonicalStateDir) -> Result<&'static str, Error> {
    Mode::read(state_dir).map(Mode::as_public_token)
}

pub fn set_mode_from_token(state_dir: CanonicalStateDir, token: &str) -> Result<bool, Error> {
    let mode = Mode::from_public_token(token).ok_or(Error::Unknown)?;
    mode.apply(state_dir)
        .map(|effect| matches!(effect, Effect::Written))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Effect {
    Unchanged,
    Written,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetModeRequest {
    mode: Mode,
}

impl SetModeRequest {
    pub fn mode(self) -> Mode {
        self.mode
    }
}

pub fn decode_set_mode_request(input: Value) -> Result<SetModeRequest, InvalidRequest> {
    serde_json::from_value(input).map_err(|_| InvalidRequest)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidRequest;

pub fn project_mode(mode: Mode) -> Value {
    json!({ "result": { "mode": mode.as_public_token() } })
}

pub fn project_set_mode(mode: Mode, effect: Effect) -> Value {
    json!({
        "result": {
            "mode": mode.as_public_token(),
            "changed": matches!(effect, Effect::Written),
        }
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Unavailable,
    Unknown,
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Unavailable => "OpenClaw tool permission mode is unavailable",
            Self::Unknown => "OpenClaw tool permission mode outcome is unknown",
        })
    }
}

impl std::error::Error for Error {}

impl From<native_config::tool_permission::Mode> for Mode {
    fn from(mode: native_config::tool_permission::Mode) -> Self {
        match mode {
            native_config::tool_permission::Mode::Default => Self::Default,
            native_config::tool_permission::Mode::FullAccess => Self::FullAccess,
        }
    }
}

impl From<Mode> for native_config::tool_permission::Mode {
    fn from(mode: Mode) -> Self {
        match mode {
            Mode::Default => Self::Default,
            Mode::FullAccess => Self::FullAccess,
        }
    }
}

impl From<native_config::tool_permission::Effect> for Effect {
    fn from(effect: native_config::tool_permission::Effect) -> Self {
        match effect {
            native_config::tool_permission::Effect::Unchanged => Self::Unchanged,
            native_config::tool_permission::Effect::Written => Self::Written,
        }
    }
}

impl From<native_config::tool_permission::Error> for Error {
    fn from(error: native_config::tool_permission::Error) -> Self {
        match error {
            native_config::tool_permission::Error::Unavailable => Self::Unavailable,
            native_config::tool_permission::Error::Unknown => Self::Unknown,
        }
    }
}
