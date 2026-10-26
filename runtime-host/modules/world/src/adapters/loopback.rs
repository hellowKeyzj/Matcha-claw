use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use platform::{loopback::{self, BodyPolicy, ModuleId, Request, RequestHead, Response, RouteDescriptor, RouteHeadPlan, RoutePath}, module::{EffectKind, ModuleDescriptor}};
use serde::{Deserialize, Serialize};
use world_protocol::{api::{self, ApiFailure, CommandEnvelope, PeerRequest, QueryEnvelope, TransportFailure}, failure::{FailureStage, Recovery}, operation::OperationRequest, wire};

use crate::{authorization::RequestBinding, owner::{Error, SignedRequest, WorldHandle}};

const PATHS: &[RoutePath] = &[
    RoutePath::Exact(api::QUERY_ENDPOINT), RoutePath::Exact(api::COMMAND_ENDPOINT),
    RoutePath::Exact(api::OPERATION_ENDPOINT), RoutePath::Exact(api::PEER_ENDPOINT),
];
const MAX_PEER_BYTES: usize = (api::MAX_REQUEST_BYTES + 32_768) * 4 / 3 + 4096;

pub fn descriptor(world: WorldHandle) -> ModuleDescriptor {
    let routes = loopback::ModuleDescriptor::new(ModuleId::new("world"), vec![RouteDescriptor::bound(
        "world.loopback", PATHS, head_plan, move |request| {
            let world = world.clone();
            Box::pin(async move { handle(world, request).await.into() })
        },
    )]);
    ModuleDescriptor::new(platform::module::ModuleId::new("world"), &[], &[],
        &[EffectKind::OwnerTask, EffectKind::Route, EffectKind::FilesystemRead, EffectKind::FilesystemWrite],
        &["world.loopback"], &[], Some(routes))
}

fn head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    if !matches!(head.path.as_str(), api::QUERY_ENDPOINT | api::COMMAND_ENDPOINT | api::OPERATION_ENDPOINT | api::PEER_ENDPOINT) { return None; }
    let max_bytes = if head.path == api::PEER_ENDPOINT { MAX_PEER_BYTES } else { api::MAX_REQUEST_BYTES };
    Some(RouteHeadPlan::body_deadline(BodyPolicy::Required { max_bytes }, Duration::from_secs(30), timeout))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeEnvelope { proof: String, signature: String, request: String }

async fn handle(world: WorldHandle, request: Request) -> Response {
    let result = async {
        if request.method() != "POST" { return Err(invalid(TransportFailure::ContractData)); }
        match request.path() {
            api::QUERY_ENDPOINT => {
                let envelope: QueryEnvelope = decode(&request.body, api::MAX_REQUEST_BYTES)?;
                let signed = signed(&request, envelope.world.clone(), api::QUERY_ENDPOINT, envelope.query.operation_name())?;
                success(world.query(signed, envelope).await?, 200)
            }
            api::COMMAND_ENDPOINT => {
                let envelope: CommandEnvelope = decode(&request.body, api::MAX_REQUEST_BYTES)?;
                let signed = signed(&request, envelope.world.clone(), api::COMMAND_ENDPOINT, envelope.command.operation_name())?;
                let value = world.command(signed, envelope).await?;
                let status = if matches!(value, api::CommandResult::Accepted(_)) { 202 } else { 200 };
                success(value, status)
            }
            api::OPERATION_ENDPOINT => {
                let input: OperationRequest = decode(&request.body, api::MAX_REQUEST_BYTES)?;
                let signed = signed(&request, input.world().clone(), api::OPERATION_ENDPOINT, input.operation_name())?;
                success(world.operation(signed, input).await?, 200)
            }
            api::PEER_ENDPOINT => {
                let outer: NativeEnvelope = decode(&request.body, MAX_PEER_BYTES)?;
                // Preserve both signed payloads. In particular, never reserialize PeerRequest before verification.
                let raw_request = URL_SAFE_NO_PAD.decode(&outer.request).map_err(|cause| invalid(TransportFailure::ContractData).caused(cause))?;
                let proof = URL_SAFE_NO_PAD.decode(&outer.proof).map_err(|cause| invalid(TransportFailure::ContractData).caused(cause))?;
                let signature = URL_SAFE_NO_PAD.decode(&outer.signature).map_err(|cause| invalid(TransportFailure::ContractData).caused(cause))?;
                if proof.len() > 24_576 || signature.len() > 1024 { return Err(invalid(TransportFailure::SizeLimit)); }
                let input: PeerRequest = decode(&raw_request, api::MAX_REQUEST_BYTES)?;
                // NativeVerifier consumes this fixed proof wrapper and checks its original decoded proof bytes.
                let raw_proof = serde_json::to_vec(&serde_json::json!({ "proof": outer.proof, "signature": outer.signature }))
                    .map_err(|cause| Error::internal(FailureStage::Decode).caused(cause))?;
                success(world.peer(raw_proof, raw_request, input).await?, 200)
            }
            _ => Err(invalid(TransportFailure::WrongAudience)),
        }
    }.await;
    result.unwrap_or_else(failure)
}

fn signed(request: &Request, world: world_protocol::ids::WorldRef, endpoint: &'static str, operation: &str) -> Result<SignedRequest, Error> {
    let token = request.bearer_authorization().ok_or(world_protocol::authorization::AuthorizationFailure::InvalidPrincipal)?.to_owned();
    Ok(SignedRequest { token, binding: RequestBinding::new(world, endpoint, operation, &request.body)? })
}

fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8], maximum: usize) -> Result<T, Error> {
    wire::decode(bytes, maximum).map_err(|cause| {
        let detail = match cause {
            wire::CodecFailure::SizeLimit => TransportFailure::SizeLimit,
            wire::CodecFailure::DepthLimit => TransportFailure::DepthLimit,
            wire::CodecFailure::DuplicateKey => TransportFailure::DuplicateKey,
            wire::CodecFailure::JsonSyntax { .. } => TransportFailure::JsonSyntax,
            wire::CodecFailure::UnexpectedEof { .. } => TransportFailure::UnexpectedEof,
            _ => TransportFailure::ContractData,
        };
        invalid(detail).caused(cause)
    })
}

fn invalid(detail: TransportFailure) -> Error {
    Error::new("world.invalid_request", FailureStage::Decode, "世界请求不符合输入契约。", ApiFailure::Transport(detail), Recovery::None)
}
fn success(value: impl Serialize, status: u16) -> Result<Response, Error> {
    serde_json::to_value(value).map(|value| Response::json(status, serde_json::json!({ "success": true, "data": value })))
        .map_err(|cause| Error::internal(FailureStage::Disclose).caused(cause))
}
fn failure(error: Error) -> Response {
    let status = match error.safe_failure().details {
        ApiFailure::Authorization(_) => 401,
        ApiFailure::Input(_) | ApiFailure::Transport(_) => 400,
        ApiFailure::RevisionConflict => 409,
        ApiFailure::NotConfigured => 503,
        _ => 422,
    };
    Response::json(status, serde_json::json!({ "success": false, "error": error.safe_failure() }))
}
fn timeout() -> Response { failure(invalid(TransportFailure::DeadlineExpired)) }
