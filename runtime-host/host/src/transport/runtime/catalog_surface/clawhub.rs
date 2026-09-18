use std::sync::Arc;

use ::clawhub::ClawHubRegistryClient;
use tokio::sync::Mutex;

use crate::{
    facade::SkillsHandle,
    transport::{
        common::authorization::CapabilityDecisionVerifier,
        skills::{clawhub_search, clawhub_skill},
    },
};

use super::handler::{Request, Response, now_millis};

pub(super) async fn handle_search(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    clawhub_registry: ClawHubRegistryClient,
) -> Response {
    match clawhub_search::handle(
        &request.headers,
        &request.body,
        verifier,
        clawhub_registry,
        now_millis(),
    )
    .await
    {
        Ok(delivery) => Response::from_clawhub_search_delivery(delivery),
        Err(clawhub_search::RequestError::Invalid) => Response::clawhub_search_bad_request(),
        Err(clawhub_search::RequestError::Unauthorized) => Response::clawhub_search_unauthorized(),
    }
}

pub(super) async fn handle_skill_install(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    skills: SkillsHandle,
) -> Response {
    match clawhub_skill::handle(
        &request.headers,
        &request.body,
        verifier,
        skills,
        now_millis(),
    )
    .await
    {
        Ok(delivery) => Response::from_clawhub_skill_delivery(delivery),
        Err(clawhub_skill::RequestError::Invalid) => Response::clawhub_skill_bad_request(),
        Err(clawhub_skill::RequestError::Unauthorized) => Response::clawhub_skill_unauthorized(),
    }
}
