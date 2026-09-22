pub mod arguments;
mod protocol;
mod server;

pub use protocol::{
    DecodeError, Framing, Request, RequestId, decode_request, detect_framing, encode_error,
    encode_result,
};
pub use server::{ToolCallError, ToolCallOutcome, ToolCatalog, ToolProvider, run_stdio};
