use std::{io, time::Duration};

use bytes::BytesMut;
use foundation::execution::OwnedTask;
use pg_wired::{
    PgWireError, TlsConfig, TlsMode, WireConn,
    protocol::{
        frontend::encode_message,
        types::{BackendMsg, FrontendMsg},
    },
};
use serde::{Deserialize, Deserializer, Serialize};
use tokio::time::Instant;
use tokio_postgres::config::SslMode;
use tokio_util::sync::CancellationToken;
use world::{
    PgReplicationConnection, PgSourceConnection, SourceAccess, SourceCredential, SourceError,
    SourceFuture,
};
use world_protocol::{
    failure::FailureStage,
    ids::{ConnectionId, Revision, WorldRef},
    sources::{PostgresConnectionConfig, PostgresTls, SourceCredentialReason, SourceFailure},
};
use zeroize::Zeroizing;

const RESPONSE_LIMIT: usize = 64 * 1024;

/// Private Main resolver configuration, never serialized or included in Host diagnostics.
pub struct WorldSourceAccessConfig {
    endpoint: String,
    authorization: Zeroizing<String>,
}

impl WorldSourceAccessConfig {
    pub fn new(endpoint: String, authorization: String) -> Self {
        Self {
            endpoint,
            authorization: Zeroizing::new(authorization),
        }
    }
}

pub(crate) struct HostSourceAccess {
    resolver: Option<WorldSourceAccessConfig>,
    client: reqwest::Client,
}

