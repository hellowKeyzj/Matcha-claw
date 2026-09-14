use std::{
    collections::HashMap,
    fmt::Write as _,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use image::Luma;
use qrcode::QrCode;
use reqwest::Url;
use serde::Deserialize;
use serde_json::{Map, Value};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroize;

use super::channel_config::channel_trace;
use super::channel_login::{
    LoginProgress, LoginProgressStatus, WebLoginStart, WebLoginStartEffect, WebLoginWait,
    WebLoginWaitEffect,
};
use crate::{
    gateway::wire::channel::{MAX_QR_DATA_URL_LENGTH, QR_DATA_URL_PREFIX},
    lifecycle::state_dir::CanonicalStateDir,
    projection::config_store::OpenClawConfigStore,
};

pub const OPENCLAW_WEIXIN_CHANNEL: &str = "openclaw-weixin";

const LEGACY_WECHAT_CHANNEL: &str = "wechat";
const DEFAULT_WECHAT_BASE_URL: &str = "https://ilinkai.weixin.qq.com";
const DEFAULT_ILINK_BOT_TYPE: &str = "3";
const ACTIVE_LOGIN_TTL: Duration = Duration::from_secs(5 * 60);
const DEFAULT_WAIT_TIMEOUT: Duration = Duration::from_secs(8 * 60);
const MIN_WAIT_TIMEOUT: Duration = Duration::from_secs(1);
const QR_POLL_REQUEST_TIMEOUT: Duration = Duration::from_secs(35);
const QR_POLL_INTERVAL: Duration = Duration::from_secs(1);
const MAX_QR_REFRESH_COUNT: u8 = 3;
const MAX_QR_SOURCE_BYTES: usize = 2_953;
const WEIXIN_STATE_DIR: &str = "openclaw-weixin";
const WEIXIN_ACCOUNTS_DIR: &str = "accounts";
const WEIXIN_ACCOUNT_INDEX_FILE: &str = "accounts.json";
const FALLBACK_ACCOUNT_ID: &str = "default";

#[derive(Clone)]
pub struct WeixinLogin {
    state_dir: CanonicalStateDir,
    client: reqwest::Client,
    sessions: Arc<Mutex<HashMap<String, ActiveLogin>>>,
}

impl WeixinLogin {
    pub fn new(state_dir: CanonicalStateDir) -> Self {
        Self {
            state_dir,
            client: reqwest::Client::new(),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn start(&self, input: WebLoginStart) -> WebLoginStartEffect {
        let started = Instant::now();
        channel_trace("weixin.start", "event=begin");
        let effect = self.start_login(input).await;
        let outcome = match &effect {
            WebLoginStartEffect::Progress(_) => "qr",
            WebLoginStartEffect::Rejected => "rejected",
            _ => "unknown",
        };
        channel_trace(
            "weixin.start",
            &format!(
                "event=end outcome={outcome} elapsedMs={}",
                started.elapsed().as_millis()
            ),
        );
        effect
    }

    async fn start_login(&self, input: WebLoginStart) -> WebLoginStartEffect {
        if !valid_optional_identity(input.account_id.as_deref()) {
            return WebLoginStartEffect::Rejected;
        }
        let account_id = input.account_id.filter(|value| !value.trim().is_empty());
        let api_base_url = self
            .load_config_string(account_id.as_deref(), "baseUrl")
            .unwrap_or_else(|| DEFAULT_WECHAT_BASE_URL.to_owned());
        let qr = match self
            .fetch_qr_code(&api_base_url, account_id.as_deref())
            .await
        {
            Ok(qr) => qr,
            Err(()) => return WebLoginStartEffect::Unknown,
        };
        let qr_data_url = match render_qr_data_url(&qr.qrcode_img_content) {
            Ok(qr_data_url) => qr_data_url,
            Err(()) => {
                channel_trace("weixin.qr-render", "outcome=unknown error=render-or-size");
                return WebLoginStartEffect::Unknown;
            }
        };
        let session_key = match random_session_key() {
            Some(session_key) => session_key,
            None => return WebLoginStartEffect::Unknown,
        };
        let progress = LoginProgress::new(
            LoginProgressStatus::Qr,
            account_id.clone(),
            Some(session_key.clone()),
            Some(qr_data_url.clone()),
        );
        self.sessions.lock().await.insert(
            session_key,
            ActiveLogin {
                qrcode: qr.qrcode.clone(),
                qr_data_url,
                account_id,
                api_base_url,
                started_at: Instant::now(),
                refresh_count: 1,
            },
        );
        WebLoginStartEffect::Progress(progress)
    }

    pub async fn wait(
        &self,
        input: WebLoginWait,
        cancellation: CancellationToken,
    ) -> WebLoginWaitEffect {
        let started = Instant::now();
        channel_trace("weixin.wait", "event=begin");
        let effect = self.wait_login(input, cancellation).await;
        let outcome = match &effect {
            WebLoginWaitEffect::Progress(progress) => match progress.status() {
                LoginProgressStatus::Connected => "confirmed",
                _ => "qr",
            },
            WebLoginWaitEffect::Rejected => "rejected",
            WebLoginWaitEffect::Cancelled => "cancelled",
            _ => "unknown",
        };
        channel_trace(
            "weixin.wait",
            &format!(
                "event=end outcome={outcome} elapsedMs={}",
                started.elapsed().as_millis()
            ),
        );
        effect
    }

    async fn wait_login(
        &self,
        input: WebLoginWait,
        cancellation: CancellationToken,
    ) -> WebLoginWaitEffect {
        if !valid_optional_identity(input.account_id.as_deref())
            || !valid_optional_identity(input.session_key.as_deref())
        {
            return WebLoginWaitEffect::Rejected;
        }
        let Some((session_key, login)) = self
            .session_snapshot(input.session_key.as_deref(), input.account_id.as_deref())
            .await
        else {
            channel_trace(
                "weixin.wait-session",
                "outcome=unknown reason=not-found-or-ambiguous",
            );
            return WebLoginWaitEffect::Unknown;
        };
        if login.started_at.elapsed() >= ACTIVE_LOGIN_TTL {
            channel_trace("weixin.wait-session", "outcome=unknown reason=expired");
            self.sessions.lock().await.remove(&session_key);
            return WebLoginWaitEffect::Unknown;
        }
        let timeout = input
            .timeout_ms
            .map(Duration::from_millis)
            .unwrap_or(DEFAULT_WAIT_TIMEOUT)
            .max(MIN_WAIT_TIMEOUT);
        let deadline = Instant::now() + timeout;

        loop {
            if cancellation.is_cancelled() {
                return WebLoginWaitEffect::Cancelled;
            }
            if Instant::now() >= deadline {
                channel_trace("weixin.wait-session", "outcome=unknown reason=deadline");
                self.sessions.lock().await.remove(&session_key);
                return WebLoginWaitEffect::Unknown;
            }
            let Some(current) = self.sessions.lock().await.get(&session_key).cloned() else {
                return WebLoginWaitEffect::Cancelled;
            };
            let status = tokio::select! {
                _ = cancellation.cancelled() => return WebLoginWaitEffect::Cancelled,
                status = self.poll_qr_status(&current.api_base_url, &current.qrcode, current.account_id.as_deref()) => status,
            };
            let status = match status {
                Ok(status) => status,
                Err(()) => return WebLoginWaitEffect::Unknown,
            };
            match status.status.trim() {
                "wait" => channel_trace("weixin.poll-state", "outcome=waiting"),
                "scaned" => channel_trace("weixin.poll-state", "outcome=scanned"),
                "expired" => {
                    channel_trace("weixin.poll-state", "outcome=expired action=refresh");
                    return self
                        .refresh_session(session_key, current, cancellation.clone())
                        .await;
                }
                "confirmed" => {
                    channel_trace(
                        "weixin.confirmed",
                        &format!(
                            "accountPresent={} credentialPresent={}",
                            status
                                .ilink_bot_id
                                .as_deref()
                                .is_some_and(|value| !value.trim().is_empty()),
                            status
                                .bot_token
                                .as_deref()
                                .is_some_and(|value| !value.trim().is_empty())
                        ),
                    );
                    self.sessions.lock().await.remove(&session_key);
                    let Some(raw_account_id) = status
                        .ilink_bot_id
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                    else {
                        return WebLoginWaitEffect::Unknown;
                    };
                    let Some(token) = status
                        .bot_token
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                    else {
                        return WebLoginWaitEffect::Unknown;
                    };
                    let account_id = match self.save_account_state(
                        raw_account_id,
                        token,
                        status.baseurl.as_deref(),
                        status.ilink_user_id.as_deref(),
                    ) {
                        Ok(account_id) => account_id,
                        Err(()) => return WebLoginWaitEffect::Unknown,
                    };
                    return WebLoginWaitEffect::Progress(LoginProgress::new(
                        LoginProgressStatus::Connected,
                        Some(account_id),
                        Some(session_key),
                        None,
                    ));
                }
                _ => channel_trace("weixin.poll-state", "outcome=unrecognized action=continue"),
            }
            tokio::select! {
                _ = cancellation.cancelled() => return WebLoginWaitEffect::Cancelled,
                _ = tokio::time::sleep(QR_POLL_INTERVAL) => {}
            }
        }
    }

    pub async fn cancel(&self, account_id: Option<String>) {
        self.remove_session(None, account_id.as_deref()).await;
    }

    async fn refresh_session(
        &self,
        session_key: String,
        current: ActiveLogin,
        cancellation: CancellationToken,
    ) -> WebLoginWaitEffect {
        channel_trace(
            "weixin.qr-refresh",
            &format!("event=begin attempt={}", current.refresh_count),
        );
        if current.refresh_count >= MAX_QR_REFRESH_COUNT {
            channel_trace(
                "weixin.qr-refresh",
                "event=end outcome=unknown reason=refresh-exhausted",
            );
            self.sessions.lock().await.remove(&session_key);
            return WebLoginWaitEffect::Unknown;
        }
        let qr = tokio::select! {
            _ = cancellation.cancelled() => return WebLoginWaitEffect::Cancelled,
            qr = self.fetch_qr_code(&current.api_base_url, current.account_id.as_deref()) => qr,
        };
        let qr = match qr {
            Ok(qr) => qr,
            Err(()) => return WebLoginWaitEffect::Unknown,
        };
        let qr_data_url = match render_qr_data_url(&qr.qrcode_img_content) {
            Ok(qr_data_url) => qr_data_url,
            Err(()) => return WebLoginWaitEffect::Unknown,
        };
        let account_id = current.account_id.clone();
        self.sessions.lock().await.insert(
            session_key.clone(),
            ActiveLogin {
                qrcode: qr.qrcode.clone(),
                qr_data_url: qr_data_url.clone(),
                account_id: account_id.clone(),
                api_base_url: current.api_base_url.clone(),
                started_at: Instant::now(),
                refresh_count: current.refresh_count + 1,
            },
        );
        WebLoginWaitEffect::Progress(LoginProgress::new(
            LoginProgressStatus::Qr,
            account_id,
            Some(session_key),
            Some(qr_data_url),
        ))
    }

    async fn session_snapshot(
        &self,
        session_key: Option<&str>,
        account_id: Option<&str>,
    ) -> Option<(String, ActiveLogin)> {
        let sessions = self.sessions.lock().await;
        if let Some(session_key) = session_key {
            return sessions
                .get(session_key)
                .cloned()
                .map(|login| (session_key.to_owned(), login));
        }
        let mut matches = sessions.iter().filter(|(_, login)| {
            account_id.is_none_or(|account_id| login.account_id.as_deref() == Some(account_id))
        });
        let (key, login) = matches.next()?;
        if matches.next().is_some() {
            return None;
        }
        Some((key.clone(), login.clone()))
    }

    async fn remove_session(&self, session_key: Option<&str>, account_id: Option<&str>) {
        let mut sessions = self.sessions.lock().await;
        if let Some(session_key) = session_key {
            sessions.remove(session_key);
            return;
        }
        match account_id {
            Some(account_id) => {
                sessions.retain(|_, login| login.account_id.as_deref() != Some(account_id))
            }
            None => sessions.clear(),
        }
    }

    async fn fetch_qr_code(
        &self,
        api_base_url: &str,
        account_id: Option<&str>,
    ) -> Result<QrCodeResponse, ()> {
        let mut url = ilink_url(api_base_url, "ilink/bot/get_bot_qrcode").map_err(|()| {
            channel_trace("weixin.qr-start-http", "outcome=rejected error=invalid-url");
        })?;
        url.query_pairs_mut()
            .append_pair("bot_type", DEFAULT_ILINK_BOT_TYPE);
        let mut request = self.client.get(url);
        if let Some(route_tag) = self.load_config_string(account_id, "routeTag") {
            request = request.header("SKRouteTag", route_tag);
        }
        let started = Instant::now();
        channel_trace("weixin.qr-start-http", "event=begin");
        let response = request.send().await.map_err(|error| {
            channel_trace(
                "weixin.qr-start-http",
                &format!(
                    "event=end error={} elapsedMs={}",
                    http_error_class(&error),
                    started.elapsed().as_millis()
                ),
            );
        })?;
        channel_trace(
            "weixin.qr-start-http",
            &format!(
                "event=headers status={} elapsedMs={}",
                response.status().as_u16(),
                started.elapsed().as_millis()
            ),
        );
        if !response.status().is_success() {
            channel_trace("weixin.qr-start-http", "event=end outcome=rejected");
            return Err(());
        }
        let qr = response.json::<QrCodeResponse>().await.map_err(|error| {
            channel_trace(
                "weixin.qr-start-http",
                &format!(
                    "event=end error={} elapsedMs={}",
                    http_error_class(&error),
                    started.elapsed().as_millis()
                ),
            );
        })?;
        channel_trace(
            "weixin.qr-start-http",
            &format!(
                "event=end outcome=decoded elapsedMs={}",
                started.elapsed().as_millis()
            ),
        );
        if qr.qrcode.trim().is_empty() || qr.qrcode_img_content.trim().is_empty() {
            channel_trace("weixin.qr-start-decode", "outcome=unknown reason=empty-qr");
            return Err(());
        }
        Ok(qr)
    }

    async fn poll_qr_status(
        &self,
        api_base_url: &str,
        qrcode: &str,
        account_id: Option<&str>,
    ) -> Result<QrStatusResponse, ()> {
        let mut url = ilink_url(api_base_url, "ilink/bot/get_qrcode_status").map_err(|()| {
            channel_trace("weixin.qr-poll-http", "outcome=rejected error=invalid-url");
        })?;
        url.query_pairs_mut().append_pair("qrcode", qrcode);
        let mut request = self
            .client
            .get(url)
            .header("iLink-App-ClientVersion", "1")
            .timeout(QR_POLL_REQUEST_TIMEOUT);
        if let Some(route_tag) = self.load_config_string(account_id, "routeTag") {
            request = request.header("SKRouteTag", route_tag);
        }
        let started = Instant::now();
        channel_trace("weixin.qr-poll-http", "event=begin");
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                channel_trace(
                    "weixin.qr-poll-http",
                    &format!(
                        "event=end error={} elapsedMs={}",
                        http_error_class(&error),
                        started.elapsed().as_millis()
                    ),
                );
                if error.is_timeout() {
                    channel_trace("weixin.qr-poll-http", "outcome=waiting reason=poll-timeout");
                    return Ok(QrStatusResponse::waiting());
                }
                return Err(());
            }
        };
        channel_trace(
            "weixin.qr-poll-http",
            &format!(
                "event=headers status={} elapsedMs={}",
                response.status().as_u16(),
                started.elapsed().as_millis()
            ),
        );
        if !response.status().is_success() {
            channel_trace("weixin.qr-poll-http", "event=end outcome=rejected");
            return Err(());
        }
        let result = response.json::<QrStatusResponse>().await.map_err(|error| {
            channel_trace(
                "weixin.qr-poll-http",
                &format!(
                    "event=end error={} elapsedMs={}",
                    http_error_class(&error),
                    started.elapsed().as_millis()
                ),
            );
        });
        if result.is_ok() {
            channel_trace(
                "weixin.qr-poll-http",
                &format!(
                    "event=end outcome=decoded elapsedMs={}",
                    started.elapsed().as_millis()
                ),
            );
        }
        result
    }

    fn load_config_string(&self, account_id: Option<&str>, key: &str) -> Option<String> {
        let started = Instant::now();
        channel_trace("weixin.config-read", "event=begin");
        let document = match OpenClawConfigStore::new(self.state_dir.clone()).read_private() {
            Ok(document) => document,
            Err(_) => {
                channel_trace(
                    "weixin.config-read",
                    &format!(
                        "event=end outcome=unavailable action=use-existing-default elapsedMs={}",
                        started.elapsed().as_millis()
                    ),
                );
                return None;
            }
        };
        channel_trace(
            "weixin.config-read",
            &format!(
                "event=end outcome=read elapsedMs={}",
                started.elapsed().as_millis()
            ),
        );
        let channels = document.get("channels").and_then(Value::as_object)?;
        let section = channels
            .get(OPENCLAW_WEIXIN_CHANNEL)
            .or_else(|| channels.get(LEGACY_WECHAT_CHANNEL))
            .and_then(Value::as_object)?;
        if let Some(account_id) = account_id.and_then(normalize_account_id) {
            if let Some(value) = section
                .get("accounts")
                .and_then(Value::as_object)
                .and_then(|accounts| accounts.get(&account_id))
                .and_then(Value::as_object)
                .and_then(|account| scalar_config_value(account.get(key)))
            {
                return Some(value);
            }
        }
        scalar_config_value(section.get(key))
    }

    fn save_account_state(
        &self,
        raw_account_id: &str,
        token: &str,
        base_url: Option<&str>,
        user_id: Option<&str>,
    ) -> Result<String, ()> {
        let account_id =
            normalize_account_id(raw_account_id).unwrap_or_else(|| FALLBACK_ACCOUNT_ID.to_owned());
        let state_dir = self.state_dir.as_path().join(WEIXIN_STATE_DIR);
        let accounts_dir = state_dir.join(WEIXIN_ACCOUNTS_DIR);
        let started = Instant::now();
        channel_trace("weixin.account-save", "event=begin accountPresent=true");
        std::fs::create_dir_all(&accounts_dir).map_err(|error| {
            channel_trace(
                "weixin.account-save",
                &format!(
                    "event=end stage=mkdir error={:?} elapsedMs={}",
                    error.kind(),
                    started.elapsed().as_millis()
                ),
            );
        })?;

        let mut data = Map::new();
        data.insert("token".into(), Value::String(token.trim().to_owned()));
        data.insert(
            "savedAt".into(),
            Value::String(chrono::Utc::now().to_rfc3339()),
        );
        if let Some(base_url) = trimmed_value(base_url) {
            data.insert("baseUrl".into(), Value::String(base_url.to_owned()));
        }
        if let Some(user_id) = trimmed_value(user_id) {
            data.insert("userId".into(), Value::String(user_id.to_owned()));
        }
        let mut bytes = serde_json::to_vec_pretty(&data).map_err(|_| {
            channel_trace("weixin.account-save", "event=end error=json-encode");
        })?;
        let path = account_file(&accounts_dir, &account_id);
        let written = std::fs::write(&path, &bytes);
        bytes.zeroize();
        zeroize_value(&mut data);
        written.map_err(|error| {
            channel_trace(
                "weixin.account-save",
                &format!(
                    "event=end stage=write error={:?} elapsedMs={}",
                    error.kind(),
                    started.elapsed().as_millis()
                ),
            );
        })?;
        channel_trace("weixin.account-save", "stage=account-file outcome=written");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }

        let index_path = state_dir.join(WEIXIN_ACCOUNT_INDEX_FILE);
        let mut accounts = read_account_index(&index_path).unwrap_or_default();
        if !accounts.iter().any(|account| account == &account_id) {
            accounts.push(account_id.clone());
            write_account_index(&state_dir, &index_path, &accounts)?;
        } else {
            channel_trace(
                "weixin.account-index-write",
                "outcome=noop reason=already-indexed",
            );
        }
        channel_trace(
            "weixin.account-save",
            &format!(
                "event=end outcome=written elapsedMs={}",
                started.elapsed().as_millis()
            ),
        );
        Ok(account_id)
    }
}

