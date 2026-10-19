use std::{
    collections::BTreeMap, ffi::OsString, future::Future, path::PathBuf, pin::Pin, sync::Arc,
    time::Duration,
};

use foundation::toolchain::{
    FoundationToolchainCommandPort, ToolchainCommandPort, ToolchainCommandRequest,
    ToolchainPythonResolution,
};
use searxng::{
    EngineConfig, Error, PythonEnvironment, PythonExecution, SearchRequest, Service, ServiceConfig,
    ServiceInput,
};

struct PreparedPython {
    uv: PathBuf,
    commands: FoundationToolchainCommandPort,
}

impl PythonEnvironment for PreparedPython {
    fn prepare(&self) -> Pin<Box<dyn Future<Output = Result<PythonExecution, Error>> + Send + '_>> {
        Box::pin(async move {
            let request = ToolchainCommandRequest::new(
                self.uv.clone(),
                ["python", "find", "3.12", "--no-python-downloads"].map(OsString::from),
                Some(Duration::from_secs(15)),
            );
            let ToolchainPythonResolution::Ready(python) =
                self.commands.resolve_python(request).await
            else {
                return Err(Error::ToolchainUnavailable);
            };
            let mut paths = vec![
                python
                    .parent()
                    .ok_or(Error::ToolchainUnavailable)?
                    .to_owned(),
            ];
            if let Some(path) = std::env::var_os("PATH") {
                paths.extend(std::env::split_paths(&path));
            }
            Ok(PythonExecution {
                uv: self.uv.clone(),
                environment: vec![(
                    "PATH".into(),
                    std::env::join_paths(paths).map_err(|_| Error::ToolchainUnavailable)?,
                )],
            })
        })
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments: Vec<_> = std::env::args_os().skip(1).collect();
    let mut hold_seconds = 0u64;
    if let Some(index) = arguments.iter().position(|value| value == "--hold-seconds") {
        hold_seconds = arguments
            .get(index + 1)
            .ok_or("missing hold seconds")?
            .to_string_lossy()
            .parse()?;
        if hold_seconds > 300 {
            return Err("hold seconds must be at most 300".into());
        }
        arguments.drain(index..=index + 1);
    }
    let enabled = arguments
        .iter()
        .position(|value| value == "--enable-engine")
        .map(|index| arguments.remove(index))
        .is_some();
    if arguments.len() < 3 {
        return Err("usage: probe <resource root> <new writable state directory> <uv executable> [engine] [guardian executable] [--enable-engine] [--hold-seconds 0..300]".into());
    }
    let resources_dir = PathBuf::from(&arguments[0]);
    let state_dir = PathBuf::from(&arguments[1]);
    let uv = PathBuf::from(&arguments[2]);
    let engine = arguments
        .get(3)
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "bing".to_owned());
    let guardian_executable = arguments.get(4).map(PathBuf::from);
    std::fs::create_dir_all(&state_dir)?;
    #[cfg(windows)]
    let commands = FoundationToolchainCommandPort::new(state_dir.clone());
    #[cfg(unix)]
    let commands = FoundationToolchainCommandPort::new(
        state_dir.clone(),
        guardian_executable
            .clone()
            .ok_or("guardian executable is required")?,
    );
    let service = Arc::new(Service::new(ServiceInput {
        resources_dir,
        state_dir,
        python_environment: Arc::new(PreparedPython { uv, commands }),
        guardian_executable,
    }));
    let config = ServiceConfig {
        language: "en".to_owned(),
        safe_search: 1,
        request_timeout_seconds: 15,
        proxy_url: None,
        engines: vec![EngineConfig {
            name: engine.clone(),
            enabled,
            timeout_seconds: Some(15),
            weight: Some(1.0),
            options: BTreeMap::new(),
        }],
    };
    assert!(!service.is_running());
    let mut invalid = config.clone();
    invalid.engines[0]
        .options
        .insert("api_key".to_owned(), serde_json::json!("must-not-leak"));
    assert_eq!(service.validate_config(&invalid), Err(Error::InvalidConfig));
    service.prepare().await?;
    let base_url = service.start(&config).await?;
    println!("owned_service_base_url={base_url}");
    let outcome = async {
        assert!(service.is_running());
        assert_eq!(service.base_url().as_deref(), Some(base_url.as_str()));
        let catalog = service.catalog().await?;
        assert!(
            catalog
                .iter()
                .any(|entry| entry.name == engine && entry.enabled == enabled)
        );
        let request = SearchRequest {
            query: "Rust programming language".to_owned(),
            categories: Some(
                catalog
                    .iter()
                    .find(|entry| entry.name == engine)
                    .expect("configured engine")
                    .categories[0]
                    .clone(),
            ),
            engines: Some(engine.clone()),
            language: Some("en".to_owned()),
            safe_search: Some(1),
            count: 3,
        };
        let mut unknown = request.clone();
        unknown.engines = Some("not-a-real-engine".to_owned());
        assert!(matches!(
            service.search(&unknown).await,
            Err(Error::InvalidRequest)
        ));
        let mut unknown_category = request.clone();
        unknown_category.categories = Some("not-a-real-category".to_owned());
        assert!(matches!(
            service.search(&unknown_category).await,
            Err(Error::InvalidRequest)
        ));
        if engine == "bing" {
            let mut images = request.clone();
            images.categories = Some("images".to_owned());
            assert!(matches!(
                service.search(&images).await,
                Err(Error::InvalidRequest)
            ));
        }
        for directive in ["!ddg Rust", ":fr Rust", "<1 Rust", "!! Rust"] {
            let mut injected = request.clone();
            injected.query = directive.to_owned();
            assert!(matches!(
                service.search(&injected).await,
                Err(Error::InvalidRequest)
            ));
        }
        let enabled_general: Vec<_> = catalog
            .iter()
            .filter(|entry| {
                entry.enabled
                    && entry
                        .categories
                        .iter()
                        .any(|category| category == "general")
            })
            .map(|entry| entry.name.as_str())
            .collect();
        println!(
            "enabled_general_engines={} names={}",
            enabled_general.len(),
            enabled_general.join(",")
        );
        let (first, second) = tokio::join!(service.search(&request), service.search(&request));
        let first = first?;
        let second = second?;
        println!(
            "catalog_engines={} results={} concurrent_results={} unresponsive={}",
            catalog.len(),
            first.results.len(),
            second.results.len(),
            first.unresponsive_engines
        );
        for hit in &first.results {
            assert!(!hit.title.trim().is_empty());
            let url = reqwest::Url::parse(&hit.url).expect("valid result URL");
            assert!(matches!(url.scheme(), "http" | "https"));
            println!("{} {}", hit.title, hit.url);
        }
        if first.results.is_empty() {
            return Err(Error::InvalidResponse);
        }
        let mut default_request = request.clone();
        default_request.engines = None;
        default_request.categories = Some("general".to_owned());
        let started = std::time::Instant::now();
        let default = service.search(&default_request).await?;
        println!(
            "default_general_results={} elapsed_ms={} unresponsive={}",
            default.results.len(),
            started.elapsed().as_millis(),
            default.unresponsive_engines
        );
        for hit in &default.results {
            println!("default_general_hit={} {}", hit.title, hit.url);
        }
        Ok(())
    }
    .await;
    if hold_seconds != 0 {
        println!("native_probe_hold_seconds={hold_seconds}");
        tokio::time::sleep(Duration::from_secs(hold_seconds)).await;
    }
    service.stop().await?;
    assert!(!service.is_running());
    assert!(matches!(service.catalog().await, Err(Error::NotRunning)));
    let address = reqwest::Url::parse(&base_url)?;
    assert!(
        tokio::net::TcpStream::connect(("127.0.0.1", address.port().expect("bound port")))
            .await
            .is_err()
    );
    println!("owned_process_stopped=true");
    outcome?;
    Ok(())
}
