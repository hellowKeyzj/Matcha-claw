use std::{fmt, net::SocketAddr};

use crate::gateway::auth::GatewaySecret;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PublicControlUiUrl(String);

impl PublicControlUiUrl {
    pub fn for_gateway(
        endpoint: SocketAddr,
        secret: &GatewaySecret,
    ) -> Result<Self, ControlUiUrlError> {
        if endpoint.port() == 0 || !endpoint.ip().is_loopback() {
            return Err(ControlUiUrlError);
        }

        let mut url = format!("http://{endpoint}/");
        secret.append_url_fragment(&mut url);
        Ok(Self(url))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for PublicControlUiUrl {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ControlUiUrlError;

impl fmt::Display for ControlUiUrlError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Control UI endpoint is invalid")
    }
}

impl std::error::Error for ControlUiUrlError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_url_uses_gateway_loopback_with_fragment_token() {
        let secret = GatewaySecret::new("space token".into()).unwrap();
        let url = PublicControlUiUrl::for_gateway("127.0.0.1:18789".parse().unwrap(), &secret)
            .unwrap()
            .to_string();

        assert_eq!(url, "http://127.0.0.1:18789/#token=space%20token");
        assert!(!url.contains('?') && !url.contains('@'));
    }

    #[test]
    fn non_loopback_endpoint_is_rejected() {
        let secret = GatewaySecret::new("token".into()).unwrap();

        assert!(
            PublicControlUiUrl::for_gateway("192.168.0.2:18789".parse().unwrap(), &secret).is_err(),
        );
    }
}
