#![recursion_limit = "512"]

mod bootstrap;

use std::{path::PathBuf, process::ExitCode};

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
    if let Some((source, target)) = migration_arguments()? {
        let report = organization::migrate_legacy_log(&source, &target).map_err(Error::Migration)?;
        println!(
            "{}",
            serde_json::to_string(&report).map_err(|_| Error::MigrationReport)?
        );
        return Ok(());
    }
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

fn migration_arguments() -> Result<Option<(PathBuf, PathBuf)>, Error> {
    let mut args = std::env::args_os().skip(1);
    let Some(command) = args.next() else {
        return Ok(None);
    };
    if command != "migrate-organization" {
        return Err(Error::Arguments);
    }
    let mut source = None;
    let mut target = None;
    while let Some(flag) = args.next() {
        let value = args.next().ok_or(Error::Arguments)?;
        let slot = match flag.to_str() {
            Some("--source-log") if source.is_none() => &mut source,
            Some("--target-db") if target.is_none() => &mut target,
            _ => return Err(Error::Arguments),
        };
        let path = PathBuf::from(value);
        if !path.is_absolute() {
            return Err(Error::Arguments);
        }
        *slot = Some(path);
    }
    Ok(Some((
        source.ok_or(Error::Arguments)?,
        target.ok_or(Error::Arguments)?,
    )))
}

#[derive(Debug)]
enum Error {
    Arguments,
    Migration(organization::MigrationError),
    MigrationReport,
    Bootstrap(bootstrap::BootstrapError),
    Control(runtime_host::ControlError),
}

impl std::fmt::Display for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Arguments => formatter.write_str(
                "expected no arguments, or migrate-organization --source-log <absolute offline log> --target-db <absolute new offline database>; no automatic cutover",
            ),
            Self::Migration(error) => error.fmt(formatter),
            Self::MigrationReport => formatter.write_str("organization migration report could not be encoded"),
            Self::Bootstrap(error) => error.fmt(formatter),
            Self::Control(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for Error {}
