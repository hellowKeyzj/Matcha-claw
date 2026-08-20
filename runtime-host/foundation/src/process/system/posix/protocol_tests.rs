use std::ffi::OsString;
use std::os::unix::ffi::OsStringExt;
use std::path::Path;

use super::guardian_protocol::{
    decode_launch_payload, encode_armed_payload, encode_exit_status_payload, validate_stdio_spec,
};
use super::host_protocol::{
    decode_armed_payload, decode_exit_status_payload, encode_launch_payload, encode_stdio_spec,
};
use super::protocol::{Frame, HEADER_BYTES, Message};
use crate::process::launch::posix::encoded_launch_payload_size;
use crate::process::launch::posix_limits::MAX_FRAME_BYTES;
use crate::process::{StdioMode, StdioSpec};

#[test]
fn guardian_observation_round_trips_through_the_host_codec() {
    let frame = Frame::new(
        Message::Armed,
        [7; 16],
        42,
        encode_armed_payload(123, 456).unwrap(),
    )
    .unwrap();
    let bytes = frame.encode();
    let header: [u8; HEADER_BYTES] = bytes[..HEADER_BYTES].try_into().unwrap();
    let decoded = Frame::from_header(
        Frame::decode_header(&header).unwrap(),
        bytes[HEADER_BYTES..].to_vec(),
    )
    .unwrap();

    assert_eq!(decoded.message, Message::Armed);
    assert_eq!(decoded.nonce, [7; 16]);
    assert_eq!(decoded.request_id, 42);
    assert_eq!(decode_armed_payload(&decoded.payload).unwrap(), (123, 456));
}

#[test]
fn frame_shape_validation_defers_directional_semantics_to_endpoint_decoders() {
    let minimum_launch = [0, 1, 0, 0, 0, 1, b'x', 0, 0, 0, 0, 0, 0];
    assert!(Frame::new(Message::Launch, [7; 16], 42, minimum_launch.to_vec()).is_ok());
    assert!(decode_launch_payload(&minimum_launch).is_err());

    let malformed_stdio = vec![1, 2, 0];
    assert!(Frame::new(Message::Hello, [7; 16], 42, malformed_stdio.clone()).is_ok());
    assert!(validate_stdio_spec(&malformed_stdio).is_err());

    let malformed_armed = [
        0_i32.to_be_bytes().as_slice(),
        456_u128.to_be_bytes().as_slice(),
    ]
    .concat();
    assert!(Frame::new(Message::Armed, [7; 16], 42, malformed_armed.clone()).is_ok());
    assert!(decode_armed_payload(&malformed_armed).is_err());

    let malformed_exit = 0x7f_i32.to_be_bytes().to_vec();
    assert!(Frame::new(Message::Drained, [7; 16], 42, malformed_exit.clone()).is_ok());
    assert!(decode_exit_status_payload(&malformed_exit).is_err());
}

#[test]
fn malformed_or_v5_header_is_rejected_before_payload_allocation() {
    let mut header = [0_u8; HEADER_BYTES];
    header[..4].copy_from_slice(b"NOPE");
    assert!(Frame::decode_header(&header).is_err());

    header[..4].copy_from_slice(b"MCGD");
    header[4] = 5;
    header[5] = Message::Hello as u8;
    header[22..30].copy_from_slice(&1_u64.to_be_bytes());
    assert!(Frame::decode_header(&header).is_err());

    header[4] = 6;
    header[5] = 255;
    assert!(Frame::decode_header(&header).is_err());

    header[5] = Message::Hello as u8;
    header[22..30].copy_from_slice(&0_u64.to_be_bytes());
    assert!(Frame::decode_header(&header).is_err());

    header[22..30].copy_from_slice(&1_u64.to_be_bytes());
    header[30..].copy_from_slice(&(u32::MAX).to_be_bytes());
    assert!(Frame::decode_header(&header).is_err());
}

#[test]
fn cleanup_unconfirmed_encodes_as_the_v7_terminal_retry_message() {
    let frame = Frame::new(Message::CleanupUnconfirmed, [7; 16], 42, Vec::new()).unwrap();
    let bytes = frame.encode();
    let mut expected = Vec::from(*b"MCGD");
    expected.extend_from_slice(&[7, 12]);
    expected.extend_from_slice(&[7; 16]);
    expected.extend_from_slice(&42_u64.to_be_bytes());
    expected.extend_from_slice(&0_u32.to_be_bytes());
    assert_eq!(bytes, expected);

    let header: [u8; HEADER_BYTES] = bytes[..HEADER_BYTES].try_into().unwrap();
    let decoded = Frame::from_header(
        Frame::decode_header(&header).unwrap(),
        bytes[HEADER_BYTES..].to_vec(),
    )
    .unwrap();
    assert_eq!(decoded.message, Message::CleanupUnconfirmed);
    assert!(decoded.payload.is_empty());
    assert!(Frame::new(Message::CleanupUnconfirmed, [7; 16], 42, vec![1]).is_err());
}

