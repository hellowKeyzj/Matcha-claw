#![forbid(unsafe_code)]

use std::{
    io::{self, BufReader},
    path::PathBuf,
    process::ExitCode,
};

use platform::mcp::{ToolCatalog, run_stdio};

fn main() -> ExitCode {
    let Ok(config) = McpInvocation::parse() else {
        eprintln!("runtime-host-mcp: artifact configuration is invalid");
        return ExitCode::FAILURE;
    };

    let Ok(team_run) = runtime_host::team_mcp::team_provider(&config.state_dir) else {
        return ExitCode::FAILURE;
    };
    let Ok(wiki) = wiki::wiki_mcp_provider(&config.state_dir) else {
        return ExitCode::FAILURE;
    };
    let catalog = ToolCatalog::new(vec![Box::new(team_run), Box::new(wiki)]);

    match run_stdio(
        catalog,
        BufReader::new(io::stdin().lock()),
        io::stdout().lock(),
    ) {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => ExitCode::FAILURE,
    }
}

struct McpInvocation {
    state_dir: PathBuf,
}

impl McpInvocation {
    fn parse() -> Result<Self, ()> {
        let mut args = std::env::args_os();
        let _program = args.next();
        let mut state_dir = None;
        while let Some(flag) = args.next() {
            match flag.to_str() {
                Some("--state-dir") if state_dir.is_none() => {
                    state_dir = args.next().map(PathBuf::from)
                }
                _ => return Err(()),
            }
        }
        let state_dir = state_dir.ok_or(())?;
        if !state_dir.is_absolute() || state_dir.as_os_str().is_empty() {
            return Err(());
        }
        Ok(Self { state_dir })
    }
}
