use std::fmt;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer as _, SigningKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use platform::state_dir::{CanonicalStateDir, StateDirError};

const DEVICE_IDENTITY_FILE_NAME: &str = "device-identity.json";
const DEVICE_IDENTITY_FILE_LIMIT: usize = 4096;
const DEVICE_IDENTITY_VERSION: u8 = 1;
const PRIVATE_KEY_BYTES: usize = 32;
const PUBLIC_KEY_BYTES: usize = 32;
const REDACTED_SECRET: &str = "[REDACTED]";

pub fn load_or_create_device_identity(
    state_dir: &CanonicalStateDir,
    created_at_ms: u64,
) -> Result<DeviceIdentity, DeviceIdentityError> {
    match state_dir
        .read_regular_file_bounded(DEVICE_IDENTITY_FILE_NAME, DEVICE_IDENTITY_FILE_LIMIT)
        .map_err(DeviceIdentityError::from)?
    {
        Some(contents) => load_device_identity(&contents),
        None => create_device_identity(state_dir, created_at_ms),
    }
}

pub struct DeviceIdentity {
    device_id: String,
    public_key: String,
    signing_key: DeviceSigningKey,
}

impl DeviceIdentity {
    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    pub fn public_key(&self) -> &str {
        &self.public_key
    }

    pub fn sign_connect_device_payload(
        &self,
        context: DeviceConnectPayloadContext<'_>,
    ) -> DeviceConnectAuthPayload {
        let payload = build_device_auth_payload_v3(DeviceAuthPayloadV3Params {
            device_id: &self.device_id,
            client_id: context.client_id,
            client_mode: context.client_mode,
            role: context.role,
            scopes: context.scopes,
            signed_at_ms: context.signed_at_ms,
            token: context.token,
            nonce: context.nonce,
            platform: context.platform,
            device_family: context.device_family,
        });
        DeviceConnectAuthPayload {
            id: self.device_id.clone(),
            public_key: self.public_key.clone(),
            signature: self.signing_key.sign_payload(&payload),
            signed_at: context.signed_at_ms,
            nonce: context.nonce.to_owned(),
        }
    }
}

impl fmt::Debug for DeviceIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DeviceIdentity")
            .field("device_id", &self.device_id)
            .field("public_key", &self.public_key)
            .field("signing_key", &REDACTED_SECRET)
            .finish()
    }
}

struct DeviceSigningKey {
    private_key: [u8; PRIVATE_KEY_BYTES],
}

impl DeviceSigningKey {
    fn sign_payload(&self, payload: &str) -> String {
        let signing_key = SigningKey::from_bytes(&self.private_key);
        encode_base64_url(&signing_key.sign(payload.as_bytes()).to_bytes())
    }

    fn verifying_key_bytes(&self) -> [u8; PUBLIC_KEY_BYTES] {
        SigningKey::from_bytes(&self.private_key)
            .verifying_key()
            .to_bytes()
    }
}

impl fmt::Debug for DeviceSigningKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("DeviceSigningKey([REDACTED])")
    }
}

impl Drop for DeviceSigningKey {
    fn drop(&mut self) {
        self.private_key.fill(0);
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DeviceConnectPayloadContext<'a> {
    pub client_id: &'a str,
    pub client_mode: &'a str,
    pub role: &'a str,
    pub scopes: &'a [&'a str],
    pub signed_at_ms: u64,
    pub token: Option<&'a str>,
    pub nonce: &'a str,
    pub platform: Option<&'a str>,
    pub device_family: Option<&'a str>,
}

#[derive(Clone, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceConnectAuthPayload {
    id: String,
    public_key: String,
    signature: String,
    signed_at: u64,
    nonce: String,
}

impl DeviceConnectAuthPayload {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn public_key(&self) -> &str {
        &self.public_key
    }

    pub fn signature(&self) -> &str {
        &self.signature
    }

    pub fn signed_at(&self) -> u64 {
        self.signed_at
    }

    pub fn nonce(&self) -> &str {
        &self.nonce
    }
}

impl fmt::Debug for DeviceConnectAuthPayload {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DeviceConnectAuthPayload")
            .field("id", &self.id)
            .field("public_key", &self.public_key)
            .field("signature", &REDACTED_SECRET)
            .field("signed_at", &self.signed_at)
            .field("nonce", &REDACTED_SECRET)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DeviceAuthPayloadV3Params<'a> {
    pub device_id: &'a str,
    pub client_id: &'a str,
    pub client_mode: &'a str,
    pub role: &'a str,
    pub scopes: &'a [&'a str],
    pub signed_at_ms: u64,
    pub token: Option<&'a str>,
    pub nonce: &'a str,
    pub platform: Option<&'a str>,
    pub device_family: Option<&'a str>,
}

