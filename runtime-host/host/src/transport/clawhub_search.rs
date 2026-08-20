use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{
    skill_management::{Command as SkillManagementCommand, Outcome, ReadError, SearchResult},
    transport::authorization::CapabilityDecisionVerifier,
};

pub(crate) const ENDPOINT: &str = "/api/clawhub/search";
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
const REJECTED_ERROR: &str = "ClawHub search was rejected";
const UNAVAILABLE_ERROR: &str = "ClawHub search is unavailable";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RequestError {
    Invalid,
    Unauthorized,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchRequest {
    query: String,
}

struct SearchCommand {
    command: SkillManagementCommand,
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
        let command = SkillManagementCommand::search(query, Some(limit))
            .map_err(|_| RequestError::Invalid)?;
        Ok(SearchCommand {
            command,
            max_results: limit as usize,
        })
    }
}

pub(crate) enum Delivery {
    Success(Vec<PublicSkill>),
    Rejected,
    Unavailable,
}

impl Delivery {
    fn success(results: Vec<SearchResult>) -> Self {
        if results.len() > MAX_RESULT_COUNT {
            return Self::Unavailable;
        }
        let results = results
            .into_iter()
            .map(PublicSkill::try_from)
            .collect::<Result<Vec<_>, _>>();
        match results {
            Ok(results) => Self::Success(results),
            Err(()) => Self::Unavailable,
        }
    }

    fn rejected() -> Self {
        Self::Rejected
    }

    fn unavailable() -> Self {
        Self::Unavailable
    }

    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Success(_) => 200,
            Self::Rejected => 400,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Success(results) => json!({
                "success": true,
                "results": results.iter().map(PublicSkill::json).collect::<Vec<_>>(),
            }),
            Self::Rejected => json!({
                "success": false,
                "error": REJECTED_ERROR,
            }),
            Self::Unavailable => json!({
                "success": false,
                "error": UNAVAILABLE_ERROR,
            }),
        }
    }
}

pub(crate) struct PublicSkill {
    slug: String,
    name: String,
    description: String,
    version: String,
}

impl PublicSkill {
    fn try_from(result: SearchResult) -> Result<Self, ()> {
        if !valid_slug(&result.slug)
            || !valid_text(&result.display_name, 256)
            || !valid_bounded_text(result.summary.as_deref().unwrap_or_default(), 8_192)
        {
            return Err(());
        }
        let version = result
            .version
            .as_deref()
            .filter(|version| !version.trim().is_empty())
            .unwrap_or("latest")
            .trim()
            .to_owned();
        if !valid_text(&version, 128) {
            return Err(());
        }
        Ok(Self {
            slug: result.slug,
            name: result.display_name,
            description: result.summary.unwrap_or_default(),
            version,
        })
    }

    fn json(&self) -> Value {
        json!({
            "slug": self.slug,
            "name": self.name,
            "description": self.description,
            "version": self.version,
        })
    }
}

pub(crate) async fn handle(
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: crate::owner::Handle,
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
        command,
        max_results,
    } = SearchRequest::decode(value, authorization, &mut verifier, now)?;
    drop(verifier);

    let delivery = match owner.manage_skills(command).await {
        Ok(Outcome::Search(Ok(results))) if results.len() <= max_results => {
            Delivery::success(results)
        }
        Ok(Outcome::Search(Ok(_))) => Delivery::unavailable(),
        Ok(Outcome::Search(Err(ReadError::Rejected))) | Ok(Outcome::Rejected) => {
            Delivery::rejected()
        }
        Ok(Outcome::Search(Err(_))) | Ok(Outcome::Unavailable) | Err(_) => Delivery::unavailable(),
        Ok(_) => Delivery::unavailable(),
    };
    Ok(delivery)
}

pub(crate) fn invalid_request_error() -> &'static str {
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
        assert!(matches!(
            command.command,
            SkillManagementCommand::Search {
                query: Some(query),
                limit: Some(50),
            } if query == "web search"
        ));

        let command = decode(json!({"query": "   "})).expect("discovery command");
        assert_eq!(command.max_results, DISCOVERY_LIMIT as usize);
        assert!(matches!(
            command.command,
            SkillManagementCommand::Search {
                query: None,
                limit: Some(25),
            }
        ));
    }

    #[test]
    fn rejects_unknown_fields_invalid_queries_and_unsigned_requests() {
        for value in [
            json!({"query": "web", "limit": 10}),
            json!({"query": null}),
            json!({}),
            json!({"query": " private"}),
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
    fn projects_only_renderer_marketplace_fields_and_seals_failures() {
        let success = Delivery::success(vec![SearchResult {
            score: 0.9,
            slug: "web-search".into(),
            display_name: "Web Search".into(),
            summary: None,
            version: None,
            updated_at: Some(99),
        }]);
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
                }],
            })
        );
        assert_eq!(
            Delivery::rejected().body(),
            json!({"success": false, "error": REJECTED_ERROR})
        );
        assert_eq!(
            Delivery::unavailable().body(),
            json!({"success": false, "error": UNAVAILABLE_ERROR})
        );
        assert!(!success.body().to_string().contains("0.9"));
        assert!(!success.body().to_string().contains("99"));
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
