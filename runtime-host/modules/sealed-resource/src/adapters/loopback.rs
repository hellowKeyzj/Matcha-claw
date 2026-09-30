use std::{sync::Arc, time::Duration};

use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{
        BodyPolicy, ModuleDescriptor, ModuleId, Request, RequestHead, Response, RouteDescriptor,
        RouteFuture, RouteHeadPlan,
    },
};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::Mutex;

use crate::{SealedPackageAuthorizationKey, SealedResourceError, SealedResourceModule};

const AUTHORIZE_PACKAGE_ENDPOINT: &str = "/api/sealed-resource/authorize-package";
const AUTHORIZATION_SCOPE: &str = "sealed-resource:package";
const CLOUD_PACKAGES_ENDPOINT: &str = "/api/sealed-resource/cloud-packages";
const CLEAR_AUTHORIZATIONS_ENDPOINT: &str = "/api/sealed-resource/clear-authorizations";
const AUTHORIZATION_SUBJECT: &str = "sealed-resource-keyring";
const DEFAULT_REQUEST_BYTES: usize = 2 * 1024;
const SHORT_DEADLINE: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub(crate) struct Dependencies {
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    sealed_resource: SealedResourceModule,
}

impl Dependencies {
    pub(crate) fn new(
        verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
        sealed_resource: SealedResourceModule,
    ) -> Self {
        Self {
            verifier,
            sealed_resource,
        }
    }
}

pub(crate) fn descriptor(dependencies: Dependencies) -> ModuleDescriptor {
    ModuleDescriptor::new(
        ModuleId::new("sealed-resource"),
        vec![RouteDescriptor::bound(
            "sealed-resource.loopback",
            head_plan,
            move |request| route(dependencies.clone(), request),
        )],
    )
}

fn capability(method: &str, endpoint: &str) -> Option<&'static str> {
    match (method, endpoint) {
        ("POST", AUTHORIZE_PACKAGE_ENDPOINT) => Some("sealedResource.authorizePackage"),
        ("GET", CLOUD_PACKAGES_ENDPOINT) => Some("sealedResource.listCloudPackages"),
        ("POST", CLEAR_AUTHORIZATIONS_ENDPOINT) => Some("sealedResource.clearAuthorizations"),
        _ => None,
    }
}

fn head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    let endpoint = pathname(&head.path);
    capability(&head.method, endpoint)?;
    Some(RouteHeadPlan::body_deadline(
        if endpoint == AUTHORIZE_PACKAGE_ENDPOINT {
            BodyPolicy::Required {
                max_bytes: DEFAULT_REQUEST_BYTES,
            }
        } else {
            BodyPolicy::Empty
        },
        SHORT_DEADLINE,
        timeout_response,
    ))
}

fn route(dependencies: Dependencies, request: Request) -> RouteFuture {
    Box::pin(async move { handle(dependencies, request).await.into() })
}

