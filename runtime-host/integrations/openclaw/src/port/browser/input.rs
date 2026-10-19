use serde_json::{Map, Value, json};

use crate::gateway::request::OpenClawBrowserGatewayRequest;

use super::{MAX_VIEWPORT_DIMENSION, Operation, public_url, text};

pub(super) const VIEWPORT_FUNCTION: &str =
    "() => ({width:window.innerWidth,height:window.innerHeight})";

pub(super) fn normalize(request: &mut OpenClawBrowserGatewayRequest) -> Result<Operation, ()> {
    if request
        .timeout_ms
        .is_some_and(|timeout| timeout == 0 || timeout > 60_000)
        || request
            .target
            .as_deref()
            .is_some_and(|target| !matches!(target, "host" | "node"))
        || request
            .node
            .as_ref()
            .is_some_and(|node| request.target.as_deref() != Some("node") || !text(node, 256))
    {
        return Err(());
    }
    if let Some(query) = &request.query {
        let query = query.as_object().ok_or(())?;
        if !keys(query, &["profile"]) || !required_text(query, "profile", 256) {
            return Err(());
        }
    }
    let empty = Map::new();
    let body = match &request.body {
        Some(value) => value.as_object().ok_or(())?,
        None => &empty,
    };
    let operation = match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/") if body.is_empty() => Operation::Status,
        ("GET", "/tabs") if body.is_empty() => Operation::Tabs,
        ("POST", "/start") if body.is_empty() => Operation::Start,
        ("POST", "/tabs/open")
            if keys(body, &["url"])
                && body
                    .get("url")
                    .and_then(Value::as_str)
                    .is_some_and(public_url) =>
        {
            Operation::Tab
        }
        ("POST", "/tabs/focus")
            if keys(body, &["targetId"]) && required_text(body, "targetId", 256) =>
        {
            Operation::Mutation
        }
        ("POST", "/navigate")
            if keys(body, &["targetId", "url"])
                && required_text(body, "targetId", 256)
                && body
                    .get("url")
                    .and_then(Value::as_str)
                    .is_some_and(public_url) =>
        {
            Operation::Mutation
        }
        ("POST", "/screenshot")
            if keys(body, &["targetId", "type"])
                && required_text(body, "targetId", 256)
                && body
                    .get("type")
                    .is_none_or(|value| matches!(value.as_str(), Some("png" | "jpeg"))) =>
        {
            Operation::Screenshot
        }
        ("POST", "/act") => return normalize_action(request),
        ("DELETE", path) if body.is_empty() && valid_tab_path(path) => Operation::Mutation,
        _ => return Err(()),
    };
    Ok(operation)
}

