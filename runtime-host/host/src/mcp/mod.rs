#![forbid(unsafe_code)]

mod client;
mod discovery;
pub(crate) mod route;
mod stdio;

pub(crate) use discovery::{Discovery, project_matcha};
pub use stdio::run;

const MAX_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy)]
enum Family {
    Team,
    Wiki,
}

impl Family {
    const fn path(self) -> &'static str {
        match self {
            Self::Team => "/internal/team/mcp",
            Self::Wiki => "/internal/wiki/mcp",
        }
    }

    fn principal(self) -> &'static str {
        match self {
            Self::Team => "team-mcp-local",
            Self::Wiki => "wiki-mcp-local",
        }
    }

    fn scope(self) -> &'static str {
        match self {
            Self::Team => "team.mcp",
            Self::Wiki => "wiki.mcp",
        }
    }
}

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
