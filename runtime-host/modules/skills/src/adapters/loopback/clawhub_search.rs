use platform::capability::CapabilityDecisionVerifier;

use std::sync::Arc;

use crate::ports::ClawHubSearchResult;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

pub(super) const ENDPOINT: &str = "/api/clawhub/search";
const AUTHORIZATION_SCOPE: &str = "skills:search";
const AUTHORIZATION_CAPABILITY: &str = "clawhubSkill.search";
const AUTHORIZATION_SUBJECT: &str = "clawhub-skill-search";
const AUTHORIZATION_HEADER: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";
const DISCOVERY_LIMIT: u16 = 25;
const SEARCH_LIMIT: u16 = 50;
const MAX_QUERY_BYTES: usize = 256;
const MAX_RESULT_COUNT: usize = SEARCH_LIMIT as usize;
const INVALID_REQUEST_ERROR: &str = "ClawHub search request is invalid";
const UNAVAILABLE_ERROR: &str = "ClawHub search is unavailable";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum RequestError {
    Invalid,
    Unauthorized,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchRequest {
    query: String,
}

struct SearchCommand {
    query: Option<String>,
    limit: u16,
    max_results: usize,
}

impl SearchRequest {
    fn decode(
        value: Value,
        authorization: &str,
        verifier: &mut CapabilityDecisionVerifier,
        now: u64,
    ) -> Result<SearchCommand, RequestError> {
        verifier
            .verify(
                authorization,
                now,
                ENDPOINT,
                AUTHORIZATION_SCOPE,
                AUTHORIZATION_CAPABILITY,
                AUTHORIZATION_SUBJECT,
            )
            .map_err(|_| RequestError::Unauthorized)?;
        let request = serde_json::from_value::<Self>(value).map_err(|_| RequestError::Invalid)?;
        if request.query.len() > MAX_QUERY_BYTES || request.query.contains('\0') {
            return Err(RequestError::Invalid);
        }
        let query = request.query.trim().to_owned();
        let (query, limit) = if query.is_empty() {
            (None, DISCOVERY_LIMIT)
        } else {
            (Some(query), SEARCH_LIMIT)
        };
        Ok(SearchCommand {
            query,
            limit,
            max_results: limit as usize,
        })
    }
}

pub(super) enum Delivery {
    Success(Vec<PublicSkill>),
    Unavailable,
}

impl Delivery {
    fn success(results: Vec<ClawHubSearchResult>) -> Self {
        Self::Success(
            results
                .into_iter()
                .filter_map(PublicSkill::try_from)
                .take(MAX_RESULT_COUNT)
                .collect(),
        )
    }

    fn unavailable() -> Self {
        Self::Unavailable
    }

    pub(super) fn status_code(&self) -> u16 {
        match self {
            Self::Success(_) => 200,
            Self::Unavailable => 503,
        }
    }

    pub(super) fn body(&self) -> Value {
        match self {
            Self::Success(results) => json!({
                "success": true,
                "results": results.iter().map(PublicSkill::json).collect::<Vec<_>>(),
            }),
            Self::Unavailable => json!({
                "success": false,
                "error": UNAVAILABLE_ERROR,
            }),
        }
    }
}

pub(super) struct PublicSkill {
    slug: String,
    name: String,
    description: String,
    version: String,
    author: Option<String>,
    downloads: Option<u64>,
    stars: Option<u64>,
}

impl PublicSkill {
    fn try_from(result: ClawHubSearchResult) -> Option<Self> {
        if !valid_slug(result.slug()) || !valid_text(result.name(), 256) {
            return None;
        }
        let version = result.version().trim();
        if !valid_text(version, 128) {
            return None;
        }
        let author = result
            .author()
            .filter(|value| valid_text(value, 256))
            .map(str::to_owned);
        Some(Self {
            slug: result.slug().to_owned(),
            name: result.name().to_owned(),
            description: bounded_public_text(result.description(), 8_192),
            version: version.to_owned(),
            author,
            downloads: result.downloads(),
            stars: result.stars(),
        })
    }

    fn json(&self) -> Value {
        let mut value = serde_json::Map::from_iter([
            ("slug".into(), Value::String(self.slug.clone())),
            ("name".into(), Value::String(self.name.clone())),
            (
                "description".into(),
                Value::String(self.description.clone()),
            ),
            ("version".into(), Value::String(self.version.clone())),
        ]);
        if let Some(author) = &self.author {
            value.insert("author".into(), Value::String(author.clone()));
        }
        if let Some(downloads) = self.downloads {
            value.insert("downloads".into(), downloads.into());
        }
        if let Some(stars) = self.stars {
            value.insert("stars".into(), stars.into());
        }
        Value::Object(value)
    }
}

pub(super) async fn handle(
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    skills: crate::SkillsModule,
    now: u64,
) -> Result<Delivery, RequestError> {
    let authorization = headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
        .ok_or(RequestError::Unauthorized)?;
    let value = serde_json::from_slice::<Value>(body).map_err(|_| RequestError::Invalid)?;
    let mut verifier = verifier.lock().await;
    let SearchCommand {
        query,
        limit,
        max_results,
    } = SearchRequest::decode(value, authorization, &mut verifier, now)?;
    drop(verifier);

    let delivery = match skills.search_clawhub(query, limit).await {
        Ok(results) if results.len() <= max_results => Delivery::success(results),
        Ok(_) | Err(()) => Delivery::unavailable(),
    };
    Ok(delivery)
}

pub(super) fn invalid_request_error() -> &'static str {
    INVALID_REQUEST_ERROR
}

