use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;

use crate::{
    config::Config,
    rpc::{self, Error},
};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BundledSkill {
    pub(crate) name: String,
    pub(crate) description: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Catalog {
    skills: Vec<BundledSkill>,
}

pub(crate) async fn list(config: &Config, agent_id: &str) -> rpc::Result<Vec<BundledSkill>> {
    if !config.agents.contains_key(agent_id) {
        return Err(Error::not_found("Agent"));
    }
    let path = config.cli.skills_catalog.as_ref().ok_or_else(|| {
        Error::unavailable(
            "skill_catalog_missing",
            "The static skill catalog is not configured",
        )
    })?;
    let file = tokio::fs::File::open(path).await.map_err(|source| {
        Error::unavailable(
            "skill_catalog_read",
            "The static skill catalog could not be read",
        )
        .with_source(source)
    })?;
    const LIMIT: u64 = 256 * 1024;
    let mut bytes = Vec::new();
    file.take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|source| {
            Error::unavailable(
                "skill_catalog_read",
                "The static skill catalog could not be read",
            )
            .with_source(source)
        })?;
    if bytes.len() as u64 > LIMIT {
        return Err(Error::internal("skill_catalog_size"));
    }
    let catalog: Catalog = serde_json::from_slice(&bytes)
        .map_err(|source| Error::internal("skill_catalog_schema").with_source(source))?;
    let mut names = BTreeSet::new();
    for skill in &catalog.skills {
        validate_name(&skill.name)?;
        if !names.insert(&skill.name) {
            return Err(Error::internal("skill_catalog_duplicate"));
        }
    }
    Ok(catalog.skills)
}

pub(crate) fn validate_name(name: &str) -> rpc::Result<()> {
    if name.is_empty()
        || name.len() > 128
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        || name.starts_with('-')
        || name.ends_with('-')
    {
        return Err(Error::invalid(
            "Bundled skill names must be lowercase ASCII names with digits or internal hyphens",
        ));
    }
    Ok(())
}
