use super::super::protocol::{STDIO_NULL, STDIO_PIPED};
use crate::process::{StdioMode, StdioSpec};

pub(in super::super) fn encode_stdio_spec(spec: StdioSpec) -> Vec<u8> {
    vec![
        encode_mode(spec.stdin()),
        encode_mode(spec.stdout()),
        encode_mode(spec.stderr()),
    ]
}

const fn encode_mode(mode: StdioMode) -> u8 {
    match mode {
        StdioMode::Null => STDIO_NULL,
        StdioMode::Piped => STDIO_PIPED,
    }
}
