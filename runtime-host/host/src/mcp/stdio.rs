use std::{
    io::{self, BufReader},
    path::PathBuf,
    process::ExitCode,
    rc::Rc,
};

use organization::TeamRunMcpFacade;
use platform::mcp::{ToolCatalog, run_stdio};
use wiki::WikiMcpFacade;

use super::{Family, client::Client};

pub fn run() -> ExitCode {
    let Ok(config) = McpInvocation::parse() else {
        eprintln!("runtime-host mcp: artifact configuration is invalid");
        return ExitCode::FAILURE;
    };

    let Ok(client) = Client::new(config.state_dir) else {
        return ExitCode::FAILURE;
    };
    let client = Rc::new(client);
    let team_client = Rc::clone(&client);
    let team_run = TeamRunMcpFacade::new(move |name, arguments| {
        team_client.call(Family::Team, name, arguments)
    });
    let wiki =
        WikiMcpFacade::new(move |name, arguments| client.call(Family::Wiki, name, arguments));
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
        let mut args = std::env::args_os().skip(2);
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
