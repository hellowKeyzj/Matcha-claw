pub(crate) mod catalog;
#[allow(dead_code)]
pub(crate) mod config_read;
pub(crate) mod control;
pub(crate) mod credentials;
pub(crate) mod delete;
pub(crate) mod login;
pub(crate) mod pairing;
pub(crate) mod status;

pub(crate) fn request_body_within_limit(
    headers: &[(String, String)],
    body: &[u8],
    max_bytes: usize,
) -> bool {
    body_length(headers).is_some_and(|length| length == body.len() && length <= max_bytes)
}

pub(crate) fn required_request_body_within_limit(
    headers: &[(String, String)],
    body: &[u8],
    max_bytes: usize,
) -> bool {
    body_length(headers)
        .is_some_and(|length| length > 0 && length == body.len() && length <= max_bytes)
}

fn body_length(headers: &[(String, String)]) -> Option<usize> {
    headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse::<usize>().ok())
}