#[derive(Clone)]
struct ActiveLogin {
    qrcode: String,
    qr_data_url: String,
    account_id: Option<String>,
    api_base_url: String,
    started_at: Instant,
    refresh_count: u8,
}

impl Drop for ActiveLogin {
    fn drop(&mut self) {
        self.qrcode.zeroize();
        self.qr_data_url.zeroize();
        if let Some(account_id) = &mut self.account_id {
            account_id.zeroize();
        }
    }
}

#[derive(Deserialize)]
struct QrCodeResponse {
    qrcode: String,
    qrcode_img_content: String,
}

impl Drop for QrCodeResponse {
    fn drop(&mut self) {
        self.qrcode.zeroize();
        self.qrcode_img_content.zeroize();
    }
}

#[derive(Deserialize)]
struct QrStatusResponse {
    status: String,
    bot_token: Option<String>,
    ilink_bot_id: Option<String>,
    baseurl: Option<String>,
    ilink_user_id: Option<String>,
}

impl QrStatusResponse {
    fn waiting() -> Self {
        Self {
            status: "wait".into(),
            bot_token: None,
            ilink_bot_id: None,
            baseurl: None,
            ilink_user_id: None,
        }
    }
}

impl Drop for QrStatusResponse {
    fn drop(&mut self) {
        if let Some(token) = &mut self.bot_token {
            token.zeroize();
        }
    }
}

