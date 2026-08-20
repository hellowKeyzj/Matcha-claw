use std::fmt;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use rcgen::{CertifiedKey, generate_simple_self_signed};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

const LOOPBACK_SUBJECT_ALT_NAMES: [&str; 3] = ["localhost", "127.0.0.1", "::1"];
const PRIVATE_KEY_PEM_BEGIN: &[u8] = b"-----BEGIN PRIVATE KEY-----\n";
const PRIVATE_KEY_PEM_END: &[u8] = b"-----END PRIVATE KEY-----\n";
const PRIVATE_KEY_DER_LINE_BYTES: usize = 48;
const PRIVATE_KEY_PEM_LINE_BYTES: usize = 64;

/// Ephemeral TLS material for one loopback listener.
///
/// The private key stays local to the listener. Clients receive only the
/// certificate fingerprint as a pinned trust anchor.
pub struct ListenerIdentity {
    certificate_pem: Vec<u8>,
    private_key_pem: Zeroizing<Vec<u8>>,
    fingerprint: CertificateFingerprint,
}

impl ListenerIdentity {
    /// Generates a fresh self-signed leaf certificate for loopback listeners.
    ///
    /// # Errors
    ///
    /// Returns a fixed error if certificate or private-key generation fails.
    pub fn generate_loopback() -> Result<Self, ListenerIdentityError> {
        let subject_alt_names = LOOPBACK_SUBJECT_ALT_NAMES.map(str::to_owned).to_vec();
        let CertifiedKey {
            cert,
            mut signing_key,
        } = generate_simple_self_signed(subject_alt_names).map_err(|_| ListenerIdentityError)?;
        let fingerprint = CertificateFingerprint::from_der(cert.der());
        let private_key_pem = encode_private_key_pem(signing_key.serialized_der());
        signing_key.zeroize();

        Ok(Self {
            certificate_pem: cert.pem().into_bytes(),
            private_key_pem,
            fingerprint,
        })
    }

    pub fn certificate_pem(&self) -> &[u8] {
        &self.certificate_pem
    }

    pub fn private_key_pem(&self) -> &[u8] {
        self.private_key_pem.as_slice()
    }

    pub const fn fingerprint(&self) -> CertificateFingerprint {
        self.fingerprint
    }
}

fn encode_private_key_pem(der: &[u8]) -> Zeroizing<Vec<u8>> {
    let line_count = der.len().div_ceil(PRIVATE_KEY_DER_LINE_BYTES);
    let mut pem = Zeroizing::new(Vec::with_capacity(
        PRIVATE_KEY_PEM_BEGIN.len()
            + line_count * (PRIVATE_KEY_PEM_LINE_BYTES + 1)
            + PRIVATE_KEY_PEM_END.len(),
    ));
    pem.extend_from_slice(PRIVATE_KEY_PEM_BEGIN);

    let mut encoded = Zeroizing::new([0_u8; PRIVATE_KEY_PEM_LINE_BYTES]);
    for chunk in der.chunks(PRIVATE_KEY_DER_LINE_BYTES) {
        let length = STANDARD
            .encode_slice(chunk, encoded.as_mut_slice())
            .expect("64 PEM bytes must encode 48 DER bytes");
        pem.extend_from_slice(&encoded[..length]);
        pem.push(b'\n');
    }
    pem.extend_from_slice(PRIVATE_KEY_PEM_END);
    pem
}

impl fmt::Debug for ListenerIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ListenerIdentity(<redacted>)")
    }
}

/// SHA-256 fingerprint of the listener leaf certificate DER.
///
/// This is the pinned TLS mechanism shared with clients, not a listener identity
/// secret and not a certificate authority chain.
#[derive(Clone, Copy, Eq, PartialEq)]
pub struct CertificateFingerprint([u8; 32]);

impl CertificateFingerprint {
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub(crate) fn from_der(der: &[u8]) -> Self {
        Self(Sha256::digest(der).into())
    }
}