pub fn build_device_auth_payload_v3(params: DeviceAuthPayloadV3Params<'_>) -> String {
    [
        "v3".to_owned(),
        params.device_id.to_owned(),
        params.client_id.to_owned(),
        params.client_mode.to_owned(),
        params.role.to_owned(),
        params.scopes.join(","),
        params.signed_at_ms.to_string(),
        params.token.unwrap_or_default().to_owned(),
        params.nonce.to_owned(),
        normalize_device_metadata_for_auth(params.platform),
        normalize_device_metadata_for_auth(params.device_family),
    ]
    .join("|")
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeviceIdentityError {
    StateUnavailable,
    InvalidIdentityFile,
    EncodeIdentityFile,
    RandomUnavailable,
}

impl fmt::Display for DeviceIdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::StateUnavailable => "OpenClaw device identity state is unavailable",
            Self::InvalidIdentityFile => "OpenClaw device identity file is invalid",
            Self::EncodeIdentityFile => "OpenClaw device identity file encoding failed",
            Self::RandomUnavailable => "OpenClaw device identity randomness is unavailable",
        })
    }
}

impl std::error::Error for DeviceIdentityError {}

impl From<StateDirError> for DeviceIdentityError {
    fn from(_: StateDirError) -> Self {
        Self::StateUnavailable
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PersistedDeviceIdentity {
    version: u8,
    device_id: String,
    public_key: String,
    private_key: String,
    created_at_ms: u64,
}

fn load_device_identity(contents: &[u8]) -> Result<DeviceIdentity, DeviceIdentityError> {
    let persisted: PersistedDeviceIdentity =
        serde_json::from_slice(contents).map_err(|_| DeviceIdentityError::InvalidIdentityFile)?;
    if persisted.version != DEVICE_IDENTITY_VERSION {
        return Err(DeviceIdentityError::InvalidIdentityFile);
    }
    let public_key = decode_key::<PUBLIC_KEY_BYTES>(&persisted.public_key)?;
    let private_key = decode_key::<PRIVATE_KEY_BYTES>(&persisted.private_key)?;
    let signing_key = DeviceSigningKey { private_key };
    if signing_key.verifying_key_bytes() != public_key
        || fingerprint_public_key(&public_key) != persisted.device_id
    {
        return Err(DeviceIdentityError::InvalidIdentityFile);
    }
    Ok(DeviceIdentity {
        device_id: persisted.device_id,
        public_key: persisted.public_key,
        signing_key,
    })
}

fn create_device_identity(
    state_dir: &CanonicalStateDir,
    created_at_ms: u64,
) -> Result<DeviceIdentity, DeviceIdentityError> {
    let mut private_key = [0_u8; PRIVATE_KEY_BYTES];
    getrandom::fill(&mut private_key).map_err(|_| DeviceIdentityError::RandomUnavailable)?;
    let signing_key = DeviceSigningKey { private_key };
    let public_key = signing_key.verifying_key_bytes();
    let identity = DeviceIdentity {
        device_id: fingerprint_public_key(&public_key),
        public_key: encode_base64_url(&public_key),
        signing_key,
    };
    let persisted = PersistedDeviceIdentity {
        version: DEVICE_IDENTITY_VERSION,
        device_id: identity.device_id.clone(),
        public_key: identity.public_key.clone(),
        private_key: encode_base64_url(&identity.signing_key.private_key),
        created_at_ms,
    };
    let mut contents = serde_json::to_vec_pretty(&persisted)
        .map_err(|_| DeviceIdentityError::EncodeIdentityFile)?;
    contents.push(b'\n');
    state_dir
        .replace_regular_file_bounded(
            DEVICE_IDENTITY_FILE_NAME,
            &contents,
            DEVICE_IDENTITY_FILE_LIMIT,
        )
        .map_err(DeviceIdentityError::from)?;
    Ok(identity)
}

fn decode_key<const N: usize>(value: &str) -> Result<[u8; N], DeviceIdentityError> {
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| DeviceIdentityError::InvalidIdentityFile)?;
    decoded
        .try_into()
        .map_err(|_| DeviceIdentityError::InvalidIdentityFile)
}

fn encode_base64_url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn fingerprint_public_key(public_key: &[u8; PUBLIC_KEY_BYTES]) -> String {
    let digest = Sha256::digest(public_key);
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn normalize_device_metadata_for_auth(value: Option<&str>) -> String {
    let Some(trimmed) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return String::new();
    };
    trimmed
        .bytes()
        .map(|byte| {
            if byte.is_ascii_uppercase() {
                char::from(byte + 32)
            } else {
                char::from(byte)
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::{
        fmt::Display,
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use ed25519_dalek::{Signature, Verifier as _, VerifyingKey};
    use serde_json::json;

    use super::*;

    static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new() -> Self {
            let sequence = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("test clock must follow Unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "openclaw-device-identity-{}-{nanos}-{sequence}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn state_dir(&self) -> CanonicalStateDir {
            CanonicalStateDir::provision(self.0.join("state")).unwrap()
        }

        fn identity_path(&self) -> PathBuf {
            self.0.join("state").join(DEVICE_IDENTITY_FILE_NAME)
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    trait AmbiguousIfDisplay<A> {}
    impl<T> AmbiguousIfDisplay<()> for T {}
    impl<T: Display> AmbiguousIfDisplay<u8> for T {}
    fn assert_not_display<T: AmbiguousIfDisplay<A>, A>() {}

    #[test]
    fn stable_identity_loads_from_openclaw_private_state() {
        let root = TestRoot::new();
        let state_dir = root.state_dir();

        let first = load_or_create_device_identity(&state_dir, 100).unwrap();
        let second = load_or_create_device_identity(&state_dir, 200).unwrap();

        assert_eq!(second.device_id(), first.device_id());
        assert_eq!(second.public_key(), first.public_key());
        let persisted: serde_json::Value =
            serde_json::from_slice(&fs::read(root.identity_path()).unwrap()).unwrap();
        assert_eq!(persisted["version"], 1);
        assert_eq!(persisted["deviceId"], first.device_id());
        assert_eq!(persisted["publicKey"], first.public_key());
        assert_eq!(persisted["createdAtMs"], 100);
        assert!(persisted["privateKey"].as_str().unwrap().len() > 20);
    }

    #[test]
    fn connect_device_payload_matches_v3_semantics_and_signature_verifies() {
        let root = TestRoot::new();
        let state_dir = root.state_dir();
        let identity = load_or_create_device_identity(&state_dir, 1744070400000).unwrap();
        let scopes = ["operator.read", "operator.write"];
        let payload = build_device_auth_payload_v3(DeviceAuthPayloadV3Params {
            device_id: identity.device_id(),
            client_id: "gateway-client",
            client_mode: "backend",
            role: "operator",
            scopes: &scopes,
            signed_at_ms: 1744070400000,
            token: Some("token-123"),
            nonce: "nonce-xyz",
            platform: Some(" WIN32 "),
            device_family: Some("Desktop"),
        });
        assert_eq!(
            payload,
            format!(
                "v3|{}|gateway-client|backend|operator|operator.read,operator.write|1744070400000|token-123|nonce-xyz|win32|desktop",
                identity.device_id()
            )
        );

        let signed = identity.sign_connect_device_payload(DeviceConnectPayloadContext {
            client_id: "gateway-client",
            client_mode: "backend",
            role: "operator",
            scopes: &scopes,
            signed_at_ms: 1744070400000,
            token: Some("token-123"),
            nonce: "nonce-xyz",
            platform: Some(" WIN32 "),
            device_family: Some("Desktop"),
        });
        let public_key = decode_key::<PUBLIC_KEY_BYTES>(signed.public_key()).unwrap();
        let verifying_key = VerifyingKey::from_bytes(&public_key).unwrap();
        let signature =
            Signature::from_slice(&URL_SAFE_NO_PAD.decode(signed.signature()).unwrap()).unwrap();
        verifying_key
            .verify(payload.as_bytes(), &signature)
            .unwrap();
        assert_eq!(
            serde_json::to_value(&signed).unwrap(),
            json!({
                "id": identity.device_id(),
                "publicKey": identity.public_key(),
                "signature": signed.signature(),
                "signedAt": 1744070400000_u64,
                "nonce": "nonce-xyz"
            })
        );
    }

    #[test]
    fn debug_and_errors_do_not_expose_private_key_or_token() {
        assert_not_display::<DeviceIdentity, _>();

        let root = TestRoot::new();
        let state_dir = root.state_dir();
        let identity = load_or_create_device_identity(&state_dir, 100).unwrap();
        let persisted: serde_json::Value =
            serde_json::from_slice(&fs::read(root.identity_path()).unwrap()).unwrap();
        let private_key = persisted["privateKey"].as_str().unwrap();
        assert!(!format!("{identity:?}").contains(private_key));

        let scopes = ["operator.read"];
        let signed = identity.sign_connect_device_payload(DeviceConnectPayloadContext {
            client_id: "gateway-client",
            client_mode: "backend",
            role: "operator",
            scopes: &scopes,
            signed_at_ms: 100,
            token: Some("token-secret-canary"),
            nonce: "nonce-secret-canary",
            platform: None,
            device_family: None,
        });
        let debug = format!("{signed:?}");
        assert!(!debug.contains("token-secret-canary"));
        assert!(!debug.contains("nonce-secret-canary"));
        assert!(!debug.contains(signed.signature()));
        assert!(debug.contains(REDACTED_SECRET));

        state_dir
            .replace_regular_file_bounded(
                DEVICE_IDENTITY_FILE_NAME,
                br#"{"version":1,"deviceId":"private-key-canary","publicKey":"public-key-canary","privateKey":"private-key-canary","createdAtMs":1}"#,
                DEVICE_IDENTITY_FILE_LIMIT,
            )
            .unwrap();
        let error = load_or_create_device_identity(&state_dir, 200).unwrap_err();
        assert_eq!(error, DeviceIdentityError::InvalidIdentityFile);
        assert!(!error.to_string().contains("private-key-canary"));
        assert!(!format!("{error:?}").contains("private-key-canary"));
        assert!(!error.to_string().contains("public-key-canary"));
    }
}
