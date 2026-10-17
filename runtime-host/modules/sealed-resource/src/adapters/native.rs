use std::{sync::Arc, time::Duration};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use platform::loopback::{
    BodyPolicy, Request, RequestHead, Response, RouteDescriptor, RouteHeadPlan, RoutePath,
};
use serde_json::json;

use crate::{
    PackageRelativePath, SkillKey,
    native::{NativeReadError, NativeSealedCatalog, NativeSealedSkills, valid_agent, valid_sha256},
};

const PREFIX: &str = "/api/sealed-skills/native/";

pub(crate) fn descriptor(reader: Option<Arc<NativeSealedSkills>>) -> RouteDescriptor {
    RouteDescriptor::bound(
        "sealed-resource.native-reader",
        &[RoutePath::Prefix(PREFIX)],
        head_plan,
        move |request| {
            let reader = reader.clone();
            Box::pin(async move { handle(reader, request).await.into() })
        },
    )
}

fn head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    (head.method == "GET" && head.path.starts_with(PREFIX)).then(|| {
        RouteHeadPlan::body_deadline(BodyPolicy::Empty, Duration::from_secs(5), unavailable)
    })
}

async fn handle(reader: Option<Arc<NativeSealedSkills>>, request: Request) -> Response {
    let result = async {
        let reader = reader.ok_or(NativeReadError::Unavailable)?;
        if request.method() != "GET" || !request.body.is_empty() || request.path().contains(['?', '#']) {
            return Err(NativeReadError::InvalidRequest);
        }
        if header(&request, "x-matcha-sealed-runtime") != Some("matcha-agent")
            || !header(&request, "x-matcha-sealed-token").is_some_and(|token| reader.authorized(token))
            || request.headers().iter().any(|(name, _)| name.eq_ignore_ascii_case("origin"))
        {
            return Err(NativeReadError::Unauthorized);
        }
        let tail = request.path().strip_prefix(PREFIX).ok_or(NativeReadError::InvalidRequest)?;
        let (agent, operation) = tail.split_once('/').ok_or(NativeReadError::InvalidRequest)?;
        let agent = decode_segment(agent)?;
        if !valid_agent(&agent) { return Err(NativeReadError::InvalidRequest); }
        if operation == "catalog" {
            let catalog = tokio::task::spawn_blocking(move || {
                let skills = match reader.store(&agent, false) {
                    Ok(store) => store.native_catalog()?,
                    Err(crate::SealedResourceError::NotFound) => Vec::new(),
                    Err(error) => return Err(error.into()),
                };
                Ok::<_, NativeReadError>(NativeSealedCatalog { agent_id: agent, skills })
            }).await.map_err(|_| NativeReadError::Unavailable)??;
            return serde_json::to_value(catalog).map_err(|_| NativeReadError::Unavailable);
        }
        let read = operation.strip_prefix("read/").ok_or(NativeReadError::InvalidRequest)?;
        let (key, relative) = read.split_once('/').ok_or(NativeReadError::InvalidRequest)?;
        let key = percent_decode(key)?;
        let skill_key = SkillKey::parse(key.clone()).map_err(|_| NativeReadError::InvalidRequest)?;
        if skill_key.as_str() != key || matches!(key.as_str(), "." | "..") {
            return Err(NativeReadError::InvalidRequest);
        }
        let components = relative.split('/').map(decode_segment).collect::<Result<Vec<_>, _>>()?;
        let path = PackageRelativePath::parse(components.join("/")).map_err(|_| NativeReadError::InvalidRequest)?;
        let sha256 = header(&request, "x-matcha-sealed-package-sha256")
            .filter(|sha| valid_sha256(sha)).ok_or(NativeReadError::InvalidRequest)?.to_owned();
        let read = tokio::task::spawn_blocking(move || reader.store(&agent, false)?.native_read(skill_key, path, &sha256))
            .await.map_err(|_| NativeReadError::Unavailable)??;
        let mut response = json!({"contentBase64": STANDARD.encode(read.content()), "packageSha256": read.package_sha256()});
        if let Some(binding) = read.metering_binding() { response["meteringBinding"] = json!(binding.as_str()); }
        Ok(response)
    }.await;
    match result {
        Ok(body) => Response::json(200, body).with_header("cache-control", "no-store"),
        Err(error) => failure(error),
    }
}

fn header<'a>(request: &'a Request, expected: &str) -> Option<&'a str> {
    let mut values = request
        .headers()
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case(expected));
    let value = values.next()?.1.as_str();
    values.next().is_none().then_some(value)
}

fn decode_segment(value: &str) -> Result<String, NativeReadError> {
    let value = percent_decode(value)?;
    if value.is_empty() || value.contains(['/', '\\', '\0']) {
        return Err(NativeReadError::InvalidRequest);
    }
    Ok(value)
}

fn percent_decode(value: &str) -> Result<String, NativeReadError> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let pair = bytes
                .get(index + 1..index + 3)
                .ok_or(NativeReadError::InvalidRequest)?;
            let hex = std::str::from_utf8(pair).map_err(|_| NativeReadError::InvalidRequest)?;
            decoded.push(u8::from_str_radix(hex, 16).map_err(|_| NativeReadError::InvalidRequest)?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| NativeReadError::InvalidRequest)
}

fn failure(error: NativeReadError) -> Response {
    let (status, kind) = match error {
        NativeReadError::InvalidRequest => (400, "invalid_request"),
        NativeReadError::Unauthorized => (401, "unauthorized"),
        NativeReadError::NotFound => (404, "unknown"),
        NativeReadError::Disabled => (403, "disabled"),
        NativeReadError::PackageChanged => (409, "package_changed"),
        NativeReadError::Unavailable => (503, "unavailable"),
    };
    Response::json(status, json!({"error": {"kind": kind}}))
        .with_header("cache-control", "no-store")
}

fn unavailable() -> Response {
    failure(NativeReadError::Unavailable)
}