fn http_error_class(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect"
    } else if error.is_decode() {
        "decode"
    } else if error.is_builder() {
        "request-build"
    } else {
        "transport"
    }
}

fn ilink_url(api_base_url: &str, endpoint: &str) -> Result<Url, ()> {
    let base = api_base_url.trim();
    if base.is_empty() {
        return Err(());
    }
    let base = if base.ends_with('/') {
        base.to_owned()
    } else {
        format!("{base}/")
    };
    Url::parse(&base)
        .and_then(|url| url.join(endpoint))
        .map_err(|_| ())
}

fn render_qr_data_url(value: &str) -> Result<String, ()> {
    if value.len() > MAX_QR_SOURCE_BYTES {
        return Err(());
    }
    let code = QrCode::with_error_correction_level(value.as_bytes(), qrcode::EcLevel::L)
        .map_err(|_| ())?;
    let image = code.render::<Luma<u8>>().module_dimensions(6, 6).build();
    let mut encoded = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut encoded, image::ImageFormat::Png)
        .map_err(|_| ())?;
    let data_url = format!(
        "{QR_DATA_URL_PREFIX}{}",
        STANDARD.encode(encoded.into_inner())
    );
    if data_url.len() <= MAX_QR_DATA_URL_LENGTH {
        Ok(data_url)
    } else {
        Err(())
    }
}