fn valid_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.split('-').all(|segment| {
            !segment.is_empty()
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

fn valid_text(value: &str, max_bytes: usize) -> bool {
    !value.trim().is_empty() && valid_bounded_text(value, max_bytes)
}

fn valid_bounded_text(value: &str, max_bytes: usize) -> bool {
    value.len() <= max_bytes && !value.contains('\0')
}

fn bounded_public_text(value: &str, max_bytes: usize) -> String {
    let value = value.replace('\0', "");
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

#[cfg(test)]
mod tests {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::{Signer as _, SigningKey};
    use serde_json::json;

    use super::*;

    const NOW: u64 = 1_000;

    #[test]
    fn rejects_slugs_outside_renderer_grammar() {
        for slug in [" web-search", "web-search ", "web--search", "Web-search"] {
            assert!(!valid_slug(slug), "slug should be invalid: {slug:?}");
        }
        for slug in ["web-search", "web", "web2-search2"] {
            assert!(valid_slug(slug), "slug should be valid: {slug:?}");
        }
    }

    #[test]
    fn decodes_fixed_query_and_preserves_empty_query_discovery() {
        let command = decode(json!({"query": "  web search  "})).expect("search command");
        assert_eq!(command.max_results, SEARCH_LIMIT as usize);
        assert_eq!(command.query.as_deref(), Some("web search"));
        assert_eq!(command.limit, SEARCH_LIMIT);

        let command = decode(json!({"query": "   "})).expect("discovery command");
        assert_eq!(command.max_results, DISCOVERY_LIMIT as usize);
        assert_eq!(command.query, None);
        assert_eq!(command.limit, DISCOVERY_LIMIT);
    }

    #[test]
    fn rejects_unknown_fields_invalid_queries_and_unsigned_requests() {
        for value in [
            json!({"query": "web", "limit": 10}),
            json!({"query": null}),
            json!({}),
            json!({"query": "\0private"}),
            json!({"query": "x".repeat(MAX_QUERY_BYTES + 1)}),
        ] {
            assert!(matches!(decode(value), Err(RequestError::Invalid)));
        }

        let mut verifier = verifier();
        assert!(matches!(
            SearchRequest::decode(
                json!({"query": "private"}),
                "private-decision",
                &mut verifier,
                NOW,
            ),
            Err(RequestError::Unauthorized)
        ));
    }

    #[test]
    fn projects_renderer_marketplace_fields_and_seals_failures() {
        let success = Delivery::success(vec![
            ClawHubSearchResult::new(
                "web-search".into(),
                "Web Search".into(),
                "".into(),
                "latest".into(),
                Some("ClawHub".into()),
                Some(99),
                Some(7),
            ),
            ClawHubSearchResult::new(
                "bad_slug".into(),
                "Bad".into(),
                "should skip".into(),
                "latest".into(),
                None,
                None,
                None,
            ),
        ]);
        assert_eq!(success.status_code(), 200);
        assert_eq!(
            success.body(),
            json!({
                "success": true,
                "results": [{
                    "slug": "web-search",
                    "name": "Web Search",
                    "description": "",
                    "version": "latest",
                    "author": "ClawHub",
                    "downloads": 99,
                    "stars": 7,
                }],
            })
        );
        assert_eq!(
            Delivery::unavailable().body(),
            json!({"success": false, "error": UNAVAILABLE_ERROR})
        );
        assert!(!success.body().to_string().contains("bad_slug"));
        assert!(!success.body().to_string().contains("should skip"));
    }

    fn decode(value: Value) -> Result<SearchCommand, RequestError> {
        let mut verifier = verifier();
        SearchRequest::decode(value, &decision(), &mut verifier, NOW)
    }

    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[17; 32])
    }

    fn verifier() -> CapabilityDecisionVerifier {
        let mut bytes = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        bytes.extend_from_slice(signing_key().verifying_key().as_bytes());
        CapabilityDecisionVerifier::try_new(&URL_SAFE_NO_PAD.encode(bytes)).expect("verifier")
    }

    fn decision() -> String {
        let payload = json!({
            "version": 1,
            "principal": "localhost-test",
            "endpoint": ENDPOINT,
            "scope": AUTHORIZATION_SCOPE,
            "capability": AUTHORIZATION_CAPABILITY,
            "subject": AUTHORIZATION_SUBJECT,
            "expiresAt": NOW + 1,
            "correlation": "clawhub-search-test",
            "revision": "test",
        });
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("payload"));
        let signed = format!("capability-decision.v1.{payload}");
        let signature = URL_SAFE_NO_PAD.encode(signing_key().sign(signed.as_bytes()).to_bytes());
        format!("{signed}.{signature}")
    }
}
