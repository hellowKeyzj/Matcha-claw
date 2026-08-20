use std::{
    collections::BTreeMap,
    ffi::OsString,
    fmt,
    io::{self, Read, Write},
    path::PathBuf,
    process::{Child, Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};

#[cfg(windows)]
use foundation::process::windows_system_root;

use serde::Deserialize;
use tokio::task;
use zeroize::{Zeroize, Zeroizing};

use super::channel_identity::{AccountId, ChannelId};

const ELECTRON_RUN_AS_NODE: &str = "ELECTRON_RUN_AS_NODE";
const OPENCLAW_STATE_DIR: &str = "OPENCLAW_STATE_DIR";
const SYSTEM_ROOT: &str = "SystemRoot";
const VALIDATION_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_CANDIDATE_BYTES: usize = 1_048_576;
const MAX_NATIVE_OUTPUT_BYTES: usize = 16 * 1024;

const VALIDATION_PROGRAM: &str = r###"
const { readdirSync, readFileSync } = await import("node:fs");
const path = await import("node:path");
const { pathToFileURL } = await import("node:url");

for (const method of ["debug", "error", "info", "log", "trace", "warn"]) {
  if (typeof console[method] === "function") console[method] = () => {};
}

const [rawChannel, rawAccount = "", entryPath] = process.argv.slice(1);
let emitted = false;
const emit = (status, code) => {
  if (emitted) return;
  emitted = true;
  process.stdout.write(JSON.stringify({ status }) + "\n");
  process.exitCode = code;
};
const valid = () => emit("valid", 0);
const invalid = () => emit("invalid", 0);
const rejected = () => emit("rejected", 2);
const unknown = () => emit("unknown", 3);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const exactExport = (source, name) =>
  new RegExp(`export\\s*\\{[^}]*\\b${name}\\b(?!\\s+as)[^}]*\\}`, "s").test(source);
const exportedAlias = (source, name) => {
  const alias = source.match(
    new RegExp(`export\\s*\\{[^}]*\\b${name}\\s+as\\s+([A-Za-z_$][\\w$]*)[^}]*\\}`, "s"),
  );
  if (alias?.[1]) return alias[1];
  return exactExport(source, name) ? name : undefined;
};

const loadSemanticExport = async (directory, prefix, name) => {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".js"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    throw new Error("module discovery failed");
  }

  const sources = [];
  for (const file of entries) {
    const filePath = path.join(directory, file);
    let source;
    try {
      source = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    sources.push({ filePath, source });
  }

  const exact = sources
    .filter(({ source }) => exactExport(source, name))
    .map(({ filePath }) => ({ filePath, key: name }));
  const candidates = exact.length > 0
    ? exact
    : sources
        .map(({ filePath, source }) => ({ filePath, key: exportedAlias(source, name) }))
        .filter((candidate) => candidate.key);
  if (candidates.length !== 1) throw new Error("ambiguous module discovery");

  const imported = await import(pathToFileURL(candidates[0].filePath).href);
  const exported = imported[candidates[0].key];
  if (typeof exported !== "function") throw new Error("module export shape is invalid");
  return exported;
};

const channelInputFields = {
  telegram: { botToken: "token" },
  signal: { phoneNumber: "signalNumber" },
  mattermost: { serverUrl: "httpUrl", botToken: "botToken" },
  matrix: { homeserver: "homeserver", accessToken: "accessToken" },
  line: { channelAccessToken: "channelAccessToken", channelSecret: "channelSecret" },
};

try {
  if (typeof rawChannel !== "string" || typeof rawAccount !== "string" || typeof entryPath !== "string") {
    rejected();
  } else {
    const channel = rawChannel.trim().toLowerCase();
    const mapping = channelInputFields[channel];
    if (!mapping || !channel) {
      unknown();
    } else {
      let candidate;
      try {
        candidate = JSON.parse(readFileSync(0, "utf8"));
      } catch {
        rejected();
      }
      if (!emitted) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
          rejected();
        } else if (Object.values(candidate).some((value) => typeof value !== "string")) {
          rejected();
        }
      }
      if (!emitted) {
        const input = {};
        for (const [sourceKey, targetKey] of Object.entries(mapping)) {
          if (hasOwn(candidate, sourceKey)) input[targetKey] = candidate[sourceKey];
        }

        const { loadConfig } = await import("openclaw/plugin-sdk/config-runtime");
        const { normalizeAccountId } = await import("openclaw/plugin-sdk/account-id");
        const cfg = loadConfig({ skipPluginValidation: true });
        const runtime = {
          log: () => {},
          error: () => {},
          exit: () => {
            throw new Error("runtime exit");
          },
        };
        const packageDirectory = path.dirname(entryPath);
        const distDirectory = path.join(packageDirectory, "dist");
        const loadRegistry = await loadSemanticExport(
          distDirectory,
          "plugin-install-",
          "loadChannelSetupPluginRegistrySnapshotForChannel",
        );
        const snapshot = loadRegistry({
          cfg,
          runtime,
          channel,
          forceSetupOnlyChannelPlugins: true,
        });
        if (!snapshot || typeof snapshot.then === "function") throw new Error("registry snapshot is invalid");
        if (!Array.isArray(snapshot.channelSetups) || !Array.isArray(snapshot.channels)) {
          throw new Error("registry shape is invalid");
        }

        const matchingPlugin = (entries) => {
          const matches = entries.filter((entry) => entry?.plugin?.id === channel);
          if (matches.length > 1) throw new Error("ambiguous plugin registration");
          return matches[0]?.plugin;
        };
        let plugin = matchingPlugin(snapshot.channelSetups);
        if (!plugin) {
          const loadBundled = await loadSemanticExport(
            distDirectory,
            "bundled-",
            "getBundledChannelSetupPlugin",
          );
          plugin = loadBundled(channel);
        }
        if (!plugin) plugin = matchingPlugin(snapshot.channels);
        const setup = plugin?.setup;
        if (!setup || typeof setup !== "object" || typeof setup.validateInput !== "function") {
          throw new Error("setup validator is unavailable");
        }

        const accountArg = rawAccount.trim() || undefined;
        const accountId = typeof setup.resolveAccountId === "function"
          ? setup.resolveAccountId({ cfg, accountId: accountArg, input })
          : normalizeAccountId(accountArg);
        if (typeof accountId !== "string" || !accountId) throw new Error("resolved account is invalid");
        const validationError = setup.validateInput({ cfg, accountId, input });
        if (validationError && typeof validationError.then === "function") {
          throw new Error("async setup validator is unsupported");
        }
        if (validationError === null) valid();
        else if (typeof validationError === "string") invalid();
        else throw new Error("setup validator result is invalid");
      }
    }
  }
} catch {
  unknown();
}
"###;