impl HostSourceAccess {
    pub(crate) fn new(resolver: Option<WorldSourceAccessConfig>) -> Result<Self, SourceError> {
        if let Some(config) = &resolver {
            let port = config
                .endpoint
                .strip_prefix("http://127.0.0.1:")
                .and_then(|value| value.strip_suffix("/resolve"))
                .and_then(|value| value.parse::<u16>().ok())
                .filter(|port| *port > 0);
            if port.is_none_or(|port| config.endpoint != format!("http://127.0.0.1:{port}/resolve"))
                || config.authorization.len() != 43
                || !config
                    .authorization
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            {
                return Err(failure(
                    SourceFailure::Credential {
                        reason: SourceCredentialReason::ResolverUnavailable,
                    },
                    "source-resolver-configuration-invalid",
                ));
            }
        }
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(2))
            .build()
            .map_err(|cause| {
                SourceError::caused_by(
                    SourceFailure::Credential {
                        reason: SourceCredentialReason::ResolverUnavailable,
                    },
                    FailureStage::Prepare,
                    cause,
                )
            })?;
        Ok(Self { resolver, client })
    }

    async fn resolve(
        &self,
        world: &WorldRef,
        connection: &ConnectionId,
        revision: Revision,
    ) -> Result<SourceCredential, SourceError> {
        let config = self.resolver.as_ref().ok_or_else(|| {
            failure(
                SourceFailure::Credential {
                    reason: SourceCredentialReason::ResolverUnavailable,
                },
                "source-resolver-not-configured",
            )
        })?;
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Request<'a> {
            operation: &'static str,
            world: &'a WorldRef,
            connection_id: &'a ConnectionId,
            revision: Revision,
        }
        let mut authorization =
            reqwest::header::HeaderValue::from_str(&format!("Bearer {}", &*config.authorization))
                .map_err(|cause| {
                SourceError::caused_by(
                    SourceFailure::Credential {
                        reason: SourceCredentialReason::ResolverUnavailable,
                    },
                    FailureStage::Prepare,
                    cause,
                )
            })?;
        authorization.set_sensitive(true);
        let body = serde_json::to_vec(&Request {
            operation: "source.resolve",
            world,
            connection_id: connection,
            revision,
        })
        .map_err(|cause| {
            SourceError::caused_by(SourceFailure::InternalFault, FailureStage::Prepare, cause)
        })?;
        let mut response = self
            .client
            .post(&config.endpoint)
            .header(reqwest::header::AUTHORIZATION, authorization)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await
            .map_err(|cause| {
                SourceError::caused_by(
                    SourceFailure::Credential {
                        reason: SourceCredentialReason::ResolverUnavailable,
                    },
                    FailureStage::Prepare,
                    cause,
                )
            })?;
        let status = response.status();
        if response
            .content_length()
            .is_some_and(|length| length > RESPONSE_LIMIT as u64)
        {
            return Err(failure(
                SourceFailure::Credential {
                    reason: SourceCredentialReason::ResolverUnavailable,
                },
                "source-resolver-response-limit",
            ));
        }
        let mut bytes = Zeroizing::new(Vec::new());
        while let Some(chunk) = response.chunk().await.map_err(|cause| {
            SourceError::caused_by(
                SourceFailure::Credential {
                    reason: SourceCredentialReason::ResolverUnavailable,
                },
                FailureStage::Read,
                cause,
            )
        })? {
            if chunk.len() > RESPONSE_LIMIT.saturating_sub(bytes.len()) {
                return Err(failure(
                    SourceFailure::Credential {
                        reason: SourceCredentialReason::ResolverUnavailable,
                    },
                    "source-resolver-response-limit",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        if status == reqwest::StatusCode::OK {
            let credential: CredentialResponse =
                serde_json::from_slice(&bytes).map_err(|cause| {
                    SourceError::caused_by(
                        SourceFailure::Credential {
                            reason: SourceCredentialReason::ResolverUnavailable,
                        },
                        FailureStage::Decode,
                        cause,
                    )
                })?;
            return credential.into_credential();
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Rejected {
            error: String,
        }
        let rejected: Rejected = serde_json::from_slice(&bytes).map_err(|cause| {
            SourceError::caused_by(
                SourceFailure::Credential {
                    reason: SourceCredentialReason::ResolverUnavailable,
                },
                FailureStage::Decode,
                cause,
            )
        })?;
        let (reason, code) = match (status.as_u16(), rejected.error.as_str()) {
            (404, "credential-missing") => {
                (SourceCredentialReason::Missing, "source-credential-missing")
            }
            (503, "credential-decrypt-failed") => (
                SourceCredentialReason::DecryptFailed,
                "source-credential-decrypt-failed",
            ),
            (503, "credential-invalid") => {
                (SourceCredentialReason::Invalid, "source-credential-invalid")
            }
            (503, "credential-store-unavailable") => (
                SourceCredentialReason::StoreUnavailable,
                "source-credential-store-unavailable",
            ),
            (503, "auth-profile-write-failed") => (
                SourceCredentialReason::ResolverUnavailable,
                "source-resolver-unavailable",
            ),
            (400, "invalid-request") => (
                SourceCredentialReason::Invalid,
                "source-resolver-invalid-request",
            ),
            _ => {
                return Err(failure(
                    SourceFailure::ProtocolViolation,
                    "source-resolver-response-invalid",
                ));
            }
        };
        Err(failure(SourceFailure::Credential { reason }, code))
    }
}

impl SourceAccess for HostSourceAccess {
    fn credentials<'a>(
        &'a self,
        world: &'a WorldRef,
        connection: &'a ConnectionId,
        revision: Revision,
        cancel: CancellationToken,
        deadline: Instant,
    ) -> SourceFuture<'a, SourceCredential> {
        Box::pin(async move {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => Err(failure(SourceFailure::Cancelled, "source-credential-cancelled")),
                _ = tokio::time::sleep_until(deadline) => Err(failure(SourceFailure::ReadTimeout, "source-credential-deadline")),
                result = self.resolve(world, connection, revision) => result,
            }
        })
    }

    fn connect_postgres<'a>(
        &'a self,
        input: &'a PostgresConnectionConfig,
        credential: SourceCredential,
        cancel: CancellationToken,
        deadline: Instant,
    ) -> SourceFuture<'a, PgSourceConnection> {
        Box::pin(async move {
            let SourceCredential::Postgres { user, password } = credential else {
                return Err(failure(
                    SourceFailure::Authentication,
                    "source-postgres-credential-kind",
                ));
            };
            let mut config = tokio_postgres::Config::new();
            config
                .host(&input.host)
                .port(input.port)
                .dbname(&input.database)
                .user(user.as_str())
                .password(password.as_bytes())
                .connect_timeout(
                    deadline
                        .saturating_duration_since(Instant::now())
                        .min(Duration::from_secs(5)),
                );
            let connect = async {
                match input.tls {
                    PostgresTls::Required => {
                        config.ssl_mode(SslMode::Require);
                        let tls = super::postgres::verified_tls().map_err(|cause| {
                            SourceError::caused_by(
                                SourceFailure::Connection,
                                FailureStage::Prepare,
                                cause,
                            )
                        })?;
                        let (client, connection) =
                            config.connect(tls).await.map_err(database_error)?;
                        let (driver, _) = OwnedTask::spawn(move |cancel| async move {
                            tokio::select! {
                                biased;
                                result = connection => result,
                                _ = cancel.cancelled() => Ok(()),
                            }
                        });
                        Ok(PgSourceConnection { client, driver })
                    }
                    PostgresTls::Disabled => {
                        config.ssl_mode(SslMode::Disable);
                        let (client, connection) = config
                            .connect(tokio_postgres::NoTls)
                            .await
                            .map_err(database_error)?;
                        let (driver, _) = OwnedTask::spawn(move |cancel| async move {
                            tokio::select! {
                                biased;
                                result = connection => result,
                                _ = cancel.cancelled() => Ok(()),
                            }
                        });
                        Ok(PgSourceConnection { client, driver })
                    }
                }
            };
            tokio::select! {
                biased;
                _ = cancel.cancelled() => Err(failure(SourceFailure::Cancelled, "source-postgres-connect-cancelled")),
                _ = tokio::time::sleep_until(deadline) => Err(failure(SourceFailure::ConnectTimeout, "source-postgres-connect-deadline")),
                result = connect => result,
            }
        })
    }

    fn connect_postgres_replication<'a>(
        &'a self,
        input: &'a PostgresConnectionConfig,
        credential: SourceCredential,
        command: String,
        cancel: CancellationToken,
        deadline: Instant,
    ) -> SourceFuture<'a, PgReplicationConnection> {
        Box::pin(async move {
            let SourceCredential::Postgres { user, password } = credential else {
                return Err(failure(
                    SourceFailure::Authentication,
                    "source-postgres-credential-kind",
                ));
            };
            let mut tls = TlsConfig::default();
            let mode = match input.tls {
                PostgresTls::Required => {
                    tls.root_certs = rustls_native_certs::load_native_certs()
                        .certs
                        .into_iter()
                        .map(|certificate| certificate.as_ref().to_vec())
                        .collect();
                    if tls.root_certs.is_empty() {
                        return Err(failure(
                            SourceFailure::Connection,
                            "source-postgres-tls-roots-unavailable",
                        ));
                    }
                    TlsMode::Require
                }
                PostgresTls::Disabled => TlsMode::Disable,
            };
            let address = if input.host.parse::<std::net::Ipv6Addr>().is_ok() {
                format!("[{}]:{}", input.host, input.port)
            } else {
                format!("{}:{}", input.host, input.port)
            };
            let mut connection = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(failure(SourceFailure::Cancelled, "source-postgres-replication-connect-cancelled")),
                _ = tokio::time::sleep_until(deadline) => return Err(failure(SourceFailure::ConnectTimeout, "source-postgres-replication-connect-deadline")),
                result = WireConn::connect_with_tls_config(
                    &address,
                    user.as_str(),
                    password.as_str(),
                    &input.database,
                    &[("replication", "database")],
                    mode,
                    &tls,
                ) => result.map_err(|cause| replication_error(cause, FailureStage::Prepare))?,
            };
            let mut buffer = BytesMut::new();
            encode_message(&FrontendMsg::Query(command.as_bytes()), &mut buffer);
            let collect = async {
                connection.send_raw(&buffer).await?;
                connection.collect_rows().await
            };
            let (rows, _) = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(failure(SourceFailure::Cancelled, "source-postgres-replication-command-cancelled")),
                _ = tokio::time::sleep_until(deadline) => return Err(failure(SourceFailure::ReadTimeout, "source-postgres-replication-command-deadline")),
                result = collect => result.map_err(|cause| replication_error(cause, FailureStage::Read))?,
            };
            let rows = rows
                .into_iter()
                .map(|row| {
                    row.iter()
                        .map(|cell| {
                            cell.map(|bytes| std::str::from_utf8(bytes).map(str::to_owned))
                                .transpose()
                        })
                        .collect::<Result<Vec<_>, _>>()
                })
                .collect::<Result<Vec<_>, _>>()
                .map_err(|cause| {
                    SourceError::caused_by(
                        SourceFailure::ProtocolViolation,
                        FailureStage::Decode,
                        cause,
                    )
                })?;
            let (driver, _) = OwnedTask::spawn(move |cancel| async move {
                loop {
                    tokio::select! {
                        biased;
                        message = connection.recv_msg() => match message.map_err(|cause| replication_error(cause, FailureStage::Drain))? {
                            BackendMsg::NoticeResponse { .. } | BackendMsg::ParameterStatus { .. } => {},
                            BackendMsg::ErrorResponse { fields } => return Err(replication_error(PgWireError::Pg(fields), FailureStage::Drain)),
                            _ => return Err(SourceError::new(SourceFailure::ProtocolViolation, FailureStage::Drain)),
                        },
                        _ = cancel.cancelled() => return Ok(()),
                    }
                }
            });
            Ok(PgReplicationConnection { rows, driver })
        })
    }
}

