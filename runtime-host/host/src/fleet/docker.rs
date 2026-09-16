use std::{
    collections::BTreeMap,
    fmt,
    time::{Duration, Instant, SystemTime},
};

use fleet::{DockerTargetConfig, FleetSecretResolution, FleetSecretResolverPort};

use super::provider_resource::{
    ProviderOwnershipEvidence, ProviderResourceAssociation, ProviderResourceFact,
    ProviderResourceKind, ProviderResourceProvider, ProviderResourceReceipt, ProviderResourceRef,
};
use futures_util::StreamExt;
use reqwest::{Client, Response, StatusCode};
use serde_json::{Value, json};

const API_TIMEOUT: Duration = Duration::from_secs(15);
const LONG_TIMEOUT: Duration = Duration::from_secs(600);
const BODY_LIMIT: usize = 64 * 1024;
const OUTPUT_TAIL: usize = 12 * 1024;
const POLL: Duration = Duration::from_secs(1);
#[cfg(test)]
const MANAGED: &str = "com.matchaclaw.remote-fleet.managed";
const SETUP: &str = "set -e; mkdir -p /workspace; if command -v apt-get >/dev/null 2>&1; then export DEBIAN_FRONTEND=noninteractive; apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 update && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install -y --no-install-recommends bash ca-certificates curl git openssh-client procps; apt-get clean; rm -rf /var/lib/apt/lists/*; fi";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DockerEffect {
    Ping,
    Pull,
    Create,
    Start,
    Setup,
    StopRemove,
}

/// Typed provider lifecycle effects. Each mutating effect only reports success
/// after the provider-specific operation has completed and been read back.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DockerLifecycleEffect {
    Probe,
    Provision,
    Delete,
}

const PULL_TIMEOUT: Duration = Duration::from_secs(LONG_TIMEOUT.as_secs() + API_TIMEOUT.as_secs());
const CREATE_TIMEOUT: Duration = Duration::from_secs(API_TIMEOUT.as_secs() * 2);
const START_TIMEOUT: Duration = Duration::from_secs(API_TIMEOUT.as_secs() * 2);
const SETUP_TIMEOUT: Duration = LONG_TIMEOUT;
const PROVISION_TIMEOUT: Duration = Duration::from_secs(
    PULL_TIMEOUT.as_secs()
        + CREATE_TIMEOUT.as_secs()
        + START_TIMEOUT.as_secs()
        + SETUP_TIMEOUT.as_secs(),
);
const DELETE_TIMEOUT: Duration = Duration::from_secs(API_TIMEOUT.as_secs() * 3);

