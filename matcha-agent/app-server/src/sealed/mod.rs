mod reader;
mod wire;

use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
};

use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    config::{self, Config, ConfigStore},
    rpc::{self, Error},
    session::Sessions,
};
use reader::{Reader, ReaderInput};

/// Shared private memory survives Config snapshots but is never serialized.
#[derive(Clone, Default)]
pub struct PrivateSource(Arc<Mutex<Source>>);

#[derive(Default)]
struct Source {
    origin: Option<SocketAddr>,
    reader: Option<Arc<Reader>>,
    instances: HashMap<String, Weak<Access>>,
}

struct Access {
    token: String,
    agent_id: String,
    session_id: String,
    instance_id: String,
    reader: Arc<Reader>,
    revoked: AtomicBool,
}

/// The real Cli::Instance owns this guard; a transcript cannot retain authority.
pub(crate) struct InstanceGuard {
    access: Arc<Access>,
    endpoint: String,
}

impl PrivateSource {
    pub(crate) fn acquire(
        &self,
        config: &Config,
        agent_id: &str,
        session_id: &str,
        instance_id: &str,
    ) -> rpc::Result<Option<InstanceGuard>> {
        config::validate_id(agent_id)?;
        if !config.agents.contains_key(agent_id) {
            return Err(Error::not_found("Agent"));
        }
        if Uuid::parse_str(session_id).is_err() || Uuid::parse_str(instance_id).is_err() {
            return Err(Error::invalid(
                "A sealed capability requires native session and instance UUIDs",
            ));
        }
        let mut source = self
            .0
            .lock()
            .map_err(|_| Error::internal("sealed_source_lock"))?;
        let Some(reader) = source.reader.clone() else {
            return Ok(None);
        };
        let endpoint = source
            .origin
            .filter(|origin| origin.ip().is_loopback())
            .map(|origin| format!("http://{origin}"))
            .ok_or_else(listener_unavailable)?;
        source.instances.retain(|_, access| {
            access
                .upgrade()
                .is_some_and(|access| !access.revoked.load(Ordering::Acquire))
        });
        let access = Arc::new(Access {
            token: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
            agent_id: agent_id.to_owned(),
            session_id: session_id.to_owned(),
            instance_id: instance_id.to_owned(),
            reader,
            revoked: AtomicBool::new(false),
        });
        if let Some(previous) = source
            .instances
            .insert(session_id.to_owned(), Arc::downgrade(&access))
            .and_then(|access| access.upgrade())
        {
            previous.revoked.store(true, Ordering::Release);
        }
        Ok(Some(InstanceGuard { access, endpoint }))
    }

    fn authorized(
        &self,
        session_id: &str,
        authorization: Option<&str>,
    ) -> rpc::Result<Arc<Access>> {
        let token = authorization
            .and_then(|value| value.strip_prefix("Bearer "))
            .ok_or_else(unauthorized)?;
        let access = self
            .0
            .lock()
            .map_err(|_| Error::internal("sealed_source_lock"))?
            .instances
            .get(session_id)
            .and_then(Weak::upgrade)
            .ok_or_else(unauthorized)?;
        if token.len() != access.token.len()
            || token
                .bytes()
                .zip(access.token.bytes())
                .fold(0, |different, (left, right)| different | (left ^ right))
                != 0
            || access.session_id != session_id
            || access.revoked.load(Ordering::Acquire)
        {
            return Err(unauthorized());
        }
        Ok(access)
    }
}

impl InstanceGuard {
    pub(crate) fn inject(&self, environment: &mut std::collections::BTreeMap<String, String>) {
        environment.insert("MATCHA_SEALED_ENDPOINT".into(), self.endpoint.clone());
        environment.insert("MATCHA_SEALED_TOKEN".into(), self.access.token.clone());
        environment.insert("MATCHA_SEALED_RUNTIME".into(), "matcha-agent".into());
    }

    pub(crate) fn revoke(&self) {
        self.access.revoked.store(true, Ordering::Release);
    }
}

impl Drop for InstanceGuard {
    fn drop(&mut self) {
        self.revoke();
    }
}

pub async fn bind_origin(config: &ConfigStore, listen: SocketAddr) -> rpc::Result<()> {
    if listen.port() == 0 {
        return Err(Error::invalid(
            "The sealed listener requires an assigned port",
        ));
    }
    let snapshot = config.snapshot().await;
    let mut source = snapshot
        .private_sealed
        .0
        .lock()
        .map_err(|_| Error::internal("sealed_source_lock"))?;
    if source.origin.is_some_and(|origin| origin != listen) {
        return Err(Error::conflict(
            "sealed_origin_changed",
            "The sealed listener origin is already bound",
        ));
    }
    source.origin = Some(listen);
    Ok(())
}

