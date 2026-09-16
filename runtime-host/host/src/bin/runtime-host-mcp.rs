#![forbid(unsafe_code)]

use std::{
    io::{self, BufReader},
    path::PathBuf,
    process::ExitCode,
};

fn main() -> ExitCode {
    let Ok(config) = TeamRunMcpInvocation::parse() else {
        eprintln!("runtime-host-mcp: artifact configuration is invalid");
        return ExitCode::FAILURE;
    };

    match runtime_host::run_team_run_mcp(
        &config.state_dir,
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