fn replication_error(cause: PgWireError, stage: FailureStage) -> SourceError {
    let reason = match &cause {
        PgWireError::Pg(error) => match error.code.as_str() {
            "28P01" | "28000" => SourceFailure::Authentication,
            "42501" => SourceFailure::PermissionDenied,
            "57014" => SourceFailure::ReadTimeout,
            code if code.len() == 5
                && code
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit()) =>
            {
                SourceFailure::SqlState {
                    code: error.code.clone(),
                }
            }
            _ => SourceFailure::ProtocolViolation,
        },
        PgWireError::Protocol(_) => SourceFailure::ProtocolViolation,
        _ => SourceFailure::Connection,
    };
    SourceError::caused_by(reason, stage, cause)
}

fn database_error(cause: tokio_postgres::Error) -> SourceError {
    use tokio_postgres::error::SqlState;
    let reason = match cause.code() {
        Some(&SqlState::INVALID_PASSWORD | &SqlState::INVALID_AUTHORIZATION_SPECIFICATION) => {
            SourceFailure::Authentication
        }
        Some(&SqlState::INSUFFICIENT_PRIVILEGE) => SourceFailure::PermissionDenied,
        _ => SourceFailure::Connection,
    };
    SourceError::caused_by(reason, FailureStage::Prepare, cause)
}

