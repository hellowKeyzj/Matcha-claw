use std::{
    io::{BufRead, Write},
    path::Path,
};

use crate::{organization, transport::mcp::stdio};

pub fn run<R: BufRead, W: Write>(
    state_dir: &Path,
    input: R,
    output: W,
) -> Result<(), TeamRunMcpConstructionError> {
    let facade = compose(state_dir)?;
    stdio::run(facade, input, output).map_err(|_| TeamRunMcpConstructionError)
}

fn compose(
    state_dir: &Path,
) -> Result<organization::TeamRunMcpFacade, TeamRunMcpConstructionError> {
    let store = organization::open_organization_store(state_dir)
        .map_err(|_| TeamRunMcpConstructionError)?;
    Ok(organization::TeamRunMcpFacade::from_canonical_store(store))
}

#[derive(Clone, Copy, Debug)]
pub struct TeamRunMcpConstructionError;
