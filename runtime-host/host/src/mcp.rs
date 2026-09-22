use std::{
    io::{BufRead, Write},
    path::Path,
};

use platform::mcp::{ToolCatalog, run_stdio};

pub fn run_matcha_mcp<R: BufRead, W: Write>(
    state_dir: &Path,
    input: R,
    output: W,
) -> Result<(), MatchaMcpConstructionError> {
    let catalog = compose(state_dir)?;
    run_stdio(catalog, input, output).map_err(|_| MatchaMcpConstructionError)
}

fn compose(state_dir: &Path) -> Result<ToolCatalog, MatchaMcpConstructionError> {
    Ok(ToolCatalog::new(vec![Box::new(
        organization::team_run_mcp_provider(state_dir).map_err(|_| MatchaMcpConstructionError)?,
    )]))
}

#[derive(Clone, Copy, Debug)]
pub struct MatchaMcpConstructionError;