pub async fn dispatch(config: &ConfigStore, method: &str, params: Value) -> rpc::Result<Value> {
    if method != "sealedSkills.project" {
        return Err(Error::method(method));
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Project {
        reader: ReaderInput,
    }
    let input: Project = rpc::params(params)?;
    let reader = Arc::new(Reader::new(input.reader)?);
    let snapshot = config.snapshot().await;
    let mut source = snapshot
        .private_sealed
        .0
        .lock()
        .map_err(|_| Error::internal("sealed_source_lock"))?;
    if !source
        .origin
        .is_some_and(|origin| origin.ip().is_loopback())
    {
        return Err(listener_unavailable());
    }
    source.reader = Some(reader);
    Ok(json!({"projected":true,"application":"futureCliInstances"}))
}

pub async fn catalog(
    config: &ConfigStore,
    sessions: &Sessions,
    session_id: &str,
    authorization: Option<&str>,
) -> rpc::Result<Value> {
    let (source, access) = authorize(config, sessions, session_id, authorization).await?;
    let reader = &access.reader;
    let catalog = reader.catalog(&access.agent_id).await?;
    current(config, sessions, &source, &access, authorization).await?;
    rpc::value(catalog)
}

pub async fn read(
    config: &ConfigStore,
    sessions: &Sessions,
    session_id: &str,
    skill_key: &str,
    path: &str,
    authorization: Option<&str>,
    expected_package_sha256: Option<&str>,
) -> rpc::Result<Value> {
    let expected = expected_package_sha256
        .filter(|value| wire::sha256(value))
        .ok_or_else(|| Error::invalid("A lowercase sealed package SHA-256 is required"))?;
    if !wire::skill_key(skill_key) || !wire::relative_path(path) {
        return Err(Error::invalid(
            "The sealed skill key or relative path is invalid",
        ));
    }
    let (source, access) = authorize(config, sessions, session_id, authorization).await?;
    let reader = &access.reader;
    let catalog = reader.catalog(&access.agent_id).await?;
    let skill = catalog
        .skills
        .iter()
        .find(|skill| skill.skill_key == skill_key)
        .ok_or_else(|| Error::new(-32001, "sealed_unknown", "The sealed skill is unknown"))?;
    if skill.package_sha256 != expected {
        return Err(Error::conflict(
            "sealed_package_changed",
            "The sealed package has changed",
        ));
    }
    let file = skill
        .files
        .iter()
        .find(|file| file.path == path)
        .ok_or_else(|| Error::new(-32001, "sealed_unknown", "The sealed file is unknown"))?;
    let content = reader
        .read(&access.agent_id, skill_key, path, expected, file.size_bytes)
        .await?;
    content.validate(skill, file, expected).map_err(|error| {
        error.with_data(json!({"hostStatus":200,"delivery":"responseReceived"}))
    })?;
    current(config, sessions, &source, &access, authorization).await?;
    rpc::value(content)
}

async fn authorize(
    config: &ConfigStore,
    sessions: &Sessions,
    session_id: &str,
    authorization: Option<&str>,
) -> rpc::Result<(PrivateSource, Arc<Access>)> {
    if Uuid::parse_str(session_id).is_err() {
        return Err(Error::invalid("A native session UUID is required"));
    }
    let source = config.snapshot().await.private_sealed;
    let access = source.authorized(session_id, authorization)?;
    current(config, sessions, &source, &access, authorization).await?;
    Ok((source, access))
}

async fn current(
    config: &ConfigStore,
    sessions: &Sessions,
    source: &PrivateSource,
    access: &Arc<Access>,
    authorization: Option<&str>,
) -> rpc::Result<()> {
    let current = source.authorized(&access.session_id, authorization)?;
    if !Arc::ptr_eq(&current, access) || current.instance_id != access.instance_id {
        return Err(unauthorized());
    }
    let snapshot = config.snapshot().await;
    if !snapshot.agents.contains_key(&access.agent_id) {
        return Err(unauthorized());
    }
    let session = sessions
        .dispatch("sessions.get", json!({"sessionId":access.session_id}))
        .await?;
    if session.get("sessionId").and_then(Value::as_str) != Some(access.session_id.as_str())
        || session.get("agentId").and_then(Value::as_str) != Some(access.agent_id.as_str())
        || session.get("status").and_then(Value::as_str) != Some("open")
        || access.revoked.load(Ordering::Acquire)
    {
        return Err(unauthorized());
    }
    Ok(())
}

fn unauthorized() -> Error {
    Error::new(
        -32007,
        "sealed_unauthorized",
        "The CLI sealed capability is not current or authorized",
    )
}
fn listener_unavailable() -> Error {
    Error::unavailable(
        "sealed_listener_unavailable",
        "The Server listener does not support private sealed reads",
    )
}
