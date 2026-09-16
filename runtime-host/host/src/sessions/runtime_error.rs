use std::fmt;

use crate::composition::RequestAdmissionClosed;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeSessionError<E> {
    AdmissionClosed(RequestAdmissionClosed),
    RuntimeUnavailable,
    Client(E),
}

impl<E: fmt::Display> fmt::Display for RuntimeSessionError<E> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AdmissionClosed(error) => error.fmt(formatter),
            Self::RuntimeUnavailable => formatter.write_str("runtime session is unavailable"),
            Self::Client(error) => error.fmt(formatter),
        }
    }
}

impl<E: std::error::Error + 'static> std::error::Error for RuntimeSessionError<E> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::AdmissionClosed(error) => Some(error),
            Self::RuntimeUnavailable => None,
            Self::Client(error) => Some(error),
        }
    }
}