pub struct ChannelCredentialsOperation {
    command: OpenClawCommand,
}

impl ChannelCredentialsOperation {
    pub fn try_new(
        executable: PathBuf,
        entry: PathBuf,
        working_directory: PathBuf,
        state_dir: PathBuf,
    ) -> Result<Self, ChannelCredentialsOperationError> {
        Ok(Self {
            command: OpenClawCommand::try_new(executable, entry, working_directory, state_dir)?,
        })
    }

    pub async fn validate(
        &self,
        channel: String,
        account: Option<String>,
        config: Zeroizing<Vec<u8>>,
    ) -> ChannelCredentialsEffect {
        let channel = match ChannelId::try_new(channel) {
            Ok(channel) => channel,
            Err(_) => return ChannelCredentialsEffect::Rejected,
        };
        let account = match account {
            Some(account) => match AccountId::try_new(account) {
                Ok(account) => Some(account),
                Err(_) => return ChannelCredentialsEffect::Rejected,
            },
            None => None,
        };
        if config.is_empty() || config.len() > MAX_CANDIDATE_BYTES {
            return ChannelCredentialsEffect::Rejected;
        }

        let invocation = self.command.validate(
            channel.as_str(),
            account.as_ref().map(AccountId::as_str),
            config,
        );
        match task::spawn_blocking(move || invocation.run()).await {
            Ok(Ok(output)) => decode_output(output),
            Ok(Err(ChannelCredentialsExecution::Unknown)) | Err(_) => {
                ChannelCredentialsEffect::OutcomeUnknown
            }
        }
    }
}

