use std::{fs, io::Write, path::Path, sync::Arc};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signature, Signer, SigningKey};
use foundation::storage::{PrivateMode, provision_private_directory, set_private_mode};
use organization::{DeliveryRequest, TeamRunExecutionScope};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

const PREFIX: &str = "team-run-authority.v1";
const MAX_TOKEN_BYTES: usize = 4096;

#[derive(Clone)]
pub(crate) struct ExecutionAuthority(Arc<SigningKey>);

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Claims {
    team_id: String,
    run_id: String,
    delivery_id: String,
    node_execution_id: String,
}

impl ExecutionAuthority {
    pub(crate) fn load_or_create(state_dir: &Path) -> Result<Self, ()> {
        if !state_dir.is_absolute() {
            return Err(());
        }
        let directory = state_dir.join("mcp-private");
        provision_private_directory(&directory).map_err(|_| ())?;
        let path = directory.join("execution-authority.key");
        match fs::symlink_metadata(&path) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => create_key(&path)?,
            Err(_) => return Err(()),
        }
        let metadata = fs::symlink_metadata(&path).map_err(|_| ())?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() != 32 {
            return Err(());
        }
        set_private_mode(&path, PrivateMode::File).map_err(|_| ())?;
        let bytes = Zeroizing::new(fs::read(path).map_err(|_| ())?);
        let key: &[u8; 32] = bytes.as_slice().try_into().map_err(|_| ())?;
        Ok(Self(Arc::new(SigningKey::from_bytes(key))))
    }

    pub(crate) fn sign(&self, delivery: &DeliveryRequest) -> Result<String, ()> {
        let claims = Claims {
            team_id: delivery.team_id.clone(),
            run_id: delivery.run_id.clone(),
            delivery_id: delivery.delivery_id.as_str().to_owned(),
            node_execution_id: delivery.node_execution_id.clone(),
        };
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).map_err(|_| ())?);
        let signed = format!("{PREFIX}.{payload}");
        let token = format!(
            "{signed}.{}",
            URL_SAFE_NO_PAD.encode(self.0.sign(signed.as_bytes()).to_bytes())
        );
        if token.len() > MAX_TOKEN_BYTES {
            return Err(());
        }
        Ok(token)
    }

    pub(crate) fn verify(&self, token: &str) -> Result<TeamRunExecutionScope, ()> {
        if token.len() > MAX_TOKEN_BYTES {
            return Err(());
        }
        let (signed, signature) = token.rsplit_once('.').ok_or(())?;
        let payload = signed
            .strip_prefix(concat!("team-run-authority.v1", "."))
            .ok_or(())?;
        let signature = Signature::from_slice(&URL_SAFE_NO_PAD.decode(signature).map_err(|_| ())?)
            .map_err(|_| ())?;
        self.0
            .verifying_key()
            .verify_strict(signed.as_bytes(), &signature)
            .map_err(|_| ())?;
        let claims: Claims =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).map_err(|_| ())?)
                .map_err(|_| ())?;
        TeamRunExecutionScope::try_new(
            claims.team_id,
            claims.run_id,
            claims.delivery_id,
            claims.node_execution_id,
        )
    }
}

fn create_key(path: &Path) -> Result<(), ()> {
    let mut key = Zeroizing::new([0_u8; 32]);
    getrandom::fill(key.as_mut()).map_err(|_| ())?;
    let mut nonce = [0_u8; 16];
    getrandom::fill(&mut nonce).map_err(|_| ())?;
    let temporary = path.with_extension(format!("{}.tmp", URL_SAFE_NO_PAD.encode(nonce)));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|_| ())?;
        set_private_mode(&temporary, PrivateMode::File).map_err(|_| ())?;
        file.write_all(key.as_ref()).map_err(|_| ())?;
        file.sync_all().map_err(|_| ())?;
        // Publish without replacing a key another Host has already loaded.
        match fs::hard_link(&temporary, path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(_) => Err(()),
        }
    })();
    let _ = fs::remove_file(temporary);
    result
}