fn normalize_action(request: &mut OpenClawBrowserGatewayRequest) -> Result<Operation, ()> {
    let body = request.body.as_ref().and_then(Value::as_object).ok_or(())?;
    if !required_text(body, "targetId", 256) {
        return Err(());
    }
    let kind = body.get("kind").and_then(Value::as_str).ok_or(())?;
    let function = match kind {
        "clickCoords"
            if keys(
                body,
                &["kind", "targetId", "x", "y", "button", "doubleClick"],
            ) && coordinate(body.get("x"))
                && coordinate(body.get("y"))
                && body.get("button").is_none_or(|value| {
                    matches!(value.as_str(), Some("left" | "right" | "middle"))
                })
                && optional_bool(body, "doubleClick") =>
        {
            None
        }
        "press" if keys(body, &["kind", "targetId", "key"]) && required_text(body, "key", 256) => {
            None
        }
        "type"
            if keys(
                body,
                &["kind", "targetId", "selector", "text", "submit", "slowly"],
            ) && required_text(body, "selector", 4096)
                && input_text(body.get("text"), false)
                && optional_bool(body, "submit")
                && optional_bool(body, "slowly") =>
        {
            None
        }
        "resize"
            if keys(body, &["kind", "targetId", "width", "height"])
                && dimension(body.get("width"))
                && dimension(body.get("height")) =>
        {
            None
        }
        "history"
            if keys(body, &["kind", "targetId", "delta"])
                && matches!(body.get("delta").and_then(Value::as_i64), Some(-1 | 1)) =>
        {
            Some(format!(
                "() => {{ history.go({}); return true; }}",
                body["delta"]
            ))
        }
        "reload" if keys(body, &["kind", "targetId"]) => {
            Some("() => { location.reload(); return true; }".into())
        }
        "scrollBy"
            if keys(body, &["kind", "targetId", "deltaX", "deltaY", "x", "y"])
                && delta(body.get("deltaX"))
                && delta(body.get("deltaY"))
                && ((!body.contains_key("x") && !body.contains_key("y"))
                    || (coordinate(body.get("x")) && coordinate(body.get("y")))) =>
        {
            let arguments = json!([body["deltaX"], body["deltaY"], body.get("x"), body.get("y")]);
            Some(format!(
                r#"() => {{
  const [dx,dy,x,y] = {arguments};
  let el = x === null ? document.activeElement : document.elementFromPoint(x,y);
  for (let i=0; el && i<64; i++, el=el.parentElement) {{
    const style = getComputedStyle(el);
    const horizontal = dx !== 0 && /(auto|scroll)/.test(style.overflowX) && el.scrollWidth > el.clientWidth;
    const vertical = dy !== 0 && /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight;
    if (horizontal || vertical) {{
      const left=el.scrollLeft, top=el.scrollTop;
      el.scrollBy({{left:dx,top:dy,behavior:'instant'}});
      if (left !== el.scrollLeft || top !== el.scrollTop) return true;
    }}
  }}
  window.scrollBy({{left:dx,top:dy,behavior:'instant'}});
  return true;
}}"#
            ))
        }
        "insertText"
            if keys(body, &["kind", "targetId", "text"]) && input_text(body.get("text"), true) =>
        {
            let input = &body["text"];
            Some(format!(
                r#"() => {{
  let el=document.activeElement;
  for (let i=0; el && el.shadowRoot && el.shadowRoot.activeElement && i<8; i++) el=el.shadowRoot.activeElement;
  if (!el || el.disabled || el.readOnly) return false;
  const editable = el.isContentEditable || el.tagName === 'TEXTAREA' ||
    (el.tagName === 'INPUT' && ['text','search','email','password','tel','url'].includes(el.type));
  if (!editable) return false;
  return document.execCommand('insertText',false,{input});
}}"#
            ))
        }
        _ => return Err(()),
    };
    let operation = match kind {
        "insertText" => Operation::FixedAction { input: true },
        "history" | "reload" | "scrollBy" => Operation::FixedAction { input: false },
        _ => Operation::Mutation,
    };
    if let Some(function) = function {
        request.body = Some(json!({"kind":"evaluate","targetId":body["targetId"],"fn":function}));
    }
    Ok(operation)
}

fn keys(body: &Map<String, Value>, allowed: &[&str]) -> bool {
    body.keys().all(|key| allowed.contains(&key.as_str()))
}

fn required_text(body: &Map<String, Value>, key: &str, limit: usize) -> bool {
    body.get(key)
        .and_then(Value::as_str)
        .is_some_and(|value| text(value, limit))
}

fn optional_bool(body: &Map<String, Value>, key: &str) -> bool {
    body.get(key).is_none_or(Value::is_boolean)
}

fn input_text(value: Option<&Value>, nonempty: bool) -> bool {
    value.and_then(Value::as_str).is_some_and(|value| {
        (!nonempty || !value.is_empty())
            && value.encode_utf16().count() <= 32_768
            && !value.contains('\0')
    })
}

fn coordinate(value: Option<&Value>) -> bool {
    value.and_then(Value::as_f64).is_some_and(|value| {
        value.is_finite() && (0.0..=MAX_VIEWPORT_DIMENSION as f64).contains(&value)
    })
}

fn dimension(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_u64)
        .is_some_and(|value| (1..=MAX_VIEWPORT_DIMENSION).contains(&value))
}

fn delta(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_f64)
        .is_some_and(|value| value.is_finite() && value.abs() <= 1200.0)
}

fn valid_tab_path(path: &str) -> bool {
    let Some(encoded) = path.strip_prefix("/tabs/") else {
        return false;
    };
    let mut bytes = Vec::with_capacity(encoded.len());
    let mut chars = encoded.bytes();
    while let Some(byte) = chars.next() {
        if byte == b'%' {
            let Some(high) = chars.next().and_then(hex) else {
                return false;
            };
            let Some(low) = chars.next().and_then(hex) else {
                return false;
            };
            bytes.push(high * 16 + low);
        } else {
            bytes.push(byte);
        }
    }
    String::from_utf8(bytes).is_ok_and(|id| {
        text(&id, 256) && !id.contains(['/', '\\', '?', '#']) && !matches!(id.as_str(), "." | "..")
    })
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}
