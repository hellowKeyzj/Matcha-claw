use std::sync::Arc;

use foundation::{execution::OwnedTask, process::ProcessOutput};
use tokio::time::{Instant, timeout_at};
use world_protocol::process::{self, ProcessFailure};

use super::{
    error::ProcessError,
    io::{IoEnd, IoResult},
    materials_session,
    materials_wire::{self, MaterialsFrame},
    session::Session,
};

pub(super) fn reader(mut output: ProcessOutput, session: Arc<Session>, deadline: Instant) -> OwnedTask<IoResult> {
    let (task, _) = OwnedTask::spawn(move |cancel| async move {
        let result = async {
            let mut hello = false;
            loop {
                let handshaking = !session.is_ready();
                let maximum = if handshaking { process::MAX_HANDSHAKE_BYTES } else { session.maximum_frame() };
                let read = materials_wire::read(&mut output, handshaking, maximum);
                let incoming = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Ok(IoEnd::Cancelled),
                    _ = session.closed.cancelled() => return Ok(IoEnd::Cancelled),
                    result = async {
                        if handshaking { timeout_at(deadline, read).await.map_err(|_| Arc::new(ProcessError::Protocol(ProcessFailure::HandshakeTimeout)))? }
                        else { read.await }
                        .map_err(|cause| Arc::new(ProcessError::from(cause)))
                    } => result?,
                };
                let Some(incoming) = incoming else { return Ok(IoEnd::Eof) };
                if handshaking {
                    match incoming {
                        MaterialsFrame::Hello { contract, maximum_frame_bytes } if !hello => {
                            if session.implementation.contracts != vec![contract.clone()]
                                || contract != crate::materials::material_contract().map_err(|_| Arc::new(ProcessError::Protocol(ProcessFailure::HandshakeMismatch)))? {
                                return Err(Arc::new(ProcessError::Protocol(ProcessFailure::HandshakeMismatch)));
                            }
                            let (maximum_frame_bytes, _) = session.select_limits(maximum_frame_bytes, 1).map_err(Arc::new)?;
                            let materials = session.materials().expect("materials session");
                            hello = true;
                            materials_session::send(&session, MaterialsFrame::Select {
                                contract, generation: session.generation.clone(), implementation: session.implementation.clone(),
                                config: session.config.clone(), pdfium: materials.pdfium.clone(), maximum_frame_bytes,
                                maximum_payload_bytes: materials.maximum_payload,
                            }).map_err(Arc::new)?;
                        }
                        MaterialsFrame::InitializationFailed { generation, failure } if hello && generation == session.generation => {
                            return Err(Arc::new(ProcessError::MaterialsInitialization(failure)));
                        }
                        MaterialsFrame::Ready { generation, implementation_digest, config_digest } if hello => {
                            if generation != session.generation || implementation_digest != session.implementation.artifact_digest
                                || config_digest != session.config.digest {
                                return Err(Arc::new(ProcessError::Protocol(ProcessFailure::HandshakeMismatch)));
                            }
                            session.ready();
                        }
                        _ => return Err(Arc::new(ProcessError::Protocol(ProcessFailure::UnexpectedDirection))),
                    }
                } else {
                    session.materials().expect("materials session").dispatch(&session, incoming).map_err(Arc::new)?;
                }
            }
        }.await;
        match &result {
            Ok(IoEnd::Eof) if session.orderly_eof() => { session.closed.cancel(); }
            Ok(IoEnd::Eof) => session.fail(Arc::new(ProcessError::TransportClosed)),
            Err(cause) => session.fail(cause.clone()),
            _ => {},
        }
        session.status.send_modify(|status| status.reader_done = true);
        result
    });
    task
}
