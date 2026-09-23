use std::net::Ipv6Addr;

use super::TelegramDefaultAccountProxyError;

pub(super) fn normalize_proxy_endpoint(
    endpoint: &str,
) -> Result<String, TelegramDefaultAccountProxyError> {
    if endpoint.is_empty() {
        return Err(TelegramDefaultAccountProxyError::InvalidProxyEndpoint);
    }
    let endpoint = if has_scheme(endpoint) {
        endpoint.to_owned()
    } else {
        format!("http://{endpoint}")
    };
    valid_endpoint(&endpoint)
        .then_some(endpoint)
        .ok_or(TelegramDefaultAccountProxyError::InvalidProxyEndpoint)
}

fn has_scheme(value: &str) -> bool {
    let Some((scheme, _)) = value.split_once("://") else {
        return false;
    };
    valid_scheme(scheme)
}

fn valid_endpoint(value: &str) -> bool {
    let Some((scheme, authority)) = value.split_once("://") else {
        return false;
    };
    valid_scheme(scheme)
        && !authority
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
        && !authority.contains(['/', '@', '?', '#', '\\'])
        && valid_authority(authority)
}

fn valid_authority(authority: &str) -> bool {
    if let Some(value) = authority.strip_prefix('[') {
        let Some((host, suffix)) = value.split_once(']') else {
            return false;
        };
        return host.parse::<Ipv6Addr>().is_ok() && valid_port_suffix(suffix);
    }

    match authority.split_once(':') {
        Some((host, port)) => !port.contains(':') && valid_host(host) && valid_port(port),
        None => valid_host(authority),
    }
}

fn valid_port_suffix(value: &str) -> bool {
    value.is_empty() || value.strip_prefix(':').is_some_and(valid_port)
}

fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.split('.').all(|label| {
            let bytes = label.as_bytes();
            matches!(bytes.first(), Some(value) if value.is_ascii_alphanumeric())
                && matches!(bytes.last(), Some(value) if value.is_ascii_alphanumeric())
                && bytes
                    .iter()
                    .all(|value| value.is_ascii_alphanumeric() || *value == b'-')
        })
}

fn valid_port(port: &str) -> bool {
    !port.is_empty()
        && port.bytes().all(|value| value.is_ascii_digit())
        && port.parse::<u16>().is_ok()
}

fn valid_scheme(scheme: &str) -> bool {
    let mut characters = scheme.bytes();
    matches!(characters.next(), Some(character) if character.is_ascii_alphabetic())
        && characters.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, b'+' | b'.' | b'-')
        })
}
