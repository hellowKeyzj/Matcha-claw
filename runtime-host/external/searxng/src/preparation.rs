use std::{
    ffi::OsString,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

use foundation::process::{
    LaunchSpec, OneShotCompletion, OneShotContainment, OneShotRun, OneShotRunner, StdioMode,
    StdioSpec,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{Error, ServiceInput, process};

const UPSTREAM_SHA: &str = "2a6fc07be3760543c7b6d1d1bfe62f5765d5d9d6";

pub(crate) struct Execution {
    pub(crate) python: PathBuf,
    pub(crate) environment: Vec<(OsString, OsString)>,
}

pub(crate) async fn prepare(input: &ServiceInput) -> Result<Execution, Error> {
    if !input.resources_dir.is_absolute() || !input.state_dir.is_absolute() {
        return Err(Error::ResourcesUnavailable);
    }
    process::containment(input)?;
    let manifest_bytes = read_bounded(&input.resources_dir.join("manifest.json"), 2 * 1024 * 1024)?;
    let manifest: Value =
        serde_json::from_slice(&manifest_bytes).map_err(|_| Error::ResourcesUnavailable)?;
    if manifest.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || manifest.get("upstreamSha").and_then(Value::as_str) != Some(UPSTREAM_SHA)
    {
        return Err(Error::ResourcesUnavailable);
    }
    let wheels = input.resources_dir.join("wheels").join(target()?);
    for path in [
        input.resources_dir.join("source/searx/settings.yml"),
        input.resources_dir.join("serve.py"),
        input.resources_dir.join("requirements.lock"),
    ] {
        if !path.is_file() {
            return Err(Error::ResourcesUnavailable);
        }
    }
    if !wheels.is_dir() {
        return Err(Error::ResourcesUnavailable);
    }
    fs::create_dir_all(input.state_dir.join("cache")).map_err(|_| Error::StateUnavailable)?;
    let execution = input.python_environment.prepare().await?;
    if !execution.uv.is_absolute() || !execution.uv.is_file() {
        return Err(Error::ToolchainUnavailable);
    }
    let uv = execution.uv;
    let mut environment = execution.environment;
    environment.extend(environment_overrides(input));
    let venv = input.state_dir.join("venv");
    let python = venv.join(if cfg!(windows) {
        "Scripts/python.exe"
    } else {
        "bin/python"
    });
    let fingerprint = format!("{:x}", Sha256::digest(&manifest_bytes));
    let marker = input.state_dir.join("prepared.sha256");
    if python.is_file() && fs::read_to_string(&marker).is_ok_and(|stored| stored == fingerprint) {
        return Ok(Execution {
            python,
            environment,
        });
    }
    if marker.exists() {
        fs::remove_file(&marker).map_err(|_| Error::StateUnavailable)?;
    }
    execute(
        input,
        &uv,
        vec![
            "venv".into(),
            "--clear".into(),
            "--python".into(),
            "3.12".into(),
            "--no-python-downloads".into(),
            venv.into_os_string(),
        ],
        &environment,
        Duration::from_secs(30),
    )
    .await?;
    execute(
        input,
        &uv,
        vec![
            "pip".into(),
            "install".into(),
            "--python".into(),
            python.clone().into_os_string(),
            "--offline".into(),
            "--only-binary".into(),
            ":all:".into(),
            "--require-hashes".into(),
            "--no-index".into(),
            "--find-links".into(),
            wheels.into_os_string(),
            "-r".into(),
            input
                .resources_dir
                .join("requirements.lock")
                .into_os_string(),
        ],
        &environment,
        Duration::from_secs(300),
    )
    .await?;
    execute(input, &python, vec!["-I".into(), "-B".into(), "-c".into(), "import sys, waitress, flask, curl_cffi, yaml, tzdata; assert sys.version_info[:2] == (3, 12)".into()], &environment, Duration::from_secs(15)).await?;
    fs::write(marker, fingerprint).map_err(|_| Error::StateUnavailable)?;
    Ok(Execution {
        python,
        environment,
    })
}

async fn execute(
    input: &ServiceInput,
    program: &Path,
    arguments: Vec<OsString>,
    environment: &[(OsString, OsString)],
    timeout: Duration,
) -> Result<(), Error> {
    let launch = LaunchSpec::try_new(
        program.to_owned(),
        input.state_dir.clone(),
        arguments,
        environment.to_vec(),
        StdioSpec::new(StdioMode::Null, StdioMode::Null, StdioMode::Null),
    )
    .map_err(|_| Error::PreparationFailed)?;
    let run = OneShotRun::try_new(
        launch,
        OneShotContainment::from_process_containment(process::containment(input)?),
        timeout,
    )
    .map_err(|_| Error::PreparationFailed)?;
    let mut operation = OneShotRunner::new()
        .start(run)
        .map_err(|_| Error::PreparationFailed)?;
    if operation.wait().await == OneShotCompletion::Succeeded {
        Ok(())
    } else {
        Err(Error::PreparationFailed)
    }
}

fn environment_overrides(input: &ServiceInput) -> Vec<(OsString, OsString)> {
    let mut environment: Vec<_> = [
        "HOME",
        "USERPROFILE",
        "LOCALAPPDATA",
        "APPDATA",
        "TEMP",
        "TMP",
        "LANG",
        "LC_ALL",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
    ]
    .into_iter()
    .filter_map(|key| std::env::var_os(key).map(|value| (OsString::from(key), value)))
    .collect();
    #[cfg(windows)]
    if let Ok(root) = foundation::process::windows_system_root() {
        environment.push(("SystemRoot".into(), root));
    }
    for (key, value) in [
        (
            "XDG_CACHE_HOME",
            input.state_dir.join("cache").into_os_string(),
        ),
        (
            "UV_CACHE_DIR",
            input.state_dir.join("cache/uv").into_os_string(),
        ),
        ("PYTHONDONTWRITEBYTECODE", "1".into()),
        (
            "SEARXNG_SETTINGS_PATH",
            input.state_dir.join("settings.yml").into_os_string(),
        ),
    ] {
        environment.push((key.into(), value));
    }
    environment
}

pub(crate) fn write_settings(state: &Path, bytes: &[u8]) -> Result<(), Error> {
    let path = state.join("settings.yml");
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|_| Error::StateUnavailable)?;
    file.write_all(bytes).map_err(|_| Error::StateUnavailable)?;
    file.sync_all().map_err(|_| Error::StateUnavailable)
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, Error> {
    let file = fs::File::open(path).map_err(|_| Error::ResourcesUnavailable)?;
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::ResourcesUnavailable)?;
    if bytes.len() as u64 > limit {
        return Err(Error::ResourcesUnavailable);
    }
    Ok(bytes)
}

fn target() -> Result<String, Error> {
    let platform = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        "linux" => "linux",
        _ => return Err(Error::ResourcesUnavailable),
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        _ => return Err(Error::ResourcesUnavailable),
    };
    Ok(format!("{platform}-{arch}"))
}