#[test]
fn host_stdio_payload_round_trips_through_the_guardian_codec_with_a_stable_v6_golden() {
    let spec = StdioSpec::new(StdioMode::Piped, StdioMode::Null, StdioMode::Piped);
    let payload = encode_stdio_spec(spec);
    assert_eq!(payload, [1, 0, 1]);
    validate_stdio_spec(&payload).unwrap();

    for malformed in [&[][..], &[1, 0][..], &[1, 0, 1, 0][..], &[1, 2, 0][..]] {
        assert!(validate_stdio_spec(malformed).is_err());
    }
}

#[test]
fn host_launch_payload_round_trips_through_the_guardian_codec() {
    let program = OsString::from_vec(vec![b'r', 0xff]);
    let arguments = vec![OsString::from_vec(vec![0xfe, b'x']), OsString::new()];
    let working_directory = Path::new(&OsString::from_vec(vec![b'/', 0xfd])).to_path_buf();
    let environment = vec![
        (
            OsString::from_vec(vec![b'K', 0xfc]),
            OsString::from_vec(vec![0xfb, b'V']),
        ),
        (OsString::from("EMPTY"), OsString::new()),
    ];

    let payload = encode_launch_payload(
        program.as_os_str(),
        &working_directory,
        &arguments,
        &environment,
    )
    .unwrap();
    let decoded = decode_launch_payload(&payload).unwrap();

    assert!(decoded.program == program);
    assert!(decoded.arguments == arguments);
    assert!(decoded.working_directory == Path::as_os_str(&working_directory));
    assert!(decoded.public_environment == environment);
}

#[test]
fn validated_launch_payload_encodes_at_the_exact_capacity() {
    let program = OsString::from("/");
    let working_directory = Path::new("/");
    let baseline =
        encoded_launch_payload_size(program.as_os_str(), working_directory, &[], &[]).unwrap();
    let exact_argument = OsString::from_vec(vec![b'x'; MAX_FRAME_BYTES - baseline - 4]);
    let exact = encode_launch_payload(
        program.as_os_str(),
        working_directory,
        &[exact_argument],
        &[],
    )
    .unwrap();

    assert_eq!(exact.len(), MAX_FRAME_BYTES);
    assert!(Frame::new(Message::Launch, [7; 16], 42, exact).is_ok());
    assert!(Frame::new(Message::Launch, [7; 16], 42, vec![0; MAX_FRAME_BYTES + 1]).is_err());
}

#[test]
fn drain_messages_require_bounded_terminal_status_evidence() {
    let drain = Frame::new(Message::Drain, [7; 16], 42, Vec::new()).unwrap();
    let pending = Frame::new(Message::Pending, [7; 16], 42, Vec::new()).unwrap();
    let terminate = Frame::new(Message::Terminate, [7; 16], 42, Vec::new()).unwrap();
    assert_eq!(drain.message, Message::Drain);
    assert_eq!(pending.message, Message::Pending);
    assert_eq!(terminate.message, Message::Terminate);
    assert!(Frame::new(Message::Pending, [7; 16], 42, vec![1]).is_err());

    let exited_payload = encode_exit_status_payload(17 << 8);
    let drained = Frame::new(Message::Drained, [7; 16], 42, exited_payload.clone()).unwrap();
    assert_eq!(drained.message, Message::Drained);
    assert!(Frame::new(Message::Terminate, [7; 16], 42, exited_payload.clone()).is_err());
    let exited = decode_exit_status_payload(&exited_payload).unwrap();
    let signaled = decode_exit_status_payload(&encode_exit_status_payload(libc::SIGKILL)).unwrap();

    assert_eq!(exited, (Some(17), None));
    assert_eq!(signaled, (None, Some(libc::SIGKILL)));
    let malformed = encode_exit_status_payload(0x7f);
    assert!(Frame::new(Message::Drained, [7; 16], 42, malformed.clone()).is_ok());
    assert!(decode_exit_status_payload(&malformed).is_err());
}

#[test]
fn launch_payload_rejects_nuls_and_invalid_environment_keys() {
    assert!(
        encode_launch_payload(
            OsString::from("bad\0program").as_os_str(),
            Path::new("/"),
            &[],
            &[],
        )
        .is_err()
    );

    for key in [
        OsString::new(),
        OsString::from("A=B"),
        OsString::from("A\0B"),
    ] {
        assert!(
            encode_launch_payload(
                OsString::from("runner").as_os_str(),
                Path::new("/"),
                &[],
                &[(key, OsString::from("value"))],
            )
            .is_err()
        );
    }

    assert!(
        encode_launch_payload(
            OsString::from("runner").as_os_str(),
            Path::new("/"),
            &[],
            &[
                (OsString::from("KEY"), OsString::from("one")),
                (OsString::from("KEY"), OsString::from("two")),
            ],
        )
        .is_err()
    );
}
