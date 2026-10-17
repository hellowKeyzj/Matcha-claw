use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use channels_module::login::{LoginProgress, LoginProgressStatus, Outcome};
use image::Luma;
use qrcode::QrCode;
use serde_json::{Value, json};
use tokio::time::{Instant, sleep};
use tokio_util::sync::CancellationToken;

use super::{CHANNEL, Channels, Failure, failure};

impl Channels {
    pub(super) async fn start_login(
        &self,
        channel: String,
        force: bool,
        _timeout_ms: Option<u64>,
        account: Option<String>,
    ) -> Outcome {
        let binding = match self.binding(&channel, account.as_deref()).await {
            Ok(binding) => binding,
            Err(Failure::Rejected) => return Outcome::Rejected,
            Err(Failure::Unknown) => return Outcome::Unknown,
        };
        if binding.definition.session_id.is_none() {
            return Outcome::Rejected;
        }
        let mut params = json!({"id":binding.id});
        if force {
            match self.client.call("channels.status", params.clone()).await {
                Ok(status) => {
                    if let Some(flow) = status.pointer("/login/flowId").and_then(Value::as_str) {
                        params["restartFlowId"] = flow.into();
                    }
                }
                Err(error) => return login_failure(&error),
            }
        }
        match self.client.call("channels.login", params).await {
            Ok(value) => progress(&binding.id, value.get("login")),
            Err(error) => login_failure(&error),
        }
    }

    pub(super) async fn wait_login(
        &self,
        channel: String,
        timeout_ms: Option<u64>,
        account: Option<String>,
        expected_flow: Option<String>,
        current_qr_data_url: Option<String>,
        cancellation: CancellationToken,
    ) -> Outcome {
        let binding = match self.binding(&channel, account.as_deref()).await {
            Ok(binding) => binding,
            Err(Failure::Rejected) => return Outcome::Rejected,
            Err(Failure::Unknown) => return Outcome::Unknown,
        };
        let deadline = Instant::now() + Duration::from_millis(timeout_ms.unwrap_or(30_000));
        loop {
            if cancellation.is_cancelled() {
                return self
                    .cancel_login(channel, Some(binding.id), expected_flow)
                    .await;
            }
            let value = match self
                .client
                .call("channels.status", json!({"id":binding.id}))
                .await
            {
                Ok(value) => value,
                Err(error) => return login_failure(&error),
            };
            if expected_flow.as_deref().is_some_and(|expected| {
                value.pointer("/login/flowId").and_then(Value::as_str) != Some(expected)
            }) {
                return Outcome::Rejected;
            }
            let observed = progress(&binding.id, value.get("login"));
            let unchanged = matches!(&observed, Outcome::Progress(progress)
                if progress.status == LoginProgressStatus::Pending
                    || (progress.status == LoginProgressStatus::Qr
                        && progress.qr_data_url.as_deref() == current_qr_data_url.as_deref()));
            if !unchanged || Instant::now() >= deadline {
                return observed;
            }
            tokio::select! {
                _ = cancellation.cancelled() => return self.cancel_login(channel, Some(binding.id), expected_flow).await,
                _ = sleep(Duration::from_millis(250)) => {},
            }
        }
    }

    pub(super) async fn cancel_login(
        &self,
        channel: String,
        account: Option<String>,
        flow_id: Option<String>,
    ) -> Outcome {
        let binding = match self.binding(&channel, account.as_deref()).await {
            Ok(binding) => binding,
            Err(Failure::Rejected) => return Outcome::Rejected,
            Err(Failure::Unknown) => return Outcome::Unknown,
        };
        let mut params = json!({"id":binding.id});
        if let Some(flow) = flow_id {
            params["flowId"] = flow.into();
        }
        match self.client.call("channels.login.cancel", params).await {
            Ok(value)
                if value.get("stopped") == Some(&Value::Bool(true))
                    && value.get("cleanupConfirmed") == Some(&Value::Bool(true)) =>
            {
                Outcome::Cancelled
            }
            Err(error) => login_failure(&error),
            _ => Outcome::Unknown,
        }
    }
}

fn login_failure(error: &crate::client::Error) -> Outcome {
    match failure(error) {
        Failure::Rejected => Outcome::Rejected,
        Failure::Unknown => Outcome::Unknown,
    }
}

fn progress(binding_id: &str, value: Option<&Value>) -> Outcome {
    let Some(value) = value else {
        return Outcome::Unknown;
    };
    let Some(flow) = value.get("flowId").and_then(Value::as_str) else {
        return Outcome::Unknown;
    };
    let status = match value.get("status").and_then(Value::as_str) {
        Some("connected") => LoginProgressStatus::Connected,
        Some("cancelled") => return Outcome::Cancelled,
        Some("failed") => return Outcome::Rejected,
        Some("outcomeUnknown") => return Outcome::Unknown,
        Some("starting" | "waiting" | "finishing") => LoginProgressStatus::Pending,
        _ => return Outcome::Unknown,
    };
    let qr = if status == LoginProgressStatus::Pending {
        value
            .get("qrUrl")
            .and_then(Value::as_str)
            .and_then(render_qr)
    } else {
        None
    };
    // Native refreshes are not observable on stdout. This is the first QR, not a freshness claim.
    Outcome::Progress(LoginProgress::new(
        CHANNEL.into(),
        Some(binding_id.into()),
        Some(flow.into()),
        if qr.is_some() {
            LoginProgressStatus::Qr
        } else {
            status
        },
        qr,
    ))
}

fn render_qr(url: &str) -> Option<String> {
    if url.len() > 2_953 || !(url.starts_with("https://") || url.starts_with("http://")) {
        return None;
    }
    let code = QrCode::with_error_correction_level(url.as_bytes(), qrcode::EcLevel::L).ok()?;
    let image = code.render::<Luma<u8>>().module_dimensions(6, 6).build();
    let mut png = std::io::Cursor::new(Vec::new());
    image.write_to(&mut png, image::ImageFormat::Png).ok()?;
    let value = format!(
        "data:image/png;base64,{}",
        STANDARD.encode(png.into_inner())
    );
    channels_module::login::valid_qr_data_url(&value).then_some(value)
}