impl fmt::Debug for CertificateFingerprint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CertificateFingerprint(<redacted>)")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ListenerIdentityError;

impl fmt::Display for ListenerIdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("listener identity generation failed")
    }
}

impl std::error::Error for ListenerIdentityError {}

#[cfg(test)]
mod tests {
    use super::{CertificateFingerprint, ListenerIdentity};
    use sha2::{Digest, Sha256};

    #[test]
    fn generated_identity_contains_pem_material_and_matching_leaf_pin() {
        let identity = ListenerIdentity::generate_loopback().unwrap();
        let certificate_der = decode_pem(identity.certificate_pem(), "CERTIFICATE");
        let private_key_der = decode_pem(identity.private_key_pem(), "PRIVATE KEY");

        assert!(!certificate_der.is_empty());
        assert!(rcgen::KeyPair::try_from(private_key_der.as_slice()).is_ok());
        assert_eq!(
            identity.fingerprint().as_bytes(),
            &<[u8; 32]>::from(Sha256::digest(&certificate_der))
        );
        assert!(
            identity
                .private_key_pem()
                .starts_with(b"-----BEGIN PRIVATE KEY-----")
        );
    }

    #[test]
    fn each_identity_is_fresh() {
        let first = ListenerIdentity::generate_loopback().unwrap();
        let second = ListenerIdentity::generate_loopback().unwrap();

        assert_ne!(first.fingerprint(), second.fingerprint());
        assert_ne!(first.private_key_pem(), second.private_key_pem());
    }

    #[test]
    fn debug_output_is_fixed_and_redacted() {
        let identity = ListenerIdentity::generate_loopback().unwrap();
        let private_key = String::from_utf8_lossy(identity.private_key_pem());

        assert_eq!(format!("{identity:?}"), "ListenerIdentity(<redacted>)");
        assert_eq!(
            format!("{:?}", identity.fingerprint()),
            "CertificateFingerprint(<redacted>)"
        );
        assert!(!format!("{identity:?}").contains(private_key.as_ref()));
    }

    #[test]
    fn fingerprint_is_copy() {
        fn copy(value: CertificateFingerprint) -> CertificateFingerprint {
            value
        }

        let identity = ListenerIdentity::generate_loopback().unwrap();
        assert_eq!(copy(identity.fingerprint()), identity.fingerprint());
    }

    fn decode_pem(pem: &[u8], label: &str) -> Vec<u8> {
        let text = std::str::from_utf8(pem).unwrap();
        let begin = format!("-----BEGIN {label}-----");
        let end = format!("-----END {label}-----");
        let body = text.strip_prefix(&begin).unwrap().trim_end();
        let encoded = body
            .strip_suffix(&end)
            .unwrap()
            .bytes()
            .filter(|byte| !byte.is_ascii_whitespace())
            .collect::<Vec<_>>();
        decode_base64(&encoded)
    }

    fn decode_base64(encoded: &[u8]) -> Vec<u8> {
        let mut decoded = Vec::with_capacity(encoded.len() / 4 * 3);
        let mut chunk = [0_u8; 4];

        for quartet in encoded.chunks_exact(4) {
            for (index, byte) in quartet.iter().copied().enumerate() {
                chunk[index] = match byte {
                    b'A'..=b'Z' => byte - b'A',
                    b'a'..=b'z' => byte - b'a' + 26,
                    b'0'..=b'9' => byte - b'0' + 52,
                    b'+' => 62,
                    b'/' => 63,
                    b'=' => 0,
                    _ => panic!("invalid base64"),
                };
            }

            decoded.push(chunk[0] << 2 | chunk[1] >> 4);
            if quartet[2] != b'=' {
                decoded.push(chunk[1] << 4 | chunk[2] >> 2);
            }
            if quartet[3] != b'=' {
                decoded.push(chunk[2] << 6 | chunk[3]);
            }
        }

        decoded
    }
}
