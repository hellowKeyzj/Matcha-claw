use std::sync::Arc;

use tokio::sync::Mutex;

use crate::{
    facade::{AgentsHandle, SkillsHandle},
    transport::{common::authorization::CapabilityDecisionVerifier, skills::sealed_resource},
};

use super::server::{Request, Response, now_millis};

pub(super) async fn handle_sealed_resource(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    skills: SkillsHandle,
    agents: AgentsHandle,
) -> Response {
    match sealed_resource::handle(
        &request.path,
        &request.method,
        &request.headers,
        &request.body,
        verifier,
        skills,
        agents,
        now_millis(),
    )
    .await
    {
        Ok((status, body)) => Response { status, body },
        Err(sealed_resource::RequestError::Invalid) => Response::sealed_resource_rejected(),
        Err(sealed_resource::RequestError::Unauthorized) => {
            Response::sealed_resource_unauthorized()
        }
        Err(sealed_resource::RequestError::Unavailable) => Response::sealed_resource_unavailable(),
    }
}
