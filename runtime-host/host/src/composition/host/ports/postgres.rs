use std::{io, net::IpAddr, sync::Arc, time::Duration};

use tokio_postgres::{
    Config,
    config::{Host, SslMode},
};
use tokio_postgres_rustls::MakeRustlsConnect;

pub(crate) fn configuration(
    input: super::super::WorldPostgresConfig,
    identity: world::StorageIdentity,
) -> Result<world::StoreConfiguration, world::StoreError> {
    let (pool, drivers) = pool(input.connection_string())?;
    Ok(world::StoreConfiguration::Postgres {
        pool,
        drivers,
        identity,
        limits: world::StoreLimits {
            acquire_timeout: Duration::from_secs(5),
            statement_timeout: Duration::from_secs(10),
            transaction_timeout: Duration::from_secs(30),
            close_timeout: Duration::from_secs(5),
        },
    })
}

pub(crate) fn inspection(connection_string: String) -> Result<world::StoreConfiguration, world::StoreError> {
    configuration(super::super::WorldPostgresConfig::new(String::new(), connection_string),
        world::StorageIdentity::Existing { storage_id: String::new(), configuration_token: String::new() })
}

fn pool(
    connection_string: &str,
) -> Result<(deadpool_postgres::Pool, world::DriverCustody), world::StoreError> {
    let mut config = connection_string
        .parse::<Config>()
        .map_err(world::StoreError::connection_failed)?;
    let drivers = world::DriverCustody::new();
    let manager = match prepare(&mut config)? {
        Some(tls) => deadpool_postgres::Manager::from_connect(
            config,
            world::TrackedConnect::new(tls, drivers.clone()),
            deadpool_postgres::ManagerConfig::default(),
        ),
        None => deadpool_postgres::Manager::from_connect(
            config,
            world::TrackedConnect::new(tokio_postgres::NoTls, drivers.clone()),
            deadpool_postgres::ManagerConfig::default(),
        ),
    };
    let pool = deadpool_postgres::Pool::builder(manager)
        .max_size(8)
        .build()
        .map_err(world::StoreError::connection_failed)?;
    Ok((pool, drivers))
}

fn prepare(config: &mut Config) -> Result<Option<MakeRustlsConnect>, world::StoreError> {
    if config.get_connect_timeout().is_none() {
        config.connect_timeout(Duration::from_secs(5));
    }
    if config.get_ssl_mode() == SslMode::Disable {
        let addressed = !config.get_hosts().is_empty() || !config.get_hostaddrs().is_empty();
        let local = config.get_hosts().iter().all(|host| match host {
            Host::Tcp(host) => {
                host.eq_ignore_ascii_case("localhost")
                    || host
                        .parse::<IpAddr>()
                        .is_ok_and(|address| address.is_loopback())
            }
            #[cfg(unix)]
            Host::Unix(_) => true,
        }) && config.get_hostaddrs().iter().all(IpAddr::is_loopback);
        return if addressed && local {
            Ok(None)
        } else {
            Err(world::StoreError::connection_failed(io::Error::new(
                io::ErrorKind::InvalidInput,
                "unencrypted PostgreSQL requires an explicit local address",
            )))
        };
    }
    config.ssl_mode(SslMode::Require);
    verified_tls().map(Some)
}

pub(crate) fn verified_tls() -> Result<MakeRustlsConnect, world::StoreError> {
    let native = rustls_native_certs::load_native_certs();
    let mut roots = rustls::RootCertStore::empty();
    roots.add_parsable_certificates(native.certs);
    if roots.is_empty() {
        return Err(world::StoreError::connection_failed(io::Error::new(
            io::ErrorKind::NotFound,
            "PostgreSQL TLS trust roots are unavailable",
        )));
    }
    let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(world::StoreError::connection_failed)?
    .with_root_certificates(roots)
    .with_no_client_auth();
    Ok(MakeRustlsConnect::new(tls))
}
