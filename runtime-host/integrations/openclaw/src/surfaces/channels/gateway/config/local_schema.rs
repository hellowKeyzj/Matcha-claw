use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};

use tokio::{io::AsyncReadExt, process::Command};

use serde_json::{Map, Value, json};

const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum LocalSchemaError {
    Unavailable,
    Invalid,
}

/// Resolves native descriptors without loading user config or registering plugins.
pub(super) async fn read(
    executable: &Path,
    openclaw_root: &Path,
    installed_extensions_root: &Path,
    managed_root: &Path,
    channel: &str,
) -> Result<Value, LocalSchemaError> {
    let started = Instant::now();
    super::channel_trace("schema.local.begin", "path=local");
    let result = async {
    if !super::valid_read_key(channel) {
        return Err(LocalSchemaError::Invalid);
    }
    for (source, root) in [
        ("installed", installed_extensions_root.to_path_buf()),
        ("managed", managed_root.to_path_buf()),
        ("bundled", openclaw_root.join("dist/extensions")),
    ] {
        super::channel_trace("schema.local.select", &format!("source={source}"));
        let Some((plugin_root, manifest)) = select_plugin(&root, channel)? else {
            continue;
        };
        let descriptor = manifest
            .get("channelConfigs")
            .and_then(|configs| configs.get(channel));
        if descriptor
            .and_then(|value| value.get("schema"))
            .and_then(|value| value.get("properties"))
            .and_then(Value::as_object)
            .is_some()
        {
            return payload(descriptor.ok_or(LocalSchemaError::Invalid)?, channel);
        }
        // WeCom has no native channel schema. This is the existing ClawX product
        // form (shared/types/channel.ts), verified against native accounts.js's
        // resolveWeComAccountMulti botId/secret reader, not a fabricated native schema.
        if channel == "wecom" {
            return payload(
                &json!({
                    "schema": {
                        "type": "object",
                        "properties": {
                            "botId": {"type": "string", "title": "Bot ID"},
                            "secret": {"type": "string", "title": "Secret", "format": "password"}
                        },
                        "required": ["botId", "secret"]
                    },
                    "uiHints": {"secret": {"sensitive": true}}
                }),
                channel,
            );
        }
        let descriptor =
            native_descriptor(executable, openclaw_root, &plugin_root, channel).await?;
        return payload(&descriptor, channel);
    }
    Err(LocalSchemaError::Unavailable)
    }.await;
    let code = match &result {
        Ok(_) => "success",
        Err(LocalSchemaError::Invalid) => "invalid",
        Err(LocalSchemaError::Unavailable) => "unavailable",
    };
    super::channel_trace(
        "schema.local.end",
        &format!("code={code} elapsedMs={}", started.elapsed().as_millis()),
    );
    result
}

fn select_plugin(root: &Path, channel: &str) -> Result<Option<(PathBuf, Value)>, LocalSchemaError> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(LocalSchemaError::Unavailable),
    };
    let mut selected = None;
    for entry in entries {
        let path = entry.map_err(|_| LocalSchemaError::Unavailable)?.path();
        if !path.join("openclaw.plugin.json").is_file() {
            continue;
        }
        let manifest = read_manifest(&path)?;
        if !manifest
            .get("channels")
            .and_then(Value::as_array)
            .is_some_and(|channels| channels.iter().any(|value| value.as_str() == Some(channel)))
        {
            continue;
        }
        if selected.is_some() {
            return Err(LocalSchemaError::Invalid);
        }
        selected = Some((path, manifest));
    }
    Ok(selected)
}

fn read_manifest(plugin_root: &Path) -> Result<Value, LocalSchemaError> {
    let file = File::open(plugin_root.join("openclaw.plugin.json"))
        .map_err(|_| LocalSchemaError::Unavailable)?;
    let mut bytes = Vec::new();
    file.take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| LocalSchemaError::Unavailable)?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(LocalSchemaError::Invalid);
    }
    serde_json::from_slice(&bytes).map_err(|_| LocalSchemaError::Invalid)
}

fn payload(descriptor: &Value, channel: &str) -> Result<Value, LocalSchemaError> {
    let descriptor = descriptor.as_object().ok_or(LocalSchemaError::Invalid)?;
    let schema = descriptor
        .get("schema")
        .and_then(Value::as_object)
        .ok_or(LocalSchemaError::Unavailable)?;
    let properties = schema
        .get("properties")
        .and_then(Value::as_object)
        .ok_or(LocalSchemaError::Unavailable)?;
    let hints = match descriptor.get("uiHints") {
        None => None,
        Some(Value::Object(hints)) => Some(hints),
        Some(_) => return Err(LocalSchemaError::Invalid),
    };
    let mut children = Vec::new();
    for (key, property) in properties {
        if !super::valid_read_key(key) {
            return Err(LocalSchemaError::Invalid);
        }
        let property = property.as_object().ok_or(LocalSchemaError::Invalid)?;
        // The public form supports scalars only. Keep the native schema intact,
        // but do not invent a scalar type for unions, refs, arrays or account maps.
        if !is_scalar_property(property) {
            continue;
        }
        let mut hint = match hints.and_then(|hints| hints.get(key)) {
            None => Map::new(),
            Some(Value::Object(hint)) => hint.clone(),
            Some(_) => return Err(LocalSchemaError::Invalid),
        };
        if super::is_sensitive_key(key)
            || super::password_format(property).map_err(|_| LocalSchemaError::Invalid)?
        {
            hint.insert("sensitive".into(), Value::Bool(true));
        }
        children.push(json!({"key": key, "hasChildren": false, "hint": hint}));
    }
    if children.len() > super::MAX_READ_FIELDS {
        return Err(LocalSchemaError::Invalid);
    }
    Ok(json!({
        "path": format!("channels.{channel}"),
        "schema": schema,
        "children": children,
    }))
}

