use std::{fmt, net::SocketAddr, sync::Arc};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use serde_json::json;
use zeroize::Zeroizing;

use crate::client::{Client, Delivery};

// Host-private credentials: no Debug/Serialize and no runtime/config projection.
#[derive(Clone)]
pub struct ReaderSource {
    endpoint: String,
    token: Arc<Zeroizing<String>>,
}

impl ReaderSource {
    pub fn new(endpoint: String, token: String) -> Result<Self, ProjectionError> {
        let token = Zeroizing::new(token);
        let valid_endpoint = endpoint
            .strip_prefix("http://")
            .and_then(|authority| authority.parse::<SocketAddr>().ok())
            .is_some_and(|address| {
                address.ip().is_loopback()
                    && address.port() != 0
                    && endpoint == format!("http://{address}")
            });
        if !valid_endpoint
            || token.len() != 43
            || !URL_SAFE_NO_PAD
                .decode(token.as_bytes())
                .is_ok_and(|bytes| bytes.len() == 32)
        {
            return Err(ProjectionError::new(
                ProjectionErrorKind::InvalidSource,
                Delivery::NotSent,
            ));
        }
        Ok(Self {
            endpoint,
            token: Arc::new(token),
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize)]
pub enum Application {
    #[serde(rename = "futureCliInstances")]
    FutureCliInstances,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectionReceipt {
    pub projected: bool,
    pub application: Application,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RemoteKind {
    Rejected,
    Conflict,
    Unavailable,
    Unauthorized,
    CommitUnknown,
    Other,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProjectionErrorKind {
    InvalidSource,
    SourceUnavailable,
    NotSent,
    Unknown,
    Remote { code: i64, kind: RemoteKind },
    InvalidReadback,
}

pub struct ProjectionError {
    kind: ProjectionErrorKind,
    delivery: Delivery,
    source: Option<Box<dyn std::error::Error + Send + Sync>>,
}

impl ProjectionError {
    pub fn missing_source() -> Self {
        Self::new(ProjectionErrorKind::SourceUnavailable, Delivery::NotSent)
    }

    pub fn kind(&self) -> ProjectionErrorKind {
        self.kind
    }
    pub fn delivery(&self) -> Delivery {
        self.delivery
    }

    fn new(kind: ProjectionErrorKind, delivery: Delivery) -> Self {
        Self {
            kind,
            delivery,
            source: None,
        }
    }

    fn caused(
        kind: ProjectionErrorKind,
        delivery: Delivery,
        source: impl std::error::Error + Send + Sync + 'static,
    ) -> Self {
        Self {
            kind,
            delivery,
            source: Some(Box::new(source)),
        }
    }
}

impl fmt::Debug for ProjectionError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output
            .debug_struct("SealedProjectionError")
            .field("kind", &self.kind)
            .field("delivery", &self.delivery)
            .field("has_private_source", &self.source.is_some())
            .finish()
    }
}

impl fmt::Display for ProjectionError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(match self.kind {
            ProjectionErrorKind::InvalidSource => "The private sealed reader source is invalid",
            ProjectionErrorKind::SourceUnavailable => {
                "The private sealed reader source is unavailable"
            }
            ProjectionErrorKind::NotSent => "The sealed reader projection was not sent",
            ProjectionErrorKind::Unknown => "The sealed reader projection delivery is unknown",
            ProjectionErrorKind::Remote { .. } => {
                "The native server rejected the sealed reader projection"
            }
            ProjectionErrorKind::InvalidReadback => {
                "The sealed reader projection receipt is invalid"
            }
        })
    }
}

impl std::error::Error for ProjectionError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source
            .as_deref()
            .map(|source| source as &(dyn std::error::Error + 'static))
    }
}

pub async fn project(
    client: &Client,
    reader: &ReaderSource,
) -> Result<ProjectionReceipt, ProjectionError> {
    let value = client
        .call(
            "sealedSkills.project",
            json!({
                "reader": {"endpoint":reader.endpoint,"token":reader.token.as_str()},
            }),
        )
        .await
        .map_err(transport)?;
    let receipt: ProjectionReceipt = serde_json::from_value(value).map_err(|source| {
        ProjectionError::caused(
            ProjectionErrorKind::InvalidReadback,
            Delivery::ResponseReceived,
            source,
        )
    })?;
    if !receipt.projected {
        return Err(ProjectionError::new(
            ProjectionErrorKind::InvalidReadback,
            Delivery::ResponseReceived,
        ));
    }
    Ok(receipt)
}

fn transport(error: crate::client::Error) -> ProjectionError {
    let delivery = error.delivery();
    let kind = match delivery {
        Delivery::NotSent => ProjectionErrorKind::NotSent,
        Delivery::Unknown => ProjectionErrorKind::Unknown,
        Delivery::ResponseReceived => match error.code() {
            Some(code) => ProjectionErrorKind::Remote {
                code,
                kind: match code {
                    -32602 | -32001 => RemoteKind::Rejected,
                    -32002 => RemoteKind::Conflict,
                    -32003 | -32004 | -32005 | -32603 => RemoteKind::Unavailable,
                    -32007 => RemoteKind::Unauthorized,
                    -32006 => RemoteKind::CommitUnknown,
                    _ => RemoteKind::Other,
                },
            },
            None => ProjectionErrorKind::InvalidReadback,
        },
    };
    ProjectionError::caused(kind, delivery, error)
}