async fn handle(dependencies: Dependencies, request: Request) -> Response {
    let endpoint = pathname(request.path());
    let Some(capability) = capability(request.method(), endpoint) else {
        return Response::not_found();
    };
    let command = match endpoint {
        AUTHORIZE_PACKAGE_ENDPOINT => "authorizePackage",
        CLOUD_PACKAGES_ENDPOINT => "listCloudPackages",
        _ => "clearAuthorizations",
    };
    let Some(authorization) = request.bearer_authorization() else {
        dependencies.sealed_resource.reject_call(command).await;
        return unauthorized();
    };
    if dependencies
        .verifier
        .lock()
        .await
        .verify(
            authorization,
            now_millis(),
            endpoint,
            AUTHORIZATION_SCOPE,
            capability,
            AUTHORIZATION_SUBJECT,
        )
        .is_err()
    {
        dependencies.sealed_resource.reject_call(command).await;
        return unauthorized();
    }

    if endpoint != AUTHORIZE_PACKAGE_ENDPOINT && !request.body.is_empty() {
        dependencies.sealed_resource.reject_call(command).await;
        return rejected();
    }
    if endpoint == CLOUD_PACKAGES_ENDPOINT {
        return match dependencies.sealed_resource.list_cloud_packages().await {
            Ok(packages) => Response::json(200, json!({ "packages": packages })),
            Err(_) => Response::json(503, json!({ "packages": [] })),
        };
    }
    if endpoint == CLEAR_AUTHORIZATIONS_ENDPOINT {
        return match dependencies.sealed_resource.clear_authorizations().await {
            Ok(()) => Response::json(200, json!({ "outcome": "accepted" })),
            Err(_) => Response::json(503, json!({ "outcome": "unknown" })),
        };
    }

    let request = match serde_json::from_slice::<AuthorizePackageRequest>(&request.body) {
        Ok(request) => request,
        Err(_) => {
            dependencies.sealed_resource.reject_call("authorizePackage").await;
            return rejected();
        }
    };
    match authorize_package(dependencies.sealed_resource, request).await {
        Ok(()) => Response::json(200, json!({ "outcome": "accepted" })),
        Err(SealedResourceError::Unknown) => Response::json(503, json!({ "outcome": "unknown" })),
        Err(_) => rejected(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthorizePackageRequest {
    package_sha256: String,
    authorization_key: String,
    lease_expires_at: String,
}

async fn authorize_package(
    sealed_resource: SealedResourceModule,
    request: AuthorizePackageRequest,
) -> Result<(), SealedResourceError> {
    let authorization_key = SealedPackageAuthorizationKey::from_base64(&request.authorization_key);
    let lease_expires_at_ms = lease_expires_at_ms(&request.lease_expires_at);
    sealed_resource.authorize_package(
        request.package_sha256,
        authorization_key,
        lease_expires_at_ms,
    ).await
}

fn lease_expires_at_ms(value: &str) -> Result<u64, SealedResourceError> {
    let value = chrono::DateTime::parse_from_rfc3339(value)
        .map_err(|_| SealedResourceError::Rejected)?
        .timestamp_millis();
    value.try_into().map_err(|_| SealedResourceError::Rejected)
}

fn unauthorized() -> Response {
    Response::error(401, "Sealed resource authorization is invalid")
}

fn rejected() -> Response {
    Response::json(400, json!({ "outcome": "rejected" }))
}

fn timeout_response() -> Response {
    Response::json(
        503,
        json!({ "success": false, "error": "Runtime Host request deadline exceeded" }),
    )
}

fn pathname(path: &str) -> &str {
    path.split_once('?').map_or(path, |(path, _)| path)
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::{Signer as _, SigningKey};
    use platform::state_dir::CanonicalStateDir;

    use super::*;
    use crate::{
        AgentKey, SealedAgentRuntimeProjection, SealedCloudPackageMetadata, SealedCloudPackageType,
        SealedSkillTarget, SkillKey,
        package::{
            agent::{SealedAgentFileRequest, SealedAgentPackage},
            skill::{SealedSkillFileRequest, SealedSkillPackage},
        },
    };

    struct Runtime(PathBuf);

    impl SealedAgentRuntimeProjection for Runtime {
        fn workspace_directory(&self, _: &str) -> Result<PathBuf, SealedResourceError> {
            Ok(self.0.clone())
        }

        fn maintenance_workspace_directories(&self) -> Result<Vec<PathBuf>, SealedResourceError> {
            Ok(vec![self.0.clone(), self.0.clone()])
        }
    }

    fn dependencies(root: &std::path::Path) -> Dependencies {
        let key = SigningKey::from_bytes(&[37; 32]);
        let mut public = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        public.extend_from_slice(key.verifying_key().as_bytes());
        Dependencies::new(
            Arc::new(Mutex::new(
                CapabilityDecisionVerifier::try_new(&URL_SAFE_NO_PAD.encode(public)).unwrap(),
            )),
            SealedResourceModule::openclaw(
                CanonicalStateDir::provision(root.join("state")).unwrap(),
                Arc::new(Runtime(root.join("agent"))),
                root.join("skill-private"),
                root.join("agent-private"),
                Some(Arc::from("runtime-token")),
            )
            .unwrap(),
        )
    }

    fn request(
        method: &str,
        endpoint: &str,
        signed_capability: Option<&str>,
        body: serde_json::Value,
    ) -> Request {
        let headers = signed_capability.map(|capability| {
            let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&json!({
                "version": 1, "principal": "test", "endpoint": endpoint,
                "scope": AUTHORIZATION_SCOPE, "capability": capability, "subject": AUTHORIZATION_SUBJECT,
                "expiresAt": now_millis() + 60_000, "correlation": format!("{endpoint}-{capability}"), "revision": "1",
            })).unwrap());
            let signed = format!("capability-decision.v1.{payload}");
            let signature = SigningKey::from_bytes(&[37; 32]).sign(signed.as_bytes());
            vec![("authorization".into(), format!("Bearer {signed}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()))) ]
        }).unwrap_or_default();
        Request {
            head: RequestHead::new(method.into(), endpoint.into(), headers, false, None, None),
            body: if body.is_null() {
                vec![]
            } else {
                serde_json::to_vec(&body).unwrap()
            },
        }
    }

    #[tokio::test]
    async fn directory_and_clear_are_protected_and_project_only_installed_cloud_metadata() {
        let root = tempfile::tempdir().unwrap();
        let dependencies = dependencies(root.path());
        let module = &dependencies.sealed_resource;
        let receipt = SealedSkillPackage::seal(
            SkillKey::parse("cloud-skill").unwrap(),
            SealedSkillTarget::OpenClaw,
            vec![
                SealedSkillFileRequest::try_new(
                    "SKILL.md",
                    "---\nname: Cloud\ndescription: test\n---\nsecret skill body",
                )
                .unwrap(),
            ],
        )
        .unwrap();
        let path = root.path().join(receipt.package_file_name());
        fs::write(&path, receipt.package_bytes()).unwrap();
        let authorize = handle(dependencies.clone(), request("POST", AUTHORIZE_PACKAGE_ENDPOINT,
            Some("sealedResource.authorizePackage"), json!({
                "packageSha256": receipt.package_sha256(), "authorizationKey": receipt.authorization_key().to_base64(),
                "leaseExpiresAt": chrono::DateTime::from_timestamp_millis((now_millis() + 60_000) as i64).unwrap().to_rfc3339(),
            }),
        )).await;
        assert_eq!(authorize.status(), 200);
        module
            .install_skill_package_path_with_cloud_metadata(
                path,
                SealedCloudPackageMetadata::new(
                    "skill-version".into(),
                    SealedCloudPackageType::Skill,
                    receipt.package_sha256().into(),
                    receipt.package_file_name().into(),
                    1,
                )
                .unwrap(),
            )
            .unwrap();
        fs::copy(
            root.path()
                .join("state/skills")
                .join(receipt.package_file_name()),
            root.path().join("state/skills/duplicate.matcha-skillpkg"),
        )
        .unwrap();

        let agent = SealedAgentPackage::seal(
            AgentKey::parse("writer").unwrap(),
            crate::SealedAgentTarget::OpenClaw,
            vec![SealedAgentFileRequest::try_new("AGENTS.md", "secret agent body").unwrap()],
        )
        .unwrap();
        let path = root.path().join(agent.package_file_name());
        fs::write(&path, agent.package_bytes()).unwrap();
        module
            .register_authorization_key(
                agent.package_sha256().into(),
                agent.authorization_key().clone(),
                now_millis() + 60_000,
            )
            .unwrap();
        module
            .install_agent_package_path_with_cloud_metadata(
                path,
                SealedCloudPackageMetadata::new(
                    "agent-version".into(),
                    SealedCloudPackageType::Agent,
                    agent.package_sha256().into(),
                    agent.package_file_name().into(),
                    1,
                )
                .unwrap(),
            )
            .unwrap();
        let local = root.path().join("state/skills/local-skill");
        fs::create_dir(&local).unwrap();
        fs::write(
            local.join("SKILL.md"),
            "---\nname: Local\ndescription: test\n---\nlocal secret",
        )
        .unwrap();
        module
            .skills_port()
            .export_sealed_skill_package("local-skill".into())
            .unwrap();
        // Orphan metadata must not become an installed package.
        fs::write(
            root.path()
                .join("skill-private")
                .join(format!("{}.cloud-metadata.json", "a".repeat(64))),
            serde_json::to_vec(
                &SealedCloudPackageMetadata::new(
                    "orphan".into(),
                    SealedCloudPackageType::Skill,
                    "a".repeat(64),
                    "orphan.matcha-skillpkg".into(),
                    1,
                )
                .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();

        for (method, endpoint) in [
            ("GET", CLOUD_PACKAGES_ENDPOINT),
            ("POST", CLEAR_AUTHORIZATIONS_ENDPOINT),
        ] {
            assert_eq!(
                handle(
                    dependencies.clone(),
                    request(method, endpoint, None, json!(null))
                )
                .await
                .status(),
                401
            );
            assert_eq!(
                handle(
                    dependencies.clone(),
                    request(
                        method,
                        endpoint,
                        Some("sealedResource.authorizePackage"),
                        json!(null)
                    )
                )
                .await
                .status(),
                401
            );
        }
        let cleared = handle(
            dependencies.clone(),
            request(
                "POST",
                CLEAR_AUTHORIZATIONS_ENDPOINT,
                Some("sealedResource.clearAuthorizations"),
                json!(null),
            ),
        )
        .await;
        assert_eq!(cleared.status(), 200);
        assert_eq!(cleared.body(), &json!({"outcome": "accepted"}));
        assert_eq!(
            module
                .agents_port()
                .read_file("runtime-token", "writer".into(), "AGENTS.md".into())
                .unwrap_err(),
            subagents::SealedAgentError::Rejected
        );
        let listed = handle(
            dependencies.clone(),
            request(
                "GET",
                CLOUD_PACKAGES_ENDPOINT,
                Some("sealedResource.listCloudPackages"),
                json!(null),
            ),
        )
        .await;
        assert_eq!(listed.status(), 200);
        let packages = listed.body()["packages"].as_array().unwrap();
        assert_eq!(packages.len(), 2);
        assert!(packages.contains(&json!({"packageVersionId": "skill-version", "packageType": "skill", "packageSha256": receipt.package_sha256(), "fileName": receipt.package_file_name()})));
        assert!(packages.contains(&json!({"packageVersionId": "agent-version", "packageType": "agent", "packageSha256": agent.package_sha256(), "fileName": agent.package_file_name()})));
        assert!(!listed.body().to_string().contains("secret"));
        fs::remove_file(root.path().join("state/skills/duplicate.matcha-skillpkg")).unwrap();
        assert!(
            module
                .skills_port()
                .read_sealed_skill_file("runtime-token", "local-skill".into(), "SKILL.md".into(), None)
                .is_ok()
        );
        assert!(
            module
                .skills_port()
                .read_sealed_skill_file("runtime-token", "cloud-skill".into(), "SKILL.md".into(), None)
                .is_err()
        );
    }

    #[test]
    fn route_heads_and_authorization_require_the_frozen_contract() {
        for (method, endpoint) in [
            ("GET", CLOUD_PACKAGES_ENDPOINT),
            ("POST", CLEAR_AUTHORIZATIONS_ENDPOINT),
        ] {
            let request = request(method, endpoint, None, json!(null));
            assert!(matches!(
                head_plan(&request.head).unwrap().body_policy(),
                BodyPolicy::Empty
            ));
        }
        assert!(
            head_plan(&request("POST", CLOUD_PACKAGES_ENDPOINT, None, json!(null)).head).is_none()
        );
        assert!(
            serde_json::from_value::<AuthorizePackageRequest>(
                json!({"packageSha256": "a".repeat(64), "authorizationKey": "b".repeat(43)})
            )
            .is_err()
        );
        assert!(serde_json::from_value::<AuthorizePackageRequest>(json!({"packageSha256": "a".repeat(64), "authorizationKey": "b".repeat(43), "leaseExpiresAt": "bad", "extra": true})).is_err());
        assert_eq!(
            lease_expires_at_ms("bad").unwrap_err(),
            SealedResourceError::Rejected
        );
    }
}
