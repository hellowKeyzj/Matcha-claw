use std::fmt;

use crate::{authorization::AuthError, store::StoreError};
use world_protocol::definitions::DefinitionFailure;

#[derive(Debug)]
pub(crate) enum DefinitionError {
    Rejected(DefinitionFailure),
    Compile(world_protocol::compiler::CompileFailure),
    Store(StoreError),
    Codec(serde_json::Error),
}

impl From<DefinitionFailure> for DefinitionError {
    fn from(failure: DefinitionFailure) -> Self {
        Self::Rejected(failure)
    }
}
impl From<world_protocol::compiler::CompileFailure> for DefinitionError {
    fn from(failure: world_protocol::compiler::CompileFailure) -> Self {
        Self::Compile(failure)
    }
}
impl From<StoreError> for DefinitionError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}
impl From<AuthError> for DefinitionError {
    fn from(error: AuthError) -> Self {
        match error {
            AuthError::Denied(failure) => {
                Self::Rejected(DefinitionFailure::Authorization { failure })
            }
            AuthError::Store(error) => Self::Store(error),
            AuthError::Codec(error) => Self::Codec(error),
        }
    }
}
impl fmt::Display for DefinitionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Rejected(_) => formatter.write_str("world.definition_rejected"),
            Self::Compile(_) => formatter.write_str("world.definition_compile_rejected"),
            Self::Store(error) => error.fmt(formatter),
            Self::Codec(_) => formatter.write_str("world.definition_codec_fault"),
        }
    }
}
impl std::error::Error for DefinitionError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Store(error) => Some(error),
            Self::Codec(error) => Some(error),
            _ => None,
        }
    }
}
