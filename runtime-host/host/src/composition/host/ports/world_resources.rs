use std::{fs::File, io::Read, path::Path, time::Duration};

use foundation::{execution::OwnedTask, process::ProcessContainment};
use platform::state_dir::CanonicalStateDir;
use sha2::{Digest as _, Sha256};
use world::{PackageReadLimits, PreparationPorts, WorldResources};
use world_protocol::ids::Digest;

const MAXIMUM_BLOB_BYTES: u64 = 1024 * 1024 * 1024;
const ARTIFACT_BYTES: usize = 1024 * 1024 * 1024;

pub(crate) fn prepare(
    root: &Path,
    wiki: wiki::WikiHandle,
    provider: provider_module::ProviderHandle,
    investigation: super::world_investigation::HostWorldInvestigation,
    containment: ProcessContainment,
) -> Result<(WorldResources, OwnedTask<()>), world::Error> {
    let content = CanonicalStateDir::provision_private(root.join("world/content"))
        .map_err(world::Error::preparation_failed)?;
    let packages = CanonicalStateDir::provision_private(root.join("world/packages"))
        .map_err(world::Error::preparation_failed)?;
    let process = CanonicalStateDir::provision_private(root.join("world/process"))
        .map_err(world::Error::preparation_failed)?;
    let host_build = host_build().map_err(world::Error::preparation_failed)?;
    let engine = wasm_host::Engine::try_new(wasm_host::EngineLimits {
        artifact_bytes: ARTIFACT_BYTES,
        concurrent_compilations: 2,
        cached_components: 16,
        cached_image_bytes: 256 * 1024 * 1024,
    })
    .map_err(world::Error::preparation_failed)?;
    let (clock, _) = engine
        .spawn_epoch_clock(Duration::from_millis(10))
        .map_err(world::Error::preparation_failed)?;
    Ok((
        WorldResources {
            content_root: content.as_path().to_path_buf(),
            maximum_blob_bytes: MAXIMUM_BLOB_BYTES,
            package_root: packages.as_path().to_path_buf(),
            package_limits: PackageReadLimits::default(),
            wiki: std::sync::Arc::new(super::world_wiki::HostWorldWiki(wiki)),
            generation: std::sync::Arc::new(super::world_generation::HostWorldGeneration(provider)),
            investigation: std::sync::Arc::new(investigation),
            preparation: PreparationPorts::new(
                engine,
                host_build,
                ARTIFACT_BYTES,
                containment,
                process,
                wasm_host::ExecutionLimits {
                    fuel: 100_000_000,
                    fuel_yield_interval: 10_000,
                    memory_bytes_per_memory: 64 * 1024 * 1024,
                    memories: 4,
                    table_elements_per_table: 65_536,
                    tables: 8,
                    instances: 64,
                    component_handles: 1_024,
                    host_resources: 256,
                    lift_bytes: 16 * 1024 * 1024,
                    output_bytes: 16 * 1024 * 1024,
                },
                Duration::from_secs(30),
                Duration::from_secs(10),
            ),
        },
        clock,
    ))
}

fn host_build() -> Result<Digest, std::io::Error> {
    let mut file = File::open(std::env::current_exe()?)?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Digest::try_new(format!("sha256:{:x}", digest.finalize())).map_err(std::io::Error::other)
}
