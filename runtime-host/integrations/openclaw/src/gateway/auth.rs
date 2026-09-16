use std::fmt;

use zeroize::Zeroizing;

use super::wire;

const REDACTED_SECRET: &str = "[REDACTED]";

pub struct GatewaySecret {
    value: Vec<u8>,
    #[cfg(test)]
    drop_observer: Option<std::sync::Arc<std::sync::Mutex<Vec<u8>>>>,
}

impl GatewaySecret {
    pub fn new(value: String) -> Result<Self, GatewayAuthError> {
        if value.is_empty() {
            return Err(GatewayAuthError);
        }

        Ok(Self {
            value: value.into_bytes(),
            #[cfg(test)]
            drop_observer: None,
        })
    }

    pub(crate) fn issue_gateway_token(&self) -> Result<wire::GatewayToken, GatewayAuthError> {
        let value = String::from_utf8(self.value.clone()).map_err(|_| GatewayAuthError)?;
        wire::GatewayToken::new(value).map_err(|_| GatewayAuthError)
    }

    pub(crate) fn with_token<T>(
        &self,
        read: impl FnOnce(&str) -> T,
    ) -> Result<T, GatewayAuthError> {
        let value = std::str::from_utf8(&self.value).map_err(|_| GatewayAuthError)?;
        Ok(read(value))
    }

    pub(crate) fn append_url_fragment(&self, url: &mut String) {
        url.push_str("#token=");
        for byte in &self.value {
            if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b'.' | b'~') {
                url.push(char::from(*byte));
            } else {
                use std::fmt::Write as _;
                let _ = write!(url, "%{byte:02X}");
            }
        }
    }

    #[cfg(test)]
    fn json_string_capacity_bound(&self) -> Result<usize, GatewayAuthError> {
        json_string_capacity_bound(self.value.len())
    }

    pub(crate) fn append_json_string(&self, output: &mut Zeroizing<Vec<u8>>) {
        let value = std::str::from_utf8(&self.value)
            .expect("GatewaySecret is constructed from a valid UTF-8 String");
        serde_json::to_writer(&mut **output, value)
            .expect("serializing a String into a Vec cannot fail");
    }

    #[cfg(test)]
    fn observe_drop(&mut self, observer: std::sync::Arc<std::sync::Mutex<Vec<u8>>>) {
        self.drop_observer = Some(observer);
    }
}

#[cfg(test)]
fn json_string_capacity_bound(length: usize) -> Result<usize, GatewayAuthError> {
    length
        .checked_mul(6)
        .and_then(|length| length.checked_add(2))
        .ok_or(GatewayAuthError)
}

impl fmt::Debug for GatewaySecret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("GatewaySecret")
            .field(&REDACTED_SECRET)
            .finish()
    }
}

impl Drop for GatewaySecret {
    fn drop(&mut self) {
        self.value.fill(0);

        #[cfg(test)]
        if let Some(observer) = self.drop_observer.take() {
            *observer
                .lock()
                .expect("drop observer lock should be available") = self.value.clone();
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GatewayAuthError;

impl fmt::Display for GatewayAuthError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("gateway authentication is invalid")
    }
}

impl std::error::Error for GatewayAuthError {}

#[cfg(test)]
mod tests {
    use std::{
        fmt::Display,
        sync::{Arc, Mutex},
    };

    use serde::Serialize;

    use super::*;

    trait AmbiguousIfClone<A> {}
    impl<T> AmbiguousIfClone<()> for T {}
    impl<T: Clone> AmbiguousIfClone<u8> for T {}
    trait AmbiguousIfDisplay<A> {}
    impl<T> AmbiguousIfDisplay<()> for T {}
    impl<T: Display> AmbiguousIfDisplay<u8> for T {}
    trait AmbiguousIfSerialize<A> {}
    impl<T> AmbiguousIfSerialize<()> for T {}
    impl<T: Serialize> AmbiguousIfSerialize<u8> for T {}

    fn assert_not_clone<T: AmbiguousIfClone<A>, A>() {}
    fn assert_not_display<T: AmbiguousIfDisplay<A>, A>() {}
    fn assert_not_serialize<T: AmbiguousIfSerialize<A>, A>() {}