fn failure(reason: SourceFailure, code: &'static str) -> SourceError {
    SourceError::caused_by(reason, FailureStage::Prepare, io::Error::other(code))
}

fn secret<'de, D: Deserializer<'de>>(decoder: D) -> Result<Zeroizing<String>, D::Error> {
    String::deserialize(decoder).map(Zeroizing::new)
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum CredentialResponse {
    None,
    HttpBearer {
        #[serde(deserialize_with = "secret")]
        token: Zeroizing<String>,
    },
    Postgres {
        #[serde(deserialize_with = "secret")]
        user: Zeroizing<String>,
        #[serde(deserialize_with = "secret")]
        password: Zeroizing<String>,
    },
}

impl CredentialResponse {
    fn into_credential(self) -> Result<SourceCredential, SourceError> {
        fn valid(value: &str) -> bool {
            !value.is_empty() && value.len() <= 16 * 1024 && !value.contains('\0')
        }
        match self {
            Self::None => Ok(SourceCredential::None),
            Self::HttpBearer { token } if valid(&token) && !token.contains(['\r', '\n']) => {
                Ok(SourceCredential::HttpBearer(token))
            }
            Self::Postgres { user, password } if valid(&user) && valid(&password) => {
                Ok(SourceCredential::Postgres { user, password })
            }
            _ => Err(failure(
                SourceFailure::Credential {
                    reason: SourceCredentialReason::Invalid,
                },
                "source-resolver-credential-invalid",
            )),
        }
    }
}