impl fmt::Debug for ChannelCredentialsOperation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ChannelCredentialsOperation")
            .finish_non_exhaustive()
    }
}

#[derive(Clone)]
struct OpenClawCommand {
    executable: PathBuf,
    entry: PathBuf,
    working_directory: PathBuf,
    state_dir: PathBuf,
    #[cfg(windows)]
    system_root: OsString,
}

impl OpenClawCommand {
    fn try_new(
        executable: PathBuf,
        entry: PathBuf,
        working_directory: PathBuf,
        state_dir: PathBuf,
    ) -> Result<Self, ChannelCredentialsOperationError> {
        if !executable.is_absolute()
            || !entry.is_absolute()
            || !working_directory.is_absolute()
            || !state_dir.is_absolute()
        {
            return Err(ChannelCredentialsOperationError::InvalidInput);
        }
        #[cfg(windows)]
        let system_root =
            windows_system_root().map_err(|_| ChannelCredentialsOperationError::InvalidInput)?;
        Ok(Self {
            executable,
            entry,
            working_directory,
            state_dir,
            #[cfg(windows)]
            system_root,
        })
    }

    fn validate(
        &self,
        channel: &str,
        account: Option<&str>,
        config: Zeroizing<Vec<u8>>,
    ) -> ValidationInvocation {
        ValidationInvocation {
            command: self.clone(),
            channel: channel.to_owned(),
            account: account.map(str::to_owned),
            config,
        }
    }

    fn environment(&self) -> Vec<(OsString, OsString)> {
        let mut environment = vec![
            (ELECTRON_RUN_AS_NODE.into(), "1".into()),
            (
                OPENCLAW_STATE_DIR.into(),
                self.state_dir.clone().into_os_string(),
            ),
        ];
        #[cfg(windows)]
        environment.push((SYSTEM_ROOT.into(), self.system_root.clone()));
        environment
    }
}

struct ValidationInvocation {
    command: OpenClawCommand,
    channel: String,
    account: Option<String>,
    config: Zeroizing<Vec<u8>>,
}

impl ValidationInvocation {
    fn run(mut self) -> Result<NativeOutput, ChannelCredentialsExecution> {
        let mut args = vec![
            OsString::from("-e"),
            OsString::from(VALIDATION_PROGRAM),
            self.channel.into(),
        ];
        args.push(self.account.unwrap_or_default().into());
        args.push(self.command.entry.clone().into_os_string());
        let mut child = Command::new(&self.command.executable)
            .args(args)
            .current_dir(&self.command.working_directory)
            .env_clear()
            .envs(self.command.environment())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| ChannelCredentialsExecution::Unknown)?;
        let Some(mut stdin) = child.stdin.take() else {
            self.config.zeroize();
            return Err(terminate_without_reader(&mut child));
        };
        let write_result = stdin.write_all(&self.config);
        self.config.zeroize();
        drop(stdin);
        if write_result.is_err() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(ChannelCredentialsExecution::Unknown);
        }
        wait_for_child(&mut child, VALIDATION_TIMEOUT)
    }
}

fn terminate_without_reader(child: &mut Child) -> ChannelCredentialsExecution {
    let _ = child.kill();
    let _ = child.wait();
    ChannelCredentialsExecution::Unknown
}

struct NativeOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
}

fn wait_for_child(
    child: &mut Child,
    timeout: Duration,
) -> Result<NativeOutput, ChannelCredentialsExecution> {
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(ChannelCredentialsExecution::Unknown);
    };
    let reader = thread::spawn(move || read_bounded(stdout));
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = reader
                    .join()
                    .map_err(|_| ChannelCredentialsExecution::Unknown)?
                    .map_err(|_| ChannelCredentialsExecution::Unknown)?;
                return Ok(NativeOutput { status, stdout });
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err(ChannelCredentialsExecution::Unknown);
            }
        }
    }
}

