mod client;
mod discovery;
pub(crate) mod route;

pub use client::team_provider;
pub(crate) use discovery::{Discovery, project_matcha};

const ROUTE: &str = "/internal/team/mcp";
const PRINCIPAL: &str = "team-mcp-local";
const SCOPE: &str = "team.mcp";
const CAPABILITY: &str = "team.mcp";
const MAX_BYTES: usize = 1024 * 1024;

fn revision(body: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(body))
}

fn now_millis() -> Result<u64, ()> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| ())?
        .as_millis()
        .try_into()
        .map_err(|_| ())
}