// Only source-backed channel exports are loaded. The plugin entrypoint and its
// plugin-level configSchema are deliberately not used for channel forms.
const NATIVE_SCHEMA_PROGRAM: &str = r#"
const { createRequire } = await import('node:module');
const { realpathSync } = await import('node:fs');
const path = await import('node:path');
const { pathToFileURL } = await import('node:url');
const [root, pluginRoot, channel] = process.argv.slice(1);
for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) console[method] = () => {};
try {
  let descriptor;
  if (channel === 'feishu') {
    const source = await import(pathToFileURL(path.join(pluginRoot, 'dist/config-schema.mjs')).href);
    descriptor = { schema: source.FEISHU_CONFIG_JSON_SCHEMA };
  } else if (channel === 'openclaw-weixin') {
    const require = createRequire(path.join(realpathSync(root), 'package.json'));
    const { createJiti } = require('jiti');
    const loader = createJiti(path.join(pluginRoot, 'index.ts'), {
      fsCache: false,
      moduleCache: false,
      alias: { 'openclaw/plugin-sdk': path.join(root, 'dist/plugin-sdk') },
    });
    const source = await loader.import(path.join(pluginRoot, 'src/channel.ts'));
    if (source.weixinPlugin?.id !== channel) throw new Error('channel mismatch');
    descriptor = source.weixinPlugin.configSchema;
  } else {
    process.exit(2);
  }
  if (!descriptor?.schema?.properties) throw new Error('schema unavailable');
  process.stdout.write(JSON.stringify({ schema: descriptor.schema, uiHints: descriptor.uiHints }));
} catch {
  process.exitCode = 2;
}
"#;

async fn native_descriptor(
    executable: &Path,
    openclaw_root: &Path,
    plugin_root: &Path,
    channel: &str,
) -> Result<Value, LocalSchemaError> {
    if !matches!(channel, "feishu" | "openclaw-weixin") {
        return Err(LocalSchemaError::Unavailable);
    }
    let mut command = Command::new(executable);
    command
        .args(["--input-type=module", "-e", NATIVE_SCHEMA_PROGRAM])
        .arg(openclaw_root)
        .arg(plugin_root)
        .arg(channel)
        .current_dir(openclaw_root)
        .env_clear()
        .env("ELECTRON_RUN_AS_NODE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    #[cfg(windows)]
    command.env(
        "SystemRoot",
        foundation::process::windows_system_root().map_err(|_| LocalSchemaError::Unavailable)?,
    );
    let started = Instant::now();
    super::channel_trace("schema.native.begin", "execution=descriptor_process");
    let mut child = command.spawn().map_err(|error| {
        super::channel_trace(
            "schema.native.end",
            &format!(
                "outcome=spawn_failed ioKind={:?} elapsedMs={}",
                error.kind(),
                started.elapsed().as_millis()
            ),
        );
        LocalSchemaError::Unavailable
    })?;
    let stdout = child.stdout.take().ok_or(LocalSchemaError::Unavailable)?;
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        let mut bytes = Vec::new();
        stdout
            .take(MAX_MANIFEST_BYTES + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| LocalSchemaError::Unavailable)?;
        if bytes.len() as u64 > MAX_MANIFEST_BYTES {
            return Err(LocalSchemaError::Invalid);
        }
        let status = child
            .wait()
            .await
            .map_err(|_| LocalSchemaError::Unavailable)?;
        super::channel_trace(
            "schema.native.exit",
            &format!(
                "success={} statusCode={:?}",
                status.success(),
                status.code()
            ),
        );
        if !status.success() {
            return Err(LocalSchemaError::Unavailable);
        }
        serde_json::from_slice(&bytes).map_err(|_| LocalSchemaError::Invalid)
    })
    .await;
    let code = match &result {
        Ok(Ok(_)) => "success",
        Ok(Err(LocalSchemaError::Invalid)) => "invalid",
        Ok(Err(LocalSchemaError::Unavailable)) => "unavailable",
        Err(_) => "timeout",
    };
    super::channel_trace(
        "schema.native.end",
        &format!("code={code} elapsedMs={}", started.elapsed().as_millis()),
    );
    match result {
        Ok(result) => result,
        Err(_) => {
            let _ = child.kill().await;
            Err(LocalSchemaError::Unavailable)
        }
    }
}

fn is_scalar_property(property: &Map<String, Value>) -> bool {
    if ["$ref", "allOf", "anyOf", "oneOf"]
        .iter()
        .any(|key| property.contains_key(*key))
    {
        return false;
    }
    if let Some(options) = property.get("enum") {
        return options
            .as_array()
            .is_some_and(|options| !options.is_empty() && options.iter().all(Value::is_string));
    }
    if let Some(constant) = property.get("const") {
        return constant.is_string();
    }
    matches!(
        property.get("type").and_then(Value::as_str),
        Some("string" | "boolean" | "number" | "integer")
    )
}
