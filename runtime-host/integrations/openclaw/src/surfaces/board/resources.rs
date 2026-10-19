use ::board::{
    BoardFailure, BoardGrantState, BoardIdentity, BoardResult, BoardWidget, BoardWidgetContentKind,
    BoardWidgetContentOwner,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::Url;
use serde::Deserialize;

use super::identity::ticket_claims;

pub(super) fn project_result(
    gateway_origin: &str,
    identity: &BoardIdentity,
    result: &mut BoardResult,
) -> Result<(), BoardFailure> {
    let (session_key, widgets) = match result {
        BoardResult::Snapshot(snapshot) => (&snapshot.session_key, &mut snapshot.widgets),
        BoardResult::WidgetPut(result) => (&result.session_key, &mut result.widgets),
        _ => return Ok(()),
    };
    if session_key != identity.session_key() {
        return Err(BoardFailure::Forbidden);
    }
    let gateway = origin(gateway_origin, false)?;
    for widget in widgets {
        project_widget(&gateway, identity, widget)?;
    }
    Ok(())
}

fn project_widget(
    gateway: &Url,
    identity: &BoardIdentity,
    widget: &mut BoardWidget,
) -> Result<(), BoardFailure> {
    let Some(frame_url) = widget.frame_url.as_deref() else {
        if widget.view_ticket.is_some()
            || widget.view_ticket_ttl_ms.is_some()
            || widget.view_generation.is_some()
            || widget.sandbox_url.is_some()
            || widget.sandbox_port.is_some()
            || widget.sandbox_origin.is_some()
        {
            return Err(BoardFailure::Unknown);
        }
        // Stored mutation snapshots and native plugin/MCP widgets have no HTML view.
        return Ok(());
    };
    if !matches!(
        widget.grant_state,
        BoardGrantState::None | BoardGrantState::Granted
    ) {
        return Err(BoardFailure::Unknown);
    }
    let ticket = widget.view_ticket.as_deref().ok_or(BoardFailure::Unknown)?;
    let claims = ticket_claims(identity, ticket).map_err(|_| BoardFailure::Unknown)?;
    if claims.name != widget.name
        || claims.revision != widget.revision
        || Some(claims.view_generation.as_str()) != widget.view_generation.as_deref()
        || widget.view_ticket_ttl_ms.is_none()
    {
        return Err(BoardFailure::Unknown);
    }
    let resource_origin = match &claims.plugin_frame {
        Some(plugin) => {
            if widget.content_kind != BoardWidgetContentKind::Plugin
                || widget.content_owner != Some(BoardWidgetContentOwner::Registered)
                || widget.plugin_kind.as_deref() != Some(plugin.plugin_kind.as_str())
            {
                return Err(BoardFailure::Unknown);
            }
            let scoped = trusted_url(gateway, &plugin.scoped_host_url)?;
            let token = scoped
                .path()
                .strip_prefix("/__openclaw__/cap/")
                .ok_or(BoardFailure::Unknown)?;
            if token.len() != 24
                || !token
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
                || scoped.query().is_some()
            {
                return Err(BoardFailure::Unknown);
            }
            Some(scoped.origin().ascii_serialization())
        }
        None => {
            if widget.content_kind != BoardWidgetContentKind::Html {
                return Err(BoardFailure::Unknown);
            }
            None
        }
    };
    let frame = trusted_url(gateway, frame_url)?;
    let path = format!(
        "/__openclaw__/board/{}/{}/index.html",
        encode_component(identity.session_key()),
        encode_component(&widget.name)
    );
    if frame.path() != path || single_query(&frame, "bt")? != ticket {
        return Err(BoardFailure::Unknown);
    }
    let sandbox_port = widget.sandbox_port.ok_or(BoardFailure::Unavailable)?;
    let sandbox_origin = match widget.sandbox_origin.as_deref() {
        // This advertised origin comes from the admitted native board.get config,
        // not from the caller; its public port need not equal the listener port.
        Some(configured) => origin(configured, false)?,
        None => {
            let mut origin = gateway.clone();
            origin
                .set_port(Some(sandbox_port))
                .map_err(|_| BoardFailure::Unknown)?;
            origin
        }
    };
    if sandbox_port == 0 || sandbox_origin.origin() == gateway.origin() {
        return Err(BoardFailure::Unknown);
    }
    let sandbox = trusted_url(
        &sandbox_origin,
        widget
            .sandbox_url
            .as_deref()
            .ok_or(BoardFailure::Unavailable)?,
    )?;
    if sandbox.path() != "/mcp-app-sandbox" {
        return Err(BoardFailure::Unknown);
    }
    validate_csp(
        &single_query(&sandbox, "csp")?,
        widget,
        resource_origin.as_deref(),
    )?;
    widget.frame_url = Some(frame.into());
    widget.sandbox_url = Some(sandbox.into());
    widget.sandbox_origin = Some(sandbox_origin.origin().ascii_serialization());
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SandboxCsp {
    block_descendant_frames: bool,
    connect_domains: Option<Vec<String>>,
    resource_domains: Option<Vec<String>>,
}

fn validate_csp(
    encoded: &str,
    widget: &BoardWidget,
    resource_origin: Option<&str>,
) -> Result<(), BoardFailure> {
    // Native limits decoded metadata to 5 KiB before constructing the HTTP header.
    if encoded.len() > 6_832 {
        return Err(BoardFailure::Unknown);
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| BoardFailure::Unknown)?;
    if bytes.len() > 5 * 1024 {
        return Err(BoardFailure::Unknown);
    }
    let csp: SandboxCsp = serde_json::from_slice(&bytes).map_err(|_| BoardFailure::Unknown)?;
    let expected_connect = if widget.grant_state == BoardGrantState::Granted {
        widget
            .declared
            .as_ref()
            .and_then(|declared| declared.net_origins.as_deref())
            .unwrap_or_default()
            .iter()
            .map(|value| origin(value, true).map(|url| url.origin().ascii_serialization()))
            .collect::<Result<Vec<_>, _>>()?
    } else {
        Vec::new()
    };
    let expected_resources: Vec<String> = resource_origin.into_iter().map(str::to_owned).collect();
    if !csp.block_descendant_frames
        || csp.connect_domains.unwrap_or_default() != expected_connect
        || csp.resource_domains.unwrap_or_default() != expected_resources
    {
        return Err(BoardFailure::Unknown);
    }
    Ok(())
}

fn origin(value: &str, websocket: bool) -> Result<Url, BoardFailure> {
    let url = Url::parse(value).map_err(|_| BoardFailure::Unknown)?;
    if value.trim() != value
        || value.chars().any(char::is_control)
        || !(matches!(url.scheme(), "http" | "https")
            || websocket && matches!(url.scheme(), "ws" | "wss"))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(BoardFailure::Unknown);
    }
    Ok(url)
}

fn trusted_url(base: &Url, value: &str) -> Result<Url, BoardFailure> {
    let url = base.join(value).map_err(|_| BoardFailure::Unknown)?;
    if value.trim() != value
        || value.chars().any(char::is_control)
        || url.origin() != base.origin()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(BoardFailure::Unknown);
    }
    Ok(url)
}

fn single_query(url: &Url, name: &str) -> Result<String, BoardFailure> {
    let mut pairs = url.query_pairs();
    let (key, value) = pairs.next().ok_or(BoardFailure::Unknown)?;
    if key != name || pairs.next().is_some() || value.is_empty() {
        return Err(BoardFailure::Unknown);
    }
    Ok(value.into_owned())
}

fn encode_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push(char::from(HEX[usize::from(byte >> 4)]));
            encoded.push(char::from(HEX[usize::from(byte & 15)]));
        }
    }
    encoded
}
