use std::{fmt, str::FromStr};

pub const FLEET_SECRET_REF_SCHEME: &str = "remote-fleet://";

const MAX_SECRET_PATH_LENGTH: usize = 256;

#[derive(Clone, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct FleetSecretRef(String);

impl FleetSecretRef {
    pub fn parse(value: &str) -> Result<Self, FleetSecretRefError> {
        let value = value.trim();
        if !value.contains("://") {
            return Err(FleetSecretRefError::MissingNamespace);
        }
        let Some(path) = value.strip_prefix(FLEET_SECRET_REF_SCHEME) else {
            return Err(FleetSecretRefError::UnsupportedNamespace);
        };
        if !is_valid_secret_path(path) {
            return Err(FleetSecretRefError::InvalidPath);
        }

        Ok(Self(format!("{FLEET_SECRET_REF_SCHEME}{path}")))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_serialized(self) -> String {
        self.0
    }

    pub(crate) fn from_serialized(value: String) -> Result<Self, FleetSecretRefError> {
        Self::parse(&value)
    }
}

impl fmt::Debug for FleetSecretRef {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("FleetSecretRef(<private>)")
    }
}

impl fmt::Display for FleetSecretRef {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("remote-fleet://<private>")
    }
}

impl FromStr for FleetSecretRef {
    type Err = FleetSecretRefError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
    }
}

impl TryFrom<&str> for FleetSecretRef {
    type Error = FleetSecretRefError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        Self::parse(value)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FleetSecretRefError {
    MissingNamespace,
    UnsupportedNamespace,
    InvalidPath,
}

impl fmt::Display for FleetSecretRefError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingNamespace => {
                formatter.write_str("Fleet secret reference is missing a namespace")
            }
            Self::UnsupportedNamespace => {
                formatter.write_str("Fleet secret reference namespace is unsupported")
            }
            Self::InvalidPath => formatter.write_str("Fleet secret reference path is invalid"),
        }
    }
}

impl std::error::Error for FleetSecretRefError {}

fn is_valid_secret_path(path: &str) -> bool {
    if path.is_empty()
        || path.len() > MAX_SECRET_PATH_LENGTH
        || path.contains("..")
        || path.contains("//")
    {
        return false;
    }

    path.split('/').all(is_valid_path_segment)
}

fn is_valid_path_segment(segment: &str) -> bool {
    let bytes = segment.as_bytes();
    let Some((first, rest)) = bytes.split_first() else {
        return false;
    };

    first.is_ascii_alphanumeric()
        && rest.len() <= 63
        && rest
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

#[cfg(test)]
mod tests;
