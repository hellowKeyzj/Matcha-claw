use platform::{
    call::CallId,
    loopback::{Request, Response},
};
use serde::Deserialize;

use super::{AUTHORIZATION_SCOPE, AUTHORIZATION_SUBJECT, Dependencies, Endpoint, Operation};
use crate::application::results::{ResultRead, ResultSubject};

pub(super) const ENDPOINT: &str = "/api/subagents/results";
pub(super) const PRIVATE_ENDPOINT: &str = "/api/subagents/package-artifacts";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResultRequest {
    call_id: CallId,
    operation_id: String,
    endpoint: Endpoint,
    agent_id: Option<String>,
}

pub(super) async fn handle(request: Request, dependencies: Dependencies) -> Response {
    if request.method() != "POST" {
        return error(404, "Subagent route is not available");
    }
    let Some(authorization) = super::header_value(request.headers(), "authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
    else {
        return error(401, "Subagent authorization is invalid");
    };
    let Ok(input) = serde_json::from_slice::<ResultRequest>(&request.body) else {
        return error(400, "Subagent result request is invalid");
    };
    let Some(operation) = Operation::parse(&input.operation_id) else {
        return error(400, "Subagent result request is invalid");
    };
    let private = super::pathname(request.path()) == PRIVATE_ENDPOINT;
    if private
        && !matches!(
            operation,
            Operation::PackageExport | Operation::PackageExportCloud
        )
    {
        return error(400, "Subagent artifact request is invalid");
    }
    let requires_agent = match operation {
        Operation::Create | Operation::PackageInstall => false,
        Operation::Update
        | Operation::Delete
        | Operation::SetDescription
        | Operation::SetConfigurationModel
        | Operation::SetSkills
        | Operation::SetSkillConfiguration
        | Operation::SetToolConfiguration
        | Operation::PackageExport
        | Operation::PackageExportCloud => true,
        _ => return error(400, "Subagent result request is invalid"),
    };
    if !input.endpoint.is_supported()
        || (operation.requires_openclaw() && input.endpoint.runtime_adapter_id != "openclaw")
        || requires_agent != input.agent_id.is_some()
        || input
            .agent_id
            .as_deref()
            .is_some_and(|id| !super::valid_id(id))
    {
        return error(400, "Subagent result request is invalid");
    }
    let decision = {
        let mut verifier = dependencies.verifier.lock().await;
        verifier.verify(
            authorization,
            super::handler::now_millis(),
            if private { PRIVATE_ENDPOINT } else { ENDPOINT },
            AUTHORIZATION_SCOPE,
            operation.capability_id(),
            AUTHORIZATION_SUBJECT,
        )
    };
    let Ok(decision) = decision else {
        return error(401, "Subagent authorization is invalid");
    };
    if private && decision.principal() != "electron-main-local" {
        return error(401, "Subagent authorization is invalid");
    }
    let subject = ResultSubject {
        principal: decision.principal().to_owned(),
        operation: input.operation_id.clone(),
        endpoint: input.endpoint.native_endpoint(),
        agent_id: input.agent_id,
    };
    match dependencies.subagents.read_result(&input.call_id, &subject) {
        ResultRead::Missing => error(404, "Subagent result is unavailable or expired"),
        ResultRead::Pending => error(409, "Subagent result is not ready"),
        ResultRead::Completed(result) => {
            if private {
                use base64::{Engine as _, engine::general_purpose::STANDARD};
                let crate::application::results::MutationResult::PackageExported(package) =
                    result.as_ref()
                else {
                    return error(409, "Subagent package artifact is unavailable");
                };
                return Response::json(
                    200,
                    serde_json::json!({
                        "callId": input.call_id, "operationId": input.operation_id,
                        "package": {
                            "agentId": package.agent_id(), "fileName": package.file_name(),
                            "size": package.size(), "exportedAtMs": package.exported_at_ms(),
                            "packageSha256": package.package_sha256(),
                            "packageBase64": STANDARD.encode(package.package_bytes()),
                        },
                    }),
                );
            }
            let delivery = result.delivery();
            Response::json(
                200,
                serde_json::json!({
                    "callId": input.call_id, "operationId": input.operation_id,
                    "status": delivery.status_code(), "body": delivery.body(),
                }),
            )
        }
    }
}

fn error(status: u16, message: &'static str) -> Response {
    Response::json(
        status,
        serde_json::json!({ "success": false, "error": message }),
    )
}
