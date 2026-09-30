use std::{sync::Arc, time::Duration};

use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{
        BodyPolicy, ModuleDescriptor, ModuleId, Request, RequestHead, Response, RouteDescriptor,
        RouteFuture, RouteHeadPlan,
    },
};
use tokio::sync::Mutex;

use crate::SkillsModule;

mod bundle;
mod clawhub_search;
mod clawhub_skill;
mod management;
mod result;
mod sealed_resource;

const DEFAULT_REQUEST_BYTES: usize = 64 * 1024;
const SHORT_DEADLINE: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct Dependencies {
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    skills: SkillsModule,
}

impl Dependencies {
    pub fn new(verifier: Arc<Mutex<CapabilityDecisionVerifier>>, skills: SkillsModule) -> Self {
        Self { verifier, skills }
    }
}

pub fn descriptor(dependencies: Dependencies) -> ModuleDescriptor {
    ModuleDescriptor::new(
        ModuleId::new("skills"),
        vec![RouteDescriptor::bound(
            "skills.loopback",
            head_plan,
            move |request| route(dependencies.clone(), request),
        )],
    )
}

fn head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    let path = pathname(&head.path);
    is_route(path).then(|| {
        RouteHeadPlan::body_deadline(
            body_policy_for_method(head.method.as_str()),
            SHORT_DEADLINE,
            timeout_response,
        )
    })
}

fn route(dependencies: Dependencies, request: Request) -> RouteFuture {
    Box::pin(async move {
        let path = pathname(request.path()).to_owned();
        let recorded = match (
            &dependencies.skills.recorder,
            crate::call::request(&path, &request.body),
        ) {
            (Some(recorder), Some((command, detail))) => {
                match recorder.begin(command, &detail).await {
                    Ok(context) => Some(crate::operation::RecordedCall {
                        context,
                        detail,
                        command,
                        accepted: Arc::new(tokio::sync::OnceCell::new()),
                    }),
                    Err(_) => return fixed(503, "Skills call recording is unavailable").into(),
                }
            }
            _ => None,
        };
        if let Some(call) = &recorded {
            if !is_long_operation(&path, &request.body) && call.context.running().await.is_err() {
                return fixed(503, "Skills call recording is unavailable").into();
            }
        }
        let mut response = match (request.method(), path.as_str()) {
            ("POST", result::ENDPOINT | result::PRIVATE_ENDPOINT) => {
                result::handle(request, dependencies.verifier, dependencies.skills).await
            }
            ("GET", management::ENDPOINT) => {
                handle_status(request, dependencies.verifier, dependencies.skills).await
            }
            ("POST", management::CAPABILITY_EXECUTE_ENDPOINT) => {
                handle_capability_execute(
                    request,
                    dependencies.verifier,
                    dependencies.skills,
                    recorded.clone(),
                )
                .await
            }
            ("POST", management::DETAIL_ENDPOINT)
            | ("POST", management::CONFIG_ENDPOINT)
            | ("POST", management::CLAWHUB_INSTALL_ENDPOINT)
            | ("POST", management::CLAWHUB_UPDATE_ENDPOINT)
            | ("POST", management::UPLOAD_BEGIN_ENDPOINT)
            | ("POST", management::UPLOAD_CHUNK_ENDPOINT)
            | ("POST", management::UPLOAD_COMMIT_ENDPOINT)
            | ("POST", management::UNINSTALL_ENDPOINT)
            | ("POST", management::IMPORT_MARKDOWN_ENDPOINT)
            | ("POST", management::IMPORT_BUNDLE_ENDPOINT)
            | ("POST", management::README_ENDPOINT) => {
                handle_management(
                    request,
                    dependencies.verifier,
                    dependencies.skills,
                    recorded.clone(),
                )
                .await
            }
            ("POST", clawhub_search::ENDPOINT) => {
                handle_clawhub_search(request, dependencies.verifier, dependencies.skills).await
            }
            ("POST", clawhub_skill::ENDPOINT) => {
                handle_clawhub_skill_install(
                    request,
                    dependencies.verifier,
                    dependencies.skills,
                    recorded.clone(),
                )
                .await
            }
            ("POST", bundle::EXPORT_ENDPOINT) => {
                handle_bundle_export(
                    request,
                    dependencies.verifier,
                    dependencies.skills,
                    recorded.clone(),
                )
                .await
            }
            ("POST", bundle::IMPORT_ENDPOINT) => {
                handle_bundle_import(
                    request,
                    dependencies.verifier,
                    dependencies.skills,
                    recorded.clone(),
                )
                .await
            }
            ("GET", sealed_resource::STATUS_ENDPOINT)
            | ("POST", sealed_resource::EXPORT_ENDPOINT)
            | ("POST", sealed_resource::EXPORT_CLOUD_ENDPOINT)
            | ("POST", sealed_resource::INSTALL_ENDPOINT)
            | ("POST", sealed_resource::UNINSTALL_ENDPOINT) => {
                handle_sealed_resource(
                    request,
                    dependencies.verifier,
                    dependencies.skills,
                    recorded.clone(),
                )
                .await
            }
            ("GET", path) if path.starts_with(sealed_resource::READ_ENDPOINT_PREFIX) => {
                handle_sealed_resource(
                    request,
                    dependencies.verifier,
                    dependencies.skills,
                    recorded.clone(),
                )
                .await
            }
            _ => Response::json(
                404,
                serde_json::json!({ "success": false, "error": not_found_error(&path) }),
            ),
        };
        if let Some(call) = recorded {
            response = response.with_header("X-Matcha-Call-Id", call.context.id().as_str());
            if response.status() != 202 {
                let (status, detail) = crate::call::terminal(call.detail, &response);
                if let Err(error) = call.context.finish(status, &detail).await {
                    eprintln!("[skills-call] terminal transition failed: {error}");
                }
            }
        }
        response.into()
    })
}

