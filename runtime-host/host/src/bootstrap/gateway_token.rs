use std::path::PathBuf;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use openclaw::gateway::auth::GatewaySecret;
use platform::state_dir::CanonicalStateDir;
use zeroize::Zeroize;

use super::{BootstrapError, webhook_token::GeneratedToken};

const TOKEN_FILE: &str = "gateway-token.v1";
const TEMPORARY_FILE_PREFIX: &str = ".gateway-token-";
const TOKEN_LENGTH: usize = 64;

pub(super) fn load_or_create(
    state_dir: &CanonicalStateDir,
) -> Result<GatewaySecret, BootstrapError> {
    let path = state_dir.as_path().join(TOKEN_FILE);
    super::webhook_token::load_or_create_token(
        &path,
        TOKEN_LENGTH,
        TEMPORARY_FILE_PREFIX,
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

fn generate() -> Result<String, BootstrapError> {
    let mut entropy = [0_u8; 48];
    getrandom::fill(&mut entropy).map_err(|_| BootstrapError)?;
    let value = URL_SAFE_NO_PAD.encode(entropy);
    entropy.zeroize();
    (value.len() == TOKEN_LENGTH)
        .then_some(value)
        .ok_or(BootstrapError)
}

#[cfg(test)]
pub(super) fn path(state_dir: &CanonicalStateDir) -> PathBuf {
    state_dir.as_path().join(TOKEN_FILE)
}
