//! Native Kubernetes effects for Fleet targets.
//!
//! Kubernetes credentials are resolved only inside this provider.  Every
//! mutating operation verifies the managed labels before patching or deleting,
//! and verifies the resulting object with a readback before reporting success.

use std::{
    collections::BTreeMap,
    fmt,
    time::{Duration, SystemTime},
};

use crate as fleet;
use fleet::{FleetSecretResolution, FleetSecretResolverPort, KubernetesTargetConfig};

use super::provider_resource::{
    ProviderOwnershipEvidence, ProviderResourceAssociation, ProviderResourceFact,
    ProviderResourceKind, ProviderResourceProvider, ProviderResourceReceipt, ProviderResourceRef,
};
use reqwest::{Client, Method, Response, StatusCode};
use serde_json::{Value, json};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const OPERATION_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_BODY_BYTES: usize = 256 * 1024;
const MANAGED_LABEL: &str = "com.matchaclaw.remote-fleet.managed";
const TARGET_LABEL: &str = "com.matchaclaw.remote-fleet.target";
const AGENT_LABEL: &str = "com.matchaclaw.remote-fleet.agent-id";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum KubernetesEffect {
    Probe,
    Pull,
    Apply,
    Delete,
}

/// Typed lifecycle operations for the Kubernetes provider.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum KubernetesLifecycleEffect {
    Probe,
    Provision,
    Delete,
}

