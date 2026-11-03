use std::{net::IpAddr, time::Duration};

use reqwest::{Client, Url};

use super::{Content, Failure, MAX_OUTPUT_BYTES, wire};

pub(super) async fn download(
    _client: &Client,
    url: &str,
    remaining: &mut usize,
) -> Result<Content, Failure> {
    if url.split_once("://").is_some_and(|(_, rest)| {
        rest.split(['/', '?', '#'])
            .next()
            .is_some_and(|authority| authority.contains('@'))
    }) {
        return Err(Failure::InvalidResponse);
    }
    let url = Url::parse(url).map_err(|_| Failure::InvalidResponse)?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url
            .host_str()
            .is_none_or(|host| host.starts_with('[') || host.parse::<IpAddr>().is_ok())
    {
        return Err(Failure::InvalidResponse);
    }
    let hostname = url.host_str().ok_or(Failure::InvalidResponse)?;
    let port = url
        .port_or_known_default()
        .ok_or(Failure::InvalidResponse)?;
    let addresses = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::net::lookup_host((hostname, port)),
    )
    .await
    .map_err(|_| Failure::Deadline)?
    .map_err(|_| Failure::ProviderUnavailable)?
    .collect::<Vec<_>>();
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|address| !is_public_address(address.ip()))
    {
        return Err(Failure::InvalidResponse);
    }
    // Do not inherit provider headers, proxies or pooled connections. Pin this DNS
    // observation for the actual TLS connection; a second lookup could rebind.
    let client = Client::builder()
        .https_only(true)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(5 * 60))
        .resolve_to_addrs(hostname, &addresses)
        .build()
        .map_err(|_| Failure::ProviderUnavailable)?;
    let response = wire::send(client.get(url)).await?;
    let mime_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .filter(|mime| !mime.eq_ignore_ascii_case("text/plain"))
        .ok_or(Failure::InvalidResponse)?
        .to_owned();
    let bytes = wire::bytes(response, (*remaining).min(MAX_OUTPUT_BYTES)).await?;
    wire::media_output(bytes, &mime_type, remaining)
}

fn is_public_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let [a, b, c, _] = address.octets();
            !matches!(a, 0 | 10 | 127 | 224..=255)
                && !(a == 100 && (64..=127).contains(&b))
                && !(a == 169 && b == 254)
                && address.octets() != [168, 63, 129, 16]
                && !(a == 172 && (16..=31).contains(&b))
                && !(a == 192 && (b == 168 || b == 0 && matches!(c, 0 | 2) || b == 88 && c == 99))
                && !(a == 198 && (matches!(b, 18 | 19) || b == 51 && c == 100))
                && !(a == 203 && b == 0 && c == 113)
        }
        IpAddr::V6(address) => {
            let segments = address.segments();
            // Only global unicast, excluding special-purpose, transition and
            // documentation prefixes; mapped/private/link-local never enter it.
            (0x2000..=0x3fff).contains(&segments[0])
                && !(segments[0] == 0x2001 && (segments[1] < 0x200 || segments[1] == 0xdb8))
                && segments[0] != 0x2002
                && !(segments[0] == 0x3fff && segments[1] < 0x1000)
        }
    }
}
