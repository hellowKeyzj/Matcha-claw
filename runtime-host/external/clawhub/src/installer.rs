use std::{path::PathBuf, process::Command};

#[derive(Clone, Eq, PartialEq)]
pub struct ClawHubInstallRequest {
    slug: String,
    version: Option<String>,
    force: bool,
}

impl ClawHubInstallRequest {
    pub fn try_new(slug: String, version: Option<String>, force: bool) -> Result<Self, ()> {
        let slug = slug.trim().to_owned();
        if !is_slug(&slug) {
            return Err(());
        }
        let version = version.map(|version| version.trim().to_owned());
        if version.as_deref().is_some_and(str::is_empty) {
            return Err(());
        }
        Ok(Self {
            slug,
            version,
            force,
        })
    }

    pub fn slug(&self) -> &str {
        &self.slug
    }

    pub fn version(&self) -> Option<&str> {
        self.version.as_deref()
    }

    fn args(&self) -> Vec<String> {
        let mut args = vec!["install".to_owned(), self.slug.clone()];
        if let Some(version) = &self.version {
            args.push("--version".to_owned());
            args.push(version.clone());
        }
        if self.force {
            args.push("--force".to_owned());
        }
        args
    }
}

impl std::fmt::Debug for ClawHubInstallRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ClawHubInstallRequest([REDACTED])")
    }
}

#[derive(Clone)]
pub struct ClawHubCliInstaller {
    electron_image: PathBuf,
    work_dir: PathBuf,
    cli_entries: Vec<PathBuf>,
    registries: Vec<String>,
}

impl ClawHubCliInstaller {
    pub fn new(
        electron_image: PathBuf,
        work_dir: PathBuf,
        cli_entries: Vec<PathBuf>,
        registries: Vec<String>,
    ) -> Self {
        Self {
            electron_image,
            work_dir,
            cli_entries,
            registries,
        }
    }

    pub async fn install(&self, request: ClawHubInstallRequest) -> Result<(), ()> {
        let installer = self.clone();
        tokio::task::spawn_blocking(move || installer.install_blocking(request))
            .await
            .map_err(|_| ())?
    }

    fn install_blocking(self, request: ClawHubInstallRequest) -> Result<(), ()> {
        let Some(entry) = self.cli_entries.iter().find(|entry| entry.is_file()) else {
            return Err(());
        };
        let args = request.args();
        for registry in &self.registries {
            if self.run(entry, &args, registry).is_ok() {
                return Ok(());
            }
        }
        Err(())
    }

    fn run(&self, entry: &PathBuf, args: &[String], registry: &str) -> Result<(), ()> {
        let mut command = Command::new(&self.electron_image);
        command.arg(entry);
        command.args(args);
        command.current_dir(&self.work_dir);
        command.envs(std::env::vars_os());
        command.env("ELECTRON_RUN_AS_NODE", "1");
        command.env("CI", "true");
        command.env("FORCE_COLOR", "0");
        command.env("CLAWHUB_WORKDIR", &self.work_dir);
        command.env("CLAWHUB_REGISTRY", registry);
        let output = command.output().map_err(|_| ())?;
        output.status.success().then_some(()).ok_or(())
    }
}

fn is_slug(slug: &str) -> bool {
    let bytes = slug.as_bytes();
    let Some((&first, rest)) = bytes.split_first() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    let Some(&last) = rest.last() else {
        return true;
    };
    last.is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
}