impl KubernetesLifecycleEffect {
    pub(crate) const fn lifecycle_timeout(self) -> Duration {
        match self {
            Self::Probe => REQUEST_TIMEOUT,
            Self::Provision | Self::Delete => OPERATION_TIMEOUT,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum KubernetesEffectOutcome {
    Completed,
    AlreadyAbsent,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct KubernetesResourceReadback {
    pub(crate) receipt: ProviderResourceReceipt,
}

impl KubernetesResourceReadback {
    pub(crate) fn fact(&self) -> Option<&ProviderResourceFact> {
        self.receipt.confirmed()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum KubernetesEffectError {
    SecretUnavailable,
    SecretDenied,
    SecretMissing,
    InvalidResponse,
    InvalidUrl,
    Timeout,
    Network,
    RemoteStatus(u16),
    NotOwned,
    ReadbackMismatch,
    BodyTooLarge,
}

impl fmt::Display for KubernetesEffectError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SecretUnavailable => {
                formatter.write_str("Kubernetes secret resolver unavailable")
            }
            Self::SecretDenied => formatter.write_str("Kubernetes secret access denied"),
            Self::SecretMissing => formatter.write_str("Kubernetes bearer token missing"),
            Self::InvalidResponse => {
                formatter.write_str("Kubernetes API returned an invalid response")
            }
            Self::InvalidUrl => formatter.write_str("Kubernetes API URL is invalid"),
            Self::Timeout => formatter.write_str("Kubernetes API request timed out"),
            Self::Network => formatter.write_str("Kubernetes API request failed"),
            Self::RemoteStatus(status) => {
                write!(formatter, "Kubernetes API returned HTTP {status}")
            }
            Self::NotOwned => {
                formatter.write_str("Kubernetes resource is not owned by this Fleet target")
            }
            Self::ReadbackMismatch => {
                formatter.write_str("Kubernetes resource readback did not match the applied object")
            }
            Self::BodyTooLarge => {
                formatter.write_str("Kubernetes API response exceeded the size limit")
            }
        }
    }
}

impl std::error::Error for KubernetesEffectError {}

#[derive(Clone)]
pub(crate) struct KubernetesEffectClient {
    client: Client,
    config: KubernetesTargetConfig,
    ownership: BTreeMap<String, String>,
}

impl KubernetesEffectClient {
    pub(crate) fn new(
        config: KubernetesTargetConfig,
        ownership: BTreeMap<String, String>,
    ) -> Result<Self, KubernetesEffectError> {
        if !valid_ownership(&ownership) {
            return Err(KubernetesEffectError::NotOwned);
        }
        let client = Client::builder()
            .connect_timeout(REQUEST_TIMEOUT)
            .timeout(OPERATION_TIMEOUT)
            .build()
            .map_err(|_| KubernetesEffectError::Network)?;
        Ok(Self {
            client,
            config,
            ownership,
        })
    }

    pub(crate) async fn execute<R: FleetSecretResolverPort>(
        &self,
        effect: KubernetesEffect,
        resolver: &mut R,
    ) -> Result<KubernetesEffectOutcome, KubernetesEffectError>
    where
        R::Secret: AsRef<str>,
    {
        let token = self.token(resolver)?;
        match effect {
            KubernetesEffect::Probe => {
                self.probe(token.as_deref()).await?;
                Ok(KubernetesEffectOutcome::Completed)
            }
            // Kubernetes has no standalone image-pull endpoint.  A pull is a
            // real readback of the configured image from the target workload;
            // installation uses Apply, which lets the cluster pull the image.
            KubernetesEffect::Pull => {
                self.readback_deployment(token.as_deref()).await?;
                Ok(KubernetesEffectOutcome::Completed)
            }
            KubernetesEffect::Apply => {
                self.apply(token.as_deref()).await?;
                Ok(KubernetesEffectOutcome::Completed)
            }
            KubernetesEffect::Delete => Ok(self.delete(token.as_deref()).await?),
        }
    }

    pub(crate) async fn execute_lifecycle<R: FleetSecretResolverPort>(
        &self,
        effect: KubernetesLifecycleEffect,
        resolver: &mut R,
    ) -> Result<KubernetesEffectOutcome, KubernetesEffectError>
    where
        R::Secret: AsRef<str>,
    {
        match effect {
            KubernetesLifecycleEffect::Probe => {
                self.execute(KubernetesEffect::Probe, resolver).await
            }
            KubernetesLifecycleEffect::Provision => {
                self.execute(KubernetesEffect::Apply, resolver).await
            }
            KubernetesLifecycleEffect::Delete => {
                self.execute(KubernetesEffect::Delete, resolver).await
            }
        }
    }

    /// Executes the lifecycle effect and returns Kubernetes API metadata identity.
    /// The workload ID is the API object's `metadata.uid`; names and paths remain refs.
    pub(crate) async fn execute_lifecycle_readback<R: FleetSecretResolverPort>(
        &self,
        effect: KubernetesLifecycleEffect,
        resolver: &mut R,
        observed_at: SystemTime,
    ) -> Result<KubernetesResourceReadback, KubernetesEffectError>
    where
        R::Secret: AsRef<str>,
    {
        let outcome = self.execute_lifecycle(effect, resolver).await?;
        if matches!(effect, KubernetesLifecycleEffect::Delete) {
            return Ok(KubernetesResourceReadback {
                receipt: match outcome {
                    KubernetesEffectOutcome::Completed => {
                        ProviderResourceReceipt::NoAuthoritativeResourceIdentity {
                            provider: ProviderResourceProvider::Kubernetes,
                            observed_at,
                        }
                    }
                    KubernetesEffectOutcome::AlreadyAbsent => {
                        ProviderResourceReceipt::AlreadyAbsent {
                            provider: ProviderResourceProvider::Kubernetes,
                            observed_at,
                        }
                    }
                },
            });
        }
        match outcome {
            KubernetesEffectOutcome::Completed => {
                self.readback_resource(resolver, observed_at).await
            }
            KubernetesEffectOutcome::AlreadyAbsent => Ok(KubernetesResourceReadback {
                receipt: ProviderResourceReceipt::AlreadyAbsent {
                    provider: ProviderResourceProvider::Kubernetes,
                    observed_at,
                },
            }),
        }
    }

    pub(crate) async fn readback_resource<R: FleetSecretResolverPort>(
        &self,
        resolver: &mut R,
        observed_at: SystemTime,
    ) -> Result<KubernetesResourceReadback, KubernetesEffectError>
    where
        R::Secret: AsRef<str>,
    {
        let token = self.token(resolver)?;
        let deployment_path = format!(
            "/apis/apps/v1/namespaces/{}/deployments/{}",
            path_segment(self.config.namespace()),
            path_segment(self.config.deployment_name())
        );
        let service_path = format!(
            "/api/v1/namespaces/{}/services/{}",
            path_segment(self.config.namespace()),
            path_segment(self.config.service_name())
        );
        let deployment = self
            .read_resource(token.as_deref(), &deployment_path)
            .await?;
        let service = self.read_resource(token.as_deref(), &service_path).await?;
        if !owned_labels(&deployment, &self.ownership) || !owned_labels(&service, &self.ownership) {
            return Err(KubernetesEffectError::NotOwned);
        }
        let uid = deployment
            .pointer("/metadata/uid")
            .and_then(Value::as_str)
            .filter(|uid| !uid.trim().is_empty())
            .ok_or(KubernetesEffectError::ReadbackMismatch)?;
        let service_uid = service
            .pointer("/metadata/uid")
            .and_then(Value::as_str)
            .filter(|uid| !uid.trim().is_empty())
            .ok_or(KubernetesEffectError::ReadbackMismatch)?;
        let namespace = deployment
            .pointer("/metadata/namespace")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(self.config.namespace());
        let deployment_name = deployment
            .pointer("/metadata/name")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or(KubernetesEffectError::ReadbackMismatch)?;
        let service_name = service
            .pointer("/metadata/name")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(self.config.service_name());
        let labels = deployment
            .pointer("/metadata/labels")
            .and_then(Value::as_object)
            .ok_or(KubernetesEffectError::NotOwned)?
            .iter()
            .map(|(key, value)| {
                value
                    .as_str()
                    .map(|value| (key.clone(), value.to_owned()))
                    .ok_or(KubernetesEffectError::InvalidResponse)
            })
            .collect::<Result<BTreeMap<_, _>, _>>()?;
        let association = ProviderResourceAssociation::kubernetes_workload(
            namespace,
            deployment_name,
            service_name,
        )
        .map_err(|_| KubernetesEffectError::ReadbackMismatch)?;
        let refs = vec![
            ProviderResourceRef::new(
                ProviderResourceProvider::Kubernetes,
                ProviderResourceKind::KubernetesDeployment,
                uid,
                Some(namespace.to_owned()),
                Some(deployment_name.to_owned()),
            ),
            ProviderResourceRef::new(
                ProviderResourceProvider::Kubernetes,
                ProviderResourceKind::KubernetesService,
                service_uid,
                Some(namespace.to_owned()),
                Some(service_name.to_owned()),
            ),
        ]
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| KubernetesEffectError::ReadbackMismatch)?;
        let ownership = ProviderOwnershipEvidence::required(labels.clone())
            .map_err(|_| KubernetesEffectError::NotOwned)?;
        let fact = ProviderResourceFact::confirmed(
            ProviderResourceProvider::Kubernetes,
            ProviderResourceKind::KubernetesWorkload,
            uid,
            refs,
            ownership,
            association,
            format!("Kubernetes workload {namespace}/{deployment_name}"),
            labels.clone(),
            observed_at,
        )
        .map_err(|_| KubernetesEffectError::ReadbackMismatch)?;
        Ok(KubernetesResourceReadback {
            receipt: ProviderResourceReceipt::Confirmed(fact),
        })
    }

    fn token<R: FleetSecretResolverPort>(
        &self,
        resolver: &mut R,
    ) -> Result<Option<String>, KubernetesEffectError>
    where
        R::Secret: AsRef<str>,
    {
        match resolver
            .resolve(self.config.bearer_token())
            .map_err(|_| KubernetesEffectError::SecretUnavailable)?
        {
            FleetSecretResolution::Resolved(value) => {
                let token = value.as_ref().trim();
                if token.is_empty() {
                    Err(KubernetesEffectError::SecretMissing)
                } else {
                    Ok(Some(token.to_owned()))
                }
            }
            FleetSecretResolution::AccessDenied => Err(KubernetesEffectError::SecretDenied),
            FleetSecretResolution::NotFound => Err(KubernetesEffectError::SecretMissing),
        }
    }

    async fn probe(&self, token: Option<&str>) -> Result<(), KubernetesEffectError> {
        let response = self
            .send(
                Method::GET,
                &namespace_path(self.config.namespace()),
                token,
                None,
            )
            .await?;
        ensure_success(response).await.map(|_| ())
    }

    async fn apply(&self, token: Option<&str>) -> Result<(), KubernetesEffectError> {
        let labels = &self.ownership;
        let deployment = deployment_body(&self.config, labels);
        let service = service_body(&self.config, labels);
        self.apply_resource(
            token,
            &format!(
                "/apis/apps/v1/namespaces/{}/deployments",
                path_segment(self.config.namespace())
            ),
            &format!(
                "/apis/apps/v1/namespaces/{}/deployments/{}",
                path_segment(self.config.namespace()),
                path_segment(self.config.deployment_name())
            ),
            deployment,
        )
        .await?;
        self.apply_resource(
            token,
            &format!(
                "/api/v1/namespaces/{}/services",
                path_segment(self.config.namespace())
            ),
            &format!(
                "/api/v1/namespaces/{}/services/{}",
                path_segment(self.config.namespace()),
                path_segment(self.config.service_name())
            ),
            service,
        )
        .await?;
        self.readback_deployment(token).await?;
        self.readback_service(token).await
    }

    async fn apply_resource(
        &self,
        token: Option<&str>,
        collection_path: &str,
        resource_path: &str,
        body: Value,
    ) -> Result<(), KubernetesEffectError> {
        let response = self
            .send(Method::POST, collection_path, token, Some(&body))
            .await?;
        if response.status().is_success() {
            let _ = bounded_bytes(response).await?;
            return Ok(());
        }
        if response.status() != StatusCode::CONFLICT {
            return Err(KubernetesEffectError::RemoteStatus(
                response.status().as_u16(),
            ));
        }
        let existing = self.read_resource(token, resource_path).await?;
        if !owned_labels(&existing, &self.ownership) {
            return Err(KubernetesEffectError::NotOwned);
        }
        let response = self
            .send(Method::PATCH, resource_path, token, Some(&body))
            .await?;
        ensure_success(response).await.map(|_| ())
    }

    async fn delete(
        &self,
        token: Option<&str>,
    ) -> Result<KubernetesEffectOutcome, KubernetesEffectError> {
        let deployment = format!(
            "/apis/apps/v1/namespaces/{}/deployments/{}",
            path_segment(self.config.namespace()),
            path_segment(self.config.deployment_name())
        );
        let service = format!(
            "/api/v1/namespaces/{}/services/{}",
            path_segment(self.config.namespace()),
            path_segment(self.config.service_name())
        );
        let mut absent = true;
        for path in [service, deployment] {
            match self.read_resource_optional(token, &path).await? {
                None => continue,
                Some(value) if !owned_labels(&value, &self.ownership) => {
                    return Err(KubernetesEffectError::NotOwned);
                }
                Some(_) => {
                    absent = false;
                    let response = self.send(Method::DELETE, &path, token, None).await?;
                    if response.status() != StatusCode::NOT_FOUND {
                        ensure_success(response).await?;
                    }
                    self.verify_absent(token, &path).await?;
                }
            }
        }
        Ok(if absent {
            KubernetesEffectOutcome::AlreadyAbsent
        } else {
            KubernetesEffectOutcome::Completed
        })
    }

    async fn readback_deployment(&self, token: Option<&str>) -> Result<(), KubernetesEffectError> {
        let path = format!(
            "/apis/apps/v1/namespaces/{}/deployments/{}",
            path_segment(self.config.namespace()),
            path_segment(self.config.deployment_name())
        );
        let value = self.read_resource(token, &path).await?;
        if !owned_labels(&value, &self.ownership)
            || value.pointer("/spec/template/spec/containers/0/image")
                != Some(&Value::String(self.config.image().to_owned()))
        {
            return Err(KubernetesEffectError::ReadbackMismatch);
        }
        Ok(())
    }

    async fn readback_service(&self, token: Option<&str>) -> Result<(), KubernetesEffectError> {
        let path = format!(
            "/api/v1/namespaces/{}/services/{}",
            path_segment(self.config.namespace()),
            path_segment(self.config.service_name())
        );
        let value = self.read_resource(token, &path).await?;
        if owned_labels(&value, &self.ownership) {
            Ok(())
        } else {
            Err(KubernetesEffectError::ReadbackMismatch)
        }
    }

    async fn read_resource(
        &self,
        token: Option<&str>,
        path: &str,
    ) -> Result<Value, KubernetesEffectError> {
        let response = self.send(Method::GET, path, token, None).await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Err(KubernetesEffectError::RemoteStatus(404));
        }
        bounded_json(ensure_success(response).await?).await
    }

    async fn read_resource_optional(
        &self,
        token: Option<&str>,
        path: &str,
    ) -> Result<Option<Value>, KubernetesEffectError> {
        let response = self.send(Method::GET, path, token, None).await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        Ok(Some(bounded_json(ensure_success(response).await?).await?))
    }

    async fn verify_absent(
        &self,
        token: Option<&str>,
        path: &str,
    ) -> Result<(), KubernetesEffectError> {
        if self.read_resource_optional(token, path).await?.is_none() {
            Ok(())
        } else {
            Err(KubernetesEffectError::ReadbackMismatch)
        }
    }

    async fn send(
        &self,
        method: Method,
        path: &str,
        token: Option<&str>,
        body: Option<&Value>,
    ) -> Result<Response, KubernetesEffectError> {
        let url = self
            .config
            .api_server()
            .parse::<reqwest::Url>()
            .map_err(|_| KubernetesEffectError::InvalidUrl)?
            .join(path.trim_start_matches('/'))
            .map_err(|_| KubernetesEffectError::InvalidUrl)?;
        let mut request = self.client.request(method, url).timeout(REQUEST_TIMEOUT);
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request
                .header(
                    reqwest::header::CONTENT_TYPE,
                    "application/merge-patch+json",
                )
                .json(body);
        }
        request.send().await.map_err(|error| {
            if error.is_timeout() {
                KubernetesEffectError::Timeout
            } else {
                KubernetesEffectError::Network
            }
        })
    }
}

