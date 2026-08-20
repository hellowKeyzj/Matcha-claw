use std::{fmt, sync::Arc};

use crate::listener_identity::CertificateFingerprint;
use rustls::{
    CertificateError, ClientConfig, DigitallySignedStruct, Error, SignatureScheme,
    client::{
        Resumption,
        danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    },
    crypto::{
        WebPkiSupportedAlgorithms, verify_tls12_signature as verify_tls12_handshake_signature,
        verify_tls13_signature as verify_tls13_handshake_signature,
    },
    pki_types::{CertificateDer, ServerName, UnixTime},
};

pub fn client_config(fingerprint: CertificateFingerprint) -> Arc<ClientConfig> {
    let provider = rustls::crypto::ring::default_provider();
    let verifier = Arc::new(PinnedVerifier {
        pinned_leaf: fingerprint,
        algorithms: provider.signature_verification_algorithms,
    });
    let mut config = ClientConfig::builder_with_provider(Arc::new(provider))
        .with_safe_default_protocol_versions()
        .expect("ring supports the rustls default protocol versions")
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    config.resumption = Resumption::disabled();
    Arc::new(config)
}

struct PinnedVerifier {
    pinned_leaf: CertificateFingerprint,
    algorithms: WebPkiSupportedAlgorithms,
}

impl fmt::Debug for PinnedVerifier {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PinnedVerifier(<redacted>)")
    }
}

impl ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        if CertificateFingerprint::from_der(end_entity.as_ref()) == self.pinned_leaf {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(CertificateError::ApplicationVerificationFailure.into())
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        certificate: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls12_handshake_signature(message, certificate, signature, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        certificate: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls13_handshake_signature(message, certificate, signature, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::{
        client::danger::ServerCertVerifier,
        pki_types::{CertificateDer, ServerName, UnixTime},
    };

    #[test]
    fn exact_leaf_der_pin_is_required() {
        let certificate = CertificateDer::from(vec![1, 2, 3, 4]);
        let matching = verifier_for(&certificate);
        let name = ServerName::try_from("localhost").unwrap();

        assert!(
            matching
                .verify_server_cert(
                    &certificate,
                    &[CertificateDer::from(vec![9, 8, 7, 6])],
                    &name,
                    &[],
                    UnixTime::since_unix_epoch(std::time::Duration::ZERO)
                )
                .is_ok()
        );
        assert!(
            matching
                .verify_server_cert(
                    &CertificateDer::from(vec![1, 2, 3, 5]),
                    std::slice::from_ref(&certificate),
                    &name,
                    &[],
                    UnixTime::since_unix_epoch(std::time::Duration::ZERO),
                )
                .is_err()
        );
    }

    #[test]
    fn debug_output_redacts_the_pin() {
        let certificate = CertificateDer::from(vec![5, 6, 7, 8]);
        assert_eq!(
            format!("{:?}", verifier_for(&certificate)),
            "PinnedVerifier(<redacted>)"
        );
    }

    fn verifier_for(certificate: &CertificateDer<'_>) -> PinnedVerifier {
        let provider = rustls::crypto::ring::default_provider();
        PinnedVerifier {
            pinned_leaf: CertificateFingerprint::from_der(certificate.as_ref()),
            algorithms: provider.signature_verification_algorithms,
        }
    }
}