fn random_session_key() -> Option<String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).ok()?;
    let mut key = String::with_capacity(35);
    key.push_str("wx-");
    for byte in &bytes {
        write!(&mut key, "{:02x}", *byte).ok()?;
    }
    bytes.zeroize();
    Some(key)
}

pub(super) fn normalize_account_id(value: &str) -> Option<String> {
    let value = value.trim();
    let is_valid = !value.is_empty()
        && value.len() <= 64
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'));
    let mut normalized = value.to_lowercase();
    if !is_valid {
        let mut canonical = String::with_capacity(normalized.len());
        let mut invalid_run = false;
        for character in normalized.chars() {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
                canonical.push(character);
                invalid_run = false;
            } else if !invalid_run {
                canonical.push('-');
                invalid_run = true;
            }
        }
        normalized = canonical.trim_matches('-').to_owned();
        normalized.truncate(normalized.len().min(64));
    }
    if normalized.is_empty()
        || matches!(
            normalized.as_str(),
            "__proto__" | "prototype" | "constructor"
        )
    {
        None
    } else {
        Some(normalized)
    }
}

fn scalar_config_value(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(value)) => trimmed_value(Some(value)).map(str::to_owned),
        Some(Value::Number(value)) => Some(value.to_string()),
        _ => None,
    }
}

