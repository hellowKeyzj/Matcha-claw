#![recursion_limit = "512"]

mod bootstrap;

use std::process::ExitCode;

use runtime_host::{AppInput, run_app_service};
use tokio::io::{stdin, stdout};

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("runtime-host: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), Error> {
    if std::env::var_os("MATCHACLAW_DEBUG_CRON_PROVIDER").is_some() {
        eprintln!("[DEBUG-cron-provider] host=process_started");
    }
    let mut control_input = stdin();
    let bootstrap = bootstrap::read(&mut control_input)
        .await
        .map_err(Error::Bootstrap)?;
    let parts = bootstrap.into_parts().map_err(Error::Bootstrap)?;

    run_app_service(AppInput {
        host: parts.host,
        verifier: parts.verifier,
        provider_credential_resolver: parts.provider_credential_resolver,
        webhook_token: parts.webhook_token,
        runtime_host_transport_port: parts.runtime_host_transport_port,
        control_input,
        control_output: stdout(),
    })
    .await
    .map_err(Error::Control)
}

#[derive(Debug)]
enum Error {
    Bootstrap(bootstrap::BootstrapError),
    Control(runtime_host::ControlError),
}

impl std::fmt::Display for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Bootstrap(error) => error.fmt(formatter),
            Self::Control(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for Error {}
