use std::fmt;

#[derive(Debug)]
pub enum LlmClientError {
    UnsupportedProtocol,
    Http(reqwest::Error),
    Protocol(String),
    StreamSink(String),
}

impl fmt::Display for LlmClientError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedProtocol => {
                formatter.write_str("provider LLM protocol is not supported")
            }
            Self::Http(error) => write!(formatter, "provider LLM HTTP request failed: {error}"),
            Self::Protocol(message) => write!(formatter, "provider LLM protocol error: {message}"),
            Self::StreamSink(message) => {
                write!(formatter, "provider LLM stream sink error: {message}")
            }
        }
    }
}

impl std::error::Error for LlmClientError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Http(error) => Some(error),
            Self::UnsupportedProtocol | Self::Protocol(_) | Self::StreamSink(_) => None,
        }
    }
}

impl From<reqwest::Error> for LlmClientError {
    fn from(error: reqwest::Error) -> Self {
        Self::Http(error)
    }
}