fn trimmed_value(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
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

pub(super) fn clear_account_state(
    state_dir: &CanonicalStateDir,
    account_id: Option<&str>,
) -> Result<(), ()> {
    let started = Instant::now();
    channel_trace(
        "weixin.account-clear",
        &format!("event=begin accountPresent={}", account_id.is_some()),
    );
    let state_dir = state_dir.as_path().join(WEIXIN_STATE_DIR);
    let Some(account_id) = account_id else {
        return match std::fs::remove_dir_all(state_dir) {
            Ok(()) => {
                channel_trace(
                    "weixin.account-clear",
                    &format!(
                        "event=end scope=channel outcome=removed elapsedMs={}",
                        started.elapsed().as_millis()
                    ),
                );
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                channel_trace(
                    "weixin.account-clear",
                    &format!(
                        "event=end scope=channel outcome=noop reason=not-found elapsedMs={}",
                        started.elapsed().as_millis()
                    ),
                );
                Ok(())
            }
            Err(error) => {
                channel_trace(
                    "weixin.account-clear",
                    &format!(
                        "event=end scope=channel error={:?} elapsedMs={}",
                        error.kind(),
                        started.elapsed().as_millis()
                    ),
                );
                Err(())
            }
        };
    };
    let account_id =
        normalize_account_id(account_id).unwrap_or_else(|| FALLBACK_ACCOUNT_ID.to_owned());
    let index_path = state_dir.join(WEIXIN_ACCOUNT_INDEX_FILE);
    let mut accounts = read_account_index(&index_path)?;
    let accounts_dir = state_dir.join(WEIXIN_ACCOUNTS_DIR);
    for suffix in [".json", ".sync.json", ".context-tokens.json"] {
        channel_trace(
            "weixin.account-file-remove",
            &format!("event=begin fileKind={suffix}"),
        );
        match std::fs::remove_file(accounts_dir.join(format!("{account_id}{suffix}"))) {
            Ok(()) => channel_trace(
                "weixin.account-file-remove",
                &format!(
                    "event=end fileKind={suffix} outcome=removed elapsedMs={}",
                    started.elapsed().as_millis()
                ),
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => channel_trace(
                "weixin.account-file-remove",
                &format!(
                    "event=end fileKind={suffix} outcome=noop reason=not-found elapsedMs={}",
                    started.elapsed().as_millis()
                ),
            ),
            Err(error) => {
                channel_trace(
                    "weixin.account-file-remove",
                    &format!(
                        "event=end fileKind={suffix} error={:?} elapsedMs={}",
                        error.kind(),
                        started.elapsed().as_millis()
                    ),
                );
                return Err(());
            }
        }
    }
    let previous_len = accounts.len();
    accounts.retain(|existing| existing != &account_id);
    if accounts.len() != previous_len {
        write_account_index(&state_dir, &index_path, &accounts)?;
    } else {
        channel_trace(
            "weixin.account-index-write",
            "outcome=noop reason=not-indexed",
        );
    }
    channel_trace(
        "weixin.account-clear",
        &format!(
            "event=end scope=account outcome=removed elapsedMs={}",
            started.elapsed().as_millis()
        ),
    );
    Ok(())
}

fn account_file(accounts_dir: &Path, account_id: &str) -> PathBuf {
    accounts_dir.join(format!("{account_id}.json"))
}

fn read_account_index(path: &Path) -> Result<Vec<String>, ()> {
    let started = Instant::now();
    channel_trace("weixin.account-index-read", "event=begin");
    let mut bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            channel_trace(
                "weixin.account-index-read",
                &format!(
                    "event=end outcome=absent elapsedMs={}",
                    started.elapsed().as_millis()
                ),
            );
            return Ok(Vec::new());
        }
        Err(error) => {
            channel_trace(
                "weixin.account-index-read",
                &format!(
                    "event=end error={:?} elapsedMs={}",
                    error.kind(),
                    started.elapsed().as_millis()
                ),
            );
            return Err(());
        }
    };
    let parsed = serde_json::from_slice::<Value>(&bytes);
    bytes.zeroize();
    let Value::Array(values) = parsed.map_err(|_| {
        channel_trace("weixin.account-index-read", "event=end error=json-decode");
    })?
    else {
        channel_trace("weixin.account-index-read", "event=end error=invalid-shape");
        return Err(());
    };
    channel_trace(
        "weixin.account-index-read",
        &format!(
            "event=end outcome=decoded elapsedMs={}",
            started.elapsed().as_millis()
        ),
    );
    Ok(values
        .into_iter()
        .filter_map(|value| match value {
            Value::String(value) if !value.trim().is_empty() => Some(value),
            _ => None,
        })
        .collect())
}

