#[cfg(test)]
use std::path::PathBuf;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use openclaw::gateway::auth::GatewaySecret;
use platform::state_dir::CanonicalStateDir;
use zeroize::Zeroizing;

use super::{BootstrapError, webhook_token::GeneratedToken};

const TOKEN_FILE: &str = "gateway-token.v1";
const TOKEN_LENGTH: usize = 64;

pub(super) fn load_or_create(
    state_dir: &CanonicalStateDir,
) -> Result<GatewaySecret, BootstrapError> {
    let state_dir = state_dir.open().map_err(|_| BootstrapError)?;
    super::webhook_token::load_or_create_token(
        &state_dir,
        TOKEN_FILE,
        TOKEN_LENGTH,
        parse,
        generate_token,
    )
}

fn parse(value: &mut String) -> Result<GatewaySecret, BootstrapError> {
    GatewaySecret::new(std::mem::take(value)).map_err(|_| BootstrapError)
}

fn generate_token() -> Result<GeneratedToken<GatewaySecret>, BootstrapError> {
    generate().map(GeneratedToken::Unparsed)
}

fn generate() -> Result<Zeroizing<String>, BootstrapError> {
    let mut entropy = Zeroizing::new([0_u8; 48]);
    getrandom::fill(&mut *entropy).map_err(|_| BootstrapError)?;
    let value = Zeroizing::new(URL_SAFE_NO_PAD.encode(&*entropy));
    (value.len() == TOKEN_LENGTH)
        .then_some(value)
        .ok_or(BootstrapError)
}

#[cfg(test)]
pub(super) fn path(state_dir: &CanonicalStateDir) -> PathBuf {
    state_dir.as_path().join(TOKEN_FILE)
}