fn deployment_body(config: &KubernetesTargetConfig, labels: &BTreeMap<String, String>) -> Value {
    json!({
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": { "name": config.deployment_name(), "namespace": config.namespace(), "labels": labels },
        "spec": {
            "replicas": 1,
            "selector": { "matchLabels": labels },
            "template": { "metadata": { "labels": labels }, "spec": {
                "containers": [{ "name": "runtime-agent", "image": config.image() }]
            }}
        }
    })
}

fn service_body(config: &KubernetesTargetConfig, labels: &BTreeMap<String, String>) -> Value {
    json!({
        "apiVersion": "v1",
        "kind": "Service",
        "metadata": { "name": config.service_name(), "namespace": config.namespace(), "labels": labels },
        "spec": { "selector": labels, "ports": [{ "name": "http", "port": 8721, "targetPort": 8721 }] }
    })
}

fn valid_ownership(ownership: &BTreeMap<String, String>) -> bool {
    ownership
        .get(MANAGED_LABEL)
        .is_some_and(|value| value == "true")
        && ownership
            .iter()
            .all(|(key, value)| !key.trim().is_empty() && !value.trim().is_empty())
}

fn owned_labels(value: &Value, expected: &BTreeMap<String, String>) -> bool {
    let Some(labels) = value.pointer("/metadata/labels").and_then(Value::as_object) else {
        return false;
    };
    valid_ownership(expected)
        && expected
            .iter()
            .all(|(key, expected)| labels.get(key).and_then(Value::as_str) == Some(expected))
}