impl DockerLifecycleEffect {
    pub(crate) const fn lifecycle_timeout(self) -> Duration {
        match self {
            Self::Probe => API_TIMEOUT,
            Self::Provision => PROVISION_TIMEOUT,
            Self::Delete => DELETE_TIMEOUT,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum DockerEffectOutcome {
    Completed,
    AlreadyAbsent,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DockerResourceReadback {
    pub(crate) receipt: ProviderResourceReceipt,
}

impl DockerResourceReadback {
    pub(crate) fn fact(&self) -> Option<&ProviderResourceFact> {
        self.receipt.confirmed()
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum DockerEffectError {
    SecretUnavailable,
    SecretDenied,
    SecretMissing,
    InvalidResponse,
    Timeout,
    Network,
    RemoteStatus(u16),
    NotOwned,
    SetupFailed(i64, String),
    BodyTooLarge,
}
impl fmt::Display for DockerEffectError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SecretUnavailable => f.write_str("Docker secret resolver unavailable"),
            Self::SecretDenied => f.write_str("Docker secret access denied"),
            Self::SecretMissing => f.write_str("Docker secret missing"),
            Self::InvalidResponse => f.write_str("Docker Engine returned an invalid response"),
            Self::Timeout => f.write_str("Docker Engine request timed out"),
            Self::Network => f.write_str("Docker Engine request failed"),
            Self::RemoteStatus(s) => write!(f, "Docker Engine returned HTTP {s}"),
            Self::NotOwned => f.write_str("Docker container is not owned by this fleet"),
            Self::SetupFailed(c, _) => write!(f, "Docker setup exited with code {c}"),
            Self::BodyTooLarge => f.write_str("Docker Engine response body exceeded the limit"),
        }
    }
}
impl std::error::Error for DockerEffectError {}

#[derive(Clone)]
pub(crate) struct DockerEffectClient {
    client: Client,
    config: DockerTargetConfig,
    ownership: BTreeMap<String, String>,
}
pub(crate) async fn open_terminal<R: FleetSecretResolverPort>(
    config: &DockerTargetConfig,
    resolver: &mut R,
    rows: u16,
    cols: u16,
) -> Result<crate::fleet::terminal::TerminalProviderOpen, DockerEffectError>
where
    R::Secret: AsRef<str>,
{
    if rows == 0 || cols == 0 {
        return Err(DockerEffectError::InvalidResponse);
    }
    let client = DockerEffectClient::new(config.clone(), BTreeMap::new())?;
    let token = client.token(resolver)?;
    let response = client
        .req(
            &format!("/containers/{}/exec", config.container_name()),
            reqwest::Method::POST,
            token.as_deref(),
            Some(json!({
                "AttachStdin": true,
                "AttachStdout": true,
                "AttachStderr": true,
                "Tty": true,
                "Cmd": ["/bin/sh", "-l"]
            })),
            API_TIMEOUT,
        )
        .await?;
    ok(&response)?;
    let exec_id = id(response).await?;
    resize_exec(&client, &exec_id, token.as_deref(), rows, cols).await?;

    let (commands, command_rx) = tokio::sync::mpsc::channel(32);
    let (events, events_rx) = tokio::sync::mpsc::channel(32);
    let http = client.client.clone();
    let url = client.url(&format!("/exec/{exec_id}/start"))?;
    let token_owned = token.clone();
    let start_payload = serde_json::to_vec(&json!({"Detach": false, "Tty": true}))
        .map_err(|_| DockerEffectError::InvalidResponse)?;
    let resize_client = std::sync::Arc::new(client.clone());
    let resize_exec_id = std::sync::Arc::new(exec_id.clone());
    let resize_token = std::sync::Arc::new(token.clone());
    tokio::spawn(async move {
        let body_stream = futures_util::stream::unfold(
            (Some(start_payload), command_rx),
            move |(payload, mut rx)| {
                let resize_client = std::sync::Arc::clone(&resize_client);
                let resize_exec_id = std::sync::Arc::clone(&resize_exec_id);
                let resize_token = std::sync::Arc::clone(&resize_token);
                async move {
                    if let Some(payload) = payload {
                        return Some((Ok::<_, std::convert::Infallible>(payload), (None, rx)));
                    }
                    loop {
                        match rx.recv().await {
                            Some(crate::fleet::terminal::ProviderCommand::Input(data))
                                if !data.is_empty() =>
                            {
                                return Some((Ok(data), (None, rx)));
                            }
                            Some(crate::fleet::terminal::ProviderCommand::Resize {
                                rows,
                                cols,
                            }) => {
                                let _ = resize_exec(
                                    resize_client.as_ref(),
                                    resize_exec_id.as_str(),
                                    resize_token.as_deref(),
                                    rows,
                                    cols,
                                )
                                .await;
                            }
                            Some(crate::fleet::terminal::ProviderCommand::Input(_)) => {}
                            None => return None,
                        }
                    }
                }
            },
        );
        let mut request = http
            .post(url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header("Connection", "Upgrade")
            .header("Upgrade", "tcp")
            .body(reqwest::Body::wrap_stream(body_stream));
        if let Some(token) = token_owned.as_deref() {
            request = request.bearer_auth(token);
        }
        let Ok(response) = request.send().await else {
            let _ = events
                .send(Err(crate::fleet::terminal::ProviderError::message(
                    "Docker stream failed",
                )))
                .await;
            return;
        };
        if !response.status().is_success() {
            let _ = events
                .send(Err(crate::fleet::terminal::ProviderError::message(
                    "Docker stream rejected",
                )))
                .await;
            return;
        }
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(chunk) if !chunk.is_empty() => {
                    if events
                        .send(Ok(crate::fleet::terminal::ProviderEvent::Output(
                            chunk.to_vec(),
                        )))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
                Ok(_) => {}
                Err(_) => {
                    let _ = events
                        .send(Err(crate::fleet::terminal::ProviderError::message(
                            "Docker stream failed",
                        )))
                        .await;
                    return;
                }
            }
        }
        let _ = events
            .send(Ok(crate::fleet::terminal::ProviderEvent::Exit {
                code: None,
            }))
            .await;
    });
    Ok(crate::fleet::terminal::TerminalProviderOpen {
        commands,
        events: events_rx,
    })
}

async fn resize_exec(
    client: &DockerEffectClient,
    exec_id: &str,
    token: Option<&str>,
    rows: u16,
    cols: u16,
) -> Result<(), DockerEffectError> {
    if rows == 0 || cols == 0 {
        return Err(DockerEffectError::InvalidResponse);
    }
    let mut url = client.url(&format!("/exec/{exec_id}/resize"))?;
    url.query_pairs_mut()
        .append_pair("h", &rows.to_string())
        .append_pair("w", &cols.to_string());
    let response = client
        .send(url, reqwest::Method::POST, token, None, API_TIMEOUT)
        .await?;
    ok(&response)
}

impl DockerEffectClient {
    pub(crate) fn new(
        config: DockerTargetConfig,
        ownership: BTreeMap<String, String>,
    ) -> Result<Self, DockerEffectError> {
        Ok(Self {
            client: Client::builder()
                .connect_timeout(API_TIMEOUT)
                .timeout(LONG_TIMEOUT)
                .build()
                .map_err(|_| DockerEffectError::Network)?,
            config,
            ownership,
        })
    }
    pub(crate) async fn execute<R: FleetSecretResolverPort>(
        &self,
        effect: DockerEffect,
        resolver: &mut R,
    ) -> Result<DockerEffectOutcome, DockerEffectError>
    where
        R::Secret: AsRef<str>,
    {
        let token = self.token(resolver)?;
        match effect {
            DockerEffect::Ping => self
                .ping(token.as_deref())
                .await
                .map(|_| DockerEffectOutcome::Completed),
            DockerEffect::Pull => self
                .pull(token.as_deref())
                .await
                .map(|_| DockerEffectOutcome::Completed),
            DockerEffect::Create => self
                .create(token.as_deref())
                .await
                .map(|_| DockerEffectOutcome::Completed),
            DockerEffect::Start => self
                .start(token.as_deref())
                .await
                .map(|_| DockerEffectOutcome::Completed),
            DockerEffect::Setup => self
                .setup(token.as_deref())
                .await
                .map(|_| DockerEffectOutcome::Completed),
            DockerEffect::StopRemove => self.stop_remove(token.as_deref()).await,
        }
    }

    pub(crate) async fn execute_lifecycle<R: FleetSecretResolverPort>(
        &self,
        effect: DockerLifecycleEffect,
        resolver: &mut R,
    ) -> Result<DockerEffectOutcome, DockerEffectError>
    where
        R::Secret: AsRef<str>,
    {
        match effect {
            DockerLifecycleEffect::Probe => self.execute(DockerEffect::Ping, resolver).await,
            DockerLifecycleEffect::Provision => {
                for step in [
                    DockerEffect::Pull,
                    DockerEffect::Create,
                    DockerEffect::Start,
                    DockerEffect::Setup,
                ] {
                    self.execute(step, resolver).await?;
                }
                Ok(DockerEffectOutcome::Completed)
            }
            DockerLifecycleEffect::Delete => self.execute(DockerEffect::StopRemove, resolver).await,
        }
    }

    /// Executes a lifecycle effect and preserves only Docker-authoritative identity.
    /// The remote ID comes from `GET /containers/{name}/json` (`Id`), never from
    /// the configured container name or a derived logical ID.
    pub(crate) async fn execute_lifecycle_readback<R: FleetSecretResolverPort>(
        &self,
        effect: DockerLifecycleEffect,
        resolver: &mut R,
        observed_at: SystemTime,
    ) -> Result<DockerResourceReadback, DockerEffectError>
    where
        R::Secret: AsRef<str>,
    {
        let outcome = self.execute_lifecycle(effect, resolver).await?;
        if matches!(effect, DockerLifecycleEffect::Delete) {
            return Ok(DockerResourceReadback {
                receipt: match outcome {
                    DockerEffectOutcome::Completed => {
                        ProviderResourceReceipt::NoAuthoritativeResourceIdentity {
                            provider: ProviderResourceProvider::Docker,
                            observed_at,
                        }
                    }
                    DockerEffectOutcome::AlreadyAbsent => ProviderResourceReceipt::AlreadyAbsent {
                        provider: ProviderResourceProvider::Docker,
                        observed_at,
                    },
                },
            });
        }
        match outcome {
            DockerEffectOutcome::Completed => self.readback_resource(resolver, observed_at).await,
            DockerEffectOutcome::AlreadyAbsent => Ok(DockerResourceReadback {
                receipt: ProviderResourceReceipt::AlreadyAbsent {
                    provider: ProviderResourceProvider::Docker,
                    observed_at,
                },
            }),
        }
    }

    pub(crate) async fn readback_resource<R: FleetSecretResolverPort>(
        &self,
        resolver: &mut R,
        observed_at: SystemTime,
    ) -> Result<DockerResourceReadback, DockerEffectError>
    where
        R::Secret: AsRef<str>,
    {
        let token = self.token(resolver)?;
        let value = self.inspect_container(token.as_deref()).await?;
        let labels = value
            .pointer("/Config/Labels")
            .and_then(Value::as_object)
            .ok_or(DockerEffectError::NotOwned)?
            .iter()
            .map(|(key, value)| {
                value
                    .as_str()
                    .map(|value| (key.clone(), value.to_owned()))
                    .ok_or(DockerEffectError::InvalidResponse)
            })
            .collect::<Result<BTreeMap<_, _>, _>>()?;
        if !self
            .ownership
            .iter()
            .all(|(key, expected)| labels.get(key).map(String::as_str) == Some(expected.as_str()))
        {
            return Err(DockerEffectError::NotOwned);
        }
        let remote_id = value
            .get("Id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .ok_or(DockerEffectError::InvalidResponse)?;
        let name = value
            .get("Name")
            .and_then(Value::as_str)
            .map(|name| name.trim_start_matches('/'))
            .filter(|name| !name.trim().is_empty())
            .unwrap_or(self.config.container_name());
        let association = ProviderResourceAssociation::docker_container(name)
            .map_err(|_| DockerEffectError::InvalidResponse)?;
        let reference = ProviderResourceRef::new(
            ProviderResourceProvider::Docker,
            ProviderResourceKind::DockerContainer,
            remote_id,
            None,
            Some(name.to_owned()),
        )
        .map_err(|_| DockerEffectError::InvalidResponse)?;
        let ownership = ProviderOwnershipEvidence::required(labels.clone())
            .map_err(|_| DockerEffectError::NotOwned)?;
        let fact = ProviderResourceFact::confirmed(
            ProviderResourceProvider::Docker,
            ProviderResourceKind::DockerContainer,
            remote_id,
            vec![reference],
            ownership,
            association,
            format!("Docker container {name}"),
            labels.clone(),
            observed_at,
        )
        .map_err(|_| DockerEffectError::InvalidResponse)?;
        Ok(DockerResourceReadback {
            receipt: ProviderResourceReceipt::Confirmed(fact),
        })
    }

    fn token<R: FleetSecretResolverPort>(
        &self,
        resolver: &mut R,
    ) -> Result<Option<String>, DockerEffectError>
    where
        R::Secret: AsRef<str>,
    {
        let Some(r) = self.config.bearer_token() else {
            return Ok(None);
        };
        match resolver
            .resolve(r)
            .map_err(|_| DockerEffectError::SecretUnavailable)?
        {
            FleetSecretResolution::Resolved(v) => {
                let s = v.as_ref().trim();
                if s.is_empty() {
                    Err(DockerEffectError::SecretMissing)
                } else {
                    Ok(Some(s.to_owned()))
                }
            }
            FleetSecretResolution::AccessDenied => Err(DockerEffectError::SecretDenied),
            FleetSecretResolution::NotFound => Err(DockerEffectError::SecretMissing),
        }
    }
    async fn ping(&self, t: Option<&str>) -> Result<(), DockerEffectError> {
        let r = self
            .req("/_ping", reqwest::Method::GET, t, None, API_TIMEOUT)
            .await?;
        if bounded_text(r).await?.trim() == "OK" {
            Ok(())
        } else {
            Err(DockerEffectError::InvalidResponse)
        }
    }
    async fn pull(&self, t: Option<&str>) -> Result<(), DockerEffectError> {
        let mut u = self.url("/images/create")?;
        let (i, tag) = split_image(self.config.image());
        u.query_pairs_mut().append_pair("fromImage", i);
        if let Some(x) = tag {
            u.query_pairs_mut().append_pair("tag", x);
        }
        let r = self
            .send(u, reqwest::Method::POST, t, None, LONG_TIMEOUT)
            .await?;
        ok(&r)?;
        for l in bounded_text(r).await?.lines() {
            let v: Value = serde_json::from_str(l).unwrap_or(Value::Null);
            if v.get("error").is_some() || v.get("errorDetail").is_some() {
                return Err(DockerEffectError::InvalidResponse);
            }
        }
        // A successful pull stream is not sufficient evidence: Docker may have
        // accepted the request and still fail to materialize the image.
        self.inspect_image(t).await
    }
    async fn create(&self, t: Option<&str>) -> Result<(), DockerEffectError> {
        let mut u = self.url("/containers/create")?;
        u.query_pairs_mut()
            .append_pair("name", self.config.container_name());
        let b = json!({"Image":self.config.image(),"Entrypoint":["/bin/sh","-lc"],"Cmd":["mkdir -p /workspace && trap 'exit 0' TERM INT; while :; do sleep 2147483647 & wait $!; done"],"WorkingDir":"/workspace","Labels":self.ownership});
        let r = self
            .send(u, reqwest::Method::POST, t, Some(b), API_TIMEOUT)
            .await?;
        if r.status() == StatusCode::CONFLICT {
            self.owned(t).await
        } else {
            ok(&r)?;
            let _ = bounded_json(r)
                .await?
                .get("Id")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .ok_or(DockerEffectError::InvalidResponse)?;
            self.owned(t).await
        }
    }
    async fn start(&self, t: Option<&str>) -> Result<(), DockerEffectError> {
        let r = self
            .req(
                &format!("/containers/{}/start", self.config.container_name()),
                reqwest::Method::POST,
                t,
                None,
                API_TIMEOUT,
            )
            .await?;
        if !(r.status().is_success() || r.status() == StatusCode::NOT_MODIFIED) {
            return Err(DockerEffectError::RemoteStatus(r.status().as_u16()));
        }
        self.running(t).await
    }
    async fn setup(&self, t: Option<&str>) -> Result<(), DockerEffectError> {
        let deadline = Instant::now() + LONG_TIMEOUT;
        let r=self.req(&format!("/containers/{}/exec",self.config.container_name()),reqwest::Method::POST,t,Some(json!({"AttachStdout":true,"AttachStderr":true,"Tty":false,"Cmd":["/bin/sh","-lc",SETUP]})),API_TIMEOUT).await?;
        ok(&r)?;
        let id = id(r).await?;
        let timeout = deadline.saturating_duration_since(Instant::now());
        if timeout.is_zero() {
            return Err(DockerEffectError::Timeout);
        }
        let r = self
            .req(
                &format!("/exec/{id}/start"),
                reqwest::Method::POST,
                t,
                Some(json!({"Detach":false,"Tty":false})),
                timeout,
            )
            .await?;
        ok(&r)?;
        let output = bounded_text(r).await?;
        loop {
            let timeout = deadline.saturating_duration_since(Instant::now());
            if timeout.is_zero() {
                return Err(DockerEffectError::Timeout);
            }
            let r = self
                .req(
                    &format!("/exec/{id}/json"),
                    reqwest::Method::GET,
                    t,
                    None,
                    timeout.min(API_TIMEOUT),
                )
                .await?;
            ok(&r)?;
            let v = bounded_json(r).await?;
            if let Some(c) = v.get("ExitCode").and_then(Value::as_i64) {
                if c == 0 {
                    return Ok(());
                }
                return Err(DockerEffectError::SetupFailed(c, tail(&output)));
            }
            let timeout = deadline.saturating_duration_since(Instant::now());
            if timeout.is_zero() {
                return Err(DockerEffectError::Timeout);
            }
            tokio::time::sleep(POLL.min(timeout)).await;
        }
    }
    async fn inspect_image(&self, t: Option<&str>) -> Result<(), DockerEffectError> {
        let r = self
            .req(
                &format!("/images/{}", image_path(self.config.image())),
                reqwest::Method::GET,
                t,
                None,
                API_TIMEOUT,
            )
            .await?;
        ok(&r)?;
        let value = bounded_json(r).await?;
        value
            .get("Id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .map(|_| ())
            .ok_or(DockerEffectError::InvalidResponse)
    }

    async fn inspect_container(&self, t: Option<&str>) -> Result<Value, DockerEffectError> {
        let r = self
            .req(
                &format!("/containers/{}/json", self.config.container_name()),
                reqwest::Method::GET,
                t,
                None,
                API_TIMEOUT,
            )
            .await?;
        if r.status() == StatusCode::NOT_FOUND {
            return Err(DockerEffectError::RemoteStatus(404));
        }
        ok(&r)?;
        bounded_json(r).await
    }

    async fn owned(&self, t: Option<&str>) -> Result<(), DockerEffectError> {
        let v = self.inspect_container(t).await?;
        let l = v
            .pointer("/Config/Labels")
            .and_then(Value::as_object)
            .ok_or(DockerEffectError::NotOwned)?;
        if self
            .ownership
            .iter()
            .all(|(k, x)| l.get(k).and_then(Value::as_str) == Some(x))
        {
            Ok(())
        } else {
            Err(DockerEffectError::NotOwned)
        }
    }

    async fn running(&self, t: Option<&str>) -> Result<(), DockerEffectError> {
        let r = self
            .req(
                &format!("/containers/{}/json", self.config.container_name()),
                reqwest::Method::GET,
                t,
                None,
                API_TIMEOUT,
            )
            .await?;
        ok(&r)?;
        let v = bounded_json(r).await?;
        if v.pointer("/State/Running") == Some(&Value::Bool(true)) {
            Ok(())
        } else {
            Err(DockerEffectError::InvalidResponse)
        }
    }
    async fn stop_remove(&self, t: Option<&str>) -> Result<DockerEffectOutcome, DockerEffectError> {
        let r = self
            .req(
                &format!("/containers/{}/json", self.config.container_name()),
                reqwest::Method::GET,
                t,
                None,
                API_TIMEOUT,
            )
            .await?;
        if r.status() == StatusCode::NOT_FOUND {
            return Ok(DockerEffectOutcome::AlreadyAbsent);
        }
        ok(&r)?;
        let v = bounded_json(r).await?;
        let l = v
            .pointer("/Config/Labels")
            .and_then(Value::as_object)
            .ok_or(DockerEffectError::NotOwned)?;
        if !self
            .ownership
            .iter()
            .all(|(k, x)| l.get(k).and_then(Value::as_str) == Some(x))
        {
            return Err(DockerEffectError::NotOwned);
        }
        let r = self
            .req(
                &format!("/containers/{}/stop", self.config.container_name()),
                reqwest::Method::POST,
                t,
                None,
                API_TIMEOUT,
            )
            .await?;
        if !(r.status().is_success()
            || r.status() == StatusCode::NOT_MODIFIED
            || r.status() == StatusCode::NOT_FOUND)
        {
            return Err(DockerEffectError::RemoteStatus(r.status().as_u16()));
        }
        let mut u = self.url(&format!("/containers/{}", self.config.container_name()))?;
        u.query_pairs_mut().append_pair("force", "true");
        let r = self
            .send(u, reqwest::Method::DELETE, t, None, API_TIMEOUT)
            .await?;
        if r.status().is_success() || r.status() == StatusCode::NOT_FOUND {
            Ok(DockerEffectOutcome::Completed)
        } else {
            Err(DockerEffectError::RemoteStatus(r.status().as_u16()))
        }
    }
    fn url(&self, p: &str) -> Result<reqwest::Url, DockerEffectError> {
        reqwest::Url::parse(self.config.endpoint())
            .map_err(|_| DockerEffectError::Network)?
            .join(p.trim_start_matches('/'))
            .map_err(|_| DockerEffectError::Network)
    }
    async fn req(
        &self,
        p: &str,
        m: reqwest::Method,
        t: Option<&str>,
        b: Option<Value>,
        d: Duration,
    ) -> Result<Response, DockerEffectError> {
        self.send(self.url(p)?, m, t, b, d).await
    }
    async fn send(
        &self,
        u: reqwest::Url,
        m: reqwest::Method,
        t: Option<&str>,
        b: Option<Value>,
        d: Duration,
    ) -> Result<Response, DockerEffectError> {
        let mut q = self.client.request(m, u).timeout(d);
        if let Some(t) = t {
            q = q.bearer_auth(t)
        }
        if let Some(b) = b {
            q = q.json(&b)
        }
        q.send().await.map_err(|e| {
            if e.is_timeout() {
                DockerEffectError::Timeout
            } else {
                DockerEffectError::Network
            }
        })
    }
}
fn ok(r: &Response) -> Result<(), DockerEffectError> {
    if r.status().is_success() {
        Ok(())
    } else {
        Err(DockerEffectError::RemoteStatus(r.status().as_u16()))
    }
}
async fn bytes(r: Response) -> Result<Vec<u8>, DockerEffectError> {
    let mut s = r.bytes_stream();
    let mut o = Vec::new();
    while let Some(c) = s.next().await {
        let c = c.map_err(|_| DockerEffectError::Network)?;
        if o.len() + c.len() > BODY_LIMIT {
            return Err(DockerEffectError::BodyTooLarge);
        }
        o.extend_from_slice(&c)
    }
    Ok(o)
}
async fn bounded_text(r: Response) -> Result<String, DockerEffectError> {
    Ok(String::from_utf8_lossy(&bytes(r).await?).into_owned())
}
async fn bounded_json(r: Response) -> Result<Value, DockerEffectError> {
    serde_json::from_slice(&bytes(r).await?).map_err(|_| DockerEffectError::InvalidResponse)
}
async fn id(r: Response) -> Result<String, DockerEffectError> {
    bounded_json(r)
        .await?
        .get("Id")
        .and_then(Value::as_str)
        .filter(|x| !x.trim().is_empty())
        .map(str::to_owned)
        .ok_or(DockerEffectError::InvalidResponse)
}
fn tail(s: &str) -> String {
    let s = s.trim();
    if s.len() <= OUTPUT_TAIL {
        s.to_owned()
    } else {
        s[s.len() - OUTPUT_TAIL..].to_owned()
    }
}
fn split_image(s: &str) -> (&str, Option<&str>) {
    if s.contains('@') {
        return (s, None);
    }
    let slash = s.rfind('/').unwrap_or(0);
    match s[slash..].find(':') {
        Some(i) => (&s[..slash + i], Some(&s[slash + i + 1..])),
        None => (s, None),
    }
}

fn image_path(image: &str) -> String {
    image.replace('/', "%2F")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn image_split_handles_digest_and_registry_port() {
        assert_eq!(
            split_image("registry:5000/team/image:stable"),
            ("registry:5000/team/image", Some("stable"))
        );
        assert_eq!(
            split_image("team/image@sha256:abc"),
            ("team/image@sha256:abc", None)
        );
    }
    #[test]
    fn ownership_label_is_strict() {
        let e = BTreeMap::from([
            (MANAGED.to_owned(), "true".to_owned()),
            ("node".to_owned(), "n1".to_owned()),
        ]);
        let a = json!({MANAGED:"true","node":"n1"});
        assert!(
            e.iter()
                .all(|(k, v)| a.get(k).and_then(Value::as_str) == Some(v))
        );
    }
}
