#![forbid(unsafe_code)]

use std::{
    io::{self, BufReader},
    path::PathBuf,
    process::ExitCode,
};

use platform::mcp::{ToolCatalog, run_stdio};

fn main() -> ExitCode {
    let Ok(config) = TeamRunMcpInvocation::parse() else {
        eprintln!("runtime-host-mcp: artifact configuration is invalid");
        return ExitCode::FAILURE;
    };

    let Ok(provider) = organization::team_run_mcp_provider(&config.state_dir) else {
        return ExitCode::FAILURE;
    };
    let catalog = ToolCatalog::new(vec![Box::new(provider)]);

    match run_stdio(
        catalog,
        BufReader::new(io::stdin().lock()),
        io::stdout().lock(),
    ) {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => ExitCode::FAILURE,
    }
}

struct TeamRunMcpInvocation {
    state_dir: PathBuf,
}

impl TeamRunMcpInvocation {
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
