use std::{
    fs,
    path::{Path, PathBuf},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::SigningKey;
use foundation::storage::{PrivateMode, provision_private_directory, set_private_mode};
use platform::capability::CapabilityDecisionVerifier;
use serde::{Deserialize, Serialize};
use serde_json::json;
use zeroize::Zeroizing;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Metadata {
    pub port: u16,
    pub signing_key: String,
}

pub(crate) struct Discovery {
    path: PathBuf,
    metadata: Zeroizing<Vec<u8>>,
    verifier: CapabilityDecisionVerifier,
}

impl Discovery {
    pub(crate) fn prepare(state_dir: &Path, port: u16) -> Result<Self, ()> {
        if !state_dir.is_absolute() || port == 0 {
            return Err(());
        }
        let private_dir = state_dir.join("mcp-private");
        provision_private_directory(&private_dir).map_err(|_| ())?;
        let mut secret = Zeroizing::new([0_u8; 32]);
        getrandom::fill(secret.as_mut()).map_err(|_| ())?;
        let signing_key = SigningKey::from_bytes(&secret);
        let mut public_key = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        public_key.extend_from_slice(signing_key.verifying_key().as_bytes());
        let verifier = CapabilityDecisionVerifier::try_new(&URL_SAFE_NO_PAD.encode(public_key))
            .map_err(|_| ())?;
        let mut metadata = Metadata {
            port,
            signing_key: URL_SAFE_NO_PAD.encode(secret.as_ref()),
        };
        let bytes = Zeroizing::new(serde_json::to_vec(&metadata).map_err(|_| ())?);
        use zeroize::Zeroize;
        metadata.signing_key.zeroize();
        Ok(Self {
            path: private_dir.join("team-mcp.json"),
            metadata: bytes,
            verifier,
        })
    }

    pub(crate) fn descriptor(
        &self,
        owner: organization::OrganizationHandle,
        resolver: std::sync::Arc<dyn organization::RoleSessionIdentityResolver>,
        authority: super::ExecutionAuthority,
    ) -> platform::loopback::ModuleDescriptor {
        super::route::descriptor(owner, self.verifier.clone(), resolver, authority)
    }

    pub(crate) fn publish(&self) -> Result<(), ()> {
        write_private(&self.path, &self.metadata)
    }
}

impl Drop for Discovery {
    fn drop(&mut self) {
        // Only retire the projection owned by this Host startup, never a newer Host's discovery.
        if fs::read(&self.path).is_ok_and(|current| current == *self.metadata) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

pub(crate) fn project_matcha(
    storage_root: &Path,
    executable: &Path,
    state_dir: &Path,
) -> Result<(), ()> {
    if !storage_root.is_absolute() || !executable.is_absolute() || !state_dir.is_absolute() {
        return Err(());
    }
    provision_private_directory(storage_root).map_err(|_| ())?;
    let body = serde_json::to_vec(&json!({
        "command": executable.to_str().ok_or(())?,
        "args": ["--state-dir", state_dir.to_str().ok_or(())?],
    }))
    .map_err(|_| ())?;
    write_private(&storage_root.join("matcha-mcp.json"), &body)
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), ()> {
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&temporary, bytes).map_err(|_| ())?;
    if set_private_mode(&temporary, PrivateMode::File).is_err() {
        let _ = fs::remove_file(&temporary);
        return Err(());
    }
    fs::rename(&temporary, path).map_err(|_| ())
}

pub(super) fn read(state_dir: &Path) -> Result<Metadata, ()> {
    let path = state_dir.join("mcp-private/team-mcp.json");
    let bytes = Zeroizing::new(fs::read(&path).map_err(|_| ())?);
    let metadata: Metadata = serde_json::from_slice(&bytes).map_err(|_| ())?;
    if metadata.port == 0 {
        return Err(());
    }
    Ok(metadata)
}
