use std::sync::Arc;

use tokio::sync::Mutex;

use crate::{
    facade::SkillsHandle,
    transport::{
        common::authorization::CapabilityDecisionVerifier,
        skills::{bundle as skill_bundle, management as skills},
    },
};

use super::handler::{Request, Response, now_millis};

pub(super) async fn handle_status(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    skills: SkillsHandle,
) -> Response {
    match skills::handle_status(&request.headers, verifier, skills, now_millis()).await {
        Ok(body) => Response { status: 200, body },
        Err(skills::RequestError::Unauthorized) => Response::skills_unauthorized(),
        Err(skills::RequestError::Invalid) => Response::skills_unavailable(),
    }
}

pub(super) async fn handle_management(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    skills: SkillsHandle,
) -> Response {
    match skills::handle_management(
        &request.path,
        &request.headers,
        &request.body,
        verifier,
        skills,
        now_millis(),
    )
    .await
    {
        Ok(outcome) => {
            let (status, body) = skills::response(outcome);
            Response { status, body }
        }
        Err(skills::RequestError::Invalid) => Response::skills_rejected(),
        Err(skills::RequestError::Unauthorized) => Response::skills_management_unauthorized(),
    }
}

pub(super) async fn handle_bundle_export(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    skills: SkillsHandle,
) -> Response {
    match skill_bundle::export(
        &request.headers,
        &request.body,
        verifier,
        skills,
        now_millis(),
    )
    .await
    {
        Ok(delivery) => Response::skill_bundle_delivery(delivery),
        Err(skill_bundle::RequestError::Invalid) => Response::skill_bundle_bad_request(),
        Err(skill_bundle::RequestError::Unauthorized) => Response::skill_bundle_unauthorized(),
    }
}

pub(super) async fn handle_bundle_import(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    skills: SkillsHandle,
) -> Response {
    match skill_bundle::import(
        &request.headers,
        &request.body,
        verifier,
        skills,
        now_millis(),
    )
    .await
    {
        Ok(delivery) => Response::skill_bundle_delivery(delivery),
        Err(skill_bundle::RequestError::Invalid) => Response::skill_bundle_bad_request(),
        Err(skill_bundle::RequestError::Unauthorized) => Response::skill_bundle_unauthorized(),
    }
}
