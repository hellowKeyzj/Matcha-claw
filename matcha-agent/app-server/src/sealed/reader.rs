use std::{net::SocketAddr, time::Duration};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::{
    Client, Url,
    header::{HeaderMap, HeaderValue},
};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::json;

use crate::rpc::{self, Error};

use super::wire::{self, Catalog, Read};

// Host credentials exist only inside this in-memory HTTP client. Never derive Debug.
pub(super) struct Reader {
    endpoint: Url,
    client: Client,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ReaderInput {
    endpoint: String,
    token: String,
}

impl Reader {
    pub fn new(input: ReaderInput) -> rpc::Result<Self> {
        let endpoint = origin(&input.endpoint)?;
        if input.token.len() != 43
            || !URL_SAFE_NO_PAD
                .decode(input.token.as_bytes())
                .is_ok_and(|bytes| bytes.len() == 32)
        {
            return Err(Error::invalid("The sealed reader credential is invalid"));
        }
        let mut token = HeaderValue::from_str(&input.token).map_err(|source| {
            Error::invalid("The sealed reader credential is invalid").with_source(source)
        })?;
        token.set_sensitive(true);
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-matcha-sealed-runtime",
            HeaderValue::from_static("matcha-agent"),
        );
        headers.insert("x-matcha-sealed-token", token);
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(30))
            .default_headers(headers)
            .build()
            .map_err(|source| {
                Error::unavailable(
                    "sealed_reader_client",
                    "The sealed reader client is unavailable",
                )
                .with_source(source.without_url())
            })?;
        Ok(Self { endpoint, client })
    }

    pub async fn catalog(&self, agent: &str) -> rpc::Result<Catalog> {
        let catalog: Catalog = self
            .get(
                &["api", "sealed-skills", "native", agent, "catalog"],
                None,
                None,
            )
            .await?;
        catalog.validate(agent).map_err(|error| {
            error.with_data(json!({"hostStatus":200,"delivery":"responseReceived"}))
        })?;
        Ok(catalog)
    }

    pub async fn read(
        &self,
        agent: &str,
        key: &str,
        path: &str,
        sha: &str,
        size: u64,
    ) -> rpc::Result<Read> {
        let mut segments = vec!["api", "sealed-skills", "native", agent, "read", key];
        segments.extend(path.split('/'));
        // Bound the complete response by the real file size and frozen Host wire, not a fixed cap.
        let binding = serde_json::to_vec(&json!({
            "v":1,"kind":"skill","runtime":"matcha-agent",
            "packageSha256":sha,"key":key,"use":"turn",
        }))
        .map_err(|source| Error::internal("sealed_binding_encode").with_source(source))?;
        let envelope = serde_json::to_vec(&json!({
            "contentBase64":"","packageSha256":sha,
            "meteringBinding":format!("m1.{}", URL_SAFE_NO_PAD.encode(binding)),
        }))
        .map_err(|source| Error::internal("sealed_read_envelope").with_source(source))?;
        let limit = (size as usize).div_ceil(3) * 4 + envelope.len();
        self.get(&segments, Some(sha), Some(limit)).await
    }

    async fn get<T: DeserializeOwned>(
        &self,
        segments: &[&str],
        sha: Option<&str>,
        limit: Option<usize>,
    ) -> rpc::Result<T> {
        let mut url = self.endpoint.clone();
        url.path_segments_mut()
            .map_err(|_| Error::internal("sealed_reader_origin"))?
            .extend(segments);
        let mut request = self.client.get(url);
        if let Some(sha) = sha {
            request = request.header("x-matcha-sealed-package-sha256", sha);
        }
        let mut response = request
            .send()
            .await
            .map_err(|source| transport(source, "unknown", 0))?;
        let status = response.status().as_u16();
        let body_limit = if status == 200 {
            limit
        } else {
            // The longest error kind in the frozen Host error envelope.
            Some(br#"{"error":{"kind":"invalid_request"}}"#.len())
        };
        if response
            .content_length()
            .is_some_and(|length| body_limit.is_some_and(|limit| length > limit as u64))
        {
            return Err(wire::invalid_readback().with_data(json!({"hostStatus":status,"delivery":"responseReceived","partialBytes":0,"bodyTooLarge":true})));
        }
        let mut bytes = Vec::new();
        loop {
            let chunk = response.chunk().await.map_err(|source| {
                transport(source, "responseReceived", bytes.len())
                    .with_data(json!({"hostStatus":status}))
            })?;
            let Some(chunk) = chunk else {
                break;
            };
            if body_limit.is_some_and(|limit| chunk.len() > limit.saturating_sub(bytes.len())) {
                return Err(wire::invalid_readback().with_data(json!({"hostStatus":status,"delivery":"responseReceived","partialBytes":bytes.len(),"bodyTooLarge":true})));
            }
            bytes.extend_from_slice(&chunk);
        }
        if status != 200 {
            return Err(remote(status, &bytes));
        }
        serde_json::from_slice(&bytes).map_err(|source| wire::invalid_readback()
            .with_data(json!({"hostStatus":status,"delivery":"responseReceived","partialBytes":bytes.len()})).with_source(source))
    }
}

pub(super) fn origin(value: &str) -> rpc::Result<Url> {
    let address = value
        .strip_prefix("http://")
        .and_then(|authority| authority.parse::<SocketAddr>().ok())
        .filter(|address| address.ip().is_loopback() && address.port() != 0)
        .filter(|address| value == format!("http://{address}"))
        .ok_or_else(|| {
            Error::invalid("The sealed reader requires a canonical loopback HTTP origin")
        })?;
    Url::parse(&format!("http://{address}"))
        .map_err(|source| Error::invalid("The sealed reader origin is invalid").with_source(source))
}

fn transport(source: reqwest::Error, delivery: &str, partial: usize) -> Error {
    let delivery = if source.is_connect() {
        "notSent"
    } else {
        delivery
    };
    Error::unavailable("sealed_reader_transport", "The sealed reader request could not be completed")
        .with_data(json!({"delivery":delivery,"partialBytes":partial,"timeout":source.is_timeout(),"connect":source.is_connect()}))
        .with_source(source.without_url())
}

fn remote(status: u16, bytes: &[u8]) -> Error {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Body {
        error: Detail,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Detail {
        kind: String,
    }
    let kind = serde_json::from_slice::<Body>(bytes)
        .ok()
        .map(|body| body.error.kind);
    let (code, kind, message) = match (status, kind.as_deref()) {
        (400, Some("invalid_request")) => (
            -32602,
            "sealed_invalid_request",
            "The sealed reader rejected the request",
        ),
        (401, Some("unauthorized")) => (
            -32007,
            "sealed_unauthorized",
            "The sealed read is not authorized",
        ),
        (404, Some("unknown")) => (-32001, "sealed_unknown", "The sealed resource is unknown"),
        (403, Some("disabled")) => (
            -32007,
            "sealed_disabled",
            "The sealed resource is not enabled",
        ),
        (409, Some("package_changed")) => (
            -32002,
            "sealed_package_changed",
            "The sealed package has changed",
        ),
        (503, Some("unavailable")) => (
            -32003,
            "sealed_unavailable",
            "The sealed reader is unavailable",
        ),
        _ => {
            return wire::invalid_readback()
                .with_data(json!({"hostStatus":status,"delivery":"responseReceived","partialBytes":bytes.len()}));
        }
    };
    Error::new(code, kind, message).with_data(
        json!({"hostStatus":status,"delivery":"responseReceived","partialBytes":bytes.len()}),
    )
}
