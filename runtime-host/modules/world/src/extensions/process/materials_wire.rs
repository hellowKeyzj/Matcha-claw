use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite};
use world_protocol::{
    api::PackageConfigView,
    bindings::ImplementationRef,
    ids::{Digest, PluginGenerationId},
    process::{self, CallId, Credit, StreamEnd, StreamItem},
    sources::ContractRef,
    wire,
};

use super::frame::{self, WireFailure};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Pdfium {
    pub(super) path: PathBuf,
    pub(super) digest: Digest,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Payload {
    pub(super) schema: Digest,
    pub(super) digest: Digest,
    pub(super) size: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum MaterialsFrame {
    Hello { contract: ContractRef, maximum_frame_bytes: u32 },
    Select {
        contract: ContractRef,
        generation: PluginGenerationId,
        implementation: ImplementationRef,
        config: PackageConfigView,
        pdfium: Option<Pdfium>,
        maximum_frame_bytes: u32,
        maximum_payload_bytes: u64,
    },
    Ready { generation: PluginGenerationId, implementation_digest: Digest, config_digest: Digest },
    InitializationFailed { generation: PluginGenerationId, failure: crate::materials::WorkerFailure },
    Call { id: CallId, payload: Payload },
    Result { id: CallId, payload: Payload },
    Fragment(StreamItem),
    Credit(Credit),
    End(StreamEnd),
    Cancel { id: CallId },
    Cancelled { id: CallId },
    Stop,
    Stopped,
}

pub(super) fn encode(value: &MaterialsFrame, maximum: usize) -> Result<Vec<u8>, WireFailure> {
    let body = wire::encode(value, maximum.min(process::MAX_FRAME_BYTES)).map_err(WireFailure::Codec)?;
    let mut bytes = Vec::with_capacity(body.len() + 4);
    bytes.extend_from_slice(&(body.len() as u32).to_be_bytes());
    bytes.extend_from_slice(&body);
    Ok(bytes)
}

pub(super) async fn read(
    input: &mut (impl AsyncRead + Unpin), handshake: bool, maximum: usize,
) -> Result<Option<MaterialsFrame>, WireFailure> {
    let Some(bytes) = frame::read_body(input, handshake, maximum).await? else { return Ok(None) };
    wire::decode(&bytes, maximum).map(Some).map_err(WireFailure::Codec)
}

pub(super) async fn write(
    output: &mut (impl AsyncWrite + Unpin), value: &MaterialsFrame, maximum: usize,
) -> Result<(), WireFailure> {
    frame::write(output, &encode(value, maximum)?).await
}
