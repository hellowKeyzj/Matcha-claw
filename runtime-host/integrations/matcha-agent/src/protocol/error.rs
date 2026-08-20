use std::fmt;

use super::wire::JsonRpcId;

#[derive(Clone, Eq, PartialEq)]
pub enum DecodeError {
    Parse,
    InvalidRequest {
        id: Option<JsonRpcId>,
        reason: &'static str,
    },
}

impl fmt::Debug for DecodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Parse => formatter.write_str("DecodeError::Parse"),
            Self::InvalidRequest { .. } => formatter.write_str("DecodeError::InvalidRequest"),
        }
    }
}

impl DecodeError {
    pub(super) const fn invalid(id: Option<JsonRpcId>, reason: &'static str) -> Self {
        Self::InvalidRequest { id, reason }
    }
}

impl fmt::Display for DecodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Parse => formatter.write_str("invalid JSON-RPC JSON"),
            Self::InvalidRequest { reason, .. } => formatter.write_str(reason),
        }
    }
}

impl std::error::Error for DecodeError {}