    #[test]
    fn debug_is_constant_and_secret_traits_are_not_available() {
        assert_not_clone::<GatewaySecret, _>();
        assert_not_display::<GatewaySecret, _>();
        assert_not_serialize::<GatewaySecret, _>();

        let first = GatewaySecret::new("first-secret-canary".into()).unwrap();
        let second = GatewaySecret::new("second-secret-canary".into()).unwrap();
        assert_eq!(format!("{first:?}"), "GatewaySecret(\"[REDACTED]\")");
        assert_eq!(format!("{first:?}"), format!("{second:?}"));
    }

    #[test]
    fn empty_secret_returns_a_fixed_error() {
        let error = GatewaySecret::new(String::new()).unwrap_err();
        assert_eq!(error, GatewayAuthError);
        assert_eq!(error.to_string(), "gateway authentication is invalid");
        assert_eq!(format!("{error:?}"), "GatewayAuthError");
    }

    #[test]
    fn connection_tokens_are_fresh_and_owned_secret_is_cleared_on_drop() {
        let secret = GatewaySecret::new("reconnect-secret-canary".into()).unwrap();
        let first = secret.issue_gateway_token().unwrap();
        let second = secret.issue_gateway_token().unwrap();
        drop(first);
        drop(second);

        let observed = Arc::new(Mutex::new(Vec::new()));
        let mut secret = GatewaySecret::new("dropped-secret-canary".into()).unwrap();
        secret.observe_drop(Arc::clone(&observed));
        drop(secret);

        let observed = observed.lock().unwrap();
        assert!(!observed.is_empty());
        assert!(observed.iter().all(|byte| *byte == 0));
    }

    #[test]
    fn secret_appends_one_json_string_without_exposing_a_string_api() {
        let secret = GatewaySecret::new("quote-\"-newline-\n-canary".into()).unwrap();
        let mut output = Zeroizing::new(b"{\"token\":".to_vec());

        secret.append_json_string(&mut output);
        output.push(b'}');

        let value: serde_json::Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(value["token"], "quote-\"-newline-\n-canary");
        assert!(
            output.len() <= secret.json_string_capacity_bound().unwrap() + b"{\"token\":".len() + 1
        );
    }

    #[test]
    fn json_capacity_bound_covers_plain_and_escaped_values_and_fails_on_overflow() {
        let plain = GatewaySecret::new("plain-canary".into()).unwrap();
        let escaped = GatewaySecret::new("\0\n\"\\".into()).unwrap();

        for secret in [&plain, &escaped] {
            let mut encoded = Zeroizing::new(Vec::new());
            secret.append_json_string(&mut encoded);
            assert!(encoded.len() <= secret.json_string_capacity_bound().unwrap());
        }
        assert_eq!(json_string_capacity_bound(0), Ok(2));
        assert_eq!(
            json_string_capacity_bound(usize::MAX),
            Err(GatewayAuthError)
        );
        assert_eq!(
            json_string_capacity_bound((usize::MAX - 2) / 6 + 1),
            Err(GatewayAuthError)
        );
    }

    #[test]
    fn secret_composes_directly_with_wire_connect_request() {
        let secret = GatewaySecret::new("wire-secret-canary".into()).unwrap();
        let request = wire::build_backend_connect_request(
            "connect-1".into(),
            "nonce-1".into(),
            secret.issue_gateway_token().unwrap(),
            wire::ConnectParams {
                client: wire::ConnectClient {
                    version: "1.0.0".into(),
                    platform: "windows".into(),
                    display_name: Some("Gateway Backend".into()),
                    device_family: Some("desktop".into()),
                    instance_id: Some("instance-1".into()),
                },
                scopes: vec![wire::SYSTEM_PRESENCE_SCOPE.into()],
                caps: vec!["gateway-control".into()],
                device: Some(wire::ConnectDevice {
                    id: "device-1".into(),
                    public_key: "public-key-1".into(),
                    signature: "signature-1".into(),
                    signed_at: 1_774_051_200_000,
                    nonce: "device-nonce-1".into(),
                }),
            },
        )
        .unwrap();

        assert_eq!(request.request_id(), "connect-1");
        let debug = format!("{request:?}");
        assert!(!debug.contains("wire-secret-canary"));
        assert!(debug.contains(REDACTED_SECRET));
    }
}