fn read_bounded(mut stdout: impl Read) -> io::Result<Vec<u8>> {
    let mut output = Vec::with_capacity(MAX_NATIVE_OUTPUT_BYTES.min(1024));
    let mut buffer = [0_u8; 8192];
    loop {
        let read = stdout.read(&mut buffer)?;
        if read == 0 {
            return Ok(output);
        }
        if output.len().saturating_add(read) > MAX_NATIVE_OUTPUT_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "native validation output exceeded the limit",
            ));
        }
        output.extend_from_slice(&buffer[..read]);
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ChannelCredentialsExecution {
    Unknown,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ValidationWire {
    status: ValidationWireStatus,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum ValidationWireStatus {
    Valid,
    Invalid,
    Rejected,
    Unknown,
}

fn decode_output(output: NativeOutput) -> ChannelCredentialsEffect {
    let wire: ValidationWire = match serde_json::from_slice(&output.stdout) {
        Ok(wire) => wire,
        Err(_) => return ChannelCredentialsEffect::OutcomeUnknown,
    };
    match (wire.status, output.status.code()) {
        (ValidationWireStatus::Valid, Some(0)) => {
            ChannelCredentialsEffect::Validated(ChannelCredentialsValidation {
                valid: true,
                errors: Vec::new(),
                warnings: Vec::new(),
                details: None,
            })
        }
        (ValidationWireStatus::Invalid, Some(0)) => {
            ChannelCredentialsEffect::Validated(ChannelCredentialsValidation {
                valid: false,
                errors: vec![String::from("The provider rejected these credentials.")],
                warnings: Vec::new(),
                details: None,
            })
        }
        (ValidationWireStatus::Rejected, Some(2)) => ChannelCredentialsEffect::Rejected,
        (ValidationWireStatus::Unknown, Some(3)) => ChannelCredentialsEffect::OutcomeUnknown,
        _ => ChannelCredentialsEffect::OutcomeUnknown,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChannelCredentialsValidation {
    pub valid: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub details: Option<BTreeMap<String, String>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChannelCredentialsEffect {
    Validated(ChannelCredentialsValidation),
    Rejected,
    OutcomeUnknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChannelCredentialsOperationError {
    InvalidInput,
}

impl fmt::Display for ChannelCredentialsOperationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("OpenClaw channel credentials operation is invalid")
    }
}

impl std::error::Error for ChannelCredentialsOperationError {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    const CHANNEL: &str = "telegram";
    const CREDENTIAL_CANARY: &str = "credential-canary";
    const TIMEOUT_CHILD_ENV: &str = "MATCHA_CREDENTIALS_TIMEOUT_CHILD";

    use std::io::Cursor;

    #[test]
    fn timeout_child_entry() {
        if std::env::var_os(TIMEOUT_CHILD_ENV).is_some() {
            thread::sleep(Duration::from_secs(60));
        }
    }

    fn command() -> OpenClawCommand {
        OpenClawCommand::try_new(
            PathBuf::from("C:/Matcha/MatchaClaw.exe"),
            PathBuf::from("C:/Matcha/openclaw.mjs"),
            PathBuf::from("C:/Matcha"),
            PathBuf::from("C:/State"),
        )
        .unwrap()
    }

    #[test]
    fn invalid_identity_and_candidate_size_are_rejected_before_spawn() {
        let operation = ChannelCredentialsOperation { command: command() };
        let runtime = tokio::runtime::Runtime::new().unwrap();
        assert_eq!(
            runtime.block_on(operation.validate(
                "with space".into(),
                None,
                Zeroizing::new(br#"{}"#.to_vec()),
            )),
            ChannelCredentialsEffect::Rejected
        );
        assert_eq!(
            runtime.block_on(operation.validate(
                CHANNEL.into(),
                None,
                Zeroizing::new(vec![b'x'; MAX_CANDIDATE_BYTES + 1]),
            )),
            ChannelCredentialsEffect::Rejected
        );
    }

    #[test]
    fn validation_program_does_not_contain_mutation_or_probe_seams() {
        for forbidden in [
            "applyAccountConfig",
            "writeConfigFile",
            "replaceConfigFile",
            "mutateConfigFile",
            "lifecycle",
            "probeAccount",
            "observeStatus",
        ] {
            assert!(!VALIDATION_PROGRAM.contains(forbidden), "{forbidden}");
        }
    }

    #[test]
    fn candidate_never_enters_arguments_or_environment_or_debug() {
        let invocation = command().validate(
            CHANNEL,
            None,
            Zeroizing::new(CREDENTIAL_CANARY.as_bytes().to_vec()),
        );
        let args = [
            "-e",
            VALIDATION_PROGRAM,
            CHANNEL,
            "",
            "C:/Matcha/openclaw.mjs",
        ]
        .join(" ");
        assert!(!args.contains(CREDENTIAL_CANARY));
        assert!(
            !invocation
                .command
                .environment()
                .iter()
                .any(|(_, value)| value.to_string_lossy().contains(CREDENTIAL_CANARY))
        );
        let operation = ChannelCredentialsOperation {
            command: invocation.command,
        };
        assert!(!format!("{operation:?}").contains(CREDENTIAL_CANARY));
    }

    #[test]
    fn bounded_reader_rejects_oversized_native_output() {
        let output = read_bounded(Cursor::new(vec![b'x'; MAX_NATIVE_OUTPUT_BYTES + 1]));
        assert!(output.is_err());
    }

    #[test]
    fn wire_projection_distinguishes_valid_invalid_rejected_and_unknown() {
        let valid = NativeOutput {
            status: exit_status(0),
            stdout: serde_json::to_vec(&json!({"status":"valid"})).unwrap(),
        };
        assert!(matches!(
            decode_output(valid),
            ChannelCredentialsEffect::Validated(ChannelCredentialsValidation { valid: true, .. })
        ));
        let invalid = NativeOutput {
            status: exit_status(0),
            stdout: serde_json::to_vec(&json!({"status":"invalid"})).unwrap(),
        };
        assert!(matches!(
            decode_output(invalid),
            ChannelCredentialsEffect::Validated(ChannelCredentialsValidation { valid: false, .. })
        ));
        let rejected = NativeOutput {
            status: exit_status(2),
            stdout: serde_json::to_vec(&json!({"status":"rejected"})).unwrap(),
        };
        assert_eq!(decode_output(rejected), ChannelCredentialsEffect::Rejected);
        let unknown = NativeOutput {
            status: exit_status(3),
            stdout: serde_json::to_vec(&json!({"status":"unknown"})).unwrap(),
        };
        assert_eq!(
            decode_output(unknown),
            ChannelCredentialsEffect::OutcomeUnknown
        );
    }

    #[test]
    fn malformed_or_ambiguous_wire_is_unknown() {
        for stdout in [
            br#"{}"#.to_vec(),
            br#"{"status":"valid","secret":"leak"}"#.to_vec(),
            br#"not-json"#.to_vec(),
        ] {
            assert_eq!(
                decode_output(NativeOutput {
                    status: exit_status(0),
                    stdout,
                }),
                ChannelCredentialsEffect::OutcomeUnknown
            );
        }
    }

    #[test]
    fn timeout_kills_native_child_and_returns_unknown() {
        let executable = std::env::current_exe().unwrap();
        let mut child = Command::new(executable)
            .arg("--exact")
            .arg("operations::channel_credentials::tests::timeout_child_entry")
            .arg("--nocapture")
            .env(TIMEOUT_CHILD_ENV, "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();

        assert!(matches!(
            wait_for_child(&mut child, Duration::from_millis(30)),
            Err(ChannelCredentialsExecution::Unknown)
        ));
        assert!(child.try_wait().unwrap().is_some());
    }

    #[test]
    fn operation_debug_and_public_projection_exclude_native_error_text() {
        let native_error = "provider-private-error-canary";
        let effect = ChannelCredentialsEffect::Validated(ChannelCredentialsValidation {
            valid: false,
            errors: vec![String::from("The provider rejected these credentials.")],
            warnings: Vec::new(),
            details: None,
        });
        assert!(!format!("{effect:?}").contains(native_error));
        assert!(
            !format!("{:?}", ChannelCredentialsOperation { command: command() })
                .contains(native_error)
        );
    }

    #[cfg(unix)]
    fn exit_status(code: i32) -> ExitStatus {
        use std::os::unix::process::ExitStatusExt;
        ExitStatus::from_raw(code << 8)
    }

    #[cfg(windows)]
    fn exit_status(code: i32) -> ExitStatus {
        use std::os::windows::process::ExitStatusExt;
        ExitStatus::from_raw(code as u32)
    }
}