fn is_long_operation(path: &str, body: &[u8]) -> bool {
    matches!(
        path,
        management::CLAWHUB_INSTALL_ENDPOINT
            | management::CLAWHUB_UPDATE_ENDPOINT
            | management::IMPORT_MARKDOWN_ENDPOINT
            | management::IMPORT_BUNDLE_ENDPOINT
            | clawhub_skill::ENDPOINT
            | bundle::IMPORT_ENDPOINT
            | bundle::EXPORT_ENDPOINT
            | management::CONFIG_ENDPOINT
            | management::UPLOAD_COMMIT_ENDPOINT
            | management::UNINSTALL_ENDPOINT
            | sealed_resource::INSTALL_ENDPOINT
            | sealed_resource::EXPORT_ENDPOINT
            | sealed_resource::EXPORT_CLOUD_ENDPOINT
            | sealed_resource::UNINSTALL_ENDPOINT
    ) || path == management::CAPABILITY_EXECUTE_ENDPOINT
        && serde_json::from_slice::<serde_json::Value>(body)
            .ok()
            .and_then(|value| {
                value
                    .get("operationId")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .as_deref()
            .is_some_and(|operation| {
                matches!(
                    operation,
                    "skills.importBundles"
                        | "skills.exportBundles"
                        | "skills.updateConfig"
                        | "skills.updateState"
                        | "skills.updateBatchState"
                )
            })
}

fn body_policy_for_method(method: &str) -> BodyPolicy {
    if method == "GET" {
        BodyPolicy::Empty
    } else if method == "POST" {
        BodyPolicy::Required {
            max_bytes: DEFAULT_REQUEST_BYTES,
        }
    } else {
        BodyPolicy::Optional {
            max_bytes: DEFAULT_REQUEST_BYTES,
        }
    }
}

fn timeout_response() -> Response {
    Response::json(
        503,
        serde_json::json!({ "success": false, "error": "Runtime Host request deadline exceeded" }),
    )
}

fn is_route(path: &str) -> bool {
    path.starts_with(sealed_resource::READ_ENDPOINT_PREFIX)
        || matches!(
            path,
            management::ENDPOINT
                | result::ENDPOINT
                | result::PRIVATE_ENDPOINT
                | management::CAPABILITY_EXECUTE_ENDPOINT
                | management::DETAIL_ENDPOINT
                | management::CONFIG_ENDPOINT
                | management::CLAWHUB_INSTALL_ENDPOINT
                | management::CLAWHUB_UPDATE_ENDPOINT
                | management::UPLOAD_BEGIN_ENDPOINT
                | management::UPLOAD_CHUNK_ENDPOINT
                | management::UPLOAD_COMMIT_ENDPOINT
                | management::UNINSTALL_ENDPOINT
                | management::IMPORT_MARKDOWN_ENDPOINT
                | management::IMPORT_BUNDLE_ENDPOINT
                | management::README_ENDPOINT
                | clawhub_search::ENDPOINT
                | clawhub_skill::ENDPOINT
                | bundle::EXPORT_ENDPOINT
                | bundle::IMPORT_ENDPOINT
                | sealed_resource::STATUS_ENDPOINT
                | sealed_resource::EXPORT_ENDPOINT
                | sealed_resource::EXPORT_CLOUD_ENDPOINT
                | sealed_resource::INSTALL_ENDPOINT
                | sealed_resource::UNINSTALL_ENDPOINT
        )
}

fn not_found_error(path: &str) -> &'static str {
    match path {
        clawhub_search::ENDPOINT => "ClawHub search route is not available",
        clawhub_skill::ENDPOINT => "ClawHub skill install route is not available",
        management::ENDPOINT => "Skills status route is not available",
        management::CAPABILITY_EXECUTE_ENDPOINT => "Skills capability route is not available",
        management::DETAIL_ENDPOINT
        | management::CONFIG_ENDPOINT
        | management::CLAWHUB_INSTALL_ENDPOINT
        | management::CLAWHUB_UPDATE_ENDPOINT
        | management::UPLOAD_BEGIN_ENDPOINT
        | management::UPLOAD_CHUNK_ENDPOINT
        | management::UPLOAD_COMMIT_ENDPOINT
        | management::UNINSTALL_ENDPOINT
        | management::IMPORT_MARKDOWN_ENDPOINT
        | management::IMPORT_BUNDLE_ENDPOINT
        | management::README_ENDPOINT => "Skills management route is not available",
        bundle::EXPORT_ENDPOINT | bundle::IMPORT_ENDPOINT => {
            "Subagent skill bundle route is not available"
        }
        sealed_resource::STATUS_ENDPOINT
        | sealed_resource::EXPORT_ENDPOINT
        | sealed_resource::EXPORT_CLOUD_ENDPOINT
        | sealed_resource::INSTALL_ENDPOINT
        | sealed_resource::UNINSTALL_ENDPOINT => "Sealed skills route is not available",
        path if path.starts_with(sealed_resource::READ_ENDPOINT_PREFIX) => {
            "Sealed resource route is not available"
        }
        _ => "Catalog surface route is not available",
    }
}

async fn handle_status(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    skills: SkillsModule,
) -> Response {
    match management::handle_status(&request.head.headers, verifier, skills, now_millis()).await {
        Ok(body) => Response::json(200, body),
        Err(management::RequestError::Admission(error)) => admission_response(error),
        Err(management::RequestError::Unauthorized) => {
            fixed(401, "Skills status authorization is invalid")
        }
        Err(management::RequestError::Invalid) => {
            Response::json(503, serde_json::json!({ "outcome": "unknown" }))
        }
    }
}

async fn handle_management(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    skills: SkillsModule,
    call: Option<crate::operation::RecordedCall>,
) -> Response {
    match management::handle_management(
        request.path(),
        &request.head.headers,
        &request.body,
        verifier,
        skills,
        now_millis(),
        call,
    )
    .await
    {
        Ok((status, body)) => Response::json(status, body),
        Err(management::RequestError::Invalid) => {
            Response::json(400, serde_json::json!({ "outcome": "rejected" }))
        }
        Err(management::RequestError::Admission(error)) => admission_response(error),
        Err(management::RequestError::Unauthorized) => {
            fixed(401, "Skills management authorization is invalid")
        }
    }
}

async fn handle_capability_execute(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    skills: SkillsModule,
    call: Option<crate::operation::RecordedCall>,
) -> Response {
    match management::handle_capability_execute(
        &request.head.headers,
        &request.body,
        verifier,
        skills,
        now_millis(),
        call,
    )
    .await
    {
        Ok(outcome) => capability_response(outcome),
        Err(management::RequestError::Invalid) => {
            Response::json(400, serde_json::json!({ "outcome": "rejected" }))
        }
        Err(management::RequestError::Admission(error)) => admission_response(error),
        Err(management::RequestError::Unauthorized) => {
            fixed(401, "Skills capability authorization is invalid")
        }
    }
}

fn capability_response(outcome: crate::control::ManagementOutcome) -> Response {
    match outcome {
        crate::control::ManagementOutcome::Succeeded(body) => {
            let status = if body.get("callId").is_some() {
                202
            } else {
                200
            };
            Response::json(status, body)
        }
        crate::control::ManagementOutcome::Unknown(body) => Response::json(503, body),
        crate::control::ManagementOutcome::InvalidInput => {
            Response::json(400, serde_json::json!({ "outcome": "rejected" }))
        }
        crate::control::ManagementOutcome::Rejected(_) => {
            Response::json(400, serde_json::json!({ "outcome": "rejected" }))
        }
        crate::control::ManagementOutcome::Unavailable
        | crate::control::ManagementOutcome::InternalError => {
            Response::json(503, serde_json::json!({ "outcome": "unknown" }))
        }
    }
}

async fn handle_clawhub_search(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    skills: SkillsModule,
) -> Response {
    match clawhub_search::handle(
        &request.head.headers,
        &request.body,
        verifier,
        skills,
        now_millis(),
    )
    .await
    {
        Ok(delivery) => Response::json(delivery.status_code(), delivery.body()),
        Err(clawhub_search::RequestError::Invalid) => {
            fixed(400, clawhub_search::invalid_request_error())
        }
        Err(clawhub_search::RequestError::Unauthorized) => {
            fixed(401, "ClawHub search authorization is invalid")
        }
    }
}

async fn handle_clawhub_skill_install(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    skills: SkillsModule,
    call: Option<crate::operation::RecordedCall>,
) -> Response {
    match clawhub_skill::handle(
        &request.head.headers,
        &request.body,
        verifier,
        skills,
        now_millis(),
        call,
    )
    .await
    {
        Ok(delivery) => Response::json(delivery.status_code(), delivery.body()),
        Err(clawhub_skill::RequestError::Invalid) => {
            fixed(400, "ClawHub skill install request is invalid")
        }
        Err(clawhub_skill::RequestError::Admission(error)) => admission_response(error),
        Err(clawhub_skill::RequestError::Unauthorized) => {
            fixed(401, "ClawHub skill install authorization is invalid")
        }
    }
}

async fn handle_bundle_export(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    skills: SkillsModule,
    call: Option<crate::operation::RecordedCall>,
) -> Response {
    match bundle::export(
        &request.head.headers,
        &request.body,
        verifier,
        skills,
        now_millis(),
        call,
    )
    .await
    {
        Ok((status, body)) => Response::json(status, body),
        Err(bundle::RequestError::Invalid) => {
            fixed(400, "Subagent skill bundle request is invalid")
        }
        Err(bundle::RequestError::Admission(error)) => admission_response(error),
        Err(bundle::RequestError::Unauthorized) => {
            fixed(401, "Subagent skill bundle authorization is invalid")
        }
    }
}

async fn handle_bundle_import(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    skills: SkillsModule,
    call: Option<crate::operation::RecordedCall>,
) -> Response {
    match bundle::import(
        &request.head.headers,
        &request.body,
        verifier,
        skills,
        now_millis(),
        call,
    )
    .await
    {
        Ok((status, body)) => Response::json(status, body),
        Err(bundle::RequestError::Invalid) => {
            fixed(400, "Subagent skill bundle request is invalid")
        }
        Err(bundle::RequestError::Admission(error)) => admission_response(error),
        Err(bundle::RequestError::Unauthorized) => {
            fixed(401, "Subagent skill bundle authorization is invalid")
        }
    }
}

async fn handle_sealed_resource(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    skills: SkillsModule,
    call: Option<crate::operation::RecordedCall>,
) -> Response {
    match sealed_resource::handle(
        request.path(),
        request.method(),
        &request.head.headers,
        &request.body,
        verifier,
        skills,
        now_millis(),
        call,
    )
    .await
    {
        Ok((status, body)) => Response::json(status, body),
        Err(sealed_resource::RequestError::Invalid) => {
            Response::json(400, serde_json::json!({ "outcome": "rejected" }))
        }
        Err(sealed_resource::RequestError::Admission(error)) => admission_response(error),
        Err(sealed_resource::RequestError::Unauthorized) => {
            fixed(401, "Sealed resource authorization is invalid")
        }
        Err(sealed_resource::RequestError::Unavailable) => {
            Response::json(503, serde_json::json!({ "outcome": "unknown" }))
        }
    }
}

fn admission_response(error: platform::call::CallLogError) -> Response {
    Response::json(
        503,
        serde_json::json!({ "outcome": "rejected", "error": error.to_string() }),
    )
}

fn fixed(status: u16, error: &'static str) -> Response {
    Response::json(
        status,
        serde_json::json!({ "success": false, "error": error }),
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