fn write_account_index(state_dir: &Path, path: &Path, accounts: &[String]) -> Result<(), ()> {
    let started = Instant::now();
    channel_trace("weixin.account-index-write", "event=begin");
    std::fs::create_dir_all(state_dir).map_err(|error| {
        channel_trace(
            "weixin.account-index-write",
            &format!(
                "event=end stage=mkdir error={:?} elapsedMs={}",
                error.kind(),
                started.elapsed().as_millis()
            ),
        );
    })?;
    let bytes = serde_json::to_vec_pretty(accounts).map_err(|_| {
        channel_trace("weixin.account-index-write", "event=end error=json-encode");
    })?;
    std::fs::write(path, bytes).map_err(|error| {
        channel_trace(
            "weixin.account-index-write",
            &format!(
                "event=end stage=write error={:?} elapsedMs={}",
                error.kind(),
                started.elapsed().as_millis()
            ),
        );
    })?;
    channel_trace(
        "weixin.account-index-write",
        &format!(
            "event=end outcome=written elapsedMs={}",
            started.elapsed().as_millis()
        ),
    );
    Ok(())
}

fn zeroize_value(value: &mut Map<String, Value>) {
    value.values_mut().for_each(zeroize_json_value);
}

fn zeroize_json_value(value: &mut Value) {
    match value {
        Value::String(value) => value.zeroize(),
        Value::Array(values) => values.iter_mut().for_each(zeroize_json_value),
        Value::Object(values) => values.values_mut().for_each(zeroize_json_value),
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use serde_json::json;

    use super::*;

    static NEXT_TEST_ID: AtomicU64 = AtomicU64::new(1);

    fn state_dir() -> CanonicalStateDir {
        let sequence = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("test clock must follow the Unix epoch")
            .as_nanos();
        CanonicalStateDir::provision(
            std::env::temp_dir().join(format!("runtime-host-weixin-login-{nanos}-{sequence}")),
        )
        .unwrap()
    }

    #[test]
    fn account_id_normalization_matches_openclaw_config_keys() {
        assert_eq!(
            normalize_account_id("xxx@im.bot").as_deref(),
            Some("xxx-im-bot")
        );
        assert_eq!(
            normalize_account_id(" WeChat Main ").as_deref(),
            Some("wechat-main")
        );
        assert_eq!(normalize_account_id("__proto__"), None);
    }

    #[test]
    fn account_state_is_saved_under_weixin_plugin_state() {
        let state_dir = state_dir();
        let login = WeixinLogin::new(state_dir.clone());

        let account_id = login
            .save_account_state(
                "xxx@im.bot",
                "secret-token",
                Some("https://ilinkai.weixin.qq.com"),
                Some("user-1"),
            )
            .unwrap();

        assert_eq!(account_id, "xxx-im-bot");
        let account_file = state_dir
            .as_path()
            .join(WEIXIN_STATE_DIR)
            .join(WEIXIN_ACCOUNTS_DIR)
            .join("xxx-im-bot.json");
        let account: Value = serde_json::from_slice(&fs::read(account_file).unwrap()).unwrap();
        assert_eq!(account["token"], "secret-token");
        assert_eq!(account["baseUrl"], "https://ilinkai.weixin.qq.com");
        assert_eq!(account["userId"], "user-1");
        assert!(
            account["savedAt"]
                .as_str()
                .is_some_and(|value| value.contains('T'))
        );

        let index_file = state_dir
            .as_path()
            .join(WEIXIN_STATE_DIR)
            .join(WEIXIN_ACCOUNT_INDEX_FILE);
        let index: Value = serde_json::from_slice(&fs::read(index_file).unwrap()).unwrap();
        assert_eq!(index, json!(["xxx-im-bot"]));
    }

    #[test]
    fn qr_renderer_returns_bounded_png_data_url() {
        let rendered = render_qr_data_url("https://weixin.qq.com/x/login-canary").unwrap();
        assert!(rendered.starts_with(QR_DATA_URL_PREFIX));
        assert!(rendered.len() <= MAX_QR_DATA_URL_LENGTH);
        let png = STANDARD
            .decode(rendered.strip_prefix(QR_DATA_URL_PREFIX).unwrap())
            .unwrap();
        assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert!(render_qr_data_url(&"x".repeat(MAX_QR_SOURCE_BYTES + 1)).is_err());
    }
}
