use std::{fmt, net::Ipv6Addr};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Desired {
    pub(crate) browser_mode: BrowserMode,
    pub(crate) proxy: Proxy,
    pub(crate) launch_at_startup: bool,
    pub(crate) gateway_auto_start: bool,
}

impl Desired {
    pub fn try_new(
        browser_mode: BrowserMode,
        proxy: ProxyDesired,
        launch_at_startup: bool,
        gateway_auto_start: bool,
    ) -> Result<Self, InvalidDesired> {
        if !valid_text(&proxy.server, 2048) || !valid_text(&proxy.bypass_rules, 4096) {
            return Err(InvalidDesired);
        }
        if proxy.enabled && proxy.server.is_empty() {
            return Err(InvalidDesired);
        }
        if !proxy.server.is_empty() && !valid_proxy_server(&proxy.server) {
            return Err(InvalidDesired);
        }
        Ok(Self {
            browser_mode,
            proxy: Proxy {
                enabled: proxy.enabled,
                server: proxy.server,
                bypass_rules: proxy.bypass_rules,
            },
            launch_at_startup,
            gateway_auto_start,
        })
    }

    pub const fn browser_mode(&self) -> BrowserMode {
        self.browser_mode
    }

    pub const fn launch_at_startup(&self) -> bool {
        self.launch_at_startup
    }

    pub const fn gateway_auto_start(&self) -> bool {
        self.gateway_auto_start
    }

    pub const fn proxy_enabled(&self) -> bool {
        self.proxy.enabled
    }

    pub fn proxy_server(&self) -> &str {
        &self.proxy.server
    }

    pub fn proxy_bypass_rules(&self) -> &str {
        &self.proxy.bypass_rules
    }

    pub fn proxy_endpoint(&self) -> Option<&str> {
        self.proxy.enabled.then_some(self.proxy.server.as_str())
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ProxyDesired {
    pub enabled: bool,
    pub server: String,
    pub bypass_rules: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidDesired;

impl fmt::Display for InvalidDesired {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("settings desired state is invalid")
    }
}

impl std::error::Error for InvalidDesired {}

fn valid_text(value: &str, maximum: usize) -> bool {
    value.len() <= maximum && !value.contains('\0') && !value.contains(['\r', '\n'])
}

/// A non-empty proxy server must be a projectable endpoint: a bare `host[:port]`
/// or `scheme://authority`. Anything else would be persisted here and rejected by
/// the projection, leaving a desired state no reader accepts.
fn valid_proxy_server(server: &str) -> bool {
    let authority = match server.split_once("://") {
        Some((scheme, authority)) if valid_scheme(scheme) => authority,
        Some(_) => return false,
        None => server,
    };
    !authority
        .bytes()
        .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
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

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum BrowserMode {
    #[default]
    Native,
    Relay,
    Off,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Proxy {
    pub(crate) enabled: bool,
    pub(crate) server: String,
    pub(crate) bypass_rules: String,
}
