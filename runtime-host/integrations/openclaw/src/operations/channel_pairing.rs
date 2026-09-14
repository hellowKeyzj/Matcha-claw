use std::{
    collections::BTreeMap,
    ffi::OsString,
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[cfg(windows)]
use foundation::process::windows_system_root;

use serde::Deserialize;
use serde_json::{Map, Value};
use tokio::task;
use zeroize::{Zeroize, Zeroizing};

use crate::gateway::{
    client::GatewayClient,
    wire::{self, GatewayResponse},
};

use super::{OperationsReadError, next_request_id, read_gateway};

const ELECTRON_RUN_AS_NODE: &str = "ELECTRON_RUN_AS_NODE";
const OPENCLAW_STATE_DIR: &str = "OPENCLAW_STATE_DIR";
const SYSTEM_ROOT: &str = "SystemRoot";
const CHANNELS_PAIRING_LIST_METHOD: &str = "channels.pairing.list";
const PAIRING_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_PAIRING_REQUESTS: usize = 3;
const MAX_CODE_BYTES: usize = 128;
const APPROVE_PROGRAM: &str = "import { approveChannelPairingCode } from 'openclaw/plugin-sdk/conversation-runtime'; import { readFileSync } from 'node:fs'; const [channel, account] = process.argv.slice(1); const code = readFileSync(0, 'utf8').trim(); if (!channel || !code) process.exit(2); const approved = account ? await approveChannelPairingCode({channel, accountId: account, code}) : await approveChannelPairingCode({channel, code}); process.stdout.write(JSON.stringify(approved));";

/// Source-backed OpenClaw channel pairing operations.
///
/// Approval accepts the code supplied explicitly by the user and passes it to the
/// native pairing-store producer. List results come from the live Gateway pairing
/// endpoint and expose only public request metadata.
pub struct ChannelPairingOperation {
    command: OpenClawCommand,
}

impl ChannelPairingOperation {
    pub fn try_new(
        executable: PathBuf,
        entry: PathBuf,
        working_directory: PathBuf,
        state_dir: PathBuf,
    ) -> Result<Self, ChannelPairingOperationError> {
        Ok(Self {
            command: OpenClawCommand::try_new(executable, entry, working_directory, state_dir)?,
        })
    }

    pub async fn list(
        gateway: &GatewayClient,
        channel: String,
        account: Option<String>,
    ) -> ChannelPairingEffect {
        list_via_gateway(gateway, channel, account).await
    }

    pub async fn approve(
        &self,
        channel: String,
        account: Option<String>,
        code: Zeroizing<Vec<u8>>,
    ) -> ChannelPairingApprovalEffect {
        if !valid_identity(&channel) || !valid_optional_identity(account.as_deref()) {
            return ChannelPairingApprovalEffect::TargetRejected;
        }
        if code.is_empty()
            || code.len() > MAX_CODE_BYTES
            || !code.iter().all(u8::is_ascii_alphanumeric)
        {
            return ChannelPairingApprovalEffect::TargetRejected;
        }
        let command = self.command.approve(&channel, account.as_deref(), code);
        match task::spawn_blocking(move || command.run()).await {
            Ok(Ok(_)) => ChannelPairingApprovalEffect::Confirmed,
            Ok(Err(PairingExecution::Rejected)) => ChannelPairingApprovalEffect::TargetRejected,
            Ok(Err(PairingExecution::Unknown)) | Err(_) => {
                ChannelPairingApprovalEffect::OutcomeUnknown
            }
        }
    }
}

#[derive(Clone)]
struct OpenClawCommand {
    executable: PathBuf,
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
    ) -> Result<Self, ChannelPairingOperationError> {
        if !executable.is_absolute()
            || !entry.is_absolute()
            || !working_directory.is_absolute()
            || !state_dir.is_absolute()
        {
            return Err(ChannelPairingOperationError::InvalidInput);
        }
        #[cfg(windows)]
        let system_root =
            windows_system_root().map_err(|_| ChannelPairingOperationError::InvalidInput)?;
        Ok(Self {
            executable,
            working_directory,
            state_dir,
            #[cfg(windows)]
            system_root,
        })
    }

    fn approve(
        &self,
        channel: &str,
        account: Option<&str>,
        code: Zeroizing<Vec<u8>>,
    ) -> PairingApprovalInvocation {
        PairingApprovalInvocation {
            command: self.clone(),
            channel: channel.into(),
            account: account.map(str::to_owned),
            code,
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

struct PairingApprovalInvocation {
    command: OpenClawCommand,
    channel: String,
    account: Option<String>,
    code: Zeroizing<Vec<u8>>,
}

impl PairingApprovalInvocation {
    fn run(mut self) -> Result<Vec<u8>, PairingExecution> {
        let mut args = vec![
            OsString::from("-e"),
            OsString::from(APPROVE_PROGRAM),
            self.channel.into(),
        ];
        args.push(self.account.unwrap_or_default().into());
        let mut child = Command::new(&self.command.executable)
            .args(args)
            .current_dir(&self.command.working_directory)
            .env_clear()
            .envs(self.command.environment())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| PairingExecution::Unknown)?;
        let mut stdin = child.stdin.take().ok_or(PairingExecution::Unknown)?;
        let write_result = stdin
            .write_all(&self.code)
            .and_then(|_| stdin.write_all(b"\n"));
        self.code.zeroize();
        drop(stdin);
        if write_result.is_err() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(PairingExecution::Unknown);
        }
        let output = wait_for_child(&mut child, PAIRING_TIMEOUT)?;
        if !output.status.success() {
            return Err(classify_exit(output.status.code()));
        }
        Ok(output.stdout)
    }
}

fn wait_for_child(
    child: &mut std::process::Child,
    timeout: Duration,
) -> Result<std::process::Output, PairingExecution> {
    let stdout = child.stdout.take().ok_or(PairingExecution::Unknown)?;
    let reader = thread::spawn(move || {
        let mut stdout = stdout;
        let mut output = Vec::new();
        stdout.read_to_end(&mut output).map(|_| output)
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = reader
                    .join()
                    .map_err(|_| PairingExecution::Unknown)?
                    .map_err(|_| PairingExecution::Unknown)?;
                return Ok(std::process::Output {
                    status,
                    stdout,
                    stderr: Vec::new(),
                });
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err(PairingExecution::Unknown);
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PairingExecution {
    Rejected,
    Unknown,
}

fn classify_exit(code: Option<i32>) -> PairingExecution {
    match code {
        Some(2) | Some(3) => PairingExecution::Rejected,
        _ => PairingExecution::Unknown,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChannelPairingRequest {
    pub id: String,
    pub created_at: String,
    pub last_seen_at: String,
    pub meta: Option<BTreeMap<String, String>>,
    pub status: ChannelPairingRequestStatus,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChannelPairingRequestStatus {
    Pending,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChannelPairingEffect {
    Listed(Vec<ChannelPairingRequest>),
    UnknownPairingChannel,
    Rejected,
    OutcomeUnknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChannelPairingApprovalEffect {
    Confirmed,
    TargetRejected,
    OutcomeUnknown,
}

async fn list_via_gateway(
    gateway: &GatewayClient,
    channel: String,
    account: Option<String>,
) -> ChannelPairingEffect {
    if !valid_identity(&channel) || !valid_optional_identity(account.as_deref()) {
        return ChannelPairingEffect::Rejected;
    }
    let request = match channel_pairing_list_request(
        next_request_id("channel-pairing-list"),
        &channel,
        account.as_deref(),
    ) {
        Ok(request) => request,
        Err(_) => return ChannelPairingEffect::OutcomeUnknown,
    };
    let response = match read_gateway(gateway, request).await {
        Ok(response) => response,
        Err(OperationsReadError::Rejected) => {
            super::channel_config::channel_trace("pairing.gateway.list", "outcome=rpc_rejected");
            return ChannelPairingEffect::Rejected;
        }
        Err(OperationsReadError::Unavailable) => {
            super::channel_config::channel_trace("pairing.gateway.list", "outcome=unavailable");
            return ChannelPairingEffect::OutcomeUnknown;
        }
        Err(OperationsReadError::Protocol) => {
            super::channel_config::channel_trace("pairing.gateway.list", "outcome=protocol");
            return ChannelPairingEffect::OutcomeUnknown;
        }
    };
    match response {
        GatewayResponse::Failure { error, .. } => {
            super::channel_config::channel_trace(
                "pairing.gateway.list",
                &format!("outcome=failure code={}", error.code()),
            );
            if error.code() == "INVALID_REQUEST"
                && error.message().contains("unknown pairing channel")
            {
                ChannelPairingEffect::UnknownPairingChannel
            } else {
                ChannelPairingEffect::Rejected
            }
        }
        response => match decode_requests(response, &channel, account.as_deref()) {
            Ok(requests) => ChannelPairingEffect::Listed(requests),
            Err(()) => {
                super::channel_config::channel_trace("pairing.decode", "outcome=invalid");
                ChannelPairingEffect::OutcomeUnknown
            }
        },
    }
}

fn channel_pairing_list_request(
    request_id: String,
    channel: &str,
    account: Option<&str>,
) -> Result<wire::RpcRequest, wire::WireError> {
    let mut params = Map::new();
    params.insert("channel".into(), Value::String(channel.to_owned()));
    if let Some(account) = account {
        params.insert("accountId".into(), Value::String(account.to_owned()));
    }
    wire::operations_request(
        request_id,
        CHANNELS_PAIRING_LIST_METHOD,
        Value::Object(params),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingRequestWire {
    request_id: String,
    channel: String,
    account_id: String,
    sender_id: String,
    created_at: String,
    last_seen_at: String,
}

fn decode_requests(
    response: GatewayResponse,
    expected_channel: &str,
    expected_account: Option<&str>,
) -> Result<Vec<ChannelPairingRequest>, ()> {
    let GatewayResponse::Success {
        payload: Some(Value::Object(mut payload)),
        ..
    } = response
    else {
        return Err(());
    };
    let Some(Value::Array(requests)) = payload.remove("requests") else {
        return Err(());
    };
    if requests.len() > MAX_PAIRING_REQUESTS {
        return Err(());
    }
    requests
        .into_iter()
        .map(|request| {
            let request: PairingRequestWire = serde_json::from_value(request).map_err(|_| ())?;
            if request.channel != expected_channel
                || expected_account.is_some_and(|account| request.account_id != account)
            {
                return Err(());
            }
            let id = normalize_identity(&request.sender_id).ok_or(())?;
            if normalize_identity(&request.request_id).is_none() {
                return Err(());
            }
            let account_id = normalize_identity(&request.account_id).ok_or(())?;
            let created_at = normalize_timestamp(&request.created_at).ok_or(())?;
            let last_seen_at = normalize_timestamp(&request.last_seen_at).ok_or(())?;
            Ok(ChannelPairingRequest {
                id,
                created_at,
                last_seen_at,
                meta: Some(BTreeMap::from([(String::from("accountId"), account_id)])),
                status: ChannelPairingRequestStatus::Pending,
            })
        })
        .collect()
}

fn normalize_identity(value: &str) -> Option<String> {
    let value = value.trim();
    valid_identity(value).then(|| value.to_owned())
}

fn normalize_timestamp(value: &str) -> Option<String> {
    let value = value.trim();
    valid_timestamp(value).then(|| value.to_owned())
}

fn valid_timestamp(value: &str) -> bool {
    parse_rfc3339_timestamp(value).is_some()
}

fn parse_rfc3339_timestamp(value: &str) -> Option<i128> {
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
    {
        return None;
    }
    let year = decimal(bytes, 0, 4)?;
    let month = decimal(bytes, 5, 2)?;
    let day = decimal(bytes, 8, 2)?;
    let hour = decimal(bytes, 11, 2)?;
    let minute = decimal(bytes, 14, 2)?;
    let second = decimal(bytes, 17, 2)?;
    if !(1..=12).contains(&month)
        || !(1..=days_in_month(year, month)).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }

    let mut index = 19;
    let mut nanos = 0_i128;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let fraction_start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            if index - fraction_start < 9 {
                nanos = nanos * 10 + i128::from(bytes[index] - b'0');
            }
            index += 1;
        }
        let fraction_len = index - fraction_start;
        if fraction_len == 0 {
            return None;
        }
        for _ in fraction_len.min(9)..9 {
            nanos *= 10;
        }
    }

    let offset_seconds = match bytes.get(index) {
        Some(b'Z') if index + 1 == bytes.len() => 0,
        Some(sign @ (b'+' | b'-'))
            if index + 6 == bytes.len() && bytes.get(index + 3) == Some(&b':') =>
        {
            let offset_hours = decimal(bytes, index + 1, 2)?;
            let offset_minutes = decimal(bytes, index + 4, 2)?;
            if offset_hours > 23 || offset_minutes > 59 {
                return None;
            }
            let offset = offset_hours * 3_600 + offset_minutes * 60;
            if *sign == b'+' { offset } else { -offset }
        }
        _ => return None,
    };

    i128::from(days_from_civil(year, month, day))
        .checked_mul(86_400)?
        .checked_add(i128::from(hour * 3_600 + minute * 60 + second))?
        .checked_sub(i128::from(offset_seconds))?
        .checked_mul(1_000_000_000)?
        .checked_add(nanos)
}

fn decimal(bytes: &[u8], start: usize, length: usize) -> Option<i64> {
    bytes
        .get(start..start.checked_add(length)?)?
        .iter()
        .try_fold(0_i64, |value, digit| {
            digit
                .is_ascii_digit()
                .then(|| value * 10 + i64::from(*digit - b'0'))
        })
}

const fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => 0,
    }
}

const fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year / 400;
    let year_of_era = year - era * 400;
    let month_from_march = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_from_march + 2) / 5 + day - 1;
    era * 146_097 + year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year - 719_468
}

fn valid_optional_identity(value: Option<&str>) -> bool {
    value.is_none_or(valid_identity)
}

fn valid_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| !character.is_control() && !character.is_whitespace())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChannelPairingOperationError {
    InvalidInput,
}

impl std::fmt::Display for ChannelPairingOperationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("OpenClaw channel pairing operation is invalid")
    }
}

impl std::error::Error for ChannelPairingOperationError {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    const CHANNEL: &str = "feishu";
    const TIMEOUT_CHILD_ENV: &str = "MATCHA_PAIRING_TIMEOUT_CHILD";

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
    fn wait_for_child_kills_timed_out_process() {
        let executable = std::env::current_exe().unwrap();
        let mut child = Command::new(executable)
            .arg("--exact")
            .arg("operations::channel_pairing::tests::timeout_child_entry")
            .arg("--nocapture")
            .env(TIMEOUT_CHILD_ENV, "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();

        assert_eq!(
            wait_for_child(&mut child, Duration::from_millis(30)),
            Err(PairingExecution::Unknown)
        );
        let status = child.try_wait().unwrap();
        eprintln!("post-timeout child status: {status:?}");
    }

    fn response(payload: Value) -> GatewayResponse {
        GatewayResponse::Success {
            request_id: "test".into(),
            payload: Some(payload),
        }
    }

    #[test]
    fn pairing_list_uses_channel_plugin_id() {
        let request = channel_pairing_list_request("test".into(), CHANNEL, Some("main")).unwrap();

        assert_eq!(request.method(), CHANNELS_PAIRING_LIST_METHOD);
        assert_eq!(
            request.params(),
            Some(&json!({"channel": CHANNEL, "accountId": "main"}))
        );
    }

    #[test]
    fn list_decodes_gateway_public_fields_without_code() {
        let requests = decode_requests(
            response(json!({
                "accounts": [],
                "requests": [{
                    "requestId": "telegram:main:sender-1",
                    "channel": CHANNEL,
                    "channelLabel": "Feishu",
                    "accountId": "main",
                    "accountLabel": "Main",
                    "senderId": "sender-1",
                    "senderLabel": "Sender",
                    "metadata": {
                        "display": "Sender",
                        "private": "must-not-project"
                    },
                    "createdAt": "2026-08-07T00:00:00.000Z",
                    "lastSeenAt": "2026-08-07T00:01:00.000Z",
                    "expiresAt": "2026-08-07T00:05:00.000Z",
                    "notifySupported": true,
                    "code": "SECRET",
                    "native": {
                        "token": "native-secret"
                    },
                    "raw": "raw-secret"
                }],
                "commandOwnerConfigured": true,
                "limits": {
                    "pendingPerAccount": 3,
                    "ttlMs": 300000
                }
            })),
            CHANNEL,
            Some("main"),
        )
        .unwrap();
        assert_eq!(
            requests,
            vec![ChannelPairingRequest {
                id: "sender-1".into(),
                created_at: "2026-08-07T00:00:00.000Z".into(),
                last_seen_at: "2026-08-07T00:01:00.000Z".into(),
                meta: Some(BTreeMap::from([(
                    String::from("accountId"),
                    String::from("main")
                )])),
                status: ChannelPairingRequestStatus::Pending,
            }]
        );
        let debug = format!("{:?}", requests);
        assert!(!debug.contains("SECRET"));
        assert!(!debug.contains("native-secret"));
        assert!(!debug.contains("raw-secret"));
        assert!(!debug.contains("must-not-project"));
    }

    #[test]
    fn list_rejects_malformed_gateway_output() {
        assert!(decode_requests(response(json!({})), CHANNEL, None).is_err());
        assert!(
            decode_requests(
                response(json!({
                    "requests": [{
                        "requestId": "request-1",
                        "channel": "wrong",
                        "accountId": "main",
                        "senderId": "sender-1",
                        "createdAt": "2026-08-07T00:00:00.000Z",
                        "lastSeenAt": "2026-08-07T00:01:00.000Z"
                    }]
                })),
                CHANNEL,
                None,
            )
            .is_err()
        );
        assert!(
            decode_requests(
                response(json!({
                    "requests": [{
                        "requestId": "request-1",
                        "channel": CHANNEL,
                        "accountId": "other",
                        "senderId": "sender-1",
                        "createdAt": "2026-08-07T00:00:00.000Z",
                        "lastSeenAt": "2026-08-07T00:01:00.000Z"
                    }]
                })),
                CHANNEL,
                Some("main"),
            )
            .is_err()
        );
        for timestamp in ["", "not-a-timestamp", "2026-02-30T00:00:00Z"] {
            assert!(
                decode_requests(
                    response(json!({
                        "requests": [{
                            "requestId": "request-1",
                            "channel": CHANNEL,
                            "accountId": "main",
                            "senderId": "sender-1",
                            "createdAt": timestamp,
                            "lastSeenAt": "2026-08-07T00:01:00.000Z"
                        }]
                    })),
                    CHANNEL,
                    None,
                )
                .is_err(),
                "{timestamp}"
            );
        }
    }

    #[test]
    fn approval_plan_never_contains_code() {
        let code = "pairing-code-canary";
        let invocation = command().approve(CHANNEL, None, Zeroizing::new(code.as_bytes().to_vec()));
        let args = [APPROVE_PROGRAM, CHANNEL, ""].join(" ");
        assert!(!args.contains(code));
        assert!(
            !invocation
                .command
                .environment()
                .iter()
                .any(|(_, value)| value.to_string_lossy().contains(code))
        );
    }

    #[test]
    fn native_exit_classification_preserves_rejection_and_unknown() {
        assert_eq!(classify_exit(Some(2)), PairingExecution::Rejected);
        assert_eq!(classify_exit(Some(3)), PairingExecution::Rejected);
        assert_eq!(classify_exit(Some(1)), PairingExecution::Unknown);
        assert_eq!(classify_exit(None), PairingExecution::Unknown);
    }
}