fn namespace_path(namespace: &str) -> String {
    format!("/api/v1/namespaces/{}", path_segment(namespace))
}

fn path_segment(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => {
                vec![byte]
            }
            _ => format!("%{byte:02X}").into_bytes(),
        })
        .map(char::from)
        .collect()
}

async fn ensure_success(response: Response) -> Result<Response, KubernetesEffectError> {
    if response.status().is_success() {
        Ok(response)
    } else {
        Err(KubernetesEffectError::RemoteStatus(
            response.status().as_u16(),
        ))
    }
}

async fn bounded_bytes(response: Response) -> Result<Vec<u8>, KubernetesEffectError> {
    let bytes = response
        .bytes()
        .await
        .map_err(|_| KubernetesEffectError::Network)?;
    if bytes.len() > MAX_BODY_BYTES {
        return Err(KubernetesEffectError::BodyTooLarge);
    }
    Ok(bytes.to_vec())
}

async fn bounded_json(response: Response) -> Result<Value, KubernetesEffectError> {
    serde_json::from_slice(&bounded_bytes(response).await?)
        .map_err(|_| KubernetesEffectError::InvalidResponse)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ownership_requires_managed_label() {
        let labels = BTreeMap::from([
            (MANAGED_LABEL.to_owned(), "true".to_owned()),
            (TARGET_LABEL.to_owned(), "node-a".to_owned()),
        ]);
        assert!(owned_labels(
            &json!({"metadata":{"labels":{"com.matchaclaw.remote-fleet.managed":"true","com.matchaclaw.remote-fleet.target":"node-a"}}}),
            &labels
        ));
        assert!(!owned_labels(
            &json!({"metadata":{"labels":{"com.matchaclaw.remote-fleet.managed":"false"}}}),
            &labels
        ));
    }

    #[test]
    fn paths_escape_namespace_and_names() {
        assert_eq!(namespace_path("prod"), "/api/v1/namespaces/prod");
        assert_eq!(path_segment("node-a"), "node-a");
    }

    #[test]
    fn effect_kinds_are_explicit() {
        assert_ne!(KubernetesEffect::Apply, KubernetesEffect::Delete);
        assert_ne!(KubernetesEffect::Pull, KubernetesEffect::Probe);
    }
}
