use std::{
    fmt,
    sync::atomic::{Ordering, compiler_fence},
};

pub struct Secret(Vec<u8>);

impl Secret {
    pub fn new(value: String) -> Result<Self, SecretError> {
        if value.is_empty() {
            return Err(SecretError::Empty);
        }
        Ok(Self(value.into_bytes()))
    }

    pub(crate) fn issue_bearer_token(&self) -> BearerToken {
        BearerToken(self.0.clone())
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str("Secret(<redacted>)")
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        clear_bytes(&mut self.0);
    }
}

pub(crate) struct BearerToken(Vec<u8>);

impl BearerToken {
    pub(crate) fn as_str(&self) -> &str {
        // Secret is constructed from a Rust String, so every issued copy remains UTF-8.
        std::str::from_utf8(&self.0).expect("Secret always contains UTF-8")
    }
}

impl fmt::Debug for BearerToken {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str("BearerToken(<redacted>)")
    }
}

impl Drop for BearerToken {
    fn drop(&mut self) {
        clear_bytes(&mut self.0);
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SecretError {
    Empty,
}

impl fmt::Display for SecretError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str("secret is empty")
    }
}

impl std::error::Error for SecretError {}

fn clear_bytes(bytes: &mut [u8]) {
    for byte in bytes {
        // SAFETY: byte is a valid, uniquely borrowed byte in the allocation being cleared.
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
    compiler_fence(Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_secret() {
        assert_eq!(Secret::new(String::new()).unwrap_err(), SecretError::Empty);
    }

    #[test]
    fn debug_redacts_secret_and_issued_bearer_token() {
        let secret = Secret::new("secret-canary".to_owned()).unwrap();
        let token = secret.issue_bearer_token();

        assert_eq!(token.as_str(), "secret-canary");
        assert_eq!(format!("{secret:?}"), "Secret(<redacted>)");
        assert_eq!(format!("{token:?}"), "BearerToken(<redacted>)");
        assert!(!format!("{secret:?}{token:?}").contains("secret-canary"));
    }
}
