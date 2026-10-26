use std::{io, sync::{Arc, atomic::{AtomicBool, Ordering}}};

use tokio::io::{AsyncRead, AsyncWrite};
use world_protocol::{process::{self, Endpoint, ProcessFailure}, wire};

use super::{
    error::ProcessError,
    materials_payload,
    materials_session::{request_schema, result_schema},
    materials_wire::{self, MaterialsFrame, Payload},
};
use crate::materials::{self, MaterialRequest, MaterialResponse, WorkerFailure};

/// Private pure-worker mode. The caller branches before constructing any Host resources.
pub async fn serve_materials() -> io::Result<()> {
    let mut input = foundation::process::StdinReader::open()?;
    let result = serve(&mut input, &mut tokio::io::stdout()).await;
    let closed = input.close();
    result.map_err(io::Error::other).and(closed)
}

async fn serve(input: &mut (impl AsyncRead + Unpin), output: &mut (impl AsyncWrite + Unpin)) -> Result<(), ProcessError> {
    let contract = materials::material_contract().map_err(|_| ProcessFailure::HandshakeMismatch)?;
    materials_wire::write(output, &MaterialsFrame::Hello { contract: contract.clone(), maximum_frame_bytes: process::MAX_FRAME_BYTES as u32 }, process::MAX_HANDSHAKE_BYTES).await?;
    let Some(MaterialsFrame::Select { contract: selected, generation, implementation, config, pdfium,
        maximum_frame_bytes, maximum_payload_bytes }) = materials_wire::read(input, true, process::MAX_HANDSHAKE_BYTES).await? else {
        return Err(ProcessFailure::HandshakeMismatch.into());
    };
    if contract != selected || implementation.contracts != vec![contract.clone()] || maximum_frame_bytes == 0
        || maximum_frame_bytes as usize > process::MAX_FRAME_BYTES || maximum_payload_bytes == 0
        || config.install_id != implementation.install_id || config.digest != implementation.config_digest
        || world_protocol::api::package_config_digest(&config.fields).map_err(|_| ProcessFailure::HandshakeMismatch)? != config.digest
        || !matches!(&implementation.entrypoint, world_protocol::bindings::Entrypoint::Process { protocol, .. } if protocol == &contract) {
        return Err(ProcessFailure::HandshakeMismatch.into());
    }
    if let Err(failure) = materials::initialize_materials(pdfium.as_ref().map(|value| (value.path.as_path(), &value.digest))) {
        materials_wire::write(output, &MaterialsFrame::InitializationFailed { generation, failure }, process::MAX_HANDSHAKE_BYTES).await?;
        return Ok(());
    }
    let maximum = maximum_frame_bytes as usize;
    materials_wire::write(output, &MaterialsFrame::Ready { generation: generation.clone(),
        implementation_digest: implementation.artifact_digest, config_digest: config.digest }, process::MAX_HANDSHAKE_BYTES).await?;
    let mut sequence = 0;
    loop {
        match materials_wire::read(input, false, maximum).await? {
            Some(MaterialsFrame::Call { id, payload }) => {
                let next = process::request_sequence(&id)?.0;
                if id.initiator != Endpoint::Host || id.generation_id != generation || next <= sequence {
                    return Err(ProcessFailure::DuplicateRequest.into());
                }
                sequence = next;
                let bytes = materials_payload::receive(input, output, id.clone(), payload, &request_schema()?, maximum_payload_bytes, maximum).await?;
                let request: MaterialRequest = wire::decode(&bytes, usize::try_from(maximum_payload_bytes).unwrap_or(usize::MAX))
                    .map_err(super::frame::WireFailure::Codec)?;
                let cancellation = Arc::new(AtomicBool::new(false));
                let worker_cancel = cancellation.clone();
                let mut task = tokio::task::spawn_blocking(move || materials::execute_material(request, &worker_cancel));
                let (bytes, first) = {
                    let incoming = materials_wire::read(input, false, maximum);
                    tokio::pin!(incoming);
                    let result: Result<MaterialResponse, WorkerFailure> = tokio::select! {
                        biased;
                        incoming = &mut incoming => {
                            cancellation.store(true, Ordering::Release);
                            // Cancellation is not a join; keep custody until the pure task actually ends.
                            let _ = (&mut task).await.map_err(|_| ProcessFailure::ReadinessFailed)?;
                            match incoming? {
                                Some(MaterialsFrame::Cancel { id: cancelled }) if cancelled == id => {
                                    materials_wire::write(output, &MaterialsFrame::Cancelled { id }, maximum).await?;
                                    continue;
                                }
                                None => return Ok(()),
                                _ => return Err(ProcessFailure::UnexpectedDirection.into()),
                            }
                        }
                        result = &mut task => result.map_err(|_| ProcessFailure::ReadinessFailed)?,
                    };
                    let bytes = materials_payload::encode(&result, maximum_payload_bytes)?;
                    let payload = Payload { schema: result_schema()?,
                        digest: world_protocol::schema::hash(&bytes).map_err(|_| ProcessFailure::FrameMalformed)?, size: bytes.len() as u64 };
                    materials_wire::write(output, &MaterialsFrame::Result { id: id.clone(), payload }, maximum).await?;
                    // Preserve a possibly partial read when pure work wins the race.
                    (bytes, incoming.await?)
                };
                match first {
                    Some(MaterialsFrame::Cancel { id: cancelled }) if cancelled == id => {
                        materials_wire::write(output, &MaterialsFrame::Cancelled { id }, maximum).await?;
                    }
                    Some(first) => materials_payload::send(input, output, id, bytes, maximum, Some(first)).await?,
                    None => return Ok(()),
                }
            }
            Some(MaterialsFrame::Stop) => {
                materials_wire::write(output, &MaterialsFrame::Stopped, maximum).await?;
                return Ok(());
            }
            None => return Ok(()),
            _ => return Err(ProcessFailure::UnexpectedDirection.into()),
        }
    }
}
