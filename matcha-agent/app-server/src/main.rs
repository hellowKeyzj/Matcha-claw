use matcha_app_server::{
    config::{ConfigStore, Paths},
    diagnostics::Diagnostics,
    events::Events,
    gateway,
    interaction::Interactions,
    persistence::Database,
    rpc, schedule,
    session::Sessions,
};
use std::{env, path::PathBuf, sync::Arc};

#[tokio::main]
async fn main() -> std::process::ExitCode {
    match run().await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            std::process::ExitCode::FAILURE
        }
    }
}

async fn run() -> rpc::Result<()> {
    let mut args = env::args_os().skip(1);
    let mut root = env::var_os("MATCHA_AGENT_HOME").map(PathBuf::from);
    let mut search_disable = false;
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--home") => {
                root = Some(
                    args.next()
                        .map(PathBuf::from)
                        .ok_or_else(|| rpc::Error::invalid("--home requires a directory"))?,
                )
            }
            Some("--search-disable") => search_disable = true,
            Some("--version") => {
                println!("matcha-app-server {}", env!("CARGO_PKG_VERSION"));
                return Ok(());
            }
            Some("--help" | "-h") => {
                println!(
                    "matcha-app-server [--home DIRECTORY] [--search-disable]\nDefault: MATCHA_AGENT_HOME or ~/.matcha-agent\n--search-disable: remove the search projection while the server is stopped"
                );
                return Ok(());
            }
            _ => return Err(rpc::Error::invalid("Unknown argument; use --help")),
        }
    }
    let root = root
        .or_else(|| {
            env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .map(|p| PathBuf::from(p).join(".matcha-agent"))
        })
        .ok_or_else(|| rpc::Error::invalid("Home directory is unavailable; provide --home"))?;
    let paths = Paths::new(root);
    let config = Arc::new(ConfigStore::open(paths).await?);
    if search_disable {
        let observed = matcha_app_server::search::disable_offline(&config).await?;
        println!("{observed}");
        return Ok(());
    }
    let listener = tokio::net::TcpListener::bind(config.snapshot().await.listen)
        .await
        .map_err(|_| {
            rpc::Error::unavailable("listen_failed", "The HTTP listener could not bind")
        })?;
    let listen = listener
        .local_addr()
        .map_err(|_| rpc::Error::internal("listen_address"))?;
    matcha_app_server::sealed::bind_origin(config.as_ref(), listen).await?;
    let paths = config.paths();
    let diagnostics = Diagnostics::open(paths).await?;
    let database = Database::open(&paths.database()).await?;
    matcha_app_server::session::prepare_database(&database).await?;
    let events = Events::open(database.clone()).await?;
    let interactions = Interactions::open(database.clone(), events.clone()).await?;
    let media = matcha_app_server::workspace::Media::default();
    let sessions = Sessions::open(
        config.clone(),
        database,
        events.clone(),
        interactions.clone(),
        diagnostics.clone(),
        media.clone(),
    )
    .await?;
    let scheduler = match schedule::start(
        config.clone(),
        sessions.clone(),
        events.clone(),
        diagnostics.clone(),
    )
    .await
    {
        Ok(scheduler) => scheduler,
        Err(error) => {
            return Err(match sessions.shutdown().await {
                Ok(()) => error,
                Err(cleanup) => error.with_data(serde_json::json!({ "cleanup": cleanup })),
            });
        }
    };
    let serving = gateway::serve(
        config,
        sessions.clone(),
        events,
        interactions,
        diagnostics,
        media,
        listener,
    )
    .await;
    let mut failures = Vec::new();
    if let Err(error) = serving {
        failures.push(error);
    }
    if let Err(error) = schedule::shutdown().await {
        failures.push(error);
    }
    if let Err(source) = scheduler.await {
        failures.push(rpc::Error::internal("schedule_shutdown_task").with_source(source));
    }
    if let Err(error) = matcha_app_server::channel::shutdown().await {
        failures.push(error);
    }
    if let Err(error) = sessions.shutdown().await {
        failures.push(error);
    }
    if failures.is_empty() {
        Ok(())
    } else {
        let primary = failures.remove(0);
        Err(if failures.is_empty() {
            primary
        } else {
            primary.with_data(serde_json::json!({ "relatedFailures": failures }))
        })
    }
}
